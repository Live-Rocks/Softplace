import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { Message } from "@softplace/shared";
import { RETRIEVAL_SHADOW, buildShadowDialogueWindow, buildShadowQuery, buildShadowQueryParts, buildShadowUserEvidence, truncate } from "../src/domain/retrievalShadow.js";
import { processRetrievalShadowJobs, shadowErrorCode, type RetrievalShadowStore } from "../src/integrations/retrievalShadow.js";
import { qualityAtThreshold } from "../src/scripts/retrievalShadowReport.js";
import { candidatesToReview, formatCandidateHeader, formatReviewHeader, scanKeysetReviewRuns, scanReviewRuns } from "../src/scripts/retrievalShadowReview.js";

const messages: Message[] = [
  message("u1", 1, "user", "主管昨天又改了企劃"),
  message("a1", 2, "assistant", "那份反覆會讓人很挫折"),
  message("u2", 3, "user", "我今天看到信又緊張了"),
  message("a2", 4, "assistant", "你像是先預期又會被推翻"),
  message("u3", 5, "user", "果然又來了")
];

test("shadow builders preserve Phase 0 roles, recent user context, and deterministic truncation", () => {
  assert.equal(RETRIEVAL_SHADOW.dimensions, 512);
  assert.equal(buildShadowQuery(messages, "u3"), [
    "最近訊息：主管昨天又改了企劃",
    "最近訊息：我今天看到信又緊張了",
    "目前訊息：果然又來了"
  ].join("\n"));
  assert.deepEqual(buildShadowDialogueWindow(messages, "u3"), {
    startSequence: 3,
    endSequence: 5,
    text: "使用者：我今天看到信又緊張了\n安放：你像是先預期又會被推翻\n使用者：果然又來了"
  });
  assert.deepEqual(buildShadowUserEvidence(messages, "u3"), {
    startSequence: 3,
    endSequence: 5,
    text: "我今天看到信又緊張了\n果然又來了"
  });
  assert.equal(truncate("甲乙丙", 2), "甲乙");
  assert.equal(buildShadowQuery(messages, "u3"), buildShadowQuery(messages, "u3"));
});

test("shadow builders reject image or crisis query and skip unsafe windows", () => {
  const unsafe = messages.map((item) => item.id === "u3" ? { ...item, crisisDetected: true } : item);
  assert.throws(() => buildShadowQuery(unsafe, "u3"), /shadow_query_ineligible/);
  assert.equal(buildShadowDialogueWindow(unsafe, "u3"), null);
  assert.equal(buildShadowUserEvidence(unsafe, "u3"), null);
});

test("user evidence embedding uses the same recall-probe and boilerplate filters as injection", () => {
  const mixed: Message[] = [
    message("probe", 1, "user", "你還記得那隻貓叫什麼嗎？"),
    message("answer", 2, "assistant", "牠叫咪咪"),
    message("fact", 3, "user", "我幫牠取名叫飽飽")
  ];
  assert.deepEqual(buildShadowUserEvidence(mixed, "fact"), {
    startSequence: 1,
    endSequence: 3,
    text: "我幫牠取名叫飽飽"
  });

  const noEvidence: Message[] = [
    message("probe", 1, "user", "你還記得那隻貓叫什麼嗎？"),
    message("answer", 2, "assistant", "牠叫咪咪"),
    message("thanks", 3, "user", "謝謝")
  ];
  assert.equal(buildShadowUserEvidence(noEvidence, "thanks"), null);
});

