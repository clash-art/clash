import { PreviewHostEmitter } from "./emitter";
import {
  PREVIEW_HOST_PROTOCOL,
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
   * Creates the isolated frame. The host calls this on the first mount, so the
   * frame is created lazily and torn down on unmount.
   */
  createBridge(): PreviewHostBridge;
  /**
   * Origin of the editor document. Required on every mount so the frame knows
   * where replies may go (referrer alone is unreliable under strict policies).
   */
  parentOrigin: string;
}

function factFromEvent(event: PreviewHostEvent): PreviewHostFact | null {
  switch (event.type) {
    case "frame":
      return { type: "frame", frame: event.frame };
    case "transport":
      return { type: "transport", event: event.event };
    case "audio-levels":
      return { type: "audio-levels", left: event.left, right: event.right };
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
 *
 * Mount is deferred until the frame announces `ready`, matching the browser
 * Timeline render-frame handshake so a postMessage never races the frame's
 * module load.
 */
export function createIframePreviewHost(
  options: IframePreviewHostOptions,
): PreviewHost {
  const emitter = new PreviewHostEmitter();
  let bridge: PreviewHostBridge | null = null;
  let unsubscribe: (() => void) | null = null;
  let currentFrame: number | null = null;
  let frameReady = false;
  let pendingComposition: PreviewCompositionDescriptor | null = null;

  const sendMount = (composition: PreviewCompositionDescriptor) => {
    bridge?.send({
      protocol: PREVIEW_HOST_PROTOCOL,
      type: "mount",
      composition,
      parentOrigin: options.parentOrigin,
    });
  };

  const handleEvent = (event: PreviewHostEvent) => {
    if (event.type === "ready") {
      frameReady = true;
      if (pendingComposition) {
        sendMount(pendingComposition);
      }
      return;
    }
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
      pendingComposition = next;
      if (!bridge) {
        frameReady = false;
        bridge = options.createBridge();
        unsubscribe = bridge.onEvent(handleEvent);
      } else if (frameReady) {
        sendMount(next);
      }
    },
    unmount() {
      bridge?.send({ protocol: PREVIEW_HOST_PROTOCOL, type: "unmount" });
      unsubscribe?.();
      unsubscribe = null;
      bridge?.dispose();
      bridge = null;
      currentFrame = null;
      frameReady = false;
      pendingComposition = null;
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
    setAudioMeterEnabled(enabled: boolean) {
      bridge?.send({
        protocol: PREVIEW_HOST_PROTOCOL,
        type: "set-audio-meter",
        enabled,
      });
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
