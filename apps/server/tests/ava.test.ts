import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildAvaInstructions,
  buildAvaProactiveInput,
  canScheduleAvaProactiveAt,
  calculateReplyDueAt,
  dailyLifeForDate,
  extractSafeAvaMemory,
  getAvaLifeContext,
  relationshipStage,
  shouldScheduleProactive
} from "../src/domain/ava.js";
import {
  buildAvaEventDetailInput,
  buildAvaEventDetailInstructions,
  getAvaEventDefinition,
  getAvaEventPhase,
  listAvaEventDefinitions,
  resolveAvaEventMoment,
  selectNextAvaEvent,
  validateAvaEventDetail
} from "../src/domain/avaEvents.js";
import {
  AVA_EVENT_FACTS_VERSION,
  avaEventFactsJsonSchema,
  buildAvaEventFactsInput,
  buildAvaEventFactsInstructions,
  parseAvaEventFacts,
  visibleAvaEventFacts,
  type AvaEventFacts
} from "../src/domain/avaEventFacts.js";
import { avaConversationEvalCases } from "../src/evals/avaConversationCases.js";

function taipeiTime(localDateTime: string) {
  return new Date(`${localDateTime}+08:00`);
}

function copywritingFacts(): AvaEventFacts {
  return {
    schemaVersion: AVA_EVENT_FACTS_VERSION,
    eventTopic: "早餐店菜單文案改寫",
    concreteSubject: "一份早餐店外帶菜單的版面文案",
    facts: [
      { text: "菜單分成蛋餅、吐司和飲料三個區塊", earliestEventDay: 1, earliestStage: "before" },
      { text: "手寫菜名會和餐點照片放在同一欄", earliestEventDay: 1, earliestStage: "during" },
      { text: "價格最後統一放在每個品項的右側", earliestEventDay: 2, earliestStage: "after" }
    ],
    phases: [
      {
        phaseKey: "rewrite",
        eventDay: 1,
        activityMaterial: "先重寫蛋餅與吐司區塊的品項說明",
        activityEarliestStage: "during",
        completionResult: "第一天留下三個分類清楚的文案版本",
        completionEarliestStage: "after"
      },
      {
        phaseKey: "refine",
        eventDay: 2,
        activityMaterial: "逐項核對飲料名稱和右側價格的位置",
        activityEarliestStage: "during",
        completionResult: "菜名、照片與價格排列已經確定下來",
        completionEarliestStage: "after"
      }
    ]
  };
}

test("available recent conversations schedule replies between 20 and 90 seconds", () => {
  const now = taipeiTime("2026-07-22T12:30:00");
  const due = calculateReplyDueAt({ lifeContext: getAvaLifeContext(now), lastAssistantAt: now.toISOString(), now, random: () => 0.5 });
  const seconds = (new Date(due).getTime() - now.getTime()) / 1000;
  assert.ok(seconds >= 20 && seconds <= 90);
});

test("schedule-specific commute and work delays are used", () => {
  const commute = taipeiTime("2026-07-22T09:15:00");
  const commuteDue = calculateReplyDueAt({ lifeContext: getAvaLifeContext(commute), now: commute, random: () => 0.5 });
  const commuteMinutes = (new Date(commuteDue).getTime() - commute.getTime()) / 60_000;
  assert.ok(commuteMinutes >= 8 && commuteMinutes <= 20);

  const work = taipeiTime("2026-07-22T10:30:00");
  const workDue = calculateReplyDueAt({ lifeContext: getAvaLifeContext(work), now: work, random: () => 0.5 });
  const workMinutes = (new Date(workDue).getTime() - work.getTime()) / 60_000;
  assert.ok(workMinutes >= 15 && workMinutes <= 60);
});

test("sleeping replies are scheduled for the same upcoming 08:05 to 08:30 window", () => {
  const earlyMorning = taipeiTime("2026-07-22T02:00:00");
  const earliest = calculateReplyDueAt({ lifeContext: getAvaLifeContext(earlyMorning), now: earlyMorning, random: () => 0 });
  const latest = calculateReplyDueAt({ lifeContext: getAvaLifeContext(earlyMorning), now: earlyMorning, random: () => 1 });
  assert.equal(earliest, taipeiTime("2026-07-22T08:05:00").toISOString());
  assert.equal(latest, taipeiTime("2026-07-22T08:30:00").toISOString());
});

