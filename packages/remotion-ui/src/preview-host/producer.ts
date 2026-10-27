import type { PreviewCompositionDescriptor } from "./protocol";

/**
 * A preview frame producer.
 *
 * A producer renders the composition inside whatever host it was given: the
 * editor's own thread, an isolated frame, or (later) an offscreen document.
 * This is the seam a second runtime can plug into without the editor learning
 * anything about it.
 *
 * The producer owns its time base. `seek` asks for a frame, `play` asks the
 * producer to run its own clock, and `onFrame` reports what the producer
 * actually shows. The producer never asks the host to advance time, and the
 * host never derives time for the producer: there is no global playback clock
 * in this contract, and none is implied by it.
 */
export interface PreviewFrameProducer {
  /** Identifies the producer, e.g. `"remotion-player"` or `"html-scene"`. */
  readonly kind: string;
  /** Prepares the producer for a composition of the given geometry. */
  prepare(composition: PreviewCompositionDescriptor): void | Promise<void>;
  /** Renders or presents the requested frame. */
  seek(frame: number): void | Promise<void>;
  /** Starts the producer's own clock. */
  play(): void | Promise<void>;
  /** Stops the producer's own clock. */
  pause(): void | Promise<void>;
  /** Releases the producer's resources. */
  dispose(): void | Promise<void>;
  /** Reports the frame the producer currently shows. */
  onFrame(listener: (frame: number) => void): () => void;
}

/**
 * The surface a producer uses to report back to its host.
 *
 * A producer reports the frame it shows and the transport facts it observes.
 * It does not report a time base to the host: the host has none.
 */
export interface PreviewProducerReporter {
  /** Reports the frame the producer currently shows. */
  reportFrame(frame: number): void;
  /** Reports a transport fact the producer observed. */
  reportTransport(event: PreviewProducerTransportEvent): void;
  /** Reports a terminal failure. */
  reportError(message: string): void;
}

/**
 * Transport facts a producer may report. The vocabulary matches the editor's
 * existing `playerTransport` reducer so both hosted and main-thread producers
 * feed the same state machine.
 */
export type PreviewProducerTransportEvent =
  | { type: "play" }
  | { type: "pause" }
  | { type: "ended" }
  | { type: "waiting" }
  | { type: "resume" }
  | { type: "error"; message: string };
