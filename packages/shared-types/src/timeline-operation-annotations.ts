import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  TIMELINE_DSL_FIELD_ANNOTATIONS,
  TIMELINE_DSL_ITEM_TYPES,
  timelineDslAnnotatedObjectShape,
  type TimelineDslFieldAnnotation,
} from "./timeline-field-annotations.js";
import { TimelineDiscoveryViewSchema } from "./timeline-discovery-contract.js";

/**
 * Executable operation annotations for every public Timeline surface.
 *
 * The executable registry is consumed by adapters that validate operation
 * envelopes. The catalog is the serializable discovery/Javadoc projection.
 * Read proof and CAS are deliberately metadata rather than caller-supplied
 * input fields: the local host records observations and enforces mutations.
 */

export type TimelineOperationAccess = "read" | "write";
export type TimelineOperationCas = "none" | "host-enforced";
export type TimelineOperationReadProof =
  "none" | "records-observation" | "requires-observation";
export type TimelineOperationKind =
  "agent" | "entity" | "projection" | "editor-command" | "editor-action";

export type TimelineOperationAnnotation = {
  id: string;
  kind: TimelineOperationKind;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  access: TimelineOperationAccess;
  readOnly: boolean;
  cas: TimelineOperationCas;
  readProof: TimelineOperationReadProof;
  preconditions: readonly string[];
  description: string;
  runtimeConsumers: readonly string[];
  /** Concrete public commands/tools implementing this logical operation. */
  surfaceBindings?: readonly string[];
  /** Input property paths whose value is validated by another canonical contract. */
  inputContractRefs?: Readonly<Record<string, string>>;
  public: true;
  agentCallable: boolean;
};

export type TimelineOperationCatalogEntry = Omit<
  TimelineOperationAnnotation,
  "inputSchema" | "outputSchema"
> & {
  inputJsonSchema: Record<string, unknown>;
  outputJsonSchema: Record<string, unknown>;
};

const IdentifierSchema = z.string().trim().min(1);
const FiniteNumberSchema = z.number().finite();
const FrameSchema = z.number().finite().int().nonnegative();
const PositiveFrameSchema = z.number().finite().int().positive();
const PositionSchema = z
  .object({
    x: FiniteNumberSchema,
    y: FiniteNumberSchema,
  })
  .strict();

const TimelineDocumentEnvelopeSchema = z
  .object({
    tracks: z.array(z.unknown()),
  })
  .passthrough();

const TimelineOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z
    .object({
      kind: z.literal("canvas-action"),
      canvasId: IdentifierSchema,
      actionNodeId: IdentifierSchema,
    })
    .strict(),
]);

const ProjectTimelineEntitySchema = z
  .object({
    id: IdentifierSchema,
    name: IdentifierSchema,
    owner: TimelineOwnerSchema,
    revisionId: IdentifierSchema,
    state: z.unknown(),
  })
  .passthrough();

/** Discovery carries identity and size; clip bodies are an explicit detail read. */
export function summarizeProjectTimeline<T extends { state: unknown }>(
  timeline: T,
) {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const { state, ...identity } = timeline;
  const data = isRecord(state) ? state : {};
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  const dimensions: Partial<
    Record<
      "fps" | "durationInFrames" | "compositionWidth" | "compositionHeight",
      number
    >
  > = {};
  for (const field of [
    "fps",
    "durationInFrames",
    "compositionWidth",
    "compositionHeight",
  ] as const) {
    const value = data[field];
    if (typeof value === "number" && Number.isFinite(value))
      dimensions[field] = value;
  }
  return {
    ...identity,
    ...dimensions,
    trackCount: tracks.length,
    itemCount: tracks.reduce(
      (count: number, track: unknown) =>
        count +
        (isRecord(track) && Array.isArray(track.items)
          ? track.items.length
          : 0),
      0,
    ),
  };
}

const ProjectTimelineSummarySchema = ProjectTimelineEntitySchema.omit({ state: true }).extend({
  trackCount: FrameSchema,
  itemCount: FrameSchema,
  fps: FiniteNumberSchema.optional(),
  durationInFrames: FrameSchema.optional(),
  compositionWidth: FiniteNumberSchema.optional(),
  compositionHeight: FiniteNumberSchema.optional(),
}).strict();

const TimelineIssueSchema = z
  .object({
    severity: z.enum(["error", "warning"]).optional(),
    code: IdentifierSchema,
    message: z.string().min(1),
    path: z.string(),
  })
  .passthrough();

