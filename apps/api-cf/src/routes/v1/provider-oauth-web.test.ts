/**
 * Hosted Provider OAuth by web redirect, against real SQL: every web/drizzle
 * migration on node:sqlite, the real ACTION_SECRET_KEY envelope, and a fake
 * vendor token endpoint standing in for the network.
 */
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("../../containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));

import { pkceChallenge } from "@clash/shared-runtime/provider-oauth-flow";
import { createSqliteD1 } from "../../../../web/app/test-support/sqlite-d1";
import { createApp } from "../../app";
import type { Env } from "../../config";
import { modelProviderRoutes } from "./model-providers";

const ORIGIN = "https://clash.test";
const CALLBACK = `${ORIGIN}/api/v1/provider-oauth/callback`;
const CLIENT_SECRET = "hosted-client-secret-value";

const ACME = {
  id: "acme",
  label: "Acme Media",
  flow: {
    open: "https://auth.acme.test/authorize",
    tokenUrl: "https://auth.acme.test/token",
    clientId: "clash-hosted",
    clientSecret: CLIENT_SECRET,
    params: { scope: "media" },
    callback: { type: "loopback" },
  },
};

type VendorCall = { url: string; form: URLSearchParams };

function vendor(response: () => Response) {
  const calls: VendorCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), form: new URLSearchParams(String(init.body)) });
    return response();
  });
  return calls;
}

