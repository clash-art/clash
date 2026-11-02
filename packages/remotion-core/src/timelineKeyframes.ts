import type {
  TimelineItemKeyframes,
  TimelineKeyframeChannel,
  TimelineMaskKeyframeSample,
  TimelineScalarKeyframe,
  TimelineVectorKeyframe,
} from "@clash/shared-types";
import {
  DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
  sampleTimelineKeyframeChannel,
  TIMELINE_KEYFRAME_CHANNEL_ANNOTATIONS,
  TIMELINE_MASK_KEYFRAME_CHANNELS,
  TIMELINE_MASK_SCALAR_ANIMATION_BINDINGS,
  TIMELINE_MASK_VECTOR_ANIMATION_BINDINGS,
} from "@clash/shared-types";

export type TimelineKeyframeSample = {
  position: readonly [number, number];
  scale: readonly [number, number];
  rotation: number;
  opacity: number;
};

export type { TimelineMaskKeyframeSample } from "@clash/shared-types";

const VECTOR_KEYFRAME_CHANNELS = new Set<TimelineKeyframeChannel>(
  Object.entries(TIMELINE_KEYFRAME_CHANNEL_ANNOTATIONS)
    .filter(([, annotation]) => annotation.valueKind === "vector")
    .map(([channel]) => channel as TimelineKeyframeChannel),
);

function sampleScalar(
  keyframes: readonly TimelineScalarKeyframe[] | undefined,
  frame: number,
  fallback: number,
): number {
  return sampleTimelineKeyframeChannel(
    keyframes,
    frame,
    fallback,
    (left, right, progress) => left + ((right - left) * progress),
  );
}

function sampleVector(
  keyframes: readonly TimelineVectorKeyframe[] | undefined,
  frame: number,
  fallback: readonly [number, number],
): readonly [number, number] {
  return sampleTimelineKeyframeChannel(
    keyframes,
    frame,
    fallback,
    (left, right, progress) => [
      left[0] + ((right[0] - left[0]) * progress),
      left[1] + ((right[1] - left[1]) * progress),
    ],
  );
}

export function sampleTimelineKeyframes(
  keyframes: TimelineItemKeyframes | undefined,
  itemLocalFrame: number,
  fallback: TimelineKeyframeSample,
): TimelineKeyframeSample {
  return {
    position: sampleVector(keyframes?.position, itemLocalFrame, fallback.position),
    scale: sampleVector(keyframes?.scale, itemLocalFrame, fallback.scale),
    rotation: sampleScalar(keyframes?.rotation, itemLocalFrame, fallback.rotation),
    opacity: sampleScalar(keyframes?.opacity, itemLocalFrame, fallback.opacity),
  };
}

export function sampleTimelineMaskKeyframes(
  keyframes: TimelineItemKeyframes | undefined,
  itemLocalFrame: number,
  fallback: TimelineMaskKeyframeSample,
): TimelineMaskKeyframeSample {
  const sampled = { ...fallback } as Record<string, number | readonly [number, number]>;
  for (const binding of TIMELINE_MASK_VECTOR_ANIMATION_BINDINGS) {
    const channel = keyframes?.[binding.channel];
    sampled[binding.field] = sampleVector(
      channel as readonly TimelineVectorKeyframe[] | undefined,
      itemLocalFrame,
      fallback[binding.field] as readonly [number, number],
    );
  }
  for (const binding of TIMELINE_MASK_SCALAR_ANIMATION_BINDINGS) {
    const channel = keyframes?.[binding.channel];
    sampled[binding.field] = sampleScalar(
      channel as readonly TimelineScalarKeyframe[] | undefined,
      itemLocalFrame,
      fallback[binding.field] as number,
    );
  }
  return sampled as TimelineMaskKeyframeSample;
}

type TimelineKeyframe = TimelineScalarKeyframe | TimelineVectorKeyframe;

function channelKeyframes(
  keyframes: TimelineItemKeyframes | undefined,
  channel: TimelineKeyframeChannel,
): readonly TimelineKeyframe[] {
  return (keyframes?.[channel] ?? []) as readonly TimelineKeyframe[];
}

