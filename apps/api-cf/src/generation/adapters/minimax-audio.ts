import { log } from "../../logger";
import { generateMiniMaxAudio } from "../../services/minimax-audio";
import type { GenerationAdapter } from "../adapter";
import { credentialsForRoute } from "./provider-credentials";

export const minimaxAudioAdapter: GenerationAdapter = {
  name: "minimax-audio",

  async submit(ctx) {
    const { params } = ctx;
    const modelName = params.modelName ?? "minimax-tts";
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "minimax") {
      throw new Error(
        `MiniMax execution requires a selected MiniMax route for ${modelName}`,
      );
    }

    const storageKey = await (async () => {
      log.info("MiniMax TTS started", { ...ctx.tag, model: modelName });
      const credentials = await credentialsForRoute(ctx, route);
      const result = await generateMiniMaxAudio(credentials.apiKey, {
        prompt: params.prompt ?? "",
        modelName: route.upstreamModel,
        modelParams: params.modelParams,
        baseUrl: credentials.baseUrl,
      });
      log.info("MiniMax TTS generated", {
        ...ctx.tag,
        model: result.model,
        bytes: result.data.byteLength,
      });
      return ctx.uploadBytes(result.data, result.mediaType);
    })();

    return ctx.completedMedia(storageKey);
  },
};
