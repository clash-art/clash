import { log } from "../../logger";
import { createVideoTask, pollVideoTaskOnce } from "../../services/kling";
import type { GenerationAdapter } from "../adapter";
import { signedMediaUrl } from "./media-url";
import { credentialsForRoute } from "./provider-credentials";

export const klingVideoAdapter: GenerationAdapter = {
  name: "kling-video",

  async submit(ctx) {
    const { params, env } = ctx;
    const modelName = params.videoModel ?? params.modelName ?? "kling-3";
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "kling") {
      throw new Error(
        `Kling execution requires a selected Kling route for ${modelName}`,
      );
    }

    const sourceImageUrl = await (async () => {
      const sourceKey =
        params.startFrameR2Key ?? params.referenceImageR2Keys?.[0];
      if (!sourceKey)
        throw new Error("Kling video generation requires a start frame image.");
      return signedMediaUrl(env, sourceKey);
    })();

    const token = await (async () => {
      log.info("Kling video generate started", {
        ...ctx.tag,
        model: modelName,
      });
      const credentials = await credentialsForRoute(ctx, route);
      const result = await createVideoTask(
        {
          accessKey: credentials.accessKey,
          secretKey: credentials.secretKey,
          apiUrl: credentials.baseUrl,
        },
        {
          image: sourceImageUrl,
          prompt: params.prompt,
          duration:
            typeof params.duration === "number"
              ? params.duration
              : Number.parseInt(String(params.duration ?? "5"), 10),
          cfgScale: params.cfgScale,
          model: route.upstreamModel,
        },
      );
      return { taskId: result };
    })();

    return ctx.accepted(token);
  },
  async poll(ctx, token) {
    const credentials = await credentialsForRoute(
      ctx,
      ctx.params.selectedRoute!,
    );
    const result = await pollVideoTaskOnce(
      {
        accessKey: credentials.accessKey,
        secretKey: credentials.secretKey,
        apiUrl: credentials.baseUrl,
      },
      (token as { taskId: string }).taskId,
    );
    if (!result) return ctx.accepted(token);
    return ctx.completedVideo(result.url, "video/mp4", result);
  },
};
