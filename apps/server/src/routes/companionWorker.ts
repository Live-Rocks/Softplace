import { Router } from "express";
import { config } from "../config.js";
import { buildAvaInput, buildAvaInstructions, buildAvaProactiveInput, extractSafeAvaMemory, getAvaLifeContext, relationshipStage } from "../domain/ava.js";
import { getAvaEventDefinition, resolveAvaEventMoment } from "../domain/avaEvents.js";
import { parseAvaEventFacts, type AvaEventFacts } from "../domain/avaEventFacts.js";
import {
  claimAvaEventFacts,
  claimAvaDailyEventDetail,
  claimAvaJobs,
  completeAvaEventFacts,
  completeAvaDailyEventDetail,
  completeAvaJob,
  getAvaJobContext,
  getAvaDailyStatesForDates,
  getAvaEventRuns,
  getPushTokens,
  newWorkerToken,
  releaseAvaEventFacts,
  releaseAvaDailyEventDetail,
  retryAvaJob,
  saveAvaMemoryIfNew,
  ensureAvaDailyState,
  scheduleEligibleProactiveJobs
} from "../integrations/avaRepository.js";
import type { AvaDailyState, AvaEventRunRow } from "../integrations/avaRepository.js";
import { sendAvaPush } from "../integrations/expoPush.js";
import { generateAvaEventDetail, generateAvaEventFacts, generateAvaReply } from "../integrations/openai.js";
import {
  createShadowEmbeddingProvider,
  createSupabaseShadowStore,
  processRetrievalShadowJobs
} from "../integrations/retrievalShadow.js";
import { cleanupGenerationRuns } from "../integrations/retrievalGeneration.js";

export function companionWorkerRouter() {
  const router = Router();
  router.post("/tick", async (req, res, next) => {
    try {
      const secret = req.header("x-companion-worker-secret") ?? req.header("authorization")?.replace(/^Bearer\s+/i, "");
      if (!config.companionWorkerSecret || secret !== config.companionWorkerSecret) {
        return res.status(401).json({ error: "Invalid worker secret", code: "unauthorized" });
      }
      let retrieval = { claimed: 0, completed: 0, failed: 0 };
      if (config.retrievalShadowEnabled) {
        const store = createSupabaseShadowStore();
        if (store) {
          retrieval = await processRetrievalShadowJobs({ store, provider: createShadowEmbeddingProvider() })
            .catch(() => {
              console.warn("[retrieval-shadow:worker]", { code: "shadow_worker_failed" });
              return { claimed: 0, completed: 0, failed: 1 };
            });
        }
        await cleanupGenerationRuns().catch(() => {
          console.warn("[retrieval-generation:cleanup]", { code: "generation_cleanup_failed" });
        });
      }
      if (!config.avaFeatureEnabled) return res.json({ scheduled: 0, claimed: 0, completed: 0, retrieval });

      await ensureAvaDailyState();
      const scheduled = await scheduleEligibleProactiveJobs();
      const workerToken = newWorkerToken();
      const jobs = await claimAvaJobs(workerToken);
      let completed = 0;

      for (const job of jobs) {
        try {
          const now = new Date();
          const context = await getAvaJobContext(job, now);
          const proactive = job.job_type === "proactive";
          const currentLife = getAvaLifeContext(now);
          const latestUser = proactive ? undefined : [...context.messages].reverse().find((message) => message.role === "user");
          const receivedLife = latestUser ? getAvaLifeContext(new Date(latestUser.createdAt)) : undefined;
          const historicalDates = recentHistoricalDates(context.messages, currentLife.localDate);
          const historicalDailyStates = await getAvaDailyStatesForDates(historicalDates);
          const historicalRuns = await getAvaEventRuns(historicalDailyStates.flatMap((daily) => daily.event_run_id ? [daily.event_run_id] : []));
          const runsById = new Map(historicalRuns.map((run) => [run.id, run]));
          const dailyByDate = new Map(historicalDailyStates.map((daily) => [daily.local_date, daily]));
          const receivedDaily = receivedLife
            ? receivedLife.localDate === context.daily.local_date
              ? context.daily
              : dailyByDate.get(receivedLife.localDate) ?? null
            : null;
          const currentFacts = factsForRun(context.eventRun);
          const currentEvent = resolveEventContext(context.daily, currentLife.localSecondOfDay / 60, currentFacts);
          const receivedEvent = receivedLife && receivedDaily
            ? resolveEventContext(
                receivedDaily,
                receivedLife.localSecondOfDay / 60,
                receivedDaily.event_run_id === context.eventRun?.id
                  ? currentFacts
                  : receivedDaily.event_run_id
                    ? factsForRun(runsById.get(receivedDaily.event_run_id))
                    : null
              )
            : undefined;
          const instructions = buildAvaInstructions({
            relationship: relationshipStage(context.user.relationship_started_at, context.user.reply_count),
            receivedContext: receivedEvent ? describeEventMoment(receivedEvent) : receivedLife?.currentActivity,
            currentActivity: currentLife.currentActivity,
            currentTone: currentLife.tone,
            eventContext: currentEvent,
            recentPastEvents: describePastEvents(historicalDailyStates, runsById),
            memories: context.memories.map((memory) => memory.content),
            proactive
          });
          const messages = proactive
            ? [
                ...buildAvaProactiveInput(context.messages),
                { role: "user" as const, content: "[主動訊息任務] 根據目前可用背景與最近對話，自然傳一則新訊息。這不是使用者說的話。" }
              ]
            : buildAvaInput(context.messages);
          const content = await generateAvaReply({ userId: job.user_id, instructions, messages });
          await completeAvaJob(job.id, workerToken, content);
          completed += 1;

          if (!proactive) {
            const memory = latestUser ? extractSafeAvaMemory(latestUser.content) : null;
            if (memory) {
              await saveAvaMemoryIfNew(job.user_id, memory, latestUser?.id).catch((error) => {
                console.warn("[ava:memory]", { message: error instanceof Error ? error.message : "memory_failed" });
              });
            }
          }

          const tokens = await getPushTokens(job.user_id).catch(() => []);
          await sendAvaPush(tokens, content)
            .then((result) => {
              if (result.accepted > 0) console.info("[ava:push]", { accepted: result.accepted });
            })
            .catch((error) => {
              console.warn("[ava:push]", { message: error instanceof Error ? error.message : "push_failed" });
            });
        } catch (error) {
          await retryAvaJob(job.id, workerToken, error instanceof Error ? error.message : "worker_failed");
        }
      }

      const factsTask = await claimAvaEventFacts();
      if (factsTask) {
        try {
          const event = getAvaEventDefinition(factsTask.run.event_key);
          const facts = await generateAvaEventFacts({ event, prompt: factsTask.prompt });
          await completeAvaEventFacts(factsTask, facts);
        } catch (error) {
          await releaseAvaEventFacts(factsTask).catch(() => undefined);
          console.warn("[ava:event-facts]", { message: error instanceof Error ? error.message : "event_facts_failed" });
        }
      } else {
        const detailTask = await claimAvaDailyEventDetail();
        if (detailTask) {
          try {
            const detail = await generateAvaEventDetail({
              activity: detailTask.daily.skeleton_activity!,
              moodNote: detailTask.daily.skeleton_mood_note!,
              anchorTerms: getAvaEventDefinition(detailTask.daily.event_key!).anchorTerms,
              prompt: detailTask.prompt
            });
            await completeAvaDailyEventDetail(detailTask, detail);
          } catch (error) {
            await releaseAvaDailyEventDetail(detailTask).catch(() => undefined);
            console.warn("[ava:event-detail]", { message: error instanceof Error ? error.message : "event_detail_failed" });
          }
        }
      }

      return res.json({ scheduled, claimed: jobs.length, completed, retrieval });
    } catch (error) {
      return next(error);
    }
  });
  return router;
}

