import {
  TIMELINE_DSL_DEFINITION,
  TIMELINE_OPERATION_REGISTRY,
  validateTimelineDsl,
  type TimelineDslTrackCategory,
  type TimelineDslValidationIssue,
} from "@clash/shared-types/timeline-contract";
import { z } from "zod";

type TimelineAgentOperationId = keyof typeof TIMELINE_OPERATION_REGISTRY.agent;

type TimelinePluginSurfaceBinding = {
  operationId: TimelineAgentOperationId;
};

/**
 * The MCP tool list is projected from shared operation annotations. Adding or
 * removing an `mcp:...` surface binding in shared-types updates registration,
 * descriptions, access hints, and operation metadata together.
 */
function mcpSurfaceBindings(): Record<string, TimelinePluginSurfaceBinding> {
  const bindings: Record<string, TimelinePluginSurfaceBinding> = {};
  for (const [operationId, annotation] of Object.entries(
    TIMELINE_OPERATION_REGISTRY.agent,
  ) as Array<
    [
      TimelineAgentOperationId,
      (typeof TIMELINE_OPERATION_REGISTRY.agent)[TimelineAgentOperationId],
    ]
  >) {
    for (const surface of annotation.surfaceBindings ?? []) {
      if (!surface.startsWith("mcp:")) continue;
      const toolName = surface.slice("mcp:".length);
      if (!toolName.startsWith("clash_timeline_")) {
        throw new Error(`Unsupported Timeline MCP surface binding ${surface}`);
      }
      if (bindings[toolName]) {
        throw new Error(`Duplicate Timeline MCP surface binding ${surface}`);
      }
      bindings[toolName] = Object.freeze({ operationId });
    }
  }
  return bindings;
}

export const TIMELINE_PLUGIN_SURFACE_BINDINGS =
  Object.freeze(mcpSurfaceBindings());

export type TimelinePluginSurfaceToolName = `clash_timeline_${string}`;

export const TIMELINE_PLUGIN_TOOL_NAMES = Object.freeze(
  Object.keys(TIMELINE_PLUGIN_SURFACE_BINDINGS),
) as readonly TimelinePluginSurfaceToolName[];

export const TIMELINE_PLUGIN_OPERATION_IDS = Object.freeze(
  Object.fromEntries(
    Object.entries(TIMELINE_PLUGIN_SURFACE_BINDINGS).map(
      ([toolName, binding]) => [toolName, binding.operationId],
    ),
  ),
) as Readonly<Record<TimelinePluginSurfaceToolName, TimelineAgentOperationId>>;

const TIMELINE_TRACK_CATEGORY_LABELS = {
  effect: "Effects",
  text: "Text / subtitle",
  visual: "Video / image",
  primary: "Primary video",
  audio: "Audio",
} as const satisfies Record<TimelineDslTrackCategory, string>;

/**
 * Narrow server-to-browser projection. The browser bundle deliberately does
 * not import shared-types; the MCP resource injects this generated payload.
 */
export const TIMELINE_APP_CONTRACT = Object.freeze({
  contractFingerprint: TIMELINE_DSL_DEFINITION.contractFingerprint,
  trackCategories: Object.freeze(
    TIMELINE_DSL_DEFINITION.taxonomy.trackCategories.map((id) =>
      Object.freeze({
        id,
        label: TIMELINE_TRACK_CATEGORY_LABELS[id],
      }),
    ),
  ),
  defaultTrackCategory: "visual" as TimelineDslTrackCategory,
  inspector: Object.freeze({
    scope: "timing-only" as const,
    editableItemFields: Object.freeze(["from", "durationInFrames"] as const),
  }),
});

export type TimelineAppContract = typeof TIMELINE_APP_CONTRACT;

export type TimelinePluginOperationMetadata =
  (typeof TIMELINE_DSL_DEFINITION.operationCatalog.agent)[TimelineAgentOperationId];

export function timelineOperationMetadata(
  toolName: TimelinePluginSurfaceToolName | string,
): TimelinePluginOperationMetadata | undefined {
  const binding = TIMELINE_PLUGIN_SURFACE_BINDINGS[toolName];
  if (!binding) return undefined;
  return TIMELINE_DSL_DEFINITION.operationCatalog.agent[binding.operationId];
}

export function timelineStateJsonSchema(): Record<string, unknown> {
  return cloneJsonSchema(
    TIMELINE_DSL_DEFINITION.jsonSchema as Record<string, unknown>,
  );
}

export type TimelineStateValidation =
  | { ok: true; issues: [] }
  | { ok: false; issues: TimelineDslValidationIssue[] };

export function validateTimelineState(state: unknown): TimelineStateValidation {
  const validation = validateTimelineDsl(state);
  return validation.ok
    ? { ok: true, issues: [] }
    : { ok: false, issues: validation.issues };
}

export class TimelineDslContractError extends Error {
  readonly code = "TIMELINE_DSL_INVALID";
  readonly issues: TimelineDslValidationIssue[];