function grant() {
  return new Response(
    JSON.stringify({ access_token: "vendor-access-token", refresh_token: "vendor-refresh-token", expires_in: 3600 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function harness(overrides: Partial<Env> = {}) {
  const { d1, sqlite } = createSqliteD1();
  const env = {
    DB: d1,
    ACTION_SECRET_KEY: "test-action-secret-key",
    WORKER_PUBLIC_URL: ORIGIN,
    PROVIDER_OAUTH_PROVIDERS: JSON.stringify([ACME]),
    ...overrides,
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/v1", modelProviderRoutes);

  const start = async (userId: string, providerId = "acme", body: Record<string, unknown> = {}) =>
    app.request(`/api/v1/provider-oauth/${providerId}/start`, {
      method: "POST",
      headers: { "x-user-id": userId, "content-type": "application/json" },
      body: JSON.stringify(body),
    }, env);
  const callback = async (userId: string | undefined, query: Record<string, string>) => {
    const response = await app.request(
      `/api/v1/provider-oauth/callback?${new URLSearchParams(query)}`,
      { headers: userId ? { "x-user-id": userId } : {} },
      env,
    );
    const location = response.headers.get("location") ?? "";
    return { response, location, url: new URL(location || ORIGIN) };
  };
  const list = async (userId: string) => {
    const response = await app.request("/api/v1/provider-oauth", { headers: { "x-user-id": userId } }, env);
    return (await response.json()) as { providers: Record<string, unknown>[] };
  };
  const row = (userId: string) =>
    sqlite.prepare("SELECT * FROM provider_oauth WHERE user_id = ?").get(userId) as Record<string, unknown>;
  return { app, env, sqlite, start, callback, list, row };
}

async function startedState(h: ReturnType<typeof harness>, userId: string, body: Record<string, unknown> = {}) {
  const response = await h.start(userId, "acme", body);
  expect(response.status).toBe(200);
  const started = (await response.json()) as Record<string, string>;
  const authorize = new URL(started.verificationUri);
  return { started, authorize, state: authorize.searchParams.get("state")! };
}

function expectErrorRedirect(
  result: { response: Response; url: URL },
  code: string,
  providerId?: string,
) {
  expect(result.response.status).toBe(302);
  expect(result.url.origin).toBe(ORIGIN);
  expect(result.url.pathname).toBe("/settings");
  expect(result.url.searchParams.get("section")).toBe("providers");
  expect(result.url.searchParams.get("status")).toBe("error");
  expect(result.url.searchParams.get("code")).toBe(code);
  if (providerId) expect(result.url.searchParams.get("providerOAuth")).toBe(providerId);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("POST /provider-oauth/:id/start (web redirect)", () => {
  it("answers a pending web flow whose authorization URL carries host-owned PKCE, state and redirect", async () => {
    const h = harness();
    const before = Date.now();
    const { started, authorize, state } = await startedState(h, "user-a", { accountId: "acct-1" });

    expect(started).toMatchObject({
      providerId: "acme",
      accountId: "acct-1",
      status: "pending",
      flow: "browser",
      callbackType: "web",
      hasAccessToken: false,
    });
    const expiresAt = Date.parse(started.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 10 * 60_000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 1000);

    expect(`${authorize.origin}${authorize.pathname}`).toBe(ACME.flow.open);
    expect(authorize.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(authorize.searchParams.get("client_id")).toBe("clash-hosted");
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toBe("media");
    expect(authorize.searchParams.has("client_secret")).toBe(false);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    // Verifier and state exist only inside the envelope.
    const stored = h.row("user-a");
    expect(stored.status).toBe("pending");
    expect(stored.callback_type).toBe("web");
    expect(typeof stored.encrypted_flow_secret).toBe("string");
    expect(JSON.stringify(stored)).not.toContain(state);
  });

  it("answers 404 for a provider this deployment does not offer", async () => {
    const h = harness();
    const response = await h.start("user-a", "unknown-provider");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "Unsupported OAuth provider",
      code: "PROVIDER_OAUTH_UNSUPPORTED",
    });
  });

  it("answers 404 when PROVIDER_OAUTH_PROVIDERS is unset", async () => {
    const h = harness({ PROVIDER_OAUTH_PROVIDERS: undefined });
    const response = await h.start("user-a");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_OAUTH_UNSUPPORTED" });
    expect(h.row("user-a")).toBeUndefined();
  });

  it("rejects an invalid entry at use time with a clear message that never echoes the secret", async () => {
    const h = harness({
      PROVIDER_OAUTH_PROVIDERS: JSON.stringify([
        { ...ACME, flow: { ...ACME.flow, tokenUrl: "http://auth.acme.test/token" } },
      ]),
    });
    const response = await h.start("user-a");
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("PROVIDER_OAUTH_NOT_CONFIGURED");
    expect(body.error).toMatch(/acme: flow\.tokenUrl: A token endpoint must be https/);
    expect(body.error).not.toContain(CLIENT_SECRET);
  });

  it("rejects an entry without the client a hosted exchange needs", async () => {
    const { clientId: _clientId, ...flow } = ACME.flow;
    const h = harness({ PROVIDER_OAUTH_PROVIDERS: JSON.stringify([{ ...ACME, flow }]) });
    const response = await h.start("user-a");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "PROVIDER_OAUTH_NOT_CONFIGURED",
      error: "acme: a hosted flow must declare tokenUrl and clientId.",
    });
  });

  it("rejects malformed JSON in the secret", async () => {
    const h = harness({ PROVIDER_OAUTH_PROVIDERS: "[{" });
    const response = await h.start("user-a");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "PROVIDER_OAUTH_NOT_CONFIGURED",
      error: "PROVIDER_OAUTH_PROVIDERS is not valid JSON.",
    });
  });

  it("refuses to start without the envelope key rather than store a clear verifier", async () => {
    const h = harness({ ACTION_SECRET_KEY: undefined });
    const response = await h.start("user-a");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_OAUTH_NOT_CONFIGURED" });
    expect(h.row("user-a")).toBeUndefined();
  });
});

describe("GET /provider-oauth/callback", () => {
  beforeAll(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges the code with the verifier, stores tokens encrypted and marks the row authorized", async () => {
    const h = harness();
    const { authorize, state } = await startedState(h, "user-a", { accountId: "acct-1" });
    const calls = vendor(grant);

    const result = await h.callback("user-a", { code: "vendor-code", state });
    expect(result.response.status).toBe(302);
    expect(result.location).toBe(
      `${ORIGIN}/settings?section=providers&providerOAuth=acme&status=authorized`,
    );
    expect(result.location).not.toContain("vendor-code");
    expect(result.location).not.toContain("vendor-access-token");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ACME.flow.tokenUrl);
    expect(calls[0]!.form.get("grant_type")).toBe("authorization_code");
    expect(calls[0]!.form.get("code")).toBe("vendor-code");
    expect(calls[0]!.form.get("redirect_uri")).toBe(CALLBACK);
    expect(calls[0]!.form.get("client_id")).toBe("clash-hosted");
    expect(calls[0]!.form.get("client_secret")).toBe(CLIENT_SECRET);
    // The verifier sent is the one the authorization URL committed to.
    await expect(pkceChallenge(calls[0]!.form.get("code_verifier")!)).resolves.toBe(
      authorize.searchParams.get("code_challenge"),
    );

    const stored = h.row("user-a");
    expect(stored).toMatchObject({
      status: "authorized",
      has_tokens: 1,
      encrypted_flow_secret: null,
      error: null,
      error_code: null,
    });
    expect(typeof stored.encrypted_tokens).toBe("string");
    expect(String(stored.encrypted_tokens)).not.toContain("vendor-access-token");

    const { providers } = await h.list("user-a");
    expect(providers).toEqual([
      expect.objectContaining({
        providerId: "acme",
        accountId: "acct-1",
        status: "authorized",
        hasAccessToken: true,
      }),
    ]);
    expect(providers[0]).not.toHaveProperty("verificationUri");

    const accounts = await h.app.request("/api/v1/model-providers", { headers: { "x-user-id": "user-a" } }, h.env);
    const { providers: accountRows } = (await accounts.json()) as { providers: Record<string, unknown>[] };
    expect(accountRows).toContainEqual(expect.objectContaining({ id: "acct-1", availableOAuth: ["acme"] }));
  });

  it("refuses a reused state without a second exchange", async () => {
    const h = harness();
    const { state } = await startedState(h, "user-a");
    const calls = vendor(grant);
    await h.callback("user-a", { code: "vendor-code", state });

    const replay = await h.callback("user-a", { code: "vendor-code", state });
    expectErrorRedirect(replay, "PROVIDER_OAUTH_STATE_INVALID");
    expect(calls).toHaveLength(1);
    expect(h.row("user-a").status).toBe("authorized");
  });

  it("refuses a state that matches no pending flow", async () => {
    const h = harness();
    const { state } = await startedState(h, "user-a");
    const calls = vendor(grant);

    const forged = await h.callback("user-a", { code: "vendor-code", state: `${state.slice(0, -2)}xx` });
    expectErrorRedirect(forged, "PROVIDER_OAUTH_STATE_INVALID");
    const missing = await h.callback("user-a", { code: "vendor-code" });
    expectErrorRedirect(missing, "PROVIDER_OAUTH_STATE_INVALID");
    expect(calls).toHaveLength(0);
    expect(h.row("user-a").status).toBe("pending");
  });

  it("refuses another user's state and leaves that user's flow usable", async () => {
    const h = harness();
    const { state } = await startedState(h, "user-a");
    const calls = vendor(grant);

    const stolen = await h.callback("user-b", { code: "attacker-code", state });
    expectErrorRedirect(stolen, "PROVIDER_OAUTH_STATE_INVALID");
    expect(calls).toHaveLength(0);

    const owner = await h.callback("user-a", { code: "vendor-code", state });
    expect(owner.url.searchParams.get("status")).toBe("authorized");
  });

  it("expires a pending flow after 10 minutes, to readers and to the callback", async () => {
    const h = harness();
    const { state } = await startedState(h, "user-a");
    const calls = vendor(grant);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1000);

    const { providers } = await h.list("user-a");
    expect(providers[0]).toMatchObject({
      status: "expired",
      errorCode: "PROVIDER_OAUTH_STATE_EXPIRED",
      hasAccessToken: false,
    });
    expect(providers[0]!.error).toEqual(expect.any(String));

    const late = await h.callback("user-a", { code: "vendor-code", state });
    expectErrorRedirect(late, "PROVIDER_OAUTH_STATE_EXPIRED", "acme");
    expect(calls).toHaveLength(0);
    expect(h.row("user-a")).toMatchObject({
      status: "expired",
      error_code: "PROVIDER_OAUTH_STATE_EXPIRED",
      encrypted_flow_secret: null,
    });
  });

  it("records a vendor access_denied as PROVIDER_OAUTH_DENIED and consumes the state", async () => {
    const h = harness();
    const { state } = await startedState(h, "user-a");
    const calls = vendor(grant);

    const denied = await h.callback("user-a", { error: "access_denied", state });
    expectErrorRedirect(denied, "PROVIDER_OAUTH_DENIED", "acme");
    expect(calls).toHaveLength(0);
    const { providers } = await h.list("user-a");
    expect(providers[0]).toMatchObject({
      status: "error",
      errorCode: "PROVIDER_OAUTH_DENIED",
      hasAccessToken: false,
    });

    const replay = await h.callback("user-a", { code: "vendor-code", state });
    expectErrorRedirect(replay, "PROVIDER_OAUTH_STATE_INVALID");
  });

  it("records another vendor error as PROVIDER_OAUTH_VENDOR_ERROR without echoing free text", async () => {
    const h = harness();
    const { state } = await startedState(h, "user-a");
    const result = await h.callback("user-a", { error: "<script>alert(1)</script>", state });
    expectErrorRedirect(result, "PROVIDER_OAUTH_VENDOR_ERROR", "acme");
    expect(String(h.row("user-a").error)).not.toContain("<script>");
  });

  it("records a rejected exchange as PROVIDER_OAUTH_EXCHANGE_FAILED with no tokens stored", async () => {
    const h = harness();
    const { state } = await startedState(h, "user-a");
    const calls = vendor(() =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Bad code" }), { status: 400 }),
    );

    const failed = await h.callback("user-a", { code: "vendor-code", state });
    expectErrorRedirect(failed, "PROVIDER_OAUTH_EXCHANGE_FAILED", "acme");
    expect(calls).toHaveLength(1);
    expect(h.row("user-a")).toMatchObject({
      status: "error",
      error_code: "PROVIDER_OAUTH_EXCHANGE_FAILED",
      has_tokens: 0,
      encrypted_tokens: null,
      encrypted_flow_secret: null,
    });
    const { providers } = await h.list("user-a");
    expect(providers[0]).toMatchObject({ status: "error", errorCode: "PROVIDER_OAUTH_EXCHANGE_FAILED" });
    expect(String(providers[0]!.error)).toContain("invalid_grant");
  });

  it("redirects an unauthenticated callback with PROVIDER_OAUTH_UNAUTHENTICATED and exchanges nothing", async () => {
    const h = harness();
    const { state } = await startedState(h, "user-a");
    const calls = vendor(grant);
    const anonymous = await h.callback(undefined, { code: "vendor-code", state });
    expectErrorRedirect(anonymous, "PROVIDER_OAUTH_UNAUTHENTICATED");
    expect(calls).toHaveLength(0);
    expect(h.row("user-a").status).toBe("pending");
  });
});

