import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supabaseAdmin } from "../integrations/supabase.js";

type Run = {
  id: string;
  status: "injected" | "abstained" | "fallback";
  selection_strategy: "threshold_top2" | "top5_all" | "top20_local_rerank" | "user_evidence_top20" | "user_evidence_adaptive";
  injected_count: number;
  embedding_latency_ms: number;
  search_latency_ms: number;
  total_retrieval_latency_ms: number;
  history_10_tokens: number;
  history_20_tokens: number;
  retrieval_tokens: number;
  actual_input_tokens: number | null;
  output_tokens: number | null;
  response_effect: "helpful" | "neutral" | "harmful" | null;
  stale_detected: boolean | null;
  sensitive_detected: boolean | null;
  error_code: string | null;
};

type Candidate = {
  run_id: string;
  injected: boolean;
  selection_decision?: string | null;
  review_label: string | null;
};

export async function main() {
  if (!supabaseAdmin) throw new Error("Supabase configuration is required");
  const [{ data: runRows, error: runError }, { data: candidateRows, error: candidateError }] = await Promise.all([
    supabaseAdmin.from("retrieval_generation_runs").select("id,status,selection_strategy,injected_count,embedding_latency_ms,search_latency_ms,total_retrieval_latency_ms,history_10_tokens,history_20_tokens,retrieval_tokens,actual_input_tokens,output_tokens,response_effect,stale_detected,sensitive_detected,error_code"),
    supabaseAdmin.from("retrieval_generation_candidates").select("run_id,injected,selection_decision,review_label")
  ]);
  if (runError || candidateError) throw new Error("generation_report_read_failed");
  const report = buildGenerationReport((runRows ?? []) as Run[], (candidateRows ?? []) as Candidate[]);
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const directory = path.join(repoRoot, "artifacts", "retrieval-generation", new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(path.join(directory, "report.md"), markdown(report))
  ]);
  console.info("[retrieval-generation:report]", {
    directory,
    injectedRuns: report.userEvidenceAdaptiveRuns.injected,
    reviewedInjectedRuns: report.phase24.review.reviewedInjectedRuns,
    phase24MetricsPass: report.phase24.metricsPass
  });
  return { directory, report };
}

