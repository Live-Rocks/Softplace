import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { Message } from "@softplace/shared";
import {
  RETRIEVAL_GENERATION,
  buildGenerationQuery,
  classifyGenerationMessage,
  countTokens,
  generationSearchBeforeSequence,
  prepareGenerationContext,
  rerankGenerationCandidates,
  retrievalGenerationErrorCode,
  type GenerationCandidate
} from "../src/domain/retrievalGeneration.js";
import { isValidGenerationSourceWindow, withDeadline } from "../src/integrations/retrievalGeneration.js";
import { buildGenerationReport } from "../src/scripts/retrievalGenerationReport.js";
import { formatGenerationCandidate, formatGenerationReviewHeader, yesNo } from "../src/scripts/retrievalGenerationReview.js";

const history: Message[] = [
  message("u1", 11, "user", "主管昨天又把企劃改掉"),
  message("a1", 12, "assistant", "那種反覆真的很累"),
  message("u2", 13, "user", "我現在看到信就緊張"),
  message("a2", 14, "assistant", "先陪你停一下")
];

test("generation query uses two recent eligible user messages and history cutoff uses the oldest sent message", () => {
  const query = buildGenerationQuery(history, "果然又來了");
  assert.deepEqual(query.recentContext, ["主管昨天又把企劃改掉", "我現在看到信就緊張"]);
  assert.equal(query.text, "最近訊息：主管昨天又把企劃改掉\n最近訊息：我現在看到信就緊張\n目前訊息：果然又來了");
  assert.equal(generationSearchBeforeSequence(history), 11);
  assert.equal(generationSearchBeforeSequence([]), null);
});

test("generation constants use adaptive user-only evidence search with a 2.5 second deadline", () => {
  assert.equal(RETRIEVAL_GENERATION.candidateLimit, 20);
  assert.equal(RETRIEVAL_GENERATION.injectionLimit, 5);
  assert.equal(RETRIEVAL_GENERATION.selectionStrategy, "user_evidence_adaptive");
  assert.equal(RETRIEVAL_GENERATION.minimumScore, 0.4);
  assert.equal(RETRIEVAL_GENERATION.relativeScoreRatio, 0.9);
  assert.equal(RETRIEVAL_GENERATION.timeoutMs, 2500);
});

test("local evidence rerank removes repeated cat-name probes and selects the lower-ranked fact", () => {
  const candidates = [
    candidate("probe-1", 1, 0.70, [message("p1", 1, "user", "你還記得那隻貓咪的名字嗎？")]),
    candidate("probe-2", 2, 0.68, [message("p2", 2, "user", "我幫那隻貓取什麼名字？")]),
    candidate("probe-3", 3, 0.66, [message("p3", 3, "user", "你對牠有印象嗎？")]),
    candidate("probe-4", 4, 0.64, [message("p4", 4, "user", "測試訊息")]),
    candidate("probe-5", 5, 0.62, [message("p5", 5, "user", "我來了"), message("p6", 6, "user", "牠叫什麼？")]),
    candidate("fact", 9, 0.55, [message("fact-user", 9, "user", "我幫他取名叫 飽飽")])
  ];
  const reranked = rerankGenerationCandidates(candidates);
  assert.deepEqual(reranked.slice(0, 5).map((item) => item.selectionDecision), [
    "recall_probe_only", "recall_probe_only", "recall_probe_only", "boilerplate_only", "recall_probe_only"
  ]);
  const fact = reranked.find((item) => item.chunkId === "fact");
  assert.equal(fact?.selectionDecision, "selected");
  assert.equal(fact?.selectionRank, 1);
  const prepared = prepareGenerationContext(reranked.filter((item) => item.selectionDecision === "selected"));
  assert.match(prepared?.text ?? "", /飽飽/);
  assert.doesNotMatch(prepared?.text ?? "", /記得|測試訊息|我來了/);
});

