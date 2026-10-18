/**
 * Service account → OAuth2 access token for Vertex AI, runnable in
 * Cloudflare Workers edge runtime.
 *
 * We sign an RS256 JWT with the service account's private key (via
 * `crypto.subtle` — no node:crypto dependency), then exchange it at
 * https://oauth2.googleapis.com/token for a short-lived access token.
 *
 * This mirrors what `@ai-sdk/google-vertex/edge` does internally, but
 * exposes the token so we can talk to Vertex REST endpoints that the SDK
 * doesn't wrap (specifically Veo's `:predictLongRunning` + `operations.get`
 * LRO split — the SDK hides the operation name).
 *
 * Tokens are cached per-clientEmail in module memory with a 5-minute safety
 * margin before the declared expiry. One worker instance → one active token
 * at a time; multiple concurrent callers share the in-flight exchange.
 */
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const REFRESH_MARGIN_SEC = 300; // refresh 5 min before expiry

type CachedToken = { accessToken: string; expiresAt: number };
export interface ServiceAccountAuthCredentials {
  clientEmail: string;
  privateKey: string;
}

export interface GoogleServiceAccount extends ServiceAccountAuthCredentials {
  project: string;
  location?: string;
}

/** Parse the `serviceAccountKey` JSON a Google Cloud Agent Platform provider account stores. */
export function googleServiceAccountFromCredentials(
  credentials: Record<string, string>,
): GoogleServiceAccount {
  const raw = credentials.serviceAccountKey?.trim();
  if (!raw) {
    throw new Error(
      "Google Cloud Agent Platform provider account is missing service account credentials.",
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(
      "Google Cloud Agent Platform credentials must be a service account JSON object.",
    );
  }
  const clientEmail =
    typeof parsed.clientEmail === "string"
      ? parsed.clientEmail
      : typeof parsed.client_email === "string"
        ? parsed.client_email
        : "";
  const privateKey =
    typeof parsed.privateKey === "string"
      ? parsed.privateKey
      : typeof parsed.private_key === "string"
        ? parsed.private_key
        : "";
  const project =
    typeof parsed.project === "string"
      ? parsed.project
      : typeof parsed.project_id === "string"
        ? parsed.project_id
        : "";
  const location =
    typeof parsed.location === "string" && parsed.location.trim()
      ? parsed.location.trim()
      : "global";
  if (!clientEmail || !privateKey || !project) {
    throw new Error(
      "Google Cloud Agent Platform credentials must include clientEmail/privateKey/project.",
    );
  }
  return { clientEmail, privateKey, project, location };
}

/** Vertex REST address for one publisher model action (`generateContent`, `predictLongRunning`, ...). */
export function googleAgentPlatformModelUrl(
  account: GoogleServiceAccount,
  modelId: string,
  action: string,
): string {
  const location = account.location ?? "global";
  if (!account.project) {
    throw new Error(
      "Google Cloud Agent Platform provider account is missing project.",
    );
  }
  const host =
    location === "global"
      ? "aiplatform.googleapis.com"
      : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${account.project}/locations/${location}/publishers/google/models/${modelId}:${action}`;
}

const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<CachedToken>>();

// ─── base64url helpers (RFC 7515) ─────────────────────────────

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // chunked String.fromCharCode to avoid stack overflow on large buffers
  const CHUNK = 8192;
  const parts: string[] = [];
  for (let i = 0; i < arr.length; i += CHUNK) {
    parts.push(String.fromCharCode(...arr.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function utf8ToBase64Url(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

// ─── PEM → CryptoKey ──────────────────────────────────────────

/** Parse a "-----BEGIN PRIVATE KEY-----...END PRIVATE KEY-----" PEM string
 *  into a CryptoKey suitable for RS256 signing. Accepts newlines encoded as
 *  literal "\n" (common when service-account JSON is pasted into settings). */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// ─── JWT sign + token exchange ────────────────────────────────

async function mintJwt(
  clientEmail: string,
  privateKey: CryptoKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const signingInput = `${utf8ToBase64Url(JSON.stringify(header))}.${utf8ToBase64Url(JSON.stringify(claim))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

async function exchangeJwtForToken(jwt: string): Promise<CachedToken> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "<unreadable>");
    throw new Error(
      `Vertex token exchange failed (${resp.status} ${resp.statusText}): ${text.slice(0, 300)}`,
    );
  }
  const data = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token || !data.expires_in) {
    throw new Error(
      "Vertex token exchange returned no access_token/expires_in",
    );
  }
  return {
    accessToken: data.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
  };
}

// ─── Public: getAccessToken(env) ──────────────────────────────

async function getVertexAccessTokenForRawCredentials(
  clientEmail: string,
  privateKey: string,
): Promise<string> {
  if (!clientEmail || !privateKey) {
    throw new Error(
      "Agent Platform auth requires clientEmail and privateKey provider credentials",
    );
  }

  const cached = tokenCache.get(clientEmail);
  const nowSec = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - nowSec > REFRESH_MARGIN_SEC) {
    return cached.accessToken;
  }

  let pending = inflight.get(clientEmail);
  if (!pending) {
    pending = (async () => {
      const key = await importPrivateKey(privateKey);
      const jwt = await mintJwt(clientEmail, key);
      const token = await exchangeJwtForToken(jwt);
      tokenCache.set(clientEmail, token);
      return token;
    })()
      .catch((err) => {
        // Bubble up but clear inflight so retries aren't stuck on a dead promise
        inflight.delete(clientEmail);
        throw err;
      })
      .finally(() => {
        inflight.delete(clientEmail);
      });
    inflight.set(clientEmail, pending);
  }
  const token = await pending;
  return token.accessToken;
}

export async function getVertexAccessTokenForCredentials(
  credentials: ServiceAccountAuthCredentials,
): Promise<string> {
  return getVertexAccessTokenForRawCredentials(
    credentials.clientEmail,
    credentials.privateKey,
  );
}

/** Clear the cached token for a given client email. For tests / manual revoke. */
export function invalidateVertexAccessToken(clientEmail: string): void {
  tokenCache.delete(clientEmail);
}
