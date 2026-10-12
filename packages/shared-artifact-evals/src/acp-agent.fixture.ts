/**
 * A scripted ACP agent for adapter tests. It speaks the JSON-RPC wire protocol
 * over stdio and replays a recorded `acp.session_update` log, so the runner's
 * real ACP client is exercised against a real agent process.
 *
 * ACP_FIXTURE_REPLAY   event log to replay (see `AcpEventLine`)
 * ACP_FIXTURE_MODE     "prompt-error" rejects the prompt, "hang" never answers,
 *                      "init-error" rejects initialize, "crash" exits during
 *                      the prompt, "refusal" stops the turn with a refusal,
 *                      "permission" asks the client for permission first
 * ACP_FIXTURE_WORK     Node script that does the turn's work in the workspace,
 *                      in place of the default one-file submission
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

const mode = process.env.ACP_FIXTURE_MODE ?? "ok";
const replay = process.env.ACP_FIXTURE_REPLAY
  ? readFileSync(process.env.ACP_FIXTURE_REPLAY, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  : [];
const sessionId = "fixture-session";
let cwd = process.cwd();
let mcpServers: unknown;

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

let pendingPrompt: number | string | undefined;

function handle(message: Message & { result?: unknown }): void {
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  if (method === undefined) {
    // The client's answer to the permission request ends the turn.
    writeFileSync(
      join(cwd, "acp-permission.json"),
      JSON.stringify(message.result),
    );
    send({ id: pendingPrompt, result: { stopReason: "end_turn" } });
    return;
  }
  if (method === "initialize" && mode === "init-error") {
    send({ id, error: { code: -32603, message: "Fixture cannot initialize" } });
    return;
  }
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fixture-acp-agent", version: "0.0.0" },
      },
    });
    return;
  }
  if (method === "session/new") {
    cwd = params.cwd as string;
    mcpServers = params.mcpServers;
    send({ id, result: { sessionId } });
    return;
  }
  if (method === "session/prompt") {
    const prompt = (params.prompt as Array<{ text?: string }>)
      .map(({ text }) => text ?? "")
      .join("");
    writeFileSync(
      join(cwd, "acp-observation.json"),
      JSON.stringify({
        argv: process.argv.slice(2),
        cwd,
        mcpServers,
        prompt,
        inheritedSecret: process.env.ACP_FIXTURE_HOST_SECRET ?? null,
        path: process.env.PATH ?? "",
        home: Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) =>
              name === "HOME" ||
              name === "USERPROFILE" ||
              name.startsWith("XDG_") ||
              name.endsWith("_AGENT_DIR"),
          ),
        ),
        homeEntries: process.env.HOME ? readdirSync(process.env.HOME) : [],
      }),
    );
    if (mode === "hang") return;
    if (mode === "crash") process.exit(3);
    if (mode === "refusal") {
      send({ id, result: { stopReason: "refusal" } });
      return;
    }
    if (mode === "permission") {
      pendingPrompt = id;
      send({
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "call-1", title: "Run a command" },
          options: JSON.parse(process.env.ACP_FIXTURE_PERMISSION_OPTIONS!),
        },
      });
      return;
    }
    if (mode === "prompt-error") {
      send({
        id,
        error: { code: -32603, message: "Fixture provider rejected the turn" },
      });
      return;
    }
    if (process.env.ACP_FIXTURE_WORK) {
      execFileSync(process.execPath, [process.env.ACP_FIXTURE_WORK], {
        cwd,
        stdio: "ignore",
      });
    } else {
      writeFileSync(join(cwd, "result.txt"), "acp artifact");
      writeFileSync(
        join(cwd, "submission.json"),
        JSON.stringify({
          schemaVersion: 1,
          taskId: process.env.CLASH_BENCH_CASE_ID,
          artifacts: [{ id: "result", kind: "report", path: "result.txt" }],
        }),
      );
    }
    for (const line of replay) {
      if (line.type === "acp.session_update") {
        send({
          method: "session/update",
          params: { sessionId, update: line.update },
        });
      }
    }
    const complete = replay.find(({ type }) => type === "acp.prompt_complete");
    send({
      id,
      result: {
        stopReason: complete?.stopReason ?? "end_turn",
        ...(complete?.usage ? { usage: complete.usage } : {}),
      },
    });
    return;
  }
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) handle(JSON.parse(line) as Message);
});
