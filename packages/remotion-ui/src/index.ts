// Export all UI components
export { Editor } from "./components/Editor";
export type {
  MgElementEditHandlers,
  MgElementEditPatch,
} from "./components/mgElementEdit";
export type { TimelineAssetInsertRequest } from "./components/timeline/insertAssetRequest";
export { AssetPanel } from "./components/AssetPanel";
export { Timeline } from "./components/Timeline";
export { PropertiesPanel } from "./components/PropertiesPanel";
export {
  AspectRatioPicker,
  closestAspectRatioOption,
  parseAspectRatio,
  type AspectRatioDimensions,
  type AspectRatioOption,
  type AspectRatioPickerProps,
  type AspectRatioValue,
} from "./components/AspectRatioPicker";
export {
  TranscriptEditor,
  type TranscriptEditorProps,
} from "./components/TranscriptEditor";
export {
  CaptionWorkspace,
  type CaptionWorkspaceProps,
} from "./components/CaptionWorkspace";
export { TimelineLibraryPanel } from "./components/TimelineLibraryPanel";
export { InteractiveCanvas } from "./components/InteractiveCanvas";
export type { CanvasViewportCommand } from "./components/InteractiveCanvas";
export {
  TimelineRuler,
  type TimelineRulerTokens,
} from "./components/timeline/TimelineRuler";
export {
  anchoredTimelineScrollLeft,
  clampTimelineZoom,
  fitTimelineZoom,
  sliderValueToZoom,
  stepTimelineZoom,
  zoomToSliderValue,
} from "./components/timeline/zoom";
export {
  formatTime,
  formatTimecode,
  frameToPixels,
  framesToSeconds,
  getPixelsPerFrame,
  pixelsToFrame,
  secondsToFrames,
} from "./components/timeline/utils/timeFormatter";

// Export utilities
export {
  thumbnailCache,
  generateVideoThumbnail,
  generateVideoThumbnailAtTime,
} from "./utils/thumbnailCache";

// Re-export core for convenience
export * from "@clash/remotion-core";

export {
  TIMELINE_EDITOR_FIELD_CONSUMERS,
  TIMELINE_EDITOR_ROOT_TRACK_FIELD_CONSUMERS,
  TIMELINE_EDITOR_DEFAULT_COVERAGE,
} from "./timeline-editor-field-consumers";