test("local evidence rerank can recover a trip fact at rank twenty and keeps mixed factual questions", () => {
  const candidates = Array.from({ length: 20 }, (_, index) => candidate(
    `c-${index + 1}`,
    index + 1,
    0.8 - index * 0.01,
    [message(`u-${index + 1}`, index + 1, "user", index === 19
      ? "我前陣子第一次出國，去了中國武漢"
      : `你還記得第${index + 1}件事嗎？`)]
  ));
  const selected = rerankGenerationCandidates(candidates).filter((item) => item.selectionDecision === "selected");
  assert.deepEqual(selected.map((item) => item.chunkId), ["c-20"]);
  assert.equal(classifyGenerationMessage("我明天要去台北，你覺得呢？"), "evidence");
  assert.equal(classifyGenerationMessage("我第一次出國去了哪裡？"), "recall_probe");
  assert.equal(classifyGenerationMessage("我記得第一次出國去了中國武漢"), "evidence");
  assert.equal(classifyGenerationMessage("我對那裡很有印象"), "evidence");
});

test("local evidence rerank removes exact user duplicates and never fills with filtered candidates", () => {
  const shared = message("shared", 1, "user", "我喜歡橘色");
  const reranked = rerankGenerationCandidates([
    candidate("first", 1, 0.8, [shared]),
    candidate("duplicate-id", 2, 0.7, [shared]),
    candidate("duplicate-text", 3, 0.6, [message("other", 3, "user", "我喜歡橘色！")]),
    candidate("invalid", 4, 0.5, []),
    candidate("probe", 5, 0.4, [message("probe", 5, "user", "你記得嗎？")])
  ]);
  assert.deepEqual(reranked.map((item) => item.selectionDecision), [
    "selected", "duplicate", "duplicate", "invalid_source", "recall_probe_only"
  ]);
  assert.equal(reranked.filter((item) => item.selectionDecision === "selected").length, 1);
});

test("low-information filtering covers observed test and acknowledgement variants", () => {
  assert.equal(classifyGenerationMessage("就測試😂"), "boilerplate");
  assert.equal(classifyGenerationMessage("嘻嘻好棒"), "boilerplate");
  assert.equal(classifyGenerationMessage("太好了，你記起來了"), "boilerplate");
  assert.equal(classifyGenerationMessage("回來了"), "boilerplate");
  assert.equal(classifyGenerationMessage("嗯 是呀\n沒關係了"), "boilerplate");
  assert.equal(classifyGenerationMessage("太好了，我幫牠取名叫飽飽"), "evidence");
});

test("adaptive evidence selection reproduces the latest three live smoke rankings at the 0.40 floor", () => {
  const cat = rerankGenerationCandidates([
    candidate("cat", 1, 0.5588, [message("cat-name", 1, "user", "我幫一隻貓取名叫飽飽"), message("cat-kind", 3, "user", "是虎斑流浪貓")]),
    candidate("cat-overlap", 2, 0.3989, [message("cat-kind", 3, "user", "是虎斑流浪貓"), message("trip", 5, "user", "我第一次出國去了中國武漢")]),
    candidate("weak", 3, 0.3748, [message("reason", 11, "user", "我其實也忘記原因了"), message("ack", 13, "user", "嗯 是呀\n沒關係了")])
  ]);
  assert.deepEqual(cat.map((item) => item.selectionDecision), ["selected", "duplicate", "below_relevance"]);
  assert.match(prepareGenerationContext(cat.filter((item) => item.selectionDecision === "selected"))?.text ?? "", /飽飽|虎斑/);

  const trip = rerankGenerationCandidates([
    candidate("trip", 1, 0.4781, [message("cat-kind", 3, "user", "是虎斑流浪貓"), message("trip", 5, "user", "我第一次出國去了中國武漢")]),
    candidate("trip-overlap", 2, 0.4652, [message("trip", 5, "user", "我第一次出國去了中國武漢"), message("returned", 7, "user", "回來了")]),
    candidate("weak", 3, 0.4003, [message("cry", 9, "user", "我在旅遊巴士上，看著下雨的窗外哭過"), message("reason", 11, "user", "我其實也忘記原因了")])
  ]);
  assert.deepEqual(trip.map((item) => item.selectionDecision), ["selected", "duplicate", "below_relevance"]);
  const tripContext = prepareGenerationContext(trip.filter((item) => item.selectionDecision === "selected"))?.text ?? "";
  assert.match(tripContext, /中國武漢/);
  assert.match(tripContext, /虎斑/);
  assert.doesNotMatch(tripContext, /回來了|哭過|忘記原因/);

  const crying = rerankGenerationCandidates([
    candidate("cry", 1, 0.43, [message("cry", 9, "user", "我在旅遊巴士上，看著下雨的窗外哭過"), message("reason", 11, "user", "我其實也忘記原因了")]),
    candidate("reason-overlap", 2, 0.4097, [message("reason", 11, "user", "我其實也忘記原因了"), message("ack", 13, "user", "嗯 是呀\n沒關係了")]),
    candidate("cry-overlap", 3, 0.3853, [message("returned", 7, "user", "回來了"), message("cry", 9, "user", "我在旅遊巴士上，看著下雨的窗外哭過")]),
    candidate("unrelated", 4, 0.3271, [message("cat-name", 1, "user", "我幫一隻貓取名叫飽飽"), message("cat-kind", 3, "user", "是虎斑流浪貓")])
  ]);
  assert.deepEqual(crying.map((item) => item.selectionDecision), ["selected", "duplicate", "duplicate", "below_relevance"]);
  const cryContext = prepareGenerationContext(crying.filter((item) => item.selectionDecision === "selected"))?.text ?? "";
  assert.match(cryContext, /旅遊巴士|下雨的窗外|忘記原因/);
  assert.doesNotMatch(cryContext, /回來了|飽飽|虎斑/);
});

