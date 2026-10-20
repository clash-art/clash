import { describe, expect, it } from "vitest";
import { buildEffectiveModelCards } from "@clash/shared-types/model-routing";

import { createGatewayApp, GATEWAY_REQUEST_ID_HEADER, isOpenAIChatRoute } from "./app.js";
import type { GatewayUpstreamPort } from "./ports.js";
import { planGatewayRoutes, type GatewayCatalog } from "./routing.js";
import { catalogFixture } from "./testing/fixtures.js";
import { createMemoryGatewayPorts, type MemoryIdentity } from "./testing/memory-ports.js";

const fixture = catalogFixture();

function gateway(options: {
  upstream: GatewayUpstreamPort;
  identity?: Partial<MemoryIdentity>;
  catalog?: GatewayCatalog;
  /** Extra official accounts, e.g. a second OpenAI-compatible route. */
  extraOfficial?: typeof fixture.providers.official;
}) {
  const official = [...fixture.providers.official, ...(options.extraOfficial ?? [])];
  const memory = createMemoryGatewayPorts({
    identities: {
      "tenant-a": {
        tenantId: "tenant-a",
        userId: "user-a",
        keyId: "key-a",
        budgetIds: ["budget-a"],
        credentialScope: "official",
        ...options.identity,
      },
    },
    catalog: options.catalog ?? fixture.catalog,
    providers: { official, tenant: fixture.providers.tenant },
    keys: { ...fixture.keys, "official-openai-2": "sk-fixture-official-openai-2" },
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
  });
  return { memory, app: createGatewayApp(memory.ports, { basePath: "/gateway", upstreamTimeoutMs: 50 }) };
}

