/**
 * ProjectRoom adapter for the shared Timeline Host commands (issue #180).
 *
 * This is the Cloudflare composition root for `host-command`: the Durable
 * Object supplies the live Loro document, its serial write queue, persistence
 * and broadcast; the platform-agnostic `executeTimelineHostCommand` decides
 * everything else. Loaded with a dynamic import from ProjectRoom so neither
 * the Timeline product code, the plugin catalog nor the generated validators
 * enter Worker startup.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { LoroDoc } from "loro-crdt";
import {
  completeTimelineRenderNode,
  projectTimelineRenderActionRunId,
  requestTimelineRevisionRender,
} from "@clash/shared-types";
import {
  executeTimelineHostCommand,
  parseTimelineHostCommand,
  readHostTimeline,
  timelineReceiptMessage,
  type TimelineHostCommandResult,
} from "@clash/shared-runtime/cloud-project-host/timeline-commands";
import { observeProjectAsset } from "@clash/shared-runtime/cloud-project-host/project-assets";
import { cloudPluginCatalog } from "../services/cloud-plugin-catalog";
import { requireSecret } from "../services/require-secret";

/** What ProjectRoom lends this adapter; nothing else of the room is visible. */
export interface ProjectRoomHostCommandPort {
  projectId: string;
  doc(): LoroDoc;
  /** Current owner record from the shared project authority (D1). */
  readProject(): Promise<{ ownerId: string; deletedAt: number | null } | null>;
  /** Run `work` as one item of the room's serial Loro write queue. */
  serialize<T>(work: () => Promise<T>): Promise<T>;
  /** Durably append `update` (validates and applies it to the live doc). */
  persist(update: Uint8Array): Promise<void>;
  broadcast(update: Uint8Array): void;
  env: { ENVIRONMENT: string; JWT_SECRET?: string };
}

const READ_ONLY_ACTIONS = new Set<string>(["list_timelines"]);

const notFound = (): TimelineHostCommandResult => ({
  status: 404,
  body: { code: "PROJECT_NOT_FOUND", error: "Project not found" },
  mutated: false,
});

export function timelineReceiptSigner(
  env: ProjectRoomHostCommandPort["env"],
  userId: string,
  projectId: string,
) {
  const secret = requireSecret(
    env,
    "JWT_SECRET",
    env.JWT_SECRET,
    "dev-project-host-receipt-secret",
  );
  // Same algorithm and encoding as api-node, so receipts look alike everywhere.
  return (version: string) =>
    createHmac("sha256", secret)
      .update(timelineReceiptMessage(userId, projectId, version))
      .digest("base64url");
}

async function owned(port: ProjectRoomHostCommandPort, userId: string) {
  const project = await port.readProject();
  return !!project && project.ownerId === userId && project.deletedAt === null;
}

export async function runProjectRoomHostCommand(
  port: ProjectRoomHostCommandPort,
  input: unknown,
): Promise<{ status: number; body: unknown }> {
  const raw = input as { userId?: unknown; command?: unknown } | null;
  const userId = typeof raw?.userId === "string" ? raw.userId : "";
  if (!userId) return { status: 401, body: { error: "unauthorized" } };
  const parsed = parseTimelineHostCommand(raw?.command);
  if (!parsed.ok) return { status: 400, body: parsed.result.body };
  const ports = {
    definitions: cloudPluginCatalog().generatorDefinitions(),
    sign: timelineReceiptSigner(port.env, userId, port.projectId),
    newId: () => randomUUID(),
    // The Cloudflare adapter owns a render executor: the pending node the
    // shared command creates is picked up by the existing RENDER_CONTAINER
    // pipeline (NodeProcessor -> GenerationWorkflow). api-node binds the
    // same port only when its render queue is configured.
    timelineRender: { actorUserId: userId },
  };
  const command = parsed.command;
  if (READ_ONLY_ACTIONS.has(command.action)) {
    if (!(await owned(port, userId))) return notFound();
    const { status, body } = executeTimelineHostCommand(port.doc(), command, ports);
    return { status, body };
  }
  const result = await port.serialize(async () => {
    // Ownership may have changed while the command waited for the queue.
    if (!(await owned(port, userId))) return notFound();
    const live = port.doc();
    const fork = live.fork();
    const executed = executeTimelineHostCommand(fork, command, ports);
    if (!executed.mutated) return executed;
    fork.commit({ origin: "host-command" });
    const update = fork.export({ mode: "update", from: live.oplogVersion() });
    if (update.byteLength > 0) {
      await port.persist(update);
      port.broadcast(update);
    }
    return executed;
  });
  return { status: result.status, body: result.body };
}
/**
 * Publishes bytes a render adapter produced itself (the browser render
 * adapter) as the same render node the container pipeline writes: the node
 * is created through the shared pending-render constructor and completed
 * before the room commits, so NodeProcessor never sees it as pending and
 * no second render starts. Same node projection as durable render publication.
 */
