import crypto from "node:crypto";
import OpenAI from "openai";
import type { Message } from "@softplace/shared";
import { config } from "../config.js";
import { RETRIEVAL_SHADOW, buildShadowDialogueWindow, buildShadowQueryParts, buildShadowUserEvidence } from "../domain/retrievalShadow.js";
import { supabaseAdmin } from "./supabase.js";

export type RetrievalShadowJob = {
  id: string;
  userId: string;
  conversationId: string;
  queryMessageId: string;
  attempts: number;
  createdAt: string;
};

export type RetrievalShadowCandidate = { chunkId: string; score: number };

export type RetrievalShadowStore = {
  claimJobs(token: string, limit: number): Promise<RetrievalShadowJob[]>;
  getMessages(job: RetrievalShadowJob): Promise<Message[]>;
  match(job: RetrievalShadowJob, beforeSequence: number, embedding: number[]): Promise<RetrievalShadowCandidate[]>;
  complete(job: RetrievalShadowJob, token: string, queueDelayMs: number, searchLatencyMs: number, candidates: RetrievalShadowCandidate[]): Promise<void>;
  retry(jobId: string, token: string, errorCode: string): Promise<void>;
  upsertChunk(job: RetrievalShadowJob, startSequence: number, endSequence: number, dialogueEmbedding: number[], evidenceEmbedding: number[] | null): Promise<void>;
  cleanup(): Promise<void>;
};

export type ShadowEmbeddingProvider = { embed(texts: string[]): Promise<number[][]> };

export function retrievalShadowEnabledFor(userId: string) {
  return config.retrievalShadowEnabled && config.retrievalShadowUserIds.has(userId);
}

export async function enqueueRetrievalShadowJob(userId: string, conversationId: string, queryMessageId: string) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.rpc("enqueue_retrieval_shadow_job", {
    p_user_id: userId,
    p_conversation_id: conversationId,
    p_query_message_id: queryMessageId
  });
  if (error) throw new Error("shadow_enqueue_failed");
  return data as string;
}

export function createShadowEmbeddingProvider(): ShadowEmbeddingProvider {
  const client = config.openAiApiKey ? new OpenAI({
    apiKey: config.openAiApiKey,
    timeout: config.openAiTimeoutMs,
    maxRetries: config.openAiMaxRetries
  }) : null;
  return {
    async embed(texts) {
      if (!client) throw new Error("shadow_embedding_unconfigured");
      const response = await client.embeddings.create({
        model: RETRIEVAL_SHADOW.model,
        dimensions: RETRIEVAL_SHADOW.dimensions,
        input: texts,
        encoding_format: "float"
      });
      const ordered = [...response.data].sort((left, right) => left.index - right.index).map((item) => item.embedding);
      if (ordered.length !== texts.length || ordered.some((vector) => vector.length !== RETRIEVAL_SHADOW.dimensions)) {
        throw new Error("shadow_embedding_invalid");
      }
      return ordered;
    }
  };
}

