import {
  createIframePreviewHost,
  type IframePreviewHostOptions,
} from "./iframeHost";
import {
  createMainThreadPreviewHost,
  type MainThreadPreviewHostOptions,
} from "./mainThreadHost";
import type { PreviewHost, PreviewHostMode } from "./types";

export interface CreatePreviewHostOptions {
  /**
   * Where the producer runs. `main-thread` keeps today's behaviour; `iframe`
   * hosts the producer in a separate document.
   */
  mode: PreviewHostMode;
  /** Required for `mode: "main-thread"`. */
  mainThread?: MainThreadPreviewHostOptions;
  /** Required for `mode: "iframe"`. */
  iframe?: IframePreviewHostOptions;
}

/**
 * Creates a preview host for the requested mode.
 *
 * Both modes answer the same contract, so the editor's transport code does not
 * branch on where the producer lives. Neither mode introduces a clock: the
 * producer keeps its own time base.
 */
export function createPreviewHost(options: CreatePreviewHostOptions): PreviewHost {
  if (options.mode === "main-thread") {
    if (!options.mainThread) {
      throw new Error(
        "createPreviewHost({ mode: 'main-thread' }) needs mainThread options.",
      );
    }
    return createMainThreadPreviewHost(options.mainThread);
  }
  if (!options.iframe) {
    throw new Error(
      "createPreviewHost({ mode: 'iframe' }) needs iframe options.",
    );
  }
  return createIframePreviewHost(options.iframe);
}
