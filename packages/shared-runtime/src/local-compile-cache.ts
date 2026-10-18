import { mkdirSync, readdirSync, rmSync } from "node:fs";
import * as nodeModule from "node:module";
import { join, resolve } from "node:path";

import {
  clashHomeForLocalDataDir,
  defaultLocalApiDataDir,
} from "./local-paths.js";

/** Coded warning emitted when the Host cannot use a V8 module compile cache. */
export const HOST_COMPILE_CACHE_UNAVAILABLE = "HOST_COMPILE_CACHE_UNAVAILABLE";
/** Coded warning emitted when one obsolete cache directory cannot be removed. */
export const HOST_COMPILE_CACHE_PRUNE_FAILED =
  "HOST_COMPILE_CACHE_PRUNE_FAILED";

/**
 * Compile-cache selectors that must not cross into child processes. Node reads
 * `NODE_COMPILE_CACHE` at process start, so every Node child (ACP agents, the
 * Codex/Claude CLIs and plugin workers) would otherwise populate the Host's
 * bytecode directory with its own modules.
 */
export const LOCAL_API_COMPILE_CACHE_ENV_KEYS = [
  "NODE_COMPILE_CACHE",
  "CLASH_COMPILE_CACHE_DIR",
] as const;

export interface CompileCacheModuleApi {
  enableCompileCache?: (directory?: string) => {
    status?: number;
    directory?: string;
    message?: string;
  };
  getCompileCacheDir?: () => string | undefined;
  constants?: {
    compileCacheStatus?: {
      ENABLED?: number;
      ALREADY_ENABLED?: number;
    };
  };
}

export interface LocalApiCompileCacheResult {
  enabled: boolean;
  directory?: string;
  /** Set only when the cache could not be enabled; startup must continue regardless. */
  code?: typeof HOST_COMPILE_CACHE_UNAVAILABLE;
  reason?: string;
}

type Environment = Record<string, string | undefined>;

function cacheKey(env: Environment): string {
  const fingerprint = env.CLASH_DAEMON_RUNTIME_FINGERPRINT?.trim();
  if (!fingerprint) return "unversioned";
  // A fingerprint already encodes the runtime content; sanitize it into one path segment so a
  // colon or a path separator can never escape the CLASH_HOME cache root.
  return fingerprint
    .replace(/^sha256:/, "sha256-")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 160);
}

/** Root that owns every fingerprint-keyed Host compile-cache directory. */
export function localApiCompileCacheRoot(
  env: Environment = process.env,
  dataDir: string = defaultLocalApiDataDir(env),
): string {
  const clashHome = clashHomeForLocalDataDir(dataDir, env.CLASH_HOME);
  return join(clashHome, "cache", "compile");
}

/**
 * Where the Host keeps its V8 compile cache.
 *
 * Keyed by the runtime fingerprint so a newly installed Host never reads bytecode compiled from
 * a different bundle. Node additionally namespaces the directory by its own version, so switching
 * Node binaries is safe too. `CLASH_HOME` stays the owner of machine-local cache state.
 */
export function localApiCompileCacheDir(
  env: Environment = process.env,
  dataDir: string = defaultLocalApiDataDir(env),
): string {
  const explicit = env.CLASH_COMPILE_CACHE_DIR?.trim();
  if (explicit) return resolve(explicit);
  return join(localApiCompileCacheRoot(env, dataDir), cacheKey(env));
}

/** Remove the compile-cache selectors from one environment in place. */
export function clearLocalApiCompileCacheEnvironment(
  env: Environment = process.env,
): void {
  for (const key of LOCAL_API_COMPILE_CACHE_ENV_KEYS) delete env[key];
}

/** Return a copy of an environment with the compile-cache selectors removed. */
export function withoutLocalApiCompileCacheEnvironment<T extends Environment>(
  env: T,
): T {
  const next: Environment = { ...env };
  clearLocalApiCompileCacheEnvironment(next);
  return next as T;
}

