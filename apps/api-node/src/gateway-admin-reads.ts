/**
 * Read models of the admin console over Postgres (#372), the Node twin of
 * api-cf's gateway/d1-admin-reads.ts and d1-tenant-admin.ts list reads, in
 * the console's shapes (packages/web-ui/src/lib/adminClient.ts): overview,
 * usage, tenants, members, budgets and keys, and the live abuse counters.
 *
 * The Node ledger is N2 (#363): a settled request is a `charge` (text,
 * postpay) or `debit` (media, prepay) row per budget it drew on, each with
 * the request's amount; there are no holds. Request-level views take one row
 * per (request, kind), and the console's `settle` filter means those kinds.
 *
 * Read-only. Nothing here returns key material, token hashes or request
 * content.
 */
import { GatewayError, walletAvailable, type GatewayClock } from "@clash/gateway-core";
import type { GatewayBudgetSqlClient } from "./gateway-budget.ts";
import { gatewayLimitConfigKeys } from "./gateway-limits.ts";

/** Window of the overview metrics (as api-cf). */
export const NODE_OVERVIEW_WINDOW_DAYS = 30;
/** Window of the live rate-limit counters on the abuse page (as api-cf). */
export const NODE_ABUSE_WINDOW_MINUTES = 10;

/** N2 ledger kinds that settle one gateway request. */
const SETTLED_KINDS = ["charge", "debit"] as const;
/** The ledger kinds a usage filter may name: the console's (D1) and Node's own. */
export const NODE_USAGE_KINDS = [
  "settle",
  "hold",
  "release",
  "charge",
  "debit",
  "refund",
  "adjust",
  "grant",
  "topup",
  "expire",
] as const;
export type NodeUsageKind = (typeof NODE_USAGE_KINDS)[number];

/** The ledger kinds a filter selects: `settle` is a settled request; N2 has no holds or releases. */
function ledgerKinds(kind: NodeUsageKind | undefined): readonly string[] | null {
  if (kind === undefined) return null;
  if (kind === "settle") return SETTLED_KINDS;
  if (kind === "hold" || kind === "release") return [];
  return [kind];
}

const int = (value: unknown) => Number(value ?? 0);
const iso = (seconds: unknown) => new Date(int(seconds) * 1000).toISOString();
const isoOrNull = (seconds: unknown) => (seconds === null || seconds === undefined ? null : iso(seconds));
const isoDate = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
const seconds = (ms: number | undefined) => (ms === undefined ? null : Math.floor(ms / 1000));

export interface NodeUsageFilter {
  tenantId?: string;
  userId?: string;
  keyId?: string;
  modelCode?: string;
  kind?: NodeUsageKind;
  /** Epoch ms bounds, inclusive from, exclusive to. */
  from?: number;
  to?: number;
  limit: number;
}

