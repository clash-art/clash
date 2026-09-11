import { uploadPikaMedia } from "@clash/shared-runtime";

import { log } from "../../logger";
import {
  submitPikaMedia,
  pollPikaMediaOnce,
  type PikaMediaTask,
} from "../../services/pika-media";
import { appendProviderUsageEvent } from "../../services/provider-usage";
import type { GenerationContext } from "../context";
import type { GenerationAdapter } from "../adapter";
import { credentialsForRoute } from "./provider-credentials";
import { positionalReferencePrompt } from "./positional-reference-prompt";

async function uploadR2ToPika(
  ctx: GenerationContext,
  key: string | undefined,
  apiKey: string,
): Promise<string | undefined> {
  if (!key) return undefined;
  const object = await ctx.env.R2_BUCKET.get(key);
  if (!object) throw new Error(`R2 object not found: ${key}`);
  return uploadPikaMedia({
    apiKey,
    bytes: new Uint8Array(await object.arrayBuffer()),
    contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
  });
}

async function uploadMany(
  ctx: GenerationContext,
  keys: string[] | undefined,
  apiKey: string,
): Promise<string[] | undefined> {
  if (!keys?.length) return undefined;
  const urls: string[] = [];
  for (const key of keys) urls.push((await uploadR2ToPika(ctx, key, apiKey))!);
  return urls;
}

function mediaKind(ctx: GenerationContext): "image" | "video" | "audio" {
  if (ctx.params.type === "image_gen") return "image";
  if (ctx.params.type === "video_gen") return "video";
  if (ctx.params.type === "audio_gen") return "audio";
  throw new Error(`Pika media adapter cannot execute ${ctx.params.type}`);
}

export const pikaMediaAdapter: GenerationAdapter = {
  name: "pika-media",

  async submit(ctx) {
    const { params } = ctx;
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "pika") {
      throw new Error(
        `Pika media execution requires a selected Pika route for ${params.modelName ?? "unknown model"}`,
      );
    }
    const credentials = await credentialsForRoute(ctx, route);
    const apiKey = credentials.apiKey;
    const kind = mediaKind(ctx);
    const sources = await (async () => {
      const [
        startFrameUrl,
        endFrameUrl,
        referenceImageUrls,
        referenceVideoUrls,
        referenceAudioUrls,
      ] = await Promise.all([
        uploadR2ToPika(ctx, params.startFrameR2Key, apiKey),
        uploadR2ToPika(ctx, params.endFrameR2Key, apiKey),
        uploadMany(ctx, params.referenceImageR2Keys, apiKey),
        uploadMany(ctx, params.referenceVideoR2Keys, apiKey),
        uploadMany(ctx, params.referenceAudioR2Keys, apiKey),
      ]);
      return {
        startFrameUrl,
        endFrameUrl,
        referenceImageUrls,
        referenceVideoUrls,
        referenceAudioUrls,
      };
    })();

    const token = await (async () => {
      log.info("Pika media generation started", {
        ...ctx.tag,
        model: route.modelCode,
      });
      const result = await submitPikaMedia(apiKey, {
        taskId: params.taskId,
        kind,
        route,
        prompt: positionalReferencePrompt(params),
        aspectRatio: params.aspectRatio,
        duration: params.duration,
        modelParams: params.modelParams,
        baseUrl: credentials.baseUrl,
        ...sources,
      });
      log.info("Pika media submission accepted", {
        ...ctx.tag,
        requestId: result.requestId,
        operation: result.operation,
      });
      return result;
    })();

    return ctx.accepted(token as never);
  },
  async poll(ctx, token) {
    const credentials = await credentialsForRoute(
      ctx,
      ctx.params.selectedRoute!,
    );
    const result = await pollPikaMediaOnce(
      credentials.apiKey,
      { baseUrl: credentials.baseUrl, onUsageEvent: usageRecorder(ctx) },
      token as unknown as PikaMediaTask,
    );
    if (!result) return ctx.accepted(token);
    const kind = mediaKind(ctx);
    return ctx.completedMedia(
      await ctx.uploadFromUrl(
        result.url,
        kind === "video"
          ? "video/mp4"
          : kind === "audio"
            ? "audio/mpeg"
            : "image/png",
      ),
    );
  },
};

function usageRecorder(ctx: GenerationContext) {
  const { params } = ctx;
  const route = params.selectedRoute!;
  return async (
    event: import("../../services/pika-media").PikaUsageLifecycleEvent,
  ) => {
    const requestPart = event.providerRequestId ?? "submit";
    await appendProviderUsageEvent(ctx.env.DB, {
      id: `${params.taskId}:pika:${requestPart}:${event.status}`,
      userId: params.actorUserId,
      providerId: "pika",
      ...(route.accountId ? { providerAccountId: route.accountId } : {}),
      modelId: route.modelCode,
      operation: event.operation,
      taskId: params.taskId,
      projectId: params.projectId,
      nodeId: params.nodeId,
      actorType: params.actorType,
      actorUserId: params.actorUserId,
      ...(params.actorAgentId ? { actorAgentId: params.actorAgentId } : {}),
      ...(event.providerRequestId
        ? { providerRequestId: event.providerRequestId }
        : {}),
      idempotencyKey: event.idempotencyKey,
      status: event.status,
      ...(event.estimatedCostMicroUsd !== undefined
        ? { estimatedCostMicroUsd: event.estimatedCostMicroUsd }
        : {}),
      estimateComplete: event.estimateComplete,
      currency: "USD",
      pricingSource: event.pricingSource,
      billingBasis: event.billingBasis,
      ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      occurredAt: event.occurredAt,
    });
  };
}
