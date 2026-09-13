import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@softplace/shared";
import { config } from "../config.js";
import { buildShadowDialogueWindow, buildShadowUserEvidence } from "../domain/retrievalShadow.js";
import { createShadowEmbeddingProvider } from "../integrations/retrievalShadow.js";
import { supabaseAdmin } from "../integrations/supabase.js";
import { RETRIEVAL_PAGE_SIZE, keysetWindow, type Keyset } from "./retrievalPagination.js";

export async function main(argv = process.argv.slice(2)) {
  const userId = value(argv, "user-id");
  const confirm = argv.includes("--confirm");
  if (!userId) throw new Error("--user-id is required");
  if (!config.retrievalShadowUserIds.has(userId)) throw new Error("user is not in RETRIEVAL_SHADOW_USER_IDS");
  if (!supabaseAdmin) throw new Error("Supabase configuration is required");
  const observedAt = new Date().toISOString();

  const { data: conversationUpperRows, error: conversationUpperError } = await supabaseAdmin.from("conversations")
    .select("id").eq("user_id", userId).lte("created_at", observedAt)
    .order("id", { ascending: false }).limit(1);
  if (conversationUpperError) throw new Error("shadow_backfill_read_failed");
  const conversationUpperId = conversationUpperRows?.[0]?.id as string | undefined;
  const conversations: Array<{ id: string }> = [];
  let conversationCursor: string | null = null;
  while (conversationUpperId) {
    let query = supabaseAdmin.from("conversations").select("id").eq("user_id", userId)
      .lte("created_at", observedAt).lte("id", conversationUpperId)
      .order("id", { ascending: true }).limit(RETRIEVAL_PAGE_SIZE);
    if (conversationCursor) query = query.gt("id", conversationCursor);
    const { data, error } = await query;
    if (error) throw new Error("shadow_backfill_read_failed");
    if (!(data ?? []).length) break;
    conversations.push(...data);
    conversationCursor = data![data!.length - 1]!.id;
  }
  const { data: chunkUpperRows, error: chunkUpperError } = await supabaseAdmin.from("retrieval_chunks")
    .select("id").eq("user_id", userId).lte("created_at", observedAt)
    .order("id", { ascending: false }).limit(1);
  if (chunkUpperError) throw new Error("shadow_backfill_read_failed");
  const chunkUpperId = chunkUpperRows?.[0]?.id as string | undefined;
  const existingAnchors = new Set<string>();
  let chunkCursor: string | null = null;
  while (chunkUpperId) {
    let query = supabaseAdmin.from("retrieval_chunks").select("id,anchor_message_id")
      .eq("user_id", userId).lte("created_at", observedAt).lte("id", chunkUpperId)
      .order("id", { ascending: true }).limit(RETRIEVAL_PAGE_SIZE);
    if (chunkCursor) query = query.gt("id", chunkCursor);
    const { data, error } = await query;
    if (error) throw new Error("shadow_backfill_read_failed");
    if (!(data ?? []).length) break;
    for (const row of data ?? []) existingAnchors.add(row.anchor_message_id);
    chunkCursor = data![data!.length - 1]!.id;
  }
  const provider = confirm ? createShadowEmbeddingProvider() : null;
  const pending: Array<{
    conversationId: string;
    anchorId: string;
    start: number;
    end: number;
    dialogueText: string;
    evidenceText: string | null;
  }> = [];
  let eligible = 0;
  let skipped = 0;
  let written = 0;

  async function flush() {
    if (!confirm || !pending.length || !provider) { pending.length = 0; return; }
    const batch = pending.splice(0, pending.length);
    const texts = batch.flatMap((window) => [window.dialogueText, ...(window.evidenceText ? [window.evidenceText] : [])]);
    const embeddings = await provider.embed(texts);
    let embeddingIndex = 0;
    for (const window of batch) {
      const dialogueEmbedding = embeddings[embeddingIndex++]!;
      const evidenceEmbedding = window.evidenceText ? embeddings[embeddingIndex++]! : null;
      const { error } = await supabaseAdmin!.rpc("upsert_retrieval_chunk_with_evidence", {
        p_user_id: userId, p_conversation_id: window.conversationId, p_anchor_message_id: window.anchorId,
        p_start_sequence: window.start, p_end_sequence: window.end,
        p_dialogue_embedding: `[${dialogueEmbedding.join(",")}]`,
        p_evidence_embedding: evidenceEmbedding ? `[${evidenceEmbedding.join(",")}]` : null
      });
      if (error) throw new Error("shadow_backfill_write_failed");
      written += 1;
    }
  }

  for (const conversation of conversations) {
    const upper = await messageUpper(conversation.id);
    let cursor: Keyset | null = null;
    let carry: Message[] = [];
    while (upper) {
      const query: any = supabaseAdmin.from("messages")
        .select("id,conversation_id,message_sequence,role,content,model_used,mode,image_present,crisis_detected,created_at")
        .eq("conversation_id", conversation.id)
        .lte("created_at", observedAt)
        .or(keysetWindow("message_sequence", cursor, upper))
        .order("message_sequence", { ascending: true }).order("id", { ascending: true })
        .limit(RETRIEVAL_PAGE_SIZE);
      const { data, error }: any = await query;
      if (error) throw new Error("shadow_backfill_read_failed");
      if (!(data ?? []).length) break;
      const page: Message[] = (data ?? []).map(mapMessage);
      const messages = [...carry, ...page];
      for (const message of page.filter((item: Message) => item.role === "user")) {
        if (existingAnchors.has(message.id)) { skipped += 1; continue; }
        const window = buildShadowDialogueWindow(messages, message.id);
        const evidence = buildShadowUserEvidence(messages, message.id);
        if (!window) { skipped += 1; continue; }
        eligible += 1;
        pending.push({
          conversationId: conversation.id, anchorId: message.id,
          start: window.startSequence, end: window.endSequence,
          dialogueText: window.text, evidenceText: evidence?.text ?? null
        });
        if (pending.length >= 64) await flush();
      }
      carry = messages.slice(-2);
      const last: Message = page[page.length - 1]!;
      cursor = { primary: last.sequence, id: last.id };
    }
  }
  await flush();

  console.info("[retrieval-shadow:backfill]", { mode: confirm ? "confirm" : "dry-run", eligible, skipped });
  console.info("[retrieval-shadow:backfill]", { written });
  return { eligible, skipped, written };

  async function messageUpper(conversationId: string): Promise<Keyset | null> {
    const { data, error } = await supabaseAdmin!.from("messages").select("id,message_sequence")
      .eq("conversation_id", conversationId)
      .order("message_sequence", { ascending: false }).order("id", { ascending: false }).limit(1);
    if (error) throw new Error("shadow_backfill_read_failed");
    const row = data?.[0];
    return row ? { primary: Number(row.message_sequence), id: row.id } : null;
  }
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
