import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  acquirePinnedNodeArchive,
  pinnedNodeArchive,
  stageSelfContainedRuntime,
  type NodeRuntimeLock,
} from "./self-contained-runtime.ts";

const execute = promisify(execFile);
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function fixtureArchive(root: string, target: string) {
  const top = `node-vtest-${target}`;
  await mkdir(join(root, top, "bin"), { recursive: true });
  await writeFile(join(root, top, "bin", "node"), "#!/bin/sh\necho fixture-node \"$@\"\n");
  await chmod(join(root, top, "bin", "node"), 0o755);
  await writeFile(join(root, top, "LICENSE"), "fixture licence\n");
  await writeFile(join(root, top, "bin", "npm"), "must not ship\n");
  const file = `${top}.tar.gz`;
  await execute("tar", ["-czf", join(root, file), "-C", root, top]);
  return { file, sha256: digest(await readFile(join(root, file))) };
}

test("a Node archive is accepted only when it matches the checked-in pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-node-pin-"));
  try {
    const lock: NodeRuntimeLock = {
      version: "test", baseUrl: "https://example.invalid/dist/",
      archives: { "linux-x64": { file: "node.tar.gz", sha256: digest("official bytes") } },
    };
    const target = { platform: "linux" as const, arch: "x64" };
    assert.equal(pinnedNodeArchive(lock, target).url, "https://example.invalid/dist/node.tar.gz");
    assert.throws(() => pinnedNodeArchive(lock, { platform: "linux", arch: "riscv64" }), /No pinned Node/u);
    await assert.rejects(
      acquirePinnedNodeArchive(lock, target, { cacheDir: join(root, "bad"), download: (_url, path) => writeFile(path, "tampered bytes") }),
      /does not match its pinned SHA-256/u,
    );
    await assert.rejects(stat(join(root, "bad", "node.tar.gz")));
    let downloads = 0;
    const download = async (_url: string, path: string) => { downloads += 1; await writeFile(path, "official bytes"); };
    const first = await acquirePinnedNodeArchive(lock, target, { cacheDir: join(root, "good"), download });
    assert.equal(await acquirePinnedNodeArchive(lock, target, { cacheDir: join(root, "good"), download }), first);
    assert.equal(downloads, 1);
    // A corrupted cache entry is replaced rather than trusted.
    await writeFile(first, "corrupted");
    await acquirePinnedNodeArchive(lock, target, { cacheDir: join(root, "good"), download });
    assert.equal(await readFile(first, "utf8"), "official bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging adds a launcher that runs the bundled Node and a manifest describing what shipped", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "clash-self-contained-"));
  try {
    const target = { platform: process.platform, arch: process.arch };
    const id = `${target.platform}-${target.arch}`;
    const archive = await fixtureArchive(root, id);
    const lock: NodeRuntimeLock = { version: "test", baseUrl: "https://example.invalid/", archives: { [id]: archive } };
    const stage = join(root, "stage");
    for (const tool of ["ffmpeg", "ffprobe"]) {
      await mkdir(join(stage, "node_modules", `@${tool}-installer`, id), { recursive: true });
      await writeFile(join(stage, "node_modules", `@${tool}-installer`, id, tool), `${tool} payload`);
    }
    await mkdir(join(stage, "runtime"));
    await writeFile(join(stage, ".mcp.json"), JSON.stringify({
      mcpServers: { clash: { command: "node", args: ["./runtime/dispatcher.js", "mcp"], cwd: "." } },
    }));
    const input = {
      lock, target, nodeArchivePath: join(root, archive.file),
      package: { name: "clash", version: "9.9.9" }, runtimeDependenciesSha256: "sha256:dependencies",
    };
    const manifest = await stageSelfContainedRuntime(stage, input);
    assert.deepEqual(JSON.parse(await readFile(join(stage, "self-contained.json"), "utf8")), manifest);
    assert.equal(manifest.node.sha256, digest(await readFile(join(stage, manifest.node.path))));
    assert.equal(manifest.node.archive.sha256, archive.sha256);
    assert.equal(manifest.media.ffprobe.sha256, digest("ffprobe payload"));
    assert.equal(manifest.runtimeDependencies.sha256, "sha256:dependencies");
    await assert.rejects(stat(join(stage, "node", "bin", "npm")));

    // The launcher resolves its own location, also through a symlink, and ignores PATH.
    const { stdout } = await execute(join(stage, manifest.launcher), ["mcp"], { env: { PATH: "/nonexistent" }, cwd: root });
    assert.equal(stdout.trim(), `fixture-node ${join(stage, "runtime", "dispatcher.js")} mcp`);
    await symlink(join(stage, manifest.launcher), join(root, "clash-link"));
    const linked = await execute(join(root, "clash-link"), ["--version"], { env: { PATH: "/usr/bin:/bin" }, cwd: stage });
    assert.equal(linked.stdout.trim(), `fixture-node ${join(stage, "runtime", "dispatcher.js")} --version`);
    const declared = JSON.parse(await readFile(join(stage, ".mcp.json"), "utf8")).mcpServers.clash;
    assert.deepEqual([declared.command, declared.args], ["./bin/clash", ["mcp"]]);

    await writeFile(join(root, archive.file), "tampered");
    await assert.rejects(stageSelfContainedRuntime(stage, input), /does not match its pinned SHA-256/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
