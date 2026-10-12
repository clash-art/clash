import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Variables that locate a user's home and per-user configuration, data, cache
 * and state. An isolated Attempt points every one of them at a directory that
 * exists only for that Attempt.
 */
export const ISOLATED_HOME_VARIABLES = [
  "HOME",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

export type IsolatedAgentHome = {
  /** Overrides for the agent process environment. */
  env: Record<(typeof ISOLATED_HOME_VARIABLES)[number], string>;
  /** Empty directory for the agent's own user-level configuration. */
  agentDir: string;
  /** Empty directory for the agent's own session files. */
  sessionDir: string;
};

/**
 * Lays out a private home under `root` so an agent finds no configuration,
 * extensions, skills, context files or stored credentials of the person
 * running the benchmark. Credentials reach the agent only as the environment
 * variables the runner passes explicitly.
 */
export async function createIsolatedAgentHome(
  root: string,
): Promise<IsolatedAgentHome> {
  const home = join(root, "home");
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all(
    [...Object.values(env), agentDir, sessionDir].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  return { env, agentDir, sessionDir };
}
