/**
 * The preview host contract.
 *
 * A preview host relays transport intent to whichever producer renders the
 * composition and republishes the producer's own facts. It has no clock and
 * no frame timer: `seek`, `play`, and `pause` are intents, and the producer
 * stays the time authority for the frames it shows. This is what lets the
 * Remotion Player keep its clock while it is hosted inside an isolated frame.
 */
import type { PlayerTransportEvent } from "../components/playerTransport";
import type { PreviewCompositionDescriptor } from "./protocol";

/**
 * Where the producer runs.
 *
 * - `main-thread` keeps today's behaviour: the producer shares the editor's
 *   UI thread.
 * - `iframe` hosts the producer in a separate document. The frame only
 *   isolates the editor when it is served from a different *site* than the
 *   editor; a same-site, `srcdoc`, or `blob:` frame stays in the editor's
 *   renderer process.
 */
export type PreviewHostMode = "main-thread" | "iframe";

/**
 * Facts a producer reports back to the editor. `transport` carries the same
 * vocabulary as the existing `playerTransport` reducer, so a hosted producer
 * feeds the editor's transport state without a second state machine.
 */
export type PreviewHostFact =
  | { type: "frame"; frame: number }
  | { type: "transport"; event: PlayerTransportEvent }
  | { type: "audio-levels"; left: number; right: number }
  | { type: "error"; message: string };

export type PreviewHostListener = (fact: PreviewHostFact) => void;

export interface PreviewHost {
  readonly mode: PreviewHostMode;
  /** Prepares the producer for a composition. Safe to call once per mount. */
  mount(composition: PreviewCompositionDescriptor): void;
  /** Releases the producer. The host stays usable and can mount again. */
  unmount(): void;
  /** Requests a frame. The producer decides how to produce it. */
  seek(frame: number): void;
  /** Asks the producer to run its own clock. */
  play(): void;
  /** Asks the producer to stop its own clock. */
  pause(): void;
  /**
   * Asks the frame to sample and report stereo audio levels for the parent
   * meter. Cross-origin media is unreachable from the editor document, so the
   * frame samples locally and posts `audio-levels` facts.
   */
  setAudioMeterEnabled(enabled: boolean): void;
  /** The frame the producer last reported, or null before the first report. */
  getCurrentFrame(): number | null;
  /**
   * Publishes a producer-reported fact. Producer-side only: the editor reads
   * facts through `subscribe` instead.
   */
  publish(fact: PreviewHostFact): void;
  /** Subscribes to producer-reported facts. Returns an unsubscribe function. */
  subscribe(listener: PreviewHostListener): () => void;
}
