/**
 * `POST /api/v1/projects/:id/host-command` on the hosted Worker (issue #180).
 *
 * Thin HTTP shell: authenticate, check project ownership against the shared
 * project authority, and hand the command to the project's ProjectRoom, which
 * runs the shared platform-agnostic Timeline commands. Same request and
 * response contract as apps/local-api and apps/api-node.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../../config";
import { createD1ProjectAuthorizationStore } from "../../loro/authorization-store";

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: any): { fetch(request: Request): Promise<Response> };
}

/** Room port: deliver one command to the project's Durable Object. */
export function createProjectRoomHostCommandPort(room: DurableObjectNamespaceLike) {
  return async (projectId: string, userId: string, command: unknown) => {
    const response = await room.get(room.idFromName(projectId)).fetch(
      new Request(
        `http://internal/loro/${encodeURIComponent(projectId)}/host-command`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-internal-loro": "true",
            "x-loro-project-id": projectId,
          },
          body: JSON.stringify({ userId, command }),
        },
      ),
    );
    return {
      status: response.status,
      body: (await response.json().catch(() => ({
        code: "HOST_COMMAND_FAILED",
        error: "Project command failed",
      }))) as unknown,
    };
  };
}

export function createProjectHostCommandRoutes() {
  const routes = new Hono<{ Bindings: Env }>();
  routes.post("/:id/host-command", async (c) => {
    const userId = c.req.header("x-user-id");
    if (!userId) return c.json({ error: "unauthorized" }, 401);
    const projectId = c.req.param("id");
    const command = await c.req.json().catch(() => null);
    const project = await createD1ProjectAuthorizationStore(c.env).readProject(
      projectId,
    );
    if (!project || project.ownerId !== userId || project.deletedAt !== null)
      return c.json({ code: "PROJECT_NOT_FOUND", error: "Project not found" }, 404);
    const { status, body } = await createProjectRoomHostCommandPort(
      c.env.ROOM as never,
    )(projectId, userId, command);
    return c.json(body as object, status as ContentfulStatusCode);
  });
  return routes;
}
