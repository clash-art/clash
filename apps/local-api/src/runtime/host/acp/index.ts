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
export {
  AcpRuntimeImpl,
  AcpSessionImpl,
  authenticateAgent,
  disposeAllAcpProbes,
  probeAgentAuthStatus,
} from "@openma/common/acp-runtime";
export type {
  AcpForkPoint,
  AcpSessionConstructOptions,
  AuthenticateAgentOptions,
  AuthenticateAgentResult,
  ProbeAgentAuthStatus,
  ProbeAgentAuthStatusOptions,
} from "@openma/common/acp-runtime";
export { NodeSpawner } from "@openma/common/acp-runtime/node-spawner";

export {
  disposeAllAcpSetupProcesses,
  probeAgentConfigOptions,
  probeAgentSessionConfig,
  type ProbeAgentConfigOptionsOptions,
  type ProbeAgentSessionConfigResult,
} from "./probe.js";
export { listAgentSessions, listLocalAgentSessions, type AcpListedSession } from "./session-list.js";
export {
  KNOWN_ACP_AGENTS,
  OVERLAY_AGENTS,
  detect,
  detectAll,
  detectEntry,
  getKnownAgents,
  knownAgentCatalog,
  loadRegistry,
  registryShimName,
  resolveAcpDetectOptions,
  resolveKnownAgent,
  type KnownAgentEntry,
  type ResolveAgentCommandOptions,
} from "./registry.js";
