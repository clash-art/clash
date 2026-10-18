import { describe, expect, it } from "vitest";

import {
  authorizationUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  OAuthTokenError,
  oauthStatesMatch,
  pkceChallenge,
  refreshAccessToken,
} from "./provider-oauth-flow";
import { toBase64Url } from "./web-encoding";

/**
 * The OAuth pieces every adapter shares. The local Host binds a loopback port and the Cloudflare
 * adapter answers a web redirect, but PKCE, `state` and the exchange are this one module.
 */

function tokenFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const TOKEN_REQUEST = {
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: "client-1",
  code: "abc",
  verifier: "verifier-1",
  redirectUri: "https://clash.test/api/v1/provider-oauth/callback",
};

describe("PKCE (RFC 7636)", () => {
  // RFC 7636 Appendix B: the 32 octets, the verifier they encode, and its S256 challenge.
  const APPENDIX_B_OCTETS = [
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186,
    22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
  ];
  const APPENDIX_B_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const APPENDIX_B_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("encodes the appendix B octets as the appendix B verifier", () => {
    expect(toBase64Url(new Uint8Array(APPENDIX_B_OCTETS))).toBe(APPENDIX_B_VERIFIER);
  });

  it("derives the appendix B challenge from the appendix B verifier", async () => {
    await expect(pkceChallenge(APPENDIX_B_VERIFIER)).resolves.toBe(APPENDIX_B_CHALLENGE);
  });

  it("pairs a fresh verifier with its own S256 challenge", async () => {
    const pair = await createPkcePair();
    expect(pair.method).toBe("S256");
    await expect(pkceChallenge(pair.verifier)).resolves.toBe(pair.challenge);
    // RFC 7636 §4.1: 43..128 characters from the unreserved set.
    expect(pair.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
  });

  it("makes a different verifier each time", async () => {
    // A fixed verifier would let anyone who saw one authorization exchange replay the next.
    const [first, second] = await Promise.all([createPkcePair(), createPkcePair()]);
    expect(first.verifier).not.toBe(second.verifier);
  });
});

describe("state", () => {
  it("carries at least 32 random bytes, base64url", () => {
    const state = createOAuthState();
    // 32 bytes is 43 base64url characters without padding.
    expect(state).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(createOAuthState()).not.toBe(state);
  });

  it("matches only the identical value", () => {
    const state = createOAuthState();
    expect(oauthStatesMatch(state, state)).toBe(true);
    const lastDiffers = `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`;
    expect(oauthStatesMatch(lastDiffers, state)).toBe(false);
    expect(oauthStatesMatch(state.slice(1), state)).toBe(false);
    expect(oauthStatesMatch(`${state}a`, state)).toBe(false);
  });

  it("never matches an absent value", () => {
    expect(oauthStatesMatch(undefined, "s")).toBe(false);
    expect(oauthStatesMatch(null, "s")).toBe(false);
    expect(oauthStatesMatch("", "")).toBe(false);
  });
});

describe("authorization url", () => {
  it("carries the parameters the standard requires, and the ones the declaration adds", () => {
    const url = new URL(authorizationUrl({
      open: "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: "client-1",
      redirectUri: "https://clash.test/api/v1/provider-oauth/callback",
      state: "state-1",
      challenge: "challenge-1",
      params: { scope: "https://www.googleapis.com/auth/cloud-platform", access_type: "offline" },
    }));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://clash.test/api/v1/provider-oauth/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("does not let declared parameters overwrite the host-owned ones", () => {
    // A declaration that set `state` would be replacing the value the host is about to check
    // against, which turns the check into a comparison of a constant with itself.
    const url = new URL(authorizationUrl({
      open: "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: "client-1",
      redirectUri: "https://clash.test/cb",
      state: "host-state",
      challenge: "host-challenge",
      params: {
        state: "plugin-state",
        code_challenge: "plugin-challenge",
        code_challenge_method: "plain",
        redirect_uri: "https://evil.test/cb",
        client_id: "other-client",
        response_type: "token",
      },
    }));
    expect(url.searchParams.get("state")).toBe("host-state");
    expect(url.searchParams.get("code_challenge")).toBe("host-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://clash.test/cb");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

describe("token exchange", () => {
  it("posts the verifier, the redirect uri and the client", async () => {
    let body = "";
    await exchangeAuthorizationCode({
      ...TOKEN_REQUEST,
      clientSecret: "secret-1",
      fetch: (async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const form = new URLSearchParams(body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toBe("verifier-1");
    expect(form.get("redirect_uri")).toBe(TOKEN_REQUEST.redirectUri);
    expect(form.get("client_id")).toBe("client-1");
    expect(form.get("client_secret")).toBe("secret-1");
  });

  it("turns expires_in into an absolute time", async () => {
    const before = Date.now();
    const token = await exchangeAuthorizationCode({
      ...TOKEN_REQUEST,
      fetch: tokenFetch(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 }),
    });
    expect(token.accessToken).toBe("at");
    expect(token.refreshToken).toBe("rt");
    expect(token.expiresAt!).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it("maps a vendor error to OAuthTokenError with its RFC 6749 code", async () => {
    const failure = await exchangeAuthorizationCode({
      ...TOKEN_REQUEST,
      fetch: tokenFetch(400, { error: "invalid_grant", error_description: "Bad code" }),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OAuthTokenError);
    expect((failure as OAuthTokenError).oauthError).toBe("invalid_grant");
    expect((failure as OAuthTokenError).status).toBe(400);
    expect((failure as Error).message).toMatch(/invalid_grant/);
  });

  it("reports the HTTP status when the vendor sends no error code", async () => {
    const failure = await exchangeAuthorizationCode({
      ...TOKEN_REQUEST,
      fetch: tokenFetch(503, {}),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OAuthTokenError);
    expect((failure as OAuthTokenError).oauthError).toBeUndefined();
    expect((failure as Error).message).toMatch(/HTTP 503/);
  });

  it("refuses a non-JSON answer instead of throwing a parser error", async () => {
    const failure = await exchangeAuthorizationCode({
      ...TOKEN_REQUEST,
      fetch: tokenFetch(502, "<html>Bad gateway</html>"),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OAuthTokenError);
    expect((failure as OAuthTokenError).status).toBe(502);
  });

  it("refuses a success that carries no access_token", async () => {
    await expect(exchangeAuthorizationCode({
      ...TOKEN_REQUEST,
      fetch: tokenFetch(200, { token_type: "Bearer" }),
    })).rejects.toThrow(OAuthTokenError);
  });

  it("wraps an unreachable endpoint", async () => {
    const failure = await exchangeAuthorizationCode({
      ...TOKEN_REQUEST,
      fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OAuthTokenError);
    expect((failure as Error).cause).toBeInstanceOf(TypeError);
  });

  it("keeps the old refresh token when a refresh does not return one", async () => {
    // Google omits it on refresh. Overwriting with undefined loses the only credential that can
    // obtain another access token.
    const token = await refreshAccessToken({
      tokenUrl: TOKEN_REQUEST.tokenUrl,
      clientId: "client-1",
      refreshToken: "rt-original",
      fetch: tokenFetch(200, { access_token: "at-2", expires_in: 3600 }),
    });
    expect(token.refreshToken).toBe("rt-original");
  });
});
