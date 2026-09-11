import { z } from "zod";
import { TimelineItemKeyframesSchema } from "./timeline-keyframes.js";
import {
  TIMELINE_MASK_APPLIES_TO_ITEM_TYPES,
  TimelineItemMaskSchema,
} from "./timeline-mask.js";

/**
 * Java-annotation-style metadata for the complete persisted Timeline contract.
 *
 * The executable Zod schema and the serializable catalog below are two views
 * of this one registry. Schema, YAML, docs, UI routing, and runtime coverage
 * must consume this registry rather than maintaining independent field lists.
 */
export type TimelineDslEditorSurface = "timeline" | "properties-panel" | "none";

export const TIMELINE_DSL_RUNTIME_CONSUMERS = [
  "asset-loader",
  "audio-ducking",
  "audio-mix",
  "canvas-link",
  "caption-export",
  "caption-generation",
  "composition-runtime",
  "derivation",
  "editor",
  "effect-runtime",
  "export",
  "future-renderer",
  "migration",
  "persistence",
  "preview",
  "render",
  "timeline-semantics",
  "transcript",
  "yaml",
] as const;

export type TimelineDslRuntimeConsumer =
  (typeof TIMELINE_DSL_RUNTIME_CONSUMERS)[number];

export type TimelineDslFieldAnnotation = {
  schema: z.ZodTypeAny;
  description: string;
  authored: boolean;
  required: boolean;
  authoredRequired: boolean;
  editor: {
    surface: TimelineDslEditorSurface;
    control?: string;
  };
  runtimeConsumers: readonly TimelineDslRuntimeConsumer[];
  /** Project persistence handling for legacy/runtime-only presentation fields. */
  persistence?: "discard";
  appliesToItemTypes?: readonly TimelineDslItemType[];
  applicabilityRuleId?: string;
  applicabilityMessage?: string;
  deprecated?: string;
  relation?: "tracks" | "items";
  defaultValue?: unknown;
};

export type TimelineDslFieldRequiredness = "authored" | "runtime" | "partial";

/**
 * Build an executable Zod object shape from the field annotations.
 *
 * Every structural consumer uses this helper so adding a field cannot update
 * the public document schema while silently missing editor operation inputs.
 */
export function timelineDslAnnotatedObjectShape(
  fields: Record<string, TimelineDslFieldAnnotation>,
  options: {
    overrides?: z.ZodRawShape;
    requiredness?: TimelineDslFieldRequiredness;
  } = {},
): z.ZodRawShape {
  const requiredness = options.requiredness ?? "authored";
  return Object.fromEntries(
    Object.entries(fields).map(([name, annotation]) => {
      const executable = options.overrides?.[name]
        ?? annotation.schema.describe(annotation.description);
      const required = requiredness === "runtime"
        ? annotation.required
        : requiredness === "authored"
          ? annotation.authoredRequired
          : false;
      return [name, required ? executable : executable.optional()];
    }),
  );
}

type FieldOptions = Omit<
  TimelineDslFieldAnnotation,
  "schema" | "description" | "authoredRequired"
> & {
  authoredRequired?: boolean;
};

export type TimelineDslTypedFieldAnnotation<Schema extends z.ZodTypeAny> =
  Omit<TimelineDslFieldAnnotation, "schema"> & {
    schema: Schema;
  };

function field<Schema extends z.ZodTypeAny>(
  schema: Schema,
  description: string,
  options: FieldOptions,
): TimelineDslTypedFieldAnnotation<Schema> {
  return {
    schema,
    description,
    ...options,
    authoredRequired: options.authoredRequired ?? options.required,
  };
}

const authored = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  description: string,
  options: Omit<FieldOptions, "authored">,
) => field(schema, description, { ...options, authored: true });

const derived = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  description: string,
  options: Omit<FieldOptions, "authored">,
) => field(schema, description, { ...options, authored: false });

export const TIMELINE_DSL_ITEM_TYPES = [
  "video",
  "audio",
  "image",
  "solid",
  "text",
  "sticker",
  "composition",
  "derived-overlay",
  "transition",
] as const;

export type TimelineDslItemType = (typeof TIMELINE_DSL_ITEM_TYPES)[number];

