import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  AcpRuntimeImpl,
  type AgentSpec,
  type ChildHandle,
  type ClientCallbacks,
  type SessionOptions,
  type Spawner,
} from "@openma/common/acp-runtime";

/**
 * One line of the ACP event log an ACP-driven adapter writes to `events.jsonl`.
 * `update` is the agent's `session/update` payload, unmodified.
 */
export type AcpEventLine =
  | {
      type: "acp.session";
      sessionId: string;
      protocolVersion: number | null;
      harness: { id: string; package?: string; version?: string };
      agent?: { name?: string; version?: string };
    }
  | { type: "acp.session_update"; update: Record<string, unknown> }
  | {
      type: "acp.prompt_complete";
      stopReason: string;
      usage?: Record<string, unknown>;
    }
  | { type: "acp.prompt_error"; message: string; code?: number }
  | { type: "acp.runtime_event"; event: string };

export type AcpAgentRunResult = {
  status: "completed" | "failed" | "timed-out" | "spawn-error";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

type McpServers = NonNullable<SessionOptions["mcpServers"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The benchmark is headless, so a permission request is answered with the
 * first option that grants it. Without one the request is cancelled.
 */
export const approvePermission: NonNullable<
  ClientCallbacks["requestPermission"]
> = async (params) => {
  const allow =
    params.options.find(({ kind }) => kind === "allow_once") ??
    params.options.find(({ kind }) => kind === "allow_always");
  return allow
    ? { outcome: { outcome: "selected", optionId: allow.optionId } }
    : { outcome: { outcome: "cancelled" } };
};

export function acpEventLine(value: unknown): AcpEventLine {
  if (!isRecord(value)) {
    return { type: "acp.runtime_event", event: "unknown" };
  }
  if (typeof value.sessionUpdate === "string") {
    return { type: "acp.session_update", update: value };
  }
  if (value.type === "promptComplete") {
    const response = isRecord(value.response) ? value.response : {};
    return {
      type: "acp.prompt_complete",
      stopReason:
        typeof response.stopReason === "string"
          ? response.stopReason
          : "unknown",
      ...(isRecord(response.usage) ? { usage: response.usage } : {}),
    };
  }
  if (value.type === "promptError") {
    const details = isRecord(value.errorDetails) ? value.errorDetails : {};
    return {
      type: "acp.prompt_error",
      message:
        typeof details.message === "string"
          ? details.message
          : String(value.error),
      ...(typeof details.code === "number" ? { code: details.code } : {}),
    };
  }
  return {
    type: "acp.runtime_event",
    event: typeof value.type === "string" ? value.type : "unknown",
  };
}

/**
 * Drives one headless prompt turn of an ACP agent through the shared OpenMA
 * ACP runtime and writes the session as JSON lines to `events`. The runtime
 * owns the protocol; this function owns only the process (exact environment,
 * process-group tracking, stderr capture) and the log.
 */
export async function runAcpAgentSession(input: {
  harness: {
    id: string;
    versions?: { package: { name: string; version: string } };
  };
  command: string;
  args: string[];
  cwd: string;
  /** The complete child environment. Nothing is inherited implicitly. */
  env: NodeJS.ProcessEnv;
  prompt: string;
  mcpServers?: McpServers;
  timeoutMs: number;
  /** File descriptor that receives the agent's stderr. */
  stderrFd: number;
  /** Receives one JSON line per session event; ended when the turn settles. */
  events: Writable;
  onSpawn?: (child: ChildProcess) => void;
}): Promise<AcpAgentRunResult> {
  let child: ChildProcess | undefined;
  let spawnError: string | undefined;
  const spawner: Spawner = {
    spawn: (spec: AgentSpec): Promise<ChildHandle> =>
      new Promise((resolveHandle, reject) => {
        const spawned = spawn(spec.command, spec.args ?? [], {
          cwd: spec.cwd,
          env: input.env,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", input.stderrFd],
        });
        child = spawned;
        input.onSpawn?.(spawned);
        const exited = new Promise<{
          code: number | null;
          signal: string | null;
        }>((resolveExit) => {
          spawned.once("close", (code, signal) =>
            resolveExit({ code, signal }),
          );
          spawned.once("error", () =>
            resolveExit({ code: null, signal: null }),
          );
        });
        spawned.once("error", (error) => {
          spawnError = error.message;
          reject(error);
        });
        spawned.once("spawn", () =>
          resolveHandle({
            stdin: Writable.toWeb(spawned.stdin!) as WritableStream<Uint8Array>,
            stdout: Readable.toWeb(
              spawned.stdout!,
            ) as ReadableStream<Uint8Array>,
            stderr: new ReadableStream<Uint8Array>({
              start: (controller) => controller.close(),
            }),
            kill: async (signal = "SIGTERM") => {
              if (spawned.exitCode !== null || spawned.signalCode !== null) {
                return;
              }
              try {
                if (process.platform !== "win32" && spawned.pid) {
                  process.kill(-spawned.pid, signal);
                } else {
                  spawned.kill(signal);
                }
              } catch {
                // The process group is already gone.
              }
              await exited;
            },
            exited,
          }),
        );
      }),
  };

  const write = (line: AcpEventLine): void => {
    input.events.write(`${JSON.stringify(line)}\n`);
  };
  const exitState = (): Pick<AcpAgentRunResult, "exitCode" | "signal"> => ({
    exitCode: child?.exitCode ?? null,
    signal: child?.signalCode ?? null,
  });

  let session: Awaited<ReturnType<AcpRuntimeImpl["start"]>>;
  try {
    session = await new AcpRuntimeImpl(spawner).start({
      agent: { command: input.command, args: input.args, cwd: input.cwd },
      mcpServers: input.mcpServers ?? [],
      perTurnTimeoutMs: input.timeoutMs,
      clientCallbacks: { requestPermission: approvePermission },
    });
  } catch (error) {
    input.events.end();
    const message = error instanceof Error ? error.message : String(error);
    return spawnError
      ? { status: "spawn-error", exitCode: null, signal: null, error: message }
      : {
          status: "failed",
          ...exitState(),
          error: `ACP session setup failed: ${message}`,
        };
  }

  let stopReason: string | undefined;
  let failure: string | undefined;
  let timedOut = false;
  try {
    write({
      type: "acp.session",
      sessionId: session.acpSessionId,
      protocolVersion:
        typeof session.protocolVersion === "number"
          ? session.protocolVersion
          : null,
      harness: {
        id: input.harness.id,
        ...(input.harness.versions
          ? {
              package: input.harness.versions.package.name,
              version: input.harness.versions.package.version,
            }
          : {}),
      },
      ...(session.agentInfo
        ? {
            agent: {
              name: session.agentInfo.name,
              version: session.agentInfo.version,
            },
          }
        : {}),
    });
    for await (const event of session.prompt(input.prompt)) {
      const line = acpEventLine(event);
      write(line);
      if (line.type === "acp.prompt_complete") stopReason = line.stopReason;
      if (line.type === "acp.prompt_error") {
        failure = line.message;
        timedOut = /^ACP prompt timed out after \d+ms$/u.test(line.message);
      }
    }
  } catch (error) {
    // The runtime reports a rejected prompt as an event and then rethrows it.
    if (failure === undefined) {
      failure = error instanceof Error ? error.message : String(error);
      write({ type: "acp.prompt_error", message: failure });
    }
  } finally {
    await session.dispose();
    input.events.end();
  }

  if (timedOut) {
    return {
      status: "timed-out",
      ...exitState(),
      error: `Agent exceeded timeout of ${input.timeoutMs}ms`,
    };
  }
  if (failure !== undefined) {
    return { status: "failed", ...exitState(), error: failure };
  }
  if (stopReason !== "end_turn") {
    return {
      status: "failed",
      ...exitState(),
      error: `ACP turn stopped with '${stopReason ?? "no response"}'`,
    };
  }
  // The harness is a server: it has no exit status of its own to report, and
  // dispose() terminates it once the turn has settled.
  return { status: "completed", exitCode: 0, signal: null };
}
