export type {
  AgentSpec,
  ChildHandle,
  Spawner,
  AcpSession,
  AcpRuntime,
  RestartPolicy,
  SessionOptions,
  ClientCallbacks,
} from "@openma/common/acp-runtime";
export { AcpSessionImpl } from "@openma/common/acp-runtime";
export type { AcpSessionConstructOptions } from "@openma/common/acp-runtime";
export { NodeSpawner } from "./node-spawner.js";

export { AcpRuntimeImpl } from "./runtime.js";
export type { ClashAcpStartOptions } from "./runtime.js";
export {
  authenticateAgent,
  disposeAllAcpSetupProcesses,
  probeAgentAuthStatus,
  probeAgentConfigOptions,
  probeAgentSessionConfig,
  type AuthenticateAgentOptions,
  type AuthenticateAgentResult,
  type ProbeAgentAuthStatus,
  type ProbeAgentAuthStatusOptions,
  type ProbeAgentConfigOptionsOptions,
  type ProbeAgentSessionConfigResult,
} from "./probe.js";
export { listAgentSessions, listLocalAgentSessions, type AcpListedSession } from "./session-list.js";
export { KNOWN_ACP_AGENTS, detect, detectAll, detectEntry, type KnownAgentEntry } from "./registry.js";
