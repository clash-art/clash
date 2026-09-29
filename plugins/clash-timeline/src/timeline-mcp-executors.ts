import {
  TIMELINE_OPERATION_REGISTRY,
  type TimelineAgentOperationId,
} from "@clash/shared-types/timeline-contract";
import {
  timelineWorkspaceCwd,
  type TimelineAdapter,
} from "./adapter.js";
import type { TimelineToolInput } from "./contract.js";
import {
  assertTimelineState,
  TIMELINE_CONTRACT_SUMMARY,
  TIMELINE_GET_OUTPUT_SCHEMA,
  timelineOperationInputSchema,
  timelineOperationOutputSchema,
  validateTimelineState,
  type TimelineMcpZodSchema,
} from "./timeline-contract-adapter.js";

export type TimelineMcpExecutor = {
  title: string;
  inputSchema: TimelineMcpZodSchema;
  outputSchema: TimelineMcpZodSchema;
  execute(input: TimelineToolInput, adapter: TimelineAdapter): Promise<unknown>;
  summary(value: unknown): string;
};

function listOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const rebaseLocalRefs = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) rebaseLocalRefs(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
      record.$ref = `#/properties/items/${record.$ref.slice(2)}`;
    }
    for (const entry of Object.values(record)) rebaseLocalRefs(entry);
  };
  rebaseLocalRefs(schema);
  delete schema.$schema;
  return {
    type: "object",
    properties: { items: schema },
    required: ["items"],
    additionalProperties: false,
  };
}

function jsonSummary(value: unknown): string {
  return JSON.stringify(value);
}

function transportScope(input: TimelineToolInput): TimelineToolInput {
  return {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  };
}

