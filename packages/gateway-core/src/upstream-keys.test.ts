/**
 * Upstream keys and circuits in the data plane (#350): a refused key retries
 * the draining version before the first byte, an unusable key fails closed,
 * connect/408/429/5xx fail over only before the first byte, and an account
 * whose circuit is open is skipped without contact. Key material never
 * reaches a log, an error body or the ledger.
 */
import { describe, expect, it } from "vitest";
import { buildEffectiveModelCards } from "@clash/shared-types/model-routing";

import { createGatewayApp, GATEWAY_REQUEST_ID_HEADER, type GatewayAppOptions } from "./app.js";
import { GatewayError } from "./errors.js";
import type { GatewayUpstreamPort } from "./ports.js";
import type { GatewayCatalog } from "./routing.js";
import { createSseParser } from "./sse.js";
import { catalogFixture } from "./testing/fixtures.js";
import { createMemoryGatewayPorts } from "./testing/memory-ports.js";

const fixture = catalogFixture();
const primary = fixture.providers.official[0]!;
const secondary = {
  id: "official-openai-2",
  providerId: "official",
  upstreamId: "openai",
  apiShape: "openai-compatible",
  configuredCredentials: ["apiKey"],
};

/** The fixture chat model bound to the primary account, then (with `failover`) the secondary. */
function catalogOf(failover: boolean): GatewayCatalog {
  const accounts = failover ? [primary, secondary] : [primary];
  return {
    version: failover ? "keys-failover-1" : "keys-single-1",
    models: buildEffectiveModelCards({
      baseModels: [],
      providers: accounts,
      configs: [
        {
          modelId: fixture.textModel,
          custom: true,
          name: "Keys chat",
          kind: "text",
          providerBindings: accounts.map((account) => ({ providerAccountId: account.id!, upstreamModel: `${account.id}-model` })),
        },
      ],
    }),
  };
}

const PRIMARY_NEW = "sk-primary-new-0123456789abcdef";
const PRIMARY_OLD = "sk-primary-old-0123456789abcdef";
const SECONDARY = "sk-secondary-0123456789abcdef";

function gateway(options: {
  upstream: GatewayUpstreamPort;
  failover?: boolean;
  primaryKeys?: string | readonly string[];
  app?: GatewayAppOptions;
}) {
  const failover = options.failover ?? false;
  const memory = createMemoryGatewayPorts({
    identities: {
      "tenant-a": { tenantId: "tenant-a", userId: "user-a", keyId: "key-a", budgetIds: ["budget-a"], credentialScope: "official" },
    },
    catalog: catalogOf(failover),
    providers: { official: failover ? [primary, secondary] : [primary], tenant: [] },
    keys: { [primary.id!]: options.primaryKeys ?? PRIMARY_NEW, [secondary.id]: SECONDARY },
    prices: [
      {
        modelCode: fixture.textModel,
        version: "price-1",
        maxOutputTokens: 1024,
        rates: [
          { unit: "input_token", microCredits: 1_000_000, per: 1_000_000 },
          { unit: "output_token", microCredits: 2_000_000, per: 1_000_000 },
        ],
      },
    ],
    budgets: [
      {
        id: "budget-a",
        tenantId: "tenant-a",
        scope: "tenant",
        scopeId: "tenant-a",
        limitMicroCredits: 1_000_000_000,
        spentMicroCredits: 0,
        reservedMicroCredits: 0,
        version: 0,
      },
    ],
    upstream: options.upstream,
    startAt: 1_700_000_000_000,
  });
  return { memory, app: createGatewayApp(memory.ports, { basePath: "/gateway", upstreamTimeoutMs: 50, ...options.app }) };
}

const chat = { model: fixture.textModel, messages: [{ role: "user", content: "hi" }], max_tokens: 4 };
const post = (body: unknown = chat) =>
  new Request("https://gw.test/gateway/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tenant-a" },
    body: JSON.stringify(body),
  });
const ok = () =>
  Response.json({
    model: "x",
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  });
const code = (res: Response) => res.headers.get("x-clash-error-code");
const bearer = (request: Request) => request.headers.get("authorization")?.replace(/^Bearer /, "");

/** Records which key each upstream call carried, and answers per key. */
function recordingUpstream(answer: (key: string | undefined, call: number) => Response | Promise<Response>) {
  const keys: Array<string | undefined> = [];
  return {
    keys,
    port: {
      async fetch(request: Request) {
        keys.push(bearer(request));
        return answer(bearer(request), keys.length);
      },
    } satisfies GatewayUpstreamPort,
  };
}

