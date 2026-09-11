/**
 * Google Gemini TTS audio generation (gemini-3.1-flash-tts etc.).
 */
import { log } from "../../logger";
import { generateGoogleAudio } from "../../services/google-gen";
import type { GenerationAdapter } from "../adapter";
import { credentialsForRoute } from "./provider-credentials";

export const googleAiStudioAudioAdapter: GenerationAdapter = {
  name: "gemini-tts",

  async submit(ctx) {
    const { params } = ctx;
    const modelName = params.modelName ?? "gemini-3.1-flash-tts";
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "google-ai-studio") {
      throw new Error(
        `Gemini TTS execution requires a selected Google AI Studio route for ${modelName}`,
      );
    }

    const storageKey = await (async () => {
      log.info("Gemini TTS started", { ...ctx.tag, model: modelName });
      const credentials = await credentialsForRoute(ctx, route);
      const result = await generateGoogleAudio(credentials.apiKey, {
        prompt: params.prompt ?? "",
        modelName: route.upstreamModel,
        modelParams: params.modelParams,
        baseUrl: credentials.baseUrl,
      });
      log.info("Gemini TTS generated", {
        ...ctx.tag,
        model: result.model,
        bytes: result.data.byteLength,
      });
      return ctx.uploadBytes(result.data, result.mediaType);
    })();

    return ctx.completedMedia(storageKey);
  },
};
