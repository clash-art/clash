/**
 * gateway-core `reconcile` over D1 (#355; guide: apps/docs/guide/gateway-usage.md):
 * imported upstream reports (`gateway_upstream_report` + `gateway_upstream_usage`,
 * 0052), the ledger's official settlements, and reconciliation runs
 * (`gateway_reconciliation_run`) whose differences are platform `adjust`
 * ledger entries (`tenant_id = ''`, `ref_kind = 'reconcile'`, direction in
 * `status`, see reconcileAdjustEntry). A run, its adjustments and its audit
 * row are one D1 batch; each adjustment is written only while its group's
 * posted sum is still what the run read, so concurrent runs never both post.
 *
 * Reconciliation never touches a tenant wallet or a settlement (#399 owns
 * settlement semantics): adjustments record what the upstream billed
 * differently from what the gateway metered.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  GATEWAY_RECONCILE_REF_KIND,
  GatewayError,
  gatewayDayWindow,
  isBlockedDeepSeekModel,
  reconcileAdjustEntry,
  reconcileGatewayUsage,
  reconcileGatewayUsageDay,
  signedReconcileAmount,
  type GatewayClock,
  type GatewayErrorCode,
  type GatewayIds,
  type GatewayLogger,
  type GatewayMediaUnit,
  type GatewayReconcileSource,
  type GatewayReconciliationPort,
  type NightlyReconcileResult,
  type ReconcileActor,
  type ReconcileDiff,
  type ReconcileRunResult,
  type ReconcileRunStatus,
  type ReconcileUsage,
  type UpstreamUsageGroup,
} from "@clash/gateway-core";

import type { Env } from "../config";
import { adminAuditStatement, type GatewayAdminActor } from "./d1-admin-audit";
import { monotonicClock, numberRecord, parseJson, toMs, toSeconds } from "./d1-common";
import { publishedPriceAt } from "./d1-routes";
import { workersLogger } from "./workers-logger";

const iso = (seconds: number) => new Date(toMs(seconds)).toISOString();

/** `[low, high)` request-id range of a day's (and optionally one group's) adjustments. */
function adjustRange(day: string, groupKey?: string): [string, string] {
  const prefix = `${GATEWAY_RECONCILE_REF_KIND}:${day}:${groupKey ? `${groupKey}:` : ""}`;
  // ';' sorts right after ':', so the range is exactly the ids with this prefix.
  return [prefix, `${prefix.slice(0, -1)};`];
}

const SIGNED_AMOUNT = `CASE status WHEN 'upstream_over' THEN amount_micro_credits
  WHEN 'upstream_under' THEN -amount_micro_credits ELSE 0 END`;

function units(value: string | null): Partial<Record<GatewayMediaUnit, number>> {
  return (numberRecord(value) ?? {}) as Partial<Record<GatewayMediaUnit, number>>;
}

interface UsageColumns {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
}

const usageOf = (row: UsageColumns, unitCounts: Partial<Record<GatewayMediaUnit, number>>): ReconcileUsage => ({
  requests: row.requests,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cachedInputTokens: row.cached_input_tokens,
  cacheWriteTokens: row.cache_write_tokens,
  units: unitCounts,
});

