import type {
  TimelineItemKeyframes,
  TimelineItemMask,
} from '@clash/shared-types';

// Properties for positioning and transforming items on canvas
export type ItemProperties = {
  x: number; // X position in pixels from canvas center
  y: number; // Y position in pixels from canvas center
  // Unitless source-size multipliers, never output pixels. The renderer treats
  // the default pair (1, 1) as contain-fit within the composition.
  width: number;
  height: number;
  rotation?: number; // Rotation in degrees
  opacity?: number; // Opacity (0-1)
  // Note: zIndex is determined by track order, not stored in properties
};

export type EffectParamValue = string | number | boolean | [number, number];

/**
 * Stable reference to a versioned Effect SDK definition. Timeline documents
 * store declarative parameters only; shader source and executable code stay in
 * installed effect packages.
 */
export type EffectInstanceRef = {
  effectId: string;
  effectVersion: number;
  params?: Record<string, EffectParamValue>;
};

// Base types for timeline items
export type BaseItem = {
  id: string;
  from: number; // Start frame (resolved absolute frame; the canonical value
                // every consumer reads — VideoComposition, render-server, DnD)
  durationInFrames: number;
  /** D1 asset row id, matching canvas node data.assetId. */
  assetId?: string;
  /** Canvas source node id. Legacy DSL stored this value in assetId. */
  sourceNodeId?: string;
  properties?: ItemProperties; // Canvas positioning and transform properties
  /** Seek-safe item-local transform animation shared by GUI, agents, preview, and export. */
  keyframes?: TimelineItemKeyframes;
  /** Resolution-independent clip-local mask shared by GUI, agents, preview, and export. */
  mask?: TimelineItemMask;
  /** Ordered, version-pinned clip effect stack. */
  effects?: EffectInstanceRef[];
  /** Rendered replacement used when exporting effects to an external NLE. */
  bakedAssetPath?: string;
  /**
   * Original relative-position expression authored by the agent or user via
   * YAML — kept as an opaque memo. The `from` field above is the resolved
   * absolute frame and is what every internal consumer actually reads.
   *
   * Examples (parsed by packages/shared-types/src/timeline-yaml.ts):
   *   "30"          → absolute 30
   *   "prev"        → previous item in the same track + 0
   *   "prev+15"     → previous item's end + 15
   *   "clip-A-30"   → item with id "clip-A" — 30 (overlap)
   *   "start"       → 0
   *
   * Cleared whenever the user moves the item via DnD (the absolute
   * position no longer matches the expression's intent).
   */
  fromExpr?: string;
};

// Different item types
export type SolidItem = BaseItem & {
  type: 'solid';
  color: string;
};

export type TypographyStyle<TFontWeight extends string | number = string | number> = {
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: TFontWeight;
};

export type MediaFit = 'fill' | 'cover' | 'contain';

export type ClipAnimationType =
  | 'fade'
  | 'zoom-in'
  | 'zoom-out'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down';

/**
 * A seek-safe clip animation. Absence means no animation; durations are
 * explicit Timeline frames so preview, export, and agent edits agree.
 */
export type ClipAnimation = {
  type: ClipAnimationType;
  durationInFrames: number;
};

export type TextItem = BaseItem & TypographyStyle & {
  type: 'text';
  text: string;
  color: string;
  /** Horizontal alignment for plain title/text items. */
  textAlign?: 'left' | 'center' | 'right';
  /** Plain-text tracking in rendered pixels. */
  letterSpacingPx?: number;
  /** Unitless plain-text line-height multiplier. */
  lineHeight?: number;
  /**
   * Structured timed-text payload. Subtitle tracks use the same `text` item
   * type as titles; cues and lineage distinguish timed subtitles from plain
   * text without introducing a second item taxonomy.
   */
  cues?: CaptionCue[];
  language?: string;
  wordRefs?: CaptionWordReference[];
  sourceToOutputMap?: SourceToOutputFrameMap[];
  style?: TypographyStyle & {
    backgroundColor?: string;
    position?: 'bottom' | 'top' | 'center';
  };
};

