/**
 * sk_gw_ gateway tokens (#346) against real SQL (web/drizzle migrations on
 * node:sqlite), real Better Auth sessions and real clsh_ token rows.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("../containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));

import { isGatewayError, type GatewayErrorCode } from "@clash/gateway-core";
import { createApp } from "../app";
import { createSqliteD1 } from "../../../web/app/test-support/sqlite-d1";
import {
  createD1GatewayIdentityPort,
  createGatewayTokenStore,
  type GatewayTokenRequirements,
} from "../services/gateway-tokens";

const ORIGIN = "http://localhost:8789";
// Issue #346: tokens are `sk_gw_…` and live 15 minutes.
const TOKEN_PREFIX = "sk_gw_";
const TTL_MS = 15 * 60 * 1000;

const { d1, sqlite } = createSqliteD1();
const env = {
  DB: d1,
  ENVIRONMENT: "test",
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "test-secret-for-gateway-tokens-0123456789",
} as never;
const app = createApp();

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

async function signUp(email: string) {
  const res = await app.request(
    "/api/better-auth/sign-up/email",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: "gateway-password-123", name: email }),
    },
    env,
  );
  expect(res.status).toBe(200);
  const { id } = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string };
  return { userId: id, cookie: cookieOf(res), email };
}

async function signIn(email: string) {
  const res = await app.request(
    "/api/better-auth/sign-in/email",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: "gateway-password-123" }),
    },
    env,
  );
  expect(res.status).toBe(200);
  return cookieOf(res);
}

function apiToken(userId: string) {
  const raw = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  const id = `tok-${crypto.randomUUID()}`;
  sqlite
    .prepare("INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, 'gw', ?, 'clsh_gw', 1)")
    .run(id, userId, sha256(raw));
  return { id, raw };
}

interface MintBody {
  token: string;
  expiresAt: string;
  baseUrl: string;
  keyId: string;
  tenantId: string;
  scopes: string[];
  modelAllowlist: string[] | null;
}

async function mint(headers: Record<string, string>, body?: unknown) {
  return app.request(
    "/api/v1/gateway/tokens",
    {
      method: "POST",
      headers: { origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
}

async function minted(headers: Record<string, string>, body?: unknown): Promise<MintBody> {
  const res = await mint(headers, body);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as MintBody;
}

const me = (headers: Record<string, string>) => app.request("/gateway/me", { headers }, env);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function expectCoded(res: Response, status: number, code: GatewayErrorCode) {
  expect(res.status).toBe(status);
  expect(res.headers.get("x-clash-error-code")).toBe(code);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe(code);
  return body;
}

async function expectRejects(promise: Promise<unknown>, code: GatewayErrorCode) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isGatewayError(error), String(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
}

const verifyRequest = (token: string) =>
  new Request("https://gateway.test/gateway/v1/chat/completions", { headers: bearer(token) });

function tokenRow(keyId: string) {
  return sqlite.prepare("SELECT * FROM gateway_token WHERE id = ?").get(keyId) as Record<string, unknown>;
}

describe("gateway tokens", () => {
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;
  const logged: string[] = [];

  beforeAll(async () => {
    alice = await signUp("alice-gw@example.com");
    bob = await signUp("bob-gw@example.com");
  });

  afterEach(() => vi.restoreAllMocks());

  function captureLogs() {
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      });
  }

  it("mints from a Better Auth session and stores only the hash", async () => {
    const before = Date.now();
    const body = await minted({ cookie: alice.cookie }, { modelAllowlist: ["model-a"] });
    expect(body.token.startsWith(TOKEN_PREFIX)).toBe(true);
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThan(before + TTL_MS - 2_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + TTL_MS);
    expect(body.modelAllowlist).toEqual(["model-a"]);
    expect(body.tenantId).toBe(`personal:${alice.userId}`);

    const row = tokenRow(body.keyId);
    expect(row.token_hash).toBe(sha256(body.token));
    expect(Object.values(row).some((value) => String(value).includes(body.token.slice(TOKEN_PREFIX.length)))).toBe(false);
    // D1 keeps unix seconds; the API answers the same instant.
    expect((row.expires_at as number) * 1000).toBe(expiresAt);
    expect(row.parent_kind).toBe("session");
    expect(sqlite.prepare("SELECT user_id FROM sessions WHERE id = ?").get(row.parent_id as string)).toEqual({
      user_id: alice.userId,
    });

    // baseUrl is where the token is presented.
    const res = await app.request(`${new URL(body.baseUrl).pathname}/me`, { headers: bearer(body.token) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      userId: alice.userId,
      tenantId: body.tenantId,
      keyId: body.keyId,
      modelAllowlist: ["model-a"],
      expiresAt: body.expiresAt,
    });
  });

  it("mints from a clsh_ API token", async () => {
    const clsh = apiToken(bob.userId);
    const body = await minted(bearer(clsh.raw));
    expect(body.modelAllowlist).toBeNull();
    expect(tokenRow(body.keyId)).toMatchObject({ parent_kind: "api_token", parent_id: clsh.id, user_id: bob.userId });
    const res = await me(bearer(body.token));
    expect(await res.json()).toMatchObject({ userId: bob.userId, tenantId: `personal:${bob.userId}` });
  });

  it("refuses to mint without a session or clsh_ parent, including from an sk_gw_ token", async () => {
    await expectCoded(await mint({}), 401, "GATEWAY_AUTH_REQUIRED");
    const child = await minted({ cookie: alice.cookie });
    await expectCoded(await mint(bearer(child.token)), 401, "GATEWAY_AUTH_REQUIRED");
    await expectCoded(await mint({ "x-user-id": alice.userId }), 401, "GATEWAY_AUTH_REQUIRED");
  });

  it("rejects an invalid mint body with a coded error", async () => {
    await expectCoded(await mint({ cookie: alice.cookie }, { scopes: ["admin"] }), 400, "GATEWAY_INVALID_REQUEST");
    await expectCoded(await mint({ cookie: alice.cookie }, { modelAllowlist: [] }), 400, "GATEWAY_INVALID_REQUEST");
  });

  it("derives identity from the token only: x-user-id cannot spoof or authenticate", async () => {
    const body = await minted({ cookie: alice.cookie });
    const spoofed = await me({ ...bearer(body.token), "x-user-id": bob.userId });
    expect(spoofed.status).toBe(200);
    expect(await spoofed.json()).toMatchObject({ userId: alice.userId, tenantId: `personal:${alice.userId}` });

    await expectCoded(await me({ "x-user-id": alice.userId }), 401, "GATEWAY_AUTH_REQUIRED");
    await expectCoded(await me({ cookie: alice.cookie }), 401, "GATEWAY_AUTH_REQUIRED");
    await expectCoded(await me(bearer(apiToken(alice.userId).raw)), 401, "GATEWAY_AUTH_REQUIRED");
    await expectCoded(await me(bearer(`${body.token}x`)), 401, "GATEWAY_AUTH_REQUIRED");
    // Well-formed but never minted.
    const forged = `${body.token.slice(0, -4)}${body.token.endsWith("0000") ? "1111" : "0000"}`;
    await expectCoded(await me(bearer(forged)), 401, "GATEWAY_AUTH_REQUIRED");
  });

  it("expires after the TTL", async () => {
    const t0 = 1_800_000_000_000;
    let now = t0;
    const store = createGatewayTokenStore(d1, { clock: { now: () => now } });
    // A parent session (Better Auth stores epoch ms) that outlives the clock under test.
    const parent = { id: `session-${crypto.randomUUID()}` };
    sqlite
      .prepare("INSERT INTO sessions (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(parent.id, t0 + 10 * TTL_MS, crypto.randomUUID(), t0, t0, alice.userId);
    const token = await store.mint({ userId: alice.userId, parent: { kind: "session", id: parent.id } });
    expect(token.expiresAt).toBe(t0 + TTL_MS);

    now = t0 + TTL_MS - 1_000;
    await expect(store.verify(verifyRequest(token.token))).resolves.toMatchObject({ userId: alice.userId });
    now = t0 + TTL_MS;
    await expectRejects(store.verify(verifyRequest(token.token)), "GATEWAY_TOKEN_EXPIRED");

    // Over HTTP (real clock), an elapsed expires_at answers the same code.
    const body = await minted({ cookie: alice.cookie });
    sqlite.prepare("UPDATE gateway_token SET expires_at = unixepoch() - 1 WHERE id = ?").run(body.keyId);
    await expectCoded(await me(bearer(body.token)), 401, "GATEWAY_TOKEN_EXPIRED");
  });

  it("revokes a token through the API, idempotently and only for its owner", async () => {
    const body = await minted({ cookie: alice.cookie });
    const revoke = (headers: Record<string, string>) =>
      app.request(`/api/v1/gateway/tokens/${body.keyId}`, { method: "DELETE", headers: { origin: ORIGIN, ...headers } }, env);

    await expectCoded(await revoke({ cookie: bob.cookie }), 403, "GATEWAY_FORBIDDEN");
    expect((await me(bearer(body.token))).status).toBe(200);
    expect((await revoke({ cookie: alice.cookie })).status).toBe(204);
    expect((await revoke({ cookie: alice.cookie })).status).toBe(204);
    await expectCoded(await me(bearer(body.token)), 401, "GATEWAY_TOKEN_REVOKED");
    await expectCoded(await revoke(bearer(body.token)), 401, "GATEWAY_AUTH_REQUIRED");
  });

  it("revokes children when the parent clsh_ token is deleted", async () => {
    const clsh = apiToken(alice.userId);
    const body = await minted(bearer(clsh.raw));
    expect((await me(bearer(body.token))).status).toBe(200);
    sqlite.prepare("DELETE FROM api_token WHERE id = ?").run(clsh.id);
    await expectCoded(await me(bearer(body.token)), 401, "GATEWAY_TOKEN_REVOKED");
  });

  it("revokes child tokens on Better Auth sign-out", async () => {
    const cookie = await signIn(alice.email);
    const body = await minted({ cookie });
    const sibling = await minted({ cookie: alice.cookie });
    expect((await me(bearer(body.token))).status).toBe(200);

    const out = await app.request("/api/better-auth/sign-out", { method: "POST", headers: { cookie, origin: ORIGIN } }, env);
    expect(out.status).toBe(200);
    expect(tokenRow(body.keyId).revoked_at).toEqual(expect.any(Number));
    await expectCoded(await me(bearer(body.token)), 401, "GATEWAY_TOKEN_REVOKED");
    // Tokens of the user's other sessions are untouched.
    expect(tokenRow(sibling.keyId).revoked_at).toBeNull();
    expect((await me(bearer(sibling.token))).status).toBe(200);
    // The signed-out session can no longer mint or renew.
    await expectCoded(await mint({ cookie }), 401, "GATEWAY_AUTH_REQUIRED");
  });

  it("renews while the same parent credential is valid", async () => {
    const body = await minted({ cookie: alice.cookie });
    sqlite.prepare("UPDATE gateway_token SET expires_at = unixepoch() + 30 WHERE id = ?").run(body.keyId);
    const renew = (headers: Record<string, string>) =>
      app.request(`/api/v1/gateway/tokens/${body.keyId}/renew`, { method: "POST", headers: { origin: ORIGIN, ...headers } }, env);

    const before = Date.now();
    const res = await renew({ cookie: alice.cookie });
    expect(res.status, await res.clone().text()).toBe(200);
    const renewed = (await res.json()) as { keyId: string; expiresAt: string };
    expect(renewed.keyId).toBe(body.keyId);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(before + TTL_MS - 2_000);
    // Same token, new expiry.
    expect(await (await me(bearer(body.token))).json()).toMatchObject({ expiresAt: renewed.expiresAt });

    // Another credential of the same user is not the parent.
    await expectCoded(await renew(bearer(apiToken(alice.userId).raw)), 403, "GATEWAY_FORBIDDEN");
    await expectCoded(await renew({ cookie: bob.cookie }), 403, "GATEWAY_FORBIDDEN");
    await expectCoded(await renew(bearer(body.token)), 401, "GATEWAY_AUTH_REQUIRED");

    sqlite.prepare("UPDATE gateway_token SET expires_at = unixepoch() - 1 WHERE id = ?").run(body.keyId);
    await expectCoded(await renew({ cookie: alice.cookie }), 401, "GATEWAY_TOKEN_EXPIRED");
    sqlite.prepare("UPDATE gateway_token SET expires_at = unixepoch() + 30, revoked_at = unixepoch() WHERE id = ?").run(body.keyId);
    await expectCoded(await renew({ cookie: alice.cookie }), 401, "GATEWAY_TOKEN_REVOKED");
  });

  it("isolates tenants at mint and at verification", async () => {
    const team = `team:${crypto.randomUUID()}`;
    sqlite.prepare("INSERT INTO tenant (id, owner_user_id, name, kind) VALUES (?, ?, 'Team', 'team')").run(team, bob.userId);
    sqlite.prepare("INSERT INTO tenant_member (tenant_id, user_id, role) VALUES (?, ?, 'owner')").run(team, bob.userId);

    // Alice cannot mint into Bob's team or Bob's personal tenant.
    await expectCoded(await mint({ cookie: alice.cookie }, { tenantId: team }), 403, "GATEWAY_FORBIDDEN");
    await expectCoded(await mint({ cookie: alice.cookie }, { tenantId: `personal:${bob.userId}` }), 403, "GATEWAY_FORBIDDEN");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM tenant_member WHERE user_id = ? AND tenant_id != ?").get(alice.userId, `personal:${alice.userId}`)).toEqual({ n: 0 });

    const teamToken = await minted({ cookie: bob.cookie }, { tenantId: team });
    expect(await (await me(bearer(teamToken.token))).json()).toMatchObject({ userId: bob.userId, tenantId: team });

    const port = createD1GatewayIdentityPort(d1);
    await expectRejects(port.verify(verifyRequest(teamToken.token), { tenantId: `personal:${bob.userId}` }), "GATEWAY_FORBIDDEN");
    await expect(port.verify(verifyRequest(teamToken.token), { tenantId: team })).resolves.toMatchObject({ tenantId: team });

    // Leaving the tenant ends the token's access to it.
    sqlite.prepare("DELETE FROM tenant_member WHERE tenant_id = ? AND user_id = ?").run(team, bob.userId);
    await expectCoded(await me(bearer(teamToken.token)), 403, "GATEWAY_FORBIDDEN");
  });

  it("enforces scopes and the model allowlist", async () => {
    const body = await minted({ cookie: alice.cookie }, { scopes: ["usage:read"], modelAllowlist: ["model-a"] });
    const port = createD1GatewayIdentityPort(d1);
    const verify = (requirements: GatewayTokenRequirements) => port.verify(verifyRequest(body.token), requirements);

    await expectRejects(verify({ scope: "models:invoke" }), "GATEWAY_FORBIDDEN");
    await expectRejects(verify({ model: "model-b" }), "GATEWAY_MODEL_NOT_ALLOWED");
    await expect(verify({ scope: "usage:read", model: "model-a" })).resolves.toMatchObject({
      scopes: ["usage:read"],
      modelAllowlist: ["model-a"],
    });

    const open = await minted({ cookie: alice.cookie });
    await expect(port.verify(verifyRequest(open.token), { scope: "models:invoke", model: "any-model" })).resolves.toMatchObject({
      scopes: ["models:invoke"],
    });
  });

  it("implements the gateway-core identity port", async () => {
    const port = createD1GatewayIdentityPort(d1);
    await expectRejects(port.authenticate(new Request("https://gateway.test/")), "GATEWAY_AUTH_REQUIRED");
    const body = await minted({ cookie: alice.cookie });
    const tenantBudget = `budget-${crypto.randomUUID()}`;
    const userBudget = `budget-${crypto.randomUUID()}`;
    const tenant = `personal:${alice.userId}`;
    sqlite.prepare("INSERT INTO gateway_budget (id, tenant_id, scope, scope_id) VALUES (?, ?, 'tenant', ?)").run(tenantBudget, tenant, tenant);
    sqlite.prepare("INSERT INTO gateway_budget (id, tenant_id, scope, scope_id) VALUES (?, ?, 'user', ?)").run(userBudget, tenant, alice.userId);
    sqlite.prepare("INSERT INTO gateway_budget (id, tenant_id, scope, scope_id) VALUES (?, ?, 'user', ?)").run(`budget-${crypto.randomUUID()}`, `personal:${bob.userId}`, bob.userId);

    const identity = await port.authenticate(verifyRequest(body.token));
    expect(identity).toMatchObject({ tenantId: tenant, userId: alice.userId, keyId: body.keyId, credentialScope: "official" });
    expect([...identity.budgetIds].sort()).toEqual([tenantBudget, userBudget].sort());
  });

  it("verifies tokens minted from a virtual key while the key is live", async () => {
    const tenant = `personal:${alice.userId}`;
    const keyId = `key-${crypto.randomUUID()}`;
    sqlite
      .prepare("INSERT INTO gateway_key (id, tenant_id, user_id, name, token_prefix, token_hash) VALUES (?, ?, ?, 'k', 'sk_gw_k', ?)")
      .run(keyId, tenant, alice.userId, sha256(keyId));
    const raw = `${TOKEN_PREFIX}${"a".repeat(24)}.${"b".repeat(64)}`;
    sqlite
      .prepare("INSERT INTO gateway_token (id, token_hash, key_id, tenant_id, user_id, scopes_json, expires_at) VALUES (?, ?, ?, ?, ?, '[\"models:invoke\"]', unixepoch() + 600)")
      .run(`gwt_${crypto.randomUUID()}`, sha256(raw), keyId, tenant, alice.userId);
    const keyBudget = `budget-${crypto.randomUUID()}`;
    sqlite.prepare("INSERT INTO gateway_budget (id, tenant_id, scope, scope_id) VALUES (?, ?, 'key', ?)").run(keyBudget, tenant, keyId);

    const port = createD1GatewayIdentityPort(d1);
    expect((await port.authenticate(verifyRequest(raw))).budgetIds).toContain(keyBudget);
    sqlite.prepare("UPDATE gateway_key SET revoked_at = unixepoch() WHERE id = ?").run(keyId);
    await expectRejects(port.authenticate(verifyRequest(raw)), "GATEWAY_TOKEN_REVOKED");
  });

  it("never echoes or logs the token in coded failures", async () => {
    captureLogs();
    const body = await minted({ cookie: alice.cookie });
    const secret = body.token.slice(TOKEN_PREFIX.length);
    const answers: string[] = [];
    const record = async (res: Response) => {
      answers.push(`${[...res.headers].join(" ")} ${await res.text()}`);
    };
    await record(await me(bearer(`${body.token}x`)));
    sqlite.prepare("UPDATE gateway_token SET expires_at = unixepoch() - 1 WHERE id = ?").run(body.keyId);
    await record(await me(bearer(body.token)));
    sqlite.prepare("UPDATE gateway_token SET revoked_at = unixepoch() WHERE id = ?").run(body.keyId);
    await record(await me(bearer(body.token)));
    await record(await mint(bearer(body.token)));
    await record(await app.request(`/api/v1/gateway/tokens/${body.keyId}/renew`, { method: "POST", headers: bearer(body.token) }, env));
    expect(answers).toHaveLength(5);
    for (const answer of [...answers, ...logged]) expect(answer).not.toContain(secret);
  });
});
