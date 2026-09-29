import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { openPostgres } from "../postgres.ts";
import { createNodeCloudApp } from "../app.ts";
import { createReplicaHttpGateway } from "../relay-http.ts";
import { createPostgresNotificationSource } from "../pg-notifications.ts";
import { createPostgresOutbox } from "../replica-log.ts";
const database = openPostgres({ connectionString: process.env.DATABASE_URL });
if (process.env.CLUSTER_ROLE === "lease") {
  const leases = await createPostgresOutbox(database.db).claim({
    limit: 1,
    leaseMs: 1000,
  });
  process.send?.({ type: "lease", leases });
  setInterval(() => {}, 1000);
} else {
  const source = createPostgresNotificationSource({
    connectionString: process.env.DATABASE_URL,
    application_name: process.env.CLUSTER_NAME,
  });
  const gateway = createReplicaHttpGateway({
    db: database.db,
    pollMs: 60000,
    notifications: {
      start(notify, reconnected) {
        return source.start(notify, async () => {
          await reconnected();
          process.send?.({ type: "listen" });
        });
      },
    },
  });
  const app = createNodeCloudApp({
    db: database.db,
    syncBaseUrl: "http://127.0.0.1",
  });
  app.route("/", gateway.app);
  const server = createServer(getRequestListener(app.fetch));
  server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    if (a && typeof a !== "string")
      process.send?.({ type: "ready", port: a.port });
  });
  process.once("SIGTERM", () => {
    void (async () => {
      await gateway.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
      process.disconnect?.();
    })().catch(() => process.exit(1));
  });
}
