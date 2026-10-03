import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export function listFiles(directory: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(path.relative(directory, full));
    }
  };
  walk(directory);
  files.sort();
  return files;
}

function tarField(header: Buffer, start: number, length: number): string {
  return header
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "");
}

function tarEntryName(header: Buffer): string {
  const name = tarField(header, 0, 100);
  const prefix = tarField(header, 345, 155);
  if (prefix && name) return `${prefix}/${name}`;
  return name || prefix;
}

/** Extract a gzip-compressed tar without the system tar. Windows GNU tar treats `C:` as a host. */
export function extractTarGz(tarballPath: string, destination: string): void {
  const archive = gunzipSync(readFileSync(tarballPath));
  let offset = 0;
  let pendingName: string | undefined;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    offset += 512;
    const sizeText = tarField(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar entry size at offset ${offset}`);
    }
    const data = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const typeflag = header[156] ?? 0;
    if (typeflag === 76) {
      pendingName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (typeflag === 120) {
      const pathRecord = data
        .toString("utf8")
        .match(/(?:^|\n)\d+ path=([^\n]*)/);
      if (pathRecord?.[1]) pendingName = pathRecord[1];
      continue;
    }
    const name = pendingName || tarEntryName(header);
    pendingName = undefined;
    if (!name) continue;
    if (name.split("/").includes("..") || path.isAbsolute(name)) {
      throw new Error(`Refusing tar entry ${name}`);
    }
    const target = path.join(destination, name);
    if (typeflag === 53 || name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (typeflag !== 0 && typeflag !== 48) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

export function distMismatches(
  packedDist: string,
  sourceDist: string,
): string[] {
  const packed = listFiles(packedDist);
  const source = new Set(listFiles(sourceDist));
  const mismatches: string[] = [];
  for (const relative of packed) {
    if (!source.delete(relative)) {
      mismatches.push(`missing in checkout: ${relative}`);
      continue;
    }
    const packedHash = createHash("sha256")
      .update(readFileSync(path.join(packedDist, relative)))
      .digest("hex");
    const sourceHash = createHash("sha256")
      .update(readFileSync(path.join(sourceDist, relative)))
      .digest("hex");
    if (packedHash !== sourceHash)
      mismatches.push(`hash mismatch: ${relative}`);
  }
  for (const extra of source) mismatches.push(`extra in checkout: ${extra}`);
  return mismatches;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

const committedDist = [
  "dist/chat-ui/index.js",
  "dist/agent-ui/index.js",
  "dist/acp-runtime/index.js",
  "dist/protocol/acp/index.js",
];

/** A release asset is optional. v0.7.4 publishes the prebuilt tree only in git. */
export function tarballPinMode(url: string, digest: string): "tarball" | "git" {
  const hasUrl = url.trim().length > 0;
  const hasDigest = digest.trim().length > 0;
  if (hasUrl !== hasDigest) {
    throw new Error(
      "OPENMA_COMMON_TARBALL_URL and OPENMA_COMMON_TARBALL_SHA256 must both be set or both be empty",
    );
  }
  return hasUrl ? "tarball" : "git";
}

function assertCommittedDist(root: string, sha: string): void {
  for (const relative of committedDist) {
    git(["-C", root, "cat-file", "-e", `${sha}:${relative}`]);
    const info = statSync(path.join(root, relative));
    if (!info.isFile() || info.size === 0) {
      throw new Error(`OpenMA committed dist is empty: ${relative}`);
    }
  }
}

export function verifyOpenmaPrebuilt(): void {
  const workspace = requireEnv("GITHUB_WORKSPACE");
  const sha = requireEnv("OPENMA_COMMON_SHA");
  const tag = requireEnv("OPENMA_COMMON_TAG");
  const expectedDigest = process.env.OPENMA_COMMON_TARBALL_SHA256 ?? "";
  const tarballUrl = process.env.OPENMA_COMMON_TARBALL_URL ?? "";
  const root = path.resolve(workspace, "..", "openma-common");
  if (git(["-C", root, "rev-parse", "HEAD"]) !== sha) {
    throw new Error(`OpenMA checkout is not ${sha}`);
  }
  if (git(["-C", root, "rev-parse", `${tag}^{commit}`]) !== sha) {
    throw new Error(`OpenMA tag ${tag} does not peel to ${sha}`);
  }
  assertCommittedDist(root, sha);
  if (tarballPinMode(tarballUrl, expectedDigest) === "git") {
    console.log(
      `OpenMA ${tag} ${sha} uses committed dist; this tag publishes no release tarball`,
    );
    return;
  }

  const scratch = mkdtempSync(path.join(tmpdir(), "openma-prebuilt-"));
  try {
    const tarball = path.join(scratch, "openma-common.tgz");
    const download = spawnSync(
      "curl",
      ["-fsSL", "-o", tarball, tarballUrl.trim()],
      {
        encoding: "utf8",
      },
    );
    if (download.status !== 0) {
      throw new Error(`OpenMA tarball download failed\n${download.stderr}`);
    }
    const actualDigest = createHash("sha256")
      .update(readFileSync(tarball))
      .digest("hex");
    if (actualDigest !== expectedDigest.trim()) {
      throw new Error(
        `OpenMA tarball sha256 ${actualDigest} != ${expectedDigest.trim()}`,
      );
    }
    extractTarGz(tarball, scratch);
    const mismatches = distMismatches(
      path.join(scratch, "package", "dist"),
      path.join(root, "dist"),
    );
    if (mismatches.length > 0) {
      throw new Error(
        `Committed OpenMA dist does not match the release tarball\n${mismatches
          .slice(0, 20)
          .join("\n")}`,
      );
    }
    console.log(
      `OpenMA ${tag} ${sha} dist matches the published release tarball`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return (
    pathToFileURL(path.resolve(entry)).href ===
    pathToFileURL(path.resolve(fileURLToPath(import.meta.url))).href
  );
}

if (isDirectRun()) {
  try {
    verifyOpenmaPrebuilt();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
