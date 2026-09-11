import { Buffer } from "node:buffer";

import {
  createGeminiOmniInteraction,
  downloadGeminiOmniVideo,
  extractGeminiOmniVideo,
  geminiOmniInteractionId,
  geminiOmniInteractionStatus,
  getGeminiOmniInteraction,
  type GeminiOmniInputPart,
  type GeminiOmniInteraction,
} from "@clash/shared-runtime";

import { log } from "../../logger";
import type { GenerationContext } from "../context";
import type { GenerationAdapter } from "../adapter";
import { credentialsForRoute } from "./provider-credentials";

const COMPLETED_STATUSES = new Set(["completed", "succeeded", "success"]);
const FAILED_STATUSES = new Set([
  "failed",
  "cancelled",
  "canceled",
  "error",
  "incomplete",
]);

function interactionError(interaction: GeminiOmniInteraction): string {
  const message = interaction.error?.message;
  return typeof message === "string" && message.trim()
    ? message
    : "unknown interaction failure";
}

async function buildInput(
  ctx: GenerationContext,
): Promise<GeminiOmniInputPart[]> {
  const { params } = ctx;
  const result: GeminiOmniInputPart[] = [];
  const mentionedKeys = new Set<string>();

  for (const part of params.promptParts ?? []) {
    if (part.type === "text") {
      if (part.text) result.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type !== "asset_ref" || part.modality !== "image" || !part.r2Key)
      continue;
    const inline = await ctx.readR2Base64(part.r2Key);
    result.push({
      type: "image",
      data: inline.bytesBase64Encoded,
      mimeType: inline.mimeType,
    });
    mentionedKeys.add(part.r2Key);
  }

  if (!result.some((part) => part.type === "text") && params.prompt) {
    result.unshift({ type: "text", text: params.prompt });
  }
  for (const key of params.referenceImageR2Keys ?? []) {
    if (mentionedKeys.has(key)) continue;
    const inline = await ctx.readR2Base64(key);
    result.push({
      type: "image",
      data: inline.bytesBase64Encoded,
      mimeType: inline.mimeType,
    });
  }
  if (!result.length)
    throw new Error(
      "Gemini Omni requires a prompt or at least one reference image.",
    );
  return result;
}

function stringCredential(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isCloudflareGateway(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).hostname === "gateway.ai.cloudflare.com";
  } catch {
    return false;
  }
}

async function transportCredentials(
  ctx: GenerationContext,
  route: NonNullable<GenerationContext["params"]["selectedRoute"]>,
): Promise<{ apiKey?: string; baseUrl?: string }> {
  let stored: Record<string, string> = {};
  let storedError: unknown;
  try {
    // Gateway BYOK may intentionally omit apiKey, so select the account first
    // and enforce the alternative transport credentials below.
    stored = await credentialsForRoute(ctx, {
      ...route,
      requiredCredentials: [],
    });
  } catch (error) {
    storedError = error;
  }

  const baseUrl =
    stringCredential(stored.baseUrl) ??
    stringCredential(ctx.env.GOOGLE_AI_STUDIO_BASE_URL);
  const apiKey =
    stringCredential(stored.apiKey) ?? stringCredential(ctx.env.GOOGLE_API_KEY);
  if (!apiKey) {
    if (storedError) throw storedError;
    throw new Error("Google AI Studio API key is required for Gemini Omni.");
  }
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export const googleAiStudioInteractionsAdapter: GenerationAdapter = {
  name: "gemini-omni",

  async submit(ctx) {
    const { params } = ctx;
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "google-ai-studio-interactions") {
      throw new Error(
        `Gemini Omni execution requires a selected Interactions route for ${params.modelName ?? "unknown model"}`,
      );
    }
    const credentials = await transportCredentials(ctx, route);

    const submitted = await (async () => {
      const input = await buildInput(ctx);
      const interaction = await createGeminiOmniInteraction({
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        model: route.upstreamModel,
        input,
        aspectRatio: params.aspectRatio === "9:16" ? "9:16" : "16:9",
        duration:
          typeof params.duration === "number"
            ? params.duration
            : typeof params.modelParams?.duration === "number"
              ? params.modelParams.duration
              : 5,
      });
      const id = geminiOmniInteractionId(interaction);
      log.info("Gemini Omni interaction submitted", {
        ...ctx.tag,
        id,
        model: route.upstreamModel,
      });
      return { id, interaction };
    })();

    return interactionResult(ctx, submitted.interaction, credentials);
  },
  async poll(ctx, token) {
    const credentials = await transportCredentials(
      ctx,
      ctx.params.selectedRoute!,
    );
    const state = token as {
      id: string;
      file?: { uri: string; mimeType: string };
    };
    if (state.file) {
      const downloaded = await downloadGeminiOmniVideo({
        ...credentials,
        uri: state.file.uri,
      });
      if (!downloaded) return ctx.accepted(token);
      return ctx.completedMedia(
        await ctx.uploadBytes(
          downloaded.bytes,
          downloaded.mimeType || state.file.mimeType,
        ),
      );
    }
    const interaction = await getGeminiOmniInteraction({
      ...credentials,
      interactionId: (token as { id: string }).id,
    });
    return interactionResult(ctx, interaction, credentials);
  },
};

async function interactionResult(
  ctx: GenerationContext,
  interaction: GeminiOmniInteraction,
  credentials: { apiKey?: string; baseUrl?: string },
) {
  const status = geminiOmniInteractionStatus(interaction);
  if (FAILED_STATUSES.has(status))
    throw new Error(
      `Gemini Omni interaction ${status}: ${interactionError(interaction)}`,
    );
  if (!COMPLETED_STATUSES.has(status))
    return ctx.accepted({ id: geminiOmniInteractionId(interaction) });
  const output = extractGeminiOmniVideo(interaction);
  if (!output) throw new Error("Gemini Omni completed without a video output.");
  if (output.data)
    return ctx.completedMedia(
      await ctx.uploadBytes(
        new Uint8Array(Buffer.from(output.data, "base64")),
        output.mimeType,
      ),
    );
  if (!output.uri)
    throw new Error("Gemini Omni video output did not include data or a URI.");
  return ctx.accepted({
    id: geminiOmniInteractionId(interaction),
    file: { uri: output.uri, mimeType: output.mimeType },
  });
}
