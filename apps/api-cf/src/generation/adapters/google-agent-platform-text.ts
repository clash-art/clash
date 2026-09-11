/**
 * Gemini text generation via Vertex. Mirrors text-gen.ts but routes through
 * @ai-sdk/google-vertex. Accepts inline image / video / audio refs alongside
 * the prompt — Gemini is multimodal across all four input types.
 * No asset output — result lands on node.data.content.
 */
import { log } from "../../logger";
import { generateGoogleText } from "../../services/google-gen";
import type { GenerationAdapter } from "../adapter";
import { buildMultimodalUserMessage } from "../multimodal";
import {
  credentialsForRoute,
  googleServiceAccountFromProvider,
} from "./provider-credentials";

export const googleAgentPlatformTextAdapter: GenerationAdapter = {
  name: "google-text",

  async submit(ctx) {
    const { params } = ctx;
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "google-agent-platform") {
      throw new Error(
        `Google text execution requires a selected Agent Platform route for ${params.modelName ?? "unknown model"}`,
      );
    }

    const content = await (async () => {
      const creds = googleServiceAccountFromProvider(
        await credentialsForRoute(ctx, route),
      );
      const systemPrompt =
        typeof params.modelParams?.system_prompt === "string"
          ? params.modelParams.system_prompt.trim()
          : "";
      const userMessage = await buildMultimodalUserMessage(ctx, params);
      log.info("Gemini text generate started", {
        ...ctx.tag,
        model: route.upstreamModel,
        parts: userMessage.content.length,
      });
      const result = await generateGoogleText(creds, {
        messages: [userMessage],
        modelName: route.upstreamModel,
        systemPrompt: systemPrompt || undefined,
      });
      return result.text;
    })();

    return ctx.completedValue({ content });
  },
};
