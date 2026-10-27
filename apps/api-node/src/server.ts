import { loadTimelineDefinition } from "./timeline-definition.ts";
import { createNodeAuth } from "./auth.ts";
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
import { readGatewaySettlementFloor } from "./gateway-budget.ts";
import { createPgGatewayCredentialStore } from "./gateway-credentials.ts";
import { createPgGatewayBilling, createPgGatewayPriceBook } from "./gateway-billing.ts";
import {
  createGatewayAdminApp,
  createGatewayHttpServers,
  gatewayAdminListenerFromEnv,
} from "./gateway-admin.ts";
import { createPgGatewayAdminTokens } from "./gateway-admin-tokens.ts";
import { createGatewayBillingTenantRoutes, gatewayBillingPurchaseConfigFromEnv } from "./gateway-billing-routes.ts";
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
    // Tenant credit billing (#425), before the data plane's /api/v1/gateway/* catch-all.
    app.route(
      "/",
      createGatewayBillingTenantRoutes({
        billing: createPgGatewayBilling({ db: database.db }),
        db: database.db,
        session: async (headers: Headers) => {
          const session = auth ? await auth.api.getSession({ headers }) : null;
          return session ? { userId: session.user.id } : null;
        },
        purchase: gatewayBillingPurchaseConfigFromEnv(env),
      }),
    );
    app.route(
      "/",
      createGatewayNodeRoutes(ports, {
        work: gatewayWork,
        drain,
        // The text credit floor knob (#399): the same gateway_config value the
        // settle run's postpaid charge caps at.
        app: { creditFloor: () => readGatewaySettlementFloor(database.db) },
      }),
    );
    stopGatewayMaintenance = startGatewayMaintenance({
      db: database.db,
      limits,
      onError: (error) =>
        log.error("gateway.maintenance_failed", errorFacts(error)),
    });
  }
  // Admin API on its own listener (#371, N14), only when GATEWAY_ADMIN_PORT
  // is set; the public listener answers 404 for /api/v1/admin/* either way.
  const adminListener = gatewayAdminListenerFromEnv(env, config.port);
  let adminApp: ReturnType<typeof createGatewayAdminApp> | undefined;
  if (adminListener) {
    const adminRing = ring ?? (role === "admin" ? gatewayKeyRingFromEnv(env) : undefined);
    adminApp = createGatewayAdminApp({
      db: database.db,
      tokens: createPgGatewayAdminTokens({ db: database.db }),
      billing: createPgGatewayBilling({ db: database.db }),
      priceBook: createPgGatewayPriceBook({ db: database.db }),
      ...(adminRing
        ? {
            keyRing: {
              ring: adminRing,
              store: createPgGatewayCredentialStore({ db: database.db, ring: adminRing }),
            },
          }
        : {}),
      allowedOrigins: adminListener.allowedOrigins,
    });
  }
  const { server, adminServer } = createGatewayHttpServers({
    publicFetch: app.fetch,
    ...(adminApp ? { adminFetch: adminApp.fetch } : {}),
  });
  server.listen(config.port, config.hostname);
  if (adminListener) adminServer?.listen(adminListener.port, adminListener.hostname);
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
        if (adminServer) {
          const closed = new Promise<void>((resolve) => adminServer!.close(() => resolve()));
          adminServer.closeAllConnections();
          await closed;
        }
        await gateway.close();
      },
      closeDatabase: () => database.close(),
      onStep: (step, facts) => log.info(`gateway.drain_${step}`, facts ?? {}),
    }).then(() => undefined));
  return { server, adminServer, close };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const running = startServer();
    for (const listener of [running.server, running.adminServer])
      listener?.on("error", (error) => {
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
