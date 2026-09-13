import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supabaseAdmin } from "../integrations/supabase.js";
import { RETRIEVAL_GENERATION } from "../domain/retrievalGeneration.js";
import {
  RETRIEVAL_PAGE_SIZE, keysetWindow, type Keyset
} from "./retrievalPagination.js";

type Run = {
  id: string;
  user_id?: string;
  status: "injected" | "abstained" | "fallback";
  selection_strategy: "threshold_top2" | "top5_all" | "top20_local_rerank" | "user_evidence_top20" | "user_evidence_adaptive";
  model?: string;
  embedding_model?: string;
  dimensions?: number;
  chunk_strategy?: string;
  injection_strategy?: string;
  candidate_limit?: number;
  injection_limit?: number;
  history_limit?: number;
  retrieval_token_budget?: number;
  injected_count: number;
  embedding_latency_ms: number;
  search_latency_ms: number;
  total_retrieval_latency_ms: number;
  history_10_tokens: number;
  history_20_tokens: number;
  retrieval_tokens: number;
  actual_input_tokens: number | null;
  output_tokens: number | null;
  response_effect: "helpful" | "neutral" | "harmful" | null;
  stale_detected: boolean | null;
  sensitive_detected: boolean | null;
  error_code: string | null;
  candidate_count?: number;
  evaluation_version?: string;
  retrieval_need?: "required" | "not_needed" | "uncertain" | null;
  question_type?: string | null;
  evidence_groups?: string[][] | null;
  evidence_resolution?: string | null;
  manifest_verification?: string | null;
  review_completed_at?: string | null;
  created_at?: string;
  selection_version?: string | null;
  query_builder_version?: string | null;
  evidence_filter_version?: string | null;
  context_formatter_version?: string | null;
  minimum_score?: number | null;
  relative_score_ratio?: number | null;
  effective_threshold?: number | null;
  search_before_sequence?: number | null;
  retrieval_timeout_ms?: number | null;
};

type Candidate = {
  id?: string;
  run_id: string;
  injected: boolean;
  selection_decision?: string | null;
  review_label: string | null;
};

export async function main(argv = process.argv.slice(2)) {
  if (!supabaseAdmin) throw new Error("Supabase configuration is required");
  const filters = parseReportFilters(argv);
  const observedFrom = new Date().toISOString();
  const loaded = await loadGenerationReportRows(supabaseAdmin, filters, observedFrom);
  const observedTo = new Date().toISOString();
  const base = buildGenerationReport(loaded.runs, loaded.candidates);
  const isCurrentEvaluation = filters.version === RETRIEVAL_GENERATION.evaluationVersion;
  const report = {
    ...base,
    scope: { ...filters, userId: filters.userId ? "single_user" : null, observedFrom, observedTo },
    dataComplete: loaded.dataComplete,
    rowsRead: { runs: loaded.runs.length, candidates: loaded.candidates.length },
    dataRange: createdAtRange(loaded.runs),
    phase25: isCurrentEvaluation
      ? buildPhase25Evaluation(loaded.runs, loaded.candidates, loaded.dataComplete, Boolean(filters.userId))
      : null,
    phase25Groups: isCurrentEvaluation
      ? buildPhase25UserGroups(loaded.runs, loaded.candidates, loaded.dataComplete, Boolean(filters.userId))
      : {}
  };
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const directory = path.join(repoRoot, "artifacts", "retrieval-generation", new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(path.join(directory, "report.md"), markdown(report))
  ]);
  console.info("[retrieval-generation:report]", {
    directory,
    injectedRuns: report.userEvidenceAdaptiveRuns.injected,
    reviewedInjectedRuns: report.phase24.review.reviewedInjectedRuns,
    phase24MetricsPass: report.phase24.metricsPass
  });
  return { directory, report };
}

type ReportFilters = { userId?: string; version: string; from?: string; to?: string };

