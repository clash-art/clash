import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
import {
  LOCAL_DAEMON_RUNTIME_MANIFEST_FILE,
  type LocalDaemonRuntimeManifest,
} from "./local-daemon-manifest.js";
import type { ClashRuntimeProfile } from "./local-paths.js";
import { localApiCompileCacheDir } from "./local-compile-cache.js";

/**
 * The Node range the daemon supports. Kept beside the launcher so a host can
 * never be started on a runtime the stores were not verified against.
 */
export const DAEMON_SUPPORTED_NODE_RANGE = ">=24.18.0 <25";

/** First Host readiness probe interval. Discovery is written about 2 ms after listen. */
export const DEFAULT_READINESS_POLL_INTERVAL_MS = 12;
/** Backoff ceiling; a slow Host should not be polled every 12 ms forever. */
export const DEFAULT_READINESS_POLL_MAX_INTERVAL_MS = 50;

export function nextReadinessPollInterval(
  currentMs: number,
  maxMs: number = DEFAULT_READINESS_POLL_MAX_INTERVAL_MS,
): number {
  return Math.min(maxMs, Math.max(currentMs + 1, Math.round(currentMs * 1.5)));
}

export interface LocalDaemonLaunchResult {
  pid: number;
  /** Which Node actually runs this host, and why it was chosen. */
  runtime?: DaemonNodeRuntime;
  /** Where this launch's stdout/stderr went, when it was captured. */
  diagnosticLogPath?: string;
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
  /** Base delay for startup-lock and unhealthy-recovery polling. */
  pollIntervalMs?: number;
  /** Readiness begins at 10-15 ms (default 12) and backs off to the ceiling. */
  readinessPollIntervalMs?: number;
  readinessPollMaxIntervalMs?: number;
}

/**
 * Runtime identity for the packaged Host.
 *
 * The shipped tree carries `local-daemon-runtime.manifest.json` (built by
 * `writeLocalDaemonRuntimeManifest`). In that case the launcher reads the small
 * manifest, checks the entry and payload file set/sizes, and uses the build-time
 * tree digest, instead of re-hashing 121 MB on every launch.
 *
 * A source checkout / older multi-file runtime has no manifest. That case
 * falls back to the previous full-tree hash and logs once; it is deliberately
 * not silent because the cost and the trust model differ.
 */
export function resolveLocalDaemonRuntimeFingerprint(
  entryPath: string,
): string {
  if (
    existsSync(join(dirname(entryPath), LOCAL_DAEMON_RUNTIME_MANIFEST_FILE))
  ) {
    return computeLocalDaemonRuntimeFingerprintFromManifest(
      entryPath,
      LOCAL_DAEMON_RUNTIME_MANIFEST_FILE,
    );
  }
  warnMissingRuntimeManifest(entryPath);
  return resolveFullRuntimeFingerprint(entryPath);
}

let warnedMissingRuntimeManifest = false;

function warnMissingRuntimeManifest(entryPath: string): void {
  if (warnedMissingRuntimeManifest) return;
  warnedMissingRuntimeManifest = true;
  console.warn(
    `[local-daemon] ${LOCAL_DAEMON_RUNTIME_MANIFEST_FILE} is missing beside ${entryPath}; ` +
      "falling back to hashing the full runtime tree. Run the package build to generate the manifest.",
  );
}

interface RuntimeTreeFile {
  relative: string;
  path: string;
}

function isMissingPayloadRoot(error: unknown, payloadRoot: string): boolean {
  return (
    isMissingFile(error) &&
    (error as NodeJS.ErrnoException).path === payloadRoot
  );
}

/** Orders files the way the sync walk does: sorted siblings, depth first. */
function compareRuntimeTreeFiles(
  a: RuntimeTreeFile,
  b: RuntimeTreeFile,
): number {
  const left = a.relative.split("/");
  const right = b.relative.split("/");
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) {
      return left[index].localeCompare(right[index]);
    }
  }
  return left.length - right.length;
}

