import { access } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import { buildAcpHeadlessLaunch } from "@openma/common/acp-harnesses/headless-launch";
import {
  installPinnedAcpHarness,
  pinnedAcpHarnessPaths,
  readAcpHarnessPinState,
  readAcpRegistryInstallMetadata,
  type AcpHarnessPinState,
} from "@openma/common/acp-harnesses/installer";
import {
  loadRegistry,
  resolveKnownAgent,
  type KnownAgentEntry,
} from "@openma/common/acp-harnesses/registry";

import type { BenchmarkAgent } from "./types";

/**
 * Benchmark adapters that are driven over the Agent Client Protocol, mapped to
 * the harness id that names them in the OpenMA harness registry. The id is the
 * only harness fact this package owns: the package, its pinned versions, and
 * every launch flag and variable come from the registry entry.
 */
const ACP_HARNESS_IDS = { pi: "pi-acp" } as const;

/** Reasoning effort every benchmark Attempt asks its agent for. */
export const BENCHMARK_THINKING_LEVEL = "medium";

export type AcpBenchmarkAdapter = keyof typeof ACP_HARNESS_IDS;

/**
 * The directory benchmark harness installs live in. It is the benchmark's own:
 * the variables the Local Host and other OpenMA products use for their managed
 * ACP bin directory are deliberately not read, so a benchmark never installs
 * into, or runs from, a product's directory.
 */
export const BENCHMARK_ACP_BIN_DIR_VARIABLE = "CLASH_BENCH_ACP_BIN_DIR";

/**
 * The exact versions an Attempt's harness runs. `dependencies` is what the
 * installer recorded it installed (`InstallResult.dependencies`), checked
 * against the registry's pins before every Attempt.
 */
export type AcpHarnessVersions = {
  package: { name: string; version: string };
  dependencies: Array<{ name: string; version: string }>;
};