export function parseReportFilters(argv: string[]): ReportFilters {
  const userId = value(argv, "user-id");
  const version = value(argv, "version") ?? RETRIEVAL_GENERATION.evaluationVersion;
  const from = parseInstant(value(argv, "from"));
  const to = parseInstant(value(argv, "to"));
  if (from && to && from >= to) throw new Error("--from must be before --to");
  return { ...(userId ? { userId } : {}), version, ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

async function loadGenerationReportRows(db: any, filters: ReportFilters, observedFrom: string) {
  const columns = "id,user_id,status,selection_strategy,model,embedding_model,dimensions,chunk_strategy,injection_strategy,candidate_limit,injection_limit,history_limit,retrieval_token_budget,injected_count,candidate_count,embedding_latency_ms,search_latency_ms,total_retrieval_latency_ms,history_10_tokens,history_20_tokens,retrieval_tokens,actual_input_tokens,output_tokens,response_effect,stale_detected,sensitive_detected,error_code,evaluation_version,selection_version,query_builder_version,evidence_filter_version,context_formatter_version,minimum_score,relative_score_ratio,effective_threshold,search_before_sequence,retrieval_timeout_ms,retrieval_need,question_type,evidence_groups,evidence_resolution,manifest_verification,review_completed_at,created_at";
  const apply = (query: any) => {
    let next = query.eq("evaluation_version", filters.version).lte("created_at", observedFrom);
    if (filters.userId) next = next.eq("user_id", filters.userId);
    if (filters.from) next = next.gte("created_at", filters.from);
    if (filters.to) next = next.lt("created_at", filters.to);
    return next;
  };
  const { data: upperRows, error: upperError } = await apply(db.from("retrieval_generation_runs").select("id,created_at"))
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (upperError) throw new Error("generation_report_read_failed");
  const upperRow = upperRows?.[0];
  const upper = upperRow ? { primary: upperRow.created_at, id: upperRow.id } : null;
  const runs: Run[] = [];
  let cursor: Keyset | null = null;
  while (upper) {
    const query: any = apply(db.from("retrieval_generation_runs").select(columns))
      .or(keysetWindow("created_at", cursor, upper)).order("created_at", { ascending: true }).order("id", { ascending: true })
      .limit(RETRIEVAL_PAGE_SIZE);
    const { data, error }: any = await query;
    if (error) throw new Error("generation_report_read_failed");
    if (!(data ?? []).length) break;
    runs.push(...data);
    const last: any = data[data.length - 1];
    cursor = { primary: last.created_at, id: last.id };
  }

  const candidates: Candidate[] = [];
  for (let offset = 0; offset < runs.length; offset += RETRIEVAL_PAGE_SIZE) {
    const ids = runs.slice(offset, offset + RETRIEVAL_PAGE_SIZE).map((run) => run.id);
    if (!ids.length) continue;
    const { data: candidateUpperRows, error: candidateUpperError } = await db.from("retrieval_generation_candidates")
      .select("id").in("run_id", ids).lte("created_at", observedFrom).order("id", { ascending: false }).limit(1);
    if (candidateUpperError) throw new Error("generation_report_read_failed");
    const candidateUpper = candidateUpperRows?.[0]?.id as string | undefined;
    let candidateCursor: string | null = null;
    while (candidateUpper) {
      let query = db.from("retrieval_generation_candidates")
        .select("id,run_id,injected,selection_decision,review_label").in("run_id", ids)
        .lte("id", candidateUpper).lte("created_at", observedFrom)
        .order("id", { ascending: true }).limit(RETRIEVAL_PAGE_SIZE);
      if (candidateCursor) query = query.gt("id", candidateCursor);
      const { data, error } = await query;
      if (error) throw new Error("generation_report_read_failed");
      if (!(data ?? []).length) break;
      candidates.push(...data);
      candidateCursor = data[data.length - 1].id;
    }
  }
  let survivingRuns = 0;
  for (let offset = 0; offset < runs.length; offset += RETRIEVAL_PAGE_SIZE) {
    const ids = runs.slice(offset, offset + RETRIEVAL_PAGE_SIZE).map((run) => run.id);
    const { data, error } = await db.from("retrieval_generation_runs").select("id").in("id", ids);
    if (error) throw new Error("generation_report_read_failed");
    survivingRuns += (data ?? []).length;
  }
  return { runs, candidates, dataComplete: generationDataComplete(runs, candidates, survivingRuns) };
}

export function buildGenerationReport(runs: Run[], candidates: Candidate[]) {
  const byRun = new Map<string, Candidate[]>();
  for (const candidate of candidates) byRun.set(candidate.run_id, [...(byRun.get(candidate.run_id) ?? []), candidate]);
  const top5Runs = runs.filter((run) => run.selection_strategy === "top5_all");
  const top20Runs = runs.filter((run) => run.selection_strategy === "top20_local_rerank");
  const evidenceRuns = runs.filter((run) => run.selection_strategy === "user_evidence_top20");
  const adaptiveRuns = runs.filter((run) => run.selection_strategy === "user_evidence_adaptive");
  const phase21Review = buildReview(top5Runs, byRun, 25, false);
  const phase22Review = buildReview(top20Runs, byRun, 10, true);
  const phase21Pass = passesQualityGate(phase21Review);
  const timeoutCount = top20Runs.filter((run) => run.error_code?.endsWith("_timeout")).length;
  const timeoutRate = ratio(timeoutCount, top20Runs.length);
  const phase22MetricsPass = passesQualityGate(phase22Review) && timeoutRate <= 0.1;
  const phase23Review = buildReview(evidenceRuns, byRun, 10, true);
  const evidenceTimeoutCount = evidenceRuns.filter((run) => run.error_code?.endsWith("_timeout")).length;
  const evidenceTimeoutRate = ratio(evidenceTimeoutCount, evidenceRuns.length);
  const phase23MetricsPass = passesQualityGate(phase23Review) && evidenceTimeoutRate <= 0.1;
  const phase24Review = buildReview(adaptiveRuns, byRun, 10, true);
  const adaptiveTimeoutCount = adaptiveRuns.filter((run) => run.error_code?.endsWith("_timeout")).length;
  const adaptiveTimeoutRate = ratio(adaptiveTimeoutCount, adaptiveRuns.length);
  const phase24MetricsPass = passesQualityGate(phase24Review) && adaptiveTimeoutRate <= 0.1;
  const top20RunIds = new Set(top20Runs.map((run) => run.id));
  const evidenceRunIds = new Set(evidenceRuns.map((run) => run.id));
  const decisionCounts = selectionDecisionCounts(candidates, top20RunIds);
  const evidenceDecisionCounts = selectionDecisionCounts(candidates, evidenceRunIds);
  const adaptiveRunIds = new Set(adaptiveRuns.map((run) => run.id));
  const adaptiveDecisionCounts = selectionDecisionCounts(candidates, adaptiveRunIds);
  return {
    generatedAt: new Date().toISOString(),
    privacy: "No chat content is included.",
    strategies: {
      thresholdTop2: summarizeStatuses(runs.filter((run) => run.selection_strategy === "threshold_top2")),
      top5All: summarizeStatuses(top5Runs),
      top20LocalRerank: summarizeStatuses(top20Runs),
      userEvidenceTop20: summarizeStatuses(evidenceRuns),
      userEvidenceAdaptive: summarizeStatuses(adaptiveRuns)
    },
    top5AllRuns: summarizeStatuses(top5Runs),
    top20LocalRerankRuns: summarizeStatuses(top20Runs),
    userEvidenceTop20Runs: summarizeStatuses(evidenceRuns),
    userEvidenceAdaptiveRuns: summarizeStatuses(adaptiveRuns),
    errors: errorsFor(top5Runs),
    review: phase21Review,
    latencyMs: latencyFor(top5Runs),
    tokens: tokensFor(top5Runs),
    completionCriteria: completionCriteria(phase21Review),
    phase21Pass,
    phase22: {
      errors: errorsFor(top20Runs),
      timeoutCount,
      timeoutRate,
      selectionDecisions: decisionCounts,
      review: phase22Review,
      latencyMs: latencyFor(top20Runs),
      tokens: tokensFor(top20Runs),
      completionCriteria: {
        ...completionCriteria(phase22Review),
        timeoutAtMost10Percent: top20Runs.length > 0 && timeoutRate <= 0.1,
        fixedSmokeCases: "manual"
      },
      metricsPass: phase22MetricsPass
    },
    phase23: {
      errors: errorsFor(evidenceRuns),
      timeoutCount: evidenceTimeoutCount,
      timeoutRate: evidenceTimeoutRate,
      selectionDecisions: evidenceDecisionCounts,
      review: phase23Review,
      latencyMs: latencyFor(evidenceRuns),
      tokens: tokensFor(evidenceRuns),
      completionCriteria: {
        ...completionCriteria(phase23Review),
        timeoutAtMost10Percent: evidenceRuns.length > 0 && evidenceTimeoutRate <= 0.1,
        fixedSmokeCases: "manual"
      },
      metricsPass: phase23MetricsPass
    },
    phase24: {
      errors: errorsFor(adaptiveRuns),
      timeoutCount: adaptiveTimeoutCount,
      timeoutRate: adaptiveTimeoutRate,
      selectionDecisions: adaptiveDecisionCounts,
      review: phase24Review,
      latencyMs: latencyFor(adaptiveRuns),
      tokens: tokensFor(adaptiveRuns),
      completionCriteria: {
        ...completionCriteria(phase24Review),
        timeoutAtMost10Percent: adaptiveRuns.length > 0 && adaptiveTimeoutRate <= 0.1,
        fixedSmokeCases: "manual"
      },
      metricsPass: phase24MetricsPass
    }
  };
}

function buildReview(
  runs: Run[],
  byRun: Map<string, Candidate[]>,
  targetInjectedRuns: number,
  injectedLabelsOnly: boolean
) {
  const injectedRuns = runs.filter((run) => run.status === "injected");
  const reviewed = injectedRuns.filter((run) =>
    run.response_effect && (byRun.get(run.id)?.length ?? 0) > 0 && byRun.get(run.id)!.every((candidate) => candidate.review_label)
  );
  const correctlyReviewed = injectedLabelsOnly
    ? injectedRuns.filter((run) => {
      const injected = (byRun.get(run.id) ?? []).filter((candidate) => candidate.injected);
      return run.response_effect && injected.length > 0 && injected.every((candidate) => candidate.review_label);
    })
    : reviewed;
  const injectedReviewedCandidates = correctlyReviewed.flatMap((run) => (byRun.get(run.id) ?? []).filter((candidate) => candidate.injected));
  const usefulInjected = injectedReviewedCandidates.filter((candidate) => candidate.review_label === "must" || candidate.review_label === "acceptable").length;
  const forbiddenInjected = injectedReviewedCandidates.filter((candidate) => candidate.review_label === "forbidden").length;
  const irrelevantInjected = injectedReviewedCandidates.filter((candidate) => candidate.review_label === "irrelevant").length;
  const helpful = correctlyReviewed.filter((run) => run.response_effect === "helpful").length;
  const neutral = correctlyReviewed.filter((run) => run.response_effect === "neutral").length;
  const harmful = correctlyReviewed.filter((run) => run.response_effect === "harmful").length;
  const stale = correctlyReviewed.filter((run) => run.stale_detected).length;
  const sensitive = correctlyReviewed.filter((run) => run.sensitive_detected).length;
  return {
      targetInjectedRuns,
      reviewedInjectedRuns: correctlyReviewed.length,
      helpful,
      neutral,
      harmful,
      stale,
      sensitive,
      helpfulRate: ratio(helpful, correctlyReviewed.length),
      injectedCandidatePrecision: ratio(usefulInjected, injectedReviewedCandidates.length),
      injectedForbidden: forbiddenInjected,
      injectedIrrelevant: irrelevantInjected,
      injectedIrrelevantRate: ratio(irrelevantInjected, injectedReviewedCandidates.length),
      averageInjectedChunks: ratio(injectedRuns.reduce((sum, run) => sum + Number(run.injected_count), 0), injectedRuns.length)
  };
}

function passesQualityGate(review: ReturnType<typeof buildReview>) {
  return review.reviewedInjectedRuns >= review.targetInjectedRuns
    && review.helpfulRate >= 0.5
    && review.harmful === 0
    && review.stale === 0
    && review.sensitive === 0
    && review.injectedForbidden === 0;
}

function completionCriteria(review: ReturnType<typeof buildReview>) {
  return {
    reviewedAtLeastTarget: review.reviewedInjectedRuns >= review.targetInjectedRuns,
    helpfulAtLeast50Percent: review.reviewedInjectedRuns > 0 && review.helpfulRate >= 0.5,
    zeroHarmfulStaleSensitive: review.harmful === 0 && review.stale === 0 && review.sensitive === 0,
    zeroInjectedForbidden: review.injectedForbidden === 0
  };
}

function errorsFor(runs: Run[]) {
  return Object.fromEntries([...new Set(runs.map((run) => run.error_code).filter(Boolean))]
    .map((code) => [code!, runs.filter((run) => run.error_code === code).length]));
}

function latencyFor(runs: Run[]) {
  return {
    embeddingP50: percentile(runs.map((run) => Number(run.embedding_latency_ms)), 0.5),
    embeddingP95: percentile(runs.map((run) => Number(run.embedding_latency_ms)), 0.95),
    searchP50: percentile(runs.map((run) => Number(run.search_latency_ms)), 0.5),
    searchP95: percentile(runs.map((run) => Number(run.search_latency_ms)), 0.95),
    retrievalP50: percentile(runs.map((run) => Number(run.total_retrieval_latency_ms)), 0.5),
    retrievalP95: percentile(runs.map((run) => Number(run.total_retrieval_latency_ms)), 0.95)
  };
}

function tokensFor(runs: Run[]) {
  const injectedRuns = runs.filter((run) => run.status === "injected");
  const contextRatios = injectedRuns
    .filter((run) => run.history_20_tokens > 0)
    .map((run) => (run.history_10_tokens + run.retrieval_tokens) / run.history_20_tokens);
  const tokenSavings = contextRatios.map((ratioValue) => 1 - ratioValue);
  return {
    history10Median: percentile(runs.map((run) => Number(run.history_10_tokens)), 0.5),
    history20Median: percentile(runs.map((run) => Number(run.history_20_tokens)), 0.5),
    retrievalMedian: percentile(injectedRuns.map((run) => Number(run.retrieval_tokens)), 0.5),
    actualInputMedian: percentile(runs.flatMap((run) => run.actual_input_tokens === null ? [] : [Number(run.actual_input_tokens)]), 0.5),
    outputMedian: percentile(runs.flatMap((run) => run.output_tokens === null ? [] : [Number(run.output_tokens)]), 0.5),
    historyPlusRetrievalVsHistory20Median: percentile(contextRatios, 0.5),
    estimatedSavingsMedian: percentile(tokenSavings, 0.5)
  };
}

function summarizeStatuses(runs: Run[]) {
  return Object.fromEntries(["injected", "abstained", "fallback"].map((status) => [
    status,
    runs.filter((run) => run.status === status).length
  ])) as Record<"injected" | "abstained" | "fallback", number>;
}

function selectionDecisionCounts(candidates: Candidate[], runIds: Set<string>) {
  return Object.fromEntries([
    "selected", "recall_probe_only", "boilerplate_only", "duplicate", "below_relevance", "not_selected", "invalid_source"
  ].map((decision) => [decision, candidates.filter((candidate) =>
    runIds.has(candidate.run_id) && candidate.selection_decision === decision
  ).length]));
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? 0;
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 0;
}

function nullableRatio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : null;
}

export function buildPhase25Evaluation(
  runs: Run[], candidates: Candidate[], dataComplete = true, qualityGateEligible = true
) {
  const complete = runs.filter((run) => run.review_completed_at && run.manifest_verification === "verified");
  const required = complete.filter((run) => run.retrieval_need === "required");
  const notNeeded = complete.filter((run) => run.retrieval_need === "not_needed");
  const knownRequired = required.filter((run) => (run.evidence_groups?.length ?? 0) > 0);
  const searchCompletedRequired = knownRequired.filter((run) => run.status !== "fallback");
  const hit20 = searchCompletedRequired.filter((run) => [
    "injected_complete", "injected_truncated", "candidate_not_injected"
  ].includes(run.evidence_resolution ?? ""));
  const injectionHits = knownRequired.filter((run) =>
    run.status === "injected" && run.evidence_resolution === "injected_complete"
  );
  const completedSearchNotNeeded = notNeeded.filter((run) => run.status !== "fallback");
  const currentRunIds = new Set(runs.map((run) => run.id));
  const review = buildReview(complete, groupCandidates(candidates), 10, true);
  const timeoutCount = runs.filter((run) => run.error_code?.endsWith("_timeout")).length;
  const userCount = new Set(runs.map((run) => run.user_id).filter(Boolean)).size;
  const sampleSufficient = knownRequired.length >= 10 && notNeeded.length >= 10 && review.reviewedInjectedRuns >= 10;
  const qualityChecksPass = qualityGateEligible && dataComplete && userCount <= 1 && sampleSufficient
    && passesQualityGate(review) && nullableRatio(timeoutCount, runs.length)! <= 0.1;
  return {
    evaluationVersion: RETRIEVAL_GENERATION.evaluationVersion,
    dataComplete,
    qualityGateEligible,
    userGroups: userCount,
    reviewed: { total: complete.length, required: required.length, notNeeded: notNeeded.length },
    coverage: {
      unreviewed: runs.filter((run) => !run.review_completed_at).length,
      unverifiable: runs.filter((run) => run.manifest_verification === "unverifiable").length,
      legacyApproximate: runs.filter((run) => run.manifest_verification === "legacy_approximate").length,
      unresolved: complete.filter((run) => run.evidence_resolution === "unresolved").length
    },
    knownEvidenceHitAt20: nullableRatio(hit20.length, searchCompletedRequired.length),
    injectedEvidenceHitRate: nullableRatio(injectionHits.length, knownRequired.length),
    selectionMisses: required.filter((run) => ["candidate_not_injected", "injected_truncated"].includes(run.evidence_resolution ?? "")).length,
    outsideCandidatePoolMisses: required.filter((run) => run.evidence_resolution === "outside_candidate_pool").length,
    fallbackRequired: required.filter((run) => run.status === "fallback").length,
    correctAbstentionRate: nullableRatio(
      completedSearchNotNeeded.filter((run) => run.status === "abstained").length,
      completedSearchNotNeeded.length
    ),
    unnecessaryInjectionRate: nullableRatio(
      completedSearchNotNeeded.filter((run) => run.status === "injected").length,
      completedSearchNotNeeded.length
    ),
    timeoutRate: nullableRatio(timeoutCount, runs.length),
    observedDynamicSettings: {
      effectiveThreshold: numberRange(runs.flatMap((run) => run.effective_threshold === null
        || run.effective_threshold === undefined ? [] : [Number(run.effective_threshold)])),
      searchBeforeSequence: numberRange(runs.flatMap((run) => run.search_before_sequence === null
        || run.search_before_sequence === undefined ? [] : [Number(run.search_before_sequence)]))
    },
    settings: summarizeSettings(runs),
    review,
    selectionDecisions: selectionDecisionCounts(candidates, currentRunIds),
    sampleSufficient,
    qualityChecksPass,
    goNoGo: "manual"
  };
}

export function buildPhase25UserGroups(runs: Run[], candidates: Candidate[], dataComplete: boolean, singleUser = false) {
  const users = [...new Set(runs.map((run) => run.user_id).filter((id): id is string => Boolean(id)))].sort();
  return Object.fromEntries(users.map((userId, index) => {
    const userRuns = runs.filter((run) => run.user_id === userId);
    const ids = new Set(userRuns.map((run) => run.id));
    const userCandidates = candidates.filter((candidate) => ids.has(candidate.run_id));
    const expected = userRuns.reduce((sum, run) => sum + Number(run.candidate_count ?? 0), 0);
    return [singleUser ? "single_user" : `user_${index + 1}`, buildPhase25Evaluation(
      userRuns, userCandidates, dataComplete && expected === userCandidates.length, true
    )];
  }));
}

export function generationDataComplete(runs: Run[], candidates: Candidate[], survivingRuns = runs.length) {
  const expected = runs.reduce((sum, run) => sum + Number(run.candidate_count ?? 0), 0);
  return expected === candidates.length && survivingRuns === runs.length;
}

function summarizeSettings(runs: Run[]) {
  const signatures = new Map<string, number>();
  for (const run of runs) {
    const setting = {
      selectionStrategy: run.selection_strategy,
      generationModel: run.model ?? "legacy_unknown",
      embeddingModel: run.embedding_model ?? "legacy_unknown",
      dimensions: run.dimensions ?? null,
      chunkStrategy: run.chunk_strategy ?? "legacy_unknown",
      injectionStrategy: run.injection_strategy ?? "legacy_unknown",
      candidateLimit: run.candidate_limit ?? null,
      injectionLimit: run.injection_limit ?? null,
      historyLimit: run.history_limit ?? null,
      retrievalTokenBudget: run.retrieval_token_budget ?? null,
      selectionVersion: run.selection_version ?? "legacy_unknown",
      queryBuilderVersion: run.query_builder_version ?? "legacy_unknown",
      evidenceFilterVersion: run.evidence_filter_version ?? "legacy_unknown",
      contextFormatterVersion: run.context_formatter_version ?? "legacy_unknown",
      minimumScore: run.minimum_score ?? null,
      relativeScoreRatio: run.relative_score_ratio ?? null,
      timeoutMs: run.retrieval_timeout_ms ?? null
    };
    const key = JSON.stringify(setting);
    signatures.set(key, (signatures.get(key) ?? 0) + 1);
  }
  return [...signatures].map(([setting, runsCount]) => ({ ...JSON.parse(setting), runs: runsCount }));
}

function numberRange(values: number[]) {
  return values.length ? { minimum: Math.min(...values), maximum: Math.max(...values) } : null;
}

function groupCandidates(candidates: Candidate[]) {
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) grouped.set(candidate.run_id, [...(grouped.get(candidate.run_id) ?? []), candidate]);
  return grouped;
}