test("late personal-time replies that would cross midnight wait until morning", () => {
  const lateNight = taipeiTime("2026-07-22T23:59:00");
  const due = calculateReplyDueAt({ lifeContext: getAvaLifeContext(lateNight), now: lateNight, random: () => 0 });
  assert.equal(due, taipeiTime("2026-07-23T08:05:00").toISOString());
});

test("daily lives are deterministic and weekends only use relaxed profiles", () => {
  assert.equal(dailyLifeForDate("2026-07-22").key, dailyLifeForDate("2026-07-22").key);
  assert.notEqual(dailyLifeForDate("2026-07-22").key, "day-off");
  assert.ok(["light-work", "cafe-work", "day-off"].includes(dailyLifeForDate("2026-07-18").key));
  assert.equal(dailyLifeForDate("2026-07-18").key, "day-off");
});

test("schedule boundaries cover the full Taipei day without gaps", () => {
  const cases = [
    ["2026-07-22T00:00:00", "resting"],
    ["2026-07-22T07:59:59", "resting"],
    ["2026-07-22T08:00:00", "available"],
    ["2026-07-22T09:00:00", "busy"],
    ["2026-07-22T10:00:00", "busy"],
    ["2026-07-22T12:00:00", "available"],
    ["2026-07-22T13:30:00", "busy"],
    ["2026-07-22T17:30:00", "busy"],
    ["2026-07-22T19:00:00", "available"],
    ["2026-07-22T23:59:59", "available"],
    ["2026-07-23T00:00:00", "resting"]
  ] as const;
  for (const [time, availability] of cases) {
    assert.equal(getAvaLifeContext(taipeiTime(time)).availability, availability, time);
  }
});

test("day-off schedules never describe office work or commuting", () => {
  const life = dailyLifeForDate("2026-07-18");
  assert.equal(life.key, "day-off");
  assert.doesNotMatch(life.schedule.map((block) => block.activity).join(" "), /(公司|開會|通勤|上班)/);
});

test("proactive scheduling requires an available block with ten minutes remaining", () => {
  assert.equal(canScheduleAvaProactiveAt(getAvaLifeContext(taipeiTime("2026-07-22T12:30:00"))), true);
  assert.equal(canScheduleAvaProactiveAt(getAvaLifeContext(taipeiTime("2026-07-22T11:00:00"))), false);
  assert.equal(canScheduleAvaProactiveAt(getAvaLifeContext(taipeiTime("2026-07-22T07:30:00"))), false);
  assert.equal(canScheduleAvaProactiveAt(getAvaLifeContext(taipeiTime("2026-07-22T13:20:01"))), false);
});

test("relationship stages require both time and reply count", () => {
  const now = new Date("2026-07-22T00:00:00.000Z");
  assert.equal(relationshipStage("2026-07-01T00:00:00.000Z", 60, now), "familiar");
  assert.equal(relationshipStage("2026-06-01T00:00:00.000Z", 60, now), "close");
  assert.equal(relationshipStage("2026-07-20T00:00:00.000Z", 100, now), "new");
});

test("proactive messages respect quiet hours and pending messages", () => {
  const quietTime = new Date("2026-07-22T16:30:00.000Z"); // 00:30 Taipei
  assert.equal(shouldScheduleProactive({ level: "normal", pendingOrUnread: false, now: quietTime }), false);
  const daytime = new Date("2026-07-22T04:00:00.000Z"); // 12:00 Taipei
  assert.equal(shouldScheduleProactive({ level: "normal", pendingOrUnread: true, now: daytime }), false);
  assert.equal(shouldScheduleProactive({ level: "normal", pendingOrUnread: false, now: daytime }), true);
});

