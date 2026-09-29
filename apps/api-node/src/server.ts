import { loadTimelineDefinition } from "./timeline-definition.ts";
import { createNodeAuth } from "./auth.ts";
import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createNodeCloudApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { openPostgres } from "./postgres.ts";
import { createReplicaHttpGateway } from "./relay-http.ts";
import { createPostgresNotificationSource } from "./pg-notifications.ts";

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
    timeline: env.BETTER_AUTH_SECRET
      ? {
          definition: loadTimelineDefinition(),
          receiptSecret: env.BETTER_AUTH_SECRET,
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
    running.server.on("error", () => {
      console.error("Node cloud listener failed");
      process.exitCode = 1;
      void running.close().catch(() => {});
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void running.close().catch(() => {
          console.error("Node cloud shutdown failed");
          process.exitCode = 1;
        });
      });
  } catch {
    console.error(
      "Node cloud startup failed; check database and listener configuration",
    );
    process.exitCode = 1;
  }
}
