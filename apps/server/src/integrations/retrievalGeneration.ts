import OpenAI, { APIConnectionTimeoutError } from "openai";
import type { Message } from "@softplace/shared";
import { config } from "../config.js";
import {
  RETRIEVAL_GENERATION,
  buildGenerationManifest,
  buildGenerationQuery,
  generationEffectiveThreshold,
  generationSearchBeforeSequence,
  prepareGenerationContext,
  rerankGenerationCandidates,
  retrievalGenerationErrorCode,
  type GenerationCandidate,
  type GenerationManifest,
  type GenerationSelectionDecision
} from "../domain/retrievalGeneration.js";
import { RETRIEVAL_SHADOW } from "../domain/retrievalShadow.js";
import { supabaseAdmin } from "./supabase.js";

export type GenerationRetrievalResult = {
  status: "injected" | "abstained" | "fallback";
  context: string | null;
  candidates: Array<{
    chunkId: string;
    rank: number;
    score: number;
    injected: boolean;
    selectionRank: number | null;
    selectionDecision: GenerationSelectionDecision;
  }>;
  embeddingLatencyMs: number;
  searchLatencyMs: number;
  totalLatencyMs: number;
  retrievalTokens: number;
  errorCode: string | null;
  effectiveThreshold: number | null;
  searchBeforeSequence: number | null;
  manifest: GenerationManifest | null;
};

export type GenerationRetrievalInput = {
  userId: string;
  conversationId: string;
  history: Message[];
  currentQuery: string;
};

export type GenerationRunRecord = {
  userId: string;
  conversationId: string;
  queryMessageId: string;
  assistantMessageId: string;
  model: string;
  retrieval: GenerationRetrievalResult;
  tokenMetrics: {
    instructionsTokens: number;
    memoryTokens: number;
    history10Tokens: number;
    history20Tokens: number;
    currentQueryTokens: number;
    actualInputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
  };
};

export type GenerationRetriever = (input: GenerationRetrievalInput) => Promise<GenerationRetrievalResult>;
export type GenerationRunRecorder = (input: GenerationRunRecord) => Promise<void>;

export function retrievalGenerationEnabledFor(userId: string) {
  return config.retrievalGenerationEnabled && config.retrievalShadowUserIds.has(userId);
}

export async function retrieveForGeneration(input: GenerationRetrievalInput): Promise<GenerationRetrievalResult> {
  const started = performance.now();
  const deadline = started + RETRIEVAL_GENERATION.timeoutMs;
  const timings = { embeddingLatencyMs: 0, searchLatencyMs: 0 };
  const query = buildGenerationQuery(input.history, input.currentQuery);
  const beforeSequence = generationSearchBeforeSequence(input.history);
  try {
    return await runRetrieval(input, query, beforeSequence, started, deadline, timings);
  } catch (error) {
    return {
      status: "fallback",
      context: null,
      candidates: [],
      embeddingLatencyMs: timings.embeddingLatencyMs,
      searchLatencyMs: timings.searchLatencyMs,
      totalLatencyMs: Math.max(0, Math.round(performance.now() - started)),
      retrievalTokens: 0,
      errorCode: retrievalGenerationErrorCode(error),
      effectiveThreshold: null,
      searchBeforeSequence: beforeSequence,
      manifest: buildGenerationManifest({ history: input.history, query, prepared: null })
    };
  }
}

