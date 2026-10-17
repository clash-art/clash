/**
 * Microservice mode (issue #138): a Node process that serves only the
 * metadata routes, with the same module and adapters as the monolith.
 *   DATABASE_URL=… PORT=8790 tsx src/metadata-server.ts
 */
import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { readConfig } from "./config.ts";
import { openPostgres } from "./postgres.ts";
import { createMetadataServer, createNodeMetadataPorts } from "./metadata-service.ts";

export function startMetadataServer(env: Record<string, string | undefined> = process.env) {
  const config = readConfig(env);
  const database = openPostgres({ connectionString: config.connectionString });
  const app = createMetadataServer(createNodeMetadataPorts({ db: database.db as never }));
  const server = createServer(getRequestListener(app.fetch));
  server.listen(config.port, config.hostname);
  return {
    server,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await database.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const running = startMetadataServer();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => void running.close());
}
