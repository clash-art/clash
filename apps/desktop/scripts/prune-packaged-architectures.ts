import { readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function relocateCompositorLibraries(directory: string) {
  const files = await readdir(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const libraries = new Set(files.filter((file) => file.endsWith(".dylib")));
  for (const file of files) {
    if (
      !libraries.has(file) &&
      !["remotion", "ffmpeg", "ffprobe"].includes(file)
    )
      continue;
    const executable = join(directory, file);
    const { stdout } = await run("otool", ["-L", executable]);
    const args: string[] = [];
    if (libraries.has(file)) args.push("-id", `@loader_path/${file}`);
    for (const line of stdout.split("\n")) {
      const dependency = /^\s+(.+?) \(compatibility version/.exec(line)?.[1];
      if (dependency && dependency !== file && libraries.has(dependency)) {
        args.push("-change", dependency, `@loader_path/${dependency}`);
      }
    }
    // Upstream uses bare library names plus DYLD_LIBRARY_PATH. Hardened signing
    // disallows that fallback. Resolve only bundled peers, before the app seal.
    if (args.length) await run("install_name_tool", [...args, executable]);
  }
}

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

  const resources = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Resources",
  );
  for (const runtime of ["app.asar.unpacked", "clash-runtime"]) {
    const nodeModules = join(resources, runtime, "node_modules");
    await Promise.all(
      packageDirectories.map((packageName) =>
        rm(join(nodeModules, ...packageName.split("/")), {
          recursive: true,
          force: true,
        }),
      ),
    );
    await relocateCompositorLibraries(
      join(
        nodeModules,
        "@remotion",
        `compositor-darwin-${context.arch === ARM64 ? "arm64" : "x64"}`,
      ),
    );
  }
}
