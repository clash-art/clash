#!/usr/bin/env node
/**
 * Prove a Developer ID build in /Applications replaces itself with the next
 * preview build served from a local HTTP feed.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  UPDATE_E2E_EVIDENCE_PATH,
  previewAppVersion,
} from "../src/app-update.ts";
import {
  clashMacArm64ZipBlockmapName,
  clashMacArm64ZipName,
} from "./desktop-release-assets.ts";
import { assertDifferentialUpdate } from "./update-differential-assert.ts";

export const OLD_PREVIEW_BUILD = 910001;
export const NEW_PREVIEW_BUILD = 910002;
const transcriptPath = resolve("test-results/macos-update-e2e.txt");
const installedAppPath = "/Applications/Clash.app";
const processName = "Clash";

export function zipNameFromFeedYaml(text: string): string {
  const pathLine = text.split("\n").find((line) => /^\s*path:\s*\S/.test(line));
  if (!pathLine) throw new Error("preview-mac.yml has no path");
  const raw = pathLine
    .replace(/^\s*path:\s*/, "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  const name = raw.split("/").pop() ?? "";
  if (!name.endsWith(".zip")) {
    throw new Error(`update feed path is not a zip: ${raw}`);
  }
  return name;
}

export function localizeFeedYaml(text: string, zipFileName: string): string {
  return text
    .split("\n")
    .map((line) => {
      const url = /^(\s*(?:-\s*)?url:\s*)(\S.*?)\s*$/.exec(line);
      if (url?.[1]) return `${url[1]}${zipFileName}`;
      const path = /^(\s*path:\s*)(\S.*?)\s*$/.exec(line);
      if (path?.[1]) return `${path[1]}${zipFileName}`;
      return line;
    })
    .join("\n");
}

export function assertInstalledUpdate(input: {
  oldVersion: string;
  newVersion: string;
  oldPid: number;
  evidence: Array<Record<string, unknown>>;
  samples: Array<{ version: string; oldPidAlive: boolean; newPid: number }>;
}): string[] {
  const errors: string[] = [];
  if (
    !input.evidence.some(
      (event) => event.event === "update-accepted" && event.pid === input.oldPid,
    )
  ) {
    errors.push("old process did not accept the update");
  }
  if (
    !input.evidence.some(
      (event) => event.event === "quit-and-install" && event.pid === input.oldPid,
    )
  ) {
    errors.push("old process did not call quitAndInstall");
  }
  if (
    !input.samples.some(
      (sample) => sample.oldPidAlive && sample.version === input.oldVersion,
    )
  ) {
    errors.push("never observed the old version while the old process was alive");
  }
  if (
    !input.samples.some(
      (sample) =>
        sample.oldPidAlive === false &&
        sample.version === input.newVersion &&
        sample.newPid > 0,
    )
  ) {
    errors.push("app did not relaunch as the new version after the old process exited");
  }
  return errors;
}

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  appendFileSync(transcriptPath, line);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function run(command: string, args: string[]): ReturnType<typeof spawnSync> {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
  log(`$ ${command} ${args.join(" ")}`);
  if (output) log(output);
  log(`exit:${String(result.status)}`);
  return result;
}

function bundleVersion(appPath: string): string {
  const plist = join(appPath, "Contents", "Info.plist");
  const result = spawnSync("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    plist,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `cannot read ${plist}`);
  }
  return result.stdout.trim();
}

