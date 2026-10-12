import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type RunnerSealedMcpCall = {
  tool: string;
  arguments: unknown;
  result: unknown;
  startedAt: string;
};

export type RunnerSealedMcpInvocation = {
  tool: string;
  arguments: unknown;
  startedAt: string;
  result?: unknown;
  error?: unknown;
  succeeded: boolean;
};

type JsonRpcId = string | number;

type StartedMcpEvent = {
  type: "clash.mcp.started";
  sessionId: string;
  invocationId: string;
  rpcId: JsonRpcId;
  startedAt: string;
  tool: string;
  arguments: unknown;
  argumentsSha256: string;
};

type CompletedMcpEvent = {
  type: "clash.mcp.completed";
  sessionId: string;
  invocationId: string;
  rpcId: JsonRpcId;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tool: string;
  argumentsSha256: string;
  result?: unknown;
  error?: unknown;
  resultSha256: string;
  succeeded: boolean;
};

type McpTraceEvent = StartedMcpEvent | CompletedMcpEvent;

type PendingMcpCall = {
  started: StartedMcpEvent;
  startedMonotonic: bigint;
};

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(value) ?? "undefined");
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return undefined;
}

function requestKey(sessionId: string, rpcId: JsonRpcId): string {
  return `${sessionId}\0${typeof rpcId}\0${String(rpcId)}`;
}

