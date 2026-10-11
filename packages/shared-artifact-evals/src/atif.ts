import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AtifToolCall = {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, JsonValue>;
  extra?: Record<string, JsonValue>;
};

export type AtifObservationResult = {
  source_call_id?: string;
  content?: string;
  extra?: Record<string, JsonValue>;
};

export type AtifStep = {
  step_id: number;
  source: "system" | "user" | "agent";
  message: string;
  model_name?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: AtifObservationResult[] };
  metrics?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    extra?: Record<string, JsonValue>;
  };
  extra?: Record<string, JsonValue>;
};

export type AtifTrajectory = {
  schema_version: "ATIF-v1.7";
  session_id: string;
  trajectory_id: string;
  agent: {
    name: string;
    version: string;
    model_name: string;
  };
  steps: AtifStep[];
  notes: string;
  final_metrics: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_steps: number;
    extra?: Record<string, JsonValue>;
  };
  extra: {
    fidelity: "structured-projection";
    native_raw_retained: false;
    reasoning_content_retained: false;
    redaction_count: number;
    training_eligible: boolean;
  };
};

export type AtifEventSource =
  { kind: "text"; text: string } | { kind: "file"; path: string };

export type AtifProjectionInput = {
  adapter: "codex" | "claude" | "pi" | "command";
  publicPrompt: string;
  source: AtifEventSource;
  lockedAgent: {
    name: string;
    version: string;
    model: string;
  };
  workspaceRoot?: string;
};

export type AtifProjection = {
  trajectory: AtifTrajectory;
  fidelity: "structured-projection";
  redactionCount: number;
  trainingEligible: boolean;
  source: {
    format: "codex-exec-jsonl" | "pi-events" | "acp-events";
    bytes: number;
    sha256: string;
    lines: number;
  };
  /**
   * Event types the projection does not understand, with their counts. They
   * are skipped: a newer agent that adds an event must not fail the Attempt.
   */
  skippedEventTypes?: Record<string, number>;
};

export type AtifReceipt = {
  schemaVersion: 1;
  kind: "clash.benchmark.atif-receipt";
  format: "ATIF-v1.7";
  path: "trajectory.atif.json";
  bytes: number;
  sha256: string;
  fidelity: "structured-projection";
  redactionCount: number;
  trainingEligible: boolean;
  source: AtifProjection["source"];
};

export type WriteAtifInput = AtifProjectionInput & {
  outputDirectory: string;
};

/** @deprecated Use AtifEventSource. */
export type CodexAtifSource = AtifEventSource;
/** @deprecated Use AtifProjectionInput. */
export type CodexAtifInput = AtifProjectionInput;
/** @deprecated Use AtifProjection. */
export type CodexAtifProjection = AtifProjection;
/** @deprecated Use AtifReceipt. */
export type CodexAtifReceipt = AtifReceipt;
/** @deprecated Use WriteAtifInput. */
export type WriteCodexAtifInput = WriteAtifInput;

type JsonRecord = Record<string, unknown>;

type ParsedEvent = {
  line: number;
  value: JsonRecord;
};

type ToolItem = {
  order: number;
  value: JsonRecord;
};

type Turn = {
  messages: Array<{ order: number; id: string; text: string }>;
  tools: Map<string, ToolItem>;
  auxiliary: Array<{
    order: number;
    type: "error" | "todo_list";
    value: unknown;
  }>;
  nextOrder: number;
  status?: "completed" | "failed";
  usage?: JsonRecord;
  failure?: unknown;
  /** Latest ACP `usage_update` seen while this message was open. */
  contextUsage?: JsonRecord;
};

type ParsedTurns = {
  sessionId: string;
  turns: Turn[];
  /** Whole-session usage, when the protocol reports no per-message usage. */
  sessionUsage?: JsonRecord;
  skipped: Map<string, number>;
};