test("adaptive evidence 0.40 floor keeps boundary evidence and abstains on weak or ambiguous candidates", () => {
  const boundary = rerankGenerationCandidates([
    candidate("boundary", 1, 0.4, [message("fact", 1, "user", "我把票放在藍色盒子裡")])
  ]);
  assert.equal(boundary[0]?.selectionDecision, "selected");

  const weak = rerankGenerationCandidates([
    candidate("weak-fact", 1, 0.3999, [message("weak-fact", 1, "user", "今天晚餐想吃麵")]),
    candidate("ambiguous", 2, 0.39, [message("ambiguous", 3, "user", "又來了")]),
    candidate("probe", 3, 0.8, [message("probe", 5, "user", "你記得我養的狗叫什麼嗎？")]),
    candidate("assistant-only", 4, 0.9, [message("assistant", 7, "assistant", "舊助理猜測")])
  ]);
  assert.deepEqual(weak.map((item) => item.selectionDecision), [
    "below_relevance", "below_relevance", "recall_probe_only", "invalid_source"
  ]);
  assert.equal(weak.some((item) => item.selectionDecision === "selected"), false);

  const relative = rerankGenerationCandidates([
    candidate("best", 1, 0.8, [message("best", 1, "user", "我最喜歡深綠色")]),
    candidate("too-far", 2, 0.7199, [message("too-far", 3, "user", "我常穿灰色外套")])
  ]);
  assert.deepEqual(relative.map((item) => item.selectionDecision), ["selected", "below_relevance"]);
});

test("local evidence rerank selects at most five and marks later qualified candidates", () => {
  const reranked = rerankGenerationCandidates(Array.from({ length: 7 }, (_, index) => candidate(
    `fact-${index + 1}`, index + 1, 0.8 - index * 0.01,
    [message(`fact-user-${index + 1}`, index + 1, "user", `我喜歡第${index + 1}種顏色`)]
  )));
  assert.deepEqual(reranked.slice(0, 5).map((item) => item.selectionRank), [1, 2, 3, 4, 5]);
  assert.deepEqual(reranked.slice(5).map((item) => item.selectionDecision), ["not_selected", "not_selected"]);
});

test("generation source windows reject images, crisis content, and invalid role order", () => {
  const safe = [
    { role: "user" }, { role: "assistant" }, { role: "user" }
  ];
  assert.equal(isValidGenerationSourceWindow(safe), true);
  assert.equal(isValidGenerationSourceWindow(safe.map((row, index) => ({ ...row, image_present: index === 0 }))), false);
  assert.equal(isValidGenerationSourceWindow(safe.map((row, index) => ({ ...row, crisis_detected: index === 2 }))), false);
  assert.equal(isValidGenerationSourceWindow([{ role: "user" }, { role: "user" }, { role: "assistant" }]), false);
});

