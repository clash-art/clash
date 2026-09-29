import { sourceContains, sourceMatches } from "../../../packages/gui/test-support/source-match.ts";
import { describe, expect, it } from "vitest";
import {
  ensurePackagedMediaBinariesExecutable,
  stageBuiltinClashPlugin,
  packagedRuntimeArtifacts,
  resolveNpmInvocation,
} from "./prepare-clash-cli.ts";
import { access, chmod, mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

it("stages the canonical plugin manifest and skill content beside the flattened host", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clash-plugin-payload-"));
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "runtime");
    await mkdir(path.join(source, ".codex-plugin"), { recursive: true });
    await mkdir(path.join(source, "skills", "clash"), { recursive: true });
    const manifest = JSON.stringify({ name: "clash", skills: "./skills/", mcpServers: "./.mcp.json" });
    await writeFile(path.join(source, ".codex-plugin", "plugin.json"), manifest);
    await writeFile(path.join(source, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    await writeFile(path.join(source, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(path.join(source, "skills", "clash", "SKILL.md"), "Use the local Host.");
    await stageBuiltinClashPlugin(source, output);
    expect(await readFile(path.join(output, ".codex-plugin", "plugin.json"), "utf8")).toBe(manifest);
    expect(await readFile(path.join(output, "skills", "clash", "SKILL.md"), "utf8")).toBe("Use the local Host.");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("launches the declared MCP entrypoint from the flattened Desktop payload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clash-packaged-mcp-"));
  try {
    const source = path.resolve(import.meta.dirname, "../../../plugins/clash");
    // The runtime build is staged before plugin metadata. This probe occupies
    // the same entrypoint as the captured installed payload.
    await writeFile(path.join(root, "dispatcher.js"), "import process from 'node:process'; console.log(JSON.stringify(process.argv.slice(2)))");
    await stageBuiltinClashPlugin(source, root);
    const manifest = JSON.parse(await readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
    const config = JSON.parse(await readFile(path.resolve(root, manifest.mcpServers), "utf8"));
    const server = config.mcpServers.clash;
    // No syntax-detection fallback: the distributed package must carry the ESM
    // scope its real dispatcher was compiled for, independent of its parent cwd.
    const output = execFileSync(process.execPath, ["--no-experimental-detect-module", ...server.args], {
      cwd: path.resolve(root, server.cwd), encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual(["mcp"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
