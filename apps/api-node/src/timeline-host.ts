import { createHmac, randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  Canvas,
  ProjectHostCommandSchema,
  agentReadReceiptToken,
  projectTimelineReadToken,
  validateAgentReadProof,
  validateCanvasDelete,
  type GeneratorDefinition,
  type ProjectTimeline,
} from "@clash/shared-types";
import {
  createLocalTimelineGenerator,
  listLocalTimelineGenerators,
  readLocalTimelineGenerator,
  advanceLocalTimelineGenerator,
  attachLocalTimelineGeneratorToCanvas,
  detachLocalTimelineGeneratorFromCanvas,
  deleteLocalTimelineGenerator,
} from "@clash/shared-runtime/timeline-generator-product";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { withProjectDocument } from "./project-document.ts";

export interface TimelineHostOptions {
  definition: GeneratorDefinition;
  receiptSecret: string;
}
class CommandFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 501 = 409,
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
export function createTimelineHostRoutes(
  db: PostgresTransactionPort,
  options: TimelineHostOptions,
) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.post("/:id/host-command", async (c) => {
    const parsed = ProjectHostCommandSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { code: "INVALID_COMMAND", error: "Invalid project command" },
        400,
      );
    const cmd = parsed.data;
    const projectId = c.req.param("id"),
      userId = c.get("userId");
    const sign = (version: string) =>
      createHmac("sha256", options.receiptSecret)
        .update(JSON.stringify(["timeline", userId, projectId, version]))
        .digest("base64url");
    const envelope = (timeline: ProjectTimeline) => {
      const version = projectTimelineReadToken(timeline);
      return {
        timeline,
        version,
        readToken: agentReadReceiptToken({
          readToken: version,
          receipt: sign(version),
        }),
      };
    };
    try {
      const body = await withProjectDocument(
        db,
        userId,
        projectId,
        cmd.action !== "list_timelines",
        (doc) => {
          const definition = options.definition;
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
            expectedReadToken:
              typeof cmd.ifMatch === "string" ? cmd.ifMatch : undefined,
            requireReceipt: true,
            readReceiptVerifier: (p) =>
              p.namespace === "timeline" &&
              typeof p.baseReadToken === "string" &&
              p.receipt === sign(p.baseReadToken),
          });
          if (!proof.ok)
            throw new CommandFailure(
              proof.code ?? "READ_REQUIRED",
              proof.error,
            );
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
                      : randomUUID(),
                  position: cmd.position as
                    { x: number; y: number } | undefined,
                }),
              ).timeline,
            );
          if (cmd.action === "detach_timeline")
            return envelope(
              unwrap(
                detachLocalTimelineGeneratorFromCanvas(
                  doc,
                  definition,
                  current.id,
                ),
              ).timeline,
            );
          if (current.owner.kind === "canvas-action") {
            const canvas = new Canvas(doc, () => {}, current.owner.canvasId);
            const guard = validateCanvasDelete({
              nodeId: current.owner.actionNodeId,
              edges: canvas.listEdges(),
            });
            if (!guard.ok)
              throw new CommandFailure("IMMUTABLE_NODE", guard.error);
            const node = canvas.readNode(current.owner.actionNodeId);
            if (node?.data.timelineId === current.id)
              canvas.deleteNode(current.owner.actionNodeId);
          }
          unwrap(
            deleteLocalTimelineGenerator(doc, definition, {
              timelineId: current.id,
              expectedHeadRevisionId: current.revisionId,
              operationId: randomUUID(),
            }),
          );
          return { deleted: true, timelineId: current.id };
        },
      );
      return c.json(body);
    } catch (error) {
      if (error instanceof CommandFailure)
        return c.json({ code: error.code, error: error.message }, error.status);
      if (error instanceof Error && error.message === "Project not found")
        return c.json({ code: "PROJECT_NOT_FOUND", error: error.message }, 404);
      throw error;
    }
  });
  return app;
}
