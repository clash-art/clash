/**
 * #360 multi-tenant cases in workerd + migrated D1 (miniflare). Upstream is a
 * fetch stub; never production. Complements the node:sqlite suite with the
 * real Workers runtime for isolation, idempotency and abuse suspend.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../app";
import type { Env } from "../config";
import { signedInAdmin } from "../services/admin-session.test-support";
import { seedGateway, type SeededGateway } from "../gateway/test-support";

const ORIGIN = "https://clash.test";
let seeding: Promise<SeededGateway> | undefined;
const seeded = () => (seeding ??= seedGateway(env.DB, { bucket: env.R2_BUCKET }));

describe("#360 multi-tenant suite (miniflare / workerd)", () => {
  const app = createApp();
  let gateway: SeededGateway;
  let bindings: Env;
  let upstream: Request[];

  beforeAll(async () => {
    gateway = await seeded();
    bindings = { ...env, GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey } as unknown as Env;
  });
  beforeEach(() => {
    upstream = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      if (!request.url.endsWith("/chat/completions")) throw new Error(`Unexpected external request: ${request.url}`);
      upstream.push(request);
      const body = (await request.clone().json()) as Record<string, unknown>;
      return Response.json({
        id: "chatcmpl-mf",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const send = (token: string | undefined, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.request(
      "/gateway/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      },
      bindings,
    );
  const chat = (extra: Record<string, unknown> = {}) => ({
    model: gateway.textModel,
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 16,
    ...extra,
  });
  const code = (res: Response) => res.headers.get("x-clash-error-code");

  it("1. tenant isolation: Alice's settle row is invisible to Bob's ledger.get", async () => {
    const alice = await gateway.tenantToken();
    const bob = await gateway.tenantToken();
    const res = await send(alice.token, chat());
    expect(res.status, await res.clone().text()).toBe(200);
    const requestId = res.headers.get("x-clash-request-id")!;
    expect(await gateway.ports().ledger.get({ tenantId: alice.tenantId, requestId })).toMatchObject({
      tenantId: alice.tenantId,
      status: "settled",
    });
    expect(await gateway.ports().ledger.get({ tenantId: bob.tenantId, requestId })).toBeNull();
  });

  it("5. idempotency: one upstream call for a repeated Idempotency-Key", async () => {
    const caller = await gateway.tenantToken();
    const key = { "idempotency-key": `mf-${crypto.randomUUID()}` };
    expect((await send(caller.token, chat(), key)).status).toBe(200);
    const second = await send(caller.token, chat(), key);
    expect([second.status, code(second)]).toEqual([409, "GATEWAY_IDEMPOTENCY_ALREADY_SETTLED"]);
    expect(upstream).toHaveLength(1);
  });

  it("13. abuse: suspended wallet refuses subsequent chat", async () => {
    const caller = await gateway.tenantToken();
    const adminEnv = { ...bindings, BETTER_AUTH_URL: ORIGIN } as Env;
    const staff = await signedInAdmin(app, adminEnv as never, ORIGIN);
    const suspend = await app.request(
      `/api/v1/admin/gateway/tenants/${caller.tenantId}/wallet/status`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, ...staff.auth },
        body: JSON.stringify({ status: "suspended", reason: "abuse velocity" }),
      },
      adminEnv,
    );
    expect(suspend.status, await suspend.clone().text()).toBe(200);
    const before = upstream.length;
    const refused = await send(caller.token, chat());
    expect([refused.status, code(refused)]).toEqual([402, "GATEWAY_BUDGET_EXCEEDED"]);
    expect(upstream.length).toBe(before);
  });

  it("8. decision 10: self-host default refuses staff prompt access", async () => {
    const adminEnv = { ...bindings, BETTER_AUTH_URL: ORIGIN } as Env;
    const staff = await signedInAdmin(app, adminEnv as never, ORIGIN);
    const viewed = await app.request(
      `/api/v1/admin/gateway/prompts/gwr_missing/access`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, ...staff.auth },
        body: JSON.stringify({ reason: "incident" }),
      },
      adminEnv,
    );
    expect([viewed.status, code(viewed)]).toEqual([403, "GATEWAY_PROMPT_ACCESS_DISABLED"]);
  });
});
