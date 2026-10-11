import { access, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** npm is a `.cmd` shim on Windows and cannot be spawned without a shell there. */
export function resolveNpmInvocation({
  env = process.env,
  platform = process.platform,
}: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) {
  if (platform === "win32") {
    return {
      command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      argsPrefix: ["/d", "/s", "/c", "npm"],
    };
  }
  return { command: "npm", argsPrefix: [] };
}

/** Where the installer packages place the platform media binaries of a runtime tree. */
export function packagedMediaBinaryPaths(
  runtimeDir: string,
  { platform = process.platform, arch = process.arch }: { platform?: NodeJS.Platform; arch?: string } = {},
) {
  const target = `${platform}-${arch}`;
  const suffix = platform === "win32" ? ".exe" : "";
  return {
    ffmpeg: path.join(
      runtimeDir,
      "node_modules",
      "@ffmpeg-installer",
      target,
      `ffmpeg${suffix}`,
    ),
    ffprobe: path.join(
      runtimeDir,
      "node_modules",
      "@ffprobe-installer",
      target,
      `ffprobe${suffix}`,
    ),
  };
}

/**
 * Shared by the Desktop runtime staging and the npm/self-contained distribution:
 * upstream ships ffprobe without the executable bit, and a read-only install
 * cannot repair that at first use.
 */
export async function ensurePackagedMediaBinariesExecutable(
  runtimeDir: string,
  { platform = process.platform, arch = process.arch }: { platform?: NodeJS.Platform; arch?: string } = {},
) {
  const binaries = packagedMediaBinaryPaths(runtimeDir, { platform, arch });
  for (const binary of Object.values(binaries)) {
    await access(binary);
    if (platform !== "win32") await chmod(binary, 0o755);
    await access(
      binary,
      platform === "win32" ? constants.F_OK : constants.X_OK,
    );
  }
  return binaries;
}
