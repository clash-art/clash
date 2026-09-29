import { TIMELINE_DSL_DEFINITION } from "./timeline-dsl-schema.js";
import {
  timelineDslToYaml,
  type ResolvedTimelineDsl,
} from "./timeline-yaml.js";

type MaskFieldDefinition = {
  description: string;
  invalidValueDescription: string;
  unit: string;
  defaultValue: unknown;
  animatedChannel: string | null;
};

type CatalogFieldDefinition = {
  description: string;
  authored: boolean;
  required: boolean;
  authoredRequired: boolean;
  editor: { surface: string; control?: string };
  runtimeConsumers: readonly string[];
  persistence?: "discard";
  appliesToItemTypes?: readonly string[];
  deprecated?: string;
  defaultValue?: unknown;
};

type CatalogOperationDefinition = {
  access: "read" | "write";
  agentCallable: boolean;
  cas: "none" | "host-enforced";
  readProof: "none" | "records-observation" | "requires-observation";
  preconditions: readonly string[];
  runtimeConsumers: readonly string[];
  surfaceBindings?: readonly string[];
  description: string;
};

function inlineJson(value: unknown): string {
  return JSON.stringify(value);
}

function words(value: string): string {
  return value.replace(/-/g, " ");
}

function samplingVerb(value: string): string {
  return value.startsWith("use-")
    ? `uses the ${words(value.slice(4))}`
    : words(value);
}

function catalogFieldRows(
  fields: Record<string, CatalogFieldDefinition>,
): string {
  return Object.entries(fields)
    .map(([name, definition]) => {
      const authorship =
        definition.persistence === "discard"
          ? "discard / device cache"
          : definition.authored
            ? "editable"
            : "preserve / derived";
      const required = `${definition.authoredRequired ? "authored" : "optional"} / ${definition.required ? "runtime" : "optional"}`;
      const defaultValue = Object.prototype.hasOwnProperty.call(
        definition,
        "defaultValue",
      )
        ? `\`${inlineJson(definition.defaultValue)}\``
        : "—";
      const editor = definition.editor.control
        ? `${definition.editor.surface} (${definition.editor.control})`
        : definition.editor.surface;
      const deprecation = definition.deprecated
        ? ` Deprecated: ${definition.deprecated}`
        : "";
      const applicability =
        definition.appliesToItemTypes?.join(", ") ?? "all declared owners";
      return `| \`${name}\` | ${required} | ${authorship} | ${defaultValue} | ${editor} | ${applicability} | ${definition.runtimeConsumers.join(", ")} | ${definition.description}${deprecation} |`;
    })
    .join("\n");
}

function catalogSection(
  title: string,
  fields: Record<string, CatalogFieldDefinition>,
): string {
  return `### ${title}

| Field | Required (authored / runtime) | Projection policy | Consumer fallback | Editor routing | Applies to | Runtime consumers | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
${catalogFieldRows(fields)}`;
}

function operationCatalogSection(
  title: string,
  operations: Record<string, CatalogOperationDefinition>,
): string {
  const rows = Object.entries(operations).map(
    ([id, operation]) =>
      `| \`${id}\` | ${operation.agentCallable ? "yes" : "no"} | ${operation.access} | ${operation.cas} | ${operation.readProof} | ${(operation.surfaceBindings ?? []).join(", ") || "internal"} | ${operation.runtimeConsumers.join(", ")} | ${operation.description} Preconditions: ${operation.preconditions.join(" ")} |`,
  );
  return `### ${title}

| Operation | Agent-callable | Access | CAS | Read proof | Public bindings | Runtime consumers | Meaning and preconditions |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}`;
}

