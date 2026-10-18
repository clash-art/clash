import {
  PROVIDER_OAUTH_ERROR_MESSAGES,
  isProviderOAuthErrorCode,
  type ModelUpstreamId,
  type ProviderAccountId,
  type ProviderOAuthErrorCode,
  type ProviderOAuthId,
} from "@clash/shared-types";
import {
  authorizationUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  OAuthTokenError,
  oauthStatesMatch,
} from "@clash/shared-runtime/provider-oauth-flow";

import { serverLog } from "../logger";
import type { PublicProviderAccount } from "./provider-accounts";
import {
  ProviderOAuthConfigError,
  type HostedOAuthProvider,
} from "./provider-oauth-config";
import {
  decryptSecretJson,
  encryptSecretJson,
  requireSecretEnvelopeKey,
} from "./secret-envelope";

export interface ProviderOAuthRecord {
  id: string;
  userId: string;
  providerId: ProviderOAuthId;
  accountId?: string;
  status: "pending" | "authorized" | "expired" | "revoked" | "error";
  /** `web` when GET /provider-oauth/callback finishes the flow. */
  callbackType?: "web";
  verificationUri?: string;
  userCode?: string;
  deviceCode?: string;
  intervalSeconds?: number;
  accountLabel?: string;
  expiresAt?: number;
  error?: string;
  errorCode?: ProviderOAuthErrorCode;
  hasTokens: boolean;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface PublicProviderOAuth {
  providerId: ProviderOAuthId;
  accountId?: string;
  status: ProviderOAuthRecord["status"];
  flow?: "browser";
  callbackType?: "web";
  verificationUri?: string;
  userCode?: string;
  deviceCode?: string;
  intervalSeconds?: number;
  accountLabel?: string;
  expiresAt?: string;
  error?: string;
  errorCode?: ProviderOAuthErrorCode;
  hasAccessToken: boolean;
}

type ProviderOAuthRow = {
  id: string;
  user_id: string;
  provider_id: string;
  account_id: string | null;
  status: string;
  callback_type: string | null;
  verification_uri: string | null;
  user_code: string | null;
  device_code: string | null;
  interval_seconds: number | null;
  account_label: string | null;
  expires_at: number | null;
  error: string | null;
  error_code: string | null;
  has_tokens: number | null;
  created_at: number | null;
  updated_at: number | null;
};

/** A web flow must come back within this window; after it the state is refused as expired. */
export const PROVIDER_OAUTH_PENDING_SECONDS = 10 * 60;

/** Domain separators for the ACTION_SECRET_KEY envelope: each family opens only its own. */
const PROVIDER_OAUTH_FLOW_SALT = "clash-provider-oauth-flow-secret";
const PROVIDER_OAUTH_TOKENS_SALT = "clash-provider-oauth-tokens";

const oauthLog = serverLog.child("provider-oauth");

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function providerAccountForOAuth(providerId: ProviderOAuthId): { providerId: ProviderAccountId; upstreamId: ModelUpstreamId } {
  return { providerId, upstreamId: providerId };
}

function statusValue(value: string): ProviderOAuthRecord["status"] {
  if (value === "authorized" || value === "expired" || value === "revoked" || value === "error") return value;
  return "pending";
}

/**
 * A pending row past its deadline reads as `expired`, with the code, to every reader.
 *
 * Nothing needs to run for this to be true -- no sweep that might not have happened yet -- so a
 * row cannot look `pending` forever. The callback persists the transition when it meets one.
 */
function publicRecord(row: ProviderOAuthRow, now = nowSeconds()): ProviderOAuthRecord {
  const stored = statusValue(row.status);
  const lapsed = stored === "pending" && row.expires_at !== null && row.expires_at !== undefined &&
    row.expires_at <= now;
  const errorCode = lapsed
    ? "PROVIDER_OAUTH_STATE_EXPIRED"
    : isProviderOAuthErrorCode(row.error_code) ? row.error_code : undefined;
  const error = lapsed ? PROVIDER_OAUTH_ERROR_MESSAGES.PROVIDER_OAUTH_STATE_EXPIRED : row.error;
  return {
    id: row.id,
    userId: row.user_id,
    providerId: row.provider_id as ProviderOAuthId,
    ...(row.account_id ? { accountId: row.account_id } : {}),
    status: lapsed ? "expired" : stored,
    ...(row.callback_type === "web" ? { callbackType: "web" as const } : {}),
    ...(row.verification_uri && !lapsed ? { verificationUri: row.verification_uri } : {}),
    ...(row.user_code ? { userCode: row.user_code } : {}),
    ...(row.device_code ? { deviceCode: row.device_code } : {}),
    ...(row.interval_seconds !== null && row.interval_seconds !== undefined ? { intervalSeconds: row.interval_seconds } : {}),
    ...(row.account_label ? { accountLabel: row.account_label } : {}),
    ...(row.expires_at !== null && row.expires_at !== undefined ? { expiresAt: row.expires_at } : {}),
    ...(error ? { error } : {}),
    ...(errorCode ? { errorCode } : {}),
    hasTokens: row.has_tokens === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RECORD_COLUMNS = `id, user_id, provider_id, account_id, status, callback_type, verification_uri,
              user_code, device_code, interval_seconds, account_label, expires_at, error, error_code,
              has_tokens, created_at, updated_at`;

export async function listProviderOAuthRecords(db: D1Database, userId: string): Promise<ProviderOAuthRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS}
       FROM provider_oauth
       WHERE user_id = ?
       ORDER BY provider_id, COALESCE(account_id, ''), updated_at DESC`,
    )
    .bind(userId)
    .all<ProviderOAuthRow>();
  const now = nowSeconds();
  return (result.results ?? []).map((row) => publicRecord(row, now));
}

export function publicProviderOAuth(record: ProviderOAuthRecord): PublicProviderOAuth {
  return {
    providerId: record.providerId,
    ...(record.accountId ? { accountId: record.accountId } : {}),
    status: record.status,
    ...(record.callbackType ? { flow: "browser" as const, callbackType: record.callbackType } : {}),
    ...(record.verificationUri ? { verificationUri: record.verificationUri } : {}),
    ...(record.userCode ? { userCode: record.userCode } : {}),
    ...(record.deviceCode ? { deviceCode: record.deviceCode } : {}),
    ...(record.intervalSeconds !== undefined ? { intervalSeconds: record.intervalSeconds } : {}),
    ...(record.accountLabel ? { accountLabel: record.accountLabel } : {}),
    ...(record.expiresAt !== undefined ? { expiresAt: new Date(record.expiresAt * 1000).toISOString() } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    hasAccessToken: record.hasTokens,
  };
}

export function applyProviderOAuth(
  accounts: PublicProviderAccount[],
  oauthRecords: ProviderOAuthRecord[],
): PublicProviderAccount[] {
  const authorized = oauthRecords.filter((record) => record.status === "authorized");
  const merged = new Map<string, PublicProviderAccount>();
  for (const account of accounts) merged.set(account.id, { ...account });

  for (const record of authorized) {
    const mapped = providerAccountForOAuth(record.providerId);
    if (!mapped) continue;
    if (record.accountId && merged.has(record.accountId)) continue;
    const id = record.accountId ?? `oauth:${record.providerId}`;
    merged.set(id, {
      id,
      providerId: mapped.providerId,
      upstreamId: mapped.upstreamId,
      ...(record.accountLabel ? { label: record.accountLabel } : {}),
      enabled: true,
      configuredCredentials: [],
      availableOAuth: [record.providerId],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  return [...merged.values()]
    .map((account) => {
      const availableOAuth = authorized
        .filter((record) => {
          const mapped = providerAccountForOAuth(record.providerId);
          if (!mapped || mapped.providerId !== account.providerId) return false;
          if (!record.accountId) return true;
          return record.accountId === account.id;
        })
        .map((record) => record.providerId);
      return {
        ...account,
        availableOAuth,
      };
    })
    .sort((a, b) => {
      const provider = `${a.providerId}:${a.upstreamId ?? ""}:${a.region ?? ""}`
        .localeCompare(`${b.providerId}:${b.upstreamId ?? ""}:${b.region ?? ""}`);
      if (provider !== 0) return provider;
      const priority = (a.priority ?? 1000) - (b.priority ?? 1000);
      if (priority !== 0) return priority;
      return a.id.localeCompare(b.id);
    });
}

export async function deleteProviderOAuthRecord(
  db: D1Database,
  userId: string,
  providerId: ProviderOAuthId,
  accountId?: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM provider_oauth
       WHERE user_id = ? AND provider_id = ? AND COALESCE(account_id, '') = ?`,
    )
    .bind(userId, providerId, accountId ?? "")
    .run();
}