export const TIMELINE_DSL_TRACK_CATEGORIES = [
  "effect",
  "text",
  "visual",
  "primary",
  "audio",
] as const;

export type TimelineDslTrackCategory = (typeof TIMELINE_DSL_TRACK_CATEGORIES)[number];

export const TIMELINE_DSL_TRACK_ROLES = [
  "primary-video",
  "b-roll",
  "overlay",
  "subtitle",
  "narration",
  "dialogue",
  "music",
  "sfx",
  "transition",
  "mixed",
] as const;

export type TimelineDslTrackRole = (typeof TIMELINE_DSL_TRACK_ROLES)[number];

export const TIMELINE_DSL_CATEGORY_ALLOWED_ITEM_TYPES = {
  effect: ["composition", "transition"],
  text: ["text"],
  visual: ["video", "image", "solid", "sticker", "composition", "derived-overlay"],
  primary: ["video", "image", "solid"],
  audio: ["audio"],
} as const satisfies Record<TimelineDslTrackCategory, readonly TimelineDslItemType[]>;

export const TIMELINE_DSL_ROLE_ALLOWED_ITEM_TYPES = {
  "primary-video": ["video", "image", "solid"],
  "b-roll": ["video", "image", "solid"],
  overlay: ["video", "image", "solid", "text", "sticker", "composition", "derived-overlay"],
  subtitle: ["text"],
  narration: ["audio", "video"],
  dialogue: ["audio", "video"],
  music: ["audio"],
  sfx: ["audio"],
  transition: ["transition"],
  mixed: TIMELINE_DSL_ITEM_TYPES,
} as const satisfies Record<TimelineDslTrackRole, readonly TimelineDslItemType[]>;

export const TIMELINE_DSL_ROLE_CATEGORIES = {
  "primary-video": "primary",
  "b-roll": "visual",
  overlay: "visual",
  subtitle: "text",
  narration: "audio",
  dialogue: "audio",
  music: "audio",
  sfx: "audio",
  transition: "effect",
  mixed: null,
} as const satisfies Record<TimelineDslTrackRole, TimelineDslTrackCategory | null>;

export const TIMELINE_MEDIA_FITS = ["fill", "cover", "contain"] as const;
export const TIMELINE_TEXT_ALIGNMENTS = ["left", "center", "right"] as const;
export const TIMELINE_CAPTION_POSITIONS = ["bottom", "top", "center"] as const;
export const TIMELINE_CLIP_ANIMATION_TYPES = [
  "fade",
  "zoom-in",
  "zoom-out",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
] as const;
export const TIMELINE_COMPOSITION_KINDS = ["motion-graphics", "custom"] as const;
export const TIMELINE_COMPOSITION_RUNTIMES = ["html", "react", "remotion"] as const;
export const TIMELINE_DERIVED_MEDIA_TYPES = ["image", "video"] as const;
export const TIMELINE_DERIVATION_KINDS = [
  "trim",
  "crop",
  "caption-burn",
  "transcode",
  "other",
] as const;
export const TIMELINE_TRANSITION_TYPES = [
  "crossfade",
  "push-left",
  "push-right",
  "slide-up",
  "slide-down",
  "wipe-left",
  "wipe-right",
  "circle-wipe",
  "zoom-in",
] as const;

const NonEmptyStringSchema = z.string().min(1);
const FiniteNumberSchema = z.number().finite();
const NonnegativeFrameSchema = z.number().int().nonnegative();
const PositiveFrameSchema = z.number().int().positive();
const CssColorSchema = z.string().min(1);

export const TIMELINE_ITEM_TRANSFORM_SEMANTICS = {
  position: {
    fields: ["properties.x", "properties.y"],
    unit: "composition-pixels",
    origin: "composition-center",
  },
  staticSize: {
    fields: ["properties.width", "properties.height"],
    unit: "unitless-source-size-multiplier",
    outputPixels: false,
    defaults: { width: 1, height: 1 },
    oneByOneBehavior: "contain-fit-within-composition",
  },
  animatedScale: {
    field: "keyframes.scale",
    unit: "unitless-multiplier-of-static-size",
  },
} as const;