test("review displays the exact embedding input, two context slots, and threshold state", () => {
  const mixed = [
    message("u0", 0, "user", "太早的內容"),
    ...messages,
    { ...message("unsafe", 6, "user", "危機內容"), crisisDetected: true },
    message("future", 7, "user", "未來訊息")
  ];
  const eligibleAtQueryTime = mixed.filter((item) => item.sequence <= 5);
  const parts = buildShadowQueryParts(eligibleAtQueryTime, "u3");
  assert.equal(parts.text, buildShadowQuery(eligibleAtQueryTime, "u3"));
  assert.deepEqual(parts.recentContext, ["主管昨天又改了企劃", "我今天看到信又緊張了"]);
  assert.equal(parts.currentQuery, "果然又來了");
  assert.equal(parts.searchBeforeSequence, 1);
  const header = formatReviewHeader("run-1", parts);
  assert.match(header, /Recent context 1: 主管昨天又改了企劃/);
  assert.match(header, /Recent context 2: 我今天看到信又緊張了/);
  assert.match(header, /Current query: 果然又來了/);
  assert.match(header, new RegExp(parts.text));
  assert.doesNotMatch(header, /危機內容|未來訊息|太早的內容/);
  assert.equal(formatCandidateHeader({ rank: 1, score: 0.70581, passed_threshold: true }), "#1 score=0.7058 passed_threshold=yes");
  assert.equal(formatCandidateHeader({ rank: 3, score: 0.521, passed_threshold: false }), "#3 score=0.5210 passed_threshold=no");
});

test("review query reconstruction excludes prior image and crisis context", () => {
  const history: Message[] = [
    message("older", 1, "user", "較早但合格"),
    { ...message("image", 2, "user", "圖片訊息"), imagePresent: true },
    { ...message("crisis", 3, "user", "危機訊息"), crisisDetected: true },
    message("recent", 4, "user", "最近而且合格"),
    message("query", 5, "user", "目前問題")
  ];
  const parts = buildShadowQueryParts(history, "query");
  assert.deepEqual(parts.recentContext, ["較早但合格", "最近而且合格"]);
  assert.equal(parts.searchBeforeSequence, 1);
  assert.doesNotMatch(parts.text, /圖片訊息|危機訊息/);
});

test("review query display follows production truncation and shows missing context slots", () => {
  const short: Message[] = [message("query", 1, "user", "甲".repeat(RETRIEVAL_SHADOW.maxCurrentCharacters + 2))];
  const parts = buildShadowQueryParts(short, "query");
  assert.equal(parts.currentQuery.length, RETRIEVAL_SHADOW.maxCurrentCharacters);
  assert.equal(parts.searchBeforeSequence, 1);
  const header = formatReviewHeader("run-2", parts);
  assert.match(header, /Recent context 1: \[none\]/);
  assert.match(header, /Recent context 2: \[none\]/);
});

test("shadow search cutoff uses one recent context or the current query when context is absent", () => {
  const oneContext = [message("context", 3, "user", "上一則"), message("query", 5, "user", "目前")];
  assert.equal(buildShadowQueryParts(oneContext, "query").searchBeforeSequence, 3);
  assert.equal(buildShadowQueryParts([message("query", 5, "user", "目前")], "query").searchBeforeSequence, 5);
});

test("review pagination skips completed runs and continues until the requested number is reviewed", async () => {
  const runs = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, complete: index < 15 }));
  const pages: Array<[number, number]> = [];
  const visited: number[] = [];
  const reviewed = await scanReviewRuns({
    limit: 5,
    pageSize: 7,
    async loadPage(from, to) { pages.push([from, to]); return runs.slice(from, to + 1); },
    async reviewRun(run) { visited.push(run.id); return !run.complete; }
  });
  assert.equal(reviewed, 5);
  assert.deepEqual(pages, [[0, 6], [7, 13], [14, 20]]);
  assert.deepEqual(visited.slice(-6), [15, 16, 17, 18, 19, 20]);
});

test("review pagination handles exhaustion and resumes only unlabeled candidates", async () => {
  const reviewed = await scanReviewRuns({
    limit: 5,
    pageSize: 2,
    async loadPage(from, to) { return [1, 2, 3].slice(from, to + 1); },
    async reviewRun(run) { return run === 3; }
  });
  assert.equal(reviewed, 1);
  assert.deepEqual(candidatesToReview([
    { id: 1, review_label: "must" },
    { id: 2, review_label: null },
    { id: 3, review_label: null }
  ]), [
    { id: 2, review_label: null },
    { id: 3, review_label: null }
  ]);
  assert.deepEqual(candidatesToReview([{ id: 1, review_label: "irrelevant" }]), []);
});