const post = (body: unknown, init: { token?: string; path?: string; method?: string; raw?: string } = {}) =>
  new Request(`https://gw.test${init.path ?? "/gateway/v1/chat/completions"}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token === undefined ? { authorization: "Bearer tenant-a" } : init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.method === "GET" ? {} : { body: init.raw ?? JSON.stringify(body) }),
  });

const chat = { model: fixture.textModel, messages: [{ role: "user", content: "hi" }], max_tokens: 4 };

const ok = (model: string) =>
  Response.json({
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  });

const code = (res: Response) => res.headers.get("x-clash-error-code");

describe("createGatewayApp", () => {
  it("fails over to the next OpenAI-compatible route after a retryable upstream answer", async () => {
    const second = {
      id: "official-openai-2",
      providerId: "official",
      upstreamId: "openai",
      apiShape: "openai-compatible",
      configuredCredentials: ["apiKey"],
    };
    const accounts = [fixture.providers.official[0]!, second];
    const catalog: GatewayCatalog = {
      version: "failover-1",
      models: buildEffectiveModelCards({
        baseModels: [],
        providers: accounts,
        configs: [
          {
            modelId: fixture.textModel,
            custom: true,
            name: "Failover chat",
            kind: "text",
            providerBindings: accounts.map((account) => ({
              providerAccountId: account.id!,
              upstreamModel: `${account.id}-model`,
            })),
          },
        ],
      }),
    };
    const seen: Array<{ authorization: string; model: unknown }> = [];
    const { app, memory } = gateway({
      catalog,
      extraOfficial: [second],
      upstream: {
        async fetch(request) {
          seen.push({
            authorization: request.headers.get("authorization")!,
            model: ((await request.json()) as { model: unknown }).model,
          });
          return seen.length === 1 ? new Response("busy", { status: 503 }) : ok("x");
        },
      },
    });
    const plan = planGatewayRoutes({
      modelCode: fixture.textModel,
      catalog,
      scope: "official",
      providers: [...fixture.providers.official, second],
      isRouteExecutable: isOpenAIChatRoute,
    });
    expect(plan.attempts).toHaveLength(2);
    const res = await app.fetch(post(chat));
    expect(res.status).toBe(200);
    expect(seen.map((call) => call.model)).toEqual(
      plan.attempts.map((attempt) => attempt.route.upstreamModel),
    );
    expect(seen[0]!.authorization).not.toBe(seen[1]!.authorization);
    const row = await memory.ports.ledger.get({
      tenantId: "tenant-a",
      requestId: res.headers.get(GATEWAY_REQUEST_ID_HEADER)!,
    });
    expect(row).toMatchObject({ status: "settled", accountId: plan.attempts[1]!.route.accountId });
  });

  it("never sends anthropic-compatible routes the OpenAI wire format", async () => {
    const urls: string[] = [];
    const { app } = gateway({
      upstream: {
        async fetch(request) {
          urls.push(request.url);
          return ok("x");
        },
      },
    });
    expect((await app.fetch(post(chat))).status).toBe(200);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.endsWith("/chat/completions")).toBe(true);
  });

  it("maps an upstream deadline to GATEWAY_UPSTREAM_TIMEOUT or exhaustion and settles zero", async () => {
    const { app, memory } = gateway({
      upstream: {
        fetch: (request) =>
          new Promise((_resolve, reject) =>
            request.signal.addEventListener("abort", () => reject(request.signal.reason)),
          ),
      },
    });
    const res = await app.fetch(post(chat));
    expect(["GATEWAY_UPSTREAM_TIMEOUT", "GATEWAY_ROUTES_EXHAUSTED"]).toContain(code(res));
    const row = await memory.ports.ledger.get({
      tenantId: "tenant-a",
      requestId: res.headers.get(GATEWAY_REQUEST_ID_HEADER)!,
    });
    expect(row).toMatchObject({ status: "upstream_failed", costMicroCredits: 0 });
  });

  it("does not fail over or forward an upstream 4xx body", async () => {
    let calls = 0;
    const { app } = gateway({
      upstream: {
        async fetch() {
          calls += 1;
          return Response.json({ error: { message: "bad sk-leaked" } }, { status: 400 });
        },
      },
    });
    const res = await app.fetch(post(chat));
    expect([res.status, code(res)]).toEqual([400, "GATEWAY_UPSTREAM_REJECTED"]);
    expect(await res.text()).not.toContain("sk-leaked");
    expect(calls).toBe(1);
  });

  it("treats a 2xx answer that is not a completion as an upstream error", async () => {
    const { app } = gateway({ upstream: { fetch: async () => new Response("<html>", { status: 200 }) } });
    const res = await app.fetch(post(chat));
    expect([res.status, code(res)]).toEqual([502, "GATEWAY_UPSTREAM_ERROR"]);
  });

  it("enforces the credential's model allowlist with 403", async () => {
    let calls = 0;
    const { app } = gateway({
      identity: { modelAllowlist: ["some-other-model"] },
      upstream: {
        async fetch() {
          calls += 1;
          return ok("x");
        },
      },
    });
    const res = await app.fetch(post(chat));
    expect([res.status, code(res)]).toEqual([403, "GATEWAY_MODEL_NOT_ALLOWED"]);
    expect(calls).toBe(0);
  });

  it("rejects malformed, oversized and misrouted requests with coded errors", async () => {
    const never: GatewayUpstreamPort = { fetch: () => Promise.reject(new Error("unreachable")) };
    const { app } = gateway({ upstream: never });
    expect(code(await app.fetch(post(null, { raw: "{not json" })))).toBe("GATEWAY_INVALID_REQUEST");
    expect(code(await app.fetch(post({ model: fixture.textModel })))).toBe("GATEWAY_INVALID_REQUEST");
    const big = createGatewayApp(gateway({ upstream: never }).memory.ports, { maxBodyBytes: 16 });
    expect(code(await big.fetch(post(chat, { path: "/v1/chat/completions" })))).toBe(
      "GATEWAY_REQUEST_TOO_LARGE",
    );
    expect(code(await app.fetch(post(chat, { method: "GET" })))).toBe("GATEWAY_INVALID_REQUEST");
    const unknownPath = await app.fetch(post(chat, { path: "/gateway/v1/embeddings" }));
    expect([unknownPath.status, code(unknownPath)]).toEqual([501, "GATEWAY_CAPABILITY_UNAVAILABLE"]);
    expect(code(await app.fetch(post(chat, { token: "" })))).toBe("GATEWAY_AUTH_REQUIRED");
  });
});
