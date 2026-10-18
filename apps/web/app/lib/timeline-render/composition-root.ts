/**
 * apps/web composition root: binds the browser render executor to the
 * Timeline client. No package below this root may call the binder.
 */
import {
  bindTimelineRenderExecutor,
  readRuntimeModeAtCompositionRoot,
} from "@clash/web-ui/lib/runtimeConfig";
import { emitAppFeedback } from "@clash/web-ui/components/AppFeedback";
import { createBrowserTimelineRenderExecutor } from "./adapter";

type ViteRenderEnv = {
  VITE_RENDER_FRAME_ORIGIN?: string;
  VITE_REMOTION_LICENSE_KEY?: string;
  VITE_TIMELINE_RENDER_MAX_DURATION_SECONDS?: string;
  VITE_TIMELINE_RENDER_ALLOW_HTML_IN_CANVAS?: string;
};

function readEnv(): ViteRenderEnv {
  return import.meta.env as ViteRenderEnv;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function installTimelineRenderCompositionRoot(): void {
  // Desktop and local hosts keep their plugin/daemon renderer.
  if (readRuntimeModeAtCompositionRoot() !== "hosted") {
    bindTimelineRenderExecutor(undefined);
    return;
  }
  const env = readEnv();
  const configuredOrigin = env.VITE_RENDER_FRAME_ORIGIN?.trim();
  // Isolation needs a different site (eTLD+1): a same-site or same-origin
  // frame renders correctly but shares the editor's renderer process, so the
  // render can jank the editor. Deployments set VITE_RENDER_FRAME_ORIGIN to a
  // separate site that serves render-frame.html.
  const frameOrigin =
    configuredOrigin && configuredOrigin.length > 0
      ? configuredOrigin
      : window.location.origin;
  if (frameOrigin === window.location.origin)
    console.warn(
      "[timeline-render] VITE_RENDER_FRAME_ORIGIN is unset: the render frame is same-origin and not process-isolated.",
    );
  // REMOTION_LICENSE_KEY is deployed empty today. The browser build can only
  // read a VITE_-prefixed value; the Worker must expose the same value under
  // VITE_REMOTION_LICENSE_KEY when a key is ever configured. Remotion sends a
  // telemetry event (end-user IP + window.location.origin) on every
  // client-side render, key or no key: https://www.remotion.dev/docs/telemetry
  const licenseKey = env.VITE_REMOTION_LICENSE_KEY?.trim() || null;
  bindTimelineRenderExecutor(
    createBrowserTimelineRenderExecutor({
      frameOrigin,
      licenseKey,
      // Default OFF. See apps/web/app/render-frame/main.ts for the measured
      // 46% slowdown and the Blink flag requirement.
      allowHtmlInCanvas:
        env.VITE_TIMELINE_RENDER_ALLOW_HTML_IN_CANVAS === "true",
      maxDurationSeconds: positiveNumber(
        env.VITE_TIMELINE_RENDER_MAX_DURATION_SECONDS,
        10 * 60,
      ),
      onNotice: (message) =>
        emitAppFeedback({ title: message, variant: "warning" }),
    }),
  );
}
