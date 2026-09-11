import type { AcpForkPoint } from "@clash/shared-types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { visibleUserPromptText } from "@clash/shared-runtime";
import {
  createAgentUISessionRegistry,
  createAgentUIStore,
  replayAgentUIEventLog,
  type AgentUIState,
  type AgentUIStore,
  type PersistedAgentUIEvent,
} from "@openma/common/agent-ui";
import { useAgentUIState } from "@openma/common/agent-ui/react";
import { decodeAcpSessionUpdate } from "@openma/common/protocol/acp";
import {
  createOpenMAEvent,
  type OpenMAEvent,
} from "@openma/common/session-events/openma";
import {
  goalStateFromSessionInfoMetadata,
  mergeSessionInfoMetadata,
  parseAcpEvent,
  sessionInfoStateFromAcpEvent,
  usageStateFromAcpEvent,
  type ByoMessage,
  type AvailableCommand,
  type RuntimeGoalState,
  type RuntimeSessionUsage,
} from "@clash/web-ui/lib/acpEvents";
import type { RuntimeResumeSession } from "@clash/web-ui/lib/runtimeResume";
import { runtimeApiUrl, runtimeWebSocketUrl } from "../lib/runtimeConfig";
import {
  HARNESS_UPDATED_EVENT,
  SESSION_RESTART_COMPLETE_VISIBLE_MS,
  type SessionRestartMode,
  type SessionRestartPhase,
  type SessionRuntimeStatus,
} from "../lib/sessionRuntime";
import {
  applyRecentConfigPreferences,
  applyRecentModePreference,
  configValuesFromOptions,
  preferredRecentAgentId,
  type RunConfigValue,
} from "../lib/recentRunPreferences";

/**
 * useClashRuntime — chat through a registered local-runtime daemon.
 *
 * This hook drives the persistent-runtime path: list runtimes the user has registered →
 * pick one → POST /api/v1/runtimes/:rid/sessions → open WS to
 * /api/v1/local-sessions/:sid/_stream → relay prompts ↔ events.
 *
 * Same `ByoMessage[]` output shape so ChatbotCopilot's existing list
 * renderer works without changes.
 *
 * v1 scope:
 *   - One attached browser socket at a time. Switching sessions detaches
 *     the socket; the local ACP child stays alive until explicit shutdown.
 *   - No reconnect of the WS — drop = "disconnected", user re-selects
 *     the runtime to retry.
 */

export type RuntimeStatus = "online" | "offline";

export interface RuntimeAgentAuth {
  status: "configured" | "needs-auth" | "unknown";
  message: string;
  command?: string;
  methods?: RuntimeAgentAuthMethod[];
}

export interface RuntimeAgentAuthMethod {
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
}

export interface RuntimeProbeOptions {
  probe?: boolean | "auth" | "config" | "none";
  refresh?: boolean;
}

export interface RuntimeAgent {
  id: string;
  label?: string;
  binary?: string;
  version?: string;
  config_options?: AcpSessionConfigOption[];
  available_commands?: AvailableCommand[];
  session_modes?: AcpSessionModeState;
  auth?: RuntimeAgentAuth;
}

export interface RuntimeRunPreferences {
  agent_id?: string;
  config_by_agent: Record<string, Record<string, RunConfigValue>>;
  mode_by_agent: Record<string, string>;
}

export interface Runtime {
  id: string;
  machine_id: string;
  hostname: string;
  os: string;
  agents: RuntimeAgent[];
  preferences?: RuntimeRunPreferences;
  version: string;
  status: RuntimeStatus;
  last_heartbeat: number | null;
  created_at: number;
}

export type ClashRuntimeStatus =
  | "idle" // no runtime selected
  | "draft" // runtime/agent chosen, no ACP session created yet
  | "connecting" // POST /sessions in flight or waiting for session.ready
  | "connected" // session.ready received
  | "sending" // user prompt in flight
  | "streaming" // events arriving
  | "disconnected" // WS dropped or daemon went offline
  | "error";

export interface RuntimeTransientStatus {
  kind: "reconnecting" | "transport_fallback";
  message: string;
  detail?: string;
  attempt?: number;
  maxAttempts?: number;
}

export interface RuntimeDiagnostic {
  stream: "stderr";
  severity: "debug" | "info" | "warning" | "error";
  raw: string;
  message: string;
  transientStatus?: {
    status: RuntimeTransientStatus["kind"];
    message: string;
    detail?: string;
    attempt?: number;
    maxAttempts?: number;
  };
}

export type RuntimePromptQueueMode = "single" | "flush";

export interface RuntimeQueuedPrompt {
  id: string;
  turnId: string;
  text: string;
  createdAt: number;
}

interface RuntimeQueueUpdateQueuedPrompt {
  turn_id?: unknown;
  text?: unknown;
  created_at?: unknown;
}

export interface ClashRuntimeSelectOptions {
  projectId?: string;
  resumeAcpSessionId?: string;
  forkFromAcpSessionId?: string;
  forkPoint?: AcpForkPoint;
  freshSession?: boolean;
  agentId?: string;
  permissionModeId?: string;
}

export interface RuntimeSessionInfo {
  id: string;
  threadId: string;
  title?: string;
  type: "runtime";
  projectId?: string;
  runtimeId: string;
  agentId?: string | null;
  agentMemberId?: string;
  permissionMode?: string;
  acpSessionId?: string;
  supportsSessionFork?: boolean;
  status?: string;
  updatedAt?: string;
}

export interface AcpSessionConfigSelectValue {
  value: string;
  name: string;
  description?: string | null;
}

export interface AcpSessionConfigSelectGroup {
  group: string;
  name: string;
  options: AcpSessionConfigSelectValue[];
}

export interface AcpSessionConfigOption {
  id: string;
  name: string;
  type: string;
  category?: string | null;
  description?: string | null;
  currentValue?: string | boolean;
  options?: Array<AcpSessionConfigSelectValue | AcpSessionConfigSelectGroup>;
}

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string | null;
}

export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: AcpSessionMode[];
}

export interface RuntimePermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface RuntimePermissionRequest {
  requestId: string;
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: RuntimePermissionOption[];
}

export type RuntimeElicitationValue = string | number | boolean | string[];

export interface RuntimeElicitationProperty {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  default?: RuntimeElicitationValue;
  enum?: string[];
  oneOf?: Array<{ const: string; title: string }>;
  items?: { enum?: string[]; anyOf?: Array<{ const: string; title: string }> };
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

export interface RuntimeElicitationFormRequest {
  requestId: string;
  sessionId: string;
  mode: "form";
  message: string;
  toolCallId?: string;
  schema: {
    title?: string;
    description?: string;
    properties: Record<string, RuntimeElicitationProperty>;
    required: string[];
  };
}

export interface RuntimeElicitationUrlRequest {
  requestId: string;
  sessionId: string;
  mode: "url";
  message: string;
  elicitationId: string;
  url: string;
  toolCallId?: string;
}

export type RuntimeElicitationRequest =
  RuntimeElicitationFormRequest | RuntimeElicitationUrlRequest;

export type RuntimeElicitationResponse =
  | { action: "accept"; content?: Record<string, RuntimeElicitationValue> }
  | { action: "decline" | "cancel" };

export type RuntimeStartupStatus = "loading" | "ready" | "error";

export interface UseClashRuntimeReturn {
  /** All runtimes the user has registered (any status). */
  runtimes: Runtime[];
  /** Cold-start capability snapshot lifecycle. UI must not expose agent controls while loading. */
  startupStatus: RuntimeStartupStatus;
  /** id of the runtime the user picked, or null = none / cloud. */
  selectedRuntimeId: string | null;
  /** ACP agent id selected for the current local-runtime session. */
  selectedAgentId: string | null;
  /** id of the currently-open session (one at a time in v1). */
  sessionId: string | null;
  /** Current local-runtime task/session, if one is attached. */
  currentSession: RuntimeSessionInfo | null;
  status: ClashRuntimeStatus;
  errorMessage: string | null;
  transientStatus: RuntimeTransientStatus | null;
  diagnostics: RuntimeDiagnostic[];
  modelFallback: { from: string; to: string } | null;
  supportsMessageFork: boolean;
  /** Shared canonical state machine used by Backchat and Clash. */
  agentUIStore: AgentUIStore;
  agentUIState: AgentUIState;
  messages: ByoMessage[];
  /** Slash commands the agent currently advertises (replaced per
   *  available_commands_update event). UI uses this for the `/` picker. */
  availableCommands: AvailableCommand[];
  /** User prompts waiting for a safe point before being sent through ACP prompt. */
  promptQueue: RuntimeQueuedPrompt[];
  /** Whether follow-up prompts are product-queued while the current agent turn is running. */
  promptQueueEnabled: boolean;
  /** `single` drains one queued prompt per agent loop; `flush` drains all after the current loop. */
  promptQueueMode: RuntimePromptQueueMode;
  /** ACP-native session config options reported by the current agent. */
  sessionConfigOptions: AcpSessionConfigOption[];
  /** ACP-native session modes reported by the current agent. */
  sessionModes: AcpSessionModeState | null;
  /** Lossless, namespaced metadata announced through ACP session_info_update. */
  sessionInfoMeta: Record<string, unknown> | null;
  /** Harness-owned long-running Goal snapshot announced through session_info_update. */
  goal: RuntimeGoalState | null;
  /** Latest standard ACP context-window usage snapshot, kept outside the transcript. */
  sessionUsage: RuntimeSessionUsage | null;
  /** Blocking ACP permission requests, kept outside the transcript. */
  permissionRequests: RuntimePermissionRequest[];
  /** Blocking ACP structured-input requests, kept outside the transcript until answered. */
  elicitationRequests: RuntimeElicitationRequest[];
  /** Version state of the ACP child currently holding this session. */
  sessionRuntimeStatus: SessionRuntimeStatus | null;
  /** Restart lifecycle shown in the session-scoped update notice. */
  sessionRestartPhase: SessionRestartPhase;
  /** True iff status === connected/sending/streaming. */
  ready: boolean;
  /** Re-fetch the runtime list. Cheap; safe to call from a settings page. */
  refresh: (opts?: RuntimeProbeOptions) => Promise<void>;
  /** Pick a runtime plus an optional agent identity and project/resume target. */
  select: (
    runtimeId: string | null,
    agentMemberId?: string,
    opts?: ClashRuntimeSelectOptions,
  ) => Promise<void>;
  /** Prepare a blank local-runtime draft. The ACP session is created on first prompt. */
  startDraft: (
    runtimeId: string | null,
    agentMemberId?: string,
    opts?: ClashRuntimeSelectOptions,
  ) => void;
  /** Start the selected ACP draft without sending a user prompt (for capability-driven UI such as slash commands). */
  prepareSession?: () => void;
  /** Attach to an already-created local runtime session without creating or disposing it. */
  attachSession: (session: RuntimeSessionInfo) => Promise<void>;
  /** RPC the daemon for resumeable local CC sessions. Returns [] if the
   *  runtime is offline or the daemon doesn't respond. Used by the
   *  picker dialog so the user can pick "Resume X" instead of fresh. */
  loadResumeOptions: (runtimeId: string) => Promise<RuntimeResumeSession[]>;
  sendMessage: (text: string) => void;
  setPromptQueueEnabled: (enabled: boolean) => void;
  setPromptQueueMode: (mode: RuntimePromptQueueMode) => void;
  steerQueuedPrompt: (turnId: string) => void;
  updateQueuedPrompt: (turnId: string, text: string) => void;
  removeQueuedPrompt: (turnId: string) => void;
  reorderPromptQueue: (turnIds: string[]) => void;
  clearPromptQueue: () => void;
  setConfigOption: (configId: string, value: string | boolean) => void;
  setSessionMode: (modeId: string) => void;
  respondPermission: (requestId: string, optionId: string | null) => void;
  respondElicitation: (
    requestId: string,
    response: RuntimeElicitationResponse,
  ) => void;
  restartSession: (mode: SessionRestartMode) => Promise<void>;
  cancel: () => void;
  shutdown: () => void;
}

const RUNTIMES_PATH = "/api/v1/runtimes";
const SESSIONS_BASE = "/api/v1/local-sessions";
const PROMPT_QUEUE_ENABLED_STORAGE_KEY = "clash.runtimePromptQueue.enabled";
const PROMPT_QUEUE_ENABLED_EVENT = "clash-runtime-prompt-queue-enabled";

function readPromptQueueEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return (
      window.localStorage.getItem(PROMPT_QUEUE_ENABLED_STORAGE_KEY) !== "false"
    );
  } catch {
    return true;
  }
}

