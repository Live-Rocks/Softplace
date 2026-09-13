import crypto from "node:crypto";
import type {
  AvaMemory,
  AvaMessage,
  AvaPreferences,
  AvaProactiveLevel,
  AvaState
} from "@softplace/shared";
import { config } from "../config.js";
import {
  AVA_KEY,
  availabilityLabel,
  canScheduleAvaProactiveAt,
  getAvaLifeContext,
  relationshipStage,
  shouldScheduleProactive
} from "../domain/ava.js";
import { buildAvaEventDetailInput, getAvaEventDefinition, getAvaEventPhase, selectNextAvaEvent } from "../domain/avaEvents.js";
import {
  AVA_EVENT_FACTS_VERSION,
  buildAvaEventFactsInput,
  parseAvaEventFacts,
  type AvaEventFacts
} from "../domain/avaEventFacts.js";
import { supabaseAdmin } from "./supabase.js";

export type AvaEventRunRow = {
  id: string;
  event_key: string;
  starts_on: string;
  ends_on: string;
  duration_days: 2 | 3;
  event_facts_version?: string | null;
  event_facts?: unknown;
  event_facts_status?: "legacy" | "pending" | "leased" | "generated" | "failed";
};

export type AvaDailyState = {
  companion_key: string;
  local_date: string;
  activity: string;
  mood_note: string;
  event_run_id: string | null;
  event_key: string | null;
  event_day: number | null;
  phase_key: string | null;
  skeleton_activity: string | null;
  skeleton_mood_note: string | null;
  event_detail: string | null;
  event_detail_status: "pending" | "leased" | "generated" | "failed";
};

export type AvaEventDetailTask = {
  workerToken: string;
  daily: AvaDailyState;
  prompt: string;
  eventFacts: AvaEventFacts | null;
};

export type AvaEventFactsTask = {
  workerToken: string;
  run: AvaEventRunRow;
  prompt: string;
};

type UserCompanionRow = {
  user_id: string;
  companion_key: string;
  relationship_started_at: string;
  reply_count: number;
  proactive_level: AvaProactiveLevel;
  quiet_start: string;
  quiet_end: string;
  timezone: string;
  last_read_at: string | null;
  last_user_message_at: string | null;
  last_assistant_message_at: string | null;
  last_proactive_at: string | null;
};

function admin() {
  if (!supabaseAdmin) throw new Error("supabase_not_configured");
  return supabaseAdmin;
}

function localDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

export function isAvaEnabledFor(userId: string) {
  return config.avaFeatureEnabled && (!config.avaBetaUserIds.size || config.avaBetaUserIds.has(userId));
}

export async function ensureAvaUser(userId: string) {
  const { data, error } = await admin()
    .from("user_companions")
    .upsert({ user_id: userId, companion_key: AVA_KEY }, { onConflict: "user_id,companion_key", ignoreDuplicates: true })
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (data) return data as UserCompanionRow;
  const response = await admin()
    .from("user_companions")
    .select("*")
    .eq("user_id", userId)
    .eq("companion_key", AVA_KEY)
    .single();
  if (response.error) throw response.error;
  return response.data as UserCompanionRow;
}

export async function ensureAvaDailyState(now = new Date()) {
  const date = localDate(now);
  const life = getAvaLifeContext(now);
  const eventRun = await ensureAvaEventRun(date);
  const eventDay = daysBetween(eventRun.starts_on, date) + 1;
  const phase = getAvaEventPhase(eventRun.event_key, eventDay);
  const { data, error } = await admin()
    .from("companion_daily_states")
    .upsert(
      {
        companion_key: AVA_KEY,
        local_date: date,
        timezone: "Asia/Taipei",
        activity: life.dailyActivity,
        mood_note: life.moodNote,
        event_run_id: eventRun.id,
        event_key: eventRun.event_key,
        event_day: eventDay,
        phase_key: phase.key,
        skeleton_activity: phase.activity,
        skeleton_mood_note: phase.moodNote
      },
      { onConflict: "companion_key,local_date" }
    )
    .select("*")
    .single();
  if (error) throw error;
  return data as AvaDailyState;
}

export async function getAvaDailyStateForDate(date: string) {
  const { data, error } = await admin()
    .from("companion_daily_states")
    .select("*")
    .eq("companion_key", AVA_KEY)
    .eq("local_date", date)
    .maybeSingle();
  if (error) throw error;
  return data as AvaDailyState | null;
}

