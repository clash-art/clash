/**
 * Short-lived gateway tokens (#346; guide: apps/docs/guide/gateway-tokens.md).
 *
 * `sk_gw_<id>.<secret>` is minted from a Better Auth session or a `clsh_` API
 * token (the parent) and lives 15 minutes; renewal extends it while that same
 * parent is still valid. D1 keeps only the SHA-256 of the whole token plus
 * scope, model allowlist and the parent reference (`gateway_token`, 0032 +
 * 0033). Verification derives userId/tenantId/keyId from the stored row only:
 * no header (x-user-id included) is ever read as identity.
 *
 * Time: D1 columns are unix seconds; gateway-core (`GatewayClock`) is epoch
 * milliseconds. Conversion happens here and nowhere else. Errors are coded
 * `GatewayError`s whose messages and details never carry the token.
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  GatewayError,
  gatewayErrorResponseInit,
  toGatewayError,
  type GatewayClock,
  type GatewayCredentialScope,
  type GatewayIdentity,
  type GatewayIdentityPort,
} from "@clash/gateway-core";
import {
  TOKEN_TOUCH_INTERVAL_S,
  shouldTouchToken,
} from "@clash/shared-runtime/project-authorization";

import {
  GATEWAY_TOKEN_SCOPES,
  type GatewayTokenScope,
} from "../domain/requests";
import { serverLog } from "../logger";
import { sha256Hex } from "./api-token";

export { GATEWAY_TOKEN_SCOPES, type GatewayTokenScope };

const log = serverLog.child("gateway-tokens");

export const GATEWAY_TOKEN_PREFIX = "sk_gw_";
export const GATEWAY_TOKEN_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_GATEWAY_TOKEN_SCOPES: readonly GatewayTokenScope[] = [
  "models:invoke",
];

const TOKEN_PATTERN = /^sk_gw_([0-9a-f]{24})\.([0-9a-f]{64})$/;
const ROW_ID_PREFIX = "gwt_";

export type GatewayTokenParentKind = "session" | "api_token";

/** The credential a token was minted from: sessions.id or api_token.id. */
export interface GatewayTokenParent {
  kind: GatewayTokenParentKind;
  id: string;
}

