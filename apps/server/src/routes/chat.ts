import { Router } from "express";
import { z } from "zod";
import type { ChatResponse } from "@softplace/shared";
import { config } from "../config.js";
import { buildCompanionInstructions } from "../domain/companionPrompt.js";
import {
  RETRIEVAL_GENERATION,
  buildGenerationManifest,
  buildGenerationQuery,
  countTokens
} from "../domain/retrievalGeneration.js";
import { suggestMemoriesFromUserText } from "../domain/memory.js";
import { assessCrisis, buildCrisisResponse } from "../domain/safety.js";
import { decideCompanionMode } from "../domain/usage.js";
import {
  CompanionProviderError,
  CompanionProviderTimeoutError,
  generateCompanionReply,
  type GenerateCompanionReplyInput,
  type GeneratedCompanionReply
} from "../integrations/openai.js";
import type { Repository } from "../types.js";
import { enqueueRetrievalShadowJob, retrievalShadowEnabledFor } from "../integrations/retrievalShadow.js";
import {
  recordGenerationRun,
  retrievalGenerationEnabledFor,
  retrieveForGeneration,
  type GenerationRetriever,
  type GenerationRunRecorder,
  type GenerationRetrievalResult
} from "../integrations/retrievalGeneration.js";

const chatSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  requestedMode: z.enum(["light", "deep"]).default("light"),
  entryIntent: z.string().trim().max(80).optional(),
  imageBase64: z.string().max(7_500_000).optional(),
  imageMimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional()
});

type ReplyGenerator = (input: GenerateCompanionReplyInput) => Promise<GeneratedCompanionReply>;
type ShadowEnqueuer = (userId: string, conversationId: string, queryMessageId: string) => Promise<unknown>;

