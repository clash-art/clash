import { Hono } from "hono";
import type { Env } from "../../config";
import { createProjectContentRoutes } from "./project-content";
import { projectRoutes } from "./projects";
import { varsRoutes } from "./vars";
import { sessionRoutes } from "./sessions";
import { cliAuthRoutes } from "./cli-auth";
import { runtimesRoutes } from "./runtimes";
import { sessionsRuntimeRoutes } from "./sessions-runtime";
import { agentRoutes } from "./agents";
import { modelProviderRoutes } from "./model-providers";
import { providerUsageRoutes } from "./provider-usage";

export const v1Routes = new Hono<{ Bindings: Env }>();

v1Routes.route("/projects", createProjectContentRoutes());
v1Routes.route("/projects", projectRoutes);
v1Routes.route("/vars", varsRoutes);
v1Routes.route("/sessions", sessionRoutes);
v1Routes.route("/cli-auth", cliAuthRoutes);
v1Routes.route("/runtimes", runtimesRoutes);
v1Routes.route("/agents", agentRoutes);
v1Routes.route("/", modelProviderRoutes);
v1Routes.route("/", providerUsageRoutes);
// Local-runtime session lifecycle (BYO local agent; distinct from cloud
// /api/v1/sessions). Browser opens WS to /api/v1/local-sessions/:id/_stream
// for the duplex event/prompt stream. Session creation lives next to it
// at POST /api/v1/runtimes/:rid/sessions (registered inside runtimes.ts).
v1Routes.route("/local-sessions", sessionsRuntimeRoutes);

// Health check
v1Routes.get("/", (c) => c.json({ version: "v1", status: "ok" }));

// GET /api/v1/me — resolve the calling user from the x-user-id header
// (set by the /api/v1/* middleware from cookie OR API token).
//
// Used by the CLI's `clash canvas add` (Phase 0 attribution) to stamp
// `data.actorUserId` onto the nodes it creates: the CLI doesn't carry
// the user id directly — it only has the API token — so this endpoint
// is the single round-trip translator. Cheap enough to call inline
// without caching; the CLI does one add per command.
v1Routes.get("/me", (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  return c.json({ id: userId });
});