export type VideoItem = BaseItem & {
  type: 'video';
  src: string;
  /** How the source is fitted into the transformed item bounds. */
  mediaFit?: MediaFit;
  // Number of frames to skip from the start of the source media
  // when rendering this item (i.e., in-source start offset)
  sourceStartInFrames?: number;
  /** Canonical clip gain in decibels. Valid editor range: -60 (silence) to +12. */
  audioGainDb?: number;
  /** @deprecated Legacy linear gain. New writes use audioGainDb. */
  volume?: number;
  waveform?: number[];
  /** Visual animation applied at the start of this video clip. */
  entranceAnimation?: ClipAnimation;
  /** Visual animation applied at the end of this video clip. */
  exitAnimation?: ClipAnimation;
  videoFadeIn?: number; // Video fade in duration in frames
  videoFadeOut?: number; // Video fade out duration in frames
  /** Canonical audio fade-in duration in frames. */
  audioFadeInFrames?: number;
  /** Canonical audio fade-out duration in frames. */
  audioFadeOutFrames?: number;
  /** @deprecated Legacy alias for audioFadeInFrames. */
  audioFadeIn?: number;
  /** @deprecated Legacy alias for audioFadeOutFrames. */
  audioFadeOut?: number;
  /**
   * Optional CSS color (e.g. "white", "#000"). If set, the videoFadeIn
   * window is rendered as a colored overlay ramping out (the clip emerges
   * FROM that color) instead of opacity-fading the video. Pair with the
   * previous clip's videoFadeOutColor to produce a flash / fade-through-
   * color transition.
   */
  videoFadeInColor?: string;
  /** Mirror of videoFadeInColor for the fade-out window. */
  videoFadeOutColor?: string;
};

export type AudioItem = BaseItem & {
  type: 'audio';
  src: string;
  // Number of frames to skip from the start of the source media
  // when rendering this item (i.e., in-source start offset)
  sourceStartInFrames?: number;
  /** Canonical clip gain in decibels. Valid editor range: -60 (silence) to +12. */
  audioGainDb?: number;
  /** Automatically reduce this clip while a spoken-media lane is active. */
  audioDucking?: AudioDuckingSettings;
  /** @deprecated Legacy linear gain. New writes use audioGainDb. */
  volume?: number;
  waveform?: number[];
  /** Canonical audio fade-in duration in frames. */
  audioFadeInFrames?: number;
  /** Canonical audio fade-out duration in frames. */
  audioFadeOutFrames?: number;
  /** @deprecated Legacy alias for audioFadeInFrames. */
  audioFadeIn?: number;
  /** @deprecated Legacy alias for audioFadeOutFrames. */
  audioFadeOut?: number;
};

export type AudioDuckingSettings = {
  /** Gain change applied at full duck. Valid range: -60..0 dB. */
  amountDb: number;
  /** Frames used to ramp down before spoken media starts. */
  attackFrames: number;
  /** Frames used to restore gain after spoken media ends. */
  releaseFrames: number;
};

export type ImageItem = BaseItem & {
  type: 'image';
  src: string;
  /** How the source is fitted into the transformed item bounds. */
  mediaFit?: MediaFit;
  /** Image fade-in duration in frames. */
  imageFadeIn?: number;
  /** Image fade-out duration in frames. */
  imageFadeOut?: number;
  /** See VideoItem.videoFadeInColor — same semantics for images. */
  imageFadeInColor?: string;
  /** See VideoItem.videoFadeOutColor — same semantics for images. */
  imageFadeOutColor?: string;
};

export type StickerItem = BaseItem & {
  type: 'sticker';
  // Either animated webp/gif, or an image sequence.
  src: string;
  /** How the sticker source is fitted into the transformed item bounds. */
  mediaFit?: MediaFit;
  // Optional sequence metadata for future support
  sequence?: {
    baseUrl: string; // e.g., /frames/frame_####.png
    frameCount: number;
    fps: number;
  };
};

export type CompositionRuntime = 'html' | 'react' | 'remotion';

