import crypto from "node:crypto";
import OpenAI, { APIConnectionTimeoutError } from "openai";
import type { AiProvider, CompanionMode, Message } from "@softplace/shared";
import { config } from "../config.js";
import { buildAvaEventDetailInstructions, validateAvaEventDetail } from "../domain/avaEvents.js";
import {
  avaEventFactsJsonSchema,
  buildAvaEventFactsInstructions,
  buildLocalAvaEventFacts,
  parseAvaEventFacts,
  type AvaEventFacts
} from "../domain/avaEventFacts.js";
import type { AvaEventDefinition } from "../domain/avaEvents.js";

const client = config.openAiApiKey
  ? new OpenAI({
      apiKey: config.openAiApiKey,
      timeout: config.openAiTimeoutMs,
      maxRetries: config.openAiMaxRetries
    })
  : null;

export type GenerateCompanionReplyInput = {
  userId: string;
  model: string;
  mode: CompanionMode;
  instructions: string;
  history: Message[];
  userMessage: string;
  retrievalContext?: string;
  imageBase64?: string;
  imageMimeType?: string;
};

export type GeneratedCompanionReply = {
  content: string;
  provider: AiProvider;
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
};

export class CompanionProviderError extends Error {
  constructor(cause: unknown) {
    super("陪伴服務暫時無法回覆，這次不會扣除額度。請稍後再試。", { cause });
    this.name = "CompanionProviderError";
  }
}

export class CompanionProviderTimeoutError extends Error {
  constructor(cause: unknown) {
    super("這次回覆等得太久，沒有扣除額度，請再試一次。", { cause });
    this.name = "CompanionProviderTimeoutError";
  }
}

export async function generateCompanionReply(input: GenerateCompanionReplyInput): Promise<GeneratedCompanionReply> {
  if (config.aiProvider === "local") {
    return {
      content: buildDevReply(input.userMessage, Boolean(input.imageBase64), input.mode),
      provider: "local"
    };
  }

  if (!client) {
    throw new CompanionProviderError(new Error("OPENAI_API_KEY is not configured"));
  }

  const recentMessages = buildRecentMessages(input.history);

  const userContent: Array<Record<string, unknown>> = [{ type: "input_text", text: input.userMessage }];
  if (input.imageBase64 && input.imageMimeType) {
    userContent.push({
      type: "input_image",
      image_url: `data:${input.imageMimeType};base64,${input.imageBase64}`
    });
  }

  try {
    const payload = {
      model: input.model,
      instructions: input.instructions,
      input: [
        ...recentMessages,
        ...(input.retrievalContext
          ? [{ role: "user" as const, content: [{ type: "input_text", text: input.retrievalContext }] }]
          : []),
        {
          role: "user",
          content: userContent
        }
      ],
      store: config.openAiStoreResponses,
      safety_identifier: hashUserId(input.userId)
    };

    if (config.openAiDebugIo) {
      console.info(
        "OPENAI_REQUEST",
        JSON.stringify(
          {
            model: payload.model,
            mode: input.mode,
            store: payload.store,
            instructions: payload.instructions,
            input: redactImagesForDebug(payload.input)
          },
          null,
          2
        )
      );
    }

    const response = await client.responses.create(payload as any);

    if (config.openAiDebugIo) {
      console.info(
        "OPENAI_RESPONSE",
        JSON.stringify(
          {
            id: response.id,
            requestId: (response as any)._request_id,
            outputText: JSON.stringify(response.output_text ?? "")
          },
          null,
          2
        )
      );
    }

    return {
      content: response.output_text?.trim() || "我在，先陪你停一下。你可以再多跟我說一點點。",
      provider: "openai",
      usage: response.usage ? {
        inputTokens: response.usage.input_tokens,
        cachedInputTokens: response.usage.input_tokens_details.cached_tokens,
        outputTokens: response.usage.output_tokens
      } : undefined
    };
  } catch (error) {
    if (error instanceof APIConnectionTimeoutError) {
      throw new CompanionProviderTimeoutError(error);
    }
    throw new CompanionProviderError(error);
  }
}

