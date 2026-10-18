import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  HOST_COMPILE_CACHE_PRUNE_FAILED,
  HOST_COMPILE_CACHE_UNAVAILABLE,
  clearLocalApiCompileCacheEnvironment,
  enableLocalApiCompileCache,
  localApiCompileCacheDir,
  localApiCompileCacheRoot,
  pruneLocalApiCompileCache,
  withoutLocalApiCompileCacheEnvironment,
  type CompileCacheModuleApi,
} from "./local-compile-cache.js";

const enabledConstants = {
  compileCacheStatus: { ENABLED: 1, ALREADY_ENABLED: 2 },
};

describe("local API compile cache", () => {
  it("keeps the cache under CLASH_HOME and keys it by runtime fingerprint", () => {
    expect(
      localApiCompileCacheDir(
        {
          CLASH_HOME: "/tmp/clash-home",
          CLASH_DAEMON_RUNTIME_FINGERPRINT: "sha256:abc/def",
        },
        "/tmp/clash-home/local-api",
      ),
    ).toBe("/tmp/clash-home/cache/compile/sha256-abc_def");
  });

  it("exposes the cache root and strips the selectors from child environments", () => {
    expect(
      localApiCompileCacheRoot(
        { CLASH_HOME: "/tmp/clash-home" },
        "/tmp/clash-home/local-api",
      ),
    ).toBe("/tmp/clash-home/cache/compile");

    const env = {
      PATH: "/usr/bin:/bin",
      NODE_COMPILE_CACHE: "/tmp/clash-home/cache/compile/current",
      CLASH_COMPILE_CACHE_DIR: "/tmp/clash-home/cache/compile/current",
    };
    expect(withoutLocalApiCompileCacheEnvironment(env)).toEqual({
      PATH: "/usr/bin:/bin",
    });
    clearLocalApiCompileCacheEnvironment(env);
    expect(env).toEqual({ PATH: "/usr/bin:/bin" });
  });

  it("prunes obsolete sibling directories without following links or leaving the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-compile-prune-"));
    const cacheRoot = join(root, "cache", "compile");
    const current = join(cacheRoot, "sha256-current");
    const obsolete = join(cacheRoot, "sha256-obsolete");
    const outside = join(root, "outside");
    await mkdir(current, { recursive: true });
    await mkdir(obsolete, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(obsolete, "stale.cache"), "stale");
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, join(cacheRoot, "sha256-linked"), "dir");
    await writeFile(join(cacheRoot, "not-a-directory"), "file");

    try {
      const failures = vi.fn();
      const result = pruneLocalApiCompileCache({
        root: cacheRoot,
        currentKey: "sha256-current",
        onFailure: failures,
      });

      expect(result.removed).toEqual([obsolete]);
      expect(result.failures).toEqual([]);
      expect(failures).not.toHaveBeenCalled();
      expect(existsSync(current)).toBe(true);
      expect(existsSync(obsolete)).toBe(false);
      expect(await readdir(outside)).toEqual(["keep.txt"]);
      expect((await lstat(join(cacheRoot, "sha256-linked"))).isSymbolicLink()).toBe(
        true,
      );
      expect((await readdir(cacheRoot)).sort()).toEqual([
        "not-a-directory",
        "sha256-current",
        "sha256-linked",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports each failed removal with the coded prune warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-compile-prune-fail-"));
    const cacheRoot = join(root, "cache", "compile");
    const current = join(cacheRoot, "sha256-current");
    const obsolete = join(cacheRoot, "sha256-obsolete");
    await mkdir(current, { recursive: true });
    await mkdir(obsolete, { recursive: true });

    try {
      const failures = vi.fn();
      const result = pruneLocalApiCompileCache({
        root: cacheRoot,
        currentKey: "sha256-current",
        onFailure: failures,
        removeDirectory: () => {
          throw new Error("directory is busy");
        },
      });

      expect(result.removed).toEqual([]);
      expect(result.failures).toEqual([
        {
          path: obsolete,
          code: HOST_COMPILE_CACHE_PRUNE_FAILED,
          reason: "directory is busy",
        },
      ]);
      expect(failures).toHaveBeenCalledWith(result.failures[0]);
      expect(existsSync(obsolete)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses an explicit cache directory and a stable key without a fingerprint", () => {
    expect(
      localApiCompileCacheDir({
        CLASH_HOME: "/tmp/clash-home",
        CLASH_COMPILE_CACHE_DIR: "/tmp/explicit-cache",
      }),
    ).toBe("/tmp/explicit-cache");
    expect(
      localApiCompileCacheDir({
        CLASH_HOME: "/tmp/clash-home",
        CLASH_LOCAL_DATA_DIR: "/tmp/clash-home/local-api",
      }),
    ).toBe("/tmp/clash-home/cache/compile/unversioned");
  });

  it("reports an already-enabled cache instead of reconfiguring it", () => {
    const result = enableLocalApiCompileCache({
      env: { CLASH_HOME: "/tmp/clash-home" },
      moduleApi: {
        getCompileCacheDir: () => "/tmp/already-enabled",
        enableCompileCache: () => {
          throw new Error("must not be called");
        },
      },
    });
    expect(result).toEqual({ enabled: true, directory: "/tmp/already-enabled" });
  });

  it("enables a writable directory and reports its resolved location", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-compile-cache-"));
    const directory = join(root, "cache");
    try {
      const calls: string[] = [];
      const moduleApi: CompileCacheModuleApi = {
        constants: enabledConstants,
        enableCompileCache: (target) => {
          calls.push(target!);
          return { status: 1, directory: target };
        },
      };
      expect(
        enableLocalApiCompileCache({
          directory,
          moduleApi,
        }),
      ).toEqual({ enabled: true, directory });
      expect(calls).toEqual([directory]);
      expect((await stat(directory)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("turns a failed or missing module API into the coded fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-compile-cache-fail-"));
    try {
      const failed = enableLocalApiCompileCache({
        directory: join(root, "failed"),
        moduleApi: {
          constants: enabledConstants,
          enableCompileCache: () => ({
            status: 0,
            message: "cache directory is not writable",
          }),
        },
      });
      expect(failed).toMatchObject({
        enabled: false,
        code: HOST_COMPILE_CACHE_UNAVAILABLE,
        reason: "cache directory is not writable",
      });

      const missing = enableLocalApiCompileCache({
        directory: join(root, "missing"),
        moduleApi: {},
      });
      expect(missing).toMatchObject({
        enabled: false,
        code: HOST_COMPILE_CACHE_UNAVAILABLE,
      });

      const file = join(root, "not-a-directory");
      await writeFile(file, "file");
      const unwritable = enableLocalApiCompileCache({
        directory: file,
        moduleApi: {
          constants: enabledConstants,
          enableCompileCache: () => ({ status: 1 }),
        },
      });
      expect(unwritable).toMatchObject({
        enabled: false,
        code: HOST_COMPILE_CACHE_UNAVAILABLE,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
