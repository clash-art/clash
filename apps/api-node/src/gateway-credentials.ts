/**
 * Postgres upstream credential store for the Node gateway (#366), over the
 * #362 `gateway_upstream_credential` table and the key ring
 * (gateway-keyring.ts).
 *
 * - Scope: an official (platform) credential is global (`tenant_key ''`), a
 *   tenant (BYOK) credential belongs to exactly one tenant (0017 CHECK). Every
 *   read filters by scope *and* tenant, and the envelope's additional data and
 *   derived key are scope-bound, so the two never mix even if a row is edited.
 * - Current kid: `gateway_config['encryption.current']` (set by the audited
 *   admin rotation, gateway-key-admin.ts) wins over GATEWAY_ENCRYPTION_CURRENT.
 *   It is read from Postgres on every seal/resolve, so after a rotation the
 *   next request on any node seals under the new kid; requests already in
 *   flight hold their decrypted credential, and old kids stay in the ring, so
 *   they finish under the old key.
 * - Lazy re-encrypt: a resolve that opens a v1 envelope, or a v2 envelope under
 *   a non-current kid, reseals it under the current kid with a compare-and-set
 *   UPDATE (a concurrent writer wins; the reseal is best effort).
 *
 * Failures are GATEWAY_KEY_UNAVAILABLE with a reason; never key material.
 */

import { randomUUID } from "node:crypto";
import {
  GatewayError,
  type GatewayCredentialPort,
  type GatewayCredentialScope,
  type GatewayUpstreamCredential,
} from "@clash/gateway-core";
import {
  cleanProviderCredentials,
  type ProviderCredentials,
} from "@clash/shared-runtime/provider-credentials";
import { z } from "zod";
import type { GatewayBudgetSqlClient } from "./gateway-budget.ts";
import {
  envelopeKid,
  GatewayKeyRingError,
  type EnvelopeContext,
  type GatewayKeyRing,
} from "./gateway-keyring.ts";

export const GATEWAY_ENCRYPTION_CURRENT_CONFIG_KEY = "encryption.current";
const CurrentConfigSchema = z.object({ kid: z.string().min(1) });

export const tenantKeyOf = (scope: GatewayCredentialScope, tenantId: string) =>
  scope === "official" ? "" : tenantId;

function unavailable(reason: string, credentialId?: string): GatewayError {
  return new GatewayError("GATEWAY_KEY_UNAVAILABLE", {
    details: { ...(credentialId ? { credentialId } : {}), reason },
  });
}

/** The kid new envelopes use: Postgres override, else the env default. */
export async function currentEncryptionKid(
  db: GatewayBudgetSqlClient,
  ring: GatewayKeyRing,
): Promise<string | undefined> {
  const { rows } = await db.query<{ value: unknown }>(
    "SELECT value FROM gateway_config WHERE key = $1",
    [GATEWAY_ENCRYPTION_CURRENT_CONFIG_KEY],
  );
  if (!rows[0]) return ring.defaultCurrent;
  const parsed = CurrentConfigSchema.safeParse(rows[0].value);
  if (!parsed.success) throw unavailable("current_kid_config_invalid");
  return parsed.data.kid;
}

async function sealCurrent(
  db: GatewayBudgetSqlClient,
  ring: GatewayKeyRing,
  value: ProviderCredentials,
  context: EnvelopeContext,
): Promise<{ envelope: string; kid: string }> {
  const kid = await currentEncryptionKid(db, ring);
  if (!kid || !ring.has(kid))
    throw new GatewayError("GATEWAY_ENCRYPTION_KEY_MISSING");
  return { envelope: await ring.seal(value, context, kid), kid };
}

export interface PutUpstreamCredentialInput {
  id?: string;
  scope: GatewayCredentialScope;
  /** Required for tenant scope; must be absent/empty for official. */
  tenantId?: string;
  providerId: string;
  upstreamId?: string;
  accountId?: string;
  region?: string;
  label?: string;
  /** Upstream credential version (#350 rotation), not the envelope kid. */
  keyVersion?: string;
  credentials: ProviderCredentials;
  priority?: number;
  weight?: number;
}

export interface GatewayCredentialStore extends GatewayCredentialPort {
  /** Seal and upsert one credential; returns its id. Never returns the secret. */
  put(input: PutUpstreamCredentialInput): Promise<{ id: string; kid: string }>;
  /** Reseal up to `limit` envelopes not under the current kid; returns how many changed. */
  reencrypt(input?: {
    limit?: number;
  }): Promise<{ resealed: number; failed: number; skipped: number }>;
}

interface CredentialRow extends Record<string, unknown> {
  id: string;
  scope: GatewayCredentialScope;
  tenant_key: string;
  provider_id: string;
  upstream_id: string;
  encrypted_credentials: string;
  key_version: string;
}

