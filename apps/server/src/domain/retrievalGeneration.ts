import { get_encoding } from "@dqbd/tiktoken";
import type { Message } from "@softplace/shared";
import { RETRIEVAL_SHADOW, isEligibleShadowMessage, truncate } from "./retrievalShadow.js";

export const RETRIEVAL_GENERATION = {
  historyLimit: 10,
  baselineHistoryLimit: 20,
  candidateLimit: 20,
  injectionLimit: 5,
  selectionStrategy: "top20_local_rerank",
  tokenBudget: 1200,
  timeoutMs: 2500,
  retentionDays: 30
} as const;

export type GenerationCandidateSource = Pick<Message, "id" | "sequence" | "role" | "content">;

export type GenerationCandidate = {
  chunkId: string;
  rank: number;
  score: number;
  startSequence: number;
  endSequence: number;
  source: GenerationCandidateSource[];
};

export type GenerationSelectionDecision =
  | "selected"
  | "recall_probe_only"
  | "boilerplate_only"
  | "duplicate"
  | "not_selected"
  | "invalid_source";

export type RankedGenerationCandidate = GenerationCandidate & {
  selectionRank: number | null;
  selectionDecision: GenerationSelectionDecision;
};

export type PreparedGenerationContext = {
  text: string;
  tokenCount: number;
  injectedChunkIds: string[];
};

const encoder = get_encoding("o200k_base");
const BOILERPLATE = new Set(["好", "好呀", "好的", "嗯", "喔", "哦", "謝謝", "我來了", "測試", "測試訊息"]);
const MEMORY_RECALL_PATTERNS = ["記得", "想得起", "有印象"] as const;
const FACT_LOOKUP_PATTERNS = [
  "叫什麼", "什麼名字", "去哪裡", "去了哪裡", "在哪裡",
  "是誰", "是什麼", "什麼時候", "多少", "哪一個", "哪個"
] as const;

export function countTokens(value: string) {
  return encoder.encode(value).length;
}

export function buildGenerationQuery(history: Message[], currentQuery: string) {
  const eligibleUsers = history
    .filter((message) => message.role === "user" && isEligibleShadowMessage(message))
    .slice(-2);
  const recentContext = eligibleUsers.map((message) => truncate(message.content, RETRIEVAL_SHADOW.maxContextCharacters));
  const current = truncate(currentQuery, RETRIEVAL_SHADOW.maxCurrentCharacters);
  return {
    recentContext,
    currentQuery: current,
    text: [...recentContext.map((content) => `最近訊息：${content}`), `目前訊息：${current}`].join("\n")
  };
}

export function generationSearchBeforeSequence(history: Message[]) {
  return history[0]?.sequence ?? null;
}

export function rerankGenerationCandidates(
  candidates: GenerationCandidate[],
  injectionLimit = RETRIEVAL_GENERATION.injectionLimit
): RankedGenerationCandidate[] {
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  let selectionRank = 0;

  return [...candidates].sort((left, right) => left.rank - right.rank).map((candidate) => {
    const userMessages = candidate.source
      .filter((message) => message.role === "user")
      .sort((left, right) => left.sequence - right.sequence);
    if (!userMessages.length) return ranked(candidate, null, "invalid_source", []);

    const evidence = userMessages.filter((message) => classifyGenerationMessage(message.content) === "evidence");
    if (!evidence.length) {
      const allBoilerplate = userMessages.every((message) => classifyGenerationMessage(message.content) === "boilerplate");
      return ranked(candidate, null, allBoilerplate ? "boilerplate_only" : "recall_probe_only", []);
    }

    const uniqueEvidence = evidence.filter((message) => {
      const normalized = normalizeGenerationText(message.content);
      if (seenIds.has(message.id) || seenContent.has(normalized)) return false;
      seenIds.add(message.id);
      seenContent.add(normalized);
      return true;
    });
    if (!uniqueEvidence.length) return ranked(candidate, null, "duplicate", []);
    if (selectionRank >= injectionLimit) return ranked(candidate, null, "not_selected", uniqueEvidence);
    selectionRank += 1;
    return ranked(candidate, selectionRank, "selected", uniqueEvidence);
  });
}

export function classifyGenerationMessage(content: string): "evidence" | "recall_probe" | "boilerplate" {
  const clauses = content.split(/[\n,，。；;！!？?]+/u).map(normalizeGenerationText).filter(Boolean);
  if (!clauses.length || clauses.every((clause) => BOILERPLATE.has(clause))) return "boilerplate";
  if (clauses.some((clause) => !BOILERPLATE.has(clause) && !isRecallProbeClause(clause))) {
    return "evidence";
  }
  return "recall_probe";
}

