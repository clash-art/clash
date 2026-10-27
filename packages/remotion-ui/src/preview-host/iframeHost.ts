import { PreviewHostEmitter } from "./emitter";
import {
  PREVIEW_HOST_PROTOCOL,
  isPreviewHostEvent,
  type PreviewCompositionDescriptor,
  type PreviewHostCommand,
  type PreviewHostEvent,
} from "./protocol";
import type { PreviewHost, PreviewHostFact } from "./types";

/**
 * The link between the editor and a hosted producer.
 *
 * A bridge is deliberately transport-agnostic: `postMessage` is one
 * implementation, but a test can supply an in-memory bridge and exercise the
 * whole host contract without a browser frame.
 */
export interface PreviewHostBridge {
  /** Sends a command to the hosted producer. */
  send(command: PreviewHostCommand): void;
  /** Subscribes to the producer's events. Returns an unsubscribe function. */
  onEvent(listener: (event: PreviewHostEvent) => void): () => void;
  /** Releases the frame and its listeners. */
  dispose(): void;
}

export interface IframePreviewHostOptions {
  /**
   * Creates the isolated frame. The host calls this on mount, so the frame is
   * created lazily and torn down on unmount.
   */
  createBridge(): PreviewHostBridge;
}

function factFromEvent(event: PreviewHostEvent): PreviewHostFact | null {
  switch (event.type) {
    case "frame":
      return { type: "frame", frame: event.frame };
    case "transport":
      return { type: "transport", event: event.event };
    case "error":
      return { type: "error", message: event.message };
    case "ready":
      return null;
    default:
      return null;
  }
}

/**
 * Hosts a producer that runs in a separate document.
 *
 * The host is a thin, clock-free relay: it forwards seek/play/pause intent to
 * the frame and republishes the frames and transport facts the frame reports.
 * The producer inside the frame stays the time authority, so the Remotion
 * Player keeps its own clock once it is hosted there.
 */
export function createIframePreviewHost(
  options: IframePreviewHostOptions,
): PreviewHost {
  const emitter = new PreviewHostEmitter();
  let bridge: PreviewHostBridge | null = null;
  let unsubscribe: (() => void) | null = null;
  let composition: PreviewCompositionDescriptor | null = null;
  let currentFrame: number | null = null;

  const handleEvent = (event: PreviewHostEvent) => {
    const fact = factFromEvent(event);
    if (!fact) return;
    if (fact.type === "frame") {
      currentFrame = fact.frame;
    }
    emitter.publish(fact);
  };

  return {
    mode: "iframe",
    mount(next: PreviewCompositionDescriptor) {
      composition = next;
      bridge = options.createBridge();
      unsubscribe = bridge.onEvent(handleEvent);
      bridge.send({
        protocol: PREVIEW_HOST_PROTOCOL,
        type: "mount",
        composition: next,
      });
    },
    unmount() {
      bridge?.send({ protocol: PREVIEW_HOST_PROTOCOL, type: "unmount" });
      unsubscribe?.();
      unsubscribe = null;
      bridge?.dispose();
      bridge = null;
      composition = null;
      currentFrame = null;
    },
    seek(frame: number) {
      bridge?.send({ protocol: PREVIEW_HOST_PROTOCOL, type: "seek", frame });
    },
    play() {
      bridge?.send({ protocol: PREVIEW_HOST_PROTOCOL, type: "play" });
    },
    pause() {
      bridge?.send({ protocol: PREVIEW_HOST_PROTOCOL, type: "pause" });
    },
    getCurrentFrame() {
      return currentFrame;
    },
    publish(fact: PreviewHostFact) {
      emitter.publish(fact);
    },
    subscribe(listener) {
      return emitter.subscribe(listener);
    },
  };
}
