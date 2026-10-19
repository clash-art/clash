import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";
import {
  DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
  TIMELINE_KEYFRAME_INTERPOLATIONS,
  TIMELINE_KEYFRAME_SAMPLING_POLICY,
} from "./timeline-keyframe-annotations.js";

export const TIMELINE_MASK_SHAPE_ANNOTATIONS = {
  rectangle: {
    label: "Rectangle",
    renderPrimitive: "rectangle",
  },
  ellipse: {
    label: "Ellipse",
    renderPrimitive: "ellipse",
  },
} as const;

export type TimelineMaskShape = keyof typeof TIMELINE_MASK_SHAPE_ANNOTATIONS;
export type TimelineMaskRenderPrimitive =
  (typeof TIMELINE_MASK_SHAPE_ANNOTATIONS)[TimelineMaskShape]["renderPrimitive"];

export const TIMELINE_MASK_SHAPES = Object.freeze(
  Object.keys(TIMELINE_MASK_SHAPE_ANNOTATIONS) as [
    TimelineMaskShape,
    ...TimelineMaskShape[],
  ],
);

export type TimelineMaskAnimatedValueKind = "vector" | "scalar";
export const TIMELINE_MASK_FEATHER_BLUR_DIVISOR = 600;

export type TimelineMaskNumberInputAnnotation = {
  step: number;
  min?: number;
  max?: number;
};

export type TimelineMaskStaticControlAnnotation =
  | {
      kind: "select";
      label: string;
      ariaLabel: string;
      options: Readonly<Record<string, { label: string }>>;
    }
  | {
      kind: "toggle";
      label: string;
      ariaLabel: string;
    };

type TimelineMaskAnimationBase<TValue> = {
  channel: string;
  label: string;
  exampleValues: readonly [TValue, TValue];
};

type TimelineMaskVectorAnimationAnnotation<TValue> = TimelineMaskAnimationBase<TValue> & {
  valueKind: "vector";
  axisLabels: readonly [string, string];
  axisAriaLabels: readonly [string, string];
  axisInputs: readonly [
    TimelineMaskNumberInputAnnotation,
    TimelineMaskNumberInputAnnotation,
  ];
};

type TimelineMaskScalarAnimationAnnotation<TValue> = TimelineMaskAnimationBase<TValue> & {
  valueKind: "scalar";
  ariaLabel: string;
  input: TimelineMaskNumberInputAnnotation;
};

type TimelineMaskAnimationAnnotation<TValue = unknown> =
  | TimelineMaskVectorAnimationAnnotation<TValue>
  | TimelineMaskScalarAnimationAnnotation<TValue>;

type TimelineMaskFieldAnnotation<TValue> = {
  schema: z.ZodType<TValue>;
  defaultValue: TValue;
  exampleValue?: TValue;
  description: string;
  invalidValueDescription: string;
  unit: string;
  animation?: TimelineMaskAnimationAnnotation<TValue>;
  staticControl?: TimelineMaskStaticControlAnnotation;
};

function defineTimelineMaskField<
  TValue,
  const TAnimation extends TimelineMaskAnimationAnnotation<TValue>,
>(annotation: Omit<TimelineMaskFieldAnnotation<TValue>, "animation"> & {
  animation: TAnimation;
}): Omit<TimelineMaskFieldAnnotation<TValue>, "animation"> & {
  animation: TAnimation;
};
function defineTimelineMaskField<TValue>(
  annotation: Omit<TimelineMaskFieldAnnotation<TValue>, "animation" | "staticControl"> & {
    animation?: undefined;
    staticControl: TimelineMaskStaticControlAnnotation;
  },
): Omit<TimelineMaskFieldAnnotation<TValue>, "animation" | "staticControl"> & {
  animation?: undefined;
  staticControl: TimelineMaskStaticControlAnnotation;
};
function defineTimelineMaskField(
  annotation: TimelineMaskFieldAnnotation<unknown>,
): TimelineMaskFieldAnnotation<unknown> {
  return {
    ...annotation,
    schema: annotation.schema.describe(annotation.description),
  };
}