  constructor(issues: TimelineDslValidationIssue[]) {
    const first = issues[0];
    const path = first?.path.length ? first.path.join(".") : "$";
    super(
      first
        ? `TIMELINE_DSL_INVALID: ${first.ruleId} at ${path}: ${first.message}`
        : "TIMELINE_DSL_INVALID: Timeline state did not satisfy the published contract",
    );
    this.name = "TimelineDslContractError";
    this.issues = issues;
  }
}

export function assertTimelineState(state: unknown): void {
  const validation = validateTimelineState(state);
  if (!validation.ok) throw new TimelineDslContractError(validation.issues);
}

export type TimelineMcpZodSchema = z.ZodType;

function cloneJsonSchema<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function timelineContractJsonSchemaMetadata(): Record<string, unknown> {
  return {
    "x-clash-contract-fingerprint": TIMELINE_DSL_DEFINITION.contractFingerprint,
    "x-clash-schema-version": TIMELINE_DSL_DEFINITION.schemaVersion,
    "x-clash-schema-tool": "clash_timeline_schema",
  };
}

const TIMELINE_MCP_SCOPE_JSON_SCHEMA = Object.freeze({
  cwd: {
    type: "string",
    minLength: 1,
    description:
      "Absolute project workspace path containing .clash/project.toml",
  },
  projectId: {
    type: "string",
    minLength: 1,
    description:
      "Project ID override; normally resolved from the workspace marker",
  },
});

function compactTimelineStateSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: [
      "Complete Timeline DSL state, not a patch.",
      "Call clash_timeline_schema for the authoritative fields and constraints.",
    ].join(" "),
    additionalProperties: true,
    "x-clash-contract-ref": "TimelineDsl",
    "x-clash-schema-tool": "clash_timeline_schema",
    "x-clash-contract-fingerprint": TIMELINE_DSL_DEFINITION.contractFingerprint,
  };
}

function timelineContractReferenceSchema(
  original: unknown,
): Record<string, unknown> {
  const timelineReference = compactTimelineStateSchema();
  if (!original || typeof original !== "object" || Array.isArray(original)) {
    return timelineReference;
  }
  const originalSchema = original as Record<string, unknown>;
  const variants = originalSchema.anyOf;
  if (!Array.isArray(variants)) return timelineReference;
  return {
    ...cloneJsonSchema(originalSchema),
    anyOf: variants.map((variant) =>
      variant &&
      typeof variant === "object" &&
      !Array.isArray(variant) &&
      (variant as Record<string, unknown>).type === "string"
        ? cloneJsonSchema(variant)
        : timelineReference,
    ),
  };
}

/** Project a shared operation input into the MCP envelope, adding only host scope. */
export function timelineOperationInputJsonSchema(
  operationId: TimelineAgentOperationId,
): Record<string, unknown> {
  const operation = TIMELINE_OPERATION_REGISTRY.agent[operationId];
  const catalog = TIMELINE_DSL_DEFINITION.operationCatalog.agent[operationId];
  const schema = cloneJsonSchema(catalog.inputJsonSchema) as Record<
    string,
    unknown
  >;
  const properties =
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  for (const fieldPath of Object.keys(operation.inputContractRefs ?? {})) {
    if (fieldPath.includes(".")) {
      throw new Error(
        `Unsupported nested Timeline operation contract ref ${fieldPath}`,
      );
    }
    properties[fieldPath] = timelineContractReferenceSchema(
      properties[fieldPath],
    );
  }
  schema.properties = {
    ...properties,
    ...cloneJsonSchema(TIMELINE_MCP_SCOPE_JSON_SCHEMA),
  };
  schema.additionalProperties = false;
  Object.assign(schema, timelineContractJsonSchemaMetadata(), {
    "x-clash-operation-id": operationId,
  });
  return schema;
}

/**
 * Zod 4 envelope for MCP, backed by the executable shared Zod annotation.
 * JSON Schema metadata and runtime validation therefore originate together.
 */
export function timelineOperationInputSchema(
  operationId: TimelineAgentOperationId,
): TimelineMcpZodSchema {
  const operation = TIMELINE_OPERATION_REGISTRY.agent[operationId];
  return z
    .object(scopeShape)
    .catchall(z.unknown())
    .superRefine((input, context) => {
      const { cwd: _cwd, projectId: _projectId, ...operationInput } = input;
      const validation = operation.inputSchema.safeParse(operationInput);
      if (!validation.success) {
        for (const issue of validation.error.issues) {
          context.addIssue({
            code: "custom",
            path: issue.path,
            message: issue.message,
          });
        }
        return;
      }
      if (operation.access !== "write") return;
      const validatedInput = validation.data as Record<string, unknown>;
      for (const fieldPath of Object.keys(operation.inputContractRefs ?? {})) {
        const state = validatedInput[fieldPath];
        if (state === undefined || typeof state === "string") continue;
        const contractValidation = validateTimelineState(state);
        if (contractValidation.ok) continue;
        for (const issue of contractValidation.issues) {
          context.addIssue({
            code: "custom",
            path: [fieldPath, ...issue.path],
            message: issue.message,
            params: { ruleId: issue.ruleId },
          });
        }
      }
    })
    .meta(timelineOperationInputJsonSchema(operationId));
}

