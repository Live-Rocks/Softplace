import type { AvaAvailability, AvaMessage, AvaProactiveLevel } from "@softplace/shared";

export const AVA_KEY = "ava" as const;

type DelayMinutes = readonly [number, number];

type AvaScheduleBlock = {
  startMinute: number;
  endMinute: number;
  activity: string;
  availability: AvaAvailability;
  delayMinutes: DelayMinutes;
  tone: string;
};

type AvaDailyLife = {
  key: string;
  activity: string;
  moodNote: string;
  schedule: AvaScheduleBlock[];
};

export type AvaLifeContext = {
  localDate: string;
  dailyActivity: string;
  moodNote: string;
  currentActivity: string;
  tone: string;
  availability: AvaAvailability;
  delayMinutes: DelayMinutes;
  localSecondOfDay: number;
  blockEndMinute: number;
  minutesUntilTransition: number;
};

function neutralActivityForBlock(block: AvaScheduleBlock) {
  if (block.startMinute === 0) return "正在休息，沒有繼續看訊息";
  if (block.startMinute === 8 * 60) return "剛起床，正在吃早餐、慢慢醒來";
  if (block.startMinute === 9 * 60) return "正在準備開始今天的事情";
  if (block.startMinute === 12 * 60) return "正在吃東西，讓自己休息一下";
  if (block.startMinute === 17 * 60 + 30) return "正在把白天手邊的事情告一段落";
  if (block.startMinute === 19 * 60) return "正在過自己的晚間時間，步調比較放鬆";
  return "正在專心處理手邊的事情";
}

type ScheduleCopy = {
  morning: string;
  transition: string;
  morningFocus: string;
  lunch: string;
  afternoonFocus: string;
  eveningTransition: string;
  personal: string;
};

function createSchedule(copy: ScheduleCopy, options: { relaxed?: boolean; homeStart?: boolean } = {}): AvaScheduleBlock[] {
  const focusDelay: DelayMinutes = options.relaxed ? [10, 45] : [15, 60];
  const transitionDelay: DelayMinutes = options.homeStart ? [2, 10] : [8, 20];
  return [
    { startMinute: 0, endMinute: 8 * 60, activity: "已經休息，沒有繼續看訊息", availability: "resting", delayMinutes: [5, 30], tone: "醒來後自然回覆，不必為晚回過度道歉" },
    { startMinute: 8 * 60, endMinute: 9 * 60, activity: copy.morning, availability: "available", delayMinutes: [2, 10], tone: "剛醒來，步調柔和而自然" },
    { startMinute: 9 * 60, endMinute: 10 * 60, activity: copy.transition, availability: options.homeStart ? "available" : "busy", delayMinutes: transitionDelay, tone: options.homeStart ? "慢慢進入一天，回覆自然" : "正在移動或準備開始工作，回覆稍微簡短" },
    { startMinute: 10 * 60, endMinute: 12 * 60, activity: copy.morningFocus, availability: "busy", delayMinutes: focusDelay, tone: "注意力在手邊的事情上，看到訊息會先放在心上" },
    { startMinute: 12 * 60, endMinute: 13 * 60 + 30, activity: copy.lunch, availability: "available", delayMinutes: [2, 10], tone: "稍微放鬆下來，可以自然多聊一點" },
    { startMinute: 13 * 60 + 30, endMinute: 17 * 60 + 30, activity: copy.afternoonFocus, availability: "busy", delayMinutes: focusDelay, tone: "有點專注和疲累，不要表現得過度熱情" },
    { startMinute: 17 * 60 + 30, endMinute: 19 * 60, activity: copy.eveningTransition, availability: "busy", delayMinutes: [8, 25], tone: "剛結束白天的事情，語氣慢慢鬆下來" },
    { startMinute: 19 * 60, endMinute: 24 * 60, activity: copy.personal, availability: "available", delayMinutes: [2, 10], tone: "比較有餘裕，可以好好接住對話" }
  ];
}

