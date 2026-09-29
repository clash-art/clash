import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  LOCAL_HOST_PROTOCOL_VERSION,
  isCompatibleHost,
  isLocalHostDiscoveryRecord,
  type LocalHostDiscoveryRecord,
} from "./index.js";
import {
  defaultDaemonNodeCandidates,
  isDaemonNodeVersionSupported,
  resolveDaemonNodeRuntime,
  type DaemonNodeRuntime,
} from "./local-daemon-runtime.js";
import type { ClashRuntimeProfile } from "./local-paths.js";

/**
 * The Node range the daemon supports. Kept beside the launcher so a host can
 * never be started on a runtime the stores were not verified against.
 */
export const DAEMON_SUPPORTED_NODE_RANGE = ">=24.18.0 <25";

export interface LocalDaemonLaunchResult {
  pid: number;
  /** Which Node actually runs this host, and why it was chosen. */
  runtime?: DaemonNodeRuntime;
  stop?: () => Promise<void>;
}

export interface DetachedLocalDaemonOptions {
  entryPath: string;
  /** Content identity advertised by the launched host. */
  runtimeFingerprint?: string;
  /** Node flags placed before the entrypoint (for example `--import tsx` in development). */
  nodeArgs?: readonly string[];
  dataDir: string;
  runDir: string;
  cliEntryPath: string;
  /** Truncated on each launch and used only for failures before normal logging starts. */
  diagnosticLogPath?: string;
  env?: NodeJS.ProcessEnv;
  daemonEnv?: NodeJS.ProcessEnv;
  nodePath?: string;
  /** Version already reported by an explicitly supplied runtime. */
  nodeVersion?: string;
  /** Run an Electron executable as its embedded Node runtime. */
  electronRunAsNode?: boolean;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => Pick<ChildProcess, "pid" | "unref">;
  processExists?: (pid: number) => boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface LocalDaemonBootstrap {
  ensureDaemon(): Promise<LocalHostDiscoveryRecord>;
  close(): Promise<void>;
}

export interface LocalDaemonBootstrapOptions {
  runDir: string;
  profile: ClashRuntimeProfile;
  pidExists?: (pid: number) => boolean;
  probe?: (record: LocalHostDiscoveryRecord) => Promise<boolean>;
  launch: () => Promise<LocalDaemonLaunchResult>;
  /** Replace a healthy host when it advertises a different executable artifact. */
  runtimeFingerprint?: string;
  retire?: (record: LocalHostDiscoveryRecord) => Promise<void>;
  startupTimeoutMs?: number;
  /**
   * How long to wait for an already-running daemon to recover its health
   * endpoint. This never authorizes launching a second writer.
   */
  unhealthyRecoveryTimeoutMs?: number;
  lockTimeoutMs?: number;
  pollIntervalMs?: number;
}

export function resolveLocalDaemonRuntimeFingerprint(
  entryPath: string,
): string {
  const hash = createHash("sha256").update(readFileSync(entryPath));
  // Both packagers materialize dependencies and compute their content identity.
  // A same-path dependency-only upgrade must retire cached module registrations.
  const dependencyIdentity = join(dirname(entryPath), "runtime-dependencies.sha256");
  try {
    const identity = readFileSync(dependencyIdentity);
    hash.update("\0runtime-dependencies\0").update(identity);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  // Bundled PluginModules are imported into the long-lived Host. Updating only
  // their adjacent payload must retire the Host too, or Node keeps the old module.
  const visit = (directory: string, prefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const relative = `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, relative);
      else if (entry.isFile()) {
        hash.update(`\0${relative}\0`).update(readFileSync(path));
      } else {
        throw new Error(
          `Bundled runtime payload must be a regular file: ${path}`,
        );
      }
    }
  };
  // The Host also retains the renderer's installation path. A renderer-only
  // upgrade must stop serving the previous installation's project page.
  for (const name of ["bundled-plugins", "project-ui"]) {
    const payloadRoot = join(dirname(entryPath), name);
    try {
      visit(payloadRoot, name);
    } catch (error) {
      // Source entrypoints and older standalone distributions have no payload dir.
      if (!(isMissingFile(error) && (error as NodeJS.ErrnoException).path === payloadRoot)) throw error;
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT",
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EPERM",
    );
  }
}

export function launchDetachedLocalDaemon(
  options: DetachedLocalDaemonOptions,
): LocalDaemonLaunchResult {
  const spawnProcess = options.spawnProcess ?? spawn;
  const launchedProcessExists = options.processExists ?? processExists;
  const killProcess = options.killProcess ?? process.kill;
  const env = options.env ?? process.env;
  const sourceWatchSupervisor = options.nodeArgs?.includes("watch") === true;
  // Decoupled from the launcher on purpose. Desktop may explicitly use its
  // bundled Electron executable in Node mode after validating that embedded
  // Node against DAEMON_SUPPORTED_NODE_RANGE; every other launcher resolves a
  // standalone compatible Node runtime.
  if (
    options.nodePath &&
    !isDaemonNodeVersionSupported(
      options.nodeVersion,
      DAEMON_SUPPORTED_NODE_RANGE,
    )
  ) {
    throw new Error(
      `Explicit daemon Node ${options.nodeVersion ?? "unknown"} does not satisfy ${DAEMON_SUPPORTED_NODE_RANGE}.`,
    );
  }
  const runtime = options.nodePath
    ? {
        nodePath: options.nodePath,
        version: options.nodeVersion,
        source: "explicit" as const,
        inheritedFromLauncher: false,
      }
    : resolveDaemonNodeRuntime({
        execPath: process.execPath,
        env: env as Record<string, string | undefined>,
        supportedRange: DAEMON_SUPPORTED_NODE_RANGE,
        candidates: defaultDaemonNodeCandidates(
          env as Record<string, string | undefined>,
        ),
      });
  let diagnosticFd: number | undefined;
  if (options.diagnosticLogPath) {
    mkdirSync(dirname(options.diagnosticLogPath), { recursive: true });
    diagnosticFd = openSync(options.diagnosticLogPath, "w", 0o600);
  }
  let child: Pick<ChildProcess, "pid" | "unref">;
  try {
    // A Finder-launched Desktop inherits `/`. Libraries with cwd-based caches
    // (including Remotion's browser download) need a stable writable Host cwd.
    // Project/agent working trees are resolved separately from their identities.
    const workingDirectory = resolve(options.dataDir);
    mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
    child = spawnProcess(
      runtime.nodePath,
      [...(options.nodeArgs ?? []), resolve(options.entryPath)],
      {
        detached: true,
        cwd: workingDirectory,
        env: {
          ...env,
          ...(options.daemonEnv ?? {}),
          CLASH_LOCAL_DATA_DIR: workingDirectory,
          CLASH_HOST_RUN_DIR: resolve(options.runDir),
          CLASH_CLI_ENTRY_PATH: resolve(options.cliEntryPath),
          CLASH_LOCAL_API_WRAPPER_ENTRY: "1",
          // The watcher, rather than its replaceable child, owns discovery.
          CLASH_DAEMON_SOURCE_WATCH: sourceWatchSupervisor ? "1" : undefined,
          CLASH_DAEMON_RUNTIME_FINGERPRINT: options.runtimeFingerprint,
          // Electron Node mode is still a detached Node process; without this
          // explicit opt-in an Electron executable would recursively open the GUI.
          ELECTRON_RUN_AS_NODE: options.electronRunAsNode ? "1" : undefined,
          CLASH_DAEMON_NODE_PATH: runtime.nodePath,
          PORT: options.daemonEnv?.PORT ?? "0",
        },
        stdio:
          diagnosticFd === undefined
            ? "ignore"
            : ["ignore", diagnosticFd, diagnosticFd],
      },
    );
  } finally {
    if (diagnosticFd !== undefined) closeSync(diagnosticFd);
  }
  if (!child.pid) throw new Error("Failed to start Clash daemon process");
  const pid = child.pid;
  child.unref();
  return {
    pid,
    runtime,
    stop: async () => {
      if (!launchedProcessExists(pid)) return;
      try {
        // A detached source runtime may be supervised by tsx. Signal the whole
        // process group so a timed-out watcher cannot leave its listening child
        // behind as an orphan.
        killProcess(process.platform === "win32" ? pid : -pid, "SIGTERM");
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ESRCH"
        )) {
          throw error;
        }
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultHealthProbe(
  record: LocalHostDiscoveryRecord,
): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", record.endpoint), {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      ok?: unknown;
      mode?: unknown;
      host?: {
        hostId?: unknown;
        pid?: unknown;
        profile?: unknown;
        protocolVersion?: unknown;
        runtimeFingerprint?: unknown;
      };
    };
    return (
      body.ok === true &&
      body.mode === "local" &&
      body.host?.hostId === record.hostId &&
      body.host.pid === record.pid &&
      body.host.profile === (record.profile ?? "prod") &&
      body.host.protocolVersion === record.protocolVersion &&
      body.host.runtimeFingerprint === record.runtimeFingerprint
    );
  } catch {
    return false;
  }
}

type LocalDaemonInspection =
  | { status: "absent" }
  | { status: "healthy"; record: LocalHostDiscoveryRecord }
  | { status: "obsolete"; record: LocalHostDiscoveryRecord }
  | { status: "unhealthy"; record: LocalHostDiscoveryRecord };

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (hostname === "127.0.0.1" ||
        hostname === "localhost" ||
        hostname === "::1")
    );
  } catch {
    return false;
  }
}

async function inspectLocalDaemon(options: {
  runDir: string;
  profile: ClashRuntimeProfile;
  pidExists: (pid: number) => boolean;
  probe: (record: LocalHostDiscoveryRecord) => Promise<boolean>;
  runtimeFingerprint?: string;
}): Promise<LocalDaemonInspection> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(join(options.runDir, "host.json"), "utf8"),
    );
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError)
      return { status: "absent" };
    throw error;
  }
  if (!isLocalHostDiscoveryRecord(value)) return { status: "absent" };
  if (!options.pidExists(value.pid)) return { status: "absent" };
  if (
    (value.profile ?? "prod") !== options.profile ||
    !isCompatibleHost(value, LOCAL_HOST_PROTOCOL_VERSION) ||
    !isLoopbackEndpoint(value.endpoint)
  ) {
    return { status: "unhealthy", record: value };
  }
  if (!(await options.probe(value))) {
    return { status: "unhealthy", record: value };
  }
  if (
    options.runtimeFingerprint &&
    value.runtimeFingerprint !== options.runtimeFingerprint
  ) {
    return { status: "obsolete", record: value };
  }
  return { status: "healthy", record: value };
}

async function retireLocalDaemon(
  record: LocalHostDiscoveryRecord,
  pidExists: (pid: number) => boolean,
): Promise<void> {
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
    return;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pidExists(record.pid)) await delay(50);
  if (pidExists(record.pid)) {
    throw new Error(
      `Clash daemon process ${record.pid} did not stop after its runtime artifact was superseded`,
    );
  }
}

function isMissingProcess(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ESRCH",
  );
}

async function acquireStartupLock(options: {
  runDir: string;
  pidExists: (pid: number) => boolean;
  lockTimeoutMs: number;
  pollIntervalMs: number;
}): Promise<() => Promise<void>> {
  await mkdir(options.runDir, { recursive: true });
  const lockPath = join(options.runDir, "daemon-start.lock");
  const token = randomUUID();
  const deadline = Date.now() + options.lockTimeoutMs;

  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }),
        "utf8",
      );
      return async () => {
        await handle.close().catch(() => undefined);
        try {
          const current = JSON.parse(await readFile(lockPath, "utf8")) as {
            token?: unknown;
          };
          if (current.token === token) await rm(lockPath, { force: true });
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      };
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      )) {
        throw error;
      }
    }

    try {
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
        pid?: unknown;
        createdAt?: unknown;
      };
      const stale =
        typeof lock.pid !== "number" ||
        !options.pidExists(lock.pid) ||
        typeof lock.createdAt !== "number" ||
        Date.now() - lock.createdAt > options.lockTimeoutMs * 2;
      if (stale) {
        await rm(lockPath, { force: true });
        continue;
      }
    } catch (error) {
      if (isMissingFile(error)) continue;
      if (error instanceof SyntaxError) {
        await rm(lockPath, { force: true });
        continue;
      }
    }
    await delay(options.pollIntervalMs);
  }
  throw new Error("Timed out coordinating Clash daemon startup");
}

export function createLocalDaemonBootstrap(
  options: LocalDaemonBootstrapOptions,
): LocalDaemonBootstrap {
  const pidExists = options.pidExists ?? processExists;
  const probe = options.probe ?? defaultHealthProbe;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const unhealthyRecoveryTimeoutMs = options.unhealthyRecoveryTimeoutMs ?? 0;
  const lockTimeoutMs = options.lockTimeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const inspectDaemon = () =>
    inspectLocalDaemon({
      runDir: options.runDir,
      profile: options.profile,
      pidExists,
      probe,
      runtimeFingerprint: options.runtimeFingerprint,
    });
  let ensuring: Promise<LocalHostDiscoveryRecord> | undefined;
  let closed = false;

  const waitForUnhealthyDaemonRecovery = async (
    initial: Extract<LocalDaemonInspection, { status: "unhealthy" }>,
  ): Promise<LocalDaemonInspection> => {
    const deadline = Date.now() + unhealthyRecoveryTimeoutMs;
    let latest: LocalDaemonInspection = initial;
    while (
      latest.status === "unhealthy" &&
      latest.record.pid === initial.record.pid &&
      Date.now() < deadline
    ) {
      await delay(Math.min(pollIntervalMs, deadline - Date.now()));
      latest = await inspectDaemon();
    }
    return latest;
  };

  const establish = async (): Promise<LocalHostDiscoveryRecord> => {
    if (closed) throw new Error("Clash daemon bootstrap is closed");
    let active = await inspectDaemon();
    if (active.status === "unhealthy") {
      active = await waitForUnhealthyDaemonRecovery(active);
    }
    if (active.status === "healthy") return active.record;
    // Retirement happens only after taking the startup lock below. Until then,
    // another client may already be replacing the same artifact.
    if (active.status === "unhealthy") {
      throw new Error(
        `Clash daemon process ${active.record.pid} is alive but unhealthy at ${active.record.endpoint}; ` +
          "refusing to start a second project-state writer",
      );
    }

    const release = await acquireStartupLock({
      runDir: options.runDir,
      pidExists,
      lockTimeoutMs,
      pollIntervalMs,
    });
    let launched: LocalDaemonLaunchResult | undefined;
    try {
      let activeAfterLock = await inspectDaemon();
      if (activeAfterLock.status === "unhealthy") {
        activeAfterLock = await waitForUnhealthyDaemonRecovery(activeAfterLock);
      }
      if (activeAfterLock.status === "healthy") return activeAfterLock.record;
      if (activeAfterLock.status === "obsolete") {
        await (
          options.retire ?? ((record) => retireLocalDaemon(record, pidExists))
        )(activeAfterLock.record);
        const afterRetire = await inspectDaemon();
        if (afterRetire.status !== "absent") {
          throw new Error(
            `Clash daemon process ${activeAfterLock.record.pid} still owns discovery after retirement`,
          );
        }
      }
      if (activeAfterLock.status === "unhealthy") {
        throw new Error(
          `Clash daemon process ${activeAfterLock.record.pid} is alive but unhealthy at ${activeAfterLock.record.endpoint}; ` +
            "refusing to start a second project-state writer",
        );
      }
      launched = await options.launch();
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
        const ready = await inspectDaemon();
        if (ready.status === "healthy") return ready.record;
        if (ready.status === "unhealthy" && ready.record.pid !== launched.pid) {
          throw new Error(
            `A different Clash daemon process ${ready.record.pid} became unhealthy during startup`,
          );
        }
        if (!pidExists(launched.pid)) {
          throw new Error("Clash daemon exited before becoming ready");
        }
        await delay(pollIntervalMs);
      }
      throw new Error("Timed out waiting for Clash daemon readiness");
    } catch (error) {
      await launched?.stop?.().catch(() => undefined);
      throw error;
    } finally {
      await release();
    }
  };

  return {
    ensureDaemon: () => {
      if (ensuring) return ensuring;
      const attempt = establish();
      ensuring = attempt;
      void attempt.then(
        () => {
          if (ensuring === attempt) ensuring = undefined;
        },
        () => {
          if (ensuring === attempt) ensuring = undefined;
        },
      );
      return ensuring;
    },
    close: async () => {
      closed = true;
      await ensuring?.catch(() => undefined);
    },
  };
}