test("generation context injects all five candidates regardless of score and never includes assistant text", () => {
  const candidates = [
    candidate("c1", 1, 0.72, [message("old-u1", 1, "user", "第一次被改企劃"), message("old-a1", 2, "assistant", "舊助理推論"), message("old-u2", 3, "user", "那次也很慌")]),
    candidate("c2", 2, 0.66, [message("old-u2", 3, "user", "那次也很慌"), message("old-a2", 4, "assistant", "另一段舊回答"), message("old-u3", 5, "user", "後來同事來幫忙")]),
    candidate("c3", 3, 0.44, [message("u3", 7, "user", "第三段低分候選")]),
    candidate("c4", 4, 0.31, [message("u4", 9, "user", "我幫他取名叫 飽飽")]),
    candidate("c5", 5, 0.20, [message("u5", 11, "user", "第五段也會送出"), message("copy", 12, "user", "那次也很慌！")]),
    candidate("c6", 6, 0.99, [message("u6", 13, "user", "超過 Top 5")])
  ];
  const prepared = prepareGenerationContext(candidates);
  assert.ok(prepared);
  assert.deepEqual(prepared.injectedChunkIds, ["c1", "c2", "c3", "c4", "c5"]);
  assert.match(prepared.text, /第一次被改企劃|那次也很慌|後來同事來幫忙|第三段低分候選|飽飽|第五段也會送出/);
  assert.doesNotMatch(prepared.text, /舊助理推論|另一段舊回答|超過 Top 5/);
  assert.equal((prepared.text.match(/那次也很慌/g) ?? []).length, 1);
});

test("generation context fairly shares the 1200-token budget without dropping later candidates", () => {
  assert.equal(prepareGenerationContext([]), null);
  const prepared = prepareGenerationContext(Array.from({ length: 5 }, (_, index) => candidate(
    `large-${index + 1}`,
    index + 1,
    0.59 - index * 0.05,
    [message(
      `large-u-${index + 1}`,
      index + 1,
      "user",
      `第${index + 1}段。${index === 4 ? "我幫他取名叫 飽飽。" : ""}${"繁體中文內容🙂".repeat(1000)}`
    )]
  )));
  assert.ok(prepared);
  assert.ok(prepared.tokenCount <= RETRIEVAL_GENERATION.tokenBudget);
  assert.equal(prepared.tokenCount, countTokens(prepared.text));
  assert.deepEqual(prepared.injectedChunkIds, ["large-1", "large-2", "large-3", "large-4", "large-5"]);
  assert.equal((JSON.parse(prepared.text).candidates as Array<{ user_messages: string[] }>).every((item) => item.user_messages[0]?.length), true);
  assert.match(prepared.text, /飽飽/);
  assert.doesNotMatch(prepared.text, /�/);
});

test("generation review formatting identifies injected candidates and validates yes/no answers", () => {
  const header = formatGenerationReviewHeader("run", history, "現在呢", "{context}", "生成回覆");
  assert.match(header, /Recent history \(10 max\)/);
  assert.match(header, /Current query: 現在呢/);
  assert.match(header, /Injected user-only context: \{context\}/);
  assert.match(header, /Generated response: 生成回覆/);
  assert.equal(
    formatGenerationCandidate({ rank: 2, score: 0.65432, injected: true }),
    "#2 score=0.6543 injected=yes selection_rank=- decision=selected"
  );
  assert.equal(yesNo("y"), true);
  assert.equal(yesNo("N"), false);
  assert.throws(() => yesNo("maybe"), /invalid yes\/no/);
});

test("generation report requires 25 reviewed injected runs, half helpful, and zero harm", () => {
  const runs = Array.from({ length: 25 }, (_, index) => ({
    id: `run-${index}`,
    status: "injected" as const,
    selection_strategy: "top5_all" as const,
    injected_count: 5,
    embedding_latency_ms: 100,
    search_latency_ms: 50,
    total_retrieval_latency_ms: 150,
    history_10_tokens: 600,
    history_20_tokens: 1200,
    retrieval_tokens: 200,
    actual_input_tokens: 1800,
    output_tokens: 100,
    response_effect: index < 13 ? "helpful" as const : "neutral" as const,
    stale_detected: false,
    sensitive_detected: false,
    error_code: null
  }));
  const candidates = runs.map((run) => ({ run_id: run.id, injected: true, review_label: "must" }));
  const report = buildGenerationReport(runs, candidates);
  assert.equal(report.phase21Pass, true);
  assert.equal(report.review.helpful, 13);
  assert.equal(report.review.averageInjectedChunks, 5);
  assert.equal(report.tokens.estimatedSavingsMedian, 1 - 800 / 1200);
  const harmful = runs.map((run, index) => index === 0 ? { ...run, response_effect: "harmful" as const } : run);
  assert.equal(buildGenerationReport(harmful, candidates).phase21Pass, false);
  const historical = [{ ...runs[0]!, id: "historical", selection_strategy: "threshold_top2" as const, injected_count: 1 }];
  assert.equal(buildGenerationReport([...runs, ...historical], candidates).strategies.thresholdTop2.injected, 1);
  assert.equal(buildGenerationReport([...runs, ...historical], candidates).review.reviewedInjectedRuns, 25);
});