export function createPgGatewayCredentialStore(deps: {
  db: GatewayBudgetSqlClient;
  ring: GatewayKeyRing;
  now?: () => number;
}): GatewayCredentialStore {
  const { db, ring } = deps;
  const now = deps.now ?? Date.now;
  const contextOf = (row: CredentialRow): EnvelopeContext => ({
    scope: row.scope,
    tenantKey: row.tenant_key,
    credentialId: row.id,
  });

  async function reseal(
    row: CredentialRow,
    value: ProviderCredentials,
  ): Promise<boolean> {
    const { envelope } = await sealCurrent(db, ring, value, contextOf(row));
    const { rows } = await db.query<{ id: string }>(
      `UPDATE gateway_upstream_credential SET encrypted_credentials = $1, updated_at = $2
        WHERE id = $3 AND encrypted_credentials = $4 RETURNING id`,
      [envelope, now(), row.id, row.encrypted_credentials],
    );
    return rows.length === 1;
  }

  async function resealedElsewhere(id: string, kid: string): Promise<boolean> {
    const { rows } = await db.query<{ encrypted_credentials: string }>(
      "SELECT encrypted_credentials FROM gateway_upstream_credential WHERE id = $1",
      [id],
    );
    return !!rows[0] && envelopeKid(rows[0].encrypted_credentials) === kid;
  }

  async function open(row: CredentialRow) {
    try {
      return await ring.open(row.encrypted_credentials, contextOf(row));
    } catch (error) {
      throw unavailable(
        error instanceof GatewayKeyRingError ? error.reason : "decrypt_failed",
        row.id,
      );
    }
  }

  return {
    async resolve({
      route,
      scope,
      tenantId,
      excludeKeyVersions = [],
    }): Promise<GatewayUpstreamCredential> {
      if (!route.accountId) throw unavailable("no_account");
      if (scope === "tenant" && !tenantId) throw unavailable("scope");
      const { rows } = await db.query<CredentialRow>(
        `SELECT id, scope, tenant_key, provider_id, upstream_id, encrypted_credentials, key_version
           FROM gateway_upstream_credential
          WHERE id = $1 AND scope = $2 AND tenant_key = $3 AND enabled = 1`,
        [route.accountId, scope, tenantKeyOf(scope, tenantId)],
      );
      const row = rows[0];
      // A row in the other scope (or another tenant) is indistinguishable from none.
      if (!row) throw unavailable("account_unavailable", route.accountId);
      if (
        (route.providerId && row.provider_id !== route.providerId) ||
        (row.upstream_id && row.upstream_id !== route.upstreamId)
      )
        throw unavailable("route_mismatch", row.id);
      if (excludeKeyVersions.includes(row.key_version))
        throw unavailable("no_key_version", row.id);
      const opened = await open(row);
      const credentials = cleanProviderCredentials(opened.value);
      if (!credentials?.apiKey) throw unavailable("api_key_missing", row.id);
      const current = await currentEncryptionKid(db, ring).catch(
        () => undefined,
      );
      if (
        current &&
        ring.has(current) &&
        (opened.format === "v1" || opened.kid !== current)
      ) {
        await reseal(row, credentials).catch(() => false);
      }
      return {
        apiKey: credentials.apiKey,
        ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
        keyId: row.id,
        keyVersion: row.key_version,
      };
    },

    async put(input) {
      const tenantKey =
        input.scope === "official" ? "" : (input.tenantId ?? "");
      if (input.scope === "official" && input.tenantId)
        throw new GatewayError("GATEWAY_INVALID_REQUEST", {
          details: { reason: "official_has_tenant" },
        });
      if (input.scope === "tenant" && !tenantKey)
        throw new GatewayError("GATEWAY_INVALID_REQUEST", {
          details: { reason: "tenant_required" },
        });
      const credentials = cleanProviderCredentials(input.credentials);
      if (!credentials?.apiKey)
        throw new GatewayError("GATEWAY_INVALID_REQUEST", {
          details: { reason: "api_key_missing" },
        });
      const dims = [
        tenantKey,
        input.scope,
        input.providerId,
        input.upstreamId ?? "",
        input.accountId ?? "",
        input.region ?? "",
      ];
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM gateway_upstream_credential
          WHERE tenant_key = $1 AND scope = $2 AND provider_id = $3 AND upstream_id = $4
            AND account_id = $5 AND region = $6`,
        dims,
      );
      const id =
        existing.rows[0]?.id ??
        input.id ??
        `guc_${randomUUID().replaceAll("-", "")}`;
      const { envelope, kid } = await sealCurrent(db, ring, credentials, {
        scope: input.scope,
        tenantKey,
        credentialId: id,
      });
      const at = now();
      await db.query(
        `INSERT INTO gateway_upstream_credential
           (id, tenant_key, scope, provider_id, upstream_id, account_id, region, label,
            encrypted_credentials, key_version, enabled, priority, weight, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$13)
         ON CONFLICT (id) DO UPDATE SET label = excluded.label,
           encrypted_credentials = excluded.encrypted_credentials, key_version = excluded.key_version,
           priority = excluded.priority, weight = excluded.weight, updated_at = excluded.updated_at`,
        [
          id,
          ...dims,
          input.label ?? null,
          envelope,
          input.keyVersion ?? "1",
          input.priority ?? null,
          input.weight ?? null,
          at,
        ],
      );
      return { id, kid };
    },

    async reencrypt({ limit = 100 } = {}) {
      const current = await currentEncryptionKid(db, ring);
      if (!current || !ring.has(current))
        throw new GatewayError("GATEWAY_ENCRYPTION_KEY_MISSING");
      const { rows } = await db.query<CredentialRow>(
        `SELECT id, scope, tenant_key, provider_id, upstream_id, encrypted_credentials, key_version
           FROM gateway_upstream_credential
          WHERE encrypted_credentials NOT LIKE $1 ORDER BY id LIMIT $2`,
        [`v2.${current.replaceAll("_", "\\_")}.%`, limit],
      );
      let resealed = 0;
      let failed = 0;
      // Lost the compare-and-set to a concurrent worker or a lazy re-seal on
      // read (#379, seen on real Postgres): the row is done, not failed.
      let skipped = 0;
      for (const row of rows) {
        if (envelopeKid(row.encrypted_credentials) === current) continue;
        try {
          const credentials = cleanProviderCredentials((await open(row)).value);
          if (credentials && (await reseal(row, credentials))) resealed += 1;
          else if (credentials && (await resealedElsewhere(row.id, current))) skipped += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      return { resealed, failed, skipped };
    },
  };
}