function resolveEventContext(daily: AvaDailyState, minuteOfDay: number, eventFacts?: AvaEventFacts | null) {
  if (!daily.event_key || !daily.event_day || !daily.skeleton_activity || !daily.skeleton_mood_note) return undefined;
  return resolveAvaEventMoment({
    eventKey: daily.event_key,
    eventDay: daily.event_day,
    minuteOfDay,
    eventDetail: daily.event_detail,
    eventFacts
  });
}

function factsForRun(run?: AvaEventRunRow | null) {
  if (!run || run.event_facts_status !== "generated") return null;
  return parseAvaEventFacts(run.event_facts, getAvaEventDefinition(run.event_key));
}

function recentHistoricalDates(messages: Array<{ createdAt: string }>, currentDate: string) {
  const dates = [...messages].reverse().map((message) => getAvaLifeContext(new Date(message.createdAt)).localDate);
  return [...new Set(dates.filter((date) => date !== currentDate))].slice(0, 3);
}

function describePastEvents(states: AvaDailyState[], runsById: Map<string, AvaEventRunRow>) {
  return [...states]
    .sort((a, b) => b.local_date.localeCompare(a.local_date))
    .flatMap((daily) => {
      if (!daily.event_key || !daily.event_day) return [];
      const run = daily.event_run_id ? runsById.get(daily.event_run_id) : undefined;
      const moment = resolveEventContext(daily, 24 * 60, factsForRun(run));
      return moment ? [`${daily.local_date}：${describeEventMoment(moment)}`] : [];
    });
}

function describeEventMoment(moment: NonNullable<ReturnType<typeof resolveEventContext>>) {
  return `${moment.title}第 ${moment.day} 天，今天活動${moment.stageLabel}；${moment.background}`;
}
