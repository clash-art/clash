import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  TIMELINE_KEYFRAME_CHANNELS,
  TimelineItemKeyframesSchema,
  timelineKeyframeFrameIssues,
  type TimelineItemKeyframes,
} from "./timeline-keyframes.js";
import {
  TIMELINE_MASK_ANIMATION_BINDINGS,
  TIMELINE_MASK_CAPABILITY_ANNOTATION,
  TIMELINE_MASK_FIELD_ANNOTATIONS,
  TIMELINE_MASK_KEYFRAME_CHANNELS,
  TimelineItemMaskSchema,
} from "./timeline-mask.js";
import {
  TIMELINE_DSL_FIELD_ANNOTATIONS,
  TIMELINE_DSL_FIELD_CATALOG,
  TIMELINE_DSL_CATEGORY_ALLOWED_ITEM_TYPES,
  TIMELINE_DSL_ITEM_TYPES,
  TIMELINE_DSL_ROLE_ALLOWED_ITEM_TYPES,
  TIMELINE_DSL_ROLE_CATEGORIES,
  TIMELINE_DSL_RUNTIME_CONSUMERS,
  TIMELINE_DSL_TRACK_CATEGORIES,
  TIMELINE_DSL_TRACK_ROLES,
  TIMELINE_MEDIA_FITS,
  TIMELINE_ITEM_TRANSFORM_SEMANTICS,
  TIMELINE_CLIP_ANIMATION_TYPES,
  TIMELINE_TEXT_ALIGNMENTS,
  TIMELINE_CAPTION_POSITIONS,
  TIMELINE_COMPOSITION_KINDS,
  TIMELINE_COMPOSITION_RUNTIMES,
  TIMELINE_DERIVED_MEDIA_TYPES,
  TIMELINE_DERIVATION_KINDS,
  TIMELINE_TRANSITION_TYPES,
  timelineDslAnnotatedObjectShape,
  type TimelineDslItemType,
} from "./timeline-field-annotations.js";
import {
  TIMELINE_DSL_GLOBAL_SEMANTIC_RULES,
  timelineDslSemanticIssues,
} from "./timeline-dsl-semantics.js";
import { TIMELINE_OPERATION_CATALOG } from "./timeline-operation-annotations.js";

export {
  TIMELINE_DSL_ITEM_TYPES,
  TIMELINE_DSL_TRACK_CATEGORIES,
} from "./timeline-field-annotations.js";

const itemVariantSchemas = TIMELINE_DSL_ITEM_TYPES.map((type) => {
  const baseShape = timelineDslAnnotatedObjectShape(
    TIMELINE_DSL_FIELD_ANNOTATIONS.itemBase,
    {
      overrides: {
        type: z
          .literal(type)
          .describe(TIMELINE_DSL_FIELD_ANNOTATIONS.itemBase.type.description),
      },
    },
  );
  const variantShape = timelineDslAnnotatedObjectShape(
    TIMELINE_DSL_FIELD_ANNOTATIONS.itemTypes[type],
  );
  return z.object({ ...baseShape, ...variantShape }).passthrough();
});

const TimelineDslItemVariantSchema = z.discriminatedUnion(
  "type",
  itemVariantSchemas as unknown as [
    z.ZodDiscriminatedUnionOption<"type">,
    ...z.ZodDiscriminatedUnionOption<"type">[],
  ],
);

const itemFieldOwners = new Map<string, Set<TimelineDslItemType>>();
for (const type of TIMELINE_DSL_ITEM_TYPES) {
  for (const fieldName of Object.keys(
    TIMELINE_DSL_FIELD_ANNOTATIONS.itemTypes[type],
  )) {
    const owners =
      itemFieldOwners.get(fieldName) ?? new Set<TimelineDslItemType>();
    owners.add(type);
    itemFieldOwners.set(fieldName, owners);
  }
}