export const TimelineItemPropertiesSchema = z.object({
  x: FiniteNumberSchema.describe(
    "Horizontal center offset in composition pixels; 0 is the composition center.",
  ),
  y: FiniteNumberSchema.describe(
    "Vertical center offset in composition pixels; 0 is the composition center.",
  ),
  width: FiniteNumberSchema.describe(
    "Unitless multiplier of resolved source natural width; not output pixels. When width and height are both 1, the renderer contain-fits the source within the composition.",
  ),
  height: FiniteNumberSchema.describe(
    "Unitless multiplier of resolved source natural height; not output pixels. When width and height are both 1, the renderer contain-fits the source within the composition.",
  ),
  rotation: FiniteNumberSchema.describe("Clockwise rotation in degrees.").optional(),
  opacity: z.number().finite().min(0).max(1).describe("Unitless opacity from 0 through 1.").optional(),
});

export const TimelineEffectParamValueSchema = z.union([
  z.string(),
  FiniteNumberSchema,
  z.boolean(),
  z.tuple([FiniteNumberSchema, FiniteNumberSchema]),
]);

export const TimelineEffectInstanceRefSchema = z.object({
  effectId: z.string().regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)+$/),
  effectVersion: z.number().int().positive(),
  params: z.record(TimelineEffectParamValueSchema).optional(),
});

export const TimelineMediaFitSchema = z.enum(TIMELINE_MEDIA_FITS);

export const TimelineClipAnimationSchema = z.object({
  type: z.enum(TIMELINE_CLIP_ANIMATION_TYPES),
  durationInFrames: PositiveFrameSchema,
});

export const TimelineAudioDuckingSchema = z.object({
  amountDb: z.number().finite().min(-60).max(0),
  attackFrames: NonnegativeFrameSchema,
  releaseFrames: NonnegativeFrameSchema,
});

export const TimelineCaptionCueSchema = z.object({
  id: NonEmptyStringSchema,
  startFrame: NonnegativeFrameSchema,
  durationInFrames: PositiveFrameSchema,
  text: z.string(),
  wordIds: z.array(NonEmptyStringSchema).optional(),
  sourceStartFrame: NonnegativeFrameSchema.optional(),
  sourceEndFrame: NonnegativeFrameSchema.optional(),
});

export const TimelineCaptionWordReferenceSchema = z.object({
  id: NonEmptyStringSchema,
  text: z.string(),
  assetId: NonEmptyStringSchema.optional(),
  assetWordId: NonEmptyStringSchema.optional(),
  clipId: NonEmptyStringSchema.optional(),
  trackId: NonEmptyStringSchema.optional(),
  sourceStartFrame: NonnegativeFrameSchema,
  sourceEndFrame: NonnegativeFrameSchema,
  confidence: z.number().finite().min(0).max(1).optional(),
});

export const TimelineSourceToOutputFrameMapSchema = z.object({
  sourceStartFrame: NonnegativeFrameSchema,
  sourceEndFrame: NonnegativeFrameSchema,
  outputStartFrame: NonnegativeFrameSchema,
  outputEndFrame: NonnegativeFrameSchema,
});

export const TimelineTypographyStyleSchema = z.object({
  color: CssColorSchema.optional(),
  fontSize: z.number().finite().positive().optional(),
  fontFamily: NonEmptyStringSchema.optional(),
  fontWeight: z.union([z.string(), FiniteNumberSchema]).optional(),
  backgroundColor: CssColorSchema.optional(),
  position: z.enum(TIMELINE_CAPTION_POSITIONS).optional(),
});

export const TimelineEditorTranscriptWordSchema = z.object({
  id: NonEmptyStringSchema,
  text: z.string(),
  startMs: z.number().finite().nonnegative(),
  endMs: z.number().finite().nonnegative(),
  confidence: z.number().finite().min(0).max(1).optional(),
  speakerId: NonEmptyStringSchema.optional(),
});

export const TimelineEditorAssetTranscriptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("clash.editor.asset-transcript"),
  assetId: NonEmptyStringSchema,
  text: z.string(),
  durationMs: z.number().finite().nonnegative(),
  words: z.array(TimelineEditorTranscriptWordSchema),
  backendId: NonEmptyStringSchema.optional(),
  modelId: NonEmptyStringSchema.optional(),
  language: NonEmptyStringSchema.optional(),
});

