/**
 * Clash re-exports the OpenMA ACP harness registry and maps managed install
 * directories into detection options (CLASH / OPENMA bin env + explicit binDir).
 */

import { delimiter } from "node:path";

export type { KnownAgentEntry } from "@openma/common/acp-harnesses/registry";
export {
  _resetRegistryCache,
  getKnownAgents,
  loadRegistry,
  OVERLAY_AGENTS,
  registryShimName,
  resolveKnownAgent,
} from "@openma/common/acp-harnesses/registry";

import {
  detect as detectOpenma,
  detectAll as detectAllOpenma,
  detectEntry as detectEntryOpenma,
  getKnownAgents,
  type KnownAgentEntry,
} from "@openma/common/acp-harnesses/registry";

export interface ResolveAgentCommandOptions {
  env?: NodeJS.ProcessEnv;
  systemPathFallbackDirs?: string[];
  managedBinDirs?: string[];
  harnessBinDir?: string | null;
  cwd?: string;
  platform?: NodeJS.Platform;
}

function splitBinPath(value: string | undefined): string[] {
  return value?.split(delimiter).filter(Boolean) ?? [];
}

export function resolveAcpDetectOptions(
  options: ResolveAgentCommandOptions = {},
): ResolveAgentCommandOptions {
  const env = { ...(options.env ?? process.env) } as NodeJS.ProcessEnv;
  const managedBinDirs = [
    ...(options.managedBinDirs ?? []),
    ...(options.harnessBinDir ? [options.harnessBinDir] : []),
    ...splitBinPath(env.CLASH_ACP_BIN_DIR),
    ...splitBinPath(env.OPENMA_ACP_BIN_DIR),
  ];
  const unique = [...new Set(managedBinDirs.filter(Boolean))];
  if (unique.length > 0) {
    env.OPENMA_ACP_BIN_DIR = unique.join(delimiter);
  }
  return {
    ...options,
    env,
    managedBinDirs: unique,
  };
}

/** Snapshot after {@link loadRegistry}; overlay-only before first load. */
export function knownAgentCatalog(): readonly KnownAgentEntry[] {
  return getKnownAgents();
}

/** @deprecated Prefer {@link getKnownAgents} after {@link loadRegistry}. */
export const KNOWN_ACP_AGENTS: readonly KnownAgentEntry[] = getKnownAgents();

export async function detect(
  id: string,
  options: ResolveAgentCommandOptions = {},
): Promise<KnownAgentEntry | null> {
  return detectOpenma(id, resolveAcpDetectOptions(options));
}

export async function detectAll(
  options: ResolveAgentCommandOptions = {},
): Promise<KnownAgentEntry[]> {
  return detectAllOpenma(resolveAcpDetectOptions(options));
}

export async function detectEntry(
  entry: KnownAgentEntry,
  options: ResolveAgentCommandOptions = {},
): Promise<KnownAgentEntry | null> {
  return detectEntryOpenma(entry, resolveAcpDetectOptions(options));
}