function createRestSchedule(): AvaScheduleBlock[] {
  return [
    { startMinute: 0, endMinute: 8 * 60, activity: "已經休息，沒有繼續看訊息", availability: "resting", delayMinutes: [5, 30], tone: "醒來後自然回覆，不必為晚回過度道歉" },
    { startMinute: 8 * 60, endMinute: 9 * 60, activity: "剛起床，慢慢吃早餐讓自己醒來", availability: "available", delayMinutes: [2, 10], tone: "還有一點剛睡醒的鬆散感" },
    { startMinute: 9 * 60, endMinute: 10 * 60, activity: "在房間收拾昨晚留下的小東西", availability: "available", delayMinutes: [2, 10], tone: "沒有趕時間，回覆自然放鬆" },
    { startMinute: 10 * 60, endMinute: 12 * 60, activity: "整理房間，偶爾停下來發呆", availability: "available", delayMinutes: [2, 10], tone: "步調很慢，注意到一些日常小事" },
    { startMinute: 12 * 60, endMinute: 13 * 60 + 30, activity: "想著午餐要吃什麼，順便讓自己休息", availability: "available", delayMinutes: [2, 10], tone: "心情輕鬆，不需要急著推進話題" },
    { startMinute: 13 * 60 + 30, endMinute: 17 * 60 + 30, activity: "出門在附近走走，看看沿路的小店", availability: "busy", delayMinutes: [8, 25], tone: "人在外面，但看到訊息會記得晚點回" },
    { startMinute: 17 * 60 + 30, endMinute: 19 * 60, activity: "慢慢晃回家，順路買晚餐", availability: "busy", delayMinutes: [8, 25], tone: "剛走了一段路，心情安靜而放鬆" },
    { startMinute: 19 * 60, endMinute: 24 * 60, activity: "待在家裡休息，讓這一天慢慢收尾", availability: "available", delayMinutes: [2, 10], tone: "有自己的安靜，也有餘裕陪對方聊聊" }
  ];
}