export function buildGenerationReport(runs: Run[], candidates: Candidate[]) {
  const byRun = new Map<string, Candidate[]>();
  for (const candidate of candidates) byRun.set(candidate.run_id, [...(byRun.get(candidate.run_id) ?? []), candidate]);
  const top5Runs = runs.filter((run) => run.selection_strategy === "top5_all");
  const top20Runs = runs.filter((run) => run.selection_strategy === "top20_local_rerank");
  const evidenceRuns = runs.filter((run) => run.selection_strategy === "user_evidence_top20");
  const adaptiveRuns = runs.filter((run) => run.selection_strategy === "user_evidence_adaptive");
  const phase21Review = buildReview(top5Runs, byRun, 25, false);
  const phase22Review = buildReview(top20Runs, byRun, 10, true);
  const phase21Pass = passesQualityGate(phase21Review);
  const timeoutCount = top20Runs.filter((run) => run.error_code?.endsWith("_timeout")).length;
  const timeoutRate = ratio(timeoutCount, top20Runs.length);
  const phase22MetricsPass = passesQualityGate(phase22Review) && timeoutRate <= 0.1;
  const phase23Review = buildReview(evidenceRuns, byRun, 10, true);
  const evidenceTimeoutCount = evidenceRuns.filter((run) => run.error_code?.endsWith("_timeout")).length;
  const evidenceTimeoutRate = ratio(evidenceTimeoutCount, evidenceRuns.length);
  const phase23MetricsPass = passesQualityGate(phase23Review) && evidenceTimeoutRate <= 0.1;
  const phase24Review = buildReview(adaptiveRuns, byRun, 10, true);
  const adaptiveTimeoutCount = adaptiveRuns.filter((run) => run.error_code?.endsWith("_timeout")).length;
  const adaptiveTimeoutRate = ratio(adaptiveTimeoutCount, adaptiveRuns.length);
  const phase24MetricsPass = passesQualityGate(phase24Review) && adaptiveTimeoutRate <= 0.1;
  const top20RunIds = new Set(top20Runs.map((run) => run.id));
  const evidenceRunIds = new Set(evidenceRuns.map((run) => run.id));
  const decisionCounts = selectionDecisionCounts(candidates, top20RunIds);
  const evidenceDecisionCounts = selectionDecisionCounts(candidates, evidenceRunIds);
  const adaptiveRunIds = new Set(adaptiveRuns.map((run) => run.id));
  const adaptiveDecisionCounts = selectionDecisionCounts(candidates, adaptiveRunIds);
  return {
    generatedAt: new Date().toISOString(),
    privacy: "No chat content is included.",
    strategies: {
      thresholdTop2: summarizeStatuses(runs.filter((run) => run.selection_strategy === "threshold_top2")),
      top5All: summarizeStatuses(top5Runs),
      top20LocalRerank: summarizeStatuses(top20Runs),
      userEvidenceTop20: summarizeStatuses(evidenceRuns),
      userEvidenceAdaptive: summarizeStatuses(adaptiveRuns)
    },
    top5AllRuns: summarizeStatuses(top5Runs),
    top20LocalRerankRuns: summarizeStatuses(top20Runs),
    userEvidenceTop20Runs: summarizeStatuses(evidenceRuns),
    userEvidenceAdaptiveRuns: summarizeStatuses(adaptiveRuns),
    errors: errorsFor(top5Runs),
    review: phase21Review,
    latencyMs: latencyFor(top5Runs),
    tokens: tokensFor(top5Runs),
    completionCriteria: completionCriteria(phase21Review),
    phase21Pass,
    phase22: {
      errors: errorsFor(top20Runs),
      timeoutCount,
      timeoutRate,
      selectionDecisions: decisionCounts,
      review: phase22Review,
      latencyMs: latencyFor(top20Runs),
      tokens: tokensFor(top20Runs),
      completionCriteria: {
        ...completionCriteria(phase22Review),
        timeoutAtMost10Percent: top20Runs.length > 0 && timeoutRate <= 0.1,
        fixedSmokeCases: "manual"
      },
      metricsPass: phase22MetricsPass
    },
    phase23: {
      errors: errorsFor(evidenceRuns),
      timeoutCount: evidenceTimeoutCount,
      timeoutRate: evidenceTimeoutRate,
      selectionDecisions: evidenceDecisionCounts,
      review: phase23Review,
      latencyMs: latencyFor(evidenceRuns),
      tokens: tokensFor(evidenceRuns),
      completionCriteria: {
        ...completionCriteria(phase23Review),
        timeoutAtMost10Percent: evidenceRuns.length > 0 && evidenceTimeoutRate <= 0.1,
        fixedSmokeCases: "manual"
      },
      metricsPass: phase23MetricsPass
    },
    phase24: {
      errors: errorsFor(adaptiveRuns),
      timeoutCount: adaptiveTimeoutCount,
      timeoutRate: adaptiveTimeoutRate,
      selectionDecisions: adaptiveDecisionCounts,
      review: phase24Review,
      latencyMs: latencyFor(adaptiveRuns),
      tokens: tokensFor(adaptiveRuns),
      completionCriteria: {
        ...completionCriteria(phase24Review),
        timeoutAtMost10Percent: adaptiveRuns.length > 0 && adaptiveTimeoutRate <= 0.1,
        fixedSmokeCases: "manual"
      },
      metricsPass: phase24MetricsPass
    }
  };
}

function buildReview(
  runs: Run[],
  byRun: Map<string, Candidate[]>,
  targetInjectedRuns: number,
  injectedLabelsOnly: boolean
) {
  const injectedRuns = runs.filter((run) => run.status === "injected");
  const reviewed = injectedRuns.filter((run) =>
    run.response_effect && (byRun.get(run.id)?.length ?? 0) > 0 && byRun.get(run.id)!.every((candidate) => candidate.review_label)
  );
  const correctlyReviewed = injectedLabelsOnly
    ? injectedRuns.filter((run) => {
      const injected = (byRun.get(run.id) ?? []).filter((candidate) => candidate.injected);
      return run.response_effect && injected.length > 0 && injected.every((candidate) => candidate.review_label);
    })
    : reviewed;
  const injectedReviewedCandidates = correctlyReviewed.flatMap((run) => (byRun.get(run.id) ?? []).filter((candidate) => candidate.injected));
  const usefulInjected = injectedReviewedCandidates.filter((candidate) => candidate.review_label === "must" || candidate.review_label === "acceptable").length;
  const forbiddenInjected = injectedReviewedCandidates.filter((candidate) => candidate.review_label === "forbidden").length;
  const irrelevantInjected = injectedReviewedCandidates.filter((candidate) => candidate.review_label === "irrelevant").length;
  const helpful = correctlyReviewed.filter((run) => run.response_effect === "helpful").length;
  const neutral = correctlyReviewed.filter((run) => run.response_effect === "neutral").length;
  const harmful = correctlyReviewed.filter((run) => run.response_effect === "harmful").length;
  const stale = correctlyReviewed.filter((run) => run.stale_detected).length;
  const sensitive = correctlyReviewed.filter((run) => run.sensitive_detected).length;
  return {
      targetInjectedRuns,
      reviewedInjectedRuns: correctlyReviewed.length,
      helpful,
      neutral,
      harmful,
      stale,
      sensitive,
      helpfulRate: ratio(helpful, correctlyReviewed.length),
      injectedCandidatePrecision: ratio(usefulInjected, injectedReviewedCandidates.length),
      injectedForbidden: forbiddenInjected,
      injectedIrrelevant: irrelevantInjected,
      injectedIrrelevantRate: ratio(irrelevantInjected, injectedReviewedCandidates.length),
      averageInjectedChunks: ratio(injectedRuns.reduce((sum, run) => sum + Number(run.injected_count), 0), injectedRuns.length)
  };
}

