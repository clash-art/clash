/**
 * Gateway data plane (#347) in workerd with the migrated D1 schema: the shared
 * gateway-core contract (including the non-stream chat cases) over the D1
 * ports, and /gateway/v1/chat/completions through the Worker app. Upstreams
 * are fetch stubs; any other outbound request fails the test.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeGatewayContract } from "@clash/gateway-core/contract";

import { createApp } from "../app";
import type { Env } from "../config";
import { d1ContractHarness, seedGateway, type SeededGateway } from "../gateway/test-support";

const ORIGIN = "https://clash.test";
// Seeded on first use: the setup file applies the migrations before any hook runs.
let seeding: Promise<SeededGateway> | undefined;
const seeded = () => (seeding ??= seedGateway(env.DB));

describeGatewayContract("Workers/D1 gateway ports (miniflare)", async () => d1ContractHarness(await seeded()));

describe("/gateway/v1/chat/completions in workerd", () => {
  const app = createApp();
  let gateway: SeededGateway;
  let bindings: Env;
  let upstream: Request[];
  let answer: (body: Record<string, unknown>) => Response;

  beforeAll(async () => {
    gateway = await seeded();
    bindings = { ...env, GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey } as unknown as Env;
  });
  beforeEach(() => {
    upstream = [];
    answer = (body) =>
      Response.json({
        id: "chatcmpl-workerd",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      if (!request.url.endsWith("/chat/completions"))
        throw new Error(`Unexpected external request: ${request.url}`);
      upstream.push(request);
      return answer((await request.clone().json()) as Record<string, unknown>);
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

  it("routes to the official account and bills the token's user, not a spoofed x-user-id", async () => {
    const alice = await gateway.tenantToken();
    const bob = await gateway.tenantToken();
    const res = await send(alice.token, chat(), { "x-user-id": bob.userId });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.headers.get("authorization")).toBe(`Bearer ${gateway.upstreamApiKey}`);
    expect(upstream[0]!.headers.get("x-user-id")).toBeNull();
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT user_id, tenant_id FROM gateway_usage_ledger WHERE request_id = ? AND kind = 'settle'`,
    )
      .bind(res.headers.get("x-clash-request-id"))
      .all<{ user_id: string; tenant_id: string }>();
    expect(results).toEqual([{ user_id: alice.userId, tenant_id: alice.tenantId }]);
  });

  it("answers coded 401, 403, 501 and 502 without leaking upstream text", async () => {
    const caller = await gateway.tenantToken();
    const restricted = await gateway.tenantToken({ modelAllowlist: ["some-other-model"] });
    const anonymous = await send(undefined, chat(), { "x-user-id": caller.userId });
    expect([anonymous.status, code(anonymous)]).toEqual([401, "GATEWAY_AUTH_REQUIRED"]);
    const denied = await send(restricted.token, chat());
    expect([denied.status, code(denied)]).toEqual([403, "GATEWAY_MODEL_NOT_ALLOWED"]);
    const streaming = await send(caller.token, chat({ stream: true }));
    expect([streaming.status, code(streaming)]).toEqual([501, "GATEWAY_CAPABILITY_UNAVAILABLE"]);
    expect(upstream).toHaveLength(0);

    answer = () => Response.json({ error: { message: `key ${gateway.upstreamApiKey}` } }, { status: 503 });
    const failed = await send(caller.token, chat());
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(gateway.upstreamApiKey);
  });
});
