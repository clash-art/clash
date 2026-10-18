import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hydrateMacGuiPathAsync, resolveMacGuiPath } from "./shell-path";

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
