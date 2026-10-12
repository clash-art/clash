import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { BenchmarkAgent } from "./types";
import { effectiveMcpToolName } from "./product-operations";

type ObservationRecord = {
  line: number;
  observedAt: string;
  monotonicMs: number;
  rawLineSha256: string;
  parsed: boolean;
  type?: string;
};

export type TrajectoryAction = {
  sequence: number;
  source: "codex" | "claude" | "pi" | "clash-cli";
  sourceLine: number;
  kind: "mcp" | "cli" | "shell";
  operation: string;
  status: "started" | "succeeded" | "failed";
  observedAt: string;
  monotonicMs: number;
  correlationId?: string;
  error?: string;
};

/**
 * Non-gating usability diagnostics. These describe how hard Clash was to drive,
 * never whether the produced artifact is good, so no gate may read them.
 */
export type TrajectoryUsability = {
  /** Canonical invocation count; the Action-named field remains for schema-v1 readers. */
  successfulClashInvocationCount?: number;
  /** Canonical invocation count; the Action-named field remains for schema-v1 readers. */
  failedClashInvocationCount?: number;
  successfulClashActionCount: number;
  failedClashActionCount: number;
  errorCodes: string[];
  recoveryCount: number;
  parameterErrorCount: number;
  /** Canonical invocation count; the Action-named field remains for schema-v1 readers. */
  helpInvocationCount?: number;
  helpActionCount: number;
  /** Canonical invocation count; the Action-named field remains for schema-v1 readers. */
  contractDiscoveryInvocationCount?: number;
  contractDiscoveryActionCount: number;
  contractResponseBytes: number;
  largestContractResponseBytes: number;
  timeToFirstSuccessfulMutationMs?: number;
  transportsUsed: Array<"mcp" | "cli">;
  transportSwitchCount: number;
};

export type NormalizedTrajectory = {
  schemaVersion: 1;
  sourceTraces: Array<{
    kind:
      | "codex-events"
      | "claude-events"
      | "pi-events"
      | "acp-events"
      | "command-stdout"
      | "runner-observations"
      | "clash-cli-events";
    path: string;
    sha256: string;
    bytes: number;
    lines: number;
  }>;
  actions: TrajectoryAction[];
  repairs: Array<{
    operation: string;
    failedSequence: number;
    recoverySequence: number;
  }>;
  turns: Array<{
    status: "completed" | "failed";
    turnCount?: number;
    usage: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
    };
    error?: string;
  }>;
  usage: {
    turnCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  };
  errors: Array<{
    source: "codex" | "claude" | "pi" | "clash-cli";
    sourceLine: number;
    message: string;
  }>;
  summary: {
    /** Schema-v1 compatibility alias for lifecycleEventCount. */
    actionCount: number;
    /** Present on newly normalized schema-v1 traces. */
    lifecycleEventCount?: number;
    /** Distinct tool/command calls represented by the lifecycle events. */
    invocationCount?: number;
    /** Canonical invocation count; failedActionCount remains for schema-v1 readers. */
    failedInvocationCount?: number;
    failedActionCount: number;
    repairCount: number;
    turnCount: number;
  };
  usability: TrajectoryUsability;
};

function roundMonotonicMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function parseLineType(rawLine: string): { parsed: boolean; type?: string } {
  try {
    const value = JSON.parse(rawLine) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { parsed: true };
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" ? { parsed: true, type } : { parsed: true };
  } catch {
    return { parsed: false };
  }
}

export async function captureObservedOutput(input: {
  stream: Readable;
  rawPath: string;
  observedPath: string;
  startedMonotonic: bigint;
}): Promise<void> {
  const rawFile = await open(input.rawPath, "w");
  const observedFile = await open(input.observedPath, "w");
  const decoder = new TextDecoder();
  let pending = "";
  let lineNumber = 0;

  const observeLine = async (
    rawLineWithPossibleCarriageReturn: string,
  ): Promise<void> => {
    const rawLine = rawLineWithPossibleCarriageReturn.endsWith("\r")
      ? rawLineWithPossibleCarriageReturn.slice(0, -1)
      : rawLineWithPossibleCarriageReturn;
    lineNumber += 1;
    const parsed = parseLineType(rawLine);
    const observation: ObservationRecord = {
      line: lineNumber,
      observedAt: new Date().toISOString(),
      monotonicMs: roundMonotonicMs(
        Number(process.hrtime.bigint() - input.startedMonotonic) / 1_000_000,
      ),
      rawLineSha256: createHash("sha256").update(rawLine).digest("hex"),
      ...parsed,
    };
    await observedFile.write(
      `${JSON.stringify(observation)}\n`,
      undefined,
      "utf8",
    );
  };

  const captureLine = async (
    rawLineWithPossibleCarriageReturn: string,
    hasNewline: boolean,
  ): Promise<void> => {
    const rawLine = rawLineWithPossibleCarriageReturn.endsWith("\r")
      ? rawLineWithPossibleCarriageReturn.slice(0, -1)
      : rawLineWithPossibleCarriageReturn;
    await rawFile.write(
      `${rawLineWithPossibleCarriageReturn}${hasNewline ? "\n" : ""}`,
      undefined,
      "utf8",
    );
    await observeLine(rawLine);
  };

  try {
    for await (const value of input.stream) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value as Uint8Array);
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        await captureLine(pending.slice(0, newline), true);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) await captureLine(pending, false);
  } finally {
    await Promise.all([rawFile.close(), observedFile.close()]);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function hashFile(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const value of createReadStream(path)) {
    const chunk = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value as Uint8Array);
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function readJsonLines(
  path: string,
): Promise<Array<{ line: number; value: unknown }>> {
  const lines: Array<{ line: number; value: unknown }> = [];
  const reader = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      lines.push({ line: lineNumber, value: JSON.parse(line) as unknown });
    } catch {
      // The raw source remains authoritative even when a producer emits a non-JSON line.
    }
  }
  return lines;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.message === "string" && record.message.trim())
    return record.message.trim();
  try {
    return JSON.stringify(record);
  } catch {
    return String(value);
  }
}

function contentMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value)) return errorMessage(value);
  const text = value
    .flatMap((item) => {
      const record = asRecord(item);
      return record && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

const DOMAIN_FAILURE_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "rejected",
]);

function structuredRecordFailureMessage(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const status =
    typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  const explicitFailure =
    DOMAIN_FAILURE_STATUSES.has(status) ||
    record.isError === true ||
    record.ok === false ||
    record.success === false ||
    record.succeeded === false;
  const diagnostic = errorMessage(record.error);
  if (!explicitFailure && diagnostic === undefined) return undefined;
  return (
    diagnostic ??
    errorMessage(record.message) ??
    (status ? `Tool result reported status '${status}'` : "Tool result failed")
  );
}

function structuredResultFailureMessage(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) return undefined;
  const details = asRecord(record.details);
  const candidates: unknown[] = [
    record.structuredContent,
    record.structured_content,
    details?.structuredContent,
    details?.structured_content,
  ];
  if (Array.isArray(record.content)) {
    for (const candidate of record.content) {
      const block = asRecord(candidate);
      if (!block) continue;
      const blockDetails = asRecord(block.details);
      candidates.push(
        block.structuredContent,
        block.structured_content,
        blockDetails?.structuredContent,
        blockDetails?.structured_content,
      );
    }
  }
  for (const candidate of candidates) {
    const failure = structuredRecordFailureMessage(candidate);
    if (failure) return failure;
  }
  return structuredRecordFailureMessage(record);
}

function responseByteLength(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized);
  } catch {
    return undefined;
  }
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeUsage(
  value: unknown,
): NormalizedTrajectory["turns"][number]["usage"] {
  const usage = asRecord(value) ?? {};
  return {
    inputTokens: usageNumber(usage.input_tokens),
    cachedInputTokens: usageNumber(usage.cached_input_tokens),
    outputTokens: usageNumber(usage.output_tokens),
    reasoningOutputTokens: usageNumber(usage.reasoning_output_tokens),
  };
}

function normalizeClaudeUsage(
  value: unknown,
): NormalizedTrajectory["turns"][number]["usage"] {
  const usage = asRecord(value) ?? {};
  return {
    inputTokens: usageNumber(usage.input_tokens),
    cachedInputTokens: usageNumber(usage.cache_read_input_tokens),
    outputTokens: usageNumber(usage.output_tokens),
    reasoningOutputTokens: 0,
  };
}

function normalizePiUsage(
  value: unknown,
): NormalizedTrajectory["turns"][number]["usage"] {
  const usage = asRecord(value) ?? {};
  return {
    inputTokens: usageNumber(usage.input),
    cachedInputTokens: usageNumber(usage.cacheRead),
    outputTokens: usageNumber(usage.output),
    reasoningOutputTokens: usageNumber(usage.reasoning),
  };
}

function normalizeAcpUsage(
  value: unknown,
): NormalizedTrajectory["turns"][number]["usage"] {
  const usage = asRecord(value) ?? {};
  return {
    inputTokens: usageNumber(usage.inputTokens),
    cachedInputTokens: usageNumber(usage.cachedReadTokens),
    outputTokens: usageNumber(usage.outputTokens),
    reasoningOutputTokens: usageNumber(usage.thoughtTokens),
  };
}

/**
 * Names the product operation behind a tool call, for both Pi's own event
 * stream and ACP `tool_call` updates. `acpKind` is the standard ACP category
 * an agent reports when it does not expose its own tool identifier.
 */
function agentToolOperation(
  toolName: string | undefined,
  args: Record<string, unknown>,
  acpKind?: string,
): { kind: "mcp" | "shell"; operation: string } | undefined {
  const rawMcpName =
    toolName === undefined
      ? undefined
      : (/^mcp__clash__(.+)$/u.exec(toolName)?.[1] ??
        (toolName.startsWith("clash") ? toolName : undefined));
  if (rawMcpName) {
    return {
      kind: "mcp",
      operation: `clash/${effectiveMcpToolName({ tool: rawMcpName, arguments: args }) ?? rawMcpName}`,
    };
  }
  const isShell =
    toolName === "bash" || (toolName === undefined && acpKind === "execute");
  return isShell && typeof args.command === "string"
    ? { kind: "shell", operation: args.command }
    : undefined;
}