describe("POST /provider-oauth/:id/complete", () => {
  it("answers 409 for a web flow: the redirect callback completes it", async () => {
    const h = harness();
    await startedState(h, "user-a", { accountId: "acct-1" });
    const response = await h.app.request("/api/v1/provider-oauth/acme/complete", {
      method: "POST",
      headers: { "x-user-id": "user-a", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct-1" }),
    }, h.env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_OAUTH_WEB_CALLBACK" });
  });

  it.each(["complete", "import-local"])(
    "keeps 501 for %s flows that need the user's machine",
    async (route) => {
      const h = harness();
      const response = await h.app.request(`/api/v1/provider-oauth/acme/${route}`, {
        method: "POST",
        headers: { "x-user-id": "user-a", "content-type": "application/json" },
        body: "{}",
      }, h.env);
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ code: "PROVIDER_OAUTH_REQUIRES_DESKTOP" });
    },
  );
});

describe("callback through the full api-cf app", () => {
  // The gateway forwards the callback without the fail-closed header; the
  // /api/* middleware must still turn the session cookie into x-user-id.
  const { d1 } = createSqliteD1();
  const env = {
    DB: d1,
    ENVIRONMENT: "test",
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: "test-secret-for-provider-oauth-0123456789",
    ACTION_SECRET_KEY: "test-action-secret-key",
    WORKER_PUBLIC_URL: ORIGIN,
    PROVIDER_OAUTH_PROVIDERS: JSON.stringify([ACME]),
  } as never;
  const app = createApp();
  let cookie = "";

  beforeAll(async () => {
    const res = await app.request("/api/better-auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: "oauth@example.com", password: "oauth-password-123", name: "OAuth" }),
    }, env);
    expect(res.status).toBe(200);
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  });

  it("authorizes with the session cookie and redirects without one", async () => {
    const started = await app.request(`${ORIGIN}/api/v1/provider-oauth/acme/start`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json", "x-clash-require-identity": "1" },
      body: "{}",
    }, env);
    expect(started.status).toBe(200);
    const state = new URL(((await started.json()) as { verificationUri: string }).verificationUri)
      .searchParams.get("state")!;
    vendor(grant);

    const anonymous = await app.request(
      `${ORIGIN}/api/v1/provider-oauth/callback?code=c&state=${state}`,
      { headers: { "x-user-id": "forged-user" } },
      env,
    );
    expect(anonymous.status).toBe(302);
    expect(new URL(anonymous.headers.get("location")!).searchParams.get("code"))
      .toBe("PROVIDER_OAUTH_UNAUTHENTICATED");

    const signedIn = await app.request(
      `${ORIGIN}/api/v1/provider-oauth/callback?code=c&state=${state}`,
      { headers: { cookie } },
      env,
    );
    expect(signedIn.status).toBe(302);
    expect(new URL(signedIn.headers.get("location")!).searchParams.get("status")).toBe("authorized");
  });
});

