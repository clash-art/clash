import React from "react";
import {
  PreviewMediaErrorProvider,
  ReportingAudio as Audio,
  ReportingVideo as Video,
  type PreviewMediaErrorReporter,
} from "./previewMediaErrors";
import {
  AbsoluteFill,
  Sequence,
  Img,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from "remotion";
import {
  buildAudioDuckingWindows,
  computeAudioDuckingMultiplier,
  getItemLookupIds,
  resolveAudioFadeInFrames,
  resolveAudioFadeOutFrames,
  resolveLinearAudioGain,
  sampleTimelineKeyframes,
  sampleTimelineMaskKeyframes,
  TIMELINE_CAPTION_STYLE_DEFAULTS,
  TIMELINE_SHARED_DEFAULTS,
  type ClipAnimation,
  type EffectInstanceRef,
  type Track,
  type Item,
} from "@clash/remotion-core";
import {
  builtInEffectRegistry,
  computeBuiltInTransitionStyle,
  computeEffectPresentation,
  type BuiltInTransitionType,
  type EffectPresentationRole,
} from "@clash/remotion-effects";
import {
  TIMELINE_MASK_FEATHER_BLUR_DIVISOR,
  TIMELINE_MASK_SHAPE_ANNOTATIONS,
  type TimelineMaskRenderPrimitive,
} from "@clash/shared-types";
import { computeItemEffectStyle } from "./item-effects";
import {
  mergeContiguousMediaItems,
  type ResolvedTimelineItem,
} from "./timeline-media-merge";
import { isTimelineTransitionRenderItem } from "./timeline-render-field-consumers";
import { RemotionSourceComposition } from "./inline-remotion-source";
import { HtmlSceneSurface } from "./html-scene";
import {
  useRemotionMgElementEdit,
  type MgElementEditHandlers,
} from "./mg-element-edit";
import { resolveProjectedMediaUrl } from "./projected-media-url";

export {
  mergeContiguousMediaItems,
  TIMELINE_MEDIA_MERGE_FIELD_POLICY,
} from "./timeline-media-merge";

// Debug logging disabled for performance

// ─── Fade math (transitions phase A) ─────────────────────────────────────
// Return a 0-1 multiplier given fade-in/out windows and the current
// SEQUENCE-RELATIVE frame. Duration math uses [visibleFrom, endFrame]
// inclusive (matches the existing video visibility convention).
//
// fadeInFrames > 0  → linear ramp 0 → 1 from visibleFrom .. visibleFrom + N
// fadeOutFrames > 0 → linear ramp 1 → 0 from endFrame - N .. endFrame
// Outside any fade window: returns 1. Both clamped, both can coexist.
export const computeFadeMultiplier = (
  frame: number,
  visibleFrom: number,
  endFrame: number,
  fadeInFrames: number,
  fadeOutFrames: number,
): number => {
  let m = 1;
  if (fadeInFrames > 0) {
    m = Math.min(
      m,
      interpolate(frame, [visibleFrom, visibleFrom + fadeInFrames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }),
    );
  }
  if (fadeOutFrames > 0) {
    m = Math.min(
      m,
      interpolate(frame, [endFrame - fadeOutFrames, endFrame], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }),
    );
  }
  return m;
};

type ComputeClipAnimationStyleInput = {
  frame: number;
  durationInFrames: number;
  entranceAnimation?: ClipAnimation;
  exitAnimation?: ClipAnimation;
};

export type ClipAnimationStyle = {
  opacity?: number;
  transform?: string;
};

const clampAnimationProgress = (value: number): number =>
  Math.min(1, Math.max(0, value));
const easeOutCubic = (value: number): number => 1 - (1 - value) ** 3;
const compactMotionNumber = (value: number): string =>
  Number(value.toFixed(4)).toString();

/**
 * Computes a clip's deterministic, seek-safe entrance/exit presentation.
 * The input frame is Sequence-relative and every duration is stored in the
 * Timeline DSL, so browser preview and Remotion export render the same pose.
 */
export const computeClipAnimationStyle = ({
  frame,
  durationInFrames,
  entranceAnimation,
  exitAnimation,
}: ComputeClipAnimationStyleInput): ClipAnimationStyle => {
  const transforms: string[] = [];
  let opacity = 1;
  let active = false;

  const applyAnimation = (
    animation: ClipAnimation,
    progress: number,
    phase: "entrance" | "exit",
  ) => {
    active = true;
    const easedProgress = easeOutCubic(clampAnimationProgress(progress));
    const visibility = phase === "entrance" ? easedProgress : 1 - easedProgress;
    opacity *= visibility;

    if (animation.type === "fade") return;
    if (animation.type === "zoom-in") {
      const scale =
        phase === "entrance"
          ? 0.84 + 0.16 * easedProgress
          : 1 + 0.16 * easedProgress;
      transforms.push(`scale(${compactMotionNumber(scale)})`);
      return;
    }
    if (animation.type === "zoom-out") {
      const scale =
        phase === "entrance"
          ? 1.16 - 0.16 * easedProgress
          : 1 - 0.16 * easedProgress;
      transforms.push(`scale(${compactMotionNumber(scale)})`);
      return;
    }

    const distance =
      8 * (phase === "entrance" ? 1 - easedProgress : easedProgress);
    const signedDistance =
      animation.type === "slide-left" || animation.type === "slide-up"
        ? phase === "entrance"
          ? distance
          : -distance
        : phase === "entrance"
          ? -distance
          : distance;
    const axis =
      animation.type === "slide-left" || animation.type === "slide-right"
        ? "X"
        : "Y";
    transforms.push(
      `translate${axis}(${compactMotionNumber(signedDistance)}%)`,
    );
  };

  const entranceDuration = Math.min(
    Math.max(1, entranceAnimation?.durationInFrames ?? 1),
    Math.max(1, durationInFrames),
  );
  if (entranceAnimation && frame < entranceDuration) {
    applyAnimation(
      entranceAnimation,
      entranceDuration === 1 ? 1 : frame / (entranceDuration - 1),
      "entrance",
    );
  }

  const exitDuration = Math.min(
    Math.max(1, exitAnimation?.durationInFrames ?? 1),
    Math.max(1, durationInFrames),
  );
  const exitStartFrame = Math.max(0, durationInFrames - exitDuration);
  if (exitAnimation && frame >= exitStartFrame) {
    applyAnimation(
      exitAnimation,
      exitDuration === 1 ? 1 : (frame - exitStartFrame) / (exitDuration - 1),
      "exit",
    );
  }

  if (!active) return {};
  return {
    opacity,
    transform: transforms.length > 0 ? transforms.join(" ") : undefined,
  };
};

// Color-overlay opacity: the inverse rises during a fade-out (0→1) and
// the inverse falls during a fade-in (1→0). Used when videoFadeIn/OutColor
// is set — instead of fading the video itself we paint a solid color over it.
export const computeColorOverlayOpacity = (
  frame: number,
  visibleFrom: number,
  endFrame: number,
  fadeInFrames: number,
  fadeOutFrames: number,
  hasFadeInColor: boolean,
  hasFadeOutColor: boolean,
): number => {
  let m = 0;
  if (hasFadeInColor && fadeInFrames > 0) {
    m = Math.max(
      m,
      interpolate(frame, [visibleFrom, visibleFrom + fadeInFrames], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }),
    );
  }
  if (hasFadeOutColor && fadeOutFrames > 0) {
    m = Math.max(
      m,
      interpolate(frame, [endFrame - fadeOutFrames, endFrame], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }),
    );
  }
  return m;
};

// ─── Transitions (phase B) ──────────────────────────────────────────────
// CSS-only transition presentations. Each maps a 0..1 progress to a style
// for the from-side and the to-side. Both sides are rendered in a stacked
// AbsoluteFill: the source is the bed and the target paints above it. Reveal
// transitions clip the target layer, matching normal compositor semantics.
export type TransitionRole = EffectPresentationRole;
export type TransitionTypeName = BuiltInTransitionType;

export const computeTransitionStyle = (
  type: TransitionTypeName,
  progress: number,
  role: TransitionRole,
): React.CSSProperties => {
  return computeBuiltInTransitionStyle(
    type,
    progress,
    role,
  ) as React.CSSProperties;
};

