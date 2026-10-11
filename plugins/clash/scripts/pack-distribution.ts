import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ensurePackagedMediaBinariesExecutable,
  resolveNpmInvocation,
} from "../../../scripts/packaged-runtime-binaries.ts";
import { writeRuntimeDependencyIdentity } from "../../../scripts/runtime-dependency-identity.ts";
import {
  SELF_CONTAINED_MANIFEST,
  acquirePinnedNodeArchive,
  archiveTool,
  selfContainedTargetId,
  sha256File,
  stageSelfContainedRuntime,
  type NodeRuntimeLock,
} from "./self-contained-runtime.ts";

const execute = promisify(execFile);

/** npm needs a materialized dependency tree; pnpm workspace links omit transitive payloads. */
export type PackDistributionOptions = {
  /**
   * Also bundle the pinned Node binary and a launcher, producing a
   * per-platform archive that needs no preinstalled Node.
   */
  selfContained?: boolean;
  /** Where verified official Node archives are kept between builds. */
  nodeCacheDir?: string;
};

export async function packDistribution(source: string, destination: string, options: PackDistributionOptions = {}) {
  const sourceRoot = resolve(source);
  const output = resolve(destination);
  const stage = await mkdtemp(join(tmpdir(), "clash-distribution-"));
  try {
    const original = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
    const { devDependencies: _devDependencies, scripts: _scripts, ...manifest } = original;
    // Install only the distribution's public production dependencies. The
    // resulting package is also a standalone Codex plugin cache payload.
    manifest.bundleDependencies = true;
    // Native optional dependencies were installed for this host. Do not let
    // this tarball silently claim portability to a different platform.
    manifest.os = [process.platform];
    manifest.cpu = [process.arch];
    for (const entry of original.files as string[]) {
      if (entry.includes("..") || entry.startsWith("/")) throw new Error(`Unsafe distribution entry: ${entry}`);
      await cp(join(sourceRoot, entry), join(stage, entry), { recursive: true, dereference: true });
    }
    await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    await mkdir(output, { recursive: true });
    const npmEnv = { ...process.env };
    const npm = resolveNpmInvocation();
    const target = { platform: process.platform, arch: process.arch };
    // This is npm's own installation, even when the outer command is pnpm.
    delete npmEnv.npm_execpath;
    delete npmEnv.npm_node_execpath;
    await execute(npm.command, [...npm.argsPrefix, "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: stage, env: npmEnv, maxBuffer: 4 * 1024 * 1024,
    });
    // Upstream ffprobe has no executable bit; a read-only install cannot fix it later.
    await ensurePackagedMediaBinariesExecutable(stage, target);
    const dependencies = await writeRuntimeDependencyIdentity(join(stage, "node_modules"), join(stage, "runtime"));
    if (!options.selfContained) {
      const packed = await execute(npm.command, [...npm.argsPrefix, "pack", "--json", "--pack-destination", output], {
        cwd: stage, env: npmEnv, maxBuffer: 8 * 1024 * 1024,
      });
      const result = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      if (!result[0]?.filename) throw new Error("npm pack returned no artifact");
      await cp(join(stage, "package-lock.json"), join(output, "runtime-dependencies.lock.json"));
      return { artifact: join(output, result[0].filename), dependencyLock: join(output, "runtime-dependencies.lock.json") };
    }

    const lock = JSON.parse(await readFile(join(sourceRoot, "node-runtime.lock.json"), "utf8")) as NodeRuntimeLock;
    const nodeArchivePath = await acquirePinnedNodeArchive(lock, target, {
      cacheDir: options.nodeCacheDir ?? process.env.CLASH_NODE_ARCHIVE_CACHE ?? join(tmpdir(), "clash-node-archives"),
    });
    const selfContained = await stageSelfContainedRuntime(stage, {
      lock, target, nodeArchivePath, runtimeDependenciesSha256: dependencies,
      package: { name: manifest.name, version: manifest.version },
    });
    manifest.files = [...manifest.files, "bin", "node", SELF_CONTAINED_MANIFEST];
    await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    const name = `${manifest.name}-${manifest.version}-${selfContainedTargetId(target)}`;
    const dependencyLock = join(output, `${name}.runtime-dependencies.lock.json`);
    await cp(join(stage, "package-lock.json"), dependencyLock);
    let artifact: string;
    if (process.platform === "win32") {
      // Windows convention is a zip; the archive root stays `package/` like the npm tarball.
      artifact = join(output, `${name}.zip`);
      const root = join(stage, "..", `${basename(stage)}-zip`);
      try {
        await mkdir(root);
        await rm(join(stage, "package-lock.json"));
        await rename(stage, join(root, "package"));
        await rm(artifact, { force: true });
        await execute(archiveTool("win32"), ["-a", "-c", "-f", artifact, "-C", root, "package"], { maxBuffer: 8 * 1024 * 1024 });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    } else {
      // npm pack keeps file modes and writes a fixed mtime, so equal inputs give equal bytes.
      const packed = await execute(npm.command, [...npm.argsPrefix, "pack", "--json", "--pack-destination", stage], {
        cwd: stage, env: npmEnv, maxBuffer: 8 * 1024 * 1024,
      });
      const result = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      if (!result[0]?.filename) throw new Error("npm pack returned no artifact");
      artifact = join(output, `${name}.tgz`);
      await cp(join(stage, result[0].filename), artifact);
    }
    const sums = [artifact, dependencyLock];
    const checksums = join(output, `${name}.SHA256SUMS`);
    await writeFile(checksums, (await Promise.all(sums.map(async (path) => `${await sha256File(path)}  ${basename(path)}\n`))).join(""));
    return { artifact, dependencyLock, checksums, sha256: await sha256File(artifact), selfContained };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const selfContained = args.includes("--self-contained");
  const destination = args.find((argument) => !argument.startsWith("--"));
  if (!destination) throw new Error("Pass the output directory: pnpm pack:distribution [--self-contained] /absolute/artifact-directory");
  console.log(JSON.stringify(await packDistribution(source, destination, { selfContained }), null, 2));
}