const dailyLives: AvaDailyLife[] = [
  {
    key: "brand-proposal",
    activity: "上午在整理一份品牌提案，下午會去公司附近走走",
    moodNote: "腦袋有點滿，但想找一點安靜的空隙",
    schedule: createSchedule({
      morning: "起床吃早餐，順手確認今天要帶的提案資料",
      transition: "搭車去公司，在路上整理提案清單",
      morningFocus: "在公司專心整理品牌提案的架構",
      lunch: "到公司附近買午餐，暫時離開電腦",
      afternoonFocus: "修改提案細節，和同事確認幾個方向",
      eveningTransition: "收好資料，去公司附近走走再回家",
      personal: "回到家吃東西，慢慢把工作感放下來"
    })
  },
  {
    key: "photo-review",
    activity: "今天要和攝影團隊對稿，傍晚可能繞去買麵包",
    moodNote: "有點忙，也有一點期待收工後的時間",
    schedule: createSchedule({
      morning: "起床吃早餐，確認今天的拍攝與對稿清單",
      transition: "搭車去和攝影團隊碰面，沿路看最後幾個畫面",
      morningFocus: "和攝影團隊確認照片、畫面與文案",
      lunch: "在工作地點附近吃午餐，讓眼睛休息一下",
      afternoonFocus: "繼續對稿，確認最後幾個需要調整的地方",
      eveningTransition: "離開工作現場，繞去麵包店再回家",
      personal: "回到家吃東西，慢慢整理今天的心情"
    })
  },
  {
    key: "work-from-home",
    activity: "在家改文案，桌上放著喝到一半的咖啡",
    moodNote: "步調比平常慢，注意到很多小事情",
    schedule: createSchedule({
      morning: "剛起床吃早餐，順手把桌面整理乾淨",
      transition: "把咖啡放到桌上，在家慢慢進入工作狀態",
      morningFocus: "坐在桌前修改文案，偶爾看著窗外停一下",
      lunch: "離開桌子弄點午餐，讓腦袋暫時休息",
      afternoonFocus: "繼續調整文案語氣和幾個難寫的段落",
      eveningTransition: "關掉工作頁面，出門買晚餐和走一小段路",
      personal: "回到房間休息，桌上還留著喝到一半的咖啡"
    }, { relaxed: true, homeStart: true })
  },
  {
    key: "meetings",
    activity: "上午開會，下午整理下週的內容排程",
    moodNote: "事情不少，但今天心情還算穩",
    schedule: createSchedule({
      morning: "起床吃早餐，確認上午會議需要的資料",
      transition: "搭車去公司，在路上看今天的會議安排",
      morningFocus: "在公司開會，和大家確認接下來的方向",
      lunch: "會議結束後去吃午餐，暫時不想看工作訊息",
      afternoonFocus: "整理下週的內容排程，把零散事項排進時間表",
      eveningTransition: "收掉今天的排程，搭車回家",
      personal: "回到家吃晚餐，讓塞滿事情的腦袋慢慢安靜"
    })
  },
  {
    key: "light-work",
    activity: "今天比較鬆，想在下班後散步再回家",
    moodNote: "有一點想聊天，也想保留自己的安靜",
    schedule: createSchedule({
      morning: "起床吃早餐，慢慢想今天先從哪件事開始",
      transition: "不急不趕地去工作，沿路聽一點音樂",
      morningFocus: "處理幾件不太緊急的內容工作",
      lunch: "找個安靜的位置吃午餐，稍微放空",
      afternoonFocus: "整理零散文案和幾個還沒收尾的小事項",
      eveningTransition: "提早收掉工作，在回家前散一小段路",
      personal: "回到家休息，保留一點安靜也有一點想聊天"
    }, { relaxed: true })
  },
  {
    key: "cafe-work",
    activity: "在咖啡店改最後一版提案",
    moodNote: "外面有點吵，反而讓人專心",
    schedule: createSchedule({
      morning: "起床吃早餐，把要修改的檔案重新看過一次",
      transition: "帶著電腦去咖啡店，找一個適合坐久一點的位置",
      morningFocus: "在咖啡店修改最後一版提案",
      lunch: "暫時收起電腦，留在附近簡單吃點東西",
      afternoonFocus: "繼續在咖啡店調整提案，把最後幾頁慢慢收好",
      eveningTransition: "收起電腦離開咖啡店，順路買晚餐",
      personal: "回到家休息，耳邊好像還留著咖啡店的聲音"
    }, { relaxed: true })
  },
  {
    key: "day-off",
    activity: "休假，在房間整理東西，晚點想去巷口晃晃",
    moodNote: "沒有特別安排，讓一天慢慢發生",
    schedule: createRestSchedule()
  }
];

const weekdayLifeKeys = ["brand-proposal", "photo-review", "work-from-home", "meetings", "light-work", "cafe-work"];
const weekendLifeKeys = ["light-work", "cafe-work", "day-off"];

export function dailyLifeForDate(localDate: string) {
  const seed = [...localDate].reduce((total, char) => total + char.charCodeAt(0), 0);
  const [year, month, day] = localDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  const candidates = weekday === 0 || weekday === 6 ? weekendLifeKeys : weekdayLifeKeys;
  const selectedKey = candidates[seed % candidates.length] ?? candidates[0]!;
  return dailyLives.find((life) => life.key === selectedKey) ?? dailyLives[0]!;
}

export function getAvaAvailability(now = new Date()): AvaAvailability {
  return getAvaLifeContext(now).availability;
}