test("phase 2.2 report isolates local rerank, reviews only injected candidates, and gates timeout rate", () => {
  const injectedRuns = Array.from({ length: 10 }, (_, index) => ({
    id: `local-${index}`,
    status: "injected" as const,
    selection_strategy: "top20_local_rerank" as const,
    injected_count: 2,
    embedding_latency_ms: 500,
    search_latency_ms: 300,
    total_retrieval_latency_ms: 800,
    history_10_tokens: 500,
    history_20_tokens: 1200,
    retrieval_tokens: 180,
    actual_input_tokens: 1400,
    output_tokens: 100,
    response_effect: index < 5 ? "helpful" as const : "neutral" as const,
    stale_detected: false,
    sensitive_detected: false,
    error_code: null
  }));
  const timeout = {
    ...injectedRuns[0]!, id: "timeout", status: "fallback" as const, injected_count: 0,
    response_effect: null, stale_detected: null, sensitive_detected: null,
    error_code: "generation_embedding_timeout"
  };
  const candidates = injectedRuns.flatMap((run) => [
    { run_id: run.id, injected: true, selection_decision: "selected", review_label: "must" },
    { run_id: run.id, injected: false, selection_decision: "recall_probe_only", review_label: null }
  ]);
  const report = buildGenerationReport([...injectedRuns, timeout], candidates);
  assert.equal(report.phase22.review.reviewedInjectedRuns, 10);
  assert.equal(report.phase22.timeoutRate, 1 / 11);
  assert.equal(report.phase22.selectionDecisions.recall_probe_only, 10);
  assert.equal(report.phase22.metricsPass, true);
  const secondTimeout = { ...timeout, id: "timeout-2" };
  assert.equal(buildGenerationReport([...injectedRuns, timeout, secondTimeout], candidates).phase22.metricsPass, false);
});

test("phase 2.3 report isolates user evidence search from the failed dialogue-ranked baseline", () => {
  const evidenceRuns = Array.from({ length: 10 }, (_, index) => ({
    id: `evidence-${index}`,
    status: "injected" as const,
    selection_strategy: "user_evidence_top20" as const,
    injected_count: 2,
    embedding_latency_ms: 300,
    search_latency_ms: 100,
    total_retrieval_latency_ms: 400,
    history_10_tokens: 500,
    history_20_tokens: 1200,
    retrieval_tokens: 120,
    actual_input_tokens: 1300,
    output_tokens: 100,
    response_effect: index < 5 ? "helpful" as const : "neutral" as const,
    stale_detected: false,
    sensitive_detected: false,
    error_code: null
  }));
  const historical = { ...evidenceRuns[0]!, id: "old", selection_strategy: "top20_local_rerank" as const };
  const candidates = evidenceRuns.map((run) => ({
    run_id: run.id, injected: true, selection_decision: "selected", review_label: "must"
  }));
  const report = buildGenerationReport([...evidenceRuns, historical], candidates);
  assert.equal(report.phase23.review.reviewedInjectedRuns, 10);
  assert.equal(report.phase23.metricsPass, true);
  assert.deepEqual(report.userEvidenceTop20Runs, { injected: 10, abstained: 0, fallback: 0 });
  assert.deepEqual(report.top20LocalRerankRuns, { injected: 1, abstained: 0, fallback: 0 });
});