test("Ava memory extraction only keeps low-sensitive stable details", () => {
  assert.equal(extractSafeAvaMemory("我喜歡清淡一點的菜。"), "我喜歡清淡一點的菜");
  assert.equal(extractSafeAvaMemory("我有焦慮症，而且最近很難受。"), null);
  assert.equal(extractSafeAvaMemory("今天有點不開心。"), null);
});

test("Ava prompt discloses AI truthfully and includes shared life without claiming real actions", () => {
  const prompt = buildAvaInstructions({
    relationship: "new",
    receivedContext: "文案改寫第 1 天，今天活動進行中；正在改寫內容文案",
    currentActivity: "正在過自己的晚間時間，步調比較放鬆",
    currentTone: "剛放下工作，語氣慢慢鬆下來",
    eventContext: {
      title: "文案改寫",
      day: 1,
      stage: "after",
      stageLabel: "結束後",
      activity: "改寫一段內容文案",
      moodNote: "在不同句子之間找更剛好的語氣",
      background: "今天的改寫已經停筆，留下可以隔天再看的版本"
    },
    memories: ["我喜歡清淡一點的菜"],
    proactive: false
  });
  assert.match(prompt, /AI 虛擬朋友/);
  assert.match(prompt, /不要虛構現實世界的見面/);
  assert.match(prompt, /我喜歡清淡一點的菜/);
  assert.match(prompt, /最近一則訊息傳來時：文案改寫第 1 天/);
  assert.match(prompt, /目前：正在過自己的晚間時間/);
  assert.match(prompt, /今天的持續事件：文案改寫，事件第 1 天/);
  assert.match(prompt, /今天活動進度：結束後/);
  assert.match(prompt, /此刻適用的生活背景：今天的改寫已經停筆/);
  assert.match(prompt, /事件第幾天不代表此刻已完成/);
  assert.match(prompt, /不要每次報行程、重述背景/);
  assert.doesNotMatch(prompt, /今天共同的生活背景/);
  assert.doesNotMatch(prompt, /startMinute|endMinute|delayMinutes/);
});

test("Ava global event definitions balance work and life with a clear ending", () => {
  const events = listAvaEventDefinitions();
  assert.ok(events.length >= 10);
  assert.equal(events.filter((event) => event.category === "work").length, events.filter((event) => event.category === "life").length);
  for (const event of events) {
    assert.ok(event.durationDays === 2 || event.durationDays === 3, event.key);
    assert.ok(event.title.length > 0, event.key);
    assert.ok(event.anchorTerms.length > 0, event.key);
    assert.equal(event.phases.length, event.durationDays, event.key);
    assert.equal(getAvaEventPhase(event.key, event.durationDays).key, event.phases.at(-1)?.key);
    assert.ok(["complete", "transition"].includes(event.phases.at(-1)?.completion ?? ""), event.key);
    assert.doesNotMatch(
      event.phases.map((phase) => `${phase.activity} ${phase.moodNote} ${phase.scene} ${phase.visibleDetails.join(" ")}`).join(" "),
      /(朋友|家人|伴侶|同事|團隊|客戶|老師|醫生)/,
      event.key
    );
    for (const phase of event.phases) {
      assert.ok(phase.activityStartMinute >= 0, `${event.key}:${phase.key}`);
      assert.ok(phase.activityEndMinute <= 24 * 60, `${event.key}:${phase.key}`);
      assert.ok(phase.activityStartMinute < phase.activityEndMinute, `${event.key}:${phase.key}`);
      assert.ok(phase.beforeBackground.length > 0, `${event.key}:${phase.key}`);
      assert.ok(phase.duringBackground.length > 0, `${event.key}:${phase.key}`);
      assert.ok(phase.afterBackground.length > 0, `${event.key}:${phase.key}`);
      assert.ok(phase.visibleDetails.length > 0, `${event.key}:${phase.key}`);
      assert.ok(phase.scene.length > 0, `${event.key}:${phase.key}`);
      assert.ok(phase.progress.length > 0, `${event.key}:${phase.key}`);
    }
  }
});

