/**
 * CLI entry for the test-only mock upstream (#378).
 * Bind loopback by default; refuse non-loopback unless explicitly allowed.
 *
 *   pnpm --filter @clash/api-node mock-upstream
 *   MOCK_UPSTREAM_PORT=9090 tsx --tsconfig tsconfig.check.json src/mock-upstream/cli.ts
 */
import { serve } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { createMockUpstreamApp } from "./app.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function readListen(
  env: Record<string, string | undefined>,
): { host: string; port: number } {
  const host = (env.MOCK_UPSTREAM_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const allowNonLoopback = env.MOCK_UPSTREAM_ALLOW_NON_LOOPBACK === "1";
  if (!LOOPBACK.has(host) && !allowNonLoopback) {
    throw new Error(
      `mock-upstream refuses non-loopback bind (${host}); set MOCK_UPSTREAM_ALLOW_NON_LOOPBACK=1 only for isolated test networks`,
    );
  }
  const port = Number(env.MOCK_UPSTREAM_PORT ?? 9090);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("MOCK_UPSTREAM_PORT must be an integer between 1 and 65535");
  return { host, port };
}

export function main(env: Record<string, string | undefined> = process.env) {
  const { host, port } = readListen(env);
  const { app } = createMockUpstreamApp();
  const server = serve({ fetch: app.fetch, hostname: host, port });
  const addr = server.address();
  const bound =
    addr && typeof addr !== "string"
      ? `${addr.address}:${addr.port}`
      : `${host}:${port}`;
  // Never log secrets; this process only ever sees fake sk_test_* keys.
  console.log(
    JSON.stringify({
      msg: "mock-upstream listening",
      bind: bound,
      role: "mock-upstream",
      test_only: true,
    }),
  );
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: "mock-upstream.startup_failed",
        error_name: error instanceof Error ? error.name : typeof error,
        error_message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
