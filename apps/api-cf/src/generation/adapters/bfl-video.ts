import {
  submitBflFlux3Video,
  pollBflFlux3VideoOnce,
} from "@clash/shared-runtime";

import { log } from "../../logger";
import type { GenerationAdapter } from "../adapter";
import { signedMediaUrls } from "./media-url";
import { credentialsForRoute } from "./provider-credentials";

export const bflVideoAdapter: GenerationAdapter = {
  name: "bfl-video",

  async submit(ctx) {
    const { params, env } = ctx;
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "bfl") {
      throw new Error(
        `BFL video execution requires a selected BFL route for ${params.modelName ?? "unknown model"}`,
      );
    }

    const token = await (async () => {
      const [referenceImageUrls, referenceVideoUrls, credentials] =
        await Promise.all([
          signedMediaUrls(env, params.referenceImageR2Keys),
          signedMediaUrls(env, params.referenceVideoR2Keys),
          credentialsForRoute(ctx, route),
        ]);
      log.info("BFL FLUX 3 generation started", {
        ...ctx.tag,
        model: route.upstreamModel,
      });
      const result = await submitBflFlux3Video({
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        input: {
          prompt: params.prompt ?? "",
          duration: params.duration,
          aspectRatio: params.aspectRatio,
          modelParams: params.modelParams,
          referenceImageUrls,
          referenceVideoUrls,
        },
      });
      log.info("BFL FLUX 3 submission accepted", {
        ...ctx.tag,
        requestId: result.requestId,
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
    const result = await pollBflFlux3VideoOnce(
      { apiKey: credentials.apiKey },
      token as { requestId: string; pollingUrl: string },
    );
    if (!result) return ctx.accepted(token);
    return ctx.completedMedia(await ctx.uploadFromUrl(result.url, "video/mp4"));
  },
};