test("every Ava event phase resolves before, during, and after without early completion", () => {
  for (const event of listAvaEventDefinitions()) {
    for (let eventDay = 1; eventDay <= event.durationDays; eventDay += 1) {
      const phase = getAvaEventPhase(event.key, eventDay);
      const before = resolveAvaEventMoment({
        eventKey: event.key,
        eventDay,
        minuteOfDay: Math.max(0, phase.activityStartMinute - 1),
        eventDetail: "這份每日細節只應在活動結束後出現。"
      });
      const atStart = resolveAvaEventMoment({ eventKey: event.key, eventDay, minuteOfDay: phase.activityStartMinute, eventDetail: "活動細節。" });
      const beforeEnd = resolveAvaEventMoment({ eventKey: event.key, eventDay, minuteOfDay: phase.activityEndMinute - 0.01, eventDetail: "活動細節。" });
      const atEnd = resolveAvaEventMoment({ eventKey: event.key, eventDay, minuteOfDay: phase.activityEndMinute, eventDetail: "活動結束後的每日細節。" });
      assert.equal(before.stage, "before", `${event.key}:${phase.key}:before`);
      assert.equal(atStart.stage, "during", `${event.key}:${phase.key}:start`);
      assert.equal(beforeEnd.stage, "during", `${event.key}:${phase.key}:before-end`);
      assert.equal(atEnd.stage, "after", `${event.key}:${phase.key}:end`);
      assert.doesNotMatch(before.background, /每日細節/);
      assert.doesNotMatch(atStart.background, /活動細節/);
      assert.match(atEnd.background, new RegExp(phase.afterBackground));
      assert.match(atEnd.background, /活動結束後的每日細節/);
    }
  }
});

test("a final event day is preparing in the morning and complete only after its activity", () => {
  const morning = resolveAvaEventMoment({ eventKey: "copywriting-sprint", eventDay: 2, minuteOfDay: 9 * 60, eventDetail: "文案最後版本已經定下。" });
  const evening = resolveAvaEventMoment({ eventKey: "copywriting-sprint", eventDay: 2, minuteOfDay: 19 * 60, eventDetail: "文案最後版本已經定下。" });
  assert.equal(morning.stage, "before");
  assert.doesNotMatch(morning.background, /已經定下/);
  assert.equal(evening.stage, "after");
  assert.match(evening.background, /已經定下/);
});

test("life events do not inherit an unrelated office or copywriting story", () => {
  const moment = resolveAvaEventMoment({ eventKey: "grocery-and-cooking", eventDay: 2, minuteOfDay: 18 * 60 });
  const prompt = buildAvaInstructions({
    relationship: "familiar",
    currentActivity: getAvaLifeContext(taipeiTime("2026-07-22T18:00:00")).currentActivity,
    currentTone: "剛結束白天的事情，語氣慢慢鬆下來",
    eventContext: moment,
    memories: [],
    proactive: true
  });
  assert.match(prompt, /補貨做飯/);
  assert.match(prompt, /正在廚房處理食材/);
  assert.doesNotMatch(prompt, /(公司|對稿|提案|文案)/);
});

test("Ava event selection is deterministic, avoids the last three runs, and rebalances categories", () => {
  const input = {
    startDate: "2026-07-25",
    recentEventKeys: ["brand-proposal-revision", "photo-final-pass", "copywriting-sprint"]
  };
  const first = selectNextAvaEvent(input);
  const again = selectNextAvaEvent(input);
  assert.equal(first.key, again.key);
  assert.ok(!input.recentEventKeys.includes(first.key));
  assert.equal(first.category, "life");
});

