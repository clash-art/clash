import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCliLocalDaemon } from "./local-daemon-bootstrap";
import type { LocalHostDiscoveryRecord } from "@clash/shared-runtime";

const active: LocalHostDiscoveryRecord = {
  schemaVersion: 1,
  protocolVersion: 1,
  dataSchemaVersion: 1,
  hostId: "cli-daemon",
  endpoint: "http://127.0.0.1:49321",
  pid: process.pid,
  launchMode: "user-service",
  startedBy: "cli",
  profile: "prod",
  startedAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

test("CLI actively starts a missing daemon and binds subsequent commands to it", async () => {
  const clashHome = await mkdtemp(join(tmpdir(), "clash-cli-daemon-"));
  const runDir = join(clashHome, "run");
  const env: NodeJS.ProcessEnv = { CLASH_HOME: clashHome, CLASH_PROFILE: "prod" };
  let launches = 0;

  const record = await ensureCliLocalDaemon({
    env,
    daemonEntryPath: "/opt/clash/local-api.cjs",
    cliEntryPath: "/opt/clash/clash-cli.cjs",
    probeHost: async () => true,
    launch: async () => {
      launches += 1;
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "host.json"), JSON.stringify(active), "utf8");
      return { pid: process.pid };
    },
  });

  assert.equal(launches, 1);
  assert.ok(record, "bootstrap must return the discovery record it settled on");
  assert.equal(record.hostId, active.hostId);
  assert.equal(env.CLASH_API_URL, active.endpoint);
});

test("CLI honors an explicit API URL without starting the local daemon", async () => {
  const env: NodeJS.ProcessEnv = { CLASH_API_URL: "https://clash.example.test" };
  let launches = 0;
  const record = await ensureCliLocalDaemon({
    env,
    daemonEntryPath: "/opt/clash/local-api.cjs",
    cliEntryPath: "/opt/clash/clash-cli.cjs",
    launch: async () => {
      launches += 1;
      return { pid: process.pid };
    },
  });

  assert.equal(record, undefined);
  assert.equal(launches, 0);
  assert.equal(env.CLASH_API_URL, "https://clash.example.test");
});

test("CLI does not retire a Host that advertises no runtime fingerprint", async () => {
  const clashHome = await mkdtemp(join(tmpdir(), "clash-cli-daemon-unknown-"));
  const runDir = join(clashHome, "run");
  const env: NodeJS.ProcessEnv = { CLASH_HOME: clashHome, CLASH_PROFILE: "prod" };
  await mkdir(runDir, { recursive: true });
  // Desktop-style launch from an older build: no fingerprint was recorded.
  await writeFile(join(runDir, "host.json"), JSON.stringify(active), "utf8");
  let launches = 0;

  const record = await ensureCliLocalDaemon({
    env,
    daemonEntryPath: "/opt/clash/local-api.cjs",
    cliEntryPath: "/opt/clash/clash-cli.cjs",
    runtimeFingerprint: "sha256:new",
    probeHost: async () => ({ healthy: true, attachedClients: 1 }),
    launch: async () => {
      launches += 1;
      return { pid: process.pid };
    },
  });

  assert.equal(launches, 0);
  assert.equal(record?.hostId, active.hostId);
});
