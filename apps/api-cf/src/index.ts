// Namespace import: a named `tracing` import would fail module linking on a
// workerd build that predates the export; property access yields undefined.
import * as workers from "cloudflare:workers";
import { installWorkersTracing } from "@clash/shared-telemetry/cloudflare";
import { serverLog } from "./logger";
import type { Env } from "./config";
import { createApp } from "./app";
// Lazy shells: the implementation modules load on each object's first event
// instead of at Worker startup (#161).
import { ProjectRoom, SupervisorAgent } from "./agents/lazy";
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
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Separate waitUntil calls: one failing job must not cancel the others.
    // Durable Run recovery covers gateway settle runs too (#399).
    ctx.waitUntil(recoverCloudDurableRuns(env));
    ctx.waitUntil(
      import("./services/project-content-multipart").then((m) =>
        m.cleanupProjectContentUploads(env.R2_BUCKET),
      ),
    );
    // Gateway body retention (#353): delete bodies past their 30 days. Runs
    // whatever GATEWAY_STAFF_PROMPT_ACCESS says, so turning it off strands none.
    ctx.waitUntil(
      import("./gateway/d1-retention").then((m) => m.purgeGatewayRetention(env)),
    );
    // Gateway abuse thresholds (#356): alert, auto-suspend once per window,
    // and drop observations past the longest window. Idempotent.
    ctx.waitUntil(
      import("./gateway/d1-abuse").then((m) => m.evaluateGatewayAbuseNow(env)),
    );
    // Gateway usage retention and reconciliation (#355), on the every-minute
    // cron: metadata (30 days) and ledger (13 months) retention once an hour,
    // upstream reconciliation once a night (gateway-usage.md).
    ctx.waitUntil(
      import("./gateway/scheduled").then((m) => m.runScheduledGatewayUsageJobs(env, event.scheduledTime)),
    );
    // Lazy like the other cron graphs; abandoned import staging has no hero
    // request to piggyback on.
    ctx.waitUntil(
      import("./services/project-asset-import-staging").then((m) =>
        m.sweepProjectAssetImportStagingBucket(
          env.R2_BUCKET,
          serverLog.child("project-asset-import-staging"),
        ),
      ),
    );
  },
};

/** Cron recovery; its generation runtime graph loads on first call (#161). */
export async function recoverCloudDurableRuns(
  env: Env,
  now?: number,
): Promise<void> {
  const recovery = await import("./generation/recovery");
  return recovery.recoverCloudDurableRuns(env, now);
}

// Export Durable Object classes, Workflow, and Container
export { ProjectRoom, SupervisorAgent, GenerationWorkflow, RuntimeRoom };
export { RenderContainer } from "./containers/render";
