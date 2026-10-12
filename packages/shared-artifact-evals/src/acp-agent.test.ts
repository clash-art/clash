import { openSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  acpEventLine,
  approvePermission,
  runAcpAgentSession,
  type AcpEventLine,
} from "./acp-agent";

const FIXTURE_AGENT = fileURLToPath(
  new URL("./acp-agent.fixture.ts", import.meta.url),
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Runs one turn against the scripted ACP agent process. */
async function run(
  env: Record<string, string>,
  options: { command?: string; timeoutMs?: number } = {},
): Promise<{
  result: Awaited<ReturnType<typeof runAcpAgentSession>>;
  lines: AcpEventLine[];
  cwd: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "clash-acp-agent-"));
  roots.push(cwd);
  const events = new PassThrough();
  const chunks: Buffer[] = [];
  events.on("data", (chunk: Buffer) => chunks.push(chunk));
  const result = await runAcpAgentSession({
    harness: { id: "fixture" },
    command: options.command ?? process.execPath,
    args: [FIXTURE_AGENT],
    cwd,
    env: { PATH: process.env.PATH ?? "", CLASH_BENCH_CASE_ID: "case", ...env },
    prompt: "Do the task.",
    timeoutMs: options.timeoutMs ?? 20_000,
    stderrFd: openSync(join(cwd, "stderr.log"), "w"),
    events,
  });
  const lines = Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AcpEventLine);
  return { result, lines, cwd };
}

describe("ACP agent session", () => {
  it("answers a permission request with the option that grants it", async () => {
    const options = [
      { optionId: "no", name: "Reject", kind: "reject_once" },
      { optionId: "yes", name: "Allow", kind: "allow_once" },
    ];

    const { result, lines, cwd } = await run({
      ACP_FIXTURE_MODE: "permission",
      ACP_FIXTURE_PERMISSION_OPTIONS: JSON.stringify(options),
    });

    expect(result).toEqual({ status: "completed", exitCode: 0, signal: null });
    expect(
      JSON.parse(await readFile(join(cwd, "acp-permission.json"), "utf8")),
    ).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    // Client-side protocol traffic is logged by name only.
    expect(lines.filter(({ type }) => type === "acp.runtime_event")).toEqual(
      expect.arrayContaining([
        { type: "acp.runtime_event", event: "acp.client_request" },
        { type: "acp.runtime_event", event: "acp.client_response" },
      ]),
    );
    expect(lines.at(-1)).toEqual({
      type: "acp.prompt_complete",
      stopReason: "end_turn",
    });
  }, 30_000);

  it("prefers a one-time grant, falls back to a standing one, and cancels when none is offered", async () => {
    const ask = (kinds: string[]) =>
      approvePermission({
        sessionId: "s",
        toolCall: { toolCallId: "t" },
        options: kinds.map((kind) => ({ optionId: kind, name: kind, kind })),
      } as Parameters<typeof approvePermission>[0]);

    await expect(ask(["allow_always", "allow_once"])).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    await expect(ask(["reject_once", "allow_always"])).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow_always" },
    });
    await expect(ask(["reject_once"])).resolves.toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("logs the model and thinking level the session reports, not the ones the launch requested", async () => {
    // What @openma/pi-acp 0.1.7 with the Pi SDK 1.1.0 answered `session/new`
    // with for `--model deepseek/deepseek-flash:medium` (clash-art/clash#42):
    // this model has no `medium`, and Pi ran it at `high` without an error.
    const configOptions = [
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: ["off", "low", "high", "max"].map((value) => ({
          value,
          name: value,
        })),
      },
    ];

    const reported = await run({
      ACP_FIXTURE_CONFIG_OPTIONS: JSON.stringify(configOptions),
    });
    const silent = await run({});

    expect(reported.result.status).toBe("completed");
    expect(reported.lines[0]).toMatchObject({
      type: "acp.session",
      configOptions,
    });
    // An agent that reports none is logged as reporting none.
    expect(silent.lines[0]).toMatchObject({
      type: "acp.session",
      configOptions: [],
    });
  }, 30_000);

  it("fails a turn that stops for any reason other than its end", async () => {
    const { result, lines } = await run({ ACP_FIXTURE_MODE: "refusal" });

    expect(result).toMatchObject({
      status: "failed",
      error: "ACP turn stopped with 'refusal'",
    });
    expect(lines.at(-1)).toEqual({
      type: "acp.prompt_complete",
      stopReason: "refusal",
    });
  }, 30_000);

  it("reports an agent that dies during the turn as a failed run", async () => {
    const { result, lines } = await run({ ACP_FIXTURE_MODE: "crash" });

    expect(result.status).toBe("failed");
    expect(result.error).toBeTruthy();
    expect(lines.at(-1)?.type).toBe("acp.prompt_error");
    expect(
      lines.filter(({ type }) => type === "acp.prompt_error"),
    ).toHaveLength(1);
  }, 30_000);

  it("separates a launcher that cannot start from a session that cannot be set up", async () => {
    const missing = await run({}, { command: "/nonexistent/acp-launcher" });
    expect(missing.result).toMatchObject({
      status: "spawn-error",
      exitCode: null,
      error: expect.stringContaining("ENOENT"),
    });
    expect(missing.lines).toEqual([]);

    const refused = await run({ ACP_FIXTURE_MODE: "init-error" });
    expect(refused.result.status).toBe("failed");
    expect(refused.result.error).toMatch(
      /^ACP session setup failed: .*Fixture cannot initialize/u,
    );
    expect(refused.lines).toEqual([]);
  }, 30_000);

  it("names what the runtime yields without trusting its shape", () => {
    expect(acpEventLine(null)).toEqual({
      type: "acp.runtime_event",
      event: "unknown",
    });
    expect(acpEventLine({ payload: 1 })).toEqual({
      type: "acp.runtime_event",
      event: "unknown",
    });
    expect(acpEventLine({ type: "promptComplete" })).toEqual({
      type: "acp.prompt_complete",
      stopReason: "unknown",
    });
    expect(acpEventLine({ type: "promptError", error: "Error: boom" })).toEqual(
      { type: "acp.prompt_error", message: "Error: boom" },
    );
    expect(
      acpEventLine({
        type: "promptError",
        error: "x",
        errorDetails: { message: "Insufficient Balance", code: 402 },
      }),
    ).toEqual({
      type: "acp.prompt_error",
      message: "Insufficient Balance",
      code: 402,
    });
  });
});
