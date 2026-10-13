import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFilePath,
  getServerUrl,
  loadConfig,
  requireApiKey,
  saveConfig,
} from "./config";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clash-cli-config-"));
}

test("config path honors CLASH_HOME", () => {
  assert.equal(
    configFilePath({ CLASH_HOME: "/tmp/clash-home" }),
    "/tmp/clash-home/config.yaml",
  );
});

test("server URL follows the active host in the selected profile home", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const originalApiUrl = process.env.CLASH_API_URL;
  const clashHome = await tempDir();
  process.env.CLASH_HOME = clashHome;
  delete process.env.CLASH_API_URL;
  await mkdir(join(clashHome, "run"), { recursive: true });
  await writeFile(join(clashHome, "run", "host.json"), JSON.stringify({
    schemaVersion: 1,
    protocolVersion: 1,
    dataSchemaVersion: 1,
    hostId: "profile-host",
    endpoint: "http://127.0.0.1:49329",
    pid: process.pid,
    launchMode: "desktop",
    startedBy: "desktop",
    startedAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  }), "utf8");
  try {
    assert.equal(getServerUrl(), "http://127.0.0.1:49329");
  } finally {
    if (originalClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalClashHome;
    if (originalApiUrl === undefined) delete process.env.CLASH_API_URL;
    else process.env.CLASH_API_URL = originalApiUrl;
  }
});

test("server URL never crosses an explicitly mismatched host profile", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const originalProfile = process.env.CLASH_PROFILE;
  const originalApiUrl = process.env.CLASH_API_URL;
  const clashHome = await tempDir();
  process.env.CLASH_HOME = clashHome;
  process.env.CLASH_PROFILE = "dev";
  delete process.env.CLASH_API_URL;
  await mkdir(join(clashHome, "run"), { recursive: true });
  await writeFile(join(clashHome, "run", "host.json"), JSON.stringify({
    schemaVersion: 1,
    protocolVersion: 1,
    dataSchemaVersion: 1,
    hostId: "production-host",
    endpoint: "http://127.0.0.1:49321",
    pid: process.pid,
    launchMode: "desktop",
    startedBy: "desktop",
    profile: "prod",
    startedAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  }), "utf8");
  try {
    assert.equal(getServerUrl(), "http://localhost:8788");
  } finally {
    if (originalClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalClashHome;
    if (originalProfile === undefined) delete process.env.CLASH_PROFILE;
    else process.env.CLASH_PROFILE = originalProfile;
    if (originalApiUrl === undefined) delete process.env.CLASH_API_URL;
    else process.env.CLASH_API_URL = originalApiUrl;
  }
});

test("saved CLI config uses owner-only permissions", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const clashHome = await tempDir();
  process.env.CLASH_HOME = clashHome;
  try {
    saveConfig({ apiKey: "clsh_test", serverUrl: "http://localhost:8788" });

    assert.deepEqual(loadConfig(), {
      apiKey: "clsh_test",
      serverUrl: "http://localhost:8788",
    });
    const configInfo = await stat(configFilePath());
    const credentialsInfo = await stat(join(clashHome, "credentials.json"));
    assert.equal(configInfo.mode & 0o777, 0o600);
    assert.equal(credentialsInfo.mode & 0o777, 0o600);
    assert.match(await readFile(configFilePath(), "utf8"), /url: http:\/\/localhost:8788/);
    assert.doesNotMatch(await readFile(configFilePath(), "utf8"), /clsh_test/);
    assert.match(await readFile(join(clashHome, "credentials.json"), "utf8"), /clsh_test/);
  } finally {
    if (originalClashHome === undefined) {
      delete process.env.CLASH_HOME;
    } else {
      process.env.CLASH_HOME = originalClashHome;
    }
  }
});

test("saving a credential without a server URL works on a fresh home", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const clashHome = join(await tempDir(), "fresh");
  process.env.CLASH_HOME = clashHome;
  try {
    saveConfig({ apiKey: "clsh_test" });
    assert.deepEqual(loadConfig(), { apiKey: "clsh_test" });

    saveConfig({});
    assert.deepEqual(loadConfig(), {});
  } finally {
    if (originalClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalClashHome;
  }
});

test("clearing the server URL keeps unrelated config and tolerates a non-map server", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const clashHome = await tempDir();
  process.env.CLASH_HOME = clashHome;
  try {
    await writeFile(configFilePath(), "server:\n  url: http://localhost:8788\n  name: dev\n", "utf8");
    saveConfig({ apiKey: "clsh_test" });
    assert.deepEqual(loadConfig(), { apiKey: "clsh_test" });
    assert.match(await readFile(configFilePath(), "utf8"), /name: dev/);

    await writeFile(configFilePath(), "server: null\n", "utf8");
    saveConfig({ apiKey: "clsh_test" });
    assert.deepEqual(loadConfig(), { apiKey: "clsh_test" });
  } finally {
    if (originalClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalClashHome;
  }
});

test("setting the server URL replaces a non-map server", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const clashHome = await tempDir();
  process.env.CLASH_HOME = clashHome;
  try {
    for (const server of ["server: null", "server:", "server: dev", "server:\n  - dev"]) {
      await writeFile(configFilePath(), `${server}\nname: kept\n`, "utf8");
      saveConfig({ apiKey: "clsh_test", serverUrl: "http://localhost:8788" });
      assert.deepEqual(
        loadConfig(),
        { apiKey: "clsh_test", serverUrl: "http://localhost:8788" },
        server,
      );
      assert.match(await readFile(configFilePath(), "utf8"), /name: kept/);
    }
  } finally {
    if (originalClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalClashHome;
  }
});

test("loopback local-api use does not require a cloud credential", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  const originalApiKey = process.env.CLASH_API_KEY;
  process.env.CLASH_HOME = await tempDir();
  delete process.env.CLASH_API_KEY;
  try {
    assert.equal(requireApiKey("http://127.0.0.1:49321"), "");
    assert.equal(requireApiKey("http://localhost:49321"), "");
    assert.equal(requireApiKey("http://[::1]:49321"), "");
  } finally {
    if (originalClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalClashHome;
    if (originalApiKey === undefined) delete process.env.CLASH_API_KEY;
    else process.env.CLASH_API_KEY = originalApiKey;
  }
});