test("Ava event daily detail input includes concrete scene clues and a same-run previous detail", () => {
  const prompt = buildAvaEventDetailInput({
    eventKey: "copywriting-sprint",
    eventDay: 2,
    phaseKey: "refine",
    activity: "把文案讀過一遍後定下最後版本",
    moodNote: "不再那麼急，想讓它停在剛好的地方",
    eventTitle: "文案改寫",
    anchorTerms: ["文案", "句子", "段落"],
    scene: "從頭默讀一遍，把最後兩個句子的節奏換得更乾淨",
    visibleDetails: ["被標記的兩句話", "闔上的筆記本"],
    progress: "今天這段文字已經定下來，先把它留在這裡",
    completion: "complete",
    previousDetail: "昨天先把零散的句子重新排過一次。"
  });
  assert.match(prompt, /第 2 天/);
  assert.match(prompt, /文案改寫/);
  assert.match(prompt, /必須保留的事件錨點之一：文案、句子、段落/);
  assert.match(prompt, /昨天先把零散的句子/);
  assert.match(prompt, /可見線索：被標記的兩句話、闔上的筆記本/);
  assert.match(buildAvaEventDetailInstructions(), /匿名互動限店員、櫃台、路人或店家/);
  assert.match(buildAvaEventDetailInstructions(), /至少一個可觀察的小片刻/);
  assert.match(buildAvaEventDetailInstructions(), /不是生成當下的即時狀態/);
  assert.match(buildAvaEventDetailInstructions(), /避免「剛剛、現在、目前、已經/);
});

test("Ava event daily detail preserves event anchors and rejects relationships, direct address, and invalid lengths", () => {
  assert.equal(validateAvaEventDetail("把幾樣蔬菜放進購物籃後，櫃台結帳時又核對了一次袋裡的東西。", ["蔬菜", "食材"]), "把幾樣蔬菜放進購物籃後，櫃台結帳時又核對了一次袋裡的東西。");
  assert.equal(validateAvaEventDetail("把幾樣東西放進購物籃後，櫃台結帳時又核對了一次袋裡的東西。", ["蔬菜", "食材"]), null);
  assert.equal(validateAvaEventDetail("今天和朋友一起整理內容，心裡比較不急。"), null);
  assert.equal(validateAvaEventDetail("你今天可以陪我一起把內容整理好。"), null);
  assert.equal(validateAvaEventDetail("店員說「今天很熱」，把飲料放到桌邊。"), null);
  assert.equal(validateAvaEventDetail("今天先把內容重新排過一次。接著停下來看了看語氣。最後又改了幾句。"), null);
  assert.equal(validateAvaEventDetail("太短。"), null);
});

test("Ava keeps established event keys resolvable for existing global runs", () => {
  assert.equal(getAvaEventDefinition("copywriting-sprint").title, "文案改寫");
  assert.equal(getAvaEventDefinition("brand-proposal-revision").title, "品牌提案修改");
  assert.equal(getAvaEventDefinition("reset-weekend").title, "週末整理散步");
});

test("Ava event facts are structured, phase-aligned, and queryable", () => {
  const event = getAvaEventDefinition("copywriting-sprint");
  const facts = copywritingFacts();
  assert.deepEqual(parseAvaEventFacts(facts, event), facts);
  assert.match(buildAvaEventFactsInstructions(), /是什麼、有哪些、為什麼/);
  assert.match(buildAvaEventFactsInput(event, ["照片挑選：旅行照片小冊"]), /最近三條事件主題/);
  assert.equal((avaEventFactsJsonSchema(event).properties.phases as { minItems: number }).minItems, event.durationDays);

  const wrongPhase = structuredClone(facts);
  wrongPhase.phases[0]!.phaseKey = "refine";
  assert.equal(parseAvaEventFacts(wrongPhase, event), null);

  const relationship = structuredClone(facts);
  relationship.facts[0]!.text = "和朋友一起挑出三個菜單區塊";
  assert.equal(parseAvaEventFacts(relationship, event), null);

  const directAddress = structuredClone(facts);
  directAddress.facts[0]!.text = "想把這份菜單拿給你看看";
  assert.equal(parseAvaEventFacts(directAddress, event), null);

  const anonymousInteraction = structuredClone(facts);
  anonymousInteraction.facts[0]!.text = "店員把手寫菜名分成三個菜單區塊";
  assert.ok(parseAvaEventFacts(anonymousInteraction, event));
});

