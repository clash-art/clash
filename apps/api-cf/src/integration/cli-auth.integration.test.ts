/**
 * CLI access token self-revocation (#90) in workerd with the migrated D1
 * schema: a token issued by the real PKCE exchange revokes itself through the
 * /api/* identity middleware, without touching any other credential.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createApp } from "../app";
import type { Env } from "../config";

const ORIGIN = "https://clash.test";
const bindings = { ...env, BETTER_AUTH_URL: ORIGIN } as unknown as Env;
const app = createApp();

// RFC 7636 appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT_URI = "http://127.0.0.1:43123/callback";

// The web gateway forwards /api/v1/* with this header so api-cf fails closed.
const REQUIRED = { "x-clash-require-identity": "1" };

const request = (path: string, init: RequestInit = {}) =>
  app.request(path, init, bindings);

async function signUp() {
  const email = `cli-${crypto.randomUUID()}@example.com`;
  const res = await request("/api/better-auth/sign-up/email", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: "cli-auth-password-123",
      name: "CLI",
    }),
  });
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function issueAccessToken(cookie: string): Promise<string> {
  const authorized = await request("/api/v1/cli-auth/authorize", {
    method: "POST",
    headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
    body: JSON.stringify({
      response_type: "code",
      client_id: "clash-cli",
      redirect_uri: REDIRECT_URI,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "state_0123456789abcdefghijklmnopqrstuvwxyz",
    }),
  });
  expect(authorized.status).toBe(200);
  const { redirect_uri } = (await authorized.json()) as {
    redirect_uri: string;
  };
  const exchanged = await request("/api/v1/cli-auth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "clash-cli",
      redirect_uri: REDIRECT_URI,
      code: new URL(redirect_uri).searchParams.get("code")!,
      code_verifier: VERIFIER,
    }).toString(),
  });
  expect(exchanged.status).toBe(200);
  return ((await exchanged.json()) as { access_token: string }).access_token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const me = (headers: Record<string, string>) =>
  request("/api/v1/me", { headers: { ...REQUIRED, ...headers } });
const revoke = (headers: Record<string, string>) =>
  request("/api/v1/cli-auth/token", {
    method: "DELETE",
    headers: { ...REQUIRED, ...headers },
  });

describe("CLI access token self-revocation in workerd", () => {
  it("revokes only the presented token, and the token stops authenticating", async () => {
    const cookie = await signUp();
    const revoked = await issueAccessToken(cookie);
    const kept = await issueAccessToken(cookie);
    expect((await me(bearer(revoked))).status).toBe(200);

    const response = await revoke(bearer(revoked));

    expect(response.status).toBe(204);
    expect((await me(bearer(revoked))).status).toBe(401);
    expect((await me(bearer(kept))).status).toBe(200);
    expect((await me({ cookie })).status).toBe(200);
    expect((await revoke(bearer(revoked))).status).toBe(401);
  });

  it("does not revoke anything for a session, which has no token to present", async () => {
    const cookie = await signUp();
    const token = await issueAccessToken(cookie);

    const response = await revoke({ cookie });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
    expect((await me(bearer(token))).status).toBe(200);
  });
});
