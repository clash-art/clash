import {
  isPreviewHostEvent,
  type PreviewHostCommand,
  type PreviewHostEvent,
} from "./protocol";
import type { PreviewHostBridge } from "./iframeHost";

export interface PostMessageFrameOptions {
  /** Element the frame is appended to. */
  container: HTMLElement;
  /** URL of the frame document that hosts the producer. */
  frameUrl: string;
  /**
   * Origin the frame is served from. Messages are only accepted from this
   * origin, and commands are only posted to it.
   */
  frameOrigin: string;
  /** Accessible title for the frame element. */
  title?: string;
  /** Document that owns the frame. Defaults to the ambient document. */
  document?: Document;
}

/**
 * Builds a `postMessage` bridge to an isolated preview frame.
 *
 * Two rules keep the channel trustworthy:
 *
 * 1. A message is only accepted when it comes from the exact origin this
 *    bridge created the frame for *and* from the frame's own window, so
 *    another page in the editor cannot inject transport facts.
 * 2. Commands are posted to the frame's origin, never to `"*"`.
 *
 * Isolation note: a frame only gets its own renderer process when it is
 * served from a different site than the editor. A `srcdoc`, `blob:`, or
 * same-site frame shares the editor's process and therefore its UI thread.
 */
export function createPostMessageFrameBridge(
  options: PostMessageFrameOptions,
): PreviewHostBridge {
  const ownerDocument = options.document ?? globalThis.document;
  if (!ownerDocument) {
    throw new Error(
      "A preview frame needs a document to create the iframe in.",
    );
  }
  const frame = ownerDocument.createElement("iframe");
  frame.title = options.title ?? "Clash preview host";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    "width:100%",
    "height:100%",
    "border:0",
    "pointer-events:none",
  ].join(";");

  const listeners = new Set<(event: PreviewHostEvent) => void>();
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== options.frameOrigin) return;
    if (event.source !== frame.contentWindow) return;
    if (!isPreviewHostEvent(event.data)) return;
    for (const listener of [...listeners]) {
      listener(event.data);
    }
  };
  ownerDocument.defaultView?.addEventListener("message", onMessage);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ownerDocument.defaultView?.removeEventListener("message", onMessage);
    listeners.clear();
    frame.remove();
  };

  frame.src = options.frameUrl;
  options.container.appendChild(frame);

  return {
    send(command: PreviewHostCommand) {
      if (disposed) return;
      frame.contentWindow?.postMessage(command, options.frameOrigin);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose,
  };
}
