import { loadTimelineDefinition } from "./timeline-definition.ts";
import { createNodeAuth } from "./auth.ts";
import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createNodeCloudApp } from "./app.ts";
import { createNodeUploadPorts } from "./content-upload.ts";
import { readConfig } from "./config.ts";
import { openPostgres } from "./postgres.ts";
import { createReplicaHttpGateway } from "./relay-http.ts";
import { createPostgresNotificationSource } from "./pg-notifications.ts";
import { shutdownNodeTelemetry } from "@clash/shared-telemetry/node";
import { apiNodeLog, errorFacts } from "./log.ts";

const log = apiNodeLog.child("server");

export function startServer(
  env: Record<string, string | undefined> = process.env,
) {
  const config = readConfig(env);
  const database = openPostgres({ connectionString: config.connectionString });
  const auth = env.BETTER_AUTH_SECRET
    ? createNodeAuth({
        pool: database.pool,
        publicUrl: config.publicUrl,
        secret: env.BETTER_AUTH_SECRET,
      })
    : undefined;
  const app = createNodeCloudApp({
    db: database.db,
    assetDirectory: env.CLOUD_ASSET_DIR,
    syncBaseUrl: config.publicUrl,
    auth,
    // Issue #130: monolith mode serves uploads in-process; set
    // CLOUD_CONTENT_DIR. For microservice mode run src/upload-server.ts instead.
    contentUpload: env.CLOUD_CONTENT_DIR
      ? createNodeUploadPorts({
          db: database.db,
          contentDirectory: env.CLOUD_CONTENT_DIR,
        })
      : undefined,
    timeline: env.BETTER_AUTH_SECRET
      ? {
          definition: loadTimelineDefinition(),
          receiptSecret: env.BETTER_AUTH_SECRET,
          // The outbox worker renders; this process admits renders and
          // serves the signed media render-server fetches.
          ...(config.renderServerUrl ? { render: {} } : {}),
        }
      : undefined,
  });
  const gateway = createReplicaHttpGateway({
    auth,
    publicUrl: config.publicUrl,
    db: database.db,
    notifications: createPostgresNotificationSource({
      connectionString: config.connectionString,
    }),
  });
  app.route("/", gateway.app);
  const server = createServer(getRequestListener(app.fetch));
  server.listen(config.port, config.hostname);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const deadline = setTimeout(() => server.closeAllConnections(), 10000);
      deadline.unref();
      try {
        await gateway.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        clearTimeout(deadline);
        await database.close();
      }
    })());
  return { server, close };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const running = startServer();
    running.server.on("error", (error) => {
      log.error("server.listener_failed", errorFacts(error));
      process.exitCode = 1;
      void running.close().catch(() => {});
    });
    // `on`, not `once`: under tsx a hidden signal handler exits the process
    // as soon as no app listener remains, cutting async shutdown short.
    // close() is idempotent, so a repeated signal is harmless.
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => {
        void running
          .close()
          .catch((error: unknown) => {
            log.error("server.shutdown_failed", errorFacts(error));
            process.exitCode = 1;
          })
          .finally(() => shutdownNodeTelemetry());
      });
  } catch (error) {
    // Check database and listener configuration.
    log.error("server.startup_failed", errorFacts(error));
    process.exitCode = 1;
  }
}