function runtimeTitleFromPrompt(text: string): string | null {
  const trimmed = visibleUserPromptText(text);
  if (!trimmed) return null;
  return trimmed.length > 52 ? `${trimmed.slice(0, 52)}...` : trimmed;
}

function shouldReplaceRuntimeSessionTitle(title: string | undefined): boolean {
  const trimmed = title?.trim();
  return !trimmed || trimmed === "New session";
}

function isAuthSetupMessage(message: string): boolean {
  return /\b(auth|authenticate|authentication|login|sign in)\b/i.test(message);
}

async function readRuntimeErrorMessage(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const fallback = res.clone();
    try {
      const json = (await res.json()) as { error?: unknown; message?: unknown };
      if (typeof json.error === "string" && json.error.trim())
        return json.error;
      if (typeof json.message === "string" && json.message.trim())
        return json.message;
    } catch {
      return fallback.text();
    }
  }
  return res.text();
}

interface CreateSessionResponse {
  session_id: string;
}

/** Non-visual product projection for titles and canvas side effects.
 * Runtime UI consumes `agentUIStore` directly;
 * this projection is never a second rendering source. */
export function projectAgentUIStateMessages(state: AgentUIState): ByoMessage[] {
  const messages: ByoMessage[] = [];
  for (const turnId of state.turnOrder) {
    const turn = state.turns[turnId];
    if (!turn) continue;
    if (turn.status === "queued") continue;
    const prompt = turn.items.find(
      (item) => item.kind === "message" && item.role === "user",
    );
    if (prompt?.kind === "message" && prompt.text) {
      messages.push({
        id: `user-${turn.id}`,
        role: "user",
        parts: [{ type: "text", text: prompt.text }],
      });
    }

    const parts: ByoMessage["parts"] = [];
    for (const item of turn.items) {
      if (item.kind === "message" && item.role === "assistant") {
        parts.push({
          type: "text",
          text: item.text,
          ...(item.messageId ? { messageId: item.messageId } : {}),
          ...(item.phase ? { phase: item.phase } : {}),
        });
      } else if (item.kind === "thinking") {
        parts.push({
          type: "thought",
          text: item.text,
          ...(item.messageId ? { messageId: item.messageId } : {}),
        });
      } else if (item.kind === "tool") {
        parts.push({
          type: "tool_call",
          toolCallId: item.id,
          ...(item.title ? { title: item.title } : {}),
          ...(item.toolKind ? { kind: item.toolKind } : {}),
          status: item.status,
          ...(item.rawInput !== undefined ? { rawInput: item.rawInput } : {}),
          ...(item.rawOutput !== undefined
            ? { rawOutput: item.rawOutput }
            : {}),
          ...(item.content ? { content: item.content as never[] } : {}),
          ...(item.locations ? { locations: item.locations } : {}),
          ...(item.adapterMeta ? { meta: item.adapterMeta } : {}),
        });
      } else if (item.kind === "raw") {
        const data = item.event.data as { payload?: unknown } | undefined;
        parts.push({ type: "raw_event", event: data?.payload ?? item.event });
      } else if (item.kind === "notice") {
        parts.push({ type: "event_note", title: item.text, tone: "neutral" });
      }
    }
    if (turn.status === "failed" && turn.error) {
      parts.push({ type: "event_note", title: turn.error, tone: "error" });
    }
    if (parts.length > 0)
      messages.push({ id: `asst-${turn.id}`, role: "assistant", parts });
  }
  return messages;
}

function canonicalRuntimeEvent({
  eventId,
  sessionId,
  turnId,
  harness,
  type,
  occurredAt,
  data,
}: {
  eventId: string;
  sessionId: string;
  turnId?: string;
  harness?: string | null;
  type: string;
  occurredAt: string;
  data: unknown;
}): OpenMAEvent {
  return createOpenMAEvent({
    event_id: eventId,
    type,
    session_id: sessionId,
    ...(turnId ? { turn_id: turnId } : {}),
    source: {
      kind: "harness",
      harness: harness ?? "acp",
      adapter: "clash-runtime",
    },
    occurred_at: occurredAt,
    data,
  }) as OpenMAEvent;
}

function decodeRuntimeAgentUIEvent(
  sessionId: string,
  input: unknown,
  context: Parameters<typeof decodeAcpSessionUpdate>[2],
): OpenMAEvent | null {
  const decoded = decodeAcpSessionUpdate(sessionId, input, context).event;
  const parsed = parseAcpEvent(input);
  if (
    parsed.kind === "silent" &&
    (decoded.type === "agent.message" ||
      decoded.type === "agent.message_chunk" ||
      decoded.type === "agent.thinking" ||
      decoded.type === "system.notice" ||
      decoded.type === "raw.event" ||
      decoded.type === "vendor.event")
  ) {
    return null;
  }
  return decoded;
}