export const TimelineSequenceSchema = z.object({
  baseUrl: NonEmptyStringSchema,
  frameCount: PositiveFrameSchema,
  fps: z.number().finite().positive(),
});

export const TimelineDerivedAssetSchema = z.object({
  kind: z.enum(TIMELINE_DERIVATION_KINDS),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
});

const noControl = { surface: "none" } as const;
const timelineControl = { surface: "timeline" } as const;
const propertiesControl = { surface: "properties-panel" } as const;

const rootFields = {
  compositionWidth: authored(z.number().finite().positive(), "Composition width in output pixels.", {
    required: true,
    authoredRequired: false,
    editor: { ...propertiesControl, control: "composition-size" },
    runtimeConsumers: ["editor", "preview", "render", "export"],
    defaultValue: 1920,
  }),
  compositionHeight: authored(z.number().finite().positive(), "Composition height in output pixels.", {
    required: true,
    authoredRequired: false,
    editor: { ...propertiesControl, control: "composition-size" },
    runtimeConsumers: ["editor", "preview", "render", "export"],
    defaultValue: 1080,
  }),
  fps: authored(z.number().finite().positive(), "Timeline frames per second.", {
    required: true,
    authoredRequired: false,
    editor: propertiesControl,
    runtimeConsumers: ["editor", "preview", "render", "export", "transcript"],
    defaultValue: 30,
  }),
  durationInFrames: authored(PositiveFrameSchema, "Composition duration in Timeline frames.", {
    required: true,
    authoredRequired: false,
    editor: propertiesControl,
    runtimeConsumers: ["editor", "preview", "render", "export"],
    defaultValue: 300,
  }),
  primaryTrackId: authored(NonEmptyStringSchema.nullable(), "Id of the track that defines the semantic primary edit.", {
    required: false,
    editor: timelineControl,
    runtimeConsumers: ["editor", "timeline-semantics", "transcript", "export"],
    defaultValue: null,
  }),
  tracks: authored(z.array(z.unknown()), "Ordered Timeline track collection.", {
    required: true,
    editor: timelineControl,
    runtimeConsumers: ["editor", "preview", "render", "export", "yaml"],
    relation: "tracks",
  }),
  assetTranscripts: derived(z.record(TimelineEditorAssetTranscriptSchema), "Persisted word-level transcripts keyed by asset id; agents must preserve entries they do not edit.", {
    required: false,
    editor: noControl,
    runtimeConsumers: ["editor", "transcript", "caption-generation", "persistence"],
    defaultValue: {},
  }),
} as const;

const trackFields = {
  id: authored(NonEmptyStringSchema, "Stable track id, unique within the Timeline.", {
    required: true,
    editor: timelineControl,
    runtimeConsumers: ["editor", "preview", "render", "yaml"],
  }),
  name: authored(z.string(), "Human-readable track name.", {
    required: true,
    authoredRequired: false,
    editor: timelineControl,
    runtimeConsumers: ["editor"],
    defaultValue: "",
  }),
  role: authored(z.enum(TIMELINE_DSL_TRACK_ROLES), "Semantic purpose of the track.", {
    required: false,
    editor: timelineControl,
    runtimeConsumers: ["editor", "timeline-semantics", "audio-ducking", "transcript"],
  }),
  category: authored(z.enum(TIMELINE_DSL_TRACK_CATEGORIES), "Structural lane category controlling order and allowed item types.", {
    required: false,
    editor: timelineControl,
    runtimeConsumers: ["editor", "timeline-semantics", "render"],
  }),
  items: authored(z.array(z.unknown()), "Ordered items placed on this track.", {
    required: true,
    editor: timelineControl,
    runtimeConsumers: ["editor", "preview", "render", "yaml"],
    relation: "items",
  }),
  hidden: authored(z.boolean(), "Whether the track is hidden from preview and render.", {
    required: false,
    editor: timelineControl,
    runtimeConsumers: ["editor", "preview", "render"],
    defaultValue: false,
  }),
  locked: authored(z.boolean(), "Whether interactive editor mutations are locked.", {
    required: false,
    editor: timelineControl,
    runtimeConsumers: ["editor"],
    defaultValue: false,
  }),
} as const;

