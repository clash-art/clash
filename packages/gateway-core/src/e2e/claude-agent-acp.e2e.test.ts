/**
 * Real `claude-agent-acp` E2E (#349): the ACP adapter and its Claude Code
 * binary talk to createGatewayApp on a loopback port. The gateway runs on the
 * in-memory ports; its upstream is a mock Anthropic Messages API, so no
 * provider and no production endpoint is ever called. The agent's environment
 * is built from scratch, never inherited, so no real credential or base URL
 * can leak in.
 *
 * Two ways a Host hands the sk_gw_ token over, one agent run each:
 * - ACP gateway auth (`authenticate({ methodId: "gateway" })`). The adapter
 *   then sets `ANTHROPIC_AUTH_TOKEN=" "`, so Claude Code sends a token-less
 *   `Authorization: Bearer` that wins over a custom Authorization header; the
 *   token must travel as the custom `x-api-key` header, which the gateway
 *   accepts when the Bearer header carries no token.
 * - `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` in the agent's environment:
 *   Claude Code sends `Authorization: Bearer <token>`.
 *
 * One prompt drives a full agent turn: the mock answers the first main-model
 * call with a `tool_use` of Claude Code's Read tool, the agent reads the file
 * and sends the `tool_result` back, and the mock's final answer quotes it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { buildEffectiveModelCards, type ProviderAccountAvailability } from "@clash/shared-types/model-routing";

import { createGatewayApp, GATEWAY_REQUEST_ID_HEADER, type GatewayApp } from "../app.js";
import { createSseParser } from "../sse.js";
import { createMemoryGatewayPorts, type MemoryGateway } from "../testing/memory-ports.js";

type Handoff = "acp-gateway-auth" | "env-bearer";
const TOKENS: Record<Handoff, string> = {
  "acp-gateway-auth": "sk_gw_e2e_acp_gateway_auth",
  "env-bearer": "sk_gw_e2e_env_bearer",
};
/** Ids Claude Code sends: pinned through its documented model env vars, so the run does not depend on its defaults. */
const AGENT_MAIN_MODEL = "claude-sonnet-4-5-20250929";
const AGENT_SMALL_MODEL = "claude-haiku-4-5-20251001";
/** Catalog public codes: the main card is bound to the dated id, the small one to its undated family. */
const MAIN_CODE = "e2e-claude-main";
const SMALL_CODE = "e2e-claude-small";
/** What the mock upstream calls its models; never allowed to reach the agent. */
const VENDOR_PREFIX = "vendor-internal-";
const PROMPT_MARKER = "E2E-READ-THE-SECRET";

interface Inbound {
  method: string;
  path: string;
  headers: Headers;
  body: string;
  status?: number;
  requestId?: string | null;
  delivered?: string;
}
interface UpstreamCall {
  path: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) ? (typeof block.text === "string" ? block.text : textOf(block.content)) : ""))
    .join("\n");
}

/** The mock upstream's answer: read the secret file when asked, then quote the tool_result. */
function mockAnswer(body: Record<string, unknown>, secretPath: string): { blocks: Block[]; stop: string } {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1);
  const lastContent = isRecord(last) ? last.content : undefined;
  const toolResult = Array.isArray(lastContent)
    ? lastContent.find((block) => isRecord(block) && block.type === "tool_result")
    : undefined;
  if (isRecord(toolResult))
    return { blocks: [{ type: "text", text: `E2E answer: ${textOf(toolResult.content)}` }], stop: "end_turn" };
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const canRead = tools.some((tool) => isRecord(tool) && tool.name === "Read");
  if (canRead && messages.some((message) => isRecord(message) && textOf(message.content).includes(PROMPT_MARKER)))
    return {
      blocks: [{ type: "tool_use", id: "toolu_e2e_read", name: "Read", input: { file_path: secretPath } }],
      stop: "tool_use",
    };
  return { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" };
}

const usage = { input_tokens: 120, cache_read_input_tokens: 40, cache_creation_input_tokens: 8 };

function messageJson(model: string, answer: ReturnType<typeof mockAnswer>) {
  return {
    id: "msg_e2e",
    type: "message",
    role: "assistant",
    model,
    content: answer.blocks,
    stop_reason: answer.stop,
    stop_sequence: null,
    usage: { ...usage, output_tokens: 20 },
  };
}