test("keyset review keeps scanning after short pages and resumes partial runs", async () => {
  const rows = Array.from({ length: 18 }, (_, index) => ({
    id: `run-${String(index).padStart(2, "0")}`,
    created_at: `2026-09-09T00:00:${String(Math.floor(index / 2)).padStart(2, "0")}.000Z`,
    complete: index < 12
  }));
  const visited: string[] = [];
  const reviewed = await scanKeysetReviewRuns({
    limit: 5,
    pageSize: 10,
    upper: { primary: rows.at(-1)!.created_at, id: rows.at(-1)!.id },
    async loadPage(cursor) {
      return rows.filter((row) => !cursor || row.created_at > cursor.primary
        || (row.created_at === cursor.primary && row.id > cursor.id)).slice(0, 3);
    },
    async reviewRun(run) { visited.push(run.id); return !run.complete; }
  });
  assert.equal(reviewed, 5);
  assert.deepEqual(visited.slice(-5), ["run-12", "run-13", "run-14", "run-15", "run-16"]);
});

test("worker embeds query, dialogue, and user-only evidence, searches before saving current chunk, and stores no text", async () => {
  const order: string[] = [];
  const completed: any[] = [];
  const store: RetrievalShadowStore = {
    async claimJobs() { return [{ id: "job", userId: "user", conversationId: "conversation", queryMessageId: "u3", attempts: 1, createdAt: "2026-08-13T00:00:00.000Z" }]; },
    async getMessages() { return messages; },
    async match(_job, beforeSequence, embedding) { order.push("match"); assert.equal(beforeSequence, 1); assert.deepEqual(embedding, [1, 0]); return [{ chunkId: "chunk-old", score: 0.7 }]; },
    async upsertChunk(_job, start, end, dialogueEmbedding, evidenceEmbedding) {
      order.push("upsert");
      assert.deepEqual([start, end], [3, 5]);
      assert.deepEqual(dialogueEmbedding, [0, 1]);
      assert.deepEqual(evidenceEmbedding, [1, 1]);
    },
    async complete(_job, _token, queueDelay, latency, candidates) { order.push("complete"); completed.push({ queueDelay, latency, candidates }); },
    async retry() { throw new Error("unexpected retry"); },
    async cleanup() { order.push("cleanup"); }
  };
  let embeddedTexts: string[] = [];
  let clock = Date.parse("2026-08-13T00:00:01.000Z");
  const result = await processRetrievalShadowJobs({
    store,
    provider: { async embed(texts) { embeddedTexts = texts; return [[1, 0], [0, 1], [1, 1]]; } },
    now: () => { const value = clock; clock += 7; return value; }
  });
  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0 });
  assert.deepEqual(embeddedTexts, [
    "最近訊息：主管昨天又改了企劃\n最近訊息：我今天看到信又緊張了\n目前訊息：果然又來了",
    "使用者：我今天看到信又緊張了\n安放：你像是先預期又會被推翻\n使用者：果然又來了",
    "我今天看到信又緊張了\n果然又來了"
  ]);
  assert.deepEqual(order, ["match", "upsert", "complete", "cleanup"]);
  assert.equal(JSON.stringify(completed).includes("果然又來了"), false);
});

test("worker handles a query after 3,000 messages from at most five RPC context rows", async () => {
  const contextRows = [
    message("old-context", 2997, "user", "三千則前的最近脈絡"),
    message("window-user", 3000, "user", "視窗中的使用者事實"),
    message("window-assistant", 3001, "assistant", "視窗中的回覆"),
    message("tail-query", 3002, "user", "現在又想起來了")
  ];
  let returnedRows = 0;
  let queryText = "";
  const store: RetrievalShadowStore = {
    async claimJobs() { return [{ id: "job", userId: "user", conversationId: "conversation", queryMessageId: "tail-query", attempts: 1, createdAt: new Date().toISOString() }]; },
    async getMessages() { returnedRows = contextRows.length; return contextRows; },
    async match(_job, before) { assert.equal(before, 2997); return []; },
    async complete() {}, async retry() { throw new Error("unexpected retry"); }, async upsertChunk() {}, async cleanup() {}
  };
  const result = await processRetrievalShadowJobs({
    store,
    provider: { async embed(texts) { queryText = texts[0]!; return texts.map(() => [1, 0]); } }
  });
  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0 });
  assert.ok(returnedRows <= 5);
  assert.match(queryText, /三千則前的最近脈絡|視窗中的使用者事實|現在又想起來了/);
});