const TimelineFullSchemaOutputSchema = z
  .object({
    schemaVersion: z.union([z.number().int().positive(), IdentifierSchema]),
    contractFingerprint: IdentifierSchema,
    jsonSchema: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const TimelineAuthoringSchemaOutputSchema = z
  .object({
    view: z.literal("authoring"),
    schemaVersion: z.number().int().positive(),
    contractFingerprint: IdentifierSchema,
    format: z.literal("clash.timeline.yaml"),
    fields: z.record(z.string(), z.unknown()),
    taxonomy: z.record(z.string(), z.unknown()),
    semanticRules: z.record(z.string(), z.unknown()),
    references: z.record(z.string(), z.unknown()),
    examples: z.record(z.string(), z.unknown()),
    submission: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const TimelineSchemaOutputSchema = z.union([
  TimelineAuthoringSchemaOutputSchema,
  TimelineFullSchemaOutputSchema,
]);

const TimelineValidationOutputSchema = z
  .object({
    ok: z.boolean(),
    issues: z.array(TimelineIssueSchema).default([]),
    contractFingerprint: IdentifierSchema.optional(),
    sources: z.array(IdentifierSchema).optional(),
  })
  .passthrough();

const TimelineProjectionOutputSchema = z
  .object({
    pulled: z.literal(true),
    projectId: IdentifierSchema,
    timelineId: IdentifierSchema,
    revisionId: IdentifierSchema,
    owner: TimelineOwnerSchema,
    filePath: IdentifierSchema,
    timelineHash: IdentifierSchema,
  })
  .passthrough();

const TimelineApplyOutputSchema = z
  .object({
    applied: z.literal(true),
    projectId: IdentifierSchema,
    timelineId: IdentifierSchema,
    revisionId: IdentifierSchema,
    owner: TimelineOwnerSchema,
    filePath: IdentifierSchema,
    sources: z.array(IdentifierSchema),
    timelineHash: IdentifierSchema,
  })
  .passthrough();

const TimelineRenderTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project-assets") }).strict(),
  z
    .object({
      kind: z.literal("canvas"),
      canvasId: IdentifierSchema,
      actionNodeId: IdentifierSchema,
    })
    .strict(),
]);

const TimelineRenderReceiptSchema = z
  .object({
    submitted: z.literal(true),
    completed: z.boolean(),
    timelineId: IdentifierSchema,
    sourceTimelineRevisionId: IdentifierSchema,
    renderNodeId: IdentifierSchema,
    target: TimelineRenderTargetSchema,
    status: z.enum(["pending", "completed", "failed"]),
    asset: z.object({ id: IdentifierSchema }).strict().optional(),
    error: z.string().min(1).optional(),
  })
  .passthrough();

const timelineEditorItemVariantSchemas = TIMELINE_DSL_ITEM_TYPES.map((type) =>
  z
    .object({
      ...timelineDslAnnotatedObjectShape(
        TIMELINE_DSL_FIELD_ANNOTATIONS.itemBase,
        {
          requiredness: "runtime",
          overrides: {
            type: z.literal(type),
            from: FrameSchema,
          },
        },
      ),
      ...timelineDslAnnotatedObjectShape(
        TIMELINE_DSL_FIELD_ANNOTATIONS.itemTypes[type],
        { requiredness: "runtime" },
      ),
    })
    .strict(),
);

const TimelineItemEnvelopeSchema = z.discriminatedUnion(
  "type",
  timelineEditorItemVariantSchemas as unknown as [
    z.ZodDiscriminatedUnionOption<"type">,
    ...z.ZodDiscriminatedUnionOption<"type">[],
  ],
);

const TimelineTrackEnvelopeSchema = z
  .object(
    timelineDslAnnotatedObjectShape(TIMELINE_DSL_FIELD_ANNOTATIONS.track, {
      requiredness: "runtime",
      overrides: { items: z.array(TimelineItemEnvelopeSchema) },
    }),
  )
  .strict();

const TimelineAssetEnvelopeSchema = z
  .object({
    id: IdentifierSchema,
    name: IdentifierSchema,
    type: z.enum(["video", "audio", "image"]),
    src: IdentifierSchema,
    createdAt: FiniteNumberSchema,
  })
  .passthrough();

const TimelineTranscriptEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.editor.asset-transcript"),
    assetId: IdentifierSchema,
    text: z.string(),
    durationMs: FrameSchema,
    words: z.array(
      z
        .object({
          id: IdentifierSchema,
          text: z.string(),
          startMs: FrameSchema,
          endMs: PositiveFrameSchema,
        })
        .passthrough(),
    ),
  })
  .passthrough();

const TimelineEditorStateEnvelopeSchema = z
  .object({
    tracks: z.array(TimelineTrackEnvelopeSchema),
  })
  .passthrough();

const TimelineCommandOutputSchema = z
  .object({
    ok: z.boolean(),
    dsl: TimelineDocumentEnvelopeSchema,
    issues: z.array(TimelineIssueSchema),
  })
  .passthrough();