async function runRetrieval(
  input: GenerationRetrievalInput,
  query: ReturnType<typeof buildGenerationQuery>,
  beforeSequence: number | null,
  started: number,
  deadline: number,
  timings: { embeddingLatencyMs: number; searchLatencyMs: number }
): Promise<GenerationRetrievalResult> {
  if (!supabaseAdmin) throw new Error("generation_search_failed");
  if (beforeSequence === null) return emptyResult(started, input.history, query);
  const client = config.openAiApiKey ? new OpenAI({
    apiKey: config.openAiApiKey,
    timeout: RETRIEVAL_GENERATION.timeoutMs,
    maxRetries: 0
  }) : null;
  if (!client) throw new Error("generation_embedding_unconfigured");

  const embeddingStarted = performance.now();
  let response;
  try {
    try {
      response = await withDeadline(client.embeddings.create({
        model: RETRIEVAL_SHADOW.model,
        dimensions: RETRIEVAL_SHADOW.dimensions,
        input: query.text,
        encoding_format: "float"
      }), deadline, "generation_embedding_timeout");
    } catch (error) {
      if (error instanceof APIConnectionTimeoutError || errorMessage(error) === "generation_embedding_timeout") {
        throw new Error("generation_embedding_timeout");
      }
      throw new Error("generation_embedding_failed");
    }
  } finally {
    timings.embeddingLatencyMs = Math.max(0, Math.round(performance.now() - embeddingStarted));
  }
  const embedding = response.data[0]?.embedding;
  if (!embedding || embedding.length !== RETRIEVAL_SHADOW.dimensions) throw new Error("generation_embedding_invalid");

  const searchStarted = performance.now();
  let candidates: GenerationCandidate[];
  try {
    let searchResult;
    try {
      searchResult = await withDeadline(supabaseAdmin.rpc("match_retrieval_generation_evidence_chunks", {
        p_user_id: input.userId,
        p_conversation_id: input.conversationId,
        p_query_sequence: beforeSequence,
        p_query_embedding: vector(embedding),
        p_limit: RETRIEVAL_GENERATION.candidateLimit
      }), deadline, "generation_search_timeout");
    } catch (error) {
      if (errorMessage(error) === "generation_search_timeout") throw error;
      throw new Error("generation_search_failed");
    }
    const { data, error } = searchResult;
    if (error) throw new Error("generation_search_failed");
    const ranked: RankedChunk[] = (data ?? []).map((row: any, index: number) => ({
      chunkId: row.chunk_id as string,
      score: Number(row.score),
      rank: Number(row.vector_rank ?? index + 1),
      startSequence: Number(row.start_sequence),
      endSequence: Number(row.end_sequence)
    }));
    candidates = await withDeadline(loadCandidateSources(input, ranked), deadline, "generation_source_timeout");
  } finally {
    timings.searchLatencyMs = Math.max(0, Math.round(performance.now() - searchStarted));
  }
  const reranked = rerankGenerationCandidates(candidates);
  const prepared = prepareGenerationContext(reranked.filter((candidate) => candidate.selectionDecision === "selected"));
  const formattedChunkIds = new Set(prepared?.injectedChunkIds ?? []);
  const effectiveThreshold = generationEffectiveThreshold(reranked
    .filter((candidate) => !["invalid_source", "recall_probe_only", "boilerplate_only"].includes(candidate.selectionDecision))
    .map((candidate) => candidate.score));
  if (performance.now() > deadline) throw new Error("generation_retrieval_timeout");
  return {
    status: prepared ? "injected" : "abstained",
    context: prepared?.text ?? null,
    candidates: reranked.map((candidate) => ({
      chunkId: candidate.chunkId,
      rank: candidate.rank,
      score: candidate.score,
      injected: formattedChunkIds.has(candidate.chunkId),
      selectionRank: formattedChunkIds.has(candidate.chunkId) ? candidate.selectionRank : null,
      selectionDecision: candidate.selectionDecision === "selected" && !formattedChunkIds.has(candidate.chunkId)
        ? "not_selected" : candidate.selectionDecision
    })),
    embeddingLatencyMs: timings.embeddingLatencyMs,
    searchLatencyMs: timings.searchLatencyMs,
    totalLatencyMs: Math.max(0, Math.round(performance.now() - started)),
    retrievalTokens: prepared?.tokenCount ?? 0,
    errorCode: null,
    effectiveThreshold,
    searchBeforeSequence: beforeSequence,
    manifest: buildGenerationManifest({ history: input.history, query, prepared })
  };
}

async function loadCandidateSources(
  input: GenerationRetrievalInput,
  ranked: RankedChunk[]
): Promise<GenerationCandidate[]> {
  if (!ranked.length || !supabaseAdmin) return [];
  const ranges = ranked.map((candidate) =>
    `and(message_sequence.gte.${candidate.startSequence},message_sequence.lte.${candidate.endSequence})`
  );
  if (!ranges.length) return [];
  let sourceResult;
  try {
    sourceResult = await supabaseAdmin.from("messages")
      .select("id,message_sequence,role,content,image_present,crisis_detected")
      .eq("conversation_id", input.conversationId)
      .or(ranges.join(","))
      .order("message_sequence", { ascending: true });
  } catch {
    throw new Error("generation_source_failed");
  }
  const { data: messages, error: messageError } = sourceResult;
  if (messageError) throw new Error("generation_source_failed");
  return ranked.map((candidate) => {
    const startSequence = candidate.startSequence;
    const endSequence = candidate.endSequence;
    const sourceRows = (messages ?? [])
      .filter((message: any) => Number(message.message_sequence) >= startSequence && Number(message.message_sequence) <= endSequence);
    if (!isValidGenerationSourceWindow(sourceRows)) return { ...candidate, source: [] };
    return {
      ...candidate,
      source: sourceRows.map((message: any) => ({
          id: message.id,
          sequence: Number(message.message_sequence),
          role: message.role,
          content: message.content
        }))
    };
  });
}

