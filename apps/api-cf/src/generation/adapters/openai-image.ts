import { log } from "../../logger";
import {
  generateOpenAIImage,
  type OpenAIInlineImage,
} from "../../services/openai-image";
import type { GenerationContext } from "../context";
import type { GenerationAdapter } from "../adapter";
import { credentialsForRoute } from "./provider-credentials";

async function loadInlineFromR2(
  bucket: R2Bucket,
  key: string,
): Promise<OpenAIInlineImage | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  return {
    data: new Uint8Array(buf),
    mimeType: obj.httpMetadata?.contentType ?? "image/png",
  };
}

export const openaiImageAdapter: GenerationAdapter = {
  name: "openai-image",

  async submit(ctx) {
    const { params, env } = ctx;
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "openai-images") {
      throw new Error(
        `OpenAI image execution requires a selected OpenAI route for ${params.modelName ?? "unknown model"}`,
      );
    }

    const storageKey = await (async () => {
      const r2Keys = params.referenceImageR2Keys ?? [];
      const referenceImages: OpenAIInlineImage[] = [];
      for (const key of r2Keys) {
        const inline = await loadInlineFromR2(env.R2_BUCKET, key);
        if (inline) referenceImages.push(inline);
      }

      log.info("OpenAI image generate started", {
        ...ctx.tag,
        model: params.modelName,
        refs: referenceImages.length,
      });
      const credentials = await credentialsForRoute(ctx, route);
      const result = await generateOpenAIImage({
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        prompt: params.prompt ?? "",
        modelName: route.upstreamModel,
        modelParams: params.modelParams,
        referenceImages: referenceImages.length ? referenceImages : undefined,
      });
      log.info("OpenAI image generated", {
        ...ctx.tag,
        model: result.model,
        bytes: result.data.byteLength,
      });
      return ctx.uploadBytes(result.data, result.mediaType);
    })();

    return ctx.completedMedia(storageKey);
  },
};