export function createSupabaseShadowStore(): RetrievalShadowStore | null {
  if (!supabaseAdmin) return null;
  const db = supabaseAdmin;
  return {
    async claimJobs(token, limit) {
      const { data, error } = await db.rpc("claim_retrieval_shadow_jobs", { p_lease_token: token, p_limit: limit });
      if (error) throw new Error("shadow_claim_failed");
      return (data ?? []).map((row: any) => ({
        id: row.id, userId: row.user_id, conversationId: row.conversation_id,
        queryMessageId: row.query_message_id, attempts: row.attempts, createdAt: row.created_at
      }));
    },
    async getMessages(job) {
      const { data, error } = await db.from("messages")
        .select("id,conversation_id,message_sequence,role,content,model_used,mode,image_present,crisis_detected,created_at")
        .eq("conversation_id", job.conversationId)
        .order("message_sequence", { ascending: true });
      if (error) throw new Error("shadow_context_failed");
      return (data ?? []).map(mapMessage);
    },
    async match(job, beforeSequence, embedding) {
      const started = performance.now();
      const { data, error } = await db.rpc("match_retrieval_shadow_chunks", {
        p_user_id: job.userId, p_conversation_id: job.conversationId,
        p_query_sequence: beforeSequence, p_query_embedding: vector(embedding), p_limit: RETRIEVAL_SHADOW.candidateLimit
      });
      void started;
      if (error) throw new Error("shadow_search_failed");
      return (data ?? []).map((row: any) => ({ chunkId: row.chunk_id, score: Number(row.score) }));
    },
    async complete(job, token, queueDelayMs, searchLatencyMs, candidates) {
      const { error } = await db.rpc("complete_retrieval_shadow_job", {
        p_job_id: job.id, p_lease_token: token, p_queue_delay_ms: queueDelayMs,
        p_search_latency_ms: searchLatencyMs,
        p_candidates: candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }))
      });
      if (error) throw new Error("shadow_complete_failed");
    },
    async retry(jobId, token, errorCode) {
      const { error } = await db.rpc("retry_retrieval_shadow_job", {
        p_job_id: jobId, p_lease_token: token, p_error_code: errorCode
      });
      if (error) throw new Error("shadow_retry_failed");
    },
    async upsertChunk(job, startSequence, endSequence, dialogueEmbedding, evidenceEmbedding) {
      const { error } = await db.rpc("upsert_retrieval_chunk_with_evidence", {
        p_user_id: job.userId, p_conversation_id: job.conversationId,
        p_anchor_message_id: job.queryMessageId, p_start_sequence: startSequence,
        p_end_sequence: endSequence, p_dialogue_embedding: vector(dialogueEmbedding),
        p_evidence_embedding: evidenceEmbedding ? vector(evidenceEmbedding) : null
      });
      if (error) throw new Error("shadow_chunk_failed");
    },
    async cleanup() {
      const { error } = await db.rpc("cleanup_retrieval_shadow", { p_retention_days: RETRIEVAL_SHADOW.retentionDays });
      if (error) throw new Error("shadow_cleanup_failed");
    }
  };
}

export async function processRetrievalShadowJobs(input: {
  store: RetrievalShadowStore;
  provider: ShadowEmbeddingProvider;
  limit?: number;
  now?: () => number;
}) {
  const token = crypto.randomUUID();
  const now = input.now ?? Date.now;
  const jobs = await input.store.claimJobs(token, input.limit ?? 10);
  let completed = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const processingStarted = now();
      const messages = await input.store.getMessages(job);
      const query = buildShadowQueryParts(messages, job.queryMessageId);
      const window = buildShadowDialogueWindow(messages, job.queryMessageId);
      const evidence = buildShadowUserEvidence(messages, job.queryMessageId);
      const texts = window
        ? [query.text, window.text, ...(evidence ? [evidence.text] : [])]
        : [query.text];
      const [queryEmbedding, chunkEmbedding, evidenceEmbedding] = await input.provider.embed(texts);
      if (!queryEmbedding) throw new Error("shadow_embedding_invalid");
      const searchStarted = now();
      const candidates = await input.store.match(job, query.searchBeforeSequence, queryEmbedding);
      const searchLatencyMs = Math.max(0, now() - searchStarted);
      if (window && chunkEmbedding) {
        await input.store.upsertChunk(job, window.startSequence, window.endSequence, chunkEmbedding, evidenceEmbedding ?? null);
      }
      await input.store.complete(job, token, Math.max(0, processingStarted - Date.parse(job.createdAt)), searchLatencyMs, candidates);
      completed += 1;
    } catch (error) {
      failed += 1;
      await input.store.retry(job.id, token, shadowErrorCode(error)).catch(() => undefined);
    }
  }
  await input.store.cleanup().catch(() => undefined);
  return { claimed: jobs.length, completed, failed };
}

export function shadowErrorCode(error: unknown) {
  const allowed = new Set([
    "shadow_query_ineligible", "shadow_embedding_unconfigured", "shadow_embedding_invalid",
    "shadow_context_failed", "shadow_search_failed", "shadow_complete_failed", "shadow_chunk_failed"
  ]);
  const value = error instanceof Error ? error.message : "shadow_failed";
  return allowed.has(value) ? value : "shadow_failed";
}

function vector(values: number[]) {
  return `[${values.join(",")}]`;
}

function mapMessage(row: any): Message {
  return {
    id: row.id, conversationId: row.conversation_id, sequence: Number(row.message_sequence), role: row.role,
    content: row.content, modelUsed: row.model_used, mode: row.mode, imagePresent: row.image_present,
    crisisDetected: row.crisis_detected, createdAt: row.created_at
  };
}
