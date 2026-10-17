/**
 * Parent <-> cross-origin render frame protocol.
 *
 * Every message carries the protocol tag; the parent additionally rejects
 * anything whose `event.origin` or `event.source` is not the frame it created.
 * No React, DOM, or Remotion import lives here so the protocol is unit
 * testable and the parent bundle never evaluates the renderer.
 */
export const TIMELINE_RENDER_PROTOCOL = "clash.timeline-render.v1" as const;

export interface TimelineRenderFrameRequest {
  tracks: unknown[];
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** Empty today; read from config at the composition root. */
  licenseKey: string | null;
  /** Only honoured when the frame supports native HTML-in-canvas. */
  allowHtmlInCanvas: boolean;
}

export type TimelineRenderFrameMessage =
  | { protocol: typeof TIMELINE_RENDER_PROTOCOL; type: "ready" }
  | {
      protocol: typeof TIMELINE_RENDER_PROTOCOL;
      type: "progress";
      progress: number;
    }
  | { protocol: typeof TIMELINE_RENDER_PROTOCOL; type: "done"; file: Blob }
  | { protocol: typeof TIMELINE_RENDER_PROTOCOL; type: "cancelled" }
  | {
      protocol: typeof TIMELINE_RENDER_PROTOCOL;
      type: "unsupported";
      reason: string;
    }
  | { protocol: typeof TIMELINE_RENDER_PROTOCOL; type: "error"; error: string };

export interface TimelineRenderFrameRenderCommand {
  protocol: typeof TIMELINE_RENDER_PROTOCOL;
  type: "render";
  /** Origin that is allowed to receive this frame's replies. */
  parentOrigin: string;
  request: TimelineRenderFrameRequest;
}

export interface TimelineRenderFrameCancelCommand {
  protocol: typeof TIMELINE_RENDER_PROTOCOL;
  type: "cancel";
  parentOrigin: string;
}

export type TimelineRenderFrameCommand =
  | TimelineRenderFrameRenderCommand
  | TimelineRenderFrameCancelCommand;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isTimelineRenderFrameMessage(
  value: unknown,
): value is TimelineRenderFrameMessage {
  if (!isRecord(value) || value.protocol !== TIMELINE_RENDER_PROTOCOL)
    return false;
  switch (value.type) {
    case "ready":
    case "cancelled":
      return true;
    case "progress":
      return (
        typeof value.progress === "number" &&
        Number.isFinite(value.progress) &&
        value.progress >= 0 &&
        value.progress <= 1
      );
    case "done":
      return value.file instanceof Blob;
    case "unsupported":
      return typeof value.reason === "string" && value.reason.length > 0;
    case "error":
      return typeof value.error === "string" && value.error.length > 0;
    default:
      return false;
  }
}

export function isTimelineRenderFrameCommand(
  value: unknown,
): value is TimelineRenderFrameCommand {
  if (!isRecord(value) || value.protocol !== TIMELINE_RENDER_PROTOCOL)
    return false;
  if (typeof value.parentOrigin !== "string" || !value.parentOrigin) return false;
  if (value.type === "cancel") return true;
  if (value.type !== "render") return false;
  const request = value.request;
  if (!isRecord(request)) return false;
  return (
    Array.isArray(request.tracks) &&
    typeof request.width === "number" &&
    typeof request.height === "number" &&
    typeof request.fps === "number" &&
    typeof request.durationInFrames === "number" &&
    (request.licenseKey === null || typeof request.licenseKey === "string") &&
    typeof request.allowHtmlInCanvas === "boolean"
  );
}

/** Exact-origin check; a sibling subdomain is not the render frame. */
export function isTrustedFrameOrigin(
  eventOrigin: string,
  expectedOrigin: string,
): boolean {
  return eventOrigin === expectedOrigin;
}

/**
 * A parent accepts a frame message only when it came from the frame window it
 * created AND from the configured frame origin. `event.source` closes the
 * gap where another window happens to share the origin.
 */
export function isTrustedFrameMessage(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  expectedOrigin: string,
  frame: Window | null,
): boolean {
  return (
    isTrustedFrameOrigin(event.origin, expectedOrigin) &&
    frame !== null &&
    event.source === frame &&
    isTimelineRenderFrameMessage(event.data)
  );
}
