import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const outputDir = path.join(desktopRoot, "build", "clash-runtime");
const dependencyDir = path.join(
  desktopRoot,
  "build",
  ".clash-runtime-dependencies",
);
const runtimeRoot = path.join(repoRoot, "plugins", "clash");
const runtimePackagePath = path.join(runtimeRoot, "package.json");

export function packagedRuntimeArtifacts(packageJson: { clashRuntime?: unknown }) {
  const declaration = packageJson.clashRuntime;
  if (!declaration || typeof declaration !== "object") {
    throw new Error("clash package is missing package.json#clashRuntime");
  }
  return Object.fromEntries(
    Object.entries(declaration).map(([name, value]) => {
      if (typeof value !== "string" || !value.startsWith("./runtime/")) {
        throw new Error(`invalid clashRuntime.${name}: ${String(value)}`);
      }
      const relative = value.slice("./runtime/".length);
      if (!relative || relative.split(/[\\/]/).includes("..")) {
        throw new Error(`unsafe clashRuntime.${name}: ${value}`);
      }
      return [name, `./${relative}`];
    }),
  );
}

export function resolveNpmInvocation({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (platform === "win32") {
    return {
      command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      argsPrefix: ["/d", "/s", "/c", "npm"],
    };
  }
  return { command: "npm", argsPrefix: [] };
}

export async function ensurePackagedMediaBinariesExecutable(
  runtimeDir: string,
  { platform = process.platform, arch = process.arch }: { platform?: NodeJS.Platform; arch?: string } = {},
) {
  const target = `${platform}-${arch}`;
  const suffix = platform === "win32" ? ".exe" : "";
  const binaries = {
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

function runNpm(args: string[], { cwd, ...options }: { cwd: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }) {
  const invocation = resolveNpmInvocation(options);
  const result = spawnSync(
    invocation.command,
    [...invocation.argsPrefix, ...args],
    {
      cwd,
      stdio: "inherit",
      env: options.env,
    },
  );
  if (result.error) {
    throw new Error(`Unable to start npm: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} failed with exit code ${result.status ?? 1}`,
    );
  }
}

export async function prepareClashCli({
  env = process.env,
  platform = process.platform,
  logger = console.log,
} = {}) {
  const options = { env, platform };
  const runtimePackage = JSON.parse(await readFile(runtimePackagePath, "utf8"));
  const artifacts = packagedRuntimeArtifacts(runtimePackage);
  const runtimeDir = path.join(runtimeRoot, "runtime");
  for (const artifact of Object.values(artifacts)) {
    try {
      await access(path.join(runtimeDir, artifact));
    } catch (error) {
      throw new Error(
        `The unified Clash runtime is not built (${artifact}). ` +
          "Run `pnpm prepare:desktop-pack` from the repository root.",
        { cause: error },
      );
    }
  }

  logger("[prepare-clash-cli] resetting output directory");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(path.dirname(outputDir), { recursive: true });

  logger("[prepare-clash-cli] staging the prebuilt unified Clash runtime");
  await cp(runtimeDir, outputDir, {
    recursive: true,
    dereference: true,
    force: true,
  });
  await writeFile(
    path.join(outputDir, "runtime-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        package: { name: runtimePackage.name, version: runtimePackage.version },
        artifacts,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  logger("[prepare-clash-cli] installing runtime dependencies");
  await rm(dependencyDir, { recursive: true, force: true });
  await mkdir(dependencyDir, { recursive: true });
  await writeFile(
    path.join(dependencyDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@clash/desktop-runtime-dependencies",
        private: true,
        dependencies: runtimePackage.dependencies ?? {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  try {
    runNpm(
      [
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
      ],
      { ...options, cwd: dependencyDir },
    );
    await cp(
      path.join(dependencyDir, "node_modules"),
      path.join(outputDir, "node_modules"),
      {
        recursive: true,
        dereference: true,
        force: true,
      },
    );
    await ensurePackagedMediaBinariesExecutable(outputDir, {
      platform,
      arch: env.npm_config_arch ?? process.arch,
    });
  } finally {
    await rm(dependencyDir, { recursive: true, force: true });
  }
  for (const artifact of Object.values(artifacts)) {
    await access(path.join(outputDir, artifact));
  }

  logger(`[prepare-clash-cli] wrote ${outputDir}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await prepareClashCli();
  } catch (error) {
    console.error(
      "[prepare-clash-cli] failed",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  }
}