function expandTimelineEntityStateSchemas(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.reduce(
      (expanded, entry) => expandTimelineEntityStateSchemas(entry) || expanded,
      false,
    );
  }
  const schema = value as Record<string, unknown>;
  let expanded = false;
  const properties =
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : undefined;
  if (
    properties?.state &&
    properties.id &&
    properties.name &&
    properties.owner
  ) {
    properties.state = compactTimelineStateSchema();
    expanded = true;
  }
  for (const entry of Object.values(schema)) {
    expanded = expandTimelineEntityStateSchemas(entry) || expanded;
  }
  return expanded;
}

function withTimelineToolErrorEnvelope(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties =
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const normalRequired = Array.isArray(schema.required)
    ? ([...schema.required] as string[])
    : [];
  const { required: _required, ...withoutRootRequired } = schema;
  return {
    ...withoutRootRequired,
    type: "object",
    properties: {
      ...properties,
      error: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1 },
          message: { type: "string" },
          retryTool: { type: "string", minLength: 1 },
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ruleId: { type: "string", minLength: 1 },
                path: {
                  type: "array",
                  items: { anyOf: [{ type: "string" }, { type: "number" }] },
                },
                message: { type: "string" },
              },
              required: ["ruleId", "path", "message"],
              additionalProperties: true,
            },
          },
        },
        required: ["code", "message"],
        additionalProperties: true,
      },
    },
    anyOf: [{ required: normalRequired }, { required: ["error"] }],
  };
}

export function timelineOperationOutputJsonSchema(
  operationId: TimelineAgentOperationId,
  transform?: (schema: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const catalog = TIMELINE_DSL_DEFINITION.operationCatalog.agent[operationId];
  const catalogSchema = cloneJsonSchema(catalog.outputJsonSchema) as Record<
    string,
    unknown
  >;
  let schema = transform ? transform(catalogSchema) : catalogSchema;
  if (expandTimelineEntityStateSchemas(schema)) {
    Object.assign(schema, timelineContractJsonSchemaMetadata());
  }
  schema = withTimelineToolErrorEnvelope(schema);
  schema["x-clash-operation-id"] = operationId;
  return schema;
}

export function timelineOperationOutputSchema(
  operationId: TimelineAgentOperationId,
  transform?: (schema: Record<string, unknown>) => Record<string, unknown>,
  projectSharedOutput: (output: Record<string, unknown>) => unknown = (
    output,
  ) => output,
): TimelineMcpZodSchema {
  const operation = TIMELINE_OPERATION_REGISTRY.agent[operationId];
  return z
    .object({})
    .catchall(z.unknown())
    .superRefine((output, context) => {
      const validation = operation.outputSchema.safeParse(
        projectSharedOutput(output),
      );
      if (validation.success) return;
      for (const issue of validation.error.issues) {
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    })
    .meta(timelineOperationOutputJsonSchema(operationId, transform));
}

const scopeShape = {
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe("Absolute project workspace path containing .clash/project.toml"),
  projectId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Project ID override; normally resolved from the workspace marker",
    ),
};

export const TIMELINE_GET_OUTPUT_SCHEMA = timelineOperationOutputSchema(
  "timeline.get",
  (schema) => {
    const properties =
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, unknown>)
        : {};
    return {
      ...schema,
      properties: {
        ...properties,
        contract: {
          type: "object",
          properties: {
            schemaVersion: { type: "integer", minimum: 1 },
            contractFingerprint: { type: "string", minLength: 1 },
          },
          required: ["schemaVersion", "contractFingerprint"],
          additionalProperties: true,
        },
        validation: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            issues: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ruleId: { type: "string", minLength: 1 },
                  path: {
                    type: "array",
                    items: { anyOf: [{ type: "string" }, { type: "number" }] },
                  },
                  message: { type: "string" },
                },
                required: ["ruleId", "path", "message"],
                additionalProperties: true,
              },
            },
          },
          required: ["ok", "issues"],
          additionalProperties: true,
        },
      },
      required: [
        ...new Set([
          ...(Array.isArray(schema.required)
            ? (schema.required as string[])
            : []),
          "contract",
          "validation",
        ]),
      ],
    };
  },
  (output) => ({ timeline: output.timeline }),
);

export const TIMELINE_CONTRACT_SUMMARY = Object.freeze({
  schemaVersion: TIMELINE_DSL_DEFINITION.schemaVersion,
  contractFingerprint: TIMELINE_DSL_DEFINITION.contractFingerprint,
});
