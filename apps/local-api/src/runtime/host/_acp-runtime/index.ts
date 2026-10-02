// Re-export core types and classes from @openma/common
export type {
  AgentSpec,
  AcpSession,
  AcpRuntime,
  RestartPolicy,
  SessionOptions,
  ClientCallbacks,
  ChildHandle,
  Spawner,
  SteeringOutcome,
} from "@openma/common/acp-runtime";
export type { ContentBlock, PromptCapabilities } from "@agentclientprotocol/sdk";
export { AcpSessionImpl } from "@openma/common/acp-runtime";
export type { AcpSessionConstructOptions } from "@openma/common/acp-runtime";
export { NodeSpawner } from "@openma/common/acp-runtime/node-spawner";

// Clash-specific runtime wrapper
export { AcpRuntimeImpl } from "./runtime.js";

// Clash-specific probe extensions
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

// Clash-specific agent catalog and session management
export { listAgentSessions, listLocalAgentSessions, type AcpListedSession } from "./session-list.js";
export { KNOWN_ACP_AGENTS, detect, detectAll, detectEntry, type KnownAgentEntry } from "./registry.js";
export { withClashAcpExtensionCapabilities } from "./client-capabilities.js";