async function ledgerOf(memory: ReturnType<typeof gateway>["memory"], res: Response) {
  return memory.ports.ledger.get({ tenantId: "tenant-a", requestId: res.headers.get(GATEWAY_REQUEST_ID_HEADER)! });
}

/** Every place a key could leak to: the answer, the logs and the ledger row. */
async function expectNoKeyMaterial(memory: ReturnType<typeof gateway>["memory"], res: Response, body: string) {
  const headers: string[] = [];
  res.headers.forEach((value, name) => headers.push(`${name}: ${value}`));
  const surfaces = [body, headers.join("\n"), JSON.stringify(memory.logs), JSON.stringify(await ledgerOf(memory, res))];
  for (const surface of surfaces)
    for (const key of [PRIMARY_NEW, PRIMARY_OLD, SECONDARY]) expect(surface).not.toContain(key);
}

describe("key rotation in the data plane", () => {
  it("sends the active key, and retries a refused one with the draining version before the first byte", async () => {
    const upstream = recordingUpstream((key) => (key === PRIMARY_NEW ? new Response("no", { status: 401 }) : ok()));
    const { app, memory } = gateway({ upstream: upstream.port, primaryKeys: [PRIMARY_NEW, PRIMARY_OLD] });
    const res = await app.fetch(post());
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(upstream.keys).toEqual([PRIMARY_NEW, PRIMARY_OLD]);
    const refused = memory.logs.find((entry) => entry.event === "gateway.upstream_key_refused");
    expect(refused?.fields).toMatchObject({ accountId: primary.id, upstreamStatus: 401 });
    // The served version is the draining one, logged by version only.
    const served = memory.logs.find((entry) => entry.event === "gateway.chat_completion");
    expect(served?.fields?.keyVersion).toBeDefined();
    expect(served?.fields?.keyVersion).not.toBe(refused?.fields?.keyVersion);
    expect(await ledgerOf(memory, res)).toMatchObject({ status: "settled" });
    await expectNoKeyMaterial(memory, res, body);
  });

  it("serves with the active key alone when it is accepted", async () => {
    const upstream = recordingUpstream(() => ok());
    const { app } = gateway({ upstream: upstream.port, primaryKeys: [PRIMARY_NEW, PRIMARY_OLD] });
    expect((await app.fetch(post())).status).toBe(200);
    expect(upstream.keys).toEqual([PRIMARY_NEW]);
  });

  it("does not retry another version after an answer that is not a key refusal", async () => {
    const upstream = recordingUpstream(() => new Response("bad", { status: 400 }));
    const { app } = gateway({ upstream: upstream.port, primaryKeys: [PRIMARY_NEW, PRIMARY_OLD] });
    expect(code(await app.fetch(post()))).toBe("GATEWAY_UPSTREAM_REJECTED");
    expect(upstream.keys).toEqual([PRIMARY_NEW]);
  });

  it("fails the route with the refusal once every version is refused, then fails over", async () => {
    const refusing = recordingUpstream(() => new Response("no", { status: 403 }));
    const single = gateway({ upstream: refusing.port, primaryKeys: [PRIMARY_NEW, PRIMARY_OLD] });
    const res = await single.app.fetch(post());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(["GATEWAY_KEY_UNAVAILABLE", "GATEWAY_ROUTES_EXHAUSTED"]).toContain(code(res));
    expect(refusing.keys).toEqual([PRIMARY_NEW, PRIMARY_OLD]);
    expect(await ledgerOf(single.memory, res)).toMatchObject({ status: "upstream_failed", costMicroCredits: 0 });
    await expectNoKeyMaterial(single.memory, res, await res.text());

    const upstream = recordingUpstream((key) => (key === SECONDARY ? ok() : new Response("no", { status: 401 })));
    const failover = gateway({ upstream: upstream.port, failover: true, primaryKeys: [PRIMARY_NEW, PRIMARY_OLD] });
    expect((await failover.app.fetch(post())).status).toBe(200);
    expect(upstream.keys).toEqual([PRIMARY_NEW, PRIMARY_OLD, SECONDARY]);
  });

  it("fails closed when the key cannot be decrypted: no older version, no contact, GATEWAY_KEY_UNAVAILABLE", async () => {
    const upstream = recordingUpstream(() => ok());
    const { app, memory } = gateway({ upstream: upstream.port, primaryKeys: [PRIMARY_NEW, PRIMARY_OLD] });
    const asked: Array<readonly string[] | undefined> = [];
    const resolve = memory.ports.credentials.resolve.bind(memory.ports.credentials);
    memory.ports.credentials.resolve = async (input) => {
      asked.push(input.excludeKeyVersions);
      if (!input.excludeKeyVersions?.length)
        throw new GatewayError("GATEWAY_KEY_UNAVAILABLE", { details: { accountId: input.route.accountId, reason: "decrypt_failed" } });
      return resolve(input);
    };
    const res = await app.fetch(post());
    const body = await res.text();
    expect([res.status, code(res)]).toEqual([503, "GATEWAY_KEY_UNAVAILABLE"]);
    expect(upstream.keys).toEqual([]);
    expect(asked).toEqual([undefined]);
    expect(memory.logs.find((entry) => entry.event === "gateway.key_unavailable")?.fields).toMatchObject({
      accountId: primary.id,
      code: "GATEWAY_KEY_UNAVAILABLE",
      reason: "decrypt_failed",
    });
    expect(await ledgerOf(memory, res)).toMatchObject({ status: "gateway_failed", costMicroCredits: 0 });
    await expectNoKeyMaterial(memory, res, body);
  });

  it("skips an account whose key is unavailable and serves the next route", async () => {
    const upstream = recordingUpstream(() => ok());
    const { app, memory } = gateway({ upstream: upstream.port, failover: true });
    const resolve = memory.ports.credentials.resolve.bind(memory.ports.credentials);
    memory.ports.credentials.resolve = async (input) => {
      if (input.route.accountId === primary.id) throw new GatewayError("GATEWAY_KEY_UNAVAILABLE", { details: { reason: "secret_missing" } });
      return resolve(input);
    };
    expect((await app.fetch(post())).status).toBe(200);
    expect(upstream.keys).toEqual([SECONDARY]);
  });
});