/**
 * Bounds the number of concurrent fs/promises calls. The Host runtime has a few
 * hundred files; the walk itself is bookkeeping on the calling thread while the
 * reads/stats execute on the libuv threadpool.
 */
const RUNTIME_TREE_IO_CONCURRENCY = 16;

function createIoLimiter(
  limit: number,
): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function createFullRuntimeFingerprintHash(
  entryBytes: Buffer,
  dependencies: Buffer | null,
) {
  const hash = createHash("sha256").update(entryBytes);
  if (dependencies !== null) {
    // Both packagers materialize dependencies and compute their content identity.
    // A same-path dependency-only upgrade must retire cached module registrations.
    hash.update("\0runtime-dependencies\0").update(dependencies);
  }
  return {
    update(relative: string, bytes: Buffer): void {
      hash.update(`\0${relative}\0`).update(bytes);
    },
    digest(): string {
      return `sha256:${hash.digest("hex")}`;
    },
  };
}

function readRuntimeDependenciesSync(entryPath: string): Buffer | null {
  const dependencyIdentity = join(
    dirname(entryPath),
    "runtime-dependencies.sha256",
  );
  try {
    return readFileSync(dependencyIdentity);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return null;
  }
}

async function readRuntimeDependenciesAsync(
  entryPath: string,
): Promise<Buffer | null> {
  const dependencyIdentity = join(
    dirname(entryPath),
    "runtime-dependencies.sha256",
  );
  try {
    return await readFile(dependencyIdentity);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return null;
  }
}

function resolveFullRuntimeFingerprint(entryPath: string): string {
  const hash = createFullRuntimeFingerprintHash(
    readFileSync(entryPath),
    readRuntimeDependenciesSync(entryPath),
  );
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
        hash.update(relative, readFileSync(path));
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
      if (!isMissingPayloadRoot(error, payloadRoot)) throw error;
    }
  }
  return hash.digest();
}

async function resolveFullRuntimeFingerprintAsync(
  entryPath: string,
): Promise<string> {
  const hash = createFullRuntimeFingerprintHash(
    await readFile(entryPath),
    await readRuntimeDependenciesAsync(entryPath),
  );
  for (const name of ["bundled-plugins", "project-ui"]) {
    const payloadRoot = join(dirname(entryPath), name);
    let files: RuntimeTreeFile[];
    try {
      files = await collectRuntimeTreeFilesAsync(payloadRoot, name);
    } catch (error) {
      // Source entrypoints and older standalone distributions have no payload dir.
      if (!isMissingPayloadRoot(error, payloadRoot)) throw error;
      continue;
    }
    files.sort(compareRuntimeTreeFiles);
    for (
      let index = 0;
      index < files.length;
      index += RUNTIME_TREE_IO_CONCURRENCY
    ) {
      const chunk = files.slice(index, index + RUNTIME_TREE_IO_CONCURRENCY);
      const contents = await Promise.all(
        chunk.map((file) => readFile(file.path)),
      );
      for (let offset = 0; offset < chunk.length; offset += 1) {
        hash.update(chunk[offset].relative, contents[offset]);
      }
    }
  }
  return hash.digest();
}

/**
 * Lists regular files depth-first with sorted siblings, matching the sync walk's
 * order so both variants feed the digest the same `relative` sequence.
 */
async function collectRuntimeTreeFilesAsync(
  directory: string,
  prefix: string,
): Promise<RuntimeTreeFile[]> {
  const limit = createIoLimiter(RUNTIME_TREE_IO_CONCURRENCY);
  const files: RuntimeTreeFile[] = [];
  const walk = async (
    current: string,
    currentPrefix: string,
  ): Promise<void> => {
    const entries = await limit(() =>
      readdir(current, { withFileTypes: true }),
    );
    entries.sort((a, b) => a.name.localeCompare(b.name));
    await Promise.all(
      entries.map(async (entry) => {
        const relative = `${currentPrefix}/${entry.name}`;
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(path, relative);
        } else if (entry.isFile()) {
          files.push({ relative, path });
        } else {
          throw new Error(
            `Bundled runtime payload must be a regular file: ${path}`,
          );
        }
      }),
    );
  };
  await walk(directory, prefix);
  return files;
}