export const TIMELINE_MCP_EXECUTORS = {
  "timeline.open": {
    title: "Open Clash Timeline",
    inputSchema: timelineOperationInputSchema("timeline.open"),
    outputSchema: timelineOperationOutputSchema("timeline.open"),
    async execute(input, adapter) {
      const timelines = await adapter.list({ ...input, full: true });
      const selected = input.timelineId
        ? timelines.find((timeline) => timeline.id === input.timelineId)
        : timelines[0];
      if (input.timelineId && !selected) {
        throw new Error(`Timeline ${input.timelineId} not found`);
      }
      return { cwd: timelineWorkspaceCwd(input), timelines, selected };
    },
    summary(value) {
      const count = Array.isArray((value as { timelines?: unknown[] })?.timelines)
        ? (value as { timelines: unknown[] }).timelines.length
        : 0;
      return `Opened Clash Timeline with ${count} timeline${count === 1 ? "" : "s"}.`;
    },
  },
  "timeline.schema": {
    title: "Read Timeline DSL schema",
    inputSchema: timelineOperationInputSchema("timeline.schema"),
    outputSchema: timelineOperationOutputSchema("timeline.schema"),
    execute: (input, adapter) => adapter.schema(input),
    summary: (value) =>
      (value as { view?: unknown })?.view === "authoring"
        ? "Returned compact Timeline authoring discovery."
        : "Returned the complete machine-readable Timeline YAML DSL contract.",
  },
  "timeline.validate": {
    title: "Validate Timeline DSL",
    inputSchema: timelineOperationInputSchema("timeline.validate"),
    outputSchema: timelineOperationOutputSchema("timeline.validate"),
    execute(input, adapter) {
      if (input.document && typeof input.document !== "string") {
        assertTimelineState(input.document);
      }
      return adapter.validate({
        ...transportScope(input),
        ...(typeof input.document === "string"
          ? { document: input.document }
          : { state: input.document }),
        ...(input.format === undefined ? {} : { format: input.format }),
      });
    },
    summary: () => "Timeline DSL validation passed without mutation.",
  },
  "timeline.list": {
    title: "List timelines",
    inputSchema: timelineOperationInputSchema("timeline.list"),
    outputSchema: timelineOperationOutputSchema(
      "timeline.list",
      listOutputSchema,
      (output) => output.items,
    ),
    execute: (input, adapter) => adapter.list(input),
    summary: jsonSummary,
  },
  "timeline.get": {
    title: "Read timeline",
    inputSchema: timelineOperationInputSchema("timeline.get"),
    outputSchema: TIMELINE_GET_OUTPUT_SCHEMA,
    async execute(input, adapter) {
      const timeline = await adapter.get(input);
      return {
        timeline,
        contract: TIMELINE_CONTRACT_SUMMARY,
        validation: validateTimelineState(timeline.state),
      };
    },
    summary: jsonSummary,
  },
  "timeline.create": {
    title: "Create timeline",
    inputSchema: timelineOperationInputSchema("timeline.create"),
    outputSchema: timelineOperationOutputSchema("timeline.create"),
    async execute(input, adapter) {
      if (input.state) assertTimelineState(input.state);
      const transportInput: TimelineToolInput = {
        ...transportScope(input),
        timelineId: input.id,
        name: input.name,
      };
      const created = await adapter.create(transportInput);
      if (!input.state) return created;
      const current = await adapter.get(transportInput);
      if (!current.revisionId) {
        throw new Error(`Timeline ${input.id} did not expose a revisionId after creation`);
      }
      await adapter.save({
        ...transportInput,
        baseRevisionId: current.revisionId,
        state: input.state,
      });
      return adapter.get(transportInput);
    },
    summary: jsonSummary,
  },
  "timeline.save": {
    title: "Save timeline",
    inputSchema: timelineOperationInputSchema("timeline.save"),
    outputSchema: timelineOperationOutputSchema("timeline.save"),
    execute(input, adapter) {
      assertTimelineState(input.state);
      return adapter.save(input);
    },
    summary: () => "Timeline projection validated and applied.",
  },
  "timeline.attach": {
    title: "Attach timeline to Canvas",
    inputSchema: timelineOperationInputSchema("timeline.attach"),
    outputSchema: timelineOperationOutputSchema("timeline.attach"),
    execute: (input, adapter) => adapter.attach({
      ...transportScope(input),
      timelineId: input.timelineId,
      canvasId: input.canvasId,
      ...(input.actionNodeId === undefined ? {} : { nodeId: input.actionNodeId }),
      ...(input.position === undefined ? {} : { position: input.position }),
    }),
    summary: jsonSummary,
  },
  "timeline.detach": {
    title: "Detach timeline",
    inputSchema: timelineOperationInputSchema("timeline.detach"),
    outputSchema: timelineOperationOutputSchema("timeline.detach"),
    execute: (input, adapter) => adapter.detach(input),
    summary: jsonSummary,
  },
  "timeline.copy": {
    title: "Copy timeline",
    inputSchema: timelineOperationInputSchema("timeline.copy"),
    outputSchema: timelineOperationOutputSchema("timeline.copy"),
    execute: (input, adapter) => adapter.copy({
      ...transportScope(input),
      timelineId: input.sourceTimelineId,
      canvasId: input.targetCanvasId,
      ...(input.newTimelineId === undefined ? {} : { newTimelineId: input.newTimelineId }),
      ...(input.newActionNodeId === undefined ? {} : { newNodeId: input.newActionNodeId }),
      ...(input.position === undefined ? {} : { position: input.position }),
    }),
    summary: jsonSummary,
  },
  "timeline.render": {
    title: "Render timeline",
    inputSchema: timelineOperationInputSchema("timeline.render"),
    outputSchema: timelineOperationOutputSchema("timeline.render"),
    execute: (input, adapter) => adapter.render({
      ...transportScope(input),
      timelineId: input.timelineId,
      ...(input.wait === undefined ? {} : { wait: input.wait }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }),
    summary: jsonSummary,
  },
} satisfies Partial<Record<TimelineAgentOperationId, TimelineMcpExecutor>>;

type ExecutorTable = Partial<Record<TimelineAgentOperationId, TimelineMcpExecutor>>;

export function sharedTimelineMcpOperationIds(): TimelineAgentOperationId[] {
  return Object.entries(TIMELINE_OPERATION_REGISTRY.agent)
    .filter(([, operation]) => operation.surfaceBindings?.some(
      (binding) => binding.startsWith("mcp:"),
    ))
    .map(([operationId]) => operationId as TimelineAgentOperationId);
}

export function assertTimelineMcpExecutorCoverage(
  executors: ExecutorTable = TIMELINE_MCP_EXECUTORS,
): void {
  const expected = new Set(sharedTimelineMcpOperationIds());
  const actual = Object.keys(executors) as TimelineAgentOperationId[];
  const missing = [...expected].filter((operationId) => !executors[operationId]);
  const extra = actual.filter((operationId) => !expected.has(operationId));
  if (missing.length || extra.length) {
    throw new Error([
      missing.length ? `Missing Timeline MCP executors: ${missing.join(", ")}` : "",
      extra.length ? `Non-MCP Timeline executors: ${extra.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }
}

assertTimelineMcpExecutorCoverage();

export function timelineMcpExecutor(
  operationId: TimelineAgentOperationId,
): TimelineMcpExecutor {
  const executor = (TIMELINE_MCP_EXECUTORS as ExecutorTable)[operationId];
  if (!executor) {
    throw new Error(`Missing Timeline MCP executor: ${operationId}`);
  }
  return executor;
}
