/**
 * The parts of OAuth that every vendor does identically, for every adapter.
 *
 * A plugin that had to implement `state` correctly would eventually implement it incorrectly, and
 * the failure is a silent CSRF rather than an error. The same holds for PKCE and for the code
 * exchange. What actually differs between vendors is which URL to open and which extra parameters
 * to send, so those come from the declaration and the rest is here.
 *
 * Web Crypto only: the local Host (Node) and the Cloudflare adapter (workerd) run this same code.
 * How the answer comes back -- a loopback port, a custom scheme, a web redirect -- is the adapter's.
 */

import { constantTimeEqual, toBase64Url } from "./web-encoding.js";

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

function randomBase64Url(byteLength: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** RFC 7636 S256: base64url(SHA-256(ASCII(verifier))). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return toBase64Url(digest);
}

/** RFC 7636. The floor is 43 characters; below it the challenge is brute-forceable. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomBase64Url(48);
  return { verifier, challenge: await pkceChallenge(verifier), method: "S256" };
}

/** 32 random bytes, base64url: unguessable, and safe in a query string unescaped. */
export function createOAuthState(): string {
  return randomBase64Url(32);
}

/** Constant-time, because a comparison that returns early leaks the prefix it matched. */
export function oauthStatesMatch(
  received: string | null | undefined,
  expected: string,
): boolean {
  if (!received || !expected) return false;
  return constantTimeEqual(received, expected);
}

export interface AuthorizationUrlInput {
  open: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  /** Vendor-specific: scope, access_type, prompt, audience. Whatever the declaration carries. */
  params?: Record<string, string>;
}

export function authorizationUrl(input: AuthorizationUrlInput): string {
  const url = new URL(input.open);
  // Declared parameters first, so the ones below always win. A declaration that set `state` would
  // be replacing the value the host is about to compare against, which turns the check into a
  // comparison of a constant with itself.
  for (const [key, value] of Object.entries(input.params ?? {})) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  /** Absolute epoch ms, because `expires_in` is relative to a response the host will no longer have. */
  expiresAt?: number;
  raw: Record<string, unknown>;
}

/**
 * A token request that did not produce a token.
 *
 * `oauthError` is the vendor's RFC 6749 error code when it sent one (`invalid_grant`,
 * `invalid_client`), because those need different fixes and a caller told only "exchange failed"
 * has to read a log to tell them apart. The message never carries the code, verifier or secret.
 */
export class OAuthTokenError extends Error {
  readonly status?: number;
  readonly oauthError?: string;

  constructor(
    message: string,
    details: { status?: number; oauthError?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "OAuthTokenError";
    if (details.status !== undefined) this.status = details.status;
    if (details.oauthError !== undefined) this.oauthError = details.oauthError;
  }
}

interface TokenRequest {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  fetch?: typeof globalThis.fetch;
}

export async function exchangeAuthorizationCode(
  input: TokenRequest & { code: string; verifier: string; redirectUri: string },
): Promise<OAuthToken> {
  return await postToken(input, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
  });
}

export async function refreshAccessToken(
  input: TokenRequest & { refreshToken: string },
): Promise<OAuthToken> {
  const token = await postToken(input, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  // Google omits the refresh token on refresh. Overwriting with undefined loses the only credential
  // that can obtain another access token, and the account stops working at the next expiry with no
  // event to explain it.
  return { ...token, refreshToken: token.refreshToken ?? input.refreshToken };
}

/** RFC 6749 error codes are `[\x20-\x21\x23-\x5B\x5D-\x7E]+`; keep only a short, printable token. */
function vendorErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.-]{1,64}$/.test(trimmed) ? trimmed : undefined;
}

async function postToken(
  input: TokenRequest,
  fields: Record<string, string>,
): Promise<OAuthToken> {
  const body = new URLSearchParams({ ...fields, client_id: input.clientId });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);

  const fetchImpl = input.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(input.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (cause) {
    throw new OAuthTokenError("Token endpoint could not be reached.", { cause });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("not a JSON object");
    }
    payload = parsed as Record<string, unknown>;
  } catch (cause) {
    throw new OAuthTokenError(
      `Token endpoint answered HTTP ${response.status} without a JSON object.`,
      { status: response.status, cause },
    );
  }

  if (!response.ok) {
    const oauthError = vendorErrorCode(payload.error);
    const detail = typeof payload.error_description === "string" ? `: ${payload.error_description}` : "";
    throw new OAuthTokenError(
      `Token request failed (${oauthError ?? `HTTP ${response.status}`})${detail}`,
      { status: response.status, ...(oauthError ? { oauthError } : {}) },
    );
  }

  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new OAuthTokenError("Token response carried no access_token.", {
      status: response.status,
    });
  }

  return {
    accessToken,
    ...(typeof payload.refresh_token === "string" && payload.refresh_token
      ? { refreshToken: payload.refresh_token }
      : {}),
    ...(typeof payload.expires_in === "number"
      ? { expiresAt: Date.now() + payload.expires_in * 1000 }
      : {}),
    raw: payload,
  };
}