test("phase 2.4 report isolates adaptive evidence selection and below-relevance decisions", () => {
  const adaptiveRuns = Array.from({ length: 10 }, (_, index) => ({
    id: `adaptive-${index}`,
    status: "injected" as const,
    selection_strategy: "user_evidence_adaptive" as const,
    injected_count: 1,
    embedding_latency_ms: 300,
    search_latency_ms: 100,
    total_retrieval_latency_ms: 400,
    history_10_tokens: 500,
    history_20_tokens: 1200,
    retrieval_tokens: 80,
    actual_input_tokens: 1260,
    output_tokens: 100,
    response_effect: index < 5 ? "helpful" as const : "neutral" as const,
    stale_detected: false,
    sensitive_detected: false,
    error_code: null
  }));
  const candidates = adaptiveRuns.flatMap((run) => [
    { run_id: run.id, injected: true, selection_decision: "selected", review_label: "must" },
    { run_id: run.id, injected: false, selection_decision: "below_relevance", review_label: null }
  ]);
  const report = buildGenerationReport(adaptiveRuns, candidates);
  assert.equal(report.phase24.review.reviewedInjectedRuns, 10);
  assert.equal(report.phase24.selectionDecisions.below_relevance, 10);
  assert.equal(report.phase24.metricsPass, true);
  assert.deepEqual(report.userEvidenceAdaptiveRuns, { injected: 10, abstained: 0, fallback: 0 });
});

test("generation errors are redacted to fixed codes", () => {
  assert.equal(retrievalGenerationErrorCode(new Error("generation_search_failed")), "generation_search_failed");
  assert.equal(retrievalGenerationErrorCode(new Error("generation_embedding_failed")), "generation_embedding_failed");
  assert.equal(retrievalGenerationErrorCode(new Error("generation_source_timeout")), "generation_source_timeout");
  assert.equal(retrievalGenerationErrorCode(new Error("private provider message")), "generation_retrieval_failed");
});

test("generation deadline returns the fixed stage error code", async () => {
  await assert.rejects(
    withDeadline(new Promise<never>(() => undefined), performance.now() + 5, "generation_search_timeout"),
    /generation_search_timeout/
  );
});

test("generation migration enforces service-role isolation, fixed canary constants, cleanup, and cascades", async () => {
  const sql = await fs.readFile(new URL("../../../supabase/migrations/012_retrieval_generation_canary.sql", import.meta.url), "utf8");
  assert.match(sql, /threshold double precision not null check \(threshold = 0\.60\)/);
  assert.match(sql, /history_limit integer not null check \(history_limit = 10\)/);
  assert.match(sql, /retrieval_token_budget integer not null check \(retrieval_token_budget = 1200\)/);
  assert.match(sql, /references public\.messages\(id\) on delete cascade/g);
  assert.match(sql, /enable row level security/g);
  assert.match(sql, /c\.user_id = p_user_id/);
  assert.match(sql, /cleanup_retrieval_generation/);
  assert.match(sql, /p_retention_days integer default 30/);
  assert.match(sql, /revoke all on table public\.retrieval_generation_runs/);
});

test("top five migration preserves the old strategy and records the new strategy separately", async () => {
  const sql = await fs.readFile(new URL("../../../supabase/migrations/013_retrieval_generation_top5.sql", import.meta.url), "utf8");
  assert.match(sql, /selection_strategy text not null default 'threshold_top2'/);
  assert.match(sql, /selection_strategy = 'top5_all'/);
  assert.match(sql, /threshold is null/);
  assert.match(sql, /injection_limit = 5/);
  assert.match(sql, /p_selection_strategy text default 'threshold_top2'/);
  assert.match(sql, /v_injected_count between 0 and 5|injected_count between 0 and 5/);
  assert.match(sql, /revoke all on function public\.record_retrieval_generation_run/);
  assert.match(sql, /to service_role/);
});

