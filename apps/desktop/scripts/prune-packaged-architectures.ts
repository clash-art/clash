import { rm } from "node:fs/promises";
import { join } from "node:path";

const X64 = 1;
const ARM64 = 3;

export function packageDirectoriesToPrune(arch: number) {
  if (arch === ARM64) {
    return [
      "@anthropic-ai/claude-agent-sdk-darwin-x64",
      "@esbuild/darwin-x64",
      "@remotion/compositor-darwin-x64",
    ];
  }
  if (arch === X64) {
    return [
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "@esbuild/darwin-arm64",
      "@remotion/compositor-darwin-arm64",
    ];
  }
  return [];
}

export default async function prunePackagedArchitectures(context: {
  electronPlatformName: string;
  arch: number;
  appOutDir: string;
  packager: { appInfo: { productFilename: string } };
}) {
  if (context.electronPlatformName !== "darwin") return;

  const packageDirectories = packageDirectoriesToPrune(context.arch);
  if (packageDirectories.length === 0) return;

  const nodeModules = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
  );

  await Promise.all(
    packageDirectories.map((packageName) =>
      rm(join(nodeModules, ...packageName.split("/")), {
        recursive: true,
        force: true,
      }),
    ),
  );
}
