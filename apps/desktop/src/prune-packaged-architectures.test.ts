import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  default as prunePackagedArchitectures,
  packageDirectoriesToPrune,
} from "../scripts/prune-packaged-architectures.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("desktop package architecture pruning", () => {
  it.skipIf(process.platform !== "darwin")(
    "keeps the shipped Remotion tools runnable after hardened signing, without DYLD search paths",
    async () => {
      const appOutDir = await mkdtemp(join(tmpdir(), "clash-signed-remotion-"));
      temporaryDirectories.push(appOutDir);
      const packageName = `@remotion/compositor-darwin-${process.arch}`;
      const source = dirname(
        createRequire(import.meta.url).resolve(`${packageName}/package.json`),
      );
      const entitlements = createRequire(import.meta.url).resolve(
        "app-builder-lib/templates/entitlements.mac.plist",
      );
      const target = join(
        appOutDir,
        "Clash.app/Contents/Resources/clash-runtime/node_modules",
        packageName,
      );
      await cp(source, target, { recursive: true, dereference: true });
      await prunePackagedArchitectures({
        appOutDir,
        arch: process.arch === "arm64" ? 3 : 1,
        electronPlatformName: "darwin",
        packager: { appInfo: { productFilename: "Clash" } },
      });
      for (const file of await readdir(target)) {
        if (
          !file.endsWith(".dylib") &&
          !["ffmpeg", "ffprobe", "remotion"].includes(file)
        )
          continue;
        execFileSync("codesign", [
          "--force",
          "--sign",
          "-",
          "--options",
          "runtime",
          "--entitlements",
          entitlements,
          join(target, file),
        ]);
      }
      const env = { ...process.env };
      delete env.DYLD_LIBRARY_PATH;
      delete env.DYLD_FALLBACK_LIBRARY_PATH;
      for (const command of ["ffmpeg", "ffprobe"]) {
        const output = execFileSync(join(target, command), ["-version"], {
          cwd: tmpdir(),
          env,
          encoding: "utf8",
        });
        expect(output).toContain(`${command} version`);
      }
    },
    30_000,
  );
  it("maps each single-architecture macOS build to the opposite native packages", () => {
    expect(packageDirectoriesToPrune(3)).toEqual([
      "@anthropic-ai/claude-agent-sdk-darwin-x64",
      "@esbuild/darwin-x64",
      "@remotion/compositor-darwin-x64",
    ]);
    expect(packageDirectoriesToPrune(1)).toEqual([
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "@esbuild/darwin-arm64",
      "@remotion/compositor-darwin-arm64",
    ]);
    expect(packageDirectoriesToPrune(4)).toEqual([]);
  });

  it("removes only the opposite-architecture packages from the staged macOS app", async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), "clash-package-pruning-"));
    temporaryDirectories.push(appOutDir);
    const nodeModules = join(
      appOutDir,
      "Clash.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
    );
    const x64Directories = packageDirectoriesToPrune(3);
    const preservedArm64 = join(
      nodeModules,
      "@anthropic-ai",
      "claude-agent-sdk-darwin-arm64",
    );

    for (const packageName of [
      ...x64Directories,
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    ]) {
      const packageDirectory = join(nodeModules, ...packageName.split("/"));
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(join(packageDirectory, "native-binary"), packageName);
    }

    await prunePackagedArchitectures({
      appOutDir,
      arch: 3,
      electronPlatformName: "darwin",
      packager: { appInfo: { productFilename: "Clash" } },
    });

    for (const packageName of x64Directories) {
      expect(existsSync(join(nodeModules, ...packageName.split("/")))).toBe(
        false,
      );
    }
    expect(existsSync(preservedArm64)).toBe(true);
  });
});