let FiniteMaskVectorSchema = lazySchema(() => (
z.tuple([
  z.number().finite(),
  z.number().finite(),
])
), (real) => { FiniteMaskVectorSchema = real; });
let NonNegativeMaskVectorSchema = lazySchema(() => (
z.tuple([
  z.number().finite().nonnegative(),
  z.number().finite().nonnegative(),
])
), (real) => { NonNegativeMaskVectorSchema = real; });

/**
 * Implementation-side mask annotations. This is the single source used to
 * derive validation, defaults, keyframe channels, UI controls, JSON Schema,
 * examples, and generated agent documentation.
 */
export const TIMELINE_MASK_FIELD_ANNOTATIONS = {
  shape: defineTimelineMaskField({
    schema: z.enum(TIMELINE_MASK_SHAPES),
    defaultValue: "rectangle" as TimelineMaskShape,
    exampleValue: "ellipse" as TimelineMaskShape,
    unit: `enum:${TIMELINE_MASK_SHAPES.join("|")}`,
    description: "Mask primitive. Shape changes are static; they are not keyframe channels.",
    invalidValueDescription: `must be ${TIMELINE_MASK_SHAPES.join(" or ")}`,
    staticControl: {
      kind: "select",
      label: "Shape",
      ariaLabel: "Mask shape",
      options: TIMELINE_MASK_SHAPE_ANNOTATIONS,
    },
  }),
  position: defineTimelineMaskField({
    schema: FiniteMaskVectorSchema as z.ZodType<readonly [number, number]>,
    defaultValue: [50, 50] as const,
    unit: "percent-of-rendered-item-bounds",
    description: "Clip-local [x, y] center in percent of the rendered item bounds; values outside 0..100 move the mask beyond the clip.",
    invalidValueDescription: "must be a finite [x, y] tuple",
    animation: {
      channel: "maskPosition",
      valueKind: "vector",
      label: "Mask position",
      axisLabels: ["X", "Y"],
      axisAriaLabels: ["Mask center X percent", "Mask center Y percent"],
      axisInputs: [{ step: 1 }, { step: 1 }],
      exampleValues: [[30, 50], [70, 50]],
    },
  }),
  size: defineTimelineMaskField({
    schema: NonNegativeMaskVectorSchema as z.ZodType<readonly [number, number]>,
    defaultValue: [70, 70] as const,
    unit: "percent-of-rendered-item-bounds",
    description: "Clip-local [width, height] in percent of the rendered item bounds.",
    invalidValueDescription: "must be a non-negative finite [width, height] tuple",
    animation: {
      channel: "maskSize",
      valueKind: "vector",
      label: "Mask size",
      axisLabels: ["W", "H"],
      axisAriaLabels: ["Mask width percent", "Mask height percent"],
      axisInputs: [{ step: 1, min: 0 }, { step: 1, min: 0 }],
      exampleValues: [[70, 70], [35, 35]],
    },
  }),
  rotation: defineTimelineMaskField({
    schema: z.number().finite(),
    defaultValue: 0,
    unit: "degrees",
    description: "Clockwise mask rotation in degrees.",
    invalidValueDescription: "must be finite",
    animation: {
      channel: "maskRotation",
      valueKind: "scalar",
      label: "Mask rotation",
      ariaLabel: "Mask rotation in degrees",
      input: { step: 1 },
      exampleValues: [0, 25],
    },
  }),
  feather: defineTimelineMaskField({
    schema: z.number().finite().min(0).max(100),
    defaultValue: 0,
    exampleValue: 8,
    unit: "amount-0..100",
    description: "Edge feather amount from 0 through 100, mapped proportionally to the shorter rendered mask dimension.",
    invalidValueDescription: "must be between 0 and 100",
    animation: {
      channel: "maskFeather",
      valueKind: "scalar",
      label: "Mask feather",
      ariaLabel: "Mask feather percent",
      input: { step: 1, min: 0, max: 100 },
      exampleValues: [0, 30],
    },
  }),
  inverted: defineTimelineMaskField({
    schema: z.boolean(),
    defaultValue: false,
    unit: "boolean",
    description: "False reveals the mask interior; true reveals the exterior. Inversion is static, not keyframed.",
    invalidValueDescription: "must be boolean",
    staticControl: {
      kind: "toggle",
      label: "Invert",
      ariaLabel: "Invert mask",
    },
  }),
} as const;

