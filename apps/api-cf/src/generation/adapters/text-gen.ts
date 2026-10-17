import { ProviderExecutionError } from "@clash/action-sdk/executable-failure";
/**
 * Text generation via OpenAI-compatible or Anthropic-compatible chat APIs.
 * Text, image and audio refs are adapted through shared-runtime; Google text
 * keeps its dedicated provider for broader multimodal support.
 * No asset output — result lands on node.data.content.
 */
import {
  generatePikaChat,
  generateTextCompletion,
  type TextContentPart,
} from "@clash/shared-runtime";
import type { ModelUpstreamRoute } from "@clash/shared-types";
import type { Env } from "../../config";
import { log } from "../../logger";
import type { GenerationAdapter } from "../adapter";
import { buildMultimodalUserMessage } from "../multimodal";
import { getProviderCredentials } from "../../services/provider-accounts";
import {
  generateGoogleAiStudioText,
  generateGoogleText,
} from "../../services/google-gen";
import {
  credentialsForRoute,
  googleServiceAccountFromProvider,
} from "./provider-credentials";
import { appendProviderUsageEvent } from "../../services/provider-usage";

function sharedContentParts(
  content: Awaited<ReturnType<typeof buildMultimodalUserMessage>>["content"],
): TextContentPart[] {
  return content.flatMap((part): TextContentPart[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "image")
      return [{ type: "image", data: part.image, mediaType: part.mediaType }];
    if (part.type === "file" && part.mediaType.startsWith("audio/"))
      return [{ type: "audio", data: part.data, mediaType: part.mediaType }];
    return [];
  });
}

function routeProviderId(route: ModelUpstreamRoute): string {
  return route.providerId ?? route.upstreamId ?? "provider";
}

/**
 * Voice-input transcription through the same hosted text-generation path.
 * OpenAI/Anthropic-compatible routes use the shared text client with an audio
 * content part; Google routes use the Gemini multimodal clients that already
 * carry inline file/audio parts.
 */
export async function transcribeWithTextGeneration(input: {
  env: Pick<Env, "DB" | "ACTION_SECRET_KEY" | "CF_AIG_TOKEN">;
  userId: string;
  route: ModelUpstreamRoute;
  audio: { bytes: Uint8Array; mediaType: string };
  prompt: string;
  language?: string;
}): Promise<{ text: string; provider: string; model: string }> {
  const { route } = input;
  const credentials = await getProviderCredentials(input.env, input.userId, {
    accountId: route.accountId,
    providerId: route.providerId ?? route.upstreamId,
    upstreamId: route.upstreamId,
    region: route.region,
    modelCode: route.modelCode,
    requiredCredentials: route.requiredCredentials,
  });

  if (
    route.upstreamId === "google-agent-platform" ||
    (route.upstreamId === "google-ai-studio" && !credentials.apiKey?.trim())
  ) {
    const result = await generateGoogleText(
      googleServiceAccountFromProvider(credentials),
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: input.prompt },
              {
                type: "file",
                data: input.audio.bytes,
                mediaType: input.audio.mediaType,
              },
            ],
          },
        ],
        modelName: route.upstreamModel,
      },
    );
    return {
      text: result.text,
      provider: routeProviderId(route),
      model: result.model,
    };
  }

  if (route.upstreamId === "google-ai-studio") {
    const result = await generateGoogleAiStudioText({
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl,
      model: route.upstreamModel,
      prompt: input.prompt,
      audio: input.audio,
      ...(input.env.CF_AIG_TOKEN
        ? { cfAigToken: input.env.CF_AIG_TOKEN }
        : {}),
    });
    return {
      text: result.text,
      provider: routeProviderId(route),
      model: result.model,
    };
  }

  if (route.apiShape === "pika-chat") {
    throw new Error("Pika chat does not accept inline audio transcription.");
  }
  const provider =
    route.apiShape === "anthropic-compatible"
      ? "anthropic-compatible"
      : "openai-compatible";
  const result = await generateTextCompletion({
    provider,
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
    model: route.upstreamModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: input.prompt },
          {
            type: "audio",
            data: input.audio.bytes,
            mediaType: input.audio.mediaType,
          },
        ],
      },
    ],
  });
  return {
    text: result.text,
    provider: routeProviderId(route),
    model: result.model,
  };
}