export const computeTransitionEffectStyle = (options: {
  legacyType: TransitionTypeName;
  effect?: EffectInstanceRef;
  progress: number;
  role: TransitionRole;
  frame: number;
  width: number;
  height: number;
}): React.CSSProperties => {
  if (!options.effect) {
    return computeTransitionStyle(
      options.legacyType,
      options.progress,
      options.role,
    );
  }
  const { definition, fallbackFrom } = builtInEffectRegistry.resolveForRenderer(
    options.effect.effectId,
    options.effect.effectVersion,
    "remotion",
  );
  return computeEffectPresentation({
    definition,
    params: fallbackFrom ? {} : (options.effect.params ?? {}),
    progress: options.progress,
    role: options.role,
    frame: options.frame,
    width: options.width,
    height: options.height,
  }) as React.CSSProperties;
};

type RuntimeCaptionCue = {
  id: string;
  startFrame: number;
  durationInFrames: number;
  text: string;
};

export function selectCaptionCueAtFrame(
  cues: RuntimeCaptionCue[] | undefined,
  frame: number,
): RuntimeCaptionCue | null {
  if (!Array.isArray(cues)) return null;
  for (const cue of cues) {
    if (
      Number.isInteger(cue.startFrame) &&
      Number.isInteger(cue.durationInFrames) &&
      frame >= cue.startFrame &&
      frame < cue.startFrame + cue.durationInFrames
    ) {
      return cue;
    }
  }
  return null;
}

export type ObscuredWindow = { from: number; end: number };

/**
 * Pre-scan all tracks to find composition-absolute frame ranges in which
 * each clip is being painted by a transition layer above. The two clips a
 * TransitionItem references (fromItemId / toItemId) get an entry; their
 * track-level renderers consult this map and zero opacity during the
 * window so the transition layer can do the real painting.
 *
 * Pure function — no DOM, no React. Exported for tests and for any future
 * tool that wants to know "what's visible at frame X" without rendering.
 */
export function buildObscuredWindowsByItemId(
  tracks: Track[],
): Map<string, ObscuredWindow[]> {
  const windows = new Map<string, ObscuredWindow[]>();
  const addWin = (id: string, w: ObscuredWindow) => {
    const list = windows.get(id) ?? [];
    list.push(w);
    windows.set(id, list);
  };
  for (const track of tracks) {
    for (const item of track.items) {
      if (item.type !== "transition") continue;
      const t = item as Item & { fromItemId: string; toItemId: string };
      const win: ObscuredWindow = {
        from: t.from,
        end: t.from + t.durationInFrames - 1,
      };
      if (t.fromItemId) addWin(t.fromItemId, win);
      if (t.toItemId) addWin(t.toItemId, win);
    }
  }
  return windows;
}

/** True iff `compositionFrame` falls inside any of the given windows. */
export function isFrameObscured(
  compositionFrame: number,
  windows: ObscuredWindow[] | undefined,
): boolean {
  if (!windows || windows.length === 0) return false;
  for (const w of windows) {
    if (compositionFrame >= w.from && compositionFrame <= w.end) return true;
  }
  return false;
}

type PreparedSequenceItem = {
  item: ResolvedTimelineItem;
  seqFrom: number;
  visibleFromRel: number;
  endFrameRel: number;
  isGlobalEndItem: boolean;
  /**
   * Composition-absolute frame ranges during which this item should render
   * invisibly (opacity 0) because it is the from/to of an active transition.
   * The transition layer above will paint the actual content with effects.
   */
  obscuredWindows: ObscuredWindow[];
  /**
   * For TransitionItem entries only — pre-resolved references to the from/to
   * clips. Stored here so ItemComponent doesn't need to thread the global map.
   */
  transitionFrom?: ResolvedTimelineItem;
  transitionTo?: ResolvedTimelineItem;
};

type PreparedTrack = {
  id: string;
  hidden?: boolean;
  playbackItems: PreparedSequenceItem[];
};

/**
 * Resolves timeline item references to asset data.
 *
 * Timeline items store sourceNodeId plus, when known, assetId references.
 * This function resolves those references to the actual src/type/dimensions
 * data from asset nodes.
 * This is the frontend equivalent of the backend resolve_item function.
 *
 * @param item Timeline item with potential assetId reference
 * @param allNodesMap Map of all nodes (node ID -> node data)
 * @returns Item with src/type/dimensions resolved from asset node if assetId present
 */
const resolveTimelineItem = (
  item: Item,
  allNodesMap: Map<string, any>,
  srcNodeMap: Map<string, any>,
): ResolvedTimelineItem => {
  let asset = null;

  // 1. Try explicit source node id, then backing asset id, with legacy fallback.
  for (const lookupId of getItemLookupIds(item)) {
    asset = allNodesMap.get(lookupId);
    if (asset) {
      break;
    }
  }

  // 2. If not found by references, try to find by src
  if (!asset && "src" in item) {
    const itemSrc = (item as any).src;
    asset = srcNodeMap.get(itemSrc) ?? null;
  }

  if (asset) {
    const assetData = asset.data || {};
    const isLiveRemotionComponent =
      item.type === "composition" &&
      item.runtime === "remotion" &&
      asset.type === "remotion-component";
    const isLiveHtmlMotion =
      item.type === "composition" &&
      item.runtime === "html" &&
      asset.type === "html-motion";

    // Get natural dimensions from asset node
    let naturalWidth = assetData.naturalWidth;
    let naturalHeight = assetData.naturalHeight;

    // Fallback: parse aspectRatio string (e.g., "16:9") if no natural dimensions
    if ((!naturalWidth || !naturalHeight) && assetData.aspectRatio) {
      const ar = assetData.aspectRatio;
      if (typeof ar === "string" && ar.includes(":")) {
        const [w, h] = ar.split(":").map(Number);
        if (w && h) {
          // Use 1920 as base width to calculate virtual dimensions
          naturalWidth = 1920;
          naturalHeight = Math.round((1920 * h) / w);
        }
      }
    }

    return {
      ...item,
      src: assetData.src || ("src" in item ? item.src : undefined),
      type: item.type,
      naturalWidth,
      naturalHeight,
      componentSource:
        isLiveRemotionComponent && typeof assetData.content === "string"
          ? assetData.content
          : undefined,
      componentProps:
        isLiveRemotionComponent &&
        assetData.elementOverrides &&
        typeof assetData.elementOverrides === "object" &&
        !Array.isArray(assetData.elementOverrides)
          ? { mgElementOverrides: assetData.elementOverrides }
          : isLiveRemotionComponent
            ? { mgElementOverrides: {} }
            : undefined,
      htmlSource:
        isLiveHtmlMotion && typeof assetData.content === "string"
          ? assetData.content
          : undefined,
      compositionId:
        isLiveRemotionComponent && typeof assetData.componentId === "string"
          ? assetData.componentId
          : isLiveHtmlMotion && typeof assetData.documentId === "string"
            ? assetData.documentId
            : item.type === "composition"
              ? item.compositionId
              : undefined,
      resolvedSrcUrl: resolveAssetUrl(
        assetData.src || ("src" in item ? item.src : undefined),
      ),
    } as ResolvedTimelineItem;
  }

  // Return as-is for non-asset items (solid, text) or if asset not found
  return {
    ...item,
    resolvedSrcUrl: resolveAssetUrl("src" in item ? item.src : undefined),
  };
};

const resolveAssetUrl = resolveProjectedMediaUrl;

export function computeTimelineItemLocalFrame(input: {
  sequenceFrame: number;
  sequenceFrom: number;
  itemFrom: number;
}): number {
  return input.sequenceFrame + input.sequenceFrom - input.itemFrom;
}

function computeTimelineItemRenderedSize(input: {
  item: Item & { naturalWidth?: number; naturalHeight?: number };
  compositionWidth: number;
  compositionHeight: number;
}): { width: number; height: number } {
  const { item, compositionWidth, compositionHeight } = input;
  const properties =
    item.properties ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties;
  const naturalWidth = item.naturalWidth || compositionWidth;
  const naturalHeight = item.naturalHeight || compositionHeight;
  if (properties.width === 1 && properties.height === 1) {
    const containScale = Math.min(
      compositionWidth / naturalWidth,
      compositionHeight / naturalHeight,
    );
    return {
      width: naturalWidth * containScale,
      height: naturalHeight * containScale,
    };
  }
  return {
    width: properties.width * naturalWidth,
    height: properties.height * naturalHeight,
  };
}