export type TimelineItemMask = {
  [TField in keyof typeof TIMELINE_MASK_FIELD_ANNOTATIONS]:
    z.output<(typeof TIMELINE_MASK_FIELD_ANNOTATIONS)[TField]["schema"]>;
};

export type TimelineMaskField = keyof TimelineItemMask;
export type TimelineMaskKeyframeChannel = {
  [TField in keyof typeof TIMELINE_MASK_FIELD_ANNOTATIONS]:
    (typeof TIMELINE_MASK_FIELD_ANNOTATIONS)[TField] extends {
      animation: {
        channel: infer TChannel extends string;
      };
    }
      ? TChannel
      : never;
}[keyof typeof TIMELINE_MASK_FIELD_ANNOTATIONS];

export type TimelineMaskAnimatedField = {
  [TField in keyof typeof TIMELINE_MASK_FIELD_ANNOTATIONS]:
    (typeof TIMELINE_MASK_FIELD_ANNOTATIONS)[TField] extends {
      animation: TimelineMaskAnimationAnnotation<unknown>;
    }
      ? TField
      : never;
}[keyof typeof TIMELINE_MASK_FIELD_ANNOTATIONS];

export type TimelineMaskVectorAnimatedField = {
  [TField in keyof typeof TIMELINE_MASK_FIELD_ANNOTATIONS]:
    (typeof TIMELINE_MASK_FIELD_ANNOTATIONS)[TField] extends {
      animation: { valueKind: "vector" };
    }
      ? TField
      : never;
}[keyof typeof TIMELINE_MASK_FIELD_ANNOTATIONS];

export type TimelineMaskScalarAnimatedField = {
  [TField in keyof typeof TIMELINE_MASK_FIELD_ANNOTATIONS]:
    (typeof TIMELINE_MASK_FIELD_ANNOTATIONS)[TField] extends {
      animation: { valueKind: "scalar" };
    }
      ? TField
      : never;
}[keyof typeof TIMELINE_MASK_FIELD_ANNOTATIONS];

export type TimelineMaskKeyframeSample = Pick<
  TimelineItemMask,
  TimelineMaskAnimatedField
>;

type TimelineMaskSchemaShape = {
  [TField in TimelineMaskField]: (typeof TIMELINE_MASK_FIELD_ANNOTATIONS)[TField]["schema"];
};

const timelineMaskSchemaShape = Object.fromEntries(
  Object.entries(TIMELINE_MASK_FIELD_ANNOTATIONS).map(([field, annotation]) => [
    field,
    annotation.schema,
  ]),
) as TimelineMaskSchemaShape;

export let TimelineItemMaskSchema = lazySchema(() => (
z.object(timelineMaskSchemaShape)
  .strict()
  .describe("TimelineItemMask") as z.ZodType<TimelineItemMask>
), (real) => { TimelineItemMaskSchema = real; });

export const TIMELINE_MASK_FIELDS = Object.freeze(
  Object.keys(TIMELINE_MASK_FIELD_ANNOTATIONS) as TimelineMaskField[],
);

type TimelineMaskAnimationWithoutChannel<TAnimation> = TAnimation extends unknown
  ? Omit<TAnimation, "channel">
  : never;

export type TimelineMaskAnimationBinding = TimelineMaskAnimationWithoutChannel<
  TimelineMaskAnimationAnnotation
> & {
  channel: TimelineMaskKeyframeChannel;
  field: TimelineMaskField;
  valueSchema: z.ZodType<unknown>;
};