/** Generated JavaDoc-like reference for the implementation-side descriptor. */
export function renderTimelineDslMarkdown(): string {
  const feature = TIMELINE_DSL_DEFINITION.features.clipMask;
  const fields = feature.fieldDefinitions as Record<
    string,
    MaskFieldDefinition
  >;
  const fieldRows = Object.entries(fields).map(
    ([field, definition]) =>
      `| \`${field}\` | \`${definition.unit}\` | ${inlineJson(definition.defaultValue)} | ${definition.animatedChannel ? `\`${definition.animatedChannel}\`` : "static"} | ${definition.invalidValueDescription} | ${definition.description} |`,
  );
  const channelLines = Object.entries(fields)
    .filter(([, definition]) => definition.animatedChannel)
    .map(
      ([field, definition]) =>
        `- \`${definition.animatedChannel}\` animates \`mask.${field}\`.`,
    );
  const operationLines = Object.entries(feature.operations).map(
    ([operation, description]) => `- \`${operation}\`: ${description}.`,
  );
  const runtimeLines = Object.entries(feature.runtimeBehavior).map(
    ([behavior, value]) =>
      `- \`${behavior}\`: ${typeof value === "boolean" ? String(value) : words(value)}.`,
  );
  const semantics = feature.semantics;
  const catalog = TIMELINE_DSL_DEFINITION.fieldCatalog;
  const catalogSections = [
    catalogSection(
      "Root",
      catalog.root.fields as Record<string, CatalogFieldDefinition>,
    ),
    catalogSection(
      "Track",
      catalog.track.fields as Record<string, CatalogFieldDefinition>,
    ),
    catalogSection(
      "Common item fields",
      catalog.itemBase.fields as Record<string, CatalogFieldDefinition>,
    ),
    ...Object.entries(catalog.itemTypes).map(([itemType, descriptor]) =>
      catalogSection(
        `\`${itemType}\` item fields`,
        descriptor.fields as Record<string, CatalogFieldDefinition>,
      ),
    ),
  ];
  const operationCatalog = TIMELINE_DSL_DEFINITION.operationCatalog;
  const operationCatalogSections = [
    operationCatalogSection(
      "Agent, entity, and projection operations",
      operationCatalog.agent as Record<string, CatalogOperationDefinition>,
    ),
    operationCatalogSection(
      "Semantic editor commands",
      operationCatalog.editorCommands as Record<
        string,
        CatalogOperationDefinition
      >,
    ),
    operationCatalogSection(
      "Editor dispatch actions",
      operationCatalog.editorActions as Record<
        string,
        CatalogOperationDefinition
      >,
    ),
  ];

  return `<!-- GENERATED by @clash/shared-types generate:timeline-dsl-docs. Do not hand-edit. -->
# Timeline YAML DSL

Timeline YAML is the canonical agent-editable projection of a Project Timeline.
Discover the current version through \`clash_timeline_schema\` or
\`clash timeline schema --json\`. Both surfaces are generated from the same
implementation-side capability annotations as validation, documentation,
agent operations, and routing metadata. Complex UI controls and renderer behavior remain
explicit adapters, with compile-time/test coverage gates against descriptor
drift.

The current release is schema version \`${TIMELINE_DSL_DEFINITION.schemaVersion}\`
with fingerprint \`${TIMELINE_DSL_DEFINITION.contractFingerprint}\`. Version 14
documents compact Timeline list reads and atomic shared-boundary roll edits.
Authored Timeline YAML remains compatible. Version 13
clarifies that create, save, and apply validate automatically before mutation
and reserves the explicit validator for diagnostic-only workflows where no
write is intended. Version 12 adds compact reference-based authoring discovery
while preserving the complete machine contract behind the full view. Version 11 marks legacy inline waveform
samples as discard-on-save device presentation;
browsers regenerate them instead of synchronizing them. Version 10 narrowed the
public \`timeline.render\` receipt to a strict Project Asset reference
\`asset: { id }\`. Clients migrating from version 9 must resolve that Project Asset
through the Asset SDK; transient delivery URLs and storage keys are not Timeline
receipt fields.

Timeline media fields are downstream references, not producer state. A Stage
capture follows Stage revision → capture receipt → immutable Project Asset →
downstream Timeline \`assetId\`; it never writes the output into the producer
Stage or Action state. Custom Remotion items similarly keep \`sourceNodeId\` as
a reference to the Canvas-owned component instead of copying component source
into persisted Timeline state.

Create, save, or apply directly; each write validates before mutation and an
invalid submission leaves product state unchanged. For diagnostic-only work
where no write is intended, use \`${TIMELINE_DSL_DEFINITION.validation.cliCommand}\`
or \`${TIMELINE_DSL_DEFINITION.validation.mcpTool}\` without mutation. Do not use
the explicit validator as a write preflight. Standard JSON Schema handles the
structural contract and portable applicability rules; generated
\`x-clash-semantic-rules\` plus the executable validator cover owner-duration
frame bounds and per-channel frame uniqueness.

Use the read-proof workflow for every mutation:

1. Read with \`clash_timeline_get\`, or pull with \`clash timeline pull\`.
2. For typed saves, pass the returned \`revisionId\` as \`baseRevisionId\`.
3. Edit the complete state or YAML projection.
4. Save/apply. A stale revision is rejected; reread and rebase the intended edit.

## Complete field catalog

The tables below are generated from the same executable field descriptors as
the discriminated Zod/JSON Schema. “Preserve / derived” fields are not normal
authoring controls, but a full-state apply must round-trip them unchanged.
“Discard / device cache” fields remain readable only for migration/runtime
presentation and are removed by Project persistence.
“Consumer fallback” documents the value used by editor/preview/render when an
authored optional field is absent; parsing does not silently materialize it.

${catalogSections.join("\n\n")}

## Complete operation catalog

These tables and each operation's machine-readable input/output JSON Schema
are generated from the executable operation registry embedded in
\`TIMELINE_DSL_DEFINITION.operationCatalog\`.

${operationCatalogSections.join("\n\n")}

## Clip masks

Masks apply to ${feature.appliesToItemTypes.map((type) => `\`${type}\``).join(", ")}.
They are rejected on ${feature.excludedItemTypes.map((type) => `\`${type}\``).join(" and ")}.
All ${Object.keys(fields).length} \`item.mask\` fields are required when the mask exists.

| Field | Unit / domain | Editor default | Animation | Constraint | Meaning |
| --- | --- | --- | --- | --- | --- |
${fieldRows.join("\n")}

The complete editor default is \`${inlineJson(feature.defaultMask)}\`.
Positive rotation is ${semantics.positiveRotation}. Feather uses
\`${semantics.featherModel}\`.

## Mask keyframes

${channelLines.join("\n")}

Every key is \`{ frame, value, interpolation }\`. Frames use
\`${semantics.frameSpace}\` coordinates and the valid range is
\`${semantics.validFrameRange}\`. Duplicate frames are ${words(semantics.duplicateFrames)}.
Interpolation is ${semantics.interpolation.map((value) => `\`${value}\``).join(" or ")}
and belongs to the ${words(semantics.interpolationOwner)}. New editor keys use
\`${semantics.defaultNewKeyframeInterpolation}\`. Before the first key the sampler
${samplingVerb(semantics.beforeFirstKeyframe)}; after the last it
${samplingVerb(semantics.afterLastKeyframe)}. An absent or empty channel uses the
${words(semantics.emptyChannelFallback)}. Store keys in ascending frame order;
the runtime also sorts defensively.

${semantics.staticOnlyFields.map((field) => `\`${field}\``).join(" and ")} are static only. Any mask keyframe channel requires
the complete static \`item.mask\` fallback.

## Declarative operations

${operationLines.join("\n")}

## Derived runtime behavior

${runtimeLines.join("\n")}

The parser-verified example is generated at
[\`examples/mask-keyframes.timeline.yaml\`](./examples/mask-keyframes.timeline.yaml).
`;
}

