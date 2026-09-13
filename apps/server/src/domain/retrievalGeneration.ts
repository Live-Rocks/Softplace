import crypto from "node:crypto";
import { get_encoding } from "@dqbd/tiktoken";
import type { Message } from "@softplace/shared";
import { RETRIEVAL_SHADOW, isEligibleShadowMessage, truncate } from "./retrievalShadow.js";
export { classifyGenerationMessage, normalizeGenerationText } from "./retrievalEvidence.js";
import { classifyGenerationMessage, normalizeGenerationText } from "./retrievalEvidence.js";

export const RETRIEVAL_GENERATION = {
  evaluationVersion: "phase25_v1",
  selectionVersion: "adaptive_v1",
  queryBuilderVersion: "recent_user_2_v1",
  evidenceFilterVersion: "evidence_filter_v1",
  contextFormatterVersion: "retrieved_user_history_v1",
  historyLimit: 10,
  baselineHistoryLimit: 20,
  candidateLimit: 20,
  injectionLimit: 5,
  selectionStrategy: "user_evidence_adaptive",
  minimumScore: 0.4,
  relativeScoreRatio: 0.9,
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
  | "below_relevance"
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
  sources: Array<{
    chunkId: string;
    rank: number;
    messages: Array<{ messageId: string; sequence: number; prefixCodePoints: number; sourceHash: string }>;
  }>;
};

export type GenerationQuery = ReturnType<typeof buildGenerationQuery>;

export type GenerationManifest = {
  version: "phase25_v1";
  currentQueryMessageId?: string;
  historyMessageIds: string[];
  historyHash: string;
  queryContext: Array<{ messageId: string; prefixCodePoints: number; sourceHash: string }>;
  currentQueryPrefixCodePoints: number;
  currentQueryHash: string;
  embeddingInputHash: string;
  injectedCandidates: PreparedGenerationContext["sources"];
  retrievalContextHash: string | null;
  retrievalContextTokens: number;
  formatterVersion: string;
};

export type GenerationManifestReplay = {
  verification: "verified" | "unverifiable";
  reason: string | null;
  history: Array<{ id: string; role: string; content: string }>;
  embeddingInput: string | null;
  retrievalContext: string | null;
};

const encoder = get_encoding("o200k_base");

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
    recentContextSources: eligibleUsers.map((message, index) => ({
      messageId: message.id,
      prefixCodePoints: [...(recentContext[index] ?? "")].length,
      sourceHash: sha256(message.content)
    })),
    currentQuery: current,
    currentQueryPrefixCodePoints: [...current].length,
    currentQueryHash: sha256(currentQuery),
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
  const classified = [...candidates].sort((left, right) => left.rank - right.rank).map((candidate) => {
    const userMessages = candidate.source
      .filter((message) => message.role === "user")
      .sort((left, right) => left.sequence - right.sequence);
    const evidence = userMessages.filter((message) => classifyGenerationMessage(message.content) === "evidence");
    return { candidate, userMessages, evidence };
  });
  const effectiveThreshold = generationEffectiveThreshold(classified
    .filter((item) => item.evidence.length)
    .map((item) => item.candidate.score));

  return classified.map(({ candidate, userMessages, evidence }) => {
    if (!userMessages.length) return ranked(candidate, null, "invalid_source", []);

    if (!evidence.length) {
      const allBoilerplate = userMessages.every((message) => classifyGenerationMessage(message.content) === "boilerplate");
      return ranked(candidate, null, allBoilerplate ? "boilerplate_only" : "recall_probe_only", []);
    }
    const overlapsSelected = evidence.some((message) => {
      const normalized = normalizeGenerationText(message.content);
      return seenIds.has(message.id) || seenContent.has(normalized);
    });
    if (overlapsSelected) return ranked(candidate, null, "duplicate", []);
    if (effectiveThreshold === null || candidate.score < effectiveThreshold) {
      return ranked(candidate, null, "below_relevance", evidence);
    }
    if (selectionRank >= injectionLimit) return ranked(candidate, null, "not_selected", evidence);
    selectionRank += 1;
    for (const message of evidence) {
      seenIds.add(message.id);
      seenContent.add(normalizeGenerationText(message.content));
    }
    return ranked(candidate, selectionRank, "selected", evidence);
  });
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
      userMessages: messages.map((message) => ({
        messageId: message.id,
        sequence: message.sequence,
        sourceHash: sha256(message.content),
        content: truncate(message.content, RETRIEVAL_SHADOW.maxChunkMessageCharacters)
      }))
    });
  }

  const selected = fitCandidatesFairly(candidatesWithUniqueUserMessages, tokenBudget);
  if (!selected.length) return null;
  const text = formatGenerationContext(selected);
  return {
    text,
    tokenCount: countTokens(text),
    injectedChunkIds: selected.map((candidate) => candidate.chunkId),
    sources: selected.map((candidate) => ({
      chunkId: candidate.chunkId,
      rank: candidate.rank,
      messages: candidate.userMessages.map((message) => ({
        messageId: message.messageId,
        sequence: message.sequence,
        prefixCodePoints: [...message.content].length,
        sourceHash: message.sourceHash
      }))
    }))
  };
}