const maskKeyframeChannels = new Set<string>(TIMELINE_MASK_KEYFRAME_CHANNELS);
const itemBaseFieldApplicabilityRules = Object.entries(
  TIMELINE_DSL_FIELD_ANNOTATIONS.itemBase,
).flatMap(([fieldName, annotation]) =>
  annotation.appliesToItemTypes && annotation.applicabilityRuleId
    ? [
        {
          id: annotation.applicabilityRuleId,
          kind: "allowed-item-types-when-present" as const,
          objectPath: "tracks[].items[]" as const,
          field: fieldName,
          allowedItemTypes: annotation.appliesToItemTypes,
          ...(annotation.applicabilityMessage
            ? { message: annotation.applicabilityMessage }
            : {}),
        },
      ]
    : [],
);

const clipMaskRequiresMaskRule = {
  id: "timeline.clip-mask.requires-mask",
  kind: "requires-field-when-any-channel-present",
  objectPath: "tracks[].items[]",
  channelContainer: "keyframes",
  channels: TIMELINE_MASK_KEYFRAME_CHANNELS,
  requiredField: "mask",
} as const;
const timelineKeyframeRangeRule = {
  id: "timeline.keyframes.frame-range",
  kind: "frame-range-by-owner-duration",
  objectPath: "tracks[].items[]",
  channelContainer: "keyframes",
  channels: TIMELINE_KEYFRAME_CHANNELS,
  key: "frame",
  minimum: 0,
  exclusiveMaximumPath: "durationInFrames",
} as const;
const timelineRetiredAssetFieldRule = {
  id: "timeline.asset.retired-field",
  kind: "forbidden-paths",
  paths: ["mediaAssetRefs", "tracks[].items[].backingAssetId"],
} as const;
const timelineKeyframeUniqueFrameRule = {
  id: "timeline.keyframes.unique-frame",
  kind: "unique-key-by-channel",
  objectPath: "tracks[].items[]",
  channelContainer: "keyframes",
  channels: TIMELINE_KEYFRAME_CHANNELS,
  key: "frame",
} as const;
const timelineItemFieldApplicabilityRule = {
  id: "timeline.item.field-applicability",
  kind: "field-applicability-by-discriminator",
  objectPath: "tracks[].items[]",
  discriminator: "type",
  registry: "fieldCatalog.itemTypes",
} as const;

/** Serializable semantic rules that supplement standard JSON Schema. */
export const TIMELINE_DSL_SEMANTIC_RULES = {
  version: 2,
  rules: [
    ...itemBaseFieldApplicabilityRules,
    clipMaskRequiresMaskRule,
    timelineKeyframeRangeRule,
    timelineKeyframeUniqueFrameRule,
    timelineItemFieldApplicabilityRule,
    timelineRetiredAssetFieldRule,
    ...TIMELINE_DSL_GLOBAL_SEMANTIC_RULES,
  ],
} as const;

function hasMaskKeyframes(
  keyframes: TimelineItemKeyframes | undefined,
): boolean {
  return Object.keys(keyframes ?? {}).some((channel) =>
    maskKeyframeChannels.has(channel),
  );
}

export type TimelineMaskKeyframeSemanticIssue = {
  ruleId: (typeof TIMELINE_DSL_SEMANTIC_RULES.rules)[number]["id"];
  path: (string | number)[];
  message: string;
};

export function timelineMaskKeyframeSemanticIssues(item: {
  type: string;
  durationInFrames: number;
  [key: string]: unknown;
  mask?: unknown;
  keyframes?: TimelineItemKeyframes;
}): TimelineMaskKeyframeSemanticIssue[] {
  const issues: TimelineMaskKeyframeSemanticIssue[] = [];
  for (const rule of itemBaseFieldApplicabilityRules) {
    if (
      Object.prototype.hasOwnProperty.call(item, rule.field) &&
      item[rule.field] !== undefined &&
      !(rule.allowedItemTypes as readonly string[]).includes(item.type)
    ) {
      issues.push({
        ruleId: rule.id,
        path: [rule.field],
        message:
          rule.message ??
          `${rule.field} is only valid on ${rule.allowedItemTypes.join(", ")} items`,
      });
    }
  }
  if (!item.mask && hasMaskKeyframes(item.keyframes)) {
    issues.push({
      ruleId: clipMaskRequiresMaskRule.id,
      path: ["keyframes"],
      message: "mask keyframes require a mask",
    });
  }
  for (const frameIssue of timelineKeyframeFrameIssues(
    item.keyframes,
    item.durationInFrames,
  )) {
    issues.push({
      ruleId:
        frameIssue.reason === "duplicate"
          ? timelineKeyframeUniqueFrameRule.id
          : timelineKeyframeRangeRule.id,
      path: ["keyframes", frameIssue.channel, frameIssue.index, "frame"],
      message:
        frameIssue.reason === "duplicate"
          ? `duplicate keyframe at item-local frame ${frameIssue.frame}`
          : `item-local frame must be between 0 and ${item.durationInFrames - 1}`,
    });
  }
  return issues;
}