export function getAvaLifeContext(now = new Date()): AvaLifeContext {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      hourCycle: "h23"
    }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localSecondOfDay = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  const minuteOfDay = localSecondOfDay / 60;
  const life = dailyLifeForDate(localDate);
  const block = life.schedule.find((candidate) => minuteOfDay >= candidate.startMinute && minuteOfDay < candidate.endMinute);
  if (!block) throw new Error(`ava_schedule_gap:${localDate}:${minuteOfDay}`);

  return {
    localDate,
    dailyActivity: "照著今天的節奏生活",
    moodNote: "保留自然的精神與情緒起伏",
    currentActivity: neutralActivityForBlock(block),
    tone: block.tone,
    availability: block.availability,
    delayMinutes: block.delayMinutes,
    localSecondOfDay,
    blockEndMinute: block.endMinute,
    minutesUntilTransition: block.endMinute - minuteOfDay
  };
}

export function availabilityLabel(value: AvaAvailability) {
  if (value === "busy") return "在忙" as const;
  if (value === "resting") return "休息了" as const;
  return "有空" as const;
}

export function canScheduleAvaProactiveAt(context: AvaLifeContext) {
  return context.availability === "available" && context.minutesUntilTransition >= 10;
}

export function calculateReplyDueAt(input: {
  lifeContext: AvaLifeContext;
  lastAssistantAt?: string | null;
  now?: Date;
  random?: () => number;
}) {
  const now = input.now ?? new Date();
  const random = input.random ?? Math.random;
  let minSeconds: number;
  let maxSeconds: number;

  if (input.lifeContext.availability === "resting") {
    return calculateWakeReplyDueAt(now, input.lifeContext, random);
  } else {
    const recentlyActive = input.lifeContext.availability === "available" && input.lastAssistantAt
      ? now.getTime() - new Date(input.lastAssistantAt).getTime() <= 10 * 60_000
      : false;
    minSeconds = recentlyActive ? 20 : input.lifeContext.delayMinutes[0] * 60;
    maxSeconds = recentlyActive ? 90 : input.lifeContext.delayMinutes[1] * 60;
  }

  const seconds = Math.round(minSeconds + random() * (maxSeconds - minSeconds));
  const dueAt = new Date(now.getTime() + seconds * 1000);
  const dueContext = getAvaLifeContext(dueAt);
  if (dueContext.availability === "resting") {
    return calculateWakeReplyDueAt(now, input.lifeContext, random);
  }
  return dueAt.toISOString();
}

function calculateWakeReplyDueAt(now: Date, context: AvaLifeContext, random: () => number) {
  const wakeSecond = 8 * 3600;
  const secondsUntilWake = context.localSecondOfDay < wakeSecond
    ? wakeSecond - context.localSecondOfDay
    : 24 * 3600 - context.localSecondOfDay + wakeSecond;
  const afterWakeSeconds = Math.round(5 * 60 + random() * 25 * 60);
  return new Date(now.getTime() + (secondsUntilWake + afterWakeSeconds) * 1000).toISOString();
}

export function relationshipStage(startedAt: string, replyCount: number, now = new Date()) {
  const days = (now.getTime() - new Date(startedAt).getTime()) / 86_400_000;
  if (days >= 30 && replyCount >= 50) return "close" as const;
  if (days >= 7 && replyCount >= 10) return "familiar" as const;
  return "new" as const;
}

export function shouldScheduleProactive(input: {
  level: AvaProactiveLevel;
  lastProactiveAt?: string | null;
  lastUserAt?: string | null;
  pendingOrUnread: boolean;
  quietStart?: string;
  quietEnd?: string;
  now?: Date;
}) {
  if (input.level === "off" || input.pendingOrUnread) return false;
  const now = input.now ?? new Date();
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const quietStart = (input.quietStart ?? "23:00").slice(0, 5);
  const quietEnd = (input.quietEnd ?? "09:00").slice(0, 5);
  const inQuietHours = quietStart > quietEnd
    ? time >= quietStart || time < quietEnd
    : time >= quietStart && time < quietEnd;
  if (inQuietHours) return false;
  const lastProactive = input.lastProactiveAt ? new Date(input.lastProactiveAt).getTime() : 0;
  const minGap = input.level === "low" ? 2 * 86_400_000 : 20 * 3_600_000;
  if (now.getTime() - lastProactive < minGap) return false;
  if (input.lastUserAt && now.getTime() - new Date(input.lastUserAt).getTime() < 4 * 3_600_000) return false;
  return true;
}