export function isValidGenerationSourceWindow(sourceRows: Array<{
  role: string;
  image_present?: boolean;
  crisis_detected?: boolean;
}>) {
  return sourceRows.length === 3
    && sourceRows.map((message) => message.role).join(",") === "user,assistant,user"
    && sourceRows.every((message) => !message.image_present && !message.crisis_detected);
}

export async function recordGenerationRun(input: GenerationRunRecord) {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.rpc("record_retrieval_generation_observed_run", {
    p_user_id: input.userId,
    p_conversation_id: input.conversationId,
    p_query_message_id: input.queryMessageId,
    p_assistant_message_id: input.assistantMessageId,
    p_status: input.retrieval.status,
    p_model: input.model,
    p_embedding_latency_ms: input.retrieval.embeddingLatencyMs,
    p_search_latency_ms: input.retrieval.searchLatencyMs,
    p_total_retrieval_latency_ms: input.retrieval.totalLatencyMs,
    p_error_code: input.retrieval.errorCode,
    p_instructions_tokens: input.tokenMetrics.instructionsTokens,
    p_memory_tokens: input.tokenMetrics.memoryTokens,
    p_history_10_tokens: input.tokenMetrics.history10Tokens,
    p_history_20_tokens: input.tokenMetrics.history20Tokens,
    p_retrieval_tokens: input.retrieval.retrievalTokens,
    p_current_query_tokens: input.tokenMetrics.currentQueryTokens,
    p_actual_input_tokens: input.tokenMetrics.actualInputTokens,
    p_cached_input_tokens: input.tokenMetrics.cachedInputTokens,
    p_output_tokens: input.tokenMetrics.outputTokens,
    p_candidates: input.retrieval.candidates,
    p_evaluation: {
      evaluationVersion: RETRIEVAL_GENERATION.evaluationVersion,
      selectionVersion: RETRIEVAL_GENERATION.selectionVersion,
      queryBuilderVersion: RETRIEVAL_GENERATION.queryBuilderVersion,
      evidenceFilterVersion: RETRIEVAL_GENERATION.evidenceFilterVersion,
      contextFormatterVersion: RETRIEVAL_GENERATION.contextFormatterVersion,
      minimumScore: RETRIEVAL_GENERATION.minimumScore,
      relativeScoreRatio: RETRIEVAL_GENERATION.relativeScoreRatio,
      effectiveThreshold: input.retrieval.effectiveThreshold,
      searchBeforeSequence: input.retrieval.searchBeforeSequence,
      timeoutMs: RETRIEVAL_GENERATION.timeoutMs
    },
    p_manifest: input.retrieval.manifest
      ? { ...input.retrieval.manifest, currentQueryMessageId: input.queryMessageId }
      : null
  });
  if (error) throw new Error("generation_observation_write_failed");
}

export async function cleanupGenerationRuns() {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.rpc("cleanup_retrieval_generation", {
    p_retention_days: RETRIEVAL_GENERATION.retentionDays
  });
  if (error) throw new Error("generation_cleanup_failed");
}

function emptyResult(
  started: number,
  history: Message[],
  query: ReturnType<typeof buildGenerationQuery>
): GenerationRetrievalResult {
  return {
    status: "abstained",
    context: null,
    candidates: [],
    embeddingLatencyMs: 0,
    searchLatencyMs: 0,
    totalLatencyMs: Math.max(0, Math.round(performance.now() - started)),
    retrievalTokens: 0,
    errorCode: null,
    effectiveThreshold: null,
    searchBeforeSequence: null,
    manifest: buildGenerationManifest({ history, query, prepared: null })
  };
}

export async function withDeadline<T>(promise: PromiseLike<T>, deadline: number, errorCode: string) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const remainingMs = Math.max(0, deadline - performance.now());
    if (remainingMs === 0) throw new Error(errorCode);
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(errorCode)), remainingMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type RankedChunk = {
  chunkId: string;
  rank: number;
  score: number;
  startSequence: number;
  endSequence: number;
};

function vector(values: number[]) {
  return `[${values.join(",")}]`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "";
}