const itemBaseFields = {
  id: authored(NonEmptyStringSchema, "Stable item id, globally unique within the Timeline.", {
    required: true,
    editor: timelineControl,
    runtimeConsumers: ["editor", "preview", "render", "yaml"],
  }),
  type: authored(z.enum(TIMELINE_DSL_ITEM_TYPES), "Discriminant selecting the item field contract and renderer.", {
    required: true,
    editor: timelineControl,
    runtimeConsumers: ["editor", "preview", "render", "export", "yaml"],
  }),
  from: authored(z.union([z.number().finite().nonnegative(), NonEmptyStringSchema]), "Composition-absolute start frame or a relative authoring expression such as prev+15.", {
    required: true,
    editor: timelineControl,
    runtimeConsumers: ["editor", "preview", "render", "yaml"],
  }),
  durationInFrames: authored(PositiveFrameSchema, "Positive item duration in Timeline frames.", {
    required: true,
    editor: timelineControl,
    runtimeConsumers: ["editor", "preview", "render", "export"],
  }),
  assetId: authored(NonEmptyStringSchema, "Immutable Project Asset id referenced by this Timeline item.", {
    required: false,
    editor: noControl,
    runtimeConsumers: ["asset-loader", "preview", "render"],
  }),
  sourceNodeId: authored(NonEmptyStringSchema, "Canvas node id used to resolve linked source media.", {
    required: false,
    editor: noControl,
    runtimeConsumers: ["asset-loader", "canvas-link", "render"],
  }),
  properties: authored(TimelineItemPropertiesSchema, "Static item transform: x/y are composition-center pixel offsets; width/height are unitless source-size multipliers, never output pixels.", {
    required: false,
    editor: propertiesControl,
    runtimeConsumers: ["editor", "preview", "render", "export"],
    defaultValue: { x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1 },
    appliesToItemTypes: TIMELINE_MASK_APPLIES_TO_ITEM_TYPES,
    applicabilityRuleId: "timeline.properties.item-type",
  }),
  keyframes: authored(TimelineItemKeyframesSchema, "Seek-safe item-local transform and mask keyframe channels.", {
    required: false,
    editor: propertiesControl,
    runtimeConsumers: ["editor", "preview", "render", "export"],
    appliesToItemTypes: TIMELINE_MASK_APPLIES_TO_ITEM_TYPES,
    applicabilityRuleId: "timeline.keyframes.item-type",
    applicabilityMessage: "keyframes are only valid on visual transform items",
  }),
  mask: authored(TimelineItemMaskSchema, "Resolution-independent clip-local rectangle or ellipse mask.", {
    required: false,
    editor: propertiesControl,
    runtimeConsumers: ["editor", "preview", "render", "export"],
    appliesToItemTypes: TIMELINE_MASK_APPLIES_TO_ITEM_TYPES,
    applicabilityRuleId: "timeline.clip-mask.item-type",
    applicabilityMessage: "mask is only valid on visual items",
  }),
  effects: authored(z.array(TimelineEffectInstanceRefSchema), "Ordered, version-pinned declarative clip effect stack.", {
    required: false,
    editor: propertiesControl,
    runtimeConsumers: ["effect-runtime", "preview", "render", "export"],
    defaultValue: [],
  }),
  bakedAssetPath: derived(NonEmptyStringSchema, "Rendered replacement used when an external NLE cannot reproduce an effect stack.", {
    required: false,
    editor: noControl,
    runtimeConsumers: ["export"],
  }),
  fromExpr: derived(NonEmptyStringSchema, "Opaque memo of the relative expression that produced the resolved numeric from value.", {
    required: false,
    editor: noControl,
    runtimeConsumers: ["yaml"],
  }),
} as const;

