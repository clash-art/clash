import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  launchPackagedBinary,
  resolvePackagedRelease,
  shouldLaunchPackagedBinary,
} from "./packaged-binary-sanity.ts";

async function writeExecutable(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await chmod(file, 0o755);
}

describe("packaged binary sanity", () => {
  it("does not launch a macOS binary on a different CPU", () => {
    expect(shouldLaunchPackagedBinary("macOS-x64", "arm64")).toBe(false);
    expect(shouldLaunchPackagedBinary("macOS-arm64", "x64")).toBe(false);
    expect(shouldLaunchPackagedBinary("macOS-x64", "x64")).toBe(true);
    expect(shouldLaunchPackagedBinary("macOS-arm64", "arm64")).toBe(true);
    expect(shouldLaunchPackagedBinary("Linux", "x64")).toBe(true);
    expect(shouldLaunchPackagedBinary("Windows", "arm64")).toBe(true);
  });

  it("launches the unpacked Linux binary and accepts the x64 macOS layout", async () => {
    const releaseDir = await mkdtemp(path.join(tmpdir(), "clash-pack-sanity-"));
    try {
      const executable = path.join(releaseDir, "linux-unpacked", "clash");
      await writeExecutable(
        executable,
        "#!/bin/sh\nprintf '%s\\n' 'v20.18.0'\n",
      );
      await writeFile(
        path.join(releaseDir, "Clash-Desktop-Linux-x64.AppImage"),
        "installer",
      );

      const resolved = resolvePackagedRelease(releaseDir, "Linux");
      expect(resolved.executable).toBe(executable);
      expect(launchPackagedBinary(resolved.executable)).toBe("v20.18.0");

      await mkdir(path.join(releaseDir, "mac", "Clash.app"), {
        recursive: true,
      });
      const macExecutable = path.join(
        releaseDir,
        "mac",
        "Clash.app",
        "Contents",
        "MacOS",
        "Clash",
      );
      await writeExecutable(
        macExecutable,
        "#!/bin/sh\nprintf '%s\\n' 'v20.18.0'\n",
      );
      await writeFile(
        path.join(releaseDir, "Clash-Desktop-macOS-x64.dmg"),
        "installer",
      );
      expect(resolvePackagedRelease(releaseDir, "macOS-x64").executable).toBe(
        macExecutable,
      );
    } finally {
      await rm(releaseDir, { recursive: true, force: true });
    }
  });

  it("rejects a missing installer and a binary that does not start", async () => {
    const releaseDir = await mkdtemp(path.join(tmpdir(), "clash-pack-sanity-"));
    try {
      expect(() => resolvePackagedRelease(releaseDir, "Windows")).toThrow(
        /Missing packaged installer/,
      );
      await writeFile(
        path.join(releaseDir, "Clash-Desktop-Windows-x64.exe"),
        "installer",
      );
      const executable = path.join(releaseDir, "win-unpacked", "clash.exe");
      await writeExecutable(executable, "#!/bin/sh\nexit 1\n");
      expect(resolvePackagedRelease(releaseDir, "Windows").executable).toBe(
        executable,
      );
      expect(() => launchPackagedBinary(executable)).toThrow(/exited 1/);
    } finally {
      await rm(releaseDir, { recursive: true, force: true });
    }
  });
});
