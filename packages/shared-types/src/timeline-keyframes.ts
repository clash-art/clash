import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";
import {
  DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
  TIMELINE_KEYFRAME_INTERPOLATIONS,
  type TimelineKeyframeInterpolation,
} from "./timeline-keyframe-annotations.js";
import {
  TIMELINE_MASK_ANIMATION_BINDINGS,
  TIMELINE_MASK_FIELD_ANNOTATIONS,
  type TimelineMaskField,
  type TimelineMaskKeyframeChannel,
} from "./timeline-mask.js";

export {
  DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
  sampleTimelineKeyframeChannel,
  TIMELINE_KEYFRAME_INTERPOLATIONS,
  TIMELINE_KEYFRAME_SAMPLING_POLICY,
  type TimelineKeyframeSampleEntry,
  type TimelineKeyframeInterpolation,
} from "./timeline-keyframe-annotations.js";

export type TimelineVectorKeyframe = {
  frame: number;
  value: readonly [number, number];
  interpolation: TimelineKeyframeInterpolation;
};

export type TimelineScalarKeyframe = {
  frame: number;
  value: number;
  interpolation: TimelineKeyframeInterpolation;
};

type TimelineTransformItemKeyframes = {
  position?: TimelineVectorKeyframe[];
  scale?: TimelineVectorKeyframe[];
  rotation?: TimelineScalarKeyframe[];
  opacity?: TimelineScalarKeyframe[];
};

type TimelineMaskItemKeyframes = {
  [TField in keyof typeof TIMELINE_MASK_FIELD_ANNOTATIONS as
    (typeof TIMELINE_MASK_FIELD_ANNOTATIONS)[TField] extends {
      animation: { channel: infer TChannel extends string };
    }
      ? TChannel
      : never]?:
    (typeof TIMELINE_MASK_FIELD_ANNOTATIONS)[TField] extends {
      animation: { valueKind: "vector" };
    }
      ? TimelineVectorKeyframe[]
      : TimelineScalarKeyframe[];
};

export type TimelineItemKeyframes = TimelineTransformItemKeyframes & TimelineMaskItemKeyframes;

export type TimelineKeyframeChannel = keyof TimelineItemKeyframes;
export type TimelineKeyframeValueKind = "vector" | "scalar";

type TimelineKeyframeChannelAnnotation = {
  valueKind: TimelineKeyframeValueKind;
  valueSchema: z.ZodType<unknown>;
  description: string;
  source: "transform" | "mask";
  maskField?: TimelineMaskField;
};

let FiniteVectorSchema = lazySchema(() => (
z.tuple([z.number().finite(), z.number().finite()])
), (real) => { FiniteVectorSchema = real; });
let NonNegativeVectorSchema = lazySchema(() => (
z.tuple([
  z.number().finite().nonnegative(),
  z.number().finite().nonnegative(),
])
), (real) => { NonNegativeVectorSchema = real; });

const TIMELINE_TRANSFORM_KEYFRAME_ANNOTATIONS = {
  position: {
    valueKind: "vector",
    valueSchema: FiniteVectorSchema,
    description: "Item transform position [x, y] in rendered pixels.",
    source: "transform",
  },
  scale: {
    valueKind: "vector",
    valueSchema: NonNegativeVectorSchema,
    description: "Item transform scale [x, y] as non-negative multipliers.",
    source: "transform",
  },
  rotation: {
    valueKind: "scalar",
    valueSchema: z.number().finite(),
    description: "Item transform rotation in degrees.",
    source: "transform",
  },
  opacity: {
    valueKind: "scalar",
    valueSchema: z.number().finite().min(0).max(1),
    description: "Item opacity from 0 through 1.",
    source: "transform",
  },
} as const satisfies Record<string, TimelineKeyframeChannelAnnotation>;

const timelineMaskKeyframeAnnotations = Object.fromEntries(
  TIMELINE_MASK_ANIMATION_BINDINGS.map((binding) => [
    binding.channel,
    {
      valueKind: binding.valueKind,
      valueSchema: binding.valueSchema,
      description: `${binding.label} animated in ${
        binding.field === "position" || binding.field === "size"
          ? "percent of the rendered item bounds"
          : binding.field === "rotation"
            ? "clockwise degrees"
            : "the 0 through 100 feather range"
      }.`,
      source: "mask",
      maskField: binding.field,
    },
  ]),
) as Record<TimelineMaskKeyframeChannel, TimelineKeyframeChannelAnnotation>;

/** Channel annotations are derived from transform metadata plus mask fields. */
export const TIMELINE_KEYFRAME_CHANNEL_ANNOTATIONS = Object.freeze({
  ...TIMELINE_TRANSFORM_KEYFRAME_ANNOTATIONS,
  ...timelineMaskKeyframeAnnotations,
}) as Readonly<Record<TimelineKeyframeChannel, TimelineKeyframeChannelAnnotation>>;

export const TIMELINE_KEYFRAME_CHANNELS = Object.freeze(
  Object.keys(TIMELINE_KEYFRAME_CHANNEL_ANNOTATIONS) as TimelineKeyframeChannel[],
);

let TimelineKeyframeInterpolationSchema = lazySchema(() => (
z.enum(TIMELINE_KEYFRAME_INTERPOLATIONS)
  .describe("Interpolation from this keyframe to the next keyframe.")
), (real) => { TimelineKeyframeInterpolationSchema = real; });
let TimelineKeyframeFrameSchema = lazySchema(() => (
z.number().int().nonnegative()
  .describe("item-local frame. It must be less than the owning item's durationInFrames.")
), (real) => { TimelineKeyframeFrameSchema = real; });

