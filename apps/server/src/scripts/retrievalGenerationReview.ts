import "dotenv/config";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import type { Message } from "@softplace/shared";
import { config } from "../config.js";
import {
  classifyGenerationMessage,
  prepareGenerationContext,
  type GenerationCandidate
} from "../domain/retrievalGeneration.js";
import { scanReviewRuns } from "./retrievalShadowReview.js";
import { supabaseAdmin } from "../integrations/supabase.js";

const candidateLabels = { m: "must", a: "acceptable", f: "forbidden", i: "irrelevant" } as const;
const effects = { h: "helpful", n: "neutral", x: "harmful" } as const;
const REVIEW_PAGE_SIZE = 50;

export async function main(argv = process.argv.slice(2)) {
  const userId = value(argv, "user-id");
  const limit = Number(value(argv, "limit") ?? 10);
  if (!userId || !Number.isInteger(limit) || limit < 1) throw new Error("valid --user-id and --limit are required");
  if (!config.retrievalShadowUserIds.has(userId)) throw new Error("user is not in RETRIEVAL_SHADOW_USER_IDS");
  if (!supabaseAdmin) throw new Error("Supabase configuration is required");
  const db = supabaseAdmin;
  const rl = readline.createInterface({ input, output });
  let reviewedRuns = 0;
  try {
    reviewedRuns = await scanReviewRuns({
      limit,
      pageSize: REVIEW_PAGE_SIZE,
      async loadPage(from, to) {
        const { data, error } = await db.from("retrieval_generation_runs")
          .select("id,query_message_id,assistant_message_id,response_effect,stale_detected,sensitive_detected,created_at")
          .eq("user_id", userId).eq("status", "injected").eq("selection_strategy", "user_evidence_top20")
          .order("created_at", { ascending: true }).range(from, to);
        if (error) throw new Error("generation_review_read_failed");
        return data ?? [];
      },
      async reviewRun(run) {
        const { data: candidateRows, error: candidateError } = await db.from("retrieval_generation_candidates")
          .select("id,chunk_id,rank,score,injected,selection_rank,selection_decision,review_label")
          .eq("run_id", run.id).order("rank");
        if (candidateError) throw new Error("generation_review_read_failed");
        const candidates = await loadCandidates(candidateRows ?? []);
        const pendingCandidates = candidates.filter((candidate) => candidate.injected && !candidate.review_label);
        const needsResponseReview = !run.response_effect;
        if (!pendingCandidates.length && !needsResponseReview) return false;

        const { data: query, error: queryError } = await db.from("messages")
          .select("id,conversation_id,message_sequence,content").eq("id", run.query_message_id).single();
        const { data: assistant, error: assistantError } = await db.from("messages")
          .select("content").eq("id", run.assistant_message_id).single();
        if (queryError || assistantError || !query || !assistant) throw new Error("generation_review_read_failed");
        const { data: historyRows, error: historyError } = await db.from("messages")
          .select("id,conversation_id,message_sequence,role,content,model_used,mode,image_present,crisis_detected,created_at")
          .eq("conversation_id", query.conversation_id)
          .lt("message_sequence", query.message_sequence)
          .order("message_sequence", { ascending: false }).limit(10);
        if (historyError) throw new Error("generation_review_read_failed");
        const history = (historyRows ?? []).reverse().map(mapMessage);
        const prepared = prepareGenerationContext(candidates.filter((candidate) => candidate.injected).map(toDomainCandidate));
        console.info(formatGenerationReviewHeader(run.id, history, query.content, prepared?.text ?? "[missing]", assistant.content));
        console.info(formatGenerationCandidateDecisions(candidates));

        for (const candidate of pendingCandidates) {
          const answer = (await rl.question(`${formatGenerationCandidate(candidate)}\n${candidate.dialogue || "[missing]"}\n[m]ust [a]cceptable [f]orbidden [i]rrelevant: `)).trim().toLowerCase();
          const label = candidateLabels[answer as keyof typeof candidateLabels];
          if (!label) throw new Error("invalid review label");
          const { error } = await db.from("retrieval_generation_candidates")
            .update({ review_label: label, reviewed_at: new Date().toISOString() }).eq("id", candidate.id);
          if (error) throw new Error("generation_review_write_failed");
        }

        if (needsResponseReview) {
          const effectAnswer = (await rl.question("Response effect [h]elpful [n]eutral harmful[x]: ")).trim().toLowerCase();
          const effect = effects[effectAnswer as keyof typeof effects];
          if (!effect) throw new Error("invalid response effect");
          const stale = yesNo(await rl.question("Stale information used? [y/n]: "));
          const sensitive = yesNo(await rl.question("Sensitive detail raised inappropriately? [y/n]: "));
          const { error } = await db.from("retrieval_generation_runs").update({
            response_effect: effect,
            stale_detected: stale,
            sensitive_detected: sensitive,
            reviewed_at: new Date().toISOString()
          }).eq("id", run.id);
          if (error) throw new Error("generation_review_write_failed");
        }
        return true;
      }
    });
  } finally {
    rl.close();
  }
  console.info("[retrieval-generation:review]", { reviewedRuns });
  return { reviewedRuns };

  async function loadCandidates(rows: any[]) {
    return Promise.all(rows.map(async (row) => {
      const { data: chunk, error: chunkError } = await db.from("retrieval_chunks")
        .select("conversation_id,start_sequence,end_sequence").eq("id", row.chunk_id).single();
      if (chunkError || !chunk) throw new Error("generation_review_read_failed");
      const { data: source, error: sourceError } = await db.from("messages")
        .select("id,message_sequence,role,content")
        .eq("conversation_id", chunk.conversation_id)
        .gte("message_sequence", chunk.start_sequence).lte("message_sequence", chunk.end_sequence)
        .order("message_sequence", { ascending: true });
      if (sourceError) throw new Error("generation_review_read_failed");
      return {
        ...row,
        startSequence: Number(chunk.start_sequence),
        endSequence: Number(chunk.end_sequence),
        source: (source ?? []).map((message: any) => ({
          id: message.id, sequence: Number(message.message_sequence), role: message.role, content: message.content
        })),
        dialogue: (source ?? []).map((message: any) => `${message.role === "user" ? "使用者" : "安放"}：${message.content}`).join("\n")
      };
    }));
  }
}