export async function runProjectRoomTimelineRenderCompletion(
  port: ProjectRoomHostCommandPort,
  input: unknown,
): Promise<{ status: number; body: unknown }> {
  const raw = input as
    | { userId?: unknown; timelineId?: unknown; assetId?: unknown }
    | null;
  const userId = typeof raw?.userId === "string" ? raw.userId : "";
  const timelineId =
    typeof raw?.timelineId === "string" ? raw.timelineId.trim() : "";
  const assetId = typeof raw?.assetId === "string" ? raw.assetId.trim() : "";
  if (!userId) return { status: 401, body: { error: "unauthorized" } };
  if (!timelineId || !assetId)
    return {
      status: 400,
      body: { error: "timelineId and assetId are required" },
    };
  if (!(await owned(port, userId))) return notFound();
  return port.serialize(async () => {
    if (!(await owned(port, userId))) return notFound();
    const live = port.doc();
    const fork = live.fork();
    // Same read as the Timeline Host commands: hosted Timelines are
    // `clash.timeline` Project Generators, not entries of the legacy map.
    const timeline = readHostTimeline(
      fork,
      cloudPluginCatalog().generatorDefinitions(),
      timelineId,
    );
    if (!timeline)
      return { status: 404, body: { error: "Timeline not found" } };
    // Only an Asset already imported into this Project can be published.
    if (!observeProjectAsset(fork, port.projectId, assetId))
      return { status: 404, body: { error: "Asset not found" } };
    // Idempotent per (Timeline, Asset): a retried publication whose first
    // response was lost returns the existing node instead of a second one.
    const existing = publishedRenderNodeId(fork, timelineId, assetId);
    if (existing)
      return {
        status: 200,
        body: {
          submitted: true,
          renderNodeId: existing,
          actionRunId: projectTimelineRenderActionRunId(existing),
        },
      };
    const created = requestTimelineRevisionRender(fork, {
      timeline,
      actorUserId: userId,
      generateId: () => randomUUID(),
    });
    if (!created.ok) return { status: 400, body: { error: created.error } };
    const completed = completeTimelineRenderNode(fork, {
      renderNodeId: created.renderNodeId,
      assetId,
    });
    if (!completed.ok) return { status: 400, body: { error: completed.error } };
    fork.commit({ origin: "host-command" });
    const update = fork.export({ mode: "update", from: live.oplogVersion() });
    if (update.byteLength > 0) {
      await port.persist(update);
      port.broadcast(update);
    }
    return {
      status: 200,
      body: {
        submitted: true,
        renderNodeId: created.renderNodeId,
        actionRunId: projectTimelineRenderActionRunId(created.renderNodeId),
      },
    };
  });
}

function publishedRenderNodeId(
  doc: LoroDoc,
  timelineId: string,
  assetId: string,
): string | undefined {
  for (const [nodeId, value] of Object.entries(
    doc.getMap("nodes").toJSON() as Record<string, { data?: Record<string, unknown> }>,
  )) {
    const data = value?.data;
    if (
      data?.sourceTimelineId === timelineId &&
      data.assetId === assetId &&
      data.status === "completed"
    )
      return nodeId;
  }
  return undefined;
}
