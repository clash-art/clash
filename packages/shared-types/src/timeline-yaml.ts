/**
 * YAML projection of timelineDsl — the agent-facing surface.
 *
 * The Loro doc stores timelineDsl as a structured object (resolved absolute
 * frames in `from`, no expressions). Agent tools (read_timeline /
 * edit_timeline / write_timeline) round-trip that object through YAML so
 * agents can edit it like a config file with `prev`, `prev+15`, `clip-A-30`
 * style relative references.
 *
 * Module exports a small surface only:
 *   - timelineDslToYaml(dsl): string
 *   - timelineDslFromYaml(yaml): { ok: true, dsl } | { ok: false, error }
 *   - timelineDslHash(dsl): Promise<string>   (stale-read guard)
 *   - parseFromExpression / resolveFromExpression (exposed for tests)
 */
import { parse, stringify } from "yaml";
import {
  validateTimelineItemKeyframes,
  type TimelineItemKeyframes,
} from "./timeline-keyframes.js";
import { validateTimelineItemMask } from "./timeline-mask.js";
import { timelineMaskKeyframeSemanticIssues } from "./timeline-dsl-schema.js";
import {
  TIMELINE_CLIP_ANIMATION_TYPES,
  TIMELINE_DSL_CATEGORY_ALLOWED_ITEM_TYPES,
  TIMELINE_DSL_FIELD_ANNOTATIONS,
  TIMELINE_DSL_TRACK_CATEGORIES,
  type TimelineDslFieldAnnotation,
} from "./timeline-field-annotations.js";
import {
  parseFromExpression,
  type FromExpression,
} from "./timeline-from-expression.js";
export {
  parseFromExpression,
  type FromExpression,
} from "./timeline-from-expression.js";

const TRACK_CATEGORIES = TIMELINE_DSL_TRACK_CATEGORIES;
export type TimelineTrackCategory = (typeof TRACK_CATEGORIES)[number];
const CATEGORY_ALLOWED_ITEM_TYPES = Object.fromEntries(
  Object.entries(TIMELINE_DSL_CATEGORY_ALLOWED_ITEM_TYPES).map(([category, itemTypes]) => [
    category,
    new Set<string>(itemTypes),
  ]),
) as unknown as Record<TimelineTrackCategory, ReadonlySet<string>>;

function structuralItemCategory(type: unknown): Exclude<TimelineTrackCategory, "primary"> | null {
  if (type === "composition" || type === "transition") return "effect";
  if (type === "text") return "text";
  if (type === "audio") return "audio";
  if (type === "video" || type === "image" || type === "solid" || type === "sticker" || type === "derived-overlay") {
    return "visual";
  }
  return null;
}

// ─── Types (loose; mirror the DSL shape used by the renderer) ────────

type RawItem = {
  id?: string;
  type?: string;
  from?: number | string;
  fromExpr?: string;
  durationInFrames?: number;
  [key: string]: unknown;
};

type RawTrack = {
  id?: string;
  name?: string;
  role?: string;
  category?: string;
  items?: RawItem[];
  hidden?: boolean;
  locked?: boolean;
  [key: string]: unknown;
};

type RawTimelineDsl = {
  tracks?: RawTrack[];
  primaryTrackId?: string | null;
  compositionWidth?: number;
  compositionHeight?: number;
  fps?: number;
  durationInFrames?: number;
  assetTranscripts?: Record<string, unknown>;
  [key: string]: unknown;
};

// The resolved DSL stored in Loro: from is a number, fromExpr optionally
// preserved alongside.
export type ResolvedItem = RawItem & { id: string; type: string; from: number; durationInFrames: number };
export type ResolvedTrack = {
  id: string;
  name?: string;
  role?: string;
  category?: TimelineTrackCategory;
  items: ResolvedItem[];
  hidden?: boolean;
  locked?: boolean;
  [key: string]: unknown;
};
export type ResolvedTimelineDsl = {
  tracks: ResolvedTrack[];
  primaryTrackId?: string | null;
  compositionWidth?: number;
  compositionHeight?: number;
  fps?: number;
  durationInFrames?: number;
  assetTranscripts?: Record<string, unknown>;
  [key: string]: unknown;
};

