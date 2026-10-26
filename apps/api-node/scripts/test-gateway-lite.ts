#!/usr/bin/env node
/**
 * Gateway lite multi-process harness (#379): >=3 `src/server.ts` gateway
 * processes + the #378 mock upstream + race worker processes against ONE real
 * Postgres. No load balancer (the harness round-robins over node ports).
 *
 *   # an existing disposable loopback Postgres (admin URL; a fresh database is created and dropped)
 *   GATEWAY_LITE_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *     pnpm --filter @clash/api-node test:gateway-lite
 *
 *   # or an ephemeral postgres:16 container, removed afterwards
 *   GATEWAY_LITE_DOCKER=1 pnpm --filter @clash/api-node test:gateway-lite
 *   (GATEWAY_LITE_DOCKER_CMD="sudo -n docker" when the docker socket needs sudo)
 *
 * Neither set: prints a skip notice and exits 0, so CI without Postgres stays green.
 * GATEWAY_LITE_REPORT=path writes the JSON report there (default: a tmp file,
 * path printed). GATEWAY_LITE_NODES=n runs n (>=3) gateway processes.
 * Only loopback Postgres is accepted. Never point this at production.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { env, stdio: "inherit" });
  return new Promise<number>((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => accept(code ?? (signal ? 1 : 0)));
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no local port");
  await new Promise<void>((accept) => server.close(() => accept()));
  return address.port;
}

let url = process.env.GATEWAY_LITE_DATABASE_URL;
let container: string | undefined;
const docker = (process.env.GATEWAY_LITE_DOCKER_CMD ?? "docker")
  .split(" ")
  .filter(Boolean);
const dockerRun = (args: string[]) =>
  spawnSync(docker[0]!, [...docker.slice(1), ...args], { encoding: "utf8" });

if (
  !url &&
  (process.env.GATEWAY_LITE_DOCKER === "1" || process.argv.includes("--docker"))
) {
  const port = await freePort();
  container = `clash-gateway-lite-${process.pid}`;
  const started = dockerRun([
    "run",
    "-d",
    "--rm",
    "--name",
    container,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_USER=clash_test",
    "-p",
    `127.0.0.1:${port}:5432`,
    process.env.GATEWAY_LITE_PG_IMAGE ?? "postgres:16",
    "-c",
    "max_connections=300",
  ]);
  if (started.status !== 0) {
    console.error(
      `gateway-lite: could not start a Postgres container: ${started.stderr.trim()}`,
    );
    process.exit(1);
  }
  const deadline = Date.now() + 60_000;
  while (
    dockerRun([
      "exec",
      container,
      "pg_isready",
      "-U",
      "clash_test",
      "-h",
      "127.0.0.1",
    ]).status !== 0
  ) {
    if (Date.now() > deadline) {
      dockerRun(["rm", "-f", container]);
      console.error("gateway-lite: Postgres container did not become ready");
      process.exit(1);
    }
    await delay(500);
  }
  url = `postgresql://clash_test@127.0.0.1:${port}/postgres`;
}

if (!url) {
  console.log(
    "gateway-lite: SKIPPED — set GATEWAY_LITE_DATABASE_URL (disposable loopback Postgres admin URL) or GATEWAY_LITE_DOCKER=1",
  );
  process.exit(0);
}

const report =
  process.env.GATEWAY_LITE_REPORT ??
  join(tmpdir(), `gateway-lite-report-${Date.now()}.json`);
let code = 1;
try {
  code = await run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      resolve(import.meta.dirname, "../vitest.gateway-lite.config.ts"),
      "--maxWorkers=1",
      ...process.argv.slice(2).filter((a) => a !== "--docker"),
    ],
    {
      ...process.env,
      GATEWAY_LITE_DATABASE_URL: url,
      GATEWAY_LITE_REPORT: report,
    },
  );
  console.log(`gateway-lite: JSON report at ${report}`);
} finally {
  if (container) dockerRun(["rm", "-f", container]);
}
process.exit(code);
