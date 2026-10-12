import { delimiter, dirname, isAbsolute } from "node:path";

import { buildAcpHeadlessLaunch } from "@openma/common/acp-harnesses/headless-launch";
import {
  installPinnedAcpHarness,
  readAcpHarnessPinState,
  type AcpHarnessPinState,
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
 * only harness fact this package owns: the package, its pinned versions, and
 * every launch flag and variable come from the registry entry.
 */
const ACP_HARNESS_IDS = { pi: "pi-acp" } as const;

/** Reasoning effort every benchmark Attempt asks its agent for. */
const BENCHMARK_THINKING_LEVEL = "medium";

export type AcpBenchmarkAdapter = keyof typeof ACP_HARNESS_IDS;

/** The exact versions an Attempt's harness runs, as found in its install. */
export type AcpHarnessVersions = {
  package: { name: string; version: string };
  dependencies: Array<{ name: string; version: string }>;
};

export type ResolvedAcpHarness = {
  id: string;
  label: string;
  command: string;
  /**
   * Present for a harness found in a managed bin directory, where the install
   * was checked against the registry's pins. An explicit launcher is taken as
   * given and has no verified versions.
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
  const managedBinDirs = acpManagedBinDirs(env);
  const detected = await detectEntry(entry, { env, managedBinDirs });
  const installHint = `clash-artifact-bench acp-install --agent ${agent.adapter} --bin-dir <dir>`;
  if (!detected) {
    throw new Error(
      [
        `The ${entry.label} ACP harness '${entry.id}' is not installed`,
        managedBinDirs.length > 0
          ? `(looked in ${managedBinDirs.join(", ")}).`
          : "(CLASH_ACP_BIN_DIR is not set).",
        `Install it with: ${installHint}`,
        "and run with CLASH_ACP_BIN_DIR=<dir>.",
      ].join(" "),
    );
  }
  const command = detected.spec.command;
  const pins = await readAcpHarnessPinState({ entry, shimPath: command });
  if (!pins) {
    throw new Error(
      `The ACP harness registry pins no versions for '${entry.id}'`,
    );
  }
  if (!pins.satisfied) {
    throw new Error(
      [
        `The ${entry.label} ACP harness in ${dirname(command)} does not match the pinned versions:`,
        `${pinMismatches(pins).join("; ")}.`,
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
      dependencies: pins.dependencies.map(({ name, pinned }) => ({
        name,
        version: pinned,
      })),
    },
  };
}

/**
 * Installs an ACP harness into a managed bin directory at the exact versions
 * the registry pins, through the shared OpenMA installer.
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
    acpHeadlessLaunch(agent, { agentDir: "", sessionDir: "" }).env,
  ).sort();
}