function annotation(
  options: TimelineOperationAnnotation,
): TimelineOperationAnnotation {
  return Object.freeze({
    ...options,
    preconditions: Object.freeze([...options.preconditions]),
    runtimeConsumers: Object.freeze([...options.runtimeConsumers]),
    ...(options.surfaceBindings
      ? { surfaceBindings: Object.freeze([...options.surfaceBindings]) }
      : {}),
    ...(options.inputContractRefs
      ? { inputContractRefs: Object.freeze({ ...options.inputContractRefs }) }
      : {}),
  });
}

function agentOperation(
  options: Omit<TimelineOperationAnnotation, "public">,
): TimelineOperationAnnotation {
  return annotation({ ...options, public: true });
}

const agent = {
  "timeline.open": agentOperation({
    id: "timeline.open",
    kind: "agent",
    inputSchema: z.object({ timelineId: IdentifierSchema.optional() }).strict(),
    outputSchema: z
      .object({
        cwd: IdentifierSchema,
        timelines: z.array(ProjectTimelineEntitySchema),
        selected: ProjectTimelineEntitySchema.optional(),
      })
      .passthrough(),
    access: "read",
    readOnly: true,
    cas: "none",
    readProof: "records-observation",
    preconditions: ["The current cwd resolves to a Project replica."],
    description:
      "Open the interactive Timeline app with an optionally selected Project Timeline.",
    runtimeConsumers: ["mcp", "timeline-app", "agent-runtime"],
    surfaceBindings: ["mcp:clash_timeline_open"],
    agentCallable: true,
  }),
  "timeline.schema": agentOperation({
    id: "timeline.schema",
    kind: "agent",
    inputSchema: z
      .object({
        view: TimelineDiscoveryViewSchema.optional(),
      })
      .strict(),
    outputSchema: TimelineSchemaOutputSchema,
    access: "read",
    readOnly: true,
    cas: "none",
    readProof: "none",
    preconditions: ["The installed Timeline contract is available."],
    description:
      "Return compact Timeline authoring discovery by default, or the complete machine-readable contract on request.",
    runtimeConsumers: [
      "cli",
      "mcp",
      "agent-runtime",
      "documentation-generator",
    ],
    surfaceBindings: ["cli:timeline schema", "mcp:clash_timeline_schema"],
    agentCallable: true,
  }),
  "timeline.validate": agentOperation({
    id: "timeline.validate",
    kind: "agent",
    inputSchema: z
      .object({
        document: z.union([z.string(), TimelineDocumentEnvelopeSchema]),
        format: z.enum(["yaml", "json", "object"]).optional(),
      })
      .strict(),
    outputSchema: TimelineValidationOutputSchema,
    access: "read",
    readOnly: true,
    cas: "none",
    readProof: "none",
    preconditions: [
      "The authored document is syntactically readable as YAML, JSON, or an object.",
    ],
    description:
      "Diagnose authored Timeline DSL without applying or mutating a Project Timeline, only when no write is intended. Do not use it as a preflight for create, save, or apply; those writes run the same validation automatically.",
    runtimeConsumers: ["cli", "mcp", "agent-runtime", "timeline-semantics"],
    surfaceBindings: ["cli:timeline validate", "mcp:clash_timeline_validate"],
    inputContractRefs: { document: "TIMELINE_DSL_DEFINITION.jsonSchema" },
    agentCallable: true,
  }),
  "timeline.list": agentOperation({
    id: "timeline.list",
    kind: "entity",
    inputSchema: z.object({ standalone: z.boolean().optional(), full: z.boolean().optional() }).strict(),
    outputSchema: z.array(z.union([ProjectTimelineSummarySchema, ProjectTimelineEntitySchema])),
    access: "read",
    readOnly: true,
    cas: "none",
    readProof: "records-observation",
    preconditions: ["The current cwd resolves to a Project replica."],
    description:
      "List Timeline identity, ownership, revision, dimensions and item counts. Read a chosen Timeline for clip details; request full explicitly to include every complete state. Records observations for later writes.",
    runtimeConsumers: ["cli", "mcp", "local-host", "agent-runtime"],
    surfaceBindings: ["cli:timeline list", "mcp:clash_timeline_list"],
    agentCallable: true,
  }),
  "timeline.get": agentOperation({
    id: "timeline.get",
    kind: "entity",
    inputSchema: z.object({ timelineId: IdentifierSchema }).strict(),
    outputSchema: z.object({ timeline: ProjectTimelineEntitySchema }).strict(),
    access: "read",
    readOnly: true,
    cas: "none",
    readProof: "records-observation",
    preconditions: [
      "The requested Timeline exists in the current Project replica.",
    ],
    description:
      "Read one complete Project Timeline state and its revision for a later typed save.",
    runtimeConsumers: ["mcp", "local-host", "agent-runtime"],
    surfaceBindings: ["mcp:clash_timeline_get"],
    agentCallable: true,
  }),
  "timeline.create": agentOperation({
    id: "timeline.create",
    kind: "entity",
    inputSchema: z
      .object({
        id: IdentifierSchema,
        name: IdentifierSchema,
        state: TimelineDocumentEnvelopeSchema.optional(),
      })
      .strict(),
    outputSchema: ProjectTimelineEntitySchema,
    access: "write",
    readOnly: false,
    cas: "host-enforced",
    readProof: "none",
    preconditions: ["The Project-scoped Timeline id does not already exist."],
    description:
      "Automatically validate and create a standalone Project Timeline through the authoritative local host; invalid state leaves Project state unchanged.",
    runtimeConsumers: ["cli", "mcp", "local-host", "project-workspace"],
    surfaceBindings: ["cli:timeline create", "mcp:clash_timeline_create"],
    inputContractRefs: { state: "TIMELINE_DSL_DEFINITION.jsonSchema" },
    agentCallable: true,
  }),
  "timeline.save": agentOperation({
    id: "timeline.save",
    kind: "entity",
    inputSchema: z
      .object({
        timelineId: IdentifierSchema,
        baseRevisionId: IdentifierSchema,
        state: TimelineDocumentEnvelopeSchema,
      })
      .strict(),
    outputSchema: TimelineApplyOutputSchema,
    access: "write",
    readOnly: false,
    cas: "host-enforced",
    readProof: "requires-observation",
    preconditions: [
      "The Timeline was read and baseRevisionId still matches its current revision.",
      "The complete state passes the canonical structural and semantic contract.",
    ],
    description:
      "Automatically validate and atomically save a complete typed Timeline state with an explicit base revision; invalid state leaves the Timeline revision unchanged.",
    runtimeConsumers: [
      "mcp",
      "local-host",
      "agent-runtime",
      "timeline-semantics",
    ],
    surfaceBindings: ["mcp:clash_timeline_save"],
    inputContractRefs: { state: "TIMELINE_DSL_DEFINITION.jsonSchema" },
    agentCallable: true,
  }),
  "timeline.attach": agentOperation({
    id: "timeline.attach",
    kind: "entity",
    inputSchema: z
      .object({
        timelineId: IdentifierSchema,
        canvasId: IdentifierSchema,
        actionNodeId: IdentifierSchema.optional(),
        position: PositionSchema.optional(),
      })
      .strict(),
    outputSchema: ProjectTimelineEntitySchema,
    access: "write",
    readOnly: false,
    cas: "host-enforced",
    readProof: "requires-observation",
    preconditions: [
      "The Timeline was observed through list or pull and remains at that revision.",
      "The Timeline is standalone and the target Canvas exists.",
      "The Timeline Action node id is unused.",
    ],
    description:
      "Move a standalone Timeline into a Canvas as a Timeline Action.",
    runtimeConsumers: [
      "cli",
      "mcp",
      "local-host",
      "project-workspace",
      "canvas",
    ],
    surfaceBindings: ["cli:timeline attach", "mcp:clash_timeline_attach"],
    agentCallable: true,
  }),
  "timeline.detach": agentOperation({
    id: "timeline.detach",
    kind: "entity",
    inputSchema: z.object({ timelineId: IdentifierSchema }).strict(),
    outputSchema: ProjectTimelineEntitySchema,
    access: "write",
    readOnly: false,
    cas: "host-enforced",
    readProof: "requires-observation",
    preconditions: [
      "The Timeline was observed through list or pull and remains at that revision.",
      "The Timeline is currently owned by a Canvas Timeline Action.",
    ],
    description: "Detach a Canvas-owned Timeline back to the Project root.",
    runtimeConsumers: [
      "cli",
      "mcp",
      "local-host",
      "project-workspace",
      "canvas",
    ],
    surfaceBindings: ["cli:timeline detach", "mcp:clash_timeline_detach"],
    agentCallable: true,
  }),
  "timeline.copy": agentOperation({
    id: "timeline.copy",
    kind: "entity",
    inputSchema: z
      .object({
        sourceTimelineId: IdentifierSchema,
        targetCanvasId: IdentifierSchema,
        newTimelineId: IdentifierSchema.optional(),
        newActionNodeId: IdentifierSchema.optional(),
        position: PositionSchema.optional(),
      })
      .strict(),
    outputSchema: ProjectTimelineEntitySchema,
    access: "write",
    readOnly: false,
    cas: "host-enforced",
    readProof: "requires-observation",
    preconditions: [
      "The source Timeline was observed and remains at that revision.",
      "The source is a Canvas-owned Timeline Action and the target Canvas exists.",
      "The new Timeline and Action node ids are unused.",
    ],
    description:
      "Copy a Timeline Action into another Canvas using copy-on-write identity.",
    runtimeConsumers: [
      "cli",
      "mcp",
      "local-host",
      "project-workspace",
      "canvas",
    ],
    surfaceBindings: ["cli:timeline copy", "mcp:clash_timeline_copy"],
    agentCallable: true,
  }),
  "timeline.render": agentOperation({
    id: "timeline.render",
    kind: "agent",
    inputSchema: z
      .object({
        timelineId: IdentifierSchema,
        wait: z.boolean().optional(),
        timeoutMs: z.number().int().min(1_000).optional(),
      })
      .strict(),
    outputSchema: TimelineRenderReceiptSchema,
    access: "write",
    readOnly: false,
    cas: "none",
    readProof: "records-observation",
    preconditions: [
      "The Timeline exists and contains at least one renderable item.",
      "The local daemon has a healthy packaged Remotion rendering backend.",
    ],
    description:
      "Submit the current Timeline revision to the daemon renderer and optionally wait for persisted Asset readback.",
    runtimeConsumers: [
      "cli",
      "mcp",
      "local-host",
      "remotion-renderer",
      "agent-runtime",
    ],
    surfaceBindings: ["cli:timeline render", "mcp:clash_timeline_render"],
    agentCallable: true,
  }),
  "timeline.pull": agentOperation({
    id: "timeline.pull",
    kind: "projection",
    inputSchema: z.object({ timelineId: IdentifierSchema }).strict(),
    outputSchema: TimelineProjectionOutputSchema,
    access: "read",
    readOnly: true,
    cas: "none",
    readProof: "records-observation",
    preconditions: ["The Timeline exists in the current Project replica."],
    description:
      "Project the current Timeline revision to agent-editable YAML and record its observation.",
    runtimeConsumers: ["cli", "local-host", "yaml-projection", "agent-runtime"],
    surfaceBindings: ["cli:timeline pull"],
    agentCallable: true,
  }),
  "timeline.apply": agentOperation({
    id: "timeline.apply",
    kind: "projection",
    inputSchema: z
      .object({
        timelineId: IdentifierSchema,
        document: z.union([z.string(), TimelineDocumentEnvelopeSchema]),
        format: z.enum(["yaml", "json", "object"]).optional(),
      })
      .strict(),
    outputSchema: TimelineApplyOutputSchema,
    access: "write",
    readOnly: false,
    cas: "host-enforced",
    readProof: "requires-observation",
    preconditions: [
      "The Timeline was pulled or listed and remains at that revision.",
      "The complete authored document passes structural and semantic validation.",
      "Any immutable downstream dependency guard permits the revision advance.",
    ],
    description:
      "Automatically validate an authored projection and atomically advance the Project Timeline revision; invalid input leaves the Timeline revision unchanged.",
    runtimeConsumers: [
      "cli",
      "local-host",
      "yaml-projection",
      "timeline-semantics",
    ],
    surfaceBindings: ["cli:timeline apply"],
    inputContractRefs: { document: "TIMELINE_DSL_DEFINITION.jsonSchema" },
    agentCallable: true,
  }),
} satisfies Record<string, TimelineOperationAnnotation>;