export type CompositionItem = BaseItem & {
  type: 'composition';
  compositionKind: 'motion-graphics' | 'custom';
  runtime: CompositionRuntime;
  compositionId: string;
  /**
   * Local project path owned by the user/agent cwd. Remote URLs are rejected
   * by timeline validation; rendering must go through explicit asset/runtime
   * plumbing instead of executing network code from timeline state.
   */
  sourcePath: string;
  /** Optional rendered preview/export asset path. */
  renderedAssetPath?: string;
  /** Optional inert configuration preserved for legacy custom compositions. */
  spec?: Record<string, unknown>;
};

export type CaptionCue = {
  id: string;
  startFrame: number;
  durationInFrames: number;
  text: string;
  wordIds?: string[];
  sourceStartFrame?: number;
  sourceEndFrame?: number;
};

export type CaptionWordReference = {
  id: string;
  text: string;
  /** Immutable source lineage used to keep generated subtitle Text in sync with transcript corrections. */
  assetId?: string;
  assetWordId?: string;
  clipId?: string;
  trackId?: string;
  sourceStartFrame: number;
  sourceEndFrame: number;
  confidence?: number;
};

export type SourceToOutputFrameMap = {
  sourceStartFrame: number;
  sourceEndFrame: number;
  outputStartFrame: number;
  outputEndFrame: number;
};

export type SubtitleTextItem = TextItem & {
  type: 'text';
  cues: CaptionCue[];
};