/**
 * Async version used by Desktop. Every filesystem call on the launch path is
 * `node:fs/promises`, so the readdir/stat/read work runs on the libuv threadpool
 * and the Electron main thread only does bounded bookkeeping between awaits. A
 * source runtime without a manifest still takes the explicit, logged full-hash
 * fallback, asynchronously.
 */
export async function resolveLocalDaemonRuntimeFingerprintAsync(
  entryPath: string,
): Promise<string> {
  const manifestPath = join(
    dirname(entryPath),
    LOCAL_DAEMON_RUNTIME_MANIFEST_FILE,
  );
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      warnMissingRuntimeManifest(entryPath);
      return resolveFullRuntimeFingerprintAsync(entryPath);
    }
    throw runtimeManifestMismatch(
      manifestPath,
      manifestPath,
      `manifest is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return computeLocalDaemonRuntimeFingerprintFromManifestAsync(
    entryPath,
    manifestPath,
    raw,
  );
}

/**
 * Applies the launch-path manifest check and computes the identity. The entry
 * bundle's recorded sha256 is part of `treeDigest`; the runtime check validates
 * the file set and sizes only (the documented cheap check), so it never reads
 * the 7.7 MB entry or the 121 MB payload again.
 */
function computeLocalDaemonRuntimeFingerprintFromManifest(
  entryPath: string,
  manifestFile: string,
): string {
  const manifestPath = join(dirname(entryPath), manifestFile);
  const raw = readRuntimeManifestSync(manifestPath);
  const parsed = parseRuntimeManifest(manifestPath, raw, entryPath);
  const actual = collectRuntimeManifestActualSync(
    entryPath,
    manifestPath,
    parsed,
  );
  return finalizeRuntimeManifestFingerprint(
    manifestPath,
    parsed,
    actual,
    readRuntimeDependenciesSync(entryPath),
  );
}

async function computeLocalDaemonRuntimeFingerprintFromManifestAsync(
  entryPath: string,
  manifestPath: string,
  raw: string,
): Promise<string> {
  const parsed = parseRuntimeManifest(manifestPath, raw, entryPath);
  const [actual, dependencies] = await Promise.all([
    collectRuntimeManifestActualAsync(entryPath, manifestPath, parsed),
    readRuntimeDependenciesAsync(entryPath),
  ]);
  return finalizeRuntimeManifestFingerprint(
    manifestPath,
    parsed,
    actual,
    dependencies,
  );
}

function readRuntimeManifestSync(manifestPath: string): string {
  try {
    return readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw runtimeManifestMismatch(
      manifestPath,
      manifestPath,
      `manifest is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function collectRuntimeManifestActualSync(
  entryPath: string,
  manifestPath: string,
  parsed: ParsedRuntimeManifest,
): Map<string, number> {
  const actual = new Map<string, number>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile()) {
        actual.set(relative, statSync(full).size);
      } else {
        throw runtimeManifestMismatch(
          manifestPath,
          relative,
          "payload entry is not a regular file",
        );
      }
    }
  };
  actual.set(parsed.entryName, statSync(entryPath).size);
  for (const root of parsed.manifest.roots) {
    assertSafeManifestRoot(manifestPath, root);
    const rootPath = join(dirname(entryPath), root);
    let info;
    try {
      info = statSync(rootPath);
    } catch {
      throw runtimeManifestMismatch(
        manifestPath,
        root,
        "payload directory is missing",
      );
    }
    if (!info.isDirectory()) {
      throw runtimeManifestMismatch(
        manifestPath,
        root,
        "payload root is not a directory",
      );
    }
    walk(rootPath, root);
  }
  return actual;
}