export function normalizeGenerationText(content: string) {
  return content.normalize("NFKC").toLocaleLowerCase("zh-Hant").replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function prepareGenerationContext(
  candidates: GenerationCandidate[],
  options: { injectionLimit?: number; tokenBudget?: number } = {}
): PreparedGenerationContext | null {
  const injectionLimit = options.injectionLimit ?? RETRIEVAL_GENERATION.injectionLimit;
  const tokenBudget = options.tokenBudget ?? RETRIEVAL_GENERATION.tokenBudget;
  const seenMessages = new Set<string>();
  const seenContent = new Set<string>();
  const candidatesWithUniqueUserMessages: ContextCandidate[] = [];

  for (const candidate of [...candidates].sort((left, right) => left.rank - right.rank).slice(0, injectionLimit)) {
    const messages = candidate.source
      .filter((message) => message.role === "user")
      .filter((message) => {
        const key = `${message.id}:${message.sequence}`;
        const normalized = normalizeGenerationText(message.content);
        if (seenMessages.has(key) || seenContent.has(normalized)) return false;
        seenMessages.add(key);
        seenContent.add(normalized);
        return true;
      })
      .sort((left, right) => left.sequence - right.sequence);
    if (!messages.length) continue;
    candidatesWithUniqueUserMessages.push({
      rank: candidate.rank,
      chunkId: candidate.chunkId,
      userMessages: messages.map((message) => truncate(message.content, RETRIEVAL_SHADOW.maxChunkMessageCharacters))
    });
  }

  const selected = fitCandidatesFairly(candidatesWithUniqueUserMessages, tokenBudget);
  if (!selected.length) return null;
  const text = formatContext(selected);
  return { text, tokenCount: countTokens(text), injectedChunkIds: selected.map((candidate) => candidate.chunkId) };
}

type ContextCandidate = { rank: number; userMessages: string[]; chunkId: string };

function fitCandidatesFairly(candidates: ContextCandidate[], tokenBudget: number) {
  if (!candidates.length || tokenBudget < 1) return [];
  const emptyContext = candidates.map((candidate) => ({ ...candidate, userMessages: [] }));
  const envelopeTokens = countTokens(formatContext(emptyContext));
  // Leave room for JSON string escaping and token-boundary effects, then verify the final payload exactly.
  let contentBudget = Math.max(0, tokenBudget - envelopeTokens - 64);

  while (contentBudget >= 0) {
    const candidateNeeds = candidates.map((candidate) =>
      candidate.userMessages.reduce((total, message) => total + countTokens(message), 0)
    );
    const candidateBudgets = allocateFairly(candidateNeeds, contentBudget);
    const prepared = candidates.flatMap((candidate, candidateIndex) => {
      const messageNeeds = candidate.userMessages.map(countTokens);
      const messageBudgets = allocateFairly(messageNeeds, candidateBudgets[candidateIndex] ?? 0);
      const userMessages = candidate.userMessages
        .map((message, messageIndex) => truncateToTokens(message, messageBudgets[messageIndex] ?? 0))
        .filter(Boolean);
      return userMessages.length ? [{ ...candidate, userMessages }] : [];
    });
    if (!prepared.length) return [];
    const actualTokens = countTokens(formatContext(prepared));
    if (actualTokens <= tokenBudget) return prepared;
    contentBudget -= Math.max(1, actualTokens - tokenBudget);
  }
  return [];
}

function allocateFairly(needs: number[], budget: number) {
  const allocations = needs.map(() => 0);
  const remaining = new Set(needs.map((_need, index) => index).filter((index) => needs[index]! > 0));
  let available = Math.max(0, Math.floor(budget));
  while (remaining.size && available > 0) {
    const share = Math.max(1, Math.floor(available / remaining.size));
    let consumed = 0;
    for (const index of [...remaining]) {
      const unmet = needs[index]! - allocations[index]!;
      const grant = Math.min(unmet, share, available - consumed);
      allocations[index]! += grant;
      consumed += grant;
      if (allocations[index] === needs[index]) remaining.delete(index);
      if (consumed >= available) break;
    }
    if (consumed === 0) break;
    available -= consumed;
  }
  return allocations;
}

function truncateToTokens(content: string, tokenLimit: number) {
  if (tokenLimit < 1) return "";
  if (countTokens(content) <= tokenLimit) return content;
  const characters = [...content];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const value = characters.slice(0, middle).join("");
    if (countTokens(value) <= tokenLimit) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("");
}

function formatContext(candidates: Array<{ rank: number; userMessages: string[] }>) {
  return JSON.stringify({
    type: "retrieved_user_history",
    warning: "候選彼此可能無關；只能使用與本輪直接對應的舊使用者原話。本輪與最近對話優先，其餘完全忽略。",
    candidates: candidates.map((candidate) => ({ rank: candidate.rank, user_messages: candidate.userMessages }))
  });
}

export function retrievalGenerationErrorCode(error: unknown) {
  const allowed = new Set([
    "generation_retrieval_timeout",
    "generation_embedding_timeout",
    "generation_search_timeout",
    "generation_source_timeout",
    "generation_embedding_unconfigured",
    "generation_embedding_failed",
    "generation_embedding_invalid",
    "generation_search_failed",
    "generation_source_failed"
  ]);
  const value = error instanceof Error ? error.message : "generation_retrieval_failed";
  return allowed.has(value) ? value : "generation_retrieval_failed";
}

function ranked(
  candidate: GenerationCandidate,
  selectionRank: number | null,
  selectionDecision: GenerationSelectionDecision,
  source: GenerationCandidateSource[]
): RankedGenerationCandidate {
  return { ...candidate, source, selectionRank, selectionDecision };
}

function isRecallProbeClause(clause: string) {
  if (FACT_LOOKUP_PATTERNS.some((pattern) => clause.includes(pattern))) return true;
  const mentionsRecall = MEMORY_RECALL_PATTERNS.some((pattern) => clause.includes(pattern));
  const addressesAssistant = clause.includes("你記得") || clause.includes("你還記得") || clause.startsWith("你想得起");
  return mentionsRecall && (addressesAssistant || clause.endsWith("嗎") || clause.endsWith("呢"));
}
