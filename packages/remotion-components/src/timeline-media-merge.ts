import { TIMELINE_DSL_FIELD_ANNOTATIONS } from '@clash/shared-types';
import {
  TIMELINE_SHARED_DEFAULTS,
  type Item,
} from '@clash/remotion-core';

export type ResolvedTimelineItem = Item & {
  naturalWidth?: number;
  naturalHeight?: number;
  resolvedSrcUrl?: string;
  /** Render-start-only source resolved from a live Remotion Canvas node. */
  componentSource?: string;
  /** Live HTML document resolved from a Canvas html-motion node (runtime: html). */
  htmlSource?: string;
};

export type TimelineMediaMergeFieldMode =
  | 'same'
  | 'segment-id'
  | 'timeline-contiguous'
  | 'duration-sum'
  | 'source-contiguous'
  | 'absent';

type ItemBaseField = keyof typeof TIMELINE_DSL_FIELD_ANNOTATIONS.itemBase;
type VideoField = keyof typeof TIMELINE_DSL_FIELD_ANNOTATIONS.itemTypes.video;
type AudioField = keyof typeof TIMELINE_DSL_FIELD_ANNOTATIONS.itemTypes.audio;

type TimelineMediaMergeFieldPolicy = {
  video: Record<ItemBaseField | VideoField, TimelineMediaMergeFieldMode>;
  audio: Record<ItemBaseField | AudioField, TimelineMediaMergeFieldMode>;
};

/**
 * Every authored or derived Timeline field must be explicitly classified
 * before contiguous playback fragments may be coalesced. The `satisfies`
 * contract is a compile-time tripwire when the shared descriptor adds a
 * field; the runtime key check below also fails closed if package versions
 * drift.
 */
const BASE_FIELD_POLICY = {
  id: 'segment-id',
  type: 'same',
  from: 'timeline-contiguous',
  durationInFrames: 'duration-sum',
  assetId: 'same',
  sourceNodeId: 'same',
  properties: 'same',
  keyframes: 'absent',
  mask: 'absent',
  effects: 'absent',
  bakedAssetPath: 'same',
  fromExpr: 'same',
} as const satisfies Record<ItemBaseField, TimelineMediaMergeFieldMode>;

const VIDEO_FIELD_POLICY = {
  src: 'same',
  mediaFit: 'same',
  sourceStartInFrames: 'source-contiguous',
  audioGainDb: 'same',
  volume: 'same',
  waveform: 'same',
  entranceAnimation: 'absent',
  exitAnimation: 'absent',
  videoFadeIn: 'absent',
  videoFadeOut: 'absent',
  audioFadeInFrames: 'absent',
  audioFadeOutFrames: 'absent',
  audioFadeIn: 'absent',
  audioFadeOut: 'absent',
  videoFadeInColor: 'absent',
  videoFadeOutColor: 'absent',
} as const satisfies Record<VideoField, TimelineMediaMergeFieldMode>;

const AUDIO_FIELD_POLICY = {
  src: 'same',
  sourceStartInFrames: 'source-contiguous',
  audioGainDb: 'same',
  audioDucking: 'same',
  volume: 'same',
  waveform: 'same',
  audioFadeInFrames: 'absent',
  audioFadeOutFrames: 'absent',
  audioFadeIn: 'absent',
  audioFadeOut: 'absent',
} as const satisfies Record<AudioField, TimelineMediaMergeFieldMode>;

export const TIMELINE_MEDIA_MERGE_FIELD_POLICY = {
  video: { ...BASE_FIELD_POLICY, ...VIDEO_FIELD_POLICY },
  audio: { ...BASE_FIELD_POLICY, ...AUDIO_FIELD_POLICY },
} as const satisfies TimelineMediaMergeFieldPolicy;

type MediaType = keyof typeof TIMELINE_MEDIA_MERGE_FIELD_POLICY;

const RESOLVED_RUNTIME_FIELDS = new Set([
  'naturalWidth',
  'naturalHeight',
  'resolvedSrcUrl',
]);

const ZERO_IS_ABSENT_FIELDS = new Set([
  'videoFadeIn',
  'videoFadeOut',
  'audioFadeInFrames',
  'audioFadeOutFrames',
  'audioFadeIn',
  'audioFadeOut',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => jsonValueEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length
    || leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }
  return leftKeys.every((key) => jsonValueEqual(left[key], right[key]));
}

function isSemanticallyAbsent(field: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (field === 'effects') return Array.isArray(value) && value.length === 0;
  return ZERO_IS_ABSENT_FIELDS.has(field) && value === 0;
}

