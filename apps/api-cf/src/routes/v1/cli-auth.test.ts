import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "../../config";
import { cliAuthRoutes } from "./cli-auth";

type OAuthCodeRow = {
  code_hash: string;
  user_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
};

type ApiTokenRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
};

class MemoryD1 {
  readonly oauthCodes = new Map<string, OAuthCodeRow>();
  readonly apiTokens = new Map<string, ApiTokenRow>();

  prepare(sql: string) {
    const db = this;
    return {
      bind(...args: unknown[]) {
        return {
          async first<T>() {
            if (sql.includes("FROM cli_oauth_code")) {
              return (db.oauthCodes.get(String(args[0])) ?? null) as T | null;
            }
            return null;
          },
          async all<T>() {
            return { results: [] } as T;
          },
          async run() {
            if (sql.includes("INSERT INTO cli_oauth_code")) {
              const [
                codeHash,
                userId,
                clientId,
                redirectUri,
                codeChallenge,
                expiresAt,
              ] = args;
              db.oauthCodes.set(String(codeHash), {
                code_hash: String(codeHash),
                user_id: String(userId),
                client_id: String(clientId),
                redirect_uri: String(redirectUri),
                code_challenge: String(codeChallenge),
                expires_at: Number(expiresAt),
              });
              return { meta: { changes: 1 } };
            }
            if (
              sql.includes("DELETE FROM cli_oauth_code") &&
              sql.includes("expires_at <=")
            ) {
              const now = Number(args[0]);
              let changes = 0;
              for (const [key, row] of db.oauthCodes) {
                if (row.expires_at <= now) {
                  db.oauthCodes.delete(key);
                  changes += 1;
                }
              }
              return { meta: { changes } };
            }
            if (
              sql.includes("DELETE FROM cli_oauth_code") &&
              sql.includes("code_hash = ?")
            ) {
              const changes = db.oauthCodes.delete(String(args[0])) ? 1 : 0;
              return { meta: { changes } };
            }
            if (sql.includes("INSERT INTO api_token")) {
              const [id, userId, name, tokenHash, tokenPrefix] = args;
              db.apiTokens.set(String(id), {
                id: String(id),
                user_id: String(userId),
                name: String(name),
                token_hash: String(tokenHash),
                token_prefix: String(tokenPrefix),
              });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
      },
    };
  }
}

const CLIENT_ID = "clash-cli";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "state_0123456789abcdefghijklmnopqrstuvwxyz";
const REDIRECT_URI = "http://127.0.0.1:43123/callback";

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/v1/cli-auth", cliAuthRoutes);
  return app;
}

function makeEnv(db: MemoryD1): Env {
  return { DB: db as unknown as D1Database } as Env;
}

async function authorize(
  app: ReturnType<typeof makeApp>,
  env: Env,
  overrides: Record<string, unknown> = {},
) {
  return app.request(
    "/api/v1/cli-auth/authorize",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "user-1" },
      body: JSON.stringify({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        state: STATE,
        ...overrides,
      }),
    },
    env,
  );
}

async function exchange(
  app: ReturnType<typeof makeApp>,
  env: Env,
  code: string,
  overrides: Record<string, string> = {},
) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: VERIFIER,
    ...overrides,
  });
  return app.request(
    "/api/v1/cli-auth/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    env,
  );
}