export function computeTimelineItemTransformStyle(input: {
  item: Item & { naturalWidth?: number; naturalHeight?: number };
  itemLocalFrame: number;
  compositionWidth: number;
  compositionHeight: number;
}): React.CSSProperties {
  const { item, itemLocalFrame, compositionWidth, compositionHeight } = input;
  const properties =
    item.properties ?? TIMELINE_SHARED_DEFAULTS.itemBase.properties;
  const sampled = sampleTimelineKeyframes(item.keyframes, itemLocalFrame, {
    position: [properties.x, properties.y],
    scale: [1, 1],
    rotation: properties.rotation ?? 0,
    opacity: properties.opacity ?? 1,
  });
  const renderedSize = computeTimelineItemRenderedSize({
    item,
    compositionWidth,
    compositionHeight,
  });

  return {
    position: "absolute",
    left: `calc(50% + ${compactMotionNumber(sampled.position[0])}px)`,
    top: `calc(50% + ${compactMotionNumber(sampled.position[1])}px)`,
    width: `${compactMotionNumber((renderedSize.width / compositionWidth) * 100)}%`,
    height: `${compactMotionNumber((renderedSize.height / compositionHeight) * 100)}%`,
    transform: `translate(-50%, -50%) rotate(${compactMotionNumber(sampled.rotation)}deg) scale(${compactMotionNumber(sampled.scale[0])}, ${compactMotionNumber(sampled.scale[1])})`,
    opacity: sampled.opacity,
  };
}

/** Sampled geometry shared by the CSS clip-path and raster mask paths. */
export type TimelineItemMaskGeometry = {
  primitive: TimelineMaskRenderPrimitive;
  center: readonly [number, number];
  size: readonly [number, number];
  rotation: number;
  featherPixels: number;
  inverted: boolean;
};

export function computeTimelineItemMaskGeometry(input: {
  item: Item;
  itemLocalFrame: number;
  renderedWidth: number;
  renderedHeight: number;
}): TimelineItemMaskGeometry | null {
  if (!input.item.mask) return null;
  const sampled = sampleTimelineMaskKeyframes(
    input.item.keyframes,
    input.itemLocalFrame,
    input.item.mask,
  );
  const width = Math.max(0, sampled.size[0]);
  const height = Math.max(0, sampled.size[1]);
  const renderedWidth = Math.max(Number.EPSILON, Math.abs(input.renderedWidth));
  const renderedHeight = Math.max(
    Number.EPSILON,
    Math.abs(input.renderedHeight),
  );
  return {
    primitive:
      TIMELINE_MASK_SHAPE_ANNOTATIONS[input.item.mask.shape].renderPrimitive,
    center: [sampled.position[0], sampled.position[1]],
    size: [width, height],
    rotation: sampled.rotation,
    featherPixels:
      (Math.min((width / 100) * renderedWidth, (height / 100) * renderedHeight) *
        Math.max(0, sampled.feather)) /
      TIMELINE_MASK_FEATHER_BLUR_DIVISOR,
    inverted: input.item.mask.inverted,
  };
}

// Rotates a point expressed in percent-of-item-bounds coordinates. The
// aspect-ratio correction reproduces the physical-space rotation of the old
// SVG mask matrix, so the same angle means the same shape on every renderer.
function rotateMaskPoint(
  geometry: TimelineItemMaskGeometry,
  offsetX: number,
  offsetY: number,
  renderedWidth: number,
  renderedHeight: number,
): [number, number] {
  const radians = geometry.rotation * (Math.PI / 180);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const widthToHeight = renderedWidth / renderedHeight;
  return [
    geometry.center[0] +
      cosine * offsetX -
      (sine / widthToHeight) * offsetY,
    geometry.center[1] +
      widthToHeight * sine * offsetX +
      cosine * offsetY,
  ];
}

export function computeTimelineItemMaskClipPath(
  geometry: TimelineItemMaskGeometry,
  renderedWidth: number,
  renderedHeight: number,
): string {
  const [centerX, centerY] = geometry.center;
  const [width, height] = geometry.size;
  const radiusX = width / 2;
  const radiusY = height / 2;
  const normalizedRotation = ((geometry.rotation % 360) + 360) % 360;
  if (geometry.primitive === "ellipse" && normalizedRotation === 0) {
    return `ellipse(${compactMotionNumber(radiusX)}% ${compactMotionNumber(radiusY)}% at ${compactMotionNumber(centerX)}% ${compactMotionNumber(centerY)}%)`;
  }

  // clip-path has no rotate() primitive for basic shapes, so use a polygon.
  // 96 segments keep the approximation sub-pixel at 1080p while still being
  // a plain polygon the browser renderer understands.
  const points: string[] = [];
  if (geometry.primitive === "ellipse") {
    const segments = 96;
    for (let index = 0; index < segments; index += 1) {
      const angle = (index / segments) * Math.PI * 2;
      const [x, y] = rotateMaskPoint(
        geometry,
        radiusX * Math.cos(angle),
        radiusY * Math.sin(angle),
        renderedWidth,
        renderedHeight,
      );
      points.push(`${compactMotionNumber(x)}% ${compactMotionNumber(y)}%`);
    }
  } else {
    for (const [offsetX, offsetY] of [
      [-radiusX, -radiusY],
      [radiusX, -radiusY],
      [radiusX, radiusY],
      [-radiusX, radiusY],
    ] as const) {
      const [x, y] = rotateMaskPoint(
        geometry,
        offsetX,
        offsetY,
        renderedWidth,
        renderedHeight,
      );
      points.push(`${compactMotionNumber(x)}% ${compactMotionNumber(y)}%`);
    }
  }
  return `polygon(${points.join(", ")})`;
}

const RASTER_MASK_MAX_EDGE = 1024;
const rasterMaskDataUrlCache = new Map<string, string>();

// 1x1 opaque PNG used only when there is no canvas (Node/SSR unit tests).
// Both Remotion renderers execute the composition in Chromium, so production
// masks always take the canvas path below.
const OPAQUE_MASK_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lL7qWQAAAABJRU5ErkJggg==";

function createRasterMaskDataUrl(
  geometry: TimelineItemMaskGeometry,
  renderedWidth: number,
  renderedHeight: number,
): string {
  const scale = Math.min(
    1,
    RASTER_MASK_MAX_EDGE / Math.max(renderedWidth, renderedHeight),
  );
  const canvasWidth = Math.max(1, Math.round(renderedWidth * scale));
  const canvasHeight = Math.max(1, Math.round(renderedHeight * scale));
  const cacheKey = [
    geometry.primitive,
    geometry.center[0],
    geometry.center[1],
    geometry.size[0],
    geometry.size[1],
    geometry.rotation,
    geometry.featherPixels,
    geometry.inverted,
    canvasWidth,
    canvasHeight,
  ].join("|");
  const cached = rasterMaskDataUrlCache.get(cacheKey);
  if (cached) return cached;
  if (typeof document === "undefined") return `url("${OPAQUE_MASK_PNG}")`;

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext("2d");
  if (!context) return `url("${OPAQUE_MASK_PNG}")`;

  const centerX = (geometry.center[0] / 100) * canvasWidth;
  const centerY = (geometry.center[1] / 100) * canvasHeight;
  const radiusX = (geometry.size[0] / 100) * canvasWidth * 0.5;
  const radiusY = (geometry.size[1] / 100) * canvasHeight * 0.5;
  const blurPixels = geometry.featherPixels * scale;

  context.clearRect(0, 0, canvasWidth, canvasHeight);
  if (geometry.inverted) {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvasWidth, canvasHeight);
    context.globalCompositeOperation = "destination-out";
  }
  context.filter =
    blurPixels > 0.01 ? `blur(${compactMotionNumber(blurPixels)}px)` : "none";
  context.fillStyle = "#fff";
  context.translate(centerX, centerY);
  context.rotate(geometry.rotation * (Math.PI / 180));
  context.beginPath();
  if (geometry.primitive === "ellipse") {
    context.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
  } else {
    context.rect(-radiusX, -radiusY, radiusX * 2, radiusY * 2);
  }
  context.fill();
  context.setTransform(1, 0, 0, 1, 0, 0);

  const maskImage = `url("${canvas.toDataURL("image/png")}")`;
  if (rasterMaskDataUrlCache.size >= 32) {
    rasterMaskDataUrlCache.clear();
  }
  rasterMaskDataUrlCache.set(cacheKey, maskImage);
  return maskImage;
}

