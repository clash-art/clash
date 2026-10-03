import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  installAcpRegistryAgent,
} from "@openma/common/acp-harnesses/installer";
import {
  loadRegistry,
  resolveKnownAgent,
} from "@openma/common/acp-harnesses/registry";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = dirname(scriptDir);

/** Dev/E2E agents previously staged via desktop devDependencies. */
const DEV_PREPARE_REGISTRY_IDS = ["codex-acp", "claude-acp"] as const;

export const BUILTIN_ACP_WRAPPERS = ["codex-acp", "claude-agent-acp"] as const;

function npmCommandFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const nodeExec = env.CLASH_NODE_EXEC_PATH?.trim();
  if (!nodeExec) return undefined;
  return nodeExec;
}

function npmEnvFromEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nodeExec = env.CLASH_NODE_EXEC_PATH?.trim();
  if (!nodeExec) return env;
  return { ...env, ELECTRON_RUN_AS_NODE: "1" };
}

export async function prepareAcpHarnesses({
  outputDir = join(desktopRoot, "build", "acp-bin"),
  registryCachePath = join(desktopRoot, "build", "acp-registry-cache.json"),
  logger = console.log,
  env = process.env,
} = {}) {
  const log = (message: string) => logger(`[prepare-acp-harnesses] ${message}`);
  log(`preparing managed ACP bin at ${outputDir}`);
  await mkdir(outputDir, { recursive: true });
  await loadRegistry({
    cachePath: registryCachePath,
    forceRefresh: true,
  });

  for (const registryId of DEV_PREPARE_REGISTRY_IDS) {
    const entry = resolveKnownAgent(registryId);
    if (!entry?.registryId || entry.installSource !== "registry") {
      throw new Error(`Missing registry install entry for ${registryId}`);
    }
    log(`installing ${entry.label} (${registryId})`);
    await installAcpRegistryAgent({
      registryId: entry.registryId,
      ...(entry.registryDistribution
        ? {
            registryAgent: {
              id: entry.registryId,
              name: entry.label,
              ...(entry.version ? { version: entry.version } : {}),
              distribution: entry.registryDistribution,
            },
          }
        : {}),
      shimName: basename(entry.spec.command),
      binDir: outputDir,
      installRoot: outputDir,
      npmCommand: npmCommandFromEnv(env),
      npmEnv: npmEnvFromEnv(env),
      env,
      shimArgs: entry.spec.args,
      shimEnv: entry.spec.env,
    });
  }
  log("done");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  prepareAcpHarnesses().catch((error) => {
    console.error(
      "[prepare-acp-harnesses] failed",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  });
}
