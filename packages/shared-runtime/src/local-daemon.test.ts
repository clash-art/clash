import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalDaemonBootstrap,
  launchDetachedLocalDaemon,
  resolveLocalDaemonRuntimeFingerprint,
  type LocalDaemonLaunchResult,
} from "./local-daemon.js";
import {
  LOCAL_HOST_DATA_SCHEMA_VERSION,
  LOCAL_HOST_PROTOCOL_VERSION,
  LOCAL_HOST_RECORD_SCHEMA_VERSION,
  type LocalHostDiscoveryRecord,
} from "./index.js";

function record(
  overrides: Partial<LocalHostDiscoveryRecord> = {},
): LocalHostDiscoveryRecord {
  return {
    schemaVersion: LOCAL_HOST_RECORD_SCHEMA_VERSION,
    protocolVersion: LOCAL_HOST_PROTOCOL_VERSION,
    dataSchemaVersion: LOCAL_HOST_DATA_SCHEMA_VERSION,
    hostId: "daemon-1",
    endpoint: "http://127.0.0.1:49321",
    pid: process.pid,
    launchMode: "user-service",
    startedBy: "plugin",
    profile: "prod",
    startedAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

async function publish(
  runDir: string,
  value: LocalHostDiscoveryRecord,
): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "host.json"), JSON.stringify(value), "utf8");
}

