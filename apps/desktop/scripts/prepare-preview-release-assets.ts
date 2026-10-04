#!/usr/bin/env node
/**
 * Before `gh release upload desktop-preview`, download the previous preview
 * macOS zip blockmap so versioned `Clash-Desktop-{prev}-macOS-arm64.zip.blockmap`
 * stays on the rolling release for electron-updater differential updates.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compareAppVersions,
  GITHUB_REPOSITORY,
  parseAppVersion,
} from "../src/app-update.ts";
import {
  clashMacArm64ZipBlockmapName,
  clashMacArm64ZipName,
} from "./desktop-release-assets.ts";
import { zipNameFromFeedYaml } from "./macos-update-e2e.ts";

function ghEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GH_TOKEN: env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "" };
}

function readCurrentPreviewVersion(releaseRoot: string): string {
  const ymlPath = join(releaseRoot, "preview-mac.yml");
  if (!existsSync(ymlPath)) {
    throw new Error(`missing ${ymlPath}`);
  }
  const yml = readFileSync(ymlPath, "utf8");
  const zipName = zipNameFromFeedYaml(yml);
  const match = /^Clash-Desktop-(.+)-macOS-arm64\.zip$/.exec(zipName);
  if (!match?.[1]) {
    throw new Error(`unexpected preview zip name ${zipName}`);
  }
  const version = match[1];
  if (!parseAppVersion(version)) {
    throw new Error(`preview zip version is not parseable: ${version}`);
  }
  return version;
}

function listPreviewBlockmapAssets(
  env: NodeJS.ProcessEnv,
  repository: string,
): string[] {
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${repository}/releases/tags/desktop-preview`,
      "--jq",
      '.assets[] | select(.name | endswith("-macOS-arm64.zip.blockmap")) | .name',
    ],
    { encoding: "utf8", env: ghEnv(env) },
  );
  if (result.status !== 0) {
    return [];
  }
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function previousPreviewBlockmapAsset(
  currentVersion: string,
  assetNames: string[],
): string | null {
  let best: string | null = null;
  let bestVersion: string | null = null;
  for (const assetName of assetNames) {
    const match = /^Clash-Desktop-(.+)-macOS-arm64\.zip\.blockmap$/.exec(
      assetName,
    );
    if (!match?.[1]) continue;
    const version = match[1];
    if (version === currentVersion) continue;
    if (compareAppVersions(version, currentVersion) !== null &&
        compareAppVersions(version, currentVersion)! >= 0) {
      continue;
    }
    if (
      bestVersion == null ||
      (compareAppVersions(version, bestVersion) ?? -1) > 0
    ) {
      best = assetName;
      bestVersion = version;
    }
  }
  return best;
}

export type PreparePreviewBlockmapResult =
  | {
      status: "ok";
      assetName: string;
      path: string;
      previousVersion: string;
    }
  | {
      status: "no-previous-preview" | "download-failed";
      assetName?: string;
      message?: string;
    };

export function preparePreviousPreviewBlockmap(input: {
  releaseRoot: string;
  env?: NodeJS.ProcessEnv;
  repository?: string;
}): PreparePreviewBlockmapResult {
  const env = input.env ?? process.env;
  const repository = input.repository ?? env.GITHUB_REPOSITORY ?? GITHUB_REPOSITORY;
  const currentVersion = readCurrentPreviewVersion(input.releaseRoot);
  const assets = listPreviewBlockmapAssets(env, repository);
  const assetName = previousPreviewBlockmapAsset(currentVersion, assets);
  if (!assetName) {
    return {
      status: "no-previous-preview",
      message: `no older preview blockmap on desktop-preview before ${currentVersion}`,
    };
  }
  const previousVersion = assetName
    .replace(/^Clash-Desktop-/, "")
    .replace(/-macOS-arm64\.zip\.blockmap$/, "");
  const cacheDir = join(input.releaseRoot, ".previous-preview-assets");
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, assetName);
  if (!existsSync(cached)) {
    const dl = spawnSync(
      "gh",
      [
        "release",
        "download",
        "desktop-preview",
        "-p",
        assetName,
        "-D",
        cacheDir,
      ],
      { encoding: "utf8", env: ghEnv(env) },
    );
    if (dl.status !== 0 || !existsSync(cached)) {
      return {
        status: "download-failed",
        assetName,
        message: `gh release download desktop-preview ${assetName} failed: ${dl.stderr || dl.stdout}`,
      };
    }
  }
  const dest = join(input.releaseRoot, assetName);
  copyFileSync(cached, dest);
  const expectedZip = clashMacArm64ZipName(previousVersion);
  if (assetName !== clashMacArm64ZipBlockmapName(previousVersion)) {
    return {
      status: "download-failed",
      message: `blockmap name mismatch for ${previousVersion}: ${assetName} vs ${expectedZip}`,
    };
  }
  return { status: "ok", assetName, path: dest, previousVersion };
}

function emitWarning(message: string): void {
  console.warn(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(
      `::warning title=preview blockmap helper::${message.replace(/\n/g, " ")}`,
    );
  }
}

async function main(): Promise<void> {
  const releaseRoot = resolve(process.argv[2] ?? "desktop-artifacts");
  const result = preparePreviousPreviewBlockmap({ releaseRoot });
  const manifestPath = join(releaseRoot, "previous-preview-blockmap.json");
  writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "ok") {
    console.log(`prepared ${result.path} from desktop-preview`);
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
