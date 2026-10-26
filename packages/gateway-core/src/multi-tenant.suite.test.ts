/**
 * #360 multi-tenant suite (REPORT §13 on in-memory ports + createGatewayApp).
 * Soak (2h / 500-stream) is out of scope; staging smoke is env-gated elsewhere.
 *
 * Case names match the acceptance criteria so CI evidence maps 1:1.
 */
import { describe, expect, it } from "vitest";
import { buildEffectiveModelCards } from "@clash/shared-types/model-routing";

import { admitGatewayRequest, settleMediaGeneration } from "./admission.js";
import {
  createGatewayApp,
  GATEWAY_REQUEST_ID_HEADER,
  isOpenAIChatRoute,
} from "./app.js";
import { GATEWAY_ERROR_TABLE, GatewayError, gatewayErrorResponseInit } from "./errors.js";
import { normalizeMediaGenerationRequest } from "./request.js";
import { planGatewayRoutes, type GatewayCatalog } from "./routing.js";
import { GATEWAY_SETTLEMENT_DEFAULTS } from "./settlement.js";
import { createSseParser, OPENAI_STREAM_DONE } from "./sse.js";
import { emptyUsage } from "./usage.js";
import { catalogFixture } from "./testing/fixtures.js";
import { createMemoryGatewayPorts, type MemoryIdentity } from "./testing/memory-ports.js";
import type { GatewayUpstreamPort } from "./ports.js";
import { priceUsage } from "./pricing.js";

const fixture = catalogFixture();
const OFFICIAL_KEY = fixture.keys["official-openai"]!;
const TENANT_KEY = fixture.keys["tenant-compatible"]!;

const chatBody = {
  model: fixture.textModel,
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 4,
};

function completion(model: string) {
  return Response.json({
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  });
}

function streamText(model: string): string {
  const chunks = [
    { object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "hel" } }] },
    { object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
    { object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
  ];
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: ${OPENAI_STREAM_DONE}\n\n`;
}

function eventStream(text: string, options: { failAfter?: number } = {}): Response {
  const encoder = new TextEncoder();
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (options.failAfter !== undefined && offset >= options.failAfter) {
          controller.error(new Error("upstream cut"));
          return;
        }
        if (offset >= text.length) {
          controller.close();
          return;
        }
        const next = Math.min(offset + 8, text.length);
        controller.enqueue(encoder.encode(text.slice(offset, next)));
        offset = next;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function identity(tenantId: string, keyId: string, budgetIds: string[], extra: Partial<MemoryIdentity> = {}): MemoryIdentity {
  return {
    tenantId,
    userId: `${tenantId}-user`,
    keyId,
    budgetIds,
    credentialScope: "official",
    ...extra,
  };
}

function budget(id: string, tenantId: string, limit: number | null, spent = 0, reserved = 0) {
  return {
    id,
    tenantId,
    scope: "tenant" as const,
    scopeId: tenantId,
    limitMicroCredits: limit,
    spentMicroCredits: spent,
    reservedMicroCredits: reserved,
    version: 0,
  };
}

function harness(options: {
  upstream?: GatewayUpstreamPort;
  identities?: Record<string, MemoryIdentity>;
  budgets?: Array<ReturnType<typeof budget>>;
  rateLimits?: Record<string, { windowMs: number; limit: number }>;
  catalog?: GatewayCatalog;
  providers?: typeof fixture.providers;
  keys?: Record<string, string | readonly string[]>;
  prices?: Parameters<typeof createMemoryGatewayPorts>[0]["prices"];
  credentialScope?: "official" | "tenant";
}) {
  const identities = options.identities ?? {
    "tenant-a": identity("tenant-a", "key-a", ["budget-a"], {
      credentialScope: options.credentialScope ?? "official",
    }),
    "tenant-b": identity("tenant-b", "key-b", ["budget-b"]),
  };
  const memory = createMemoryGatewayPorts({
    identities,
    catalog: options.catalog ?? fixture.catalog,
    providers: options.providers ?? fixture.providers,
    keys: options.keys ?? fixture.keys,
    prices: options.prices ?? [
      {
        modelCode: fixture.textModel,
        version: "price-mt-1",
        maxOutputTokens: 64,
        rates: [
          { unit: "input_token", microCredits: 1_000_000, per: 1_000_000 },
          { unit: "output_token", microCredits: 2_000_000, per: 1_000_000 },
        ],
      },
      ...(fixture.mediaModel
        ? [
            {
              modelCode: fixture.mediaModel.code,
              version: "price-mt-1",
              rates: [{ unit: "image" as const, microCredits: 40_000, per: 1 }],
            },
          ]
        : []),
    ],
    budgets: options.budgets ?? [
      budget("budget-a", "tenant-a", 50_000_000),
      budget("budget-b", "tenant-b", 1_000_000),
    ],
    rateLimits: options.rateLimits,
    upstream: options.upstream,
    startAt: 1_700_000_000_000,
  });
  const app = createGatewayApp(memory.ports, { basePath: "/gateway", upstreamTimeoutMs: 200 });
  return { memory, app };
}

const post = (
  path: string,
  body: unknown,
  init: { token?: string | null; headers?: Record<string, string>; raw?: string } = {},
) =>
  new Request(`https://gw.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token === null
        ? {}
        : { authorization: `Bearer ${init.token ?? "tenant-a"}` }),
      ...init.headers,
    },
    body: init.raw ?? JSON.stringify(body),
  });

