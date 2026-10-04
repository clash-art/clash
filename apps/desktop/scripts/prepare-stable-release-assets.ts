#!/usr/bin/env node
/**
 * Before `gh release create` for a desktop stable tag, download the previous
 * stable release's macOS zip blockmap into the release tree so
 * `releases/latest/download/Clash-Desktop-{prev}-macOS-arm64.zip.blockmap`
 * resolves for electron-updater differential updates.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GITHUB_REPOSITORY } from "../src/app-update.ts";
import { clashMacArm64ZipBlockmapName } from "./desktop-release-assets.ts";

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseStableVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareStableVersions(a: string, b: string): number {
  const left = parseStableVersion(a);
  const right = parseStableVersion(b);
  if (!left || !right) return 0;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function listStableVersions(tags: string[]): string[] {
  return tags
    .map((tag) => (tag.startsWith("v") ? tag.slice(1) : tag))
    .filter((version) => parseStableVersion(version))
    .sort(compareStableVersions);
}

export function previousStableVersion(
  currentVersion: string,
  tags: string[],
): string | null {
  const versions = listStableVersions(tags);
  const index = versions.indexOf(currentVersion);
  if (index <= 0) return null;
  return versions[index - 1] ?? null;
}

/** Stable mac zip blockmap asset name for a semver (versioned artifact). */
export function macZipBlockmapName(version: string): string {
  return clashMacArm64ZipBlockmapName(version);
}

export function findStableMacZip(releaseRoot: string): string {
  const result = spawnSync(
    "find",
    [releaseRoot, "-type", "f", "-name", "Clash-Desktop-*-macOS-arm64.zip"],
    { encoding: "utf8" },
  );
  const candidates = (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.includes("preview"));
  if (candidates.length !== 1) {
    throw new Error(
      `expected one stable mac zip under ${releaseRoot}, found ${candidates.join(", ") || "(none)"}`,
    );
  }
  return candidates[0];
}

function ghEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GH_TOKEN: env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "" };
}

function listRemoteStableTags(env: NodeJS.ProcessEnv, repository: string): string[] {
  const result = spawnSync(
    "gh",
    ["api", `repos/${repository}/tags`, "--paginate", "--jq", ".[].name"],
    { encoding: "utf8", env: ghEnv(env) },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "gh api tags failed");
  }
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => STABLE_TAG.test(line));
}

function assetExistsOnRelease(
  env: NodeJS.ProcessEnv,
  repository: string,
  tag: string,
  assetName: string,
): boolean {
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${repository}/releases/tags/${tag}`,
      "--jq",
      `.assets[] | select(.name == "${assetName}") | .name`,
    ],
    { encoding: "utf8", env: ghEnv(env) },
  );
  return result.status === 0 && (result.stdout ?? "").trim() === assetName;
}

export type PrepareBlockmapResult =
  | {
      status: "ok";
      previousTag: string;
      assetName: string;
      path: string;
      previousVersion: string;
    }
  | {
      status:
        | "no-previous-stable"
        | "missing-on-previous-release"
        | "download-failed";
      previousTag?: string;
      assetName?: string;
      message?: string;
    };

export function preparePreviousStableBlockmap(input: {
  releaseRoot: string;
  currentTag: string;
  env?: NodeJS.ProcessEnv;
  repository?: string;
}): PrepareBlockmapResult {
  const env = input.env ?? process.env;
  const repository = input.repository ?? env.GITHUB_REPOSITORY ?? GITHUB_REPOSITORY;
  const match = STABLE_TAG.exec(input.currentTag.trim());
  if (!match) {
    throw new Error(
      `current tag must be vX.Y.Z, got ${JSON.stringify(input.currentTag)}`,
    );
  }
  const currentVersion = `${match[1]}.${match[2]}.${match[3]}`;
  const tags = listRemoteStableTags(env, repository);
  const previousVersion = previousStableVersion(currentVersion, tags);
  if (!previousVersion) {
    return {
      status: "no-previous-stable",
      message: `no stable release before v${currentVersion}`,
    };
  }

  const assetName = macZipBlockmapName(previousVersion);
  const previousTag = `v${previousVersion}`;
  if (!assetExistsOnRelease(env, repository, previousTag, assetName)) {
    return {
      status: "missing-on-previous-release",
      previousTag,
      assetName,
      message: `${previousTag} has no ${assetName}; differential update from ${previousVersion} may fall back to full download`,
    };
  }

  const zipPath = findStableMacZip(input.releaseRoot);
  const dest = join(dirname(zipPath), assetName);
  const cacheDir = join(input.releaseRoot, ".previous-stable-assets");
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, assetName);
  if (!existsSync(cached)) {
    const dl = spawnSync(
      "gh",
      ["release", "download", previousTag, "-p", assetName, "-D", cacheDir],
      { encoding: "utf8", env: ghEnv(env) },
    );
    if (dl.status !== 0 || !existsSync(cached)) {
      return {
        status: "download-failed",
        previousTag,
        assetName,
        message: `gh release download ${previousTag} ${assetName} failed: ${dl.stderr || dl.stdout}`,
      };
    }
  }
  copyFileSync(cached, dest);
  return {
    status: "ok",
    previousTag,
    assetName,
    path: dest,
    previousVersion,
  };
}

function emitWarning(message: string): void {
  console.warn(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(
      `::warning title=stable blockmap helper::${message.replace(/\n/g, " ")}`,
    );
  }
}

async function main(): Promise<void> {
  const releaseRoot = resolve(process.argv[2] ?? "apps/desktop/release");
  const currentTag = process.env.GITHUB_REF_NAME ?? process.argv[3] ?? "";
  const result = preparePreviousStableBlockmap({ releaseRoot, currentTag });
  const manifestPath = join(releaseRoot, "previous-stable-blockmap.json");
  writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`);

  if (result.status === "ok") {
    console.log(`prepared ${result.path} from ${result.previousTag}`);
    return;
  }
  emitWarning(result.message ?? result.status);
  console.log(result.message ?? result.status);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