export const TimelineDslItemSchema = TimelineDslItemVariantSchema.superRefine(
  (item, ctx) => {
    const typedItem = item as Record<string, unknown> & {
      type: TimelineDslItemType;
      durationInFrames: number;
      mask?: unknown;
      keyframes?: TimelineItemKeyframes;
    };
    if (Object.prototype.hasOwnProperty.call(typedItem, "backingAssetId")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["backingAssetId"],
        message: "backingAssetId was removed; use the item's Project Asset id",
        params: { ruleId: timelineRetiredAssetFieldRule.id },
      });
    }
    for (const [fieldName, owners] of itemFieldOwners) {
      if (
        Object.prototype.hasOwnProperty.call(typedItem, fieldName) &&
        !owners.has(typedItem.type)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [fieldName],
          message: `${fieldName} is not valid on ${typedItem.type} items`,
          params: { ruleId: timelineItemFieldApplicabilityRule.id },
        });
      }
    }
    for (const issue of timelineMaskKeyframeSemanticIssues(typedItem)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issue.path,
        message: issue.message,
        params: { ruleId: issue.ruleId },
      });
    }
  },
).describe("TimelineDslItem");

export const TimelineDslTrackSchema = z
  .object(
    timelineDslAnnotatedObjectShape(TIMELINE_DSL_FIELD_ANNOTATIONS.track, {
      overrides: { items: z.array(TimelineDslItemSchema) },
    }),
  )
  .passthrough()
  .describe("TimelineDslTrack");

const TimelineDslSchemaBase = z
  .object(
    timelineDslAnnotatedObjectShape(TIMELINE_DSL_FIELD_ANNOTATIONS.root, {
      overrides: { tracks: z.array(TimelineDslTrackSchema) },
    }),
  )
  .passthrough();

export const TimelineDslSchema = TimelineDslSchemaBase.superRefine(
  (timeline, context) => {
    if (Object.prototype.hasOwnProperty.call(timeline, "mediaAssetRefs")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mediaAssetRefs"],
        message:
          "mediaAssetRefs was removed; Timeline items bind Project Assets directly",
        params: { ruleId: timelineRetiredAssetFieldRule.id },
      });
    }
    for (const semanticIssue of timelineDslSemanticIssues(timeline)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: semanticIssue.path,
        message: semanticIssue.message,
        params: { ruleId: semanticIssue.ruleId },
      });
    }
  },
).describe("TimelineDsl");

export type TimelineDslValidationIssue = {
  ruleId: string;
  code: z.ZodIssueCode;
  path: (string | number)[];
  message: string;
};

export type TimelineDslValidationResult =
  | { ok: true; value: z.output<typeof TimelineDslSchema> }
  | { ok: false; issues: TimelineDslValidationIssue[] };

/** Execute the published base plus mask/keyframe contract before legacy YAML semantics. */
export function validateTimelineDsl(
  state: unknown,
): TimelineDslValidationResult {
  const parsed = TimelineDslSchema.safeParse(state);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      ruleId:
        issue.code === z.ZodIssueCode.custom &&
        typeof issue.params?.ruleId === "string"
          ? issue.params.ruleId
          : "timeline.dsl.structure",
      code: issue.code,
      path: [...issue.path],
      message: issue.message,
    })),
  };
}

const timelineDslJsonSchema = zodToJsonSchema(TimelineDslSchema, {
  name: "TimelineDsl",
  target: "jsonSchema7",
});
const timelineItemMaskJsonSchema = zodToJsonSchema(TimelineItemMaskSchema, {
  name: "TimelineItemMask",
  target: "jsonSchema7",
});
const timelineItemKeyframesJsonSchema = zodToJsonSchema(
  TimelineItemKeyframesSchema,
  {
    name: "TimelineItemKeyframes",
    target: "jsonSchema7",
  },
);