export async function getAvaDailyStatesForDates(dates: readonly string[]) {
  const uniqueDates = [...new Set(dates)].slice(0, 3);
  if (!uniqueDates.length) return [];
  const { data, error } = await admin()
    .from("companion_daily_states")
    .select("*")
    .eq("companion_key", AVA_KEY)
    .in("local_date", uniqueDates);
  if (error) throw error;
  return (data ?? []) as AvaDailyState[];
}

export async function claimAvaDailyEventDetail(now = new Date()): Promise<AvaEventDetailTask | null> {
  const daily = await ensureAvaDailyState(now);
  if (!daily.event_run_id || !daily.event_key) return null;
  const eventRun = await getAvaEventRun(daily.event_run_id);
  if (!eventRun || !["legacy", "generated"].includes(eventRun.event_facts_status ?? "legacy")) return null;
  const event = getAvaEventDefinition(daily.event_key);
  const eventFacts = eventRun.event_facts_status === "generated"
    ? parseAvaEventFacts(eventRun.event_facts, event)
    : null;
  if (eventRun.event_facts_status === "generated" && !eventFacts) throw new Error("ava_event_facts_invalid_stored_value");
  const workerToken = crypto.randomUUID();
  const { data, error } = await admin().rpc("claim_ava_event_detail", {
    p_companion_key: AVA_KEY,
    p_local_date: daily.local_date,
    p_worker_token: workerToken,
    p_lease_seconds: 120
  });
  if (error) throw error;
  const claimed = (Array.isArray(data) ? data[0] : data) as AvaDailyState | null;
  if (!claimed) return null;

  let previousDetail: string | null = null;
  if (claimed.event_run_id && claimed.event_day && claimed.event_day > 1) {
    const previous = await admin()
      .from("companion_daily_states")
      .select("event_detail")
      .eq("companion_key", AVA_KEY)
      .eq("event_run_id", claimed.event_run_id)
      .lt("local_date", claimed.local_date)
      .eq("event_detail_status", "generated")
      .not("event_detail", "is", null)
      .order("local_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (previous.error) throw previous.error;
    previousDetail = previous.data?.event_detail ?? null;
  }

  if (!claimed.event_key || !claimed.event_day || !claimed.phase_key || !claimed.skeleton_activity || !claimed.skeleton_mood_note) {
    throw new Error("ava_event_detail_missing_skeleton");
  }
  const phase = getAvaEventPhase(claimed.event_key, claimed.event_day);
  const claimedEvent = getAvaEventDefinition(claimed.event_key);
  return {
    workerToken,
    daily: claimed,
    eventFacts,
    prompt: buildAvaEventDetailInput({
      eventKey: claimed.event_key,
      eventDay: claimed.event_day,
      phaseKey: claimed.phase_key,
      activity: claimed.skeleton_activity,
      moodNote: claimed.skeleton_mood_note,
      eventTitle: claimedEvent.title,
      anchorTerms: claimedEvent.anchorTerms,
      scene: phase.scene,
      visibleDetails: phase.visibleDetails,
      progress: phase.progress,
      completion: phase.completion,
      anonymousInteraction: phase.anonymousInteraction,
      previousDetail,
      eventFacts
    })
  };
}

export async function claimAvaEventFacts(now = new Date()): Promise<AvaEventFactsTask | null> {
  await ensureAvaDailyState(now);
  const workerToken = crypto.randomUUID();
  const { data, error } = await admin().rpc("claim_ava_event_facts", {
    p_companion_key: AVA_KEY,
    p_worker_token: workerToken,
    p_lease_seconds: 120
  });
  if (error) throw error;
  const run = (Array.isArray(data) ? data[0] : data) as AvaEventRunRow | null;
  if (!run) return null;
  const event = getAvaEventDefinition(run.event_key);
  const recent = await admin()
    .from("ava_event_runs")
    .select("event_key,event_facts,event_facts_status")
    .eq("companion_key", AVA_KEY)
    .lt("starts_on", run.starts_on)
    .order("starts_on", { ascending: false })
    .limit(3);
  if (recent.error) {
    await releaseAvaEventFacts({ workerToken, run, prompt: "" }).catch(() => undefined);
    throw recent.error;
  }
  const recentTopics = (recent.data ?? []).map((item) => {
    if (item.event_facts_status === "generated") {
      const previous = parseAvaEventFacts(item.event_facts, getAvaEventDefinition(item.event_key));
      if (previous) return `${previous.eventTopic}：${previous.concreteSubject}`;
    }
    return getAvaEventDefinition(item.event_key).title;
  });
  return { workerToken, run, prompt: buildAvaEventFactsInput(event, recentTopics) };
}

export async function completeAvaEventFacts(task: AvaEventFactsTask, facts: AvaEventFacts) {
  const { data, error } = await admin().rpc("complete_ava_event_facts", {
    p_event_run_id: task.run.id,
    p_worker_token: task.workerToken,
    p_event_facts_version: AVA_EVENT_FACTS_VERSION,
    p_event_facts: facts
  });
  if (error) throw error;
  if (!data) throw new Error("ava_event_facts_completion_lost_lease");
}

export async function releaseAvaEventFacts(task: AvaEventFactsTask) {
  const { error } = await admin().rpc("release_ava_event_facts", {
    p_event_run_id: task.run.id,
    p_worker_token: task.workerToken
  });
  if (error) throw error;
}

export async function completeAvaDailyEventDetail(task: AvaEventDetailTask, detail: string) {
  const { data, error } = await admin().rpc("complete_ava_event_detail", {
    p_companion_key: AVA_KEY,
    p_local_date: task.daily.local_date,
    p_worker_token: task.workerToken,
    p_event_detail: detail
  });
  if (error) throw error;
  if (!data) throw new Error("ava_event_detail_completion_lost_lease");
}

export async function releaseAvaDailyEventDetail(task: AvaEventDetailTask) {
  const { error } = await admin().rpc("release_ava_event_detail", {
    p_companion_key: AVA_KEY,
    p_local_date: task.daily.local_date,
    p_worker_token: task.workerToken
  });
  if (error) throw error;
}

async function ensureAvaEventRun(date: string): Promise<AvaEventRunRow> {
  const previousRuns = await admin()
    .from("ava_event_runs")
    .select("event_key, ends_on")
    .eq("companion_key", AVA_KEY)
    .lt("ends_on", date)
    .order("ends_on", { ascending: false })
    .limit(3);
  if (previousRuns.error) throw previousRuns.error;

  const event = selectNextAvaEvent({
    startDate: date,
    recentEventKeys: (previousRuns.data ?? []).map((run) => run.event_key)
  });
  const { data, error } = await admin().rpc("ensure_ava_event_run", {
    p_companion_key: AVA_KEY,
    p_local_date: date,
    p_event_key: event.key,
    p_duration_days: event.durationDays
  });
  if (error) throw error;
  const run = Array.isArray(data) ? data[0] : data;
  if (!run) throw new Error("ava_event_run_not_created");
  return run as AvaEventRunRow;
}

export async function getAvaEventRun(id: string) {
  const { data, error } = await admin().from("ava_event_runs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as AvaEventRunRow | null;
}

export async function getAvaEventRuns(ids: readonly string[]) {
  const uniqueIds = [...new Set(ids)].slice(0, 3);
  if (!uniqueIds.length) return [];
  const { data, error } = await admin().from("ava_event_runs").select("*").in("id", uniqueIds);
  if (error) throw error;
  return (data ?? []) as AvaEventRunRow[];
}

function daysBetween(startDate: string, endDate: string) {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
}

export async function getAvaState(userId: string): Promise<AvaState> {
  const user = await ensureAvaUser(userId);
  const date = localDate();
  const [jobs, unread, usage] = await Promise.all([
    admin().from("companion_jobs").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("companion_key", AVA_KEY).in("status", ["queued", "leased"]),
    admin().from("companion_messages").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("companion_key", AVA_KEY).eq("role", "assistant").is("read_at", null),
    admin().from("companion_daily_usage").select("generated_count").eq("user_id", userId).eq("companion_key", AVA_KEY).eq("local_date", date).maybeSingle()
  ]);
  if (jobs.error) throw jobs.error;
  if (unread.error) throw unread.error;
  if (usage.error) throw usage.error;
  const availability = getAvaLifeContext().availability;
  return {
    companionKey: AVA_KEY,
    name: "Ava",
    availability,
    statusLabel: availabilityLabel(availability),
    relationshipStage: relationshipStage(user.relationship_started_at, user.reply_count),
    pendingReply: Boolean(jobs.count),
    unreadCount: unread.count ?? 0,
    dailyUsed: Number(usage.data?.generated_count ?? 0),
    dailyLimit: config.avaDailyLimit,
    preferences: {
      proactiveLevel: user.proactive_level,
      quietStart: user.quiet_start.slice(0, 5),
      quietEnd: user.quiet_end.slice(0, 5),
      timezone: user.timezone
    }
  };
}

export async function listAvaMessages(userId: string, limit: number, before?: string) {
  let query = admin()
    .from("companion_messages")
    .select("*")
    .eq("user_id", userId)
    .eq("companion_key", AVA_KEY)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) throw error;
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const selected = hasMore ? rows.slice(0, limit) : rows;
  return {
    messages: selected.reverse().map(mapMessage),
    nextCursor: hasMore ? selected[selected.length - 1]?.created_at ?? null : null
  };
}

export async function enqueueAvaMessage(userId: string, content: string, dueAt: string) {
  const { data, error } = await admin().rpc("enqueue_companion_message", {
    p_user_id: userId,
    p_companion_key: AVA_KEY,
    p_content: content,
    p_due_at: dueAt
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  const message = await admin().from("companion_messages").select("*").eq("id", result.message_id).single();
  if (message.error) throw message.error;
  return mapMessage(message.data);
}

export async function saveImmediateAvaExchange(userId: string, userContent: string, assistantContent: string) {
  await ensureAvaUser(userId);
  const { data, error } = await admin()
    .from("companion_messages")
    .insert([
      { user_id: userId, companion_key: AVA_KEY, role: "user", content: userContent, read_at: new Date().toISOString() },
      { user_id: userId, companion_key: AVA_KEY, role: "assistant", content: assistantContent }
    ])
    .select("*");
  if (error) throw error;
  await admin().from("user_companions").update({ last_user_message_at: new Date().toISOString(), last_assistant_message_at: new Date().toISOString() }).eq("user_id", userId).eq("companion_key", AVA_KEY);
  return (data ?? []).map(mapMessage);
}

export async function markAvaRead(userId: string) {
  const timestamp = new Date().toISOString();
  const { error } = await admin().from("companion_messages").update({ read_at: timestamp }).eq("user_id", userId).eq("companion_key", AVA_KEY).eq("role", "assistant").is("read_at", null);
  if (error) throw error;
  await admin().from("user_companions").update({ last_read_at: timestamp }).eq("user_id", userId).eq("companion_key", AVA_KEY);
}

export async function updateAvaPreferences(userId: string, input: Partial<AvaPreferences>) {
  await ensureAvaUser(userId);
  const values: Record<string, string> = {};
  if (input.proactiveLevel) values.proactive_level = input.proactiveLevel;
  if (input.quietStart) values.quiet_start = input.quietStart;
  if (input.quietEnd) values.quiet_end = input.quietEnd;
  if (input.timezone) values.timezone = input.timezone;
  const { error } = await admin().from("user_companions").update({ ...values, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("companion_key", AVA_KEY);
  if (error) throw error;
  return getAvaState(userId);
}

export async function deleteAvaRelationship(userId: string) {
  for (const table of ["companion_jobs", "companion_memories", "companion_messages", "companion_daily_usage", "user_companions"]) {
    const { error } = await admin().from(table).delete().eq("user_id", userId).eq("companion_key", AVA_KEY);
    if (error) throw error;
  }
}

export async function listAvaMemories(userId: string): Promise<AvaMemory[]> {
  const { data, error } = await admin().from("companion_memories").select("*").eq("user_id", userId).eq("companion_key", AVA_KEY).order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({ id: row.id, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at }));
}

export async function updateAvaMemory(userId: string, memoryId: string, content: string) {
  const { data, error } = await admin().from("companion_memories").update({ content, updated_at: new Date().toISOString() }).eq("id", memoryId).eq("user_id", userId).eq("companion_key", AVA_KEY).select("*").single();
  if (error) throw error;
  return { id: data.id, content: data.content, createdAt: data.created_at, updatedAt: data.updated_at } as AvaMemory;
}

export async function deleteAvaMemory(userId: string, memoryId: string) {
  const { error } = await admin().from("companion_memories").delete().eq("id", memoryId).eq("user_id", userId).eq("companion_key", AVA_KEY);
  if (error) throw error;
}

export async function saveAvaMemoryIfNew(userId: string, content: string, sourceMessageId?: string) {
  const existing = await admin().from("companion_memories").select("id").eq("user_id", userId).eq("companion_key", AVA_KEY).eq("content", content).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return;
  const { error } = await admin().from("companion_memories").insert({ user_id: userId, companion_key: AVA_KEY, content, source_message_id: sourceMessageId ?? null });
  if (error) throw error;
}

export async function upsertPushToken(userId: string, token: string, platform: "android" | "ios") {
  const { error } = await admin().from("push_tokens").upsert({ user_id: userId, expo_push_token: token, platform, enabled: true, updated_at: new Date().toISOString() }, { onConflict: "user_id,expo_push_token" });
  if (error) throw error;
}

export async function deletePushToken(userId: string, token: string) {
  const { error } = await admin().from("push_tokens").delete().eq("user_id", userId).eq("expo_push_token", token);
  if (error) throw error;
}

export async function getPushTokens(userId: string) {
  const { data, error } = await admin().from("push_tokens").select("expo_push_token").eq("user_id", userId).eq("enabled", true);
  if (error) throw error;
  return (data ?? []).map((row) => row.expo_push_token as string);
}

export async function scheduleEligibleProactiveJobs() {
  const now = new Date();
  const lifeContext = getAvaLifeContext(now);
  if (!canScheduleAvaProactiveAt(lifeContext)) return 0;

  const { data, error } = await admin().from("user_companions").select("*").eq("companion_key", AVA_KEY).neq("proactive_level", "off").limit(200);
  if (error) throw error;
  let scheduled = 0;
  for (const row of (data ?? []) as UserCompanionRow[]) {
    const [pending, unread] = await Promise.all([
      admin().from("companion_jobs").select("id", { count: "exact", head: true }).eq("user_id", row.user_id).eq("companion_key", AVA_KEY).in("status", ["queued", "leased"]),
      admin().from("companion_messages").select("id", { count: "exact", head: true }).eq("user_id", row.user_id).eq("companion_key", AVA_KEY).eq("role", "assistant").is("read_at", null)
    ]);
    if (!shouldScheduleProactive({
      level: row.proactive_level,
      lastProactiveAt: row.last_proactive_at,
      lastUserAt: row.last_user_message_at,
      pendingOrUnread: Boolean(pending.count || unread.count),
      quietStart: row.quiet_start,
      quietEnd: row.quiet_end,
      now
    })) continue;
    const maxDelaySeconds = Math.min(10 * 60, Math.max(2 * 60, lifeContext.minutesUntilTransition * 60 - 60));
    const delaySeconds = 2 * 60 + Math.random() * (maxDelaySeconds - 2 * 60);
    const dueAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
    const inserted = await admin().from("companion_jobs").insert({ user_id: row.user_id, companion_key: AVA_KEY, job_type: "proactive", due_at: dueAt, payload: {} });
    if (!inserted.error) scheduled += 1;
  }
  return scheduled;
}

export async function claimAvaJobs(workerToken: string) {
  const { data, error } = await admin().rpc("claim_companion_jobs", {
    p_worker_token: workerToken,
    p_daily_limit: config.avaDailyLimit,
    p_lease_seconds: 120,
    p_limit: 1
  });
  if (error) throw error;
  return data ?? [];
}

export async function getAvaJobContext(job: any, now = new Date()) {
  const [user, messages, memories, daily] = await Promise.all([
    ensureAvaUser(job.user_id),
    listAvaMessages(job.user_id, 30),
    listAvaMemories(job.user_id),
    ensureAvaDailyState(now)
  ]);
  const eventRun = daily.event_run_id ? await getAvaEventRun(daily.event_run_id) : null;
  return { user, messages: messages.messages, memories, daily, eventRun };
}

export async function completeAvaJob(jobId: string, workerToken: string, content: string) {
  const { data, error } = await admin().rpc("complete_companion_job", { p_job_id: jobId, p_worker_token: workerToken, p_content: content });
  if (error) throw error;
  return data as string;
}

export async function retryAvaJob(jobId: string, workerToken: string, errorMessage: string) {
  const { error } = await admin().rpc("retry_companion_job", { p_job_id: jobId, p_worker_token: workerToken, p_error: errorMessage });
  if (error) throw error;
}

export function newWorkerToken() {
  return crypto.randomUUID();
}

function mapMessage(row: any): AvaMessage {
  return { id: row.id, role: row.role, content: row.content, proactive: Boolean(row.proactive), createdAt: row.created_at, readAt: row.read_at };
}