const OUTPUT_NAME = "trajectory.atif.json";
const SAFE_PUBLIC_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._+:/@-]{0,499}$/u;
const SECRET_VALUE =
  /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|clsh_[A-Fa-f0-9]{32,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[aboprs]-[A-Za-z0-9-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{12,})/gu;
const SENSITIVE_FIELD =
  /^(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|headers?|x[_-]?api[_-]?key|api[_-]?key|secret|client[_-]?secret|password|passwd|credential|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|capability|delivery[_-]?capability)$/iu;
const UPPERCASE_ENV_ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]{0,127}=)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"';&|]+)/gu;
const UNIX_MACHINE_PATH = /(^|[\s("'=])\/(?!\/)[^\s"'<>?&,;)]+/gu;
const WINDOWS_MACHINE_PATH =
  /(^|[\s("'=])[A-Za-z]:[\\/](?:[^\s"'<>?&,;)]+[\\/]?)+/gu;
const QUERY_VALUE =
  /((?:^|[?&\s])(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|credential|capability|signature|sig|x-amz-signature)=)([^&#\s"'<>]+)/giu;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((child) => canonicalize(child));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalJson(value: JsonValue): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`);
}

function compactJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

function assertSafeLockedAgent(
  input: AtifProjectionInput["lockedAgent"],
): void {
  for (const [label, value] of Object.entries(input)) {
    if (
      typeof value !== "string" ||
      value.trim() !== value ||
      !SAFE_PUBLIC_VALUE.test(value) ||
      SECRET_VALUE.test(value) ||
      isAbsolute(value) ||
      /^[A-Za-z]:[\\/]/u.test(value)
    ) {
      SECRET_VALUE.lastIndex = 0;
      throw new Error(`Locked agent ${label} must be a safe public value`);
    }
    SECRET_VALUE.lastIndex = 0;
  }
}

function replaceCount(
  value: string,
  expression: RegExp,
  replacement: string | ((...parts: string[]) => string),
): { value: string; count: number } {
  let count = 0;
  const next = value.replace(expression, (...parts: string[]) => {
    count += 1;
    return typeof replacement === "string"
      ? replacement
      : replacement(...parts);
  });
  return { value: next, count };
}

class PrivacySanitizer {
  redactionCount = 0;

  constructor(private readonly workspaceRoot?: string) {}

  private redactString(input: string): string {
    let value = input;
    if (this.workspaceRoot && value.includes(this.workspaceRoot)) {
      const occurrences = value.split(this.workspaceRoot).length - 1;
      value = value.split(this.workspaceRoot).join("$WORKSPACE");
      this.redactionCount += occurrences;
    }

    const environment = replaceCount(
      value,
      UPPERCASE_ENV_ASSIGNMENT,
      (...parts) => `${parts[1] ?? ""}[REDACTED]`,
    );
    value = environment.value;
    this.redactionCount += environment.count;

    const query = replaceCount(value, QUERY_VALUE, (...parts) => {
      const prefix = parts[1] ?? "";
      return `${prefix}[REDACTED]`;
    });
    value = query.value;
    this.redactionCount += query.count;

    const secrets = replaceCount(value, SECRET_VALUE, "[REDACTED]");
    value = secrets.value;
    this.redactionCount += secrets.count;

    const unixPaths = replaceCount(
      value,
      UNIX_MACHINE_PATH,
      (...parts) => `${parts[1] ?? ""}[ABSOLUTE_PATH]`,
    );
    value = unixPaths.value;
    this.redactionCount += unixPaths.count;

    const windowsPaths = replaceCount(
      value,
      WINDOWS_MACHINE_PATH,
      (...parts) => `${parts[1] ?? ""}[ABSOLUTE_PATH]`,
    );
    value = windowsPaths.value;
    this.redactionCount += windowsPaths.count;
    return value;
  }

  value(input: unknown): JsonValue {
    if (input === null) return null;
    if (typeof input === "string") return this.redactString(input);
    if (typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input) || Object.is(input, -0)) {
        throw new Error("Agent events must contain canonical JSON numbers");
      }
      return input;
    }
    if (Array.isArray(input)) return input.map((child) => this.value(child));
    if (!isRecord(input)) {
      throw new Error("Agent events must contain canonical JSON values");
    }
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(input)) {
      const sanitizedKey = this.redactString(key);
      const outputKey = Object.hasOwn(output, sanitizedKey)
        ? `redacted-key-${createHash("sha256").update(key).digest("hex")}`
        : sanitizedKey;
      if (SENSITIVE_FIELD.test(key)) {
        output[outputKey] = "[REDACTED]";
        this.redactionCount += 1;
      } else {
        output[outputKey] = this.value(child);
      }
    }
    return output;
  }
}

async function readNoFollowRegularFile(path: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) {
      throw new Error("Agent event source must be a regular unlinked file");
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error("Agent event source must be a regular unlinked file");
    }
    const bytes = await handle.readFile();
    const pathInfo = await lstat(path);
    if (
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      pathInfo.nlink !== 1 ||
      pathInfo.dev !== opened.dev ||
      pathInfo.ino !== opened.ino ||
      pathInfo.size !== bytes.byteLength
    ) {
      throw new Error(
        "Agent event source must be a stable regular unlinked file",
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function loadSource(source: AtifEventSource): Promise<{
  bytes: Buffer;
  events: ParsedEvent[];
}> {
  const bytes =
    source.kind === "text"
      ? Buffer.from(source.text)
      : await readNoFollowRegularFile(source.path);
  const text = bytes.toString("utf8");
  const events: ParsedEvent[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Agent event line ${index + 1} is not valid JSON`);
    }
    if (!isRecord(value) || typeof value.type !== "string") {
      throw new Error(
        `Agent event line ${index + 1} is not a typed JSON object`,
      );
    }
    events.push({ line: index + 1, value });
  }
  return { bytes, events };
}

function newTurn(): Turn {
  return {
    messages: [],
    tools: new Map(),
    auxiliary: [],
    nextOrder: 0,
  };
}

const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "mcp_tool_call",
  "file_change",
  "web_search",
  "collab_tool_call",
  "pi_tool_call",
  "acp_tool_call",
]);

const PASSIVE_ITEM_TYPES = new Set(["reasoning", "todo_list", "error"]);

function mergeItem(
  previous: JsonRecord | undefined,
  next: JsonRecord,
): JsonRecord {
  return previous ? { ...previous, ...next } : next;
}

function addItem(turn: Turn, envelopeType: string, item: JsonRecord): void {
  const id = typeof item.id === "string" && item.id ? item.id : undefined;
  const type = typeof item.type === "string" ? item.type : undefined;
  if (!id || !type) throw new Error("Codex item events require an id and type");
  if (type === "reasoning") return;

  if (type === "agent_message") {
    if (envelopeType !== "item.completed") return;
    if (typeof item.text !== "string") {
      throw new Error("Codex agent_message requires text");
    }
    if (!turn.messages.some((message) => message.id === id)) {
      turn.nextOrder += 1;
      turn.messages.push({
        order: turn.nextOrder,
        id,
        text: item.text,
      });
    }
    return;
  }

  if (PASSIVE_ITEM_TYPES.has(type)) {
    if (envelopeType !== "item.completed") return;
    turn.nextOrder += 1;
    turn.auxiliary.push({
      order: turn.nextOrder,
      type: type as "error" | "todo_list",
      value: type === "error" ? item.message : item.items,
    });
    return;
  }

  if (!TOOL_ITEM_TYPES.has(type)) {
    throw new Error(`Unsupported Codex item type '${type}'`);
  }
  const existing = turn.tools.get(id);
  if (existing) {
    existing.value = mergeItem(existing.value, item);
  } else {
    turn.nextOrder += 1;
    turn.tools.set(id, { order: turn.nextOrder, value: item });
  }
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function sanitizeArguments(
  sanitizer: PrivacySanitizer,
  value: unknown,
): Record<string, JsonValue> {
  const sanitized = sanitizer.value(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized
    : { value: sanitized };
}

function observationContent(
  sanitizer: PrivacySanitizer,
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const sanitized = sanitizer.value(value);
  return typeof sanitized === "string" ? sanitized : compactJson(sanitized);
}

function sanitizedReference(
  sanitizer: PrivacySanitizer,
  value: string,
  prefix: string,
): string {
  const before = sanitizer.redactionCount;
  const sanitized = sanitizer.value(value) as string;
  return sanitizer.redactionCount === before
    ? sanitized
    : `${prefix}-${createHash("sha256").update(value).digest("hex")}`;
}

function toolProjection(
  sanitizer: PrivacySanitizer,
  item: JsonRecord,
): { call: AtifToolCall; result: AtifObservationResult } {
  const id = sanitizedReference(sanitizer, item.id as string, "codex-call");
  const type = item.type as string;
  const status = sanitizer.value(
    typeof item.status === "string" ? item.status : "unknown",
  ) as string;
  let functionName: string;
  let argumentsValue: Record<string, JsonValue>;
  let content: string | undefined;
  const extra: Record<string, JsonValue> = { status };

  if (type === "mcp_tool_call") {
    const server = sanitizer.value(
      typeof item.server === "string" ? item.server : "unknown",
    ) as string;
    const tool = sanitizer.value(
      typeof item.tool === "string" ? item.tool : "unknown",
    ) as string;
    functionName = `mcp__${server}__${tool}`;
    argumentsValue = sanitizeArguments(sanitizer, item.arguments ?? {});
    content = observationContent(
      sanitizer,
      item.result ?? (isRecord(item.error) ? item.error.message : item.error),
    );
  } else if (type === "pi_tool_call" || type === "acp_tool_call") {
    functionName = sanitizer.value(
      typeof item.toolName === "string" ? item.toolName : "unknown",
    ) as string;
    argumentsValue = sanitizeArguments(sanitizer, item.arguments ?? {});
    content = observationContent(sanitizer, item.result);
    if (item.isError === true) extra.is_error = true;
    if (typeof item.kind === "string") {
      extra.kind = sanitizer.value(item.kind) as string;
    }
  } else if (type === "command_execution") {
    functionName = "command_execution";
    argumentsValue = sanitizeArguments(sanitizer, {
      command: typeof item.command === "string" ? item.command : "",
    });
    content = observationContent(sanitizer, item.aggregated_output);
    if (typeof item.exit_code === "number") extra.exit_code = item.exit_code;
  } else if (type === "file_change") {
    functionName = "file_change";
    argumentsValue = sanitizeArguments(sanitizer, {
      changes: Array.isArray(item.changes) ? item.changes : [],
    });
  } else if (type === "web_search") {
    functionName = "web_search";
    argumentsValue = sanitizeArguments(sanitizer, {
      query: typeof item.query === "string" ? item.query : "",
      ...(item.action === undefined ? {} : { action: item.action }),
    });
  } else {
    functionName = "collab_tool_call";
    const { id: _id, type: _type, status: _status, ...arguments_ } = item;
    argumentsValue = sanitizeArguments(sanitizer, arguments_);
  }

  return {
    call: {
      tool_call_id: id,
      function_name: functionName,
      arguments: argumentsValue,
    },
    result: {
      source_call_id: id,
      ...(content === undefined ? {} : { content }),
      extra,
    },
  };
}

function turnStep(
  turn: Turn,
  stepId: number,
  model: string,
  sanitizer: PrivacySanitizer,
  adapter: "codex" | "pi" | "acp",
): AtifStep {
  const messages = turn.messages
    .sort((left, right) => left.order - right.order)
    .map((message) => sanitizer.value(message.text) as string);
  const projectedTools = [...turn.tools.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ value }) => toolProjection(sanitizer, value));
  const extra: Record<string, JsonValue> = {
    [`${adapter}_turn_status`]: turn.status ?? "unknown",
  };
  const auxiliary = turn.auxiliary
    .sort((left, right) => left.order - right.order)
    .map((entry) => ({
      type: entry.type,
      value: sanitizer.value(entry.value),
    }));
  if (auxiliary.length > 0) extra.codex_auxiliary = auxiliary;
  if (turn.failure !== undefined) {
    extra.codex_failure = sanitizer.value(turn.failure);
  }
  if (turn.contextUsage) {
    extra.acp_usage_update = sanitizer.value(turn.contextUsage);
  }

  let metrics: AtifStep["metrics"];
  if (turn.usage) {
    const usageFields =
      adapter === "codex"
        ? {
            prompt: "input_tokens",
            cached: "cached_input_tokens",
            completion: "output_tokens",
            reasoning: "reasoning_output_tokens",
            cacheWrite: "cache_write_input_tokens",
          }
        : {
            prompt: "input",
            cached: "cacheRead",
            completion: "output",
            reasoning: "reasoning",
            cacheWrite: "cacheWrite",
          };
    const usageValue = (field: string): unknown =>
      turn.usage?.[field] ?? (adapter === "pi" ? 0 : undefined);
    const promptTokens = parseNonNegativeInteger(
      usageValue(usageFields.prompt),
      `${adapter} ${usageFields.prompt}`,
    );
    const cachedTokens = parseNonNegativeInteger(
      usageValue(usageFields.cached),
      `${adapter} ${usageFields.cached}`,
    );
    const completionTokens = parseNonNegativeInteger(
      usageValue(usageFields.completion),
      `${adapter} ${usageFields.completion}`,
    );
    const reasoningTokens = parseNonNegativeInteger(
      usageValue(usageFields.reasoning),
      `${adapter} ${usageFields.reasoning}`,
    );
    const cacheWriteTokens =
      turn.usage[usageFields.cacheWrite] === undefined
        ? 0
        : parseNonNegativeInteger(
            turn.usage[usageFields.cacheWrite],
            `${adapter} ${usageFields.cacheWrite}`,
          );
    metrics = {
      prompt_tokens: promptTokens,
      cached_tokens: cachedTokens,
      completion_tokens: completionTokens,
      extra: {
        cache_write_input_tokens: cacheWriteTokens,
        reasoning_output_tokens: reasoningTokens,
      },
    };
  }

  return {
    step_id: stepId,
    source: "agent",
    message: messages.join("\n\n"),
    model_name: model,
    ...(projectedTools.length > 0
      ? {
          tool_calls: projectedTools.map(({ call }) => call),
          observation: {
            results: projectedTools.map(({ result }) => result),
          },
        }
      : {}),
    ...(metrics ? { metrics } : {}),
    extra,
  };
}

function parseCodexTurns(events: ParsedEvent[]): ParsedTurns {
  let sessionId: string | undefined;
  let current: Turn | undefined;
  const turns: Turn[] = [];

  for (const event of events) {
    const type = event.value.type as string;
    if (type === "thread.started") {
      if (sessionId || current || turns.length > 0) {
        throw new Error("Codex event turn structure is invalid");
      }
      if (typeof event.value.thread_id !== "string" || !event.value.thread_id) {
        throw new Error("Codex thread.started requires thread_id");
      }
      sessionId = event.value.thread_id;
      continue;
    }
    if (type === "turn.started") {
      if (!sessionId || current) {
        throw new Error("Codex event turn structure is invalid");
      }
      current = newTurn();
      continue;
    }
    if (
      type === "item.started" ||
      type === "item.updated" ||
      type === "item.completed"
    ) {
      if (!current || !isRecord(event.value.item)) {
        throw new Error("Codex event turn structure is invalid");
      }
      addItem(current, type, event.value.item);
      continue;
    }
    if (type === "turn.completed" || type === "turn.failed") {
      if (!current) throw new Error("Codex event turn structure is invalid");
      current.status = type === "turn.completed" ? "completed" : "failed";
      if (type === "turn.completed") {
        if (!isRecord(event.value.usage)) {
          throw new Error("Codex turn.completed requires usage");
        }
        current.usage = event.value.usage;
      } else {
        current.failure = isRecord(event.value.error)
          ? event.value.error.message
          : event.value.error;
      }
      turns.push(current);
      current = undefined;
      continue;
    }
    if (type === "error") {
      if (!current) throw new Error("Codex event turn structure is invalid");
      current.nextOrder += 1;
      current.auxiliary.push({
        order: current.nextOrder,
        type: "error",
        value: event.value.message,
      });
      continue;
    }
    throw new Error(
      `Unsupported Codex event type '${type}' at line ${event.line}`,
    );
  }

  if (!sessionId || current) {
    throw new Error("Codex event turn structure is invalid");
  }
  return { sessionId, turns, skipped: new Map() };
}

function piToolArguments(value: unknown): JsonRecord {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Pi tool arguments must be an object");
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalize(left as JsonValue)) ===
    JSON.stringify(canonicalize(right as JsonValue))
  );
}

function parsePiTurns(events: ParsedEvent[]): ParsedTurns {
  let sessionId: string | undefined;
  let current: Turn | undefined;
  let agentActive = false;
  let retryActive = false;
  let compactionActive = false;
  const turns: Turn[] = [];
  const skipped = new Map<string, number>();

  for (const event of events) {
    const type = event.value.type as string;
    if (type === "session") {
      if (sessionId || current || turns.length > 0) {
        throw new Error("Pi event turn structure is invalid");
      }
      if (typeof event.value.id !== "string" || !event.value.id) {
        throw new Error("Pi session requires id");
      }
      sessionId = event.value.id;
      continue;
    }
    if (type === "agent_start") {
      if (!sessionId || current || agentActive) {
        throw new Error("Pi event turn structure is invalid");
      }
      agentActive = true;
      continue;
    }
    if (type === "turn_start") {
      if (!sessionId || current || !agentActive) {
        throw new Error("Pi event turn structure is invalid");
      }
      current = newTurn();
      continue;
    }
    if (
      type === "message_start" ||
      type === "message_update" ||
      type === "message_end"
    ) {
      if (!current) throw new Error("Pi event turn structure is invalid");
      continue;
    }
    if (type === "tool_execution_update") {
      if (!current) throw new Error("Pi event turn structure is invalid");
      continue;
    }
    if (type === "tool_execution_start") {
      if (!current) throw new Error("Pi event turn structure is invalid");
      const id = event.value.toolCallId;
      const toolName = event.value.toolName;
      if (
        typeof id !== "string" ||
        !id ||
        typeof toolName !== "string" ||
        !toolName ||
        current.tools.has(id)
      ) {
        throw new Error("Pi tool start requires a unique id and tool name");
      }
      current.nextOrder += 1;
      current.tools.set(id, {
        order: current.nextOrder,
        value: {
          id,
          type: "pi_tool_call",
          toolName,
          arguments: piToolArguments(event.value.args),
          status: "in_progress",
        },
      });
      continue;
    }
    if (type === "tool_execution_end") {
      if (!current) throw new Error("Pi event turn structure is invalid");
      const id = event.value.toolCallId;
      const toolName = event.value.toolName;
      const existing =
        typeof id === "string" ? current.tools.get(id) : undefined;
      if (
        !existing ||
        typeof toolName !== "string" ||
        existing.value.toolName !== toolName
      ) {
        throw new Error("Pi tool result must match a started tool call");
      }
      existing.value = {
        ...existing.value,
        result: event.value.result,
        isError: event.value.isError === true,
        status: event.value.isError === true ? "failed" : "completed",
      };
      continue;
    }
    if (type === "turn_end") {
      if (!current || !isRecord(event.value.message)) {
        throw new Error("Pi event turn structure is invalid");
      }
      const message = event.value.message;
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        throw new Error("Pi turn_end requires an assistant message");
      }
      const messageToolIds = new Set<string>();
      for (const rawBlock of message.content) {
        if (!isRecord(rawBlock) || typeof rawBlock.type !== "string") {
          throw new Error("Pi assistant content blocks must be typed objects");
        }
        if (rawBlock.type === "thinking") continue;
        if (rawBlock.type === "text") {
          if (typeof rawBlock.text !== "string") {
            throw new Error("Pi text content requires text");
          }
          current.nextOrder += 1;
          current.messages.push({
            order: current.nextOrder,
            id: `pi-message-${turns.length + 1}-${current.messages.length + 1}`,
            text: rawBlock.text,
          });
          continue;
        }
        if (rawBlock.type !== "toolCall") {
          throw new Error(`Unsupported Pi content type '${rawBlock.type}'`);
        }
        const id = rawBlock.id;
        const toolName = rawBlock.name;
        if (
          typeof id !== "string" ||
          !id ||
          typeof toolName !== "string" ||
          !toolName ||
          messageToolIds.has(id)
        ) {
          throw new Error("Pi toolCall content requires a unique id and name");
        }
        messageToolIds.add(id);
        const arguments_ = piToolArguments(rawBlock.arguments);
        const existing = current.tools.get(id);
        if (!existing) {
          current.nextOrder += 1;
          current.tools.set(id, {
            order: current.nextOrder,
            value: {
              id,
              type: "pi_tool_call",
              toolName,
              arguments: arguments_,
              status: "not_executed",
            },
          });
        } else if (
          existing.value.toolName !== toolName ||
          !sameJson(existing.value.arguments, arguments_)
        ) {
          throw new Error("Pi toolCall content does not match its execution");
        }
      }
      if (!isRecord(message.usage)) {
        throw new Error("Pi turn_end requires usage");
      }
      current.status = "completed";
      current.usage = message.usage;
      turns.push(current);
      current = undefined;
      continue;
    }
    if (type === "agent_end") {
      if (!sessionId || current || !agentActive) {
        throw new Error("Pi event turn structure is invalid");
      }
      agentActive = false;
      continue;
    }
    if (type === "auto_retry_start") {
      if (!sessionId || current || agentActive || compactionActive) {
        throw new Error("Pi event turn structure is invalid");
      }
      retryActive = true;
      continue;
    }
    if (type === "auto_retry_end") {
      if (!sessionId || !retryActive) {
        throw new Error("Pi event turn structure is invalid");
      }
      retryActive = false;
      continue;
    }
    if (type === "compaction_start") {
      if (
        !sessionId ||
        current ||
        agentActive ||
        retryActive ||
        compactionActive
      ) {
        throw new Error("Pi event turn structure is invalid");
      }
      compactionActive = true;
      continue;
    }
    if (type === "compaction_end") {
      if (!sessionId || !compactionActive) {
        throw new Error("Pi event turn structure is invalid");
      }
      compactionActive = event.value.willRetry === true;
      continue;
    }
    if (type === "agent_settled") {
      if (
        !sessionId ||
        current ||
        agentActive ||
        retryActive ||
        compactionActive
      ) {
        throw new Error("Pi event turn structure is invalid");
      }
      continue;
    }
    // Pi adds event types between releases (1.1.0 added `entry_appended`).
    // An event this projection does not know carries no turn structure.
    skipped.set(type, (skipped.get(type) ?? 0) + 1);
  }

  if (
    !sessionId ||
    current ||
    agentActive ||
    retryActive ||
    compactionActive ||
    turns.length === 0
  ) {
    throw new Error("Pi event turn structure is invalid");
  }
  return { sessionId, turns, skipped };
}

/** Standard ACP updates that describe client-facing session state, not the rollout. */
const ACP_SESSION_STATE_UPDATES = new Set([
  "available_commands_update",
  "config_option_update",
  "current_mode_update",
  "session_info_update",
  "user_message_chunk",
]);

function acpText(content: unknown): string {
  return isRecord(content) &&
    content.type === "text" &&
    typeof content.text === "string"
    ? content.text
    : "";
}

/**
 * Projects the ACP event log an ACP-driven adapter records (see
 * `AcpEventLine`). One ATIF step is one assistant message together with the
 * tool calls it issued; `messageId` separates messages when the agent sends
 * it, and a message that follows a tool call starts the next step otherwise.
 */
function parseAcpTurns(events: ParsedEvent[]): ParsedTurns {
  let sessionId: string | undefined;
  let sessionUsage: JsonRecord | undefined;
  let current: (Turn & { key?: string; sawTool?: boolean }) | undefined;
  const turns: Turn[] = [];
  const toolOwners = new Map<string, Turn>();
  const skipped = new Map<string, number>();
  const skip = (type: string): void => {
    skipped.set(type, (skipped.get(type) ?? 0) + 1);
  };
  const open = (key?: string): Turn => {
    current = { ...newTurn(), ...(key ? { key } : {}) };
    turns.push(current);
    return current;
  };
  const messageTurn = (update: JsonRecord): Turn => {
    const key =
      typeof update.messageId === "string" && update.messageId
        ? update.messageId
        : undefined;
    if (!current) return open(key);
    if (key ? current.key !== key : current.sawTool) return open(key);
    return current;
  };

  for (const event of events) {
    const type = event.value.type as string;
    if (type === "acp.session") {
      if (sessionId || turns.length > 0) {
        throw new Error("ACP event log has more than one session");
      }
      if (typeof event.value.sessionId !== "string" || !event.value.sessionId) {
        throw new Error("ACP session requires sessionId");
      }
      sessionId = event.value.sessionId;
      continue;
    }
    if (!sessionId) throw new Error("ACP event log must start with a session");
    if (type === "acp.prompt_complete") {
      if (isRecord(event.value.usage)) sessionUsage = event.value.usage;
      for (const turn of turns) turn.status ??= "completed";
      continue;
    }
    if (type === "acp.prompt_error") {
      const failed = current ?? open();
      failed.status = "failed";
      failed.failure = event.value.message;
      continue;
    }
    if (type !== "acp.session_update" || !isRecord(event.value.update)) {
      skip(type);
      continue;
    }
    const update = event.value.update;
    const kind = update.sessionUpdate;
    if (kind === "agent_thought_chunk") {
      messageTurn(update);
      continue;
    }
    if (kind === "agent_message_chunk") {
      const turn = messageTurn(update);
      const text = acpText(update.content);
      if (!text) continue;
      const message = turn.messages[0];
      if (message) {
        message.text += text;
      } else {
        turn.nextOrder += 1;
        turn.messages.push({
          order: turn.nextOrder,
          id: `acp-message-${turns.length}`,
          text,
        });
      }
      continue;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const id = update.toolCallId;
      if (typeof id !== "string" || !id) {
        throw new Error("ACP tool call requires toolCallId");
      }
      const turn = toolOwners.get(id) ?? current ?? open();
      toolOwners.set(id, turn);
      if (turn === current) current.sawTool = true;
      let item = turn.tools.get(id);
      if (!item) {
        turn.nextOrder += 1;
        item = {
          order: turn.nextOrder,
          value: { id, type: "acp_tool_call", arguments: {} },
        };
        turn.tools.set(id, item);
      }
      const value = item.value;
      // `name` is the agent's own tool identifier when it sends one; `kind` is
      // the standard ACP category. `title` is display text and changes while
      // the arguments stream, so it never names the function.
      if (typeof update.name === "string" && update.name) {
        value.toolName = update.name;
      }
      if (typeof update.kind === "string") value.kind = update.kind;
      value.toolName ??= value.kind ?? "tool";
      if (isRecord(update.rawInput)) value.arguments = update.rawInput;
      if (update.rawOutput !== undefined) value.result = update.rawOutput;
      if (typeof update.status === "string") {
        value.status = update.status;
        value.isError = update.status === "failed";
      }
      continue;
    }
    if (kind === "plan") {
      const turn = current ?? open();
      turn.nextOrder += 1;
      turn.auxiliary.push({
        order: turn.nextOrder,
        type: "todo_list",
        value: update.entries,
      });
      continue;
    }
    if (kind === "usage_update") {
      const { sessionUpdate: _kind, _meta: _meta, ...usage } = update;
      (current ?? open()).contextUsage = usage;
      continue;
    }
    if (typeof kind === "string" && ACP_SESSION_STATE_UPDATES.has(kind)) {
      continue;
    }
    skip(typeof kind === "string" ? `session_update:${kind}` : type);
  }

  if (!sessionId) throw new Error("ACP event log must start with a session");
  return {
    sessionId,
    turns,
    ...(sessionUsage ? { sessionUsage } : {}),
    skipped,
  };
}

function isAcpEventLog(events: ParsedEvent[]): boolean {
  return events[0]?.value.type === "acp.session";
}

function optionalTokenCount(value: unknown, label: string): number {
  return value === undefined ? 0 : parseNonNegativeInteger(value, label);
}

function sumMetric(
  steps: AtifStep[],
  key: "prompt_tokens" | "completion_tokens" | "cached_tokens",
): number {
  return steps.reduce((total, step) => total + (step.metrics?.[key] ?? 0), 0);
}

function sumExtraMetric(steps: AtifStep[], key: string): number {
  return steps.reduce((total, step) => {
    const value = step.metrics?.extra?.[key];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

export async function projectAtifTrajectory(
  input: AtifProjectionInput,
): Promise<AtifProjection> {
  if (input.adapter !== "codex" && input.adapter !== "pi") {
    throw new Error(
      "ATIF structured projection currently supports Codex and Pi",
    );
  }
  const lockedAdapter: "codex" | "pi" = input.adapter;
  if (typeof input.publicPrompt !== "string" || !input.publicPrompt.trim()) {
    throw new Error("ATIF public prompt must be non-empty");
  }
  assertSafeLockedAgent(input.lockedAgent);
  if (
    input.workspaceRoot !== undefined &&
    (!isAbsolute(input.workspaceRoot) || input.workspaceRoot.length > 4096)
  ) {
    throw new Error("ATIF workspaceRoot must be an absolute machine path");
  }

  const loaded = await loadSource(input.source);
  // Pi is driven over ACP. Attempts recorded before that hold Pi's own JSON
  // event stream, which stays readable.
  const adapter: "codex" | "pi" | "acp" =
    lockedAdapter === "pi" && isAcpEventLog(loaded.events)
      ? "acp"
      : lockedAdapter;
  const parsed =
    adapter === "codex"
      ? parseCodexTurns(loaded.events)
      : adapter === "acp"
        ? parseAcpTurns(loaded.events)
        : parsePiTurns(loaded.events);
  const sanitizer = new PrivacySanitizer(input.workspaceRoot);
  const sessionRedactions = sanitizer.redactionCount;
  const sanitizedSession = sanitizer.value(parsed.sessionId) as string;
  const sessionId =
    sanitizer.redactionCount !== sessionRedactions || !sanitizedSession
      ? `${adapter}-${createHash("sha256").update(parsed.sessionId).digest("hex")}`
      : sanitizedSession;
  const steps: AtifStep[] = [
    {
      step_id: 1,
      source: "user",
      message: sanitizer.value(input.publicPrompt) as string,
    },
    ...parsed.turns.map((turn, index) =>
      turnStep(turn, index + 2, input.lockedAgent.model, sanitizer, adapter),
    ),
  ];
  const agentSteps = steps.filter((step) => step.source === "agent");
  const hasUsage = agentSteps.some((step) => step.metrics !== undefined);
  const reasoningTokens = sumExtraMetric(agentSteps, "reasoning_output_tokens");
  const cacheWriteTokens = sumExtraMetric(
    agentSteps,
    "cache_write_input_tokens",
  );
  const sessionUsage = parsed.sessionUsage;
  const skippedEventTypes = Object.fromEntries(
    [...parsed.skipped].sort(([left], [right]) => left.localeCompare(right)),
  );
  const skippedNote =
    parsed.skipped.size > 0
      ? ` Skipped unrecognized events: ${Object.entries(skippedEventTypes)
          .map(
            ([type, count]) => `${sanitizer.value(type) as string} x${count}`,
          )
          .join(", ")}.`
      : "";
  const trainingEligible = sanitizer.redactionCount === 0;
  const trajectory: AtifTrajectory = {
    schema_version: "ATIF-v1.7",
    session_id: sessionId,
    trajectory_id: sessionId,
    agent: {
      name: input.lockedAgent.name,
      version: input.lockedAgent.version,
      model_name: input.lockedAgent.model,
    },
    steps,
    notes: `Structured projection of ${adapter === "codex" ? "Codex exec" : adapter === "acp" ? "ACP session" : "Pi agent"} JSONL. Native raw events and reasoning_content are intentionally not retained.${skippedNote}`,
    final_metrics: {
      ...(sessionUsage
        ? {
            total_prompt_tokens: optionalTokenCount(
              sessionUsage.inputTokens,
              "acp inputTokens",
            ),
            total_completion_tokens: optionalTokenCount(
              sessionUsage.outputTokens,
              "acp outputTokens",
            ),
            total_cached_tokens: optionalTokenCount(
              sessionUsage.cachedReadTokens,
              "acp cachedReadTokens",
            ),
            extra: {
              cache_write_input_tokens: optionalTokenCount(
                sessionUsage.cachedWriteTokens,
                "acp cachedWriteTokens",
              ),
              reasoning_output_tokens: optionalTokenCount(
                sessionUsage.thoughtTokens,
                "acp thoughtTokens",
              ),
            },
          }
        : hasUsage
          ? {
              total_prompt_tokens: sumMetric(agentSteps, "prompt_tokens"),
              total_completion_tokens: sumMetric(
                agentSteps,
                "completion_tokens",
              ),
              total_cached_tokens: sumMetric(agentSteps, "cached_tokens"),
              extra: {
                cache_write_input_tokens: cacheWriteTokens,
                reasoning_output_tokens: reasoningTokens,
              },
            }
          : {}),
      total_steps: steps.length,
    },
    extra: {
      fidelity: "structured-projection",
      native_raw_retained: false,
      reasoning_content_retained: false,
      redaction_count: sanitizer.redactionCount,
      training_eligible: trainingEligible,
    },
  };
  return {
    trajectory,
    fidelity: "structured-projection",
    redactionCount: sanitizer.redactionCount,
    trainingEligible,
    source: {
      format:
        adapter === "codex"
          ? "codex-exec-jsonl"
          : adapter === "acp"
            ? "acp-events"
            : "pi-events",
      bytes: loaded.bytes.byteLength,
      sha256: createHash("sha256").update(loaded.bytes).digest("hex"),
      lines: loaded.events.length,
    },
    ...(parsed.skipped.size > 0 ? { skippedEventTypes } : {}),
  };
}

export async function projectCodexAtifTrajectory(
  input: CodexAtifInput,
): Promise<CodexAtifProjection> {
  if (input.adapter !== "codex") {
    throw new Error("ATIF structured projection currently only supports Codex");
  }
  return projectAtifTrajectory(input);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyExistingOutput(
  outputPath: string,
  expected: Buffer,
): Promise<void> {
  let handle;
  try {
    handle = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) {
      throw new Error("Existing ATIF output must be a regular unlinked file");
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error("Existing ATIF output must be a regular unlinked file");
    }
    const bytes = await handle.readFile();
    const pathInfo = await lstat(outputPath);
    if (
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      pathInfo.nlink !== 1 ||
      pathInfo.dev !== opened.dev ||
      pathInfo.ino !== opened.ino
    ) {
      throw new Error("Existing ATIF output must be a regular unlinked file");
    }
    if (!bytes.equals(expected)) {
      throw new Error(
        "Existing ATIF output conflicts with structured projection",
      );
    }
  } finally {
    await handle.close();
  }
}

export async function writeAtifTrajectory(
  input: WriteAtifInput,
): Promise<AtifReceipt> {
  const projection = await projectAtifTrajectory(input);
  if (projection.skippedEventTypes) {
    console.warn(
      `ATIF projection skipped unrecognized ${input.adapter} events: ${JSON.stringify(projection.skippedEventTypes)}`,
    );
  }
  const bytes = canonicalJson(projection.trajectory as unknown as JsonValue);
  const outputDirectory = await realpath(input.outputDirectory);
  const rootInfo = await lstat(outputDirectory);
  if (!rootInfo.isDirectory()) {
    throw new Error("ATIF output directory must be a directory");
  }
  const outputPath = join(outputDirectory, OUTPUT_NAME);
  const temporaryPath = join(
    outputDirectory,
    `.trajectory.atif.json.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  let created = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, outputPath);
      created = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
  } finally {
    if (temporaryExists) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }
  if (created) await syncDirectory(outputDirectory);
  await verifyExistingOutput(outputPath, bytes);
  return {
    schemaVersion: 1,
    kind: "clash.benchmark.atif-receipt",
    format: "ATIF-v1.7",
    path: OUTPUT_NAME,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    fidelity: projection.fidelity,
    redactionCount: projection.redactionCount,
    trainingEligible: projection.trainingEligible,
    source: projection.source,
  };
}

export async function writeCodexAtifTrajectory(
  input: WriteCodexAtifInput,
): Promise<CodexAtifReceipt> {
  if (input.adapter !== "codex") {
    throw new Error("ATIF structured projection currently only supports Codex");
  }
  return writeAtifTrajectory(input);
}
