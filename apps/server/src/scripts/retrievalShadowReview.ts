import "dotenv/config";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import type { Message } from "@softplace/shared";
import { config } from "../config.js";
import { buildShadowQueryParts } from "../domain/retrievalShadow.js";
import { supabaseAdmin } from "../integrations/supabase.js";
import { RETRIEVAL_PAGE_SIZE, keysetWindow, type Keyset } from "./retrievalPagination.js";

const labels = { m: "must", a: "acceptable", f: "forbidden", i: "irrelevant" } as const;

export async function main(argv = process.argv.slice(2)) {
  const userId = value(argv, "user-id");
  const limit = Number(value(argv, "limit") ?? 25);
  if (!userId || !Number.isInteger(limit) || limit < 1) throw new Error("valid --user-id and --limit are required");
  if (!config.retrievalShadowUserIds.has(userId)) throw new Error("user is not in RETRIEVAL_SHADOW_USER_IDS");
  if (!supabaseAdmin) throw new Error("Supabase configuration is required");
  const db = supabaseAdmin;
  const rl = readline.createInterface({ input, output });
  let reviewedRuns = 0;
  try {
    const observedAt = new Date().toISOString();
    const { data: upperRows, error: upperError } = await db.from("retrieval_shadow_runs")
      .select("id,created_at").eq("user_id", userId).eq("status", "completed").lte("created_at", observedAt)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1);
    if (upperError) throw new Error("shadow_review_read_failed");
    reviewedRuns = await scanKeysetReviewRuns({
      limit,
      upper: upperRows?.[0] ? { primary: upperRows[0].created_at, id: upperRows[0].id } : null,
      pageSize: RETRIEVAL_PAGE_SIZE,
      async loadPage(cursor, upper, pageSize) {
        const query = db.from("retrieval_shadow_runs")
          .select("id,query_message_id,created_at").eq("user_id", userId).eq("status", "completed")
          .or(keysetWindow("created_at", cursor, upper)).order("created_at", { ascending: true }).order("id", { ascending: true })
          .limit(pageSize);
        const { data, error } = await query;
        if (error) throw new Error("shadow_review_read_failed");
        return data ?? [];
      },
      async reviewRun(run) {
        const { data: candidates, error: candidateError } = await db.from("retrieval_shadow_candidates")
          .select("id,chunk_id,rank,score,passed_threshold,review_label").eq("run_id", run.id).order("rank");
        if (candidateError) throw new Error("shadow_review_read_failed");
        const pendingCandidates = candidatesToReview(candidates ?? []);
        if (!pendingCandidates.length) return false;
        const { data: queryMessages, error: queryMessagesError } = await db.rpc("get_retrieval_shadow_run_context", {
          p_run_id: run.id,
          p_user_id: userId
        });
        if (queryMessagesError) throw new Error("shadow_review_read_failed");
        if (!(queryMessages ?? []).some((message: any) => message.id === run.query_message_id)) {
          throw new Error("shadow_review_context_missing");
        }
        const queryParts = buildShadowQueryParts((queryMessages ?? []).map(mapMessage), run.query_message_id);
        console.info(formatReviewHeader(run.id, queryParts));
        for (const candidate of pendingCandidates) {
          const { data: chunk } = await db.from("retrieval_chunks")
            .select("conversation_id,start_sequence,end_sequence").eq("id", candidate.chunk_id).single();
          const { data: source } = chunk
            ? await db.from("messages").select("role,content,message_sequence")
                .eq("conversation_id", chunk.conversation_id)
                .gte("message_sequence", chunk.start_sequence).lte("message_sequence", chunk.end_sequence)
                .order("message_sequence", { ascending: true })
            : { data: null };
          const dialogue = (source ?? []).map((message) => `${message.role === "user" ? "使用者" : "安放"}：${message.content}`).join("\n");
          const answer = (await rl.question(`${formatCandidateHeader(candidate)}\n${dialogue || "[missing]"}\n[m]ust [a]cceptable [f]orbidden [i]rrelevant: `)).trim().toLowerCase();
          const label = labels[answer as keyof typeof labels];
          if (!label) throw new Error("invalid review label");
          const { error: updateError } = await db.from("retrieval_shadow_candidates")
            .update({ review_label: label, reviewed_at: new Date().toISOString() }).eq("id", candidate.id);
          if (updateError) throw new Error("shadow_review_write_failed");
        }
        return true;
      }
    });
  } finally {
    rl.close();
  }
  console.info("[retrieval-shadow:review]", { reviewedRuns });
  return { reviewedRuns };
}

export async function scanKeysetReviewRuns<T>(input: {
  limit: number;
  pageSize: number;
  upper: Keyset | null;
  loadPage: (cursor: Keyset | null, upper: Keyset, limit: number) => Promise<T[]>;
  key?: (run: T) => Keyset;
  reviewRun: (run: T) => Promise<boolean>;
}) {
  if (!input.upper) return 0;
  let reviewed = 0;
  let cursor: Keyset | null = null;
  while (reviewed < input.limit) {
    const page = await input.loadPage(cursor, input.upper, input.pageSize);
    if (!page.length) break;
    for (const run of page) {
      cursor = input.key?.(run) ?? {
        primary: (run as any).created_at,
        id: (run as any).id
      };
      if (await input.reviewRun(run)) reviewed += 1;
      if (reviewed >= input.limit) break;
    }
  }
  return reviewed;
}

export async function scanReviewRuns<T>(input: {
  limit: number;
  pageSize: number;
  loadPage: (from: number, to: number) => Promise<T[]>;
  reviewRun: (run: T) => Promise<boolean>;
}) {
  let reviewed = 0;
  let offset = 0;
  while (reviewed < input.limit) {
    const page = await input.loadPage(offset, offset + input.pageSize - 1);
    if (!page.length) break;
    for (const run of page) {
      if (reviewed >= input.limit) break;
      if (await input.reviewRun(run)) reviewed += 1;
    }
    offset += page.length;
    if (page.length < input.pageSize) break;
  }
  return reviewed;
}

export function candidatesToReview<T extends { review_label: string | null }>(candidates: T[]) {
  if (!candidates.length || candidates.every((candidate) => candidate.review_label)) return [];
  return candidates.filter((candidate) => !candidate.review_label);
}

export function formatReviewHeader(
  runId: string,
  query: { recentContext: string[]; currentQuery: string; text: string }
) {
  return [
    `\nRun ${runId}`,
    `Recent context 1: ${query.recentContext[0] ?? "[none]"}`,
    `Recent context 2: ${query.recentContext[1] ?? "[none]"}`,
    `Current query: ${query.currentQuery}`,
    "Embedding input:",
    query.text
  ].join("\n");
}

export function formatCandidateHeader(candidate: { rank: number; score: number; passed_threshold: boolean }) {
  return `#${candidate.rank} score=${Number(candidate.score).toFixed(4)} passed_threshold=${candidate.passed_threshold ? "yes" : "no"}`;
}

function value(argv: string[], name: string) { return argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3); }

function mapMessage(row: any): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: Number(row.message_sequence),
    role: row.role,
    content: row.content,
    modelUsed: row.model_used,
    mode: row.mode,
    imagePresent: row.image_present,
    crisisDetected: row.crisis_detected,
    createdAt: row.created_at
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[retrieval-shadow:review] ${error instanceof Error ? error.message : "failed"}`); process.exitCode = 1; });
}