export async function generateAvaReply(input: {
  userId: string;
  instructions: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}) {
  if (config.aiProvider === "local") {
    return "剛剛看到你傳來的訊息了。今天這邊有點忙亂，但我想先停一下回你。";
  }
  if (!client) throw new CompanionProviderError(new Error("OPENAI_API_KEY is not configured"));

  try {
    const response = await client.responses.create({
      model: config.openAiLifeModel,
      instructions: input.instructions,
      input: input.messages,
      store: config.openAiStoreResponses,
      safety_identifier: hashUserId(input.userId)
    } as any);
    const content = response.output_text?.trim();
    if (!content) throw new Error("empty_ava_response");
    return content;
  } catch (error) {
    if (error instanceof APIConnectionTimeoutError) throw new CompanionProviderTimeoutError(error);
    throw new CompanionProviderError(error);
  }
}

export async function generateAvaEventDetail(input: {
  activity: string;
  moodNote: string;
  anchorTerms: readonly string[];
  prompt: string;
}) {
  if (config.aiProvider === "local") {
    return `今天慢慢處理${input.activity}，眼前還留著${input.anchorTerms[0] ?? "手邊的事"}，心裡是${input.moodNote}。`;
  }
  if (!client) throw new CompanionProviderError(new Error("OPENAI_API_KEY is not configured"));

  try {
    const response = await client.responses.create({
      model: config.openAiLifeModel,
      instructions: buildAvaEventDetailInstructions(),
      input: [{ role: "user", content: input.prompt }],
      store: config.openAiStoreResponses,
      safety_identifier: hashUserId("ava-global-event")
    } as any);
    const detail = validateAvaEventDetail(response.output_text ?? "", input.anchorTerms);
    if (!detail) throw new Error("invalid_ava_event_detail");
    return detail;
  } catch (error) {
    if (error instanceof APIConnectionTimeoutError) throw new CompanionProviderTimeoutError(error);
    throw new CompanionProviderError(error);
  }
}

export async function generateAvaEventFacts(input: {
  event: AvaEventDefinition;
  prompt: string;
}): Promise<AvaEventFacts> {
  if (config.aiProvider === "local") return buildLocalAvaEventFacts(input.event);
  if (!client) throw new CompanionProviderError(new Error("OPENAI_API_KEY is not configured"));

  try {
    const response = await client.responses.create({
      model: config.openAiLifeModel,
      instructions: buildAvaEventFactsInstructions(),
      input: [{ role: "user", content: input.prompt }],
      text: {
        format: {
          type: "json_schema",
          name: "ava_event_facts",
          strict: true,
          schema: avaEventFactsJsonSchema(input.event)
        }
      },
      store: config.openAiStoreResponses,
      safety_identifier: hashUserId("ava-global-event-facts")
    } as any);
    const raw = response.output_text?.trim();
    if (!raw) throw new Error("empty_ava_event_facts");
    const facts = parseAvaEventFacts(JSON.parse(raw), input.event);
    if (!facts) throw new Error("invalid_ava_event_facts");
    return facts;
  } catch (error) {
    if (error instanceof APIConnectionTimeoutError) throw new CompanionProviderTimeoutError(error);
    throw new CompanionProviderError(error);
  }
}

export function buildRecentMessages(history: Message[]) {
  return history.slice(-10).map((message) => ({
    role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: message.content
  }));
}

export function redactImagesForDebug(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactImagesForDebug(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (key === "image_url" && typeof item === "string") {
        const mime = item.match(/^data:([^;]+);base64,/)?.[1] ?? "unknown";
        return [key, `[image omitted: ${mime}]`];
      }
      return [key, redactImagesForDebug(item)];
    })
  );
}

function buildDevReply(userMessage: string, hasImage: boolean, mode: CompanionMode) {
  const imageLine = hasImage
    ? "我有收到你傳來的圖片。比起急著分析畫面，我更在意它讓你心裡冒出了什麼感覺。"
    : "";
  const modeLine = mode === "light" ? "我現在先用比較輕量的方式陪你，但不會突然把你丟下。" : "";

  return [
    "我聽見你了。你現在好像真的有點累，也可能有一些說不清楚的委屈。",
    imageLine,
    "我們先不用急著把事情整理好，也不用馬上變得很正向。你可以先把這一刻放在這裡，我會慢慢聽。",
    "如果可以，先陪我做一個很小的動作：把腳踩在地上，吸一口氣，然後告訴我現在最重的是哪一塊。",
    modeLine
  ]
    .filter(Boolean)
    .join("\n\n");
}

function hashUserId(userId: string) {
  return crypto.createHash("sha256").update(userId).digest("hex");
}