export function computeTimelineItemMaskStyle(input: {
  item: Item;
  itemLocalFrame: number;
  renderedWidth: number;
  renderedHeight: number;
}): React.CSSProperties {
  const geometry = computeTimelineItemMaskGeometry(input);
  if (!geometry) return {};
  const renderedWidth = Math.max(Number.EPSILON, Math.abs(input.renderedWidth));
  const renderedHeight = Math.max(
    Number.EPSILON,
    Math.abs(input.renderedHeight),
  );

  // Plain ellipse / rectangle masks are exact as clip-path, which both
  // renderers support. Feathering and inversion need per-pixel alpha, so
  // they use a raster mask generated on a canvas.
  if (geometry.featherPixels <= 0 && !geometry.inverted) {
    const clipPath = computeTimelineItemMaskClipPath(
      geometry,
      renderedWidth,
      renderedHeight,
    );
    return {
      clipPath,
      WebkitClipPath: clipPath,
    };
  }

  const maskImage = createRasterMaskDataUrl(
    geometry,
    renderedWidth,
    renderedHeight,
  );
  return {
    // The web renderer only supports a raster mask that fills the box from
    // the top-left corner; `center` is ignored by its mask loader.
    maskImage,
    maskPosition: "0% 0%",
    maskRepeat: "no-repeat",
    maskSize: "100% 100%",
    WebkitMaskImage: maskImage,
    WebkitMaskPosition: "0% 0%",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskSize: "100% 100%",
  };
}

