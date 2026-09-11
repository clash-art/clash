import { log } from "../../logger";
import { generateElevenLabsAudio } from "../../services/elevenlabs-audio";
import type { GenerationAdapter } from "../adapter";
import { credentialsForRoute } from "./provider-credentials";

export const elevenlabsAudioAdapter: GenerationAdapter = {
  name: "elevenlabs-tts",

  async submit(ctx) {
    const { params } = ctx;
    const modelName = params.modelName ?? "elevenlabs-tts";
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "elevenlabs") {
      throw new Error(
        `ElevenLabs execution requires a selected ElevenLabs route for ${modelName}`,
      );
    }

    const storageKey = await (async () => {
      log.info("ElevenLabs TTS started", { ...ctx.tag, model: modelName });
      const credentials = await credentialsForRoute(ctx, route);
      const result = await generateElevenLabsAudio(credentials.apiKey, {
        prompt: params.prompt ?? "",
        modelName: route.upstreamModel,
        modelParams: params.modelParams,
        baseUrl: credentials.baseUrl,
      });
      log.info("ElevenLabs TTS generated", {
        ...ctx.tag,
        model: result.model,
        bytes: result.data.byteLength,
      });
      return ctx.uploadBytes(result.data, result.mediaType);
    })();

    return ctx.completedMedia(storageKey);
  },
};