function passesQualityGate(review: ReturnType<typeof buildReview>) {
  return review.reviewedInjectedRuns >= review.targetInjectedRuns
    && review.helpfulRate >= 0.5
    && review.harmful === 0
    && review.stale === 0
    && review.sensitive === 0
    && review.injectedForbidden === 0;
}

function completionCriteria(review: ReturnType<typeof buildReview>) {
  return {
    reviewedAtLeastTarget: review.reviewedInjectedRuns >= review.targetInjectedRuns,
    helpfulAtLeast50Percent: review.reviewedInjectedRuns > 0 && review.helpfulRate >= 0.5,
    zeroHarmfulStaleSensitive: review.harmful === 0 && review.stale === 0 && review.sensitive === 0,
    zeroInjectedForbidden: review.injectedForbidden === 0
  };
}

function errorsFor(runs: Run[]) {
  return Object.fromEntries([...new Set(runs.map((run) => run.error_code).filter(Boolean))]
    .map((code) => [code!, runs.filter((run) => run.error_code === code).length]));
}

function latencyFor(runs: Run[]) {
  return {
    embeddingP50: percentile(runs.map((run) => Number(run.embedding_latency_ms)), 0.5),
    embeddingP95: percentile(runs.map((run) => Number(run.embedding_latency_ms)), 0.95),
    searchP50: percentile(runs.map((run) => Number(run.search_latency_ms)), 0.5),
    searchP95: percentile(runs.map((run) => Number(run.search_latency_ms)), 0.95),
    retrievalP50: percentile(runs.map((run) => Number(run.total_retrieval_latency_ms)), 0.5),
    retrievalP95: percentile(runs.map((run) => Number(run.total_retrieval_latency_ms)), 0.95)
  };
}

function tokensFor(runs: Run[]) {
  const injectedRuns = runs.filter((run) => run.status === "injected");
  const contextRatios = injectedRuns
    .filter((run) => run.history_20_tokens > 0)
    .map((run) => (run.history_10_tokens + run.retrieval_tokens) / run.history_20_tokens);
  const tokenSavings = contextRatios.map((ratioValue) => 1 - ratioValue);
  return {
    history10Median: percentile(runs.map((run) => Number(run.history_10_tokens)), 0.5),
    history20Median: percentile(runs.map((run) => Number(run.history_20_tokens)), 0.5),
    retrievalMedian: percentile(injectedRuns.map((run) => Number(run.retrieval_tokens)), 0.5),
    actualInputMedian: percentile(runs.flatMap((run) => run.actual_input_tokens === null ? [] : [Number(run.actual_input_tokens)]), 0.5),
    outputMedian: percentile(runs.flatMap((run) => run.output_tokens === null ? [] : [Number(run.output_tokens)]), 0.5),
    historyPlusRetrievalVsHistory20Median: percentile(contextRatios, 0.5),
    estimatedSavingsMedian: percentile(tokenSavings, 0.5)
  };
}

function summarizeStatuses(runs: Run[]) {
  return Object.fromEntries(["injected", "abstained", "fallback"].map((status) => [
    status,
    runs.filter((run) => run.status === status).length
  ])) as Record<"injected" | "abstained" | "fallback", number>;
}

function selectionDecisionCounts(candidates: Candidate[], runIds: Set<string>) {
  return Object.fromEntries([
    "selected", "recall_probe_only", "boilerplate_only", "duplicate", "below_relevance", "not_selected", "invalid_source"
  ].map((decision) => [decision, candidates.filter((candidate) =>
    runIds.has(candidate.run_id) && candidate.selection_decision === decision
  ).length]));
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? 0;
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 0;
}

