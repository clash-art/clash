import { log } from "../../logger";
import { submitSunoAudio, pollSunoAudioOnce } from "../../services/suno-audio";
import type { GenerationAdapter } from "../adapter";
import { credentialsForRoute } from "./provider-credentials";

export const sunoAudioAdapter: GenerationAdapter = {
  name: "suno-audio",

  async submit(ctx) {
    const { params, env } = ctx;
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "suno") {
      throw new Error(
        `Suno execution requires a selected Suno route for ${params.modelName ?? "unknown model"}`,
      );
    }
    const credentials = await credentialsForRoute(ctx, route);
    const publicOrigin = credentials.callbackUrl || env.WORKER_PUBLIC_URL;
    if (!publicOrigin) {
      throw new Error(
        "Suno provider requires callbackUrl credentials or WORKER_PUBLIC_URL.",
      );
    }
    const callbackUrl =
      credentials.callbackUrl ||
      `${publicOrigin.replace(/\/+$/, "")}/api/v1/provider-callbacks/suno`;

    const token = await (async () => {
      log.info("Suno generation started", {
        ...ctx.tag,
        model: route.upstreamModel,
      });
      const result = await submitSunoAudio({
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        callbackUrl,
        prompt: params.prompt ?? "",
        model: route.upstreamModel,
        modelParams: params.modelParams,
      });
      log.info("Suno submission accepted", {
        ...ctx.tag,
        taskId: result.taskId,
        model: result.model,
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
    const result = await pollSunoAudioOnce(
      { apiKey: credentials.apiKey, baseUrl: credentials.baseUrl },
      token as { taskId: string; model: string },
    );
    if (!result) return ctx.accepted(token);
    return ctx.completedMedia(
      await ctx.uploadFromUrl(result.url, "audio/mpeg"),
    );
  },
};
