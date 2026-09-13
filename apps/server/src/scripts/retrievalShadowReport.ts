import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RETRIEVAL_SHADOW } from "../domain/retrievalShadow.js";
import { supabaseAdmin } from "../integrations/supabase.js";
import { RETRIEVAL_PAGE_SIZE, keysetWindow, type Keyset } from "./retrievalPagination.js";

type Candidate = { run_id: string; rank: number; score: number; review_label: string | null };

export async function main(argv = process.argv.slice(2)) {
  if (!supabaseAdmin) throw new Error("Supabase configuration is required");
  const filters = parseFilters(argv);
  const observedFrom = new Date().toISOString();
  const runs = await loadTimestampRows(supabaseAdmin, "retrieval_shadow_runs", "id,user_id,status,queue_delay_ms,search_latency_ms,candidate_count,created_at", filters, observedFrom);
  const jobs = await loadTimestampRows(supabaseAdmin, "retrieval_shadow_jobs", "id,user_id,status,created_at", filters, observedFrom);
  const candidates: Candidate[] = [];
  for (let offset = 0; offset < runs.length; offset += RETRIEVAL_PAGE_SIZE) {
    const ids = runs.slice(offset, offset + RETRIEVAL_PAGE_SIZE).map((run: any) => run.id);
    const { data: upperRows, error: upperError } = await supabaseAdmin.from("retrieval_shadow_candidates")
      .select("id").in("run_id", ids).lte("created_at", observedFrom).order("id", { ascending: false }).limit(1);
    if (upperError) throw new Error("shadow_report_read_failed");
    const upperId = upperRows?.[0]?.id as string | undefined;
    let cursor: string | null = null;
    while (ids.length && upperId) {
      let query = supabaseAdmin.from("retrieval_shadow_candidates")
        .select("id,run_id,rank,score,review_label").in("run_id", ids)
        .lte("id", upperId).lte("created_at", observedFrom)
        .order("id", { ascending: true }).limit(RETRIEVAL_PAGE_SIZE);
      if (cursor) query = query.gt("id", cursor);
      const { data, error } = await query;
      if (error) throw new Error("shadow_report_read_failed");
      if (!(data ?? []).length) break;
      candidates.push(...data as Candidate[]);
      cursor = data![data!.length - 1]!.id;
    }
  }
  const runIds = new Set((runs ?? []).map((run) => run.id));
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of (candidates ?? []) as Candidate[]) grouped.set(candidate.run_id, [...(grouped.get(candidate.run_id) ?? []), candidate]);
  const reviewedRunIds = [...runIds].filter((id) => (grouped.get(id)?.length ?? 0) > 0 && grouped.get(id)!.every((candidate) => candidate.review_label));
  const thresholds = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7].map((threshold) => qualityAtThreshold(reviewedRunIds, grouped, threshold));
  let survivingRuns = 0;
  for (let offset = 0; offset < runs.length; offset += RETRIEVAL_PAGE_SIZE) {
    const ids = runs.slice(offset, offset + RETRIEVAL_PAGE_SIZE).map((run: any) => run.id);
    const { data, error } = await supabaseAdmin.from("retrieval_shadow_runs").select("id").in("id", ids);
    if (error) throw new Error("shadow_report_read_failed");
    survivingRuns += (data ?? []).length;
  }
  const report = {
    generatedAt: new Date().toISOString(),
    scope: { ...filters, userId: filters.userId ? "single_user" : null, observedFrom, observedTo: new Date().toISOString() },
    privacy: "No chat content is included.",
    settings: {
      model: RETRIEVAL_SHADOW.model,
      dimensions: RETRIEVAL_SHADOW.dimensions,
      chunkStrategy: RETRIEVAL_SHADOW.chunkStrategy,
      queryStrategy: RETRIEVAL_SHADOW.queryStrategy,
      diagnosticThreshold: RETRIEVAL_SHADOW.threshold,
      topK: RETRIEVAL_SHADOW.topK,
      candidateLimit: RETRIEVAL_SHADOW.candidateLimit,
      retentionDays: RETRIEVAL_SHADOW.retentionDays
    },
    dataComplete: (runs ?? []).reduce((sum, run) => sum + Number(run.candidate_count), 0) === candidates.length
      && survivingRuns === runs.length,
    rowsRead: { runs: runs.length, candidates: candidates.length, jobs: jobs.length },
    dataRange: createdAtRange(runs),
    jobs: Object.fromEntries(["pending", "processing", "completed", "failed"].map((status) => [status, (jobs ?? []).filter((job) => job.status === status).length])),
    completedRuns: (runs ?? []).filter((run) => run.status === "completed").length,
    errorRuns: (runs ?? []).filter((run) => run.status === "error").length,
    reviewedRuns: reviewedRunIds.length,
    phase1SampleGoal: { completedRuns: 50, reviewedRuns: 25 },
    latencyMs: {
      queueP50: percentile((runs ?? []).map((run) => Number(run.queue_delay_ms)), 0.5),
      queueP95: percentile((runs ?? []).map((run) => Number(run.queue_delay_ms)), 0.95),
      searchP50: percentile((runs ?? []).map((run) => Number(run.search_latency_ms)), 0.5),
      searchP95: percentile((runs ?? []).map((run) => Number(run.search_latency_ms)), 0.95)
    },
    thresholds
  };
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const directory = path.join(repoRoot, "artifacts", "retrieval-shadow", new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(path.join(directory, "report.md"), markdown(report))
  ]);
  console.info("[retrieval-shadow:report]", { directory, completedRuns: report.completedRuns, reviewedRuns: report.reviewedRuns });
  return { directory, report };
}