// ─── from-expression parser ──────────────────────────────────────────

const SUBTITLE_ALLOWED_ITEM_TYPES = new Set(["text"]);
const CLIP_ANIMATION_TYPES = new Set<string>(TIMELINE_CLIP_ANIMATION_TYPES);

type ResolutionTarget = {
  item: RawItem & { id: string; durationInFrames: number };
  trackItems: Array<RawItem & { id: string; durationInFrames: number }>;
  trackIndex: number; // index of this item within trackItems (for `prev`)
};

/**
 * Resolve an item's from-expression to an absolute frame number. Recurses
 * for chained references with cycle protection. Unresolvable references
 * (missing target, cycle, malformed) fall back to 0.
 */
export function resolveFromExpression(
  expr: FromExpression,
  target: ResolutionTarget,
  ctx: Map<string, ResolutionTarget>,
  visiting: Set<string> = new Set(),
  cache: Map<string, number> = new Map(),
): number {
  if (expr.kind === "absolute") return expr.value;

  // `prev`: previous item in the same track (by YAML order).
  if (expr.refId === "prev") {
    if (target.trackIndex <= 0) return Math.max(0, expr.offset);
    const prev = target.trackItems[target.trackIndex - 1];
    const prevFrom = resolveItemFrom(prev.id, ctx, visiting, cache);
    return Math.max(0, prevFrom + prev.durationInFrames + expr.offset);
  }

  const refTarget = ctx.get(expr.refId);
  if (!refTarget) return Math.max(0, expr.offset);

  const refFrom = resolveItemFrom(expr.refId, ctx, visiting, cache);
  return Math.max(0, refFrom + refTarget.item.durationInFrames + expr.offset);
}

function resolveItemFrom(
  itemId: string,
  ctx: Map<string, ResolutionTarget>,
  visiting: Set<string>,
  cache: Map<string, number>,
): number {
  const cached = cache.get(itemId);
  if (cached !== undefined) return cached;
  if (visiting.has(itemId)) return 0;
  const t = ctx.get(itemId);
  if (!t) return 0;
  visiting.add(itemId);
  try {
    const expr = parseFromExpression(t.item.from);
    if (!expr) {
      cache.set(itemId, 0);
      return 0;
    }
    const v = resolveFromExpression(expr, t, ctx, visiting, cache);
    cache.set(itemId, v);
    return v;
  } finally {
    visiting.delete(itemId);
  }
}

// ─── YAML serialization ──────────────────────────────────────────────

const ITEM_KEY_ORDER = ["id", "type", "from", "durationInFrames"];

type TimelineFieldAnnotationRecord = Record<string, TimelineDslFieldAnnotation>;

function annotatedYamlFields(
  source: Record<string, unknown>,
  annotations: TimelineFieldAnnotationRecord,
  options: { validate?: boolean; exclude?: ReadonlySet<string> } = {},
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [fieldName, annotation] of Object.entries(annotations)) {
    if (annotation.relation || options.exclude?.has(fieldName)) continue;
    const value = source[fieldName];
    if (value === undefined) continue;
    if (options.validate && !annotation.schema.safeParse(value).success) continue;
    projected[fieldName] = value;
  }
  return projected;
}

function extraYamlFields(
  source: Record<string, unknown>,
  annotations: TimelineFieldAnnotationRecord,
): Record<string, unknown> {
  const annotatedNames = new Set(Object.keys(annotations));
  return Object.fromEntries(
    Object.entries(source).filter(([fieldName, value]) => (
      !annotatedNames.has(fieldName) && value !== undefined
    )),
  );
}

/**
 * Serialize an item with stable key order: id → type → from → durationInFrames
 * → everything else. If `fromExpr` is set, it's collapsed into the `from`
 * field as a string (and fromExpr key is dropped from the output to avoid
 * duplication). Edits then operate purely on `from`.
 */