function readEvidence(): Array<Record<string, unknown>> {
  try {
    return readFileSync(UPDATE_E2E_EVIDENCE_PATH, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function relaunchedPid(oldPid: number): number {
  const result = spawnSync("pgrep", ["-x", processName], { encoding: "utf8" });
  return (
    (result.stdout ?? "")
      .split("\n")
      .map((line) => Number(line.trim()))
      .find((pid) => pid > 0 && pid !== oldPid) ?? 0
  );
}

function findFiles(root: string, name: string): string[] {
  const result = spawnSync("find", [root, "-name", name, "-type", "f"], {
    encoding: "utf8",
  });
  return (result.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function previewBuildDir(releaseRoot: string, build: number): string {
  return join(releaseRoot, `preview-build-${build}`);
}

export function updaterCacheDirNameFromAppUpdateYaml(text: string): string {
  const match = /^\s*updaterCacheDirName:\s*(\S+)\s*$/m.exec(text);
  return match?.[1] ?? "clash-updater";
}

export function updaterCacheDirFromApp(appPath: string): string {
  const ymlPath = join(appPath, "Contents", "Resources", "app-update.yml");
  const text = readFileSync(ymlPath, "utf8");
  return join(
    homedir(),
    "Library",
    "Caches",
    updaterCacheDirNameFromAppUpdateYaml(text),
  );
}

function seedMacUpdaterCache(
  installedAppPath: string,
  oldZipPath: string,
  oldBlockmapPath: string,
): void {
  const cacheDir = updaterCacheDirFromApp(installedAppPath);
  mkdirSync(cacheDir, { recursive: true });
  run("/usr/bin/ditto", [oldZipPath, join(cacheDir, "update.zip")]);
  run("/usr/bin/ditto", [
    oldBlockmapPath,
    join(cacheDir, "current.blockmap"),
  ]);
  log(`seeded updater cache ${cacheDir}`);
}

function walkApps(root: string): string[] {
  return spawnSync("find", [root, "-type", "d", "-name", "Clash.app"], {
    encoding: "utf8",
  })
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function extractUpdaterLogText(appLogPath: string): string {
  try {
    return readFileSync(appLogPath, "utf8")
      .split("\n")
      .filter((line) => line.includes("[desktop:updater]"))
      .map((line) => line.replace(/^.*\[desktop:updater\]\s*/, "[desktop:updater] "))
      .join("\n");
  } catch {
    return "";
  }
}

async function serveFeed(directory: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const base = name.replace(/^\/+/, "");
    if (!base || base.includes("/") || base.includes("..")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = join(directory, base);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    const range = request.headers.range;
    if (range) {
      if (range.includes(",")) {
        response.writeHead(501);
        response.end();
        return;
      }
      const match = /^bytes=(\d+)-(\d+)?$/i.exec(range.trim());
      if (!match?.[1]) {
        response.writeHead(416);
        response.end();
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= size) {
        response.writeHead(416);
        response.end();
        return;
      }
      const chunk = end - start + 1;
      response.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunk,
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, {
      "Content-Length": size,
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("feed server has no port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  };
}

function launch(appPath: string, feedUrl: string, logPath: string): number {
  const binary = join(appPath, "Contents", "MacOS", processName);
  mkdirSync(resolve(logPath, ".."), { recursive: true });
  const handle = openSync(logPath, "a");
  const env = { ...process.env };
  env.CLASH_UPDATE_E2E = "1";
  env.CLASH_UPDATE_ACCEPT = "1";
  env.CLASH_UPDATE_FEED_URL = feedUrl;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [], {
    env,
    detached: true,
    stdio: ["ignore", handle, handle],
  });
  closeSync(handle);
  child.unref();
  if (!child.pid) throw new Error(`failed to launch ${binary}`);
  log(`launched pid=${child.pid} ${binary}`);
  return child.pid;
}

function removeApp(dest: string): void {
  try {
    rmSync(dest, { recursive: true, force: true });
  } catch {
    const result = run("sudo", ["rm", "-rf", dest]);
    if (result.status !== 0) throw new Error(`cannot remove ${dest}`);
  }
}

function placeApp(source: string, dest: string): void {
  removeApp(dest);
  mkdirSync(resolve(dest, ".."), { recursive: true });
  let result = run("/usr/bin/ditto", [source, dest]);
  if (result.status !== 0) {
    result = run("sudo", ["/usr/bin/ditto", source, dest]);
    const user = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
    run("sudo", ["chown", "-R", `${user}:staff`, dest]);
  }
  if (result.status !== 0) throw new Error(`cannot install ${dest}`);
  run("xattr", ["-dr", "com.apple.quarantine", dest]);
}

function requireDeveloperId(appPath: string): void {
  const verify = run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    appPath,
  ]);
  const details = run("/usr/bin/codesign", ["-dvvv", appPath]);
  const gatekeeper = run("/usr/sbin/spctl", ["-a", "-vv", appPath]);
  const staple = run("xcrun", ["stapler", "validate", appPath]);
  const described = `${details.stderr ?? ""}\n${details.stdout ?? ""}`;
  if (verify.status !== 0 || gatekeeper.status !== 0 || staple.status !== 0) {
    throw new Error(`${appPath} is not a stapled Developer ID app`);
  }
  if (!described.includes("Developer ID Application")) {
    throw new Error(`${appPath} is not signed with Developer ID Application`);
  }
}

async function sampleApp(
  appPath: string,
  pid: number,
): Promise<{ version: string; oldPidAlive: boolean; newPid: number }> {
  return {
    version: bundleVersion(appPath),
    oldPidAlive: pidAlive(pid),
    newPid: relaunchedPid(pid),
  };
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("macos-update-e2e runs on macOS");
  }
  mkdirSync(resolve("test-results"), { recursive: true });
  writeFileSync(transcriptPath, "");
  const releaseRoot = resolve(process.argv[2] ?? "release");
  const baseVersion = JSON.parse(
    readFileSync(resolve(desktopRoot(), "package.json"), "utf8"),
  ).version.replace(/-preview\.\d+$/, "");
  const oldVersion = previewAppVersion(baseVersion, OLD_PREVIEW_BUILD);
  const newVersion = previewAppVersion(baseVersion, NEW_PREVIEW_BUILD);
  const apps = walkApps(releaseRoot);
  const stagedOld = join(
    previewBuildDir(releaseRoot, OLD_PREVIEW_BUILD),
    "mac-arm64",
    "Clash.app",
  );
  const stagedNew = join(
    previewBuildDir(releaseRoot, NEW_PREVIEW_BUILD),
    "mac-arm64",
    "Clash.app",
  );
  const oldApp =
    existsSync(stagedOld) && bundleVersion(stagedOld) === oldVersion
      ? stagedOld
      : apps.find((app) => bundleVersion(app) === oldVersion);
  const newApp =
    existsSync(stagedNew) && bundleVersion(stagedNew) === newVersion
      ? stagedNew
      : apps.find((app) => bundleVersion(app) === newVersion);
  if (!oldApp || !newApp) {
    const described = apps
      .map((app) => {
        try {
          return `${app}=${bundleVersion(app)}`;
        } catch {
          return `${app}=?`;
        }
      })
      .join(", ");
    throw new Error(
      `missing signed apps for ${oldVersion} and ${newVersion}: ${described}`,
    );
  }
  log(`old=${oldApp}`);
  log(`new=${newApp}`);
  requireDeveloperId(oldApp);
  requireDeveloperId(newApp);

  const stagedYml = join(
    previewBuildDir(releaseRoot, NEW_PREVIEW_BUILD),
    "preview-mac.yml",
  );
  const ymlPath = existsSync(stagedYml)
    ? stagedYml
    : findFiles(releaseRoot, "preview-mac.yml")
        .filter((file) => readFileSync(file, "utf8").includes(newVersion))
        .find((file) => file.includes(`/preview-build-${NEW_PREVIEW_BUILD}/`)) ??
      findFiles(releaseRoot, "preview-mac.yml").find((file) =>
        readFileSync(file, "utf8").includes(newVersion),
      );
  if (!ymlPath) {
    throw new Error(`expected preview-mac.yml for ${newVersion}`);
  }
  const ymlText = readFileSync(ymlPath, "utf8");
  const zipName = zipNameFromFeedYaml(ymlText);
  const stagedZip = join(
    previewBuildDir(releaseRoot, NEW_PREVIEW_BUILD),
    zipName,
  );
  const zipPath = existsSync(stagedZip)
    ? stagedZip
    : findFiles(releaseRoot, zipName).find((file) =>
        file.includes(`/preview-build-${NEW_PREVIEW_BUILD}/`),
      ) ?? findFiles(releaseRoot, zipName)[0];
  if (!zipPath) {
    throw new Error(`expected ${zipName} for ${newVersion}`);
  }
  const feedDir = join(tmpdir(), "clash-update-feed");
  rmSync(feedDir, { recursive: true, force: true });
  mkdirSync(feedDir, { recursive: true });
  writeFileSync(
    join(feedDir, "preview-mac.yml"),
    `${localizeFeedYaml(ymlText, zipName)}\n`,
  );
  run("/usr/bin/ditto", [zipPath, join(feedDir, zipName)]);
  const newBlockmap = `${zipPath}.blockmap`;
  const oldBlockmapName = clashMacArm64ZipBlockmapName(oldVersion);
  const oldBlockmapCandidates = [
    join(previewBuildDir(releaseRoot, OLD_PREVIEW_BUILD), oldBlockmapName),
    join(dirname(zipPath), oldBlockmapName),
    ...findFiles(releaseRoot, oldBlockmapName),
  ];
  const oldBlockmapPath = oldBlockmapCandidates.find((candidate) =>
    existsSync(candidate),
  );
  if (!oldBlockmapPath) {
    throw new Error(`missing old preview blockmap ${oldBlockmapName}`);
  }
  if (!existsSync(newBlockmap)) {
    throw new Error(`missing new preview blockmap ${newBlockmap}`);
  }
  run("/usr/bin/ditto", [
    newBlockmap,
    join(feedDir, clashMacArm64ZipBlockmapName(newVersion)),
  ]);
  run("/usr/bin/ditto", [oldBlockmapPath, join(feedDir, oldBlockmapName)]);
  const fullZipBytes = statSync(zipPath).size;
  log(
    `feed assets zip=${zipName} fullZipBytes=${fullZipBytes} oldBlockmap=${oldBlockmapName}`,
  );
  const feed = await serveFeed(feedDir);
  log(`feed ${feed.url}`);

  try {
    placeApp(oldApp, installedAppPath);
    if (bundleVersion(installedAppPath) !== oldVersion) {
      throw new Error("/Applications version is not the old preview");
    }
    const oldZipPath = join(
      previewBuildDir(releaseRoot, OLD_PREVIEW_BUILD),
      clashMacArm64ZipName(oldVersion),
    );
    if (!existsSync(oldZipPath)) {
      throw new Error(`missing old preview zip for cache seed: ${oldZipPath}`);
    }
    seedMacUpdaterCache(installedAppPath, oldZipPath, oldBlockmapPath);
    rmSync(UPDATE_E2E_EVIDENCE_PATH, { force: true });
    const installedLog = resolve("test-results/installed-app.log");
    const installedPid = launch(installedAppPath, feed.url, installedLog);
    const samples: Array<{
      version: string;
      oldPidAlive: boolean;
      newPid: number;
    }> = [];
    const deadline = Date.now() + 8 * 60_000;
    let evidence: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      samples.push(await sampleApp(installedAppPath, installedPid));
      evidence = readEvidence();
      if (
        assertInstalledUpdate({
          oldVersion,
          newVersion,
          oldPid: installedPid,
          evidence,
          samples,
        }).length === 0
      ) {
        break;
      }
      await delay(500);
    }
    const installErrors = assertInstalledUpdate({
      oldVersion,
      newVersion,
      oldPid: installedPid,
      evidence,
      samples,
    });
    if (installErrors.length) throw new Error(installErrors.join("\n"));
    requireDeveloperId(installedAppPath);
    log(`installed app is ${bundleVersion(installedAppPath)}`);
    const updaterLog = extractUpdaterLogText(installedLog);
    writeFileSync(resolve("test-results/preview-updater.log"), updaterLog);
    const diff = assertDifferentialUpdate(updaterLog, fullZipBytes);
    const ratio =
      diff.analysis.downloadedBytes == null
        ? null
        : diff.analysis.downloadedBytes / fullZipBytes;
    log(
      `preview differential analysis: ${JSON.stringify({
        ...diff.analysis,
        fullPackageBytes: fullZipBytes,
        ratio,
        percent: ratio == null ? null : Math.round(ratio * 1000) / 10,
      })}`,
    );
    writeFileSync(
      resolve("test-results/preview-download.json"),
      `${JSON.stringify(
        {
          ...diff.analysis,
          fullPackageBytes: fullZipBytes,
          ratio,
        },
        null,
        2,
      )}\n`,
    );
    if (diff.errors.length) {
      throw new Error(diff.errors.join("\n"));
    }
    writeFileSync(
      resolve("test-results/clash-update-evidence.log"),
      readFileSync(UPDATE_E2E_EVIDENCE_PATH, "utf8"),
    );
  } finally {
    await feed.close();
    const quitting = spawnSync("pgrep", ["-x", processName], { encoding: "utf8" });
    for (const pid of (quitting.stdout ?? "")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((value) => value > 0)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

function desktopRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);
    try {
      log(message);
    } catch {
      console.error(message);
    }
    process.exitCode = 1;
  });
}
