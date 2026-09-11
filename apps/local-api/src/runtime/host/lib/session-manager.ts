import { supportsAcpMessageFork, type AcpForkPoint } from "@clash/shared-types";
import {
  reconcileCodexModel,
  type ModelFallback,
} from "./codex-model-fallback.js";
/**
 * SessionManager — owns the ACP child processes the daemon is currently
 * running on this machine. Slice-2 minimum: one ACP runtime per session
 * (i.e. one child process per session). Multi-session-per-process
 * optimization defers to slice 3 because (a) it requires AcpSession to
 * hold N session ids and route events by sessionId, and (b) most users
 * have one chat at a time.
 *
 * Wire protocol (over the daemon ↔ control-plane WS, see daemon.ts):
 *
 *   Server → Daemon
 *     session.start    { session_id, agent_id, cwd, resume?: { acp_session_id } }
 *     session.prompt   { session_id, turn_id, text }
 *     session.cancel   { session_id, turn_id }
 *     session.dispose  { session_id }
 *
 *   Daemon → Server
 *     session.ready    { session_id, acp_session_id }
 *     session.event    { session_id, turn_id, event }
 *     session.diagnostic { session_id, turn_id?, diagnostic }
 *     session.complete { session_id, turn_id }
 *     session.error    { session_id, turn_id?, message }
 *     session.disposed { session_id }
 */

import type {
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  initialSessionLifecycle,
  reduceSessionLifecycle,
  type SessionLifecycle,
} from "@openma/common/session-kernel";
import { AcpRuntimeImpl } from "../_acp-runtime/index.js";
import { withClashAcpExtensionCapabilities } from "../_acp-runtime/client-capabilities.js";
import { NodeSpawner } from "../_acp-runtime/spawners/node.js";
import { ensureSessionScratchpad } from "./session-scratchpad.js";
import { detect } from "../_acp-runtime/registry.js";
import type { AcpSession, AgentSpec } from "../_acp-runtime/types.js";
import {
  ensureAgentCwd,
  readAgentRuntime,
  resolveAgentMcpServers,
} from "./session-cwd.js";

const DEFAULT_SESSION_CONTEXT_ID = "clash";

export interface SessionStartParams {
  session_id: string;
  /**
   * Optional bundled agent template id.
   */
  agent_template_id?: string;
  /**
   * Optional ACP agent catalog id (e.g. "codex-acp", "claude-acp",
   * "gemini"). When set, daemon spawns this agent instead of the one
   * the selected template's bundled runtime.json points at.
   */
  agent_id?: string;
  /**
   * Fully resolved ACP command from the host. Used for registry entries that
   * were discovered dynamically by the desktop app and are not compiled into
   * the local host's static fallback catalog.
   */
  agent_spec?: AgentSpec;
  /**
   * ACP-native configuration selected before the session starts. Apply these
   * before announcing readiness so the first prompt cannot observe defaults.
   */
  config_options?: Record<string, string | boolean>;
  /**
   * Harness-specific permission mode chosen by the desktop composer.
   * The ACP harness owns how this maps to its own config surface; the
   * local host only forwards the selected id as process env.
   */
  permission_mode?: string;
  /**
   * Server-side agent member id. Daemon injects it into the spawned
   * agent's env as CLASH_AGENT_MEMBER_ID for host-side attribution.
   */
  agent_member_id?: string;
  /**
   * Optional Clash project id. Different projects get isolated roots
   * (~/.clash/projects/<project>/). Sessions share that root and differ by
   * local transcript row / ACP session id, not by cwd.
   * Also injected into the agent's env as CLASH_PROJECT_ID so room
   * tools know which room to target.
   */
  project_id?: string;
  /** Server-supplied advisory cwd. Currently ignored — we always spawn
   * into the project workspace. */
  cwd?: string;
  resume?: { acp_session_id: string };
  fork?: { acp_session_id: string; point?: AcpForkPoint };
}

export interface SessionPromptParams {
  session_id: string;
  turn_id: string;
  text: string;
}