describe("CLI OAuth authorization code flow", () => {
  it("requires a validated downstream user identity to authorize", async () => {
    const db = new MemoryD1();
    const response = await makeApp().request(
      "/api/v1/cli-auth/authorize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response_type: "code",
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_challenge: CHALLENGE,
          code_challenge_method: "S256",
          state: STATE,
        }),
      },
      makeEnv(db),
    );

    expect(response.status).toBe(401);
    expect(db.oauthCodes.size).toBe(0);
  });

  it("removes the legacy endpoint that minted a PAT directly", async () => {
    const db = new MemoryD1();
    const response = await makeApp().request(
      "/api/v1/cli-auth",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": "user-1" },
        body: JSON.stringify({ tokenName: "unsafe" }),
      },
      makeEnv(db),
    );

    expect(response.status).toBe(404);
    expect(db.apiTokens.size).toBe(0);
  });

  it("issues a short-lived hashed code and returns only code plus state to loopback", async () => {
    const db = new MemoryD1();
    const response = await authorize(makeApp(), makeEnv(db));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as {
      redirect_uri: string;
      expires_in: number;
    };
    const redirect = new URL(body.redirect_uri);
    const code = redirect.searchParams.get("code");
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("state")).toBe(STATE);
    expect(redirect.searchParams.has("token")).toBe(false);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.expires_in).toBeLessThanOrEqual(300);
    expect(JSON.stringify(body)).not.toContain("clsh_");

    expect(db.oauthCodes.size).toBe(1);
    const stored = [...db.oauthCodes.values()][0];
    expect(stored.code_hash).toBe(
      createHash("sha256").update(code!).digest("hex"),
    );
    expect(stored.code_hash).not.toContain(code!);
    expect(stored.code_challenge).toBe(CHALLENGE);
    expect(stored.redirect_uri).toBe(REDIRECT_URI);
  });

  it("exchanges a bound PKCE code once and stores only the access-token hash", async () => {
    const app = makeApp();
    const db = new MemoryD1();
    const env = makeEnv(db);
    const authorization = await authorize(app, env);
    const redirect = new URL(
      ((await authorization.json()) as { redirect_uri: string }).redirect_uri,
    );
    const code = redirect.searchParams.get("code")!;

    const first = await exchange(app, env, code);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("no-store");
    const tokenBody = (await first.json()) as {
      access_token: string;
      token_type: string;
    };
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.access_token).toMatch(/^clsh_[0-9a-f]{40}$/);
    expect(db.oauthCodes.size).toBe(0);
    expect(db.apiTokens.size).toBe(1);
    const storedToken = [...db.apiTokens.values()][0];
    expect(storedToken.token_hash).toBe(
      createHash("sha256").update(tokenBody.access_token).digest("hex"),
    );
    expect(storedToken.token_hash).not.toContain(tokenBody.access_token);

    const replay = await exchange(app, env, code);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    expect(db.apiTokens.size).toBe(1);
  });

  it("allows only one winner when the same code is exchanged concurrently", async () => {
    const app = makeApp();
    const db = new MemoryD1();
    const env = makeEnv(db);
    const authorization = await authorize(app, env);
    const code = new URL(
      ((await authorization.json()) as { redirect_uri: string }).redirect_uri,
    ).searchParams.get("code")!;

    const responses = await Promise.all([
      exchange(app, env, code),
      exchange(app, env, code),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 400,
    ]);
    expect(db.apiTokens.size).toBe(1);
  });

  it.each([
    [
      "external hostname",
      { redirect_uri: "https://attacker.example/callback" },
    ],
    [
      "loopback lookalike",
      { redirect_uri: "http://localhost.attacker.example:43123/callback" },
    ],
    ["missing explicit port", { redirect_uri: "http://localhost/callback" }],
    [
      "unexpected callback path",
      { redirect_uri: "http://127.0.0.1:43123/steal" },
    ],
    ["non-S256 PKCE", { code_challenge_method: "plain" }],
    ["malformed challenge", { code_challenge: "short" }],
  ])("rejects %s authorization requests", async (_label, overrides) => {
    const db = new MemoryD1();
    const response = await authorize(makeApp(), makeEnv(db), overrides);
    expect(response.status).toBe(400);
    expect(db.oauthCodes.size).toBe(0);
  });

  it("binds exchange to redirect URI and verifier without consuming on mismatch", async () => {
    const app = makeApp();
    const db = new MemoryD1();
    const env = makeEnv(db);
    const authorization = await authorize(app, env);
    const code = new URL(
      ((await authorization.json()) as { redirect_uri: string }).redirect_uri,
    ).searchParams.get("code")!;

    const wrongRedirect = await exchange(app, env, code, {
      redirect_uri: "http://localhost:43123/callback",
    });
    expect(wrongRedirect.status).toBe(400);
    expect(await wrongRedirect.json()).toMatchObject({
      error: "invalid_grant",
    });
    expect(db.oauthCodes.size).toBe(1);

    const wrongVerifier = await exchange(app, env, code, {
      code_verifier: "x".repeat(43),
    });
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toMatchObject({
      error: "invalid_grant",
    });
    expect(db.oauthCodes.size).toBe(1);

    const valid = await exchange(app, env, code);
    expect(valid.status).toBe(200);
  });

  it("rejects expired codes and non-form token requests", async () => {
    const app = makeApp();
    const db = new MemoryD1();
    const env = makeEnv(db);
    const authorization = await authorize(app, env);
    const code = new URL(
      ((await authorization.json()) as { redirect_uri: string }).redirect_uri,
    ).searchParams.get("code")!;
    const stored = [...db.oauthCodes.values()][0];
    stored.expires_at = Math.floor(Date.now() / 1000) - 1;

    const expired = await exchange(app, env, code);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: "invalid_grant" });
    expect(db.apiTokens.size).toBe(0);

    const jsonExchange = await app.request(
      "/api/v1/cli-auth/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      },
      env,
    );
    expect(jsonExchange.status).toBe(415);
  });

  it.each([
    ["no credential", {}],
    [
      "an unknown access token",
      { authorization: `Bearer clsh_${"0".repeat(40)}` },
    ],
    ["another credential type", { authorization: "Bearer sk_gw_token" }],
    ["a caller-supplied identity", { "x-user-id": "user-1" }],
  ])("refuses to revoke with %s", async (_label, headers) => {
    const response = await makeApp().request(
      "/api/v1/cli-auth/token",
      { method: "DELETE", headers },
      makeEnv(new MemoryD1()),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
  });
});