const editorCommandDefaults = {
  kind: "editor-command" as const,
  outputSchema: TimelineCommandOutputSchema,
  access: "write" as const,
  readOnly: false,
  cas: "none" as const,
  readProof: "none" as const,
  runtimeConsumers: ["remotion-core", "editor", "agent-runtime"] as const,
  public: true as const,
  agentCallable: true,
};

const editorCommands = {
  "timeline.command.add_clip": annotation({
    ...editorCommandDefaults,
    id: "timeline.command.add_clip",
    inputSchema: z
      .object({
        type: z.literal("add_clip"),
        trackId: IdentifierSchema,
        sourceNodeId: IdentifierSchema,
        assetId: IdentifierSchema.optional(),
        itemType: z.enum(["video", "audio", "image", "text"]),
        from: FrameSchema,
        durationInFrames: PositiveFrameSchema,
        id: IdentifierSchema.optional(),
        text: z.string().optional(),
      })
      .strict(),
    preconditions: [
      "The target track exists and accepts the requested item type.",
      "The source node resolves for media clips.",
    ],
    description: "Add one validated clip to a Timeline draft.",
  }),
  "timeline.command.trim_clip": annotation({
    ...editorCommandDefaults,
    id: "timeline.command.trim_clip",
    inputSchema: z
      .object({
        type: z.literal("trim_clip"),
        trackId: IdentifierSchema,
        itemId: IdentifierSchema,
        from: FrameSchema,
        durationInFrames: PositiveFrameSchema,
      })
      .strict(),
    preconditions: [
      "The target track and item exist and the requested duration is positive.",
    ],
    description: "Trim and reposition one clip in a Timeline draft.",
  }),
  "timeline.command.split_clip": annotation({
    ...editorCommandDefaults,
    id: "timeline.command.split_clip",
    inputSchema: z
      .object({
        type: z.literal("split_clip"),
        trackId: IdentifierSchema,
        itemId: IdentifierSchema,
        splitFrame: FrameSchema,
      })
      .strict(),
    preconditions: [
      "The target item exists and the split frame lies strictly inside its bounds.",
    ],
    description: "Split one clip at an absolute Timeline frame.",
  }),
} satisfies Record<string, TimelineOperationAnnotation>;

