import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@softplace/shared";
import { config } from "../config.js";
import { buildShadowUserEvidence } from "../domain/retrievalShadow.js";
import { createShadowEmbeddingProvider } from "../integrations/retrievalShadow.js";
import { supabaseAdmin } from "../integrations/supabase.js";
import { RETRIEVAL_PAGE_SIZE } from "./retrievalPagination.js";

type EvidenceWindow = { chunkId: string; text: string | null };
type ChunkRow = {
  id: string;
  conversation_id: string;
  anchor_message_id: string;
  start_sequence: number;
  end_sequence: number;
};

export async function main(argv = process.argv.slice(2)) {
  const userId = value(argv, "user-id");
  const confirm = argv.includes("--confirm");
  const refresh = argv.includes("--refresh");
  if (!userId) throw new Error("--user-id is required");
  if (!config.retrievalShadowUserIds.has(userId)) throw new Error("user is not in RETRIEVAL_SHADOW_USER_IDS");
  if (!supabaseAdmin) throw new Error("Supabase configuration is required");
  const db = supabaseAdmin;
  const observedAt = new Date().toISOString();
  const provider = confirm ? createShadowEmbeddingProvider() : null;
  let upperQuery = db.from("retrieval_chunks").select("id")
    .eq("user_id", userId).lte("created_at", observedAt);
  if (!refresh) upperQuery = upperQuery.is("evidence_embedding", null);
  const { data: upperRows, error: upperError } = await upperQuery
    .order("id", { ascending: false }).limit(1);
  if (upperError) throw new Error("evidence_backfill_read_failed");
  const upperChunkId = upperRows?.[0]?.id as string | undefined;
  const windows: EvidenceWindow[] = [];
  let eligible = 0;
  let embedded = 0;
  let cleared = 0;
  let skipped = 0;
  let missingSource = 0;
  let written = 0;

  async function flush() {
    if (!confirm || !windows.length || !provider) { windows.length = 0; return; }
    const batch = windows.splice(0, windows.length);
    const texts = batch.flatMap((window) => window.text ? [window.text] : []);
    const embeddings = texts.length ? await provider.embed(texts) : [];
    let embeddingIndex = 0;
    for (const window of batch) {
      const embedding = window.text ? embeddings[embeddingIndex++]! : null;
      const { data: updated, error } = await db.rpc("set_retrieval_chunk_evidence_embedding", {
        p_user_id: userId, p_chunk_id: window.chunkId,
        p_evidence_embedding: embedding ? `[${embedding.join(",")}]` : null
      });
      if (error || updated !== true) throw new Error("evidence_backfill_write_failed");
      written += 1;
    }
  }

  let cursor: string | null = null;
  while (upperChunkId) {
    let chunkQuery = db.from("retrieval_chunks")
      .select("id,conversation_id,anchor_message_id,start_sequence,end_sequence")
      .eq("user_id", userId).lte("created_at", observedAt).lte("id", upperChunkId)
      .order("id", { ascending: true }).limit(RETRIEVAL_PAGE_SIZE);
    if (!refresh) chunkQuery = chunkQuery.is("evidence_embedding", null);
    if (cursor) chunkQuery = chunkQuery.gt("id", cursor);
    const { data: chunks, error: chunkError } = await chunkQuery;
    if (chunkError) throw new Error("evidence_backfill_read_failed");
    if (!(chunks ?? []).length) break;
    const chunkRows = chunks as ChunkRow[];
    const sourceByChunk = await loadChunkSources(db, chunkRows);
    for (const chunk of chunkRows) {
      const messages = sourceByChunk.get(chunk.id) ?? [];
      if (messages.length !== 3 || !messages.some((message) => message.id === chunk.anchor_message_id)) {
        missingSource += 1;
        continue;
      }
      const evidence = buildShadowUserEvidence(messages, chunk.anchor_message_id);
      if (evidence && (evidence.startSequence !== Number(chunk.start_sequence)
        || evidence.endSequence !== Number(chunk.end_sequence))) {
        skipped += 1;
        continue;
      }
      if (!evidence && !refresh) { skipped += 1; continue; }
      eligible += 1;
      if (evidence) embedded += 1; else cleared += 1;
      windows.push({ chunkId: chunk.id, text: evidence?.text ?? null });
      if (windows.length >= 64) await flush();
    }
    cursor = chunks![chunks!.length - 1]!.id;
  }
  await flush();

  console.info("[retrieval-evidence:backfill]", {
    mode: `${refresh ? "refresh-" : ""}${confirm ? "confirm" : "dry-run"}`,
    eligible, embedded, cleared, skipped, missingSource
  });
  console.info("[retrieval-evidence:backfill]", { written });
  return { eligible, skipped, missingSource, written };
}

export async function loadChunkSources(db: any, chunks: ChunkRow[], rangeBatchSize = 25) {
  const result = new Map<string, Message[]>();
  const byConversation = new Map<string, ChunkRow[]>();
  for (const chunk of chunks) {
    byConversation.set(chunk.conversation_id, [...(byConversation.get(chunk.conversation_id) ?? []), chunk]);
  }
  for (const [conversationId, conversationChunks] of byConversation) {
    const rows = new Map<string, any>();
    for (let offset = 0; offset < conversationChunks.length; offset += rangeBatchSize) {
      const batch = conversationChunks.slice(offset, offset + rangeBatchSize);
      const ranges = batch.map((chunk) =>
        `and(message_sequence.gte.${chunk.start_sequence},message_sequence.lte.${chunk.end_sequence})`
      );
      const { data, error } = await db.from("messages")
        .select("id,conversation_id,message_sequence,role,content,model_used,mode,image_present,crisis_detected,created_at")
        .eq("conversation_id", conversationId).or(ranges.join(","))
        .order("message_sequence", { ascending: true }).order("id", { ascending: true });
      if (error) throw new Error("evidence_backfill_read_failed");
      for (const row of data ?? []) rows.set(row.id, row);
    }
    for (const chunk of conversationChunks) {
      result.set(chunk.id, [...rows.values()].filter((row) => Number(row.message_sequence) >= Number(chunk.start_sequence)
        && Number(row.message_sequence) <= Number(chunk.end_sequence)).map(mapMessage));
    }
  }
  return result;
}

function value(argv: string[], name: string) {
  return argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
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
    console.error(`[retrieval-evidence:backfill] ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  });
}