function itemToYamlObject(item: RawItem): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (item.id !== undefined) out.id = item.id;
  if (item.type !== undefined) out.type = item.type;
  // Collapse fromExpr → from as string.
  if (typeof item.fromExpr === "string" && item.fromExpr.length > 0) {
    out.from = item.fromExpr;
  } else if (item.from !== undefined) {
    out.from = item.from;
  }
  if (item.durationInFrames !== undefined) out.durationInFrames = item.durationInFrames;
  // Remaining keys, skipping the ones we already handled and the fromExpr memo.
  for (const [k, v] of Object.entries(item)) {
    if (ITEM_KEY_ORDER.includes(k) || k === "fromExpr") continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function timelineDslToYaml(dsl: ResolvedTimelineDsl): string {
  const projected: Record<string, unknown> = {
    ...annotatedYamlFields(dsl, TIMELINE_DSL_FIELD_ANNOTATIONS.root),
    ...extraYamlFields(dsl, TIMELINE_DSL_FIELD_ANNOTATIONS.root),
  };
  projected.tracks = (dsl.tracks ?? []).map((track) => {
    const projectedTrack: Record<string, unknown> = {
      ...annotatedYamlFields(track, TIMELINE_DSL_FIELD_ANNOTATIONS.track),
      ...extraYamlFields(track, TIMELINE_DSL_FIELD_ANNOTATIONS.track),
    };
    projectedTrack.items = (track.items ?? []).map((item) => itemToYamlObject(item));
    return projectedTrack;
  });
  // lineWidth: 0 disables line wrapping so Edit-tool string matching is reliable.
  return stringify(projected, { lineWidth: 0 });
}

// ─── YAML parsing + resolution ───────────────────────────────────────

export type FromYamlResult =
  | { ok: true; dsl: ResolvedTimelineDsl }
  | { ok: false; error: string };

export function timelineDslFromYaml(yamlText: string): FromYamlResult {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    return { ok: false, error: `YAML parse error: ${(e as Error).message}` };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "YAML root must be a mapping (object)" };
  }
  const root = raw as RawTimelineDsl;
  if (!Array.isArray(root.tracks)) {
    return { ok: false, error: "Missing or invalid `tracks` array" };
  }

  // First pass: collect all items with their track context, validate basics.
  const ctx = new Map<string, ResolutionTarget>();
  const trackTargetsByTrack: ResolutionTarget[][] = [];
  let previousCategoryRank = -1;
  for (const track of root.tracks) {
    if (!track || typeof track !== "object") {
      return { ok: false, error: "Each track must be an object" };
    }
    if (track.category !== undefined && !TRACK_CATEGORIES.includes(track.category as TimelineTrackCategory)) {
      return { ok: false, error: `Track ${typeof track.id === "string" ? track.id : "(missing id)"} has invalid category` };
    }
    if (track.category !== undefined) {
      const rank = TRACK_CATEGORIES.indexOf(track.category as TimelineTrackCategory);
      if (rank < previousCategoryRank) {
        return { ok: false, error: "Track categories must follow effect, text, visual, primary, audio order" };
      }
      previousCategoryRank = rank;
    }
    const items: RawItem[] = Array.isArray(track.items) ? (track.items as RawItem[]) : [];
    if (track.category === undefined) {
      const structuralCategories = new Set(
        items.map((item) => structuralItemCategory(item?.type)).filter((category) => category !== null),
      );
      const isLegacyPrimary = root.primaryTrackId === track.id || track.role === "primary-video";
      const isCompatiblePrimary = isLegacyPrimary && items.every((item) =>
        typeof item?.type !== "string" || CATEGORY_ALLOWED_ITEM_TYPES.primary.has(item.type)
      );
      if (structuralCategories.size > 1 && !isCompatiblePrimary) {
        return { ok: false, error: `Track ${typeof track.id === "string" ? track.id : "(missing id)"} mixes incompatible item categories` };
      }
    }
    const trackTargets: ResolutionTarget[] = [];
    items.forEach((item, idx) => {
      if (!item || typeof item !== "object") return;
      if (typeof item.id !== "string" || item.id.length === 0) {
        return; // Will be caught below.
      }
      const dur = typeof item.durationInFrames === "number" ? item.durationInFrames : 0;
      const target: ResolutionTarget = {
        item: { ...item, id: item.id, durationInFrames: dur },
        trackItems: items as Array<RawItem & { id: string; durationInFrames: number }>,
        trackIndex: idx,
      };
      trackTargets.push(target);
      // First definition wins on duplicate id; report below.
      if (!ctx.has(item.id)) ctx.set(item.id, target);
    });
    trackTargetsByTrack.push(trackTargets);
  }

  // Validate: every item has id, type, durationInFrames.
  for (const track of root.tracks) {
    if (!Array.isArray(track.items)) continue;
    for (const item of track.items) {
      if (!item || typeof item !== "object") {
        return { ok: false, error: "Each item must be an object" };
      }
      if (typeof item.id !== "string" || item.id.length === 0) {
        return { ok: false, error: `Item is missing a string id: ${JSON.stringify(item).slice(0, 80)}` };
      }
      if (typeof item.type !== "string" || item.type.length === 0) {
        return { ok: false, error: `Item ${item.id} is missing type` };
      }
      if (typeof item.durationInFrames !== "number" || !Number.isFinite(item.durationInFrames) || item.durationInFrames < 0) {
        return { ok: false, error: `Item ${item.id} has invalid durationInFrames` };
      }
      const semanticError = validateSemanticTimelineItem(
        item as RawItem & { id: string; type: string; durationInFrames: number },
        track,
      );
      if (semanticError) return { ok: false, error: semanticError };
    }
  }

  // Second pass: resolve all from-expressions.
  const cache = new Map<string, number>();
  for (const target of ctx.values()) {
    resolveItemFrom(target.item.id, ctx, new Set(), cache);
  }

  // Third pass: build the resolved DSL with fromExpr preserved on items
  // whose `from` was a non-numeric expression.
  const resolvedTracks: ResolvedTrack[] = root.tracks.map((track, trackIdx) => {
    const items: ResolvedItem[] = (track.items ?? [])
      .filter((it): it is RawItem & { id: string; type: string; durationInFrames: number } =>
        Boolean(it) && typeof it.id === "string" && typeof it.type === "string" && typeof it.durationInFrames === "number",
      )
      .map((item) => {
        const resolved = cache.get(item.id) ?? 0;
        const isExpr = typeof item.from === "string" && parseFromExpression(item.from)?.kind === "reference";
        const out: ResolvedItem = {
          ...item,
          from: resolved,
        };
        if (track.role === "subtitle" && out.type === "text" && Array.isArray(out.cues)) {
          if (typeof out.text !== "string") {
            out.text = out.cues
              .map((cue) => isRecord(cue) && typeof cue.text === "string" ? cue.text : "")
              .filter(Boolean)
              .join("\n");
          }
          if (typeof out.color !== "string") {
            const style = isRecord(out.style) ? out.style : null;
            out.color = style && typeof style.color === "string" ? style.color : "#ffffff";
          }
        }
        if (isExpr && typeof item.from === "string") {
          out.fromExpr = item.from.trim();
        } else {
          // No expression — clear any stale fromExpr.
          delete out.fromExpr;
        }
        return out;
      });
    void trackTargetsByTrack[trackIdx]; // ensure trackIdx referenced
    const trackExtras = extraYamlFields(track, TIMELINE_DSL_FIELD_ANNOTATIONS.track);
    const annotatedTrackFields = annotatedYamlFields(
      track,
      TIMELINE_DSL_FIELD_ANNOTATIONS.track,
      { validate: true, exclude: new Set(["id"]) },
    );
    return {
      ...trackExtras,
      ...annotatedTrackFields,
      id: typeof track.id === "string" ? track.id : `track-${trackIdx}`,
      items,
    };
  });

  const rootExtras = extraYamlFields(root, TIMELINE_DSL_FIELD_ANNOTATIONS.root);
  const annotatedRootFields = annotatedYamlFields(
    root,
    TIMELINE_DSL_FIELD_ANNOTATIONS.root,
    { validate: true, exclude: new Set(["primaryTrackId"]) },
  );
  const out: ResolvedTimelineDsl = {
    ...rootExtras,
    ...annotatedRootFields,
    tracks: resolvedTracks,
  };
  if (root.primaryTrackId !== undefined) {
    if (root.primaryTrackId === null) {
      out.primaryTrackId = null;
    } else if (typeof root.primaryTrackId !== "string" || root.primaryTrackId.length === 0) {
      return { ok: false, error: "primaryTrackId must be a non-empty string" };
    } else if (!resolvedTracks.some((track) => track.id === root.primaryTrackId)) {
      return { ok: false, error: "primaryTrackId must reference an existing track" };
    } else {
      const primaryTrack = resolvedTracks.find((track) => track.id === root.primaryTrackId);
      if (primaryTrack?.category !== undefined && primaryTrack.category !== "primary") {
        return { ok: false, error: "primaryTrackId must reference the primary track category" };
      }
      out.primaryTrackId = root.primaryTrackId;
    }
  }
  return { ok: true, dsl: out };
}

