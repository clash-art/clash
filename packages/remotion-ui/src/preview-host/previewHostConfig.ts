/**
 * Resolves whether Timeline preview uses the isolated iframe PreviewHost.
 *
 * Default remains main-thread InteractiveCanvas (today's path). Opt in with:
 *   VITE_PREVIEW_HOST_MODE=iframe
 *   VITE_PREVIEW_FRAME_ORIGIN=https://preview-frame.example  (different site)
 *
 * A same-origin frame still works functionally but is **not** process-isolated
 * (same caveat as VITE_RENDER_FRAME_ORIGIN for browser export). Preview and
 * browser-export stay separate services; they only share the cross-site
 * iframe idea and long-task metric shape. **No audio-master-clock.**
 */
import type { PreviewHostMode } from "./types";

export type PreviewHostRuntimeConfig = {
  mode: PreviewHostMode;
  /** Absolute URL of preview-frame.html, or null when mode is main-thread. */
  frameUrl: string | null;
  frameOrigin: string | null;
};

type PreviewEnv = {
  VITE_PREVIEW_HOST_MODE?: string;
  VITE_PREVIEW_FRAME_ORIGIN?: string;
};

function readEnv(env?: PreviewEnv): PreviewEnv {
  if (env) return env;
  try {
    return (import.meta as ImportMeta & { env?: PreviewEnv }).env ?? {};
  } catch {
    return {};
  }
}

/**
 * Picks the preview host mode. Falls back to main-thread when iframe is
 * requested without a usable frame origin.
 */
export function resolvePreviewHostConfig(
  env?: PreviewEnv,
  locationOrigin?: string,
): PreviewHostRuntimeConfig {
  const source = readEnv(env);
  const requested = source.VITE_PREVIEW_HOST_MODE?.trim().toLowerCase();
  const configuredOrigin = source.VITE_PREVIEW_FRAME_ORIGIN?.trim();
  const origin =
    configuredOrigin && configuredOrigin.length > 0
      ? configuredOrigin.replace(/\/$/, "")
      : null;

  if (requested !== "iframe") {
    return { mode: "main-thread", frameUrl: null, frameOrigin: null };
  }
  if (!origin) {
    return { mode: "main-thread", frameUrl: null, frameOrigin: null };
  }
  const pageOrigin = locationOrigin ?? "";
  if (pageOrigin && origin === pageOrigin) {
    // Same-origin is allowed for local smoke tests; callers should warn.
  }
  return {
    mode: "iframe",
    frameOrigin: origin,
    frameUrl: `${origin}/preview-frame.html`,
  };
}

export function previewHostIsolationWarning(
  config: PreviewHostRuntimeConfig,
  locationOrigin: string,
): string | null {
  if (config.mode !== "iframe" || !config.frameOrigin) return null;
  if (config.frameOrigin === locationOrigin) {
    return "[preview-host] VITE_PREVIEW_FRAME_ORIGIN matches the editor origin: the preview frame is same-origin and not process-isolated.";
  }
  return null;
}
