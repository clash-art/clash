import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAcpAdapter } from "./app.js";
import { createCloudAccounts } from "./cloud-accounts.js";
import { createCloudLogin } from "./cloud-login.js";
import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";
import type { LocalAcpHarness } from "./local-acp.js";
import { createOfficialGateway } from "./official-gateway.js";

const SERVICE = "https://clash.example.test";
const PARENT = "clsh_parent_credential";

/** The #346 token lifecycle as `routes/v1/gateway-tokens.ts` serves it. */
function fakeService() {
  const calls: Array<{ method: string; path: string }> = [];
  const tokens: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    if (method === "POST" && url.pathname === "/api/v1/gateway/tokens") {
      const token = `sk_gw_${"b".repeat(40)}${tokens.length + 1}`;
      tokens.push(token);
      return Response.json(
        {
          token,
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          baseUrl: `${SERVICE}/gateway`,
          keyId: `gwt_${tokens.length}`,
          tenantId: "personal:u1",
          scopes: ["models:invoke"],
          modelAllowlist: null,
        },
        { status: 201 },
      );
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  });
  return { fetch, calls, tokens };
}

const harness: LocalAcpHarness = {
  id: "codex-acp",
  label: "Codex",
  binary: "codex-acp",
  enabled: true,
  available: true,
  auth: {
    status: "needs-auth",
    message: "",
    methods: [
      {
        id: "custom-endpoint",
        name: "Custom endpoint",
        type: "agent",
        form: "fields",
        vars: [
          { name: "baseUrl", label: "Base URL" },
          { name: "api-key", label: "API key", secret: true },
          { name: "providerName", label: "Provider", optional: true },
        ],
      },
    ],
  },
};

describe("Host official gateway routes", () => {
  let dataDir: string;
  const apps = managedLocalApiApps();

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-official-gateway-routes-"));
  });
  afterEach(async () => {
    await apps.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function signIn() {
    const accounts = createCloudAccounts(dataDir);
    await accounts.select(SERVICE);
    await accounts.save(SERVICE, {
      token: PARENT,
      user: { id: "u1", email: "u1@example.test", name: "User One" },
    });
  }

  function setup(localAcpOverrides: Partial<LocalAcpAdapter> = {}) {
    const service = fakeService();
    const authenticateHarness = vi.fn(
      async (_id: string, _options?: { methodId?: string; values?: Record<string, string> }) => ({
        harnesses: [harness],
      }),
    );
    const localAcp: LocalAcpAdapter = {
      async listRuntimes() {
        return { runtimes: [] };
      },
      async createSession() {
        return { session_id: "session-1" };
      },
      async listResumeSessions() {
        return { sessions: [] };
      },
      async listHarnesses() {
        return { harnesses: [harness] };
      },
      authenticateHarness,
      ...localAcpOverrides,
    };
    const app = apps.createApp({
      dataDir,
      userId: "local-user",
      localAcp,
      officialGateway: createOfficialGateway({ dataDir, fetch: service.fetch }),
      cloudLogin: createCloudLogin({ dataDir, fetch: service.fetch }),
    });
    return { app, service, authenticateHarness };
  }

  it("shows the official provider signed out with the default BYOK-first priority", async () => {
    const { app } = setup();
    const response = await app.request("/api/v1/local/official-gateway");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      providerId: "clash-official",
      signedIn: false,
      user: null,
      priority: "byok-first",
      token: { state: "none", expiresAt: null },
      handoffs: [],
    });
  });

  it("stores the user's credential priority and audits the change", async () => {
    const { app } = setup();
    const response = await app.request("/api/v1/local/official-gateway", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: "official-first" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      priority: "official-first",
      mutation: { operation: "official_gateway_update", accepted: true },
    });
    const reread = await app.request("/api/v1/local/official-gateway");
    expect(await reread.json()).toMatchObject({ priority: "official-first" });
    const audit = await app.request(
      "/api/v1/mutation-audit?operation=official_gateway_update&entityId=official-gateway",
    );
    expect(((await audit.json()) as { records: unknown[] }).records).toHaveLength(1);
  });

  it("rejects an unknown priority with a coded error", async () => {
    const { app } = setup();
    const response = await app.request("/api/v1/local/official-gateway", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: "platform-key" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "GATEWAY_INVALID_REQUEST" });
  });

  it("answers an official handoff while signed out with GATEWAY_AUTH_REQUIRED and no fallback", async () => {
    const { app, service, authenticateHarness } = setup();
    const response = await app.request("/api/v1/local/harnesses/codex-acp/authenticate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_source: "clash-official" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "GATEWAY_AUTH_REQUIRED",
      reason: "signed_out",
      mutation: { accepted: false },
    });
    expect(authenticateHarness).not.toHaveBeenCalled();
    expect(service.fetch).not.toHaveBeenCalled();
  });

  it("mints and fills the agent's gateway method without returning the token", async () => {
    await signIn();
    const { app, service, authenticateHarness } = setup();
    const response = await app.request("/api/v1/local/harnesses/codex-acp/authenticate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_source: "clash-official" }),
    });
    expect(response.status).toBe(200);
    const token = service.tokens[0]!;
    expect(authenticateHarness).toHaveBeenCalledWith("codex-acp", {
      methodId: "custom-endpoint",
      values: { baseUrl: `${SERVICE}/gateway/v1`, "api-key": token, providerName: "clash" },
    });
    expect(await response.text()).not.toContain(token);
    const status = await app.request("/api/v1/local/official-gateway");
    const statusText = await status.text();
    expect(statusText).not.toContain(token);
    expect(JSON.parse(statusText)).toMatchObject({
      signedIn: true,
      token: { state: "active" },
      handoffs: [{ harnessId: "codex-acp", methodId: "custom-endpoint" }],
    });
  });

  it("drops the official handoff when the user authenticates with their own key", async () => {
    await signIn();
    const { app } = setup();
    await app.request("/api/v1/local/harnesses/codex-acp/authenticate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_source: "clash-official" }),
    });
    const own = await app.request("/api/v1/local/harnesses/codex-acp/authenticate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method_id: "custom-endpoint",
        values: { baseUrl: "https://api.example.test/v1", "api-key": "sk-own" },
      }),
    });
    expect(own.status).toBe(200);
    const status = await app.request("/api/v1/local/official-gateway");
    expect(await status.json()).toMatchObject({ handoffs: [] });
  });

  it("revokes handed-off tokens before signing out", async () => {
    await signIn();
    const { app, service } = setup();
    await app.request("/api/v1/local/harnesses/codex-acp/authenticate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential_source: "clash-official" }),
    });
    const logout = await app.request("/api/v1/local/cloud/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceUrl: SERVICE }),
    });
    expect(logout.status).toBe(200);
    expect(service.calls).toContainEqual({
      method: "DELETE",
      path: "/api/v1/gateway/tokens/gwt_1",
    });
    const status = await app.request("/api/v1/local/official-gateway");
    expect(await status.json()).toMatchObject({ signedIn: false, handoffs: [] });
  });

  it("puts the gateway code on a failed session start", async () => {
    const { app } = setup({
      async createSession() {
        throw new Error(
          "GATEWAY_AUTH_REQUIRED: Sign in to your Clash account to use the Clash official provider.",
        );
      },
    });
    const response = await app.request("/api/v1/runtimes/desktop-local/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "codex-acp" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "GATEWAY_AUTH_REQUIRED" });
  });
});