async function collectRuntimeManifestActualAsync(
  entryPath: string,
  manifestPath: string,
  parsed: ParsedRuntimeManifest,
): Promise<Map<string, number>> {
  const limit = createIoLimiter(RUNTIME_TREE_IO_CONCURRENCY);
  const actual = new Map<string, number>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await limit(() =>
      readdir(directory, { withFileTypes: true }),
    );
    await Promise.all(
      entries.map(async (entry) => {
        const relative = `${prefix}/${entry.name}`;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(full, relative);
        } else if (entry.isFile()) {
          actual.set(relative, (await limit(() => stat(full))).size);
        } else {
          throw runtimeManifestMismatch(
            manifestPath,
            relative,
            "payload entry is not a regular file",
          );
        }
      }),
    );
  };
  actual.set(parsed.entryName, (await limit(() => stat(entryPath))).size);
  for (const root of parsed.manifest.roots) {
    assertSafeManifestRoot(manifestPath, root);
    const rootPath = join(dirname(entryPath), root);
    let info;
    try {
      info = await limit(() => stat(rootPath));
    } catch {
      throw runtimeManifestMismatch(
        manifestPath,
        root,
        "payload directory is missing",
      );
    }
    if (!info.isDirectory()) {
      throw runtimeManifestMismatch(
        manifestPath,
        root,
        "payload root is not a directory",
      );
    }
    await walk(rootPath, root);
  }
  return actual;
}

function finalizeRuntimeManifestFingerprint(
  manifestPath: string,
  parsed: ParsedRuntimeManifest,
  actual: Map<string, number>,
  dependencies: Buffer | null,
): string {
  compareRuntimeManifestFiles(manifestPath, parsed, actual);
  return computeRuntimeManifestFingerprint(parsed.manifest, dependencies);
}

interface ParsedRuntimeManifest {
  manifest: LocalDaemonRuntimeManifest;
  entryName: string;
  expected: Map<string, { size: number }>;
}

function runtimeManifestMismatch(
  manifestPath: string,
  file: string,
  detail: string,
): Error & { code: string; file: string } {
  const error = new Error(
    `Local daemon runtime tree does not match ${manifestPath}: ${detail} (${file})`,
  ) as Error & { code: string; file: string };
  error.code = "LOCAL_DAEMON_RUNTIME_MANIFEST_MISMATCH";
  error.file = file;
  return error;
}

