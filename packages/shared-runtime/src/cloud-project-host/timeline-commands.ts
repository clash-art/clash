/**
 * Storage-agnostic Timeline Host commands for cloud adapters (api-node, api-cf).
 *
 * Command in, JSON out: the caller loads one Project Loro document, runs one
 * command and persists only when `mutated` is true. A failed command may leave
 * partial edits in `doc`; callers discard the document (or the fork they ran
 * on) instead of persisting it. Timeline semantics come from the installed
 * `clash.timeline` Generator Definition, resolved exactly like local-api.
 */
import type { LoroDoc } from "loro-crdt";
import {
  Canvas,
  ProjectHostCommandSchema,
  agentReadReceiptToken,
  projectTimelineReadToken,
  resolveGeneratorProjectionDefinition,
  validateAgentReadProof,
  validateCanvasDelete,
  type GeneratorDefinition,
  type ProjectHostCommand,
  type ProjectTimeline,
} from "@clash/shared-types";
import {
  advanceLocalTimelineGenerator,
  attachLocalTimelineGeneratorToCanvas,
  createLocalTimelineGenerator,
  deleteLocalTimelineGenerator,
  detachLocalTimelineGeneratorFromCanvas,
  listLocalTimelineGenerators,
  readLocalTimelineGenerator,
} from "../timeline-generator-product.js";

export interface TimelineHostCommandPorts {
  /** Generator Definitions installed for this adapter (see createCloudPluginCatalog). */
  definitions: readonly GeneratorDefinition[];
  /** Receipt for one observed Timeline version, scoped by the adapter to user and project. */
  sign(version: string): string;
  newId(): string;
}

export interface TimelineHostCommandResult {
  status: number;
  body: unknown;
  /** Persist the document only when true. */
  mutated: boolean;
}

/** The signed message, so every adapter's receipts verify identically. */
export function timelineReceiptMessage(
  userId: string,
  projectId: string,
  version: string,
): string {
  return JSON.stringify(["timeline", userId, projectId, version]);
}

export const TIMELINE_HOST_ACTIONS = [
  "list_timelines",
  "create_timeline",
  "update_timeline_state",
  "attach_timeline",
  "detach_timeline",
  "delete_timeline",
] as const satisfies readonly ProjectHostCommand["action"][];

/** Parse a raw request body; an invalid command answers 400 without touching storage. */
export function parseTimelineHostCommand(
  raw: unknown,
):
  | { ok: true; command: ProjectHostCommand }
  | { ok: false; result: TimelineHostCommandResult } {
  const parsed = ProjectHostCommandSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, command: parsed.data }
    : {
        ok: false,
        result: {
          status: 400,
          body: { code: "INVALID_COMMAND", error: "Invalid project command" },
          mutated: false,
        },
      };
}

class CommandFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 501 | 503 = 409,
  ) {
    super(message);
  }
}

function unwrap<T extends { ok: boolean }>(
  result: T,
): Extract<T, { ok: true }> {
  if (!result.ok) {
    const error = (result as T & { error: { code: string; message: string } })
      .error;
    throw new CommandFailure(
      error.code,
      error.message,
      error.code.endsWith("_NOT_FOUND") ? 404 : 409,
    );
  }
  return result as Extract<T, { ok: true }>;
}

function isTimelineHostAction(
  action: ProjectHostCommand["action"],
): action is (typeof TIMELINE_HOST_ACTIONS)[number] {
  return (TIMELINE_HOST_ACTIONS as readonly string[]).includes(action);
}