export type TimelineMaskVectorAnimationBinding = TimelineMaskAnimationBinding & {
  valueKind: "vector";
  field: TimelineMaskVectorAnimatedField;
  axisLabels: readonly [string, string];
  axisAriaLabels: readonly [string, string];
  axisInputs: readonly [
    TimelineMaskNumberInputAnnotation,
    TimelineMaskNumberInputAnnotation,
  ];
};

export type TimelineMaskScalarAnimationBinding = TimelineMaskAnimationBinding & {
  valueKind: "scalar";
  field: TimelineMaskScalarAnimatedField;
  ariaLabel: string;
  input: TimelineMaskNumberInputAnnotation;
};

export const TIMELINE_MASK_ANIMATION_BINDINGS = Object.freeze(
  Object.entries(TIMELINE_MASK_FIELD_ANNOTATIONS).flatMap(([field, annotation]) => (
    "animation" in annotation && annotation.animation
      ? [{
          field: field as TimelineMaskField,
          valueSchema: annotation.schema as z.ZodType<unknown>,
          ...annotation.animation,
        }]
      : []
  )) as TimelineMaskAnimationBinding[],
);

export const TIMELINE_MASK_VECTOR_ANIMATION_BINDINGS = Object.freeze(
  TIMELINE_MASK_ANIMATION_BINDINGS.filter(
    (binding): binding is TimelineMaskVectorAnimationBinding => binding.valueKind === "vector",
  ),
);

export const TIMELINE_MASK_SCALAR_ANIMATION_BINDINGS = Object.freeze(
  TIMELINE_MASK_ANIMATION_BINDINGS.filter(
    (binding): binding is TimelineMaskScalarAnimationBinding => binding.valueKind === "scalar",
  ),
);

export type TimelineMaskStaticControlBinding = {
  field: TimelineMaskField;
  control: TimelineMaskStaticControlAnnotation;
};

export const TIMELINE_MASK_STATIC_CONTROL_BINDINGS = Object.freeze(
  Object.entries(TIMELINE_MASK_FIELD_ANNOTATIONS).flatMap(([field, annotation]) => (
    "staticControl" in annotation && annotation.staticControl
      ? [{
          field: field as TimelineMaskField,
          control: annotation.staticControl,
        }]
      : []
  )) as TimelineMaskStaticControlBinding[],
);

export const TIMELINE_MASK_KEYFRAME_CHANNELS = Object.freeze(
  TIMELINE_MASK_ANIMATION_BINDINGS.map(({ channel }) => channel),
);

export const DEFAULT_TIMELINE_ITEM_MASK = Object.freeze(
  Object.fromEntries(
    Object.entries(TIMELINE_MASK_FIELD_ANNOTATIONS).map(([field, annotation]) => [
      field,
      annotation.defaultValue,
    ]),
  ) as TimelineItemMask,
);

export function createDefaultTimelineItemMask(): TimelineItemMask {
  return Object.fromEntries(
    Object.entries(DEFAULT_TIMELINE_ITEM_MASK).map(([field, value]) => [
      field,
      Array.isArray(value) ? [...value] : value,
    ]),
  ) as TimelineItemMask;
}

export const TIMELINE_MASK_APPLIES_TO_ITEM_TYPES = Object.freeze([
  "video",
  "image",
  "solid",
  "text",
  "sticker",
  "composition",
  "derived-overlay",
] as const);

export const TIMELINE_MASK_EXCLUDED_ITEM_TYPES = Object.freeze([
  "audio",
  "transition",
] as const);