function validateSemanticTimelineItem(
  item: RawItem & { id: string; type: string; durationInFrames: number },
  track: RawTrack,
): string | null {
  if (
    track.category !== undefined &&
    TRACK_CATEGORIES.includes(track.category as TimelineTrackCategory) &&
    !CATEGORY_ALLOWED_ITEM_TYPES[track.category as TimelineTrackCategory].has(item.type)
  ) {
    return `Track ${track.id ?? "(missing id)"} category ${track.category} cannot contain ${item.type} items`;
  }
  if (track.role === "subtitle" && !SUBTITLE_ALLOWED_ITEM_TYPES.has(item.type)) {
    return `Track ${track.id ?? "subtitle"} has role subtitle and must contain structured text items, not ${item.type}`;
  }
  if (track.role === "subtitle" && item.type === "text") {
    const subtitleError = validateSubtitleTextTimelineItem(item);
    if (subtitleError) return subtitleError;
  }
  const maskError = validateTimelineItemMask(item.mask);
  if (maskError) return `Timeline item ${item.id} ${maskError}`;
  const keyframeError = validateTimelineItemKeyframes(item.keyframes, item.durationInFrames);
  if (keyframeError) return `Timeline item ${item.id} ${keyframeError}`;
  const maskKeyframeIssue = timelineMaskKeyframeSemanticIssues({
    ...item,
    type: item.type,
    durationInFrames: item.durationInFrames,
    mask: item.mask,
    keyframes: item.keyframes as TimelineItemKeyframes | undefined,
  })[0];
  if (maskKeyframeIssue) return `Timeline item ${item.id} ${maskKeyframeIssue.message}`;
  const clipAnimationError = validateClipAnimationFields(item);
  if (clipAnimationError) return clipAnimationError;
  const audioFieldError = validateAudioTimelineFields(item, track);
  if (audioFieldError) return audioFieldError;
  if (item.type === "derived-overlay") return validateDerivedOverlayTimelineItem(item);
  if (item.type === "composition") return validateCompositionTimelineItem(item);
  return null;
}

