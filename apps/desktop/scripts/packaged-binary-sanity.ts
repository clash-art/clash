import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

interface PlatformLayout {
  installer: string;
  executables: string[];
  appBundles: string[];
}

const layouts: Record<string, PlatformLayout> = {
  "macOS-arm64": {
    installer: "Clash-Desktop-macOS-arm64.dmg",
    executables: ["mac-arm64/Clash.app/Contents/MacOS/Clash"],
    appBundles: ["mac-arm64/Clash.app"],
  },
  "macOS-x64": {
    installer: "Clash-Desktop-macOS-x64.dmg",
    executables: [
      "mac-x64/Clash.app/Contents/MacOS/Clash",
      "mac/Clash.app/Contents/MacOS/Clash",
    ],
    appBundles: ["mac-x64/Clash.app", "mac/Clash.app"],
  },
  Windows: {
    installer: "Clash-Desktop-Windows-x64.exe",
    executables: ["win-unpacked/clash.exe"],
    appBundles: [],
  },
  Linux: {
    installer: "Clash-Desktop-Linux-x64.AppImage",
    executables: ["linux-unpacked/clash"],
    appBundles: [],
  },
};

export interface ResolvedPackage {
  installer: string;
  executable: string;
  appBundle?: string;
}

function existingFile(
  releaseDir: string,
  relatives: string[],
): string | undefined {
  for (const relative of relatives) {
    const candidate = path.join(releaseDir, relative);
    try {
      const info = statSync(candidate);
      if (info.isFile() && info.size > 0) return candidate;
    } catch {
      // try the next published layout
    }
  }
  return undefined;
}

function existingDirectory(
  releaseDir: string,
  relatives: string[],
): string | undefined {
  for (const relative of relatives) {
    const candidate = path.join(releaseDir, relative);
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // try the next published layout
    }
  }
  return undefined;
}

export function resolvePackagedRelease(
  releaseDir: string,
  platform: string,
): ResolvedPackage {
  const layout = layouts[platform];
  if (!layout) {
    throw new Error(`Unknown desktop package platform: ${platform}`);
  }
  const installer = existingFile(releaseDir, [layout.installer]);
  if (!installer) {
    throw new Error(
      `Missing packaged installer ${path.join(releaseDir, layout.installer)}`,
    );
  }
  const executable = existingFile(releaseDir, layout.executables);
  if (!executable) {
    throw new Error(
      `Missing unpacked executable for ${platform}: ${layout.executables.join(", ")}`,
    );
  }
  const appBundle =
    layout.appBundles.length > 0
      ? existingDirectory(releaseDir, layout.appBundles)
      : undefined;
  if (layout.appBundles.length > 0 && !appBundle) {
    throw new Error(
      `Missing macOS app bundle for ${platform}: ${layout.appBundles.join(", ")}`,
    );
  }
  return appBundle
    ? { installer, executable, appBundle }
    : { installer, executable };
}

export function launchPackagedBinary(executable: string): string {
  const result = spawnSync(executable, ["-p", "process.version"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `Packaged binary failed to launch: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Packaged binary exited ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }
  const version = result.stdout.trim();
  if (!/^v\d+\.\d+\.\d+/.test(version)) {
    throw new Error(
      `Packaged binary did not report a Node version: ${version}`,
    );
  }
  return version;
}

export function verifyMacSeal(appBundle: string): void {
  const result = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appBundle],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `codesign verify failed for ${appBundle}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

export function runPackagedBinarySanity(options: {
  platform: string;
  releaseDir: string;
  verifyMacSeal: boolean;
}): {
  platform: string;
  installer: string;
  executable: string;
  version: string;
} {
  const resolved = resolvePackagedRelease(options.releaseDir, options.platform);
  if (options.verifyMacSeal) {
    if (!resolved.appBundle) {
      throw new Error(
        `macOS seal check has no app bundle for ${options.platform}`,
      );
    }
    verifyMacSeal(resolved.appBundle);
  }
  const version = launchPackagedBinary(resolved.executable);
  return {
    platform: options.platform,
    installer: resolved.installer,
    executable: resolved.executable,
    version,
  };
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
    const platform = process.env.CLASH_DESKTOP_PACK_PLATFORM ?? "";
    const releaseDir =
      process.env.CLASH_DESKTOP_RELEASE_DIR ??
      path.join(desktopRoot, "release");
    const report = runPackagedBinarySanity({
      platform,
      releaseDir,
      verifyMacSeal: process.env.CLASH_DESKTOP_VERIFY_MAC_SEAL === "1",
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