export function applyPermissionModeToAgentSpec(
  agentId: string,
  spec: AgentSpec,
  permissionMode?: string,
): AgentSpec {
  void agentId;
  if (!permissionMode) return spec;
  const env = {
    ...(spec.env ?? {}),
    CLASH_PERMISSION_MODE: permissionMode,
  };
  return { ...spec, env };
}

export function selectAcpPermissionOutcome(
  params: RequestPermissionRequest,
): RequestPermissionResponse {
  const option =
    params.options.find((candidate) => candidate.kind === "allow_always") ??
    params.options.find((candidate) => candidate.kind === "allow_once") ??
    params.options.find((candidate) =>
      /allow|approve|yes|continue/i.test(candidate.name ?? ""),
    ) ??
    params.options.find(
      (candidate) => !/deny|cancel|reject|no/i.test(candidate.name ?? ""),
    );
  return option?.optionId
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

type TrustedMcpRenderers = ReadonlyMap<string, string>;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trustedMcpRenderersFromServers(
  servers: readonly unknown[],
): Map<string, string> {
  const renderers = new Map<string, string>();
  for (const server of servers) {
    const descriptor = recordValue(server);
    const meta = recordValue(descriptor?._meta);
    if (
      typeof descriptor?.name === "string" &&
      meta?.["clash.plugin"] === "builtin" &&
      typeof meta["clash.renderer"] === "string"
    ) {
      renderers.set(descriptor.name, meta["clash.renderer"]);
    }
  }
  return renderers;
}

function annotateTrustedMcpEvent(
  event: unknown,
  renderers: TrustedMcpRenderers,
): unknown {
  if (renderers.size === 0) return event;
  const outer = recordValue(event);
  if (!outer) return event;
  const nested = recordValue(outer.update);
  const update = nested ?? outer;
  const updateType = update.sessionUpdate ?? outer.sessionUpdate;
  if (updateType !== "tool_call" && updateType !== "tool_call_update")
    return event;
  const meta = recordValue(update._meta) ?? {};
  const rawInput = recordValue(
    update.rawInput ?? update.raw_input ?? update.input,
  );
  const explicitMcp =
    meta.is_mcp_tool_call === true ||
    typeof meta.mcp_server_name === "string" ||
    typeof meta.mcpServerName === "string";
  if (!explicitMcp) return event;
  const serverName =
    typeof meta.mcp_server_name === "string"
      ? meta.mcp_server_name
      : typeof meta.mcpServerName === "string"
        ? meta.mcpServerName
        : typeof rawInput?.server === "string"
          ? rawInput.server
          : null;
  const renderer = serverName ? renderers.get(serverName) : undefined;
  if (!renderer) return event;
  const annotatedUpdate = {
    ...update,
    _meta: {
      ...meta,
      "clash.host_trusted_mcp": true,
      "clash.renderer": renderer,
    },
  };
  return nested ? { ...outer, update: annotatedUpdate } : annotatedUpdate;
}

export type AgentDiagnosticStatus =
  | {
      status: "reconnecting";
      message: string;
      attempt: number;
      maxAttempts: number;
      detail?: string;
    }
  | {
      status: "transport_fallback";
      message: string;
      detail?: string;
    };

export type AgentDiagnosticSeverity = "debug" | "info" | "warning" | "error";

export interface AgentDiagnostic {
  stream: "stderr";
  severity: AgentDiagnosticSeverity;
  raw: string;
  message: string;
  transientStatus?: AgentDiagnosticStatus;
}

function diagnosticDetail(line: string): string | undefined {
  if (/request timed out/i.test(line)) return "request timed out";
  if (/stream disconnected/i.test(line)) return "stream disconnected";
  return undefined;
}

function diagnosticSeverity(line: string): AgentDiagnosticSeverity {
  if (/\b(?:ERROR|ERR)\b/i.test(line)) return "error";
  if (/\bWARN(?:ING)?\b/i.test(line)) return "warning";
  if (/\b(?:DEBUG|TRACE)\b/i.test(line)) return "debug";
  return "info";
}

function diagnosticMessage(line: string): string {
  return line
    .trim()
    .replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s+/, "")
    .replace(
      /^(?:\[[^\]]+\]\s*)?(?:ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b[:\s-]*/i,
      "",
    )
    .trim();
}