export function createD1ReconciliationPort(
  db: D1Database,
  deps: { logger: GatewayLogger; auditActor?: GatewayAdminActor },
): GatewayReconciliationPort {
  return {
    async ledgerUsage({ from, to }) {
      // One settle row per request (the lowest budget id), official scope,
      // routed to an upstream; grouped by units_json so media units sum exactly.
      const { results } = await db
        .prepare(
          `SELECT l.upstream_id, l.account_id, l.model_code, l.units_json, COUNT(*) AS requests,
                  SUM(l.input_tokens) AS input_tokens, SUM(l.output_tokens) AS output_tokens,
                  SUM(l.cached_input_tokens) AS cached_input_tokens, SUM(l.cache_write_tokens) AS cache_write_tokens,
                  SUM(l.amount_micro_credits) AS charged
             FROM gateway_usage_ledger l
            WHERE l.kind = 'settle' AND l.credential_scope = 'official'
              AND l.upstream_id IS NOT NULL AND l.account_id IS NOT NULL AND l.model_code IS NOT NULL
              AND l.occurred_at >= ?1 AND l.occurred_at < ?2
              AND l.budget_id = (SELECT MIN(s.budget_id) FROM gateway_usage_ledger s
                                  WHERE s.request_id = l.request_id AND s.kind = 'settle')
            GROUP BY l.upstream_id, l.account_id, l.model_code, l.units_json`,
        )
        .bind(toSeconds(from), toSeconds(to))
        .all<UsageColumns & { upstream_id: string; account_id: string; model_code: string; units_json: string; charged: number }>();
      const groups = new Map<string, { upstreamId: string; accountId: string; modelCode: string; usage: ReconcileUsage; chargedMicroCredits: number }>();
      for (const row of results) {
        const key = JSON.stringify([row.upstream_id, row.account_id, row.model_code]);
        const group = groups.get(key) ?? {
          upstreamId: row.upstream_id,
          accountId: row.account_id,
          modelCode: row.model_code,
          usage: usageOf({ requests: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0 }, {}),
          chargedMicroCredits: 0,
        };
        group.usage.requests += row.requests;
        group.usage.inputTokens += row.input_tokens;
        group.usage.outputTokens += row.output_tokens;
        group.usage.cachedInputTokens += row.cached_input_tokens;
        group.usage.cacheWriteTokens += row.cache_write_tokens;
        group.chargedMicroCredits += row.charged;
        // Every request in this row group carries the same units.
        for (const [unit, count] of Object.entries(units(row.units_json)) as Array<[GatewayMediaUnit, number]>)
          group.usage.units[unit] = (group.usage.units[unit] ?? 0) + count * row.requests;
        groups.set(key, group);
      }
      return [...groups.values()];
    },

    async upstreamUsage({ day }) {
      const [reports, rows] = await db.batch([
        db.prepare(`SELECT source FROM gateway_upstream_report WHERE day = ?1`).bind(day),
        db
          .prepare(
            `SELECT source, upstream_id, account_id, model_code, requests, input_tokens, output_tokens,
                    cached_input_tokens, cache_write_tokens, units_json
               FROM gateway_upstream_usage WHERE day = ?1`,
          )
          .bind(day),
      ]);
      const groups = (rows?.results ?? []) as Array<
        UsageColumns & { source: string; upstream_id: string; account_id: string; model_code: string; units_json: string }
      >;
      return ((reports?.results ?? []) as Array<{ source: GatewayReconcileSource }>).map(({ source }) => ({
        source,
        groups: groups
          .filter((row) => row.source === source)
          .map(
            (row): UpstreamUsageGroup => ({
              upstreamId: row.upstream_id,
              accountId: row.account_id,
              modelCode: row.model_code,
              usage: usageOf(row, units(row.units_json)),
            }),
          ),
      }));
    },

    price: (input) => publishedPriceAt(db, input, deps),

    async posted({ day }) {
      const [low, high] = adjustRange(day);
      const { results } = await db
        .prepare(
          `SELECT request_id, status, amount_micro_credits FROM gateway_usage_ledger
            WHERE kind = 'adjust' AND ref_kind = ?3 AND request_id >= ?1 AND request_id < ?2`,
        )
        .bind(low, high, GATEWAY_RECONCILE_REF_KIND)
        .all<{ request_id: string; status: string; amount_micro_credits: number }>();
      return results.map((row) => ({
        requestId: row.request_id,
        signedMicroCredits: signedReconcileAmount({ status: row.status, amountMicroCredits: row.amount_micro_credits }),
      }));
    },

    async record(run) {
      const startedS = toSeconds(run.startedAt);
      const occurredS = toSeconds(gatewayDayWindow(run.day).to) - 1;
      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            `INSERT INTO gateway_reconciliation_run
               (id, day, source, status, error_code, groups, diffs_json, actor_kind, actor_id, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
          )
          .bind(
            run.id,
            run.day,
            run.source,
            run.status,
            run.errorCode ?? null,
            run.diffs.length,
            JSON.stringify(run.diffs),
            run.actor.kind,
            run.actor.id,
            startedS,
          ),
      ];
      const adjustments = run.diffs.filter((diff): diff is ReconcileDiff & { adjustRequestId: string } => !!diff.adjustRequestId);
      for (const diff of adjustments) {
        const [low, high] = adjustRange(run.day, diff.groupKey);
        const entry = reconcileAdjustEntry(diff.adjustMicroCredits);
        statements.push(
          db
            .prepare(
              `INSERT INTO gateway_usage_ledger
                 (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits, model_code,
                  credential_scope, price_version, ref_kind, ref_id, actor_user_id, reason,
                  upstream_id, account_id, occurred_at)
               SELECT ?1 || ':adjust', ?1, '', 'adjust', ?2, '', ?3, ?4, 'official', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
                WHERE (SELECT COALESCE(SUM(${SIGNED_AMOUNT}), 0) FROM gateway_usage_ledger
                        WHERE kind = 'adjust' AND ref_kind = ?6 AND request_id >= ?13 AND request_id < ?14) = ?15
               ON CONFLICT DO NOTHING`,
            )
            .bind(
              diff.adjustRequestId,
              entry.status,
              entry.amountMicroCredits,
              diff.modelCode,
              diff.priceVersion,
              GATEWAY_RECONCILE_REF_KIND,
              run.id,
              run.actor.id,
              `reconcile ${run.source ?? "unknown"} ${run.day}`,
              diff.upstreamId,
              diff.accountId,
              occurredS,
              low,
              high,
              diff.postedMicroCredits,
            ),
        );
      }
      statements.push(
        db
          .prepare(
            `UPDATE gateway_reconciliation_run
                SET adjustments = (SELECT COUNT(*) FROM gateway_usage_ledger WHERE ref_kind = ?2 AND ref_id = ?1 AND kind = 'adjust'),
                    adjusted_micro_credits = (SELECT COALESCE(SUM(${SIGNED_AMOUNT}), 0) FROM gateway_usage_ledger
                                               WHERE ref_kind = ?2 AND ref_id = ?1 AND kind = 'adjust')
              WHERE id = ?1`,
          )
          .bind(run.id, GATEWAY_RECONCILE_REF_KIND),
      );
      if (deps.auditActor)
        statements.push(
          adminAuditStatement(db, {
            tenantId: "",
            actor: deps.auditActor,
            action: "reconciliation.run",
            targetType: "gateway_reconciliation_run",
            targetId: run.id,
            after: { day: run.day, source: run.source, status: run.status, groups: run.diffs.length },
            nowS: startedS,
          }),
        );
      const results = await db.batch(statements);
      const posted = results
        .slice(1, 1 + adjustments.length)
        .reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
      return { posted };
    },

    async pendingDays({ from, before }) {
      const { results } = await db
        .prepare(
          `SELECT r.day FROM gateway_upstream_report r
            WHERE r.day >= ?1 AND r.day < ?2
            GROUP BY r.day
           HAVING MAX(r.imported_at) >= COALESCE(
                    (SELECT MAX(x.started_at) FROM gateway_reconciliation_run x WHERE x.day = r.day), -1)
            ORDER BY r.day`,
        )
        .bind(from, before)
        .all<{ day: string }>();
      return results.map((row) => row.day);
    },
  };
}

// ─── Upstream reports (admin import) ──────────────────────────────────────

export interface UpstreamReportGroupInput {
  upstreamId: string;
  accountId: string;
  modelCode: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  units: Partial<Record<GatewayMediaUnit, number>>;
}

export interface UpstreamReportView {
  day: string;
  source: GatewayReconcileSource;
  groups: number;
  importedAt: string;
  importedBy: string;
}

export interface ReconcileRunView {
  id: string;
  day: string;
  source: string | null;
  status: ReconcileRunStatus;
  errorCode: GatewayErrorCode | null;
  groups: number;
  adjustments: number;
  adjustedMicroCredits: number;
  actorKind: string;
  actorId: string;
  startedAt: string;
  diffs?: ReconcileDiff[];
}

interface RunRow {
  id: string;
  day: string;
  source: string | null;
  status: ReconcileRunStatus;
  error_code: GatewayErrorCode | null;
  groups: number;
  adjustments: number;
  adjusted_micro_credits: number;
  diffs_json: string;
  actor_kind: string;
  actor_id: string;
  started_at: number;
}

function runView(row: RunRow, withDiffs: boolean): ReconcileRunView {
  const diffs = parseJson(row.diffs_json);
  return {
    id: row.id,
    day: row.day,
    source: row.source,
    status: row.status,
    errorCode: row.error_code,
    groups: row.groups,
    adjustments: row.adjustments,
    adjustedMicroCredits: row.adjusted_micro_credits,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    startedAt: iso(row.started_at),
    ...(withDiffs ? { diffs: Array.isArray(diffs) ? (diffs as ReconcileDiff[]) : [] } : {}),
  };
}

export function createD1ReconciliationAdmin(db: D1Database, deps: { clock: GatewayClock }) {
  return {
    /**
     * Replace one day's report from one source with `groups`, and audit it,
     * in one batch. Every group names an official upstream account by id and
     * its upstream; DeepSeek models must be Flash ones; a group appears once.
     * The day must have started.
     */
    async importReport(input: {
      day: string;
      source: GatewayReconcileSource;
      groups: UpstreamReportGroupInput[];
      actor: GatewayAdminActor;
      reason?: string;
    }): Promise<UpstreamReportView> {
      const window = gatewayDayWindow(input.day);
      const now = deps.clock.now();
      if (window.from > now)
        throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { param: "day", reason: "future" } });
      const seen = new Set<string>();
      for (const [index, group] of input.groups.entries()) {
        const key = JSON.stringify([group.upstreamId, group.accountId, group.modelCode]);
        if (seen.has(key))
          throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { param: `groups.${index}`, reason: "duplicate" } });
        seen.add(key);
        if (isBlockedDeepSeekModel(group.modelCode, group.upstreamId))
          throw new GatewayError("GATEWAY_CATALOG_MODEL_BLOCKED", { details: { modelCode: group.modelCode } });
      }
      const accountIds = [...new Set(input.groups.map((group) => group.accountId))];
      if (accountIds.length) {
        const { results } = await db
          .prepare(
            `SELECT id, upstream_id FROM gateway_upstream_account
              WHERE id IN (SELECT value FROM json_each(?1))`,
          )
          .bind(JSON.stringify(accountIds))
          .all<{ id: string; upstream_id: string }>();
        const upstreamOf = new Map(results.map((row) => [row.id, row.upstream_id]));
        for (const [index, group] of input.groups.entries())
          if (upstreamOf.get(group.accountId) !== group.upstreamId)
            throw new GatewayError("GATEWAY_UPSTREAM_NOT_FOUND", {
              details: { param: `groups.${index}.accountId`, accountId: group.accountId, upstreamId: group.upstreamId },
            });
      }
      const nowS = toSeconds(now);
      const before = await db
        .prepare(`SELECT groups, imported_at FROM gateway_upstream_report WHERE day = ?1 AND source = ?2`)
        .bind(input.day, input.source)
        .first<{ groups: number; imported_at: number }>();
      const reportId = `gwrr_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
      await db.batch([
        db.prepare(`DELETE FROM gateway_upstream_usage WHERE day = ?1 AND source = ?2`).bind(input.day, input.source),
        db.prepare(`DELETE FROM gateway_upstream_report WHERE day = ?1 AND source = ?2`).bind(input.day, input.source),
        db
          .prepare(
            `INSERT INTO gateway_upstream_report (id, day, source, groups, imported_at, imported_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(reportId, input.day, input.source, input.groups.length, nowS, input.actor.id),
        ...input.groups.map((group, index) =>
          db
            .prepare(
              `INSERT INTO gateway_upstream_usage
                 (id, day, source, upstream_id, account_id, model_code, requests, input_tokens, output_tokens,
                  cached_input_tokens, cache_write_tokens, units_json)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
            )
            .bind(
              `${reportId}_${index}`,
              input.day,
              input.source,
              group.upstreamId,
              group.accountId,
              group.modelCode,
              group.requests,
              group.inputTokens,
              group.outputTokens,
              group.cachedInputTokens,
              group.cacheWriteTokens,
              JSON.stringify(group.units),
            ),
        ),
        adminAuditStatement(db, {
          tenantId: "",
          actor: input.actor,
          action: "reconciliation.import",
          targetType: "gateway_upstream_report",
          targetId: `${input.day}:${input.source}`,
          before: before ? { groups: before.groups, importedAt: iso(before.imported_at) } : undefined,
          after: { groups: input.groups.length },
          reason: input.reason ?? null,
          nowS,
        }),
      ]);
      return { day: input.day, source: input.source, groups: input.groups.length, importedAt: iso(nowS), importedBy: input.actor.id };
    },

    /** Imported reports, newest day first. */
    async listReports(input: { from?: string; to?: string; limit: number }): Promise<UpstreamReportView[]> {
      const { results } = await db
        .prepare(
          `SELECT day, source, groups, imported_at, imported_by FROM gateway_upstream_report
            WHERE (?1 IS NULL OR day >= ?1) AND (?2 IS NULL OR day < ?2)
            ORDER BY day DESC, source LIMIT ?3`,
        )
        .bind(input.from ?? null, input.to ?? null, input.limit)
        .all<{ day: string; source: GatewayReconcileSource; groups: number; imported_at: number; imported_by: string }>();
      return results.map((row) => ({
        day: row.day,
        source: row.source,
        groups: row.groups,
        importedAt: iso(row.imported_at),
        importedBy: row.imported_by,
      }));
    },

    /** Runs, newest first (optionally one day's), without their per-group diffs. */
    async listRuns(input: { day?: string; status?: string; limit: number }): Promise<ReconcileRunView[]> {
      const { results } = await db
        .prepare(
          `SELECT * FROM gateway_reconciliation_run
            WHERE (?1 IS NULL OR day = ?1) AND (?2 IS NULL OR status = ?2)
            ORDER BY started_at DESC, id DESC LIMIT ?3`,
        )
        .bind(input.day ?? null, input.status ?? null, input.limit)
        .all<RunRow>();
      return results.map((row) => runView(row, false));
    },

    /** One run with its per-group diffs; GATEWAY_NOT_FOUND when absent. */
    async readRun(id: string): Promise<ReconcileRunView> {
      const row = await db.prepare(`SELECT * FROM gateway_reconciliation_run WHERE id = ?1`).bind(id).first<RunRow>();
      if (!row) throw new GatewayError("GATEWAY_RECONCILE_RUN_NOT_FOUND", { details: { runId: id } });
      return runView(row, true);
    },
  };
}

