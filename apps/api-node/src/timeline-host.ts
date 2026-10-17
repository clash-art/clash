import { createHmac, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { GeneratorDefinition } from "@clash/shared-types";
import type { DurableRunClock } from "@clash/shared-runtime/durable-run-engine";
import {
  executeTimelineHostCommand,
  parseTimelineHostCommand,
  timelineReceiptMessage,
  type TimelineHostCommandResult,
} from "@clash/shared-runtime/cloud-project-host/timeline-commands";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { withProjectDocument } from "./project-document.ts";
import { admitNodeTimelineRender } from "./timeline-render.ts";

export interface TimelineHostOptions {
  definition: GeneratorDefinition;
  receiptSecret: string;
  /**
   * Present when this deployment executes Timeline renders (RENDER_SERVER_URL):
   * `request_timeline_render` is admitted to the durable render queue, and the
   * signed media route render-server reads from is mounted. Absent, the
   * shared command answers 501.
   */
  render?: { clock?: DurableRunClock };
}

/** Postgres storage port for the shared Timeline Host commands. */
export function createTimelineHostRoutes(
  db: PostgresTransactionPort,
  options: TimelineHostOptions,
) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.post("/:id/host-command", async (c) => {
    const parsed = parseTimelineHostCommand(
      await c.req.json().catch(() => null),
    );
    if (!parsed.ok) return c.json(parsed.result.body, 400);
    const projectId = c.req.param("id"),
      userId = c.get("userId");
    const ports = {
      definitions: [options.definition],
      sign: (version: string) =>
        createHmac("sha256", options.receiptSecret)
          .update(timelineReceiptMessage(userId, projectId, version))
          .digest("base64url"),
      newId: () => randomUUID(),
      ...(options.render ? { timelineRender: { actorUserId: userId } } : {}),
    };
    const render = options.render;
    try {
      const result = await withProjectDocument<TimelineHostCommandResult>(
        db,
        userId,
        projectId,
        (executed) => executed.mutated,
        async (doc, tx) => {
          const executed = executeTimelineHostCommand(doc, parsed.command, ports);
          // Same transaction as the node the command created: claimed and
          // journaled together, or the whole command rolls back.
          if (
            render &&
            parsed.command.action === "request_timeline_render" &&
            executed.mutated
          )
            await admitNodeTimelineRender({
              doc,
              tx,
              projectId,
              renderNodeId: (executed.body as { renderNodeId: string })
                .renderNodeId,
              ...(render.clock ? { clock: render.clock } : {}),
            });
          return executed;
        },
      );
      return c.json(result.body, result.status as ContentfulStatusCode);
    } catch (error) {
      if (error instanceof Error && error.message === "Project not found")
        return c.json({ code: "PROJECT_NOT_FOUND", error: error.message }, 404);
      throw error;
    }
  });
  return app;
}