export function createPgAdminReads(db: GatewayBudgetSqlClient, deps: { clock: GatewayClock }) {
  const nowS = () => Math.floor(deps.clock.now() / 1000);

  async function requireTenant(tenantId: string): Promise<void> {
    const { rows } = await db.query(`SELECT 1 FROM tenant WHERE id = $1`, [tenantId]);
    if (!rows[0]) throw new GatewayError("GATEWAY_TENANT_NOT_FOUND", { details: { tenantId } });
  }

  return {
    /** Ledger entries, one per request and kind, newest first; per-model totals of settled requests. */
    async usage(filter: NodeUsageFilter) {
      const kinds = ledgerKinds(filter.kind);
      const where = `($1::text IS NULL OR tenant_id = $1) AND ($2::text IS NULL OR user_id = $2)
        AND ($3::text IS NULL OR key_id = $3) AND ($4::text IS NULL OR model_code = $4)
        AND ($5::bigint IS NULL OR occurred_at >= $5) AND ($6::bigint IS NULL OR occurred_at < $6)`;
      const binds = [
        filter.tenantId ?? null,
        filter.userId ?? null,
        filter.keyId ?? null,
        filter.modelCode ?? null,
        seconds(filter.from),
        seconds(filter.to),
      ];
      const { rows: entries } = await db.query<Record<string, unknown>>(
        `SELECT * FROM (
           SELECT DISTINCT ON (request_id, kind) request_id, kind, status, tenant_id, user_id, key_id,
                  amount_micro_credits, model_code, input_tokens, output_tokens, price_version, error_code, occurred_at
             FROM gateway_usage_ledger
            WHERE ${where} AND ($7::text[] IS NULL OR kind = ANY($7::text[]))
            ORDER BY request_id, kind, budget_id) t
          ORDER BY occurred_at DESC, request_id DESC LIMIT $8`,
        [...binds, kinds, filter.limit],
      );
      const settledOnly = kinds === null || kinds.some((kind) => (SETTLED_KINDS as readonly string[]).includes(kind));
      const { rows: byModel } = settledOnly
        ? await db.query<Record<string, unknown>>(
            `SELECT COALESCE(model_code, '') AS model_code, count(*) AS requests,
                    COALESCE(sum(amount_micro_credits), 0) AS amount,
                    COALESCE(sum(input_tokens), 0) AS input_tokens, COALESCE(sum(output_tokens), 0) AS output_tokens
               FROM (SELECT DISTINCT ON (request_id, kind) model_code, amount_micro_credits, input_tokens, output_tokens
                       FROM gateway_usage_ledger
                      WHERE ${where} AND kind = ANY($7::text[])
                      ORDER BY request_id, kind, budget_id) t
              GROUP BY 1 ORDER BY amount DESC LIMIT 50`,
            [...binds, kinds === null ? SETTLED_KINDS : kinds.filter((kind) => (SETTLED_KINDS as readonly string[]).includes(kind))],
          )
        : { rows: [] };
      return {
        entries: entries.map((row) => ({
          requestId: String(row.request_id),
          kind: String(row.kind),
          status: String(row.status),
          tenantId: String(row.tenant_id),
          userId: (row.user_id as string | null) || null,
          keyId: (row.key_id as string | null) || null,
          amountMicroCredits: int(row.amount_micro_credits),
          modelCode: (row.model_code as string | null) ?? null,
          inputTokens: int(row.input_tokens),
          outputTokens: int(row.output_tokens),
          priceVersion: (row.price_version as string | null) ?? null,
          errorCode: (row.error_code as string | null) ?? null,
          occurredAt: iso(row.occurred_at),
        })),
        byModel: byModel.map((row) => ({
          modelCode: String(row.model_code),
          requests: int(row.requests),
          amountMicroCredits: int(row.amount),
          inputTokens: int(row.input_tokens),
          outputTokens: int(row.output_tokens),
          notCharged: 0,
        })),
      };
    },

    /** Spend, requests, failures and top models over the last 30 days; platform counts without a tenant. */
    async overview(tenantId: string | undefined) {
      const now = nowS();
      const since = now - NODE_OVERVIEW_WINDOW_DAYS * 86_400;
      const settled = `(SELECT DISTINCT ON (request_id, kind) model_code, amount_micro_credits, status
                          FROM gateway_usage_ledger
                         WHERE kind = ANY($3::text[]) AND occurred_at >= $2 AND ($1::text IS NULL OR tenant_id = $1)
                         ORDER BY request_id, kind, budget_id) t`;
      const binds = [tenantId ?? null, since, SETTLED_KINDS];
      const [{ rows: totals }, { rows: models }] = await Promise.all([
        db.query<Record<string, unknown>>(
          `SELECT count(*) AS requests, COALESCE(sum(amount_micro_credits), 0) AS spent,
                  count(*) FILTER (WHERE status NOT IN ('settled', 'partial')) AS failed
             FROM ${settled}`,
          binds,
        ),
        db.query<Record<string, unknown>>(
          `SELECT COALESCE(model_code, '') AS model_code, count(*) AS requests,
                  COALESCE(sum(amount_micro_credits), 0) AS spent
             FROM ${settled} GROUP BY 1 ORDER BY spent DESC, requests DESC LIMIT 5`,
          binds,
        ),
      ]);
      const overview = {
        windowDays: NODE_OVERVIEW_WINDOW_DAYS,
        requests: int(totals[0]?.requests),
        spentMicroCredits: int(totals[0]?.spent),
        failedRequests: int(totals[0]?.failed),
        topModels: models.map((row) => ({
          modelCode: String(row.model_code),
          requests: int(row.requests),
          spentMicroCredits: int(row.spent),
        })),
      };
      if (tenantId !== undefined) {
        const { rows } = await db.query<Record<string, unknown>>(
          `SELECT (SELECT count(*) FROM tenant_member WHERE tenant_id = $1) AS members,
                  (SELECT count(*) FROM gateway_virtual_key WHERE tenant_id = $1 AND revoked_at IS NULL) AS keys,
                  (SELECT count(*) FROM gateway_budget WHERE tenant_id = $1 AND status <> 'active') AS suspended`,
          [tenantId],
        );
        return {
          ...overview,
          tenant: { members: int(rows[0]?.members), activeKeys: int(rows[0]?.keys), suspendedBudgets: int(rows[0]?.suspended) },
        };
      }
      const { rows } = await db.query<Record<string, unknown>>(
        `WITH live AS (
           SELECT catalog_version FROM gateway_model
            WHERE published_at IS NOT NULL AND published_at <= $1
            ORDER BY published_at DESC, catalog_version DESC LIMIT 1)
         SELECT (SELECT count(*) FROM tenant) AS tenants,
                (SELECT catalog_version FROM live) AS catalog_version,
                (SELECT count(*) FROM gateway_model WHERE enabled = 1 AND catalog_version = (SELECT catalog_version FROM live)) AS catalog_models,
                (SELECT count(*) FROM gateway_upstream_credential WHERE enabled = 1 AND scope = 'official') AS upstreams_enabled,
                (SELECT count(*) FROM gateway_upstream_credential WHERE scope = 'official') AS upstreams,
                (SELECT count(*) FROM gateway_package WHERE status = 'active') AS packages,
                (SELECT count(*) FROM admin_account WHERE "disabledAt" IS NULL) AS admin_accounts`,
        [now],
      );
      const row = rows[0] ?? {};
      return {
        ...overview,
        platform: {
          tenants: int(row.tenants),
          liveCatalogVersion: (row.catalog_version as string | null) ?? null,
          liveCatalogModels: int(row.catalog_models),
          upstreamsEnabled: int(row.upstreams_enabled),
          upstreams: int(row.upstreams),
          activePackages: int(row.packages),
          adminAccounts: int(row.admin_accounts),
        },
      };
    },

    /** Every tenant, newest first, optionally filtered by id or name. */
    async tenants(input: { query?: string; limit: number }) {
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT t.id, t.name, t.owner_user_id, t.created_at,
                (SELECT count(*) FROM tenant_member m WHERE m.tenant_id = t.id) AS members
           FROM tenant t
          WHERE $1::text IS NULL OR strpos(lower(t.id), lower($1)) > 0 OR strpos(lower(t.name), lower($1)) > 0
          ORDER BY t.created_at DESC, t.id LIMIT $2`,
        [input.query ?? null, input.limit],
      );
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        // Postgres tenants have no kind column: a personal tenant is `personal:<user>` (gateway-node.ts).
        kind: String(row.id).startsWith("personal:") ? "personal" : "team",
        ownerUserId: String(row.owner_user_id),
        members: int(row.members),
        createdAt: isoDate(row.created_at),
      }));
    },

    async members(tenantId: string) {
      await requireTenant(tenantId);
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT m.user_id, m.role, m.created_at, u.name, u.email
           FROM tenant_member m LEFT JOIN auth_user u ON u.id = m.user_id
          WHERE m.tenant_id = $1
          ORDER BY m.role <> 'owner', m.user_id`,
        [tenantId],
      );
      return rows.map((row) => ({
        userId: String(row.user_id),
        role: String(row.role),
        name: (row.name as string | null) ?? null,
        email: (row.email as string | null) ?? null,
        joinedAt: row.created_at === null ? null : isoDate(row.created_at),
      }));
    },

    /** The tenant's budgets: wallet first, then member and key budgets. */
    async budgets(tenantId: string) {
      await requireTenant(tenantId);
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT id, tenant_id, scope, scope_id, period, status, limit_micro_credits, spent_micro_credits,
                reserved_micro_credits, enforcement, alert_threshold_pct, allocated_by_user_id, updated_at
           FROM gateway_budget WHERE tenant_id = $1
          ORDER BY CASE scope WHEN 'tenant' THEN 0 WHEN 'user' THEN 1 ELSE 2 END, scope_id`,
        [tenantId],
      );
      return rows.map((row) => {
        const limit = row.limit_micro_credits === null ? null : int(row.limit_micro_credits);
        const spent = int(row.spent_micro_credits);
        const reserved = int(row.reserved_micro_credits);
        return {
          id: String(row.id),
          tenantId: String(row.tenant_id),
          scope: row.scope as "tenant" | "user" | "key",
          scopeId: String(row.scope_id),
          period: String(row.period),
          status: String(row.status),
          limitMicroCredits: limit,
          spentMicroCredits: spent,
          reservedMicroCredits: reserved,
          availableMicroCredits:
            limit === null ? null : walletAvailable({ limitMicroCredits: limit, spentMicroCredits: spent, reservedMicroCredits: reserved }),
          enforcement: row.enforcement as "hard" | "soft" | "alert",
          alertThresholdPct: row.alert_threshold_pct === null ? null : int(row.alert_threshold_pct),
          allocatedByUserId: (row.allocated_by_user_id as string | null) ?? null,
          updatedAt: iso(row.updated_at),
        };
      });
    },

    /** The tenant's virtual keys (no hashes), live first; a key's limit is its gateway_config override. */
    async keys(tenantId: string) {
      await requireTenant(tenantId);
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT k.id, k.user_id, k.label, k.token_prefix, k.model_allowlist, k.credential_scope,
                k.expires_at, k.revoked_at, k.created_at,
                (SELECT b.id FROM gateway_budget b WHERE b.tenant_id = k.tenant_id AND b.scope = 'key' AND b.scope_id = k.id) AS budget_id,
                (SELECT c.value FROM gateway_config c WHERE c.key = $2 || k.id) AS rate_limit
           FROM gateway_virtual_key k WHERE k.tenant_id = $1
          ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC, k.id`,
        [tenantId, gatewayLimitConfigKeys.key(tenantId, "")],
      );
      return rows.map((row) => ({
        id: String(row.id),
        userId: String(row.user_id),
        name: (row.label as string | null) ?? "",
        tokenPrefix: String(row.token_prefix),
        modelAllowlist: Array.isArray(row.model_allowlist) ? (row.model_allowlist as string[]) : null,
        credentialScope: String(row.credential_scope),
        budgetId: (row.budget_id as string | null) ?? null,
        rateLimit: (row.rate_limit as Record<string, number> | null) ?? null,
        expiresAt: isoOrNull(row.expires_at),
        revokedAt: isoOrNull(row.revoked_at),
        // Node does not record key use.
        lastUsedAt: null,
        createdAt: iso(row.created_at),
      }));
    },

    /**
     * The busiest rate-limit counters of the last minutes and the open
     * in-flight leases (as api-cf). Node has no abuse store yet (the data
     * plane's abuse port is unavailable): no signal is measured, so there
     * are no thresholds, alerts or suspensions to list, and `events` says so.
     */
    async abuse() {
      const now = nowS();
      const [{ rows: windows }, { rows: inflight }, { rows: suspended }] = await Promise.all([
        db.query<Record<string, unknown>>(
          `SELECT subject, sum(requests) AS requests, sum(tokens) AS tokens, max(window_start) AS last_window
             FROM gateway_rate_window WHERE window_start >= $1
            GROUP BY subject ORDER BY requests DESC, tokens DESC LIMIT 50`,
          [now - NODE_ABUSE_WINDOW_MINUTES * 60],
        ),
        db.query<Record<string, unknown>>(
          `SELECT subject, count(*) AS leases FROM gateway_inflight WHERE expires_at > $1
            GROUP BY subject ORDER BY leases DESC LIMIT 50`,
          [now],
        ),
        // Node suspensions are budget rows (#371): wallet or key cap status=suspended.
        db.query<Record<string, unknown>>(
          `SELECT id, scope, scope_id, tenant_id, updated_at FROM gateway_budget
            WHERE status = 'suspended' AND scope IN ('tenant', 'key')
            ORDER BY updated_at DESC, id LIMIT 50`,
        ),
      ]);
      return {
        windowMinutes: NODE_ABUSE_WINDOW_MINUTES,
        rateWindows: windows.map((row) => ({
          subject: String(row.subject),
          requests: int(row.requests),
          tokens: int(row.tokens),
          lastWindowAt: iso(row.last_window),
        })),
        inflight: inflight.map((row) => ({ subject: String(row.subject), leases: int(row.leases) })),
        events: {
          available: false as const,
          reason: "This Node gateway measures no abuse signals yet: only the live rate-limit counters and in-flight leases are shown, and nothing is auto-suspended.",
        },
        signals: [],
        alerts: [],
        suspensions: suspended.map((row) => ({
          id: String(row.id),
          subjectKind: String(row.scope) as "tenant" | "key",
          subjectId: String(row.scope_id),
          tenantId: String(row.tenant_id),
          source: "manual" as const,
          signal: null,
          reason: "",
          actorKind: "admin" as const,
          actorId: "",
          createdAt: iso(row.updated_at),
          liftedAt: null,
          liftedBy: null,
          liftReason: null,
        })),
      };
    },
  };
}
export type PgAdminReads = ReturnType<typeof createPgAdminReads>;
