/**
 * Timeline render — proxies to render-server (ffmpeg) OR CF Container.
 */
import { renderTimelineVideo } from "@clash/shared-runtime/render-server";
import { log } from "../../logger";
import { renderServerFetch } from "../../services/thumbnail";
import type { GenerationAdapter } from "../adapter";

export const videoRenderAdapter: GenerationAdapter = {
  name: "video-render",

  async submit(ctx) {
    const { params, env } = ctx;

    const { storageKey, metadata } = await (async () => {
      log.info("Render started", ctx.tag);
      const rendered = await renderTimelineVideo(
        { fetch: (path, init) => renderServerFetch(env, path, init) },
        {
          timelineDsl: params.timelineDsl,
          projectId: params.projectId,
          taskId: params.taskId,
        },
      );
      const key = await ctx.uploadBytes(rendered.bytes, "video/mp4");
      log.info("Render uploaded to R2", {
        ...ctx.tag,
        storageKey: key,
        metadata: rendered.metadata,
      });
      return { storageKey: key, metadata: rendered.metadata };
    })();

    return ctx.completedMedia(storageKey, { metadata: metadata as never });
  },
};
