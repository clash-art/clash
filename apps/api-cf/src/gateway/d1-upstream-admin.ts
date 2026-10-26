/**
 * Official upstream account administration (`gateway_upstream_account`;
 * guide: apps/docs/guide/gateway-admin.md). Accounts are created, edited,
 * enabled/disabled, rotated and their key versions revoked here;
 * d1-credentials.ts resolves them for the data plane.
 *
 * Secrets are write-only. A key version is either a `GATEWAY_UPSTREAM_*`
 * Worker secret / Secrets Store binding name (`secret_ref`) or an API key
 * sealed at once under GATEWAY_ENCRYPTION_KEY (`encrypted_credentials`). No
 * view, response, audit snapshot or error ever carries the key or its
 * envelope: views report the credential kind, field names, key version and
 * the key's first characters (`keyPrefix`, never in audit rows).
 *
 * Rotation (#350, 0043): `rotate` adds version N+1 as the active key. By
 * default the previous active version keeps draining (the data plane retries
 * it when the new key is refused) until `revokeKey` removes it; `drain: false`
 * revokes every previous version at once (a leaked key). Revoking the active
 * version while one drains rolls back to it. Version numbers are never reused
 * (`key_serial`). Each change is one D1 batch with its audit row and resets
 * the account's circuit, since its failures were the old key's.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { GatewayError, gatewayCircuitState, type GatewayClock } from "@clash/gateway-core";

import { adminAuditStatement, type GatewayAdminActor } from "./d1-admin-audit";
import type { RateLimitConfig } from "./d1-billing";
import { numberRecord, parseJson, stringList, toMs, toSeconds } from "./d1-common";
import {
  secretRefCredentials,
  sealGatewayUpstreamCredentials,
  type GatewayCredentialSecrets,
} from "./d1-credentials";
import { HEALTH_COLUMNS, healthOf, type HealthRow } from "./d1-upstream-health";

export type UpstreamCredentialInput = { secretRef: string } | { apiKey: string; baseUrl?: string };

export interface UpstreamFields {
  label?: string | null;
  enabled?: boolean;
  region?: string;
  priority?: number | null;
  weight?: number | null;
  supportedModelIds?: string[] | null;
  modelPriorities?: Record<string, number> | null;
  rateLimit?: RateLimitConfig | null;
}

/** One key version as an admin sees it: never the key. */
export interface UpstreamKeyVersionView {
  keyVersion: string;
  kind: "secret_ref" | "sealed";
  /** The Worker secret / Secrets Store binding name; a name, never the secret. */
  secretRef: string | null;
  /** Non-secret credential field names, e.g. ["apiKey", "baseUrl"]. */
  fields: string[];
  /** The key's first characters; null for a short key or an unbound secret. */
  keyPrefix: string | null;
  /** For a secret_ref: whether the binding currently resolves to a value. */
  secretPresent?: boolean;
}

