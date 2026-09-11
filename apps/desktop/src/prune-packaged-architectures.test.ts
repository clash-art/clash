import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  default as prunePackagedArchitectures,
  packageDirectoriesToPrune,
} from "../scripts/prune-packaged-architectures.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("desktop package architecture pruning", () => {
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
    const appOutDir = await mkdtemp(
      join(tmpdir(), "clash-package-pruning-"),
    );
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

    for (const packageName of [...x64Directories, "@anthropic-ai/claude-agent-sdk-darwin-arm64"]) {
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
      expect(
        existsSync(join(nodeModules, ...packageName.split("/"))),
      ).toBe(false);
    }
    expect(existsSync(preservedArm64)).toBe(true);
  });
});
