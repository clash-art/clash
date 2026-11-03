import { lchown, readdir } from "node:fs/promises";
import { join } from "node:path";

export type ProcessIdentity = { uid: number; gid: number };

/**
 * The worker grades; the Agent only works. A worker given this runs the Agent
 * (and nothing else) as `agent`, an unprivileged identity that owns its
 * workspace and home and nothing the worker reads, so the suite, the unit, the
 * Attempt directory and the worker's own `/proc` entries stay closed to it.
 * When the worker is done, the Attempt directory goes back to `owner`.
 */
export type AgentIsolation = {
  agent: ProcessIdentity;
  owner: ProcessIdentity;
};

/** In-process form: also names worker variables the Agent must not inherit. */
export type AgentProcessIsolation = AgentIsolation & {
  withheldEnv: readonly string[];
};

export type AgentIsolationErrorCode =
  | "agent_isolation_invalid_identity"
  | "agent_isolation_shared_uid"
  | "agent_isolation_unprivileged_worker";

export class AgentIsolationError extends Error {
  readonly code: AgentIsolationErrorCode;

  constructor(code: AgentIsolationErrorCode, message: string) {
    super(message);
    this.name = "AgentIsolationError";
    this.code = code;
  }
}

function assertIdentity(identity: ProcessIdentity, label: string): void {
  for (const id of [identity.uid, identity.gid]) {
    if (!Number.isInteger(id) || id < 0) {
      throw new AgentIsolationError(
        "agent_isolation_invalid_identity",
        `${label} uid and gid must be non-negative integers`,
      );
    }
  }
}

/**
 * The Agent's uid must be neither root nor the uid that owns the private
 * mounts, or it could read them, and the worker needs root to switch to it.
 */
export function assertAgentIsolation(
  isolation: AgentIsolation,
  workerUid: number | undefined,
): void {
  assertIdentity(isolation.agent, "The Agent");
  assertIdentity(isolation.owner, "The Attempt owner");
  if (
    isolation.agent.uid === 0 ||
    isolation.agent.uid === isolation.owner.uid
  ) {
    throw new AgentIsolationError(
      "agent_isolation_shared_uid",
      `The Agent uid ${isolation.agent.uid} must differ from root and from the Attempt owner ${isolation.owner.uid}`,
    );
  }
  if (workerUid !== undefined && workerUid !== 0) {
    throw new AgentIsolationError(
      "agent_isolation_unprivileged_worker",
      `The worker runs as uid ${workerUid} and cannot start the Agent as uid ${isolation.agent.uid}; it must run as root`,
    );
  }
}

/** `spawn` options that start a process as the isolated Agent. */
export function agentSpawnIdentity(isolation: AgentIsolation | undefined): {
  uid?: number;
  gid?: number;
} {
  return isolation
    ? { uid: isolation.agent.uid, gid: isolation.agent.gid }
    : {};
}

/** Gives `root` and everything below it to `identity`, never following links. */
export async function handOverTree(
  root: string,
  identity: ProcessIdentity,
): Promise<void> {
  await lchown(root, identity.uid, identity.gid);
  const entries = await readdir(root, { recursive: true });
  for (const entry of entries) {
    await lchown(join(root, entry), identity.uid, identity.gid);
  }
}