export function formatGenerationReviewHeader(
  runId: string,
  history: Message[],
  currentQuery: string,
  retrievalContext: string,
  response: string
) {
  return [
    `\nRun ${runId}`,
    "Recent history (10 max):",
    ...history.map((message) => `${message.role === "user" ? "使用者" : "安放"}：${message.content}`),
    `Current query: ${currentQuery}`,
    `Injected user-only context: ${retrievalContext}`,
    `Generated response: ${response}`
  ].join("\n");
}

export function formatGenerationCandidate(candidate: { rank: number; score: number; injected: boolean }) {
  const detailed = candidate as typeof candidate & { selection_rank?: number | null; selection_decision?: string };
  return [
    `#${candidate.rank}`,
    `score=${Number(candidate.score).toFixed(4)}`,
    `injected=${candidate.injected ? "yes" : "no"}`,
    `selection_rank=${detailed.selection_rank ?? "-"}`,
    `decision=${detailed.selection_decision ?? (candidate.injected ? "selected" : "not_selected")}`
  ].join(" ");
}

export function formatGenerationCandidateDecisions(candidates: Array<any>) {
  return [
    "Candidate decisions:",
    ...candidates.map((candidate) => [
      formatGenerationCandidate(candidate),
      candidate.dialogue || "[missing]"
    ].join("\n"))
  ].join("\n");
}

export function yesNo(value: string) {
  const answer = value.trim().toLowerCase();
  if (answer === "y") return true;
  if (answer === "n") return false;
  throw new Error("invalid yes/no answer");
}

function toDomainCandidate(candidate: any): GenerationCandidate {
  return {
    chunkId: candidate.chunk_id,
    rank: Number(candidate.rank),
    score: Number(candidate.score),
    startSequence: candidate.startSequence,
    endSequence: candidate.endSequence,
    source: candidate.source.filter((message: any) =>
      message.role === "user" && classifyGenerationMessage(message.content) === "evidence"
    )
  };
}

function value(argv: string[], name: string) {
  return argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function mapMessage(row: any): Message {
  return {
    id: row.id, conversationId: row.conversation_id, sequence: Number(row.message_sequence), role: row.role,
    content: row.content, modelUsed: row.model_used, mode: row.mode, imagePresent: row.image_present,
    crisisDetected: row.crisis_detected, createdAt: row.created_at
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[retrieval-generation:review] ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  });
}
