#!/usr/bin/env node
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "clash-pg-cluster-"));
const binary = (name: string) =>
  process.env.PG_BIN ? join(process.env.PG_BIN, name) : name;
async function run(command: string, args: string[], env = process.env) {
  const child = spawn(command, args, { env, stdio: "inherit" });
  await new Promise<void>((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? accept()
        : reject(Error(`${command} exited ${code ?? signal}`)),
    );
  });
}
const socket = createServer();
await new Promise<void>((accept) => socket.listen(0, "127.0.0.1", accept));
const address = socket.address();
if (!address || typeof address === "string") throw Error("No local port");
const port = address.port;
await new Promise<void>((accept, reject) =>
  socket.close((error) => (error ? reject(error) : accept())),
);
const data = join(root, "data");
let started = false;
try {
  await run(binary("initdb"), [
    "-D",
    data,
    "-U",
    "clash_test",
    "--auth=trust",
    "--no-locale",
    "-E",
    "UTF8",
  ]);
  await run(binary("pg_ctl"), [
    "-D",
    data,
    "-l",
    join(root, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${root}`,
    "-w",
    "start",
  ]);
  started = true;
  await run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      resolve(import.meta.dirname, "../vitest.cluster.config.ts"),
      ...process.argv.slice(2),
      "--testTimeout",
      "300000",
    ],
    {
      ...process.env,
      CLUSTER_POSTGRES_URL: `postgresql://clash_test@127.0.0.1:${port}/postgres`,
    },
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  try {
    console.error(
      (await readFile(join(root, "postgres.log"), "utf8")).slice(-8000),
    );
  } catch {}
  process.exitCode = 1;
} finally {
  if (started)
    await run(binary("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(root, { recursive: true, force: true });
}