const itemTypeFields = {
  solid: {
    color: authored(CssColorSchema, "CSS fill color for the generated solid.", {
      required: true,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
    }),
  },
  text: {
    text: authored(z.string(), "Rendered plain text or synthesized caption text.", {
      required: true,
      authoredRequired: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render", "transcript"],
      defaultValue: "",
    }),
    color: authored(CssColorSchema, "Plain-text CSS color.", {
      required: true,
      authoredRequired: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: "#ffffff",
    }),
    fontSize: authored(z.number().finite().positive(), "Plain-text font size in rendered pixels.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: 60,
    }),
    fontFamily: authored(NonEmptyStringSchema, "Plain-text CSS font family.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: "Arial",
    }),
    fontWeight: authored(z.union([z.string(), FiniteNumberSchema]), "Plain-text CSS font weight.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: "bold",
    }),
    textAlign: authored(z.enum(TIMELINE_TEXT_ALIGNMENTS), "Horizontal plain-text alignment.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: "center",
    }),
    letterSpacingPx: authored(FiniteNumberSchema, "Plain-text letter spacing in rendered pixels.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: 0,
    }),
    lineHeight: authored(z.number().finite().positive(), "Unitless plain-text line-height multiplier.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: 1.1,
    }),
    cues: authored(z.array(TimelineCaptionCueSchema), "Timed caption cues for structured subtitle text.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render", "transcript", "caption-export"],
    }),
    language: authored(NonEmptyStringSchema, "BCP-47-style language hint for caption text.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["transcript", "caption-export"],
    }),
    wordRefs: authored(z.array(TimelineCaptionWordReferenceSchema), "Source-word lineage for synchronized caption edits.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["transcript", "caption-export"],
    }),
    sourceToOutputMap: authored(z.array(TimelineSourceToOutputFrameMapSchema), "Source-to-output frame lineage for structured captions.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["transcript", "caption-export"],
    }),
    style: authored(TimelineTypographyStyleSchema, "Structured-caption typography and screen position.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render", "caption-export"],
    }),
  },
  video: {
    src: authored(NonEmptyStringSchema, "Resolved local or application media source.", {
      required: true,
      authoredRequired: false,
      editor: noControl,
      runtimeConsumers: ["asset-loader", "preview", "render"],
    }),
    mediaFit: authored(TimelineMediaFitSchema, "How source pixels fit the transformed item bounds.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: "fill",
    }),
    sourceStartInFrames: authored(NonnegativeFrameSchema, "Frames skipped from the beginning of source media.", {
      required: false,
      editor: timelineControl,
      runtimeConsumers: ["preview", "render", "transcript"],
      defaultValue: 0,
    }),
    audioGainDb: authored(z.number().finite().min(-60).max(12), "Canonical clip audio gain in decibels.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render", "audio-mix"],
      defaultValue: 0,
    }),
    volume: authored(z.number().finite().nonnegative(), "Legacy linear audio gain alias.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["preview", "render", "migration"],
      deprecated: "Use audioGainDb for new writes.",
    }),
    waveform: derived(z.array(FiniteNumberSchema), "Legacy inline waveform peaks; browsers regenerate this disposable presentation cache.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["editor"],
      persistence: "discard",
    }),
    entranceAnimation: authored(TimelineClipAnimationSchema, "Seek-safe visual entrance animation.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
    }),
    exitAnimation: authored(TimelineClipAnimationSchema, "Seek-safe visual exit animation.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
    }),
    videoFadeIn: authored(NonnegativeFrameSchema, "Video fade-in duration in frames.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: 0,
    }),
    videoFadeOut: authored(NonnegativeFrameSchema, "Video fade-out duration in frames.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: 0,
    }),
    audioFadeInFrames: authored(NonnegativeFrameSchema, "Canonical audio fade-in duration in frames.", {
      required: false,
      editor: timelineControl,
      runtimeConsumers: ["preview", "render", "audio-mix"],
      defaultValue: 0,
    }),
    audioFadeOutFrames: authored(NonnegativeFrameSchema, "Canonical audio fade-out duration in frames.", {
      required: false,
      editor: timelineControl,
      runtimeConsumers: ["preview", "render", "audio-mix"],
      defaultValue: 0,
    }),
    audioFadeIn: authored(NonnegativeFrameSchema, "Legacy audio fade-in alias in frames.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["preview", "render", "migration"],
      deprecated: "Use audioFadeInFrames for new writes.",
    }),
    audioFadeOut: authored(NonnegativeFrameSchema, "Legacy audio fade-out alias in frames.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["preview", "render", "migration"],
      deprecated: "Use audioFadeOutFrames for new writes.",
    }),
    videoFadeInColor: authored(CssColorSchema, "Color faded out over the video fade-in window.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["preview", "render"],
    }),
    videoFadeOutColor: authored(CssColorSchema, "Color faded in over the video fade-out window.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["preview", "render"],
    }),
  },
  audio: {
    src: authored(NonEmptyStringSchema, "Resolved local or application audio source.", {
      required: true,
      authoredRequired: false,
      editor: noControl,
      runtimeConsumers: ["asset-loader", "preview", "render"],
    }),
    sourceStartInFrames: authored(NonnegativeFrameSchema, "Frames skipped from the beginning of source audio.", {
      required: false,
      editor: timelineControl,
      runtimeConsumers: ["preview", "render", "transcript"],
      defaultValue: 0,
    }),
    audioGainDb: authored(z.number().finite().min(-60).max(12), "Canonical clip audio gain in decibels.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render", "audio-mix"],
      defaultValue: 0,
    }),
    audioDucking: authored(TimelineAudioDuckingSchema, "Automatic music ducking amount and ramps.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render", "audio-mix"],
    }),
    volume: authored(z.number().finite().nonnegative(), "Legacy linear audio gain alias.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["preview", "render", "migration"],
      deprecated: "Use audioGainDb for new writes.",
    }),
    waveform: derived(z.array(FiniteNumberSchema), "Legacy inline waveform peaks; browsers regenerate this disposable presentation cache.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["editor"],
      persistence: "discard",
    }),
    audioFadeInFrames: authored(NonnegativeFrameSchema, "Canonical audio fade-in duration in frames.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render", "audio-mix"],
      defaultValue: 0,
    }),
    audioFadeOutFrames: authored(NonnegativeFrameSchema, "Canonical audio fade-out duration in frames.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render", "audio-mix"],
      defaultValue: 0,
    }),
    audioFadeIn: authored(NonnegativeFrameSchema, "Legacy audio fade-in alias in frames.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["preview", "render", "migration"],
      deprecated: "Use audioFadeInFrames for new writes.",
    }),
    audioFadeOut: authored(NonnegativeFrameSchema, "Legacy audio fade-out alias in frames.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["preview", "render", "migration"],
      deprecated: "Use audioFadeOutFrames for new writes.",
    }),
  },
  image: {
    src: authored(NonEmptyStringSchema, "Resolved local or application image source.", {
      required: true,
      authoredRequired: false,
      editor: noControl,
      runtimeConsumers: ["asset-loader", "preview", "render"],
    }),
    mediaFit: authored(TimelineMediaFitSchema, "How source pixels fit the transformed item bounds.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: "fill",
    }),
    imageFadeIn: authored(NonnegativeFrameSchema, "Image fade-in duration in frames.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: 0,
    }),
    imageFadeOut: authored(NonnegativeFrameSchema, "Image fade-out duration in frames.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: 0,
    }),
    imageFadeInColor: authored(CssColorSchema, "Color faded out over the image fade-in window.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
    }),
    imageFadeOutColor: authored(CssColorSchema, "Color faded in over the image fade-out window.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
    }),
  },
  sticker: {
    src: authored(NonEmptyStringSchema, "Animated image or sequence source.", {
      required: true,
      authoredRequired: false,
      editor: noControl,
      runtimeConsumers: ["asset-loader", "preview", "render"],
    }),
    mediaFit: authored(TimelineMediaFitSchema, "How sticker pixels fit the transformed item bounds.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: "contain",
    }),
    sequence: authored(TimelineSequenceSchema, "Optional still-frame sequence metadata.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["persistence", "future-renderer"],
    }),
  },
  composition: {
    compositionKind: authored(z.enum(TIMELINE_COMPOSITION_KINDS), "Composition domain label; motion-graphics must resolve a live Remotion Canvas component.", {
      required: true,
      editor: propertiesControl,
      runtimeConsumers: ["composition-runtime", "preview", "render"],
    }),
    runtime: authored(z.enum(TIMELINE_COMPOSITION_RUNTIMES), "Runtime used by the composition source.", {
      required: true,
      editor: propertiesControl,
      runtimeConsumers: ["composition-runtime", "preview", "render"],
    }),
    compositionId: authored(NonEmptyStringSchema, "Stable composition implementation id.", {
      required: true,
      editor: propertiesControl,
      runtimeConsumers: ["composition-runtime", "preview", "render"],
    }),
    sourcePath: authored(NonEmptyStringSchema, "User-owned local project path for the composition source.", {
      required: true,
      editor: noControl,
      runtimeConsumers: ["composition-runtime", "preview", "render"],
    }),
    renderedAssetPath: derived(NonEmptyStringSchema, "Host-produced rendered preview/export asset path for legacy React composition states, preserved by agents.", {
      required: false,
      editor: noControl,
      runtimeConsumers: ["preview", "render", "export"],
    }),
    spec: authored(z.record(z.unknown()), "Optional runtime configuration for legacy custom compositions; motion graphics use Canvas Remotion component source instead.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["composition-runtime", "preview", "render"],
    }),
  },
  "derived-overlay": {
    mediaType: authored(z.enum(TIMELINE_DERIVED_MEDIA_TYPES), "Media kind produced by the derivation.", {
      required: true,
      editor: noControl,
      runtimeConsumers: ["asset-loader", "preview", "render"],
    }),
    src: authored(NonEmptyStringSchema, "Immutable derived media source.", {
      required: true,
      authoredRequired: false,
      editor: noControl,
      runtimeConsumers: ["asset-loader", "preview", "render"],
    }),
    mediaFit: authored(TimelineMediaFitSchema, "How derived pixels fit the transformed item bounds.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
      defaultValue: "fill",
    }),
    sourceAssetId: authored(NonEmptyStringSchema, "Immutable lineage id of the source asset.", {
      required: true,
      editor: noControl,
      runtimeConsumers: ["asset-loader", "derivation", "export"],
    }),
    derivedAssetId: authored(NonEmptyStringSchema, "Distinct id of the derived copy-on-write asset.", {
      required: true,
      editor: noControl,
      runtimeConsumers: ["asset-loader", "derivation", "export"],
    }),
    derivation: authored(TimelineDerivedAssetSchema, "Operation and parameters that produced this immutable overlay.", {
      required: true,
      editor: noControl,
      runtimeConsumers: ["derivation", "export"],
    }),
  },
  transition: {
    transitionType: authored(z.enum(TIMELINE_TRANSITION_TYPES), "Built-in transition renderer.", {
      required: true,
      editor: propertiesControl,
      runtimeConsumers: ["preview", "render"],
    }),
    fromItemId: authored(NonEmptyStringSchema, "Id of the visual clip leaving the screen.", {
      required: true,
      editor: timelineControl,
      runtimeConsumers: ["timeline-semantics", "preview", "render"],
    }),
    toItemId: authored(NonEmptyStringSchema, "Id of the visual clip entering the screen.", {
      required: true,
      editor: timelineControl,
      runtimeConsumers: ["timeline-semantics", "preview", "render"],
    }),
    effect: authored(TimelineEffectInstanceRefSchema, "Optional SDK transition effect that supersedes the built-in renderer.", {
      required: false,
      editor: propertiesControl,
      runtimeConsumers: ["effect-runtime", "preview", "render", "export"],
    }),
  },
} as const satisfies Record<TimelineDslItemType, Record<string, TimelineDslFieldAnnotation>>;

export const TIMELINE_DSL_FIELD_ANNOTATIONS = {
  root: rootFields,
  track: trackFields,
  itemBase: itemBaseFields,
  itemTypes: itemTypeFields,
} as const;

type SerializableFieldAnnotation = Omit<TimelineDslFieldAnnotation, "schema">;

function serializableFields(
  fields: Record<string, TimelineDslFieldAnnotation>,
): Record<string, SerializableFieldAnnotation> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, annotation]) => {
      const { schema: _schema, ...serializable } = annotation;
      return [name, serializable];
    }),
  );
}

export const TIMELINE_DSL_FIELD_CATALOG = {
  version: 1,
  root: { fields: serializableFields(rootFields) },
  track: { fields: serializableFields(trackFields) },
  itemBase: { fields: serializableFields(itemBaseFields) },
  itemTypes: Object.fromEntries(
    Object.entries(itemTypeFields).map(([type, fields]) => [
      type,
      { fields: serializableFields(fields) },
    ]),
  ) as Record<TimelineDslItemType, { fields: Record<string, SerializableFieldAnnotation> }>,
} as const;
