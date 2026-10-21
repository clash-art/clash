/**
 * sk_gw_ gateway tokens (#346) in workerd with the migrated D1 schema: mint
 * from a real Better Auth session and a clsh_ token, verify through
 * /gateway/me, and the sign-out cascade. The D1 identity port also runs the
 * shared gateway-core contract (identity supported, everything else 501).
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unavailablePort, type GatewayPorts } from "@clash/gateway-core";
import { describeGatewayContract } from "@clash/gateway-core/contract";

import { createApp } from "../app";
import type { Env } from "../config";
import { sha256Hex } from "../services/api-token";
import { createD1GatewayIdentityPort, createGatewayTokenStore } from "../services/gateway-tokens";

const ORIGIN = "https://clash.test";
const bindings = { ...env, BETTER_AUTH_URL: ORIGIN } as unknown as Env;
const app = createApp();

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    throw new Error(`Unexpected external request: ${String(request)}`);
  });
});
afterEach(() => vi.restoreAllMocks());

const request = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { origin: ORIGIN, ...(init.headers as Record<string, string>) } }, bindings);

async function signUp() {
  const email = `gw-${crypto.randomUUID()}@example.com`;
  const res = await request("/api/better-auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "gateway-password-123", name: "Gateway" }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  return { userId: user!.id, cookie };
}

async function apiToken(userId: string) {
  const raw = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO api_token (id, user_id, name, token_hash, token_prefix) VALUES (?, ?, 'gw', ?, 'clsh_gw')")
    .bind(id, userId, await sha256Hex(raw))
    .run();
  return { id, raw };
}

async function mint(headers: Record<string, string>, body?: unknown) {
  const res = await request("/api/v1/gateway/tokens", {
    method: "POST",
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res;
}

async function minted(headers: Record<string, string>, body?: unknown) {
  const res = await mint(headers, body);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { token: string; keyId: string; expiresAt: string; baseUrl: string; modelAllowlist: string[] | null };
}

const me = (headers: Record<string, string>) => request("/gateway/me", { headers });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const code = (res: Response) => res.headers.get("x-clash-error-code");

describe("gateway tokens in workerd", () => {
  it("mints from a session, verifies from the token alone, and revokes on sign-out", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const body = await minted({ cookie: alice.cookie }, { modelAllowlist: ["model-a"] });
    expect(body.token.startsWith("sk_gw_")).toBe(true);
    expect(body.modelAllowlist).toEqual(["model-a"]);

    const row = await env.DB.prepare("SELECT token_hash, expires_at, parent_kind FROM gateway_token WHERE id = ?")
      .bind(body.keyId)
      .first<{ token_hash: string; expires_at: number; parent_kind: string }>();
    expect(row).toEqual({
      token_hash: await sha256Hex(body.token),
      expires_at: Date.parse(body.expiresAt) / 1000,
      parent_kind: "session",
    });

    const spoofed = await me({ ...bearer(body.token), "x-user-id": bob.userId });
    expect(spoofed.status).toBe(200);
    expect(await spoofed.json()).toMatchObject({ userId: alice.userId, tenantId: `personal:${alice.userId}`, keyId: body.keyId });
    const anonymous = await me({ "x-user-id": alice.userId });
    expect([anonymous.status, code(anonymous)]).toEqual([401, "GATEWAY_AUTH_REQUIRED"]);

    const out = await request("/api/better-auth/sign-out", { method: "POST", headers: { cookie: alice.cookie } });
    expect(out.status).toBe(200);
    const revoked = await me(bearer(body.token));
    expect([revoked.status, code(revoked)]).toEqual([401, "GATEWAY_TOKEN_REVOKED"]);
    const cascaded = await env.DB.prepare("SELECT revoked_at FROM gateway_token WHERE id = ?").bind(body.keyId).first<{ revoked_at: number | null }>();
    expect(cascaded?.revoked_at).toEqual(expect.any(Number));
  });

  it("mints from clsh_, renews, expires, revokes and isolates tenants", async () => {
    const carol = await signUp();
    const dave = await signUp();
    const clsh = await apiToken(carol.userId);
    const body = await minted(bearer(clsh.raw));

    await env.DB.prepare("UPDATE gateway_token SET expires_at = unixepoch() + 30 WHERE id = ?").bind(body.keyId).run();
    const renewed = await request(`/api/v1/gateway/tokens/${body.keyId}/renew`, { method: "POST", headers: bearer(clsh.raw) });
    expect(renewed.status).toBe(200);
    const notParent = await request(`/api/v1/gateway/tokens/${body.keyId}/renew`, { method: "POST", headers: { cookie: carol.cookie } });
    expect([notParent.status, code(notParent)]).toEqual([403, "GATEWAY_FORBIDDEN"]);
    expect((await me(bearer(body.token))).status).toBe(200);

    await env.DB.prepare("UPDATE gateway_token SET expires_at = unixepoch() - 1 WHERE id = ?").bind(body.keyId).run();
    const expired = await me(bearer(body.token));
    expect([expired.status, code(expired)]).toEqual([401, "GATEWAY_TOKEN_EXPIRED"]);

    const second = await minted(bearer(clsh.raw));
    const del = await request(`/api/v1/gateway/tokens/${second.keyId}`, { method: "DELETE", headers: bearer(clsh.raw) });
    expect(del.status).toBe(204);
    const revoked = await me(bearer(second.token));
    expect([revoked.status, code(revoked)]).toEqual([401, "GATEWAY_TOKEN_REVOKED"]);

    const crossTenant = await mint({ cookie: carol.cookie }, { tenantId: `personal:${dave.userId}` });
    expect([crossTenant.status, code(crossTenant)]).toEqual([403, "GATEWAY_FORBIDDEN"]);
    const daves = await minted({ cookie: dave.cookie });
    const port = createD1GatewayIdentityPort(env.DB);
    await expect(
      port.verify(new Request(`${ORIGIN}/gateway/v1/chat/completions`, { headers: bearer(daves.token) }), {
        tenantId: `personal:${carol.userId}`,
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_FORBIDDEN" });
  });
});

describeGatewayContract("Workers/D1 gateway token identity", async () => {
  const store = createGatewayTokenStore(env.DB);
  const tenantToken = async () => {
    const userId = `contract-${crypto.randomUUID()}`;
    const parent = await apiToken(userId);
    return (await store.mint({ userId, parent: { kind: "api_token", id: parent.id } })).token;
  };
  const [tenantA, tenantB] = [await tenantToken(), await tenantToken()];
  const gatewayRequest = (token?: string) =>
    new Request(`${ORIGIN}/gateway/v1/chat/completions`, {
      method: "POST",
      headers: token ? bearer(token) : {},
    });
  let last = 0;
  const ports: GatewayPorts = {
    clock: { now: () => (last = Math.max(last, Date.now())) },
    ids: { requestId: () => crypto.randomUUID() },
    identity: createD1GatewayIdentityPort(env.DB),
    routes: unavailablePort("routes"),
    credentials: unavailablePort("credentials"),
    budgets: unavailablePort("budgets"),
    limits: unavailablePort("limits"),
    ledger: unavailablePort("ledger"),
    blobs: unavailablePort("blobs"),
    retention: unavailablePort("retention"),
    scheduler: unavailablePort("scheduler"),
    audit: unavailablePort("audit"),
    logger: { info() {}, warn() {}, error() {} },
    upstream: unavailablePort("upstream"),
  };
  return {
    ports,
    capabilities: {
      identity: "supported",
      routes: "unavailable",
      credentials: "unavailable",
      budgets: "unavailable",
      ledger: "unavailable",
      "limits.rate": "unavailable",
      "limits.concurrency": "unavailable",
      blobs: "unavailable",
      retention: "unavailable",
      scheduler: "unavailable",
      audit: "unavailable",
    },
    fixtures: {
      tenantRequest: () => gatewayRequest(tenantA),
      otherTenantRequest: () => gatewayRequest(tenantB),
      anonymousRequest: () => gatewayRequest(),
      textModel: "contract-text-model",
    },
  };
});
