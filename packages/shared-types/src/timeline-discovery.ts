import { TIMELINE_DSL_FIELD_CATALOG } from "./timeline-field-annotations.js";
import {
  TIMELINE_DSL_DEFINITION,
  TIMELINE_DSL_SEMANTIC_RULES,
  type TimelineDslDefinition,
} from "./timeline-dsl-schema.js";
import type { TimelineDiscoveryView } from "./timeline-discovery-contract.js";
import {
  timelineDslToYaml,
  type ResolvedTimelineDsl,
} from "./timeline-yaml.js";

type AuthoringField = Readonly<{
  description: string;
  required: boolean;
  defaultValue?: unknown;
  deprecated?: string;
  appliesToItemTypes?: readonly string[];
}>;

type SerializableField = Readonly<{
  description: string;
  authored?: boolean;
  authoredRequired?: boolean;
  persistence?: string;
  defaultValue?: unknown;
  deprecated?: string;
  appliesToItemTypes?: readonly string[];
}>;

function authoringFields(
  fields: Readonly<Record<string, SerializableField>>,
): Record<string, AuthoringField> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(
        ([, field]) =>
          field.authored !== false && field.persistence !== "discard",
      )
      .map(([name, field]) => [
        name,
        {
          description: field.description,
          required: field.authoredRequired === true,
          ...(Object.prototype.hasOwnProperty.call(field, "defaultValue")
            ? { defaultValue: field.defaultValue }
            : {}),
          ...(field.deprecated ? { deprecated: field.deprecated } : {}),
          ...(field.appliesToItemTypes
            ? { appliesToItemTypes: field.appliesToItemTypes }
            : {}),
        },
      ]),
  );
}

const baseAuthoringTrackFields = authoringFields(
  TIMELINE_DSL_FIELD_CATALOG.track.fields,
);

const authoringTrackFields = {
  ...baseAuthoringTrackFields,
  role: {
    ...baseAuthoringTrackFields.role,
    description:
      "Semantic purpose of the track. Use subtitle only for structured captions: each text item requires non-empty cues, wordRefs, and sourceToOutputMap. For a plain title, omit role.",
  },
  category: {
    ...baseAuthoringTrackFields.category,
    description:
      "Structural lane category controlling order and allowed item types. Track categories must follow the canonical effect, text, visual, primary, audio order; supplied order is preserved and never automatically sorted.",
  },
} satisfies Record<string, AuthoringField>;

const basicAuthoringState: ResolvedTimelineDsl = {
  compositionWidth: 1080,
  compositionHeight: 1080,
  fps: 30,
  durationInFrames: 180,
  tracks: [
    {
      id: "titles",
      name: "Titles",
      category: "text",
      items: [
        {
          id: "title",
          type: "text",
          from: 0,
          durationInFrames: 60,
          text: "Opening title",
          color: "#ffffff",
        },
      ],
    },
    {
      id: "visuals",
      name: "Visuals",
      category: "visual",
      items: [
        {
          id: "still",
          type: "image",
          from: 0,
          durationInFrames: 90,
          assetId: "project-asset-id",
        },
        {
          id: "motion",
          type: "composition",
          from: 90,
          durationInFrames: 90,
          runtime: "remotion",
          compositionKind: "custom",
          compositionId: "mascot",
          sourceNodeId: "canvas-component-node-id",
          sourcePath: "components/mascot.tsx",
        },
      ],
    },
  ],
};

