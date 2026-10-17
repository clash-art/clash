/**
 * Cross-origin render frame entry.
 *
 * This is the only module that imports @remotion/web-renderer. It runs in an
 * out-of-process iframe so ReactDOM.createRoot + document.createTreeWalker
 * (see ../lib/timeline-render/adapter.ts for file:line evidence) do not block
 * the editor's main thread.
 */
import { ALL_FORMATS, Input, UrlSource } from "mediabunny";
import {
  canRenderMediaOnWeb,
  renderMediaOnWeb,
  type RenderMediaOnWebProgress,
} from "@remotion/web-renderer";
import { VideoComposition } from "@clash/remotion-components";
import type { Track } from "@clash/remotion-core";
import {
  TIMELINE_RENDER_PROTOCOL,
  isTimelineRenderFrameCommand,
  type TimelineRenderFrameMessage,
  type TimelineRenderFrameRequest,
} from "../lib/timeline-render/protocol";

/**
 * The renderer's own check is not exported, so mirror it: native
 * HTML-in-canvas needs CanvasRenderingContext2D.drawElementImage. It requires
 * --enable-blink-features=CanvasDrawElement and is absent by default in
 * Chrome 155 and headless 157. With the flag a z-index composition matched
 * the server output (SSIM 0.983 vs 0.925 without), but it was 46% slower
 * (10.7 s vs 7.3 s) with one ~300 ms longtask, and SVG data-URI masks still
 * failed. Keep it off unless the composition root opts in AND the frame
 * actually supports it.
 */
function supportsNativeHtmlInCanvas(): boolean {
  if (typeof document === "undefined") return false;
  const context = document.createElement("canvas").getContext("2d");
  return typeof (context as { drawElementImage?: unknown } | null)
    ?.drawElementImage === "function";
}

class FrameUnsupported extends Error {}

function post(message: TimelineRenderFrameMessage, targetOrigin: string) {
  window.parent.postMessage(message, targetOrigin);
}

function itemMediaSources(tracks: unknown[]): string[] {
  const sources = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      (record.type === "video" || record.type === "audio") &&
      typeof record.src === "string" &&
      record.src
    )
      sources.add(record.src);
    visit(record.items);
    visit(record.tracks);
  };
  visit(tracks);
  return [...sources];
}

async function assertSourcesDecodable(tracks: unknown[]): Promise<void> {
  for (const src of itemMediaSources(tracks)) {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(src) });
    try {
      const track =
        (await input.getPrimaryVideoTrack()) ??
        (await input.getPrimaryAudioTrack());
      if (!track) throw new FrameUnsupported("Media source has no track.");
      if (!(await track.canDecode()))
        throw new FrameUnsupported(`Codec cannot be decoded: ${src}`);
    } catch (error) {
      if (error instanceof FrameUnsupported) throw error;
      throw new FrameUnsupported(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      input.dispose();
    }
  }
}

async function renderRequest(
  request: TimelineRenderFrameRequest,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<Blob> {
  const support = await canRenderMediaOnWeb({
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    width: request.width,
    height: request.height,
  });
  if (!support.canRender)
    throw new FrameUnsupported(
      support.issues.map((issue) => issue.message).join(" "),
    );
  await assertSourcesDecodable(request.tracks);
  const allowHtmlInCanvas =
    request.allowHtmlInCanvas && supportsNativeHtmlInCanvas();
  const result = await renderMediaOnWeb({
    composition: {
      id: "VideoComposition",
      component: VideoComposition,
      width: request.width,
      height: request.height,
      fps: request.fps,
      durationInFrames: request.durationInFrames,
      defaultProps: { tracks: [] },
    },
    inputProps: { tracks: request.tracks as Track[] },
    // Omitted so Remotion writes to OPFS ("web-fs") when the browser supports
    // it and to an ArrayBuffer otherwise.
    signal,
    licenseKey: request.licenseKey,
    allowHtmlInCanvas,
    logLevel: "error",
    onProgress(progress: RenderMediaOnWebProgress) {
      if (Number.isFinite(progress.progress))
        onProgress(Math.min(1, Math.max(0, progress.progress)));
    },
  });
  return result.getBlob();
}

let active: AbortController | null = null;

async function run(
  request: TimelineRenderFrameRequest,
  targetOrigin: string,
): Promise<void> {
  active?.abort();
  const controller = new AbortController();
  active = controller;
  try {
    const file = await renderRequest(request, controller.signal, (progress) =>
      post(
        {
          protocol: TIMELINE_RENDER_PROTOCOL,
          type: "progress",
          progress,
        },
        targetOrigin,
      ),
    );
    if (controller.signal.aborted) {
      post(
        { protocol: TIMELINE_RENDER_PROTOCOL, type: "cancelled" },
        targetOrigin,
      );
      return;
    }
    post({ protocol: TIMELINE_RENDER_PROTOCOL, type: "done", file }, targetOrigin);
  } catch (error) {
    if (controller.signal.aborted) {
      post(
        { protocol: TIMELINE_RENDER_PROTOCOL, type: "cancelled" },
        targetOrigin,
      );
    } else if (error instanceof FrameUnsupported) {
      post(
        {
          protocol: TIMELINE_RENDER_PROTOCOL,
          type: "unsupported",
          reason: error.message,
        },
        targetOrigin,
      );
    } else {
      post(
        {
          protocol: TIMELINE_RENDER_PROTOCOL,
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        },
        targetOrigin,
      );
    }
  } finally {
    if (active === controller) active = null;
  }
}

function documentParentOrigin(): string | null {
  if (!document.referrer) return null;
  try {
    return new URL(document.referrer).origin;
  } catch {
    return null;
  }
}

const embedded = window.parent !== window;
const expectedParentOrigin = embedded ? documentParentOrigin() : null;
if (embedded) {
  window.addEventListener("message", (event) => {
    if (!isTimelineRenderFrameCommand(event.data)) return;
    // The document's own referrer is the embedder origin: a frame driven by
    // the page it was served from only, not by any site that guesses a URL.
    if (
      !expectedParentOrigin ||
      event.origin !== expectedParentOrigin ||
      event.data.parentOrigin !== expectedParentOrigin
    )
      return;
    if (event.data.type === "cancel") {
      active?.abort();
      return;
    }
    void run(event.data.request, expectedParentOrigin);
  });
  post({ protocol: TIMELINE_RENDER_PROTOCOL, type: "ready" }, "*");
}

/**
 * E2E seam: the same render entry can run inline so a test can compare its
 * long tasks with the iframe path. It is never used by the product adapter.
 */
declare global {
  interface Window {
    __renderTimelineInline?: (
      request: TimelineRenderFrameRequest,
    ) => Promise<Blob>;
  }
}
window.__renderTimelineInline = (request) =>
  renderRequest(request, new AbortController().signal, () => undefined);