function messageStream(model: string, answer: ReturnType<typeof mockAnswer>): string {
  const event = (type: string, data: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const halves = (text: string) => [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
  let out = event("message_start", {
    message: { id: "msg_e2e", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
  });
  answer.blocks.forEach((block, index) => {
    out += event("content_block_start", {
      index,
      content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} },
    });
    if (index === 0) out += event("ping");
    for (const part of halves(block.type === "text" ? block.text : JSON.stringify(block.input)))
      out += event("content_block_delta", {
        index,
        delta: block.type === "text" ? { type: "text_delta", text: part } : { type: "input_json_delta", partial_json: part },
      });
    out += event("content_block_stop", { index });
  });
  out += event("message_delta", { delta: { stop_reason: answer.stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  return out + event("message_stop");
}

/** Node HTTP -> WHATWG fetch handler, streaming the answer and recording both sides. */
function serve(app: GatewayApp, inbound: Inbound[]): Server {
  return createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const record: Inbound = { method: req.method ?? "GET", path: url.pathname, headers, body: body.toString("utf8") };
      inbound.push(record);
      const response = await app.fetch(
        new Request(url, { method: req.method ?? "GET", headers, ...(body.byteLength ? { body } : {}) }),
      );
      record.status = response.status;
      record.requestId = response.headers.get(GATEWAY_REQUEST_ID_HEADER);
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        outHeaders[name] = value;
      });
      res.writeHead(response.status, outHeaders);
      if (!response.body) return void res.end();
      const reader = response.body.getReader();
      res.on("close", () => void reader.cancel().catch(() => undefined));
      const decoder = new TextDecoder();
      record.delivered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        record.delivered += decoder.decode(value, { stream: true });
        res.write(value);
      }
      res.end();
    })().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

