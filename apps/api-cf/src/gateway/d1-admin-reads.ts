/**
 * Read models for the admin console (guide: apps/docs/guide/gateway-admin.md):
 * admin audit, overview metrics, tenants and abuse signals (the usage
 * explorer is d1-usage-explorer.ts, #355). Read-only; every query is tenant-filtered when a tenant is given,
 * and the routes only omit the tenant for platform permissions.
 *
 * Nothing here returns key material, token hashes or request content.
 * Retained bodies are read only through the audited staff view
 * (routes/v1/admin/gateway-insights.ts over d1-retention.ts).
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { GatewayClock } from "@clash/gateway-core";

import { parseJson, publishedCatalogVersionSql, toMs, toSeconds } from "./d1-common";

const iso = (seconds: number) => new Date(toMs(seconds)).toISOString();

export interface AuditFilter {
  tenantId?: string;
  actorKind?: string;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: number;
  to?: number;
  limit: number;
}

export interface AuditEntryView {
  id: string;
  tenantId: string;
  /** `admin` (an admin account), `user` (a team role), `bootstrap` or `migration` (#394). */
  actorKind: string;
  /** The admin account id for `admin`, the product user id for `user`. */
  actorId: string;
  actorRole: string | null;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  occurredAt: string;
}

interface AuditRow {
  id: string;
  tenant_id: string;
  actor_kind: string;
  actor_id: string;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  occurred_at: number;
}

/** Window of the overview metrics. */
export const OVERVIEW_WINDOW_DAYS = 30;
/** Window of the abuse rate-window signals. */
export const ABUSE_WINDOW_MINUTES = 10;

const seconds = (ms: number | undefined) => (ms === undefined ? null : toSeconds(ms));