const itemUpdateFields: Record<string, TimelineDslFieldAnnotation> = {
  ...TIMELINE_DSL_FIELD_ANNOTATIONS.itemBase,
  ...Object.assign(
    {},
    ...Object.values(TIMELINE_DSL_FIELD_ANNOTATIONS.itemTypes),
  ),
};
const ItemUpdatesSchema = z
  .object(
    timelineDslAnnotatedObjectShape(itemUpdateFields, {
      requiredness: "partial",
      overrides: { from: FrameSchema },
    }),
  )
  .strict()
  .refine(
    (updates) => Object.keys(updates).length > 0,
    "At least one item field must be updated.",
  );
const TrackUpdatesSchema = z
  .object(
    timelineDslAnnotatedObjectShape(TIMELINE_DSL_FIELD_ANNOTATIONS.track, {
      requiredness: "partial",
      overrides: { items: z.array(TimelineItemEnvelopeSchema) },
    }),
  )
  .strict()
  .refine(
    (updates) => Object.keys(updates).length > 0,
    "At least one track field must be updated.",
  );

function editorAction(
  id: string,
  inputSchema: z.ZodTypeAny,
  description: string,
  preconditions: readonly string[] = ["A Timeline editor draft is loaded."],
): TimelineOperationAnnotation {
  return annotation({
    id,
    kind: "editor-action",
    inputSchema,
    outputSchema: TimelineEditorStateEnvelopeSchema,
    access: "write",
    readOnly: false,
    cas: "none",
    readProof: "none",
    preconditions,
    description,
    runtimeConsumers: ["remotion-core", "remotion-ui", "editor-history"],
    public: true,
    agentCallable: false,
  });
}