function markdown(report: ReturnType<typeof buildGenerationReport>) {
  return [
    "# Retrieval Generation Canary Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "> No chat content is included.",
    "",
    `Adaptive user evidence injected / abstained / fallback: ${report.userEvidenceAdaptiveRuns.injected} / ${report.userEvidenceAdaptiveRuns.abstained} / ${report.userEvidenceAdaptiveRuns.fallback}`,
    `Adaptive timeout rate: ${(report.phase24.timeoutRate * 100).toFixed(1)}%`,
    `Adaptive reviewed injected runs: ${report.phase24.review.reviewedInjectedRuns} / ${report.phase24.review.targetInjectedRuns}`,
    `Adaptive helpful / neutral / harmful: ${report.phase24.review.helpful} / ${report.phase24.review.neutral} / ${report.phase24.review.harmful}`,
    `Adaptive selection decisions: ${JSON.stringify(report.phase24.selectionDecisions)}`,
    `Adaptive retrieval latency P50 / P95: ${report.phase24.latencyMs.retrievalP50} / ${report.phase24.latencyMs.retrievalP95} ms`,
    `Adaptive metrics pass (fixed smoke cases are manual): ${report.phase24.metricsPass ? "YES" : "NO"}`,
    "",
    "Historical Phase 2.3:",
    `User evidence Top 20 injected / abstained / fallback: ${report.userEvidenceTop20Runs.injected} / ${report.userEvidenceTop20Runs.abstained} / ${report.userEvidenceTop20Runs.fallback}`,
    `User evidence timeout rate: ${(report.phase23.timeoutRate * 100).toFixed(1)}%`,
    `User evidence reviewed injected runs: ${report.phase23.review.reviewedInjectedRuns} / ${report.phase23.review.targetInjectedRuns}`,
    `User evidence helpful / neutral / harmful: ${report.phase23.review.helpful} / ${report.phase23.review.neutral} / ${report.phase23.review.harmful}`,
    `User evidence selection decisions: ${JSON.stringify(report.phase23.selectionDecisions)}`,
    `User evidence retrieval latency P50 / P95: ${report.phase23.latencyMs.retrievalP50} / ${report.phase23.latencyMs.retrievalP95} ms`,
    `User evidence metrics pass (fixed smoke cases are manual): ${report.phase23.metricsPass ? "YES" : "NO"}`,
    "",
    "Historical Phase 2.2:",
    `Top 20 local rerank injected / abstained / fallback: ${report.top20LocalRerankRuns.injected} / ${report.top20LocalRerankRuns.abstained} / ${report.top20LocalRerankRuns.fallback}`,
    `Top 20 timeout rate: ${(report.phase22.timeoutRate * 100).toFixed(1)}%`,
    `Top 20 reviewed injected runs: ${report.phase22.review.reviewedInjectedRuns} / ${report.phase22.review.targetInjectedRuns}`,
    `Top 20 helpful / neutral / harmful: ${report.phase22.review.helpful} / ${report.phase22.review.neutral} / ${report.phase22.review.harmful}`,
    `Top 20 selection decisions: ${JSON.stringify(report.phase22.selectionDecisions)}`,
    `Top 20 retrieval latency P50 / P95: ${report.phase22.latencyMs.retrievalP50} / ${report.phase22.latencyMs.retrievalP95} ms`,
    `Top 20 metrics pass (fixed smoke cases are manual): ${report.phase22.metricsPass ? "YES" : "NO"}`,
    "",
    `Historical Top 5 injected / abstained / fallback: ${report.top5AllRuns.injected} / ${report.top5AllRuns.abstained} / ${report.top5AllRuns.fallback}`,
    `Historical Top 2 injected / abstained / fallback: ${report.strategies.thresholdTop2.injected} / ${report.strategies.thresholdTop2.abstained} / ${report.strategies.thresholdTop2.fallback}`,
    `Historical Top 5 reviewed injected runs: ${report.review.reviewedInjectedRuns} / ${report.review.targetInjectedRuns}`,
    `Helpful / Neutral / Harmful: ${report.review.helpful} / ${report.review.neutral} / ${report.review.harmful}`,
    `Stale / Sensitive / Injected forbidden: ${report.review.stale} / ${report.review.sensitive} / ${report.review.injectedForbidden}`,
    `Helpful rate: ${(report.review.helpfulRate * 100).toFixed(1)}%`,
    `Injected candidate precision: ${(report.review.injectedCandidatePrecision * 100).toFixed(1)}%`,
    `Injected irrelevant rate: ${(report.review.injectedIrrelevantRate * 100).toFixed(1)}%`,
    `Average injected chunks: ${report.review.averageInjectedChunks.toFixed(2)}`,
    `Median context token savings vs history 20: ${(report.tokens.estimatedSavingsMedian * 100).toFixed(1)}%`,
    `Retrieval latency P50 / P95: ${report.latencyMs.retrievalP50} / ${report.latencyMs.retrievalP95} ms`,
    "",
    `Historical Phase 2.1 Top 5 pass: ${report.phase21Pass ? "YES" : "NO"}`,
    ""
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[retrieval-generation:report] ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  });
}
