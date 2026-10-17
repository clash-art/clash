import { createHmac, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { GeneratorDefinition } from "@clash/shared-types";
import {
  executeTimelineHostCommand,
  parseTimelineHostCommand,
  timelineReceiptMessage,
  type TimelineHostCommandResult,
} from "@clash/shared-runtime/cloud-project-host/timeline-commands";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { withProjectDocument } from "./project-document.ts";

export interface TimelineHostOptions {
  definition: GeneratorDefinition;
  receiptSecret: string;
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
    };
    try {
      const result = await withProjectDocument<TimelineHostCommandResult>(
        db,
        userId,
        projectId,
        (executed) => executed.mutated,
        (doc) => executeTimelineHostCommand(doc, parsed.command, ports),
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
