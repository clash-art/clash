/**
 * Preview host wire protocol.
 *
 * The protocol carries transport *intent* (seek, play, pause) into an isolated
 * preview host and producer-reported *facts* (current frame, transport state)
 * back out. It deliberately contains no clock: whichever producer is hosted
 * owns its own time base, exactly as the Remotion Player owns the clock in the
 * editor today. There is no frame timer, no interpolation, and no master clock
 * in this protocol.
 *
 * No React, DOM, or Remotion import lives here, so the protocol stays unit
 * testable and the editor bundle never evaluates the hosted producer.
 */
import type { PlayerTransportEvent } from "../components/playerTransport";

export const PREVIEW_HOST_PROTOCOL = "clash.preview-host.v1" as const;

/**
 * Player-reported facts only. `retry` is an editor action (it remounts the
 * editor's own media) and never crosses the host boundary.
 */
export type PreviewTransportEvent = Exclude<
  PlayerTransportEvent,
  { type: "retry" }
>;

/**
 * The geometry and timing of the composition a producer must present. The
 * producer derives its own frame rate from `fps`; the host never drives time.
 *
 * `tracks` and `allNodes` are opaque JSON the Remotion `VideoComposition`
 * understands. Keeping them `unknown` keeps this file free of Remotion imports.
 * An HTML producer may ignore tracks and use a different payload later.
 */
export interface PreviewCompositionDescriptor {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** Timeline tracks for a Remotion VideoComposition producer. */
  tracks?: unknown[];
  /** Optional Canvas node map for live sourceNodeId resolution. */
  allNodes?: unknown;
}

export type PreviewHostCommand =
  | {
      protocol: typeof PREVIEW_HOST_PROTOCOL;
      type: "mount";
      composition: PreviewCompositionDescriptor;
      /** Origin allowed to receive this frame's replies. */
      parentOrigin: string;
    }
  | { protocol: typeof PREVIEW_HOST_PROTOCOL; type: "seek"; frame: number }
  | { protocol: typeof PREVIEW_HOST_PROTOCOL; type: "play" }
  | { protocol: typeof PREVIEW_HOST_PROTOCOL; type: "pause" }
  | { protocol: typeof PREVIEW_HOST_PROTOCOL; type: "unmount" };

export type PreviewHostEvent =
  | { protocol: typeof PREVIEW_HOST_PROTOCOL; type: "ready" }
  | {
      protocol: typeof PREVIEW_HOST_PROTOCOL;
      type: "frame";
      frame: number;
    }
  | {
      protocol: typeof PREVIEW_HOST_PROTOCOL;
      type: "transport";
      event: PreviewTransportEvent;
    }
  | {
      protocol: typeof PREVIEW_HOST_PROTOCOL;
      type: "error";
      message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFrame(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCompositionDescriptor(
  value: unknown,
): value is PreviewCompositionDescriptor {
  if (!isRecord(value)) return false;
  return (
    isFrame(value.width) &&
    isFrame(value.height) &&
    isFrame(value.fps) &&
    isFrame(value.durationInFrames) &&
    (value.tracks === undefined || Array.isArray(value.tracks))
  );
}

function isTransportEvent(value: unknown): value is PreviewTransportEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "play":
    case "pause":
    case "ended":
    case "waiting":
    case "resume":
      return true;
    case "error":
      return typeof value.message === "string";
    default:
      return false;
  }
}

export function isPreviewHostCommand(
  value: unknown,
): value is PreviewHostCommand {
  if (!isRecord(value) || value.protocol !== PREVIEW_HOST_PROTOCOL) return false;
  switch (value.type) {
    case "mount":
      return (
        isCompositionDescriptor(value.composition) &&
        typeof value.parentOrigin === "string" &&
        value.parentOrigin.length > 0
      );
    case "seek":
      return isFrame(value.frame);
    case "play":
    case "pause":
    case "unmount":
      return true;
    default:
      return false;
  }
}

export function isPreviewHostEvent(value: unknown): value is PreviewHostEvent {
  if (!isRecord(value) || value.protocol !== PREVIEW_HOST_PROTOCOL) return false;
  switch (value.type) {
    case "ready":
      return true;
    case "frame":
      return isFrame(value.frame);
    case "transport":
      return isTransportEvent(value.event);
    case "error":
      return typeof value.message === "string";
    default:
      return false;
  }
}
