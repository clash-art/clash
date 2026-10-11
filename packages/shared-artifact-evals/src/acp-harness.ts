import { basename, delimiter, dirname, isAbsolute } from "node:path";

import {
  installAcpRegistryAgent,
  npmPackageNameFromSpec,
  readInstalledNpmPackageVersion,
} from "@openma/common/acp-harnesses/installer";
import {
  detectEntry,
  loadRegistry,
  resolveKnownAgent,
  type KnownAgentEntry,
} from "@openma/common/acp-harnesses/registry";

import type { BenchmarkAgent } from "./types";

/**
 * Benchmark adapters that are driven over the Agent Client Protocol, mapped to
 * the harness id that names them in the OpenMA harness registry. The id is the
 * only harness fact this package owns: the package, its version, and the launch
 * command all come from the registry entry.
 */
const ACP_HARNESS_IDS = { pi: "pi-acp" } as const;

export type AcpBenchmarkAdapter = keyof typeof ACP_HARNESS_IDS;

export type ResolvedAcpHarness = {
  id: string;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** npm package the registry installs for this harness, when it is one. */
  packageName?: string;
  /** Version of that package found in the managed install. */
  packageVersion?: string;
};

export type AcpBenchmarkAgent = Extract<
  BenchmarkAgent,
  { adapter: AcpBenchmarkAdapter }
>;

export function isAcpAgent(agent: BenchmarkAgent): agent is AcpBenchmarkAgent {
  return (
    agent.adapter !== undefined && Object.hasOwn(ACP_HARNESS_IDS, agent.adapter)
  );
}

function splitPath(value: string | undefined): string[] {
  return value?.split(delimiter).filter(Boolean) ?? [];
}

/** The same managed-bin variables the Local Host exports for its harnesses. */
export function acpManagedBinDirs(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set([
      ...splitPath(env.CLASH_ACP_BIN_DIR),
      ...splitPath(env.OPENMA_ACP_BIN_DIR),
    ]),
  ];
}

function harnessEntry(adapter: AcpBenchmarkAdapter): KnownAgentEntry {
  const id = ACP_HARNESS_IDS[adapter];
  const entry = resolveKnownAgent(id);
  if (!entry) {
    throw new Error(`The ACP harness registry has no '${id}' entry`);
  }
  return entry;
}

function definedEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function npmPackageName(entry: KnownAgentEntry): string | undefined {
  const spec = entry.registryDistribution?.npx?.package;
  return spec ? npmPackageNameFromSpec(spec) : undefined;
}

/**
 * Resolves the launch command of an ACP-driven adapter. An explicit
 * `agent.command` path is an operator override of the launcher; otherwise the
 * registry entry is detected in the managed ACP bin directories.
 */
export async function resolveAcpHarness(
  agent: AcpBenchmarkAgent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedAcpHarness> {
  const entry = harnessEntry(agent.adapter);
  const packageName = npmPackageName(entry);
  if (agent.command) {
    if (!isAbsolute(agent.command)) {
      throw new Error(
        `An explicit ${entry.label} ACP launcher must be an absolute path`,
      );
    }
    return {
      id: entry.id,
      label: entry.label,
      command: agent.command,
      args: [...(entry.spec.args ?? [])],
      env: definedEnv(entry.spec.env),
      ...(packageName ? { packageName } : {}),
    };
  }
  const managedBinDirs = acpManagedBinDirs(env);
  const detected = await detectEntry(entry, { env, managedBinDirs });
  if (!detected) {
    throw new Error(
      [
        `The ${entry.label} ACP harness '${entry.id}' is not installed`,
        managedBinDirs.length > 0
          ? `(looked for ${basename(entry.spec.command)} in ${managedBinDirs.join(", ")}).`
          : "(CLASH_ACP_BIN_DIR is not set).",
        `Install it with: clash-artifact-bench acp-install --agent ${agent.adapter} --bin-dir <dir>`,
        "and run with CLASH_ACP_BIN_DIR=<dir>.",
      ].join(" "),
    );
  }
  const packageVersion = packageName
    ? await readInstalledNpmPackageVersion({
        shimPath: detected.spec.command,
        packageName,
        installRoot: dirname(detected.spec.command),
        ...(entry.registryId ? { registryId: entry.registryId } : {}),
      })
    : undefined;
  return {
    id: entry.id,
    label: entry.label,
    command: detected.spec.command,
    args: [...(detected.spec.args ?? [])],
    env: definedEnv(detected.spec.env),
    ...(packageName ? { packageName } : {}),
    ...(packageVersion ? { packageVersion } : {}),
  };
}

/**
 * Installs an ACP harness into a managed bin directory through the shared
 * OpenMA installer, the same call the Local Host makes for its harnesses.
 */
export async function installAcpHarness(input: {
  adapter: AcpBenchmarkAdapter;
  binDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; commandPath: string; version?: string }> {
  if (!isAbsolute(input.binDir)) {
    throw new Error("The ACP harness bin directory must be an absolute path");
  }
  await loadRegistry();
  const entry = harnessEntry(input.adapter);
  if (entry.installSource !== "registry" || !entry.registryId) {
    throw new Error(`${entry.label} is not installable from the ACP registry`);
  }
  const installed = await installAcpRegistryAgent({
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
    binDir: input.binDir,
    installRoot: input.binDir,
    ...(entry.spec.args ? { shimArgs: entry.spec.args } : {}),
    ...(entry.spec.env ? { shimEnv: entry.spec.env } : {}),
    ...(input.env ? { env: input.env } : {}),
  });
  return {
    id: entry.id,
    commandPath: installed.commandPath,
    ...(installed.version ? { version: installed.version } : {}),
  };
}

/**
 * Launcher arguments for one headless benchmark Attempt. These are the
 * harness's own documented flags; the equivalent selection used to be passed
 * to the `pi` CLI directly.
 */
export function acpLaunchArgs(
  agent: AcpBenchmarkAgent,
  harness: ResolvedAcpHarness,
  options: { sessionDir: string },
): string[] {
  const model =
    agent.model && agent.provider && !agent.model.includes("/")
      ? `${agent.provider}/${agent.model}`
      : agent.model;
  return [
    ...harness.args,
    // The runner provides no editor: tools run in the agent's own process.
    "--no-delegation",
    "--quiet-startup",
    // Case skills are installed in the workspace's `.agents/skills`.
    "--trust-projects",
    "--session-dir",
    options.sessionDir,
    ...(model ? ["--model", `${model}:medium`] : []),
    ...(agent.args ?? []),
  ];
}