export async function deleteProviderOAuthRecordsForAccount(
  db: D1Database,
  userId: string,
  accountId: string,
): Promise<boolean> {
  const records = await listProviderOAuthRecords(db, userId);
  const hasRecords = records.some((record) => record.accountId === accountId);
  await db
    .prepare(
      `DELETE FROM provider_oauth
       WHERE user_id = ? AND account_id = ?`,
    )
    .bind(userId, accountId)
    .run();
  return hasRecords;
}

export async function findProviderOAuthRecord(
  db: D1Database,
  userId: string,
  providerId: ProviderOAuthId,
  accountId?: string,
): Promise<ProviderOAuthRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS}
       FROM provider_oauth
       WHERE user_id = ? AND provider_id = ? AND COALESCE(account_id, '') = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .bind(userId, providerId, accountId ?? "")
    .first<ProviderOAuthRow>();
  return row ? publicRecord(row) : null;
}

// ───────── Web redirect flow (Cloudflare adapter) ─────────

/** What the callback needs back from `start`, sealed: never in clear at rest or on the wire. */
interface WebFlowSecret {
  state: string;
  verifier: string;
  redirectUri: string;
}

function parseWebFlowSecret(value: unknown): WebFlowSecret | null {
  if (!value || typeof value !== "object") return null;
  const { state, verifier, redirectUri } = value as Record<string, unknown>;
  return typeof state === "string" && typeof verifier === "string" && typeof redirectUri === "string"
    ? { state, verifier, redirectUri }
    : null;
}

