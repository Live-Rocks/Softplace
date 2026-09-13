import { z } from "zod";
import type { AvaEventActivityStage, AvaEventDefinition } from "./avaEvents.js";

export const AVA_EVENT_FACTS_VERSION = "ava_event_facts_v1" as const;

const stageSchema = z.enum(["before", "during", "after"]);

const eventFactSchema = z.object({
  text: z.string().trim().min(4).max(100),
  earliestEventDay: z.number().int().min(1).max(3),
  earliestStage: stageSchema
}).strict();

const phaseFactSchema = z.object({
  phaseKey: z.string().trim().min(1).max(100),
  eventDay: z.number().int().min(1).max(3),
  activityMaterial: z.string().trim().min(8).max(160),
  activityEarliestStage: z.literal("during"),
  completionResult: z.string().trim().min(8).max(160),
  completionEarliestStage: z.literal("after")
}).strict();

const avaEventFactsSchema = z.object({
  schemaVersion: z.literal(AVA_EVENT_FACTS_VERSION),
  eventTopic: z.string().trim().min(4).max(80),
  concreteSubject: z.string().trim().min(4).max(100),
  facts: z.array(eventFactSchema).min(3).max(5),
  phases: z.array(phaseFactSchema).min(2).max(3)
}).strict();

export type AvaEventFacts = z.infer<typeof avaEventFactsSchema>;

const forbiddenContent = /(朋友|家人|伴侶|男友|女友|同事|客戶|主管|老師|醫生|約會|使用者|你|妳|我們見面|傳訊息)/;
const stageOrder: Record<AvaEventActivityStage, number> = { before: 0, during: 1, after: 2 };

export function parseAvaEventFacts(value: unknown, event: AvaEventDefinition) {
  const parsed = avaEventFactsSchema.safeParse(value);
  if (!parsed.success) return null;
  const facts = parsed.data;
  if (facts.phases.length !== event.phases.length) return null;
  if (facts.facts.some((fact) => fact.earliestEventDay > event.durationDays)) return null;
  if (facts.phases.some((phase, index) => phase.phaseKey !== event.phases[index]?.key || phase.eventDay !== index + 1)) return null;
  const allText = [
    facts.eventTopic,
    facts.concreteSubject,
    ...facts.facts.map((fact) => fact.text),
    ...facts.phases.flatMap((phase) => [phase.activityMaterial, phase.completionResult])
  ];
  if (allText.some((text) => forbiddenContent.test(text))) return null;
  return facts;
}

export function visibleAvaEventFacts(input: {
  facts?: AvaEventFacts | null;
  eventDay: number;
  stage: AvaEventActivityStage;
}) {
  if (!input.facts) return [];
  const isVisible = (day: number, stage: AvaEventActivityStage) =>
    day < input.eventDay || (day === input.eventDay && stageOrder[stage] <= stageOrder[input.stage]);
  const visible = [input.facts.eventTopic, input.facts.concreteSubject];
  visible.push(...input.facts.facts.filter((fact) => isVisible(fact.earliestEventDay, fact.earliestStage)).map((fact) => fact.text));
  const phase = input.facts.phases[input.eventDay - 1];
  if (phase && isVisible(phase.eventDay, phase.activityEarliestStage)) visible.push(phase.activityMaterial);
  if (phase && isVisible(phase.eventDay, phase.completionEarliestStage)) visible.push(phase.completionResult);
  return [...new Set(visible)];
}

export function buildAvaEventFactsInstructions() {
  return `你正在替 AI 虛擬朋友 Ava 的一條全域虛構生活事件建立可沿用、可追問的事實設定。
輸出必須符合指定 JSON Schema。內容只依提供的事件骨架生成，不得使用或想像任何使用者資料。
替抽象活動選一個小而具體的主題，例如某類菜單、刊物、照片用途、房間區域或料理；事實要能直接回答「是什麼、有哪些、為什麼」。
每個 phase 的活動素材描述當天實際會處理什麼；完成結果只描述該 phase 結束後確立的結果。後續 phase 必須延續同一主題。
可以有店員、櫃台、路人或店家等一次性匿名互動。不得建立姓名、固定人物、朋友、家人、伴侶、同事、客戶、私人關係、約會、共同經歷或重大事件。
語氣自然具體，避免人生感悟，也不要反覆使用安靜、慢慢、收束、療癒、鬆一口氣等抽象詞。`;
}

export function buildAvaEventFactsInput(event: AvaEventDefinition, recentTopics: readonly string[]) {
  return [
    `事件 key：${event.key}`,
    `事件名稱：${event.title}`,
    `事件類型：${event.category}`,
    `共 ${event.durationDays} 天`,
    `事件錨點：${event.anchorTerms.join("、")}`,
    "每日骨架：",
    ...event.phases.map((phase, index) => `${index + 1}. ${phase.key}｜${phase.activity}｜${phase.scene}｜結束方向：${phase.progress}`),
    recentTopics.length ? `最近三條事件主題，請避開相似內容：${recentTopics.join("；")}` : "目前沒有近期事件主題。"
  ].join("\n");
}

export function avaEventFactsJsonSchema(event: AvaEventDefinition) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "eventTopic", "concreteSubject", "facts", "phases"],
    properties: {
      schemaVersion: { type: "string", enum: [AVA_EVENT_FACTS_VERSION] },
      eventTopic: { type: "string", minLength: 4, maxLength: 80 },
      concreteSubject: { type: "string", minLength: 4, maxLength: 100 },
      facts: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "earliestEventDay", "earliestStage"],
          properties: {
            text: { type: "string", minLength: 4, maxLength: 100 },
            earliestEventDay: { type: "integer", minimum: 1, maximum: event.durationDays },
            earliestStage: { type: "string", enum: ["before", "during", "after"] }
          }
        }
      },
      phases: {
        type: "array",
        minItems: event.durationDays,
        maxItems: event.durationDays,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["phaseKey", "eventDay", "activityMaterial", "activityEarliestStage", "completionResult", "completionEarliestStage"],
          properties: {
            phaseKey: { type: "string", enum: event.phases.map((phase) => phase.key) },
            eventDay: { type: "integer", minimum: 1, maximum: event.durationDays },
            activityMaterial: { type: "string", minLength: 8, maxLength: 160 },
            activityEarliestStage: { type: "string", enum: ["during"] },
            completionResult: { type: "string", minLength: 8, maxLength: 160 },
            completionEarliestStage: { type: "string", enum: ["after"] }
          }
        }
      }
    }
  };
}

export function buildLocalAvaEventFacts(event: AvaEventDefinition): AvaEventFacts {
  return {
    schemaVersion: AVA_EVENT_FACTS_VERSION,
    eventTopic: `${event.title}的具體測試主題`,
    concreteSubject: `一份和${event.anchorTerms[0] ?? event.title}有關的測試素材`,
    facts: [
      { text: `素材保留了${event.anchorTerms[0] ?? "事件"}的主要內容`, earliestEventDay: 1, earliestStage: "before" },
      { text: "先從三個清楚的小項目開始處理", earliestEventDay: 1, earliestStage: "during" },
      { text: "最後留下可直接說明的完成版本", earliestEventDay: event.durationDays, earliestStage: "after" }
    ],
    phases: event.phases.map((phase, index) => ({
      phaseKey: phase.key,
      eventDay: index + 1,
      activityMaterial: `${phase.activity}時使用明確的測試素材`,
      activityEarliestStage: "during",
      completionResult: `${phase.activity}在當天結束後已有明確結果`,
      completionEarliestStage: "after"
    }))
  };
}
