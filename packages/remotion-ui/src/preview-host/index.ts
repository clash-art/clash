/**
 * Preview host: the contract that lets preview frame production move off the
 * editor's UI thread without changing who owns the clock.
 *
 * The Remotion Player stays the time authority for a Remotion preview. This
 * module only carries transport intent into a host and the producer's own
 * facts back out; it introduces no playback clock of its own.
 */
export {
  PREVIEW_HOST_PROTOCOL,
  isPreviewHostCommand,
  isPreviewHostEvent,
  type PreviewCompositionDescriptor,
  type PreviewHostCommand,
  type PreviewHostEvent,
  type PreviewTransportEvent,
} from "./protocol";
export {
  createMainThreadPreviewHost,
  type MainThreadPreviewHostOptions,
  type PreviewPlayerAdapter,
} from "./mainThreadHost";
export {
  createIframePreviewHost,
  type IframePreviewHostOptions,
  type PreviewHostBridge,
} from "./iframeHost";
export {
  createPostMessageFrameBridge,
  type PostMessageFrameOptions,
} from "./postMessageFrame";
export {
  createPreviewHost,
  type CreatePreviewHostOptions,
} from "./createPreviewHost";
export {
  LONG_TASK_THRESHOLD_MS,
  createLongTaskRecorder,
  summarizeLongTasks,
  type LongTaskObserver,
  type LongTaskRecorder,
  type LongTaskRecorderOptions,
  type PreviewMainThreadMetric,
} from "./metrics";
export {
  type PreviewFrameProducer,
  type PreviewProducerReporter,
  type PreviewProducerTransportEvent,
} from "./producer";
export type {
  PreviewHost,
  PreviewHostFact,
  PreviewHostListener,
  PreviewHostMode,
} from "./types";
export {
  resolvePreviewHostConfig,
  previewHostIsolationWarning,
  type PreviewHostRuntimeConfig,
} from "./previewHostConfig";
export {
  IframedRemotionPreview,
  type IframedRemotionPreviewProps,
} from "./IframedRemotionPreview";

export {
  createHtmlSceneProducer,
  extractHtmlScenesFromComposition,
  compositionHasHtmlScenes,
  compositionIsHtmlOnly,
  type HtmlSceneDescriptor,
  type CreateHtmlSceneProducerOptions,
} from "./htmlSceneProducer";
