import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type AuthMethod,
  type Client,
  type ClientCapabilities,
  type InitializeResponse,
  type NewSessionResponse,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import { NodeSpawner } from "@openma/common/acp-runtime/node-spawner";
import {
  sessionConfigOptionsFromResponse,
  type AgentSpec,
  type ChildHandle,
  type ProbeAgentAuthMethod,
  type ProbeAgentAuthStatus,
  type Spawner,
  type TerminalAuthLaunchOptions,
} from "@openma/common/acp-runtime";
import { withClashAcpExtensionCapabilities } from "./client-capabilities.js";

export interface ProbeAgentConfigOptionsOptions {
  agent: AgentSpec;
  cwd?: string;
  env?: Record<string, string | undefined>;
  capabilitySettleMs?: number;
  timeoutMs?: number;
  spawner?: Spawner;
}

export interface ProbeAgentSessionConfigResult {
  configOptions: SessionConfigOption[];
  availableCommands: unknown[];
  modes?: SessionModeState | null;
  /** Auth observed by the same disposable process as the capability snapshot. */
  auth: ProbeAgentAuthStatus;
}

const ACP_AUTH_REQUIRED_CODE = -32000;
const activeSetupConnections = new Set<() => Promise<void>>();
const ACP_CLIENT_CAPABILITIES: ClientCapabilities = withClashAcpExtensionCapabilities({
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
  auth: {
    terminal: true,
    _meta: { gateway: true },
  },
});

function authMethodType(method: AuthMethod): string {
  const type = (method as { type?: unknown }).type;
  if (typeof type === "string") return type;
  const meta = authMethodMeta(method);
  const metaType = meta?.type;
  return typeof metaType === "string" ? metaType : "agent";
}

function isSupportedAuthMethod(method: AuthMethod): boolean {
  const type = authMethodType(method);
  return type === "agent" || type === "terminal" || type === "env_var";
}

function supportedAuthMethods(authMethods: unknown): AuthMethod[] {
  if (!Array.isArray(authMethods)) return [];
  return authMethods.filter((method): method is AuthMethod => {
    if (!method || typeof method !== "object") return false;
    const typed = method as AuthMethod & { id?: unknown };
    return typeof typed.id === "string" && typed.id.length > 0 && isSupportedAuthMethod(typed);
  });
}

function declaredAuthMethods(authMethods: unknown): AuthMethod[] {
  if (!Array.isArray(authMethods)) return [];
  return authMethods.filter((method): method is AuthMethod => {
    if (!method || typeof method !== "object") return false;
    const typed = method as AuthMethod & { id?: unknown };
    return typeof typed.id === "string" && typed.id.length > 0;
  });
}