function persistedEventData(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function decodePersistedRuntimeEvent(
  sessionId: string,
  harness: string | null,
  row: PersistedAgentUIEvent,
): OpenMAEvent | readonly OpenMAEvent[] | null {
  const data = persistedEventData(row.data);
  const turnId =
    typeof data.turn_id === "string" && data.turn_id.length > 0
      ? data.turn_id
      : undefined;
  const occurredAt = new Date(row.ts).toISOString();
  const canonical = (type: string, eventData: unknown, suffix = type) =>
    canonicalRuntimeEvent({
      eventId: `clash-history:${row.seq}:${suffix}`,
      sessionId,
      turnId,
      harness,
      type,
      occurredAt,
      data: eventData,
    });

  if (row.type === "openma_event") {
    return data as unknown as OpenMAEvent;
  }
  if (row.type === "user_prompt" && turnId) {
    const text = typeof data.text === "string" ? data.text : "";
    return [
      canonical(
        "user.message",
        {
          message_id: `user-${turnId}`,
          text,
        },
        "user",
      ),
      canonical("session.running", {}, "running"),
    ];
  }
  if (row.type === "session.event" && data.event !== undefined) {
    return decodeRuntimeAgentUIEvent(sessionId, data.event, {
      eventId: `clash-history:${row.seq}:acp`,
      occurredAt,
      ...(turnId ? { turnId } : {}),
      seq: row.seq,
      ...(harness ? { harness } : {}),
    });
  }
  if (row.type === "turn_completed" || row.type === "session.complete") {
    return turnId ? canonical("turn.completed", {}) : null;
  }
  if (row.type === "turn_cancelled" || row.type === "session.cancelled") {
    return turnId ? canonical("turn.cancelled", {}) : null;
  }
  if (
    row.type === "turn_failed" ||
    row.type === "prompt_error" ||
    row.type === "session.error"
  ) {
    const message =
      typeof data.message === "string"
        ? data.message
        : typeof data.error === "string"
          ? data.error
          : "Runtime turn failed";
    return canonical(turnId ? "turn.failed" : "session.error", { message });
  }
  return null;
}

function appendRuntimeError(
  messages: ByoMessage[],
  turnId: string | undefined,
  message: string,
): ByoMessage[] {
  const id = turnId
    ? `runtime-error-${turnId}`
    : `runtime-error-${Date.now().toString(36)}`;
  if (messages.some((candidate) => candidate.id === id)) return messages;
  return [
    ...messages,
    {
      id,
      role: "assistant",
      parts: [{ type: "event_note", title: message, tone: "error" }],
    },
  ];
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

function isAuthenticationFailure(
  code: string | undefined,
  message: string,
): boolean {
  return code === "auth_required" || ACP_AUTH_FAILURE_PATTERN.test(message);
}

function normalizeSessionConfigOptions(
  value: unknown,
): AcpSessionConfigOption[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(
      (option): option is Record<string, unknown> =>
        !!option && typeof option === "object",
    )
    .filter(
      (option) =>
        typeof option.id === "string" &&
        typeof option.name === "string" &&
        typeof option.type === "string",
    )
    .map((option) => ({
      id: String(option.id),
      name: String(option.name),
      type: String(option.type),
      ...(typeof option.category === "string" || option.category === null
        ? { category: option.category }
        : {}),
      ...(typeof option.description === "string" || option.description === null
        ? { description: option.description }
        : {}),
      ...(typeof option.currentValue === "string" ||
      typeof option.currentValue === "boolean"
        ? { currentValue: option.currentValue }
        : typeof option.current_value === "string" ||
            typeof option.current_value === "boolean"
          ? { currentValue: option.current_value }
          : {}),
      ...(Array.isArray(option.options)
        ? { options: option.options as AcpSessionConfigOption["options"] }
        : {}),
    }));
}

function normalizeSessionModes(value: unknown): AcpSessionModeState | null {
  if (!value || typeof value !== "object") return null;
  const modes = value as Record<string, unknown>;
  if (
    typeof modes.currentModeId !== "string" ||
    !Array.isArray(modes.availableModes)
  )
    return null;
  const availableModes = modes.availableModes
    .filter(
      (mode): mode is Record<string, unknown> =>
        !!mode && typeof mode === "object",
    )
    .filter(
      (mode) => typeof mode.id === "string" && typeof mode.name === "string",
    )
    .map((mode) => ({
      id: String(mode.id),
      name: String(mode.name),
      ...(typeof mode.description === "string" || mode.description === null
        ? { description: mode.description }
        : {}),
    }));
  return {
    currentModeId: modes.currentModeId,
    availableModes,
  };
}

function normalizeAvailableCommands(value: unknown): AvailableCommand[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(
      (command): command is Record<string, unknown> =>
        !!command &&
        typeof command === "object" &&
        typeof (command as Record<string, unknown>).name === "string",
    )
    .map((command) => ({
      name: String(command.name),
      ...(typeof command.description === "string"
        ? { description: command.description }
        : {}),
      ...(command.input && typeof command.input === "object"
        ? { input: command.input as AvailableCommand["input"] }
        : {}),
      ...(typeof command.kind === "string" ? { kind: command.kind } : {}),
      ...(typeof command.type === "string" ? { type: command.type } : {}),
      ...(typeof command.category === "string"
        ? { category: command.category }
        : {}),
      ...(typeof command.source === "string" ? { source: command.source } : {}),
      ...(command._meta &&
      typeof command._meta === "object" &&
      !Array.isArray(command._meta)
        ? { _meta: command._meta as Record<string, unknown> }
        : {}),
      ...(command.metadata && typeof command.metadata === "object"
        ? { metadata: command.metadata as Record<string, unknown> }
        : {}),
    }));
}

function normalizeRuntimeAgent(value: unknown): RuntimeAgent | null {
  if (!value || typeof value !== "object") return null;
  const agent = value as Record<string, unknown>;
  if (typeof agent.id !== "string") return null;
  const configOptions = normalizeSessionConfigOptions(
    agent.config_options ?? agent.configOptions,
  );
  const availableCommands = normalizeAvailableCommands(
    agent.available_commands ?? agent.availableCommands,
  );
  const sessionModes = normalizeSessionModes(
    agent.session_modes ?? agent.sessionModes,
  );
  const rawAuth =
    agent.auth && typeof agent.auth === "object"
      ? (agent.auth as Record<string, unknown>)
      : null;
  const authMethods = Array.isArray(rawAuth?.methods)
    ? rawAuth.methods.flatMap((candidate): RuntimeAgentAuthMethod[] => {
        if (
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        )
          return [];
        const method = candidate as Record<string, unknown>;
        if (typeof method.id !== "string" || method.id.length === 0) return [];
        const vars = Array.isArray(method.vars)
          ? method.vars.flatMap((candidateVar) => {
              if (
                !candidateVar ||
                typeof candidateVar !== "object" ||
                Array.isArray(candidateVar)
              )
                return [];
              const variable = candidateVar as Record<string, unknown>;
              if (
                typeof variable.name !== "string" ||
                variable.name.length === 0
              )
                return [];
              return [
                {
                  name: variable.name,
                  ...(typeof variable.label === "string"
                    ? { label: variable.label }
                    : {}),
                  ...(typeof variable.secret === "boolean"
                    ? { secret: variable.secret }
                    : {}),
                  ...(typeof variable.optional === "boolean"
                    ? { optional: variable.optional }
                    : {}),
                },
              ];
            })
          : undefined;
        return [
          {
            id: method.id,
            ...(typeof method.name === "string" ? { name: method.name } : {}),
            ...(typeof method.description === "string"
              ? { description: method.description }
              : {}),
            ...(typeof method.type === "string" ? { type: method.type } : {}),
            ...(method.form === "fields" ? { form: "fields" as const } : {}),
            ...(vars?.length ? { vars } : {}),
            ...(typeof method.link === "string" ? { link: method.link } : {}),
          },
        ];
      })
    : undefined;
  const auth =
    rawAuth &&
    (rawAuth.status === "configured" ||
      rawAuth.status === "needs-auth" ||
      rawAuth.status === "unknown") &&
    typeof rawAuth.message === "string"
      ? ({
          status: rawAuth.status,
          message: rawAuth.message,
          ...(typeof rawAuth.command === "string"
            ? { command: rawAuth.command }
            : {}),
          ...(authMethods?.length ? { methods: authMethods } : {}),
        } satisfies RuntimeAgentAuth)
      : null;
  return {
    id: agent.id,
    ...(typeof agent.label === "string" ? { label: agent.label } : {}),
    ...(typeof agent.binary === "string" ? { binary: agent.binary } : {}),
    ...(typeof agent.version === "string" ? { version: agent.version } : {}),
    ...(configOptions && configOptions.length > 0
      ? { config_options: configOptions }
      : {}),
    ...(availableCommands ? { available_commands: availableCommands } : {}),
    ...(sessionModes ? { session_modes: sessionModes } : {}),
    ...(auth ? { auth } : {}),
  };
}

function normalizeRunPreferences(value: unknown): RuntimeRunPreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const configByAgent: RuntimeRunPreferences["config_by_agent"] = {};
  if (
    raw.config_by_agent &&
    typeof raw.config_by_agent === "object" &&
    !Array.isArray(raw.config_by_agent)
  ) {
    for (const [agentId, candidate] of Object.entries(raw.config_by_agent)) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      )
        continue;
      configByAgent[agentId] = Object.fromEntries(
        Object.entries(candidate).filter(
          (entry): entry is [string, RunConfigValue] =>
            typeof entry[1] === "string" || typeof entry[1] === "boolean",
        ),
      );
    }
  }
  const modeByAgent =
    raw.mode_by_agent &&
    typeof raw.mode_by_agent === "object" &&
    !Array.isArray(raw.mode_by_agent)
      ? Object.fromEntries(
          Object.entries(raw.mode_by_agent).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  return {
    ...(typeof raw.agent_id === "string" && raw.agent_id.trim()
      ? { agent_id: raw.agent_id.trim() }
      : {}),
    config_by_agent: configByAgent,
    mode_by_agent: modeByAgent,
  };
}

function normalizeRuntime(value: unknown): Runtime | null {
  if (!value || typeof value !== "object") return null;
  const runtime = value as Record<string, unknown>;
  if (
    typeof runtime.id !== "string" ||
    typeof runtime.machine_id !== "string" ||
    typeof runtime.hostname !== "string" ||
    typeof runtime.os !== "string" ||
    typeof runtime.version !== "string" ||
    (runtime.status !== "online" && runtime.status !== "offline") ||
    typeof runtime.created_at !== "number"
  ) {
    return null;
  }
  const agents = Array.isArray(runtime.agents)
    ? runtime.agents
        .map(normalizeRuntimeAgent)
        .filter((agent): agent is RuntimeAgent => agent !== null)
    : [];
  const preferences = normalizeRunPreferences(runtime.preferences);
  return {
    id: runtime.id,
    machine_id: runtime.machine_id,
    hostname: runtime.hostname,
    os: runtime.os,
    agents,
    ...(preferences ? { preferences } : {}),
    version: runtime.version,
    status: runtime.status,
    last_heartbeat:
      typeof runtime.last_heartbeat === "number"
        ? runtime.last_heartbeat
        : null,
    created_at: runtime.created_at,
  };
}

function resolveRuntimeAgent(
  runtime: Runtime | undefined,
  agentId?: string | null,
): RuntimeAgent | null {
  if (!runtime) return null;
  if (agentId) {
    const match = runtime.agents.find((agent) => agent.id === agentId);
    if (match) return match;
  }
  const preferredId = preferredRecentAgentId(
    runtime.agents,
    runtime.preferences?.agent_id,
  );
  return runtime.agents.find((agent) => agent.id === preferredId) ?? null;
}

function seedConfigOptionsForAgent(
  runtime: Runtime | undefined,
  agentId?: string | null,
): AcpSessionConfigOption[] {
  const agent = resolveRuntimeAgent(runtime, agentId);
  if (!agent) return [];
  return applyRecentConfigPreferences(
    agent.config_options,
    runtime?.preferences?.config_by_agent[agent.id],
  );
}

function seedAvailableCommandsForAgent(
  runtime: Runtime | undefined,
  agentId?: string | null,
): AvailableCommand[] {
  return resolveRuntimeAgent(runtime, agentId)?.available_commands ?? [];
}

function seedSessionModesForAgent(
  runtime: Runtime | undefined,
  agentId?: string | null,
): AcpSessionModeState | null {
  const agent = resolveRuntimeAgent(runtime, agentId);
  if (!agent) return null;
  return applyRecentModePreference(
    agent.session_modes,
    runtime?.preferences?.mode_by_agent[agent.id],
  );
}

function configOptionsFromAcpEvent(
  event: unknown,
): AcpSessionConfigOption[] | null {
  const update =
    (event as { update?: unknown } | null | undefined)?.update ?? event;
  if (
    (update as { sessionUpdate?: unknown } | null | undefined)
      ?.sessionUpdate !== "config_option_update"
  )
    return null;
  return normalizeSessionConfigOptions(
    (update as { configOptions?: unknown } | null | undefined)?.configOptions,
  );
}

function modeIdFromAcpEvent(event: unknown): string | null {
  const update =
    (event as { update?: unknown } | null | undefined)?.update ?? event;
  if (
    (update as { sessionUpdate?: unknown } | null | undefined)
      ?.sessionUpdate !== "current_mode_update"
  )
    return null;
  const modeId = (update as { currentModeId?: unknown } | null | undefined)
    ?.currentModeId;
  return typeof modeId === "string" && modeId.length > 0 ? modeId : null;
}

function normalizePromptQueue(value: unknown): RuntimeQueuedPrompt[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(
      (prompt): prompt is RuntimeQueueUpdateQueuedPrompt =>
        !!prompt && typeof prompt === "object",
    )
    .filter(
      (prompt) =>
        typeof prompt.turn_id === "string" && typeof prompt.text === "string",
    )
    .map((prompt) => ({
      id: `queued-${prompt.turn_id}`,
      turnId: prompt.turn_id as string,
      text: prompt.text as string,
      createdAt:
        typeof prompt.created_at === "number" ? prompt.created_at : Date.now(),
    }));
}

function normalizeElicitationProperty(
  value: unknown,
): RuntimeElicitationProperty | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !["string", "number", "integer", "boolean", "array"].includes(
      String(raw.type),
    )
  )
    return null;
  const property: RuntimeElicitationProperty = {
    type: raw.type as RuntimeElicitationProperty["type"],
  };
  if (typeof raw.title === "string") property.title = raw.title;
  if (typeof raw.description === "string")
    property.description = raw.description;
  for (const key of [
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ] as const) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key]))
      property[key] = raw[key];
  }
  if (
    typeof raw.default === "string" ||
    typeof raw.default === "number" ||
    typeof raw.default === "boolean"
  ) {
    property.default = raw.default;
  } else if (
    Array.isArray(raw.default) &&
    raw.default.every((item) => typeof item === "string")
  ) {
    property.default = raw.default as string[];
  }
  if (
    Array.isArray(raw.enum) &&
    raw.enum.every((item) => typeof item === "string")
  ) {
    property.enum = raw.enum as string[];
  }
  const normalizeTitled = (
    items: unknown,
  ): Array<{ const: string; title: string }> | undefined =>
    Array.isArray(items)
      ? items.flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item))
            return [];
          const option = item as Record<string, unknown>;
          return typeof option.const === "string" &&
            typeof option.title === "string"
            ? [{ const: option.const, title: option.title }]
            : [];
        })
      : undefined;
  const oneOf = normalizeTitled(raw.oneOf);
  if (oneOf?.length) property.oneOf = oneOf;
  if (raw.items && typeof raw.items === "object" && !Array.isArray(raw.items)) {
    const items = raw.items as Record<string, unknown>;
    const values =
      Array.isArray(items.enum) &&
      items.enum.every((item) => typeof item === "string")
        ? (items.enum as string[])
        : undefined;
    const anyOf = normalizeTitled(items.anyOf);
    if (values?.length || anyOf?.length) {
      property.items = {
        ...(values ? { enum: values } : {}),
        ...(anyOf ? { anyOf } : {}),
      };
    }
  }
  return property;
}