type Filters = { userId?: string; from?: string; to?: string };

function parseFilters(argv: string[]): Filters {
  const userId = value(argv, "user-id");
  const from = parseInstant(value(argv, "from"));
  const to = parseInstant(value(argv, "to"));
  if (from && to && from >= to) throw new Error("--from must be before --to");
  return { ...(userId ? { userId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

async function loadTimestampRows(db: any, table: string, columns: string, filters: Filters, observedFrom: string) {
  const apply = (query: any) => {
    let next = query.lte("created_at", observedFrom);
    if (filters.userId) next = next.eq("user_id", filters.userId);
    if (filters.from) next = next.gte("created_at", filters.from);
    if (filters.to) next = next.lt("created_at", filters.to);
    return next;
  };
  const { data: upperRows, error: upperError } = await apply(db.from(table).select("id,created_at"))
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (upperError) throw new Error("shadow_report_read_failed");
  const upper = upperRows?.[0] ? { primary: upperRows[0].created_at, id: upperRows[0].id } : null;
  const rows: any[] = [];
  let cursor: Keyset | null = null;
  while (upper) {
    const query: any = apply(db.from(table).select(columns)).or(keysetWindow("created_at", cursor, upper))
      .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(RETRIEVAL_PAGE_SIZE);
    const { data, error }: any = await query;
    if (error) throw new Error("shadow_report_read_failed");
    if (!(data ?? []).length) break;
    rows.push(...data);
    const last: any = data[data.length - 1];
    cursor = { primary: last.created_at, id: last.id };
  }
  return rows;
}

function value(argv: string[], name: string) {
  return argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function parseInstant(raw: string | undefined) {
  if (!raw) return undefined;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new Error("report timestamps must include a timezone");
  }
  return new Date(raw).toISOString();
}

export function qualityAtThreshold(runIds: string[], grouped: Map<string, Candidate[]>, threshold: number) {
  const selected = runIds.flatMap((id) => (grouped.get(id) ?? []).filter((candidate) => candidate.rank <= 3 && candidate.score >= threshold));
  const useful = selected.filter((candidate) => candidate.review_label === "must" || candidate.review_label === "acceptable").length;
  const forbidden = selected.filter((candidate) => candidate.review_label === "forbidden").length;
  const usefulRuns = runIds.filter((id) => (grouped.get(id) ?? []).some((candidate) => candidate.rank <= 3 && candidate.score >= threshold && (candidate.review_label === "must" || candidate.review_label === "acceptable"))).length;
  return {
    threshold,
    selectedPrecision: ratio(useful, selected.length),
    queryUsefulHitRate: ratio(usefulRuns, runIds.length),
    forbiddenRate: ratio(forbidden, selected.length),
    selected: selected.length
  };
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? 0;
}
function ratio(a: number, b: number) { return b ? a / b : 0; }
function createdAtRange(rows: Array<{ created_at?: string }>) {
  const values = rows.flatMap((row) => row.created_at ? [row.created_at] : []).sort();
  return { earliest: values[0] ?? null, latest: values.at(-1) ?? null };
}
function markdown(report: any) {
  const lines = ["# Retrieval Shadow Report", "", `Generated: ${report.generatedAt}`, "", "> No chat content is included.", "", `Scope and observation window: ${JSON.stringify(report.scope)}`, `Observed settings: ${JSON.stringify(report.settings)}`, `Data complete: ${report.dataComplete ? "YES" : "NO"}`, `Rows read: ${JSON.stringify(report.rowsRead)}`, `Run data range: ${JSON.stringify(report.dataRange)}`, `Completed runs: ${report.completedRuns}`, `Reviewed runs: ${report.reviewedRuns}`, "", "| Threshold | Selected precision | Useful query hit | Forbidden | Selected |", "| ---: | ---: | ---: | ---: | ---: |"];
  for (const row of report.thresholds) lines.push(`| ${row.threshold.toFixed(2)} | ${(row.selectedPrecision * 100).toFixed(1)}% | ${(row.queryUsefulHitRate * 100).toFixed(1)}% | ${(row.forbiddenRate * 100).toFixed(1)}% | ${row.selected} |`);
  return `${lines.join("\n")}\n`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[retrieval-shadow:report] ${error instanceof Error ? error.message : "failed"}`); process.exitCode = 1; });
}