test("Ava event facts only become visible at their declared day and stage", () => {
  const facts = copywritingFacts();
  const beforeDayOne = visibleAvaEventFacts({ facts, eventDay: 1, stage: "before" });
  assert.ok(beforeDayOne.includes(facts.eventTopic));
  assert.ok(beforeDayOne.includes(facts.concreteSubject));
  assert.ok(beforeDayOne.includes(facts.facts[0]!.text));
  assert.ok(!beforeDayOne.includes(facts.facts[1]!.text));
  assert.ok(!beforeDayOne.includes(facts.phases[0]!.activityMaterial));

  const duringDayOne = visibleAvaEventFacts({ facts, eventDay: 1, stage: "during" });
  assert.ok(duringDayOne.includes(facts.facts[1]!.text));
  assert.ok(duringDayOne.includes(facts.phases[0]!.activityMaterial));
  assert.ok(!duringDayOne.includes(facts.phases[0]!.completionResult));
  assert.ok(!duringDayOne.includes(facts.facts[2]!.text));

  const afterDayTwo = visibleAvaEventFacts({ facts, eventDay: 2, stage: "after" });
  assert.ok(afterDayTwo.includes(facts.facts[2]!.text));
  assert.ok(afterDayTwo.includes(facts.phases[1]!.completionResult));
});

test("Ava event moments keep fixed completion context and append only visible facts", () => {
  const facts = copywritingFacts();
  const before = resolveAvaEventMoment({
    eventKey: "copywriting-sprint",
    eventDay: 2,
    minuteOfDay: 9 * 60,
    eventDetail: "價格已經全部確認完成。",
    eventFacts: facts
  });
  assert.doesNotMatch(before.background, /價格已經全部確認完成/);
  assert.doesNotMatch(before.background, /菜名、照片與價格排列已經確定下來/);

  const after = resolveAvaEventMoment({
    eventKey: "copywriting-sprint",
    eventDay: 2,
    minuteOfDay: 20 * 60,
    eventDetail: "價格已經全部確認完成。",
    eventFacts: facts
  });
  assert.match(after.background, /文案最後版本已經定下來/);
  assert.match(after.background, /價格已經全部確認完成/);
  assert.match(after.background, /菜名、照片與價格排列已經確定下來/);
});

test("Ava proactive context preserves the latest thirty roles, time, and proactive metadata", () => {
  const history = Array.from({ length: 32 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? "assistant" as const : "user" as const,
    content: `內容 ${index}`,
    proactive: index === 31,
    createdAt: new Date(Date.UTC(2026, 7, 2, 2, index)).toISOString(),
    readAt: null
  }));
  const input = buildAvaProactiveInput(history);
  assert.equal(input.length, 30);
  assert.equal(input[0]!.role, history[2]!.role);
  assert.match(input[0]!.content, /內容 2/);
  assert.match(input.at(-1)!.content, /Ava 主動傳送/);
});

test("Ava conversation evaluation baseline covers twenty multi-turn behaviors", () => {
  assert.ok(avaConversationEvalCases.length >= 20);
  assert.deepEqual(
    new Set(avaConversationEvalCases.map((item) => item.category)),
    new Set(["specific-follow-up", "daily-life", "emotional", "proactive"])
  );
  assert.ok(avaConversationEvalCases.filter((item) => item.category === "specific-follow-up").length >= 5);
  assert.ok(avaConversationEvalCases.filter((item) => item.category === "proactive").length >= 5);
  assert.ok(avaConversationEvalCases.every((item) => item.history.length > 0));
});

test("migration 018 protects event fact leases and service-role ownership", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/018_ava_event_facts.sql", import.meta.url), "utf8");
  assert.match(sql, /event_facts_status text not null default 'legacy'/);
  assert.match(sql, /event_facts_status\s*\n\s*\)\s*\n\s*values[\s\S]*?'pending'/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /interval '30 minutes'/);
  assert.match(sql, /event_facts_lease_expires_at > now\(\)/);
  assert.match(sql, /event_facts_lease_token = p_worker_token/);
  assert.match(sql, /revoke all on function public\.complete_ava_event_facts[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.complete_ava_event_facts[\s\S]*to service_role/);
});
