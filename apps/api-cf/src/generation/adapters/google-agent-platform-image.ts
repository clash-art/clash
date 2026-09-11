/**
 * Google Gemini image generation (gemini-3.1-flash-image, gemini-3-pro-image, ...).
 * Gemini 3 Image models use the Gemini `:generateContent` multimodal path
 * for both text-to-image and image-in/image-out requests.
 */
import { log } from "../../logger";
import {
  generateGoogleImage,
  type AgentPlatformInlineImage,
} from "../../services/google-gen";
import type { GenerationAdapter } from "../adapter";
import {
  credentialsForRoute,
  googleServiceAccountFromProvider,
} from "./provider-credentials";

async function loadInlineFromR2(
  bucket: R2Bucket,
  key: string,
): Promise<AgentPlatformInlineImage | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return {
    bytesBase64Encoded: btoa(bin),
    mimeType: obj.httpMetadata?.contentType ?? "image/png",
  };
}

export const googleAgentPlatformImageAdapter: GenerationAdapter = {
  name: "google-image",

  async submit(ctx) {
    const { params, env } = ctx;
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "google-agent-platform") {
      throw new Error(
        `Google image execution requires a selected Agent Platform route for ${params.modelName ?? "unknown model"}`,
      );
    }

    const storageKey = await (async () => {
      // R2 read + base64 encode happens INSIDE this step. Don't return
      // base64 bytes from a separate step — CF Workflow's per-step output
      // cap is 1 MiB, and a 1280×720 PNG base64 is ~1–2 MiB. R2 reads are
      // cheap (same isolate, no egress); re-reading on retry is fine.
      // Only the final R2 storage key (a short string) crosses the step
      // boundary. Same trick as veo.ts.
      const r2Keys = params.referenceImageR2Keys ?? [];
      const referenceImages: AgentPlatformInlineImage[] = [];
      for (const k of r2Keys) {
        const inline = await loadInlineFromR2(env.R2_BUCKET, k);
        if (inline) referenceImages.push(inline);
      }

      const creds = googleServiceAccountFromProvider(
        await credentialsForRoute(ctx, route),
      );
      log.info("Google image generate started", {
        ...ctx.tag,
        model: params.modelName,
        refs: referenceImages.length,
      });
      const result = await generateGoogleImage(creds, {
        prompt: params.prompt ?? "",
        aspectRatio: params.aspectRatio,
        modelName: route.upstreamModel,
        modelParams: params.modelParams,
        referenceImages: referenceImages.length ? referenceImages : undefined,
      });
      log.info("Google image generated", { ...ctx.tag, model: result.model });
      return ctx.uploadBytes(result.data, result.mediaType ?? "image/png");
    })();

    return ctx.completedMedia(storageKey);
  },
};
