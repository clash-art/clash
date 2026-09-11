/**
 * Google Veo 3.1 video generation — split into submit + poll steps so a
 * DO/Workflow reset mid-generation doesn't re-bill on retry.
 *
 * Step graph:
 *   1. veo-submit  → POST :predictLongRunning, returns operationName
 *                    (cached in workflow step state — survives retries)
 *   2. veo-poll    → POST :fetchPredictOperation in a loop, decode inline
 *                    video, upload to R2. Re-entrant: re-polling the same
 *                    operationName resumes against the same Vertex job.
 *   3. probe-video → dimensions + duration + cover frame
 *   4. save-asset  → D1 row
 *
 * Why split: previously a single `vertex-generate` step wrapped the AI SDK's
 * `experimental_generateVideo`, which awaits the LRO internally and hides
 * the operationName. Veo bills $0.50/sec — a single retry can cost $2-5,
 * and DO resets (deploys, code updates) happened often enough to matter.
 */
import { log } from "../../logger";
import {
  submitVeoOperation,
  fetchVeoOperationOnce,
  type AgentPlatformInlineImage,
} from "../../services/google-gen";
import type { GenerationContext } from "../context";
import type { GenerationAdapter } from "../adapter";
import {
  credentialsForRoute,
  googleServiceAccountFromProvider,
} from "./provider-credentials";

export const googleAgentPlatformVideoAdapter: GenerationAdapter = {
  name: "veo",

  async submit(ctx: GenerationContext) {
    const { params } = ctx;
    const route = params.selectedRoute;
    if (!route || route.apiShape !== "google-agent-platform") {
      throw new Error(
        `Veo execution requires a selected Agent Platform route for ${params.videoModel ?? params.modelName ?? "unknown model"}`,
      );
    }
    const creds = googleServiceAccountFromProvider(
      await credentialsForRoute(ctx, route),
    );

    // Step 1: submit. Inline image bytes (R2 reads kept inside the step —
    // base64 of a 1280×720 PNG is 1-2 MiB, exceeds Workflows' 1 MiB step
    // output cap so they can't cross a step boundary). Output is just the
    // operation name + model id, both small strings.
    const { operationName, modelId } = await (async () => {
      const read = (
        k?: string,
      ): Promise<AgentPlatformInlineImage | undefined> =>
        k ? ctx.readR2Base64(k) : Promise.resolve(undefined);
      const readAll = async (
        keys?: string[],
      ): Promise<AgentPlatformInlineImage[] | undefined> => {
        if (!keys?.length) return undefined;
        return Promise.all(keys.map((k) => ctx.readR2Base64(k)));
      };
      const [image, tailImage, referenceImages] = await Promise.all([
        read(params.startFrameR2Key),
        read(params.endFrameR2Key),
        readAll(params.referenceImageR2Keys),
      ]);
      const modelName = route.upstreamModel;
      log.info("Veo submit", {
        ...ctx.tag,
        model: modelName,
        hasImage: !!image,
        hasTail: !!tailImage,
        refs: referenceImages?.length ?? 0,
      });
      const result = await submitVeoOperation(creds, {
        prompt: params.prompt ?? "",
        aspectRatio: params.aspectRatio,
        modelName,
        modelParams: params.modelParams,
        image,
        tailImage,
        referenceImages,
      });
      log.info("Veo operation submitted", {
        ...ctx.tag,
        operationName: result.operationName,
      });
      return result;
    })();

    return ctx.accepted({ operationName, modelId });
  },
  async poll(ctx, token) {
    const { operationName, modelId } = token as {
      operationName: string;
      modelId: string;
    };
    const creds = googleServiceAccountFromProvider(
      await credentialsForRoute(ctx, ctx.params.selectedRoute!),
    );
    const op = await fetchVeoOperationOnce(creds, modelId, operationName);
    if (!op.done) return ctx.accepted(token);
    if (op.error)
      throw new Error(`Veo operation errored: ${JSON.stringify(op.error)}`);
    const samples = op.response?.generated_samples ?? op.response?.videos;
    const video = samples?.[0]?.video ?? samples?.[0];
    const b64 = video?.bytesBase64Encoded;
    if (!b64) throw new Error("Veo completed without inline video bytes.");
    const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
    return ctx.completedMedia(
      await ctx.uploadBytes(bytes, video?.mimeType ?? "video/mp4"),
    );
  },
};
