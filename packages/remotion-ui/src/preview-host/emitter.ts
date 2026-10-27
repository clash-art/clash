import type { PreviewHostFact, PreviewHostListener } from "./types";

/**
 * Fan-out for producer-reported facts. A plain Set keeps subscription order
 * stable and makes unsubscription explicit, so a host can be torn down without
 * leaving listeners behind.
 */
export class PreviewHostEmitter {
  private readonly listeners = new Set<PreviewHostListener>();

  publish(fact: PreviewHostFact): void {
    // Copy first: a listener may unsubscribe while it is being notified.
    for (const listener of [...this.listeners]) {
      listener(fact);
    }
  }

  subscribe(listener: PreviewHostListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
