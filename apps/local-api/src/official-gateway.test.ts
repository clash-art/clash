import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudAccounts } from "./cloud-accounts.js";
import type { LocalAcpHarness, LocalAcpHarnessAuth } from "./local-acp.js";
import {
  OFFICIAL_GATEWAY_REFRESH_MARGIN_MS,
  OfficialGatewayError,
  createOfficialGateway,
  decideAgentCredential,
  type OfficialGatewayHarnessPort,
} from "./official-gateway.js";

const SERVICE = "https://clash.example.test";
const PARENT = "clsh_parent_credential";

/** The ACP gateway auth method as `probe.ts` publishes it (baseUrl + api-key fields). */
const gatewayAuth = (status: LocalAcpHarnessAuth["status"]): LocalAcpHarnessAuth => ({
  status,
  message: "",
  methods: [
    { id: "chatgpt", name: "ChatGPT", type: "agent" },
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
});

interface ServiceCall {
  method: string;
  path: string;
  authorization: string | null;
}

/** A Clash service speaking the #346 token lifecycle (`routes/v1/gateway-tokens.ts`). */
function fakeService(now: () => number) {
  const calls: ServiceCall[] = [];
  let minted = 0;
  const tokens: string[] = [];
  const behaviour = {
    mint: "ok" as "ok" | "offline" | "rejected",
    renew: "ok" as "ok" | "expired",
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname, authorization: headers.get("authorization") });
    if (url.origin !== SERVICE) throw new TypeError("unexpected origin");
    if (method === "POST" && url.pathname === "/api/v1/gateway/tokens") {
      if (behaviour.mint === "offline") throw new TypeError("fetch failed");
      if (behaviour.mint === "rejected")
        return Response.json(
          { error: { message: "A gateway credential is required.", type: "authentication_error", param: null, code: "GATEWAY_AUTH_REQUIRED" } },
          { status: 401, headers: { "x-clash-error-code": "GATEWAY_AUTH_REQUIRED" } },
        );
      minted += 1;
      const token = `sk_gw_${"a".repeat(40)}${minted}`;
      tokens.push(token);
      return Response.json(
        {
          token,
          tokenType: "Bearer",
          expiresAt: new Date(now() + 15 * 60_000).toISOString(),
          baseUrl: `${SERVICE}/gateway`,
          keyId: `gwt_${minted}`,
          tenantId: "personal:u1",
          scopes: ["models:invoke"],
          modelAllowlist: null,
        },
        { status: 201 },
      );
    }
    const renew = /^\/api\/v1\/gateway\/tokens\/([^/]+)\/renew$/.exec(url.pathname);
    if (method === "POST" && renew) {
      if (behaviour.renew === "expired")
        return Response.json(
          { error: { message: "The gateway token has expired; mint a new one.", type: "authentication_error", param: null, code: "GATEWAY_TOKEN_EXPIRED" } },
          { status: 401, headers: { "x-clash-error-code": "GATEWAY_TOKEN_EXPIRED" } },
        );
      return Response.json({ keyId: renew[1], expiresAt: new Date(now() + 15 * 60_000).toISOString() });
    }
    if (method === "DELETE" && url.pathname.startsWith("/api/v1/gateway/tokens/"))
      return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  });
  return { fetch, calls, tokens, behaviour };
}

function fakeHarnesses(auth: LocalAcpHarnessAuth = gatewayAuth("needs-auth")) {
  const harness: LocalAcpHarness = {
    id: "codex-acp",
    label: "Codex",
    binary: "codex-acp",
    enabled: true,
    available: true,
    auth,
  };
  const authenticateHarness = vi.fn<NonNullable<OfficialGatewayHarnessPort["authenticateHarness"]>>(
    async () => ({ harnesses: [harness] }),
  );
  const port: OfficialGatewayHarnessPort = {
    listHarnesses: async () => ({ harnesses: [harness] }),
    authenticateHarness,
  };
  return { port, authenticateHarness, harness };
}

async function filesUnder(dir: string): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    out.push((await readFile(join(entry.parentPath, entry.name))).toString("latin1"));
  }
  return out.join("\n");
}

