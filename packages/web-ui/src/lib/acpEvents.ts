/**
 * ACP (Agent Client Protocol) event parser + per-turn assistant message
 * accumulator used by local and hosted ACP transports.
 *
 * Wire shape (verified against @agentclientprotocol/sdk@0.20 types AND
 * a captured chat_message events_json from claude-agent-acp):
 *
 *   SessionNotification = { sessionId, update: SessionUpdate }
 *   SessionUpdate is a discriminated union on `sessionUpdate`:
 *     - "user_message_chunk"   ContentChunk
 *     - "agent_message_chunk"  ContentChunk
 *     - "agent_thought_chunk"  ContentChunk
 *     - "tool_call"            ToolCall
 *     - "tool_call_update"     ToolCallUpdate
 *     - "plan"                 Plan
 *     - "available_commands_update" AvailableCommandsUpdate
 *     - "current_mode_update" | "config_option_update" | …  (silent for now)
 *
 * Canonical ToolCall fields per the ACP spec:
 *   { _meta?, content?: ToolCallContent[], kind?, locations?, rawInput?,
 *     rawOutput?, status?, title: string (required), toolCallId: string }
 *
 * claude-agent-acp emits TWO `tool_call` events for the same toolCallId —
 * first a bare-minimum placeholder so the UI can mount a card immediately
 * (rawInput:{}, title:"Terminal"), then a filled-in version once the
 * model finishes streaming the input (rawInput:{command,...}, title:`<cmd>`).
 * THIS PARSER coalesces both kinds of `tool_call` AND every
 * `tool_call_update` into a single part keyed by toolCallId — same
 * merge rules either way: null/undefined fields = "no change".
 *
 * Our older parser invented field names ("input", "output", "name") that
 * the wire never used; the rewrite intentionally keeps the ACP names
 * (`rawInput`, `rawOutput`, `content`) so future schema changes hit one
 * place. Display-friendly derivatives (input preview, tool name) are
 * computed at render time, not stored.
 */

import { mergeAgentUIStreamingText } from "@openma/common/agent-ui";
import { decodeAcpSessionUpdate } from "@openma/common/protocol/acp";
import {
  sessionUpdateInner,
  sessionUpdateType,
} from "@openma/common/session-events/acp";

// ─── ACP wire shapes (subset we use) ────────────────────────────────

/** ACP-defined ToolCallContent: text content, file diff, or terminal output. */
export interface AcpToolCallContent {
  type: "content" | "diff" | "terminal";
  /** When type='content', the inner content is { type:'text', text:string } etc. */
  content?: { type?: string; text?: string; [k: string]: unknown };
  /** When type='diff' / 'terminal', other fields populate. We don't render those yet. */
  [k: string]: unknown;
}

export interface AcpToolCallPart {
  type: "tool_call";
  /** Stable id for delta updates. */
  toolCallId: string;
  /** ACP-canonical fields, kept verbatim from the wire. */
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: AcpToolCallContent[];
  /** claude-agent-acp extension under `_meta.claudeCode.toolName`. Pulled
   *  out into a top-level field for convenience — header uses it as the
   *  human label ("Bash" / "Read" / etc). */
  toolName?: string;
  locations?: Array<{ path?: string; line?: number; [k: string]: unknown }>;
  /** ACP extension metadata, preserved so product renderers can use an
   * explicit protocol identity instead of guessing from display titles. */
  meta?: Record<string, unknown>;
  /** Normalized MCP identity supplied by ACP adapters such as codex-acp. */
  mcp?: {
    serverName: string;
    toolName?: string;
    renderer?: string;
  };
}

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low" | string;
  status: "pending" | "in_progress" | "completed" | string;
}

export interface AvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
  kind?: string;
  type?: string;
  category?: string;
  source?: string;
  /** ACP extension metadata. Command actions are host hints, not transcript. */
  _meta?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type AvailableCommandAction =
  | {
      kind: "setConfigOption";
      configId: string;
      value: string | boolean;
      resetValue?: string | boolean;
      presentation?: string;
    }
  | {
      kind: "prefixPrompt";
      presentation?: string;
    };

export function commandActionFromAvailableCommand(
  command: AvailableCommand,
): AvailableCommandAction | null {
  const meta = plainRecord(command._meta)
    ? command._meta
    : plainRecord(command.metadata)
      ? command.metadata
      : null;
  const action = plainRecord(meta?.commandAction) ? meta.commandAction : null;
  if (!action || typeof action.kind !== "string") return null;
  const presentation =
    typeof action.presentation === "string" && action.presentation.trim()
      ? action.presentation.trim()
      : undefined;
  if (action.kind === "prefixPrompt") {
    return {
      kind: "prefixPrompt",
      ...(presentation ? { presentation } : {}),
    };
  }
  if (
    action.kind !== "setConfigOption" ||
    typeof action.configId !== "string" ||
    !action.configId.trim() ||
    (typeof action.value !== "string" && typeof action.value !== "boolean")
  ) {
    return null;
  }
  const resetValue =
    typeof action.resetValue === "string" ||
    typeof action.resetValue === "boolean"
      ? action.resetValue
      : undefined;
  return {
    kind: "setConfigOption",
    configId: action.configId.trim(),
    value: action.value,
    ...(resetValue !== undefined ? { resetValue } : {}),
    ...(presentation ? { presentation } : {}),
  };
}