const DECLARED_FIELDS: Record<MediaType, ReadonlySet<string>> = {
  video: new Set([
    ...Object.keys(TIMELINE_DSL_FIELD_ANNOTATIONS.itemBase),
    ...Object.keys(TIMELINE_DSL_FIELD_ANNOTATIONS.itemTypes.video),
  ]),
  audio: new Set([
    ...Object.keys(TIMELINE_DSL_FIELD_ANNOTATIONS.itemBase),
    ...Object.keys(TIMELINE_DSL_FIELD_ANNOTATIONS.itemTypes.audio),
  ]),
};

const CLASSIFIED_FIELDS: Record<MediaType, ReadonlySet<string>> = {
  video: new Set(Object.keys(TIMELINE_MEDIA_MERGE_FIELD_POLICY.video)),
  audio: new Set(Object.keys(TIMELINE_MEDIA_MERGE_FIELD_POLICY.audio)),
};

const POLICY_IS_COMPLETE: Record<MediaType, boolean> = {
  video:
    CLASSIFIED_FIELDS.video.size === DECLARED_FIELDS.video.size
    && [...CLASSIFIED_FIELDS.video].every((field) => DECLARED_FIELDS.video.has(field)),
  audio:
    CLASSIFIED_FIELDS.audio.size === DECLARED_FIELDS.audio.size
    && [...CLASSIFIED_FIELDS.audio].every((field) => DECLARED_FIELDS.audio.has(field)),
};

function carriesOnlyClassifiedFields(
  type: MediaType,
  item: ResolvedTimelineItem,
): boolean {
  return Object.keys(item).every((field) => (
    CLASSIFIED_FIELDS[type].has(field) || RESOLVED_RUNTIME_FIELDS.has(field)
  ));
}

function canMergeMediaPair(
  left: ResolvedTimelineItem,
  right: ResolvedTimelineItem,
  protectedItemIds: ReadonlySet<string>,
): boolean {
  if (
    (left.type !== 'video' && left.type !== 'audio')
    || right.type !== left.type
    || protectedItemIds.has(left.id)
    || protectedItemIds.has(right.id)
  ) {
    return false;
  }
  const type = left.type;
  if (
    !POLICY_IS_COMPLETE[type]
    || !carriesOnlyClassifiedFields(type, left)
    || !carriesOnlyClassifiedFields(type, right)
  ) {
    return false;
  }
  if (
    !left.resolvedSrcUrl
    || !right.resolvedSrcUrl
    || left.resolvedSrcUrl !== right.resolvedSrcUrl
    || !jsonValueEqual(left.naturalWidth, right.naturalWidth)
    || !jsonValueEqual(left.naturalHeight, right.naturalHeight)
  ) {
    return false;
  }

  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const policy = TIMELINE_MEDIA_MERGE_FIELD_POLICY[type];
  for (const [field, mode] of Object.entries(policy)) {
    const leftValue = leftRecord[field];
    const rightValue = rightRecord[field];
    if (mode === 'segment-id' || mode === 'duration-sum') continue;
    if (mode === 'same' && !jsonValueEqual(leftValue, rightValue)) return false;
    if (
      mode === 'timeline-contiguous'
      && right.from !== left.from + left.durationInFrames
    ) {
      return false;
    }
    if (
      mode === 'source-contiguous'
      && (
        Number(rightValue ?? TIMELINE_SHARED_DEFAULTS[type].sourceStartInFrames)
        !== Number(leftValue ?? TIMELINE_SHARED_DEFAULTS[type].sourceStartInFrames)
          + left.durationInFrames
      )
    ) {
      return false;
    }
    if (
      mode === 'absent'
      && (!isSemanticallyAbsent(field, leftValue) || !isSemanticallyAbsent(field, rightValue))
    ) {
      return false;
    }
  }
  return true;
}

export const mergeContiguousMediaItems = (
  items: ResolvedTimelineItem[],
  options: { protectedItemIds?: ReadonlySet<string> } = {},
): ResolvedTimelineItem[] => {
  const sorted = [...items].sort((left, right) => left.from - right.from);
  const result: ResolvedTimelineItem[] = [];
  const protectedItemIds = options.protectedItemIds ?? new Set<string>();

  for (const item of sorted) {
    const previous = result[result.length - 1];
    if (previous && canMergeMediaPair(previous, item, protectedItemIds)) {
      result[result.length - 1] = {
        ...previous,
        durationInFrames: previous.durationInFrames + item.durationInFrames,
      };
      continue;
    }
    result.push({ ...item });
  }

  return result;
};