function actionWithPayload(type: string, payload: z.ZodTypeAny): z.ZodTypeAny {
  return z.object({ type: z.literal(type), payload }).strict();
}

function actionWithoutPayload(type: string): z.ZodTypeAny {
  return z.object({ type: z.literal(type) }).strict();
}

const editorActions = {
  "timeline.action.ADD_TRACK": editorAction(
    "timeline.action.ADD_TRACK",
    actionWithPayload("ADD_TRACK", TimelineTrackEnvelopeSchema),
    "Append a compatible track to the local Timeline draft.",
  ),
  "timeline.action.INSERT_TRACK": editorAction(
    "timeline.action.INSERT_TRACK",
    actionWithPayload(
      "INSERT_TRACK",
      z
        .object({
          track: TimelineTrackEnvelopeSchema,
          index: FrameSchema,
        })
        .strict(),
    ),
    "Insert a compatible track at a requested editor index.",
  ),
  "timeline.action.REMOVE_TRACK": editorAction(
    "timeline.action.REMOVE_TRACK",
    actionWithPayload("REMOVE_TRACK", IdentifierSchema),
    "Remove a track from the local Timeline draft.",
    [
      "The target track exists and editor primary-track invariants can be preserved.",
    ],
  ),
  "timeline.action.SET_PRIMARY_TRACK": editorAction(
    "timeline.action.SET_PRIMARY_TRACK",
    actionWithPayload("SET_PRIMARY_TRACK", IdentifierSchema),
    "Choose the Timeline track that anchors semantic edits.",
    ["The target track exists and is eligible to be primary."],
  ),
  "timeline.action.UPDATE_TRACK": editorAction(
    "timeline.action.UPDATE_TRACK",
    actionWithPayload(
      "UPDATE_TRACK",
      z
        .object({
          id: IdentifierSchema,
          updates: TrackUpdatesSchema,
        })
        .strict(),
    ),
    "Update authored properties of one Timeline track.",
    [
      "The target track exists and the update preserves category and primary-track invariants.",
    ],
  ),
  "timeline.action.REORDER_TRACKS": editorAction(
    "timeline.action.REORDER_TRACKS",
    actionWithPayload("REORDER_TRACKS", z.array(TimelineTrackEnvelopeSchema)),
    "Replace the local track ordering with a complete ordered track list.",
    [
      "Every current track is represented exactly once and category ordering remains valid.",
    ],
  ),
  "timeline.action.ADD_ITEM": editorAction(
    "timeline.action.ADD_ITEM",
    actionWithPayload(
      "ADD_ITEM",
      z
        .object({
          trackId: IdentifierSchema,
          item: TimelineItemEnvelopeSchema,
        })
        .strict(),
    ),
    "Append one item to a compatible Timeline track.",
    [
      "The target track exists, accepts the item type, and the item id is unique.",
    ],
  ),
  "timeline.action.MOVE_ITEM": editorAction(
    "timeline.action.MOVE_ITEM",
    actionWithPayload(
      "MOVE_ITEM",
      z
        .object({
          sourceTrackId: IdentifierSchema,
          targetTrackId: IdentifierSchema,
          itemId: IdentifierSchema,
          from: FrameSchema,
        })
        .strict(),
    ),
    "Move an item between compatible tracks at an absolute frame.",
    [
      "Both tracks and the item exist, and the target track accepts the item type.",
    ],
  ),
  "timeline.action.REMOVE_ITEM": editorAction(
    "timeline.action.REMOVE_ITEM",
    actionWithPayload(
      "REMOVE_ITEM",
      z
        .object({
          trackId: IdentifierSchema,
          itemId: IdentifierSchema,
        })
        .strict(),
    ),
    "Remove an item and reconcile its parent track.",
    ["The target track and item exist."],
  ),
  "timeline.action.UPDATE_ITEM": editorAction(
    "timeline.action.UPDATE_ITEM",
    actionWithPayload(
      "UPDATE_ITEM",
      z
        .object({
          trackId: IdentifierSchema,
          itemId: IdentifierSchema,
          updates: ItemUpdatesSchema,
        })
        .strict(),
    ),
    "Update authored fields on one Timeline item.",
    [
      "The target item exists and the update remains valid for its discriminated item type.",
    ],
  ),
  "timeline.action.ROLL_EDIT": editorAction(
    "timeline.action.ROLL_EDIT",
    actionWithPayload(
      "ROLL_EDIT",
      z.object({
        trackId: IdentifierSchema,
        leftItemId: IdentifierSchema,
        rightItemId: IdentifierSchema,
        boundaryFrame: FrameSchema,
      }).strict(),
    ),
    "Move a shared clip boundary atomically, preserving the pair's total span and attached transition.",
    ["Both clips are adjacent on the same track; the boundary is clamped to available source handles."],
  ),
  "timeline.action.SPLIT_ITEM": editorAction(
    "timeline.action.SPLIT_ITEM",
    actionWithPayload(
      "SPLIT_ITEM",
      z
        .object({
          trackId: IdentifierSchema,
          itemId: IdentifierSchema,
          splitFrame: FrameSchema,
        })
        .strict(),
    ),
    "Split an item at an absolute Timeline frame and slice its keyframes.",
    ["The split frame lies strictly inside the target item bounds."],
  ),
  "timeline.action.RIPPLE_DELETE_RANGE": editorAction(
    "timeline.action.RIPPLE_DELETE_RANGE",
    actionWithPayload(
      "RIPPLE_DELETE_RANGE",
      z
        .object({
          startFrame: FrameSchema,
          endFrame: PositiveFrameSchema,
        })
        .strict()
        .refine(
          ({ startFrame, endFrame }) => endFrame > startFrame,
          "endFrame must be greater than startFrame.",
        ),
    ),
    "Delete an absolute frame range and close the resulting gap.",
    ["The requested range is non-empty and lies within the editable Timeline."],
  ),
  "timeline.action.RESTORE_TIMELINE_SNAPSHOT": editorAction(
    "timeline.action.RESTORE_TIMELINE_SNAPSHOT",
    actionWithPayload(
      "RESTORE_TIMELINE_SNAPSHOT",
      z
        .object({
          tracks: z.array(TimelineTrackEnvelopeSchema),
          durationInFrames: PositiveFrameSchema,
        })
        .strict(),
    ),
    "Restore persistent Timeline fields from an editor history snapshot.",
    ["The snapshot was produced by the current editor history contract."],
  ),
  "timeline.action.SELECT_ITEM": editorAction(
    "timeline.action.SELECT_ITEM",
    actionWithPayload("SELECT_ITEM", IdentifierSchema.nullable()),
    "Select or clear one Timeline item in the editor session.",
  ),
  "timeline.action.SELECT_TRACK": editorAction(
    "timeline.action.SELECT_TRACK",
    actionWithPayload("SELECT_TRACK", IdentifierSchema.nullable()),
    "Select or clear one Timeline track in the editor session.",
  ),
  "timeline.action.SET_CURRENT_FRAME": editorAction(
    "timeline.action.SET_CURRENT_FRAME",
    actionWithPayload("SET_CURRENT_FRAME", FrameSchema),
    "Seek the editor playhead to an absolute Timeline frame.",
  ),
  "timeline.action.SET_PLAYING": editorAction(
    "timeline.action.SET_PLAYING",
    actionWithPayload("SET_PLAYING", z.boolean()),
    "Start or stop editor preview playback.",
  ),
  "timeline.action.SET_ZOOM": editorAction(
    "timeline.action.SET_ZOOM",
    actionWithPayload("SET_ZOOM", z.number().finite().positive()),
    "Set the Timeline viewport zoom level.",
  ),
  "timeline.action.ADD_ASSET": editorAction(
    "timeline.action.ADD_ASSET",
    actionWithPayload("ADD_ASSET", TimelineAssetEnvelopeSchema),
    "Add a media asset to the local editor asset collection.",
    ["The asset id is not already present in the editor collection."],
  ),
  "timeline.action.UPSERT_ASSET": editorAction(
    "timeline.action.UPSERT_ASSET",
    actionWithPayload("UPSERT_ASSET", TimelineAssetEnvelopeSchema),
    "Insert or replace a media asset in the local editor collection.",
  ),
  "timeline.action.SET_ASSET_TRANSCRIPT": editorAction(
    "timeline.action.SET_ASSET_TRANSCRIPT",
    actionWithPayload("SET_ASSET_TRANSCRIPT", TimelineTranscriptEnvelopeSchema),
    "Store an asset transcript and synchronize linked subtitle text.",
    [
      "The transcript word timings are expressed in the referenced immutable asset.",
    ],
  ),
  "timeline.action.REMOVE_ASSET": editorAction(
    "timeline.action.REMOVE_ASSET",
    actionWithPayload("REMOVE_ASSET", IdentifierSchema),
    "Remove a media asset from the local editor asset collection.",
  ),
  "timeline.action.SET_COMPOSITION_SIZE": editorAction(
    "timeline.action.SET_COMPOSITION_SIZE",
    actionWithPayload(
      "SET_COMPOSITION_SIZE",
      z
        .object({
          width: z.number().finite().int().positive(),
          height: z.number().finite().int().positive(),
        })
        .strict(),
    ),
    "Set positive pixel dimensions for the Timeline composition.",
  ),
  "timeline.action.SET_DURATION": editorAction(
    "timeline.action.SET_DURATION",
    actionWithPayload("SET_DURATION", PositiveFrameSchema),
    "Set the Timeline composition duration in frames.",
  ),
  "timeline.action.UNDO": editorAction(
    "timeline.action.UNDO",
    actionWithoutPayload("UNDO"),
    "Restore the previous persistent Timeline history snapshot.",
    [
      "The editor history has at least one past snapshot or an active changed group.",
    ],
  ),
  "timeline.action.REDO": editorAction(
    "timeline.action.REDO",
    actionWithoutPayload("REDO"),
    "Restore the next persistent Timeline history snapshot.",
    ["The editor history has at least one future snapshot."],
  ),
  "timeline.action.BEGIN_HISTORY_GROUP": editorAction(
    "timeline.action.BEGIN_HISTORY_GROUP",
    actionWithoutPayload("BEGIN_HISTORY_GROUP"),
    "Begin grouping related editor mutations into one undo step.",
  ),
  "timeline.action.END_HISTORY_GROUP": editorAction(
    "timeline.action.END_HISTORY_GROUP",
    actionWithoutPayload("END_HISTORY_GROUP"),
    "Commit the active editor mutation group as one undo step.",
    ["A Timeline editor history group is active."],
  ),
} satisfies Record<string, TimelineOperationAnnotation>;