function unsupportedAuthMethodTypes(methods: AuthMethod[]): string[] {
  return [...new Set(
    methods
      .filter((method) => !isSupportedAuthMethod(method))
      .map(authMethodType)
      .filter((type) => type.length > 0),
  )];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function authMethodMeta(method: AuthMethod): Record<string, unknown> | null {
  const meta = (method as { _meta?: unknown; meta?: unknown })._meta ?? (method as { meta?: unknown }).meta;
  return isRecord(meta) ? meta : null;
}

function terminalAuthMeta(method: AuthMethod): TerminalAuthLaunchOptions | null {
  const meta = authMethodMeta(method);
  if (!meta) return null;
  const terminalAuth = meta["terminal-auth"];
  if (!isRecord(terminalAuth)) return null;
  if (typeof terminalAuth.command !== "string" || terminalAuth.command.length === 0) return null;
  return {
    label: typeof terminalAuth.label === "string" && terminalAuth.label.length > 0
      ? terminalAuth.label
      : authMethodName(method) ?? "Login",
    command: terminalAuth.command,
    args: stringArray(terminalAuth.args),
    ...(stringRecord(terminalAuth.env) ? { env: stringRecord(terminalAuth.env) } : {}),
  };
}

function parseGeneratedShellShimCommand(command: string): string | null {
  try {
    const text = readFileSync(command, "utf8");
    const execLine = text.split("\n").find((line) => line.startsWith("exec ") && line.includes('"$@"'));
    if (!execLine) return null;
    const match = execLine.match(/^exec\s+'([^']+)'(?:\s|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function terminalAuthCommand(command: string): string {
  return parseGeneratedShellShimCommand(command) ?? command;
}

function terminalAuthFromMethod(method: AuthMethod, agent: AgentSpec, env: Record<string, string>, cwd: string): TerminalAuthLaunchOptions | null {
  const metaAuth = terminalAuthMeta(method);
  if (metaAuth) return { ...metaAuth, cwd };
  if (authMethodType(method) !== "terminal") return null;
  const terminalMethod = method as AuthMethod & { args?: unknown; env?: unknown };
  const meta = authMethodMeta(method);
  const methodEnv = stringRecord(terminalMethod.env) ?? {};
  const metaEnv = stringRecord(meta?.env) ?? {};
  const metaArgs = stringArray(meta?.args);
  const command = typeof meta?.command === "string" && meta.command.length > 0
    ? meta.command
    : terminalAuthCommand(agent.command);
  return {
    label: authMethodName(method) ?? "Login",
    command,
    args: metaArgs.length > 0 ? metaArgs : stringArray(terminalMethod.args),
    env: {
      ...env,
      ...methodEnv,
      ...metaEnv,
    },
    cwd,
  };
}

function authEnvVars(method: AuthMethod): ProbeAgentAuthMethod["vars"] | undefined {
  if (authMethodType(method) !== "env_var") return undefined;
  const vars = (method as AuthMethod & { vars?: unknown }).vars;
  if (!Array.isArray(vars)) return undefined;
  const normalized = vars.flatMap((item): NonNullable<ProbeAgentAuthMethod["vars"]> => {
    if (!item || typeof item !== "object") return [];
    const typed = item as { name?: unknown; label?: unknown; secret?: unknown; optional?: unknown };
    if (typeof typed.name !== "string" || typed.name.length === 0) return [];
    return [{
      name: typed.name,
      ...(typeof typed.label === "string" && typed.label.length > 0 ? { label: typed.label } : {}),
      ...(typeof typed.secret === "boolean" ? { secret: typed.secret } : {}),
      ...(typeof typed.optional === "boolean" ? { optional: typed.optional } : {}),
    }];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function authMethodLink(method: AuthMethod): string | undefined {
  const link = (method as AuthMethod & { link?: unknown }).link;
  return typeof link === "string" && link.length > 0 ? link : undefined;
}

function apiKeyAuthMeta(method: AuthMethod): Record<string, unknown> | null {
  const meta = authMethodMeta(method);
  if (!meta) return null;
  const block = meta["api-key"];
  return isRecord(block) ? block : null;
}

function gatewayAuthMeta(method: AuthMethod): Record<string, unknown> | null {
  const meta = authMethodMeta(method);
  if (!meta) return null;
  return isRecord(meta.gateway) ? meta.gateway : null;
}

function authFormVars(method: AuthMethod): ProbeAgentAuthMethod["vars"] | undefined {
  if (apiKeyAuthMeta(method)) {
    return [{ name: "api-key", label: "API key", secret: true }];
  }
  if (gatewayAuthMeta(method)) {
    return [
      { name: "baseUrl", label: "Base URL" },
      { name: "api-key", label: "API key", secret: true },
      { name: "providerName", label: "Provider", optional: true },
    ];
  }
  return undefined;
}

function selectAuthMethod(authMethods: unknown, methodId?: string): AuthMethod | null {
  const methods = supportedAuthMethods(authMethods);
  if (!methodId) return methods[0] ?? null;
  return methods.find((method) => method.id === methodId) ?? null;
}

function isAuthRequiredError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const typed = error as { code?: unknown; message?: unknown };
  return (
    typed.code === ACP_AUTH_REQUIRED_CODE &&
    typeof typed.message === "string" &&
    /^Authentication required\b/i.test(typed.message)
  );
}

function authMethodName(method: AuthMethod | null): string | undefined {
  if (!method) return undefined;
  const name = (method as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function authMethodDescription(method: AuthMethod | null): string | undefined {
  if (!method) return undefined;
  const description = (method as { description?: unknown }).description;
  return typeof description === "string" && description.length > 0 ? description : undefined;
}

function inferredCredentialVars(method: AuthMethod): ProbeAgentAuthMethod["vars"] | undefined {
  const description = authMethodDescription(method);
  if (!description || !/\benvironment variable\b|\benv(?:ironment)? var\b/i.test(description)) return undefined;
  const names = [...new Set(
    [...description.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)]
      .flatMap((match) => match[1] ? [match[1]] : []),
  )];
  if (names.length === 0) return undefined;
  return names.map((name) => ({
    name,
    secret: /(?:^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/.test(name),
  }));
}

function credentialVars(method: AuthMethod): ProbeAgentAuthMethod["vars"] | undefined {
  return authEnvVars(method) ?? inferredCredentialVars(method);
}

function isCredentialPromptAuthMethod(method: AuthMethod): boolean {
  const type = authMethodType(method);
  return type === "env_var" || (type === "terminal" && Boolean(inferredCredentialVars(method)));
}

function missingCredentialVariableNames(
  method: AuthMethod,
  env: Record<string, string>,
): string[] {
  return (credentialVars(method) ?? [])
    .filter((variable) => variable.optional !== true)
    .map((variable) => variable.name)
    .filter((name) => !env[name]);
}

function publicAuthMethods(
  methods: AuthMethod[],
  agent: AgentSpec,
  env: Record<string, string>,
  cwd: string,
): ProbeAgentAuthMethod[] {
  return methods.map((method) => {
    const formVars = authFormVars(method);
    const vars = formVars ?? credentialVars(method);
    const type = isCredentialPromptAuthMethod(method) ? "env_var" : authMethodType(method);
    const form = formVars ? "fields" as const : undefined;
    const terminalLaunch = type === "terminal" ? terminalAuthFromMethod(method, agent, env, cwd) : null;
    return {
      id: method.id,
      ...(authMethodName(method) ? { name: authMethodName(method) } : {}),
      ...(authMethodDescription(method) ? { description: authMethodDescription(method) } : {}),
      type,
      ...(form ? { form } : {}),
      ...(vars ? { vars } : {}),
      ...(authMethodLink(method) ? { link: authMethodLink(method) } : {}),
      ...(terminalLaunch ? { terminalLaunch } : {}),
    };
  });
}

function authMethodStatusFields(
  method: AuthMethod,
  methods: AuthMethod[],
  agent: AgentSpec,
  env: Record<string, string>,
  cwd: string,
): Pick<ProbeAgentAuthStatus, "methodId" | "methodName" | "methods"> {
  const methodName = authMethodName(method);
  return {
    methodId: method.id,
    ...(methodName ? { methodName } : {}),
    methods: publicAuthMethods(methods, agent, env, cwd),
  };
}

function mergedStringEnv(
  ...envs: Array<Record<string, string | undefined> | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const env of envs) {
    for (const [key, value] of Object.entries(env ?? {})) {
      if (typeof value === "string") out[key] = value;
    }
  }
  return out;
}

function mergedSpawnEnv(
  ...envs: Array<Record<string, string | undefined> | undefined>
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const env of envs) Object.assign(out, env);
  return out;
}

function configOptionsFromResponse(value: NewSessionResponse | { configOptions?: SessionConfigOption[] | null } | undefined): SessionConfigOption[] {
  return sessionConfigOptionsFromResponse(value);
}

function configOptionsFromSessionUpdate(update: unknown): SessionConfigOption[] | null {
  if (!update || typeof update !== "object") return null;
  const typed = update as { sessionUpdate?: unknown; configOptions?: unknown };
  if (typed.sessionUpdate !== "config_option_update" || !Array.isArray(typed.configOptions)) return null;
  return typed.configOptions.map((option) => structuredClone(option));
}

function availableCommandsFromSessionUpdate(update: unknown): unknown[] | null {
  if (!update || typeof update !== "object") return null;
  const typed = update as {
    sessionUpdate?: unknown;
    availableCommands?: unknown;
    available_commands?: unknown;
  };
  if (typed.sessionUpdate !== "available_commands_update") return null;
  const commands = Array.isArray(typed.availableCommands)
    ? typed.availableCommands
    : Array.isArray(typed.available_commands)
      ? typed.available_commands
      : null;
  return commands?.map((command) => structuredClone(command)) ?? null;
}

function modesFromResponse(value: NewSessionResponse | { modes?: SessionModeState | null } | undefined): SessionModeState | null {
  return value?.modes ? structuredClone(value.modes) : null;
}

function modeFromSessionUpdate(update: unknown): string | null {
  if (!update || typeof update !== "object") return null;
  const typed = update as { sessionUpdate?: unknown; currentModeId?: unknown };
  if (typed.sessionUpdate !== "current_mode_update" || typeof typed.currentModeId !== "string") return null;
  return typed.currentModeId;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForSignalOrTimeout(
  signal: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function spawnAcpProbeAgent(
  options: {
    agent: AgentSpec;
    cwd: string;
    env?: Record<string, string | undefined>;
    spawner?: Spawner;
    client?: Client;
  },
): Promise<{
  agent: Agent;
  child: ChildHandle;
  env: Record<string, string>;
  diagnosticLines: string[];
  dispose: () => Promise<void>;
}> {
  const env = mergedStringEnv(options.agent.env, options.env);
  const spawnEnv = mergedSpawnEnv(options.agent.env, options.env);
  const diagnosticLines: string[] = [];
  const onDiagnosticLine = options.agent.onDiagnosticLine;
  const spawner = options.spawner ?? new NodeSpawner();
  const child = await spawner.spawn({
    ...options.agent,
    cwd: options.cwd,
    env: spawnEnv,
    onDiagnosticLine: (line) => {
      diagnosticLines.push(line);
      onDiagnosticLine?.(line);
    },
  });
  const stream = ndJsonStream(child.stdin, child.stdout);
  const agent: Agent = new ClientSideConnection(
    (): Client => options.client ?? {
      sessionUpdate: async () => undefined,
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    },
    stream,
  );
  let disposePromise: Promise<void> | null = null;
  const dispose = () => {
    disposePromise ??= withTimeout(
      child.kill(),
      5_000,
      "ACP setup process disposal timed out after 5000ms",
    ).catch(() => undefined).finally(() => {
      activeSetupConnections.delete(dispose);
    });
    return disposePromise;
  };
  activeSetupConnections.add(dispose);
  return {
    agent,
    child,
    env,
    diagnosticLines,
    dispose,
  };
}

export async function disposeAllAcpSetupProcesses(): Promise<void> {
  await Promise.allSettled(
    [...activeSetupConnections].map((dispose) => dispose()),
  );
}

function initializeAcpAgent(agent: Agent): Promise<InitializeResponse> {
  return Promise.resolve(agent.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: ACP_CLIENT_CAPABILITIES,
  }));
}

function createAcpProbeSession(agent: Agent, cwd: string): Promise<NewSessionResponse> {
  return Promise.resolve(agent.newSession({
    cwd,
    mcpServers: [],
  }));
}

function unauthenticatedDiagnostic(lines: string[]): string | null {
  for (const line of lines) {
    const plain = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim();
    if (/\bcreating session without credentials\b/i.test(plain)) {
      return plain.replace(/^.*?\bcreating session without credentials\b/i, "Creating session without credentials");
    }
    if (/\bagent may not work\b/i.test(plain) && /\bcredentials?\b/i.test(plain)) {
      return plain;
    }
  }
  return null;
}

async function allowDiagnosticsToFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

export async function probeAgentSessionConfig(
  options: ProbeAgentConfigOptionsOptions,
): Promise<ProbeAgentSessionConfigResult> {
  const cwd = options.cwd ?? join(tmpdir(), "clash-acp-probe");
  await mkdir(cwd, { recursive: true });

  let updatedConfigOptions: SessionConfigOption[] = [];
  let updatedAvailableCommands: unknown[] = [];
  let updatedModeId: string | null = null;
  let resolveAvailableCommands: (() => void) | null = null;
  const availableCommandsReady = new Promise<void>((resolve) => {
    resolveAvailableCommands = resolve;
  });
  const client: Client = {
    sessionUpdate: async (params) => {
      const next = configOptionsFromSessionUpdate(params.update);
      if (next) updatedConfigOptions = next;
      const commands = availableCommandsFromSessionUpdate(params.update);
      if (commands) {
        updatedAvailableCommands = commands;
        resolveAvailableCommands?.();
      }
      const modeId = modeFromSessionUpdate(params.update);
      if (modeId) updatedModeId = modeId;
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  };
  const connection = await spawnAcpProbeAgent({
    agent: options.agent,
    cwd,
    env: options.env,
    spawner: options.spawner,
    client,
  });
  const timeoutMs = options.timeoutMs ?? 15_000;
  const capabilitySettleMs = options.capabilitySettleMs ?? 750;
  try {
    return await withTimeout(
      (async () => {
        const initResult = await initializeAcpAgent(connection.agent);
        const methods = supportedAuthMethods(initResult.authMethods);
        const method = selectAuthMethod(initResult.authMethods);
        if (!method) {
          const declared = declaredAuthMethods(initResult.authMethods);
          if (declared.length > 0) {
            const unsupported = unsupportedAuthMethodTypes(declared);
            return {
              configOptions: [],
              availableCommands: [],
              auth: {
                status: "unknown" as const,
                message: unsupported.length > 0
                  ? `No supported ACP auth method is available. Unsupported methods: ${unsupported.join(", ")}.`
                  : "No supported ACP auth method is available.",
              },
            };
          }
        }
        const methodFields = method
          ? authMethodStatusFields(
              method,
              methods,
              options.agent,
              connection.env,
              cwd,
            )
          : {};
        if (method && isCredentialPromptAuthMethod(method)) {
          const missing = missingCredentialVariableNames(
            method,
            connection.env,
          );
          if (missing.length > 0) {
            return {
              configOptions: [],
              availableCommands: [],
              auth: {
                status: "needs-auth" as const,
                ...methodFields,
                message:
                  missing.length === 1
                    ? `Missing credential variable: ${missing[0]}.`
                    : `Missing credential variables: ${missing.join(", ")}.`,
              },
            };
          }
        }
        try {
          const session = await createAcpProbeSession(connection.agent, cwd);
          const responseConfigOptions = configOptionsFromResponse(session);
          const modes = modesFromResponse(session);
          await waitForSignalOrTimeout(
            availableCommandsReady,
            capabilitySettleMs,
          );
          await allowDiagnosticsToFlush();
          const diagnostic = unauthenticatedDiagnostic(
            connection.diagnosticLines,
          );
          return {
            configOptions: responseConfigOptions.length > 0 ? responseConfigOptions : updatedConfigOptions,
            availableCommands: updatedAvailableCommands,
            ...(modes ? { modes: updatedModeId ? { ...modes, currentModeId: updatedModeId } : modes } : {}),
            auth: diagnostic
              ? {
                  status: "needs-auth" as const,
                  ...methodFields,
                  message: diagnostic,
                }
              : method
                ? { status: "configured" as const, ...methodFields }
                : { status: "none" as const },
          };
        } catch (error) {
          if (isAuthRequiredError(error)) {
            return {
              configOptions: [],
              availableCommands: [],
              auth: {
                status: "needs-auth" as const,
                ...methodFields,
              },
            };
          }
          throw error;
        }
      })(),
      timeoutMs,
      `ACP agent config probe timed out after ${timeoutMs}ms`,
    );
  } finally {
    await connection.dispose();
  }
}

export async function probeAgentConfigOptions(
  options: ProbeAgentConfigOptionsOptions,
): Promise<SessionConfigOption[]> {
  return (await probeAgentSessionConfig(options)).configOptions;
}