function validateClipAnimationFields(
  item: RawItem & { id: string; type: string; durationInFrames: number },
): string | null {
  for (const field of ["entranceAnimation", "exitAnimation"] as const) {
    const animation = item[field];
    if (animation === undefined) continue;
    if (item.type !== "video") {
      return `Timeline item ${item.id} ${field} is only valid on video items`;
    }
    if (!isRecord(animation)) {
      return `Timeline item ${item.id} ${field} must be an object`;
    }
    if (typeof animation.type !== "string" || !CLIP_ANIMATION_TYPES.has(animation.type)) {
      return `Timeline item ${item.id} ${field}.type is unsupported`;
    }
    if (
      typeof animation.durationInFrames !== "number" ||
      !Number.isInteger(animation.durationInFrames) ||
      animation.durationInFrames < 1 ||
      animation.durationInFrames > Math.max(1, item.durationInFrames)
    ) {
      return `Timeline item ${item.id} ${field}.durationInFrames must be between 1 and the clip duration`;
    }
  }
  return null;
}

function validateAudioTimelineFields(
  item: RawItem & { id: string; type: string },
  track: RawTrack,
): string | null {
  const supportsAudio = item.type === "audio" || item.type === "video";
  if (item.audioGainDb !== undefined) {
    if (!supportsAudio) {
      return `Timeline item ${item.id} audioGainDb is only valid on audio or video items`;
    }
    if (
      typeof item.audioGainDb !== "number" ||
      !Number.isFinite(item.audioGainDb) ||
      item.audioGainDb < -60 ||
      item.audioGainDb > 12
    ) {
      return `Timeline item ${item.id} audioGainDb must be between -60 and 12`;
    }
  }
  for (const field of ["audioFadeInFrames", "audioFadeOutFrames"] as const) {
    const value = item[field];
    if (value === undefined) continue;
    if (!supportsAudio) {
      return `Timeline item ${item.id} ${field} is only valid on audio or video items`;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return `Timeline item ${item.id} ${field} must be a non-negative integer`;
    }
  }
  if (item.audioDucking !== undefined) {
    if (item.type !== "audio") {
      return `Timeline item ${item.id} audioDucking is only valid on audio items`;
    }
    if (track.role !== "music") {
      return `Timeline item ${item.id} audioDucking requires a music track`;
    }
    if (!isRecord(item.audioDucking)) {
      return `Timeline item ${item.id} audioDucking must be an object`;
    }
    const amountDb = item.audioDucking.amountDb;
    if (
      typeof amountDb !== "number" ||
      !Number.isFinite(amountDb) ||
      amountDb < -60 ||
      amountDb > 0
    ) {
      return `Timeline item ${item.id} audioDucking.amountDb must be between -60 and 0`;
    }
    for (const field of ["attackFrames", "releaseFrames"] as const) {
      const value = item.audioDucking[field];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        return `Timeline item ${item.id} audioDucking.${field} must be a non-negative integer`;
      }
    }
  }
  return null;
}