// Built on first use: it reads the DSL contract fingerprint and renders YAML,
// which is too much CPU to spend at module load (Worker startup budget).
function buildAuthoringDiscovery() {
  return {
    view: "authoring",
    schemaVersion: TIMELINE_DSL_DEFINITION.schemaVersion,
    contractFingerprint: TIMELINE_DSL_DEFINITION.contractFingerprint,
    format: TIMELINE_DSL_DEFINITION.format,
    fields: {
      version: TIMELINE_DSL_FIELD_CATALOG.version,
      root: authoringFields(TIMELINE_DSL_FIELD_CATALOG.root.fields),
      track: authoringTrackFields,
      itemBase: authoringFields(TIMELINE_DSL_FIELD_CATALOG.itemBase.fields),
      itemTypes: Object.fromEntries(
        Object.entries(TIMELINE_DSL_FIELD_CATALOG.itemTypes).map(
          ([itemType, descriptor]) => [
            itemType,
            authoringFields(descriptor.fields),
          ],
        ),
      ),
    },
    taxonomy: {
      itemTypes: TIMELINE_DSL_DEFINITION.taxonomy.itemTypes,
      trackCategoryOrder: TIMELINE_DSL_DEFINITION.taxonomy.trackCategories,
      trackRoles: TIMELINE_DSL_DEFINITION.taxonomy.trackRoles,
      categoryAllowedItemTypes:
        TIMELINE_DSL_DEFINITION.taxonomy.categoryAllowedItemTypes,
      roleAllowedItemTypes:
        TIMELINE_DSL_DEFINITION.taxonomy.roleAllowedItemTypes,
      roleCategories: TIMELINE_DSL_DEFINITION.taxonomy.roleCategories,
      mediaFits: TIMELINE_DSL_DEFINITION.taxonomy.mediaFits,
      clipAnimationTypes: TIMELINE_DSL_DEFINITION.taxonomy.clipAnimationTypes,
      textAlignments: TIMELINE_DSL_DEFINITION.taxonomy.textAlignments,
      captionPositions: TIMELINE_DSL_DEFINITION.taxonomy.captionPositions,
      compositionKinds: TIMELINE_DSL_DEFINITION.taxonomy.compositionKinds,
      compositionRuntimes: TIMELINE_DSL_DEFINITION.taxonomy.compositionRuntimes,
      derivedMediaTypes: TIMELINE_DSL_DEFINITION.taxonomy.derivedMediaTypes,
      derivationKinds: TIMELINE_DSL_DEFINITION.taxonomy.derivationKinds,
      transitionTypes: TIMELINE_DSL_DEFINITION.taxonomy.transitionTypes,
    },
    semanticRules: TIMELINE_DSL_SEMANTIC_RULES,
    references: {
      assetId: {
        target: "project-asset",
        description:
          "For a Stage capture, follow Stage revision -> capture receipt -> immutable Project Asset -> downstream Timeline item.assetId. The producer Stage or Action is not mutated.",
      },
      sourceNodeId: {
        target: "canvas-node",
        description:
          "Reference a Canvas-owned Remotion component through Timeline item.sourceNodeId; resolve it for rendering without copying component source into persisted Timeline state.",
      },
    },
    examples: {
      basic: {
        description:
          "Plain text, a Project Asset image, and a Canvas-owned Remotion component in canonical track order.",
        state: basicAuthoringState,
        yaml: timelineDslToYaml(basicAuthoringState),
      },
    },
    submission: {
      validation: "automatic",
      operations: ["timeline.create", "timeline.save", "timeline.apply"],
      diagnosticOperation: "timeline.validate",
      diagnosticRequired: false,
    },
    nextView: "full",
  } as const;
}

let authoringDiscoveryCache:
  ReturnType<typeof buildAuthoringDiscovery> | undefined;

export type TimelineAuthoringDiscovery = ReturnType<
  typeof buildAuthoringDiscovery
>;
export type TimelineDiscovery =
  TimelineAuthoringDiscovery | TimelineDslDefinition;

export function timelineDslDiscovery(
  view: TimelineDiscoveryView = "authoring",
): TimelineDiscovery {
  if (view === "full") {
    return structuredClone(TIMELINE_DSL_DEFINITION);
  }
  if (view !== "authoring") {
    throw new Error(`Unsupported Timeline discovery view: ${String(view)}`);
  }
  authoringDiscoveryCache ??= buildAuthoringDiscovery();
  return structuredClone(authoringDiscoveryCache);
}