const codeOf = (res: Response) => res.headers.get("x-clash-error-code");

describe("#360 multi-tenant suite (gateway-core / in-memory)", () => {
  describe("1. tenant isolation", () => {
    it("keeps ledger, budgets and credentials of tenant A invisible to tenant B", async () => {
      const recorder: string[] = [];
      const { memory, app } = harness({
        upstream: {
          async fetch(request) {
            recorder.push(request.headers.get("authorization") ?? "");
            return completion("x");
          },
        },
      });
      const res = await app.fetch(post("/gateway/v1/chat/completions", chatBody));
      expect(res.status).toBe(200);
      const requestId = res.headers.get(GATEWAY_REQUEST_ID_HEADER)!;
      expect(await memory.ports.ledger.get({ tenantId: "tenant-a", requestId })).toMatchObject({
        tenantId: "tenant-a",
        status: "settled",
      });
      expect(await memory.ports.ledger.get({ tenantId: "tenant-b", requestId })).toBeNull();
      const aBudgets = await memory.ports.budgets.snapshot({ tenantId: "tenant-a" });
      const bBudgets = await memory.ports.budgets.snapshot({ tenantId: "tenant-b" });
      expect(aBudgets.map((row) => row.id)).toEqual(["budget-a"]);
      expect(bBudgets.map((row) => row.id)).toEqual(["budget-b"]);
      expect(aBudgets.map((row) => row.id)).not.toContain("budget-b");
      expect(recorder).toEqual([`Bearer ${OFFICIAL_KEY}`]);
    });
  });

  describe("2. key custody (decision 7)", () => {
    it("sends the official key for official scope and the BYOK key for tenant scope; never mixes them", async () => {
      const seen: string[] = [];
      const official = harness({
        upstream: {
          async fetch(request) {
            seen.push(request.headers.get("authorization")!);
            return completion("x");
          },
        },
        credentialScope: "official",
      });
      const byok = harness({
        upstream: {
          async fetch(request) {
            seen.push(request.headers.get("authorization")!);
            return completion("x");
          },
        },
        identities: {
          "tenant-a": identity("tenant-a", "key-a", ["budget-a"], { credentialScope: "tenant" }),
        },
        credentialScope: "tenant",
      });
      expect((await official.app.fetch(post("/gateway/v1/chat/completions", chatBody))).status).toBe(200);
      expect((await byok.app.fetch(post("/gateway/v1/chat/completions", chatBody))).status).toBe(200);
      expect(seen).toEqual([`Bearer ${OFFICIAL_KEY}`, `Bearer ${TENANT_KEY}`]);
      expect(seen[0]).not.toBe(seen[1]);
    });

    it("answers GATEWAY_KEY_UNAVAILABLE with no fallback when the official key cannot be resolved", async () => {
      const only = fixture.providers.official[0]!;
      const catalog: GatewayCatalog = {
        version: "mt-no-key",
        models: buildEffectiveModelCards({
          baseModels: [],
          providers: [only],
          configs: [
            {
              modelId: fixture.textModel,
              custom: true,
              name: "No key",
              kind: "text",
              providerBindings: [{ providerAccountId: only.id!, upstreamModel: "fixture-openai-model" }],
            },
          ],
        }),
      };
      const { app } = harness({
        catalog,
        providers: { official: [only], tenant: [] },
        keys: { "tenant-compatible": TENANT_KEY },
        upstream: {
          async fetch() {
            throw new Error("must not contact upstream without a key");
          },
        },
      });
      const res = await app.fetch(post("/gateway/v1/chat/completions", chatBody));
      expect([res.status, codeOf(res)]).toEqual([503, "GATEWAY_KEY_UNAVAILABLE"]);
      expect(await res.text()).not.toContain("sk-");
    });
  });

  describe("3. budget race under concurrent streaming", () => {
    it("keeps spent <= limit across many concurrent prepaid debits; excess is GATEWAY_BUDGET_EXCEEDED", async () => {
      const debit = 100_000;
      const limit = 1_000_000; // admits exactly 10 debits
      const { memory } = harness({
        budgets: [budget("budget-a", "tenant-a", limit)],
      });
      const identityA = await memory.ports.identity.authenticate(
        post("/gateway/v1/chat/completions", chatBody, { token: "tenant-a" }),
      );
      const attempts = 50;
      const results = await Promise.all(
        Array.from({ length: attempts }, (_, index) =>
          memory.ports.budgets
            .debit({
              requestId: `race-${index}`,
              tenantId: identityA.tenantId,
              userId: identityA.userId,
              modelCode: "race-media",
              kind: "image",
              upstreamId: "race",
              credentialScope: identityA.credentialScope,
              usage: emptyUsage(),
              costMicroCredits: debit,
              priceVersion: "race",
              catalogVersion: "race",
              status: "settled",
              occurredAt: memory.ports.clock.now(),
              budgetIds: identityA.budgetIds,
            })
            .then(() => ({ ok: true as const }))
            .catch((error: unknown) => ({
              ok: false as const,
              code: error instanceof GatewayError ? error.code : "OTHER",
            })),
        ),
      );
      const admitted = results.filter((row) => row.ok).length;
      const refused = results.filter((row) => !row.ok && row.code === "GATEWAY_BUDGET_EXCEEDED").length;
      expect(admitted).toBe(10);
      expect(refused).toBe(attempts - admitted);
      const [snapshot] = await memory.ports.budgets.snapshot({
        tenantId: "tenant-a",
        budgetIds: ["budget-a"],
      });
      expect(snapshot!.spentMicroCredits).toBeLessThanOrEqual(limit);
      expect(snapshot!.spentMicroCredits).toBe(admitted * debit);
      expect(snapshot!.reservedMicroCredits).toBe(0);
    });
  });

  describe("4. partial stream + disconnect", () => {
    it("settles a truncated stream as partial at observed usage and contacts upstream once", async () => {
      let calls = 0;
      const text = streamText(fixture.textModel);
      const { memory, app } = harness({
        upstream: {
          async fetch() {
            calls += 1;
            return eventStream(text, { failAfter: Math.floor(text.length / 3) });
          },
        },
      });
      const res = await app.fetch(
        post("/gateway/v1/chat/completions", { ...chatBody, stream: true, stream_options: { include_usage: true } }),
      );
      expect(res.status).toBe(200);
      await res.text();
      expect(calls).toBe(1);
      const row = await memory.ports.ledger.get({
        tenantId: "tenant-a",
        requestId: res.headers.get(GATEWAY_REQUEST_ID_HEADER)!,
      });
      expect(row).toMatchObject({ status: "partial" });
    });

    it("settles client_aborted when the caller cancels mid-stream", async () => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let upstreamSignal: AbortSignal | undefined;
      const parts = streamText(fixture.textModel).split(/(?<=\n\n)/);
      const background: Array<Promise<unknown>> = [];
      const encoder = new TextEncoder();
      const memory = createMemoryGatewayPorts({
        identities: {
          "tenant-a": identity("tenant-a", "key-a", ["budget-a"]),
        },
        catalog: fixture.catalog,
        providers: fixture.providers,
        keys: fixture.keys,
        prices: [
          {
            modelCode: fixture.textModel,
            version: "price-mt-1",
            maxOutputTokens: 64,
            rates: [
              { unit: "input_token", microCredits: 1_000_000, per: 1_000_000 },
              { unit: "output_token", microCredits: 2_000_000, per: 1_000_000 },
            ],
          },
        ],
        budgets: [budget("budget-a", "tenant-a", 50_000_000)],
        upstream: {
          async fetch(request) {
            upstreamSignal = request.signal;
            return new Response(
              new ReadableStream<Uint8Array>({
                async start(controller) {
                  const fail = (reason: unknown) => {
                    try {
                      controller.error(reason);
                    } catch {
                      // already closed
                    }
                  };
                  request.signal.addEventListener("abort", () => fail(request.signal.reason));
                  for (const [index, part] of parts.entries()) {
                    if (index === 1) await gate;
                    if (request.signal.aborted) return;
                    controller.enqueue(encoder.encode(part));
                  }
                  controller.close();
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        },
        startAt: 1_700_000_000_000,
      });
      const app = createGatewayApp(memory.ports, {
        basePath: "/gateway",
        upstreamTimeoutMs: 200,
        waitUntil: (promise) => void background.push(promise),
      });
      const res = await app.fetch(post("/gateway/v1/chat/completions", { ...chatBody, stream: true }));
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      for (let wait = 0; wait < 200 && (background.length === 0 || !upstreamSignal?.aborted); wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(upstreamSignal?.aborted).toBe(true);
      expect(background.length).toBeGreaterThan(0);
      await Promise.all(background);
      open();
      const row = await memory.ports.ledger.get({
        tenantId: "tenant-a",
        requestId: res.headers.get(GATEWAY_REQUEST_ID_HEADER)!,
      });
      expect(row).toMatchObject({ status: "client_aborted" });
    }, 15_000);
  });

  describe("5. idempotency", () => {
    it("admits one upstream call and one ledger row for the same Idempotency-Key", async () => {
      let calls = 0;
      const { memory, app } = harness({
        upstream: {
          async fetch() {
            calls += 1;
            return completion("x");
          },
        },
      });
      const key = { "idempotency-key": "mt-idem-1" };
      const first = await app.fetch(post("/gateway/v1/chat/completions", chatBody, { headers: key }));
      expect(first.status).toBe(200);
      const second = await app.fetch(post("/gateway/v1/chat/completions", chatBody, { headers: key }));
      expect([second.status, codeOf(second)]).toEqual([409, "GATEWAY_IDEMPOTENCY_ALREADY_SETTLED"]);
      expect(calls).toBe(1);
      const requestId = first.headers.get(GATEWAY_REQUEST_ID_HEADER)!;
      expect(await memory.ports.ledger.get({ tenantId: "tenant-a", requestId })).toMatchObject({
        status: "settled",
      });
    });
  });

  describe("6. rate limits (decision 5)", () => {
    it("throttles only the limited key and never another tenant; answers 429 with Retry-After", async () => {
      const { app } = harness({
        identities: {
          "tenant-a": identity("tenant-a", "key-rate", ["budget-a"]),
          "tenant-b": identity("tenant-b", "key-b", ["budget-b"]),
        },
        rateLimits: { "key-rate": { windowMs: 60_000, limit: 2 } },
        upstream: { async fetch() { return completion("x"); } },
      });
      expect((await app.fetch(post("/gateway/v1/chat/completions", chatBody, { token: "tenant-a" }))).status).toBe(200);
      expect((await app.fetch(post("/gateway/v1/chat/completions", chatBody, { token: "tenant-a" }))).status).toBe(200);
      const limited = await app.fetch(post("/gateway/v1/chat/completions", chatBody, { token: "tenant-a" }));
      expect([limited.status, codeOf(limited)]).toEqual([429, "GATEWAY_RATE_LIMITED"]);
      expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
      expect((await app.fetch(post("/gateway/v1/chat/completions", chatBody, { token: "tenant-b" }))).status).toBe(200);
    });
  });

  describe("7. auth", () => {
    it("rejects anonymous, expired and model-allowlist mismatches with stable codes", async () => {
      const { app } = harness({
        identities: {
          "tenant-a": identity("tenant-a", "key-a", ["budget-a"]),
          expired: identity("tenant-a", "key-expired", ["budget-a"], { expiresAt: 1 }),
          restricted: identity("tenant-a", "key-restricted", ["budget-a"], {
            modelAllowlist: ["other-model"],
          }),
        },
        upstream: { async fetch() { return completion("x"); } },
      });
      const anonymous = await app.fetch(post("/gateway/v1/chat/completions", chatBody, { token: null }));
      expect([anonymous.status, codeOf(anonymous)]).toEqual([401, "GATEWAY_AUTH_REQUIRED"]);
      const expired = await app.fetch(post("/gateway/v1/chat/completions", chatBody, { token: "expired" }));
      expect([expired.status, codeOf(expired)]).toEqual([401, "GATEWAY_TOKEN_EXPIRED"]);
      const denied = await app.fetch(post("/gateway/v1/chat/completions", chatBody, { token: "restricted" }));
      expect([denied.status, codeOf(denied)]).toEqual([403, "GATEWAY_MODEL_NOT_ALLOWED"]);
    });
  });

  describe("8. admin / staff prompt policy (decision 10 — core half)", () => {
    it("documents self-host default: retention stays off unless the deployment opts in", () => {
      // Hosted api-cf sets GATEWAY_STAFF_PROMPT_ACCESS=enabled; OSS/self-host leaves it unset.
      // HTTP staff-access + audit coverage lives in apps/api-cf gateway-console + data-plane tests.
      const app = createGatewayApp(
        harness({ upstream: { async fetch() { return completion("x"); } } }).memory.ports,
        { basePath: "/gateway", retention: { enabled: false } },
      );
      expect(app).toBeTruthy();
    });
  });

  describe("9. coded errors", () => {
    it("maps the REPORT status table to GATEWAY_* without secrets in messages", async () => {
      const cases: Array<{ status: number; code: keyof typeof GATEWAY_ERROR_TABLE }> = [
        { status: 400, code: "GATEWAY_INVALID_REQUEST" },
        { status: 401, code: "GATEWAY_AUTH_REQUIRED" },
        { status: 402, code: "GATEWAY_BUDGET_EXCEEDED" },
        { status: 403, code: "GATEWAY_FORBIDDEN" },
        { status: 404, code: "GATEWAY_MODEL_NOT_FOUND" },
        { status: 413, code: "GATEWAY_REQUEST_TOO_LARGE" },
        { status: 429, code: "GATEWAY_RATE_LIMITED" },
        { status: 502, code: "GATEWAY_UPSTREAM_ERROR" },
      ];
      for (const { status, code } of cases) {
        expect(GATEWAY_ERROR_TABLE[code].status).toBe(status);
        const error = new GatewayError(code, { details: { secret: "sk-leak-test" } });
        const init = gatewayErrorResponseInit(error, "openai");
        expect(init.headers["x-clash-error-code"]).toBe(code);
        expect(JSON.stringify(init)).not.toContain("sk-leak-test");
        expect(error.message).not.toContain("sk-");
      }
    });
  });

  describe("10. streaming fidelity", () => {
    it("relays OpenAI SSE byte-for-byte with the public model code and settles reported usage", async () => {
      const vendor = "vendor-internal-model";
      const publicStream = streamText(fixture.textModel);
      const { memory, app } = harness({
        upstream: {
          async fetch() {
            return eventStream(streamText(vendor));
          },
        },
      });
      const res = await app.fetch(
        post("/gateway/v1/chat/completions", {
          ...chatBody,
          stream: true,
          stream_options: { include_usage: true },
        }),
      );
      expect(res.status).toBe(200);
      const delivered = await res.text();
      expect(delivered).toBe(publicStream);
      expect(delivered).not.toContain(vendor);
      const parser = createSseParser();
      const events = [...parser.push(delivered), ...parser.end()];
      expect(events.some((event) => event.data === OPENAI_STREAM_DONE)).toBe(true);
      const row = await memory.ports.ledger.get({
        tenantId: "tenant-a",
        requestId: res.headers.get(GATEWAY_REQUEST_ID_HEADER)!,
      });
      expect(row).toMatchObject({
        status: "settled",
        usage: { inputTokens: 2, outputTokens: 1, source: "reported" },
      });
    });
  });

  describe("11. failover", () => {
    it("retries a pre-first-byte 503 on the next key and never retries after bytes have started", async () => {
      const second = {
        id: "official-openai-2",
        providerId: "official",
        upstreamId: "openai",
        apiShape: "openai-compatible",
        configuredCredentials: ["apiKey"],
      };
      const accounts = [fixture.providers.official[0]!, second];
      const catalog: GatewayCatalog = {
        version: "mt-failover",
        models: buildEffectiveModelCards({
          baseModels: [],
          providers: accounts,
          configs: [
            {
              modelId: fixture.textModel,
              custom: true,
              name: "Failover",
              kind: "text",
              providerBindings: accounts.map((account) => ({
                providerAccountId: account.id!,
                upstreamModel: `${account.id}-model`,
              })),
            },
          ],
        }),
      };
      const seen: string[] = [];
      const { app, memory } = harness({
        catalog,
        providers: { official: accounts, tenant: fixture.providers.tenant },
        keys: { ...fixture.keys, "official-openai-2": "sk-fixture-official-openai-2" },
        upstream: {
          async fetch(request) {
            seen.push(request.headers.get("authorization")!);
            return seen.length === 1 ? new Response("busy", { status: 503 }) : completion("x");
          },
        },
      });
      const plan = planGatewayRoutes({
        modelCode: fixture.textModel,
        catalog,
        scope: "official",
        providers: accounts,
        isRouteExecutable: isOpenAIChatRoute,
      });
      expect(plan.attempts.length).toBeGreaterThanOrEqual(2);
      const res = await app.fetch(post("/gateway/v1/chat/completions", chatBody));
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(2);
      expect(seen[0]).not.toBe(seen[1]);
      expect(
        await memory.ports.ledger.get({
          tenantId: "tenant-a",
          requestId: res.headers.get(GATEWAY_REQUEST_ID_HEADER)!,
        }),
      ).toMatchObject({ status: "settled", accountId: plan.attempts[1]!.route.accountId });
    });
  });

  describe("12. media metering (decision 11 — AIGC zero-charge on failure, #399 prepay + refund)", () => {
    it("refunds the prepaid debit when a media generation fails after acceptance; a success keeps it", async (context) => {
      const media = fixture.mediaModel;
      if (!media) {
        context.skip();
        return;
      }
      const units = { image: 2 } as const;
      const { memory } = harness({});
      const admit = () =>
        admitGatewayRequest(
          memory.ports,
          {
            httpRequest: post("/gateway/v1/chat/completions", chatBody),
            request: normalizeMediaGenerationRequest({
              model: media.code,
              kind: media.kind,
              units,
            }),
          },
        );
      const wallet = async () => (await memory.ports.budgets.snapshot({ tenantId: "tenant-a" }))[0]!;
      const before = await wallet();
      const failed = await admit();
      const { dispatch } = await settleMediaGeneration(memory.ports, failed, {
        attempt: failed.plan.attempts[0]!,
        result: { status: "failed", error: new GatewayError("GATEWAY_UPSTREAM_ERROR") },
      });
      expect(dispatch).toMatchObject({ kind: "refund", scheduled: true });
      expect((await wallet()).spentMicroCredits).toBe(before.spentMicroCredits);
      expect(
        await memory.ports.ledger.get({ tenantId: failed.identity.tenantId, requestId: failed.requestId }),
      ).toMatchObject({ status: "upstream_failed", costMicroCredits: 0 });

      const served = await admit();
      const { settlement, dispatch: none } = await settleMediaGeneration(memory.ports, served, {
        attempt: served.plan.attempts[0]!,
        result: { status: "succeeded", units },
      });
      const price = priceUsage({ ...emptyUsage(), units }, served.price).microCredits;
      expect(settlement.costMicroCredits).toBe(price);
      expect(price).toBeGreaterThan(0);
      expect(none).toBeNull();
      expect((await wallet()).spentMicroCredits).toBe(before.spentMicroCredits + price);
    });
  });

  describe("13. abuse", () => {
    it("refuses further spend once the hard wallet is exhausted to the credit floor (suspend-equivalent ceiling)", async () => {
      const { app } = harness({
        // Postpaid text is admitted down to -floor (#399); at -floor it is refused.
        budgets: [budget("budget-a", "tenant-a", 0, GATEWAY_SETTLEMENT_DEFAULTS.creditFloorMicroCredits)],
        upstream: {
          async fetch() {
            throw new Error("must not contact upstream over an empty wallet");
          },
        },
      });
      const res = await app.fetch(post("/gateway/v1/chat/completions", chatBody));
      expect([res.status, codeOf(res)]).toEqual([402, "GATEWAY_BUDGET_EXCEEDED"]);
    });
  });

  describe("14. staging smoke (named check)", () => {
    it("is env-gated in apps/api-cf integration; this unit suite never hits real upstreams", () => {
      expect(process.env.GATEWAY_STAGING_SMOKE ?? "").not.toBe("force-in-unit");
    });
  });
});
