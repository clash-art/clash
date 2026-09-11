import { log } from "../../logger";
import {
  submitModelArkVideo,
  pollModelArkVideoOnce,
} from "../../services/modelark-video";
import type { GenerationAdapter } from "../adapter";
import { signedMediaUrl, signedMediaUrls } from "./media-url";
import { credentialsForRoute } from "./provider-credentials";
import { positionalReferencePrompt } from "./positional-reference-prompt";

type ModelArkUpstreamKind = "volcengine";

function createModelArkVideoAdapter(
  kind: ModelArkUpstreamKind,
): GenerationAdapter {
  return {
    name: `${kind}-video`,

    async submit(ctx) {
      const { params, env } = ctx;
      const modelName =
        params.videoModel ?? params.modelName ?? "seedance-2-ref";
      const outputMediaType =
        params.modelParams?.output_format === "mov"
          ? "video/quicktime"
          : "video/mp4";
      const route = params.selectedRoute;
      if (!route || route.apiShape !== "modelark") {
        throw new Error(
          `ModelArk execution requires a selected ModelArk route for ${modelName}`,
        );
      }

      const sources = await (async () => {
        const [
          startFrameUrl,
          endFrameUrl,
          referenceImageUrls,
          referenceVideoUrls,
          referenceAudioUrls,
        ] = await Promise.all([
          params.startFrameR2Key
            ? signedMediaUrl(env, params.startFrameR2Key)
            : Promise.resolve(undefined),
          params.endFrameR2Key
            ? signedMediaUrl(env, params.endFrameR2Key)
            : Promise.resolve(undefined),
          signedMediaUrls(env, params.referenceImageR2Keys),
          signedMediaUrls(env, params.referenceVideoR2Keys),
          signedMediaUrls(env, params.referenceAudioR2Keys),
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
        log.info("ModelArk video generate started", {
          ...ctx.tag,
          provider: kind,
          model: modelName,
        });
        const credentials = await credentialsForRoute(ctx, route);
        const result = await submitModelArkVideo(credentials.apiKey, {
          baseUrl:
            credentials.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3",
          prompt: positionalReferencePrompt(params),
          modelName,
          upstreamModel: route.upstreamModel,
          startFrameUrl: sources.startFrameUrl,
          endFrameUrl: sources.endFrameUrl,
          referenceImageUrls: sources.referenceImageUrls,
          referenceVideoUrls: sources.referenceVideoUrls,
          referenceAudioUrls: sources.referenceAudioUrls,
          duration: params.duration,
          aspectRatio: params.aspectRatio,
          modelParams: params.modelParams,
        });
        log.info("ModelArk video submission accepted", {
          ...ctx.tag,
          provider: kind,
          taskId: result.taskId,
        });
        return result;
      })();

      return ctx.accepted(token);
    },
    async poll(ctx, token) {
      const credentials = await credentialsForRoute(
        ctx,
        ctx.params.selectedRoute!,
      );
      const result = await pollModelArkVideoOnce(
        credentials.apiKey,
        { baseUrl: credentials.baseUrl },
        token as { taskId: string; model: string },
      );
      if (!result) return ctx.accepted(token);
      const mediaType =
        ctx.params.modelParams?.output_format === "mov"
          ? "video/quicktime"
          : "video/mp4";
      return ctx.completedVideo(result.url, mediaType, result);
    },
  };
}
export const volcengineVideoAdapter = createModelArkVideoAdapter("volcengine");
