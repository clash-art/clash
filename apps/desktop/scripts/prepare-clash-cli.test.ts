import { sourceContains, sourceMatches } from "../../../packages/gui/test-support/source-match.ts";
import { describe, expect, it } from "vitest";
import {
  ensurePackagedMediaBinariesExecutable,
  packagedRuntimeArtifacts,
  resolveNpmInvocation,
} from "./prepare-clash-cli.ts";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("prepare packaged Clash CLI", () => {
  it("only stages the runtime built by the root dependency graph", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("./prepare-clash-cli.ts", import.meta.url), "utf8"),
    );
    expect(sourceContains(source, "build:package")).toBe(false);
    expect(sourceContains(source, "staging the prebuilt unified Clash runtime")).toBe(true);
    expect(sourceContains(source, "pnpm prepare:desktop-pack")).toBe(true);
    expect(sourceMatches(source, /"deploy",\s*"--legacy",\s*"--prod"/)).toBe(false);
    expect(sourceContains(source, '"--omit=dev"')).toBe(true);
  });

  it("uses npm without inheriting the active pnpm entrypoint", () => {
    expect(
      resolveNpmInvocation({
        env: { npm_execpath: String.raw`D:\pnpm\pnpm.cjs` },
        platform: "linux",
      }),
    ).toEqual({ command: "npm", argsPrefix: [] });
  });

  it("derives the flattened Desktop resource layout from clashRuntime", () => {
    expect(
      packagedRuntimeArtifacts({
        clashRuntime: {
          dispatcher: "./runtime/dispatcher.js",
          localApi: "./runtime/local-api.cjs",
          agents: "./runtime/agents",
        },
      }),
    ).toEqual({
      dispatcher: "./dispatcher.js",
      localApi: "./local-api.cjs",
      agents: "./agents",
    });
  });

  it("rejects runtime declarations that escape the shared artifact root", () => {
    expect(() =>
      packagedRuntimeArtifacts({
        clashRuntime: { localApi: "./runtime/../other.cjs" },
      }),
    ).toThrow(/unsafe clashRuntime\.localApi/);
  });

  it("makes ignore-scripts media payloads executable before Desktop packaging", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clash-desktop-media-"));
    try {
      const target = "darwin-arm64";
      const ffmpeg = path.join(
        root,
        "node_modules",
        "@ffmpeg-installer",
        target,
        "ffmpeg",
      );
      const ffprobe = path.join(
        root,
        "node_modules",
        "@ffprobe-installer",
        target,
        "ffprobe",
      );
      await Promise.all([
        mkdir(path.dirname(ffmpeg), { recursive: true }),
        mkdir(path.dirname(ffprobe), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(ffmpeg, "ffmpeg"),
        writeFile(ffprobe, "ffprobe"),
      ]);
      await Promise.all([chmod(ffmpeg, 0o644), chmod(ffprobe, 0o644)]);

      await ensurePackagedMediaBinariesExecutable(root, {
        platform: "darwin",
        arch: "arm64",
      });
      await expect(access(ffmpeg, constants.X_OK)).resolves.toBeUndefined();
      await expect(access(ffprobe, constants.X_OK)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
