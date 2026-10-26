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
import {
  createGatewayBackgroundWork,
  createGatewayNodeRoutes,
  createPgGatewayPorts,
  gatewayRole,
} from "./gateway-node.ts";
import { createPgGatewayCredentialStore } from "./gateway-credentials.ts";
import { gatewayKeyRingFromEnv } from "./gateway-keyring.ts";
import { createPgGatewayLimitPort } from "./gateway-limits.ts";
import { startGatewayMaintenance } from "./gateway-maintenance.ts";
import {
  createGatewayDrainController,
  createGatewayHealthRoutes,
  gatewayDrainTimingsFromEnv,
  runGatewayDrain,
} from "./gateway-health.ts";

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
    providerSecretKey: config.providerSecretKey,
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
  // Model gateway data plane (#367): api role only (role matrix: #373).
  let stopGatewayMaintenance: (() => void) | undefined;
  // Settlements of streams whose caller left (#368); drained before the pool closes.
  const gatewayWork = createGatewayBackgroundWork();
  // Drain state and open streams of this node (#375).
  const drain = createGatewayDrainController();
  const role = gatewayRole(env);
  const ring = role === "api" ? gatewayKeyRingFromEnv(env) : undefined;
  app.route(
    "/",
    createGatewayHealthRoutes({
      db: database.db,
      drain,
      work: gatewayWork,
      ...(ring ? { ring } : {}),
      blobDirectories: [env.CLOUD_CONTENT_DIR, env.CLOUD_ASSET_DIR].filter(
        (directory): directory is string => !!directory,
      ),
    }),
  );
  if (ring) {
    const limits = createPgGatewayLimitPort(database.db);
    const ports = createPgGatewayPorts({
      db: database.db,
      credentials: createPgGatewayCredentialStore({
        db: database.db,
        ring,
      }),
      limits,
      ...(auth
        ? {
            session: async (headers: Headers) => {
              const session = await auth.api.getSession({ headers });
              return session ? { userId: session.user.id } : null;
            },
          }
        : {}),
    });
    app.route("/", createGatewayNodeRoutes(ports, { work: gatewayWork, drain }));
    stopGatewayMaintenance = startGatewayMaintenance({
      db: database.db,
      limits,
      onError: (error) =>
        log.error("gateway.maintenance_failed", errorFacts(error)),
    });
  }
  const server = createServer(getRequestListener(app.fetch));
  server.listen(config.port, config.hostname);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  const timings = gatewayDrainTimingsFromEnv(env);
  let closing: Promise<void> | undefined;
  // SIGTERM drain (#375): readyz 503 → delay → stop accepting → grace →
  // GATEWAY_DRAINING to open streams → settle → close sockets → close pool.
  const close = () =>
    (closing ??= runGatewayDrain({
      drain,
      work: gatewayWork,
      server,
      timings,
      onStopAccepting: async () => {
        stopGatewayMaintenance?.();
        await gateway.close();
      },
      closeDatabase: () => database.close(),
      onStep: (step, facts) => log.info(`gateway.drain_${step}`, facts ?? {}),
    }).then(() => undefined));
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