describe("retries before the first byte only", () => {
  const failures: Array<[string, () => Promise<Response>]> = [
    ["a refused connection", () => Promise.reject(new TypeError("connect ECONNREFUSED"))],
    ["429", async () => new Response("slow down", { status: 429 })],
    ["500", async () => new Response("boom", { status: 500 })],
    ["503", async () => new Response("busy", { status: 503 })],
  ];
  it.each(failures)("fails over after %s and charges only the served route", async (_label, fail) => {
    const upstream = recordingUpstream((key) => (key === PRIMARY_NEW ? fail() : ok()));
    const { app, memory } = gateway({ upstream: upstream.port, failover: true });
    const res = await app.fetch(post());
    expect(res.status).toBe(200);
    expect(upstream.keys).toEqual([PRIMARY_NEW, SECONDARY]);
    expect(await ledgerOf(memory, res)).toMatchObject({ status: "settled", accountId: secondary.id });
  });

  it("never retries once a stream's first byte reached the caller", async () => {
    const encoder = new TextEncoder();
    const first = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] })}\n\n`;
    let drop!: () => void;
    const dropped = new Promise<void>((resolve) => {
      drop = resolve;
    });
    const upstream = recordingUpstream(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            // The first event is delivered; the connection drops once the caller has it.
            async start(controller) {
              controller.enqueue(encoder.encode(first));
              await dropped;
              controller.error(new TypeError("connection reset"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const { app, memory } = gateway({ upstream: upstream.port, failover: true });
    const res = await app.fetch(post({ ...chat, stream: true }));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const head = await reader.read();
    text += decoder.decode(head.value);
    expect(text).toBe(first);
    drop();
    for (let next = await reader.read(); !next.done; next = await reader.read()) text += decoder.decode(next.value);
    const parser = createSseParser();
    const last = [...parser.push(text), ...parser.end()].at(-1)!;
    expect(JSON.parse(last.data)).toMatchObject({ error: { code: "GATEWAY_UPSTREAM_ERROR" } });
    expect(upstream.keys).toEqual([PRIMARY_NEW]);
    expect((await ledgerOf(memory, res))?.status).not.toBe("settled");
  });
});

describe("circuit breaker", () => {
  const circuit = { failureThreshold: 2, cooldownMs: 1_000 };

  it("opens after consecutive failures, skips the account without contact, and closes after a half-open success", async () => {
    let primaryHealthy = false;
    const upstream = recordingUpstream((key) =>
      key === PRIMARY_NEW && !primaryHealthy ? new Response("busy", { status: 503 }) : ok(),
    );
    const { app, memory } = gateway({ upstream: upstream.port, failover: true, app: { circuit } });
    const primaryCalls = () => upstream.keys.filter((key) => key === PRIMARY_NEW).length;

    for (let i = 0; i < circuit.failureThreshold; i += 1) expect((await app.fetch(post())).status).toBe(200);
    expect(primaryCalls()).toBe(circuit.failureThreshold);
    expect(memory.logs.filter((entry) => entry.event === "gateway.circuit_open")).toHaveLength(1);

    // Open: the next requests go straight to the healthy route.
    for (let i = 0; i < 3; i += 1) expect((await app.fetch(post())).status).toBe(200);
    expect(primaryCalls()).toBe(circuit.failureThreshold);

    // Half-open after the cooldown: one failure reopens it at once.
    memory.advance(circuit.cooldownMs);
    expect((await app.fetch(post())).status).toBe(200);
    expect(primaryCalls()).toBe(circuit.failureThreshold + 1);
    expect(memory.logs.filter((entry) => entry.event === "gateway.circuit_open")).toHaveLength(2);
    await app.fetch(post());
    expect(primaryCalls()).toBe(circuit.failureThreshold + 1);

    // Half-open again; a success closes the circuit and routes normally.
    memory.advance(circuit.cooldownMs);
    primaryHealthy = true;
    const res = await app.fetch(post());
    expect(await ledgerOf(memory, res)).toMatchObject({ accountId: primary.id });
    const [health] = await memory.ports.upstreamHealth.read({ accountIds: [primary.id!] });
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.openUntil).toBeUndefined();
  });

  it("answers 503 GATEWAY_NO_ROUTE with Retry-After when every route is open, contacting none", async () => {
    const upstream = recordingUpstream(() => new Response("busy", { status: 503 }));
    const { app, memory } = gateway({ upstream: upstream.port, app: { circuit } });
    for (let i = 0; i < circuit.failureThreshold; i += 1) await app.fetch(post());
    const calls = upstream.keys.length;
    const res = await app.fetch(post());
    expect([res.status, code(res)]).toEqual([503, "GATEWAY_NO_ROUTE"]);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(Math.ceil(circuit.cooldownMs / 1000));
    expect(upstream.keys.length).toBe(calls);
    expect(await ledgerOf(memory, res)).toMatchObject({ status: "gateway_failed", costMicroCredits: 0 });
  });

  it("does not count a caller's 4xx, and a success with no failures on record writes nothing", async () => {
    const upstream = recordingUpstream((_key, call) => (call % 2 ? new Response("bad", { status: 400 }) : ok()));
    const { app, memory } = gateway({ upstream: upstream.port, app: { circuit } });
    const writes: string[] = [];
    const port = memory.ports.upstreamHealth;
    memory.ports.upstreamHealth = {
      read: port.read.bind(port),
      recordFailure: (input) => (writes.push("failure"), port.recordFailure(input)),
      recordSuccess: (input) => (writes.push("success"), port.recordSuccess(input)),
    };
    for (let i = 0; i < circuit.failureThreshold * 2; i += 1) await app.fetch(post());
    expect(upstream.keys.length).toBe(circuit.failureThreshold * 2);
    expect(writes).toEqual([]);
  });

  it("routes as if closed when health cannot be read or written, without changing the answer", async () => {
    const upstream = recordingUpstream((key) => (key === PRIMARY_NEW ? new Response("busy", { status: 503 }) : ok()));
    const { app, memory } = gateway({ upstream: upstream.port, failover: true, app: { circuit } });
    const broken = () => Promise.reject(new Error("d1 down"));
    memory.ports.upstreamHealth = { read: broken, recordFailure: broken, recordSuccess: broken };
    for (let i = 0; i < circuit.failureThreshold + 1; i += 1) expect((await app.fetch(post())).status).toBe(200);
    expect(upstream.keys.filter((key) => key === PRIMARY_NEW)).toHaveLength(circuit.failureThreshold + 1);
    expect(memory.logs.some((entry) => entry.event === "gateway.health_unavailable")).toBe(true);
    expect(memory.logs.some((entry) => entry.event === "gateway.health_record_failed")).toBe(true);
  });
});