function createdAtRange(rows: Array<{ created_at?: string }>) {
  const values = rows.flatMap((row) => row.created_at ? [row.created_at] : []).sort();
  return { earliest: values[0] ?? null, latest: values.at(-1) ?? null };
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

function markdown(report: ReturnType<typeof buildGenerationReport> & {
  scope?: unknown;
  dataComplete?: boolean;
  rowsRead?: { runs: number; candidates: number };
  dataRange?: { earliest: string | null; latest: string | null };
  phase25?: ReturnType<typeof buildPhase25Evaluation> | null;
  phase25Groups?: Record<string, ReturnType<typeof buildPhase25Evaluation>>;
}) {
  const groupRows = Object.entries(report.phase25Groups ?? {}).map(([group, evaluation]) =>
    `| ${group} | ${evaluation.reviewed.required} | ${evaluation.reviewed.notNeeded} | ${formatRatio(evaluation.knownEvidenceHitAt20)} | ${formatRatio(evaluation.injectedEvidenceHitRate)} | ${evaluation.sampleSufficient ? "YES" : "NO"} | ${evaluation.qualityChecksPass ? "YES" : "NO"} |`
  );
  return [
    "# Retrieval Generation Canary Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "> No chat content is included.",
    "",
    `Scope and observation window: ${JSON.stringify(report.scope ?? {})}`,
    `Rows read: ${JSON.stringify(report.rowsRead ?? {})}`,
    `Run data range: ${JSON.stringify(report.dataRange ?? {})}`,
    `Data complete: ${report.dataComplete ? "YES" : "NO"}`,
    `Observed settings: ${JSON.stringify(report.phase25?.settings ?? [])}`,
    "",
    ...(report.phase25 ? [
      `Phase 2.5 data complete: ${report.phase25.dataComplete ? "YES" : "NO"}`,
      `Phase 2.5 reviewed required / not needed: ${report.phase25.reviewed.required} / ${report.phase25.reviewed.notNeeded}`,
      `Known evidence Hit@20: ${formatRatio(report.phase25.knownEvidenceHitAt20)}`,
      `Injected evidence hit: ${formatRatio(report.phase25.injectedEvidenceHitRate)}`,
      `Correct abstention: ${formatRatio(report.phase25.correctAbstentionRate)}`,
      `Unnecessary injection: ${formatRatio(report.phase25.unnecessaryInjectionRate)}`,
      `Sample sufficient: ${report.phase25.sampleSufficient ? "YES" : "NO"}`,
      `Quality checks pass: ${report.phase25.qualityChecksPass ? "YES" : "NO"}; go/no-go remains manual`,
      ""
    ] : []),
    ...(groupRows.length ? [
      "## Phase 2.5 anonymous user groups",
      "",
      "| Group | Required | Not needed | Hit@20 | Injected evidence hit | Sample sufficient | Quality checks pass |",
      "| --- | ---: | ---: | ---: | ---: | --- | --- |",
      ...groupRows,
      ""
    ] : []),
    `Adaptive user evidence injected / abstained / fallback: ${report.userEvidenceAdaptiveRuns.injected} / ${report.userEvidenceAdaptiveRuns.abstained} / ${report.userEvidenceAdaptiveRuns.fallback}`,
    `Adaptive timeout rate: ${(report.phase24.timeoutRate * 100).toFixed(1)}%`,
    `Adaptive reviewed injected runs: ${report.phase24.review.reviewedInjectedRuns} / ${report.phase24.review.targetInjectedRuns}`,
    `Adaptive helpful / neutral / harmful: ${report.phase24.review.helpful} / ${report.phase24.review.neutral} / ${report.phase24.review.harmful}`,
    `Adaptive selection decisions: ${JSON.stringify(report.phase24.selectionDecisions)}`,
    `Adaptive retrieval latency P50 / P95: ${report.phase24.latencyMs.retrievalP50} / ${report.phase24.latencyMs.retrievalP95} ms`,
    `Adaptive metrics pass (fixed smoke cases are manual): ${report.phase24.metricsPass ? "YES" : "NO"}`,
    "",
    "Historical Phase 2.3:",
    `User evidence Top 20 injected / abstained / fallback: ${report.userEvidenceTop20Runs.injected} / ${report.userEvidenceTop20Runs.abstained} / ${report.userEvidenceTop20Runs.fallback}`,
    `User evidence timeout rate: ${(report.phase23.timeoutRate * 100).toFixed(1)}%`,
    `User evidence reviewed injected runs: ${report.phase23.review.reviewedInjectedRuns} / ${report.phase23.review.targetInjectedRuns}`,
    `User evidence helpful / neutral / harmful: ${report.phase23.review.helpful} / ${report.phase23.review.neutral} / ${report.phase23.review.harmful}`,
    `User evidence selection decisions: ${JSON.stringify(report.phase23.selectionDecisions)}`,
    `User evidence retrieval latency P50 / P95: ${report.phase23.latencyMs.retrievalP50} / ${report.phase23.latencyMs.retrievalP95} ms`,
    `User evidence metrics pass (fixed smoke cases are manual): ${report.phase23.metricsPass ? "YES" : "NO"}`,
    "",
    "Historical Phase 2.2:",
    `Top 20 local rerank injected / abstained / fallback: ${report.top20LocalRerankRuns.injected} / ${report.top20LocalRerankRuns.abstained} / ${report.top20LocalRerankRuns.fallback}`,
    `Top 20 timeout rate: ${(report.phase22.timeoutRate * 100).toFixed(1)}%`,
    `Top 20 reviewed injected runs: ${report.phase22.review.reviewedInjectedRuns} / ${report.phase22.review.targetInjectedRuns}`,
    `Top 20 helpful / neutral / harmful: ${report.phase22.review.helpful} / ${report.phase22.review.neutral} / ${report.phase22.review.harmful}`,
    `Top 20 selection decisions: ${JSON.stringify(report.phase22.selectionDecisions)}`,
    `Top 20 retrieval latency P50 / P95: ${report.phase22.latencyMs.retrievalP50} / ${report.phase22.latencyMs.retrievalP95} ms`,
    `Top 20 metrics pass (fixed smoke cases are manual): ${report.phase22.metricsPass ? "YES" : "NO"}`,
    "",
    `Historical Top 5 injected / abstained / fallback: ${report.top5AllRuns.injected} / ${report.top5AllRuns.abstained} / ${report.top5AllRuns.fallback}`,
    `Historical Top 2 injected / abstained / fallback: ${report.strategies.thresholdTop2.injected} / ${report.strategies.thresholdTop2.abstained} / ${report.strategies.thresholdTop2.fallback}`,
    `Historical Top 5 reviewed injected runs: ${report.review.reviewedInjectedRuns} / ${report.review.targetInjectedRuns}`,
    `Helpful / Neutral / Harmful: ${report.review.helpful} / ${report.review.neutral} / ${report.review.harmful}`,
    `Stale / Sensitive / Injected forbidden: ${report.review.stale} / ${report.review.sensitive} / ${report.review.injectedForbidden}`,
    `Helpful rate: ${(report.review.helpfulRate * 100).toFixed(1)}%`,
    `Injected candidate precision: ${(report.review.injectedCandidatePrecision * 100).toFixed(1)}%`,
    `Injected irrelevant rate: ${(report.review.injectedIrrelevantRate * 100).toFixed(1)}%`,
    `Average injected chunks: ${report.review.averageInjectedChunks.toFixed(2)}`,
    `Median context token savings vs history 20: ${(report.tokens.estimatedSavingsMedian * 100).toFixed(1)}%`,
    `Retrieval latency P50 / P95: ${report.latencyMs.retrievalP50} / ${report.latencyMs.retrievalP95} ms`,
    "",
    `Historical Phase 2.1 Top 5 pass: ${report.phase21Pass ? "YES" : "NO"}`,
    ""
  ].join("\n");
}

function formatRatio(value: number | null) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[retrieval-generation:report] ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  });
}
