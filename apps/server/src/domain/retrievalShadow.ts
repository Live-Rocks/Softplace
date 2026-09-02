import type { Message } from "@softplace/shared";
import { classifyGenerationMessage } from "./retrievalEvidence.js";

export const RETRIEVAL_SHADOW = {
  model: "text-embedding-3-small",
  dimensions: 512,
  chunkStrategy: "dialogue_window",
  queryStrategy: "with_recent_context",
  threshold: 0.6,
  topK: 3,
  candidateLimit: 5,
  retentionDays: 90,
  maxCurrentCharacters: 4000,
  maxContextCharacters: 1000,
  maxChunkMessageCharacters: 1800
} as const;

export function isEligibleShadowMessage(message: Message) {
  return !message.imagePresent && !message.crisisDetected && Boolean(message.content.trim());
}

export function buildShadowQuery(messages: Message[], queryMessageId: string) {
  return buildShadowQueryParts(messages, queryMessageId).text;
}

export function buildShadowQueryParts(messages: Message[], queryMessageId: string) {
  const query = messages.find((message) => message.id === queryMessageId && message.role === "user");
  if (!query || !isEligibleShadowMessage(query)) throw new Error("shadow_query_ineligible");
  const recent = messages
    .filter((message) => message.role === "user" && message.sequence < query.sequence && isEligibleShadowMessage(message))
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, 2)
    .reverse();
  const recentContext = recent.map((message) => truncate(message.content, RETRIEVAL_SHADOW.maxContextCharacters));
  const currentQuery = truncate(query.content, RETRIEVAL_SHADOW.maxCurrentCharacters);
  return {
    recentContext,
    currentQuery,
    searchBeforeSequence: recent[0]?.sequence ?? query.sequence,
    text: [
      ...recentContext.map((content) => `最近訊息：${content}`),
      `目前訊息：${currentQuery}`
    ].join("\n")
  };
}

export function buildShadowDialogueWindow(messages: Message[], anchorMessageId: string) {
  const source = shadowWindowSource(messages, anchorMessageId);
  if (!source) return null;
  const [first, assistant, anchor] = source;
  return {
    startSequence: first.sequence,
    endSequence: anchor.sequence,
    text: [
      `使用者：${truncate(first.content, RETRIEVAL_SHADOW.maxChunkMessageCharacters)}`,
      `安放：${truncate(assistant.content, RETRIEVAL_SHADOW.maxChunkMessageCharacters)}`,
      `使用者：${truncate(anchor.content, RETRIEVAL_SHADOW.maxChunkMessageCharacters)}`
    ].join("\n")
  };
}

export function buildShadowUserEvidence(messages: Message[], anchorMessageId: string) {
  const source = shadowWindowSource(messages, anchorMessageId);
  if (!source) return null;
  const [first, , anchor] = source;
  const evidence = [first, anchor].filter((message) => classifyGenerationMessage(message.content) === "evidence");
  if (!evidence.length) return null;
  return {
    startSequence: first.sequence,
    endSequence: anchor.sequence,
    text: evidence
      .map((message) => truncate(message.content, RETRIEVAL_SHADOW.maxChunkMessageCharacters))
      .join("\n")
  };
}

function shadowWindowSource(messages: Message[], anchorMessageId: string): [Message, Message, Message] | null {
  const anchor = messages.find((message) => message.id === anchorMessageId && message.role === "user");
  if (!anchor || !isEligibleShadowMessage(anchor)) return null;
  const first = messages.find((message) => message.sequence === anchor.sequence - 2 && message.role === "user");
  const assistant = messages.find((message) => message.sequence === anchor.sequence - 1 && message.role === "assistant");
  if (!first || !assistant || !isEligibleShadowMessage(first) || !isEligibleShadowMessage(assistant)) return null;
  return [first, assistant, anchor];
}

export function truncate(value: string, maxCharacters: number) {
  return [...value].slice(0, maxCharacters).join("");
}