export type DerivedOverlayItem = BaseItem & {
  type: 'derived-overlay';
  mediaType: 'image' | 'video';
  src: string;
  /** How the immutable derived source is fitted into the transformed item bounds. */
  mediaFit?: MediaFit;
  sourceAssetId: string;
  derivedAssetId: string;
  derivation: {
    kind: 'trim' | 'crop' | 'caption-burn' | 'transcode' | 'other';
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

/**
 * Transition between two clips. Sits on the timeline like any other item;
 * during [from, from + durationInFrames) it renders fromItem and toItem
 * simultaneously with a transition effect applied. The referenced items
 * are auto-hidden on their original tracks during the transition window
 * (the renderer wires this up — see VideoComposition).
 *
 * Phase B v1 effects:
 *  - push-left / push-right: translateX both clips
 *  - circle-wipe: animated clip-path circle reveals toItem over fromItem
 *  - crossfade: opacity blend (cleaner alternative to dual fadeIn/fadeOut)
 */
export type TransitionType =
  | 'crossfade'
  | 'push-left'
  | 'push-right'
  | 'slide-up'
  | 'slide-down'
  | 'wipe-left'
  | 'wipe-right'
  | 'circle-wipe'
  | 'zoom-in';

export type TransitionItem = BaseItem & {
  type: 'transition';
  transitionType: TransitionType;
  /** ID of the clip leaving the screen. */
  fromItemId: string;
  /** ID of the clip entering the screen. */
  toItemId: string;
  /** Optional SDK effect that supersedes the legacy transitionType renderer. */
  effect?: EffectInstanceRef;
};

export type Item =
  | SolidItem
  | TextItem
  | VideoItem
  | AudioItem
  | ImageItem
  | StickerItem
  | CompositionItem
  | DerivedOverlayItem
  | TransitionItem;

export function isSubtitleTextItem(item: Item): item is SubtitleTextItem {
  return item.type === 'text' && Array.isArray(item.cues);
}

export type TrackRole =
  | 'primary-video'
  | 'b-roll'
  | 'overlay'
  | 'subtitle'
  | 'narration'
  | 'dialogue'
  | 'music'
  | 'sfx'
  | 'transition'
  | 'mixed';

/**
 * Structural lane category used by the editor and agent-facing timeline DSL.
 * Categories are intentionally broader than TrackRole: roles describe purpose,
 * while categories define which item kinds may share a lane and where the lane
 * sits vertically.
 */
export type TrackCategory = 'effect' | 'text' | 'visual' | 'primary' | 'audio';

// Track definition
export type Track = {
  id: string;
  name: string;
  role?: TrackRole;
  category?: TrackCategory;
  items: Item[];
  locked?: boolean;
  hidden?: boolean;
};

// Asset types
export type Asset = {
  id: string;
  name: string;
  type: 'video' | 'audio' | 'image';
  src: string;
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: string;
  thumbnailFrameCount?: number; // Number of frames in the thumbnail strip
  thumbnailFrameWidth?: number; // Width of each frame in the thumbnail strip (in pixels)
  waveform?: number[]; // Normalized audio peaks (0-1) for waveform visualization
  createdAt: number;
  readOnly?: boolean;
  /** ID of the source node when asset is linked from canvas (for deduplication) */
  sourceNodeId?: string;
  /** Stable Project Asset identity; runtime URLs and Canvas ids are projections. */
  projectAssetId?: string;
};

export type EditorTranscriptWord = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  speakerId?: string;
};

export type EditorAssetTranscript = {
  schemaVersion: 1;
  kind: 'clash.editor.asset-transcript';
  assetId: string;
  text: string;
  durationMs: number;
  words: EditorTranscriptWord[];
  backendId?: string;
  modelId?: string;
  language?: string;
};

export type TimelineTranscriptWord = {
  id: string;
  text: string;
  assetId: string;
  assetWordId: string;
  clipId: string;
  trackId: string;
  sourceStartFrame: number;
  sourceEndFrame: number;
  timelineStartFrame: number;
  timelineEndFrame: number;
  confidence?: number;
  speakerId?: string;
};

// Editor state
export type EditorState = {
  tracks: Track[];
  /** The one track that defines the semantic edit, below visual lanes and above audio lanes. */
  primaryTrackId: string | null;
  selectedItemId: string | null;
  selectedTrackId: string | null;
  currentFrame: number;
  playing: boolean;
  zoom: number;
  assets: Asset[];
  assetTranscripts: Record<string, EditorAssetTranscript>;
  compositionWidth: number;
  compositionHeight: number;
  fps: number;
  durationInFrames: number;
};

// Editor actions
export type EditorAction =
  | { type: 'ADD_TRACK'; payload: Track }
  | { type: 'INSERT_TRACK'; payload: { track: Track; index: number } }
  | { type: 'REMOVE_TRACK'; payload: string }
  | { type: 'SET_PRIMARY_TRACK'; payload: string }
  | { type: 'UPDATE_TRACK'; payload: { id: string; updates: Partial<Track> } }
  | { type: 'REORDER_TRACKS'; payload: Track[] }
  | { type: 'ADD_ITEM'; payload: { trackId: string; item: Item } }
  | { type: 'MOVE_ITEM'; payload: { sourceTrackId: string; targetTrackId: string; itemId: string; from: number } }
  | { type: 'ROLL_EDIT'; payload: { trackId: string; leftItemId: string; rightItemId: string; boundaryFrame: number } }
  | { type: 'REMOVE_ITEM'; payload: { trackId: string; itemId: string } }
  | { type: 'UPDATE_ITEM'; payload: { trackId: string; itemId: string; updates: Partial<Item> } }
  | { type: 'SPLIT_ITEM'; payload: { trackId: string; itemId: string; splitFrame: number } }
  | { type: 'RIPPLE_DELETE_RANGE'; payload: { startFrame: number; endFrame: number } }
  | { type: 'RESTORE_TIMELINE_SNAPSHOT'; payload: { tracks: Track[]; durationInFrames: number } }
  | { type: 'SELECT_ITEM'; payload: string | null }
  | { type: 'SELECT_TRACK'; payload: string | null }
  | { type: 'SET_CURRENT_FRAME'; payload: number }
  | { type: 'SET_PLAYING'; payload: boolean }
  | { type: 'SET_ZOOM'; payload: number }
  | { type: 'ADD_ASSET'; payload: Asset }
  | { type: 'UPSERT_ASSET'; payload: Asset }
  | { type: 'SET_ASSET_TRANSCRIPT'; payload: EditorAssetTranscript }
  | { type: 'REMOVE_ASSET'; payload: string }
  | { type: 'SET_COMPOSITION_SIZE'; payload: { width: number; height: number } }
  | { type: 'SET_DURATION'; payload: number };

export type TimelineDsl = Pick<
  EditorState,
  'tracks' | 'compositionWidth' | 'compositionHeight' | 'fps' | 'durationInFrames'
> & Pick<Partial<EditorState>, 'primaryTrackId' | 'assetTranscripts'> & {
};