describe("local daemon bootstrap", () => {
  it("starts the Host in its writable data directory instead of the desktop launcher's cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-daemon-cwd-"));
    const dataDir = join(root, "local-api");
    let spawnedCwd: string | URL | undefined;
    try {
      launchDetachedLocalDaemon({
        entryPath: "/opt/clash/clashd.cjs",
        dataDir,
        runDir: join(root, "run"),
        cliEntryPath: "/opt/clash/clash.cjs",
        spawnProcess: (_command, _args, options) => {
          spawnedCwd = options.cwd;
          return { pid: 4242, unref() {} };
        },
      });
      expect(spawnedCwd).toBe(dataDir);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
      await mkdir(join(dataDir, ".renderer-cache"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("fingerprints the runtime artifact content instead of its filesystem location", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-daemon-fingerprint-"));
    const first = join(root, "first.cjs");
    const second = join(root, "second.cjs");
    await writeFile(first, "module.exports = 'same';\n", "utf8");
    await writeFile(second, "module.exports = 'same';\n", "utf8");

    const before = resolveLocalDaemonRuntimeFingerprint(first);
    expect(resolveLocalDaemonRuntimeFingerprint(second)).toBe(before);

    await writeFile(second, "module.exports = 'changed';\n", "utf8");
    expect(resolveLocalDaemonRuntimeFingerprint(second)).not.toBe(before);
  });

  it("invalidates a packaged Host when an adjacent bundled plugin changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-plugin-fingerprint-"));
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      for (const directory of [first, second]) {
        await mkdir(join(directory, "bundled-plugins", "asset-edit", "dist"), {
          recursive: true,
        });
        await writeFile(
          join(directory, "local-api.cjs"),
          "host entry stays unchanged",
        );
        await writeFile(
          join(directory, "bundled-plugins", "asset-edit", "dist", "stdio.mjs"),
          "old adapter",
        );
      }
      const before = resolveLocalDaemonRuntimeFingerprint(
        join(first, "local-api.cjs"),
      );
      expect(
        resolveLocalDaemonRuntimeFingerprint(join(second, "local-api.cjs")),
      ).toBe(before);
      await writeFile(
        join(second, "bundled-plugins", "asset-edit", "dist", "stdio.mjs"),
        "fixed adapter",
      );
      expect(
        resolveLocalDaemonRuntimeFingerprint(join(second, "local-api.cjs")),
      ).not.toBe(before);
      await rm(join(second, "bundled-plugins"), { recursive: true });
      expect(
        resolveLocalDaemonRuntimeFingerprint(join(second, "local-api.cjs")),
      ).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates a Host when only its served project renderer changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-renderer-fingerprint-"));
    try {
      const entry = join(root, "local-api.cjs");
      await writeFile(entry, "unchanged host entry");
      await mkdir(join(root, "project-ui", "_app"), { recursive: true });
      const editor = join(root, "project-ui", "_app", "editor.js");
      await writeFile(editor, "old scroll implementation");
      const before = resolveLocalDaemonRuntimeFingerprint(entry);
      await writeFile(editor, "fixed scroll implementation");
      expect(resolveLocalDaemonRuntimeFingerprint(entry)).not.toBe(before);
      await rm(join(root, "project-ui"), { recursive: true });
      expect(resolveLocalDaemonRuntimeFingerprint(entry)).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retires a Host when the staged dependency identity changes without changing its entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-dependency-fingerprint-"));
    try {
      const entry = join(root, "local-api.cjs");
      const identity = join(root, "runtime-dependencies.sha256");
      await writeFile(entry, "unchanged host entry");
      const legacy = resolveLocalDaemonRuntimeFingerprint(entry);
      await writeFile(identity, "first staged dependency payload\n");
      const first = resolveLocalDaemonRuntimeFingerprint(entry);
      expect(first).not.toBe(legacy);
      expect(resolveLocalDaemonRuntimeFingerprint(entry)).toBe(first);
      await writeFile(identity, "fixed staged dependency payload\n");
      expect(resolveLocalDaemonRuntimeFingerprint(entry)).not.toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("launches a detached daemon that outlives the initiating client", async () => {
    let spawnOptions: Record<string, unknown> | undefined;
    let unrefs = 0;
    const launched = launchDetachedLocalDaemon({
      entryPath: "/opt/clash/clashd.cjs",
      dataDir: "/tmp/clash/local-api",
      runDir: "/tmp/clash/run",
      cliEntryPath: "/opt/clash/clash.cjs",
      runtimeFingerprint: "sha256:runtime-a",
      env: { CLASH_PROFILE: "prod" },
      spawnProcess: (_command, _args, options) => {
        spawnOptions = options as Record<string, unknown>;
        return {
          pid: 4242,
          unref: () => {
            unrefs += 1;
          },
        } as never;
      },
    });

    expect(launched.pid).toBe(4242);
    expect(spawnOptions).toMatchObject({
      detached: true,
      stdio: "ignore",
      env: {
        CLASH_PROFILE: "prod",
        CLASH_LOCAL_DATA_DIR: "/tmp/clash/local-api",
        CLASH_HOST_RUN_DIR: "/tmp/clash/run",
        CLASH_CLI_ENTRY_PATH: "/opt/clash/clash.cjs",
        CLASH_LOCAL_API_WRAPPER_ENTRY: "1",
        CLASH_DAEMON_RUNTIME_FINGERPRINT: "sha256:runtime-a",
        PORT: "0",
      },
    });
    expect(unrefs).toBe(1);
  });

  it("captures early daemon output in one truncated diagnostic file", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-daemon-diagnostics-"));
    const diagnosticLogPath = join(root, "host-startup.log");
    let spawnOptions: import("node:child_process").SpawnOptions | undefined;

    await writeFile(diagnosticLogPath, "stale failure\n", "utf8");
    launchDetachedLocalDaemon({
      entryPath: "/opt/clash/clashd.cjs",
      dataDir: "/tmp/clash/local-api",
      runDir: "/tmp/clash/run",
      cliEntryPath: "/opt/clash/clash.cjs",
      diagnosticLogPath,
      spawnProcess: (_command, _args, options) => {
        spawnOptions = options;
        return { pid: 4248, unref() {} } as never;
      },
    });

    expect(spawnOptions?.stdio).toEqual([
      "ignore",
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(await readFile(diagnosticLogPath, "utf8")).toBe("");
  });

  it("can run a validated Electron executable as a detached Node host", () => {
    let command = "";
    let args: readonly string[] = [];
    let spawnOptions: import("node:child_process").SpawnOptions | undefined;
    launchDetachedLocalDaemon({
      entryPath:
        "/Applications/Clash.app/Contents/Resources/clash-runtime/local-api.cjs",
      dataDir: "/tmp/clash/local-api",
      runDir: "/tmp/clash/run",
      cliEntryPath:
        "/Applications/Clash.app/Contents/Resources/clash-runtime/dispatcher.js",
      nodePath: "/Applications/Clash.app/Contents/MacOS/Clash",
      nodeVersion: "24.18.0",
      electronRunAsNode: true,
      nodeArgs: ["--import", "/workspace/node_modules/tsx/dist/loader.mjs"],
      spawnProcess: (nextCommand, nextArgs, options) => {
        command = nextCommand;
        args = nextArgs;
        spawnOptions = options;
        return { pid: 4243, unref() {} } as never;
      },
    });

    expect(command).toBe("/Applications/Clash.app/Contents/MacOS/Clash");
    expect(args).toEqual([
      "--import",
      "/workspace/node_modules/tsx/dist/loader.mjs",
      "/Applications/Clash.app/Contents/Resources/clash-runtime/local-api.cjs",
    ]);
    expect(spawnOptions?.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
    expect(spawnOptions?.detached).toBe(true);
  });

  it("stops the complete detached process group so source runners cannot orphan a child", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const launched = launchDetachedLocalDaemon({
      entryPath: "/opt/clash/source-host.ts",
      dataDir: "/tmp/clash/local-api",
      runDir: "/tmp/clash/run",
      cliEntryPath: "/opt/clash/clash.ts",
      processExists: () => true,
      killProcess: (pid, signal) => {
        signals.push({ pid, signal });
      },
      spawnProcess: () => ({ pid: 4245, unref() {} }) as never,
    });

    await launched.stop?.();

    expect(signals).toEqual([
      {
        pid: process.platform === "win32" ? 4245 : -4245,
        signal: "SIGTERM",
      },
    ]);
  });

  it("marks a detached tsx watcher as the stable source-host supervisor", () => {
    let spawnOptions: import("node:child_process").SpawnOptions | undefined;
    launchDetachedLocalDaemon({
      entryPath: "/workspace/plugins/clash/src/local-api-entry.ts",
      dataDir: "/tmp/clash/local-api",
      runDir: "/tmp/clash/run",
      cliEntryPath: "/workspace/packages/cli/src/index.ts",
      nodeArgs: [
        "/workspace/node_modules/tsx/dist/cli.mjs",
        "watch",
        "--tsconfig",
        "/workspace/plugins/clash/tsconfig.dev.json",
      ],
      spawnProcess: (_command, _args, options) => {
        spawnOptions = options;
        return { pid: 4246, unref() {} } as never;
      },
    });

    expect(spawnOptions?.env).toMatchObject({
      CLASH_DAEMON_SOURCE_WATCH: "1",
    });
  });

  it("keeps a source watcher's reserved port across replaceable children", () => {
    let spawnOptions: import("node:child_process").SpawnOptions | undefined;
    launchDetachedLocalDaemon({
      entryPath: "/workspace/plugins/clash/src/local-api-entry.ts",
      dataDir: "/tmp/clash/local-api",
      runDir: "/tmp/clash/run",
      cliEntryPath: "/workspace/packages/cli/src/index.ts",
      nodeArgs: [
        "/workspace/node_modules/tsx/dist/cli.mjs",
        "watch",
        "--tsconfig",
        "/workspace/plugins/clash/tsconfig.dev.json",
      ],
      daemonEnv: { PORT: "49321" },
      spawnProcess: (_command, _args, options) => {
        spawnOptions = options;
        return { pid: 4247, unref() {} } as never;
      },
    });

    expect(spawnOptions?.env).toMatchObject({
      CLASH_DAEMON_SOURCE_WATCH: "1",
      PORT: "49321",
    });
  });

  it("rejects Electron Node mode outside the verified Node 24 range", () => {
    expect(() =>
      launchDetachedLocalDaemon({
        entryPath: "/app/local-api.cjs",
        dataDir: "/tmp/clash/local-api",
        runDir: "/tmp/clash/run",
        cliEntryPath: "/app/dispatcher.js",
        nodePath: "/Applications/Clash.app/Contents/MacOS/Clash",
        nodeVersion: "26.0.0",
        electronRunAsNode: true,
        spawnProcess: () => ({ pid: 4244, unref() {} }) as never,
      }),
    ).toThrow(/does not satisfy >=24\.18\.0 <25/);
  });

  it("reuses a healthy daemon without launching another process", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-daemon-reuse-"));
    const active = record();
    await publish(runDir, active);
    let launches = 0;
    const bootstrap = createLocalDaemonBootstrap({
      runDir,
      profile: "prod",
      probe: async () => true,
      launch: async () => {
        launches += 1;
        return { pid: 999_999 };
      },
    });

    await expect(bootstrap.ensureDaemon()).resolves.toEqual(active);
    expect(launches).toBe(0);
  });

  it("gracefully replaces a healthy daemon running a different runtime artifact", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-daemon-replace-"));
    const active = record({ runtimeFingerprint: "sha256:old" });
    const replacement = record({
      hostId: "daemon-replacement",
      runtimeFingerprint: "sha256:new",
    });
    await publish(runDir, active);
    let retires = 0;
    let launches = 0;
    const bootstrap = createLocalDaemonBootstrap({
      runDir,
      profile: "prod",
      runtimeFingerprint: "sha256:new",
      probe: async () => true,
      retire: async (candidate) => {
        expect(candidate).toEqual(active);
        retires += 1;
        await rm(join(runDir, "host.json"));
      },
      launch: async () => {
        launches += 1;
        await publish(runDir, replacement);
        return { pid: replacement.pid };
      },
    });

    await expect(bootstrap.ensureDaemon()).resolves.toEqual(replacement);
    expect(retires).toBe(1);
    expect(launches).toBe(1);
  });

  it("actively launches when discovery is stale and waits for healthy readiness", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-daemon-stale-"));
    await publish(runDir, record({ pid: 999_999 }));
    let launches = 0;
    let ready = false;
    const started = record({ hostId: "daemon-started", pid: process.pid });
    const launch = async (): Promise<LocalDaemonLaunchResult> => {
      launches += 1;
      await publish(runDir, started);
      ready = true;
      return { pid: started.pid };
    };
    const bootstrap = createLocalDaemonBootstrap({
      runDir,
      profile: "prod",
      pidExists: (pid) => pid === process.pid,
      probe: async (candidate) => ready && candidate.hostId === started.hostId,
      launch,
    });

    await expect(bootstrap.ensureDaemon()).resolves.toEqual(started);
    expect(launches).toBe(1);
  });

  it("fails closed instead of creating a second writer when a live daemon is unhealthy", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-daemon-unhealthy-"));
    await publish(runDir, record({ pid: process.pid }));
    let launches = 0;
    const bootstrap = createLocalDaemonBootstrap({
      runDir,
      profile: "prod",
      probe: async () => false,
      startupTimeoutMs: 25,
      pollIntervalMs: 5,
      launch: async () => {
        launches += 1;
        return { pid: process.pid };
      },
    });

    await expect(bootstrap.ensureDaemon()).rejects.toThrow(
      /alive but unhealthy/i,
    );
    expect(launches).toBe(0);
  });

  it("waits for the same live daemon to recover before failing closed", async () => {
    const runDir = await mkdtemp(
      join(tmpdir(), "clash-daemon-unhealthy-recovery-"),
    );
    const existing = record({ pid: process.pid });
    await publish(runDir, existing);
    let probes = 0;
    let launches = 0;
    const bootstrap = createLocalDaemonBootstrap({
      runDir,
      profile: "prod",
      probe: async () => {
        probes += 1;
        return probes >= 3;
      },
      startupTimeoutMs: 100,
      unhealthyRecoveryTimeoutMs: 100,
      pollIntervalMs: 5,
      launch: async () => {
        launches += 1;
        return { pid: process.pid };
      },
    });

    await expect(bootstrap.ensureDaemon()).resolves.toEqual(existing);
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(launches).toBe(0);
  });

  it("rejects a healthy-looking endpoint owned by a different daemon identity", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          mode: "local",
          host: {
            hostId: "different-daemon",
            pid: process.pid,
            profile: "prod",
            protocolVersion: LOCAL_HOST_PROTOCOL_VERSION,
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    const runDir = await mkdtemp(join(tmpdir(), "clash-daemon-identity-"));
    await publish(
      runDir,
      record({
        hostId: "expected-daemon",
        endpoint: `http://127.0.0.1:${address.port}`,
      }),
    );
    let launches = 0;
    const bootstrap = createLocalDaemonBootstrap({
      runDir,
      profile: "prod",
      launch: async () => {
        launches += 1;
        return { pid: process.pid };
      },
    });

    try {
      await expect(bootstrap.ensureDaemon()).rejects.toThrow(
        /alive but unhealthy/i,
      );
      expect(launches).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("coordinates concurrent cold starts across independent clients", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-daemon-race-"));
    let launches = 0;
    const started = record({ hostId: "daemon-race" });
    const launch = async (): Promise<LocalDaemonLaunchResult> => {
      launches += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      await publish(runDir, started);
      return { pid: started.pid };
    };
    const options = {
      runDir,
      profile: "prod" as const,
      probe: async () => true,
      launch,
    };
    const first = createLocalDaemonBootstrap(options);
    const second = createLocalDaemonBootstrap(options);

    const [one, two] = await Promise.all([
      first.ensureDaemon(),
      second.ensureDaemon(),
    ]);

    expect(one.hostId).toBe(started.hostId);
    expect(two.hostId).toBe(started.hostId);
    expect(launches).toBe(1);
  });

  it("never stops a daemon when the bootstrapping client closes", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-daemon-persist-"));
    const started = record({ hostId: "daemon-persist" });
    let stops = 0;
    const bootstrap = createLocalDaemonBootstrap({
      runDir,
      profile: "prod",
      probe: async () => true,
      launch: async () => {
        await publish(runDir, started);
        return {
          pid: started.pid,
          stop: async () => {
            stops += 1;
          },
        };
      },
    });

    await bootstrap.ensureDaemon();
    await bootstrap.close();

    expect(stops).toBe(0);
    expect(
      JSON.parse(await readFile(join(runDir, "host.json"), "utf8")).hostId,
    ).toBe(started.hostId);
  });

  it("re-probes after an earlier ensure call instead of caching a stale endpoint forever", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-daemon-reprobe-"));
    const first = record({ hostId: "daemon-first" });
    const second = record({ hostId: "daemon-second" });
    await publish(runDir, first);
    let probes = 0;
    const bootstrap = createLocalDaemonBootstrap({
      runDir,
      profile: "prod",
      probe: async () => {
        probes += 1;
        return true;
      },
      launch: async () => ({ pid: process.pid }),
    });

    expect((await bootstrap.ensureDaemon()).hostId).toBe(first.hostId);
    await publish(runDir, second);
    expect((await bootstrap.ensureDaemon()).hostId).toBe(second.hostId);
    expect(probes).toBe(2);
  });
});
