import { Hono, type Context } from "hono";
import type { Env } from "../../config";
import { getApiTokenIdentity } from "../../services/api-token";
import { revokeApiToken } from "../../services/settings-d1";

export const cliAuthRoutes = new Hono<{ Bindings: Env }>();

const CLI_CLIENT_ID = "clash-cli";
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const OAUTH_STATE = /^[A-Za-z0-9._~-]{32,128}$/;

type AuthorizationRequest = {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
};

type AuthorizationCodeRow = {
  user_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
};

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return new Uint8Array(digest);
}

async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await sha256Bytes(input));
}

function isLoopbackRedirectUri(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port !== "" &&
      url.pathname === "/callback" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function parseAuthorizationRequest(body: unknown): AuthorizationRequest | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const request: AuthorizationRequest = {
    response_type:
      typeof value.response_type === "string" ? value.response_type : "",
    client_id: typeof value.client_id === "string" ? value.client_id : "",
    redirect_uri:
      typeof value.redirect_uri === "string" ? value.redirect_uri : "",
    code_challenge:
      typeof value.code_challenge === "string" ? value.code_challenge : "",
    code_challenge_method:
      typeof value.code_challenge_method === "string"
        ? value.code_challenge_method
        : "",
    state: typeof value.state === "string" ? value.state : "",
  };
  if (
    request.response_type !== "code" ||
    request.client_id !== CLI_CLIENT_ID ||
    request.code_challenge_method !== "S256" ||
    !BASE64URL_32_BYTES.test(request.code_challenge) ||
    !OAUTH_STATE.test(request.state) ||
    !isLoopbackRedirectUri(request.redirect_uri)
  ) {
    return null;
  }
  return request;
}

function parseSingleFormValue(
  params: URLSearchParams,
  name: string,
): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function noStoreHeaders(c: {
  header(name: string, value: string): void;
}): void {
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function invalidGrant(c: Context<{ Bindings: Env }>) {
  noStoreHeaders(c);
  return c.json(
    {
      error: "invalid_grant",
      error_description:
        "Authorization code is invalid, expired, already used, or not bound to this request.",
    },
    400,
  );
}

cliAuthRoutes.post("/authorize", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const request = parseAuthorizationRequest(
    await c.req.json().catch(() => null),
  );
  if (!request) {
    return c.json(
      {
        error: "invalid_request",
        error_description:
          "A first-party code request with loopback redirect, state, and PKCE S256 is required.",
      },
      400,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare("DELETE FROM cli_oauth_code WHERE expires_at <= ?")
    .bind(now)
    .run()
    .catch(() => undefined);

  const code = bytesToBase64Url(randomBytes(32));
  const codeHash = await sha256Hex(code);
  const expiresAt = now + AUTHORIZATION_CODE_TTL_SECONDS;
  await c.env.DB.prepare(
    `INSERT INTO cli_oauth_code
      (code_hash, user_id, client_id, redirect_uri, code_challenge, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
  )
    .bind(
      codeHash,
      userId,
      request.client_id,
      request.redirect_uri,
      request.code_challenge,
      expiresAt,
    )
    .run();

  const redirect = new URL(request.redirect_uri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", request.state);
  noStoreHeaders(c);
  return c.json({
    redirect_uri: redirect.toString(),
    expires_in: AUTHORIZATION_CODE_TTL_SECONDS,
  });
});

cliAuthRoutes.post("/token", async (c) => {
  const contentType = (c.req.header("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    noStoreHeaders(c);
    return c.json(
      {
        error: "invalid_request",
        error_description: "Form encoding is required.",
      },
      415,
    );
  }

  const params = new URLSearchParams(await c.req.text());
  const allowed = new Set([
    "grant_type",
    "client_id",
    "redirect_uri",
    "code",
    "code_verifier",
  ]);
  if ([...params.keys()].some((key) => !allowed.has(key))) {
    noStoreHeaders(c);
    return c.json(
      {
        error: "invalid_request",
        error_description: "Unexpected token request parameter.",
      },
      400,
    );
  }
  const grantType = parseSingleFormValue(params, "grant_type");
  const clientId = parseSingleFormValue(params, "client_id");
  const redirectUri = parseSingleFormValue(params, "redirect_uri");
  const code = parseSingleFormValue(params, "code");
  const verifier = parseSingleFormValue(params, "code_verifier");
  if (
    grantType !== "authorization_code" ||
    clientId !== CLI_CLIENT_ID ||
    !redirectUri ||
    !isLoopbackRedirectUri(redirectUri) ||
    !code ||
    !BASE64URL_32_BYTES.test(code) ||
    !verifier ||
    !PKCE_VERIFIER.test(verifier)
  ) {
    noStoreHeaders(c);
    return c.json(
      {
        error: "invalid_request",
        error_description: "Malformed authorization code request.",
      },
      400,
    );
  }

  const codeHash = await sha256Hex(code);
  const row = await c.env.DB.prepare(
    `SELECT user_id, client_id, redirect_uri, code_challenge, expires_at
       FROM cli_oauth_code
      WHERE code_hash = ?
      LIMIT 1`,
  )
    .bind(codeHash)
    .first<AuthorizationCodeRow>();
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.expires_at <= now) return invalidGrant(c);

  const actualChallenge = bytesToBase64Url(await sha256Bytes(verifier));
  if (
    !constantTimeEqual(row.client_id, clientId) ||
    !constantTimeEqual(row.redirect_uri, redirectUri) ||
    !constantTimeEqual(row.code_challenge, actualChallenge)
  ) {
    return invalidGrant(c);
  }

  const consumed = await c.env.DB.prepare(
    "DELETE FROM cli_oauth_code WHERE code_hash = ? AND expires_at > ?",
  )
    .bind(codeHash, now)
    .run();
  if (Number(consumed.meta?.changes ?? 0) !== 1) return invalidGrant(c);

  const accessToken = `clsh_${bytesToHex(randomBytes(20))}`;
  const tokenHash = await sha256Hex(accessToken);
  await c.env.DB.prepare(
    `INSERT INTO api_token
      (id, user_id, name, token_hash, token_prefix, created_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())`,
  )
    .bind(
      crypto.randomUUID(),
      row.user_id,
      "Clash CLI",
      tokenHash,
      `${accessToken.slice(0, 13)}...`,
    )
    .run();

  noStoreHeaders(c);
  return c.json({ access_token: accessToken, token_type: "Bearer" });
});

// The access token is the only handle a CLI holds on its token row, so the
// credential revokes itself. A client that cannot persist a token it was just
// issued uses this instead of leaving it valid and unreachable.
cliAuthRoutes.delete("/token", async (c) => {
  noStoreHeaders(c);
  const token = await getApiTokenIdentity(c.req.raw, c.env);
  if (!token) {
    return c.json(
      {
        error: "invalid_token",
        error_description: "A valid bearer access token is required.",
      },
      401,
    );
  }
  await revokeApiToken(c.env, token.userId, token.id);
  return c.body(null, 204);
});