export interface RuntimeGoalState {
  objective: string;
  status: string;
  tokenBudget?: number;
  timeUsedSeconds?: number;
  createdAt?: number;
  controlMethod?: string;
}

export interface RuntimeSessionUsage {
  used: number;
  size: number;
  cost?: {
    amount: number;
    currency: string;
  };
  metadata?: Record<string, unknown>;
}

export interface AcpSessionInfoStatePatch {
  title?: string | null;
  updatedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ByoMessage {
  id: string;
  role: "user" | "assistant";
  parts: Array<
    | {
        type: "text";
        text: string;
        messageId?: string;
        phase?: "commentary" | "final_answer";
      }
    | { type: "thought"; text: string; messageId?: string }
    | AcpToolCallPart
    | { type: "plan"; entries: PlanEntry[] }
    | {
        type: "event_note";
        title: string;
        detail?: string;
        tone?: "neutral" | "warning" | "error";
      }
    | { type: "raw_event"; event: unknown }
  >;
}

// ─── parseAcpEvent ──────────────────────────────────────────────────

type ParsedKind =
  | "text"
  | "thought"
  | "tool_call" // covers BOTH initial tool_call and any later tool_call/tool_call_update
  | "commands"
  | "plan"
  | "note"
  | "silent"
  | "raw";

interface ParsedEvent {
  kind: ParsedKind;
  /** For text / thought. */
  text?: string;
  messageId?: string;
  phase?: "commentary" | "final_answer";
  /** For tool_call (initial or update). Field set follows the wire —
   *  null fields are dropped, undefined fields stay undefined. */
  tool?: Partial<AcpToolCallPart> & { toolCallId: string };
  /** For commands events. */
  commands?: AvailableCommand[];
  /** For plan events — full snapshot. */
  plan?: PlanEntry[];
  note?: {
    title: string;
    detail?: string;
    tone?: "neutral" | "warning" | "error";
  };
  /** Original event, used for the raw_event fallback. */
  event: unknown;
}

/**
 * Codex exposes Goal as session state, not transcript content. Preserve the
 * three meaningful outcomes so a host can update its UI without inventing
 * fallback state:
 *   undefined — this event says nothing about Goal
 *   null      — Goal was explicitly cleared
 *   object    — replace the current Goal snapshot
 */
export function sessionInfoStateFromAcpEvent(
  event: unknown,
): AcpSessionInfoStatePatch | undefined {
  const inner = sessionUpdateInner(event);
  if (sessionUpdateType(event) !== "session_info_update")
    return undefined;
  const patch: AcpSessionInfoStatePatch = {};
  if (Object.prototype.hasOwnProperty.call(inner, "title")) {
    patch.title = typeof inner.title === "string" ? inner.title : null;
  }
  if (Object.prototype.hasOwnProperty.call(inner, "updatedAt")) {
    patch.updatedAt =
      typeof inner.updatedAt === "string" ? inner.updatedAt : null;
  }
  const metaKey = Object.prototype.hasOwnProperty.call(inner, "_meta")
    ? "_meta"
    : Object.prototype.hasOwnProperty.call(inner, "meta")
      ? "meta"
      : null;
  if (metaKey) {
    const rawMeta = inner[metaKey];
    patch.metadata =
      rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
        ? (rawMeta as Record<string, unknown>)
        : null;
  }
  return patch;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function mergeSessionInfoMetadata(
  current: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    const previous = next[key];
    next[key] =
      plainRecord(previous) && plainRecord(value)
        ? mergeSessionInfoMetadata(previous, value)
        : value;
  }
  return next;
}

function normalizeGoalState(value: unknown): RuntimeGoalState | null {
  if (!plainRecord(value)) return null;
  const objective =
    typeof value.objective === "string" ? value.objective.trim() : "";
  const status = typeof value.status === "string" ? value.status.trim() : "";
  if (!objective || !status) return null;
  return {
    objective,
    status,
    ...(typeof value.tokenBudget === "number" &&
    Number.isFinite(value.tokenBudget)
      ? { tokenBudget: value.tokenBudget }
      : {}),
    ...(typeof value.timeUsedSeconds === "number" &&
    Number.isFinite(value.timeUsedSeconds)
      ? { timeUsedSeconds: value.timeUsedSeconds }
      : {}),
    ...(typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? { createdAt: value.createdAt }
      : {}),
    ...(typeof value.controlMethod === "string" && value.controlMethod.trim()
      ? { controlMethod: value.controlMethod.trim() }
      : {}),
  };
}

/**
 * Feature adapters inspect namespaced ACP metadata, never a selected harness
 * id. The raw sessionInfoMeta remains available so another ACP can add a
 * renderer without changing the session lifecycle.
 */
export function goalStateFromSessionInfoMetadata(
  metadata: Record<string, unknown> | null,
): RuntimeGoalState | null {
  const codex = plainRecord(metadata?.codex) ? metadata.codex : null;
  return normalizeGoalState(codex?.goal);
}

export function goalStateFromAcpEvent(
  event: unknown,
): RuntimeGoalState | null | undefined {
  const patch = sessionInfoStateFromAcpEvent(event);
  if (!patch || patch.metadata === undefined) return undefined;
  if (patch.metadata === null) return null;
  const codex = plainRecord(patch.metadata.codex) ? patch.metadata.codex : null;
  if (!codex || !Object.prototype.hasOwnProperty.call(codex, "goal"))
    return undefined;
  if (codex.goal === null) return null;
  return normalizeGoalState(codex.goal) ?? undefined;
}

export function usageStateFromAcpEvent(
  event: unknown,
): RuntimeSessionUsage | undefined {
  const inner = sessionUpdateInner(event);
  if (sessionUpdateType(event) !== "usage_update") return undefined;
  if (
    typeof inner.used !== "number" ||
    !Number.isFinite(inner.used) ||
    typeof inner.size !== "number" ||
    !Number.isFinite(inner.size)
  ) {
    return undefined;
  }
  const rawCost = plainRecord(inner.cost) ? inner.cost : null;
  const metadata = plainRecord(inner._meta)
    ? inner._meta
    : plainRecord(inner.meta)
      ? inner.meta
      : undefined;
  return {
    used: inner.used,
    size: inner.size,
    ...(rawCost &&
    typeof rawCost.amount === "number" &&
    Number.isFinite(rawCost.amount) &&
    typeof rawCost.currency === "string"
      ? { cost: { amount: rawCost.amount, currency: rawCost.currency } }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function stringField(
  raw: Record<string, unknown>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function nestedErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim())
    return record.message.trim();
  return nestedErrorMessage(record.error);
}

function promptErrorNote(error: string): NonNullable<ParsedEvent["note"]> {
  const trimmed = error.trim();
  let actionable = trimmed;

  // Some adapters prepend a model-metadata warning before the real JSON API
  // error. Parse the structured suffix so transport noise never becomes chat.
  for (
    let index = trimmed.indexOf("{");
    index >= 0;
    index = trimmed.indexOf("{", index + 1)
  ) {
    try {
      const parsed = JSON.parse(trimmed.slice(index));
      actionable = nestedErrorMessage(parsed) ?? actionable;
      break;
    } catch {
      // The first brace may be ordinary prose; try the next candidate.
    }
  }

  if (/requires a newer version of codex/i.test(actionable)) {
    return {
      title: "Codex update required",
      detail: actionable,
      tone: "error",
    };
  }
  return {
    title: actionable || "The agent could not complete this request",
    tone: "error",
  };
}

export function getAcpEventBlockKey(event: unknown): string | null {
  const inner = sessionUpdateInner(event);
  const update = sessionUpdateType(event);
  if (update === "tool_call" || update === "tool_call_update") {
    const toolCallId = stringField(inner, ["toolCallId", "tool_call_id", "id"]);
    return toolCallId ? `tool:${toolCallId}` : null;
  }
  if (!update) {
    if (
      (inner.type === "tool_call" ||
        inner.type === "tool_call_update" ||
        inner.type === "agent.tool_use") &&
      typeof inner.id === "string"
    ) {
      return `tool:${inner.id}`;
    }
    if (
      inner.type === "agent.tool_result" &&
      typeof inner.tool_use_id === "string"
    ) {
      return `tool:${inner.tool_use_id}`;
    }
  }
  return null;
}

/** Updates we drop silently — they're protocol signaling, not user content. */
const SILENT_SESSION_UPDATES = new Set([
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
]);

/** Normalize a wire ToolCall(Update) object into our ParsedEvent.tool shape.
 *  ACP spec says null/missing fields on an update mean "no change"; we
 *  preserve that by only setting fields whose wire value is non-null. */
function normalizeToolCall(
  raw: Record<string, unknown>,
): Partial<AcpToolCallPart> & { toolCallId: string } {
  const meta =
    raw._meta && typeof raw._meta === "object"
      ? (raw._meta as Record<string, unknown>)
      : undefined;
  const claudeCode =
    meta?.claudeCode && typeof meta.claudeCode === "object"
      ? (meta.claudeCode as { toolName?: string })
      : undefined;
  const toolCallId = raw.toolCallId ?? raw.tool_call_id ?? raw.id;
  const tc: Partial<AcpToolCallPart> & { toolCallId: string } = {
    toolCallId: String(toolCallId ?? ""),
  };
  const title = raw.title ?? raw.name ?? raw.toolName ?? raw.tool_name;
  if (typeof title === "string") tc.title = title;
  if (typeof raw.kind === "string") tc.kind = raw.kind;
  if (typeof raw.status === "string") tc.status = raw.status;
  const rawInput = raw.rawInput ?? raw.raw_input ?? raw.input ?? raw.args;
  const rawOutput = raw.rawOutput ?? raw.raw_output ?? raw.output ?? raw.result;
  if (rawInput !== undefined && rawInput !== null) tc.rawInput = rawInput;
  if (rawOutput !== undefined && rawOutput !== null) tc.rawOutput = rawOutput;
  if (Array.isArray(raw.content))
    tc.content = raw.content as AcpToolCallContent[];
  if (Array.isArray(raw.locations))
    tc.locations = raw.locations as AcpToolCallPart["locations"];
  const toolName =
    claudeCode?.toolName ?? raw.toolName ?? raw.tool_name ?? raw.name;
  if (typeof toolName === "string") tc.toolName = toolName;
  if (meta) tc.meta = meta;
  return withMcpIdentity(tc);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringMetaField(
  meta: Record<string, unknown> | undefined,
  names: string[],
): string | undefined {
  if (!meta) return undefined;
  for (const name of names) {
    const value = meta[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function withMcpIdentity<
  T extends Partial<AcpToolCallPart> & { toolCallId: string },
>(tool: T): T {
  if (tool.mcp?.serverName) return tool;
  const meta = tool.meta;
  const rawInput = recordValue(tool.rawInput);
  const explicitMcp =
    meta?.is_mcp_tool_call === true ||
    stringMetaField(meta, [
      "mcp_server_name",
      "mcpServerName",
      "server_id",
      "serverId",
    ]) !== undefined;
  if (!explicitMcp) return tool;
  const serverName =
    stringMetaField(meta, [
      "mcp_server_name",
      "mcpServerName",
      "server_id",
      "serverId",
    ]) ?? (typeof rawInput?.server === "string" ? rawInput.server : undefined);
  if (!serverName) return tool;
  const mcpToolName =
    stringMetaField(meta, ["mcp_tool_name", "mcpToolName"]) ??
    (typeof rawInput?.tool === "string" ? rawInput.tool : undefined);
  const renderer =
    typeof meta?.["clash.renderer"] === "string"
      ? meta["clash.renderer"]
      : undefined;
  tool.mcp = {
    serverName,
    ...(mcpToolName ? { toolName: mcpToolName } : {}),
    ...(renderer ? { renderer } : {}),
  };
  return tool;
}

function extractContentText(
  inner: Record<string, unknown>,
): string | undefined {
  if (typeof inner.text === "string") return inner.text;
  if (typeof inner.delta === "string") return inner.delta;
  if (typeof inner.content === "string") return inner.content;
  const content = inner.content as
    { type?: string; text?: string; content?: unknown } | undefined;
  if (typeof content?.text === "string") return content.text;
  if (typeof content?.content === "string") return content.content;
  if (content?.content && typeof content.content === "object") {
    const nested = content.content as { text?: string };
    if (typeof nested.text === "string") return nested.text;
  }
  return undefined;
}

function streamMetadata(inner: Record<string, unknown>): {
  messageId?: string;
  phase?: "commentary" | "final_answer";
} {
  const meta =
    inner._meta && typeof inner._meta === "object"
      ? (inner._meta as Record<string, unknown>)
      : null;
  const codex =
    meta?.codex && typeof meta.codex === "object"
      ? (meta.codex as Record<string, unknown>)
      : null;
  const phase =
    codex?.phase === "commentary" || codex?.phase === "final_answer"
      ? codex.phase
      : undefined;
  const messageId = stringField(inner, ["messageId", "message_id"]);
  return {
    ...(messageId ? { messageId } : {}),
    ...(phase ? { phase } : {}),
  };
}

function extractTextBlocks(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const block = part as {
          type?: unknown;
          text?: unknown;
          content?: unknown;
        };
        if (typeof block.text === "string") return block.text;
        if (typeof block.content === "string") return block.content;
        return "";
      })
      .join("");
    return text.length > 0 ? text : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const block = value as { type?: unknown; text?: unknown; content?: unknown };
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return undefined;
}

function isTransportDiagnosticText(text: string): boolean {
  const normalized = text.trim();
  return /^Falling back from WebSockets to HTTPS transport\./i.test(normalized);
}

function parseClashAcpEventFallback(event: unknown): ParsedEvent {
  // ACP SessionNotification wraps the update under `update`. Older
  // openma-vendored shape exposed sessionUpdate at the top level —
  // accept both so a chat mixing sources still parses cleanly.
  const inner = sessionUpdateInner(event);
  const update = sessionUpdateType(event);

  if (!update) {
    if (
      inner.type === "agent.message_chunk" &&
      typeof inner.delta === "string"
    ) {
      return {
        kind: inner.delta.length > 0 ? "text" : "silent",
        text: inner.delta,
        event,
      };
    }
    if (inner.type === "agent.message") {
      const text = extractTextBlocks(inner.content);
      return typeof text === "string" && text.length > 0
        ? { kind: "text", text, event }
        : { kind: "silent", event };
    }
    if (
      inner.type === "agent.thinking_chunk" &&
      typeof inner.delta === "string"
    ) {
      return {
        kind: inner.delta.length > 0 ? "thought" : "silent",
        text: inner.delta,
        event,
      };
    }
    if (inner.type === "agent.thinking") {
      const text =
        typeof inner.text === "string"
          ? inner.text
          : extractTextBlocks(inner.content);
      return typeof text === "string" && text.length > 0
        ? { kind: "thought", text, event }
        : { kind: "silent", event };
    }
    if (inner.type === "agent.tool_use" && typeof inner.id === "string") {
      return {
        kind: "tool_call",
        tool: {
          toolCallId: inner.id,
          title: typeof inner.name === "string" ? inner.name : "tool",
          toolName: typeof inner.name === "string" ? inner.name : undefined,
          rawInput: inner.input ?? {},
          status: "pending",
        },
        event,
      };
    }
    if (
      inner.type === "agent.tool_result" &&
      typeof inner.tool_use_id === "string"
    ) {
      return {
        kind: "tool_call",
        tool: {
          toolCallId: inner.tool_use_id,
          rawOutput: extractTextBlocks(inner.content) ?? inner.content,
          status: inner.is_error ? "failed" : "completed",
        },
        event,
      };
    }
    if (
      inner.type === "agent.message_stream_start" ||
      inner.type === "agent.message_stream_end" ||
      inner.type === "agent.thinking_stream_start" ||
      inner.type === "agent.thinking_stream_end" ||
      inner.type === "agent.tool_use_input_stream_start" ||
      inner.type === "agent.tool_use_input_chunk" ||
      inner.type === "agent.tool_use_input_stream_end" ||
      inner.type === "session.status_running" ||
      inner.type === "session.status_idle" ||
      inner.type === "session.warning"
    ) {
      return { kind: "silent", event };
    }
    if (
      inner.type === "session.error" &&
      typeof inner.error === "string" &&
      inner.error.length > 0
    ) {
      return {
        kind: "note",
        note: { title: inner.error, tone: "error" },
        event,
      };
    }
    if (
      inner.type === "text" &&
      typeof inner.text === "string" &&
      inner.text.length > 0
    ) {
      return { kind: "text", text: inner.text, event };
    }
    if (
      inner.type === "thought" &&
      typeof inner.text === "string" &&
      inner.text.length > 0
    ) {
      return { kind: "thought", text: inner.text, event };
    }
    if (inner.type === "requestPermission") {
      return { kind: "silent", event };
    }
    if (
      (inner.type === "tool_call" || inner.type === "tool_call_update") &&
      (typeof inner.toolCallId === "string" ||
        typeof inner.tool_call_id === "string" ||
        typeof inner.id === "string")
    ) {
      return { kind: "tool_call", tool: normalizeToolCall(inner), event };
    }
    if (
      inner.type === "promptError" &&
      typeof inner.error === "string" &&
      inner.error.length > 0
    ) {
      return { kind: "note", note: promptErrorNote(inner.error), event };
    }
    if (inner.type === "promptComplete") {
      return {
        kind: "note",
        note: { title: "Turn complete", tone: "neutral" },
        event,
      };
    }
    return { kind: "raw", event };
  }

  // ─── text / thought (ContentChunk) ──────────────────────────────
  if (update === "agent_message_chunk" || update === "agent_thought_chunk") {
    const text = extractContentText(inner);
    if (typeof text !== "string") return { kind: "silent", event };
    if (text.length === 0) return { kind: "silent", event };
    if (update === "agent_message_chunk" && isTransportDiagnosticText(text))
      return { kind: "silent", event };
    return {
      kind: update === "agent_thought_chunk" ? "thought" : "text",
      text,
      ...streamMetadata(inner),
      event,
    };
  }

  // user_message_chunk: agent is echoing the user's input back. We
  // already render the user's bubble from the optimistic dispatchPrompt
  // path, so skip silently to avoid a duplicate.
  if (update === "user_message_chunk") return { kind: "silent", event };

  // ─── tool_call / tool_call_update (treated identically) ─────────
  // claude-agent-acp emits two `tool_call` events for the same id (a
  // bare skeleton, then the filled-in input/title) before any
  // `tool_call_update`s. All three frames carry the same toolCallId
  // and have the same field shape — coalesce in the merger.
  if (update === "tool_call" || update === "tool_call_update") {
    if (
      typeof inner.toolCallId !== "string" &&
      typeof inner.tool_call_id !== "string" &&
      typeof inner.id !== "string"
    ) {
      return { kind: "raw", event };
    }
    return { kind: "tool_call", tool: normalizeToolCall(inner), event };
  }

  // ─── plan ────────────────────────────────────────────────────────
  if (update === "plan") {
    const rawEntries = Array.isArray(inner.entries)
      ? inner.entries
      : inner.plan &&
          typeof inner.plan === "object" &&
          "entries" in inner.plan &&
          Array.isArray((inner.plan as { entries?: unknown }).entries)
        ? (inner.plan as { entries: unknown[] }).entries
        : [];
    const entries = rawEntries
      .filter(
        (e): e is Record<string, unknown> =>
          Boolean(e) && typeof e === "object",
      )
      .map((e) => ({
        content: typeof e.content === "string" ? e.content : "",
        priority: typeof e.priority === "string" ? e.priority : undefined,
        status: typeof e.status === "string" ? e.status : "pending",
      }));
    return { kind: "plan", plan: entries, event };
  }

  if (update === "plan_update") {
    const plan =
      inner.plan && typeof inner.plan === "object"
        ? (inner.plan as Record<string, unknown>)
        : inner;
    const content =
      plan.content && typeof plan.content === "object"
        ? (plan.content as Record<string, unknown>)
        : plan;
    if (Array.isArray(content.entries)) {
      const entries = (content.entries as unknown[])
        .filter(
          (e): e is Record<string, unknown> =>
            Boolean(e) && typeof e === "object",
        )
        .map((e) => ({
          content: typeof e.content === "string" ? e.content : "",
          priority: typeof e.priority === "string" ? e.priority : undefined,
          status: typeof e.status === "string" ? e.status : "pending",
        }));
      return { kind: "plan", plan: entries, event };
    }
    const markdown =
      typeof content.markdown === "string"
        ? content.markdown
        : typeof content.content === "string"
          ? content.content
          : undefined;
    if (markdown) {
      return {
        kind: "plan",
        plan: [{ content: markdown, status: "in_progress" }],
        event,
      };
    }
    return {
      kind: "note",
      note: {
        title: "Plan updated",
        detail: getEventSummary(inner),
        tone: "neutral",
      },
      event,
    };
  }

  if (update === "plan_removed") {
    return {
      kind: "note",
      note: {
        title: "Plan removed",
        detail: typeof inner.id === "string" ? inner.id : undefined,
        tone: "neutral",
      },
      event,
    };
  }

  // ─── available_commands_update (slash menu) ─────────────────────
  if (update === "available_commands_update") {
    const availableCommands = Array.isArray(inner.availableCommands)
      ? inner.availableCommands
      : Array.isArray(inner.available_commands)
        ? inner.available_commands
        : null;
    if (!availableCommands) return { kind: "silent", event };
    return {
      kind: "commands",
      commands: availableCommands as AvailableCommand[],
      event,
    };
  }

  if (SILENT_SESSION_UPDATES.has(update)) return { kind: "silent", event };
  return { kind: "raw", event };
}

export function parseAcpEvent(event: unknown): ParsedEvent {
  const inner = sessionUpdateInner(event);
  if (inner.type === "promptError") return parseClashAcpEventFallback(event);

  const canonical = decodeAcpSessionUpdate("clash-projection", event, {
    eventId: "clash-projection",
    occurredAt: "1970-01-01T00:00:00.000Z",
  }).event;
  const data =
    canonical.data && typeof canonical.data === "object"
      ? (canonical.data as Record<string, unknown>)
      : {};

  if (
    canonical.type === "agent.message_chunk" ||
    canonical.type === "agent.message"
  ) {
    const text = typeof data.text === "string" ? data.text : "";
    if (!text || isTransportDiagnosticText(text))
      return { kind: "silent", event };
    const phase =
      data.phase === "commentary" || data.phase === "final_answer"
        ? data.phase
        : undefined;
    return {
      kind: "text",
      text,
      ...(typeof data.message_id === "string"
        ? { messageId: data.message_id }
        : {}),
      ...(phase ? { phase } : {}),
      event,
    };
  }
  if (canonical.type === "agent.thinking") {
    const text = typeof data.text === "string" ? data.text : "";
    if (!text) return { kind: "silent", event };
    return {
      kind: "thought",
      text,
      ...(typeof data.message_id === "string"
        ? { messageId: data.message_id }
        : {}),
      event,
    };
  }
  if (canonical.type.startsWith("tool.")) {
    const adapterMeta = plainRecord(data.adapter_meta)
      ? data.adapter_meta
      : undefined;
    return {
      kind: "tool_call",
      tool: withMcpIdentity({
        type: "tool_call",
        toolCallId: String(
          data.tool_call_id ?? canonical.work_item_id ?? canonical.event_id,
        ),
        ...(typeof data.title === "string" ? { title: data.title } : {}),
        ...(typeof data.kind === "string" ? { kind: data.kind } : {}),
        ...(typeof data.status === "string" ? { status: data.status } : {}),
        ...(data.raw_input !== undefined ? { rawInput: data.raw_input } : {}),
        ...(data.raw_output !== undefined
          ? { rawOutput: data.raw_output }
          : {}),
        ...(Array.isArray(data.content)
          ? { content: data.content as AcpToolCallContent[] }
          : {}),
        ...(Array.isArray(data.locations)
          ? { locations: data.locations as AcpToolCallPart["locations"] }
          : {}),
        ...(typeof data.tool_name === "string"
          ? { toolName: data.tool_name }
          : {}),
        ...(adapterMeta ? { meta: adapterMeta } : {}),
      }),
      event,
    };
  }
  if (canonical.type === "command_catalog.updated") {
    return {
      kind: "commands",
      commands: Array.isArray(data.commands)
        ? (data.commands as AvailableCommand[])
        : [],
      event,
    };
  }
  if (canonical.type === "plan.updated") {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return {
      kind: "plan",
      plan: entries
        .filter(
          (entry): entry is Record<string, unknown> =>
            plainRecord(entry) !== null,
        )
        .map((entry) => ({
          content: typeof entry.content === "string" ? entry.content : "",
          ...(typeof entry.priority === "string"
            ? { priority: entry.priority }
            : {}),
          status: typeof entry.status === "string" ? entry.status : "pending",
        })),
      event,
    };
  }
  if (canonical.type === "system.notice") return { kind: "silent", event };
  if (canonical.type === "system.message") {
    return typeof data.text === "string" && data.text
      ? { kind: "note", note: { title: data.text, tone: "neutral" }, event }
      : { kind: "silent", event };
  }
  if (canonical.type === "raw.event" || canonical.type === "vendor.event") {
    return parseClashAcpEventFallback(event);
  }
  return { kind: "silent", event };
}

// ─── appendAcpEvent

export interface AppendResult {
  idx: number;
  commands?: AvailableCommand[];
}

/**
 * Append a parsed event to the right message bubble. Returns the
 * bubble index (or -1 when the event was silently dropped — caller
 * should not cache that index). Side info (e.g. command lists) goes
 * out via the `commands` field; caller copies it into hook state.
 *
 * Mutates `messages` — callers must clone state before passing it here.
 */
export function appendAcpEvent(
  messages: ByoMessage[],
  turnId: string,
  knownIdx: number | undefined,
  event: unknown,
  messageId = `asst-${turnId}`,
): AppendResult {
  const parsed = parseAcpEvent(event);
  if (parsed.kind === "silent") return { idx: knownIdx ?? -1 };
  if (parsed.kind === "commands") {
    return { idx: knownIdx ?? -1, commands: parsed.commands };
  }

  const ensure = (): number => {
    if (
      knownIdx !== undefined &&
      messages[knownIdx]?.role === "assistant" &&
      Array.isArray(messages[knownIdx].parts)
    ) {
      return knownIdx;
    }
    const existingIdx = messages.findIndex(
      (message) =>
        message.id === messageId &&
        message.role === "assistant" &&
        Array.isArray(message.parts),
    );
    if (existingIdx >= 0) return existingIdx;
    const newIdx = messages.length;
    messages.push({ id: messageId, role: "assistant", parts: [] });
    return newIdx;
  };

  // ─── plan: snapshot semantics ───────────────────────────────────
  // Plan is re-emitted as a full snapshot every time the agent
  // updates its TODO list. Replace any existing plan part on the
  // bubble so the user sees the latest state, not a stack of
  // intermediate plans.
  if (parsed.kind === "plan" && parsed.plan) {
    const i = ensure();
    const existing = messages[i].parts.findIndex((p) => p.type === "plan");
    const planPart = { type: "plan" as const, entries: parsed.plan };
    if (existing >= 0) {
      const parts = [...messages[i].parts];
      parts[existing] = planPart;
      messages[i] = { ...messages[i], parts };
    } else {
      messages[i] = { ...messages[i], parts: [...messages[i].parts, planPart] };
    }
    return { idx: i };
  }

  if (parsed.kind === "note" && parsed.note) {
    const i = ensure();
    messages[i] = {
      ...messages[i],
      parts: [
        ...messages[i].parts,
        { type: "event_note", ...parsed.note } as ByoMessage["parts"][number],
      ],
    };
    return { idx: i };
  }

  // ─── text / thought: streaming chunk merge ──────────────────────
  // Consecutive chunks of the SAME kind merge into one part (one
  // bubble visually). Different kinds → separate parts.
  if (
    (parsed.kind === "text" || parsed.kind === "thought") &&
    typeof parsed.text === "string"
  ) {
    const i = ensure();
    const partType = parsed.kind;
    const last = messages[i].parts[messages[i].parts.length - 1];
    const sameStream =
      parsed.kind === "text"
        ? last?.type === "text" &&
          last.messageId === parsed.messageId &&
          last.phase === parsed.phase
        : last?.type === "thought" && last.messageId === parsed.messageId;
    const nextPart = {
      type: partType,
      text: parsed.text,
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
      ...(partType === "text" && parsed.phase ? { phase: parsed.phase } : {}),
    } as ByoMessage["parts"][number];
    if (sameStream && (last.type === "text" || last.type === "thought")) {
      const merged = mergeStreamingText(last.text, parsed.text);
      messages[i] = {
        ...messages[i],
        parts: [
          ...messages[i].parts.slice(0, -1),
          { ...nextPart, text: merged } as ByoMessage["parts"][number],
        ],
      };
    } else {
      messages[i] = {
        ...messages[i],
        parts: [...messages[i].parts, nextPart],
      };
    }
    return { idx: i };
  }

  // ─── tool_call (initial + updates): merge by toolCallId ─────────
  if (parsed.kind === "tool_call" && parsed.tool) {
    const i = ensure();
    const inc = parsed.tool;
    const partIdx = messages[i].parts.findIndex(
      (p) => p.type === "tool_call" && p.toolCallId === inc.toolCallId,
    );
    if (partIdx >= 0) {
      // Merge into existing — only overwrite fields whose incoming
      // value is non-null/non-undefined (per ACP spec).
      const prev = messages[i].parts[partIdx] as AcpToolCallPart;
      const next: AcpToolCallPart = { ...prev };
      if (inc.title !== undefined) next.title = inc.title;
      if (inc.kind !== undefined) next.kind = inc.kind;
      if (inc.status !== undefined) next.status = inc.status;
      if (inc.toolName !== undefined) next.toolName = inc.toolName;
      if (inc.locations !== undefined) next.locations = inc.locations;
      if (inc.meta !== undefined) {
        next.meta = mergeSessionInfoMetadata(prev.meta ?? null, inc.meta);
      }
      if (inc.mcp !== undefined) next.mcp = inc.mcp;
      // rawInput: prefer non-empty later value. The skeleton frame
      // sends `{}` then the filled frame sends `{command,...}`; we
      // want the filled one. Empty object → keep previous if previous
      // had real content.
      if (inc.rawInput !== undefined) {
        const incEmpty = isEmptyObject(inc.rawInput);
        const prevHasContent = !isEmptyObject(prev.rawInput);
        if (!(incEmpty && prevHasContent)) next.rawInput = inc.rawInput;
      }
      if (inc.rawOutput !== undefined) next.rawOutput = inc.rawOutput;
      // content[]: replace per ACP spec ("Replace the content collection").
      if (inc.content !== undefined) next.content = inc.content;
      const parts = [...messages[i].parts];
      parts[partIdx] = withMcpIdentity(next);
      messages[i] = { ...messages[i], parts };
      return { idx: i };
    }
    // New tool call.
    messages[i] = {
      ...messages[i],
      parts: [
        ...messages[i].parts,
        { type: "tool_call", ...inc } as AcpToolCallPart,
      ],
    };
    return { idx: i };
  }

  // Raw fallback — keep the event so debugging is possible without
  // losing data.
  const i = ensure();
  messages[i] = {
    ...messages[i],
    parts: [...messages[i].parts, { type: "raw_event", event }],
  };
  return { idx: i };
}

// ─── helpers ────────────────────────────────────────────────────────

function isEmptyObject(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v !== "object") return false;
  return Object.keys(v as Record<string, unknown>).length === 0;
}

function getEventSummary(event: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(event);
  } catch {
    return undefined;
  }
}

/**
 * Streaming text dedup. claude-agent-acp's text stream contract:
 *   • Most chunks are pure deltas — plain append is correct.
 *   • Occasionally a "settled" snapshot frame arrives carrying the
 *     full message; without dedup we'd render it twice.
 *   • Sometimes the model rewords earlier text mid-stream and emits a
 *     snapshot that doesn't strictly prefix-match the accumulator.
 *
 * Strategy (tuned against real wire dumps):
 *   1. Strict prefix → snapshot, replace.
 *   2. accumulated ends with full incoming → already there, no-op.
 *   3. incoming is longer AND first SNAPSHOT_HEAD_PROBE chars match →
 *      treat as rewording snapshot, replace.
 *   4. Suffix/prefix overlap ≥ MIN_OVERLAP chars → append the
 *      non-overlapping suffix. Floor avoids spurious 1–2-char punctuation
 *      matches that produced duplicated paragraphs in an earlier rev.
 *   5. None of the above → plain append.
 */
const MIN_OVERLAP = 8;
const SNAPSHOT_HEAD_PROBE = 16;

export function mergeStreamingText(
  accumulated: string,
  incoming: string,
): string {
  return mergeAgentUIStreamingText(accumulated, incoming);
}