describe("no ambiguous outcomes (review)", () => {
  it("refuses a start body that is not a JSON object instead of ignoring it", async () => {
    const h = harness();
    for (const body of ["{not json", "[1]"]) {
      const response = await h.app.request("/api/v1/provider-oauth/acme/start", {
        method: "POST",
        headers: { "x-user-id": "user-a", "content-type": "application/json" },
        body,
      }, h.env);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "PROVIDER_OAUTH_BAD_REQUEST" });
    }
    expect(h.row("user-a")).toBeUndefined();
  });

  it("redirects a storage failure during the callback with PROVIDER_OAUTH_SERVER_ERROR, never a raw 500", async () => {
    const h = harness();
    const { state } = await startedState(h, "user-a");
    const calls = vendor(grant);
    (h.env as unknown as { DB: unknown }).DB = {
      prepare() {
        throw new Error("D1 unavailable");
      },
    };

    const result = await h.callback("user-a", { code: "vendor-code", state });
    expectErrorRedirect(result, "PROVIDER_OAUTH_SERVER_ERROR");
    expect(calls).toHaveLength(0);
  });

  it("lists no plugin Provider declarations: hosted builds bundle none", async () => {
    const h = harness();
    const response = await h.app.request("/api/v1/plugin-providers", { headers: { "x-user-id": "user-a" } }, h.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: [] });
  });
});