describe("decideAgentCredential", () => {
  const base = {
    signedIn: true,
    gatewayMethodId: "custom-endpoint",
    handoff: null,
    now: 1_000_000,
  } as const;

  it("lets official-first replace a working BYOK credential when signed in", () => {
    expect(decideAgentCredential({ ...base, priority: "official-first", authStatus: "configured" })).toEqual({
      action: "handoff",
      methodId: "custom-endpoint",
    });
  });

  it("keeps a working BYOK credential under byok-first and hands off only when it is missing", () => {
    expect(decideAgentCredential({ ...base, priority: "byok-first", authStatus: "configured" })).toEqual({ action: "keep" });
    expect(decideAgentCredential({ ...base, priority: "byok-first", authStatus: "needs-auth" })).toEqual({
      action: "handoff",
      methodId: "custom-endpoint",
    });
  });

  it("requires sign-in instead of any fallback when official is the only way", () => {
    expect(
      decideAgentCredential({ ...base, signedIn: false, priority: "official-first", authStatus: "needs-auth" }),
    ).toEqual({ action: "auth-required" });
    expect(
      decideAgentCredential({ ...base, signedIn: false, priority: "official-first", authStatus: "configured" }),
    ).toEqual({ action: "keep" });
    expect(
      decideAgentCredential({
        ...base,
        signedIn: false,
        priority: "byok-first",
        authStatus: "configured",
        handoff: { expiresAt: base.now + 600_000 },
      }),
    ).toEqual({ action: "auth-required" });
  });

  it("refreshes a handoff close to expiry whatever the priority", () => {
    for (const priority of ["byok-first", "official-first"] as const) {
      expect(
        decideAgentCredential({
          ...base,
          priority,
          authStatus: "configured",
          handoff: { expiresAt: base.now + OFFICIAL_GATEWAY_REFRESH_MARGIN_MS },
        }),
      ).toEqual({ action: "refresh" });
      expect(
        decideAgentCredential({
          ...base,
          priority,
          authStatus: "configured",
          handoff: { expiresAt: base.now + OFFICIAL_GATEWAY_REFRESH_MARGIN_MS + 1 },
        }),
      ).toEqual({ action: "keep" });
    }
  });

  it("leaves a harness without a gateway auth method alone", () => {
    expect(
      decideAgentCredential({ ...base, gatewayMethodId: null, priority: "official-first", authStatus: "needs-auth" }),
    ).toEqual({ action: "keep" });
  });

  it("hands off through a #358 adapter method when ACP gateway auth is missing", () => {
    expect(
      decideAgentCredential({
        ...base,
        gatewayMethodId: null,
        adapterMethodId: "adapter:codex-config",
        priority: "official-first",
        authStatus: "needs-auth",
      }),
    ).toEqual({ action: "handoff", methodId: "adapter:codex-config" });
    expect(
      decideAgentCredential({
        ...base,
        gatewayMethodId: null,
        adapterMethodId: "adapter:dsh-env",
        priority: "byok-first",
        authStatus: "needs-auth",
      }),
    ).toEqual({ action: "handoff", methodId: "adapter:dsh-env" });
    expect(
      decideAgentCredential({
        ...base,
        gatewayMethodId: null,
        adapterMethodId: "adapter:dsh-env",
        priority: "byok-first",
        authStatus: "configured",
      }),
    ).toEqual({ action: "keep" });
  });
});