// ─── Entry points (scheduled handler, admin route) ───────────────────────

/** Run ids, `gwrec_` + 24 hex (the admin route's run id shape). */
export const reconcileRunIds: GatewayIds = {
  requestId: () => `gwrec_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
};

export interface ReconcileEnvOptions {
  clock?: GatewayClock;
  logger?: GatewayLogger;
}

function reconcilePorts(env: Pick<Env, "DB">, options: ReconcileEnvOptions & { auditActor?: GatewayAdminActor }) {
  const logger = options.logger ?? workersLogger();
  return {
    reconciliation: createD1ReconciliationPort(env.DB, {
      logger,
      ...(options.auditActor ? { auditActor: options.auditActor } : {}),
    }),
    ids: reconcileRunIds,
    clock: options.clock ?? monotonicClock(),
    logger,
  };
}

/** The nightly job: yesterday plus every day whose report changed since its last run. */
export function reconcileGatewayUsageNightly(
  env: Pick<Env, "DB">,
  options: ReconcileEnvOptions = {},
): Promise<NightlyReconcileResult> {
  return reconcileGatewayUsage(reconcilePorts(env, options));
}

/** Reconcile one day on demand (admin route): the run is audited in its own batch. */
export function reconcileGatewayDay(
  env: Pick<Env, "DB">,
  input: { day: string; source?: GatewayReconcileSource; actor: GatewayAdminActor },
  options: ReconcileEnvOptions = {},
): Promise<ReconcileRunResult> {
  const actor: ReconcileActor = { kind: "admin", id: input.actor.id };
  return reconcileGatewayUsageDay(reconcilePorts(env, { ...options, auditActor: input.actor }), {
    day: input.day,
    actor,
    ...(input.source ? { source: input.source } : {}),
  });
}