export function createD1AdminReads(db: D1Database, deps: { clock: GatewayClock }) {
  const nowS = () => toSeconds(deps.clock.now());

  return {
    /** Admin audit rows, newest first. Without a tenant: every row, platform-wide ones included. */
    async audit(filter: AuditFilter): Promise<AuditEntryView[]> {
      const { results } = await db
        .prepare(
          `SELECT id, tenant_id, actor_kind, actor_id, actor_role, action, target_type, target_id,
                  before_json, after_json, reason, occurred_at
             FROM gateway_admin_audit
            WHERE (?1 IS NULL OR tenant_id = ?1) AND (?2 IS NULL OR actor_id = ?2)
              AND (?3 IS NULL OR action = ?3 OR action LIKE ?3 || '.%')
              AND (?4 IS NULL OR target_type = ?4) AND (?5 IS NULL OR target_id = ?5)
              AND (?6 IS NULL OR occurred_at >= ?6) AND (?7 IS NULL OR occurred_at < ?7)
              AND (?9 IS NULL OR actor_kind = ?9)
            ORDER BY occurred_at DESC, rowid DESC LIMIT ?8`,
        )
        .bind(
          filter.tenantId ?? null,
          filter.actorId ?? null,
          filter.action ?? null,
          filter.targetType ?? null,
          filter.targetId ?? null,
          seconds(filter.from),
          seconds(filter.to),
          filter.limit,
          filter.actorKind ?? null,
        )
        .all<AuditRow>();
      return results.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        actorKind: row.actor_kind,
        actorId: row.actor_id,
        actorRole: row.actor_role,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        before: parseJson(row.before_json) ?? null,
        after: parseJson(row.after_json) ?? null,
        reason: row.reason,
        occurredAt: iso(row.occurred_at),
      }));
    },

    /** Spend, requests, failures and top models over the last 30 days; platform counts without a tenant. */
    async overview(tenantId: string | undefined) {
      const now = nowS();
      const since = now - OVERVIEW_WINDOW_DAYS * 86_400;
      const tenant = tenantId ?? null;
      const [usage, models, platform, scoped] = await db.batch([
        db
          .prepare(
            `SELECT COALESCE(SUM(kind = 'settle'), 0) AS requests,
                    COALESCE(SUM(CASE kind WHEN 'settle' THEN amount_micro_credits ELSE -amount_micro_credits END), 0) AS spent,
                    COALESCE(SUM(CASE WHEN kind = 'refund' THEN 1
                                      WHEN status IN ('settled', 'partial') THEN 0 ELSE 1 END), 0) AS failed
               FROM gateway_usage_ledger
              WHERE kind IN ('settle', 'refund') AND occurred_at >= ?2 AND (?1 IS NULL OR tenant_id = ?1)`,
          )
          .bind(tenant, since),
        db
          .prepare(
            `SELECT COALESCE(model_code, '') AS model_code, COALESCE(SUM(kind = 'settle'), 0) AS requests,
                    COALESCE(SUM(CASE kind WHEN 'settle' THEN amount_micro_credits ELSE -amount_micro_credits END), 0) AS spent
               FROM gateway_usage_ledger
              WHERE kind IN ('settle', 'refund') AND occurred_at >= ?2 AND (?1 IS NULL OR tenant_id = ?1)
              GROUP BY model_code ORDER BY spent DESC, requests DESC LIMIT 5`,
          )
          .bind(tenant, since),
        db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM tenant) AS tenants,
                    ${publishedCatalogVersionSql("?1")} AS catalog_version,
                    (SELECT COUNT(*) FROM gateway_model WHERE catalog_version = ${publishedCatalogVersionSql("?1")}) AS catalog_models,
                    (SELECT COUNT(*) FROM gateway_upstream_account WHERE enabled = 1) AS upstreams_enabled,
                    (SELECT COUNT(*) FROM gateway_upstream_account) AS upstreams,
                    (SELECT COUNT(*) FROM gateway_package WHERE status = 'active') AS packages,
                    (SELECT COUNT(*) FROM admin_accounts WHERE disabled_at IS NULL) AS admin_accounts`,
          )
          .bind(now),
        db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM tenant_member WHERE tenant_id = ?1) AS members,
                    (SELECT COUNT(*) FROM gateway_key WHERE tenant_id = ?1 AND revoked_at IS NULL) AS keys,
                    (SELECT COUNT(*) FROM gateway_budget WHERE tenant_id = ?1 AND status <> 'active') AS suspended_budgets`,
          )
          .bind(tenant),
      ]);
      const totals = (usage?.results?.[0] ?? { requests: 0, spent: 0, failed: 0 }) as {
        requests: number;
        spent: number;
        failed: number;
      };
      const platformRow = platform?.results?.[0] as
        | {
            tenants: number;
            catalog_version: string | null;
            catalog_models: number;
            upstreams_enabled: number;
            upstreams: number;
            packages: number;
            admin_accounts: number;
          }
        | undefined;
      const tenantRow = scoped?.results?.[0] as { members: number; keys: number; suspended_budgets: number } | undefined;
      return {
        windowDays: OVERVIEW_WINDOW_DAYS,
        requests: totals.requests,
        spentMicroCredits: totals.spent,
        failedRequests: totals.failed,
        topModels: ((models?.results ?? []) as Array<{ model_code: string; requests: number; spent: number }>).map(
          (row) => ({ modelCode: row.model_code, requests: row.requests, spentMicroCredits: row.spent }),
        ),
        ...(tenantId === undefined && platformRow
          ? {
              platform: {
                tenants: platformRow.tenants,
                liveCatalogVersion: platformRow.catalog_version,
                liveCatalogModels: platformRow.catalog_models,
                upstreamsEnabled: platformRow.upstreams_enabled,
                upstreams: platformRow.upstreams,
                activePackages: platformRow.packages,
                adminAccounts: platformRow.admin_accounts,
              },
            }
          : {}),
        ...(tenantId !== undefined && tenantRow
          ? {
              tenant: {
                members: tenantRow.members,
                activeKeys: tenantRow.keys,
                suspendedBudgets: tenantRow.suspended_budgets,
              },
            }
          : {}),
      };
    },

    /** Every tenant (platform view), newest first, optionally filtered by id or name. */
    async tenants(input: { query?: string; limit: number }) {
      const { results } = await db
        .prepare(
          `SELECT t.id, t.name, t.kind, t.owner_user_id, t.created_at,
                  (SELECT COUNT(*) FROM tenant_member m WHERE m.tenant_id = t.id) AS members
             FROM tenant t
            WHERE ?1 IS NULL OR instr(lower(t.id), lower(?1)) > 0 OR instr(lower(t.name), lower(?1)) > 0
            ORDER BY t.created_at DESC, t.id LIMIT ?2`,
        )
        .bind(input.query ?? null, input.limit)
        .all<{ id: string; name: string; kind: string; owner_user_id: string; created_at: number; members: number }>();
      return results.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        ownerUserId: row.owner_user_id,
        members: row.members,
        createdAt: iso(row.created_at),
      }));
    },

    /**
     * Live counters beside the abuse signals (#356, d1-abuse.ts): the busiest
     * rate-limit counters of the last minutes and the open in-flight leases.
     * 401 answers are counted (`auth_failures`); rate-limited (429) and
     * forbidden (403) answers are not recorded, so `events` says so.
     */
    async abuse() {
      const now = nowS();
      const [windows, inflight] = await db.batch([
        db
          .prepare(
            `SELECT subject, SUM(requests) AS requests, SUM(tokens) AS tokens, MAX(window_start) AS last_window
               FROM gateway_rate_window WHERE window_start >= ?1
              GROUP BY subject ORDER BY requests DESC, tokens DESC LIMIT 50`,
          )
          .bind(now - ABUSE_WINDOW_MINUTES * 60),
        db
          .prepare(
            `SELECT subject, COUNT(*) AS leases FROM gateway_inflight WHERE expires_at > ?1
              GROUP BY subject ORDER BY leases DESC LIMIT 50`,
          )
          .bind(now),
      ]);
      return {
        windowMinutes: ABUSE_WINDOW_MINUTES,
        rateWindows: (
          (windows?.results ?? []) as Array<{ subject: string; requests: number; tokens: number; last_window: number }>
        ).map((row) => ({
          subject: row.subject,
          requests: row.requests,
          tokens: row.tokens,
          lastWindowAt: iso(row.last_window),
        })),
        inflight: ((inflight?.results ?? []) as Array<{ subject: string; leases: number }>).map((row) => ({
          subject: row.subject,
          leases: row.leases,
        })),
        events: {
          available: false as const,
          reason: "Rate-limited and forbidden answers are not recorded; 401 answers are counted as the auth_failures signal.",
        },
      };
    },

    /** The tenant of the ledger rows carrying this gateway request id, if any. */
    async requestTenant(requestId: string): Promise<string | null> {
      const row = await db
        .prepare(`SELECT tenant_id FROM gateway_usage_ledger WHERE request_id = ? LIMIT 1`)
        .bind(requestId)
        .first<{ tenant_id: string }>();
      return row?.tenant_id ?? null;
    },
  };
}