function validateSubtitleTextTimelineItem(item: RawItem & { id: string; durationInFrames: number }): string | null {
  const cues = Array.isArray(item.cues) ? item.cues : [];
  const wordRefs = Array.isArray(item.wordRefs) ? item.wordRefs : [];
  const sourceToOutputMap = Array.isArray(item.sourceToOutputMap) ? item.sourceToOutputMap : [];
  if (cues.length === 0 || wordRefs.length === 0 || sourceToOutputMap.length === 0) {
    return `Subtitle text item ${item.id} must include cues, wordRefs, and sourceToOutputMap`;
  }

  const wordIds = new Set<string>();
  for (const wordRef of wordRefs) {
    if (!isRecord(wordRef)) return `Subtitle text item ${item.id} has invalid wordRefs`;
    if (typeof wordRef.id !== "string" || wordRef.id.length === 0) return `Subtitle text item ${item.id} has invalid wordRefs`;
    if (typeof wordRef.text !== "string") return `Subtitle text item ${item.id} has invalid wordRefs`;
    if (!isValidFrameRange(wordRef.sourceStartFrame, wordRef.sourceEndFrame)) {
      return `Subtitle text item ${item.id} has invalid wordRefs source frame range`;
    }
    wordIds.add(wordRef.id);
  }

  for (const map of sourceToOutputMap) {
    if (!isRecord(map)) return `Subtitle text item ${item.id} has invalid sourceToOutputMap`;
    if (!isValidFrameRange(map.sourceStartFrame, map.sourceEndFrame) || !isValidFrameRange(map.outputStartFrame, map.outputEndFrame)) {
      return `Subtitle text item ${item.id} has invalid sourceToOutputMap frame range`;
    }
  }

  for (const cue of cues) {
    if (!isRecord(cue)) return `Subtitle text item ${item.id} has invalid cues`;
    if (typeof cue.id !== "string" || cue.id.length === 0) return `Subtitle text item ${item.id} has invalid cues`;
    if (typeof cue.text !== "string" || cue.text.trim().length === 0) return `Subtitle text item ${item.id} has invalid cues`;
    if (typeof cue.startFrame !== "number" || !Number.isInteger(cue.startFrame) || cue.startFrame < 0) {
      return `Subtitle text item ${item.id} has invalid cue startFrame`;
    }
    if (typeof cue.durationInFrames !== "number" || !Number.isInteger(cue.durationInFrames) || cue.durationInFrames <= 0) {
      return `Subtitle text item ${item.id} has invalid cue durationInFrames`;
    }
    const cueStartFrame = cue.startFrame;
    const cueDurationInFrames = cue.durationInFrames;
    const cueSourceStartFrame = cue.sourceStartFrame;
    const cueSourceEndFrame = cue.sourceEndFrame;
    if (cueStartFrame + cueDurationInFrames > item.durationInFrames) {
      return `Subtitle text item ${item.id} has cue outside item duration`;
    }
    if (!isValidFrameRange(cueSourceStartFrame, cueSourceEndFrame)) {
      return `Subtitle text item ${item.id} has invalid cue source frame range`;
    }
    const cueSourceStart = cueSourceStartFrame as number;
    const cueSourceEnd = cueSourceEndFrame as number;
    if (!Array.isArray(cue.wordIds) || cue.wordIds.length === 0) {
      return `Subtitle text item ${item.id} cues must reference wordRefs`;
    }
    for (const wordId of cue.wordIds) {
      if (typeof wordId !== "string" || !wordIds.has(wordId)) {
        return `Subtitle text item ${item.id} cue references unknown wordRefs`;
      }
    }
    const cueEndFrame = cueStartFrame + cueDurationInFrames;
    const coveredByMap = sourceToOutputMap.some((map) => {
      if (!isRecord(map)) return false;
      if (!isValidFrameRange(map.sourceStartFrame, map.sourceEndFrame)) return false;
      if (!isValidFrameRange(map.outputStartFrame, map.outputEndFrame)) return false;
      const frameMap = map as {
        sourceStartFrame: number;
        sourceEndFrame: number;
        outputStartFrame: number;
        outputEndFrame: number;
      };
      return (
        cueSourceStart >= frameMap.sourceStartFrame &&
        cueSourceEnd <= frameMap.sourceEndFrame &&
        cueStartFrame >= frameMap.outputStartFrame &&
        cueEndFrame <= frameMap.outputEndFrame
      );
    });
    if (!coveredByMap) return `Subtitle text item ${item.id} cue must be covered by sourceToOutputMap`;
  }
  return null;
}

