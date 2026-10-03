import { constants } from "node:fs";
import { access, readdir, readFile, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  installAcpRegistryAgent,
  readAcpRegistryInstallMetadata,
  repairRelocatedAcpRegistryShim,
} from "@openma/common/acp-harnesses/installer";
import {
  getKnownAgents,
  loadRegistry,
  type KnownAgentEntry,
} from "@openma/common/acp-harnesses/registry";

export const ACP_LEGACY_SHIM_MIGRATION_ID = "acp-clash-managed-shim-v1";

export type AcpLegacyShimMigrationResult = {
  adopted: string[];
  reinstalled: string[];
  needsAttention: { harnessId: string; message: string }[];
};

function legacyClashShimName(registryId: string): string {
  return `clash-acp-${registryId}`;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function shimExecTarget(shimPath: string): Promise<string | null> {
  const shim = await readFile(shimPath, "utf8").catch(() => "");
  const match = shim.match(/^exec '([^'\r\n]+)'/m);
  return match?.[1] ?? null;
}

async function adoptLegacyShimRename(options: {
  binDir: string;
  entry: KnownAgentEntry;
  legacyPath: string;
  targetShimName: string;
}): Promise<boolean> {
  const targetPath = join(options.binDir, options.targetShimName);
  if (options.legacyPath === targetPath) return true;
  try {
    await access(targetPath);
    return true;
  } catch {
    // target missing — rename legacy shim into place
  }
  const execTarget = await shimExecTarget(options.legacyPath);
  if (!execTarget || !(await access(execTarget).then(() => true, () => false))) {
    return false;
  }
  await rename(options.legacyPath, targetPath);
  return true;
}

export async function migrateLegacyClashAcpShims(options: {
  binDir: string;
  fetchImpl?: typeof fetch;
  spawnEnv?: Record<string, string | undefined>;
  reinstallHarness: (harnessId: string) => Promise<void>;
}): Promise<AcpLegacyShimMigrationResult> {
  const result: AcpLegacyShimMigrationResult = {
    adopted: [],
    reinstalled: [],
    needsAttention: [],
  };
  if (!options.binDir) return result;

  await loadRegistry({}).catch(() => undefined);
  const catalog = getKnownAgents().filter(
    (entry) => entry.installSource === "registry" && entry.registryId,
  );

  let binEntries: string[] = [];
  try {
    binEntries = await readdir(options.binDir);
  } catch {
    return result;
  }

  const legacyShims = binEntries.filter((name) => name.startsWith("clash-acp-"));
  if (legacyShims.length === 0) {
    await repairRegistryShims(options.binDir, catalog);
    return result;
  }

  for (const entry of catalog) {
    const registryId = entry.registryId;
    if (!registryId) continue;
    const legacyName = legacyClashShimName(registryId);
    if (!legacyShims.includes(legacyName)) continue;

    const legacyPath = join(options.binDir, legacyName);
    const targetShimName = basename(entry.spec.command);

    await repairRelocatedAcpRegistryShim({
      registryId,
      shimName: legacyName,
      binDir: options.binDir,
      installRoot: options.binDir,
    }).catch(() => false);

    const metadata = await readAcpRegistryInstallMetadata({
      registryId,
      binDir: options.binDir,
      installRoot: options.binDir,
    });

    let adopted = false;
    if (legacyName !== targetShimName) {
      adopted = await adoptLegacyShimRename({
        binDir: options.binDir,
        entry,
        legacyPath,
        targetShimName,
      });
    } else if (await isExecutable(legacyPath)) {
      adopted = true;
    }

    if (adopted) {
      result.adopted.push(entry.id);
      continue;
    }

    try {
      if (metadata) {
        await installAcpRegistryAgent({
          registryId,
          shimName: targetShimName,
          binDir: options.binDir,
          installRoot: options.binDir,
          fetchImpl: options.fetchImpl,
          env: options.spawnEnv as NodeJS.ProcessEnv,
        });
        await access(legacyPath).then(
          () => rename(legacyPath, `${legacyPath}.migrated`),
          () => undefined,
        );
        result.reinstalled.push(entry.id);
        continue;
      }
      await options.reinstallHarness(entry.id);
      result.reinstalled.push(entry.id);
    } catch {
      result.needsAttention.push({
        harnessId: entry.id,
        message: `${entry.label} still uses the older Clash shim name (${legacyName}). Open Settings → Agents and choose Install to refresh this harness.`,
      });
    }
  }

  await repairRegistryShims(options.binDir, catalog);
  return result;
}

async function repairRegistryShims(
  binDir: string,
  catalog: KnownAgentEntry[],
): Promise<void> {
  await Promise.all(
    catalog.map(async (entry) => {
      if (entry.installSource !== "registry" || !entry.registryId) return;
      try {
        await repairRelocatedAcpRegistryShim({
          registryId: entry.registryId,
          shimName: basename(entry.spec.command),
          binDir,
          installRoot: binDir,
        });
      } catch {
        // best-effort
      }
    }),
  );
}
