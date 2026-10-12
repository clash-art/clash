// Namespace import: a named `tracing` import would fail module linking on a
// workerd build that predates the export; property access yields undefined.
import * as workers from "cloudflare:workers";
import { installWorkersTracing } from "@clash/shared-telemetry/cloudflare";
import { serverLog } from "./logger";
import { cleanupProjectContentUploads } from "./services/project-content-multipart";
import { recoverHostedGenerations } from "./generation/recovery";
import type { Env } from "./config";
import { createApp } from "./app";
import { ProjectRoom } from "./agents/project-room";
import { SupervisorAgent } from "./agents/supervisor";
import { GenerationWorkflow } from "./agents/generation";
import { RuntimeRoom } from "./agents/runtime-room";

// Route @opentelemetry/api spans (and the logger's trace correlation) through
// the platform tracer, exported by the [observability.traces] destinations.
installWorkersTracing(workers.tracing);

// CF runtime swallows wrapper-chain async rejections inside DO lifecycle
// hooks (webSocketClose, webSocketMessage, …) — surfaces them as
// `outcome=exception` with empty exceptions[] in `wrangler tail`. We've
// tried several layers of try/catch wraps and the throw still escapes,
// which means it's coming from a microtask scheduled OUTSIDE the handler's
// await chain (event listeners, fire-and-forget promises in third-party
// libs). This last-resort handler at least prints the reason + stack so we
// stop chasing ghosts. preventDefault() suppresses the runtime's exception
// outcome so a microtask leak doesn't take the DO with it.
if (typeof addEventListener === "function") {
  addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    serverLog.error("worker.unhandled_rejection", { error: reason });
    e.preventDefault();
  });
}

// OSS entry: no plugins. Downstream / hosted entry points
// (e.g. apps/api-cf-hosted) call createApp({ plugins: [...] })
// to install billing / quota / BYOK key resolution.
const app = createApp();

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([recoverHostedGenerations(env), cleanupProjectContentUploads(env.R2_BUCKET)]));
  },
};
export { recoverHostedGenerations };

// Export Durable Object classes, Workflow, and Container
export { ProjectRoom, SupervisorAgent, GenerationWorkflow, RuntimeRoom };
export { RenderContainer } from "./containers/render";