export const textGenAdapter: GenerationAdapter = {
  name: "text-gen",

  async submit(ctx) {
    const { params } = ctx;
    const route = params.selectedRoute;
    if (
      !route ||
      !["openai-compatible", "anthropic-compatible", "pika-chat"].includes(
        route.apiShape,
      )
    ) {
      throw new Error(
        `Text execution requires a selected compatible route for ${params.modelName ?? "unknown model"}`,
      );
    }

    const content = await (async () => {
      const providerLabel =
        route.apiShape === "pika-chat" ? "pika" : route.apiShape;
      const credentials = await credentialsForRoute(ctx, route);
      const systemPrompt =
        typeof params.modelParams?.system_prompt === "string"
          ? params.modelParams.system_prompt.trim()
          : "";
      const configuredModelName =
        typeof params.modelParams?.model_name === "string" &&
        params.modelParams.model_name.trim()
          ? params.modelParams.model_name.trim()
          : "";
      const userMessage = await buildMultimodalUserMessage(ctx, params);
      log.info("Text generate started", {
        ...ctx.tag,
        model: configuredModelName || route.upstreamModel,
        provider: providerLabel,
        parts: userMessage.content.length,
      });
      if (route.apiShape === "pika-chat") {
        const textPrompt = userMessage.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        let accepted = false;
        try {
          const result = await generatePikaChat({
            apiKey: credentials.apiKey,
            baseUrl: credentials.baseUrl,
            model: route.upstreamModel,
            prompt: textPrompt,
            systemPrompt: systemPrompt || undefined,
          });
          accepted = true;
          await appendProviderUsageEvent(ctx.env.DB, {
            id: `${params.taskId}:pika:${result.requestId ?? "sync"}:completed`,
            userId: params.actorUserId,
            providerId: "pika",
            ...(route.accountId ? { providerAccountId: route.accountId } : {}),
            modelId: route.modelCode,
            operation: route.upstreamModel,
            taskId: params.taskId,
            projectId: params.projectId,
            nodeId: params.nodeId,
            actorType: params.actorType,
            actorUserId: params.actorUserId,
            ...(params.actorAgentId
              ? { actorAgentId: params.actorAgentId }
              : {}),
            ...(result.requestId
              ? { providerRequestId: result.requestId }
              : {}),
            idempotencyKey: params.taskId,
            status: "completed",
            estimateComplete: false,
            currency: "USD",
            pricingSource: "unavailable",
            billingBasis: result.usage ?? {},
            occurredAt: new Date().toISOString(),
          });
          return result;
        } catch (error) {
          if (accepted)
            throw new ProviderExecutionError({
              code: "output_persistence_failed",
              message: `Provider usage persistence failed: ${String(error)}`,
              retryable: true,
              requestState: "accepted",
            });
          await appendProviderUsageEvent(ctx.env.DB, {
            id: `${params.taskId}:pika:sync:failed`,
            userId: params.actorUserId,
            providerId: "pika",
            modelId: route.modelCode,
            operation: route.upstreamModel,
            taskId: params.taskId,
            projectId: params.projectId,
            nodeId: params.nodeId,
            actorType: params.actorType,
            actorUserId: params.actorUserId,
            idempotencyKey: params.taskId,
            status: "failed",
            estimateComplete: false,
            currency: "USD",
            pricingSource: "unavailable",
            billingBasis: {},
            errorMessage:
              error instanceof Error ? error.message : String(error),
            occurredAt: new Date().toISOString(),
          });
          throw error;
        }
      }
      const provider =
        route.apiShape === "anthropic-compatible"
          ? "anthropic-compatible"
          : "openai-compatible";
      const result = await generateTextCompletion({
        provider,
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        model: configuredModelName || route.upstreamModel,
        systemPrompt: systemPrompt || undefined,
        messages: [
          { role: "user", content: sharedContentParts(userMessage.content) },
        ],
      });
      return result;
    })();

    return ctx.completedValue({ content: content.text });
  },
};
