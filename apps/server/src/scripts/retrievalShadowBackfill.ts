import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@softplace/shared";
import { config } from "../config.js";
import { buildShadowDialogueWindow, buildShadowUserEvidence } from "../domain/retrievalShadow.js";
import { createShadowEmbeddingProvider } from "../integrations/retrievalShadow.js";
import { supabaseAdmin } from "../integrations/supabase.js";

export async function main(argv = process.argv.slice(2)) {
  const userId = value(argv, "user-id");
  const confirm = argv.includes("--confirm");
  if (!userId) throw new Error("--user-id is required");
  if (!config.retrievalShadowUserIds.has(userId)) throw new Error("user is not in RETRIEVAL_SHADOW_USER_IDS");
  if (!supabaseAdmin) throw new Error("Supabase configuration is required");

  const { data: conversations, error: conversationError } = await supabaseAdmin.from("conversations")
    .select("id").eq("user_id", userId);
  if (conversationError) throw new Error("shadow_backfill_read_failed");
  const windows: Array<{
    conversationId: string;
    anchorId: string;
    start: number;
    end: number;
    dialogueText: string;
    evidenceText: string | null;
  }> = [];
  let skipped = 0;
  for (const conversation of conversations ?? []) {
    const { data, error } = await supabaseAdmin.from("messages")
      .select("id,conversation_id,message_sequence,role,content,model_used,mode,image_present,crisis_detected,created_at")
      .eq("conversation_id", conversation.id).order("message_sequence", { ascending: true });
    if (error) throw new Error("shadow_backfill_read_failed");
    const messages = (data ?? []).map(mapMessage);
    for (const message of messages.filter((item) => item.role === "user")) {
      const window = buildShadowDialogueWindow(messages, message.id);
      const evidence = buildShadowUserEvidence(messages, message.id);
      if (!window) { skipped += 1; continue; }
      windows.push({
        conversationId: conversation.id,
        anchorId: message.id,
        start: window.startSequence,
        end: window.endSequence,
        dialogueText: window.text,
        evidenceText: evidence?.text ?? null
      });
    }
  }

  console.info("[retrieval-shadow:backfill]", { mode: confirm ? "confirm" : "dry-run", eligible: windows.length, skipped });
  if (!confirm || !windows.length) return { eligible: windows.length, skipped, written: 0 };
  const provider = createShadowEmbeddingProvider();
  let written = 0;
  for (let offset = 0; offset < windows.length; offset += 64) {
    const batch = windows.slice(offset, offset + 64);
    const texts = batch.flatMap((window) => [window.dialogueText, ...(window.evidenceText ? [window.evidenceText] : [])]);
    const embeddings = await provider.embed(texts);
    let embeddingIndex = 0;
    for (let index = 0; index < batch.length; index += 1) {
      const window = batch[index]!;
      const dialogueEmbedding = embeddings[embeddingIndex++]!;
      const evidenceEmbedding = window.evidenceText ? embeddings[embeddingIndex++]! : null;
      const { error } = await supabaseAdmin.rpc("upsert_retrieval_chunk_with_evidence", {
        p_user_id: userId, p_conversation_id: window.conversationId, p_anchor_message_id: window.anchorId,
        p_start_sequence: window.start, p_end_sequence: window.end,
        p_dialogue_embedding: `[${dialogueEmbedding.join(",")}]`,
        p_evidence_embedding: evidenceEmbedding ? `[${evidenceEmbedding.join(",")}]` : null
      });
      if (error) throw new Error("shadow_backfill_write_failed");
      written += 1;
    }
  }
  console.info("[retrieval-shadow:backfill]", { written });
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
  main().catch((error) => { console.error(`[retrieval-shadow:backfill] ${error instanceof Error ? error.message : "failed"}`); process.exitCode = 1; });
}