export interface GatewayTokenIdentity extends GatewayIdentity {
  /** The gateway token row id (`gwt_…`); also `GatewayIdentity.keyId`. */
  keyId: string;
  scopes: readonly GatewayTokenScope[];
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface GatewayTokenRequirements {
  /** The tenant the route serves; a token of another tenant is GATEWAY_FORBIDDEN. */
  tenantId?: string;
  scope?: GatewayTokenScope;
  /** Model code the request asks for; checked against the allowlist. */
  model?: string;
}

export const personalTenantId = (userId: string) => `personal:${userId}`;

/**
 * SQL for the key a `gateway_token` row (alias `t`) is counted and suspended
 * as by abuse signals (#356, `GatewayIdentity.abuseKeyId`): its virtual key,
 * else its `clsh_` parent, else the token itself. A session parent is not a
 * key: each short-lived token stands alone, and its tenant is suspended instead.
 */
export const gatewayAbuseKeySql = (t: string) =>
  `COALESCE(${t}.key_id, CASE WHEN ${t}.parent_kind = 'api_token' THEN ${t}.parent_id END, ${t}.id)`;

const seconds = (ms: number) => Math.floor(ms / 1000);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

function forbidden(reason: string): GatewayError {
  return new GatewayError("GATEWAY_FORBIDDEN", { details: { reason } });
}

function parseJsonList(value: string | null): string[] | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** The bearer credential, or GATEWAY_AUTH_REQUIRED when absent or not an sk_gw_ token. */
export function readGatewayBearer(request: Request): string {
  const match = /^Bearer[\t ]+(\S+)$/i.exec(
    (request.headers.get("authorization") ?? "").trim(),
  );
  const token = match?.[1];
  if (!token) throw new GatewayError("GATEWAY_AUTH_REQUIRED");
  if (!TOKEN_PATTERN.test(token))
    throw new GatewayError("GATEWAY_AUTH_REQUIRED", {
      message: "The gateway credential is malformed.",
      details: { reason: "malformed" },
    });
  return token;
}

export interface MintGatewayTokenInput {
  userId: string;
  parent: GatewayTokenParent;
  /** Defaults to the caller's personal tenant, created on first use. */
  tenantId?: string;
  scopes?: readonly GatewayTokenScope[];
  /** null: the whole published catalog. */
  modelAllowlist?: readonly string[] | null;
}

export interface MintedGatewayToken {
  token: string;
  keyId: string;
  tenantId: string;
  scopes: readonly GatewayTokenScope[];
  modelAllowlist: readonly string[] | null;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface GatewayTokenStoreOptions {
  clock?: GatewayClock;
}

export function createGatewayTokenStore(
  db: D1Database,
  options: GatewayTokenStoreOptions = {},
) {
  const clock = options.clock ?? { now: () => Date.now() };

  async function mint(input: MintGatewayTokenInput): Promise<MintedGatewayToken> {
    const now = clock.now();
    const nowS = seconds(now);
    const expiresS = seconds(now + GATEWAY_TOKEN_TTL_MS);
    const tenantId = input.tenantId ?? personalTenantId(input.userId);
    const scopes = [...new Set(input.scopes ?? DEFAULT_GATEWAY_TOKEN_SCOPES)];
    const modelAllowlist = input.modelAllowlist
      ? [...new Set(input.modelAllowlist)]
      : null;
    const publicId = randomHex(12);
    const token = `${GATEWAY_TOKEN_PREFIX}${publicId}.${randomHex(32)}`;
    const keyId = `${ROW_ID_PREFIX}${publicId}`;

    const statements = [];
    if (tenantId === personalTenantId(input.userId))
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO tenant (id, owner_user_id, name, created_at, updated_at)
             VALUES (?, ?, 'Personal workspace', ?, ?)`,
          )
          .bind(tenantId, input.userId, nowS, nowS),
        db
          .prepare(
            `INSERT OR IGNORE INTO tenant_member (tenant_id, user_id, role, created_at, updated_at)
             VALUES (?, ?, 'owner', ?, ?)`,
          )
          .bind(tenantId, input.userId, nowS, nowS),
      );
    // A token is only ever minted into a tenant the caller belongs to.
    statements.push(
      db
        .prepare(
          `INSERT INTO gateway_token
             (id, token_hash, tenant_id, user_id, scopes_json, model_allowlist_json,
              credential_scope, expires_at, created_at, parent_kind, parent_id)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'official', ?7, ?8, ?9, ?10
            WHERE EXISTS (SELECT 1 FROM tenant_member WHERE tenant_id = ?3 AND user_id = ?4)`,
        )
        .bind(
          keyId,
          await sha256Hex(token),
          tenantId,
          input.userId,
          JSON.stringify(scopes),
          modelAllowlist ? JSON.stringify(modelAllowlist) : null,
          expiresS,
          nowS,
          input.parent.kind,
          input.parent.id,
        ),
    );
    const results = await db.batch(statements);
    if (results.at(-1)?.meta.changes !== 1) throw forbidden("tenant_membership");
    return {
      token,
      keyId,
      tenantId,
      scopes,
      modelAllowlist,
      expiresAt: expiresS * 1000,
    };
  }

  /** Extend a live token by one TTL; only its own parent credential may do so. */
  async function renew(input: {
    keyId: string;
    userId: string;
    parent: GatewayTokenParent;
  }): Promise<{ keyId: string; expiresAt: number }> {
    const now = clock.now();
    const expiresS = seconds(now + GATEWAY_TOKEN_TTL_MS);
    const updated = await db
      .prepare(
        `UPDATE gateway_token SET expires_at = ?1
          WHERE id = ?2 AND user_id = ?3 AND parent_kind = ?4 AND parent_id = ?5
            AND revoked_at IS NULL AND expires_at > ?6`,
      )
      .bind(
        expiresS,
        input.keyId,
        input.userId,
        input.parent.kind,
        input.parent.id,
        seconds(now),
      )
      .run();
    if (updated.meta.changes === 1)
      return { keyId: input.keyId, expiresAt: expiresS * 1000 };

    const row = await db
      .prepare(
        `SELECT parent_kind, parent_id, revoked_at, expires_at
           FROM gateway_token WHERE id = ? AND user_id = ? LIMIT 1`,
      )
      .bind(input.keyId, input.userId)
      .first<{
        parent_kind: string | null;
        parent_id: string | null;
        revoked_at: number | null;
        expires_at: number;
      }>();
    if (
      !row ||
      row.parent_kind !== input.parent.kind ||
      row.parent_id !== input.parent.id
    )
      throw forbidden("parent_mismatch");
    if (row.revoked_at !== null) throw new GatewayError("GATEWAY_TOKEN_REVOKED");
    throw new GatewayError("GATEWAY_TOKEN_EXPIRED");
  }

  /** Revoke one of the caller's tokens; repeating it is a no-op. */
  async function revoke(input: { keyId: string; userId: string }): Promise<void> {
    const result = await db
      .prepare(
        `UPDATE gateway_token SET revoked_at = COALESCE(revoked_at, ?1)
          WHERE id = ?2 AND user_id = ?3`,
      )
      .bind(seconds(clock.now()), input.keyId, input.userId)
      .run();
    if (result.meta.changes !== 1) throw forbidden("not_owner");
  }

  /**
   * Verify the request's sk_gw_ bearer in one D1 query: token row, parent
   * liveness, tenant membership and budget ids together. ?2 is epoch ms
   * because Better Auth's sessions.expires_at is; every gateway column is
   * seconds (?3).
   */
  async function verify(
    request: Request,
    requirements: GatewayTokenRequirements = {},
  ): Promise<GatewayTokenIdentity> {
    const token = readGatewayBearer(request);
    const now = clock.now();
    const nowS = seconds(now);
    const hash = await sha256Hex(token);
    const row = await db
      .prepare(
        `SELECT t.id, t.tenant_id, t.user_id, t.scopes_json, t.model_allowlist_json,
                t.credential_scope, t.expires_at, t.revoked_at, t.last_used_at,
                ${gatewayAbuseKeySql("t")} AS abuse_key_id,
                CASE t.parent_kind
                  WHEN 'session' THEN EXISTS (
                    SELECT 1 FROM sessions s
                     WHERE s.id = t.parent_id AND s.user_id = t.user_id AND s.expires_at > ?2)
                  WHEN 'api_token' THEN EXISTS (
                    SELECT 1 FROM api_token a
                     WHERE a.id = t.parent_id AND a.user_id = t.user_id)
                  ELSE t.key_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM gateway_key k
                     WHERE k.id = t.key_id AND k.user_id = t.user_id
                       AND k.tenant_id = t.tenant_id AND k.revoked_at IS NULL
                       AND (k.expires_at IS NULL OR k.expires_at > ?3))
                  END AS parent_live,
                EXISTS (
                  SELECT 1 FROM tenant_member m
                   WHERE m.tenant_id = t.tenant_id AND m.user_id = t.user_id) AS member,
                (SELECT json_group_array(b.id) FROM gateway_budget b
                  WHERE b.tenant_id = t.tenant_id
                    AND ((b.scope = 'tenant' AND b.scope_id = t.tenant_id)
                      OR (b.scope = 'user' AND b.scope_id = t.user_id)
                      OR (b.scope = 'key' AND b.scope_id = t.key_id))) AS budget_ids
           FROM gateway_token t WHERE t.token_hash = ?1 LIMIT 1`,
      )
      .bind(hash, now, nowS)
      .first<{
        id: string;
        tenant_id: string;
        user_id: string;
        scopes_json: string;
        model_allowlist_json: string | null;
        credential_scope: GatewayCredentialScope;
        expires_at: number;
        revoked_at: number | null;
        last_used_at: number | null;
        abuse_key_id: string;
        parent_live: number;
        member: number;
        budget_ids: string;
      }>();
    if (!row)
      throw new GatewayError("GATEWAY_AUTH_REQUIRED", {
        message: "The gateway credential is not recognized.",
        details: { reason: "unknown" },
      });
    // A signed-out session or deleted clsh_ token takes its children with it.
    if (row.revoked_at !== null || !row.parent_live)
      throw new GatewayError("GATEWAY_TOKEN_REVOKED", { details: { keyId: row.id } });
    if (row.expires_at <= nowS)
      throw new GatewayError("GATEWAY_TOKEN_EXPIRED", { details: { keyId: row.id } });
    if (!row.member) throw forbidden("tenant_membership");
    if (requirements.tenantId !== undefined && requirements.tenantId !== row.tenant_id)
      throw forbidden("tenant_mismatch");

    const scopes = (parseJsonList(row.scopes_json) ?? []).filter(
      (scope): scope is GatewayTokenScope =>
        (GATEWAY_TOKEN_SCOPES as readonly string[]).includes(scope),
    );
    if (requirements.scope && !scopes.includes(requirements.scope))
      throw new GatewayError("GATEWAY_FORBIDDEN", {
        details: { reason: "scope", scope: requirements.scope },
      });
    const modelAllowlist = parseJsonList(row.model_allowlist_json);
    if (
      requirements.model !== undefined &&
      modelAllowlist !== null &&
      !modelAllowlist.includes(requirements.model)
    )
      throw new GatewayError("GATEWAY_MODEL_NOT_ALLOWED", {
        details: { param: "model" },
      });

    if (shouldTouchToken(row.last_used_at == null ? null : row.last_used_at * 1000, now))
      db.prepare(
        `UPDATE gateway_token SET last_used_at = ?1
          WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?1 - ?3)`,
      )
        .bind(nowS, row.id, TOKEN_TOUCH_INTERVAL_S)
        .run()
        .catch(() => {});

    return {
      tenantId: row.tenant_id,
      userId: row.user_id,
      keyId: row.id,
      ...(row.abuse_key_id !== row.id ? { abuseKeyId: row.abuse_key_id } : {}),
      ...(modelAllowlist ? { modelAllowlist } : {}),
      budgetIds: parseJsonList(row.budget_ids) ?? [],
      credentialScope: row.credential_scope,
      scopes,
      expiresAt: row.expires_at * 1000,
    };
  }

  return { mint, renew, revoke, verify };
}

export type GatewayTokenStore = ReturnType<typeof createGatewayTokenStore>;

/**
 * Coded JSON error answer (OpenAI error shape, `x-clash-error-code`). Only the
 * code and the error class are logged: never the request, token or message.
 */
export function gatewayErrorResponse(error: unknown): Response {
  const coded = toGatewayError(error);
  if (coded.code === "GATEWAY_INTERNAL")
    log.error("gateway.token_internal", {
      code: coded.code,
      cause: coded.cause instanceof Error ? coded.cause.name : typeof coded.cause,
    });
  const init = gatewayErrorResponseInit(coded, "openai");
  return new Response(JSON.stringify(init.body), {
    status: init.status,
    headers: { ...init.headers, "cache-control": "no-store" },
  });
}

/** gateway-core identity port backed by D1 `gateway_token` rows. */
export function createD1GatewayIdentityPort(
  db: D1Database,
  options: GatewayTokenStoreOptions = {},
): GatewayIdentityPort & { verify: GatewayTokenStore["verify"] } {
  const store = createGatewayTokenStore(db, options);
  return {
    authenticate: (request) => store.verify(request),
    verify: store.verify,
  };
}