function validateDerivedOverlayTimelineItem(item: RawItem & { id: string }): string | null {
  if (item.mediaType !== "image" && item.mediaType !== "video") {
    return `Derived overlay item ${item.id} mediaType must be image or video`;
  }
  if (!isLocalProjectPath(item.src)) {
    return `Derived overlay item ${item.id} src must be a local project path`;
  }
  if (typeof item.sourceAssetId !== "string" || item.sourceAssetId.length === 0) {
    return `Derived overlay item ${item.id} must include sourceAssetId, derivedAssetId, and derivation.kind`;
  }
  if (typeof item.derivedAssetId !== "string" || item.derivedAssetId.length === 0) {
    return `Derived overlay item ${item.id} must include sourceAssetId, derivedAssetId, and derivation.kind`;
  }
  if (item.sourceAssetId === item.derivedAssetId) {
    return `Derived overlay item ${item.id} must be copy-on-write`;
  }
  if (!isRecord(item.derivation) || typeof item.derivation.kind !== "string" || item.derivation.kind.length === 0) {
    return `Derived overlay item ${item.id} must include sourceAssetId, derivedAssetId, and derivation.kind`;
  }
  return null;
}

function validateCompositionTimelineItem(item: RawItem & { id: string }): string | null {
  if (item.runtime !== "html" && item.runtime !== "react" && item.runtime !== "remotion") {
    return `Composition item ${item.id} runtime must be html, react, or remotion`;
  }
  if (typeof item.compositionId !== "string" || item.compositionId.length === 0) {
    return `Composition item ${item.id} must include compositionId`;
  }
  if (!isLocalProjectPath(item.sourcePath)) {
    return `Composition item ${item.id} sourcePath must be a local project path`;
  }
  if (
    item.compositionKind === "motion-graphics" &&
    item.runtime !== "remotion" &&
    item.runtime !== "html"
  ) {
    return `Composition item ${item.id} motion-graphics items must use Remotion or HTML with a live Canvas sourceNodeId`;
  }
  if (item.renderedAssetPath !== undefined && !isLocalProjectPath(item.renderedAssetPath)) {
    return `Composition item ${item.id} renderedAssetPath must be a local project path`;
  }
  if (
    (item.runtime === "remotion" ||
      (item.compositionKind === "motion-graphics" && item.runtime === "html")) &&
    (typeof item.sourceNodeId !== "string" || item.sourceNodeId.trim().length === 0)
  ) {
    return `Composition item ${item.id} ${item.runtime === "html" ? "HTML" : "Remotion"} items must include sourceNodeId`;
  }
  if (item.runtime === "react" && !isLocalProjectPath(item.renderedAssetPath)) {
    return `Composition item ${item.id} React items must include local renderedAssetPath for timeline preview`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidFrameRange(startFrame: unknown, endFrame: unknown): boolean {
  return (
    typeof startFrame === "number" &&
    typeof endFrame === "number" &&
    Number.isInteger(startFrame) &&
    Number.isInteger(endFrame) &&
    startFrame >= 0 &&
    endFrame > startFrame
  );
}

function isLocalProjectPath(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]+/).includes("..");
}