function normalizeElicitationRequest(
  msg: Record<string, unknown>,
): RuntimeElicitationRequest | null {
  if (msg.mode === "url") {
    if (
      typeof msg.request_id !== "string" ||
      typeof msg.session_id !== "string" ||
      typeof msg.message !== "string" ||
      typeof msg.elicitation_id !== "string" ||
      typeof msg.url !== "string"
    )
      return null;
    try {
      const url = new URL(msg.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      return {
        requestId: msg.request_id,
        sessionId: msg.session_id,
        mode: "url",
        message: msg.message,
        elicitationId: msg.elicitation_id,
        url: url.toString(),
        ...(typeof msg.tool_call_id === "string"
          ? { toolCallId: msg.tool_call_id }
          : {}),
      };
    } catch {
      return null;
    }
  }
  if (
    msg.mode !== "form" ||
    typeof msg.request_id !== "string" ||
    typeof msg.session_id !== "string" ||
    typeof msg.message !== "string" ||
    !msg.requested_schema ||
    typeof msg.requested_schema !== "object" ||
    Array.isArray(msg.requested_schema)
  )
    return null;
  const rawSchema = msg.requested_schema as Record<string, unknown>;
  if (
    !rawSchema.properties ||
    typeof rawSchema.properties !== "object" ||
    Array.isArray(rawSchema.properties)
  )
    return null;
  const properties: Record<string, RuntimeElicitationProperty> = {};
  for (const [name, value] of Object.entries(
    rawSchema.properties as Record<string, unknown>,
  )) {
    const property = normalizeElicitationProperty(value);
    if (property) properties[name] = property;
  }
  if (Object.keys(properties).length === 0) return null;
  const required = Array.isArray(rawSchema.required)
    ? rawSchema.required.filter(
        (name): name is string =>
          typeof name === "string" && name in properties,
      )
    : [];
  return {
    requestId: msg.request_id,
    sessionId: msg.session_id,
    mode: "form",
    message: msg.message,
    ...(typeof msg.tool_call_id === "string"
      ? { toolCallId: msg.tool_call_id }
      : {}),
    schema: {
      ...(typeof rawSchema.title === "string"
        ? { title: rawSchema.title }
        : {}),
      ...(typeof rawSchema.description === "string"
        ? { description: rawSchema.description }
        : {}),
      properties,
      required,
    },
  };
}

export function useClashRuntime(): UseClashRuntimeReturn {
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [startupStatus, setStartupStatus] =
    useState<RuntimeStartupStatus>("loading");
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string | null>(
    null,
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentSession, setCurrentSession] =
    useState<RuntimeSessionInfo | null>(null);
  const [status, setStatus] = useState<ClashRuntimeStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transientStatus, setTransientStatus] =
    useState<RuntimeTransientStatus | null>(null);
  const [modelFallback, setModelFallback] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const [supportsMessageFork, setSupportsMessageFork] = useState(false);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostic[]>([]);
  const [agentUISessions] = useState(() => createAgentUISessionRegistry());
  const [agentUIStore, setAgentUIStoreState] = useState<AgentUIStore>(() =>
    createAgentUIStore("draft"),
  );
  const agentUIState = useAgentUIState(agentUIStore);
  const [availableCommands, setAvailableCommands] = useState<
    AvailableCommand[]
  >([]);
  const [promptQueue, setPromptQueue] = useState<RuntimeQueuedPrompt[]>([]);
  const [promptQueueEnabled, setPromptQueueEnabledState] = useState(
    readPromptQueueEnabled,
  );
  const [promptQueueMode, setPromptQueueModeState] =
    useState<RuntimePromptQueueMode>("single");
  const [sessionConfigOptions, setSessionConfigOptions] = useState<
    AcpSessionConfigOption[]
  >([]);
  const [sessionModes, setSessionModes] = useState<AcpSessionModeState | null>(
    null,
  );
  const [sessionInfoMeta, setSessionInfoMeta] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [goal, setGoal] = useState<RuntimeGoalState | null>(null);
  const [sessionUsage, setSessionUsage] = useState<RuntimeSessionUsage | null>(
    null,
  );
  const [permissionRequests, setPermissionRequests] = useState<
    RuntimePermissionRequest[]
  >([]);
  const [elicitationRequests, setElicitationRequests] = useState<
    RuntimeElicitationRequest[]
  >([]);
  const [sessionRuntimeStatus, setSessionRuntimeStatus] =
    useState<SessionRuntimeStatus | null>(null);
  const [sessionRestartPhase, setSessionRestartPhase] =
    useState<SessionRestartPhase>("idle");

  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const statusRef = useRef<ClashRuntimeStatus>("idle");
  const acpSessionIdRef = useRef<string | null>(null);
  const selectedAgentIdRef = useRef<string | null>(null);
  const agentUIStoreRef = useRef<AgentUIStore>(agentUIStore);
  const promptQueueRef = useRef<RuntimeQueuedPrompt[]>([]);
  const queuedPromptLookupRef = useRef(new Map<string, RuntimeQueuedPrompt>());
  const promptQueueEnabledRef = useRef(readPromptQueueEnabled());
  const promptQueueModeRef = useRef<RuntimePromptQueueMode>("single");
  const sessionInfoMetaRef = useRef<Record<string, unknown> | null>(null);
  const draftRef = useRef<{
    runtimeId: string;
    agentMemberId?: string;
    opts?: ClashRuntimeSelectOptions;
  } | null>(null);
  const pendingPromptRef = useRef<{ turnId: string; text: string } | null>(
    null,
  );
  const pendingTitleRef = useRef<string | null>(null);
  const pendingConfigOptionsRef = useRef(new Map<string, string | boolean>());
  const pendingSessionModeRef = useRef<string | null>(null);
  const runtimeSnapshotErrorRef = useRef<string | null>(null);
  const resendQueuedAfterRestartRef = useRef(false);
  const turnSeq = useRef(0);
  const runtimeEventSeq = useRef(0);
  const queuedPromptSeq = useRef(0);
  const activeTurnIds = useRef(new Set<string>());
  /** Monotonic selection token. Backchat keys lifecycle state by session;
   * this single-session surface uses the same rule by rejecting async work
   * started for an older selection. */
  const sessionOperationSeq = useRef(0);
  const historyLoadedSessionIds = useRef(new Set<string>());
  const restartSessionRef = useRef<
    ((mode: SessionRestartMode) => Promise<void>) | null
  >(null);
  const restartCompletionTimerRef = useRef<number | null>(null);

  const ready =
    status === "connected" || status === "sending" || status === "streaming";
  const messages = useMemo(
    () => projectAgentUIStateMessages(agentUIState),
    [agentUIState],
  );

  const replaceAgentUIStore = useCallback((next: AgentUIStore) => {
    agentUIStoreRef.current = next;
    setAgentUIStoreState(next);
  }, []);

  const dispatchRuntimeEvent = useCallback(
    (type: string, turnId: string | undefined, data: unknown) => {
      const store = agentUIStoreRef.current;
      const sessionId = store.getState().sessionId;
      const occurredAt = new Date().toISOString();
      const eventId = `clash-runtime:${++runtimeEventSeq.current}:${type}`;
      store.dispatch(
        canonicalRuntimeEvent({
          eventId,
          sessionId,
          turnId,
          harness: selectedAgentIdRef.current,
          type,
          occurredAt,
          data,
        }),
      );
    },
    [],
  );

  const setRuntimeAgentId = useCallback((next: string | null) => {
    selectedAgentIdRef.current = next;
    setSelectedAgentId(next);
  }, []);

  const setRuntimeSessionId = useCallback(
    (next: string | null) => {
      sessionIdRef.current = next;
      setSessionId(next);
      const nextStore = next
        ? agentUISessions.get(next)
        : createAgentUIStore("draft");
      if (agentUIStoreRef.current !== nextStore) replaceAgentUIStore(nextStore);
    },
    [agentUISessions, replaceAgentUIStore],
  );

  const setRuntimeStatus = useCallback(
    (
      next:
        ClashRuntimeStatus | ((prev: ClashRuntimeStatus) => ClashRuntimeStatus),
    ) => {
      const resolved =
        typeof next === "function" ? next(statusRef.current) : next;
      statusRef.current = resolved;
      setStatus(resolved);
    },
    [],
  );

  const hydrateRuntimeSessionHistory = useCallback(
    async (session: RuntimeSessionInfo, operation: number) => {
      if (historyLoadedSessionIds.current.has(session.id)) return;
      let response: Response;
      try {
        response = await fetch(
          runtimeApiUrl(
            `${SESSIONS_BASE}/${encodeURIComponent(session.id)}/events`,
          ),
          { credentials: "include" },
        );
      } catch {
        return;
      }
      if (
        !response.ok ||
        sessionOperationSeq.current !== operation ||
        sessionIdRef.current !== session.id
      ) {
        return;
      }
      const payload = (await response.json()) as { events?: unknown };
      if (!Array.isArray(payload.events)) return;
      const rows = payload.events.filter(
        (value): value is PersistedAgentUIEvent =>
          !!value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          typeof (value as { seq?: unknown }).seq === "number" &&
          typeof (value as { type?: unknown }).type === "string" &&
          typeof (value as { ts?: unknown }).ts === "number",
      );
      const store = agentUISessions.get(session.id);
      replayAgentUIEventLog(store, rows, (row) =>
        decodePersistedRuntimeEvent(session.id, session.agentId ?? null, row),
      );
      historyLoadedSessionIds.current.add(session.id);

      const firstPrompt = [...rows]
        .sort((left, right) => left.seq - right.seq)
        .find((row) => row.type === "user_prompt");
      const title = firstPrompt
        ? runtimeTitleFromPrompt(
            String(persistedEventData(firstPrompt.data).text ?? ""),
          )
        : null;
      if (title) {
        setCurrentSession((current) =>
          current?.id === session.id &&
          shouldReplaceRuntimeSessionTitle(current.title)
            ? { ...current, title }
            : current,
        );
      }
    },
    [agentUISessions],
  );

  const refresh = useCallback(async (opts: RuntimeProbeOptions = {}) => {
    try {
      const query = new URLSearchParams();
      if (opts.probe === true) query.set("probe", "1");
      else if (opts.probe && opts.probe !== "none")
        query.set("probe", opts.probe);
      if (opts.refresh) query.set("refresh", "1");
      const path = query.toString()
        ? `${RUNTIMES_PATH}?${query.toString()}`
        : RUNTIMES_PATH;
      const res = await fetch(runtimeApiUrl(path), { credentials: "include" });
      if (!res.ok) {
        throw new Error(`Runtime snapshot request failed: HTTP ${res.status}`);
      }
      const json = (await res.json()) as { runtimes?: unknown[] };
      const next = Array.isArray(json.runtimes)
        ? json.runtimes
            .map(normalizeRuntime)
            .filter((runtime): runtime is Runtime => runtime !== null)
        : [];
      setRuntimes(next);
      const draft = draftRef.current;
      if (statusRef.current === "draft" && draft) {
        const runtime = next.find(
          (candidate) => candidate.id === draft.runtimeId,
        );
        const agentId = draft.opts?.agentId;
        const configOptions = seedConfigOptionsForAgent(runtime, agentId).map(
          (option) => {
            const pendingValue = pendingConfigOptionsRef.current.get(option.id);
            return typeof pendingValue === "string" ||
              typeof pendingValue === "boolean"
              ? { ...option, currentValue: pendingValue }
              : option;
          },
        );
        setSessionConfigOptions(configOptions);
        setAvailableCommands(seedAvailableCommandsForAgent(runtime, agentId));
        setSessionModes(seedSessionModesForAgent(runtime, agentId));
      }
      const priorSnapshotError = runtimeSnapshotErrorRef.current;
      runtimeSnapshotErrorRef.current = null;
      if (priorSnapshotError) {
        setErrorMessage((current) =>
          current === priorSnapshotError ? null : current,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtimeSnapshotErrorRef.current = message;
      setErrorMessage(message);
      throw error;
    }
  }, []);

  const refreshSessionRuntimeStatus = useCallback(
    async (targetSessionId: string) => {
      try {
        const response = await fetch(
          runtimeApiUrl(
            `${SESSIONS_BASE}/${encodeURIComponent(targetSessionId)}/runtime-status`,
          ),
          { credentials: "include" },
        );
        if (!response.ok || sessionIdRef.current !== targetSessionId) return;
        setSessionRuntimeStatus(
          (await response.json()) as SessionRuntimeStatus,
        );
      } catch {
        // A status check must never disconnect an otherwise healthy ACP chat.
      }
    },
    [],
  );

  // The local host owns the cold-start capability barrier. Its ordinary
  // runtime list does not resolve until the single startup warmup settles.
  useEffect(() => {
    let cancelled = false;
    void refresh().then(
      () => {
        if (!cancelled) setStartupStatus("ready");
      },
      () => {
        if (!cancelled) setStartupStatus("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!sessionId) {
      setSessionRuntimeStatus(null);
      setSessionRestartPhase("idle");
      return undefined;
    }
    void refreshSessionRuntimeStatus(sessionId);
    const onHarnessUpdated = (event: Event) => {
      const harnessId = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (
        typeof harnessId !== "string" ||
        !currentSession?.agentId ||
        harnessId === currentSession.agentId
      ) {
        void refreshSessionRuntimeStatus(sessionId);
      }
    };
    window.addEventListener(HARNESS_UPDATED_EVENT, onHarnessUpdated);
    return () =>
      window.removeEventListener(HARNESS_UPDATED_EVENT, onHarnessUpdated);
  }, [currentSession?.agentId, refreshSessionRuntimeStatus, sessionId]);

  // Tear down on unmount so the WS doesn't leak across page changes.
  useEffect(() => {
    return () => {
      sessionOperationSeq.current += 1;
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      if (restartCompletionTimerRef.current !== null) {
        window.clearTimeout(restartCompletionTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const syncEnabled = (enabled: boolean) => {
      promptQueueEnabledRef.current = enabled;
      setPromptQueueEnabledState(enabled);
    };
    const onCustom = (event: Event) => {
      const enabled = (event as CustomEvent<{ enabled?: unknown }>).detail
        ?.enabled;
      if (typeof enabled === "boolean") syncEnabled(enabled);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === PROMPT_QUEUE_ENABLED_STORAGE_KEY)
        syncEnabled(event.newValue !== "false");
    };
    window.addEventListener(PROMPT_QUEUE_ENABLED_EVENT, onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PROMPT_QUEUE_ENABLED_EVENT, onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const handleAcpEvent = useCallback(
    (turnId: string | undefined, event: unknown) => {
      const store = agentUIStoreRef.current;
      const sessionId = store.getState().sessionId;
      const seq = ++runtimeEventSeq.current;
      const decoded = decodeRuntimeAgentUIEvent(sessionId, event, {
        eventId: `clash-runtime:${seq}:acp`,
        occurredAt: new Date().toISOString(),
        ...(turnId ? { turnId } : {}),
        seq,
        ...(selectedAgentIdRef.current
          ? { harness: selectedAgentIdRef.current }
          : {}),
      });
      if (decoded) store.dispatch(decoded);
    },
    [],
  );

  const replacePromptQueue = useCallback((next: RuntimeQueuedPrompt[]) => {
    for (const prompt of next)
      queuedPromptLookupRef.current.set(prompt.turnId, prompt);
    promptQueueRef.current = next;
    setPromptQueue(next);
  }, []);

  const clearPromptQueue = useCallback(() => {
    queuedPromptLookupRef.current.clear();
    replacePromptQueue([]);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "clear_prompt_queue" }));
    }
  }, [replacePromptQueue]);

  const makePrompt = useCallback(
    (text: string): RuntimeQueuedPrompt => ({
      id: `queued-${++queuedPromptSeq.current}-${Date.now().toString(36)}`,
      turnId: `t-${++turnSeq.current}-${Date.now().toString(36)}`,
      text,
      createdAt: Date.now(),
    }),
    [],
  );

  const appendUserMessage = useCallback(
    (turnId: string, text: string) => {
      dispatchRuntimeEvent("user.message", turnId, {
        message_id: `user-${turnId}`,
        text,
      });
      const nextTitle = runtimeTitleFromPrompt(text);
      if (nextTitle) {
        pendingTitleRef.current = nextTitle;
        setCurrentSession((session) => {
          if (!session || !shouldReplaceRuntimeSessionTitle(session.title))
            return session;
          return { ...session, title: nextTitle };
        });
      }
    },
    [dispatchRuntimeEvent],
  );

  const sendPromptFrame = useCallback(
    (
      prompt: Pick<RuntimeQueuedPrompt, "turnId" | "text">,
      opts: {
        queueMode?: RuntimePromptQueueMode;
        markActive?: boolean;
      } = {},
    ): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      if (opts.markActive !== false) {
        const priorActiveTurnId = activeTurnIds.current.values().next()
          .value as string | undefined;
        appendUserMessage(prompt.turnId, prompt.text);
        if (priorActiveTurnId && priorActiveTurnId !== prompt.turnId) {
          activeTurnIds.current.delete(priorActiveTurnId);
        }
        dispatchRuntimeEvent("session.running", prompt.turnId, {});
        activeTurnIds.current.add(prompt.turnId);
        setTransientStatus(null);
        setRuntimeStatus("sending");
      }
      ws.send(
        JSON.stringify({
          type: "prompt",
          turn_id: prompt.turnId,
          text: prompt.text,
          ...(opts.queueMode ? { queue_mode: opts.queueMode } : {}),
        }),
      );
      return true;
    },
    [appendUserMessage, dispatchRuntimeEvent, setRuntimeStatus],
  );

  const enqueuePrompt = useCallback(
    (prompt: RuntimeQueuedPrompt) => {
      if (
        promptQueueRef.current.some((queued) => queued.turnId === prompt.turnId)
      )
        return;
      replacePromptQueue([...promptQueueRef.current, prompt]);
    },
    [replacePromptQueue],
  );

  const sendQueuedPromptFrame = useCallback(
    (prompt: RuntimeQueuedPrompt): boolean => {
      appendUserMessage(prompt.turnId, prompt.text);
      const sent = sendPromptFrame(prompt, {
        queueMode: promptQueueModeRef.current,
        markActive: false,
      });
      if (sent) enqueuePrompt(prompt);
      return sent;
    },
    [appendUserMessage, enqueuePrompt, sendPromptFrame],
  );

  const setPromptQueueMode = useCallback((mode: RuntimePromptQueueMode) => {
    promptQueueModeRef.current = mode;
    setPromptQueueModeState(mode);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "set_prompt_queue_mode", queue_mode: mode }),
      );
    }
  }, []);

  const setPromptQueueEnabled = useCallback((enabled: boolean) => {
    promptQueueEnabledRef.current = enabled;
    setPromptQueueEnabledState(enabled);
    try {
      window.localStorage.setItem(
        PROMPT_QUEUE_ENABLED_STORAGE_KEY,
        enabled ? "true" : "false",
      );
    } catch {
      /* ignore unavailable storage */
    }
    window.dispatchEvent(
      new CustomEvent(PROMPT_QUEUE_ENABLED_EVENT, { detail: { enabled } }),
    );
  }, []);

  const closeSessionSocket = useCallback((opts: { dispose?: boolean } = {}) => {
    const ws = wsRef.current;
    if (opts.dispose && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "dispose" }));
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    wsRef.current = null;
  }, []);

  const resetRuntimeState = useCallback(
    (opts: { disposeSocket?: boolean } = {}) => {
      closeSessionSocket({ dispose: opts.disposeSocket });
      activeTurnIds.current.clear();
      queuedPromptLookupRef.current.clear();
      pendingPromptRef.current = null;
      pendingTitleRef.current = null;
      pendingSessionModeRef.current = null;
      runtimeSnapshotErrorRef.current = null;
      replaceAgentUIStore(createAgentUIStore("draft"));
      setAvailableCommands([]);
      replacePromptQueue([]);
      setSessionConfigOptions([]);
      setSessionModes(null);
      sessionInfoMetaRef.current = null;
      setSessionInfoMeta(null);
      setGoal(null);
      setSessionUsage(null);
      setPermissionRequests([]);
      setElicitationRequests([]);
      setSessionRuntimeStatus(null);
      setSessionRestartPhase("idle");
      setErrorMessage(null);
      setTransientStatus(null);
      setDiagnostics([]);
      setModelFallback(null);
      setSupportsMessageFork(false);
    },
    [closeSessionSocket, replaceAgentUIStore, replacePromptQueue],
  );

  const onWsMessage = useCallback(
    (data: unknown) => {
      let msg: {
        type: string;
        session_id?: string;
        acp_session_id?: string;
        supports_session_fork?: boolean;
        supports_message_fork?: boolean;
        turn_id?: string;
        event?: unknown;
        config_options?: unknown;
        model_fallback?: { from: string; to: string };
        modes?: unknown;
        message?: string;
        detail?: string;
        status?: string;
        attempt?: number;
        maxAttempts?: number;
        diagnostic?: RuntimeDiagnostic;
        daemon_online?: boolean;
        mode?: string;
        active_turn_id?: string | null;
        queued?: unknown;
        code?: string;
        agent_id?: string;
        auth?: unknown;
        request_id?: string;
        tool_call?: unknown;
        options?: unknown;
        option_id?: string | null;
        requested_schema?: unknown;
        tool_call_id?: string;
        action?: string;
        content?: unknown;
      };
      try {
        msg = JSON.parse(typeof data === "string" ? data : "");
      } catch {
        return;
      }

      switch (msg.type) {
        case "attached":
          // Daemon may or may not be online at this moment — we already
          // gated on `runtime.status === 'online'` before POSTing /sessions,
          // so don't re-surface here.
          return;
        case "session.ready":
          {
            setModelFallback(msg.model_fallback ?? null);
            setSupportsMessageFork(msg.supports_message_fork === true);
            const configOptions = normalizeSessionConfigOptions(
              msg.config_options,
            );
            if (configOptions) setSessionConfigOptions(configOptions);
            const modes = normalizeSessionModes(msg.modes);
            if (modes) setSessionModes(modes);
          }
          if (
            typeof msg.acp_session_id === "string" &&
            msg.acp_session_id.length > 0
          ) {
            acpSessionIdRef.current = msg.acp_session_id;
            setCurrentSession((session) =>
              session
                ? {
                    ...session,
                    acpSessionId: msg.acp_session_id,
                    supportsSessionFork: msg.supports_session_fork === true,
                    status: "active",
                  }
                : session,
            );
          }
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            for (const [configId, value] of pendingConfigOptionsRef.current) {
              wsRef.current.send(
                JSON.stringify({
                  type: "set_config_option",
                  config_id: configId,
                  value,
                }),
              );
            }
            pendingConfigOptionsRef.current.clear();
            const pendingModeId = pendingSessionModeRef.current;
            if (pendingModeId) {
              wsRef.current.send(
                JSON.stringify({
                  type: "set_session_mode",
                  mode_id: pendingModeId,
                }),
              );
              pendingSessionModeRef.current = null;
            }
            const pendingPrompt = pendingPromptRef.current;
            if (pendingPrompt) {
              pendingPromptRef.current = null;
              sendPromptFrame(pendingPrompt);
              for (const queued of promptQueueRef.current) {
                if (promptQueueEnabledRef.current) {
                  sendPromptFrame(queued, {
                    queueMode: promptQueueModeRef.current,
                    markActive: false,
                  });
                } else {
                  sendPromptFrame(queued);
                }
              }
              if (!promptQueueEnabledRef.current) {
                queuedPromptLookupRef.current.clear();
                replacePromptQueue([]);
              }
              return;
            }
            if (resendQueuedAfterRestartRef.current) {
              resendQueuedAfterRestartRef.current = false;
              for (const queued of promptQueueRef.current) {
                sendPromptFrame(queued, {
                  queueMode: promptQueueModeRef.current,
                  markActive: false,
                });
              }
            }
          }
          setRuntimeStatus("connected");
          return;
        case "session.config_options":
          {
            const configOptions = normalizeSessionConfigOptions(
              msg.config_options,
            );
            if (configOptions) setSessionConfigOptions(configOptions);
          }
          return;
        case "session.mode":
          {
            const modes = normalizeSessionModes(msg.modes);
            if (modes) setSessionModes(modes);
          }
          return;
        case "session.permission_request":
          if (
            typeof msg.request_id === "string" &&
            typeof msg.session_id === "string" &&
            msg.tool_call &&
            typeof msg.tool_call === "object" &&
            !Array.isArray(msg.tool_call) &&
            Array.isArray(msg.options)
          ) {
            const options = msg.options
              .filter(
                (option): option is Record<string, unknown> =>
                  !!option &&
                  typeof option === "object" &&
                  !Array.isArray(option),
              )
              .filter(
                (option) =>
                  typeof option.optionId === "string" &&
                  typeof option.name === "string" &&
                  typeof option.kind === "string",
              )
              .map((option) => ({
                optionId: option.optionId as string,
                name: option.name as string,
                kind: option.kind as string,
              }));
            if (options.length > 0) {
              const request: RuntimePermissionRequest = {
                requestId: msg.request_id,
                sessionId: msg.session_id,
                toolCall: msg.tool_call as Record<string, unknown>,
                options,
              };
              setPermissionRequests((current) => [
                ...current.filter(
                  (candidate) => candidate.requestId !== request.requestId,
                ),
                request,
              ]);
            }
          }
          return;
        case "session.permission_resolved":
          if (typeof msg.request_id === "string") {
            setPermissionRequests((current) =>
              current.filter((request) => request.requestId !== msg.request_id),
            );
          }
          return;
        case "session.elicitation_request":
          {
            const request = normalizeElicitationRequest(
              msg as Record<string, unknown>,
            );
            if (request) {
              setElicitationRequests((current) => [
                ...current.filter(
                  (candidate) => candidate.requestId !== request.requestId,
                ),
                request,
              ]);
            }
          }
          return;
        case "session.elicitation_resolved":
          if (typeof msg.request_id === "string") {
            setElicitationRequests((current) =>
              current.filter((request) => request.requestId !== msg.request_id),
            );
          }
          return;
        case "session.queue_update":
          if (msg.mode === "single" || msg.mode === "flush") {
            promptQueueModeRef.current = msg.mode;
            setPromptQueueModeState(msg.mode);
          }
          {
            const activeQueued =
              typeof msg.active_turn_id === "string" &&
              msg.active_turn_id.length > 0
                ? (promptQueueRef.current.find(
                    (queued) => queued.turnId === msg.active_turn_id,
                  ) ?? queuedPromptLookupRef.current.get(msg.active_turn_id))
                : null;
            if (activeQueued) {
              appendUserMessage(activeQueued.turnId, activeQueued.text);
              queuedPromptLookupRef.current.delete(activeQueued.turnId);
            }
            const queue = normalizePromptQueue(msg.queued);
            const nextQueue = queue ?? promptQueueRef.current;
            if (queue) replacePromptQueue(queue);
            if (
              typeof msg.active_turn_id === "string" &&
              msg.active_turn_id.length > 0
            ) {
              dispatchRuntimeEvent("session.running", msg.active_turn_id, {});
            }
          }
          if (
            typeof msg.active_turn_id === "string" &&
            msg.active_turn_id.length > 0
          ) {
            activeTurnIds.current.clear();
            activeTurnIds.current.add(msg.active_turn_id);
            setRuntimeStatus("sending");
          } else {
            activeTurnIds.current.clear();
            if (!promptQueueRef.current.length) setRuntimeStatus("connected");
          }
          return;
        case "session.status":
          if (
            msg.status === "reconnecting" ||
            msg.status === "transport_fallback"
          ) {
            setTransientStatus({
              kind: msg.status,
              message:
                msg.message ??
                (msg.status === "reconnecting"
                  ? "Reconnecting"
                  : "Switching transport"),
              ...(typeof msg.detail === "string" ? { detail: msg.detail } : {}),
              ...(typeof msg.attempt === "number"
                ? { attempt: msg.attempt }
                : {}),
              ...(typeof msg.maxAttempts === "number"
                ? { maxAttempts: msg.maxAttempts }
                : {}),
            });
          }
          return;
        case "session.diagnostic":
          if (msg.diagnostic) {
            setDiagnostics((prev) => [
              ...prev.slice(-99),
              msg.diagnostic as RuntimeDiagnostic,
            ]);
            const status = msg.diagnostic.transientStatus;
            if (
              status?.status === "reconnecting" ||
              status?.status === "transport_fallback"
            ) {
              setTransientStatus({
                kind: status.status,
                message: status.message,
                ...(typeof status.detail === "string"
                  ? { detail: status.detail }
                  : {}),
                ...(typeof status.attempt === "number"
                  ? { attempt: status.attempt }
                  : {}),
                ...(typeof status.maxAttempts === "number"
                  ? { maxAttempts: status.maxAttempts }
                  : {}),
              });
            }
          }
          return;
        case "session.event":
          {
            const configOptions = configOptionsFromAcpEvent(msg.event);
            if (configOptions) setSessionConfigOptions(configOptions);
            const currentModeId = modeIdFromAcpEvent(msg.event);
            if (currentModeId) {
              setSessionModes((prev) =>
                prev ? { ...prev, currentModeId } : prev,
              );
            }
            const sessionInfoPatch = sessionInfoStateFromAcpEvent(msg.event);
            const usagePatch = usageStateFromAcpEvent(msg.event);
            if (usagePatch) setSessionUsage(usagePatch);
            if (
              sessionInfoPatch &&
              (sessionInfoPatch.title !== undefined ||
                sessionInfoPatch.updatedAt !== undefined)
            ) {
              setCurrentSession((current) => {
                if (!current) return current;
                return {
                  ...current,
                  ...(sessionInfoPatch.title !== undefined
                    ? { title: sessionInfoPatch.title ?? undefined }
                    : {}),
                  ...(sessionInfoPatch.updatedAt !== undefined
                    ? { updatedAt: sessionInfoPatch.updatedAt ?? undefined }
                    : {}),
                };
              });
            }
            if (sessionInfoPatch?.metadata !== undefined) {
              const nextMetadata =
                sessionInfoPatch.metadata === null
                  ? null
                  : mergeSessionInfoMetadata(
                      sessionInfoMetaRef.current,
                      sessionInfoPatch.metadata,
                    );
              sessionInfoMetaRef.current = nextMetadata;
              setSessionInfoMeta(nextMetadata);
              setGoal(goalStateFromSessionInfoMetadata(nextMetadata));
            }
            const parsed = parseAcpEvent(msg.event);
            if (parsed.commands) setAvailableCommands(parsed.commands);
          }
          handleAcpEvent(msg.turn_id, msg.event);
          if (msg.turn_id) setRuntimeStatus("streaming");
          return;
        case "session.complete":
          if (msg.turn_id) {
            dispatchRuntimeEvent("turn.completed", msg.turn_id, {});
            activeTurnIds.current.delete(msg.turn_id);
          }
          setTransientStatus(null);
          if (activeTurnIds.current.size === 0) {
            if (promptQueueRef.current.length > 0) setRuntimeStatus("sending");
            else setRuntimeStatus("connected");
          }
          return;
        case "session.cancelled":
          if (msg.turn_id) {
            dispatchRuntimeEvent("turn.cancelled", msg.turn_id, {});
            activeTurnIds.current.delete(msg.turn_id);
          }
          setTransientStatus(null);
          if (activeTurnIds.current.size === 0) {
            if (promptQueueRef.current.length > 0) setRuntimeStatus("sending");
            else setRuntimeStatus("connected");
          }
          return;
        case "session.restart_ready":
          void restartSessionRef.current?.("now");
          return;
        case "session.error":
          {
            const message = redactAuthenticationError(
              msg.message ?? "unknown error",
            );
            const authRequired = isAuthenticationFailure(
              msg.code,
              msg.message ?? "",
            );
            if (authRequired) activeTurnIds.current.clear();
            else if (msg.turn_id) activeTurnIds.current.delete(msg.turn_id);
            if (authRequired) {
              setErrorMessage(null);
              void refresh({ probe: "config", refresh: true });
              setTransientStatus(null);
              setCurrentSession((session) =>
                session ? { ...session, status: "active" } : session,
              );
              setRuntimeStatus("connected");
              return;
            }
            setErrorMessage(message);
            setTransientStatus(null);
            if (msg.turn_id) {
              dispatchRuntimeEvent("turn.failed", msg.turn_id, { message });
            } else {
              dispatchRuntimeEvent("session.error", undefined, { message });
            }
            setCurrentSession((session) =>
              session ? { ...session, status: "error" } : session,
            );
          }
          setRuntimeStatus("error");
          return;
        case "session.disposed":
          setTransientStatus(null);
          setRuntimeStatus("idle");
          setRuntimeSessionId(null);
          setCurrentSession(null);
          return;
        case "daemon_offline":
          setTransientStatus(null);
          setRuntimeStatus("disconnected");
          setErrorMessage("runtime went offline");
          return;
        case "daemon_online":
          // No state change — we'd need to re-select to start a new session.
          return;
      }
    },
    [
      appendUserMessage,
      dispatchRuntimeEvent,
      handleAcpEvent,
      refresh,
      replacePromptQueue,
      sendPromptFrame,
    ],
  );

  const openSessionStream = useCallback(
    (id: string) => {
      const ws = new WebSocket(
        runtimeWebSocketUrl(
          `${SESSIONS_BASE}/${encodeURIComponent(id)}/_stream`,
        ),
      );
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;
        onWsMessage(ev.data);
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        setRuntimeStatus((s) => (s === "idle" ? s : "disconnected"));
      };
    },
    [onWsMessage],
  );

  const restartSession = useCallback(
    async (mode: SessionRestartMode) => {
      const targetSessionId = sessionIdRef.current;
      if (!targetSessionId) return;
      setSessionRestartPhase(mode === "after-turn" ? "pending" : "restarting");
      try {
        const response = await fetch(
          runtimeApiUrl(
            `${SESSIONS_BASE}/${encodeURIComponent(targetSessionId)}/restart`,
          ),
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode }),
          },
        );
        if (!response.ok)
          throw new Error(await readRuntimeErrorMessage(response));
        const result = (await response.json()) as { status?: unknown };
        if (result.status === "pending") {
          setSessionRuntimeStatus((current) =>
            current
              ? {
                  ...current,
                  restart_pending: true,
                }
              : current,
          );
          setSessionRestartPhase("pending");
          return;
        }

        closeSessionSocket();
        setRuntimeStatus("connecting");
        resendQueuedAfterRestartRef.current = promptQueueRef.current.length > 0;
        setSessionRuntimeStatus((current) =>
          current
            ? {
                ...current,
                running_version:
                  current.installed_version ?? current.running_version,
                restart_required: false,
                restart_pending: false,
                busy: false,
              }
            : current,
        );
        openSessionStream(targetSessionId);
        setSessionRestartPhase("complete");
        if (restartCompletionTimerRef.current !== null) {
          window.clearTimeout(restartCompletionTimerRef.current);
        }
        restartCompletionTimerRef.current = window.setTimeout(() => {
          setSessionRestartPhase("idle");
          restartCompletionTimerRef.current = null;
        }, SESSION_RESTART_COMPLETE_VISIBLE_MS);
      } catch (error) {
        setSessionRestartPhase("idle");
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [closeSessionSocket, openSessionStream, setRuntimeStatus],
  );
  restartSessionRef.current = restartSession;

  const createRuntimeSession = useCallback(
    async (
      runtimeId: string | null,
      agentMemberId?: string,
      opts?: ClashRuntimeSelectOptions,
    ) => {
      const operation = ++sessionOperationSeq.current;
      setRuntimeSessionId(null);
      const runtime = runtimeId
        ? runtimes.find((candidate) => candidate.id === runtimeId)
        : undefined;
      const resolvedAgent = resolveRuntimeAgent(runtime, opts?.agentId);
      const resolvedAgentId = resolvedAgent?.id ?? opts?.agentId ?? null;
      const effectiveConfigOptions = runtimeId
        ? seedConfigOptionsForAgent(runtime, resolvedAgentId).map((option) => {
            const pendingValue = pendingConfigOptionsRef.current.get(option.id);
            return typeof pendingValue === "string" ||
              typeof pendingValue === "boolean"
              ? { ...option, currentValue: pendingValue }
              : option;
          })
        : [];
      const effectiveModes = runtimeId
        ? seedSessionModesForAgent(runtime, resolvedAgentId)
        : null;
      const resolvedModeId =
        opts?.permissionModeId ??
        pendingSessionModeRef.current ??
        effectiveModes?.currentModeId;
      const resolvedOpts: ClashRuntimeSelectOptions | undefined =
        resolvedAgentId
          ? {
              ...(opts ?? {}),
              agentId: resolvedAgentId,
              ...(resolvedModeId ? { permissionModeId: resolvedModeId } : {}),
            }
          : opts;
      setSelectedRuntimeId(runtimeId);
      setRuntimeAgentId(runtimeId ? resolvedAgentId : null);
      setSessionConfigOptions(effectiveConfigOptions);
      setAvailableCommands(
        runtimeId
          ? seedAvailableCommandsForAgent(runtime, resolvedAgentId)
          : [],
      );
      setSessionModes(effectiveModes);
      if (!runtimeId) {
        acpSessionIdRef.current = null;
        setCurrentSession(null);
        setRuntimeStatus("idle");
        return;
      }

      for (const option of effectiveConfigOptions) {
        if (
          typeof option.currentValue === "string" ||
          typeof option.currentValue === "boolean"
        ) {
          pendingConfigOptionsRef.current.set(option.id, option.currentValue);
        }
      }
      setRuntimeStatus("connecting");
      try {
        const sessionContextId = agentMemberId?.trim() || undefined;
        const resumeAcpSessionId = resolvedOpts?.freshSession
          ? undefined
          : resolvedOpts?.resumeAcpSessionId;
        const forkFromAcpSessionId = resolvedOpts?.freshSession
          ? undefined
          : resolvedOpts?.forkFromAcpSessionId;
        acpSessionIdRef.current = resumeAcpSessionId ?? null;
        const res = await fetch(
          runtimeApiUrl(`${RUNTIMES_PATH}/${runtimeId}/sessions`),
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...(sessionContextId
                ? { agent_member_id: sessionContextId }
                : {}),
              ...(resolvedOpts?.agentId
                ? { agent_id: resolvedOpts.agentId }
                : {}),
              ...(effectiveConfigOptions.length > 0
                ? {
                    config_values: configValuesFromOptions(
                      effectiveConfigOptions,
                    ),
                  }
                : {}),
              ...(resolvedOpts?.permissionModeId
                ? { permission_mode: resolvedOpts.permissionModeId }
                : {}),
              ...(resolvedOpts?.projectId
                ? { project_id: resolvedOpts.projectId }
                : {}),
              ...(resumeAcpSessionId
                ? { resume_session_id: resumeAcpSessionId }
                : {}),
              ...(forkFromAcpSessionId
                ? { fork_session_id: forkFromAcpSessionId, ...(resolvedOpts?.forkPoint ? { fork_point: resolvedOpts.forkPoint } : {}) }
                : {}),
            }),
          },
        );
        if (sessionOperationSeq.current !== operation) return;
        if (!res.ok) {
          const message = await readRuntimeErrorMessage(res);
          if (isAuthSetupMessage(message)) {
            void refresh({ probe: "config", refresh: true });
          }
          setErrorMessage(`session create failed: ${message.slice(0, 200)}`);
          setRuntimeStatus("error");
          return;
        }
        const json = (await res.json()) as CreateSessionResponse;
        if (sessionOperationSeq.current !== operation) return;
        // The draft is a one-shot session creation intent. Keeping it after a
        // successful create makes a later socket drop turn the next prompt
        // into another POST /sessions instead of reconnecting this session.
        draftRef.current = null;
        setRuntimeSessionId(json.session_id);
        const pendingPrompt = pendingPromptRef.current;
        if (pendingPrompt) {
          appendUserMessage(pendingPrompt.turnId, pendingPrompt.text);
          dispatchRuntimeEvent("session.running", pendingPrompt.turnId, {});
        }
        setCurrentSession({
          id: json.session_id,
          threadId: json.session_id,
          type: "runtime",
          title: pendingTitleRef.current ?? "New session",
          ...(resolvedOpts?.projectId
            ? { projectId: resolvedOpts.projectId }
            : {}),
          runtimeId,
          agentId: resolvedAgentId,
          ...(sessionContextId ? { agentMemberId: sessionContextId } : {}),
          ...(resolvedOpts?.permissionModeId
            ? { permissionMode: resolvedOpts.permissionModeId }
            : {}),
          ...(resumeAcpSessionId ? { acpSessionId: resumeAcpSessionId } : {}),
          status: "active",
        });

        openSessionStream(json.session_id);
      } catch (e) {
        if (sessionOperationSeq.current !== operation) return;
        setErrorMessage(e instanceof Error ? e.message : String(e));
        setRuntimeStatus("error");
      }
    },
    [
      appendUserMessage,
      dispatchRuntimeEvent,
      openSessionStream,
      runtimes,
      setRuntimeAgentId,
    ],
  );

  const select = useCallback(
    async (
      runtimeId: string | null,
      agentMemberId?: string,
      opts?: ClashRuntimeSelectOptions,
    ) => {
      resetRuntimeState();
      draftRef.current = null;
      pendingConfigOptionsRef.current.clear();
      await createRuntimeSession(runtimeId, agentMemberId, opts);
    },
    [createRuntimeSession, resetRuntimeState],
  );

  const startDraft = useCallback(
    (
      runtimeId: string | null,
      agentMemberId?: string,
      opts?: ClashRuntimeSelectOptions,
    ) => {
      sessionOperationSeq.current += 1;
      resetRuntimeState();
      acpSessionIdRef.current = null;
      pendingConfigOptionsRef.current.clear();
      setRuntimeSessionId(null);
      setCurrentSession(null);
      const runtime = runtimeId
        ? runtimes.find((candidate) => candidate.id === runtimeId)
        : undefined;
      const resolvedAgent = resolveRuntimeAgent(runtime, opts?.agentId);
      const resolvedAgentId = resolvedAgent?.id ?? opts?.agentId ?? null;
      const effectiveConfigOptions = runtimeId
        ? seedConfigOptionsForAgent(runtime, resolvedAgentId)
        : [];
      const effectiveModes = runtimeId
        ? seedSessionModesForAgent(runtime, resolvedAgentId)
        : null;
      const resolvedModeId =
        opts?.permissionModeId ?? effectiveModes?.currentModeId;
      const resolvedOpts: ClashRuntimeSelectOptions | undefined =
        resolvedAgentId
          ? {
              ...(opts ?? {}),
              agentId: resolvedAgentId,
              ...(resolvedModeId ? { permissionModeId: resolvedModeId } : {}),
            }
          : opts;
      setSelectedRuntimeId(runtimeId);
      setRuntimeAgentId(runtimeId ? resolvedAgentId : null);
      setSessionConfigOptions(effectiveConfigOptions);
      setAvailableCommands(
        runtimeId
          ? seedAvailableCommandsForAgent(runtime, resolvedAgentId)
          : [],
      );
      setSessionModes(effectiveModes);
      if (!runtimeId) {
        draftRef.current = null;
        setRuntimeStatus("idle");
        return;
      }
      draftRef.current = {
        runtimeId,
        ...(agentMemberId ? { agentMemberId } : {}),
        opts: resolvedOpts,
      };
      setRuntimeStatus("draft");
    },
    [resetRuntimeState, runtimes, setRuntimeAgentId],
  );

  const attachSession = useCallback(
    async (session: RuntimeSessionInfo) => {
      const operation = ++sessionOperationSeq.current;
      resetRuntimeState();
      draftRef.current = null;
      const runtime = runtimes.find(
        (candidate) => candidate.id === session.runtimeId,
      );
      setSelectedRuntimeId(session.runtimeId);
      setRuntimeAgentId(session.agentId ?? null);
      setSessionConfigOptions(
        seedConfigOptionsForAgent(runtime, session.agentId),
      );
      setAvailableCommands(
        seedAvailableCommandsForAgent(runtime, session.agentId),
      );
      setSessionModes(seedSessionModesForAgent(runtime, session.agentId));
      setRuntimeSessionId(session.id);
      setCurrentSession(session);
      acpSessionIdRef.current = session.acpSessionId ?? null;
      setRuntimeStatus("connecting");

      await hydrateRuntimeSessionHistory(session, operation);
      if (sessionOperationSeq.current !== operation) return;

      const attach = await fetch(
        runtimeApiUrl(
          `/api/v1/local-sessions/${encodeURIComponent(session.id)}/_attach`,
        ),
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (sessionOperationSeq.current !== operation) return;
      if (!attach.ok) {
        const message = await readRuntimeErrorMessage(attach);
        setErrorMessage(`session attach failed: ${message.slice(0, 200)}`);
        setRuntimeStatus("error");
        return;
      }
      openSessionStream(session.id);
    },
    [
      hydrateRuntimeSessionHistory,
      openSessionStream,
      resetRuntimeState,
      runtimes,
      setRuntimeAgentId,
    ],
  );

  const sendMessage = useCallback(
    (text: string) => {
      const prompt = makePrompt(text);

      const ws = wsRef.current;
      if ((!ws || ws.readyState !== WebSocket.OPEN) && draftRef.current) {
        if (pendingPromptRef.current) {
          appendUserMessage(prompt.turnId, prompt.text);
          enqueuePrompt(prompt);
          return;
        }
        pendingPromptRef.current = { turnId: prompt.turnId, text: prompt.text };
        appendUserMessage(prompt.turnId, prompt.text);
        dispatchRuntimeEvent("session.running", prompt.turnId, {});
        setTransientStatus(null);
        setRuntimeStatus("connecting");
        const draft = draftRef.current;
        void createRuntimeSession(
          draft.runtimeId,
          draft.agentMemberId,
          draft.opts,
        );
        return;
      }

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        const currentSessionId = sessionIdRef.current;
        if (currentSessionId) {
          pendingPromptRef.current = {
            turnId: prompt.turnId,
            text: prompt.text,
          };
          appendUserMessage(prompt.turnId, prompt.text);
          dispatchRuntimeEvent("session.running", prompt.turnId, {});
          setTransientStatus(null);
          setRuntimeStatus("connecting");
          openSessionStream(currentSessionId);
          return;
        }
        setErrorMessage("not connected");
        setRuntimeStatus("error");
        return;
      }

      const currentStatus = statusRef.current;
      if (currentStatus === "connecting") {
        if (!pendingPromptRef.current && activeTurnIds.current.size === 0) {
          pendingPromptRef.current = {
            turnId: prompt.turnId,
            text: prompt.text,
          };
          appendUserMessage(prompt.turnId, prompt.text);
          dispatchRuntimeEvent("session.running", prompt.turnId, {});
          setTransientStatus(null);
        } else {
          appendUserMessage(prompt.turnId, prompt.text);
          enqueuePrompt(prompt);
        }
        return;
      }
      if (
        promptQueueEnabledRef.current &&
        (activeTurnIds.current.size > 0 ||
          currentStatus === "sending" ||
          currentStatus === "streaming")
      ) {
        sendQueuedPromptFrame(prompt);
        return;
      }
      sendPromptFrame(prompt);
    },
    [
      appendUserMessage,
      createRuntimeSession,
      dispatchRuntimeEvent,
      enqueuePrompt,
      makePrompt,
      openSessionStream,
      sendPromptFrame,
      sendQueuedPromptFrame,
    ],
  );

  const prepareSession = useCallback(() => {
    if (statusRef.current !== "draft" || !draftRef.current) return;
    setTransientStatus(null);
    setRuntimeStatus("connecting");
    const draft = draftRef.current;
    void createRuntimeSession(draft.runtimeId, draft.agentMemberId, draft.opts);
  }, [createRuntimeSession, setRuntimeStatus]);

  const steerQueuedPrompt = useCallback(
    (turnId: string) => {
      const queued =
        promptQueueRef.current.find((prompt) => prompt.turnId === turnId) ??
        queuedPromptLookupRef.current.get(turnId);
      if (!queued) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setErrorMessage("not connected");
        setRuntimeStatus("error");
        return;
      }
      ws.send(JSON.stringify({ type: "steer_queued_prompt", turn_id: turnId }));
      const activeTurnId = activeTurnIds.current.values().next().value as
        string | undefined;
      if (activeTurnId)
        dispatchRuntimeEvent("session.running", queued.turnId, {});
      queuedPromptLookupRef.current.delete(turnId);
      replacePromptQueue(
        promptQueueRef.current.filter((prompt) => prompt.turnId !== turnId),
      );
    },
    [dispatchRuntimeEvent, replacePromptQueue, setRuntimeStatus],
  );

  const updateQueuedPrompt = useCallback(
    (turnId: string, text: string) => {
      const nextText = text.trim();
      if (!nextText) return;
      const next = promptQueueRef.current.map((prompt) =>
        prompt.turnId === turnId ? { ...prompt, text: nextText } : prompt,
      );
      const updated = next.find((prompt) => prompt.turnId === turnId);
      if (updated) queuedPromptLookupRef.current.set(turnId, updated);
      replacePromptQueue(next);
      dispatchRuntimeEvent("user.message", turnId, {
        message_id: `user-${turnId}`,
        text: nextText,
      });
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "update_queued_prompt",
            turn_id: turnId,
            text: nextText,
          }),
        );
      }
    },
    [dispatchRuntimeEvent, replacePromptQueue],
  );

  const removeQueuedPrompt = useCallback(
    (turnId: string) => {
      queuedPromptLookupRef.current.delete(turnId);
      replacePromptQueue(
        promptQueueRef.current.filter((prompt) => prompt.turnId !== turnId),
      );
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "remove_queued_prompt", turn_id: turnId }),
        );
      }
    },
    [replacePromptQueue],
  );

  const reorderPromptQueue = useCallback(
    (turnIds: string[]) => {
      const byTurnId = new Map(
        promptQueueRef.current.map((prompt) => [prompt.turnId, prompt]),
      );
      const seen = new Set<string>();
      const ordered: RuntimeQueuedPrompt[] = [];
      for (const turnId of turnIds) {
        const prompt = byTurnId.get(turnId);
        if (!prompt || seen.has(turnId)) continue;
        seen.add(turnId);
        ordered.push(prompt);
      }
      for (const prompt of promptQueueRef.current) {
        if (!seen.has(prompt.turnId)) ordered.push(prompt);
      }
      replacePromptQueue(ordered);
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "reorder_prompt_queue",
            turn_ids: ordered.map((prompt) => prompt.turnId),
          }),
        );
      }
    },
    [replacePromptQueue],
  );

  const setConfigOption = useCallback(
    (configId: string, value: string | boolean) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (draftRef.current) {
          pendingConfigOptionsRef.current.set(configId, value);
          setSessionConfigOptions((prev) =>
            prev.map((option) =>
              option.id === configId
                ? { ...option, currentValue: value }
                : option,
            ),
          );
          return;
        }
        setErrorMessage("not connected");
        setRuntimeStatus("error");
        return;
      }
      ws.send(
        JSON.stringify({
          type: "set_config_option",
          config_id: configId,
          value,
        }),
      );
    },
    [],
  );

  const setSessionMode = useCallback((modeId: string) => {
    const nextModeId = modeId.trim();
    if (!nextModeId) return;
    const applyLocal = () =>
      setSessionModes((prev) =>
        prev ? { ...prev, currentModeId: nextModeId } : prev,
      );
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (draftRef.current) {
        pendingSessionModeRef.current = nextModeId;
        draftRef.current = {
          ...draftRef.current,
          opts: {
            ...(draftRef.current.opts ?? {}),
            permissionModeId: nextModeId,
          },
        };
        applyLocal();
        return;
      }
      pendingSessionModeRef.current = nextModeId;
      applyLocal();
      return;
    }
    ws.send(JSON.stringify({ type: "set_session_mode", mode_id: nextModeId }));
  }, []);

  const cancel = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const turnIds = new Set([
      ...activeTurnIds.current,
      ...agentUIStoreRef.current
        .getState()
        .turnOrder.filter(
          (turnId) =>
            agentUIStoreRef.current.getState().turns[turnId]?.status ===
            "running",
        ),
    ]);
    for (const turnId of turnIds) {
      ws.send(JSON.stringify({ type: "cancel", turn_id: turnId }));
    }
  }, []);

  const respondPermission = useCallback(
    (requestId: string, optionId: string | null) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: "permission_response",
          request_id: requestId,
          option_id: optionId,
        }),
      );
    },
    [],
  );

  const respondElicitation = useCallback(
    (requestId: string, response: RuntimeElicitationResponse) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: "elicitation_response",
          request_id: requestId,
          ...response,
        }),
      );
    },
    [],
  );

  const shutdown = useCallback(() => {
    sessionOperationSeq.current += 1;
    resetRuntimeState({ disposeSocket: true });
    setRuntimeSessionId(null);
    setCurrentSession(null);
    setSelectedRuntimeId(null);
    setRuntimeAgentId(null);
    draftRef.current = null;
    pendingConfigOptionsRef.current.clear();
    replacePromptQueue([]);
    setRuntimeStatus("idle");
  }, [replacePromptQueue, resetRuntimeState, setRuntimeAgentId]);

  const loadResumeOptions = useCallback(
    async (runtimeId: string): Promise<RuntimeResumeSession[]> => {
      try {
        const res = await fetch(
          runtimeApiUrl(`${RUNTIMES_PATH}/${runtimeId}/local-sessions/scan`),
          {
            credentials: "include",
          },
        );
        if (!res.ok) return [];
        const json = (await res.json()) as { sessions: RuntimeResumeSession[] };
        return json.sessions ?? [];
      } catch {
        return [];
      }
    },
    [],
  );

  return {
    runtimes,
    startupStatus,
    selectedRuntimeId,
    selectedAgentId,
    sessionId,
    currentSession,
    status,
    errorMessage,
    transientStatus,
    diagnostics,
    modelFallback,
    supportsMessageFork,
    agentUIStore,
    agentUIState,
    messages,
    availableCommands,
    promptQueue,
    promptQueueEnabled,
    promptQueueMode,
    sessionConfigOptions,
    sessionModes,
    sessionInfoMeta,
    goal,
    sessionUsage,
    permissionRequests,
    elicitationRequests,
    sessionRuntimeStatus,
    sessionRestartPhase,
    ready,
    refresh,
    startDraft,
    prepareSession,
    select,
    attachSession,
    loadResumeOptions,
    sendMessage,
    setPromptQueueEnabled,
    setPromptQueueMode,
    steerQueuedPrompt,
    updateQueuedPrompt,
    removeQueuedPrompt,
    reorderPromptQueue,
    clearPromptQueue,
    setConfigOption,
    setSessionMode,
    respondPermission,
    respondElicitation,
    restartSession,
    cancel,
    shutdown,
  };
}
