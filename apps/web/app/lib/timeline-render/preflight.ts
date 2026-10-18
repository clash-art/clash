/**
 * Structural routing decision for the browser render adapter.
 *
 * These checks never render: they reject Timeline features the DOM composer
 * cannot express and let the caller fall back to the Host render. Codec and
 * `canRenderMediaOnWeb` checks need the frame document, so they run inside the
 * iframe and arrive as an `unsupported` protocol message.
 */

import type { TimelineRenderFallbackReason } from "@clash/shared-types";

/** Preflight refusals: every shared fallback reason except a failed browser attempt. */
export type BrowserRenderFallbackReason = Exclude<
  TimelineRenderFallbackReason,
  "browser-render-failed"
>;

export interface BrowserRenderPreflightInput {
  state: unknown;
  /** Config; defaults to ten minutes at the composition root. */
  maxDurationSeconds: number;
  browser: {
    /** WebKit does not apply CSS filters client-side. */
    isWebKit: boolean;
    hasWebCodecs: boolean;
  };
}

export interface BrowserRenderPreflightOk {
  ok: true;
  tracks: unknown[];
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export type BrowserRenderPreflight =
  | BrowserRenderPreflightOk
  | { ok: false; reason: BrowserRenderFallbackReason; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const EXPRESSIBLE_MASK_SHAPES = new Set(["rectangle", "ellipse"]);

function canExpressMask(mask: unknown): boolean {
  if (mask === undefined) return true;
  if (!isRecord(mask)) return false;
  return (
    typeof mask.shape === "string" &&
    EXPRESSIBLE_MASK_SHAPES.has(mask.shape)
  );
}

export function preflightBrowserTimelineRender(
  input: BrowserRenderPreflightInput,
): BrowserRenderPreflight {
  if (!input.browser.hasWebCodecs)
    return {
      ok: false,
      reason: "webcodecs-unavailable",
      message: "This browser does not expose WebCodecs.",
    };
  if (!isRecord(input.state) || !Array.isArray(input.state.tracks))
    return { ok: false, reason: "no-items", message: "Timeline has no tracks." };
  const tracks = input.state.tracks;
  let itemCount = 0;
  let maxEnd = 0;
  for (const track of tracks) {
    if (!isRecord(track) || !Array.isArray(track.items)) continue;
    for (const item of track.items) {
      if (!isRecord(item)) continue;
      itemCount++;
      if (item.runtime === "remotion")
        return {
          ok: false,
          reason: "inline-remotion",
          message:
            "Inline runtime:\"remotion\" components have unbounded CSS; use the Host render.",
        };
      if (!canExpressMask(item.mask))
        return {
          ok: false,
          reason: "unexpressible-mask",
          message: "A mask shape outside clip-path/raster cannot be expressed.",
        };
      if (
        input.browser.isWebKit &&
        Array.isArray(item.effects) &&
        item.effects.length > 0
      )
        return {
          ok: false,
          reason: "safari-filters",
          message: "Safari does not apply CSS filters in the browser renderer.",
        };
      const from = typeof item.from === "number" ? item.from : 0;
      const duration =
        typeof item.durationInFrames === "number" ? item.durationInFrames : 0;
      maxEnd = Math.max(maxEnd, from + duration);
    }
  }
  if (itemCount === 0)
    return { ok: false, reason: "no-items", message: "Timeline has no items." };

  const width =
    typeof input.state.compositionWidth === "number" &&
    input.state.compositionWidth > 0
      ? input.state.compositionWidth
      : 1920;
  const height =
    typeof input.state.compositionHeight === "number" &&
    input.state.compositionHeight > 0
      ? input.state.compositionHeight
      : 1080;
  const fps =
    typeof input.state.fps === "number" && input.state.fps > 0
      ? input.state.fps
      : 30;
  const declaredDuration =
    typeof input.state.durationInFrames === "number"
      ? input.state.durationInFrames
      : 0;
  const durationInFrames = Math.max(maxEnd, declaredDuration, 1);
  if (durationInFrames / fps > input.maxDurationSeconds)
    return {
      ok: false,
      reason: "duration-cap",
      message: `Timeline is longer than the ${input.maxDurationSeconds}s browser render cap.`,
    };
  return { ok: true, tracks, width, height, fps, durationInFrames };
}
