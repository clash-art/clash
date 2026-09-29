import test from "node:test";
import assert from "node:assert/strict";
import * as authModule from "./auth";

type LoginResult = { accessToken: string; authorizationUrl: string };
type AuthExports = {
  redactApiKeyForDisplay: (token: string) => string;
  createPkceChallenge?: (verifier: string) => string;
  resolveCliBrowserOrigin?: (
    serverUrl: string,
    env?: Record<string, string | undefined>,
  ) => string;
  runCliLogin?: (options: {
    serverUrl: string;
    browserOrigin: string;
    timeoutMs?: number;
    openBrowser: (url: string) => Promise<void>;
    fetchImpl: typeof fetch;
    loadConfig: () => Record<string, unknown>;
    saveConfig: (config: Record<string, unknown>) => void;
    log: (message: string) => void;
  }) => Promise<LoginResult>;
};

const auth = authModule as unknown as AuthExports;
const { redactApiKeyForDisplay } = auth;

test("auth status redacts saved API keys without exposing the full secret", () => {
  const token = "clsh_super_secret_middle_abcdef";
  const redacted = redactApiKeyForDisplay(token);

  assert.equal(redacted, "clsh_...cdef");
  assert.ok(!redacted.includes(token));
  assert.ok(!redacted.includes("super_secret_middle"));
});

test("auth status redacts short or non-standard tokens", () => {
  assert.equal(redactApiKeyForDisplay("secret"), "secr...");
  assert.equal(
    redactApiKeyForDisplay("sk-provider-secret-1234"),
    "sk-p...1234",
  );
  assert.equal(redactApiKeyForDisplay("   "), "[redacted]");
});

test("CLI PKCE uses the RFC 7636 S256 transformation", () => {
  assert.equal(typeof auth.createPkceChallenge, "function");
  if (!auth.createPkceChallenge) return;
  assert.equal(
    auth.createPkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("CLI keeps the browser authorization origin separate from the API origin", () => {
  assert.equal(typeof auth.resolveCliBrowserOrigin, "function");
  if (!auth.resolveCliBrowserOrigin) return;
  assert.equal(
    auth.resolveCliBrowserOrigin("https://api.clash.art", {}),
    "https://clash.art",
  );
  assert.equal(
    auth.resolveCliBrowserOrigin("http://127.0.0.1:8789", {
      CLASH_AUTH_URL: "http://127.0.0.1:3001/",
    }),
    "http://127.0.0.1:3001",
  );
});

test("CLI binds loopback before opening the browser, validates state, then exchanges code", async () => {
  assert.equal(typeof auth.runCliLogin, "function");
  if (!auth.runCliLogin) return;

  const saved: Array<Record<string, unknown>> = [];
  let tokenRequest: { url: string; body: URLSearchParams } | undefined;
  let authorizationUrl = "";
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    tokenRequest = { url, body: new URLSearchParams(String(init?.body ?? "")) };
    return new Response(
      JSON.stringify({
        access_token: "clsh_0123456789abcdef0123456789abcdef01234567",
        token_type: "Bearer",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await auth.runCliLogin({
    serverUrl: "https://api.clash.art",
    browserOrigin: "https://clash.art",
    timeoutMs: 5_000,
    fetchImpl,
    loadConfig: () => ({ serverUrl: "https://api.clash.art" }),
    saveConfig: (config) => saved.push(config),
    log: () => {},
    openBrowser: async (target) => {
      authorizationUrl = target;
      const authorization = new URL(target);
      assert.equal(authorization.origin, "https://clash.art");
      assert.equal(authorization.pathname, "/auth/cli");
      assert.equal(authorization.searchParams.get("response_type"), "code");
      assert.equal(authorization.searchParams.get("client_id"), "clash-cli");
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      assert.equal(authorization.searchParams.has("token"), false);

      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      assert.equal(callback.hostname, "127.0.0.1");
      assert.notEqual(callback.port, "");
      assert.equal(callback.pathname, "/callback");

      const rejectedTokenCallback = new URL(callback);
      rejectedTokenCallback.searchParams.set("token", "clsh_unsafe");
      rejectedTokenCallback.searchParams.set(
        "state",
        authorization.searchParams.get("state")!,
      );
      const oldBehavior = await fetch(rejectedTokenCallback);
      assert.equal(oldBehavior.status, 400);

      const wrongState = new URL(callback);
      wrongState.searchParams.set("code", "one_time_code");
      wrongState.searchParams.set("state", "attacker-state");
      const poisoned = await fetch(wrongState);
      assert.equal(poisoned.status, 400);

      const valid = new URL(callback);
      valid.searchParams.set("code", "one_time_code");
      valid.searchParams.set("state", authorization.searchParams.get("state")!);
      const accepted = await fetch(valid);
      assert.equal(accepted.status, 200);
    },
  });

  assert.equal(
    result.accessToken,
    "clsh_0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(result.authorizationUrl, authorizationUrl);
  assert.equal(
    tokenRequest?.url,
    "https://api.clash.art/api/v1/cli-auth/token",
  );
  assert.equal(tokenRequest?.body.get("grant_type"), "authorization_code");
  assert.equal(tokenRequest?.body.get("code"), "one_time_code");
  assert.equal(
    tokenRequest?.body.get("redirect_uri")?.startsWith("http://127.0.0.1:"),
    true,
  );
  assert.equal(
    auth.createPkceChallenge!(tokenRequest!.body.get("code_verifier")!),
    new URL(authorizationUrl).searchParams.get("code_challenge"),
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0].apiKey, result.accessToken);
});