/** JavaDoc-like structured capability metadata consumed by code and DSL output. */
export const TIMELINE_MASK_CAPABILITY_ANNOTATION = {
  id: "clipMask",
  yamlPath: "tracks[].items[]",
  appliesToItemTypes: TIMELINE_MASK_APPLIES_TO_ITEM_TYPES,
  excludedItemTypes: TIMELINE_MASK_EXCLUDED_ITEM_TYPES,
  fields: TIMELINE_MASK_FIELD_ANNOTATIONS,
  staticFields: TIMELINE_MASK_FIELDS,
  animatedChannels: TIMELINE_MASK_KEYFRAME_CHANNELS,
  defaultMask: DEFAULT_TIMELINE_ITEM_MASK,
  featherBlurDivisor: TIMELINE_MASK_FEATHER_BLUR_DIVISOR,
  semantics: {
    geometryUnits: TIMELINE_MASK_FIELD_ANNOTATIONS.position.unit,
    rotationUnit: TIMELINE_MASK_FIELD_ANNOTATIONS.rotation.unit,
    featherRange: [
      TIMELINE_MASK_FIELD_ANNOTATIONS.feather.animation.input.min,
      TIMELINE_MASK_FIELD_ANNOTATIONS.feather.animation.input.max,
    ],
    frameSpace: TIMELINE_KEYFRAME_SAMPLING_POLICY.frameSpace,
    validFrameRange: "0..durationInFrames-1",
    interpolation: TIMELINE_KEYFRAME_INTERPOLATIONS,
    interpolationOwner: TIMELINE_KEYFRAME_SAMPLING_POLICY.interpolationOwner,
    defaultNewKeyframeInterpolation: DEFAULT_TIMELINE_KEYFRAME_INTERPOLATION,
    beforeFirstKeyframe: TIMELINE_KEYFRAME_SAMPLING_POLICY.beforeFirstKeyframe,
    afterLastKeyframe: TIMELINE_KEYFRAME_SAMPLING_POLICY.afterLastKeyframe,
    emptyChannelFallback: "matching-item.mask-field",
    duplicateFrames: "rejected-per-channel",
    keyframeStorageOrder: TIMELINE_KEYFRAME_SAMPLING_POLICY.storageOrder,
    positiveRotation: "clockwise",
    featherModel: `blur-stddev=min(rendered-mask-width,rendered-mask-height)*feather/${TIMELINE_MASK_FEATHER_BLUR_DIVISOR}`,
    staticOnlyFields: TIMELINE_MASK_STATIC_CONTROL_BINDINGS.map(({ field }) => field),
    requiresStaticMask: true,
    fallback: "Each animated mask channel falls back to the matching item.mask field when the channel is absent or empty.",
  },
  operations: {
    addOrReplaceMask: `write all ${TIMELINE_MASK_FIELDS.length} item.mask fields`,
    updateStaticFallback: "edit the matching item.mask field",
    removeMask: "omit item.mask and remove every mask* keyframe channel",
    upsertKeyframe: "replace the entry at the same item-local frame or insert a sorted entry",
    setKeyframeInterpolation: "replace the current keyframe interpolation with hold or linear",
    removeKeyframe: "remove the entry and omit the channel when it becomes empty",
  },
  runtimeBehavior: {
    previewExportParity: true,
    timelineMarkers: "derived-from-mask-keyframe-channels",
    undoRedoPersistence: "editor-history-not-a-dsl-field",
    moveKeyframePolicy: "preserve-item-local-frames",
    trimSplitRippleKeyframePolicy: "sample-new-boundaries-then-slice-and-shift-item-local-keys",
    transitionSampling: "referenced-item-local",
    maskedClipMergePolicy: "never-merge-contiguous-items",
  },
} as const;

export function canMergeTimelineItemsAcrossMaskBoundary(
  left: { mask?: unknown },
  right: { mask?: unknown },
): boolean {
  return left.mask === undefined && right.mask === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateTimelineItemMask(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return "mask must be an object";

  const supportedFields = new Set<string>(TIMELINE_MASK_FIELDS);
  for (const field of Object.keys(value)) {
    if (!supportedFields.has(field)) return `mask.${field} is unsupported`;
  }

  const parsed = TimelineItemMaskSchema.safeParse(value);
  if (parsed.success) return null;
  const field = parsed.error.issues[0]?.path[0];
  if (typeof field === "string" && field in TIMELINE_MASK_FIELD_ANNOTATIONS) {
    const annotation = TIMELINE_MASK_FIELD_ANNOTATIONS[field as TimelineMaskField];
    return `mask.${field} ${annotation.invalidValueDescription}`;
  }
  return "mask is invalid";
}
