import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as authModule from "./auth";
import { configFilePath, credentialsFilePath, loadConfig } from "../lib/config";

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

test("CLI login saves the credential on a fresh CLASH_HOME", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  process.env.CLASH_HOME = join(
    await mkdtemp(join(tmpdir(), "clash-cli-auth-")),
    "fresh",
  );
  const accessToken = "clsh_0123456789abcdef0123456789abcdef01234567";
  try {
    const result = await authModule.runCliLogin({
      serverUrl: "https://api.clash.art",
      browserOrigin: "https://clash.art",
      timeoutMs: 5_000,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ access_token: accessToken, token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      log: () => {},
      openBrowser: async (target) => {
        const authorization = new URL(target);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "one_time_code");
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        assert.equal((await fetch(callback)).status, 200);
      },
    });

    assert.equal(result.accessToken, accessToken);
    assert.deepEqual(loadConfig(), { apiKey: accessToken });
  } finally {
    if (originalClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalClashHome;
  }
});

const MINTED_TOKEN = "clsh_0123456789abcdef0123456789abcdef01234567";
const PREVIOUS_TOKEN = "clsh_ffffffffffffffffffffffffffffffffffffffff";

async function completeAuthorization(target: string): Promise<void> {
  const authorization = new URL(target);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "one_time_code");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  assert.equal((await fetch(callback)).status, 200);
}

/** The mint succeeds; `revoke` decides how the server answers DELETE. */
function fakeTokenServer(revoke: (init: RequestInit) => Promise<Response>) {
  const revocations: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    if (init.method === "DELETE") {
      revocations.push({ url: String(input), init });
      return revoke(init);
    }
    return new Response(
      JSON.stringify({ access_token: MINTED_TOKEN, token_type: "Bearer" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, revocations };
}

/** Runs against a real CLASH_HOME whose config.yaml cannot be updated. */
async function loginWithUnsavableConfig(
  fetchImpl: typeof fetch,
  revokeTimeoutMs?: number,
): Promise<authModule.CliLoginSaveError> {
  const originalClashHome = process.env.CLASH_HOME;
  process.env.CLASH_HOME = await mkdtemp(join(tmpdir(), "clash-cli-auth-"));
  try {
    await writeFile(configFilePath(), "server: [unterminated\n", "utf8");
    await writeFile(
      credentialsFilePath(),
      JSON.stringify({ cliApiKey: PREVIOUS_TOKEN }),
      "utf8",
    );
    let failure: unknown;
    await authModule
      .runCliLogin({
        serverUrl: "https://api.clash.art",
        browserOrigin: "https://clash.art",
        timeoutMs: 5_000,
        ...(revokeTimeoutMs === undefined ? {} : { revokeTimeoutMs }),
        fetchImpl,
        log: () => {},
        openBrowser: completeAuthorization,
      })
      .catch((error: unknown) => {
        failure = error;
      });
    assert.ok(failure instanceof authModule.CliLoginSaveError);
    assert.equal(failure.code, "AUTH_CREDENTIAL_SAVE_FAILED");
    assert.match(failure.message, /Cannot update config\.yaml/);
    assert.ok(!failure.message.includes(MINTED_TOKEN));
    // The failed login leaves the previous credential and the user's file alone.
    assert.equal(loadConfig().apiKey, PREVIOUS_TOKEN);
    assert.equal(
      await readFile(configFilePath(), "utf8"),
      "server: [unterminated\n",
    );
    return failure;
  } finally {
    if (originalClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalClashHome;
  }
}

test("CLI login revokes the minted token when saving the credential fails", async () => {
  const server = fakeTokenServer(
    async () => new Response(null, { status: 204 }),
  );

  const failure = await loginWithUnsavableConfig(server.fetchImpl);

  assert.equal(failure.tokenRevoked, true);
  assert.match(failure.message, /was revoked/);
  assert.equal(server.revocations.length, 1);
  assert.equal(
    server.revocations[0].url,
    "https://api.clash.art/api/v1/cli-auth/token",
  );
  assert.equal(
    new Headers(server.revocations[0].init.headers).get("authorization"),
    `Bearer ${MINTED_TOKEN}`,
  );
});

test("CLI login still reports the save failure when the server refuses to revoke", async () => {
  const server = fakeTokenServer(
    async () => new Response(null, { status: 500 }),
  );

  const failure = await loginWithUnsavableConfig(server.fetchImpl);

  assert.equal(failure.tokenRevoked, false);
  assert.match(failure.message, /stays valid/);
  assert.match(failure.message, /clsh_01234567\.\.\./);
});

test("CLI login still reports the save failure when revocation cannot reach the server", async () => {
  const server = fakeTokenServer(async () => {
    throw new TypeError("fetch failed");
  });

  const failure = await loginWithUnsavableConfig(server.fetchImpl);

  assert.equal(failure.tokenRevoked, false);
  assert.match(failure.message, /stays valid/);
});

test("CLI login does not wait forever for a server that never answers the revocation", async () => {
  const server = fakeTokenServer(
    (init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      }),
  );

  const failure = await loginWithUnsavableConfig(server.fetchImpl, 10);

  assert.equal(failure.tokenRevoked, false);
  assert.equal(server.revocations.length, 1);
});

test("CLI login never revokes a token it saved", async () => {
  const originalClashHome = process.env.CLASH_HOME;
  process.env.CLASH_HOME = await mkdtemp(join(tmpdir(), "clash-cli-auth-"));
  const server = fakeTokenServer(
    async () => new Response(null, { status: 204 }),
  );
  try {
    await authModule.runCliLogin({
      serverUrl: "https://api.clash.art",
      browserOrigin: "https://clash.art",
      timeoutMs: 5_000,
      fetchImpl: server.fetchImpl,
      log: () => {},
      openBrowser: completeAuthorization,
    });

    assert.equal(loadConfig().apiKey, MINTED_TOKEN);
    assert.equal(server.revocations.length, 0);
  } finally {
    if (originalClashHome === undefined) delete process.env.CLASH_HOME;
    else process.env.CLASH_HOME = originalClashHome;
  }
});
