import "dotenv/config";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import type { Message } from "@softplace/shared";
import { config } from "../config.js";
import {
  RETRIEVAL_GENERATION,
  replayGenerationManifest,
  type GenerationManifest
} from "../domain/retrievalGeneration.js";
import { supabaseAdmin } from "../integrations/supabase.js";
import {
  RETRIEVAL_PAGE_SIZE, keysetWindow,
  type Keyset
} from "./retrievalPagination.js";

const candidateLabels = { m: "must", a: "acceptable", f: "forbidden", i: "irrelevant" } as const;
const effects = { h: "helpful", n: "neutral", x: "harmful" } as const;
const needs = { r: "required", n: "not_needed", u: "uncertain" } as const;
const questionTypes = {
  e: "explicit_recall", n: "new_topic", a: "ambiguous_reference", c: "recent_context_reference", o: "other"
} as const;
type ReviewStatus = "all" | "injected" | "abstained" | "fallback";

export type GenerationReviewArgs = {
  userId: string;
  limit: number;
  status: ReviewStatus;
  version: string;
  from?: string;
  to?: string;
  runId?: string;
  redo: boolean;
};

export function parseGenerationReviewArgs(argv: string[]): GenerationReviewArgs {
  const userId = option(argv, "user-id");
  if (!userId) throw new Error("--user-id is required");
  const runId = option(argv, "run-id");
  const explicitLimit = option(argv, "limit");
  const explicitStatus = option(argv, "status");
  const from = instant(option(argv, "from"));
  const to = instant(option(argv, "to"));
  const redo = argv.includes("--redo");
  if (runId && (explicitLimit || explicitStatus || from || to)) {
    throw new Error("--run-id cannot be combined with --limit, --status, --from, or --to");
  }
  if (redo && !runId) throw new Error("--redo requires --run-id");
  const limit = Number(explicitLimit ?? (runId ? 1 : 10));
  const status = (explicitStatus ?? "all") as ReviewStatus;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  if (!["all", "injected", "abstained", "fallback"].includes(status)) throw new Error("invalid --status");
  if (from && to && from >= to) throw new Error("--from must be before --to");
  return {
    userId, limit, status, version: option(argv, "version") ?? RETRIEVAL_GENERATION.evaluationVersion,
    ...(from ? { from } : {}), ...(to ? { to } : {}), ...(runId ? { runId } : {}), redo
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseGenerationReviewArgs(argv);
  if (!config.retrievalShadowUserIds.has(args.userId)) throw new Error("user is not in RETRIEVAL_SHADOW_USER_IDS");
  if (!supabaseAdmin) throw new Error("Supabase configuration is required");
  const db = supabaseAdmin;
  const rl = readline.createInterface({ input, output });
  let reviewedRuns = 0;
  try {
    if (args.runId) {
      const run = await loadOneRun(db, args);
      if ((!run.review_completed_at || args.redo) && await reviewRun(db, rl, args, run)) reviewedRuns = 1;
    } else {
      const observedAt = new Date().toISOString();
      const upper = await loadReviewUpper(db, args, observedAt);
      reviewedRuns = await scanGenerationReviewRuns({
        limit: args.limit,
        upper,
        async loadPage(cursor, fixedUpper, pageSize) {
          const query: any = applyRunFilters(baseRunQuery(db, args), args, observedAt)
            .or(keysetWindow("created_at", cursor, fixedUpper))
            .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(pageSize);
          const { data, error }: any = await query;
          if (error) throw new Error("generation_review_read_failed");
          return data ?? [];
        },
        async reviewRun(run: any) {
          if (run.review_completed_at) return false;
          return reviewRun(db, rl, args, run);
        }
      });
    }
  } finally {
    rl.close();
  }
  console.info("[retrieval-generation:review]", { reviewedRuns });
  return { reviewedRuns };
}

async function loadOneRun(db: any, args: GenerationReviewArgs) {
  const { data, error } = await baseRunQuery(db, args).eq("id", args.runId)
    .eq("evaluation_version", args.version).maybeSingle();
  if (error) throw new Error("generation_review_read_failed");
  if (!data) throw new Error("generation_review_not_found");
  return data;
}

async function loadReviewUpper(db: any, args: GenerationReviewArgs, observedAt: string): Promise<Keyset | null> {
  const { data: upperRows, error: upperError } = await applyRunFilters(
    db.from("retrieval_generation_runs").select("id,created_at"), args, observedAt
  )
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (upperError) throw new Error("generation_review_read_failed");
  const upperRow = upperRows?.[0];
  return upperRow ? { primary: upperRow.created_at, id: upperRow.id } : null;
}

function applyRunFilters(query: any, args: GenerationReviewArgs, observedAt: string) {
  let next = query.eq("user_id", args.userId).eq("evaluation_version", args.version).lte("created_at", observedAt);
  if (args.status !== "all") next = next.eq("status", args.status);
  if (args.from) next = next.gte("created_at", args.from);
  if (args.to) next = next.lt("created_at", args.to);
  return next;
}

export async function scanGenerationReviewRuns<T extends { id: string; created_at: string }>(input: {
  limit: number;
  upper: Keyset | null;
  pageSize?: number;
  loadPage: (cursor: Keyset | null, upper: Keyset, limit: number) => Promise<T[]>;
  reviewRun: (run: T) => Promise<boolean>;
}) {
  if (!input.upper) return 0;
  let reviewed = 0;
  let cursor: Keyset | null = null;
  while (reviewed < input.limit) {
    const page = await input.loadPage(cursor, input.upper, input.pageSize ?? RETRIEVAL_PAGE_SIZE);
    if (!page.length) break;
    for (const run of page) {
      cursor = { primary: run.created_at, id: run.id };
      if (await input.reviewRun(run)) reviewed += 1;
      if (reviewed >= input.limit) break;
    }
  }
  return reviewed;
}

function baseRunQuery(db: any, args: GenerationReviewArgs) {
  return db.from("retrieval_generation_runs").select([
    "id,user_id,conversation_id,query_message_id,assistant_message_id,status,candidate_count,created_at",
    "evaluation_version,retrieval_need,question_type,evidence_groups,evidence_resolution",
    "manifest_verification,review_completed_at,response_effect,stale_detected,sensitive_detected"
  ].join(",")).eq("user_id", args.userId);
}

async function reviewRun(db: any, rl: readline.Interface, args: GenerationReviewArgs, run: any) {
  const [queryResult, assistantResult, manifestResult, candidates] = await Promise.all([
    db.from("messages").select("id,conversation_id,message_sequence,role,content").eq("id", run.query_message_id).maybeSingle(),
    db.from("messages").select("id,content").eq("id", run.assistant_message_id).maybeSingle(),
    db.from("retrieval_generation_manifests").select("manifest").eq("run_id", run.id).maybeSingle(),
    loadCandidates(db, run.id)
  ]);
  if (queryResult.error || assistantResult.error || manifestResult.error) throw new Error("generation_review_read_failed");
  const query = queryResult.data;
  const assistant = assistantResult.data;
  const manifestRow = manifestResult.data;
  if (!query || !assistant) throw new Error("generation_review_source_missing");
  const manifest = manifestRow?.manifest as GenerationManifest | undefined;
  const sourceIds = new Set<string>([query.id]);
  if (manifest) {
    manifest.historyMessageIds.forEach((id) => sourceIds.add(id));
    manifest.queryContext.forEach((item) => sourceIds.add(item.messageId));
    manifest.injectedCandidates.forEach((candidate) => candidate.messages.forEach((item) => sourceIds.add(item.messageId)));
  }
  const sourceMessages = await loadMessagesById(db, [...sourceIds]);
  const replay = manifest
    ? replayGenerationManifest(manifest, sourceMessages, query.id)
    : { verification: run.evaluation_version === RETRIEVAL_GENERATION.evaluationVersion
      ? "unverifiable" as const : "legacy_approximate" as const,
      reason: "manifest_missing", history: [], embeddingInput: null, retrievalContext: null };
  const reviewHistory = replay.history.length ? replay.history : (manifest?.historyMessageIds ?? [])
    .map((id) => sourceMessages.get(id)).filter(Boolean) as Array<{ id: string; role: string; content: string }>;

  console.info(formatNeedReviewHeader(run.id, reviewHistory, query.content, run.status, replay.verification, replay.reason));
  let retrievalNeed = args.redo ? null : run.retrieval_need;
  let questionType = args.redo ? null : run.question_type;
  if (!retrievalNeed || !questionType) {
    retrievalNeed = answer( await rl.question("Need old evidence? [r]equired [n]ot-needed [u]ncertain: "), needs, "invalid retrieval need");
    questionType = answer(await rl.question("Question type [e]xplicit [n]ew [a]mbiguous [c]ontext-reference [o]ther: "), questionTypes, "invalid question type");
    await saveReview(db, run.id, args.userId, {
      retrievalNeed, questionType, evidenceGroups: [], evidenceResolution: retrievalNeed === "not_needed" ? "not_applicable" : "unresolved",
      manifestVerification: replay.verification, responseEffect: null, stale: null, sensitive: null, complete: false
    });
  }

  console.info(formatGenerationCandidateDecisions(candidates));
  console.info(`Verified injected context: ${replay.retrievalContext ?? "[none]"}`);
  console.info(`Generated response: ${assistant.content}`);
  const pending = candidates.filter((candidate: any) => candidate.injected && (args.redo || !candidate.review_label));
  for (const candidate of pending) {
    const label = answer(await rl.question(`${formatGenerationCandidate(candidate)}\n${candidate.dialogue || "[missing]"}\n[m]ust [a]cceptable [f]orbidden [i]rrelevant: `), candidateLabels, "invalid review label");
    const { error } = await db.from("retrieval_generation_candidates")
      .update({ review_label: label, reviewed_at: new Date().toISOString() }).eq("id", candidate.id);
    if (error) throw new Error("generation_review_write_failed");
  }

  let evidenceGroups: string[][] = args.redo ? [] : (run.evidence_groups ?? []);
  let evidenceResolution = retrievalNeed === "not_needed" ? "not_applicable" : "unresolved";
  if (retrievalNeed === "required" && (!evidenceGroups.length || args.redo)) {
    evidenceGroups = await askForEvidenceGroups(db, rl, args.userId, query.conversation_id, Number(query.message_sequence));
    await saveReview(db, run.id, args.userId, {
      retrievalNeed, questionType, evidenceGroups, evidenceResolution: evidenceGroups.length ? "unresolved" : "unresolved",
      manifestVerification: replay.verification, responseEffect: null, stale: null, sensitive: null, complete: false
    });
  }
  if (retrievalNeed === "required" && evidenceGroups.length) {
    evidenceResolution = resolveEvidence(evidenceGroups, manifest, candidates, sourceMessages, run.status);
    console.info(`Evidence resolution: ${evidenceResolution}`);
    if (evidenceResolution === "in_recent_history") {
      const correction = (await rl.question("Evidence was already in recent history. Change need to not_needed? [y/n]: ")).trim().toLowerCase();
      if (yesNo(correction)) {
        retrievalNeed = "not_needed";
        evidenceResolution = "not_applicable";
      }
    }
  } else if (retrievalNeed === "uncertain") evidenceResolution = "unresolved";

  const responseEffect = answer(await rl.question("Response effect [h]elpful [n]eutral harmful[x]: "), effects, "invalid response effect");
  const stale = yesNo(await rl.question("Stale information used? [y/n]: "));
  const sensitive = yesNo(await rl.question("Sensitive detail raised inappropriately? [y/n]: "));
  await saveReview(db, run.id, args.userId, {
    retrievalNeed, questionType, evidenceGroups, evidenceResolution, manifestVerification: replay.verification,
    responseEffect, stale, sensitive, complete: true
  });
  return true;
}

async function askForEvidenceGroups(db: any, rl: readline.Interface, userId: string, conversationId: string, beforeSequence: number) {
  while (true) {
    const raw = (await rl.question("Evidence message IDs (comma=joint, semicolon=alternative), [s]earch, or [u]nresolved: ")).trim();
    if (raw.toLowerCase() === "u" || !raw) return [];
    if (raw.toLowerCase() === "s") {
      const term = (await rl.question("Local history search text: ")).trim();
      if (term) await displayHistoryMatches(db, userId, conversationId, beforeSequence, term);
      continue;
    }
    const groups = parseEvidenceGroups(raw);
    if (groups) return groups;
    console.info("Please enter valid UUIDs.");
  }
}

async function displayHistoryMatches(db: any, userId: string, conversationId: string, beforeSequence: number, term: string) {
  const { data: upperRows, error: upperError } = await db.from("messages").select("id,message_sequence")
    .eq("conversation_id", conversationId).lt("message_sequence", beforeSequence)
    .order("message_sequence", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (upperError) throw new Error("generation_review_search_failed");
  const upperRow = upperRows?.[0];
  if (!upperRow) return;
  const upper = { primary: Number(upperRow.message_sequence), id: upperRow.id };
  const matches = await scanHistoryMatches({
    upper, term,
    async loadPage(cursor, fixedUpper, pageSize) {
      const query: any = db.from("messages").select("id,message_sequence,role,content,conversations!inner(user_id)")
        .eq("conversation_id", conversationId).eq("conversations.user_id", userId).lt("message_sequence", beforeSequence)
        .or(keysetWindow("message_sequence", cursor, fixedUpper))
        .order("message_sequence", { ascending: true }).order("id", { ascending: true }).limit(pageSize);
      const { data, error }: any = await query;
      if (error) throw new Error("generation_review_search_failed");
      return data ?? [];
    }
  });
  for (const row of matches) console.info(`${row.id} seq=${row.message_sequence} ${row.role}: ${row.content}`);
}

export async function scanHistoryMatches<T extends { id: string; message_sequence: number; role: string; content: string }>(input: {
  upper: Keyset | null;
  term: string;
  pageSize?: number;
  loadPage: (cursor: Keyset | null, upper: Keyset, limit: number) => Promise<T[]>;
}) {
  if (!input.upper) return [];
  const matches: T[] = [];
  let cursor: Keyset | null = null;
  while (true) {
    const page = await input.loadPage(cursor, input.upper, input.pageSize ?? RETRIEVAL_PAGE_SIZE);
    if (!page.length) break;
    matches.push(...page.filter((row) => row.content.includes(input.term)));
    const last = page[page.length - 1]!;
    cursor = { primary: Number(last.message_sequence), id: last.id };
  }
  return matches;
}

export function parseEvidenceGroups(raw: string) {
  const groups = raw.split(";").map((group) => group.split(",").map((id) => id.trim()).filter(Boolean))
    .filter((group) => group.length);
  return groups.length && groups.flat().every(isUuid) ? groups : null;
}

export function resolveEvidence(groups: string[][], manifest: GenerationManifest | undefined, candidates: any[], sources: Map<string, any>, status: string) {
  if (status === "fallback") return "search_incomplete";
  const history = new Set(manifest?.historyMessageIds ?? []);
  const candidateIds = new Set(candidates.flatMap((candidate: any) => candidate.source.map((message: any) => message.id)));
  const injected = new Map<string, number>();
  manifest?.injectedCandidates.forEach((candidate) => candidate.messages.forEach((message) => injected.set(message.messageId, message.prefixCodePoints)));
  if (groups.some((group) => group.every((id) => history.has(id)))) return "in_recent_history";
  for (const group of groups) {
    if (group.every((id) => injected.has(id))) {
      const complete = group.every((id) => injected.get(id)! >= [...(sources.get(id)?.content ?? "")].length);
      return complete ? "injected_complete" : "injected_truncated";
    }
  }
  if (groups.some((group) => group.every((id) => candidateIds.has(id)))) return "candidate_not_injected";
  return "outside_candidate_pool";
}

async function saveReview(db: any, runId: string, userId: string, review: any) {
  const { error } = await db.rpc("record_retrieval_generation_review", {
    p_run_id: runId, p_user_id: userId, p_retrieval_need: review.retrievalNeed,
    p_question_type: review.questionType, p_evidence_groups: review.evidenceGroups,
    p_evidence_resolution: review.evidenceResolution, p_manifest_verification: review.manifestVerification,
    p_response_effect: review.responseEffect, p_stale_detected: review.stale,
    p_sensitive_detected: review.sensitive, p_complete: review.complete
  });
  if (error) throw new Error("generation_review_write_failed");
}

async function loadMessagesById(db: any, ids: string[]) {
  if (!ids.length) return new Map();
  const { data, error } = await db.from("messages").select("id,role,content").in("id", ids);
  if (error) throw new Error("generation_review_read_failed");
  return new Map((data ?? []).map((message: any) => [message.id, message]));
}

async function loadCandidates(db: any, runId: string) {
  const { data: rows, error } = await db.from("retrieval_generation_candidates")
    .select("id,chunk_id,rank,score,injected,selection_rank,selection_decision,review_label")
    .eq("run_id", runId).order("rank");
  if (error) throw new Error("generation_review_read_failed");
  return Promise.all((rows ?? []).map(async (row: any) => {
    const { data: chunk } = await db.from("retrieval_chunks").select("conversation_id,start_sequence,end_sequence").eq("id", row.chunk_id).maybeSingle();
    if (!chunk) return { ...row, source: [], dialogue: "[source missing]" };
    const { data: source, error: sourceError } = await db.from("messages").select("id,message_sequence,role,content")
      .eq("conversation_id", chunk.conversation_id).gte("message_sequence", chunk.start_sequence)
      .lte("message_sequence", chunk.end_sequence).order("message_sequence");
    if (sourceError) throw new Error("generation_review_read_failed");
    const mapped = (source ?? []).map((message: any) => ({
      id: message.id, sequence: Number(message.message_sequence), role: message.role, content: message.content
    }));
    return { ...row, source: mapped, dialogue: mapped.map((message: any) => `${message.role === "user" ? "使用者" : "安放"}：${message.content}`).join("\n") };
  }));
}

export function formatNeedReviewHeader(runId: string, history: Array<{ role: string; content: string }>, query: string, status: string, verification: string, reason: string | null) {
  return [
    `\nRun ${runId}`, `Status: ${status}`, `Manifest: ${verification}${reason ? ` (${reason})` : ""}`,
    "Recent history (10 max):", ...history.map((message) => `${message.role === "user" ? "使用者" : "安放"}：${message.content}`),
    `Current query: ${query}`
  ].join("\n");
}

export function formatGenerationReviewHeader(runId: string, history: Message[], currentQuery: string, retrievalContext: string, response: string) {
  return [formatNeedReviewHeader(runId, history, currentQuery, "unknown", "legacy_approximate", null),
    `Injected user-only context: ${retrievalContext}`, `Generated response: ${response}`].join("\n");
}

export function formatGenerationCandidate(candidate: { rank: number; score: number; injected: boolean }) {
  const detailed = candidate as typeof candidate & { selection_rank?: number | null; selection_decision?: string };
  return `#${candidate.rank} score=${Number(candidate.score).toFixed(4)} injected=${candidate.injected ? "yes" : "no"} selection_rank=${detailed.selection_rank ?? "-"} decision=${detailed.selection_decision ?? (candidate.injected ? "selected" : "not_selected")}`;
}

export function formatGenerationCandidateDecisions(candidates: Array<any>) {
  return ["Candidate decisions:", ...candidates.map((candidate) => `${formatGenerationCandidate(candidate)}\n${candidate.dialogue || "[missing]"}`)].join("\n");
}

export function yesNo(value: string) {
  const answerValue = value.trim().toLowerCase();
  if (answerValue === "y") return true;
  if (answerValue === "n") return false;
  throw new Error("invalid yes/no answer");
}

function answer<T extends Record<string, string>>(raw: string, choices: T, error: string): T[keyof T] {
  const selected = choices[raw.trim().toLowerCase() as keyof T];
  if (!selected) throw new Error(error);
  return selected;
}

function option(argv: string[], name: string) {
  return argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function instant(raw: string | undefined) {
  if (!raw) return undefined;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(raw) || Number.isNaN(Date.parse(raw))) throw new Error("timestamps must include a timezone");
  return new Date(raw).toISOString();
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[retrieval-generation:review] ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  });
}