export interface UpstreamAccountView {
  id: string;
  providerId: string;
  upstreamId: string;
  apiShape: string | null;
  region: string;
  label: string | null;
  enabled: boolean;
  priority: number | null;
  weight: number | null;
  supportedModelIds: string[] | null;
  modelPriorities: Record<string, number> | null;
  rateLimit: RateLimitConfig | null;
  /** The active key version (sent first). */
  credential: UpstreamKeyVersionView & { rotatedAt: string | null };
  /** The previous version while a rotation drains; null otherwise. */
  draining: (UpstreamKeyVersionView & { since: string | null }) | null;
  /** The version the next rotation adds; revoked numbers are never reused. */
  nextKeyVersion: string;
  /** Circuit-breaker state (operational, never request data); null when nothing is on record. */
  health: {
    state: "closed" | "open" | "half_open";
    consecutiveFailures: number;
    openUntil: string | null;
    lastFailureCode: string | null;
    lastFailureAt: string | null;
    lastSuccessAt: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

interface AccountRow {
  id: string;
  provider_id: string;
  upstream_id: string;
  api_shape: string | null;
  region: string;
  label: string | null;
  enabled: number;
  priority: number | null;
  weight: number | null;
  supported_model_ids_json: string | null;
  model_priorities_json: string | null;
  secret_ref: string | null;
  configured_credentials: string | null;
  key_version: string;
  key_prefix: string | null;
  key_serial: number;
  draining_key_version: string | null;
  draining_secret_ref: string | null;
  draining_configured_credentials: string | null;
  draining_key_prefix: string | null;
  draining_since: number | null;
  rate_limit_json: string | null;
  rotated_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Every column but the envelopes: a sealed key is never read back for display. */
const VIEW_COLUMNS = `id, provider_id, upstream_id, api_shape, region, label, enabled, priority, weight,
  supported_model_ids_json, model_priorities_json, secret_ref, configured_credentials, key_version,
  key_prefix, key_serial, draining_key_version, draining_secret_ref, draining_configured_credentials,
  draining_key_prefix, draining_since, rate_limit_json, rotated_at, created_at, updated_at`;

const iso = (seconds: number) => new Date(toMs(seconds)).toISOString();
const keyVersionOf = (serial: number) => `v${serial}`;
const isoMs = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

/**
 * The first characters an admin may see to tell keys apart: at most 8 and at
 * most a quarter of the key, none for a key under 16 characters.
 */
export function upstreamKeyPrefix(apiKey: string): string | null {
  const key = apiKey.trim();
  return key.length < 16 ? null : key.slice(0, Math.min(8, Math.floor(key.length / 4)));
}

function keyView(columns: {
  version: string;
  secretRef: string | null;
  configured: string | null;
  prefix: string | null;
}): UpstreamKeyVersionView {
  return {
    keyVersion: columns.version,
    kind: columns.secretRef ? "secret_ref" : "sealed",
    secretRef: columns.secretRef,
    fields: stringList(columns.configured) ?? [],
    keyPrefix: columns.prefix,
  };
}

function accountView(row: AccountRow): UpstreamAccountView {
  return {
    id: row.id,
    providerId: row.provider_id,
    upstreamId: row.upstream_id,
    apiShape: row.api_shape,
    region: row.region,
    label: row.label,
    enabled: row.enabled === 1,
    priority: row.priority,
    weight: row.weight,
    supportedModelIds: stringList(row.supported_model_ids_json) ?? null,
    modelPriorities: numberRecord(row.model_priorities_json) ?? null,
    rateLimit: (parseJson(row.rate_limit_json) as RateLimitConfig | undefined) ?? null,
    credential: {
      ...keyView({ version: row.key_version, secretRef: row.secret_ref, configured: row.configured_credentials, prefix: row.key_prefix }),
      rotatedAt: row.rotated_at === null ? null : iso(row.rotated_at),
    },
    draining: row.draining_key_version
      ? {
          ...keyView({
            version: row.draining_key_version,
            secretRef: row.draining_secret_ref,
            configured: row.draining_configured_credentials,
            prefix: row.draining_key_prefix,
          }),
          since: row.draining_since === null ? null : iso(row.draining_since),
        }
      : null,
    nextKeyVersion: keyVersionOf(row.key_serial + 1),
    health: null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** A key version for an audit snapshot: kind, binding name, fields and version; never a prefix. */
function auditKey(key: UpstreamKeyVersionView | null) {
  return key && { kind: key.kind, secretRef: key.secretRef, fields: key.fields, keyVersion: key.keyVersion };
}

/** The audit snapshot: the view without timestamps, health or key prefixes (it never holds a secret). */
function snapshot(view: UpstreamAccountView) {
  const { createdAt: _created, updatedAt: _updated, health: _health, nextKeyVersion: _next, credential, draining, ...rest } = view;
  return { ...rest, credential: { ...auditKey(credential), rotatedAt: credential.rotatedAt }, draining: auditKey(draining) };
}

export function createD1UpstreamAdmin(
  db: D1Database,
  deps: {
    clock: GatewayClock;
    encryptionKey?: string;
    encryptionKeyProblem?: GatewayCredentialSecrets["encryptionKeyProblem"];
    /** Reads a secret binding, to show a secret_ref's prefix and whether it is bound. */
    secret?: GatewayCredentialSecrets["secret"];
  },
) {
  const nowSeconds = () => toSeconds(deps.clock.now());

  async function row(id: string): Promise<AccountRow | null> {
    return db.prepare(`SELECT ${VIEW_COLUMNS} FROM gateway_upstream_account WHERE id = ?`).bind(id).first<AccountRow>();
  }
  async function requireRow(id: string): Promise<AccountRow> {
    const found = await row(id);
    if (!found) throw new GatewayError("GATEWAY_UPSTREAM_NOT_FOUND", { details: { accountId: id } });
    return found;
  }

  /** A secret_ref version's binding state; the value itself never leaves this function. */
  async function withSecretState<T extends UpstreamKeyVersionView>(key: T): Promise<T> {
    if (!key.secretRef || !deps.secret) return key;
    let value: string | undefined;
    try {
      value = await deps.secret(key.secretRef);
    } catch {
      value = undefined;
    }
    const apiKey = value ? secretRefCredentials(value)?.apiKey : undefined;
    return { ...key, secretPresent: apiKey !== undefined, keyPrefix: apiKey ? upstreamKeyPrefix(apiKey) : null };
  }

  /** The view an admin reads: binding state of secret refs and the circuit. */
  async function present(account: AccountRow, health: HealthRow | null): Promise<UpstreamAccountView> {
    const view = accountView(account);
    const now = deps.clock.now();
    const counters = health ? healthOf(health) : undefined;
    return {
      ...view,
      credential: await withSecretState(view.credential),
      draining: view.draining && (await withSecretState(view.draining)),
      health: counters
        ? {
            state: gatewayCircuitState(counters, now),
            consecutiveFailures: counters.consecutiveFailures,
            openUntil: isoMs(counters.openUntil),
            lastFailureCode: counters.lastFailureCode ?? null,
            lastFailureAt: isoMs(counters.lastFailureAt),
            lastSuccessAt: isoMs(counters.lastSuccessAt),
          }
        : null,
    };
  }

  async function presentId(id: string): Promise<UpstreamAccountView> {
    const account = await requireRow(id);
    const health = await db
      .prepare(`SELECT ${HEALTH_COLUMNS} FROM gateway_upstream_health WHERE account_id = ?`)
      .bind(id)
      .first<HealthRow>();
    return present(account, health);
  }

  /** Column values for a credential; a sealed key needs a distinct GATEWAY_ENCRYPTION_KEY. */
  async function credentialColumns(credential: UpstreamCredentialInput) {
    if ("secretRef" in credential)
      return { secretRef: credential.secretRef, sealed: null, fields: ["apiKey"], prefix: null };
    if (deps.encryptionKeyProblem === "shared_with_byok") throw new GatewayError("GATEWAY_ENCRYPTION_KEY_SHARED");
    if (!deps.encryptionKey) throw new GatewayError("GATEWAY_ENCRYPTION_KEY_MISSING");
    const credentials = { apiKey: credential.apiKey, ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}) };
    return {
      secretRef: null,
      sealed: await sealGatewayUpstreamCredentials(credentials, deps.encryptionKey),
      fields: Object.keys(credentials),
      prefix: upstreamKeyPrefix(credential.apiKey),
    };
  }

  /** Clears the circuit of an account whose keys changed, chained on the audit row (so on the change). */
  const resetHealth = (id: string): D1PreparedStatement =>
    db.prepare(`DELETE FROM gateway_upstream_health WHERE account_id = ? AND changes() = 1`).bind(id);

  const json = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value));

  return {
    async list(): Promise<UpstreamAccountView[]> {
      const [accounts, health] = await db.batch([
        db.prepare(
          `SELECT ${VIEW_COLUMNS} FROM gateway_upstream_account ORDER BY provider_id, upstream_id, COALESCE(priority, 1000), id`,
        ),
        db.prepare(`SELECT ${HEALTH_COLUMNS} FROM gateway_upstream_health`),
      ]);
      const healthById = new Map(((health?.results ?? []) as HealthRow[]).map((entry) => [entry.account_id, entry]));
      return Promise.all(
        ((accounts?.results ?? []) as AccountRow[]).map((account) => present(account, healthById.get(account.id) ?? null)),
      );
    },

    async create(
      input: UpstreamFields & {
        providerId: string;
        upstreamId?: string;
        apiShape?: string | null;
        credential: UpstreamCredentialInput;
        actor: GatewayAdminActor;
      },
    ): Promise<UpstreamAccountView> {
      const id = `gwu_${crypto.randomUUID().replaceAll("-", "")}`;
      const credential = await credentialColumns(input.credential);
      const nowS = nowSeconds();
      await db.batch([
        db
          .prepare(
            `INSERT INTO gateway_upstream_account
               (id, provider_id, upstream_id, api_shape, region, label, enabled, priority, weight,
                supported_model_ids_json, model_priorities_json, secret_ref, encrypted_credentials,
                configured_credentials, key_version, key_prefix, key_serial, rate_limit_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'v1', ?17, 1, ?15, ?16, ?16)`,
          )
          .bind(
            id,
            input.providerId,
            input.upstreamId ?? "",
            input.apiShape ?? null,
            input.region ?? "",
            input.label ?? null,
            input.enabled === false ? 0 : 1,
            input.priority ?? null,
            input.weight ?? null,
            json(input.supportedModelIds),
            json(input.modelPriorities),
            credential.secretRef,
            credential.sealed,
            JSON.stringify(credential.fields),
            json(input.rateLimit),
            nowS,
            credential.prefix,
          ),
        adminAuditStatement(db, {
          tenantId: "",
          actor: input.actor,
          action: "upstream.create",
          targetType: "upstream_account",
          targetId: id,
          after: {
            providerId: input.providerId,
            upstreamId: input.upstreamId ?? "",
            apiShape: input.apiShape ?? null,
            region: input.region ?? "",
            label: input.label ?? null,
            enabled: input.enabled !== false,
            priority: input.priority ?? null,
            weight: input.weight ?? null,
            supportedModelIds: input.supportedModelIds ?? null,
            modelPriorities: input.modelPriorities ?? null,
            rateLimit: input.rateLimit ?? null,
            credential: { kind: credential.secretRef ? "secret_ref" : "sealed", secretRef: credential.secretRef, fields: credential.fields, keyVersion: "v1" },
          },
          nowS,
          when: "changes() = 1",
        }),
      ]);
      return presentId(id);
    },

    /** Non-secret fields only; `enabled: false` disables the account for routing at once. */
    async update(id: string, patch: UpstreamFields, actor: GatewayAdminActor): Promise<UpstreamAccountView> {
      const before = await requireRow(id);
      const set: string[] = [];
      const values: unknown[] = [];
      const assign = (column: string, value: unknown) => {
        values.push(value);
        set.push(`${column} = ?${values.length + 2}`);
      };
      if (patch.label !== undefined) assign("label", patch.label);
      if (patch.enabled !== undefined) assign("enabled", patch.enabled ? 1 : 0);
      if (patch.region !== undefined) assign("region", patch.region);
      if (patch.priority !== undefined) assign("priority", patch.priority);
      if (patch.weight !== undefined) assign("weight", patch.weight);
      if (patch.supportedModelIds !== undefined) assign("supported_model_ids_json", json(patch.supportedModelIds));
      if (patch.modelPriorities !== undefined) assign("model_priorities_json", json(patch.modelPriorities));
      if (patch.rateLimit !== undefined) assign("rate_limit_json", json(patch.rateLimit));
      if (set.length === 0) return presentId(id);
      const nowS = nowSeconds();
      const after = { ...accountView(before) };
      const [updated] = await db.batch([
        db
          .prepare(
            `UPDATE gateway_upstream_account SET ${set.join(", ")}, updated_at = ?2
              WHERE id = ?1 AND updated_at = ?${values.length + 3}`,
          )
          .bind(id, nowS, ...values, before.updated_at),
        adminAuditStatement(db, {
          tenantId: "",
          actor,
          action: patch.enabled === false ? "upstream.disable" : patch.enabled === true && !before.enabled ? "upstream.enable" : "upstream.update",
          targetType: "upstream_account",
          targetId: id,
          before: snapshot(accountView(before)),
          after: { ...snapshot(after), ...patch },
          nowS,
          when: "changes() = 1",
        }),
      ]);
      if (!updated?.meta.changes) throw new GatewayError("GATEWAY_CONFLICT", { details: { accountId: id } });
      return presentId(id);
    },

    /**
     * Add key version N+1 as the active key. With `drain` (the default) the
     * previous active version drains until revoked, and a rotation already
     * draining is GATEWAY_UPSTREAM_ROTATION_IN_PROGRESS; `drain: false`
     * revokes every previous version at once.
     */
    async rotate(
      id: string,
      input: { credential: UpstreamCredentialInput; drain?: boolean; reason?: string; actor: GatewayAdminActor },
    ): Promise<UpstreamAccountView> {
      const before = await requireRow(id);
      const drain = input.drain !== false;
      if (drain && before.draining_key_version !== null)
        throw new GatewayError("GATEWAY_UPSTREAM_ROTATION_IN_PROGRESS", {
          details: { accountId: id, drainingKeyVersion: before.draining_key_version },
        });
      const credential = await credentialColumns(input.credential);
      const serial = Math.max(before.key_serial, 1) + 1;
      const keyVersion = keyVersionOf(serial);
      const nowS = nowSeconds();
      const view = accountView(before);
      const [rotated] = await db.batch([
        db
          .prepare(
            // SQLite evaluates every SET expression against the row before the update.
            `UPDATE gateway_upstream_account
                SET draining_key_version = CASE WHEN ?9 THEN key_version END,
                    draining_secret_ref = CASE WHEN ?9 THEN secret_ref END,
                    draining_encrypted_credentials = CASE WHEN ?9 THEN encrypted_credentials END,
                    draining_configured_credentials = CASE WHEN ?9 THEN configured_credentials END,
                    draining_key_prefix = CASE WHEN ?9 THEN key_prefix END,
                    draining_since = CASE WHEN ?9 THEN ?6 END,
                    secret_ref = ?2, encrypted_credentials = ?3, configured_credentials = ?4, key_prefix = ?10,
                    key_version = ?5, key_serial = ?8, rotated_at = ?6, updated_at = ?6
              WHERE id = ?1 AND key_version = ?7 AND draining_key_version IS ?11`,
          )
          .bind(
            id,
            credential.secretRef,
            credential.sealed,
            JSON.stringify(credential.fields),
            keyVersion,
            nowS,
            before.key_version,
            serial,
            drain ? 1 : 0,
            credential.prefix,
            before.draining_key_version,
          ),
        adminAuditStatement(db, {
          tenantId: "",
          actor: input.actor,
          action: "upstream.rotate",
          targetType: "upstream_account",
          targetId: id,
          before: { credential: auditKey(view.credential), draining: auditKey(view.draining) },
          after: {
            credential: {
              kind: credential.secretRef ? "secret_ref" : "sealed",
              secretRef: credential.secretRef,
              fields: credential.fields,
              keyVersion,
            },
            draining: drain ? auditKey(view.credential) : null,
            revoked: drain
              ? []
              : [view.credential.keyVersion, ...(view.draining ? [view.draining.keyVersion] : [])],
          },
          reason: input.reason ?? null,
          nowS,
          when: "changes() = 1",
        }),
        resetHealth(id),
      ]);
      if (!rotated?.meta.changes) throw new GatewayError("GATEWAY_CONFLICT", { details: { accountId: id } });
      return presentId(id);
    },

    /**
     * Revoke one key version. The draining version ends the drain; the active
     * one, while another drains, rolls back to the draining version. The only
     * key is never revoked (GATEWAY_UPSTREAM_LAST_KEY): rotate or disable.
     */
    async revokeKey(
      id: string,
      input: { keyVersion: string; reason?: string; actor: GatewayAdminActor },
    ): Promise<UpstreamAccountView> {
      const before = await requireRow(id);
      const view = accountView(before);
      const draining = before.draining_key_version;
      const target =
        input.keyVersion === draining ? "draining" : input.keyVersion === before.key_version ? "active" : undefined;
      if (!target)
        throw new GatewayError("GATEWAY_UPSTREAM_KEY_VERSION_NOT_FOUND", {
          details: { accountId: id, keyVersion: input.keyVersion },
        });
      if (target === "active" && draining === null)
        throw new GatewayError("GATEWAY_UPSTREAM_LAST_KEY", { details: { accountId: id, keyVersion: input.keyVersion } });
      const nowS = nowSeconds();
      const clearDraining = `draining_key_version = NULL, draining_secret_ref = NULL, draining_encrypted_credentials = NULL,
                    draining_configured_credentials = NULL, draining_key_prefix = NULL, draining_since = NULL`;
      const promote =
        target === "active"
          ? `key_version = draining_key_version, secret_ref = draining_secret_ref,
             encrypted_credentials = draining_encrypted_credentials,
             configured_credentials = draining_configured_credentials, key_prefix = draining_key_prefix,
             rotated_at = ?2,`
          : "";
      const [revoked] = await db.batch([
        db
          .prepare(
            `UPDATE gateway_upstream_account SET ${promote} ${clearDraining}, updated_at = ?2
              WHERE id = ?1 AND key_version = ?3 AND draining_key_version = ?4`,
          )
          .bind(id, nowS, before.key_version, draining),
        adminAuditStatement(db, {
          tenantId: "",
          actor: input.actor,
          action: "upstream.revoke_key",
          targetType: "upstream_account",
          targetId: id,
          before: { credential: auditKey(view.credential), draining: auditKey(view.draining) },
          after: {
            credential: auditKey(target === "active" ? view.draining : view.credential),
            draining: null,
            revoked: [input.keyVersion],
          },
          reason: input.reason ?? null,
          nowS,
          when: "changes() = 1",
        }),
        resetHealth(id),
      ]);
      if (!revoked?.meta.changes) throw new GatewayError("GATEWAY_CONFLICT", { details: { accountId: id } });
      return presentId(id);
    },
  };
}