export function chatRouter(
  repository: Repository,
  generateReply: ReplyGenerator = generateCompanionReply,
  enqueueShadow: ShadowEnqueuer = enqueueRetrievalShadowJob,
  retrieveGeneration: GenerationRetriever = retrieveForGeneration,
  recordGeneration: GenerationRunRecorder = recordGenerationRun
) {
  const router = Router();

  router.post("/", async (req, res, next) => {
    try {
      const body = chatSchema.parse(req.body);
      const hasImage = Boolean(body.imageBase64);
      const user = req.user;
      const crisis = assessCrisis(body.message);

      if (crisis.crisisDetected) {
        const [usage, conversation] = await Promise.all([
          repository.getUsage(user.id, user.plan),
          repository.getOrCreatePrimaryConversation(user.id)
        ]);
        await repository.createMessage({
          conversationId: conversation.id,
          role: "user",
          content: body.message,
          imagePresent: hasImage,
          crisisDetected: true
        });
        const assistantMessage = await repository.createMessage({
          conversationId: conversation.id,
          role: "assistant",
          content: buildCrisisResponse(body.message),
          modelUsed: "crisis-mode",
          mode: "light",
          crisisDetected: true
        });
        await repository.touchConversation(user.id, conversation.id);
        const response: ChatResponse = {
          conversationId: conversation.id,
          assistantMessage,
          usage,
          mode: "light",
          modelUsed: "crisis-mode",
          provider: "local",
          crisisDetected: true,
          memorySuggestions: [],
          imageAccepted: false
        };
        return res.json(response);
      }

      const rateLimit = await repository.consumeChatRateLimit(user.id, {
        perMinute: config.chatRateLimitPerMinute,
        perHour: config.chatRateLimitPerHour
      });
      if (!rateLimit.allowed) {
        res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
        return res.status(429).json({
          error: "訊息送得有點快，請稍等一下再試。",
          code: "rate_limited"
        });
      }

      const usage = await repository.getUsage(user.id, user.plan);
      const decision = decideCompanionMode(usage, hasImage, body.requestedMode);
      if (!decision.ok) {
        return res.status(402).json({ error: decision.message, code: decision.code });
      }

      let mode = decision.mode;
      let quotaNotice = decision.quotaNotice;
      let reservationId: string | null = null;

      if (decision.chargeDeep) {
        const reservation = await repository.reserveDeepUsage(
          user.id,
          user.plan,
          config.deepReservationTtlSeconds
        );
        if (!reservation.reserved || !reservation.reservationId) {
          if (hasImage) {
            return res.status(402).json({
              error: "圖片陪伴需要剩餘的深度陪伴額度。你可以先用文字跟我說，我會繼續陪你。",
              code: "image_requires_deep_quota"
            });
          }
          mode = "light";
          quotaNotice = "深度陪伴額度已用完，我會先切到輕量陪伴繼續陪你。";
        } else {
          reservationId = reservation.reservationId;
        }
      }

      let conversation;
      let modelUsed;
      let generated: GeneratedCompanionReply;
      let generationRetrieval: GenerationRetrievalResult | null = null;
      let generationTokenMetrics: {
        instructionsTokens: number;
        memoryTokens: number;
        history10Tokens: number;
        history20Tokens: number;
        currentQueryTokens: number;
      } | null = null;
      try {
        conversation = await repository.getOrCreatePrimaryConversation(user.id);
        modelUsed = mode === "deep" ? config.openAiDeepModel : config.openAiLightModel;
        const [memories, history20] = await Promise.all([
          repository.listMemories(user.id),
          repository.listMessages(user.id, conversation.id, { limit: RETRIEVAL_GENERATION.baselineHistoryLimit })
        ]);
        const history = history20.slice(-RETRIEVAL_GENERATION.historyLimit);
        if (mode === "deep" && !hasImage && retrievalGenerationEnabledFor(user.id)) {
          generationRetrieval = await retrieveGeneration({
            userId: user.id,
            conversationId: conversation.id,
            history,
            currentQuery: body.message
          }).catch(() => fallbackGenerationRetrieval(history, body.message));
        }
        const instructions = buildCompanionInstructions(memories, {
          mode,
          hasImage,
          hasRetrievedContext: generationRetrieval?.status === "injected"
        });
        if (generationRetrieval) {
          generationTokenMetrics = {
            instructionsTokens: countTokens(instructions),
            memoryTokens: countTokens(memories.map((memory) => memory.content).join("\n")),
            history10Tokens: countMessageContentTokens(history),
            history20Tokens: countMessageContentTokens(history20),
            currentQueryTokens: countTokens(body.message)
          };
        }
        generated = await generateReply({
          userId: user.id,
          model: modelUsed,
          mode,
          instructions,
          history,
          userMessage: body.message,
          retrievalContext: generationRetrieval?.context ?? undefined,
          imageBase64: body.imageBase64,
          imageMimeType: body.imageMimeType
        });
      } catch (error) {
        await releaseReservation(repository, user.id, reservationId);
        if (error instanceof CompanionProviderTimeoutError) {
          return res.status(504).json({ error: error.message, code: "provider_timeout" });
        }
        if (error instanceof CompanionProviderError) {
          return res.status(502).json({ error: error.message, code: "provider_unavailable" });
        }
        throw error;
      }

      let completed;
      try {
        completed = await repository.completeChatSuccess(user.id, user.plan, {
          conversationId: conversation.id,
          userContent: body.message,
          userImagePresent: hasImage,
          assistantContent: generated.content,
          modelUsed,
          mode,
          reservationId
        });
      } catch (error) {
        await releaseReservation(repository, user.id, reservationId);
        throw error;
      }

      const response: ChatResponse = {
        conversationId: conversation.id,
        assistantMessage: completed.assistantMessage,
        usage: completed.usage,
        mode,
        modelUsed,
        provider: generated.provider,
        crisisDetected: false,
        memorySuggestions: suggestMemoriesFromUserText(body.message),
        imageAccepted: hasImage,
        quotaNotice
      };

      if (generationRetrieval && generationTokenMetrics) {
        void recordGeneration({
          userId: user.id,
          conversationId: conversation.id,
          queryMessageId: completed.userMessage.id,
          assistantMessageId: completed.assistantMessage.id,
          model: modelUsed,
          retrieval: generationRetrieval,
          tokenMetrics: {
            ...generationTokenMetrics,
            actualInputTokens: generated.usage?.inputTokens ?? null,
            cachedInputTokens: generated.usage?.cachedInputTokens ?? null,
            outputTokens: generated.usage?.outputTokens ?? null
          }
        }).catch(() => {
          console.warn("[retrieval-generation:observation]", { code: "generation_observation_write_failed" });
        });
      }

      if (!hasImage && retrievalShadowEnabledFor(user.id)) {
        enqueueShadow(user.id, conversation.id, completed.userMessage.id).catch(() => {
          console.warn("[retrieval-shadow:enqueue]", { code: "shadow_enqueue_failed" });
        });
      }

      return res.json(response);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function countMessageContentTokens(messages: Array<{ content: string }>) {
  return countTokens(messages.map((message) => message.content).join("\n"));
}

function fallbackGenerationRetrieval(history: Parameters<typeof buildGenerationQuery>[0], currentQuery: string): GenerationRetrievalResult {
  const query = buildGenerationQuery(history, currentQuery);
  return {
    status: "fallback",
    context: null,
    candidates: [],
    embeddingLatencyMs: 0,
    searchLatencyMs: 0,
    totalLatencyMs: RETRIEVAL_GENERATION.timeoutMs,
    retrievalTokens: 0,
    errorCode: "generation_retrieval_failed",
    effectiveThreshold: null,
    searchBeforeSequence: null,
    manifest: buildGenerationManifest({ history, query, prepared: null })
  };
}

async function releaseReservation(repository: Repository, userId: string, reservationId: string | null) {
  if (!reservationId) return;
  try {
    await repository.releaseDeepUsage(userId, reservationId);
  } catch (error) {
    console.error("[softplace:reservation-release]", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown reservation release error"
    });
  }
}
