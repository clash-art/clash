import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { writeRuntimeDependencyIdentity } from "../../../scripts/runtime-dependency-identity.ts";

const execute = promisify(execFile);

/** npm needs a materialized dependency tree; pnpm workspace links omit transitive payloads. */
export async function packDistribution(source: string, destination: string) {
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
    // This is npm's own installation, even when the outer command is pnpm.
    delete npmEnv.npm_execpath;
    delete npmEnv.npm_node_execpath;
    await execute("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: stage, env: npmEnv, maxBuffer: 4 * 1024 * 1024,
    });
    await writeRuntimeDependencyIdentity(join(stage, "node_modules"), join(stage, "runtime"));
    const packed = await execute("npm", ["pack", "--json", "--pack-destination", output], {
      cwd: stage, env: npmEnv, maxBuffer: 8 * 1024 * 1024,
    });
    const result = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    if (!result[0]?.filename) throw new Error("npm pack returned no artifact");
    await cp(join(stage, "package-lock.json"), join(output, "runtime-dependencies.lock.json"));
    return { artifact: join(output, result[0].filename), dependencyLock: join(output, "runtime-dependencies.lock.json") };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass the output directory: pnpm pack:distribution /absolute/artifact-directory");
  console.log(JSON.stringify(await packDistribution(source, destination), null, 2));
}
