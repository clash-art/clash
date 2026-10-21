/**
 * Gateway data plane (#347) in workerd with the migrated D1 schema: the shared
 * gateway-core contract (including the non-stream chat cases) over the D1
 * ports, and /gateway/v1/chat/completions through the Worker app. Upstreams
 * are fetch stubs; any other outbound request fails the test.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeGatewayContract } from "@clash/gateway-core/contract";
import { gatewayRetentionKeys } from "@clash/gateway-core";

import { createApp } from "../app";
import type { Env } from "../config";
import { sha256Hex } from "../services/api-token";
import { d1ContractHarness, seedGateway, type SeededGateway } from "../gateway/test-support";

const ORIGIN = "https://clash.test";
// Seeded on first use: the setup file applies the migrations before any hook runs.
let seeding: Promise<SeededGateway> | undefined;
// The real workerd R2 binding backs `blobs`, so the contract runs retention end to end.
const seeded = () => (seeding ??= seedGateway(env.DB, { bucket: env.R2_BUCKET }));

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

  it("retains bodies in R2 with the hosted flag, and platform_admin views the stored bytes, audited", async () => {
    const retaining = { ...bindings, GATEWAY_STAFF_PROMPT_ACCESS: "enabled" } as Env;
    const caller = await gateway.tenantToken();
    const prompt = `workerd prompt ${crypto.randomUUID()}`;
    const res = await app.request(
      "/gateway/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${caller.token}` },
        body: JSON.stringify(chat({ messages: [{ role: "user", content: prompt }] })),
      },
      retaining,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get("x-gateway-retention")).toBeNull();
    const answered = await res.text();
    const requestId = res.headers.get("x-clash-request-id")!;
    const object = await env.R2_BUCKET.get(gatewayRetentionKeys(requestId).response);
    expect(await object?.text()).toBe(answered);

    // A platform admin's clsh_ token, resolved by the /api/* middleware as in production.
    const staffId = `staff-${crypto.randomUUID()}`;
    const raw = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO api_token (id, user_id, name, token_hash, token_prefix) VALUES (?, ?, 'staff', ?, 'clsh_st')`).bind(
        `tok-${staffId}`,
        staffId,
        await sha256Hex(raw),
      ),
      env.DB.prepare(`INSERT INTO gateway_platform_role (user_id, role) VALUES (?, 'platform_admin')`).bind(staffId),
    ]);
    const viewed = await app.request(
      `/api/v1/admin/gateway/prompts/${requestId}/access`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${raw}` },
        body: JSON.stringify({ reason: "workerd incident" }),
      },
      retaining,
    );
    expect(viewed.status, await viewed.clone().text()).toBe(200);
    const view = (await viewed.json()) as { prompt: { request: { body: string }; response: { body: string } } };
    expect(view.prompt.response.body).toBe(answered);
    expect(view.prompt.request.body).toContain(prompt);
    const audit = await env.DB.prepare(
      `SELECT actor_user_id, reason, after_json FROM gateway_admin_audit WHERE action = 'prompt.view' AND target_id = ?`,
    )
      .bind(requestId)
      .all<{ actor_user_id: string; reason: string; after_json: string }>();
    expect(audit.results).toEqual([expect.objectContaining({ actor_user_id: staffId, reason: "workerd incident" })]);
    expect(audit.results[0]!.after_json).not.toContain(prompt);
  });
});
