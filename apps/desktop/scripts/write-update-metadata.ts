import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");

export function channelFromEnv(env: NodeJS.ProcessEnv): "preview" | "stable" | "dev" {
  const explicit = env.CLASH_UPDATE_CHANNEL?.trim();
  if (explicit) {
    if (explicit !== "preview" && explicit !== "stable" && explicit !== "dev") {
      throw new Error(
        `CLASH_UPDATE_CHANNEL must be preview, stable, or dev, got ${explicit}`,
      );
    }
    return explicit;
  }
  const ref = env.GITHUB_REF ?? "";
  if (ref.startsWith("refs/tags/v")) return "stable";
  if (ref === "refs/heads/master") return "preview";
  return "dev";
}

export function buildNumberFromEnv(env: NodeJS.ProcessEnv): number {
  const explicit = env.CLASH_UPDATE_BUILD?.trim();
  if (explicit) {
    if (!/^\d+$/.test(explicit)) {
      throw new Error("CLASH_UPDATE_BUILD must be an integer");
    }
    return Number(explicit);
  }
  const run = env.GITHUB_RUN_NUMBER?.trim() ?? "";
  if (!run) return 0;
  if (!/^\d+$/.test(run)) {
    throw new Error("GITHUB_RUN_NUMBER must be an integer");
  }
  const attemptRaw = env.GITHUB_RUN_ATTEMPT?.trim() || "1";
  if (!/^\d+$/.test(attemptRaw)) {
    throw new Error("GITHUB_RUN_ATTEMPT must be an integer");
  }
  const attempt = Number(attemptRaw);
  if (attempt < 1 || attempt >= 1000) {
    throw new Error("GITHUB_RUN_ATTEMPT must be from 1 to 999");
  }
  return Number(run) * 1000 + attempt;
}

export function commitFromEnv(env: NodeJS.ProcessEnv, cwd: string): string {
  const sha = env.GITHUB_SHA?.trim() ?? "";
  if (/^[a-f0-9]{40}$/.test(sha) || /^[a-f0-9]{64}$/.test(sha)) return sha;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  const parsed = result.stdout?.trim() ?? "";
  if (result.status === 0 && /^[a-f0-9]{40}$/.test(parsed)) return parsed;
  return "";
}

export function packagedAppVersion(
  baseVersion: string,
  channel: "preview" | "stable" | "dev",
  build: number,
): string {
  if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) {
    throw new Error(`base version must be x.y.z, got ${baseVersion}`);
  }
  if (channel === "preview" && build > 0) {
    return `${baseVersion}-preview.${build}`;
  }
  return baseVersion;
}

export async function writeUpdateMetadata(options: {
  packageJsonPath: string;
  outputPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<Record<string, unknown>> {
  const pkg = JSON.parse(await readFile(options.packageJsonPath, "utf8")) as {
    version?: string;
  };
  if (
    typeof pkg.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(pkg.version)
  ) {
    throw new Error(
      `package.json version must be x.y.z or x.y.z-preview.N, got ${String(pkg.version)}`,
    );
  }
  const channel = channelFromEnv(options.env);
  const metadata = {
    schema: 1,
    channel,
    version: pkg.version,
    build: buildNumberFromEnv(options.env),
    commit: commitFromEnv(options.env, options.cwd),
    signed:
      options.env.CLASH_DESKTOP_MAC_SIGN_MODE === "developer-id" ||
      options.env.CLASH_MAC_SIGNING === "developer-id",
  };
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

async function main(): Promise<void> {
  const outputPath = resolve(
    desktopRoot,
    process.argv[2] ?? "build/update-metadata.json",
  );
  const metadata = await writeUpdateMetadata({
    packageJsonPath: resolve(desktopRoot, "package.json"),
    outputPath,
    env: process.env,
    cwd: desktopRoot,
  });
  console.log(
    `wrote ${outputPath} channel=${String(metadata.channel)} build=${String(metadata.build)}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