describe("createOfficialGateway", () => {
  let dataDir: string;
  let clock: number;
  const now = () => clock;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clash-official-gateway-"));
    clock = Date.parse("2026-10-26T10:00:00.000Z");
  });
  afterEach(async () => {
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

  it("mints with the signed-in credential, prefills the ACP gateway method and never persists the token", async () => {
    await signIn();
    const service = fakeService(now);
    const harnesses = fakeHarnesses();
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(harnesses.port);

    await gateway.handoff("codex-acp");

    expect(service.calls).toEqual([
      { method: "POST", path: "/api/v1/gateway/tokens", authorization: `Bearer ${PARENT}` },
    ]);
    const token = service.tokens[0]!;
    expect(harnesses.authenticateHarness).toHaveBeenCalledWith("codex-acp", {
      methodId: "custom-endpoint",
      values: { baseUrl: `${SERVICE}/gateway/v1`, "api-key": token, providerName: "clash" },
    });
    const status = await gateway.status();
    expect(status).toMatchObject({
      providerId: "clash-official",
      signedIn: true,
      token: { state: "active" },
      handoffs: [{ harnessId: "codex-acp", methodId: "custom-endpoint" }],
      lastError: null,
    });
    expect(JSON.stringify(status)).not.toContain(token);
    expect(await filesUnder(dataDir)).not.toContain(token);
    expect(await filesUnder(dataDir)).toContain("gwt_1");
  });

  it("refuses a method that is not a gateway method", async () => {
    await signIn();
    const service = fakeService(now);
    const harnesses = fakeHarnesses();
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(harnesses.port);

    await expect(gateway.handoff("codex-acp", "chatgpt")).rejects.toMatchObject({
      code: "GATEWAY_CAPABILITY_UNAVAILABLE",
    });
    expect(service.calls).toEqual([]);
  });

  it("fails signed out with GATEWAY_AUTH_REQUIRED and calls nothing", async () => {
    const service = fakeService(now);
    const harnesses = fakeHarnesses();
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(harnesses.port);

    const error = await gateway.handoff("codex-acp").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfficialGatewayError);
    expect(error).toMatchObject({ code: "GATEWAY_AUTH_REQUIRED", status: 401, reason: "signed_out" });
    expect(service.fetch).not.toHaveBeenCalled();
    expect(harnesses.authenticateHarness).not.toHaveBeenCalled();
    expect((await gateway.status()).lastError).toMatchObject({ code: "GATEWAY_AUTH_REQUIRED" });
  });

  it("fails offline with GATEWAY_AUTH_REQUIRED and no platform key fallback", async () => {
    await signIn();
    const service = fakeService(now);
    service.behaviour.mint = "offline";
    const harnesses = fakeHarnesses();
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(harnesses.port);

    await expect(gateway.handoff("codex-acp")).rejects.toMatchObject({
      code: "GATEWAY_AUTH_REQUIRED",
      reason: "offline",
    });
    expect(harnesses.authenticateHarness).not.toHaveBeenCalled();
  });

  it("maps a rejected cloud credential to GATEWAY_AUTH_REQUIRED", async () => {
    await signIn();
    const service = fakeService(now);
    service.behaviour.mint = "rejected";
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(fakeHarnesses().port);

    await expect(gateway.handoff("codex-acp")).rejects.toMatchObject({
      code: "GATEWAY_AUTH_REQUIRED",
      reason: "session_rejected",
    });
  });

  it("mints on sign-in and hands that token to the first handoff", async () => {
    await signIn();
    const service = fakeService(now);
    const harnesses = fakeHarnesses();
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(harnesses.port);

    await gateway.onSignedIn(SERVICE);
    expect(service.calls.map((call) => call.path)).toEqual(["/api/v1/gateway/tokens"]);
    expect((await gateway.status()).token.state).toBe("active");

    await gateway.handoff("codex-acp");
    expect(service.calls).toHaveLength(1);
    expect(harnesses.authenticateHarness.mock.calls[0]?.[1]?.values?.["api-key"]).toBe(service.tokens[0]);
  });

  it("re-mints and hands off again on a session 401", async () => {
    await signIn();
    const service = fakeService(now);
    const harnesses = fakeHarnesses();
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(harnesses.port);
    await gateway.handoff("codex-acp");
    expect(gateway.sessionHook.hasHandoff("codex-acp")).toBe(true);

    await expect(gateway.sessionHook.onUnauthorized("codex-acp")).resolves.toBeNull();

    expect(service.tokens).toHaveLength(2);
    expect(harnesses.authenticateHarness).toHaveBeenCalledTimes(2);
    expect(harnesses.authenticateHarness.mock.calls[1]?.[1]?.values?.["api-key"]).toBe(service.tokens[1]);
  });

  it("reports GATEWAY_AUTH_REQUIRED from a 401 after sign-out", async () => {
    await signIn();
    const service = fakeService(now);
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(fakeHarnesses().port);
    await gateway.handoff("codex-acp");
    await createCloudAccounts(dataDir).logout(SERVICE);

    await expect(gateway.sessionHook.onUnauthorized("codex-acp")).resolves.toBe("GATEWAY_AUTH_REQUIRED");
  });

  it("renews a handoff near expiry before a session, and re-mints when renewal says expired", async () => {
    await signIn();
    const service = fakeService(now);
    const harnesses = fakeHarnesses(gatewayAuth("configured"));
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(harnesses.port);
    await gateway.handoff("codex-acp");

    clock += 14 * 60_000;
    await expect(gateway.sessionHook.prepareSession(harnesses.harness)).resolves.toEqual({});
    expect(service.calls.at(-1)).toEqual({
      method: "POST",
      path: "/api/v1/gateway/tokens/gwt_1/renew",
      authorization: `Bearer ${PARENT}`,
    });
    expect(harnesses.authenticateHarness).toHaveBeenCalledTimes(1);

    clock += 14 * 60_000;
    service.behaviour.renew = "expired";
    await gateway.sessionHook.prepareSession(harnesses.harness);
    expect(service.tokens).toHaveLength(2);
    expect(harnesses.authenticateHarness).toHaveBeenCalledTimes(2);
    expect((await gateway.status()).handoffs[0]?.expiresAt).toBe(
      new Date(clock + 15 * 60_000).toISOString(),
    );
  });

  it("applies the user's priority at session start", async () => {
    await signIn();
    const service = fakeService(now);
    const harnesses = fakeHarnesses(gatewayAuth("configured"));
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(harnesses.port);

    expect((await gateway.status()).priority).toBe("byok-first");
    await gateway.sessionHook.prepareSession(harnesses.harness);
    expect(harnesses.authenticateHarness).not.toHaveBeenCalled();

    await gateway.setPriority("official-first");
    expect((await gateway.status()).priority).toBe("official-first");
    await gateway.sessionHook.prepareSession(harnesses.harness);
    expect(harnesses.authenticateHarness).toHaveBeenCalledTimes(1);
  });

  it("reports GATEWAY_AUTH_REQUIRED at session start when official-first has no sign-in and the agent has no key", async () => {
    const service = fakeService(now);
    const harnesses = fakeHarnesses(gatewayAuth("needs-auth"));
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(harnesses.port);
    await gateway.setPriority("official-first");

    await expect(gateway.sessionHook.prepareSession(harnesses.harness)).resolves.toEqual({
      gatewayCode: "GATEWAY_AUTH_REQUIRED",
    });
    expect(service.fetch).not.toHaveBeenCalled();
  });

  it("forgets a handoff when the user authenticates with their own credential", async () => {
    await signIn();
    const service = fakeService(now);
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(fakeHarnesses().port);
    await gateway.handoff("codex-acp");

    await gateway.forgetHandoff("codex-acp");

    expect(gateway.sessionHook.hasHandoff("codex-acp")).toBe(false);
    expect((await gateway.status()).handoffs).toEqual([]);
  });

  it("revokes every handed-off and pre-minted token on sign-out", async () => {
    await signIn();
    const service = fakeService(now);
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(fakeHarnesses().port);
    await gateway.handoff("codex-acp");
    await gateway.onSignedIn(SERVICE);

    await gateway.onSignedOut(SERVICE);

    const deletes = service.calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.path).sort()).toEqual([
      "/api/v1/gateway/tokens/gwt_1",
      "/api/v1/gateway/tokens/gwt_2",
    ]);
    expect(deletes.every((call) => call.authorization === `Bearer ${PARENT}`)).toBe(true);
    expect(await gateway.status()).toMatchObject({ handoffs: [], token: { state: "none" } });
  });

  it("revokes a token the agent refused and keeps its text out of the error", async () => {
    await signIn();
    const service = fakeService(now);
    const harnesses = fakeHarnesses();
    harnesses.authenticateHarness.mockImplementation(async (_id, options) => {
      throw new Error(`agent rejected key ${options?.values?.["api-key"]}`);
    });
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(harnesses.port);

    const error = (await gateway.handoff("codex-acp").catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(service.tokens[0]!);
    await vi.waitFor(() =>
      expect(service.calls.some((call) => call.method === "DELETE")).toBe(true),
    );
    expect((await gateway.status()).handoffs).toEqual([]);
  });

  it("hands Codex off through the Clash-owned config adapter when ACP gateway auth is missing", async () => {
    await signIn();
    const service = fakeService(now);
    const noGateway: LocalAcpHarnessAuth = {
      status: "needs-auth",
      message: "",
      methods: [{ id: "chatgpt", name: "ChatGPT", type: "agent" }],
    };
    const harnesses = fakeHarnesses(noGateway);
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses(harnesses.port);

    const prepared = await gateway.sessionHook.prepareSession({
      id: "codex-acp",
      auth: noGateway,
    });
    expect(prepared.handedOff).toBe(true);
    expect(prepared.spawnEnv?.CODEX_HOME).toContain("official-gateway/codex-home");
    expect(prepared.spawnEnv?.OPENAI_API_KEY).toBe(service.tokens[0]);
    expect(harnesses.authenticateHarness).not.toHaveBeenCalled();
    expect((await gateway.status()).handoffs).toEqual([
      expect.objectContaining({ harnessId: "codex-acp", methodId: "adapter:codex-config" }),
    ]);
    const toml = await readFile(join(prepared.spawnEnv!.CODEX_HOME!, "config.toml"), "utf8");
    expect(toml).toContain('base_url = "https://clash.example.test/gateway/v1"');
    expect(toml).not.toContain(service.tokens[0]!);
    expect(JSON.stringify(await gateway.status())).not.toContain(service.tokens[0]!);
  });

  it("hands dsh off with Flash-only env and never calls ACP authenticate", async () => {
    await signIn();
    const service = fakeService(now);
    const dshAuth: LocalAcpHarnessAuth = { status: "needs-auth", message: "", methods: [] };
    const harness: LocalAcpHarness = {
      id: "dsh-acp",
      label: "DeepSeek",
      binary: "dsh-acp",
      enabled: true,
      available: true,
      auth: dshAuth,
    };
    const authenticateHarness = vi.fn(async () => ({ harnesses: [harness] }));
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses({
      listHarnesses: async () => ({ harnesses: [harness] }),
      authenticateHarness,
    });
    await gateway.setPriority("official-first");

    const prepared = await gateway.sessionHook.prepareSession({ id: "dsh-acp", auth: dshAuth });
    expect(prepared).toMatchObject({
      handedOff: true,
      spawnEnv: {
        DEEPSEEK_API_KEY: service.tokens[0],
        DEEPSEEK_BASE_URL: `${SERVICE}/gateway/v1`,
        DSH_ACP_MODELS: "deepseek-flash",
        DSH_MODEL: "deepseek-flash",
      },
    });
    expect(authenticateHarness).not.toHaveBeenCalled();
    expect((await gateway.status()).handoffs[0]?.methodId).toBe("adapter:dsh-env");

    // keep returns the cached spawn overlay without reminting
    const kept = await gateway.sessionHook.prepareSession({ id: "dsh-acp", auth: dshAuth });
    expect(kept.handedOff).toBeUndefined();
    expect(kept.spawnEnv?.DEEPSEEK_API_KEY).toBe(service.tokens[0]);
    expect(service.tokens).toHaveLength(1);
  });

  it("scrubs Pi adapter credentials on sign-out", async () => {
    await signIn();
    const service = fakeService(now);
    const piAuth: LocalAcpHarnessAuth = { status: "needs-auth", message: "", methods: [] };
    const harness: LocalAcpHarness = {
      id: "pi-acp",
      label: "Pi",
      binary: "pi-acp",
      enabled: true,
      available: true,
      auth: piAuth,
    };
    const gateway = createOfficialGateway({ dataDir, fetch: service.fetch, now });
    gateway.attachHarnesses({
      listHarnesses: async () => ({ harnesses: [harness] }),
      authenticateHarness: async () => ({ harnesses: [harness] }),
    });
    await gateway.setPriority("official-first");
    const prepared = await gateway.sessionHook.prepareSession({ id: "pi-acp", auth: piAuth });
    const modelsPath = join(prepared.spawnEnv!.PI_CODING_AGENT_DIR!, "models.json");
    expect(await readFile(modelsPath, "utf8")).toContain(service.tokens[0]!);
    await gateway.onSignedOut(SERVICE);
    expect(await readFile(modelsPath, "utf8")).not.toContain(service.tokens[0]!);
    expect(gateway.sessionHook.hasHandoff("pi-acp")).toBe(false);
  });
});
