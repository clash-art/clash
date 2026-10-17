/**
 * Microservice mode (issue #130): a Node process that serves only Project
 * content uploads, with the same module and adapters as the monolith.
 *   DATABASE_URL=… CLOUD_CONTENT_DIR=/var/lib/clash/content PORT=8788 \
 *     tsx src/upload-server.ts
 */
import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { readConfig } from "./config.ts";
import { openPostgres } from "./postgres.ts";
import { createNodeUploadPorts, createUploadServer } from "./content-upload.ts";
import { apiNodeLog } from "./log.ts";

const log = apiNodeLog.child("upload-server");

export function startUploadServer(env: Record<string, string | undefined> = process.env) {
  const config = readConfig(env);
  if (!env.CLOUD_CONTENT_DIR) throw new Error("CLOUD_CONTENT_DIR is required");
  const database = openPostgres({ connectionString: config.connectionString });
  const app = createUploadServer(
    createNodeUploadPorts({
      db: database.db,
      contentDirectory: env.CLOUD_CONTENT_DIR,
      log: { log: (level, event, fields) => (log as any)[level]?.(event, fields) },
    }),
  );
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
  const running = startUploadServer();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => void running.close());
}
