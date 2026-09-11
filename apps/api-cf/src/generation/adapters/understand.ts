/**
 * Legacy hosted visual analysis for image/video assets.
 * ASR is owned by the local executable ASR plugin.
 * Writes results to node.data.understanding.
 */
import { log } from "../../logger";
import { analyzeVisual } from "../../services/visual-understanding";
import type { GenerationContext } from "../context";
import type { GenerationAdapter } from "../adapter";

export const understandAdapter: GenerationAdapter = {
  name: "understand",

  async submit(ctx) {
    const { params, env } = ctx;
    const r2Key = params.r2Key;
    const mime = params.mimeType ?? "";
    if (!r2Key) throw new Error("understand task requires r2Key");

    const isVideo = mime.startsWith("video/");
    const isImage = mime.startsWith("image/");
    const understanding: Record<string, unknown> = {};

    if (!isImage && !isVideo) {
      throw new Error(
        "Hosted ASR has been retired; invoke the local executable ASR plugin.",
      );
    }

    if (isImage || isVideo) {
      understanding.visual = await (async () => {
        log.info("Visual analysis started", ctx.tag);
        const dataUri = await ctx.readR2DataUri(r2Key);
        const result = await analyzeVisual(env.AI, dataUri);
        log.info("Visual analysis completed", {
          ...ctx.tag,
          hasDescription: !!result.description,
          shots: result.shots?.length,
        });
        return result;
      })();
    }

    return ctx.completedValue({ understanding: understanding as never });
  },
};
