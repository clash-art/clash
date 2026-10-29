export { VideoComposition } from "./VideoComposition";
export {
  useRemotionMgElementEdit,
  type MgElementEditHandlers,
  type MgElementEditPatch,
} from "./mg-element-edit";
export { resolveProjectedMediaUrl } from "./projected-media-url";
export {
  InlineRemotionSourceError,
  RemotionSourceComposition,
  compileInlineRemotionSource,
  type InlineRemotionComponent,
  type InlineRemotionComponentProps,
  type RemotionSourceCompositionProps,
} from "./inline-remotion-source";
export {
  TIMELINE_RENDER_DEFAULT_COVERAGE,
  TIMELINE_RENDER_FIELD_CONSUMERS,
  TIMELINE_RENDER_ROOT_TRACK_FIELD_CONSUMERS,
  TIMELINE_TRANSITION_CONTENT_FIELD_CONSUMERS,
  TIMELINE_TRANSITION_RENDER_ITEM_TYPES,
  isTimelineTransitionRenderItem,
  type TimelineTransitionRenderItem,
} from "./timeline-render-field-consumers";
export { EffectSdkDemo } from "./effect-demo/EffectSdkDemo";
export { TimelineLibraryDemo } from "./library-demo/TimelineLibraryDemo";

export {
  HTML_SCENE_SANDBOX,
  HTML_SCENE_DOCUMENT_PROTOCOL,
  HTML_SCENE_DEFAULT_CSP,
  measureHtmlDocumentBytes,
  validateHtmlDocumentCapacity,
  htmlSceneBootstrapScript,
  wrapHtmlDocumentForPreview,
  createHtmlSceneBlobUrl,
  isHtmlSceneDocCommand,
  HtmlSceneSurface,
  type HtmlDocumentCapacityResult,
  type HtmlSceneBlobHandle,
  type HtmlSceneDocCommand,
  type HtmlSceneSurfaceProps,
} from "./html-scene";
