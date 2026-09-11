/**
 * Timeline render — proxies to render-server (ffmpeg) OR CF Container.
 */
import { log } from "../../logger";
import { renderServerFetch } from "../../services/thumbnail";
import { getRenderMetadataFromHeaders } from "../../services/render-metadata";
import type { GenerationContext } from "../context";
import type { GenerationAdapter } from "../adapter";

export const videoRenderAdapter: GenerationAdapter = {
  name: "video-render",

  async submit(ctx) {
    const { params, env } = ctx;

    const { storageKey, metadata } = await (async () => {
      log.info("Render started", ctx.tag);
      const resp = await renderServerFetch(env, "/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timelineDsl: params.timelineDsl,
          projectId: params.projectId,
          taskId: params.taskId,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Render server error ${resp.status}: ${errText}`);
      }
      const bytes = await resp.arrayBuffer();
      const key = await ctx.uploadBytes(bytes, "video/mp4");
      const meta = getRenderMetadataFromHeaders(
        resp.headers,
        params.timelineDsl,
      );
      log.info("Render uploaded to R2", {
        ...ctx.tag,
        storageKey: key,
        metadata: meta,
      });
      return { storageKey: key, metadata: meta };
    })();

    return ctx.completedMedia(storageKey, { metadata: metadata as never });
  },
};