type ContextMessage = { messageId: string; sequence: number; content: string; sourceHash: string };
type ContextCandidate = { rank: number; userMessages: ContextMessage[]; chunkId: string };

function fitCandidatesFairly(candidates: ContextCandidate[], tokenBudget: number) {
  if (!candidates.length || tokenBudget < 1) return [];
  const emptyContext = candidates.map((candidate) => ({ ...candidate, userMessages: [] }));
  const envelopeTokens = countTokens(formatGenerationContext(emptyContext));
  // Leave room for JSON string escaping and token-boundary effects, then verify the final payload exactly.
  let contentBudget = Math.max(0, tokenBudget - envelopeTokens - 64);

  while (contentBudget >= 0) {
    const candidateNeeds = candidates.map((candidate) =>
      candidate.userMessages.reduce((total, message) => total + countTokens(message.content), 0)
    );
    const candidateBudgets = allocateFairly(candidateNeeds, contentBudget);
    const prepared = candidates.flatMap((candidate, candidateIndex) => {
      const messageNeeds = candidate.userMessages.map((message) => countTokens(message.content));
      const messageBudgets = allocateFairly(messageNeeds, candidateBudgets[candidateIndex] ?? 0);
      const userMessages = candidate.userMessages
        .map((message, messageIndex) => ({
          ...message,
          content: truncateToTokens(message.content, messageBudgets[messageIndex] ?? 0)
        }))
        .filter((message) => Boolean(message.content));
      return userMessages.length ? [{ ...candidate, userMessages }] : [];
    });
    if (!prepared.length) return [];
    const actualTokens = countTokens(formatGenerationContext(prepared));
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

export function formatGenerationContext(candidates: Array<{ rank: number; userMessages: Array<{ content: string }> }>) {
  return JSON.stringify({
    type: "retrieved_user_history",
    warning: "候選彼此可能無關；只能使用與本輪直接對應的舊使用者原話。本輪與最近對話優先，其餘完全忽略。",
    candidates: candidates.map((candidate) => ({
      rank: candidate.rank,
      user_messages: candidate.userMessages.map((message) => message.content)
    }))
  });
}

export function generationEffectiveThreshold(scores: number[]) {
  const best = Math.max(...scores);
  return Number.isFinite(best)
    ? Math.max(RETRIEVAL_GENERATION.minimumScore, best * RETRIEVAL_GENERATION.relativeScoreRatio)
    : null;
}

export function buildGenerationManifest(input: {
  history: Message[];
  query: GenerationQuery;
  prepared: PreparedGenerationContext | null;
}): GenerationManifest {
  return {
    version: RETRIEVAL_GENERATION.evaluationVersion,
    historyMessageIds: input.history.map((message) => message.id),
    historyHash: sha256(JSON.stringify(input.history.map((message) => ({
      id: message.id, role: message.role, content: message.content
    })))),
    queryContext: input.query.recentContextSources,
    currentQueryPrefixCodePoints: input.query.currentQueryPrefixCodePoints,
    currentQueryHash: input.query.currentQueryHash,
    embeddingInputHash: sha256(input.query.text),
    injectedCandidates: input.prepared?.sources ?? [],
    retrievalContextHash: input.prepared ? sha256(input.prepared.text) : null,
    retrievalContextTokens: input.prepared?.tokenCount ?? 0,
    formatterVersion: RETRIEVAL_GENERATION.contextFormatterVersion
  };
}

export function replayGenerationManifest(
  manifest: GenerationManifest,
  sourceMessages: Map<string, { id: string; role: string; content: string }>,
  currentQueryId: string
): GenerationManifestReplay {
  const failed = (reason: string): GenerationManifestReplay => ({
    verification: "unverifiable", reason, history: [], embeddingInput: null, retrievalContext: null
  });
  if (manifest.version !== RETRIEVAL_GENERATION.evaluationVersion
    || manifest.formatterVersion !== RETRIEVAL_GENERATION.contextFormatterVersion) {
    return failed("unsupported_manifest_version");
  }
  const history = manifest.historyMessageIds.map((id) => sourceMessages.get(id)).filter(Boolean) as Array<{
    id: string; role: string; content: string;
  }>;
  if (history.length !== manifest.historyMessageIds.length) return failed("manifest_source_missing");
  const historyHash = sha256(JSON.stringify(history.map((message) => ({
    id: message.id, role: message.role, content: message.content
  }))));
  if (historyHash !== manifest.historyHash) return failed("manifest_history_hash_mismatch");

  const context: string[] = [];
  for (const reference of manifest.queryContext) {
    const message = sourceMessages.get(reference.messageId);
    if (!message) return failed("manifest_source_missing");
    if (sha256(message.content) !== reference.sourceHash) return failed("manifest_source_hash_mismatch");
    context.push(codePointPrefix(message.content, reference.prefixCodePoints));
  }
  const current = sourceMessages.get(currentQueryId);
  if (!current) return failed("manifest_query_missing");
  if (sha256(current.content) !== manifest.currentQueryHash) return failed("manifest_query_hash_mismatch");
  const currentQuery = codePointPrefix(current.content, manifest.currentQueryPrefixCodePoints);
  const embeddingInput = [...context.map((content) => `最近訊息：${content}`), `目前訊息：${currentQuery}`].join("\n");
  if (sha256(embeddingInput) !== manifest.embeddingInputHash) return failed("manifest_embedding_hash_mismatch");

  const replayCandidates: Array<{ rank: number; userMessages: Array<{ content: string }> }> = [];
  for (const candidate of manifest.injectedCandidates) {
    const userMessages: Array<{ content: string }> = [];
    for (const reference of candidate.messages) {
      const message = sourceMessages.get(reference.messageId);
      if (!message) return failed("manifest_source_missing");
      if (sha256(message.content) !== reference.sourceHash) return failed("manifest_source_hash_mismatch");
      userMessages.push({ content: codePointPrefix(message.content, reference.prefixCodePoints) });
    }
    replayCandidates.push({ rank: candidate.rank, userMessages });
  }
  const retrievalContext = replayCandidates.length ? formatGenerationContext(replayCandidates) : null;
  if ((retrievalContext ? sha256(retrievalContext) : null) !== manifest.retrievalContextHash
    || (retrievalContext ? countTokens(retrievalContext) : 0) !== manifest.retrievalContextTokens) {
    return failed("manifest_retrieval_hash_mismatch");
  }
  return { verification: "verified", reason: null, history, embeddingInput, retrievalContext };
}

function codePointPrefix(value: string, length: number) {
  return [...value].slice(0, Math.max(0, length)).join("");
}

export function sha256(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
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
