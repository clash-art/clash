import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hydrateMacGuiPathAsync,
  readMacGuiPathCache,
  resolveMacGuiPath,
  startMacGuiPathHydration,
} from "./shell-path";
import { performance } from "node:perf_hooks";

describe("macOS GUI shell PATH", () => {
  it("merges login shell PATH and common user binary paths ahead of the Finder default PATH", () => {
    const path = resolveMacGuiPath({
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        SHELL: "/bin/zsh",
      },
      homeDir: "/Users/tester",
      platform: "darwin",
      readLoginShellPath: () => "/opt/homebrew/bin:/Users/tester/.npm-global/bin:/usr/bin:/bin",
    });

    const segments = path.split(":");
    expect(segments.slice(0, 2)).toEqual(["/opt/homebrew/bin", "/Users/tester/.npm-global/bin"]);
    expect(segments).toContain("/usr/local/bin");
    expect(segments).toContain("/Users/tester/.local/bin");
    expect(segments).toContain("/usr/bin");
    expect(new Set(segments).size).toBe(segments.length);
  });

  it("leaves non-macOS PATH unchanged", () => {
    expect(resolveMacGuiPath({
      env: { PATH: "/custom/bin:/usr/bin" },
      homeDir: "/Users/tester",
      platform: "linux",
      readLoginShellPath: () => "/ignored/bin",
    })).toBe("/custom/bin:/usr/bin");
  });
});

describe("hydrateMacGuiPathAsync", () => {
  it("leaves PATH untouched off macOS", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/does/not/exist" };
    await hydrateMacGuiPathAsync(env, "linux");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("puts the login shell PATH first without blocking on a synchronous spawn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clash-shell-path-"));
    const shell = join(dir, "login-shell");
    await writeFile(shell, "#!/bin/sh\nprintf %s /login/bin:/usr/bin\n");
    await chmod(shell, 0o755);
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: shell };
    await hydrateMacGuiPathAsync(env, "darwin");
    expect(env.PATH?.split(":").slice(0, 2)).toEqual(["/login/bin", "/usr/bin"]);
  });
});


describe("non-blocking macOS PATH hydration", () => {
  async function executableShell(source: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "clash-slow-shell-"));
    const shell = join(dir, "login-shell");
    await writeFile(shell, `#!/bin/sh\n${source}\n`);
    await chmod(shell, 0o755);
    return shell;
  }

  it("does not add the login-shell delay to host launch sequencing", async () => {
    const shell = await executableShell("sleep 2\nprintf %s /late/bin:/usr/bin");
    const warnings: Array<{ event: string; context: Record<string, unknown> }> = [];
    const started = performance.now();
    const hydration = startMacGuiPathHydration({
      env: { PATH: "/usr/bin:/bin", SHELL: shell },
      platform: "darwin",
      homeDir: "/Users/tester",
      timeoutMs: 500,
      onWarning: (event, context) => warnings.push({ event, context }),
    });
    // The real sequence starts the fingerprint and launches the Host without
    // touching pathReady; 20 ms stands in for both.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const launchSequencingMs = performance.now() - started;
    expect(launchSequencingMs).toBeLessThan(500);

    const result = await hydration.pathReady;
    expect(result.timedOut).toBe(true);
    expect(result.source).toBe("fallback");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      event: "DESKTOP_SHELL_PATH_TIMEOUT",
      context: { fallbackPath: hydration.currentPath },
    });
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 5_000);

  it("applies the cached PATH immediately and keeps it when the shell times out", async () => {
    const shell = await executableShell("sleep 2\nprintf %s /late/bin");
    const cacheDir = await mkdtemp(join(tmpdir(), "clash-path-cache-"));
    const cachePath = join(cacheDir, "user-data", "shell-path.json");
    const first = startMacGuiPathHydration({
      env: { PATH: "/usr/bin:/bin", SHELL: shell },
      platform: "darwin",
      homeDir: "/Users/tester",
      timeoutMs: 10,
      cachePath,
    });
    await first.pathReady;
    // A failed lookup must not write a cache; seed the last-good value directly.
    await mkdir(join(cacheDir, "user-data"), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        path: "/cached/bin:/usr/bin",
        updatedAt: new Date().toISOString(),
      }),
    );
    const warnings: string[] = [];
    const hydration = startMacGuiPathHydration({
      env: { PATH: "/usr/bin:/bin", SHELL: shell },
      platform: "darwin",
      homeDir: "/Users/tester",
      timeoutMs: 10,
      cachePath,
      onWarning: (event) => warnings.push(event),
    });
    expect(hydration.currentPath.split(":")[0]).toBe("/cached/bin");
    const result = await hydration.pathReady;
    expect(result.source).toBe("cache");
    expect(result.path).toBe(hydration.currentPath);
    expect(warnings).toEqual(["DESKTOP_SHELL_PATH_TIMEOUT"]);
    expect(readMacGuiPathCache(cachePath)).toBe("/cached/bin:/usr/bin");
  });

  it("persists a successful hydration for the next launch", async () => {
    const shell = await executableShell("printf %s /login/bin:/usr/bin");
    const cacheDir = await mkdtemp(join(tmpdir(), "clash-path-cache-ok-"));
    const cachePath = join(cacheDir, "shell-path.json");
    const hydration = startMacGuiPathHydration({
      env: { PATH: "/usr/bin:/bin", SHELL: shell },
      platform: "darwin",
      homeDir: "/Users/tester",
      timeoutMs: 500,
      cachePath,
    });
    const result = await hydration.pathReady;
    expect(result.source).toBe("login-shell");
    expect(result.path.split(":")[0]).toBe("/login/bin");
    expect(readMacGuiPathCache(cachePath)).toBe(result.path);
  });

  it("logs a coded failure when the shell exits unsuccessfully", async () => {
    const shell = await executableShell("exit 7");
    const warnings: Array<{ event: string; context: Record<string, unknown> }> = [];
    const hydration = startMacGuiPathHydration({
      env: { PATH: "/usr/bin:/bin", SHELL: shell },
      platform: "darwin",
      homeDir: "/Users/tester",
      timeoutMs: 500,
      onWarning: (event, context) => warnings.push({ event, context }),
    });
    const result = await hydration.pathReady;
    expect(result.source).toBe("fallback");
    expect(result.timedOut).toBe(false);
    expect(warnings[0]).toMatchObject({
      event: "DESKTOP_SHELL_PATH_FAILED",
      context: { fallbackPath: hydration.currentPath },
    });
  });
});