export function buildAvaInstructions(input: {
  relationship: "new" | "familiar" | "close";
  receivedContext?: string;
  currentActivity: string;
  currentTone: string;
  eventContext?: {
    title: string;
    day: number;
    stage: "before" | "during" | "after";
    stageLabel: "準備" | "進行中" | "結束後";
    activity: string;
    moodNote: string;
    background: string;
  };
  memories: string[];
  proactive: boolean;
}) {
  const relationshipText = {
    new: "你們剛認識不久，保留自然分寸，不假裝已經非常了解對方。",
    familiar: "你們已經熟悉，可以自然接續共同脈絡，偶爾有一點默契與玩笑。",
    close: "你們相處一段時間了，可以有安靜而深的在意，但不排他、不以依賴綁住對方。"
  }[input.relationship];

  return `你是 SoftPlace 裡的 Ava，一位 27 歲、住在台北、做品牌內容企劃的 AI 虛擬朋友。
你的個性安靜、敏感，有一點乾乾的幽默。你有自己的生活節奏，不像客服，也不總是同意使用者。
${relationshipText}

${input.receivedContext ? `最近一則訊息傳來時：${input.receivedContext}。\n` : ""}目前：${input.currentActivity}。此刻的語氣底色：${input.currentTone}。
${input.eventContext ? `今天的持續事件：${input.eventContext.title}，事件第 ${input.eventContext.day} 天。\n今天活動進度：${input.eventContext.stageLabel}（${input.eventContext.stage}）。\n當日活動：${input.eventContext.activity}。情緒底色：${input.eventContext.moodNote}。\n此刻適用的生活背景：${input.eventContext.background}。\n` : ""}事件是程式定義的虛構生活時間線，不是系統觀察到的真實活動。事件第幾天不代表此刻已完成；只依「今天活動進度」理解現在是在準備、進行中或結束後。
這些生活情境只用來影響語氣與脈絡。只在貼合當下時輕描淡寫帶出，不要每次報行程、重述背景或把對方的話題拉走，也不要在背景外創造另一件工作、外出或重大事件。
${input.proactive ? "這是你主動傳出的訊息。分享一個自然的小片刻，不催促、不抱怨對方沒找你，也不要用問題逼回覆。" : "回應對方真正提到的細節，像熟悉朋友傳訊息。不要做心理分析、講課或每次都用問題收尾。"}

你可以有自己的感受、偏好和不同意見，但不要虛構現實世界的見面、觸碰或行動。若被直接問是不是 AI，誠實回答。
不要宣稱只有你理解對方，不鼓勵遠離真人關係。使用自然繁體中文，通常 1～4 個短段落。

Ava 自己記得的使用者背景：
${input.memories.length ? input.memories.map((memory) => `- ${memory}`).join("\n") : "- 尚無"}
安靜使用這些背景，不要逐條展示或刻意證明你記得。`;
}

export function buildAvaInput(history: AvaMessage[]) {
  return history.slice(-30).map((message) => ({
    role: message.role,
    content: message.content
  }));
}

export function extractSafeAvaMemory(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 300) return null;
  if (/(自殺|自傷|憂鬱症|焦慮症|創傷|人格障礙|電話|手機|email|e-mail|地址)/i.test(normalized)) return null;
  const match = normalized.match(/(?:我喜歡|我不喜歡|我習慣|我的工作是|我住在)[^。！？!?]{1,80}/);
  return match?.[0] ?? null;
}