function resultSucceeded(result: unknown, error: unknown): boolean {
  return error === undefined && recordOf(result)?.isError !== true;
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createRunnerMcpTraceRecorder(): {
  observeClientMessage(sessionId: string, message: unknown): void;
  observeServerMessage(sessionId: string, message: unknown): void;
  seal(input: { logsRoot: string; caseId: string }): Promise<void>;
} {
  const events: McpTraceEvent[] = [];
  const pending = new Map<string, PendingMcpCall>();
  const seenToolRequests = new Set<string>();
  let valid = true;

  return {
    observeClientMessage(sessionId, message) {
      const request = recordOf(message);
      if (request?.method !== "tools/call") return;
      const rpcId = jsonRpcId(request.id);
      const params = recordOf(request.params);
      const tool = params?.name;
      if (rpcId === undefined || typeof tool !== "string" || !tool) {
        valid = false;
        return;
      }
      const key = requestKey(sessionId, rpcId);
      if (seenToolRequests.has(key)) {
        valid = false;
        return;
      }
      seenToolRequests.add(key);
      const argumentsValue = params?.arguments ?? {};
      const started: StartedMcpEvent = {
        type: "clash.mcp.started",
        sessionId,
        invocationId: randomUUID(),
        rpcId,
        startedAt: new Date().toISOString(),
        tool,
        arguments: argumentsValue,
        argumentsSha256: sha256Json(argumentsValue),
      };
      events.push(started);
      pending.set(key, { started, startedMonotonic: process.hrtime.bigint() });
    },
    observeServerMessage(sessionId, message) {
      const response = recordOf(message);
      if (typeof response?.method === "string") return;
      const rpcId = jsonRpcId(response?.id);
      if (rpcId === undefined) return;
      const key = requestKey(sessionId, rpcId);
      const call = pending.get(key);
      if (!call) {
        if (seenToolRequests.has(key)) valid = false;
        return;
      }
      pending.delete(key);
      const result = response?.result;
      const error = response?.error;
      if (result === undefined && error === undefined) {
        valid = false;
        return;
      }
      const succeeded = resultSucceeded(result, error);
      events.push({
        type: "clash.mcp.completed",
        sessionId,
        invocationId: call.started.invocationId,
        rpcId,
        startedAt: call.started.startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Number(
          (process.hrtime.bigint() - call.startedMonotonic) / 1_000_000n,
        ),
        tool: call.started.tool,
        argumentsSha256: call.started.argumentsSha256,
        ...(result === undefined ? {} : { result }),
        ...(error === undefined ? {} : { error }),
        resultSha256: sha256Json(error === undefined ? result : { error }),
        succeeded,
      });
    },
    async seal({ logsRoot, caseId }) {
      if (pending.size > 0) valid = false;
      const traceText = events.length
        ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
        : "";
      const tracePath = join(logsRoot, "clash-mcp-events.jsonl");
      await writeFile(tracePath, traceText, {
        encoding: "utf8",
        mode: 0o600,
      });
      await writeJsonAtomically(
        join(logsRoot, "clash-mcp-trace-receipt.json"),
        {
          schemaVersion: 1,
          source: "runner-mcp-relay",
          status: valid ? "sealed" : "invalid",
          caseId,
          tracePath: "clash-mcp-events.jsonl",
          traceSha256: sha256Text(traceText),
          eventCount: events.length,
        },
      );
    },
  };
}

function parseRunnerMcpTrace(traceText: string):
  | {
      eventCount: number;
      invocations: RunnerSealedMcpInvocation[];
    }
  | undefined {
  const pairs = new Map<
    string,
    { started: StartedMcpEvent; completed?: CompletedMcpEvent }
  >();
  let eventCount = 0;
  for (const line of traceText.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    eventCount += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
    const event = recordOf(parsed);
    if (!event) return undefined;
    const sessionId = event.sessionId;
    const invocationId = event.invocationId;
    const rpcId = jsonRpcId(event.rpcId);
    const startedAt = event.startedAt;
    const tool = event.tool;
    const argumentsSha256 = event.argumentsSha256;
    if (
      typeof sessionId !== "string" ||
      !UUID_V4.test(sessionId) ||
      typeof invocationId !== "string" ||
      !UUID_V4.test(invocationId) ||
      rpcId === undefined ||
      typeof startedAt !== "string" ||
      !Number.isFinite(Date.parse(startedAt)) ||
      typeof tool !== "string" ||
      !tool ||
      typeof argumentsSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(argumentsSha256)
    ) {
      return undefined;
    }
    if (event.type === "clash.mcp.started") {
      if (
        !("arguments" in event) ||
        sha256Json(event.arguments) !== argumentsSha256 ||
        pairs.has(invocationId)
      ) {
        return undefined;
      }
      pairs.set(invocationId, {
        started: event as unknown as StartedMcpEvent,
      });
      continue;
    }
    if (event.type !== "clash.mcp.completed") return undefined;
    const pair = pairs.get(invocationId);
    if (
      !pair ||
      pair.completed ||
      pair.started.sessionId !== sessionId ||
      pair.started.rpcId !== rpcId ||
      pair.started.startedAt !== startedAt ||
      pair.started.tool !== tool ||
      pair.started.argumentsSha256 !== argumentsSha256 ||
      typeof event.finishedAt !== "string" ||
      !Number.isFinite(Date.parse(event.finishedAt)) ||
      typeof event.durationMs !== "number" ||
      !Number.isFinite(event.durationMs) ||
      event.durationMs < 0 ||
      typeof event.succeeded !== "boolean" ||
      typeof event.resultSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(event.resultSha256) ||
      (!("result" in event) && !("error" in event)) ||
      ("result" in event && "error" in event) ||
      sha256Json("error" in event ? { error: event.error } : event.result) !==
        event.resultSha256 ||
      event.succeeded !== resultSucceeded(event.result, event.error)
    ) {
      return undefined;
    }
    pair.completed = event as unknown as CompletedMcpEvent;
  }
  if ([...pairs.values()].some(({ completed }) => !completed)) {
    return undefined;
  }
  return {
    eventCount,
    invocations: [...pairs.values()].map(({ started, completed }) => ({
      tool: started.tool,
      arguments: started.arguments,
      startedAt: started.startedAt,
      ...(completed?.result === undefined ? {} : { result: completed.result }),
      ...(completed?.error === undefined ? {} : { error: completed.error }),
      succeeded: completed!.succeeded,
    })),
  };
}

export async function readRunnerSealedMcpInvocations(input: {
  logsRoot: string;
  caseId: string;
}): Promise<RunnerSealedMcpInvocation[]> {
  try {
    const traceText = await readFile(
      join(input.logsRoot, "clash-mcp-events.jsonl"),
      "utf8",
    );
    const receipt = recordOf(
      JSON.parse(
        await readFile(
          join(input.logsRoot, "clash-mcp-trace-receipt.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const parsed = parseRunnerMcpTrace(traceText);
    if (
      !receipt ||
      receipt.schemaVersion !== 1 ||
      receipt.source !== "runner-mcp-relay" ||
      receipt.status !== "sealed" ||
      receipt.caseId !== input.caseId ||
      receipt.tracePath !== "clash-mcp-events.jsonl" ||
      receipt.traceSha256 !== sha256Text(traceText) ||
      !parsed ||
      receipt.eventCount !== parsed.eventCount
    ) {
      return [];
    }
    return parsed.invocations;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    return [];
  }
}

export async function readRunnerSealedMcpCalls(input: {
  logsRoot: string;
  caseId: string;
}): Promise<RunnerSealedMcpCall[]> {
  return (await readRunnerSealedMcpInvocations(input)).flatMap(
    ({ tool, arguments: argumentsValue, result, startedAt, succeeded }) =>
      succeeded ? [{ tool, arguments: argumentsValue, result, startedAt }] : [],
  );
}