test("generation recording, review, and reporting isolate the current adaptive strategy", async () => {
  const [integration, review, report] = await Promise.all([
    fs.readFile(new URL("../src/integrations/retrievalGeneration.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/scripts/retrievalGenerationReview.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/scripts/retrievalGenerationReport.ts", import.meta.url), "utf8")
  ]);
  assert.match(integration, /rpc\("record_retrieval_generation_adaptive_run"/);
  assert.match(integration, /rpc\("match_retrieval_generation_evidence_chunks"/);
  assert.match(review, /\.eq\("selection_strategy", "user_evidence_adaptive"\)/);
  assert.match(report, /run\.selection_strategy === "top5_all"/);
  assert.match(report, /run\.selection_strategy === "threshold_top2"/);
  assert.match(report, /run\.selection_strategy === "top20_local_rerank"/);
  assert.match(report, /run\.selection_strategy === "user_evidence_top20"/);
  assert.match(report, /run\.selection_strategy === "user_evidence_adaptive"/);
});

test("adaptive evidence migration preserves old strategies and records relevance decisions separately", async () => {
  const sql = await fs.readFile(new URL("../../../supabase/migrations/016_retrieval_evidence_adaptive.sql", import.meta.url), "utf8");
  assert.match(sql, /selection_strategy in \('user_evidence_top20', 'user_evidence_adaptive'\)/);
  assert.match(sql, /search_strategy = 'user_only'/);
  assert.match(sql, /below_relevance/);
  assert.match(sql, /record_retrieval_generation_adaptive_run/);
  assert.match(sql, /c\.evidence_embedding is not null/);
  assert.match(sql, /candidate_count|v_candidate_count/);
  assert.match(sql, /to service_role/);
});

test("user evidence migration aligns generation search with injected user text and supports backfill", async () => {
  const [sql, backfill, shadowBackfill] = await Promise.all([
    fs.readFile(new URL("../../../supabase/migrations/015_retrieval_user_evidence.sql", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/scripts/retrievalEvidenceBackfill.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/scripts/retrievalShadowBackfill.ts", import.meta.url), "utf8")
  ]);
  assert.match(sql, /add column evidence_embedding extensions\.vector\(512\)/);
  assert.match(sql, /evidence_embedding extensions\.vector_cosine_ops/);
  assert.match(sql, /match_retrieval_generation_evidence_chunks/);
  assert.match(sql, /c\.evidence_embedding <=> p_query_embedding/);
  assert.match(sql, /c\.evidence_embedding is not null/);
  assert.match(sql, /c\.user_id = p_user_id/);
  assert.match(sql, /c\.conversation_id = p_conversation_id/);
  assert.match(sql, /c\.end_sequence < p_query_sequence/);
  assert.match(sql, /upsert_retrieval_chunk_with_evidence/);
  assert.match(sql, /set_retrieval_chunk_evidence_embedding/);
  assert.match(sql, /selection_strategy = 'user_evidence_top20'/);
  assert.match(sql, /search_strategy = 'user_only'/);
  assert.match(sql, /to service_role/g);
  assert.match(backfill, /\.is\("evidence_embedding", null\)/);
  assert.match(backfill, /--refresh/);
  assert.match(backfill, /p_evidence_embedding: embedding \? .* : null/);
  assert.match(backfill, /buildShadowUserEvidence/);
  assert.doesNotMatch(backfill, /console\.info\([^\n]*\.text/);
  assert.match(shadowBackfill, /upsert_retrieval_chunk_with_evidence/);
});

test("local rerank migration preserves old strategies and isolates the top twenty RPC", async () => {
  const sql = await fs.readFile(new URL("../../../supabase/migrations/014_retrieval_generation_local_rerank.sql", import.meta.url), "utf8");
  assert.match(sql, /match_retrieval_generation_chunks/);
  assert.match(sql, /limit least\(greatest\(p_limit, 1\), 20\)/);
  assert.match(sql, /c\.user_id = p_user_id/);
  assert.match(sql, /c\.conversation_id = p_conversation_id/);
  assert.match(sql, /c\.end_sequence < p_query_sequence/);
  assert.match(sql, /selection_strategy = 'threshold_top2'/);
  assert.match(sql, /selection_strategy = 'top5_all'/);
  assert.match(sql, /selection_strategy = 'top20_local_rerank'/);
  assert.match(sql, /candidate_limit = 20/);
  assert.match(sql, /rank between 1 and 20/);
  assert.match(sql, /selection_rank/);
  assert.match(sql, /recall_probe_only/);
  assert.match(sql, /to service_role/);
});

function candidate(chunkId: string, rank: number, score: number, source: Message[]): GenerationCandidate {
  return { chunkId, rank, score, startSequence: source[0]?.sequence ?? 0, endSequence: source.at(-1)?.sequence ?? 0, source };
}

function message(id: string, sequence: number, role: "user" | "assistant", content: string): Message {
  return { id, sequence, role, content, conversationId: "conversation", modelUsed: null, mode: null, imagePresent: false, crisisDetected: false, createdAt: new Date(sequence * 1000).toISOString() };
}