function timelineKeyframeSchema(valueSchema: z.ZodType<unknown>): z.ZodTypeAny {
  return z.object({
    frame: TimelineKeyframeFrameSchema,
    value: valueSchema,
    interpolation: TimelineKeyframeInterpolationSchema,
  }).strict();
}

export let TimelineVectorKeyframeSchema = lazySchema(() => (
timelineKeyframeSchema(
  FiniteVectorSchema,
) as z.ZodType<TimelineVectorKeyframe>
), (real) => { TimelineVectorKeyframeSchema = real; });

export let TimelineScalarKeyframeSchema = lazySchema(() => (
timelineKeyframeSchema(
  z.number().finite(),
) as z.ZodType<TimelineScalarKeyframe>
), (real) => { TimelineScalarKeyframeSchema = real; });

const timelineItemKeyframesSchemaShape = Object.fromEntries(
  Object.entries(TIMELINE_KEYFRAME_CHANNEL_ANNOTATIONS).map(([channel, annotation]) => [
    channel,
    z.array(timelineKeyframeSchema(annotation.valueSchema))
      .describe(annotation.description)
      .optional(),
  ]),
) as unknown as Record<TimelineKeyframeChannel, z.ZodTypeAny>;

export let TimelineItemKeyframesSchema = lazySchema(() => (
z.object(timelineItemKeyframesSchemaShape)
  .strict()
  .describe("TimelineItemKeyframes") as z.ZodType<TimelineItemKeyframes>
), (real) => { TimelineItemKeyframesSchema = real; });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type TimelineKeyframeFrameIssue = {
  channel: TimelineKeyframeChannel;
  index: number;
  frame: unknown;
  reason: "range" | "duplicate";
};

export function timelineKeyframeFrameIssues(
  keyframes: TimelineItemKeyframes | undefined,
  durationInFrames: number,
): TimelineKeyframeFrameIssue[] {
  const issues: TimelineKeyframeFrameIssue[] = [];
  for (const channel of TIMELINE_KEYFRAME_CHANNELS) {
    const entries = keyframes?.[channel] as readonly (TimelineScalarKeyframe | TimelineVectorKeyframe)[] | undefined;
    if (!entries) continue;
    const seenFrames = new Set<number>();
    entries.forEach((keyframe, index) => {
      if (
        !Number.isInteger(keyframe.frame)
        || keyframe.frame < 0
        || keyframe.frame >= durationInFrames
      ) {
        issues.push({ channel, index, frame: keyframe.frame, reason: "range" });
      } else if (seenFrames.has(keyframe.frame)) {
        issues.push({ channel, index, frame: keyframe.frame, reason: "duplicate" });
      }
      if (typeof keyframe.frame === "number") seenFrames.add(keyframe.frame);
    });
  }
  return issues;
}

function channelValueError(channel: TimelineKeyframeChannel): string {
  const maskBinding = TIMELINE_MASK_ANIMATION_BINDINGS.find(
    (binding) => binding.channel === channel,
  );
  if (maskBinding) {
    const annotation = TIMELINE_MASK_FIELD_ANNOTATIONS[maskBinding.field];
    return `keyframes.${channel} value ${annotation.invalidValueDescription}`;
  }
  switch (channel) {
    case "position":
      return "keyframes.position value must be a finite [x, y] tuple";
    case "scale":
      return "keyframes.scale value must be a non-negative finite [x, y] tuple";
    case "rotation":
      return "keyframes.rotation value must be finite";
    case "opacity":
      return "keyframes.opacity value must be between 0 and 1";
    default:
      return `keyframes.${channel} value is invalid`;
  }
}

export function validateTimelineItemKeyframes(
  value: unknown,
  durationInFrames = 0,
): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return "keyframes must be an object";
  const supportedChannels = new Set<string>(TIMELINE_KEYFRAME_CHANNELS);
  for (const channel of Object.keys(value)) {
    if (!supportedChannels.has(channel)) return `keyframes.${channel} is unsupported`;
  }
  for (const channel of TIMELINE_KEYFRAME_CHANNELS) {
    const entries = value[channel];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) return `keyframes.${channel} must be an array`;
    for (const entry of entries) {
      if (!isRecord(entry)) return `keyframes.${channel} entries must be objects`;
    }
  }

  const parsed = TimelineItemKeyframesSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const channel = issue?.path[0] as TimelineKeyframeChannel | undefined;
    const property = issue?.path[2];
    if (channel && property === "interpolation") {
      return `keyframes.${channel} interpolation must be hold or linear`;
    }
    if (channel && property === "frame") {
      return `keyframes.${channel} frame must be an integer between 0 and ${durationInFrames - 1}`;
    }
    if (channel && property === "value") return channelValueError(channel);
    return channel ? `keyframes.${channel} entries are invalid` : "keyframes are invalid";
  }

  const frameIssue = timelineKeyframeFrameIssues(parsed.data, durationInFrames)[0];
  if (!frameIssue) return null;
  return frameIssue.reason === "duplicate"
    ? `keyframes.${frameIssue.channel} contains duplicate frame ${frameIssue.frame}`
    : `keyframes.${frameIssue.channel} frame must be an integer between 0 and ${durationInFrames - 1}`;
}