test("worker still stores a dialogue chunk but clears evidence when a window has no injectable user fact", async () => {
  const noEvidence: Message[] = [
    message("probe", 1, "user", "你還記得那隻貓叫什麼嗎？"),
    message("answer", 2, "assistant", "牠叫咪咪"),
    message("thanks", 3, "user", "謝謝")
  ];
  let embeddedTexts: string[] = [];
  let storedEvidence: number[] | null | undefined;
  const store: RetrievalShadowStore = {
    async claimJobs() { return [{ id: "job", userId: "user", conversationId: "conversation", queryMessageId: "thanks", attempts: 1, createdAt: new Date().toISOString() }]; },
    async getMessages() { return noEvidence; },
    async match() { return []; },
    async complete() {},
    async retry() { throw new Error("unexpected retry"); },
    async upsertChunk(_job, _start, _end, _dialogue, evidence) { storedEvidence = evidence; },
    async cleanup() {}
  };
  const result = await processRetrievalShadowJobs({
    store,
    provider: {
      async embed(texts) {
        embeddedTexts = texts;
        return texts.map((_, index) => index === 0 ? [1, 0] : [0, 1]);
      }
    }
  });
  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0 });
  assert.equal(embeddedTexts.length, 2);
  assert.match(embeddedTexts[1]!, /安放：牠叫咪咪/);
  assert.equal(storedEvidence, null);
});

test("worker converts unknown provider errors to a fixed code", async () => {
  let code = "";
  const store: RetrievalShadowStore = {
    async claimJobs() { return [{ id: "job", userId: "user", conversationId: "conversation", queryMessageId: "u3", attempts: 1, createdAt: new Date().toISOString() }]; },
    async getMessages() { return messages; }, async match() { return []; }, async complete() {}, async upsertChunk() {}, async cleanup() {},
    async retry(_id, _token, errorCode) { code = errorCode; }
  };
  await processRetrievalShadowJobs({ store, provider: { async embed() { throw new Error("secret provider payload"); } } });
  assert.equal(code, "shadow_failed");
  assert.equal(shadowErrorCode(new Error("shadow_search_failed")), "shadow_search_failed");
});

test("shadow report recomputes useful and forbidden quality without content", () => {
  const grouped = new Map<string, any[]>([["run", [
    { run_id: "run", rank: 1, score: 0.8, review_label: "must" },
    { run_id: "run", rank: 2, score: 0.7, review_label: "forbidden" },
    { run_id: "run", rank: 3, score: 0.4, review_label: "irrelevant" }
  ]]]);
  assert.deepEqual(qualityAtThreshold(["run"], grouped, 0.6), {
    threshold: 0.6, selectedPrecision: 0.5, queryUsefulHitRate: 1, forbiddenRate: 0.5, selected: 2
  });
});

test("migration enforces pgvector, ownership filtering, leases, retries, RLS, and cascade deletion", async () => {
  const sql = await fs.readFile(new URL("../../../supabase/migrations/011_retrieval_shadow.sql", import.meta.url), "utf8");
  assert.match(sql, /extensions\.vector\(512\)/);
  assert.match(sql, /using hnsw/);
  assert.match(sql, /c\.user_id = p_user_id/);
  assert.match(sql, /c\.end_sequence < p_query_sequence/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /attempts >= 3/);
  assert.match(sql, /enable row level security/g);
  assert.match(sql, /references public\.messages\(id\) on delete cascade/);
});

function message(id: string, sequence: number, role: "user" | "assistant", content: string): Message {
  return { id, sequence, role, content, conversationId: "conversation", modelUsed: null, mode: null, imagePresent: false, crisisDetected: false, createdAt: new Date(sequence * 1000).toISOString() };
}