describe("claude-agent-acp through the Anthropic Messages gateway", () => {
  let workDir: string;
  let secretPath: string;
  const secret = `secret-${crypto.randomUUID()}`;
  const inbound: Inbound[] = [];
  const upstream: UpstreamCall[] = [];
  let memory: MemoryGateway;
  let server: Server;
  const children: ChildProcessWithoutNullStreams[] = [];
  const tenantOf = (handoff: Handoff) => `tenant-${handoff}`;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "clash-gw-acp-e2e-"));
    secretPath = join(workDir, "secret.txt");
    await writeFile(secretPath, `${secret}\n`);

    const anthropic: ProviderAccountAvailability = {
      id: "official-anthropic",
      providerId: "official",
      upstreamId: "anthropic",
      apiShape: "anthropic-compatible",
      configuredCredentials: ["apiKey"],
    };
    const card = (modelId: string, upstreamModel: string) => ({
      modelId,
      custom: true,
      name: modelId,
      kind: "text" as const,
      providerBindings: [{ providerAccountId: "official-anthropic", upstreamModel }],
    });
    const rates = [
      { unit: "input_token" as const, microCredits: 3_000_000, per: 1_000_000 },
      { unit: "output_token" as const, microCredits: 15_000_000, per: 1_000_000 },
      { unit: "cached_input_token" as const, microCredits: 300_000, per: 1_000_000 },
      { unit: "cache_write_token" as const, microCredits: 3_750_000, per: 1_000_000 },
    ];
    memory = createMemoryGatewayPorts({
      identities: Object.fromEntries(
        (Object.keys(TOKENS) as Handoff[]).map((handoff) => [
          TOKENS[handoff],
          { tenantId: tenantOf(handoff), userId: `user-${handoff}`, budgetIds: [`budget-${handoff}`], credentialScope: "official" as const },
        ]),
      ),
      catalog: {
        version: "e2e-1",
        models: buildEffectiveModelCards({
          baseModels: [],
          providers: [anthropic],
          configs: [card(MAIN_CODE, AGENT_MAIN_MODEL), card(SMALL_CODE, AGENT_SMALL_MODEL.replace(/-\d{8}$/, ""))],
        }),
      },
      providers: { official: [anthropic], tenant: [] },
      keys: { "official-anthropic": "sk-ant-e2e-mock-upstream" },
      prices: [MAIN_CODE, SMALL_CODE].map((modelCode) => ({ modelCode, version: "e2e-price", maxOutputTokens: 64_000, rates })),
      budgets: (Object.keys(TOKENS) as Handoff[]).map((handoff) => ({
        id: `budget-${handoff}`,
        tenantId: tenantOf(handoff),
        scope: "tenant" as const,
        scopeId: tenantOf(handoff),
        limitMicroCredits: 1_000_000_000_000,
        spentMicroCredits: 0,
        reservedMicroCredits: 0,
        version: 0,
      })),
      upstream: {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          const body = (await request.json()) as Record<string, unknown>;
          upstream.push({ path, headers: request.headers, body });
          if (path.endsWith("/messages/count_tokens")) return Response.json({ input_tokens: 512 });
          const model = `${VENDOR_PREFIX}${String(body.model)}`;
          const answer = mockAnswer(body, secretPath);
          return body.stream === true
            ? new Response(messageStream(model, answer), { headers: { "content-type": "text/event-stream; charset=utf-8" } })
            : Response.json(messageJson(model, answer));
        },
      },
    });
    server = serve(createGatewayApp(memory.ports, { basePath: "/gateway" }), inbound);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    await new Promise((resolve) => server?.close(resolve));
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it.each(Object.keys(TOKENS) as Handoff[])(
    "runs a tool-using agent turn end to end (%s): streamed events, tool_use/tool_result, public model codes, metered once per call",
    async (handoff) => {
    inbound.length = 0;
    upstream.length = 0;
    const token = TOKENS[handoff];
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/gateway/anthropic`;
    const home = join(workDir, `home-${handoff}`);
    const agentEntry = createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
    let stderr = "";
    const child = spawn(process.execPath, [agentEntry], {
      cwd: workDir,
      // Built from scratch: nothing of the developer's environment (keys, base URLs) reaches the agent.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        ...(handoff === "env-bearer" ? { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token } : {}),
        ANTHROPIC_MODEL: AGENT_MAIN_MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: AGENT_MAIN_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: AGENT_MAIN_MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: AGENT_SMALL_MODEL,
        ANTHROPIC_SMALL_FAST_MODEL: AGENT_SMALL_MODEL,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const said: string[] = [];
    const toolCalls: string[] = [];
    const client: Client = {
      async sessionUpdate({ update }: SessionNotification) {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") said.push(update.content.text);
        if (update.sessionUpdate === "tool_call") toolCalls.push(update.title);
      },
      async requestPermission({ options }: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const allow = options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind.startsWith("allow"));
        return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
      },
    } as Client;
    const connection = new ClientSideConnection(
      () => client,
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
    );

    const context = () =>
      `agent stderr:\n${stderr.slice(-4000)}\ninbound: ${JSON.stringify(
        inbound.map(({ method, path, status, headers }) => [method, path, status, headers.get("authorization"), headers.get("x-api-key")]),
      )}\nsaid: ${said.join("").slice(-500)}`;
    /** Each ACP step gets its own deadline, failing with what the agent and gateway saw so far. */
    const step = <T>(label: string, promise: Promise<T>, ms = 45_000): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} did not finish in ${ms} ms\n${context()}`)), ms);
        }),
      ]).finally(() => clearTimeout(timer));
    };
    const initialized = await step(
      "initialize",
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        // The gateway auth method is offered only to clients that advertise it.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, auth: { _meta: { gateway: true } } },
      } as Parameters<typeof connection.initialize>[0]),
    );
    expect(initialized.authMethods?.map((method) => method.id), context()).toContain("gateway");
    if (handoff === "acp-gateway-auth")
      await step(
        "authenticate",
        connection.authenticate({ methodId: "gateway", _meta: { gateway: { baseUrl, headers: { "x-api-key": token } } } }),
      );
    const session = await step("newSession", connection.newSession({ cwd: workDir, mcpServers: [] }));
    const result = await step(
      "prompt",
      connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: `${PROMPT_MARKER}: use the Read tool on ${secretPath} and tell me what it says.` }],
      }),
      90_000,
    );
    expect(result.stopReason, context()).toBe("end_turn");

    // The agent ran the tool the upstream asked for and relayed the answer built from its tool_result.
    expect(toolCalls.length, context()).toBeGreaterThan(0);
    expect(said.join(""), context()).toContain(`E2E answer: `);
    expect(said.join(""), context()).toContain(secret);

    const calls = inbound.filter((entry) => entry.path === "/gateway/anthropic/v1/messages");
    expect(calls.length, context()).toBeGreaterThanOrEqual(2);
    // Claude Code also probes the bare base URL (HEAD); every API call must be authenticated and served.
    for (const call of inbound.filter((entry) => entry.path.startsWith("/gateway/anthropic/v1/"))) {
      const bearer = /^Bearer\s+(\S+)$/i.exec(call.headers.get("authorization") ?? "")?.[1];
      if (handoff === "env-bearer") expect(bearer, call.path).toBe(token);
      else expect([bearer, call.headers.get("x-api-key")], call.path).toEqual([undefined, token]);
      expect(call.status, `${call.path}: ${call.delivered?.slice(0, 300)}`).toBe(200);
      // No upstream model name reaches the agent.
      expect(call.delivered, call.path).not.toContain(VENDOR_PREFIX);
    }

    // The tool round trip crossed the gateway: a streamed tool_use answer, then a request carrying its tool_result.
    const streamed = calls.filter((call) => (JSON.parse(call.body) as { stream?: boolean }).stream === true);
    expect(streamed.length).toBeGreaterThan(0);
    const toolUseAnswer = streamed.find((call) => call.delivered!.includes('"type":"tool_use"'));
    expect(toolUseAnswer, "a streamed tool_use answer").toBeDefined();
    const parser = createSseParser();
    const kinds = [...parser.push(toolUseAnswer!.delivered!), ...parser.end()].map((event) => event.event);
    expect(kinds).toEqual(expect.arrayContaining(["message_start", "content_block_start", "content_block_delta", "message_delta", "message_stop"]));
    expect(calls.some((call) => call.body.includes('"tool_result"') && call.body.includes(secret))).toBe(true);

    // Upstream saw each agent body as sent (cache_control, tools, tool_result) with only the model replaced,
    // the agent's anthropic-beta/version headers, and the gateway's key instead of the agent's token.
    const messageCalls = upstream.filter((call) => call.path.endsWith("/messages"));
    expect(messageCalls).toHaveLength(calls.length);
    for (const [index, call] of calls.entries()) {
      const sent = JSON.parse(call.body) as Record<string, unknown>;
      const forwarded = messageCalls[index]!;
      expect(forwarded.body).toEqual({ ...sent, model: forwarded.body.model });
      expect([AGENT_MAIN_MODEL, AGENT_SMALL_MODEL.replace(/-\d{8}$/, "")]).toContain(forwarded.body.model);
      expect(forwarded.headers.get("anthropic-beta")).toBe(call.headers.get("anthropic-beta"));
      expect(forwarded.headers.get("anthropic-version")).toBe(call.headers.get("anthropic-version") ?? "2023-06-01");
      expect(forwarded.headers.get("x-api-key")).toBe("sk-ant-e2e-mock-upstream");
      expect(forwarded.headers.get("authorization")).toBeNull();
    }
    expect(calls.some((call) => call.body.includes('"cache_control"'))).toBe(true);

    // Metering: one settled ledger row per message call, on the public code, holds all released.
    const rows = await memory.ports.ledger.query({ tenantId: tenantOf(handoff), limit: 1000 });
    expect(rows.map((row) => row.requestId).sort()).toEqual(calls.map((call) => call.requestId).sort());
    for (const row of rows) {
      expect(row).toMatchObject({ status: "settled", userId: `user-${handoff}`, usage: { source: "reported" } });
      expect([MAIN_CODE, SMALL_CODE]).toContain(row.modelCode);
      expect(row.costMicroCredits).toBeGreaterThan(0);
    }
    expect(rows.some((row) => row.modelCode === MAIN_CODE)).toBe(true);
    const [budget] = await memory.ports.budgets.snapshot({ tenantId: tenantOf(handoff), budgetIds: [`budget-${handoff}`] });
    expect(budget).toMatchObject({
      reservedMicroCredits: 0,
      spentMicroCredits: rows.reduce((sum, row) => sum + row.costMicroCredits, 0),
    });
  });
});