export function upsertTimelineKeyframe(
  keyframes: TimelineItemKeyframes | undefined,
  channel: TimelineKeyframeChannel,
  keyframe: TimelineKeyframe,
): TimelineItemKeyframes {
  const nextChannel = [
    ...channelKeyframes(keyframes, channel).filter((candidate) => candidate.frame !== keyframe.frame),
    keyframe,
  ].sort((left, right) => left.frame - right.frame);
  return {
    ...keyframes,
    [channel]: nextChannel,
  } as TimelineItemKeyframes;
}

export function removeTimelineKeyframe(
  keyframes: TimelineItemKeyframes | undefined,
  channel: TimelineKeyframeChannel,
  frame: number,
): TimelineItemKeyframes | undefined {
  if (!keyframes) return undefined;
  const nextChannel = channelKeyframes(keyframes, channel)
    .filter((keyframe) => keyframe.frame !== frame);
  const next = { ...keyframes } as Record<string, unknown>;
  if (nextChannel.length > 0) {
    next[channel] = nextChannel;
  } else {
    delete next[channel];
  }
  return Object.keys(next).length > 0 ? next as TimelineItemKeyframes : undefined;
}

export function removeTimelineMaskKeyframes(
  keyframes: TimelineItemKeyframes | undefined,
): TimelineItemKeyframes | undefined {
  if (!keyframes) return undefined;
  const maskChannels = new Set<string>(TIMELINE_MASK_KEYFRAME_CHANNELS);
  const remaining = Object.fromEntries(
    Object.entries(keyframes).filter(([channel]) => !maskChannels.has(channel)),
  ) as TimelineItemKeyframes;
  return Object.keys(remaining).length > 0 ? remaining : undefined;
}

export type TimelineKeyframeRetimeResult =
  | { ok: true; frame: number; keyframes: TimelineItemKeyframes | undefined }
  | {
    ok: false;
    code: "KEYFRAME_RETIME_COLLISION";
    frame: number;
    channels: TimelineKeyframeChannel[];
  };

/**
 * Moves every channel's keyframe at `fromFrame` to `toFrame` together, keeping
 * the target inside the clip (`0 … durationInFrames - 1`). A channel that
 * already holds a keyframe at the target refuses the whole move rather than
 * silently replacing that keyframe.
 */
export function retimeTimelineKeyframes(
  keyframes: TimelineItemKeyframes | undefined,
  fromFrame: number,
  toFrame: number,
  durationInFrames: number,
): TimelineKeyframeRetimeResult {
  const frame = Math.max(0, Math.min(Math.max(0, durationInFrames - 1), Math.round(toFrame)));
  if (!keyframes || frame === fromFrame) return { ok: true, frame, keyframes };
  const channels = Object.keys(keyframes) as TimelineKeyframeChannel[];
  const moving = channels.filter((channel) =>
    channelKeyframes(keyframes, channel).some((keyframe) => keyframe.frame === fromFrame));
  const collisions = moving.filter((channel) =>
    channelKeyframes(keyframes, channel).some((keyframe) => keyframe.frame === frame));
  if (collisions.length > 0) {
    return { ok: false, code: "KEYFRAME_RETIME_COLLISION", frame, channels: collisions };
  }
  if (moving.length === 0) return { ok: true, frame, keyframes };
  const next = { ...keyframes } as Record<string, unknown>;
  for (const channel of moving) {
    next[channel] = channelKeyframes(keyframes, channel)
      .map((keyframe) => keyframe.frame === fromFrame ? { ...keyframe, frame } : keyframe)
      .sort((left, right) => left.frame - right.frame);
  }
  return { ok: true, frame, keyframes: next as TimelineItemKeyframes };
}

export type AdjacentTimelineKeyframes = {
  previousFrame: number | null;
  hasCurrent: boolean;
  nextFrame: number | null;
};

export function findAdjacentTimelineKeyframes(
  keyframes: TimelineItemKeyframes | undefined,
  channel: TimelineKeyframeChannel,
  frame: number,
): AdjacentTimelineKeyframes {
  const frames = channelKeyframes(keyframes, channel)
    .map((keyframe) => keyframe.frame)
    .sort((left, right) => left - right);
  return {
    previousFrame: [...frames].reverse().find((candidate) => candidate < frame) ?? null,
    hasCurrent: frames.includes(frame),
    nextFrame: frames.find((candidate) => candidate > frame) ?? null,
  };
}

