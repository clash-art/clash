import { PreviewHostEmitter } from "./emitter";
import type { PreviewCompositionDescriptor } from "./protocol";
import type { PreviewHost, PreviewHostFact } from "./types";

/**
 * The slice of `@remotion/player`'s `PlayerRef` a host needs. Keeping the
 * dependency this narrow lets the host be driven by the real Player today and
 * by a hosted Player inside a frame later without changing the contract.
 */
export interface PreviewPlayerAdapter {
  getCurrentFrame(): number;
  seekTo(frame: number): void;
  play(): void;
  pause(): void;
}

export interface MainThreadPreviewHostOptions {
  /**
   * Resolves the live Player, or null before it mounts. The React owner of the
   * Player supplies this; the host never creates or destroys the Player.
   */
  resolvePlayer(): PreviewPlayerAdapter | null;
}

/**
 * Hosts a producer that already runs on the editor's own thread.
 *
 * This is today's behaviour, wrapped in the same contract the isolated host
 * implements, so both modes can be compared without the editor's transport
 * code knowing where the producer lives. The Player keeps its own clock here:
 * the host only forwards intent and republishes the Player's own facts.
 */
export function createMainThreadPreviewHost(
  options: MainThreadPreviewHostOptions,
): PreviewHost {
  const emitter = new PreviewHostEmitter();
  let composition: PreviewCompositionDescriptor | null = null;
  let currentFrame: number | null = null;
  let mounted = false;

  return {
    mode: "main-thread",
    mount(next: PreviewCompositionDescriptor) {
      composition = next;
      mounted = true;
    },
    unmount() {
      mounted = false;
      composition = null;
      currentFrame = null;
      options.resolvePlayer()?.pause();
    },
    seek(frame: number) {
      if (!mounted) return;
      options.resolvePlayer()?.seekTo(frame);
    },
    play() {
      if (!mounted) return;
      options.resolvePlayer()?.play();
    },
    pause() {
      if (!mounted) return;
      options.resolvePlayer()?.pause();
    },
    getCurrentFrame() {
      return currentFrame;
    },
    publish(fact: PreviewHostFact) {
      if (fact.type === "frame") {
        currentFrame = fact.frame;
      }
      emitter.publish(fact);
    },
    subscribe(listener) {
      return emitter.subscribe(listener);
    },
  };
}