export type ResolvedAcpHarness = {
  id: string;
  label: string;
  command: string;
  /**
   * Present for a harness found in the benchmark bin directory, where the
   * install was checked against the registry's pins. An explicit launcher is
   * taken as given and has no verified versions.
   */
  versions?: AcpHarnessVersions;
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

/**
 * A product install keeps its launcher under the registry's own shim name. A
 * directory that holds one belongs to that product and is refused.
 */
async function assertNotProductBinDir(
  entry: KnownAgentEntry,
  binDir: string,
): Promise<void> {
  const productLauncher = join(binDir, basename(entry.spec.command));
  if (
    await access(productLauncher).then(
      () => true,
      () => false,
    )
  ) {
    throw new Error(
      `${binDir} holds a product ${entry.label} harness install (${basename(productLauncher)}). Benchmark harnesses need a directory of their own.`,
    );
  }
}

function harnessEntry(adapter: AcpBenchmarkAdapter): KnownAgentEntry {
  const id = ACP_HARNESS_IDS[adapter];
  const entry = resolveKnownAgent(id);
  if (!entry) {
    throw new Error(`The ACP harness registry has no '${id}' entry`);
  }
  return entry;
}

function pinMismatches(state: AcpHarnessPinState): string[] {
  return [state.package, ...state.dependencies]
    .filter(({ pinned, installed }) => installed !== pinned)
    .map(
      ({ name, pinned, installed }) =>
        `${name} is ${installed ?? "not installed"}, pinned ${pinned}`,
    );
}

/**
 * Resolves the launch command of an ACP-driven adapter. An explicit
 * `agent.command` path is an operator override of the launcher; otherwise the
 * registry entry is detected in the managed ACP bin directories and its
 * install must match the versions the registry pins.
 */
export async function resolveAcpHarness(
  agent: AcpBenchmarkAgent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedAcpHarness> {
  const entry = harnessEntry(agent.adapter);
  if (agent.command) {
    if (!isAbsolute(agent.command)) {
      throw new Error(
        `An explicit ${entry.label} ACP launcher must be an absolute path`,
      );
    }
    return { id: entry.id, label: entry.label, command: agent.command };
  }
  const installHint = `clash-artifact-bench acp-install --agent ${agent.adapter} --bin-dir <dir>`;
  const binDir = env[BENCHMARK_ACP_BIN_DIR_VARIABLE];
  if (!binDir || !isAbsolute(binDir)) {
    throw new Error(
      [
        `The ${entry.label} ACP harness '${entry.id}' is not installed:`,
        `${BENCHMARK_ACP_BIN_DIR_VARIABLE} must name the benchmark's own harness directory (an absolute path).`,
        `Install it with: ${installHint}`,
      ].join(" "),
    );
  }
  await assertNotProductBinDir(entry, binDir);
  const paths = pinnedAcpHarnessPaths(entry, binDir);
  const command = paths.launcherPath;
  const [pins, recorded] = await Promise.all([
    readAcpHarnessPinState({ entry, shimPath: command }),
    readAcpRegistryInstallMetadata({ registryId: paths.stateId, binDir }),
  ]);
  if (!pins) {
    throw new Error(
      `The ACP harness registry pins no versions for '${entry.id}'`,
    );
  }
  if (!pins.package.installed || !recorded) {
    throw new Error(
      [
        `The ${entry.label} ACP harness '${entry.id}' is not installed in ${binDir}.`,
        `Install it with: ${installHint}`,
      ].join(" "),
    );
  }
  // What the installer recorded must be what is on disk, and both must be
  // the pinned versions: any difference means another Pi would run.
  const recordedDependencies = recorded.dependencies ?? {};
  const mismatches = [
    ...pinMismatches(pins),
    ...(recorded.version === pins.package.pinned
      ? []
      : [
          `install record says ${pins.package.name} ${recorded.version ?? "unknown"}, pinned ${pins.package.pinned}`,
        ]),
    ...pins.dependencies
      .filter(({ name, pinned }) => recordedDependencies[name] !== pinned)
      .map(
        ({ name, pinned }) =>
          `install record says ${name} ${recordedDependencies[name] ?? "not installed"}, pinned ${pinned}`,
      ),
  ];
  if (mismatches.length > 0) {
    throw new Error(
      [
        `The ${entry.label} ACP harness in ${binDir} does not match the pinned versions:`,
        `${mismatches.join("; ")}.`,
        `Reinstall it with: ${installHint}`,
      ].join(" "),
    );
  }
  return {
    id: entry.id,
    label: entry.label,
    command,
    versions: {
      package: { name: pins.package.name, version: pins.package.pinned },
      dependencies: pins.dependencies.map(({ name }) => ({
        name,
        version: recordedDependencies[name]!,
      })),
    },
  };
}

/**
 * Installs an ACP harness into the benchmark's own bin directory at the exact
 * versions the registry pins, through the shared OpenMA installer.
 */
export async function installAcpHarness(input: {
  adapter: AcpBenchmarkAdapter;
  binDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  id: string;
  commandPath: string;
  version?: string;
  dependencies?: Record<string, string>;
}> {
  if (!isAbsolute(input.binDir)) {
    throw new Error("The ACP harness bin directory must be an absolute path");
  }
  await loadRegistry();
  const entry = harnessEntry(input.adapter);
  await assertNotProductBinDir(entry, input.binDir);
  const installed = await installPinnedAcpHarness({
    entry,
    binDir: input.binDir,
    installRoot: input.binDir,
    ...(input.env ? { env: input.env } : {}),
  });
  return { id: entry.id, ...installed };
}

/**
 * The launch of one headless benchmark Attempt, built by the registry entry's
 * own recipe from generic options. The Attempt depends on every option it
 * passes (an agent directory the harness ignored would load the operator's
 * own configuration), so an option the recipe cannot express is an error.
 */
export function acpHeadlessLaunch(
  agent: AcpBenchmarkAgent,
  directories: { agentDir: string; sessionDir: string },
): { args: string[]; env: Record<string, string> } {
  const entry = harnessEntry(agent.adapter);
  // The provider and the thinking level are written inside the model value.
  // The thinking level is requested only together with a model; a provider
  // configured without one is reported by the recipe and refused below.
  const launch = buildAcpHeadlessLaunch(entry, {
    ...directories,
    // Case skills are installed in the workspace's `.agents/skills`.
    trustProject: true,
    ...(agent.provider ? { provider: agent.provider } : {}),
    ...(agent.model
      ? { model: agent.model, thinkingLevel: BENCHMARK_THINKING_LEVEL }
      : {}),
  });
  if (launch.unsupported.length > 0) {
    throw new Error(
      `The ${entry.label} headless launch recipe cannot express: ${launch.unsupported.join(", ")}`,
    );
  }
  return {
    args: [...launch.args, ...(agent.args ?? [])],
    env: launch.env,
  };
}

/** Variables the harness's recipe sets to point the agent at its own configuration. */
export function acpAgentDirectoryVariables(agent: AcpBenchmarkAgent): string[] {
  return Object.keys(
    buildAcpHeadlessLaunch(harnessEntry(agent.adapter), { agentDir: "" }).env,
  ).sort();
}