export function renderTimelineMaskKeyframesExampleYaml(): string {
  return timelineDslToYaml(
    TIMELINE_DSL_DEFINITION.examples
      .maskKeyframes as unknown as ResolvedTimelineDsl,
  );
}

export function renderTimelineMaskSkillReference(): string {
  const feature = TIMELINE_DSL_DEFINITION.features.clipMask;
  const fields = feature.fieldDefinitions as Record<
    string,
    MaskFieldDefinition
  >;
  const fieldNames = Object.keys(fields)
    .map((field) => `\`${field}\``)
    .join(", ");
  const channels = Object.values(fields)
    .flatMap((field) =>
      field.animatedChannel ? [`\`${field.animatedChannel}\``] : [],
    )
    .join(", ");
  return `<!-- BEGIN GENERATED TIMELINE MASK CONTRACT -->
The implementation-side capability annotations define all required mask fields:
${fieldNames}. The generated animated channels are ${channels}.
Coordinates use \`${feature.semantics.geometryUnits}\`; frames are
\`${feature.semantics.frameSpace}\` in \`${feature.semantics.validFrameRange}\`;
and interpolation is ${feature.semantics.interpolation.map((value) => `\`${value}\``).join(" or ")}.
The complete editor default is \`${inlineJson(feature.defaultMask)}\`.

Use \`clash_timeline_schema\` with \`view: "authoring"\` for compact field
descriptions, runtime semantics, reference bindings, and an executable YAML
example; request \`view: "full"\` only for the complete JSON Schema. Create/save
validates edits automatically; use the explicit validator only for diagnosis
when no write is intended. Remove a mask by
removing both \`item.mask\` and every generated mask channel.
<!-- END GENERATED TIMELINE MASK CONTRACT -->`;
}

/** Generated workflow guidance for every bundled Clash agent entrypoint. */
export function renderTimelineAgentWorkflowReference(): string {
  const validation = TIMELINE_DSL_DEFINITION.validation;
  return `<!-- BEGIN GENERATED TIMELINE DSL WORKFLOW -->
- The complete Timeline root, track, common item, item-variant, mask, and keyframe contract is generated from implementation annotations at
  schema version \`${TIMELINE_DSL_DEFINITION.schemaVersion}\` with fingerprint
  \`${TIMELINE_DSL_DEFINITION.contractFingerprint}\`.
- Before authoring unfamiliar Timeline fields, call \`clash_timeline_schema\`
  once with \`view: "authoring"\` for compact fields, reference semantics, stable
  rules, and an executable basic example. Use \`view: "full"\` only for the
  complete machine contract.
- Apply or \`clash_timeline_save\` directly: every submission automatically runs
  the authoritative validation and rejects invalid state with stable rule ids
  and paths without changing product state. Do not use the explicit validator as a preflight.
  Reserve \`${validation.mcpTool}\` (CLI equivalent:
  \`${validation.cliCommand}\`) for diagnostic-only workflows where no write is intended.
<!-- END GENERATED TIMELINE DSL WORKFLOW -->`;
}