function run(
  doc: LoroDoc,
  cmd: ProjectHostCommand,
  definition: GeneratorDefinition,
  ports: TimelineHostCommandPorts,
): unknown {
  const envelope = (timeline: ProjectTimeline) => {
    const version = projectTimelineReadToken(timeline);
    return {
      timeline,
      version,
      readToken: agentReadReceiptToken({
        readToken: version,
        receipt: ports.sign(version),
      }),
    };
  };
  if (cmd.action === "list_timelines") {
    const listed = unwrap(listLocalTimelineGenerators(doc, definition));
    return {
      timelines: listed.timelines,
      versions: Object.fromEntries(
        listed.timelines.map((t) => [t.id, envelope(t).readToken]),
      ),
    };
  }
  if (cmd.action === "create_timeline") {
    const created = unwrap(
      createLocalTimelineGenerator(doc, definition, {
        id: String(cmd.timelineId),
        name: String(cmd.name),
        owner: { kind: "project" },
        revisionId: "genesis",
        state: cmd.state ?? { tracks: [] },
      }),
    );
    const placement = cmd.placement as
      | {
          canvasId: string;
          actionNodeId: string;
          position?: { x: number; y: number };
        }
      | undefined;
    return envelope(
      placement
        ? unwrap(
            attachLocalTimelineGeneratorToCanvas(doc, definition, {
              timelineId: created.timeline.id,
              ...placement,
            }),
          ).timeline
        : created.timeline,
    );
  }
  if (
    cmd.action !== "update_timeline_state" &&
    cmd.action !== "attach_timeline" &&
    cmd.action !== "detach_timeline" &&
    cmd.action !== "delete_timeline"
  )
    throw new CommandFailure(
      "COMMAND_UNAVAILABLE",
      "This project command is not connected on this server.",
      501,
    );
  const current = unwrap(
    readLocalTimelineGenerator(doc, definition, String(cmd.timelineId)),
  ).timeline;
  // Every writer must carry the observation obtained with its draft. The
  // signed receipt is scoped to this account and project across API restarts.
  const proof = validateAgentReadProof({
    actorClientType: "agent",
    operation: "Timeline change",
    currentReadToken: projectTimelineReadToken(current),
    expectedReadToken: typeof cmd.ifMatch === "string" ? cmd.ifMatch : undefined,
    requireReceipt: true,
    readReceiptVerifier: (p) =>
      p.namespace === "timeline" &&
      typeof p.baseReadToken === "string" &&
      p.receipt === ports.sign(p.baseReadToken),
  });
  if (!proof.ok)
    throw new CommandFailure(proof.code ?? "READ_REQUIRED", proof.error);
  if (cmd.action === "update_timeline_state")
    return envelope(
      unwrap(
        advanceLocalTimelineGenerator(doc, definition, {
          ...current,
          state: cmd.state,
        }),
      ).timeline,
    );
  if (cmd.action === "attach_timeline")
    return envelope(
      unwrap(
        attachLocalTimelineGeneratorToCanvas(doc, definition, {
          timelineId: current.id,
          canvasId: String(cmd.canvasId),
          actionNodeId:
            typeof cmd.actionNodeId === "string"
              ? cmd.actionNodeId
              : ports.newId(),
          position: cmd.position as { x: number; y: number } | undefined,
        }),
      ).timeline,
    );
  if (cmd.action === "detach_timeline")
    return envelope(
      unwrap(
        detachLocalTimelineGeneratorFromCanvas(doc, definition, current.id),
      ).timeline,
    );
  if (current.owner.kind === "canvas-action") {
    const canvas = new Canvas(doc, () => {}, current.owner.canvasId);
    const guard = validateCanvasDelete({
      nodeId: current.owner.actionNodeId,
      edges: canvas.listEdges(),
    });
    if (!guard.ok) throw new CommandFailure("IMMUTABLE_NODE", guard.error);
    const node = canvas.readNode(current.owner.actionNodeId);
    if (node?.data.timelineId === current.id)
      canvas.deleteNode(current.owner.actionNodeId);
  }
  unwrap(
    deleteLocalTimelineGenerator(doc, definition, {
      timelineId: current.id,
      expectedHeadRevisionId: current.revisionId,
      operationId: ports.newId(),
    }),
  );
  return { deleted: true, timelineId: current.id };
}

/**
 * Execute one Timeline Host command against `doc`. Unsupported actions answer
 * 501 COMMAND_UNAVAILABLE (never 404), so clients can tell a missing executor
 * from a missing Timeline.
 */
export function executeTimelineHostCommand(
  doc: LoroDoc,
  command: ProjectHostCommand,
  ports: TimelineHostCommandPorts,
): TimelineHostCommandResult {
  if (!isTimelineHostAction(command.action))
    return {
      status: 501,
      body: {
        code: "COMMAND_UNAVAILABLE",
        error: "This project command is not connected on this server.",
      },
      mutated: false,
    };
  const resolved = resolveGeneratorProjectionDefinition(
    ports.definitions,
    "clash.timeline",
  );
  if (!resolved.ok)
    return {
      status: resolved.code === "GENERATOR_PROJECTION_SURFACE_AMBIGUOUS" ? 409 : 503,
      body: {
        code: resolved.code,
        error: `Generator projection surface ${resolved.surfaceId} could not be resolved`,
      },
      mutated: false,
    };
  try {
    return {
      status: 200,
      body: run(doc, command, resolved.definition, ports),
      mutated: command.action !== "list_timelines",
    };
  } catch (error) {
    if (error instanceof CommandFailure)
      return {
        status: error.status,
        body: { code: error.code, error: error.message },
        mutated: false,
      };
    throw error;
  }
}
