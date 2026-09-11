import { supportsAcpMessageFork, type AcpForkPoint } from "@clash/shared-types";
import type { IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  detectAll,
  detectEntry,
  disposeAllAcpSetupProcesses,
  KNOWN_ACP_AGENTS,
  authenticateAgent as authenticateRuntimeAgent,
  listLocalAgentSessions,
  probeAgentAuthStatus as probeRuntimeAgentAuthStatus,
  probeAgentSessionConfig as probeRuntimeAgentSessionConfig,
  type AuthenticateAgentResult,
  type KnownAgentEntry,
  type ProbeAgentAuthStatus,
} from "./runtime/host/_acp-runtime/index.js";
import { listLocalCcSessions } from "./runtime/host/lib/cc-sessions.js";
import {
  machineName,
  osTag as defaultOsTag,
} from "./runtime/host/lib/platform.js";
import {
  SessionManager,
  type ManagerOut,
  type SessionElicitationBroker,
  type SessionPermissionBroker,
} from "./runtime/host/lib/session-manager.js";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import type {
  LocalAcpAdapter,
  LocalAcpAttachSessionParams,
  LocalAcpCreateSessionParams,
  LocalAcpResumeSession,
  LocalAcpSessionEvent,
  LocalAcpSessionEventStore,
} from "./app.js";
import {
  installAcpRegistryAgent,
  installManagedAdapter,
  listAcpRegistryCatalog,
  readAcpRegistryInstallMetadata,
  uninstallAcpRegistryAgent,
  uninstallManagedAdapter,
} from "./acp-registry-installer.js";
import { createSqliteLocalConfigStore } from "./local-config-store.js";
import { createClashUserConfigStore } from "./user-config.js";

export const DESKTOP_LOCAL_RUNTIME_ID = "desktop-local";

export type SessionManagerOut = ManagerOut;
export type SessionSender = (msg: SessionManagerOut) => void;

export interface SessionStartParamsLike {
  session_id: string;
  agent_template_id?: string;
  agent_id?: string;
  agent_spec?: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
  config_options?: Record<string, string | boolean>;
  permission_mode?: string;
  agent_member_id?: string;
  project_id?: string;
  resume?: { acp_session_id: string };
  fork?: { acp_session_id: string; point?: AcpForkPoint };
}

export interface SessionPromptParamsLike {
  session_id: string;
  turn_id: string;
  text: string;
}

export interface SessionManagerLike {
  setSpawnEnv?(env: Record<string, string | undefined>): void;
  start(params: SessionStartParamsLike): Promise<void> | void;
  prompt(params: SessionPromptParamsLike): Promise<void> | void;
  setConfigOption?(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<void> | void;
  setMode?(sessionId: string, modeId: string): Promise<void> | void;
  cancel(sessionId: string, turnId: string): void;
  dispose(sessionId: string): Promise<void> | void;
}

export interface DetectedAcpAgent {
  id: string;
  label: string;
  configOptions?: unknown[];
  availableCommands?: unknown[];
  sessionModes?: unknown;
  auth?: LocalAcpHarnessAuth;
  capabilityInspection?: LocalAcpCapabilityInspection;
  spec: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
}

export interface LocalAcpCapabilityInspection {
  status: "ready" | "blocked-auth" | "degraded";
  inspected_at: string;
  error?: string;
}

export interface LocalAcpHarnessAuthMethod {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  form?: "fields";
  vars?: Array<{
    name: string;
    label?: string;
    secret?: boolean;
    optional?: boolean;
  }>;
  link?: string;
  terminalLaunch?: InteractiveAuthLaunchOptions;
}

export interface LocalAcpHarnessAuth {
  status: "configured" | "needs-auth" | "unknown";
  message: string;
  command?: string;
  methodId?: string;
  methodName?: string;
  methods?: LocalAcpHarnessAuthMethod[];
}

export interface LocalAcpHarness {
  id: string;
  label: string;
  binary: string;
  enabled: boolean;
  available: boolean;
  custom?: boolean;
  installed?: boolean;
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  installable?: boolean;
  installSource?: "registry" | "adapter";
  downloadUrl?: string;
  downloadKind?: "adapter";
  homepage?: string;
  auth?: LocalAcpHarnessAuth;
  session_modes?: unknown;
}

export interface LocalAcpHarnessListOptions {
  checkUpdates?: boolean;
  probe?: boolean | "auth" | "config" | "none";
  refresh?: boolean;
}

export interface LocalAcpRuntimeListOptions {
  probe?: boolean | "auth" | "config" | "none";
  refresh?: boolean;
}

export interface LocalAcpAuthenticateOptions {
  methodId?: string;
  values?: Record<string, string>;
}

type DetectedAgentProbeScope = "enabled" | "installed";

interface DetectedAgentListOptions {
  probeAuth?: boolean;
  probeConfigOptions?: boolean;
  probeScope?: DetectedAgentProbeScope;
  refresh?: boolean;
}

export interface LocalAcpHarnessConfigStore {
  loadEnabledHarnessIds(): Promise<string[] | null>;
  saveEnabledHarnessIds(ids: string[]): Promise<void>;
  loadAgentServers?(): Promise<LocalAcpAgentServersConfig | null>;
  saveAgentServers?(servers: LocalAcpAgentServersConfig): Promise<void>;
}

export type LocalAcpRunConfigValue = string | boolean;

export interface LocalAcpRunPreferences {
  agent_id?: string;
  config_by_agent: Record<string, Record<string, LocalAcpRunConfigValue>>;
  mode_by_agent: Record<string, string>;
}

export interface LocalAcpRunPreferencesStore {
  load(): Promise<LocalAcpRunPreferences>;
  save(preferences: LocalAcpRunPreferences): Promise<void>;
}

export interface LocalAcpRunPreferenceUpdate {
  agent_id: string;
  config_values?: Record<string, LocalAcpRunConfigValue>;
  mode_id?: string;
}

type LocalAcpConfirmedCapabilities = Pick<
  DetectedAcpAgent,
  "configOptions" | "availableCommands" | "sessionModes"
>;

export interface LocalAcpCapabilityCacheStore {
  load(): Promise<Record<string, LocalAcpConfirmedCapabilities>>;
  save(value: Record<string, LocalAcpConfirmedCapabilities>): Promise<void>;
}

export interface LocalAcpCustomAgentServer {
  type: "custom";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type LocalAcpAgentServersConfig = Record<
  string,
  LocalAcpCustomAgentServer
>;

export interface LocalAcpTextTaskParams {
  projectId: string;
  prompt: string;
  agentId?: string;
  modelId?: string;
  modelConfigId?: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

export interface LocalAcpAdapterOptions {
  detectAgents?: () => Promise<DetectedAcpAgent[]>;
  probeAgentAuth?: (
    agent: DetectedAcpAgent,
  ) => Promise<LocalAcpHarnessAuth | undefined>;
  probeAgentConfigOptions?: (agent: DetectedAcpAgent) => Promise<unknown[]>;
  probeAgentSessionConfig?: (agent: DetectedAcpAgent) => Promise<{
    configOptions?: unknown[];
    availableCommands?: unknown[];
    modes?: unknown;
    auth?: ProbeAgentAuthStatus;
  }>;
  authenticateAgent?: (
    agent: DetectedAcpAgent,
    options?: LocalAcpAuthenticateOptions,
  ) => Promise<AuthenticateAgentResult | void>;
  launchInteractiveAuth?: (
    options: InteractiveAuthLaunchOptions,
  ) => Promise<void>;
  probeCwd?: string;
  probeTimeoutMs?: number;
  listResumeSessions?: () => Promise<LocalAcpResumeSession[]>;
  listAgentSessions?: (
    agent: DetectedAcpAgent,
  ) => Promise<LocalAcpResumeSession[]>;
  createSessionId?: () => string;
  createSessionManager?: (
    send: SessionSender,
    requestPermission?: SessionPermissionBroker,
    requestElicitation?: SessionElicitationBroker,
  ) => SessionManagerLike;
  harnessConfig?: LocalAcpHarnessConfigStore;
  runPreferences?: LocalAcpRunPreferencesStore;
  capabilityCache?: LocalAcpCapabilityCacheStore;
  agentCatalog?: KnownAgentEntry[];
  spawnEnv?: Record<string, string | undefined>;
  harnessDownloadDir?: string;
  fetch?: typeof fetch;
  hostname?: () => string;
  osTag?: () => string;
  nowSeconds?: () => number;
  nowMilliseconds?: () => number;
}

interface BrowserMessage {
  type?: string;
  turn_id?: string;
  config_id?: string;
  mode_id?: string;
  value?: string | boolean;
  text?: string;
  queue_mode?: string;
  turn_ids?: unknown[];
  request_id?: string;
  option_id?: string | null;
  action?: string;
  content?: unknown;
}

export interface InteractiveAuthLaunchOptions {
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string | null;
}

interface LocalAcpSession {
  id: string;
  startParams: LocalAcpCreateSessionParams;
  harnessId: string;
  harnessLabel: string;
  harnessVersion?: string;
  manager: SessionManagerLike;
  startPromise?: Promise<void>;
  clients: Set<WebSocket>;
  readyMessage?: unknown;
  configOptionsMessage?: unknown;
  modeMessage?: unknown;
  errorMessage?: unknown;
  promptQueueMode: PromptQueueMode;
  queuedPrompts: QueuedPrompt[];
  scheduledPromptCount: number;
  activePromptTurnId: string | null;
  acpSessionId?: string;
  restartPending: boolean;
  restartReadySent: boolean;
  restarting?: boolean;
  projectId?: string;
  agentMemberId?: string;
  promptQueue: Promise<void>;
  persistQueue: Promise<void>;
  events: LocalAcpSessionEvent[];
  disposePromise?: Promise<void>;
  disposedSent?: boolean;
  observers?: Set<(msg: unknown) => void>;
  pendingPermissions: Map<
    string,
    {
      optionIds: Set<string>;
      message: {
        type: "session.permission_request";
        session_id: string;
        request_id: string;
        tool_call: unknown;
        options: unknown[];
      };
      resolve: (response: Awaited<ReturnType<SessionPermissionBroker>>) => void;
    }
  >;
  pendingElicitations: Map<
    string,
    | {
        request: CreateElicitationRequest & { mode: "form" };
        message: {
          type: "session.elicitation_request";
          session_id: string;
          request_id: string;
          mode: "form";
          message: string;
          requested_schema: unknown;
          tool_call_id?: string;
        };
        resolve: (response: CreateElicitationResponse) => void;
      }
    | {
        request: CreateElicitationRequest & { mode: "url" };
        message: {
          type: "session.elicitation_request";
          session_id: string;
          request_id: string;
          mode: "url";
          message: string;
          elicitation_id: string;
          url: string;
          tool_call_id?: string;
        };
        resolve: (response: CreateElicitationResponse) => void;
      }
  >;
}

type PromptQueueMode = "single" | "flush";

interface QueuedPrompt {
  turnId: string;
  text: string;
  createdAt: number;
}

type UpgradeCapableServer = {
  on(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: any, head: Buffer) => void,
  ): void;
};

function extractAcpContentText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    text?: unknown;
    delta?: unknown;
    content?: unknown;
  };
  if (typeof raw.text === "string") return raw.text;
  if (typeof raw.delta === "string") return raw.delta;
  if (typeof raw.content === "string") return raw.content;
  return extractAcpContentText(raw.content);
}

function isTransportDiagnosticText(text: string): boolean {
  return /^Falling back from WebSockets to HTTPS transport\./i.test(
    text.trim(),
  );
}

function isTransportDiagnosticManagerMessage(msg: unknown): boolean {
  if (!isSessionEventMessage(msg)) return false;
  const event = msg.event;
  if (!event || typeof event !== "object") return false;
  const outer = event as {
    sessionUpdate?: unknown;
    update?: unknown;
    type?: unknown;
    content?: unknown;
  };
  const inner = (
    outer.update && typeof outer.update === "object" ? outer.update : outer
  ) as {
    sessionUpdate?: unknown;
    type?: unknown;
    content?: unknown;
  };
  const update =
    typeof inner.sessionUpdate === "string"
      ? inner.sessionUpdate
      : typeof outer.sessionUpdate === "string"
        ? outer.sessionUpdate
        : typeof inner.type === "string"
          ? inner.type
          : "";
  if (update !== "agent_message_chunk") return false;
  const text = extractAcpContentText(inner.content);
  return typeof text === "string" && isTransportDiagnosticText(text);
}

async function defaultDetectAgents(
  env: Record<string, string | undefined> = process.env,
): Promise<DetectedAcpAgent[]> {
  const detected = await detectAll({ env: env as NodeJS.ProcessEnv });
  return detected.map((agent) => {
    const { env: agentEnv, ...spec } = agent.spec;
    return {
      ...agent,
      spec: {
        ...spec,
        ...(agentEnv ? { env: mergedStringEnv(agentEnv) } : {}),
      },
    };
  });
}

function normalizeEnabledHarnessIds(
  ids: string[],
  allowedIds: string[],
): string[] {
  const requested = new Set(ids);
  return [...new Set(allowedIds)].filter((id) => requested.has(id));
}

function authBlocksAgent(auth: LocalAcpHarnessAuth | undefined): boolean {
  return auth?.status === "needs-auth" || auth?.status === "unknown";
}

