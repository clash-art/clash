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

export interface MacCommandResult {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runMacVerificationCommand(
  command: string,
  args: string[],
): MacCommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const report: MacCommandResult = {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  console.log(
    `$ ${report.command}\n${report.stdout}${report.stderr ? `${report.stderr}` : ""}`,
  );
  return report;
}

export function verifyMacSeal(appBundle: string): void {
  const result = runMacVerificationCommand("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appBundle,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `codesign verify failed for ${appBundle}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

export function verifyMacSignatureDetails(appBundle: string): void {
  const result = runMacVerificationCommand("codesign", ["-dv", appBundle]);
  if (result.status !== 0) {
    throw new Error(
      `codesign -dv failed for ${appBundle}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

export function verifyMacGatekeeper(appBundle: string): void {
  const result = runMacVerificationCommand("spctl", ["-a", "-vv", appBundle]);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) {
    throw new Error(
      `spctl assess failed for ${appBundle}\n${result.stdout}\n${result.stderr}`,
    );
  }
  if (
    macDistributionSignMode() === "developer-id" &&
    (!combined.includes("accepted") ||
      !combined.includes("Notarized Developer ID"))
  ) {
    throw new Error(
      `spctl did not report a notarized Developer ID assessment for ${appBundle}\n${combined}`,
    );
  }
}

export function verifyMacStapler(appBundle: string): void {
  const result = runMacVerificationCommand("xcrun", [
    "stapler",
    "validate",
    appBundle,
  ]);
  if (result.status !== 0) {
    throw new Error(
      `xcrun stapler validate failed for ${appBundle}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

export function macDistributionSignMode(): "developer-id" | "ad-hoc" {
  const mode = process.env.CLASH_DESKTOP_MAC_SIGN_MODE ?? "ad-hoc";
  return mode === "developer-id" ? "developer-id" : "ad-hoc";
}

/** An arm64 GitHub macOS runner cannot execute the x64 Electron binary under a short timeout. */
export function shouldLaunchPackagedBinary(
  platform: string,
  hostArch: string,
): boolean {
  if (platform === "macOS-x64") return hostArch === "x64";
  if (platform === "macOS-arm64") return hostArch === "arm64";
  return true;
}

export function runPackagedBinarySanity(options: {
  platform: string;
  releaseDir: string;
  verifyMacSeal: boolean;
  hostArch?: string;
}): {
  platform: string;
  installer: string;
  executable: string;
  launched: boolean;
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
    verifyMacSignatureDetails(resolved.appBundle);
    if (macDistributionSignMode() === "developer-id") {
      verifyMacGatekeeper(resolved.appBundle);
      verifyMacStapler(resolved.appBundle);
    } else {
      runMacVerificationCommand("spctl", ["-a", "-vv", resolved.appBundle]);
      runMacVerificationCommand("xcrun", [
        "stapler",
        "validate",
        resolved.appBundle,
      ]);
    }
  }
  const hostArch = options.hostArch ?? process.arch;
  if (!shouldLaunchPackagedBinary(options.platform, hostArch)) {
    return {
      platform: options.platform,
      installer: resolved.installer,
      executable: resolved.executable,
      launched: false,
      version: "",
    };
  }
  return {
    platform: options.platform,
    installer: resolved.installer,
    executable: resolved.executable,
    launched: true,
    version: launchPackagedBinary(resolved.executable),
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
