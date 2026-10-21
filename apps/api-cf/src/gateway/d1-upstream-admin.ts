/**
 * Official upstream account administration (`gateway_upstream_account`;
 * guide: apps/docs/guide/gateway-admin.md). Accounts are created, edited,
 * enabled/disabled and rotated here; d1-credentials.ts resolves them for the
 * data plane.
 *
 * Secrets are write-only. A credential is either a `GATEWAY_UPSTREAM_*`
 * Worker secret binding name (`secret_ref`) or an API key sealed at once under
 * GATEWAY_ENCRYPTION_KEY (`encrypted_credentials`). No view, response, audit
 * snapshot or error ever carries the key or its envelope: views report only
 * the credential kind, its field names and the key version. Rotation replaces
 * the secret, bumps `key_version` and stamps `rotated_at`.
 */
import type { D1Database } from "@cloudflare/workers-types";
import { GatewayError, type GatewayClock } from "@clash/gateway-core";

import { adminAuditStatement, type GatewayAdminActor } from "./d1-admin-audit";
import type { RateLimitConfig } from "./d1-billing";
import { numberRecord, parseJson, stringList, toMs, toSeconds } from "./d1-common";
import { sealGatewayUpstreamCredentials } from "./d1-credentials";

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
  credential: {
    kind: "secret_ref" | "sealed";
    /** The Worker secret binding name; a name, never the secret. */
    secretRef: string | null;
    /** Non-secret credential field names, e.g. ["apiKey", "baseUrl"]. */
    fields: string[];
    keyVersion: string;
    rotatedAt: string | null;
  };
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
  rate_limit_json: string | null;
  rotated_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Every column but `encrypted_credentials`: the envelope is never read back for display. */
const VIEW_COLUMNS = `id, provider_id, upstream_id, api_shape, region, label, enabled, priority, weight,
  supported_model_ids_json, model_priorities_json, secret_ref, configured_credentials, key_version,
  rate_limit_json, rotated_at, created_at, updated_at`;

const iso = (seconds: number) => new Date(toMs(seconds)).toISOString();

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
      kind: row.secret_ref ? "secret_ref" : "sealed",
      secretRef: row.secret_ref,
      fields: stringList(row.configured_credentials) ?? [],
      keyVersion: row.key_version,
      rotatedAt: row.rotated_at === null ? null : iso(row.rotated_at),
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** The audit snapshot: the view without timestamps (it never holds a secret). */
function snapshot(view: UpstreamAccountView) {
  const { createdAt: _created, updatedAt: _updated, ...rest } = view;
  return rest;
}

function nextKeyVersion(current: string): string {
  const match = /^v(\d+)$/.exec(current);
  return `v${match ? Number(match[1]) + 1 : 2}`;
}

export function createD1UpstreamAdmin(
  db: D1Database,
  deps: { clock: GatewayClock; encryptionKey?: string },
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

  /** Column values for a credential; a sealed key needs GATEWAY_ENCRYPTION_KEY. */
  async function credentialColumns(credential: UpstreamCredentialInput) {
    if ("secretRef" in credential)
      return { secretRef: credential.secretRef, sealed: null, fields: ["apiKey"] };
    if (!deps.encryptionKey) throw new GatewayError("GATEWAY_ENCRYPTION_KEY_MISSING");
    const credentials = { apiKey: credential.apiKey, ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}) };
    return {
      secretRef: null,
      sealed: await sealGatewayUpstreamCredentials(credentials, deps.encryptionKey),
      fields: Object.keys(credentials),
    };
  }

  const json = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value));

  return {
    async list(): Promise<UpstreamAccountView[]> {
      const { results } = await db
        .prepare(`SELECT ${VIEW_COLUMNS} FROM gateway_upstream_account ORDER BY provider_id, upstream_id, COALESCE(priority, 1000), id`)
        .all<AccountRow>();
      return results.map(accountView);
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
                configured_credentials, key_version, rate_limit_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'v1', ?15, ?16, ?16)`,
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
      return accountView(await requireRow(id));
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
      if (set.length === 0) return accountView(before);
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
      return accountView(await requireRow(id));
    },

    /** Replace the secret: new key version, `rotated_at` now, a reason in the audit row. */
    async rotate(
      id: string,
      input: { credential: UpstreamCredentialInput; reason?: string; actor: GatewayAdminActor },
    ): Promise<UpstreamAccountView> {
      const before = await requireRow(id);
      const credential = await credentialColumns(input.credential);
      const keyVersion = nextKeyVersion(before.key_version);
      const nowS = nowSeconds();
      const [rotated] = await db.batch([
        db
          .prepare(
            `UPDATE gateway_upstream_account
                SET secret_ref = ?2, encrypted_credentials = ?3, configured_credentials = ?4,
                    key_version = ?5, rotated_at = ?6, updated_at = ?6
              WHERE id = ?1 AND key_version = ?7`,
          )
          .bind(id, credential.secretRef, credential.sealed, JSON.stringify(credential.fields), keyVersion, nowS, before.key_version),
        adminAuditStatement(db, {
          tenantId: "",
          actor: input.actor,
          action: "upstream.rotate",
          targetType: "upstream_account",
          targetId: id,
          before: { credential: snapshot(accountView(before)).credential },
          after: {
            credential: {
              kind: credential.secretRef ? "secret_ref" : "sealed",
              secretRef: credential.secretRef,
              fields: credential.fields,
              keyVersion,
            },
          },
          reason: input.reason ?? null,
          nowS,
          when: "changes() = 1",
        }),
      ]);
      if (!rotated?.meta.changes) throw new GatewayError("GATEWAY_CONFLICT", { details: { accountId: id } });
      return accountView(await requireRow(id));
    },
  };
}
