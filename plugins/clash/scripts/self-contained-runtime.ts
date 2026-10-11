import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { packagedMediaBinaryPaths } from "../../../scripts/packaged-runtime-binaries.ts";

const execute = promisify(execFile);

export const SELF_CONTAINED_MANIFEST = "self-contained.json";

export type NodeRuntimeLock = {
  version: string;
  baseUrl: string;
  archives: Record<string, { file: string; sha256: string }>;
};

export type SelfContainedTarget = { platform: NodeJS.Platform; arch: string };

export type SelfContainedManifest = {
  schemaVersion: 1;
  package: { name: string; version: string };
  platform: string;
  arch: string;
  /** Package-relative POSIX paths; the launcher never consults PATH for Node. */
  launcher: string;
  node: {
    version: string;
    path: string;
    sha256: string;
    archive: { url: string; sha256: string };
  };
  runtimeDependencies: { sha256: string };
  media: Record<"ffmpeg" | "ffprobe", { path: string; sha256: string }>;
};

export function selfContainedTargetId(target: SelfContainedTarget): string {
  return `${target.platform}-${target.arch}`;
}

export function pinnedNodeArchive(lock: NodeRuntimeLock, target: SelfContainedTarget) {
  const archive = lock.archives[selfContainedTargetId(target)];
  if (!archive) {
    throw new Error(`No pinned Node ${lock.version} archive for ${selfContainedTargetId(target)}`);
  }
  if (!/^[0-9a-f]{64}$/u.test(archive.sha256) || /[\\/]/u.test(archive.file)) {
    throw new Error(`Invalid pinned Node archive entry for ${selfContainedTargetId(target)}`);
  }
  return { ...archive, url: new URL(archive.file, lock.baseUrl).href };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Returns a local copy of the pinned official archive. A cached or downloaded
 * file is accepted only when its digest equals the checked-in pin.
 */
export async function acquirePinnedNodeArchive(
  lock: NodeRuntimeLock,
  target: SelfContainedTarget,
  { cacheDir, download = downloadFile }: {
    cacheDir: string;
    download?: (url: string, destination: string) => Promise<void>;
  },
): Promise<string> {
  const archive = pinnedNodeArchive(lock, target);
  const cached = join(cacheDir, archive.file);
  const matches = async (path: string) => {
    try {
      return (await sha256File(path)) === archive.sha256;
    } catch {
      return false;
    }
  };
  if (await matches(cached)) return cached;
  await mkdir(cacheDir, { recursive: true });
  const partial = `${cached}.${process.pid}.partial`;
  try {
    await download(archive.url, partial);
    if (!(await matches(partial))) {
      throw new Error(`Downloaded ${archive.file} does not match its pinned SHA-256 ${archive.sha256}`);
    }
    await rename(partial, cached);
  } finally {
    await rm(partial, { force: true });
  }
  return cached;
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  await writeFile(destination, response.body);
}

/** Windows ships bsdtar, which also reads zip; Git's GNU tar on PATH does not. */
export function archiveTool(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string {
  return platform === "win32" ? join(env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

// Shell built-ins only (readlink aside, for a symlinked launcher): it must work with an empty PATH.
const POSIX_LAUNCHER = [
  '#!/bin/sh',
  '# Self-contained Clash launcher: always runs the Node bundled beside it.',
  'self=$0',
  'while [ -h "$self" ]; do',
  '  link=$(readlink "$self") || exit 1',
  '  case $link in',
  '    /*) self=$link ;;',
  '    *) case $self in */*) self=${self%/*}/$link ;; *) self=$link ;; esac ;;',
  '  esac',
  'done',
  'case $self in */*) bin=${self%/*} ;; *) bin=. ;; esac',
  'root=$(CDPATH= cd "$bin/.." && pwd -P) || exit 1',
  'exec "$root/node/bin/node" "$root/runtime/dispatcher.js" "$@"',
  '',
].join("\n");

const WINDOWS_LAUNCHER = [
  "@echo off",
  "rem Self-contained Clash launcher: always runs the Node bundled beside it.",
  '"%~dp0..\\node\\node.exe" "%~dp0..\\runtime\\dispatcher.js" %*',
  "",
].join("\r\n");

const portable = (root: string, path: string) => relative(root, path).split("\\").join("/");

/**
 * Adds the pinned Node binary, a launcher and the identity manifest to a staged
 * distribution whose production dependencies are already installed.
 */
export async function stageSelfContainedRuntime(stage: string, input: {
  lock: NodeRuntimeLock;
  target: SelfContainedTarget;
  nodeArchivePath: string;
  package: { name: string; version: string };
  runtimeDependenciesSha256: string;
}): Promise<SelfContainedManifest> {
  const { lock, target } = input;
  const windows = target.platform === "win32";
  const archive = pinnedNodeArchive(lock, target);
  if ((await sha256File(input.nodeArchivePath)) !== archive.sha256) {
    throw new Error(`${archive.file} does not match its pinned SHA-256`);
  }
  const top = archive.file.replace(/\.(tar\.gz|zip)$/u, "");
  const binaryInArchive = windows ? `${top}/node.exe` : `${top}/bin/node`;
  const nodePath = windows ? join(stage, "node", "node.exe") : join(stage, "node", "bin", "node");
  const unpacked = await mkdtemp(join(tmpdir(), "clash-node-runtime-"));
  try {
    // Only the interpreter and its licence ship: npm, corepack and headers are build tools.
    await execute(archiveTool(target.platform), ["-xf", input.nodeArchivePath, "-C", unpacked, binaryInArchive, `${top}/LICENSE`]);
    await mkdir(join(nodePath, ".."), { recursive: true });
    await cp(join(unpacked, binaryInArchive), nodePath);
    await cp(join(unpacked, top, "LICENSE"), join(stage, "node", "LICENSE"));
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
  await mkdir(join(stage, "bin"), { recursive: true });
  const launcher = join(stage, "bin", windows ? "clash.cmd" : "clash");
  await writeFile(launcher, windows ? WINDOWS_LAUNCHER : POSIX_LAUNCHER);
  if (!windows) {
    await chmod(nodePath, 0o755);
    await chmod(launcher, 0o755);
  }
  // A plugin cache launches the MCP from this file; it must not need `node` on PATH either.
  const mcpPath = join(stage, ".mcp.json");
  const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as {
    mcpServers: Record<string, { command: string; args?: string[] }>;
  };
  for (const server of Object.values(mcp.mcpServers)) {
    if (server.command !== "node" || server.args?.[0] !== "./runtime/dispatcher.js") continue;
    const rest = server.args.slice(1);
    server.command = windows ? "cmd.exe" : "./bin/clash";
    server.args = windows ? ["/d", "/c", "bin\\clash.cmd", ...rest] : rest;
  }
  await writeFile(mcpPath, JSON.stringify(mcp, null, 2) + "\n");

  const media = packagedMediaBinaryPaths(stage, target);
  const manifest: SelfContainedManifest = {
    schemaVersion: 1,
    package: input.package,
    platform: target.platform,
    arch: target.arch,
    launcher: portable(stage, launcher),
    node: {
      version: lock.version,
      path: portable(stage, nodePath),
      sha256: await sha256File(nodePath),
      archive: { url: archive.url, sha256: archive.sha256 },
    },
    runtimeDependencies: { sha256: input.runtimeDependenciesSha256 },
    media: {
      ffmpeg: { path: portable(stage, media.ffmpeg), sha256: await sha256File(media.ffmpeg) },
      ffprobe: { path: portable(stage, media.ffprobe), sha256: await sha256File(media.ffprobe) },
    },
  };
  await writeFile(join(stage, SELF_CONTAINED_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
