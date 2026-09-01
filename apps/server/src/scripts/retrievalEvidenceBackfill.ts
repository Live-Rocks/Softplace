import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@softplace/shared";
import { config } from "../config.js";
import { buildShadowUserEvidence } from "../domain/retrievalShadow.js";
import { createShadowEmbeddingProvider } from "../integrations/retrievalShadow.js";
import { supabaseAdmin } from "../integrations/supabase.js";

type EvidenceWindow = { chunkId: string; text: string };

export async function main(argv = process.argv.slice(2)) {
  const userId = value(argv, "user-id");
  const confirm = argv.includes("--confirm");
  if (!userId) throw new Error("--user-id is required");
  if (!config.retrievalShadowUserIds.has(userId)) throw new Error("user is not in RETRIEVAL_SHADOW_USER_IDS");
  if (!supabaseAdmin) throw new Error("Supabase configuration is required");
  const db = supabaseAdmin;
  const { data: chunks, error: chunkError } = await db.from("retrieval_chunks")
    .select("id,conversation_id,anchor_message_id,start_sequence,end_sequence")
    .eq("user_id", userId)
    .is("evidence_embedding", null)
    .order("end_sequence", { ascending: true });
  if (chunkError) throw new Error("evidence_backfill_read_failed");

  const windows: EvidenceWindow[] = [];
  let skipped = 0;
  const byConversation = new Map<string, any[]>();
  for (const chunk of chunks ?? []) {
    const conversationId = chunk.conversation_id as string;
    byConversation.set(conversationId, [...(byConversation.get(conversationId) ?? []), chunk]);
  }
  for (const [conversationId, conversationChunks] of byConversation) {
    const { data, error } = await db.from("messages")
      .select("id,conversation_id,message_sequence,role,content,model_used,mode,image_present,crisis_detected,created_at")
      .eq("conversation_id", conversationId)
      .order("message_sequence", { ascending: true });
    if (error) throw new Error("evidence_backfill_read_failed");
    const messages = (data ?? []).map(mapMessage);
    for (const chunk of conversationChunks) {
      const evidence = buildShadowUserEvidence(messages, chunk.anchor_message_id);
      if (!evidence
        || evidence.startSequence !== Number(chunk.start_sequence)
        || evidence.endSequence !== Number(chunk.end_sequence)) {
        skipped += 1;
        continue;
      }
      windows.push({ chunkId: chunk.id, text: evidence.text });
    }
  }

  console.info("[retrieval-evidence:backfill]", {
    mode: confirm ? "confirm" : "dry-run",
    eligible: windows.length,
    skipped
  });
  if (!confirm || !windows.length) return { eligible: windows.length, skipped, written: 0 };

  const provider = createShadowEmbeddingProvider();
  let written = 0;
  for (let offset = 0; offset < windows.length; offset += 64) {
    const batch = windows.slice(offset, offset + 64);
    const embeddings = await provider.embed(batch.map((window) => window.text));
    for (let index = 0; index < batch.length; index += 1) {
      const window = batch[index]!;
      const embedding = embeddings[index]!;
      const { data: updated, error } = await db.rpc("set_retrieval_chunk_evidence_embedding", {
        p_user_id: userId,
        p_chunk_id: window.chunkId,
        p_evidence_embedding: `[${embedding.join(",")}]`
      });
      if (error || updated !== true) throw new Error("evidence_backfill_write_failed");
      written += 1;
    }
  }
  console.info("[retrieval-evidence:backfill]", { written });
  return { eligible: windows.length, skipped, written };
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