type JsonSchemaObject = Record<string, unknown>;

function jsonSchemaObject(value: unknown, label: string): JsonSchemaObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Timeline DSL JSON Schema is missing ${label}`);
  }
  return value as JsonSchemaObject;
}

function jsonSchemaObjectAtPath(
  root: unknown,
  path: readonly string[],
): JsonSchemaObject {
  let current = root;
  for (const segment of path) {
    current = jsonSchemaObject(current, path.join("."))[segment];
  }
  return jsonSchemaObject(current, path.join("."));
}

const timelineDslJsonSchemaDefinitions = jsonSchemaObjectAtPath(
  timelineDslJsonSchema,
  ["definitions"],
);
timelineDslJsonSchemaDefinitions.TimelineItemMask = jsonSchemaObjectAtPath(
  timelineItemMaskJsonSchema,
  ["definitions", "TimelineItemMask"],
);
timelineDslJsonSchemaDefinitions.TimelineItemKeyframes = jsonSchemaObjectAtPath(
  timelineItemKeyframesJsonSchema,
  ["definitions", "TimelineItemKeyframes"],
);

const timelineDslItemJsonSchema = jsonSchemaObjectAtPath(
  timelineDslJsonSchema,
  [
    "definitions",
    "TimelineDsl",
    "properties",
    "tracks",
    "items",
    "properties",
    "items",
    "items",
  ],
);
timelineDslItemJsonSchema.allOf = [
  ...itemBaseFieldApplicabilityRules.map((rule) => ({
    if: { required: [rule.field] },
    then: {
      properties: {
        type: { enum: [...rule.allowedItemTypes] },
      },
    },
  })),
  {
    if: {
      required: [clipMaskRequiresMaskRule.channelContainer],
      properties: {
        [clipMaskRequiresMaskRule.channelContainer]: {
          anyOf: clipMaskRequiresMaskRule.channels.map((channel) => ({
            required: [channel],
          })),
        },
      },
    },
    then: { required: [clipMaskRequiresMaskRule.requiredField] },
  },
];

const timelineDslJsonSchemaFragments = {
  TimelineItemMask: timelineItemMaskJsonSchema,
  TimelineItemKeyframes: timelineItemKeyframesJsonSchema,
} as const;

const timelineMaskExample = Object.fromEntries(
  Object.entries(TIMELINE_MASK_FIELD_ANNOTATIONS).map(([field, annotation]) => [
    field,
    "exampleValue" in annotation
      ? annotation.exampleValue
      : annotation.defaultValue,
  ]),
);

const timelineMaskKeyframesExample = Object.fromEntries(
  TIMELINE_MASK_ANIMATION_BINDINGS.map((binding, bindingIndex) => [
    binding.channel,
    [
      { frame: 0, value: binding.exampleValues[0], interpolation: "linear" },
      {
        frame: 59,
        value: binding.exampleValues[1],
        interpolation: bindingIndex === 0 ? "hold" : "linear",
      },
    ],
  ]),
);

export const TIMELINE_MASK_KEYFRAMES_DSL_EXAMPLE = {
  compositionWidth: 1920,
  compositionHeight: 1080,
  fps: 30,
  durationInFrames: 60,
  tracks: [
    {
      id: "visual-overlays",
      name: "Visual overlays",
      category: "visual",
      items: [
        {
          id: "masked-image",
          type: "image",
          from: 0,
          durationInFrames: 60,
          sourceNodeId: "source-image-node",
          mask: timelineMaskExample,
          keyframes: timelineMaskKeyframesExample,
        },
      ],
    },
  ],
} as const;

const timelineMaskDslFeature = {
  yamlPath: TIMELINE_MASK_CAPABILITY_ANNOTATION.yamlPath,
  appliesToItemTypes: TIMELINE_MASK_CAPABILITY_ANNOTATION.appliesToItemTypes,
  excludedItemTypes: TIMELINE_MASK_CAPABILITY_ANNOTATION.excludedItemTypes,
  staticFields: TIMELINE_MASK_CAPABILITY_ANNOTATION.staticFields,
  animatedChannels: TIMELINE_MASK_CAPABILITY_ANNOTATION.animatedChannels,
  defaultMask: TIMELINE_MASK_CAPABILITY_ANNOTATION.defaultMask,
  fieldDefinitions: Object.fromEntries(
    Object.entries(TIMELINE_MASK_FIELD_ANNOTATIONS).map(
      ([field, annotation]) => [
        field,
        {
          description: annotation.description,
          invalidValueDescription: annotation.invalidValueDescription,
          unit: annotation.unit,
          defaultValue: annotation.defaultValue,
          animatedChannel:
            "animation" in annotation
              ? (annotation.animation?.channel ?? null)
              : null,
        },
      ],
    ),
  ),
  operations: TIMELINE_MASK_CAPABILITY_ANNOTATION.operations,
  runtimeBehavior: TIMELINE_MASK_CAPABILITY_ANNOTATION.runtimeBehavior,
  semantics: TIMELINE_MASK_CAPABILITY_ANNOTATION.semantics,
} as const;

function canonicalTimelineDslContractJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalTimelineDslContractJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalTimelineDslContractJson(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function timelineDslContractFingerprint(value: unknown): string {
  const canonical = canonicalTimelineDslContractJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

const timelineDslSerializableDefinition = {
  schemaVersion: 14,
  format: "clash.timeline.yaml",
  description:
    "Agent-facing Timeline YAML DSL. Pull before editing and apply with the matching read proof.",
  fieldCatalog: TIMELINE_DSL_FIELD_CATALOG,
  operationCatalog: TIMELINE_OPERATION_CATALOG,
  taxonomy: {
    itemTypes: TIMELINE_DSL_ITEM_TYPES,
    trackCategories: TIMELINE_DSL_TRACK_CATEGORIES,
    trackRoles: TIMELINE_DSL_TRACK_ROLES,
    categoryAllowedItemTypes: TIMELINE_DSL_CATEGORY_ALLOWED_ITEM_TYPES,
    roleAllowedItemTypes: TIMELINE_DSL_ROLE_ALLOWED_ITEM_TYPES,
    roleCategories: TIMELINE_DSL_ROLE_CATEGORIES,
    runtimeConsumers: TIMELINE_DSL_RUNTIME_CONSUMERS,
    mediaFits: TIMELINE_MEDIA_FITS,
    clipAnimationTypes: TIMELINE_CLIP_ANIMATION_TYPES,
    textAlignments: TIMELINE_TEXT_ALIGNMENTS,
    captionPositions: TIMELINE_CAPTION_POSITIONS,
    compositionKinds: TIMELINE_COMPOSITION_KINDS,
    compositionRuntimes: TIMELINE_COMPOSITION_RUNTIMES,
    derivedMediaTypes: TIMELINE_DERIVED_MEDIA_TYPES,
    derivationKinds: TIMELINE_DERIVATION_KINDS,
    transitionTypes: TIMELINE_TRANSITION_TYPES,
  },
  validation: {
    structuralContract: "jsonSchema",
    semanticContract: "jsonSchema.x-clash-semantic-rules",
    typescriptFunction: "validateTimelineDsl(state)",
    cliCommand: "clash timeline validate --file <path> --json",
    mcpTool: "clash_timeline_validate",
  },
  jsonSchema: {
    ...timelineDslJsonSchema,
    "x-clash-fragments": timelineDslJsonSchemaFragments,
    "x-clash-features": {
      clipMask: timelineMaskDslFeature,
      itemTransform: TIMELINE_ITEM_TRANSFORM_SEMANTICS,
    },
    "x-clash-semantic-rules": TIMELINE_DSL_SEMANTIC_RULES,
  },
  features: {
    clipMask: timelineMaskDslFeature,
    itemTransform: TIMELINE_ITEM_TRANSFORM_SEMANTICS,
  },
  examples: {
    maskKeyframes: TIMELINE_MASK_KEYFRAMES_DSL_EXAMPLE,
  },
} as const;

export const TIMELINE_DSL_DEFINITION = {
  ...timelineDslSerializableDefinition,
  contractFingerprint: timelineDslContractFingerprint(
    timelineDslSerializableDefinition,
  ),
} as const;

export type TimelineDslDefinition = typeof TIMELINE_DSL_DEFINITION;