function authEnvVarNamesFromText(text: string | undefined): string[] {
  if (!text || !/\benvironment variable\b|\benv(?:ironment)? var\b/i.test(text))
    return [];
  return [
    ...new Set(
      [...text.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}

function isCredentialPromptAuthMethod(
  method: LocalAcpHarnessAuthMethod | undefined,
): boolean {
  if (!method) return false;
  return (
    method.type === "env_var" ||
    (method.type === "terminal" &&
      authEnvVarNamesFromText(method.description).length > 0)
  );
}

function authVariableNames(
  method: LocalAcpHarnessAuthMethod | undefined,
): string[] {
  const explicit =
    method?.vars?.map((variable) => variable.name).filter(Boolean) ?? [];
  return explicit.length > 0
    ? explicit
    : authEnvVarNamesFromText(method?.description);
}

function envVarAuthMessage(
  agent: DetectedAcpAgent,
  method: LocalAcpHarnessAuthMethod,
): string {
  const names = authVariableNames(method);
  return names.length > 0
    ? `${agent.label} credentials must be configured before ACP auth. Set ${names.join(", ")} and check again.`
    : `${agent.label} credentials must be configured before ACP auth. Set the required environment variables and check again.`;
}

function normalizeTerminalLaunch(
  value: unknown,
): InteractiveAuthLaunchOptions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const typed = value as {
    label?: unknown;
    command?: unknown;
    args?: unknown;
    env?: unknown;
    cwd?: unknown;
  };
  if (typeof typed.label !== "string" || typed.label.length === 0)
    return undefined;
  if (typeof typed.command !== "string" || typed.command.length === 0)
    return undefined;
  const args = Array.isArray(typed.args)
    ? typed.args.filter((item): item is string => typeof item === "string")
    : [];
  const env =
    typed.env && typeof typed.env === "object" && !Array.isArray(typed.env)
      ? Object.fromEntries(
          Object.entries(typed.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  return {
    label: typed.label,
    command: typed.command,
    args,
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(typeof typed.cwd === "string" || typed.cwd === null
      ? { cwd: typed.cwd }
      : {}),
  };
}

function normalizeAuthEnvVars(
  value: unknown,
): LocalAcpHarnessAuthMethod["vars"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const vars = value.flatMap(
    (item): NonNullable<LocalAcpHarnessAuthMethod["vars"]> => {
      if (!item || typeof item !== "object") return [];
      const typed = item as {
        name?: unknown;
        label?: unknown;
        secret?: unknown;
        optional?: unknown;
      };
      if (typeof typed.name !== "string" || typed.name.length === 0) return [];
      return [
        {
          name: typed.name,
          ...(typeof typed.label === "string" && typed.label.length > 0
            ? { label: typed.label }
            : {}),
          ...(typeof typed.secret === "boolean"
            ? { secret: typed.secret }
            : {}),
          ...(typeof typed.optional === "boolean"
            ? { optional: typed.optional }
            : {}),
        },
      ];
    },
  );
  return vars.length > 0 ? vars : undefined;
}

function normalizeAuthMethods(
  methods: unknown,
): LocalAcpHarnessAuthMethod[] | undefined {
  if (!Array.isArray(methods)) return undefined;
  const normalized = methods.flatMap((method): LocalAcpHarnessAuthMethod[] => {
    if (!method || typeof method !== "object") return [];
    const typed = method as {
      id?: unknown;
      name?: unknown;
      description?: unknown;
      type?: unknown;
      form?: unknown;
      vars?: unknown;
      link?: unknown;
      terminalLaunch?: unknown;
    };
    if (typeof typed.id !== "string" || typed.id.length === 0) return [];
    const terminalLaunch = normalizeTerminalLaunch(typed.terminalLaunch);
    const vars = normalizeAuthEnvVars(typed.vars);
    return [
      {
        id: typed.id,
        ...(typeof typed.name === "string" && typed.name.length > 0
          ? { name: typed.name }
          : {}),
        ...(typeof typed.description === "string" &&
        typed.description.length > 0
          ? { description: typed.description }
          : {}),
        ...(typeof typed.type === "string" && typed.type.length > 0
          ? { type: typed.type }
          : {}),
        ...(typed.form === "fields" ? { form: "fields" as const } : {}),
        ...(vars ? { vars } : {}),
        ...(typeof typed.link === "string" && typed.link.length > 0
          ? { link: typed.link }
          : {}),
        ...(terminalLaunch ? { terminalLaunch } : {}),
      },
    ];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function publicAuthForResponse(
  auth: LocalAcpHarnessAuth | undefined,
): LocalAcpHarnessAuth | undefined {
  if (!auth) return undefined;
  return {
    ...auth,
    ...(auth.methods
      ? {
          methods: auth.methods.map((method) => ({
            id: method.id,
            ...(method.name ? { name: method.name } : {}),
            ...(method.description ? { description: method.description } : {}),
            ...(method.type ? { type: method.type } : {}),
            ...(method.form ? { form: method.form } : {}),
            ...(method.vars ? { vars: method.vars } : {}),
            ...(method.link ? { link: method.link } : {}),
          })),
        }
      : {}),
  };
}

function authMethodFields(status: {
  methodId?: unknown;
  methodName?: unknown;
  methods?: unknown;
}): Pick<LocalAcpHarnessAuth, "methodId" | "methodName" | "methods"> {
  const methods = normalizeAuthMethods(status.methods);
  return {
    ...(typeof status.methodId === "string" && status.methodId.length > 0
      ? { methodId: status.methodId }
      : {}),
    ...(typeof status.methodName === "string" && status.methodName.length > 0
      ? { methodName: status.methodName }
      : {}),
    ...(methods ? { methods } : {}),
  };
}

function localAuthFromProbeStatus(
  agent: DetectedAcpAgent,
  status: ProbeAgentAuthStatus,
): LocalAcpHarnessAuth | undefined {
  if (status.status === "none") return undefined;
  const method = status.methodName ?? status.methodId;
  const methodFields = authMethodFields(status);
  if (status.status === "configured") {
    return {
      status: "configured",
      message: method
        ? `${agent.label} ACP auth is configured (${method}).`
        : `${agent.label} ACP auth is configured.`,
      command: agent.spec.command,
      ...methodFields,
    };
  }
  if (status.status === "needs-auth") {
    const prefix = method
      ? `${agent.label} requires ACP authentication (${method}).`
      : `${agent.label} requires ACP authentication.`;
    return {
      status: "needs-auth",
      message: status.message ? `${prefix} ${status.message}` : prefix,
      command: agent.spec.command,
      ...methodFields,
    };
  }
  return {
    status: "unknown",
    message: status.message
      ? `Could not verify ${agent.label} auth: ${status.message}`
      : `Could not verify ${agent.label} auth.`,
    command: agent.spec.command,
    ...methodFields,
  };
}

function toHarnessEntry(agent: DetectedAcpAgent): KnownAgentEntry {
  return {
    id: agent.id,
    label: agent.label,
    spec: agent.spec,
  };
}

function registryShimName(id: string): string {
  return `clash-acp-${id}`;
}

const REGISTRY_AGENT_SPEC_OVERRIDES: Record<
  string,
  { args?: string[]; env?: Record<string, string> }
> = {
  // Devin's registry binary is the CLI; ACP mode is a subcommand. Without this
  // the child prints interactive CLI text on stdout and breaks ACP JSON-RPC.
  devin: { args: ["acp"] },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeAgentServersConfig(
  value: unknown,
): LocalAcpAgentServersConfig {
  if (!isPlainObject(value)) return {};
  const servers: LocalAcpAgentServersConfig = {};
  for (const [name, raw] of Object.entries(value)) {
    if (
      !isPlainObject(raw) ||
      raw.type !== "custom" ||
      typeof raw.command !== "string" ||
      raw.command.trim() === ""
    ) {
      continue;
    }
    const args = Array.isArray(raw.args)
      ? raw.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const env: Record<string, string> = {};
    if (isPlainObject(raw.env)) {
      for (const [key, envValue] of Object.entries(raw.env)) {
        if (typeof envValue === "string") env[key] = envValue;
      }
    }
    servers[name] = {
      type: "custom",
      command: raw.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  return servers;
}

function sanitizeCustomAgentId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `custom-${slug || "agent"}`;
}

function customAgentEntries(
  servers: LocalAcpAgentServersConfig,
): KnownAgentEntry[] {
  const used = new Set<string>();
  return Object.entries(servers).map(([name, server]) => {
    let id = sanitizeCustomAgentId(name);
    let suffix = 2;
    while (used.has(id) || KNOWN_ACP_AGENTS.some((entry) => entry.id === id)) {
      id = `${sanitizeCustomAgentId(name)}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return {
      id,
      label: name,
      custom: true,
      systemPath: true,
      spec: {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      },
    } satisfies KnownAgentEntry;
  });
}

function mergeAgentEntries(entries: KnownAgentEntry[]): KnownAgentEntry[] {
  const merged = new Map<string, KnownAgentEntry>();
  for (const entry of entries) {
    const existing = merged.get(entry.id);
    if (!existing) {
      merged.set(entry.id, entry);
      continue;
    }
    merged.set(entry.id, {
      ...entry,
      ...existing,
      registryVersion: existing.registryVersion ?? entry.registryVersion,
      registryNpmPackage:
        existing.registryNpmPackage ?? entry.registryNpmPackage,
      registryId: existing.registryId ?? entry.registryId,
      installSource: existing.installSource ?? entry.installSource,
      homepage: existing.homepage ?? entry.homepage,
    });
  }
  return [...merged.values()];
}

function shouldEnableRegistryCatalog(options: LocalAcpAdapterOptions): boolean {
  if (!options.harnessDownloadDir) return false;
  if (options.agentCatalog === undefined) return true;
  return options.agentCatalog.some(
    (entry) => entry.installSource === "registry",
  );
}

const LOCAL_HARNESS_CONFIG_KEY = "local-harness-config";
const LOCAL_ACP_CAPABILITY_CACHE_KEY = "local-acp-confirmed-capabilities";
const LOCAL_ACP_RUN_PREFERENCES_KEY = "local-acp-run-preferences";

function harnessConfigFromLegacy(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const enabled = Array.isArray(record.enabled)
    ? record.enabled
    : Array.isArray(record.enabled_harness_ids)
      ? record.enabled_harness_ids
      : Array.isArray(record.enabledHarnessIds)
        ? record.enabledHarnessIds
        : null;
  const agents =
    record.agents &&
    typeof record.agents === "object" &&
    !Array.isArray(record.agents)
      ? record.agents
      : record.agent_servers &&
          typeof record.agent_servers === "object" &&
          !Array.isArray(record.agent_servers)
        ? record.agent_servers
        : record.agentServers &&
            typeof record.agentServers === "object" &&
            !Array.isArray(record.agentServers)
          ? record.agentServers
          : null;
  if (!enabled && !agents) return null;
  return {
    ...(enabled
      ? {
          enabled: enabled.filter((id): id is string => typeof id === "string"),
        }
      : {}),
    ...(agents ? { agents: normalizeAgentServersConfig(agents) } : {}),
  };
}

function normalizeRunPreferences(value: unknown): LocalAcpRunPreferences {
  const record = isPlainObject(value) ? value : {};
  const agentId =
    typeof record.agent_id === "string" && record.agent_id.trim()
      ? record.agent_id.trim()
      : typeof record.agent === "string" && record.agent.trim()
        ? record.agent.trim()
        : undefined;
  const rawConfig = isPlainObject(record.config_by_agent)
    ? record.config_by_agent
    : isPlainObject(record.config)
      ? record.config
      : {};
  const configByAgent: LocalAcpRunPreferences["config_by_agent"] = {};
  for (const [id, rawValues] of Object.entries(rawConfig)) {
    if (!isPlainObject(rawValues)) continue;
    configByAgent[id] = Object.fromEntries(
      Object.entries(rawValues).filter(
        (entry): entry is [string, LocalAcpRunConfigValue] =>
          typeof entry[1] === "string" || typeof entry[1] === "boolean",
      ),
    );
  }
  const rawModes = isPlainObject(record.mode_by_agent)
    ? record.mode_by_agent
    : isPlainObject(record.mode)
      ? record.mode
      : {};
  const modeByAgent = Object.fromEntries(
    Object.entries(rawModes).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return {
    ...(agentId ? { agent_id: agentId } : {}),
    config_by_agent: configByAgent,
    mode_by_agent: modeByAgent,
  };
}

export function createLocalHarnessConfigStore(
  dataDir: string,
): LocalAcpHarnessConfigStore {
  const userConfig = createClashUserConfigStore(dataDir);
  const legacyStore = createSqliteLocalConfigStore(dataDir);
  const legacySidecarPath = join(dataDir, "harnesses.json");
  let migration: Promise<void> | null = null;
  const ensureMigrated = () => {
    migration ??= (async () => {
      if (await userConfig.getSection("harnesses")) return;
      let legacy: unknown = null;
      try {
        legacy = JSON.parse(
          await readFile(legacySidecarPath, "utf8"),
        ) as unknown;
      } catch {
        legacy = await legacyStore.getJson(LOCAL_HARNESS_CONFIG_KEY);
      }
      const migrated = harnessConfigFromLegacy(legacy);
      if (!migrated) return;
      await userConfig.setSection("harnesses", migrated);
      await legacyStore.delete(LOCAL_HARNESS_CONFIG_KEY);
      await unlink(legacySidecarPath).catch(() => undefined);
    })();
    return migration;
  };
  const loadConfig = async (): Promise<Record<string, unknown>> => {
    await ensureMigrated();
    return (
      (await userConfig.getSection<Record<string, unknown>>("harnesses")) ?? {}
    );
  };
  return {
    async loadEnabledHarnessIds() {
      const parsed = await loadConfig();
      const ids = Array.isArray(parsed.enabled) ? parsed.enabled : null;
      if (!ids) return null;
      return ids.filter((id): id is string => typeof id === "string");
    },
    async saveEnabledHarnessIds(ids) {
      const parsed = await loadConfig();
      await userConfig.setSection("harnesses", { ...parsed, enabled: ids });
    },
    async loadAgentServers() {
      const parsed = await loadConfig();
      const servers = normalizeAgentServersConfig(parsed.agents);
      return Object.keys(servers).length > 0 ? servers : null;
    },
    async saveAgentServers(servers) {
      const parsed = await loadConfig();
      const next = {
        ...parsed,
        agents: normalizeAgentServersConfig(servers),
      };
      await userConfig.setSection("harnesses", next);
    },
  };
}

export function createLocalAcpRunPreferencesStore(
  dataDir: string,
): LocalAcpRunPreferencesStore {
  const store = createSqliteLocalConfigStore(dataDir);
  return {
    async load() {
      return normalizeRunPreferences(
        await store.getJson(LOCAL_ACP_RUN_PREFERENCES_KEY),
      );
    },
    async save(preferences) {
      await store.setJson(
        LOCAL_ACP_RUN_PREFERENCES_KEY,
        normalizeRunPreferences(preferences),
      );
    },
  };
}

export function createLocalAcpCapabilityCacheStore(
  dataDir: string,
): LocalAcpCapabilityCacheStore {
  const store = createSqliteLocalConfigStore(dataDir);
  return {
    async load() {
      const value = await store.getJson<Record<string, unknown>>(
        LOCAL_ACP_CAPABILITY_CACHE_KEY,
      );
      if (!isPlainObject(value)) return {};
      return Object.fromEntries(
        Object.entries(value).flatMap(([agentId, candidate]) => {
          if (!isPlainObject(candidate)) return [];
          const capabilities: LocalAcpConfirmedCapabilities = {
            ...(Array.isArray(candidate.configOptions)
              ? { configOptions: candidate.configOptions }
              : {}),
            ...(Array.isArray(candidate.availableCommands)
              ? { availableCommands: candidate.availableCommands }
              : {}),
            ...(candidate.sessionModes !== undefined
              ? { sessionModes: candidate.sessionModes }
              : {}),
          };
          return [[agentId, capabilities]];
        }),
      );
    },
    async save(value) {
      await store.setJson(LOCAL_ACP_CAPABILITY_CACHE_KEY, value);
    },
  };
}

function createDefaultSessionManager(
  send: SessionSender,
  requestPermission?: SessionPermissionBroker,
  requestElicitation?: SessionElicitationBroker,
): SessionManagerLike {
  return new SessionManager(send, { requestPermission, requestElicitation });
}

function isElicitationFieldValue(
  schema: ElicitationPropertySchema,
  value: unknown,
): value is ElicitationContentValue {
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (schema.type === "integer" && !Number.isInteger(value)) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return false;
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return false;
    return true;
  }
  if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string")
    )
      return false;
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      return false;
    const allowed =
      "enum" in schema.items
        ? schema.items.enum
        : schema.items.anyOf.map((option) => option.const);
    return value.every((item) => allowed.includes(item));
  }
  if (typeof value !== "string") return false;
  if (typeof schema.minLength === "number" && value.length < schema.minLength)
    return false;
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
    return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && !schema.oneOf.some((option) => option.const === value))
    return false;
  if (schema.pattern) {
    try {
      if (!new RegExp(schema.pattern).test(value)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function validatedElicitationResponse(
  request: CreateElicitationRequest & { mode: "form" },
  action: string | undefined,
  rawContent: unknown,
): CreateElicitationResponse {
  if (action === "cancel") return { action: "cancel" };
  if (action !== "accept") return { action: "decline" };
  if (
    !rawContent ||
    typeof rawContent !== "object" ||
    Array.isArray(rawContent)
  ) {
    return { action: "decline" };
  }
  const content = rawContent as Record<string, unknown>;
  const properties = request.requestedSchema.properties ?? {};
  const required = new Set(request.requestedSchema.required ?? []);
  for (const name of required) {
    if (!(name in content)) return { action: "decline" };
  }
  const normalized: Record<string, ElicitationContentValue> = {};
  for (const [name, value] of Object.entries(content)) {
    const schema = properties[name];
    if (!schema || !isElicitationFieldValue(schema, value))
      return { action: "decline" };
    normalized[name] = value;
  }
  return { action: "accept", content: normalized };
}

function safeElicitationUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function chooseDefaultAgent(
  agents: DetectedAcpAgent[],
  recentAgentId?: string,
): DetectedAcpAgent | undefined {
  if (recentAgentId) {
    const recent = agents.find((agent) => agent.id === recentAgentId);
    if (recent) return recent;
  }
  return agents[0];
}

function defaultEnabledHarnessSet(agents: DetectedAcpAgent[]): Set<string> {
  return new Set(agents.map((agent) => agent.id));
}

function sendJson(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function isSessionEventMessage(msg: unknown): msg is {
  type: "session.event";
  turn_id: string;
  event: unknown;
} {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "session.event" &&
    typeof (msg as { turn_id?: unknown }).turn_id === "string"
  );
}

function isSessionReadyMessage(msg: unknown): msg is {
  type: "session.ready";
  session_id: string;
  acp_session_id?: string;
  supports_session_fork?: boolean;
  config_options?: unknown[];
  modes?: unknown;
  replay_events?: unknown[];
} {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "session.ready" &&
    typeof (msg as { session_id?: unknown }).session_id === "string" &&
    ((msg as { replay_events?: unknown }).replay_events === undefined ||
      Array.isArray((msg as { replay_events?: unknown }).replay_events)) &&
    ((msg as { config_options?: unknown }).config_options === undefined ||
      Array.isArray((msg as { config_options?: unknown }).config_options))
  );
}

function isSessionConfigOptionsMessage(msg: unknown): msg is {
  type: "session.config_options";
  session_id: string;
  config_options: unknown[];
} {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "session.config_options" &&
    typeof (msg as { session_id?: unknown }).session_id === "string" &&
    Array.isArray((msg as { config_options?: unknown }).config_options)
  );
}

function isSessionModeMessage(msg: unknown): msg is {
  type: "session.mode";
  session_id: string;
  modes: unknown;
} {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "session.mode" &&
    typeof (msg as { session_id?: unknown }).session_id === "string" &&
    (msg as { modes?: unknown }).modes !== undefined
  );
}

function isSessionErrorMessage(msg: unknown): msg is {
  type: "session.error";
  session_id: string;
  turn_id?: string;
  message: string;
} {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "session.error" &&
    typeof (msg as { session_id?: unknown }).session_id === "string" &&
    typeof (msg as { message?: unknown }).message === "string"
  );
}

const ACP_AUTH_FAILURE_PATTERN =
  /authentication (?:is )?required\b|authentication (?:failed|fails)\b|invalid api key\b|api key[^\n]*\binvalid\b/i;

function redactAuthenticationError(message: string): string {
  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[redacted]")
    .replace(/\b(api[\s_-]*key|token|secret)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 4_000);
}

function normalizeSessionAuthenticationError(
  msg: unknown,
  agentId: string,
): unknown {
  if (!isSessionErrorMessage(msg)) return msg;
  const raw = msg as Record<string, unknown>;
  const message = redactAuthenticationError(msg.message);
  const authRequired =
    raw.code === "auth_required" || ACP_AUTH_FAILURE_PATTERN.test(msg.message);
  return {
    ...raw,
    message,
    ...(authRequired ? { code: "auth_required", agent_id: agentId } : {}),
  };
}

function isSessionCompleteMessage(msg: unknown): msg is {
  type: "session.complete";
  session_id: string;
  turn_id?: string;
} {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "session.complete" &&
    typeof (msg as { session_id?: unknown }).session_id === "string"
  );
}

function isSessionCancelledMessage(msg: unknown): msg is {
  type: "session.cancelled";
  session_id: string;
  turn_id: string;
} {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "session.cancelled" &&
    typeof (msg as { session_id?: unknown }).session_id === "string" &&
    typeof (msg as { turn_id?: unknown }).turn_id === "string"
  );
}

function agentTextFromSessionEvent(event: unknown): {
  text: string;
  phase?: "commentary" | "final_answer";
} | null {
  if (!event || typeof event !== "object") return null;
  const raw = event as {
    type?: unknown;
    text?: unknown;
    sessionUpdate?: unknown;
    content?: unknown;
    update?: unknown;
    _meta?: { codex?: { phase?: unknown } };
  };
  if (raw.type === "text" && typeof raw.text === "string") return { text: raw.text };
  const inner =
    raw.update && typeof raw.update === "object"
      ? (raw.update as typeof raw)
      : raw;
  const update =
    typeof inner.sessionUpdate === "string"
      ? inner.sessionUpdate
      : typeof raw.sessionUpdate === "string"
        ? raw.sessionUpdate
        : "";
  if (update !== "agent_message_chunk") return null;
  const text = extractAcpContentText(inner.content);
  if (text === null) return null;
  const phase = inner._meta?.codex?.phase;
  return { text, ...(phase === "commentary" || phase === "final_answer" ? { phase } : {}) };
}

const NON_TRANSCRIPT_SESSION_UPDATES = new Set([
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
]);

function getSessionUpdateType(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const outer = event as {
    update?: unknown;
    sessionUpdate?: unknown;
    type?: unknown;
  };
  const inner =
    outer.update && typeof outer.update === "object"
      ? (outer.update as { sessionUpdate?: unknown; type?: unknown })
      : outer;
  if (typeof inner.sessionUpdate === "string") return inner.sessionUpdate;
  if (typeof outer.sessionUpdate === "string") return outer.sessionUpdate;
  if (typeof inner.type === "string") return inner.type;
  if (typeof outer.type === "string") return outer.type;
  return null;
}

function shouldPersistSessionEvent(event: unknown): boolean {
  const update = getSessionUpdateType(event);
  return !update || !NON_TRANSCRIPT_SESSION_UPDATES.has(update);
}

function publicSessionMessage(msg: unknown): unknown {
  if (!isSessionReadyMessage(msg) || !("replay_events" in msg)) return msg;
  const { replay_events: _replayEvents, ...publicMsg } = msg;
  return publicMsg;
}

function replaySetupEvents(msg: unknown): unknown[] {
  if (!isSessionReadyMessage(msg) || !Array.isArray(msg.replay_events))
    return [];
  return msg.replay_events.filter((event) => {
    const update = getSessionUpdateType(event);
    return update !== null && NON_TRANSCRIPT_SESSION_UPDATES.has(update);
  });
}

function isPromptQueueMode(value: unknown): value is PromptQueueMode {
  return value === "single" || value === "flush";
}

function parseBrowserMessage(raw: WebSocket.RawData): BrowserMessage | null {
  try {
    const text = Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : Array.isArray(raw)
        ? Buffer.concat(raw).toString("utf8")
        : typeof raw === "string"
          ? raw
          : Buffer.from(raw as ArrayBuffer).toString("utf8");
    return JSON.parse(text) as BrowserMessage;
  } catch {
    return null;
  }
}

function truthyEnvFlag(value: string | undefined): boolean {
  return value === "true";
}

function readJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nestedString(
  value: Record<string, unknown> | null,
  path: string[],
): string | null {
  let cursor: unknown = value;
  for (const part of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor))
      return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

async function geminiAuthPreflight(
  env: Record<string, string | undefined>,
): Promise<NonNullable<LocalAcpHarness["auth"]>> {
  if (env.GEMINI_API_KEY) {
    return {
      status: "configured",
      message: "Gemini API key configured through GEMINI_API_KEY.",
    };
  }
  // Both spellings, because Google renamed the platform and kept the old flag working. The SDK
  // accepts either and throws only when they disagree; reading just one would leave whoever
  // followed the current docs staring at "not configured" with the variable exported.
  if (
    truthyEnvFlag(env.GOOGLE_GENAI_USE_ENTERPRISE) ||
    truthyEnvFlag(env.GOOGLE_GENAI_USE_VERTEXAI)
  ) {
    const flag = truthyEnvFlag(env.GOOGLE_GENAI_USE_ENTERPRISE)
      ? "GOOGLE_GENAI_USE_ENTERPRISE"
      : "GOOGLE_GENAI_USE_VERTEXAI";
    return {
      status: "configured",
      message: `Gemini Enterprise Agent Platform auth selected through ${flag}.`,
    };
  }
  if (truthyEnvFlag(env.GOOGLE_GENAI_USE_GCA)) {
    return {
      status: "configured",
      message: "Google Code Assist auth selected through GOOGLE_GENAI_USE_GCA.",
    };
  }

  const home = env.HOME || process.env.HOME;
  if (!home) {
    return {
      status: "unknown",
      message: "Cannot inspect Gemini auth because HOME is not set.",
    };
  }

  const settings = readJsonObject(
    await readFile(join(home, ".gemini", "settings.json"), "utf8").catch(
      () => "",
    ),
  );
  const selectedType = nestedString(settings, [
    "security",
    "auth",
    "selectedType",
  ]);
  if (selectedType) {
    return {
      status: "configured",
      message: `Gemini auth method selected: ${selectedType}.`,
    };
  }

  const accounts = readJsonObject(
    await readFile(join(home, ".gemini", "google_accounts.json"), "utf8").catch(
      () => "",
    ),
  );
  const activeAccount = nestedString(accounts, ["active"]);
  const hadOldAccounts =
    Array.isArray(accounts?.old) && accounts.old.length > 0;
  return {
    status: "needs-auth",
    message: activeAccount
      ? "Gemini has an account file but no selected auth method for non-interactive ACP."
      : hadOldAccounts
        ? "Gemini has old accounts but no active auth method for ACP."
        : "Gemini has no auth method selected for ACP.",
    command: "gemini",
  };
}

function agentAuthRequiredMessage(
  agent: DetectedAcpAgent,
  auth: NonNullable<LocalAcpHarness["auth"]>,
): string {
  return [
    `${agent.label} needs authentication before ACP can start.`,
    auth.message,
    "Use the Authenticate button, then check again.",
  ].join(" ");
}

function mergedStringEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return JSON.stringify(value);
}

function terminalAuthShellCommand(
  options: InteractiveAuthLaunchOptions,
): string {
  const parts: string[] = [];
  if (options.cwd) {
    parts.push("cd", shellQuote(options.cwd), "&&");
  }
  const envEntries = Object.entries(options.env ?? {}).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[0].length > 0,
  );
  if (envEntries.length > 0) {
    parts.push("env");
    for (const [key, value] of envEntries) {
      parts.push(`${key}=${shellQuote(value)}`);
    }
  }
  parts.push(shellQuote(options.command), ...options.args.map(shellQuote));
  parts.push(";");
  parts.push(
    "printf",
    shellQuote(
      "\\nReturn to Clash and click Check again after authentication completes.\\n",
    ),
  );
  return parts.join(" ");
}

function spawnDetachedCommand(
  command: string,
  args: string[],
  options: { env?: Record<string, string | undefined> } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...mergedStringEnv(options.env ?? {}),
      },
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function launchInteractiveAuthCommand(
  options: InteractiveAuthLaunchOptions,
): Promise<void> {
  const shellCommand = terminalAuthShellCommand(options);
  if (process.platform === "darwin") {
    await spawnDetachedCommand(
      "osascript",
      [
        "-e",
        `tell application "Terminal"`,
        "-e",
        "activate",
        "-e",
        `do script ${appleScriptString(shellCommand)}`,
        "-e",
        "end tell",
      ],
      {
        env: process.env,
      },
    );
    return;
  }

  const terminal =
    process.platform === "win32"
      ? null
      : process.env.TERMINAL || "x-terminal-emulator";
  if (!terminal) {
    throw new Error(
      `Interactive auth launch is not supported on ${process.platform}. Run ${[options.command, ...options.args].join(" ")} manually.`,
    );
  }
  const child = spawn(terminal, ["-e", "sh", "-lc", shellCommand], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export class LocalAcpRuntimeAdapter implements LocalAcpAdapter {
  private readonly detectAgents: () => Promise<DetectedAcpAgent[]>;
  private readonly probeAgentAuth: (
    agent: DetectedAcpAgent,
  ) => Promise<LocalAcpHarnessAuth | undefined>;
  private readonly probeAgentSessionConfig: (
    agent: DetectedAcpAgent,
  ) => Promise<{
    configOptions?: unknown[];
    availableCommands?: unknown[];
    modes?: unknown;
    auth?: ProbeAgentAuthStatus;
  }>;
  private readonly authenticateAgent: (
    agent: DetectedAcpAgent,
    options?: LocalAcpAuthenticateOptions,
  ) => Promise<AuthenticateAgentResult | void>;
  private readonly launchInteractiveAuth: (
    options: InteractiveAuthLaunchOptions,
  ) => Promise<void>;
  private readonly probeCwd: string | null;
  private readonly probeTimeoutMs: number;
  private readonly listLocalSessions: () => Promise<LocalAcpResumeSession[]>;
  private readonly listAgentSessions: (
    agent: DetectedAcpAgent,
  ) => Promise<LocalAcpResumeSession[]>;
  private readonly createSessionId: () => string;
  private readonly createSessionManager: (
    send: SessionSender,
    requestPermission?: SessionPermissionBroker,
    requestElicitation?: SessionElicitationBroker,
  ) => SessionManagerLike;
  private readonly harnessConfig: LocalAcpHarnessConfigStore | null;
  private readonly runPreferences: LocalAcpRunPreferencesStore | null;
  private readonly capabilityCache: LocalAcpCapabilityCacheStore | null;
  private readonly agentCatalog: KnownAgentEntry[];
  private readonly registryCatalogEnabled: boolean;
  private readonly spawnEnv: Record<string, string | undefined>;
  private readonly harnessDownloadDir: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly hostname: () => string;
  private readonly osTag: () => string;
  private readonly nowSeconds: () => number;
  private readonly nowMilliseconds: () => number;
  private sessionEventStore: LocalAcpSessionEventStore | null = null;
  private readonly sessions = new Map<string, LocalAcpSession>();
  private detectedAgentsCache: DetectedAcpAgent[] | null = null;
  private detectedAgentsCacheProbesAuth = false;
  private detectedAgentsCacheProbesConfigOptions = false;
  private detectedAgentsCacheProbeScope: DetectedAgentProbeScope | null = null;
  private detectedAgentsPromise: Promise<DetectedAcpAgent[]> | null = null;
  private detectedAgentsPromiseProbesAuth = false;
  private detectedAgentsPromiseProbesConfigOptions = false;
  private detectedAgentsPromiseProbeScope: DetectedAgentProbeScope | null =
    null;
  private registryAgentCatalogCache: KnownAgentEntry[] | null = null;
  private registryAgentCatalogPromise: Promise<KnownAgentEntry[]> | null = null;
  private readonly npmPackageVersionCache = new Map<string, string | null>();
  private readonly confirmedCapabilities = new Map<
    string,
    LocalAcpConfirmedCapabilities
  >();
  private readonly confirmedAuth = new Map<string, LocalAcpHarnessAuth>();
  private capabilityCacheLoad: Promise<void> | null = null;
  private capabilityCacheWrite: Promise<void> = Promise.resolve();
  private runPreferencesQueue: Promise<void> = Promise.resolve();
  private reconcileQueue: Promise<void> = Promise.resolve();
  private lastReconciledEnabledIds: Set<string> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(options: LocalAcpAdapterOptions = {}) {
    this.spawnEnv = options.spawnEnv ?? {};
    this.probeCwd = options.probeCwd ?? null;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 15_000;
    this.launchInteractiveAuth =
      options.launchInteractiveAuth ?? launchInteractiveAuthCommand;
    this.detectAgents =
      options.detectAgents ??
      (() => defaultDetectAgents({ ...process.env, ...this.spawnEnv }));
    this.probeAgentAuth =
      options.probeAgentAuth ??
      (async (agent) => {
        const env = {
          ...process.env,
          ...this.spawnEnv,
          ...(agent.spec.env ?? {}),
        };
        if (agent.id === "gemini") {
          return geminiAuthPreflight(env);
        }
        const status = await probeRuntimeAgentAuthStatus({
          agent: {
            ...agent.spec,
            env: {
              ...(agent.spec.env ?? {}),
              ...Object.fromEntries(
                Object.entries(this.spawnEnv).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === "string",
                ),
              ),
            },
          },
          ...(this.probeCwd ? { cwd: this.probeCwd } : {}),
          env: this.spawnEnv,
          timeoutMs: this.probeTimeoutMs,
        });
        return localAuthFromProbeStatus(agent, status);
      });
    this.probeAgentSessionConfig =
      options.probeAgentSessionConfig ??
      (options.probeAgentConfigOptions
        ? async (agent) => ({
            configOptions: await options.probeAgentConfigOptions!(agent),
          })
        : (agent) =>
            probeRuntimeAgentSessionConfig({
              agent: {
                ...agent.spec,
                env: {
                  ...(agent.spec.env ?? {}),
                  ...Object.fromEntries(
                    Object.entries(this.spawnEnv).filter(
                      (entry): entry is [string, string] =>
                        typeof entry[1] === "string",
                    ),
                  ),
                },
              },
              ...(this.probeCwd ? { cwd: this.probeCwd } : {}),
              env: this.spawnEnv,
              timeoutMs: this.probeTimeoutMs,
            }));
    this.authenticateAgent =
      options.authenticateAgent ??
      (async (agent, options) => {
        const methodId = options?.methodId ?? agent.auth?.methodId;
        const cachedMethod = methodId
          ? agent.auth?.methods?.find((method) => method.id === methodId)
          : agent.auth?.methods?.[0];
        if (cachedMethod && isCredentialPromptAuthMethod(cachedMethod)) {
          throw new Error(envVarAuthMessage(agent, cachedMethod));
        }
        if (cachedMethod?.terminalLaunch) {
          await this.launchInteractiveAuth(cachedMethod.terminalLaunch);
          return { status: "started" as const };
        }
        return await authenticateRuntimeAgent({
          agent: {
            ...agent.spec,
            env: {
              ...(agent.spec.env ?? {}),
              ...Object.fromEntries(
                Object.entries(this.spawnEnv).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === "string",
                ),
              ),
            },
          },
          ...(this.probeCwd ? { cwd: this.probeCwd } : {}),
          env: this.spawnEnv,
          timeoutMs: 120_000,
          agentAuthLaunchGraceMs: 2_000,
          backgroundAuthTimeoutMs: 10 * 60_000,
          methodId: options?.methodId,
          values: options?.values,
          launchInteractiveAuth: (options) =>
            this.launchInteractiveAuth({
              label: options.label,
              command: options.command,
              args: options.args,
              env: options.env,
              cwd: options.cwd ?? this.probeCwd,
            }),
        });
      });
    this.listLocalSessions =
      options.listResumeSessions ?? (() => listLocalCcSessions(20));
    this.listAgentSessions =
      options.listAgentSessions ??
      ((agent) =>
        listLocalAgentSessions({
          ...agent.spec,
          env: {
            ...(agent.spec.env ?? {}),
            ...Object.fromEntries(
              Object.entries(this.spawnEnv).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string",
              ),
            ),
          },
        }));
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.createSessionManager =
      options.createSessionManager ?? createDefaultSessionManager;
    this.harnessConfig = options.harnessConfig ?? null;
    this.runPreferences = options.runPreferences ?? null;
    this.capabilityCache = options.capabilityCache ?? null;
    this.agentCatalog = options.agentCatalog ?? KNOWN_ACP_AGENTS;
    this.registryCatalogEnabled = shouldEnableRegistryCatalog(options);
    this.hostname = options.hostname ?? machineName;
    this.osTag = options.osTag ?? defaultOsTag;
    this.nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
    this.harnessDownloadDir = options.harnessDownloadDir ?? null;
    this.fetchImpl = options.fetch ?? fetch;
  }

  updateSpawnEnv(env: Record<string, string | undefined>): void {
    Object.assign(this.spawnEnv, env);
  }

  setSessionEventStore(store: LocalAcpSessionEventStore): void {
    this.sessionEventStore = store;
  }

  async warmup(): Promise<void> {
    await this.ensureCapabilityCacheLoaded();
    const agents = await this.refreshDetectedAgents({
      probeAuth: true,
      probeConfigOptions: true,
      probeScope: "enabled",
    });
    this.lastReconciledEnabledIds =
      (await this.enabledHarnessSet()) ?? defaultEnabledHarnessSet(agents);
  }

  async reconcileConfiguration(): Promise<void> {
    const reconcile = this.reconcileQueue.then(() =>
      this.reconcileConfigurationNow(),
    );
    this.reconcileQueue = reconcile.catch(() => undefined);
    await reconcile;
  }

  private async reconcileConfigurationNow(): Promise<void> {
    if (this.detectedAgentsPromise) {
      await this.detectedAgentsPromise.catch(() => undefined);
    }
    const previousAgents = this.detectedAgentsCache ?? [];
    const previousById = new Map(
      previousAgents.map((agent) => [agent.id, agent]),
    );
    const previousEnabled = this.lastReconciledEnabledIds;
    this.registryAgentCatalogCache = null;
    const agents = await this.detectAgentsWithProbes({
      probeAuth: false,
      probeConfigOptions: false,
      probeScope: "enabled",
    });
    const enabled =
      (await this.enabledHarnessSet()) ?? defaultEnabledHarnessSet(agents);
    const shouldProbe = (agent: DetectedAcpAgent) => {
      if (enabled && !enabled.has(agent.id)) return false;
      const previous = previousById.get(agent.id);
      return (
        !previous ||
        !previousEnabled ||
        !previousEnabled.has(agent.id) ||
        JSON.stringify(previous.spec) !== JSON.stringify(agent.spec)
      );
    };
    const probedById = new Map(
      (
        await Promise.all(
          agents.filter(shouldProbe).map((agent) =>
            this.probeAgentMetadata(agent, {
              auth: true,
              configOptions: true,
            }),
          ),
        )
      ).map((agent) => [agent.id, agent]),
    );
    this.detectedAgentsCache = agents.map((agent) => {
      const probed = probedById.get(agent.id);
      if (probed) return probed;
      const previous = previousById.get(agent.id);
      return previous &&
        JSON.stringify(previous.spec) === JSON.stringify(agent.spec)
        ? previous
        : agent;
    });
    this.detectedAgentsCacheProbesAuth = true;
    this.detectedAgentsCacheProbesConfigOptions = true;
    this.detectedAgentsCacheProbeScope = "enabled";
    this.lastReconciledEnabledIds = enabled;
  }

  private async refreshDetectedAgents(
    opts: DetectedAgentListOptions = {},
  ): Promise<DetectedAcpAgent[]> {
    this.detectedAgentsCache = null;
    this.detectedAgentsCacheProbesAuth = false;
    this.detectedAgentsCacheProbesConfigOptions = false;
    this.detectedAgentsCacheProbeScope = null;
    this.registryAgentCatalogCache = null;
    return this.getDetectedAgents(opts);
  }

  private async getDetectedAgents(
    opts: DetectedAgentListOptions = {},
  ): Promise<DetectedAcpAgent[]> {
    const probeConfigOptions = opts.probeConfigOptions === true;
    const probeAuth = opts.probeAuth === true || probeConfigOptions;
    const probeScope = opts.probeScope ?? "enabled";
    if (opts.refresh) {
      this.detectedAgentsCache = null;
      this.detectedAgentsCacheProbesAuth = false;
      this.detectedAgentsCacheProbesConfigOptions = false;
      this.detectedAgentsCacheProbeScope = null;
      this.registryAgentCatalogCache = null;
    }
    const scopeSatisfiesRequest = (scope: DetectedAgentProbeScope | null) =>
      !probeAuth || probeScope === "enabled" || scope === "installed";
    const cacheSatisfiesRequest =
      (!probeAuth || this.detectedAgentsCacheProbesAuth) &&
      (!probeConfigOptions || this.detectedAgentsCacheProbesConfigOptions) &&
      scopeSatisfiesRequest(this.detectedAgentsCacheProbeScope);
    if (this.detectedAgentsCache && cacheSatisfiesRequest) {
      return this.detectedAgentsCache;
    }
    if (this.detectedAgentsPromise) {
      const requestIsLightweight = !probeAuth && !probeConfigOptions;
      const pendingIsMetadataProbe =
        this.detectedAgentsPromiseProbesAuth ||
        this.detectedAgentsPromiseProbesConfigOptions;
      if (requestIsLightweight && pendingIsMetadataProbe) {
        const agents = await this.detectAgentsWithProbes({
          probeAuth: false,
          probeConfigOptions: false,
          probeScope,
        });
        this.detectedAgentsCache = agents;
        this.detectedAgentsCacheProbesAuth = false;
        this.detectedAgentsCacheProbesConfigOptions = false;
        this.detectedAgentsCacheProbeScope = null;
        return agents;
      }
      const promiseSatisfiesRequest =
        (!probeAuth || this.detectedAgentsPromiseProbesAuth) &&
        (!probeConfigOptions ||
          this.detectedAgentsPromiseProbesConfigOptions) &&
        scopeSatisfiesRequest(this.detectedAgentsPromiseProbeScope);
      if (promiseSatisfiesRequest) return this.detectedAgentsPromise;
      await this.detectedAgentsPromise.catch(() => undefined);
      this.detectedAgentsCache = null;
      this.detectedAgentsCacheProbesAuth = false;
      this.detectedAgentsCacheProbesConfigOptions = false;
      this.detectedAgentsCacheProbeScope = null;
    }
    this.detectedAgentsPromiseProbesAuth = probeAuth;
    this.detectedAgentsPromiseProbesConfigOptions = probeConfigOptions;
    this.detectedAgentsPromiseProbeScope = probeAuth ? probeScope : null;
    this.detectedAgentsPromise = this.detectAgentsWithProbes({
      probeAuth,
      probeConfigOptions,
      probeScope,
    })
      .then((agents) => {
        this.detectedAgentsCache = agents;
        this.detectedAgentsCacheProbesAuth = probeAuth;
        this.detectedAgentsCacheProbesConfigOptions = probeConfigOptions;
        this.detectedAgentsCacheProbeScope = probeAuth ? probeScope : null;
        return agents;
      })
      .finally(() => {
        this.detectedAgentsPromise = null;
        this.detectedAgentsPromiseProbesAuth = false;
        this.detectedAgentsPromiseProbesConfigOptions = false;
        this.detectedAgentsPromiseProbeScope = null;
      });
    return this.detectedAgentsPromise;
  }

  private async probeAgentMetadata(
    agent: DetectedAcpAgent,
    opts: { auth?: boolean; configOptions?: boolean },
  ): Promise<DetectedAcpAgent> {
    let auth = agent.auth ?? this.confirmedAuth.get(agent.id);
    const withAuth = () => {
      const { auth: _staleAuth, ...withoutAuth } = agent;
      return auth ? { ...withoutAuth, auth } : withoutAuth;
    };
    if (!opts.configOptions) {
      if (!opts.auth) return withAuth();
      try {
        auth = await this.probeAgentAuth(agent);
        if (auth) this.confirmedAuth.set(agent.id, auth);
        else this.confirmedAuth.delete(agent.id);
      } catch {
        // Keep the last confirmed auth state across a transient probe failure.
      }
      return withAuth();
    }
    await this.ensureCapabilityCacheLoaded();
    const inspectedAt = new Date(this.nowSeconds() * 1_000).toISOString();
    const confirmed = this.confirmedCapabilities.get(agent.id);
    try {
      const sessionConfig = await this.probeAgentSessionConfig(withAuth());
      if (sessionConfig.auth) {
        auth = localAuthFromProbeStatus(agent, sessionConfig.auth);
        if (auth) this.confirmedAuth.set(agent.id, auth);
        else this.confirmedAuth.delete(agent.id);
      } else if (opts.auth) {
        // Compatibility for injected/legacy probes. The production probe
        // always returns auth from this same ACP child.
        auth = await this.probeAgentAuth(agent).catch(() => auth);
        if (auth) this.confirmedAuth.set(agent.id, auth);
      }
      if (authBlocksAgent(auth)) {
        return {
          ...withAuth(),
          ...confirmed,
          capabilityInspection: {
            status: "blocked-auth",
            inspected_at: inspectedAt,
          },
        };
      }
      const capabilities = {
        configOptions: sessionConfig.configOptions ?? [],
        availableCommands: sessionConfig.availableCommands ?? [],
        ...(sessionConfig.modes ? { sessionModes: sessionConfig.modes } : {}),
      };
      this.confirmedCapabilities.set(agent.id, capabilities);
      await this.persistConfirmedCapabilities();
      return {
        ...withAuth(),
        ...capabilities,
        capabilityInspection: {
          status: "ready",
          inspected_at: inspectedAt,
        },
      };
    } catch (error) {
      return {
        ...withAuth(),
        ...confirmed,
        capabilityInspection: {
          status: "degraded",
          inspected_at: inspectedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async ensureCapabilityCacheLoaded(): Promise<void> {
    if (!this.capabilityCache) return;
    this.capabilityCacheLoad ??= this.capabilityCache.load().then((value) => {
      for (const [agentId, capabilities] of Object.entries(value)) {
        if (!this.confirmedCapabilities.has(agentId)) {
          this.confirmedCapabilities.set(agentId, capabilities);
        }
      }
    });
    await this.capabilityCacheLoad;
  }

  private async persistConfirmedCapabilities(): Promise<void> {
    if (!this.capabilityCache) return;
    this.capabilityCacheWrite = this.capabilityCacheWrite.then(async () => {
      await this.capabilityCache?.save(
        Object.fromEntries(this.confirmedCapabilities.entries()),
      );
    });
    await this.capabilityCacheWrite;
  }

  private async configuredCustomAgentEntries(): Promise<KnownAgentEntry[]> {
    const servers = (await this.harnessConfig?.loadAgentServers?.()) ?? null;
    return servers ? customAgentEntries(servers) : [];
  }

  private async registryAgentEntries(): Promise<KnownAgentEntry[]> {
    if (!this.registryCatalogEnabled) return [];
    if (this.registryAgentCatalogCache) return this.registryAgentCatalogCache;
    if (!this.registryAgentCatalogPromise) {
      this.registryAgentCatalogPromise = listAcpRegistryCatalog({
        fetchImpl: this.fetchImpl,
      })
        .then((agents) =>
          agents.map((agent) => {
            const override = REGISTRY_AGENT_SPEC_OVERRIDES[agent.id];
            const args = override?.args ?? agent.args;
            const env = {
              ...(agent.env ?? {}),
              ...(override?.env ?? {}),
            };
            return {
              id: agent.id,
              label: agent.name,
              spec: {
                command: registryShimName(agent.id),
                ...(args && args.length > 0 ? { args } : {}),
                ...(Object.keys(env).length > 0 ? { env } : {}),
              },
              registryId: agent.id,
              ...(agent.version ? { registryVersion: agent.version } : {}),
              ...(agent.npmPackage
                ? { registryNpmPackage: agent.npmPackage }
                : {}),
              installSource: "registry" as const,
              ...(agent.homepage ? { homepage: agent.homepage } : {}),
            } satisfies KnownAgentEntry;
          }),
        )
        .catch(() => [])
        .finally(() => {
          this.registryAgentCatalogPromise = null;
        });
    }
    const entries = await this.registryAgentCatalogPromise;
    this.registryAgentCatalogCache = entries;
    return entries;
  }

  private async fullAgentCatalog(): Promise<KnownAgentEntry[]> {
    return mergeAgentEntries([
      ...this.agentCatalog,
      ...(await this.registryAgentEntries()),
      ...(await this.configuredCustomAgentEntries()),
    ]);
  }

  private async detectConfiguredAgents(): Promise<DetectedAcpAgent[]> {
    const agents = await this.detectAgents();
    const fullCatalog = await this.fullAgentCatalog();
    const env = { ...process.env, ...this.spawnEnv } as NodeJS.ProcessEnv;
    const knownIds = new Set(agents.map((agent) => agent.id));
    const baseCatalogIds = new Set(this.agentCatalog.map((entry) => entry.id));
    const entriesToProbe = fullCatalog.filter(
      (entry) =>
        !knownIds.has(entry.id) &&
        (entry.custom || !baseCatalogIds.has(entry.id)),
    );
    if (entriesToProbe.length === 0) return agents;
    const extraDetected = await Promise.all(
      entriesToProbe.map((entry) =>
        detectEntry(entry, {
          env,
          ...(this.probeCwd ? { cwd: this.probeCwd } : {}),
        }),
      ),
    );
    const merged = new Map(agents.map((agent) => [agent.id, agent]));
    for (const entry of extraDetected) {
      if (!entry) continue;
      merged.set(entry.id, entry as DetectedAcpAgent);
    }
    return [...merged.values()];
  }

  private async detectAgentsWithProbes(opts: {
    probeAuth: boolean;
    probeConfigOptions: boolean;
    probeScope: DetectedAgentProbeScope;
  }): Promise<DetectedAcpAgent[]> {
    const agents = await this.detectConfiguredAgents();
    if (!opts.probeAuth && !opts.probeConfigOptions) return agents;
    const enabled =
      (await this.enabledHarnessSet()) ?? defaultEnabledHarnessSet(agents);
    const shouldProbe = (agent: DetectedAcpAgent) =>
      opts.probeScope === "installed" || !enabled || enabled.has(agent.id);
    const probed = await Promise.all(
      agents.map(async (agent) => {
        if (!shouldProbe(agent)) return agent;
        return this.probeAgentMetadata(agent, {
          auth: opts.probeAuth,
          configOptions: opts.probeConfigOptions,
        });
      }),
    );
    return probed;
  }

  private updateCachedAgentConfigOptions(
    agentId: string,
    configOptions: unknown[],
  ): void {
    if (!this.detectedAgentsCache) return;
    this.detectedAgentsCache = this.detectedAgentsCache.map((agent) =>
      agent.id === agentId ? { ...agent, configOptions } : agent,
    );
  }

  private updateCachedAgentSessionModes(
    agentId: string,
    sessionModes: unknown,
  ): void {
    if (!this.detectedAgentsCache) return;
    this.detectedAgentsCache = this.detectedAgentsCache.map((agent) =>
      agent.id === agentId ? { ...agent, sessionModes } : agent,
    );
  }

  private async enabledHarnessSet(): Promise<Set<string> | null> {
    const configured = await this.harnessConfig?.loadEnabledHarnessIds();
    return configured ? new Set(configured) : null;
  }

  private async detectEnabledAgents(
    opts: DetectedAgentListOptions = {},
  ): Promise<DetectedAcpAgent[]> {
    const agents = await this.getDetectedAgents(opts);
    const enabled =
      (await this.enabledHarnessSet()) ?? defaultEnabledHarnessSet(agents);
    const enabledAgents = enabled
      ? agents.filter((agent) => enabled.has(agent.id))
      : agents;
    return enabledAgents.filter((agent) => !authBlocksAgent(agent.auth));
  }

  private async detectRuntimeListAgents(
    opts: DetectedAgentListOptions = {},
  ): Promise<DetectedAcpAgent[]> {
    const agents = await this.getDetectedAgents(opts);
    const enabled =
      (await this.enabledHarnessSet()) ?? defaultEnabledHarnessSet(agents);
    return enabled ? agents.filter((agent) => enabled.has(agent.id)) : agents;
  }

  private async managedInstallInfo(entry: KnownAgentEntry): Promise<{
    installed: boolean;
    installedVersion?: string;
    latestVersion?: string;
    updateAvailable?: boolean;
  }> {
    const registryLatestVersion = entry.registryVersion;
    if (!this.harnessDownloadDir || !entry.installSource) {
      return {
        installed: false,
        ...(registryLatestVersion
          ? { latestVersion: registryLatestVersion }
          : {}),
      };
    }
    const shimPath = join(
      this.harnessDownloadDir,
      basename(entry.spec.command),
    );
    const installed = await access(shimPath).then(
      () => true,
      () => false,
    );
    if (!installed) {
      return {
        installed: false,
        ...(registryLatestVersion
          ? { latestVersion: registryLatestVersion }
          : {}),
      };
    }
    const [metadata, installedNpmVersion, latestNpmVersion] = await Promise.all(
      [
        entry.installSource === "registry" && entry.registryId
          ? readAcpRegistryInstallMetadata({
              registryId: entry.registryId,
              binDir: this.harnessDownloadDir,
              installRoot: this.harnessDownloadDir,
            })
          : Promise.resolve(null),
        entry.installSource === "registry" &&
        entry.registryId &&
        entry.registryNpmPackage
          ? this.installedNpmPackageVersion(
              entry.registryId,
              entry.registryNpmPackage,
            )
          : Promise.resolve(undefined),
        entry.installSource === "registry" && entry.registryNpmPackage
          ? this.latestNpmPackageVersion(entry.registryNpmPackage)
          : Promise.resolve(undefined),
      ],
    );
    const installedVersion = installedNpmVersion ?? metadata?.version;
    const latestVersion = latestNpmVersion ?? registryLatestVersion;
    const updateAvailable =
      entry.installSource === "registry" &&
      !!latestVersion &&
      installedVersion !== latestVersion;
    return {
      installed: true,
      ...(installedVersion ? { installedVersion } : {}),
      ...(latestVersion ? { latestVersion } : {}),
      ...(updateAvailable ? { updateAvailable: true } : {}),
    };
  }

  private async installedHarnessVersion(
    agentId: string,
  ): Promise<string | undefined> {
    const entry = (await this.fullAgentCatalog()).find(
      (candidate) => candidate.id === agentId,
    );
    if (!entry) return undefined;
    return (await this.managedInstallInfo(entry)).installedVersion;
  }

  private async installedNpmPackageVersion(
    registryId: string,
    packageName: string,
  ): Promise<string | undefined> {
    if (!this.harnessDownloadDir) return undefined;
    try {
      const packageJson = JSON.parse(
        await readFile(
          join(
            this.harnessDownloadDir,
            "registry",
            registryId,
            "npx",
            "node_modules",
            ...packageName.split("/"),
            "package.json",
          ),
          "utf8",
        ),
      ) as { version?: unknown };
      return typeof packageJson.version === "string" &&
        packageJson.version.length > 0
        ? packageJson.version
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async latestNpmPackageVersion(
    packageName: string,
  ): Promise<string | undefined> {
    if (this.npmPackageVersionCache.has(packageName)) {
      return this.npmPackageVersionCache.get(packageName) ?? undefined;
    }
    try {
      const response = await this.fetchImpl(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      );
      if (!response.ok)
        throw new Error(`NPM registry unavailable: HTTP ${response.status}`);
      const payload = (await response.json()) as {
        version?: unknown;
        "dist-tags"?: { latest?: unknown };
      };
      const version = payload.version ?? payload["dist-tags"]?.latest;
      const normalized =
        typeof version === "string" && version.length > 0 ? version : null;
      this.npmPackageVersionCache.set(packageName, normalized);
      return normalized ?? undefined;
    } catch {
      this.npmPackageVersionCache.set(packageName, null);
      return undefined;
    }
  }

  private async buildHarnesses(
    opts: LocalAcpHarnessListOptions = {},
  ): Promise<LocalAcpHarness[]> {
    const probeAuth =
      opts.probe === true || opts.probe === "auth" || opts.probe === "config";
    const probeConfigOptions = opts.refresh === true || opts.probe === "config";
    const checksForUpdates =
      opts.checkUpdates === true ||
      opts.refresh === true ||
      (opts.probe !== undefined &&
        opts.probe !== false &&
        opts.probe !== "none");
    if (checksForUpdates) {
      this.registryAgentCatalogCache = null;
      this.npmPackageVersionCache.clear();
    }
    const agents = await this.getDetectedAgents({
      probeAuth,
      probeConfigOptions,
      probeScope: probeConfigOptions ? "enabled" : "installed",
      refresh: opts.refresh === true,
    });
    const enabled =
      (await this.enabledHarnessSet()) ?? defaultEnabledHarnessSet(agents);
    const detectedById = new Map(agents.map((agent) => [agent.id, agent]));
    const fullCatalog = await this.fullAgentCatalog();
    const catalogById = new Map(fullCatalog.map((entry) => [entry.id, entry]));
    const orderedEntries: KnownAgentEntry[] = [];
    const seen = new Set<string>();

    for (const agent of agents) {
      const entry = catalogById.get(agent.id) ?? toHarnessEntry(agent);
      orderedEntries.push(entry);
      seen.add(agent.id);
    }
    for (const entry of fullCatalog) {
      if (!seen.has(entry.id)) orderedEntries.push(entry);
    }

    return Promise.all(
      orderedEntries.map(async (entry) => {
        const detected = detectedById.get(entry.id);
        const installInfo = await this.managedInstallInfo(entry);
        const enabledByConfig = enabled ? enabled.has(entry.id) : !!detected;
        return {
          id: entry.id,
          label: entry.label,
          binary: detected?.spec.command ?? entry.spec.command,
          enabled: enabledByConfig && !authBlocksAgent(detected?.auth),
          available: !!detected,
          ...(entry.custom ? { custom: true } : {}),
          ...(installInfo.installed ? { installed: true } : {}),
          ...(installInfo.installedVersion
            ? { installedVersion: installInfo.installedVersion }
            : {}),
          ...(installInfo.latestVersion
            ? { latestVersion: installInfo.latestVersion }
            : {}),
          ...(installInfo.updateAvailable ? { updateAvailable: true } : {}),
          ...(entry.installSource
            ? { installable: true, installSource: entry.installSource }
            : {}),
          ...(entry.downloadUrl ? { downloadUrl: entry.downloadUrl } : {}),
          ...(entry.downloadKind ? { downloadKind: entry.downloadKind } : {}),
          ...(entry.homepage ? { homepage: entry.homepage } : {}),
          ...(detected?.auth
            ? { auth: publicAuthForResponse(detected.auth) }
            : {}),
          ...(detected?.sessionModes
            ? { session_modes: detected.sessionModes }
            : {}),
        };
      }),
    );
  }

  async listHarnesses(opts: LocalAcpHarnessListOptions = {}) {
    return { harnesses: await this.buildHarnesses(opts) };
  }

  async updateHarnesses(enabledIds: string[]) {
    const agents = await this.getDetectedAgents();
    const previousEnabled =
      (await this.enabledHarnessSet()) ?? defaultEnabledHarnessSet(agents);
    const normalized = normalizeEnabledHarnessIds(enabledIds, [
      ...agents.map((agent) => agent.id),
    ]);
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const probedAgents = await Promise.all(
      normalized
        .filter((id) => !previousEnabled?.has(id))
        .map((id) => agentById.get(id))
        .filter((agent): agent is DetectedAcpAgent => !!agent)
        .map((agent) =>
          this.probeAgentMetadata(agent, { auth: true, configOptions: false }),
        ),
    );
    const blocked = probedAgents.find((agent) => authBlocksAgent(agent.auth));
    if (blocked?.auth) {
      const suffix = blocked.auth.message ? ` ${blocked.auth.message}` : "";
      throw new Error(
        `Authenticate ${blocked.label} before enabling.${suffix}`,
      );
    }
    await this.harnessConfig?.saveEnabledHarnessIds(normalized);
    await this.reconcileConfiguration();
    return { harnesses: await this.buildHarnesses({ probe: "none" }) };
  }

  async listAgentServers() {
    return {
      agent_servers: (await this.harnessConfig?.loadAgentServers?.()) ?? {},
    };
  }

  async updateAgentServers(servers: LocalAcpAgentServersConfig) {
    if (!this.harnessConfig?.saveAgentServers)
      throw new Error("Custom agent server settings are not configured");
    const normalized = normalizeAgentServersConfig(servers);
    await this.harnessConfig.saveAgentServers(normalized);
    await this.reconcileConfiguration();
    return {
      agent_servers: normalized,
      harnesses: await this.buildHarnesses({ probe: "none" }),
    };
  }

  async installHarness(id: string) {
    const entry = (await this.fullAgentCatalog()).find(
      (candidate) => candidate.id === id,
    );
    if (!entry) throw new Error(`Unknown harness: ${id}`);
    if (!this.harnessDownloadDir)
      throw new Error("Harness download directory is not configured");

    if (entry.installSource === "registry") {
      if (!entry.registryId)
        throw new Error(`${entry.label} is missing an ACP registry id`);
      await installAcpRegistryAgent({
        registryId: entry.registryId,
        shimName: basename(entry.spec.command),
        binDir: this.harnessDownloadDir,
        installRoot: this.harnessDownloadDir,
        fetchImpl: this.fetchImpl,
        shimArgs: entry.spec.args,
        shimEnv: entry.spec.env ? mergedStringEnv(entry.spec.env) : undefined,
        env: this.spawnEnv as NodeJS.ProcessEnv,
      });
    } else if (entry.installSource === "adapter" && entry.downloadUrl) {
      await installManagedAdapter({
        id: entry.id,
        label: entry.label,
        command: entry.spec.command,
        args: entry.spec.args,
        downloadUrl: entry.downloadUrl,
        binDir: this.harnessDownloadDir,
        fetchImpl: this.fetchImpl,
      });
    } else {
      throw new Error(`${entry.label} is not installable from Clash`);
    }

    this.detectedAgentsCache = null;
    this.detectedAgentsCacheProbesAuth = false;
    this.detectedAgentsCacheProbesConfigOptions = false;
    this.detectedAgentsCacheProbeScope = null;
    return {
      harnesses: await this.buildHarnesses({ probe: true, refresh: true }),
    };
  }

  async installHarnessAdapter(id: string) {
    return this.installHarness(id);
  }

  async upgradeHarness(id: string) {
    const entry = (await this.fullAgentCatalog()).find(
      (candidate) => candidate.id === id,
    );
    if (!entry) throw new Error(`Unknown harness: ${id}`);
    const installInfo = await this.managedInstallInfo(entry);
    if (!installInfo.installed)
      throw new Error(`${entry.label} is not installed by Clash`);
    return this.installHarness(id);
  }

  async uninstallHarness(id: string) {
    const entry = (await this.fullAgentCatalog()).find(
      (candidate) => candidate.id === id,
    );
    if (!entry) throw new Error(`Unknown harness: ${id}`);
    if (!this.harnessDownloadDir)
      throw new Error("Harness download directory is not configured");

    if (entry.installSource === "registry") {
      if (!entry.registryId)
        throw new Error(`${entry.label} is missing an ACP registry id`);
      await uninstallAcpRegistryAgent({
        registryId: entry.registryId,
        shimName: basename(entry.spec.command),
        binDir: this.harnessDownloadDir,
        installRoot: this.harnessDownloadDir,
      });
    } else if (entry.installSource === "adapter") {
      await uninstallManagedAdapter({
        command: entry.spec.command,
        binDir: this.harnessDownloadDir,
      });
    } else {
      throw new Error(`${entry.label} is not managed by Clash`);
    }

    const enabled = await this.harnessConfig?.loadEnabledHarnessIds();
    if (enabled) {
      await this.harnessConfig?.saveEnabledHarnessIds(
        enabled.filter((candidate) => candidate !== id),
      );
    }
    this.detectedAgentsCache = null;
    this.detectedAgentsCacheProbesAuth = false;
    this.detectedAgentsCacheProbesConfigOptions = false;
    this.detectedAgentsCacheProbeScope = null;
    return {
      harnesses: await this.buildHarnesses({ probe: true, refresh: true }),
    };
  }

  async listRuntimes(opts: LocalAcpRuntimeListOptions = {}) {
    const probeAuth =
      opts.probe === true || opts.probe === "auth" || opts.probe === "config";
    const probeConfigOptions = opts.probe === true || opts.probe === "config";
    const agents = await this.detectRuntimeListAgents({
      probeAuth,
      probeConfigOptions,
      probeScope: probeConfigOptions ? "installed" : "enabled",
      refresh: opts.refresh === true,
    });
    const preferences = this.runPreferences
      ? normalizeRunPreferences(await this.runPreferences.load())
      : null;
    const now = this.nowSeconds();
    return {
      runtimes: [
        {
          id: DESKTOP_LOCAL_RUNTIME_ID,
          machine_id: DESKTOP_LOCAL_RUNTIME_ID,
          hostname: this.hostname(),
          os: this.osTag(),
          agents: agents.map((agent) => ({
            id: agent.id,
            label: agent.label,
            binary: agent.spec.command,
            ...(Array.isArray(agent.configOptions) &&
            agent.configOptions.length > 0
              ? { config_options: agent.configOptions }
              : {}),
            ...(Array.isArray(agent.availableCommands)
              ? { available_commands: agent.availableCommands }
              : {}),
            ...(agent.sessionModes
              ? { session_modes: agent.sessionModes }
              : {}),
            ...(agent.auth ? { auth: publicAuthForResponse(agent.auth) } : {}),
            ...(agent.capabilityInspection
              ? { capability_inspection: agent.capabilityInspection }
              : {}),
          })),
          ...(preferences ? { preferences } : {}),
          version: "desktop",
          status: "online" as const,
          last_heartbeat: now,
          created_at: now,
        },
      ],
    };
  }

  async updateRunPreferences(update: LocalAcpRunPreferenceUpdate) {
    const operation = this.runPreferencesQueue.then(async () => {
      if (!this.runPreferences) {
        throw new Error("Local ACP run preferences are not configured");
      }
      const agentId = update.agent_id.trim();
      if (!agentId) throw new Error("Missing agent_id");
      const current = normalizeRunPreferences(await this.runPreferences.load());
      const configValues = isPlainObject(update.config_values)
        ? Object.fromEntries(
            Object.entries(update.config_values).filter(
              (entry): entry is [string, LocalAcpRunConfigValue] =>
                typeof entry[1] === "string" || typeof entry[1] === "boolean",
            ),
          )
        : null;
      const modeId = update.mode_id?.trim();
      const preferences: LocalAcpRunPreferences = {
        agent_id: agentId,
        config_by_agent: {
          ...current.config_by_agent,
          ...(configValues ? { [agentId]: configValues } : {}),
        },
        mode_by_agent: {
          ...current.mode_by_agent,
          ...(modeId ? { [agentId]: modeId } : {}),
        },
      };
      await this.runPreferences.save(preferences);
      return { preferences };
    });
    this.runPreferencesQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async authenticateHarness(id: string, options?: LocalAcpAuthenticateOptions) {
    const agents = await this.getDetectedAgents();
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent) throw new Error(`Local agent harness is not available: ${id}`);
    const result = await this.authenticateAgent(agent, options);
    const authStarted = result?.status === "started";
    if (!authStarted) {
      const refreshedAgent = await this.probeAgentMetadata(agent, {
        auth: true,
        configOptions: false,
      });
      this.detectedAgentsCache = agents.map((candidate) =>
        candidate.id === id ? refreshedAgent : candidate,
      );
      this.detectedAgentsCacheProbesAuth = true;
    }
    return {
      harnesses: await this.buildHarnesses({ probe: false, refresh: false }),
    };
  }

  async createSession(params: LocalAcpCreateSessionParams) {
    return this.startSession(
      params,
      params.sessionId ?? this.createSessionId(),
    );
  }

  async attachSession(params: LocalAcpAttachSessionParams) {
    if (this.sessions.has(params.sessionId)) {
      return { session_id: params.sessionId };
    }
    return this.startSession(params, params.sessionId);
  }

  private async startSession(
    params: LocalAcpCreateSessionParams,
    sessionId: string,
  ) {
    if (this.shuttingDown)
      throw new Error("Local ACP runtime is shutting down");
    if (params.runtimeId !== DESKTOP_LOCAL_RUNTIME_ID) {
      throw new Error(`Unknown local runtime: ${params.runtimeId}`);
    }

    const agents = await this.detectEnabledAgents({
      probeAuth: true,
      probeScope: "enabled",
    });
    if (this.shuttingDown)
      throw new Error("Local ACP runtime is shutting down");
    const recentAgentId =
      !params.agentId && this.runPreferences
        ? normalizeRunPreferences(await this.runPreferences.load()).agent_id
        : undefined;
    let agent = params.agentId
      ? agents.find((candidate) => candidate.id === params.agentId)
      : chooseDefaultAgent(agents, recentAgentId);
    if (!agent && params.agentId) {
      const detectedAgents = await this.getDetectedAgents({
        probeAuth: true,
        probeScope: "enabled",
      });
      const requestedAgent = detectedAgents.find(
        (candidate) => candidate.id === params.agentId,
      );
      const enabled =
        (await this.enabledHarnessSet()) ??
        defaultEnabledHarnessSet(detectedAgents);
      const enabledByConfig = enabled ? enabled.has(params.agentId) : true;
      if (
        requestedAgent?.auth &&
        enabledByConfig &&
        authBlocksAgent(requestedAgent.auth)
      ) {
        throw new Error(
          agentAuthRequiredMessage(requestedAgent, requestedAgent.auth),
        );
      }
      throw new Error(
        `Local agent harness is not enabled or unavailable: ${params.agentId}`,
      );
    }
    if (!agent) throw new Error("No enabled local agent harness found");
    const agentIdForConfigUpdates = agent.id;
    const harnessVersion = await this.installedHarnessVersion(agent.id);
    if (params.forkPoint && !supportsAcpMessageFork(agent.id, harnessVersion)) {
      throw new Error("This harness version does not support forking at a message. Update the harness first.");
    }

    let entry: LocalAcpSession;
    const send: SessionSender = (msg) => {
      if (isTransportDiagnosticManagerMessage(msg)) return;
      if (isSessionReadyMessage(msg) && msg.supports_message_fork) {
        msg.supports_message_fork = supportsAcpMessageFork(
          agentIdForConfigUpdates,
          harnessVersion,
        );
      }
      const normalizedMsg = normalizeSessionAuthenticationError(
        msg,
        agentIdForConfigUpdates,
      );
      const persisted = this.persistManagerMessage(entry, normalizedMsg);
      const publicMsg = publicSessionMessage(normalizedMsg);
      if (isSessionReadyMessage(normalizedMsg)) {
        if (normalizedMsg.acp_session_id)
          entry.acpSessionId = normalizedMsg.acp_session_id;
        entry.readyMessage = publicMsg;
        if (Array.isArray(normalizedMsg.config_options)) {
          this.updateCachedAgentConfigOptions(
            agentIdForConfigUpdates,
            normalizedMsg.config_options,
          );
          entry.configOptionsMessage = {
            type: "session.config_options",
            session_id: sessionId,
            config_options: normalizedMsg.config_options,
          };
        }
        if (normalizedMsg.modes !== undefined) {
          this.updateCachedAgentSessionModes(
            agentIdForConfigUpdates,
            normalizedMsg.modes,
          );
          entry.modeMessage = {
            type: "session.mode",
            session_id: sessionId,
            modes: normalizedMsg.modes,
          };
        }
        void params.onReady?.({
          sessionId,
          ...(normalizedMsg.acp_session_id
            ? { acpSessionId: normalizedMsg.acp_session_id }
            : {}),
        });
      } else if (isSessionConfigOptionsMessage(normalizedMsg)) {
        this.updateCachedAgentConfigOptions(
          agentIdForConfigUpdates,
          normalizedMsg.config_options,
        );
        entry.configOptionsMessage = publicMsg;
      } else if (isSessionModeMessage(normalizedMsg)) {
        this.updateCachedAgentSessionModes(
          agentIdForConfigUpdates,
          normalizedMsg.modes,
        );
        entry.modeMessage = publicMsg;
      } else if (isSessionErrorMessage(normalizedMsg)) {
        entry.errorMessage = publicMsg;
        void params.onError?.({ sessionId, message: normalizedMsg.message });
      }
      const sessionDisposed =
        publicMsg &&
        typeof publicMsg === "object" &&
        (publicMsg as { type?: unknown }).type === "session.disposed";
      if (sessionDisposed) {
        entry.disposedSent = true;
        if (entry.restarting) return;
      }
      this.sendToSession(entry, publicMsg);
      for (const event of replaySetupEvents(normalizedMsg)) {
        this.sendToSession(entry, {
          type: "session.event",
          session_id: sessionId,
          event,
        });
      }
      if (persisted) void persisted.catch(() => undefined);
    };
    entry = {
      id: sessionId,
      startParams: { ...params, sessionId },
      harnessId: agent.id,
      harnessLabel: agent.label,
      ...(harnessVersion ? { harnessVersion } : {}),
      manager: this.createSessionManager(
        send,
        (requestSessionId, request) =>
          this.brokerPermissionRequest(entry, requestSessionId, request),
        (requestSessionId, request) =>
          this.brokerElicitationRequest(entry, requestSessionId, request),
      ),
      clients: new Set(),
      promptQueueMode: "single",
      queuedPrompts: [],
      scheduledPromptCount: 0,
      activePromptTurnId: null,
      restartPending: false,
      restartReadySent: false,
      promptQueue: Promise.resolve(),
      persistQueue: Promise.resolve(),
      events: [],
      pendingPermissions: new Map(),
      pendingElicitations: new Map(),
      ...(params.projectId ? { projectId: params.projectId } : {}),
      ...(params.agentMemberId ? { agentMemberId: params.agentMemberId } : {}),
    };
    entry.manager.setSpawnEnv?.(this.spawnEnv);
    this.sessions.set(sessionId, entry);
    agent = await this.probeAgentMetadata(agent, {
      auth: true,
      configOptions: false,
    });
    if (this.shuttingDown) {
      await this.disposeSession(sessionId);
      throw new Error("Local ACP runtime is shutting down");
    }
    if (agent.auth?.status === "needs-auth") {
      send({
        type: "session.error",
        session_id: sessionId,
        code: "auth_required",
        agent_id: agent.id,
        auth: publicAuthForResponse(agent.auth),
        message: agentAuthRequiredMessage(agent, agent.auth),
      } as SessionManagerOut);
      return { session_id: sessionId };
    }

    const startParams: SessionStartParamsLike = {
      session_id: sessionId,
      agent_template_id: params.agentTemplateId,
      agent_id: agent.id,
      agent_spec: agent.spec,
      ...(params.configValues && Object.keys(params.configValues).length > 0
        ? { config_options: params.configValues }
        : {}),
      ...(params.permissionMode
        ? { permission_mode: params.permissionMode }
        : {}),
      ...(params.agentMemberId
        ? { agent_member_id: params.agentMemberId }
        : {}),
      ...(params.projectId ? { project_id: params.projectId } : {}),
      ...(params.resumeAcpSessionId
        ? { resume: { acp_session_id: params.resumeAcpSessionId } }
        : {}),
      ...(params.forkFromAcpSessionId
        ? { fork: { acp_session_id: params.forkFromAcpSessionId, point: params.forkPoint } }
        : {}),
    };

    entry.startPromise = Promise.resolve(entry.manager.start(startParams)).catch((error) => {
      send({
        type: "session.error",
        session_id: sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    });

    return { session_id: sessionId };
  }

  private brokerPermissionRequest(
    entry: LocalAcpSession,
    sessionId: Parameters<SessionPermissionBroker>[0],
    request: Parameters<SessionPermissionBroker>[1],
  ): ReturnType<SessionPermissionBroker> {
    if (entry.id !== sessionId) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const message = {
        type: "session.permission_request" as const,
        session_id: sessionId,
        request_id: requestId,
        tool_call: request.toolCall,
        options: request.options,
      };
      entry.pendingPermissions.set(requestId, {
        optionIds: new Set(request.options.map((option) => option.optionId)),
        message,
        resolve,
      });
      for (const client of entry.clients) sendJson(client, message);
    });
  }

  private resolvePermissionRequest(
    entry: LocalAcpSession,
    requestId: string,
    optionId: string | null,
  ): void {
    const pending = entry.pendingPermissions.get(requestId);
    if (!pending) return;
    entry.pendingPermissions.delete(requestId);
    const selectedOptionId =
      typeof optionId === "string" && pending.optionIds.has(optionId)
        ? optionId
        : null;
    pending.resolve(
      selectedOptionId
        ? { outcome: { outcome: "selected", optionId: selectedOptionId } }
        : { outcome: { outcome: "cancelled" } },
    );
    const resolved = {
      type: "session.permission_resolved",
      session_id: entry.id,
      request_id: requestId,
      option_id: selectedOptionId,
    };
    for (const client of entry.clients) sendJson(client, resolved);
  }

  private cancelPendingPermissions(entry: LocalAcpSession): void {
    for (const requestId of [...entry.pendingPermissions.keys()]) {
      this.resolvePermissionRequest(entry, requestId, null);
    }
  }

  private brokerElicitationRequest(
    entry: LocalAcpSession,
    sessionId: Parameters<SessionElicitationBroker>[0],
    request: Parameters<SessionElicitationBroker>[1],
  ): ReturnType<SessionElicitationBroker> {
    if (entry.id !== sessionId) {
      return Promise.resolve({ action: "decline" });
    }
    if (request.mode === "url") {
      const url = safeElicitationUrl(request.url);
      if (!url || !request.elicitationId)
        return Promise.resolve({ action: "decline" });
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const message = {
          type: "session.elicitation_request" as const,
          session_id: sessionId,
          request_id: requestId,
          mode: "url" as const,
          message: request.message,
          elicitation_id: request.elicitationId,
          url,
          ...("toolCallId" in request && typeof request.toolCallId === "string"
            ? { tool_call_id: request.toolCallId }
            : {}),
        };
        entry.pendingElicitations.set(requestId, { request, message, resolve });
        for (const client of entry.clients) sendJson(client, message);
      });
    }
    if (request.mode !== "form") return Promise.resolve({ action: "decline" });
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const message = {
        type: "session.elicitation_request" as const,
        session_id: sessionId,
        request_id: requestId,
        mode: "form" as const,
        message: request.message,
        requested_schema: request.requestedSchema,
        ...("toolCallId" in request && typeof request.toolCallId === "string"
          ? { tool_call_id: request.toolCallId }
          : {}),
      };
      entry.pendingElicitations.set(requestId, { request, message, resolve });
      for (const client of entry.clients) sendJson(client, message);
    });
  }

  private resolveElicitationRequest(
    entry: LocalAcpSession,
    requestId: string,
    action: string | undefined,
    content: unknown,
  ): void {
    const pending = entry.pendingElicitations.get(requestId);
    if (!pending) return;
    entry.pendingElicitations.delete(requestId);
    const response =
      pending.request.mode === "form"
        ? validatedElicitationResponse(pending.request, action, content)
        : action === "accept"
          ? { action: "accept" as const }
          : action === "cancel"
            ? { action: "cancel" as const }
            : { action: "decline" as const };
    pending.resolve(response);
    const resolved =
      pending.request.mode === "form"
        ? {
            type: "session.elicitation_resolved",
            session_id: entry.id,
            request_id: requestId,
            mode: "form",
            message: pending.request.message,
            requested_schema: pending.request.requestedSchema,
            action: response.action,
            ...(response.action === "accept"
              ? { content: response.content ?? {} }
              : {}),
          }
        : {
            type: "session.elicitation_resolved",
            session_id: entry.id,
            request_id: requestId,
            mode: "url",
            message: pending.request.message,
            elicitation_id: pending.request.elicitationId,
            url: pending.request.url,
            action: response.action,
          };
    for (const client of entry.clients) sendJson(client, resolved);
  }

  private cancelPendingElicitations(entry: LocalAcpSession): void {
    for (const requestId of [...entry.pendingElicitations.keys()]) {
      this.resolveElicitationRequest(entry, requestId, "cancel", undefined);
    }
  }

  async runTextTask(
    params: LocalAcpTextTaskParams,
  ): Promise<{ text: string; agentId?: string; sessionId: string }> {
    const sessionId = this.createSessionId();
    await this.startSession(
      {
        runtimeId: DESKTOP_LOCAL_RUNTIME_ID,
        agentMemberId: "local-text-generator",
        projectId: params.projectId,
        agentId: params.agentId,
      },
      sessionId,
    );
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error("Local ACP text session failed to start.");
    const turnId = `text-gen-${randomUUID().slice(0, 8)}`;
    const chunks: string[] = [];
    const finalChunks: string[] = [];
    const prompt = [
      params.systemPrompt ? `System instructions:\n${params.systemPrompt}` : "",
      "Generate only the requested text. Do not edit the canvas or call tools unless strictly required for the text.",
      params.prompt,
    ]
      .filter(Boolean)
      .join("\n\n");

    return await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(
        () => {
          cleanup();
          reject(new Error("Local ACP text generation timed out."));
        },
        params.timeoutMs ?? 5 * 60 * 1000,
      );
      const observer = (msg: unknown) => {
        if (isSessionEventMessage(msg) && msg.turn_id === turnId) {
          const chunk = agentTextFromSessionEvent(msg.event);
          if (chunk?.phase === "final_answer") finalChunks.push(chunk.text);
          else if (chunk && chunk.phase !== "commentary") chunks.push(chunk.text);
          return;
        }
        if (
          isSessionErrorMessage(msg) &&
          (!msg.turn_id || msg.turn_id === turnId)
        ) {
          cleanup();
          reject(new Error(msg.message));
          return;
        }
        if (isSessionCompleteMessage(msg) && msg.turn_id === turnId) {
          cleanup();
          const text = (finalChunks.length ? finalChunks : chunks).join("").trim();
          if (!text) {
            reject(new Error("Local ACP text generation returned no text."));
            return;
          }
          resolve({ text, sessionId, agentId: params.agentId });
        }
      };
      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        entry.observers?.delete(observer);
        void this.disposeSession(sessionId);
      };
      entry.observers ??= new Set();
      entry.observers.add(observer);
      const modelId = params.modelId?.trim();
      Promise.resolve(entry.startPromise)
        .then(() => {
          if (settled) return;
          // Startup may have failed before the observer was installed.
          if (isSessionErrorMessage(entry.errorMessage)) {
            throw new Error(entry.errorMessage.message);
          }
          return modelId ? entry.manager.setConfigOption?.(
              sessionId,
              params.modelConfigId ?? "model",
              modelId,
            )
          : undefined;
        })
        .then(() => {
          if (!settled) return this.schedulePrompt(entry, turnId, prompt);
        })
        .catch((error) => {
          if (settled) return;
          cleanup();
          reject(error);
        });
    });
  }

  async listSessionEvents(
    sessionId: string,
  ): Promise<{ events: LocalAcpSessionEvent[] } | null> {
    const persisted =
      await this.sessionEventStore?.listSessionEvents(sessionId);
    if (persisted) return persisted;
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    return {
      events: entry.events.map((event) => ({
        ...event,
        data: structuredClone(event.data),
      })),
    };
  }

  private enqueuePersistence(
    entry: LocalAcpSession,
    task: () => Promise<void> | void,
  ): Promise<void> {
    entry.persistQueue = entry.persistQueue.then(
      () => Promise.resolve(task()),
      () => Promise.resolve(task()),
    );
    return entry.persistQueue;
  }

  private promptQueueSnapshot(entry: LocalAcpSession) {
    return entry.queuedPrompts.map((prompt) => ({
      turn_id: prompt.turnId,
      text: prompt.text,
      created_at: prompt.createdAt,
    }));
  }

  private sendPromptQueueUpdate(entry: LocalAcpSession): void {
    const msg = {
      type: "session.queue_update",
      session_id: entry.id,
      mode: entry.promptQueueMode,
      active_turn_id: entry.activePromptTurnId,
      queued: this.promptQueueSnapshot(entry),
    };
    for (const client of entry.clients) sendJson(client, msg);
  }

  private promptBusy(entry: LocalAcpSession): boolean {
    return entry.scheduledPromptCount > 0 || entry.activePromptTurnId !== null;
  }

  private notifyRestartReadyIfIdle(entry: LocalAcpSession): boolean {
    if (
      !entry.restartPending ||
      entry.restartReadySent ||
      this.promptBusy(entry)
    )
      return false;
    entry.restartReadySent = true;
    this.sendToSession(entry, {
      type: "session.restart_ready",
      session_id: entry.id,
    });
    return true;
  }

  private schedulePrompt(
    entry: LocalAcpSession,
    turnId: string,
    text: string,
    opts: { persistUserPrompt?: boolean } = {},
  ): Promise<void> {
    entry.scheduledPromptCount += 1;
    this.sendPromptQueueUpdate(entry);
    const runPrompt = async () => {
      if (opts.persistUserPrompt) {
        await (this.appendUserPrompt(entry, turnId, text) ?? Promise.resolve());
      }
      entry.activePromptTurnId = turnId;
      this.sendPromptQueueUpdate(entry);
      try {
        await Promise.resolve(
          entry.manager.prompt({
            session_id: entry.id,
            turn_id: turnId,
            text,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await (this.persistTurnError(entry, turnId, message) ??
          Promise.resolve());
        this.sendToSession(entry, {
          type: "session.error",
          session_id: entry.id,
          turn_id: turnId,
          message,
        });
      } finally {
        if (entry.activePromptTurnId === turnId)
          entry.activePromptTurnId = null;
        entry.scheduledPromptCount = Math.max(
          0,
          entry.scheduledPromptCount - 1,
        );
        this.sendPromptQueueUpdate(entry);
        if (!this.notifyRestartReadyIfIdle(entry) && !this.promptBusy(entry))
          this.drainQueuedPrompts(entry);
      }
    };
    entry.promptQueue = entry.promptQueue.then(runPrompt, runPrompt);
    return entry.promptQueue;
  }

  private queuePrompt(
    entry: LocalAcpSession,
    turnId: string,
    text: string,
  ): void {
    const existingIndex = entry.queuedPrompts.findIndex(
      (prompt) => prompt.turnId === turnId,
    );
    const existing =
      existingIndex >= 0 ? entry.queuedPrompts[existingIndex] : null;
    const nextPrompt = {
      turnId,
      text,
      createdAt: existing?.createdAt ?? this.nowSeconds(),
    };
    if (existingIndex >= 0) entry.queuedPrompts[existingIndex] = nextPrompt;
    else entry.queuedPrompts.push(nextPrompt);
    this.sendPromptQueueUpdate(entry);
  }

  private sendSteerPrompt(
    entry: LocalAcpSession,
    turnId: string,
    text: string,
  ): void {
    entry.queuedPrompts = entry.queuedPrompts.filter(
      (prompt) => prompt.turnId !== turnId,
    );
    this.appendUserPrompt(entry, turnId, text);
    entry.scheduledPromptCount += 1;
    this.sendPromptQueueUpdate(entry);

    void (async () => {
      try {
        await Promise.resolve(
          entry.manager.prompt({
            session_id: entry.id,
            turn_id: turnId,
            text,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await (this.persistTurnError(entry, turnId, message) ??
          Promise.resolve());
        this.sendToSession(entry, {
          type: "session.error",
          session_id: entry.id,
          turn_id: turnId,
          message,
        });
      } finally {
        entry.scheduledPromptCount = Math.max(
          0,
          entry.scheduledPromptCount - 1,
        );
        this.sendPromptQueueUpdate(entry);
        if (!this.notifyRestartReadyIfIdle(entry) && !this.promptBusy(entry))
          this.drainQueuedPrompts(entry);
      }
    })();
  }

  private dispatchPrompt(
    entry: LocalAcpSession,
    turnId: string,
    text: string,
  ): Promise<void> | void {
    if (this.promptBusy(entry)) {
      this.queuePrompt(entry, turnId, text);
      return;
    }
    this.appendUserPrompt(entry, turnId, text);
    return this.schedulePrompt(entry, turnId, text);
  }

  private markPromptCancelled(entry: LocalAcpSession, turnId: string): void {
    if (entry.activePromptTurnId !== turnId) return;
    entry.activePromptTurnId = null;
    entry.scheduledPromptCount = Math.max(0, entry.scheduledPromptCount - 1);
    this.sendPromptQueueUpdate(entry);
  }

  private drainQueuedPrompts(entry: LocalAcpSession): boolean {
    if (entry.queuedPrompts.length === 0) return false;
    const toSend =
      entry.promptQueueMode === "single"
        ? entry.queuedPrompts.slice(0, 1)
        : entry.queuedPrompts;
    const toSendTurns = new Set(toSend.map((prompt) => prompt.turnId));
    entry.queuedPrompts = entry.queuedPrompts.filter(
      (prompt) => !toSendTurns.has(prompt.turnId),
    );
    this.sendPromptQueueUpdate(entry);
    for (const prompt of toSend) {
      this.schedulePrompt(entry, prompt.turnId, prompt.text, {
        persistUserPrompt: true,
      });
    }
    return true;
  }

  private appendUserPrompt(
    entry: LocalAcpSession,
    turnId: string,
    text: string,
  ): Promise<void> | null {
    if (
      entry.events.some(
        (row) =>
          row.type === "user_prompt" &&
          !!row.data &&
          typeof row.data === "object" &&
          (row.data as { turn_id?: unknown }).turn_id === turnId,
      )
    ) {
      return this.sessionEventStore ? entry.persistQueue : null;
    }
    return this.appendSessionEvent(entry, "user_prompt", {
      turn_id: turnId,
      text,
    });
  }

  private appendSessionEvent(
    entry: LocalAcpSession,
    type: string,
    data: unknown,
  ): Promise<void> | null {
    const event: LocalAcpSessionEvent = {
      seq: (entry.events.at(-1)?.seq ?? 0) + 1,
      type,
      data: structuredClone(data),
      ts: this.nowMilliseconds(),
    };
    entry.events.push(event);
    return this.sessionEventStore
      ? this.enqueuePersistence(entry, () =>
          this.sessionEventStore?.appendEvent(entry.id, {
            type: event.type,
            data: structuredClone(event.data),
            ts: event.ts,
          }),
        )
      : null;
  }

  private persistTurnError(
    entry: LocalAcpSession,
    turnId: string | null,
    message: string,
  ): Promise<void> | null {
    return this.appendSessionEvent(entry, "turn_failed", {
      ...(turnId ? { turn_id: turnId } : {}),
      message: redactAuthenticationError(message),
    });
  }

  private persistManagerMessage(
    entry: LocalAcpSession,
    msg: unknown,
  ): Promise<void> | null {
    if (isSessionEventMessage(msg)) {
      if (!shouldPersistSessionEvent(msg.event)) return null;
      return this.appendSessionEvent(entry, "session.event", {
        turn_id: msg.turn_id,
        event: msg.event,
      });
    }
    if (isSessionErrorMessage(msg)) {
      return this.persistTurnError(entry, msg.turn_id ?? null, msg.message);
    }
    if (isSessionCompleteMessage(msg) && msg.turn_id) {
      return this.appendSessionEvent(entry, "turn_completed", {
        turn_id: msg.turn_id,
      });
    }
    if (isSessionCancelledMessage(msg)) {
      return this.appendSessionEvent(entry, "turn_cancelled", {
        turn_id: msg.turn_id,
      });
    }
    return null;
  }

  private sendToSession(entry: LocalAcpSession, msg: unknown): void {
    const publicMsg = normalizeSessionAuthenticationError(msg, entry.harnessId);
    for (const observer of entry.observers ?? []) observer(publicMsg);
    for (const client of entry.clients) sendJson(client, publicMsg);
  }

  private removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async restartSession(
    sessionId: string,
    options: { mode: "now" | "after-turn" },
  ): Promise<{ session_id: string; status: "pending" | "restarted" }> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error("local session not found");
    if (options.mode === "after-turn" && this.promptBusy(entry)) {
      entry.restartPending = true;
      entry.restartReadySent = false;
      return { session_id: sessionId, status: "pending" };
    }

    const startParams: LocalAcpCreateSessionParams = {
      ...entry.startParams,
      sessionId,
      ...(entry.acpSessionId ? { resumeAcpSessionId: entry.acpSessionId } : {}),
    };
    entry.restarting = true;
    this.cancelPendingPermissions(entry);
    this.cancelPendingElicitations(entry);
    for (const client of entry.clients) {
      try {
        client.close(1012, "ACP session restarting");
      } catch {
        // A stale browser socket must not prevent the ACP child from restarting.
      }
    }
    await Promise.resolve(entry.manager.dispose(sessionId));
    this.removeSession(sessionId);
    await this.startSession(startParams, sessionId);
    return { session_id: sessionId, status: "restarted" };
  }

  async getSessionRuntimeStatus(sessionId: string): Promise<{
    session_id: string;
    harness_id: string;
    harness_label: string;
    running_version?: string;
    installed_version?: string;
    restart_required: boolean;
    busy: boolean;
    restart_pending: boolean;
  } | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    const installedVersion = await this.installedHarnessVersion(
      entry.harnessId,
    );
    return {
      session_id: sessionId,
      harness_id: entry.harnessId,
      harness_label: entry.harnessLabel,
      ...(entry.harnessVersion
        ? { running_version: entry.harnessVersion }
        : {}),
      ...(installedVersion ? { installed_version: installedVersion } : {}),
      restart_required: Boolean(
        entry.harnessVersion &&
        installedVersion &&
        entry.harnessVersion !== installedVersion,
      ),
      busy: this.promptBusy(entry),
      restart_pending: entry.restartPending,
    };
  }

  private disposeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return Promise.resolve();
    if (!entry.disposePromise) {
      this.cancelPendingPermissions(entry);
      this.cancelPendingElicitations(entry);
      entry.disposePromise = Promise.resolve(entry.manager.dispose(sessionId))
        .catch((error) => {
          this.sendToSession(entry, {
            type: "session.error",
            session_id: sessionId,
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (!entry.disposedSent) {
            this.sendToSession(entry, {
              type: "session.disposed",
              session_id: sessionId,
            });
            entry.disposedSent = true;
          }
          this.removeSession(sessionId);
        });
    }
    return entry.disposePromise;
  }

  disposeAll(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      await disposeAllAcpSetupProcesses();
      while (this.sessions.size > 0) {
        const entries = [...this.sessions.values()];
        for (const entry of entries) {
          for (const client of entry.clients) {
            try {
              client.close(1001, "Clash local API shutdown");
            } catch {
              // Continue shutting down the ACP process if a client is already gone.
            }
          }
        }
        await Promise.all(
          entries.map((entry) => this.disposeSession(entry.id)),
        );
      }
    })();
    return this.shutdownPromise;
  }

  async listResumeSessions(runtimeId: string) {
    if (runtimeId !== DESKTOP_LOCAL_RUNTIME_ID) return { sessions: [] };
    const agents = await this.detectEnabledAgents();
    const listed = await Promise.allSettled(
      agents.map((agent) => this.listAgentSessions(agent)),
    );
    const sessions = listed.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    if (sessions.length > 0) {
      const seen = new Set<string>();
      return {
        sessions: sessions
          .filter((session) => {
            if (seen.has(session.id)) return false;
            seen.add(session.id);
            return true;
          })
          .sort((a, b) => b.modifiedAt - a.modifiedAt),
      };
    }
    return { sessions: await this.listLocalSessions() };
  }

  bindSessionSocket(sessionId: string, ws: WebSocket): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      sendJson(ws, {
        type: "session.error",
        session_id: sessionId,
        message: "local session not found",
      });
      ws.close(1008, "session not found");
      return;
    }

    entry.clients.add(ws);
    sendJson(ws, {
      type: "attached",
      session_id: sessionId,
      daemon_online: true,
    });
    if (this.promptBusy(entry) || entry.queuedPrompts.length > 0)
      this.sendPromptQueueUpdate(entry);
    if (entry.readyMessage) sendJson(ws, entry.readyMessage);
    if (entry.configOptionsMessage) sendJson(ws, entry.configOptionsMessage);
    if (entry.modeMessage) sendJson(ws, entry.modeMessage);
    if (entry.errorMessage) sendJson(ws, entry.errorMessage);
    for (const pending of entry.pendingPermissions.values()) {
      sendJson(ws, pending.message);
    }
    for (const pending of entry.pendingElicitations.values()) {
      sendJson(ws, pending.message);
    }

    ws.on("message", (raw) => {
      const msg = parseBrowserMessage(raw);
      if (!msg?.type) return;
      switch (msg.type) {
        case "permission_response":
          if (typeof msg.request_id === "string") {
            this.resolvePermissionRequest(
              entry,
              msg.request_id,
              typeof msg.option_id === "string" ? msg.option_id : null,
            );
          }
          return;
        case "elicitation_response":
          if (typeof msg.request_id === "string") {
            this.resolveElicitationRequest(
              entry,
              msg.request_id,
              msg.action,
              msg.content,
            );
          }
          return;
        case "set_prompt_queue_mode":
          if (isPromptQueueMode(msg.queue_mode)) {
            entry.promptQueueMode = msg.queue_mode;
            this.sendPromptQueueUpdate(entry);
          }
          return;
        case "clear_prompt_queue":
          entry.queuedPrompts = [];
          this.sendPromptQueueUpdate(entry);
          return;
        case "steer_queued_prompt":
          if (msg.turn_id) {
            const queued = entry.queuedPrompts.find(
              (prompt) => prompt.turnId === msg.turn_id,
            );
            if (queued) this.sendSteerPrompt(entry, queued.turnId, queued.text);
          }
          return;
        case "update_queued_prompt":
          if (msg.turn_id && typeof msg.text === "string" && msg.text.trim()) {
            const text = msg.text.trim();
            entry.queuedPrompts = entry.queuedPrompts.map((prompt) =>
              prompt.turnId === msg.turn_id ? { ...prompt, text } : prompt,
            );
            this.sendPromptQueueUpdate(entry);
          }
          return;
        case "remove_queued_prompt":
          if (msg.turn_id) {
            entry.queuedPrompts = entry.queuedPrompts.filter(
              (prompt) => prompt.turnId !== msg.turn_id,
            );
            this.sendPromptQueueUpdate(entry);
          }
          return;
        case "reorder_prompt_queue":
          if (Array.isArray(msg.turn_ids)) {
            const order = new Map<string, number>();
            for (const [index, turnId] of msg.turn_ids.entries()) {
              if (typeof turnId === "string" && !order.has(turnId))
                order.set(turnId, index);
            }
            entry.queuedPrompts = [...entry.queuedPrompts].sort((a, b) => {
              const aIndex = order.get(a.turnId);
              const bIndex = order.get(b.turnId);
              if (aIndex === undefined && bIndex === undefined)
                return a.createdAt - b.createdAt;
              if (aIndex === undefined) return 1;
              if (bIndex === undefined) return -1;
              return aIndex - bIndex;
            });
            this.sendPromptQueueUpdate(entry);
          }
          return;
        case "prompt":
          if (msg.turn_id && typeof msg.text === "string") {
            if (isPromptQueueMode(msg.queue_mode))
              entry.promptQueueMode = msg.queue_mode;
            try {
              this.dispatchPrompt(entry, msg.turn_id, msg.text);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              this.sendToSession(entry, {
                type: "session.error",
                session_id: sessionId,
                turn_id: msg.turn_id,
                message,
              });
            }
          }
          return;
        case "cancel":
          if (msg.turn_id) {
            this.cancelPendingElicitations(entry);
            this.markPromptCancelled(entry, msg.turn_id);
            entry.manager.cancel(sessionId, msg.turn_id);
          }
          return;
        case "set_config_option":
          if (
            msg.config_id &&
            (typeof msg.value === "string" || typeof msg.value === "boolean")
          ) {
            void Promise.resolve(
              entry.manager.setConfigOption?.(
                sessionId,
                msg.config_id,
                msg.value,
              ),
            ).catch((error) => {
              sendJson(ws, {
                type: "session.error",
                session_id: sessionId,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          }
          return;
        case "set_session_mode":
          if (typeof msg.mode_id === "string" && msg.mode_id.trim()) {
            void Promise.resolve(
              entry.manager.setMode?.(sessionId, msg.mode_id.trim()),
            ).catch((error) => {
              sendJson(ws, {
                type: "session.error",
                session_id: sessionId,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          }
          return;
        case "dispose":
          void this.disposeSession(sessionId);
          return;
      }
    });

    ws.on("close", () => {
      entry.clients.delete(ws);
    });
  }
}

export function createLocalAcpAdapter(
  options?: LocalAcpAdapterOptions,
): LocalAcpRuntimeAdapter {
  return new LocalAcpRuntimeAdapter(options);
}

export function attachLocalAcpSessions(
  server: UpgradeCapableServer,
  adapter: LocalAcpRuntimeAdapter,
): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = /^\/api\/v1\/local-sessions\/([^/]+)\/_stream$/.exec(
      url.pathname,
    );
    if (!match) return;

    const sessionId = decodeURIComponent(match[1]);
    wss.handleUpgrade(request, socket, head, (ws) => {
      adapter.bindSessionSocket(sessionId, ws);
    });
  });
}