export function parseAgentDiagnosticStatus(
  line: string,
): AgentDiagnosticStatus | null {
  const reconnectMatch =
    /\bReconnecting(?:\.\.\.)?\s*(\d+)\s*\/\s*(\d+)\b/i.exec(line) ??
    /\bretrying\b.*?\brequest\b.*?\((\d+)\s*\/\s*(\d+)/i.exec(line) ??
    /\bretry(?:ing)?\b.*?\((?:attempt\s*)?(\d+)\s*\/\s*(\d+)/i.exec(line);

  if (reconnectMatch) {
    const attempt = Number(reconnectMatch[1]);
    const maxAttempts = Number(reconnectMatch[2]);
    if (Number.isFinite(attempt) && Number.isFinite(maxAttempts)) {
      const detail = diagnosticDetail(line);
      return {
        status: "reconnecting",
        attempt,
        maxAttempts,
        message: `Reconnecting... ${attempt}/${maxAttempts}`,
        ...(detail ? { detail } : {}),
      };
    }
  }

  if (
    /Falling back from WebSockets to HTTPS transport/i.test(line) ||
    /\bfalling back to HTTP\b/i.test(line)
  ) {
    const detail = diagnosticDetail(line);
    return {
      status: "transport_fallback",
      message: "Switching transport",
      ...(detail ? { detail } : {}),
    };
  }

  return null;
}

export function parseAgentDiagnostic(line: string): AgentDiagnostic | null {
  const raw = line.trim();
  if (!raw) return null;
  const transientStatus = parseAgentDiagnosticStatus(raw) ?? undefined;
  return {
    stream: "stderr",
    severity: diagnosticSeverity(raw),
    raw,
    message: transientStatus?.message ?? (diagnosticMessage(raw) || raw),
    ...(transientStatus ? { transientStatus } : {}),
  };
}

/** Whatever the manager wants the daemon to send back over the WS. */
export type ManagerOut =
  | {
      type: "session.ready";
      session_id: string;
      acp_session_id: string;
      supports_session_fork: boolean;
      supports_message_fork?: boolean;
      config_options?: unknown[];
      model_fallback?: ModelFallback;
      modes?: unknown;
      replay_events?: unknown[];
    }
  | {
      type: "session.config_options";
      session_id: string;
      config_options: unknown[];
    }
  | { type: "session.mode"; session_id: string; modes: unknown }
  | {
      type: "session.diagnostic";
      session_id: string;
      turn_id?: string;
      diagnostic: AgentDiagnostic;
    }
  | {
      type: "session.status";
      session_id: string;
      turn_id?: string;
      status: AgentDiagnosticStatus["status"];
      message: string;
      detail?: string;
      attempt?: number;
      maxAttempts?: number;
    }
  | {
      type: "session.event";
      session_id: string;
      turn_id: string;
      event: unknown;
    }
  | { type: "session.complete"; session_id: string; turn_id: string }
  | { type: "session.cancelled"; session_id: string; turn_id: string }
  | {
      type: "session.error";
      session_id: string;
      turn_id?: string;
      message: string;
    }
  | { type: "session.disposed"; session_id: string };

export type Sender = (msg: ManagerOut) => void;
export type SessionPermissionBroker = (
  sessionId: string,
  params: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;
export type SessionElicitationBroker = (
  sessionId: string,
  params: CreateElicitationRequest,
) => Promise<CreateElicitationResponse>;

export interface SessionManagerOptions {
  requestPermission?: SessionPermissionBroker;
  requestElicitation?: SessionElicitationBroker;
}

interface ActiveSession {
  modelFallback?: ModelFallback;
  acp: AcpSession;
  trustedMcpRenderers: TrustedMcpRenderers;
  /** turnId → abort controller for cancel. */
  turns: Map<string, AbortController>;
  /** ACP prompt turns are request/response transactions and must not overlap
   * within one session. */
  promptQueue: Promise<void>;
  /** Disposal wins over every late prompt/start continuation. */
  disposed: boolean;
}

export interface SessionManagerEnv extends Record<string, string | undefined> {
  /** The local host passes its identity / configuration here so spawned agents
   *  can call back to clash. Currently just the API key + server URL. */
  CLASH_API_KEY?: string;
  CLASH_API_URL?: string;
}

export class SessionManager {
  #send: Sender;
  #spawner = new NodeSpawner();
  #runtime = new AcpRuntimeImpl(this.#spawner);
  #sessions = new Map<string, ActiveSession>();
  #lifecycles = new Map<string, SessionLifecycle>();
  #activeTurnBySession = new Map<string, string>();
  #lastDiagnosticBySession = new Map<string, string>();
  #requestPermission: SessionPermissionBroker;
  #requestElicitation: SessionElicitationBroker;
  /** session_id → Promise that resolves once start() has populated #sessions
   *  (or rejected if start failed). The server may push session.prompt
   *  before the corresponding session.start has finished the slow ACP
   *  newSession dance (claude-agent-acp with skills + history reloads can
   *  take 10–15s on a fresh cwd); without this queue, prompt() looks up
   *  the session, finds nothing, and silently aborts the turn. */
  #starting = new Map<string, Promise<void>>();
  #cancelledStarts = new Set<string>();
  #env: SessionManagerEnv = {};

  constructor(send: Sender, options: SessionManagerOptions = {}) {
    this.#send = send;
    this.#requestPermission =
      options.requestPermission ??
      (async (_sessionId, params) => selectAcpPermissionOutcome(params));
    this.#requestElicitation =
      options.requestElicitation ?? (async () => ({ action: "decline" }));
  }

  /** Update the env injected into every subsequent spawn. */
  setSpawnEnv(env: SessionManagerEnv): void {
    this.#env = env;
  }

  /** Swap the outbound sender (e.g. when WS reconnects with a fresh socket). */
  setSender(send: Sender): void {
    this.#send = send;
  }

  /** True iff a session with this id is currently alive on this daemon. */
  has(session_id: string): boolean {
    return this.#sessions.has(session_id);
  }

  #transition(
    sessionId: string,
    event: Parameters<typeof reduceSessionLifecycle>[1],
  ): void {
    const current =
      this.#lifecycles.get(sessionId) ?? initialSessionLifecycle(sessionId);
    this.#lifecycles.set(sessionId, reduceSessionLifecycle(current, event));
  }

  #sendReady(
    sessionId: string,
    session: ActiveSession,
    modes = session.acp.modes,
  ): void {
    this.#transition(sessionId, {
      type: "session.ready",
      acpSessionId: session.acp.acpSessionId,
    });
    this.#send({
      type: "session.ready",
      session_id: sessionId,
      acp_session_id: session.acp.acpSessionId,
      supports_session_fork: session.acp.supportsSessionFork,
      supports_message_fork: session.acp.supportsSessionFork && supportsAcpMessageFork(session.acp.agentInfo?.name, session.acp.agentInfo?.version),
      config_options: [...session.acp.configOptions],
      ...(session.modelFallback
        ? { model_fallback: session.modelFallback }
        : {}),
      ...(modes ? { modes } : {}),
      ...((session.acp.loadedReplayEvents?.length ?? 0) > 0
        ? {
            replay_events: session.acp.loadedReplayEvents!.map((event) =>
              annotateTrustedMcpEvent(event, session.trustedMcpRenderers),
            ),
          }
        : {}),
    });
  }

  #flushPendingSessionState(sessionId: string, session: ActiveSession): void {
    if (session.disposed) return;
    for (const event of session.acp.drainPendingEvents()) {
      this.#send({
        type: "session.event",
        session_id: sessionId,
        turn_id: "",
        event: annotateTrustedMcpEvent(event, session.trustedMcpRenderers),
      });
    }
  }

  /** Re-announce alive sessions to the server (used after WS reconnect). */
  announceAll(): void {
    for (const [sessionId, session] of this.#sessions) {
      this.#sendReady(sessionId, session);
      this.#flushPendingSessionState(sessionId, session);
    }
  }

  async start(p: SessionStartParams): Promise<void> {
    const existing = this.#sessions.get(p.session_id);
    if (existing) {
      this.#sendReady(p.session_id, existing);
      return;
    }
    const inFlight = this.#starting.get(p.session_id);
    if (inFlight) return inFlight;

    this.#transition(p.session_id, { type: "start.requested" });
    const startPromise = this.#startInner(p);
    this.#starting.set(p.session_id, startPromise);
    try {
      await startPromise;
    } finally {
      if (this.#starting.get(p.session_id) === startPromise) {
        this.#starting.delete(p.session_id);
        this.#cancelledStarts.delete(p.session_id);
      }
    }
  }

  async #startInner(p: SessionStartParams): Promise<void> {
    const agentTemplateId =
      p.agent_template_id?.trim() || DEFAULT_SESSION_CONTEXT_ID;
    // Resolve optional bundled template → default agent. Current Copilot
    // sends agent_id directly, so missing templates are fine in the common
    // path and the project cwd stays role-free.
    const tpl = await readAgentRuntime(agentTemplateId);
    if (!tpl && !p.agent_id) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        message: `unknown agent template: ${agentTemplateId}`,
      });
      return;
    }
    const resolvedAgentId = p.agent_id ?? tpl!.agent_id;
    const hostRuntimeEnv = {
      ...process.env,
      ...(p.agent_spec?.env ?? {}),
      ...this.#env,
    };
    const agent = p.agent_spec
      ? {
          id: resolvedAgentId,
          label: resolvedAgentId,
          spec: p.agent_spec,
        }
      : await detect(resolvedAgentId, {
          env: { ...process.env, ...this.#env },
        });
    if (!agent) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        message: `agent '${resolvedAgentId}' was not found. Install or enable it in Clash Desktop Settings > Runtimes.`,
      });
      return;
    }
    const resumeId = p.resume?.acp_session_id;
    // Workspace cwd: ~/.clash/projects/<project>/. Sessions are transcript
    // rows, not directories; different sessions for one project see the same
    // project files and app-owned `clash` shim.
    const sessionCwd = await ensureAgentCwd(
      agentTemplateId,
      p.project_id,
      { harnessId: resolvedAgentId },
      hostRuntimeEnv,
    );
    process.stderr.write(
      `  → SessionManager.start ${agent.spec.command}${resumeId ? ` (resume ${resumeId.slice(0, 8)}…)` : ""} cwd=${sessionCwd}\n`,
    );
    try {
      // Inject CLASH_API_KEY / CLASH_API_URL into the spawned agent's env.
      // Without these the bundled clash plugin's SessionStart hook
      // (`clash auth status`) prompts the user to log in, even though
      // the daemon itself is already authenticated.
      const spawnEnv: Record<string, string> = Object.fromEntries(
        Object.entries(agent.spec.env ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      for (const [key, value] of Object.entries(this.#env)) {
        if (value) spawnEnv[key] = value;
      }
      // Identity for host-side collaboration/session metadata. Local v1 no
      // longer exposes a local room CLI, but hosted runtimes may still use
      // these values for attribution.
      if (p.agent_member_id) spawnEnv.CLASH_AGENT_MEMBER_ID = p.agent_member_id;
      if (p.project_id) spawnEnv.CLASH_PROJECT_ID = p.project_id;
      // ACP harnesses may launch MCP subprocesses from their own directory.
      // Bind bundled Clash tools to this session's canonical working tree;
      // .clash/project.toml inside that tree remains the project authority.
      spawnEnv.CLASH_WORKSPACE_ROOT = sessionCwd;
      spawnEnv.CLASH_SESSION_SCRATCHPAD = await ensureSessionScratchpad(sessionCwd, p.session_id);
      const agentSpec = applyPermissionModeToAgentSpec(
        resolvedAgentId,
        agent.spec,
        p.permission_mode,
      );
      const runtimeEnv = { ...(agentSpec.env ?? {}), ...spawnEnv };
      const mcpServers = await resolveAgentMcpServers(
        agentTemplateId,
        runtimeEnv,
      );
      const trustedMcpRenderers = trustedMcpRenderersFromServers(mcpServers);
      if (trustedMcpRenderers.get("clash") !== "product") {
        throw new Error(
          "The bundled Clash MCP is unavailable. Self-host sessions require the built-in Clash MCP and cannot fall back to the shell CLI.",
        );
      }
      const session = await this.#runtime.start({
        agent: {
          ...agentSpec,
          cwd: sessionCwd,
          env: runtimeEnv,
          onDiagnosticLine: (line) =>
            this.#handleAgentDiagnostic(p.session_id, line),
        },
        resumeAcpSessionId: resumeId,
        forkFromAcpSessionId: p.fork?.acp_session_id,
        forkPoint: p.fork?.point,
        mcpServers,
        clientCapabilities: withClashAcpExtensionCapabilities({
          auth: { terminal: true },
          elicitation: { form: {}, url: {} },
        }),
        clientCallbacks: {
          requestPermission: (params) =>
            this.#requestPermission(p.session_id, params),
          createElicitation: (params: CreateElicitationRequest) =>
            this.#requestElicitation(p.session_id, params),
        },
      });
      if (this.#cancelledStarts.has(p.session_id)) {
        await session.dispose().catch(() => undefined);
        return;
      }
      const initialConfig = { ...p.config_options };
      const modelOption = session.configOptions.find(option => option.category === "model");
      const requestedModel = modelOption && initialConfig[modelOption.id];
      const modelFallback = resolvedAgentId === "codex-acp"
        ? await reconcileCodexModel(session, typeof requestedModel === "string" ? requestedModel : undefined)
        : undefined;
      if (modelFallback && modelOption) delete initialConfig[modelOption.id];
      for (const [configId, value] of Object.entries(initialConfig)) {
        await session.setConfigOption(configId, value);
      }
      if (this.#cancelledStarts.has(p.session_id)) {
        await session.dispose().catch(() => undefined);
        return;
      }
      let modes = session.modes;
      if (
        p.permission_mode &&
        modes?.availableModes.some((mode) => mode.id === p.permission_mode)
      ) {
        modes = await session.setMode(p.permission_mode);
      }
      if (this.#cancelledStarts.has(p.session_id)) {
        await session.dispose().catch(() => undefined);
        return;
      }
      process.stderr.write(
        `  ✓ agent ready, session id=${(session as unknown as { id?: string }).id}\n`,
      );
      const activeSession: ActiveSession = {
        acp: session,
        modelFallback,
        trustedMcpRenderers,
        turns: new Map(),
        promptQueue: Promise.resolve(),
        disposed: false,
      };
      this.#sessions.set(p.session_id, activeSession);
      // session.acpSessionId is the id the agent issued via session/new
      // (or echoed back via session/load). Server persists it to
      // runtime_session.acp_session_id so a future resume can re-attach.
      this.#sendReady(p.session_id, activeSession, modes);
      this.#flushPendingSessionState(p.session_id, activeSession);
      setTimeout(() => {
        if (this.#sessions.get(p.session_id) === activeSession) {
          this.#flushPendingSessionState(p.session_id, activeSession);
        }
      }, 50);
    } catch (e) {
      if (this.#cancelledStarts.has(p.session_id)) return;
      const message = e instanceof Error ? e.message : String(e);
      this.#transition(p.session_id, { type: "session.error", message });
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        message,
      });
    }
  }

  async prompt(p: SessionPromptParams): Promise<void> {
    // If the session is currently being started, wait for it. Server
    // often pushes session.prompt right after session.start (an idle
    // agent that just got @-mentioned has both frames queued), and
    // claude-agent-acp's newSession can take 10–15s on a populated
    // cwd. Without this wait, the prompt arrives before #sessions has
    // the entry and we'd silently 404 — turn disappears.
    const pending = this.#starting.get(p.session_id);
    if (pending) {
      try {
        await pending;
      } catch {
        /* start failed; falls through to no-such-session below */
      }
    }
    const sess = this.#sessions.get(p.session_id);
    if (!sess) {
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        turn_id: p.turn_id,
        message: "no such session",
      });
      return;
    }
    const run = async () => {
      if (sess.disposed) return;
      await this.#runPrompt(sess, p);
    };
    sess.promptQueue = sess.promptQueue.then(run, run);
    return sess.promptQueue;
  }

  async #runPrompt(sess: ActiveSession, p: SessionPromptParams): Promise<void> {
    const ctrl = new AbortController();
    this.#transition(p.session_id, {
      type: "prompt.requested",
      turnId: p.turn_id,
    });
    sess.turns.set(p.turn_id, ctrl);
    this.#activeTurnBySession.set(p.session_id, p.turn_id);
    this.#lastDiagnosticBySession.delete(p.session_id);
    try {
      // Native project instructions are loaded by the harness from AGENTS.md.
      // Never append host policy to the user's history on start/resume/compact.
      const promptContent: ContentBlock[] = [{ type: "text", text: p.text }];
      for await (const ev of sess.acp.prompt(promptContent, {
        abortSignal: ctrl.signal,
      })) {
        if (ctrl.signal.aborted || sess.disposed) break;
        // Filter out AcpSession's iterator-end sentinels — they're an
        // internal "the SDK promise resolved" marker, not real ACP
        // notifications. The outer session.complete / session.error
        // already conveys turn termination to the client. Forwarding
        // these would (a) show as raw_event clutter in the UI and
        // (b) confuse the parser that's looking for sessionUpdate-shaped
        // events.
        const t = (ev as { type?: string } | null | undefined)?.type;
        if (t === "promptComplete" || t === "promptError") continue;
        // DEV-ONLY raw event tap. Writes every ACP notification to a
        // JSONL file so we can ground-truth the wire shape without
        // round-tripping through the UI. Drop the import + this block
        // before publishing the local host; kept here while we polish the
        // parser. Guarded by CLASH_ACP_TAP env var to avoid disk
        // churn for users not debugging.
        if (process.env.CLASH_ACP_TAP) {
          try {
            const { appendFileSync } = await import("node:fs");
            appendFileSync(
              process.env.CLASH_ACP_TAP,
              JSON.stringify({
                ts: Date.now(),
                session_id: p.session_id,
                turn_id: p.turn_id,
                event: ev,
              }) + "\n",
              "utf-8",
            );
          } catch {
            /* tap is best-effort */
          }
        }
        this.#send({
          type: "session.event",
          session_id: p.session_id,
          turn_id: p.turn_id,
          event: annotateTrustedMcpEvent(ev, sess.trustedMcpRenderers),
        });
      }
      if (sess.disposed) return;
      if (ctrl.signal.aborted) {
        this.#transition(p.session_id, {
          type: "prompt.cancelled",
          turnId: p.turn_id,
        });
        this.#send({
          type: "session.cancelled",
          session_id: p.session_id,
          turn_id: p.turn_id,
        });
      } else {
        this.#transition(p.session_id, {
          type: "session.complete",
          turnId: p.turn_id,
        });
        this.#send({
          type: "session.complete",
          session_id: p.session_id,
          turn_id: p.turn_id,
        });
      }
    } catch (e) {
      if (sess.disposed) return;
      if (ctrl.signal.aborted) {
        this.#transition(p.session_id, {
          type: "prompt.cancelled",
          turnId: p.turn_id,
        });
        this.#send({
          type: "session.cancelled",
          session_id: p.session_id,
          turn_id: p.turn_id,
        });
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      this.#transition(p.session_id, {
        type: "session.error",
        turnId: p.turn_id,
        message,
      });
      this.#send({
        type: "session.error",
        session_id: p.session_id,
        turn_id: p.turn_id,
        message,
      });
    } finally {
      sess.turns.delete(p.turn_id);
      if (this.#activeTurnBySession.get(p.session_id) === p.turn_id) {
        this.#activeTurnBySession.delete(p.session_id);
      }
      this.#lastDiagnosticBySession.delete(p.session_id);
    }
  }

  #handleAgentDiagnostic(session_id: string, line: string): void {
    const diagnostic = parseAgentDiagnostic(line);
    if (!diagnostic) return;
    const turn_id = this.#activeTurnBySession.get(session_id);
    const key = JSON.stringify({ turn_id, diagnostic });
    if (this.#lastDiagnosticBySession.get(session_id) === key) return;
    this.#lastDiagnosticBySession.set(session_id, key);
    this.#send({
      type: "session.diagnostic",
      session_id,
      ...(turn_id ? { turn_id } : {}),
      diagnostic,
    });
  }

  cancel(session_id: string, turn_id: string): void {
    const sess = this.#sessions.get(session_id);
    if (!sess) return;
    const turn = sess.turns.get(turn_id);
    if (!turn) return;
    turn.abort();
    this.#transition(session_id, { type: "prompt.cancelled", turnId: turn_id });
  }

  async setConfigOption(
    session_id: string,
    config_id: string,
    value: string | boolean,
  ): Promise<void> {
    const pending = this.#starting.get(session_id);
    if (pending) {
      try {
        await pending;
      } catch {
        /* start failed; falls through to no-such-session below */
      }
    }
    const sess = this.#sessions.get(session_id);
    if (!sess) {
      this.#send({
        type: "session.error",
        session_id,
        message: "no such session",
      });
      return;
    }
    try {
      const configOptions = await sess.acp.setConfigOption(config_id, value);
      this.#send({
        type: "session.config_options",
        session_id,
        config_options: [...configOptions],
      });
    } catch (e) {
      this.#send({
        type: "session.error",
        session_id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async setMode(session_id: string, mode_id: string): Promise<void> {
    const pending = this.#starting.get(session_id);
    if (pending) {
      try {
        await pending;
      } catch {
        /* start failed; falls through to no-such-session below */
      }
    }
    const sess = this.#sessions.get(session_id);
    if (!sess) {
      this.#send({
        type: "session.error",
        session_id,
        message: "no such session",
      });
      return;
    }
    try {
      const modes = await sess.acp.setMode(mode_id);
      if (modes) {
        this.#send({
          type: "session.mode",
          session_id,
          modes,
        });
      }
    } catch (e) {
      this.#send({
        type: "session.error",
        session_id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async dispose(session_id: string): Promise<void> {
    const lifecycle = this.#lifecycles.get(session_id);
    if (lifecycle?.status === "disposed") return;
    const starting = this.#starting.get(session_id);
    if (starting) this.#cancelledStarts.add(session_id);
    await this.#killChild(session_id);
    if (starting) await starting.catch(() => undefined);
    this.#transition(session_id, { type: "session.disposed" });
    this.#send({ type: "session.disposed", session_id });
  }

  async #killChild(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.disposed = true;
    for (const controller of session.turns.values()) controller.abort();
    await session.acp.dispose().catch(() => undefined);
    if (this.#sessions.get(sessionId) === session) {
      this.#sessions.delete(sessionId);
    }
    this.#activeTurnBySession.delete(sessionId);
    this.#lastDiagnosticBySession.delete(sessionId);
  }

  /** App-shutdown barrier: includes both live sessions and children whose
   * initialize/new-session handshake is still in flight. */
  async disposeAll(): Promise<void> {
    const ids = new Set([...this.#sessions.keys(), ...this.#starting.keys()]);
    await Promise.allSettled([...ids].map((id) => this.dispose(id)));
  }
}