export interface LocalApiCompileCachePruneFailure {
  path: string;
  code: typeof HOST_COMPILE_CACHE_PRUNE_FAILED;
  reason: string;
}

export interface LocalApiCompileCachePruneResult {
  removed: string[];
  failures: LocalApiCompileCachePruneFailure[];
}

function isMissingDirectory(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}

/**
 * Remove obsolete fingerprint-keyed cache directories beside the active one.
 *
 * Only direct children of `root` are considered, only real directories are removed (symlinks are
 * skipped, never followed), and `currentKey` is always retained. A failed removal is reported
 * with the coded warning instead of aborting the remaining cleanup.
 */
export function pruneLocalApiCompileCache(options: {
  root: string;
  currentKey: string;
  onFailure?: (failure: LocalApiCompileCachePruneFailure) => void;
  /** Test seam; production removes with recursive `rmSync`. */
  removeDirectory?: (path: string) => void;
}): LocalApiCompileCachePruneResult {
  const removed: string[] = [];
  const failures: LocalApiCompileCachePruneFailure[] = [];
  const removeDirectory =
    options.removeDirectory ??
    ((path: string) => rmSync(path, { recursive: true, force: true }));
  const fail = (path: string, error: unknown) => {
    const failure: LocalApiCompileCachePruneFailure = {
      path,
      code: HOST_COMPILE_CACHE_PRUNE_FAILED,
      reason: error instanceof Error ? error.message : String(error),
    };
    failures.push(failure);
    options.onFailure?.(failure);
  };

  try {
    const entries = readdirSync(options.root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === options.currentKey) continue;
      // Never follow a symlink: a link beside the cache must not make us delete its target.
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const path = join(options.root, entry.name);
      try {
        removeDirectory(path);
        removed.push(path);
      } catch (error) {
        fail(path, error);
      }
    }
  } catch (error) {
    if (!isMissingDirectory(error)) fail(options.root, error);
  }
  return { removed, failures };
}

/**
 * Enable the V8 compile cache without ever making startup depend on it.
 *
 * The launcher sets `NODE_COMPILE_CACHE` before the process starts, which also caches the main
 * Host bundle. This runtime call covers lazily imported modules (bundled plugins) and direct
 * `node local-api.cjs` launches. An unavailable, unwritable, or corrupt cache degrades to the
 * returned coded result; the caller logs it once and continues.
 */
export function enableLocalApiCompileCache(options: {
  env?: Environment;
  directory?: string;
  moduleApi?: CompileCacheModuleApi;
} = {}): LocalApiCompileCacheResult {
  const env = options.env ?? process.env;
  const api = options.moduleApi ?? (nodeModule as CompileCacheModuleApi);
  const directory = options.directory ?? localApiCompileCacheDir(env);

  const alreadyEnabled = api.getCompileCacheDir?.();
  if (alreadyEnabled) {
    return { enabled: true, directory: alreadyEnabled };
  }
  if (typeof api.enableCompileCache !== "function") {
    return {
      enabled: false,
      directory,
      code: HOST_COMPILE_CACHE_UNAVAILABLE,
      reason: "module.enableCompileCache is unavailable in this runtime",
    };
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const result = api.enableCompileCache(directory);
    const status = result?.status;
    const enabledStatus = api.constants?.compileCacheStatus?.ENABLED;
    const alreadyStatus = api.constants?.compileCacheStatus?.ALREADY_ENABLED;
    if (
      status === undefined ||
      status === enabledStatus ||
      status === alreadyStatus
    ) {
      return { enabled: true, directory: result?.directory ?? directory };
    }
    return {
      enabled: false,
      directory,
      code: HOST_COMPILE_CACHE_UNAVAILABLE,
      reason: result?.message ?? `compile cache status ${String(status)}`,
    };
  } catch (error) {
    return {
      enabled: false,
      directory,
      code: HOST_COMPILE_CACHE_UNAVAILABLE,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