export const TIMELINE_OPERATION_REGISTRY = Object.freeze({
  agent: Object.freeze(agent),
  editorCommands: Object.freeze(editorCommands),
  editorActions: Object.freeze(editorActions),
});

function catalogGroup(
  group: Record<string, TimelineOperationAnnotation>,
): Record<string, TimelineOperationCatalogEntry> {
  return Object.fromEntries(
    Object.entries(group).map(([id, value]) => {
      const {
        inputSchema: _inputSchema,
        outputSchema: _outputSchema,
        ...metadata
      } = value;
      return [
        id,
        {
          ...metadata,
          inputJsonSchema: zodToJsonSchema(value.inputSchema, {
            target: "jsonSchema7",
          }) as Record<string, unknown>,
          outputJsonSchema: zodToJsonSchema(value.outputSchema, {
            target: "jsonSchema7",
          }) as Record<string, unknown>,
        },
      ];
    }),
  );
}

export const TIMELINE_OPERATION_CATALOG = Object.freeze({
  agent: Object.freeze(catalogGroup(agent)),
  editorCommands: Object.freeze(catalogGroup(editorCommands)),
  editorActions: Object.freeze(catalogGroup(editorActions)),
});

export type TimelineAgentOperationId = keyof typeof agent;
export type TimelineEditorCommandId = keyof typeof editorCommands;
export type TimelineEditorActionId = keyof typeof editorActions;
export type TimelineOperationId =
  TimelineAgentOperationId | TimelineEditorCommandId | TimelineEditorActionId;