// ─── Stable hash for stale-read detection ───────────────────────────

/**
 * Stable JSON serialization (sorted keys, omitting fromExpr — semantic
 * equivalence of the timeline shouldn't include the agent's authoring memo).
 * Used as input to SHA-256.
 */
export function timelineDslCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(timelineDslCanonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    const keys = Object.keys(value as object)
      .filter((k) =>
        k !== "fromExpr" &&
        (value as Record<string, unknown>)[k] !== undefined
      )
      .sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + timelineDslCanonicalJson((value as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

/**
 * Short hex fingerprint of the resolved timeline. Two reads return the same
 * hash iff the underlying timeline is semantically equivalent. Comparing
 * fromExpr strings is intentionally skipped — agent rewrites that change
 * only authoring style (e.g. `30` → `prev+0`) shouldn't trigger stale-read
 * rejections.
 */
export async function timelineDslHash(dsl: ResolvedTimelineDsl): Promise<string> {
  const stable = timelineDslCanonicalJson({
    ...dsl,
    tracks: Array.isArray(dsl.tracks) ? dsl.tracks : [],
    compositionWidth: typeof dsl.compositionWidth === "number" ? dsl.compositionWidth : 1920,
    compositionHeight: typeof dsl.compositionHeight === "number" ? dsl.compositionHeight : 1080,
    fps: typeof dsl.fps === "number" ? dsl.fps : 30,
    durationInFrames: typeof dsl.durationInFrames === "number" ? dsl.durationInFrames : 300,
  });
  const Encoder = (globalThis as unknown as {
    TextEncoder?: new () => { encode(input?: string): Uint8Array };
  }).TextEncoder;
  const webCrypto = (globalThis as unknown as {
    crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
  }).crypto;
  if (!Encoder || !webCrypto?.subtle) {
    throw new Error("timelineDslHash requires Web Crypto and TextEncoder support");
  }
  const bytes = new Encoder().encode(stable);
  const digest = await webCrypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
