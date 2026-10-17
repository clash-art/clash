import type { GenerationParams } from "./params";
import type { GenerationAdapter } from "./adapter";
import { googleAgentPlatformVideoAdapter } from "./adapters/google-agent-platform-video";
import { googleAgentPlatformImageAdapter } from "./adapters/google-agent-platform-image";
import { openaiImageAdapter } from "./adapters/openai-image";
import { googleAiStudioAudioAdapter } from "./adapters/google-ai-studio-audio";
import { minimaxAudioAdapter } from "./adapters/minimax-audio";
import { minimaxVideoAdapter } from "./adapters/minimax-video";
import { googleAiStudioInteractionsAdapter } from "./adapters/google-ai-studio-interactions";
import { elevenlabsAudioAdapter } from "./adapters/elevenlabs-audio";
import { sunoAudioAdapter } from "./adapters/suno-audio";
import { klingVideoAdapter } from "./adapters/kling-video";
import { volcengineVideoAdapter } from "./adapters/modelark-video";
import { videoRenderAdapter } from "./adapters/render";
import { textGenAdapter } from "./adapters/text-gen";
import { googleAgentPlatformTextAdapter } from "./adapters/google-agent-platform-text";
import { understandAdapter } from "./adapters/understand";
import { describeAdapter } from "./adapters/describe";
import { pikaMediaAdapter } from "./adapters/pika-media";
import { bflVideoAdapter } from "./adapters/bfl-video";
import {
  isExecutablePluginProviderRoute,
  pluginProviderAdapterFor,
} from "./plugin-provider-adapter";

function selectedRoute(params: GenerationParams) {
  if (!params.selectedRoute) {
    throw new Error(`No configured provider route for ${params.modelName ?? params.type}`);
  }
  return params.selectedRoute;
}

function unsupportedRoute(params: GenerationParams): never {
  const route = selectedRoute(params);
  throw new Error(
    `Hosted provider adapter is not implemented for ${route.providerId ?? route.upstreamId}` +
    ` (${route.apiShape}) on ${route.modelCode}`,
  );
}

/**
 * Picks the adapter that speaks this route's wire format.
 *
 * Selection is by `apiShape` or `upstreamId`, never by `providerId`. A provider says whose
 * credential pays; it does not change how the request is shaped, and the same model reached through
 * two providers is often the same wire format. Plugin-owned providers such as
 * fal are intentionally absent: local and future cloud Hosts invoke the same
 * provider-executor plugin through Durable Run instead of adding an adapter here.
 *
 * The effective key is the pair (generation type, route key), not the route key alone: three
 * different adapters answer `upstreamId === "google-agent-platform"`, disambiguated only by the
 * `params.type` arm they sit in. Adapter names carry both halves for that reason.
 *
 * Naming them after the key rather than after a model is what keeps them honest as routes are
 * added. An adapter called `veo` did serve exactly the veo models, but only by coincidence of
 * today's table: it answers every google-agent-platform video route, so the first such model not
 * named veo would arrive at an adapter claiming otherwise. Same for the one selected by
 * `google-ai-studio-interactions`, which was named after gemini-omni — the shape is Google's async
 * Interactions API, and the next model on it will have some other name.
 */
export function resolveAdapter(params: GenerationParams): GenerationAdapter {
  switch (params.type) {
    case "video_gen": {
      const route = selectedRoute(params);
      if (route?.apiShape === "pika") return pikaMediaAdapter;
      if (route?.apiShape === "bfl") return bflVideoAdapter;
      if (route?.apiShape === "google-ai-studio-interactions") return googleAiStudioInteractionsAdapter;
      if (route?.upstreamId === "google-agent-platform") return googleAgentPlatformVideoAdapter;
      if (route?.upstreamId === "kling") return klingVideoAdapter;
      if (route?.upstreamId === "volcengine") return volcengineVideoAdapter;
      if (route?.upstreamId === "minimax") return minimaxVideoAdapter;
      if (isExecutablePluginProviderRoute(route))
        return pluginProviderAdapterFor(route);
      return unsupportedRoute(params);
    }
    case "image_gen": {
      const route = selectedRoute(params);
      if (route?.apiShape === "pika") return pikaMediaAdapter;
      if (route?.upstreamId === "openai") return openaiImageAdapter;
      if (route?.upstreamId === "google-agent-platform")
        return googleAgentPlatformImageAdapter;
      if (isExecutablePluginProviderRoute(route))
        return pluginProviderAdapterFor(route);
      return unsupportedRoute(params);
    }
    case "audio_gen": {
      const route = selectedRoute(params);
      if (route?.apiShape === "pika") return pikaMediaAdapter;
      if (route?.upstreamId === "google-ai-studio")
        return googleAiStudioAudioAdapter;
      if (route?.upstreamId === "minimax") return minimaxAudioAdapter;
      if (route?.upstreamId === "elevenlabs") return elevenlabsAudioAdapter;
      if (route?.upstreamId === "suno") return sunoAudioAdapter;
      if (isExecutablePluginProviderRoute(route))
        return pluginProviderAdapterFor(route);
      return unsupportedRoute(params);
    }
    case "video_render":
      return videoRenderAdapter;
    case "text_gen": {
      const route = selectedRoute(params);
      if (route.upstreamId === "google-agent-platform")
        return googleAgentPlatformTextAdapter;
      if (isExecutablePluginProviderRoute(route))
        return pluginProviderAdapterFor(route);
      return textGenAdapter;
    }
    case "understand":
      return understandAdapter;
    case "image_desc":
    case "video_desc":
      return describeAdapter;
    default:
      throw new Error(`Unknown generation type: ${(params as { type: string }).type}`);
  }
}