export interface StartWebProviderOAuthInput {
  userId: string;
  provider: HostedOAuthProvider;
  accountId?: string;
  accountLabel?: string;
  /** `${public origin}/api/v1/provider-oauth/callback`, registered with the vendor by the operator. */
  redirectUri: string;
}

/**
 * Begin an authorization-code + PKCE flow that the browser finishes by redirect.
 *
 * The row is the only place the verifier and state live, and only inside the envelope; the
 * authorization URL carries the state, so it is returned to the caller and never stored. Starting
 * again replaces both and drops any earlier token: a row is authorized with tokens, or it is not
 * authorized and holds none.
 */
export async function startWebProviderOAuth(
  env: { DB: D1Database; ACTION_SECRET_KEY?: string },
  input: StartWebProviderOAuthInput,
): Promise<ProviderOAuthRecord> {
  const secretKey = requireSecretEnvelopeKey(
    env.ACTION_SECRET_KEY,
    "ACTION_SECRET_KEY is not configured, so a pending authorization cannot be sealed.",
  );
  const pkce = await createPkcePair();
  const state = createOAuthState();
  const sealed = await encryptSecretJson(
    { state, verifier: pkce.verifier, redirectUri: input.redirectUri } satisfies WebFlowSecret,
    secretKey,
    PROVIDER_OAUTH_FLOW_SALT,
  );
  const verificationUri = authorizationUrl({
    open: input.provider.flow.open,
    clientId: input.provider.flow.clientId,
    redirectUri: input.redirectUri,
    state,
    challenge: pkce.challenge,
    ...(input.provider.flow.params ? { params: input.provider.flow.params } : {}),
  });
  const now = nowSeconds();
  const expiresAt = now + PROVIDER_OAUTH_PENDING_SECONDS;
  const accountLabel = input.accountLabel ?? input.provider.label ?? null;

  const existing = await findProviderOAuthRecord(env.DB, input.userId, input.provider.id, input.accountId);
  const id = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await env.DB
      .prepare(
        `UPDATE provider_oauth
         SET status = 'pending', callback_type = 'web', encrypted_flow_secret = ?, encrypted_tokens = NULL,
             has_tokens = 0, verification_uri = NULL, user_code = NULL, device_code = NULL,
             interval_seconds = NULL, account_label = ?, expires_at = ?, error = NULL, error_code = NULL,
             updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .bind(sealed, accountLabel, expiresAt, now, id, input.userId)
      .run();
  } else {
    await env.DB
      .prepare(
        `INSERT INTO provider_oauth
           (id, user_id, provider_id, account_id, status, callback_type, encrypted_flow_secret,
            account_label, expires_at, has_tokens, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 'web', ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        id,
        input.userId,
        input.provider.id,
        input.accountId ?? null,
        sealed,
        accountLabel,
        expiresAt,
        now,
        now,
      )
      .run();
  }
  return {
    id,
    userId: input.userId,
    providerId: input.provider.id,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    status: "pending",
    callbackType: "web",
    verificationUri,
    ...(accountLabel ? { accountLabel } : {}),
    expiresAt,
    hasTokens: false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export type WebProviderOAuthCallbackResult =
  | { status: "authorized"; providerId: ProviderOAuthId }
  | { status: "error"; code: ProviderOAuthErrorCode; providerId?: ProviderOAuthId };

export interface WebProviderOAuthCallbackInput {
  userId: string;
  state: string | undefined;
  code: string | undefined;
  /** The vendor's RFC 6749 `error` parameter, when the user or vendor refused. */
  vendorError: string | undefined;
  /** Resolve the hosted declaration again; it may have changed while the browser was away. */
  resolveProvider: (providerId: string) => HostedOAuthProvider | null;
  fetch?: typeof globalThis.fetch;
}

type CandidateRow = {
  id: string;
  provider_id: string;
  status: string;
  expires_at: number | null;
  encrypted_flow_secret: string;
};

async function failRow(
  db: D1Database,
  rowId: string,
  userId: string,
  status: "error" | "expired",
  code: ProviderOAuthErrorCode,
  detail?: string,
): Promise<void> {
  const message = detail
    ? `${PROVIDER_OAUTH_ERROR_MESSAGES[code]} (${detail})`
    : PROVIDER_OAUTH_ERROR_MESSAGES[code];
  await db
    .prepare(
      `UPDATE provider_oauth
       SET status = ?, error = ?, error_code = ?, encrypted_flow_secret = NULL, encrypted_tokens = NULL,
           has_tokens = 0, verification_uri = NULL, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(status, message, code, nowSeconds(), rowId, userId)
    .run();
}

/** A vendor's `error` parameter is attacker-controllable text; keep only a short RFC 6749 token. */
function safeVendorCode(value: string): string | undefined {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

/**
 * Finish a web redirect flow for the signed-in user.
 *
 * The state is looked up only among this user's sealed pending flows and compared in constant
 * time, so another user's state, a forged one and a replayed one all miss. A match is consumed
 * by a conditional update before any exchange: of two callbacks racing on one state, exactly one
 * reaches the token endpoint.
 */
export async function completeWebProviderOAuthCallback(
  env: { DB: D1Database; ACTION_SECRET_KEY?: string },
  input: WebProviderOAuthCallbackInput,
): Promise<WebProviderOAuthCallbackResult> {
  if (!input.state) return { status: "error", code: "PROVIDER_OAUTH_STATE_INVALID" };
  const secretKey = env.ACTION_SECRET_KEY;
  if (!secretKey) return { status: "error", code: "PROVIDER_OAUTH_NOT_CONFIGURED" };

  const candidates = await env.DB
    .prepare(
      `SELECT id, provider_id, status, expires_at, encrypted_flow_secret
       FROM provider_oauth
       WHERE user_id = ? AND callback_type = 'web' AND encrypted_flow_secret IS NOT NULL`,
    )
    .bind(input.userId)
    .all<CandidateRow>();

  let match: { row: CandidateRow; secret: WebFlowSecret } | undefined;
  for (const row of candidates.results ?? []) {
    let secret: WebFlowSecret | null = null;
    try {
      secret = parseWebFlowSecret(
        await decryptSecretJson(row.encrypted_flow_secret, secretKey, PROVIDER_OAUTH_FLOW_SALT),
      );
    } catch {
      secret = null;
    }
    if (!secret) {
      // Sealed under another key or corrupted: it can never complete, so say so on the row rather
      // than leave it pending.
      await failRow(env.DB, row.id, input.userId, "error", "PROVIDER_OAUTH_STATE_INVALID", "unreadable pending state");
      continue;
    }
    if (oauthStatesMatch(input.state, secret.state)) {
      match = { row, secret };
      break;
    }
  }
  if (!match) return { status: "error", code: "PROVIDER_OAUTH_STATE_INVALID" };

  const { row, secret } = match;
  const providerId = row.provider_id as ProviderOAuthId;
  const now = nowSeconds();
  if (statusValue(row.status) !== "pending" || row.expires_at === null || row.expires_at <= now) {
    await failRow(env.DB, row.id, input.userId, "expired", "PROVIDER_OAUTH_STATE_EXPIRED");
    return { status: "error", code: "PROVIDER_OAUTH_STATE_EXPIRED", providerId };
  }

  const claimed = await env.DB
    .prepare(
      `UPDATE provider_oauth SET encrypted_flow_secret = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending' AND encrypted_flow_secret = ?`,
    )
    .bind(now, row.id, input.userId, row.encrypted_flow_secret)
    .run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    return { status: "error", code: "PROVIDER_OAUTH_STATE_INVALID", providerId };
  }

  const fail = async (code: ProviderOAuthErrorCode, detail?: string) => {
    oauthLog.warn("provider_oauth.callback_failed", {
      provider_id: providerId,
      code,
      ...(detail ? { detail } : {}),
    });
    await failRow(env.DB, row.id, input.userId, "error", code, detail);
    return { status: "error" as const, code, providerId };
  };

  if (input.vendorError !== undefined) {
    const vendorCode = safeVendorCode(input.vendorError);
    return vendorCode === "access_denied"
      ? fail("PROVIDER_OAUTH_DENIED")
      : fail("PROVIDER_OAUTH_VENDOR_ERROR", vendorCode);
  }
  if (!input.code) return fail("PROVIDER_OAUTH_EXCHANGE_FAILED", "no authorization code");

  let provider: HostedOAuthProvider | null;
  try {
    provider = input.resolveProvider(providerId);
  } catch (error) {
    if (error instanceof ProviderOAuthConfigError) return fail("PROVIDER_OAUTH_NOT_CONFIGURED");
    throw error;
  }
  if (!provider) return fail("PROVIDER_OAUTH_NOT_CONFIGURED", "provider no longer offered");

  try {
    const token = await exchangeAuthorizationCode({
      tokenUrl: provider.flow.tokenUrl,
      clientId: provider.flow.clientId,
      ...(provider.flow.clientSecret ? { clientSecret: provider.flow.clientSecret } : {}),
      code: input.code,
      verifier: secret.verifier,
      redirectUri: secret.redirectUri,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    const sealedTokens = await encryptSecretJson(
      {
        accessToken: token.accessToken,
        ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
        ...(token.expiresAt !== undefined ? { expiresAt: new Date(token.expiresAt).toISOString() } : {}),
      },
      secretKey,
      PROVIDER_OAUTH_TOKENS_SALT,
    );
    // One statement: tokens and `authorized` land together or not at all.
    await env.DB
      .prepare(
        `UPDATE provider_oauth
         SET status = 'authorized', encrypted_tokens = ?, has_tokens = 1, encrypted_flow_secret = NULL,
             verification_uri = NULL, expires_at = NULL, error = NULL, error_code = NULL, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .bind(sealedTokens, nowSeconds(), row.id, input.userId)
      .run();
    return { status: "authorized", providerId };
  } catch (error) {
    if (error instanceof OAuthTokenError) {
      return fail("PROVIDER_OAUTH_EXCHANGE_FAILED", error.oauthError ?? (error.status ? `HTTP ${error.status}` : "token endpoint unreachable"));
    }
    oauthLog.error("provider_oauth.callback_unexpected", { provider_id: providerId, error });
    return fail("PROVIDER_OAUTH_EXCHANGE_FAILED");
  }
}