function interpolationAtFrame(
  keyframes: readonly TimelineKeyframe[],
  frame: number,
): TimelineKeyframe["interpolation"] {
  const sorted = [...keyframes].sort((left, right) => left.frame - right.frame);
  return [...sorted].reverse().find((keyframe) => keyframe.frame <= frame)?.interpolation
    ?? sorted[0]?.interpolation
    ?? DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION;
}

function sampleChannelValue(
  channel: TimelineKeyframeChannel,
  keyframes: readonly TimelineKeyframe[],
  frame: number,
): TimelineKeyframe["value"] {
  const first = keyframes[0]!;
  if (VECTOR_KEYFRAME_CHANNELS.has(channel)) {
    return sampleVector(
      keyframes as readonly TimelineVectorKeyframe[],
      frame,
      first.value as readonly [number, number],
    );
  }
  return sampleScalar(
    keyframes as readonly TimelineScalarKeyframe[],
    frame,
    first.value as number,
  );
}

function sliceChannel(
  channel: TimelineKeyframeChannel,
  keyframes: readonly TimelineKeyframe[],
  startFrame: number,
  durationInFrames: number,
): TimelineKeyframe[] {
  if (keyframes.length === 0 || durationInFrames <= 0) return [];
  const endFrame = startFrame + durationInFrames - 1;
  const start: TimelineKeyframe = {
    frame: 0,
    value: sampleChannelValue(channel, keyframes, startFrame),
    interpolation: interpolationAtFrame(keyframes, startFrame),
  } as TimelineKeyframe;
  if (durationInFrames === 1) return [start];
  const middle = keyframes
    .filter((keyframe) => keyframe.frame > startFrame && keyframe.frame < endFrame)
    .map((keyframe) => ({ ...keyframe, frame: keyframe.frame - startFrame }));
  const end: TimelineKeyframe = {
    frame: durationInFrames - 1,
    value: sampleChannelValue(channel, keyframes, endFrame),
    interpolation: DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
  } as TimelineKeyframe;
  return [start, ...middle, end];
}

export function sliceTimelineKeyframes(
  keyframes: TimelineItemKeyframes | undefined,
  startFrame: number,
  durationInFrames: number,
): TimelineItemKeyframes | undefined {
  if (!keyframes || durationInFrames <= 0) return undefined;
  const next: Record<string, unknown> = {};
  for (const channel of Object.keys(keyframes) as TimelineKeyframeChannel[]) {
    const sliced = sliceChannel(
      channel,
      channelKeyframes(keyframes, channel),
      startFrame,
      durationInFrames,
    );
    if (sliced.length > 0) next[channel] = sliced;
  }
  return Object.keys(next).length > 0 ? next as TimelineItemKeyframes : undefined;
}

export function rippleDeleteTimelineKeyframes(
  keyframes: TimelineItemKeyframes | undefined,
  startFrame: number,
  endFrame: number,
  durationInFrames: number,
): TimelineItemKeyframes | undefined {
  if (!keyframes || durationInFrames <= 0) return undefined;
  const clampedStart = Math.max(0, Math.min(durationInFrames, startFrame));
  const clampedEnd = Math.max(clampedStart, Math.min(durationInFrames, endFrame));
  if (clampedEnd <= clampedStart) return keyframes;
  if (clampedStart === 0) {
    return sliceTimelineKeyframes(
      keyframes,
      clampedEnd,
      durationInFrames - clampedEnd,
    );
  }
  if (clampedEnd === durationInFrames) {
    return sliceTimelineKeyframes(keyframes, 0, clampedStart);
  }

  const left = sliceTimelineKeyframes(keyframes, 0, clampedStart);
  const right = sliceTimelineKeyframes(
    keyframes,
    clampedEnd,
    durationInFrames - clampedEnd,
  );
  const next: Record<string, unknown> = {};
  for (const channel of Object.keys(keyframes) as TimelineKeyframeChannel[]) {
    const leftChannel = channelKeyframes(left, channel);
    const rightChannel = channelKeyframes(right, channel).map((keyframe) => ({
      ...keyframe,
      frame: keyframe.frame + clampedStart,
    }));
    const combined = [...leftChannel, ...rightChannel];
    if (combined.length > 0) next[channel] = combined;
  }
  return Object.keys(next).length > 0 ? next as TimelineItemKeyframes : undefined;
}