function cliOperation(argv: string[]): string {
  const operation: string[] = [];
  for (const argument of argv) {
    if (argument.startsWith("-")) break;
    operation.push(argument);
    if (operation.length === 2) break;
  }
  const helpMarker = argv.find((argument) => HELP_FLAGS.has(argument));
  if (helpMarker && !operation.includes(helpMarker)) {
    operation.push(helpMarker);
  }
  return operation.join(" ") || argv[0] || "clash";
}

type PendingAction = Omit<TrajectoryAction, "sequence"> & {
  epochMs: number;
  stableOrder: number;
};

type PendingLifecycle = {
  started?: PendingAction;
  settled?: PendingAction;
};

function lifecycleByCorrelation(
  actions: PendingAction[],
  predicate: (action: PendingAction) => boolean,
): Map<string, PendingLifecycle> {
  const lifecycles = new Map<string, PendingLifecycle>();
  for (const action of actions) {
    if (!predicate(action) || !action.correlationId) continue;
    const lifecycle = lifecycles.get(action.correlationId) ?? {};
    if (action.status === "started") lifecycle.started = action;
    else lifecycle.settled = action;
    lifecycles.set(action.correlationId, lifecycle);
  }
  return lifecycles;
}

function shellContainsCliOperation(
  shellOperation: string,
  cliOperationName: string,
): boolean {
  const clash =
    /(?:^|\s|["'`])(?:[^\s"'`]*\/)?clash(?:-cli)?(?:\.[cm]?js)?(?=$|\s|["'`])/u.exec(
      shellOperation,
    );
  if (!clash) return false;
  const tail = shellOperation.slice(clash.index + clash[0].length);
  let cursor = 0;
  for (const token of cliOperationName.split(/\s+/u).filter(Boolean)) {
    const tokenIndex = tail.indexOf(token, cursor);
    if (tokenIndex < 0) return false;
    cursor = tokenIndex + token.length;
  }
  return true;
}

function withoutSealedCliShellEnvelopes(
  actions: PendingAction[],
): PendingAction[] {
  const sealedCliLifecycles = [
    ...lifecycleByCorrelation(
      actions,
      (action) => action.source === "clash-cli" && action.kind === "cli",
    ).values(),
  ].filter(
    (lifecycle): lifecycle is Required<PendingLifecycle> =>
      lifecycle.started !== undefined && lifecycle.settled !== undefined,
  );
  if (sealedCliLifecycles.length === 0) return actions;

  const shellLifecycles = lifecycleByCorrelation(
    actions,
    (action) => action.source === "codex" && action.kind === "shell",
  );
  const duplicateShellIds = new Set<string>();
  for (const cli of sealedCliLifecycles) {
    let closestShellId: string | undefined;
    let closestBoundaryDistance = Number.POSITIVE_INFINITY;
    for (const [correlationId, shell] of shellLifecycles) {
      const { started, settled } = shell;
      if (
        duplicateShellIds.has(correlationId) ||
        !started ||
        !settled ||
        started.epochMs > cli.settled.epochMs ||
        cli.started.epochMs > settled.epochMs ||
        !shellContainsCliOperation(started.operation, cli.started.operation)
      ) {
        continue;
      }
      const boundaryDistance =
        Math.abs(started.epochMs - cli.started.epochMs) +
        Math.abs(settled.epochMs - cli.settled.epochMs);
      if (boundaryDistance < closestBoundaryDistance) {
        closestShellId = correlationId;
        closestBoundaryDistance = boundaryDistance;
      }
    }
    if (closestShellId) duplicateShellIds.add(closestShellId);
  }
  return actions.filter(
    (action) =>
      action.source !== "codex" ||
      action.kind !== "shell" ||
      !action.correlationId ||
      !duplicateShellIds.has(action.correlationId),
  );
}

function actionStatus(
  envelopeType: string,
  item: Record<string, unknown>,
): TrajectoryAction["status"] {
  if (envelopeType === "item.started" || item.status === "in_progress")
    return "started";
  const failed =
    Boolean(errorMessage(item.error)) ||
    item.status === "failed" ||
    (typeof item.exit_code === "number" && item.exit_code !== 0);
  return failed ? "failed" : "succeeded";
}

function inferRunOrigin(observations: ObservationRecord[]): number {
  const first = observations.find((observation) =>
    Number.isFinite(Date.parse(observation.observedAt)),
  );
  return first ? Date.parse(first.observedAt) - first.monotonicMs : Date.now();
}

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

const CONTRACT_DISCOVERY_VERBS = new Set([
  "capabilities",
  "contract",
  "describe",
  "docs",
  "manifest",
  "schema",
  "schemas",
  "spec",
]);

/** A dispatcher tool that never resolved to a leaf was a menu or discovery call. */
const MCP_ROOT_TOOLS = new Set([
  "clash",
  "clash_assets",
  "clash_canvas",
  "clash_composition",
  "clash_director",
  "clash_timeline",
  "clash_workspace",
]);

type ProductOperationEffect = "read" | "mutation";

const PRODUCT_OPERATION_EFFECT_BY_VERB = new Map<
  string,
  ProductOperationEffect
>([
  ["capabilities", "read"],
  ["contract", "read"],
  ["describe", "read"],
  ["docs", "read"],
  ["get", "read"],
  ["list", "read"],
  ["manifest", "read"],
  ["pull", "read"],
  ["schema", "read"],
  ["schemas", "read"],
  ["spec", "read"],
  ["status", "read"],
  ["validate", "read"],
  ["add", "mutation"],
  ["append", "mutation"],
  ["apply", "mutation"],
  ["capture", "mutation"],
  ["create", "mutation"],
  ["delete", "mutation"],
  ["duplicate", "mutation"],
  ["generate", "mutation"],
  ["import", "mutation"],
  ["insert", "mutation"],
  ["move", "mutation"],
  ["patch", "mutation"],
  ["remove", "mutation"],
  ["rename", "mutation"],
  ["render", "mutation"],
  ["restore", "mutation"],
  ["save", "mutation"],
  ["set", "mutation"],
  ["trash", "mutation"],
  ["update", "mutation"],
  ["upload", "mutation"],
  ["write", "mutation"],
]);

/** Codes meaning the caller could not express the call, not that Clash refused it. */
const PARAMETER_ERROR_CODE_PREFIXES = [
  "INVALID_",
  "MISSING_",
  "UNKNOWN_",
  "UNRECOGNIZED_",
];
const PARAMETER_ERROR_MESSAGE =
  /unknown (?:option|argument|command|tool|flag)|unrecognized (?:option|argument)|invalid (?:option|argument|value|input|parameter)|missing required (?:option|argument|flag|parameter)/iu;

function clashTransport(action: TrajectoryAction): "mcp" | "cli" | undefined {
  return action.kind === "mcp" || action.kind === "cli"
    ? action.kind
    : undefined;
}

function mcpToolName(operation: string): string {
  const separator = operation.indexOf("/");
  return separator >= 0 ? operation.slice(separator + 1) : operation;
}

function productOperationEffect(
  action: TrajectoryAction,
): ProductOperationEffect | undefined {
  if (isHelpAction(action)) return undefined;
  const tokens =
    action.kind === "mcp"
      ? mcpToolName(action.operation).split("_").filter(Boolean)
      : action.operation
          .split(/\s+/u)
          .filter((token) => token && !token.startsWith("-"));
  let effect: ProductOperationEffect | undefined;
  for (const token of tokens) {
    const candidate = PRODUCT_OPERATION_EFFECT_BY_VERB.get(token);
    if (candidate === "mutation") return candidate;
    if (candidate === "read") effect = candidate;
  }
  return effect;
}

function isContractDiscoveryOperation(operation: string): boolean {
  const tool = mcpToolName(operation);
  return (
    MCP_ROOT_TOOLS.has(tool) ||
    CONTRACT_DISCOVERY_VERBS.has(
      tool
        .split(/[_\s/]+/u)
        .filter(Boolean)
        .at(-1) ?? "",
    )
  );
}

function isHelpAction(action: TrajectoryAction): boolean {
  if (action.kind === "mcp") return false;
  const tokens = action.operation
    .split(/\s+/u)
    .map((token) => token.replace(/^[`'";]+|[`'";]+$/gu, ""));
  const isClashCommandLine = tokens.some((token) =>
    /(?:^|\/)clash(?:-cli)?(?:\.[cm]?js)?$/u.test(token),
  );
  if (action.kind === "shell" && !isClashCommandLine) return false;
  return tokens.some((token) => HELP_FLAGS.has(token));
}

function failureCode(message: string | undefined): string | undefined {
  return message
    ? /^([A-Z][A-Z0-9_]{2,}):/u.exec(message.trim())?.[1]
    : undefined;
}

function isParameterFailure(
  code: string | undefined,
  message: string | undefined,
): boolean {
  if (
    code &&
    (PARAMETER_ERROR_CODE_PREFIXES.some((prefix) => code.startsWith(prefix)) ||
      /VALIDATION|SCHEMA/u.test(code))
  ) {
    return true;
  }
  return message !== undefined && PARAMETER_ERROR_MESSAGE.test(message);
}

export function summarizeTrajectoryUsability(input: {
  actions: TrajectoryAction[];
  repairs: NormalizedTrajectory["repairs"];
  contractResponses?: Array<{ operation: string; bytes: number }>;
}): TrajectoryUsability {
  // Started actions are paired with their own terminal action, so counting both would double.
  const settled = input.actions.filter((action) => action.status !== "started");
  const clashActions = settled.filter(
    (action) => clashTransport(action) !== undefined,
  );

  const errorCodes: string[] = [];
  let parameterErrorCount = 0;
  for (const action of clashActions) {
    if (action.status !== "failed") continue;
    const code = failureCode(action.error);
    if (code && !errorCodes.includes(code)) errorCodes.push(code);
    if (isParameterFailure(code, action.error)) parameterErrorCount += 1;
  }

  const transportsUsed: Array<"mcp" | "cli"> = [];
  let transportSwitchCount = 0;
  let previousTransport: "mcp" | "cli" | undefined;
  for (const action of clashActions) {
    const transport = clashTransport(action);
    if (!transport) continue;
    if (!transportsUsed.includes(transport)) transportsUsed.push(transport);
    if (previousTransport && previousTransport !== transport)
      transportSwitchCount += 1;
    previousTransport = transport;
  }

  const contractBytes = (input.contractResponses ?? [])
    .filter((response) => isContractDiscoveryOperation(response.operation))
    .map((response) => response.bytes);
  const firstMutation = clashActions.find(
    (action) =>
      action.status === "succeeded" &&
      productOperationEffect(action) === "mutation",
  );
  const successfulClashInvocationCount = clashActions.filter(
    (action) => action.status === "succeeded",
  ).length;
  const failedClashInvocationCount = clashActions.filter(
    (action) => action.status === "failed",
  ).length;
  const helpInvocationCount = settled.filter((action) =>
    isHelpAction(action),
  ).length;
  const contractDiscoveryInvocationCount = settled.filter(
    (action) =>
      clashTransport(action) !== undefined &&
      isContractDiscoveryOperation(action.operation),
  ).length;

  return {
    successfulClashInvocationCount,
    failedClashInvocationCount,
    successfulClashActionCount: successfulClashInvocationCount,
    failedClashActionCount: failedClashInvocationCount,
    errorCodes,
    recoveryCount: input.repairs.length,
    parameterErrorCount,
    helpInvocationCount,
    helpActionCount: helpInvocationCount,
    contractDiscoveryInvocationCount,
    contractDiscoveryActionCount: contractDiscoveryInvocationCount,
    contractResponseBytes: contractBytes.reduce(
      (total, bytes) => total + bytes,
      0,
    ),
    largestContractResponseBytes: contractBytes.reduce(
      (largest, bytes) => Math.max(largest, bytes),
      0,
    ),
    ...(firstMutation
      ? {
          timeToFirstSuccessfulMutationMs: roundMonotonicMs(
            firstMutation.monotonicMs,
          ),
        }
      : {}),
    transportsUsed,
    transportSwitchCount,
  };
}

export async function writeNormalizedTrajectory(input: {
  agent: BenchmarkAgent;
  logsRoot: string;
  rawPath: string;
  observedPath: string;
}): Promise<string> {
  const trajectoryPath = join(input.logsRoot, "trajectory.json");
  const rawLines = await readJsonLines(input.rawPath);
  // Pi is driven over ACP; logs recorded before that hold Pi's own events.
  const acpLog =
    input.agent.adapter === "pi" &&
    asRecord(rawLines[0]?.value)?.type === "acp.session";
  const rawKind =
    input.agent.adapter === "codex"
      ? "codex-events"
      : input.agent.adapter === "claude"
        ? "claude-events"
        : acpLog
          ? "acp-events"
          : input.agent.adapter === "pi"
            ? "pi-events"
            : "command-stdout";
  const observationLines = await readJsonLines(input.observedPath);
  const observations = observationLines.flatMap(({ value }) => {
    const record = asRecord(value);
    return record &&
      typeof record.line === "number" &&
      typeof record.observedAt === "string" &&
      typeof record.monotonicMs === "number" &&
      typeof record.rawLineSha256 === "string"
      ? [
          {
            line: record.line,
            observedAt: record.observedAt,
            monotonicMs: record.monotonicMs,
            rawLineSha256: record.rawLineSha256,
            parsed: record.parsed === true,
            ...(typeof record.type === "string" ? { type: record.type } : {}),
          } satisfies ObservationRecord,
        ]
      : [];
  });
  const observationByLine = new Map(
    observations.map((observation) => [observation.line, observation]),
  );
  const runOriginEpochMs = inferRunOrigin(observations);
  const pendingActions: PendingAction[] = [];
  const turns: NormalizedTrajectory["turns"] = [];
  const errors: NormalizedTrajectory["errors"] = [];
  const claudeTools = new Map<
    string,
    { kind: "mcp" | "shell"; operation: string }
  >();
  const seenClaudeToolUses = new Set<string>();
  const piTools = new Map<
    string,
    { kind: "mcp" | "shell"; operation: string }
  >();
  const acpTools = new Map<
    string,
    {
      name?: string;
      acpKind?: string;
      args: Record<string, unknown>;
      started?: { kind: "mcp" | "shell"; operation: string };
    }
  >();
  const acpMessageIds = new Set<string>();
  const contractResponses: Array<{ operation: string; bytes: number }> = [];
  let stableOrder = 0;

  for (const { line, value } of rawLines) {
    const envelope = asRecord(value);
    if (!envelope || typeof envelope.type !== "string") continue;
    const observation = observationByLine.get(line);
    const observedAt =
      observation?.observedAt ?? new Date(runOriginEpochMs).toISOString();
    const monotonicMs = observation?.monotonicMs ?? 0;
    if (acpLog) {
      if (
        envelope.type === "acp.prompt_complete" ||
        envelope.type === "acp.prompt_error"
      ) {
        const failed =
          envelope.type === "acp.prompt_error" ||
          envelope.stopReason !== "end_turn";
        const message = failed
          ? (errorMessage(envelope.message) ??
            `ACP turn stopped with '${String(envelope.stopReason)}'`)
          : undefined;
        turns.push({
          status: failed ? "failed" : "completed",
          turnCount: Math.max(1, acpMessageIds.size),
          usage: normalizeAcpUsage(envelope.usage),
          ...(message ? { error: message } : {}),
        });
        if (message) errors.push({ source: "pi", sourceLine: line, message });
        continue;
      }
      const update =
        envelope.type === "acp.session_update"
          ? asRecord(envelope.update)
          : undefined;
      if (!update) continue;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        typeof update.messageId === "string"
      ) {
        acpMessageIds.add(update.messageId);
        continue;
      }
      if (
        (update.sessionUpdate !== "tool_call" &&
          update.sessionUpdate !== "tool_call_update") ||
        typeof update.toolCallId !== "string"
      ) {
        continue;
      }
      const toolCallId = update.toolCallId;
      const tool = acpTools.get(toolCallId) ?? { args: {} };
      acpTools.set(toolCallId, tool);
      if (typeof update.name === "string") tool.name = update.name;
      if (typeof update.kind === "string") tool.acpKind = update.kind;
      const rawInput = asRecord(update.rawInput);
      if (rawInput) tool.args = rawInput;
      const settled =
        update.status === "completed" || update.status === "failed";
      // Arguments stream while the call is `pending`; it starts executing,
      // with complete arguments, at `in_progress`.
      if (!tool.started && (update.status === "in_progress" || settled)) {
        tool.started = agentToolOperation(tool.name, tool.args, tool.acpKind);
        if (tool.started) {
          stableOrder += 1;
          pendingActions.push({
            source: "pi",
            sourceLine: line,
            ...tool.started,
            status: "started",
            observedAt,
            monotonicMs,
            correlationId: toolCallId,
            epochMs: Date.parse(observedAt),
            stableOrder,
          });
        }
      }
      if (!settled) continue;
      acpTools.delete(toolCallId);
      const pending = tool.started;
      if (!pending) continue;
      const result = asRecord(update.rawOutput);
      const domainFailure =
        pending.kind === "mcp"
          ? structuredResultFailureMessage(result)
          : undefined;
      const failed = update.status === "failed" || domainFailure !== undefined;
      const failure = failed
        ? (domainFailure ??
          contentMessage(result?.content) ??
          "ACP tool call failed")
        : undefined;
      const responseBytes = responseByteLength(result?.content);
      if (pending.kind === "mcp" && responseBytes !== undefined) {
        contractResponses.push({
          operation: pending.operation,
          bytes: responseBytes,
        });
      }
      stableOrder += 1;
      pendingActions.push({
        source: "pi",
        sourceLine: line,
        ...pending,
        status: failed ? "failed" : "succeeded",
        observedAt,
        monotonicMs,
        correlationId: toolCallId,
        ...(failure ? { error: failure } : {}),
        epochMs: Date.parse(observedAt),
        stableOrder,
      });
      continue;
    }
    if (input.agent.adapter === "pi") {
      if (envelope.type === "turn_end") {
        const message = asRecord(envelope.message);
        turns.push({
          status: "completed",
          usage: normalizePiUsage(message?.usage),
        });
        continue;
      }
      if (
        envelope.type !== "tool_execution_start" &&
        envelope.type !== "tool_execution_end"
      ) {
        continue;
      }
      const toolCallId =
        typeof envelope.toolCallId === "string"
          ? envelope.toolCallId
          : undefined;
      const toolName =
        typeof envelope.toolName === "string" ? envelope.toolName : undefined;
      if (!toolCallId || !toolName) continue;
      if (envelope.type === "tool_execution_start") {
        const classified = agentToolOperation(
          toolName,
          asRecord(envelope.args) ?? {},
        );
        if (!classified) continue;
        const { kind, operation } = classified;
        piTools.set(toolCallId, classified);
        stableOrder += 1;
        pendingActions.push({
          source: "pi",
          sourceLine: line,
          kind,
          operation,
          status: "started",
          observedAt,
          monotonicMs,
          correlationId: toolCallId,
          epochMs: Date.parse(observedAt),
          stableOrder,
        });
        continue;
      }
      const pending = piTools.get(toolCallId);
      if (!pending) continue;
      const result = asRecord(envelope.result);
      const domainFailure =
        pending.kind === "mcp"
          ? structuredResultFailureMessage(result)
          : undefined;
      const failed = envelope.isError === true || domainFailure !== undefined;
      const failure = failed
        ? (domainFailure ??
          contentMessage(result?.content) ??
          "Pi tool call failed")
        : undefined;
      const responseBytes = responseByteLength(result?.content);
      if (pending.kind === "mcp" && responseBytes !== undefined) {
        contractResponses.push({
          operation: pending.operation,
          bytes: responseBytes,
        });
      }
      stableOrder += 1;
      pendingActions.push({
        source: "pi",
        sourceLine: line,
        kind: pending.kind,
        operation: pending.operation,
        status: failed ? "failed" : "succeeded",
        observedAt,
        monotonicMs,
        correlationId: toolCallId,
        ...(failure ? { error: failure } : {}),
        epochMs: Date.parse(observedAt),
        stableOrder,
      });
      piTools.delete(toolCallId);
      continue;
    }
    if (input.agent.adapter === "claude" && envelope.type === "result") {
      const failed =
        envelope.is_error === true || envelope.subtype !== "success";
      const message = failed
        ? (errorMessage(envelope.error) ?? errorMessage(envelope.result))
        : undefined;
      turns.push({
        status: failed ? "failed" : "completed",
        turnCount:
          typeof envelope.num_turns === "number" && envelope.num_turns > 0
            ? envelope.num_turns
            : 1,
        usage: normalizeClaudeUsage(envelope.usage),
        ...(message ? { error: message } : {}),
      });
      if (message) errors.push({ source: "claude", sourceLine: line, message });
      continue;
    }
    if (input.agent.adapter === "claude") {
      const message = asRecord(envelope.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      if (envelope.type === "assistant") {
        for (const candidate of content) {
          const toolUse = asRecord(candidate);
          if (
            toolUse?.type !== "tool_use" ||
            typeof toolUse.id !== "string" ||
            typeof toolUse.name !== "string" ||
            seenClaudeToolUses.has(toolUse.id)
          ) {
            continue;
          }
          const toolInput = asRecord(toolUse.input) ?? {};
          let kind: "mcp" | "shell" | undefined;
          let operation: string | undefined;
          const mcpName = /^mcp__([^]+?)__(.+)$/u.exec(toolUse.name);
          if (mcpName) {
            kind = "mcp";
            operation = `${mcpName[1]}/${
              effectiveMcpToolName({
                tool: mcpName[2],
                arguments: toolInput,
              }) ?? mcpName[2]
            }`;
          } else if (toolUse.name === "Bash") {
            kind = "shell";
            operation =
              typeof toolInput.command === "string"
                ? toolInput.command
                : "shell";
          }
          if (!kind || !operation) continue;
          seenClaudeToolUses.add(toolUse.id);
          claudeTools.set(toolUse.id, { kind, operation });
          stableOrder += 1;
          pendingActions.push({
            source: "claude",
            sourceLine: line,
            kind,
            operation,
            status: "started",
            observedAt,
            monotonicMs,
            correlationId: toolUse.id,
            epochMs: Date.parse(observedAt),
            stableOrder,
          });
        }
      } else if (envelope.type === "user") {
        for (const candidate of content) {
          const toolResult = asRecord(candidate);
          if (
            toolResult?.type !== "tool_result" ||
            typeof toolResult.tool_use_id !== "string"
          ) {
            continue;
          }
          const pending = claudeTools.get(toolResult.tool_use_id);
          if (!pending) continue;
          const domainFailure =
            pending.kind === "mcp"
              ? structuredResultFailureMessage(toolResult)
              : undefined;
          const failed =
            toolResult.is_error === true || domainFailure !== undefined;
          const failure = failed
            ? (domainFailure ??
              contentMessage(toolResult.content) ??
              "Claude tool call failed")
            : undefined;
          const responseBytes = responseByteLength(toolResult.content);
          if (pending.kind === "mcp" && responseBytes !== undefined) {
            contractResponses.push({
              operation: pending.operation,
              bytes: responseBytes,
            });
          }
          stableOrder += 1;
          pendingActions.push({
            source: "claude",
            sourceLine: line,
            kind: pending.kind,
            operation: pending.operation,
            status: failed ? "failed" : "succeeded",
            observedAt,
            monotonicMs,
            correlationId: toolResult.tool_use_id,
            ...(failure ? { error: failure } : {}),
            epochMs: Date.parse(observedAt),
            stableOrder,
          });
          claudeTools.delete(toolResult.tool_use_id);
        }
      }
      continue;
    }
    if (envelope.type === "turn.completed" || envelope.type === "turn.failed") {
      const turnError = errorMessage(envelope.error);
      turns.push({
        status: envelope.type === "turn.failed" ? "failed" : "completed",
        usage: normalizeUsage(envelope.usage),
        ...(turnError ? { error: turnError } : {}),
      });
      if (turnError)
        errors.push({ source: "codex", sourceLine: line, message: turnError });
      continue;
    }
    const item = asRecord(envelope.item);
    if (!item) continue;
    if (item.type === "error") {
      const message = errorMessage(item.message) ?? "Unknown Codex error";
      errors.push({ source: "codex", sourceLine: line, message });
      continue;
    }
    if (item.type !== "mcp_tool_call" && item.type !== "command_execution")
      continue;
    const kind = item.type === "mcp_tool_call" ? "mcp" : "shell";
    const operation =
      kind === "mcp"
        ? `${typeof item.server === "string" ? item.server : "unknown"}/${effectiveMcpToolName(item) ?? "unknown"}`
        : typeof item.command === "string"
          ? item.command
          : "shell";
    const domainFailure =
      kind === "mcp" ? structuredResultFailureMessage(item.result) : undefined;
    const status = domainFailure ? "failed" : actionStatus(envelope.type, item);
    const failure =
      status === "failed"
        ? (domainFailure ??
          errorMessage(item.error) ??
          (typeof item.exit_code === "number"
            ? `Command exited with code ${item.exit_code}`
            : "Action failed"))
        : undefined;
    const responseBytes = responseByteLength(item.result);
    if (kind === "mcp" && status !== "started" && responseBytes !== undefined) {
      contractResponses.push({ operation, bytes: responseBytes });
    }
    stableOrder += 1;
    pendingActions.push({
      source: "codex",
      sourceLine: line,
      kind,
      operation,
      status,
      observedAt,
      monotonicMs,
      ...(typeof item.id === "string" ? { correlationId: item.id } : {}),
      ...(failure ? { error: failure } : {}),
      epochMs: Date.parse(observedAt),
      stableOrder,
    });
  }

  const cliPath = join(input.logsRoot, "clash-cli-events.jsonl");
  const hasCliTrace = await pathExists(cliPath);
  const cliLines = hasCliTrace ? await readJsonLines(cliPath) : [];
  for (const { line, value } of cliLines) {
    const event = asRecord(value);
    if (
      !event ||
      (event.type !== "clash.cli.started" &&
        event.type !== "clash.cli.completed")
    )
      continue;
    if (event.origin === "mcp-transport") continue;
    const argv =
      Array.isArray(event.argv) &&
      event.argv.every((argument) => typeof argument === "string")
        ? (event.argv as string[])
        : [];
    const completed = event.type === "clash.cli.completed";
    const failed =
      completed &&
      (errorMessage(event.error) !== undefined || event.exitCode !== 0);
    const observedAt =
      completed && typeof event.finishedAt === "string"
        ? event.finishedAt
        : typeof event.startedAt === "string"
          ? event.startedAt
          : new Date(runOriginEpochMs).toISOString();
    const epochMs = Date.parse(observedAt);
    const failure = failed
      ? (errorMessage(event.error) ??
        (typeof event.exitCode === "number"
          ? `Clash CLI exited with code ${event.exitCode}`
          : "Clash CLI failed"))
      : undefined;
    stableOrder += 1;
    pendingActions.push({
      source: "clash-cli",
      sourceLine: line,
      kind: "cli",
      operation: cliOperation(argv),
      status: completed ? (failed ? "failed" : "succeeded") : "started",
      observedAt,
      monotonicMs: roundMonotonicMs(Math.max(0, epochMs - runOriginEpochMs)),
      ...(typeof event.pid === "number"
        ? { correlationId: String(event.pid) }
        : {}),
      ...(failure ? { error: failure } : {}),
      epochMs,
      stableOrder,
    });
  }

  const logicalActions = withoutSealedCliShellEnvelopes(pendingActions);
  logicalActions.sort(
    (left, right) =>
      left.epochMs - right.epochMs || left.stableOrder - right.stableOrder,
  );
  const actions: TrajectoryAction[] = logicalActions.map(
    ({ epochMs: _epochMs, stableOrder: _stableOrder, ...action }, index) => ({
      sequence: index + 1,
      ...action,
    }),
  );
  const failedByOperation = new Map<string, TrajectoryAction>();
  const repairs: NormalizedTrajectory["repairs"] = [];
  for (const action of actions) {
    const key = `${action.kind}:${action.operation}`;
    if (action.status === "failed") {
      failedByOperation.set(key, action);
    } else if (action.status === "succeeded") {
      const failure = failedByOperation.get(key);
      if (failure) {
        repairs.push({
          operation: action.operation,
          failedSequence: failure.sequence,
          recoverySequence: action.sequence,
        });
        failedByOperation.delete(key);
      }
    }
  }
  for (const action of actions) {
    if (action.status === "failed" && action.error) {
      errors.push({
        source: action.source,
        sourceLine: action.sourceLine,
        message: action.error,
      });
    }
  }

  const sourceInputs: Array<{
    kind: NormalizedTrajectory["sourceTraces"][number]["kind"];
    path: string;
    lines: number;
  }> = [
    { kind: rawKind, path: input.rawPath, lines: rawLines.length },
    {
      kind: "runner-observations",
      path: input.observedPath,
      lines: observationLines.length,
    },
    ...(hasCliTrace
      ? [
          {
            kind: "clash-cli-events" as const,
            path: cliPath,
            lines: cliLines.length,
          },
        ]
      : []),
  ];
  const sourceTraces = await Promise.all(
    sourceInputs.map(async (source) => ({
      kind: source.kind,
      path: basename(source.path),
      ...(await hashFile(source.path)),
      lines: source.lines,
    })),
  );
  const usage = turns.reduce<NormalizedTrajectory["usage"]>(
    (total, turn) => ({
      turnCount: total.turnCount + (turn.turnCount ?? 1),
      inputTokens: total.inputTokens + turn.usage.inputTokens,
      cachedInputTokens: total.cachedInputTokens + turn.usage.cachedInputTokens,
      outputTokens: total.outputTokens + turn.usage.outputTokens,
      reasoningOutputTokens:
        total.reasoningOutputTokens + turn.usage.reasoningOutputTokens,
    }),
    {
      turnCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
  );
  const trajectory: NormalizedTrajectory = {
    schemaVersion: 1,
    sourceTraces,
    actions,
    repairs,
    turns,
    usage,
    errors,
    summary: {
      actionCount: actions.length,
      lifecycleEventCount: actions.length,
      invocationCount: new Set(
        actions.flatMap((action) =>
          action.correlationId
            ? [`${action.source}:${action.kind}:${action.correlationId}`]
            : action.status === "started"
              ? []
              : [`${action.source}:${action.kind}:sequence:${action.sequence}`],
        ),
      ).size,
      failedInvocationCount: actions.filter(
        (action) => action.status === "failed",
      ).length,
      failedActionCount: actions.filter((action) => action.status === "failed")
        .length,
      repairCount: repairs.length,
      turnCount: usage.turnCount,
    },
    usability: summarizeTrajectoryUsability({
      actions,
      repairs,
      contractResponses,
    }),
  };
  await writeFile(
    trajectoryPath,
    `${JSON.stringify(trajectory, null, 2)}\n`,
    "utf8",
  );
  return trajectoryPath;
}