function parseRuntimeManifest(
  manifestPath: string,
  raw: string,
  entryPath: string,
): ParsedRuntimeManifest {
  let manifest: LocalDaemonRuntimeManifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw runtimeManifestMismatch(
      manifestPath,
      manifestPath,
      `manifest is unreadable or invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.entry !== "string" ||
    typeof manifest.treeDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.treeDigest) ||
    !Array.isArray(manifest.roots) ||
    !manifest.roots.every((root) => typeof root === "string") ||
    !Array.isArray(manifest.files)
  ) {
    throw runtimeManifestMismatch(
      manifestPath,
      manifestPath,
      "manifest has an unsupported shape",
    );
  }
  const entryName = basename(entryPath);
  if (manifest.entry !== entryName) {
    throw runtimeManifestMismatch(
      manifestPath,
      entryName,
      `manifest describes entry ${manifest.entry}`,
    );
  }
  const expected = new Map<string, { size: number }>();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.size !== "number" ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      file.path.startsWith("/") ||
      file.path.split("/").includes("..")
    ) {
      throw runtimeManifestMismatch(
        manifestPath,
        manifestPath,
        "manifest contains an invalid file record",
      );
    }
    if (expected.has(file.path)) {
      throw runtimeManifestMismatch(
        manifestPath,
        file.path,
        "manifest lists the file twice",
      );
    }
    expected.set(file.path, { size: file.size });
  }
  if (!expected.has(entryName)) {
    throw runtimeManifestMismatch(
      manifestPath,
      entryName,
      "entry is not listed in the manifest",
    );
  }
  return { manifest, entryName, expected };
}

function assertSafeManifestRoot(manifestPath: string, root: string): void {
  if (
    root.length === 0 ||
    root.startsWith("/") ||
    root.split("/").includes("..")
  ) {
    throw runtimeManifestMismatch(
      manifestPath,
      root,
      "manifest root is not a safe relative directory",
    );
  }
}

function compareRuntimeManifestFiles(
  manifestPath: string,
  parsed: ParsedRuntimeManifest,
  actual: Map<string, number>,
): void {
  for (const file of parsed.manifest.files) {
    const size = actual.get(file.path);
    if (size === undefined) {
      throw runtimeManifestMismatch(manifestPath, file.path, "file is missing");
    }
    if (size !== file.size) {
      throw runtimeManifestMismatch(
        manifestPath,
        file.path,
        `size is ${size} bytes, manifest says ${file.size}`,
      );
    }
  }
  for (const file of [...actual.keys()].sort()) {
    if (!parsed.expected.has(file)) {
      throw runtimeManifestMismatch(
        manifestPath,
        file,
        "file is not listed in the manifest",
      );
    }
  }
}

function computeRuntimeManifestFingerprint(
  manifest: LocalDaemonRuntimeManifest,
  dependencies: Buffer | null,
): string {
  const identity = createHash("sha256");
  identity.update("local-daemon-runtime-manifest-v1\0");
  identity.update(manifest.treeDigest);
  if (dependencies !== null) {
    identity.update("\0runtime-dependencies\0").update(dependencies);
  }
  return `sha256:${identity.digest("hex")}`;
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
  // Set before spawn so Node also caches the main Host bundle, not only modules loaded later by
  // the entry. An explicit caller-provided directory wins; the default stays inside CLASH_HOME.
  const compileCacheDir =
    options.daemonEnv?.NODE_COMPILE_CACHE?.trim() ||
    env.NODE_COMPILE_CACHE?.trim() ||
    localApiCompileCacheDir(
      {
        ...env,
        ...options.daemonEnv,
        CLASH_DAEMON_RUNTIME_FINGERPRINT:
          options.runtimeFingerprint ?? env.CLASH_DAEMON_RUNTIME_FINGERPRINT,
      },
      options.dataDir,
    );
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
          NODE_COMPILE_CACHE: compileCacheDir,
          CLASH_COMPILE_CACHE_DIR: compileCacheDir,
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
    diagnosticLogPath: options.diagnosticLogPath,
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

/** The tail of what a dead daemon printed, so its launcher can say why it died. */
async function startupDiagnostics(path: string | undefined): Promise<string> {
  if (!path) return "";
  const output = await readFile(path, "utf8").catch(() => "");
  const tail = output.trimEnd().split("\n").slice(-40).join("\n");
  return tail
    ? `:\n${tail}\n(startup output: ${path})`
    : ` (no startup output in ${path})`;
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
  const readinessPollMaxIntervalMs =
    options.readinessPollMaxIntervalMs ??
    DEFAULT_READINESS_POLL_MAX_INTERVAL_MS;
  const readinessPollIntervalMs =
    options.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS;
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
      let readinessIntervalMs = readinessPollIntervalMs;
      while (Date.now() < deadline) {
        const ready = await inspectDaemon();
        if (ready.status === "healthy") return ready.record;
        if (ready.status === "unhealthy" && ready.record.pid !== launched.pid) {
          throw new Error(
            `A different Clash daemon process ${ready.record.pid} became unhealthy during startup`,
          );
        }
        if (!pidExists(launched.pid)) {
          throw new Error(
            "Clash daemon exited before becoming ready" +
              (await startupDiagnostics(launched.diagnosticLogPath)),
          );
        }
        await delay(readinessIntervalMs);
        readinessIntervalMs = nextReadinessPollInterval(
          readinessIntervalMs,
          readinessPollMaxIntervalMs,
        );
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