// Component to render individual items.
//
// IMPORTANT: `visibleFrom` and `endFrame` are SEQUENCE-RELATIVE frames (i.e.
// offsets from the enclosing <Sequence from=...>'s start), not composition-
// absolute frames. `useCurrentFrame()` inside a Sequence is sequence-relative
// too, so the comparisons below line up. Mixing the two coord systems was the
// original bug: every item with `item.from > 0` was computing `hidden=true`
// for its entire Sequence and only the outer black-bg wrapper showed.
const ItemComponent: React.FC<{
  item: ResolvedTimelineItem;
  durationInFrames: number;
  visibleFrom?: number;
  endFrame?: number;
  isGlobalEndItem?: boolean;
  itemsDomMapRef?: React.RefObject<Map<string, HTMLElement>>;
  /** Sequence-relative offset — needed to convert frame to composition-absolute. */
  seqFrom?: number;
  /** Composition-absolute frame ranges in which this item is hidden by an
   *  active transition layer. Empty = never obscured. */
  obscuredWindows?: ObscuredWindow[];
  /** For TransitionItem only: the resolved from/to clip references. */
  transitionFrom?: ResolvedTimelineItem;
  transitionTo?: ResolvedTimelineItem;
  /** Composition-absolute ranges containing known spoken media. */
  duckingWindows?: ReturnType<typeof buildAudioDuckingWindows>;
  /** Timeline selection drives in-place MG element edit. */
  isSelected?: boolean;
  /** Optional in-place MG element edit bridge from the Timeline editor. */
  mgElementEditHandlers?: MgElementEditHandlers;
}> = ({
  item,
  durationInFrames: _durationInFrames,
  visibleFrom,
  endFrame,
  isGlobalEndItem,
  itemsDomMapRef,
  seqFrom = 0,
  obscuredWindows,
  transitionFrom,
  transitionTo,
  duckingWindows = [],
  isSelected = false,
  mgElementEditHandlers,
}) => {
  const frame = useCurrentFrame();
  const { width: compWidth, height: compHeight, fps } = useVideoConfig();
  const resolvedItem = item;

  // Soft-hide while a transition above is painting our content. We just zero
  // opacity (don't unmount) so video startup latency doesn't kick in when
  // the transition window ends and the clip resumes its own track.
  const compositionFrame = frame + seqFrom;
  const itemLocalFrame = computeTimelineItemLocalFrame({
    sequenceFrame: frame,
    sequenceFrom: seqFrom,
    itemFrom: resolvedItem.from,
  });
  const isObscured = isFrameObscured(compositionFrame, obscuredWindows);
  const itemEffectStyle = computeItemEffectStyle({
    effects: resolvedItem.effects,
    frame,
    durationInFrames: resolvedItem.durationInFrames,
    width: compWidth,
    height: compHeight,
  });

  const compositionRuntime =
    resolvedItem.type === "composition" ? resolvedItem.runtime : undefined;
  const compositionSourceNodeId =
    resolvedItem.type === "composition" ? resolvedItem.sourceNodeId : undefined;
  const compositionElementEditActive = Boolean(
    isSelected &&
    compositionSourceNodeId &&
    mgElementEditHandlers &&
    (compositionRuntime === "html" || compositionRuntime === "remotion") &&
    mgElementEditHandlers.activeSourceNodeId === compositionSourceNodeId,
  );
  const remotionElementEditRootRef = React.useRef<HTMLDivElement | null>(null);
  useRemotionMgElementEdit({
    rootRef: remotionElementEditRootRef,
    enabled: compositionRuntime === "remotion" && compositionElementEditActive,
    sourceNodeId: compositionSourceNodeId,
    compositionWidth: compWidth,
    handlers: mgElementEditHandlers,
  });

  const transformStyle = React.useMemo(
    () =>
      computeTimelineItemTransformStyle({
        item: resolvedItem,
        itemLocalFrame,
        compositionWidth: compWidth,
        compositionHeight: compHeight,
      }),
    [compHeight, compWidth, itemLocalFrame, resolvedItem],
  );
  const maskStyle = React.useMemo(() => {
    const renderedSize = computeTimelineItemRenderedSize({
      item: resolvedItem,
      compositionWidth: compWidth,
      compositionHeight: compHeight,
    });
    return computeTimelineItemMaskStyle({
      item: resolvedItem,
      itemLocalFrame,
      renderedWidth: renderedSize.width,
      renderedHeight: renderedSize.height,
    });
  }, [compHeight, compWidth, itemLocalFrame, resolvedItem]);

  const applyTransform = React.useCallback(
    (baseStyle: React.CSSProperties = {}): React.CSSProperties => {
      const transform =
        [
          transformStyle.transform,
          itemEffectStyle.transform,
          baseStyle.transform,
        ]
          .filter(Boolean)
          .join(" ") || undefined;
      const filter =
        [itemEffectStyle.filter, baseStyle.filter].filter(Boolean).join(" ") ||
        undefined;
      const opacity = [
        transformStyle.opacity,
        itemEffectStyle.opacity,
        baseStyle.opacity,
      ].reduce<number>(
        (product, value) => product * (typeof value === "number" ? value : 1),
        1,
      );
      return {
        ...transformStyle,
        ...itemEffectStyle,
        ...maskStyle,
        ...baseStyle,
        transform,
        filter,
        opacity,
      };
    },
    [itemEffectStyle, maskStyle, transformStyle],
  );

  if (resolvedItem.type === "solid") {
    return (
      <AbsoluteFill
        ref={(el) => {
          if (!itemsDomMapRef?.current || !el) return;
          itemsDomMapRef.current.set(resolvedItem.id, el as HTMLElement);
        }}
        style={applyTransform({
          backgroundColor: resolvedItem.color,
          opacity: isObscured ? 0 : 1,
        })}
      />
    );
  }

  if (resolvedItem.type === "text" && !Array.isArray(resolvedItem.cues)) {
    return (
      <AbsoluteFill
        ref={(el) => {
          if (!itemsDomMapRef?.current || !el) return;
          itemsDomMapRef.current.set(resolvedItem.id, el as HTMLElement);
        }}
        style={applyTransform({
          justifyContent: "center",
          alignItems: "center",
          opacity: isObscured ? 0 : 1,
        })}
      >
        <h1
          style={{
            color: resolvedItem.color,
            fontSize:
              resolvedItem.fontSize || TIMELINE_SHARED_DEFAULTS.text.fontSize,
            fontFamily:
              resolvedItem.fontFamily ||
              TIMELINE_SHARED_DEFAULTS.text.fontFamily,
            fontWeight:
              resolvedItem.fontWeight ||
              TIMELINE_SHARED_DEFAULTS.text.fontWeight,
            textAlign:
              resolvedItem.textAlign ?? TIMELINE_SHARED_DEFAULTS.text.textAlign,
            letterSpacing: `${resolvedItem.letterSpacingPx ?? TIMELINE_SHARED_DEFAULTS.text.letterSpacingPx}px`,
            lineHeight:
              resolvedItem.lineHeight ??
              TIMELINE_SHARED_DEFAULTS.text.lineHeight,
            padding: "0 40px",
          }}
        >
          {resolvedItem.text}
        </h1>
      </AbsoluteFill>
    );
  }

  if (resolvedItem.type === "text" && Array.isArray(resolvedItem.cues)) {
    const captionItem = resolvedItem as ResolvedTimelineItem & {
      cues?: RuntimeCaptionCue[];
      style?: {
        fontFamily?: string;
        fontSize?: number;
        fontWeight?: string | number;
        color?: string;
        backgroundColor?: string;
        position?: "bottom" | "top" | "center";
      };
    };
    const cue = selectCaptionCueAtFrame(captionItem.cues, frame);
    if (!cue) return null;
    const position =
      captionItem.style?.position ?? TIMELINE_CAPTION_STYLE_DEFAULTS.position;
    const justifyContent =
      position === "top"
        ? "flex-start"
        : position === "center"
          ? "center"
          : "flex-end";

    return (
      <AbsoluteFill
        ref={(el) => {
          if (!itemsDomMapRef?.current || !el) return;
          itemsDomMapRef.current.set(resolvedItem.id, el as HTMLElement);
        }}
        data-caption-item-id={resolvedItem.id}
        style={applyTransform({
          justifyContent,
          alignItems: "center",
          padding:
            position === "bottom"
              ? "0 72px 96px"
              : position === "top"
                ? "96px 72px 0"
                : "0 72px",
          pointerEvents: "none",
          opacity: isObscured ? 0 : 1,
        })}
      >
        <div
          data-caption-cue-id={cue.id}
          style={{
            maxWidth: "92%",
            color:
              captionItem.style?.color ?? TIMELINE_CAPTION_STYLE_DEFAULTS.color,
            backgroundColor:
              captionItem.style?.backgroundColor ??
              TIMELINE_CAPTION_STYLE_DEFAULTS.backgroundColor,
            fontFamily:
              captionItem.style?.fontFamily ??
              TIMELINE_CAPTION_STYLE_DEFAULTS.fontFamily,
            fontSize:
              captionItem.style?.fontSize ??
              TIMELINE_CAPTION_STYLE_DEFAULTS.fontSize,
            fontWeight:
              captionItem.style?.fontWeight ??
              TIMELINE_CAPTION_STYLE_DEFAULTS.fontWeight,
            lineHeight: TIMELINE_CAPTION_STYLE_DEFAULTS.lineHeight,
            textAlign: "center",
            borderRadius: 16,
            padding: "14px 22px",
            textWrap: "balance",
            whiteSpace: "pre-wrap",
          }}
        >
          {cue.text}
        </div>
      </AbsoluteFill>
    );
  }

  if (resolvedItem.type === "composition") {
    const compositionItem = resolvedItem as ResolvedTimelineItem & {
      runtime?: string;
      compositionKind?: string;
      compositionId?: string;
      sourceNodeId?: string;
      componentSource?: string;
      componentProps?: Record<string, unknown>;
      renderedAssetPath?: string;
    };

    if (compositionItem.runtime === "remotion") {
      return (
        <AbsoluteFill
          ref={(el) => {
            remotionElementEditRootRef.current = el as HTMLDivElement | null;
            if (!itemsDomMapRef?.current || !el) return;
            itemsDomMapRef.current.set(resolvedItem.id, el as HTMLElement);
          }}
          data-composition-item-id={resolvedItem.id}
          data-composition-id={compositionItem.compositionId}
          data-composition-kind={compositionItem.compositionKind}
          data-composition-runtime={compositionItem.runtime}
          data-remotion-source-node-id={compositionItem.sourceNodeId}
          data-mg-element-edit={
            compositionElementEditActive ? "true" : undefined
          }
          style={applyTransform({
            overflow: "hidden",
            opacity: isObscured ? 0 : 1,
          })}
        >
          {compositionItem.componentSource ? (
            <RemotionSourceComposition
              source={compositionItem.componentSource}
              componentId={compositionItem.compositionId}
              componentProps={compositionItem.componentProps}
            />
          ) : (
            <div
              role="alert"
              data-inline-remotion-error="missing-source"
              style={{
                boxSizing: "border-box",
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 24,
                color: "#fecaca",
                background: "#450a0a",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              Missing Remotion component source for Canvas node{" "}
              {compositionItem.sourceNodeId ?? "(unset)"}.
            </div>
          )}
        </AbsoluteFill>
      );
    }

    if (compositionItem.runtime === "html") {
      const htmlItem = compositionItem as typeof compositionItem & {
        htmlSource?: string;
      };
      return (
        <AbsoluteFill
          ref={(el) => {
            if (!itemsDomMapRef?.current || !el) return;
            itemsDomMapRef.current.set(resolvedItem.id, el as HTMLElement);
          }}
          data-composition-item-id={resolvedItem.id}
          data-composition-id={compositionItem.compositionId}
          data-composition-kind={compositionItem.compositionKind}
          data-composition-runtime="html"
          data-html-source-node-id={compositionItem.sourceNodeId}
          style={applyTransform({
            overflow: "hidden",
            opacity: isObscured ? 0 : 1,
          })}
        >
          {htmlItem.htmlSource ? (
            <HtmlSceneSurface
              source={htmlItem.htmlSource}
              frame={itemLocalFrame}
              fps={fps}
              durationInFrames={resolvedItem.durationInFrames}
              sourceNodeId={compositionItem.sourceNodeId}
              compositionItemId={resolvedItem.id}
              title={`HTML MG ${compositionItem.compositionId ?? resolvedItem.id}`}
              elementEdit={compositionElementEditActive}
              sceneWidth={compWidth}
              onElementEdit={
                compositionElementEditActive && compositionItem.sourceNodeId
                  ? (event) =>
                      mgElementEditHandlers?.onElementEdit(
                        compositionItem.sourceNodeId!,
                        event.elementId,
                        event.patch,
                      )
                  : undefined
              }
              onElementSelect={
                compositionElementEditActive && compositionItem.sourceNodeId
                  ? (event) =>
                      mgElementEditHandlers?.onElementSelect(
                        compositionItem.sourceNodeId!,
                        event.elementId,
                      )
                  : undefined
              }
            />
          ) : (
            <div
              role="alert"
              data-html-scene-error="missing-source"
              style={{
                boxSizing: "border-box",
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 24,
                color: "#fecaca",
                background: "#450a0a",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              Missing HTML Motion source for Canvas node{" "}
              {compositionItem.sourceNodeId ?? "(unset)"}.
            </div>
          )}
        </AbsoluteFill>
      );
    }

    if (compositionItem.renderedAssetPath) {
      const renderedAssetUrl = resolveAssetUrl(
        compositionItem.renderedAssetPath,
      );
      if (!renderedAssetUrl) return null;
      return (
        <AbsoluteFill
          ref={(el) => {
            if (!itemsDomMapRef?.current || !el) return;
            itemsDomMapRef.current.set(resolvedItem.id, el as HTMLElement);
          }}
          data-composition-item-id={resolvedItem.id}
          data-composition-id={compositionItem.compositionId}
          data-composition-kind={compositionItem.compositionKind}
          data-composition-runtime={compositionItem.runtime}
          style={applyTransform({ opacity: isObscured ? 0 : 1 })}
        >
          <Video
            src={renderedAssetUrl}
            style={{ width: "100%", height: "100%", objectFit: "fill" }}
            muted
            volume={0}
          />
        </AbsoluteFill>
      );
    }
  }

  if (resolvedItem.type === "derived-overlay") {
    const overlayItem = resolvedItem as ResolvedTimelineItem & {
      mediaType?: "image" | "video";
      src?: string;
      sourceAssetId?: string;
      derivedAssetId?: string;
      derivation?: { kind?: string };
      mediaFit?: "fill" | "cover" | "contain";
    };
    const src = resolveAssetUrl(overlayItem.src);
    if (!src) return null;
    if (overlayItem.mediaType === "image") {
      return (
        <AbsoluteFill
          ref={(el) => {
            if (!itemsDomMapRef?.current || !el) return;
            itemsDomMapRef.current.set(resolvedItem.id, el as HTMLElement);
          }}
          data-derived-overlay-item-id={resolvedItem.id}
          data-derived-source-asset-id={overlayItem.sourceAssetId}
          data-derived-asset-id={overlayItem.derivedAssetId}
          data-derived-kind={overlayItem.derivation?.kind}
          style={applyTransform({ opacity: isObscured ? 0 : 1 })}
        >
          <Img
            src={src}
            style={{
              width: "100%",
              height: "100%",
              objectFit:
                overlayItem.mediaFit ??
                TIMELINE_SHARED_DEFAULTS["derived-overlay"].mediaFit,
            }}
          />
        </AbsoluteFill>
      );
    }
    if (overlayItem.mediaType === "video") {
      return (
        <AbsoluteFill
          ref={(el) => {
            if (!itemsDomMapRef?.current || !el) return;
            itemsDomMapRef.current.set(resolvedItem.id, el as HTMLElement);
          }}
          data-derived-overlay-item-id={resolvedItem.id}
          data-derived-source-asset-id={overlayItem.sourceAssetId}
          data-derived-asset-id={overlayItem.derivedAssetId}
          data-derived-kind={overlayItem.derivation?.kind}
          style={applyTransform({ opacity: isObscured ? 0 : 1 })}
        >
          <Video
            src={src}
            style={{
              width: "100%",
              height: "100%",
              objectFit:
                overlayItem.mediaFit ??
                TIMELINE_SHARED_DEFAULTS["derived-overlay"].mediaFit,
            }}
            muted
            volume={0}
          />
        </AbsoluteFill>
      );
    }
  }

  if (resolvedItem.type === "video") {
    const sourceStart =
      resolvedItem.sourceStartInFrames ??
      TIMELINE_SHARED_DEFAULTS.video.sourceStartInFrames;
    const isBeforeVisible =
      typeof visibleFrom === "number" ? frame < visibleFrom : false;
    const isLastFrameOfItem =
      typeof endFrame === "number" ? frame === endFrame : false;
    // Skip the global-end item's last frame guard — that item is supposed to
    // still be visible at the composition's final frame.
    const shouldHideLastFrame = !isGlobalEndItem && isLastFrameOfItem;
    const hidden = isBeforeVisible || shouldHideLastFrame;
    const resolvedSrc =
      resolvedItem.resolvedSrcUrl || resolveAssetUrl(resolvedItem.src);
    if (!resolvedSrc) return null;

    const fadeInFrames =
      resolvedItem.videoFadeIn ?? TIMELINE_SHARED_DEFAULTS.video.videoFadeIn;
    const fadeOutFrames =
      resolvedItem.videoFadeOut ?? TIMELINE_SHARED_DEFAULTS.video.videoFadeOut;
    const fadeInColor = (resolvedItem as { videoFadeInColor?: string })
      .videoFadeInColor;
    const fadeOutColor = (resolvedItem as { videoFadeOutColor?: string })
      .videoFadeOutColor;
    const vf = visibleFrom ?? 0;
    const ef = endFrame ?? Number.MAX_SAFE_INTEGER;
    // Color set on a side disables opacity fade for that side; an overlay
    // ramps in/out instead. Lets users do white-flash / fade-to-black cleanly.
    const opacityFadeIn = fadeInColor ? 0 : fadeInFrames;
    const opacityFadeOut = fadeOutColor ? 0 : fadeOutFrames;
    const fadeOpacity = computeFadeMultiplier(
      frame,
      vf,
      ef,
      opacityFadeIn,
      opacityFadeOut,
    );
    const overlayOpacity = computeColorOverlayOpacity(
      frame,
      vf,
      ef,
      fadeInFrames,
      fadeOutFrames,
      Boolean(fadeInColor),
      Boolean(fadeOutColor),
    );
    // Pick whichever color is active in this frame's window. Fade-in window
    // is at the start; fade-out is at the end — they can't overlap.
    const overlayColor =
      fadeInColor && fadeInFrames > 0 && frame < vf + fadeInFrames
        ? fadeInColor
        : fadeOutColor && fadeOutFrames > 0 && frame > ef - fadeOutFrames
          ? fadeOutColor
          : undefined;
    const audioFadeIn = resolveAudioFadeInFrames(resolvedItem);
    const audioFadeOut = resolveAudioFadeOutFrames(resolvedItem);
    const audioVolumeBase = resolveLinearAudioGain(resolvedItem);
    const clipAnimationStyle = computeClipAnimationStyle({
      frame,
      durationInFrames: resolvedItem.durationInFrames,
      entranceAnimation: resolvedItem.entranceAnimation,
      exitAnimation: resolvedItem.exitAnimation,
    });
    const clipAnimationOpacity = clipAnimationStyle.opacity ?? 1;

    return (
      <AbsoluteFill
        ref={(el) => {
          if (!itemsDomMapRef?.current || !el) return;
          itemsDomMapRef.current.set(resolvedItem.id, el as HTMLElement);
        }}
        style={applyTransform({
          ...clipAnimationStyle,
          backgroundColor: "black",
          opacity: isObscured ? 0 : clipAnimationOpacity,
        })}
      >
        <AbsoluteFill
          style={{
            opacity: hidden || isObscured ? 0 : fadeOpacity,
            width: "100%",
            height: "100%",
          }}
        >
          <Video
            src={resolvedSrc}
            style={{
              width: "100%",
              height: "100%",
              objectFit:
                resolvedItem.mediaFit ??
                TIMELINE_SHARED_DEFAULTS.video.mediaFit,
            }}
            trimBefore={sourceStart}
            muted={hidden}
            volume={(f: number) =>
              audioVolumeBase *
              computeFadeMultiplier(f, vf, ef, audioFadeIn, audioFadeOut)
            }
          />
        </AbsoluteFill>
        {!isObscured && overlayColor && overlayOpacity > 0 && (
          <AbsoluteFill
            style={{ backgroundColor: overlayColor, opacity: overlayOpacity }}
          />
        )}
      </AbsoluteFill>
    );
  }

  if (resolvedItem.type === "audio") {
    const resolvedSrc =
      resolvedItem.resolvedSrcUrl || resolveAssetUrl(resolvedItem.src);
    if (!resolvedSrc) return null;
    const sourceStart =
      resolvedItem.sourceStartInFrames ??
      TIMELINE_SHARED_DEFAULTS.audio.sourceStartInFrames;
    const baseVolume = resolveLinearAudioGain(resolvedItem);
    const audioFadeIn = resolveAudioFadeInFrames(resolvedItem);
    const audioFadeOut = resolveAudioFadeOutFrames(resolvedItem);
    // Audio items use the Sequence-relative duration as their visible window:
    // visibleFrom = 0, endFrame = durationInFrames - 1. Audio doesn't piggyback
    // on the contiguous-merge offset that video items do.
    const ef = (resolvedItem.durationInFrames ?? 0) - 1;
    return (
      <Audio
        data-timeline-audio=""
        src={resolvedSrc}
        trimBefore={sourceStart}
        volume={(f: number) =>
          baseVolume *
          computeFadeMultiplier(f, 0, ef, audioFadeIn, audioFadeOut) *
          computeAudioDuckingMultiplier(
            resolvedItem.audioDucking,
            f + seqFrom,
            duckingWindows,
          )
        }
      />
    );
  }

  if (resolvedItem.type === "image") {
    const resolvedSrc =
      resolvedItem.resolvedSrcUrl || resolveAssetUrl(resolvedItem.src);
    if (!resolvedSrc) return null;
    const imageItem = resolvedItem as typeof resolvedItem & {
      imageFadeIn?: number;
      imageFadeOut?: number;
      imageFadeInColor?: string;
      imageFadeOutColor?: string;
    };
    const fadeInFrames =
      imageItem.imageFadeIn ?? TIMELINE_SHARED_DEFAULTS.image.imageFadeIn;
    const fadeOutFrames =
      imageItem.imageFadeOut ?? TIMELINE_SHARED_DEFAULTS.image.imageFadeOut;
    const fadeInColor = imageItem.imageFadeInColor;
    const fadeOutColor = imageItem.imageFadeOutColor;
    const vf = visibleFrom ?? 0;
    const ef = endFrame ?? (resolvedItem.durationInFrames ?? 0) - 1;
    const opacityFadeIn = fadeInColor ? 0 : fadeInFrames;
    const opacityFadeOut = fadeOutColor ? 0 : fadeOutFrames;
    const fadeOpacity = computeFadeMultiplier(
      frame,
      vf,
      ef,
      opacityFadeIn,
      opacityFadeOut,
    );
    const overlayOpacity = computeColorOverlayOpacity(
      frame,
      vf,
      ef,
      fadeInFrames,
      fadeOutFrames,
      Boolean(fadeInColor),
      Boolean(fadeOutColor),
    );
    const overlayColor =
      fadeInColor && fadeInFrames > 0 && frame < vf + fadeInFrames
        ? fadeInColor
        : fadeOutColor && fadeOutFrames > 0 && frame > ef - fadeOutFrames
          ? fadeOutColor
          : undefined;

    return (
      <AbsoluteFill
        style={applyTransform({
          justifyContent: "center",
          alignItems: "center",
          opacity: isObscured ? 0 : fadeOpacity,
        })}
      >
        <Img
          src={resolvedSrc}
          ref={(el) => {
            if (!itemsDomMapRef?.current || !el) return;
            itemsDomMapRef.current.set(resolvedItem.id, el as HTMLElement);
          }}
          style={{
            width: "100%",
            height: "100%",
            objectFit:
              imageItem.mediaFit ?? TIMELINE_SHARED_DEFAULTS.image.mediaFit,
          }}
        />
        {!isObscured && overlayColor && overlayOpacity > 0 && (
          <AbsoluteFill
            style={{ backgroundColor: overlayColor, opacity: overlayOpacity }}
          />
        )}
      </AbsoluteFill>
    );
  }

  if (resolvedItem.type === "sticker") {
    const resolvedSrc =
      resolvedItem.resolvedSrcUrl || resolveAssetUrl(resolvedItem.src);
    if (!resolvedSrc) return null;
    return (
      <AbsoluteFill
        ref={(el) => {
          if (!itemsDomMapRef?.current || !el) return;
          itemsDomMapRef.current.set(resolvedItem.id, el as HTMLElement);
        }}
        data-sticker-item-id={resolvedItem.id}
        style={applyTransform({
          justifyContent: "center",
          alignItems: "center",
          opacity: isObscured ? 0 : 1,
        })}
      >
        <Img
          src={resolvedSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit:
              resolvedItem.mediaFit ??
              TIMELINE_SHARED_DEFAULTS.sticker.mediaFit,
          }}
        />
      </AbsoluteFill>
    );
  }

  if (resolvedItem.type === "transition") {
    const t = resolvedItem as ResolvedTimelineItem & {
      transitionType: TransitionTypeName;
      effect?: EffectInstanceRef;
    };
    const dur = Math.max(1, resolvedItem.durationInFrames);
    // Sequence-relative: useCurrentFrame() goes 0..dur-1 inside this Sequence.
    const progress = Math.min(1, Math.max(0, frame / Math.max(1, dur - 1)));
    const transitionStyle = (role: TransitionRole) =>
      computeTransitionEffectStyle({
        legacyType: t.transitionType,
        effect: t.effect,
        progress,
        role,
        frame,
        width: compWidth,
        height: compHeight,
      });
    const fromStyle = transitionStyle("from");
    const toStyle = transitionStyle("to");
    const fromMaskStyle = transitionFrom
      ? computeTimelineItemMaskStyle({
          item: transitionFrom,
          itemLocalFrame: compositionFrame - transitionFrom.from,
          renderedWidth: compWidth,
          renderedHeight: compHeight,
        })
      : {};
    const toMaskStyle = transitionTo
      ? computeTimelineItemMaskStyle({
          item: transitionTo,
          itemLocalFrame: compositionFrame - transitionTo.from,
          renderedWidth: compWidth,
          renderedHeight: compHeight,
        })
      : {};

    return (
      <AbsoluteFill>
        {/* Source is the bed; target paints above it so reveal masks stay visible. */}
        {transitionFrom && (
          <AbsoluteFill
            data-transition-role="from"
            style={{ ...fromStyle, ...fromMaskStyle }}
          >
            <TransitionContent
              item={transitionFrom}
              compWidth={compWidth}
              compHeight={compHeight}
            />
          </AbsoluteFill>
        )}
        {transitionTo && (
          <AbsoluteFill
            data-transition-role="to"
            style={{ ...toStyle, ...toMaskStyle }}
          >
            <TransitionContent
              item={transitionTo}
              compWidth={compWidth}
              compHeight={compHeight}
            />
          </AbsoluteFill>
        )}
      </AbsoluteFill>
    );
  }

  return null;
};

/**
 * Stripped-down content-only renderer used inside transitions: no per-item
 * positioning (`properties.x/y/width/height`), no fade fields, no obscured
 * mask — the transition's own wrapper handles all of that.
 */
const TransitionContent: React.FC<{
  item: ResolvedTimelineItem;
  compWidth: number;
  compHeight: number;
}> = ({ item }) => {
  if (!isTimelineTransitionRenderItem(item)) return null;
  if (item.type === "video") {
    const sourceStart =
      item.sourceStartInFrames ??
      TIMELINE_SHARED_DEFAULTS.video.sourceStartInFrames;
    const src =
      item.resolvedSrcUrl || resolveAssetUrl((item as { src?: string }).src);
    if (!src) return null;
    return (
      <Video
        src={src}
        style={{ width: "100%", height: "100%", objectFit: "fill" }}
        trimBefore={sourceStart}
        muted
        volume={0}
      />
    );
  }
  if (item.type === "image") {
    const src =
      item.resolvedSrcUrl || resolveAssetUrl((item as { src?: string }).src);
    if (!src) return null;
    return (
      <Img
        src={src}
        style={{ width: "100%", height: "100%", objectFit: "fill" }}
      />
    );
  }
  if (item.type === "solid") {
    return <AbsoluteFill style={{ backgroundColor: item.color }} />;
  }
  if (item.type === "text") {
    const textItem = item as {
      text: string;
      color?: string;
      fontSize?: number;
      fontFamily?: string;
      fontWeight?: string | number;
    };
    return (
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <h1
          style={{
            color: textItem.color,
            fontSize:
              textItem.fontSize || TIMELINE_SHARED_DEFAULTS.text.fontSize,
            fontFamily:
              textItem.fontFamily || TIMELINE_SHARED_DEFAULTS.text.fontFamily,
            fontWeight:
              textItem.fontWeight || TIMELINE_SHARED_DEFAULTS.text.fontWeight,
            textAlign: "center",
            padding: "0 40px",
          }}
        >
          {textItem.text}
        </h1>
      </AbsoluteFill>
    );
  }
  const exhaustiveItem: never = item;
  return exhaustiveItem;
};

// Component to render a single track
const TrackComponent: React.FC<{
  track: PreparedTrack;
  itemsDomMapRef?: React.RefObject<Map<string, HTMLElement>>;
  duckingWindows: ReturnType<typeof buildAudioDuckingWindows>;
  selectedItemId?: string | null;
  mgElementEditHandlers?: MgElementEditHandlers;
}> = React.memo(({
  track,
  itemsDomMapRef,
  duckingWindows,
  selectedItemId,
  mgElementEditHandlers,
}) => {
  if (track.hidden) {
    return null;
  }

  const PREMOUNT_FRAMES = 45; // ~1.5秒@30fps，提前挂载以减少边界卡顿

  return (
    <AbsoluteFill>
      {track.playbackItems.map((p) => {
        const {
          item,
          seqFrom,
          visibleFromRel,
          endFrameRel,
          isGlobalEndItem,
          obscuredWindows,
          transitionFrom,
          transitionTo,
        } = p;
        return (
          <Sequence
            key={item.id}
            from={seqFrom}
            durationInFrames={item.durationInFrames}
            premountFor={PREMOUNT_FRAMES}
          >
            <ItemComponent
              item={item}
              durationInFrames={item.durationInFrames}
              visibleFrom={visibleFromRel}
              endFrame={endFrameRel}
              isGlobalEndItem={isGlobalEndItem}
              itemsDomMapRef={itemsDomMapRef}
              seqFrom={seqFrom}
              obscuredWindows={obscuredWindows}
              transitionFrom={transitionFrom}
              transitionTo={transitionTo}
              duckingWindows={duckingWindows}
              isSelected={selectedItemId === item.id}
              mgElementEditHandlers={mgElementEditHandlers}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
});

// Main composition component
export const VideoComposition: React.FC<{
  tracks: Track[];
  allNodes?: Map<string, any>; // Map of node ID -> node data for resolving assetId references
  selectedItemId?: string | null;
  selectionBoxRef?: React.RefObject<HTMLDivElement | null>;
  itemsDomMapRef?: React.RefObject<Map<string, HTMLElement>>;
  /** Interactive preview only: a media source failed terminally. */
  onMediaError?: PreviewMediaErrorReporter;
  /** Interactive preview only: a new value remounts every media element. */
  mediaEpoch?: number;
  /** Optional in-place MG element edit bridge for the selected composition. */
  mgElementEditHandlers?: MgElementEditHandlers;
}> = ({
  tracks,
  allNodes,
  selectedItemId,
  selectionBoxRef,
  itemsDomMapRef,
  onMediaError,
  mediaEpoch = 0,
  mgElementEditHandlers,
}) => {
  const { width: compWidth, height: compHeight } = useVideoConfig();
  const compositionFrame = useCurrentFrame();

  // Create empty nodes map if not provided (for backward compatibility)
  const nodesMap = React.useMemo(() => allNodes || new Map(), [allNodes]);
  const srcNodeMap = React.useMemo(() => {
    const next = new Map<string, any>();
    for (const [, node] of nodesMap.entries()) {
      const src = node?.data?.src;
      if (src) {
        next.set(src, node);
      }
    }
    return next;
  }, [nodesMap]);

  // 计算全局最后一帧（与上面的 TrackComponent 用到的 globalEndFrame 保持一致）
  const globalEndFrame = React.useMemo(() => {
    let maxEnd = 0;
    for (const t of tracks) {
      for (const itm of t.items) {
        const end = itm.from + itm.durationInFrames - 1;
        if (end > maxEnd) maxEnd = end;
      }
    }
    return maxEnd;
  }, [tracks]);

  // Phase B: scan all tracks once for transitions. Two outputs:
  //   1. globalResolvedItems — itemId → resolved item (for transition refs that
  //      may live on a different track than the transition itself).
  //   2. obscuredWindowsByItemId — composition-absolute frame ranges during
  //      which a clip is being painted by a transition layer and must render
  //      invisibly on its own track.
  // The window math is pulled out into buildObscuredWindowsByItemId for tests.
  const globalResolvedItems = React.useMemo(() => {
    const resolved = new Map<string, ResolvedTimelineItem>();
    for (const track of tracks) {
      for (const item of track.items) {
        resolved.set(item.id, resolveTimelineItem(item, nodesMap, srcNodeMap));
      }
    }
    return resolved;
  }, [tracks, nodesMap, srcNodeMap]);
  const obscuredWindowsByItemId = React.useMemo(
    () => buildObscuredWindowsByItemId(tracks),
    [tracks],
  );
  const duckingWindows = React.useMemo(
    () => buildAudioDuckingWindows(tracks),
    [tracks],
  );

  const preparedTracks = React.useMemo<PreparedTrack[]>(() => {
    const protectedItemIds = new Set(obscuredWindowsByItemId.keys());
    if (selectedItemId) protectedItemIds.add(selectedItemId);
    return tracks.map((track) => {
      const resolvedItems = track.items.map((item) =>
        resolveTimelineItem(item, nodesMap, srcNodeMap),
      );
      const mergedItems = mergeContiguousMediaItems(resolvedItems, {
        protectedItemIds,
      });
      const playbackItems = mergedItems.map((item, idx) => {
        const prev = idx > 0 ? mergedItems[idx - 1] : undefined;
        const isPrevContiguous =
          !!prev &&
          prev.type === item.type &&
          !!prev.resolvedSrcUrl &&
          !!item.resolvedSrcUrl &&
          prev.resolvedSrcUrl === item.resolvedSrcUrl &&
          prev.from + prev.durationInFrames === item.from &&
          ((prev as any).sourceStartInFrames ??
            TIMELINE_SHARED_DEFAULTS.video.sourceStartInFrames) +
            prev.durationInFrames ===
            ((item as any).sourceStartInFrames ??
              TIMELINE_SHARED_DEFAULTS.video.sourceStartInFrames);

        const seqFrom = isPrevContiguous
          ? Math.max(0, item.from - 1)
          : item.from;
        const visibleFromRel = item.from - seqFrom;
        const endFrameRel = item.from + item.durationInFrames - 1 - seqFrom;
        const isGlobalEndItem =
          item.from + item.durationInFrames - 1 === globalEndFrame;

        const obscuredWindows = obscuredWindowsByItemId.get(item.id) ?? [];

        let transitionFrom: ResolvedTimelineItem | undefined;
        let transitionTo: ResolvedTimelineItem | undefined;
        if (item.type === "transition") {
          const t = item as ResolvedTimelineItem & {
            fromItemId: string;
            toItemId: string;
          };
          transitionFrom = globalResolvedItems.get(t.fromItemId);
          transitionTo = globalResolvedItems.get(t.toItemId);
        }

        return {
          item,
          seqFrom,
          visibleFromRel,
          endFrameRel,
          isGlobalEndItem,
          obscuredWindows,
          transitionFrom,
          transitionTo,
        };
      });

      return {
        id: track.id,
        hidden: track.hidden,
        playbackItems,
      };
    });
  }, [
    tracks,
    nodesMap,
    srcNodeMap,
    globalEndFrame,
    obscuredWindowsByItemId,
    globalResolvedItems,
    selectedItemId,
  ]);

  // 找到选中的 item 和它的 properties，同时解析 natural dimensions
  const selectedItemResolved = React.useMemo(() => {
    if (!selectedItemId) return null;
    for (const track of preparedTracks) {
      const matched = track.playbackItems.find(
        ({ item }) => item.id === selectedItemId,
      );
      if (matched) {
        return matched.item;
      }
    }
    return null;
  }, [preparedTracks, selectedItemId]);

  // Calculate selection box dimensions using the same logic as applyTransform
  const selectionBoxStyle = React.useMemo(() => {
    if (!selectedItemResolved?.properties) return null;
    const transformStyle = computeTimelineItemTransformStyle({
      item: selectedItemResolved,
      itemLocalFrame: compositionFrame - selectedItemResolved.from,
      compositionWidth: compWidth,
      compositionHeight: compHeight,
    });
    return {
      ...transformStyle,
      opacity: 1,
      boxSizing: "border-box" as const,
    };
  }, [selectedItemResolved, compositionFrame, compWidth, compHeight]);

  return (
    <PreviewMediaErrorProvider value={onMediaError ?? null}>
    <AbsoluteFill
      key={mediaEpoch}
      style={{ backgroundColor: "black", top: 0, left: 0, right: 0, bottom: 0 }}
    >
      {/* Paint tracks bottom-up: track 0 is the top of the timeline UI, so it
          must be last in the DOM. The browser renderer ignores z-index and
          only follows DOM paint order; this keeps preview and both renderers
          visually identical. */}
      {[...preparedTracks]
        .reverse()
        .map((track) => (
          <TrackComponent
            // Keyed by identity only: inserting a track above must not
            // remount (and re-buffer) every media element below it.
            key={track.id}
            track={track}
            itemsDomMapRef={itemsDomMapRef}
            duckingWindows={duckingWindows}
            selectedItemId={selectedItemId}
            mgElementEditHandlers={mgElementEditHandlers}
          />
        ))}

      {/* 选择框 - 透明的，只用于提供 ref（不包含旋转）。It is last in DOM,
          which already puts the editor-only overlay above every track. */}
      {selectedItemResolved && selectionBoxStyle && (
        <AbsoluteFill style={{ pointerEvents: "none" }}>
          <div ref={selectionBoxRef} style={selectionBoxStyle} />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
    </PreviewMediaErrorProvider>
  );
};
