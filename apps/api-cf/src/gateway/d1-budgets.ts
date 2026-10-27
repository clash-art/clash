/**
 * Budgets and ledger over D1 (`gateway_budget`, `gateway_usage_ledger`,
 * `gateway_idempotency_claim`) under the hybrid settlement model (#399,
 * gateway-core budget.ts). There are no holds: `reserved_micro_credits` is
 * the retired reserve path's counter, zero since migration 0042.
 *
 * debit (media/AIGC prepay at admission): one `batch` (a D1 transaction)
 * debits every budget or none. Per budget: a conditional UPDATE (active,
 * covered unless the budget is not `hard`, no `settle` row yet for this
 * request), the request's `settle` row appended only when that UPDATE changed
 * a row, and a guard insert that violates the ledger's `amount >= 0` CHECK
 * when it did not, which rolls the whole batch back. A rejected batch is then
 * explained from a snapshot by gateway-core's own `planDebit`, so the coded
 * error matches every other adapter.
 *
 * check (text/LLM postpay admission): reads the budgets and applies
 * gateway-core's `planCheck` (every hard budget above `-floor`); it writes no
 * money, only the idempotency claim and the flags.
 *
 * charge (a text settle run) and refund (a media settle run): one batch per
 * request, idempotent through the ledger's unique `(request_id, budget_id,
 * kind)`: each budget's counter moves only together with the insert of its
 * `settle` (charge) or `refund` row, so a repeated run moves nothing. A
 * charge is never refused (the work was done); a refund returns exactly what
 * each budget's `settle` row recorded and points at it (ref_kind `settle`).
 *
 * Idempotency-Key claims (0042) are taken in the admission batch: an
 * `INSERT OR IGNORE` then a guard that rolls the batch back unless this
 * request owns the claim. `endIdempotency` closes it after the follow-up is
 * journaled.
 *
 * Enforcement (#354, 0041): only a `hard` budget's limit refuses. A `soft` or
 * `alert` budget debits past it, and the same batch appends its
 * `gateway_budget_event` rows (soft_exceeded per request, alert_threshold per
 * limit and threshold, deduplicated by a unique index); the rows it inserted
 * are the admission's flags. A charge records the flags its cost raises.
 *
 * A caller without any budget row is refused (GATEWAY_BUDGET_EXCEEDED,
 * reason `no_budget`): a missing budget is never unlimited. The one exception
 * is a tenant-scope (BYOK, #369) request, admitted with no money write since
 * the tenant pays its own upstream. Periodic reset of
 * `daily`/`monthly` budgets is not implemented yet; such budgets keep counting
 * (fail closed) until the reset job lands.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  GatewayError,
  assertMicroCredits,
  planCheck,
  planDebit,
  type BudgetEnforcement,
  type BudgetEntryInput,
  type BudgetFlag,
  type BudgetScope,
  type BudgetState,
  type GatewayBudgetPort,
  type GatewayClock,
  type GatewayCredentialScope,
  type GatewayLedgerPort,
  type GatewayLedgerStatus,
  type IdempotencyClaim,
  type UsageEvent,
} from "@clash/gateway-core";

import { parseJson, toMs, toSeconds } from "./d1-common";

interface BudgetRow {
  id: string;
  tenant_id: string;
  scope: BudgetScope;
  scope_id: string;
  status: string;
  limit_micro_credits: number | null;
  spent_micro_credits: number;
  reserved_micro_credits: number;
  version: number;
  reset_at: number | null;
  enforcement: BudgetEnforcement;
  alert_threshold_pct: number | null;
}

/** A gateway_budget_event row a money batch inserted (RETURNING). */
interface BudgetEventRow {
  budget_id: string;
  scope: BudgetScope;
  kind: BudgetFlag["kind"];
  enforcement: BudgetEnforcement;
  dedupe_key: string;
  limit_micro_credits: number;
  spent_micro_credits: number;
  reserved_micro_credits: number;
  threshold_pct: number | null;
}

interface SettleRow {
  request_id: string;
  tenant_id: string;
  user_id: string | null;
  key_id: string | null;
  status: string;
  amount_micro_credits: number;
  model_code: string | null;
  model_kind: string | null;
  credential_scope: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  units_json: string;
  usage_source: string | null;
  price_version: string | null;
  catalog_version: string | null;
  upstream_id: string | null;
  account_id: string | null;
  error_code: string | null;
  occurred_at: number;
  /** The refund row of the same budget, when the debit was refunded. */
  refund_status: string | null;
  refund_error_code: string | null;
  refunded_micro_credits: number;
}

const BUDGET_COLUMNS = `id, tenant_id, scope, scope_id, status, limit_micro_credits,
  spent_micro_credits, reserved_micro_credits, version, reset_at, enforcement, alert_threshold_pct`;

const EVENT_COLUMNS = `(id, tenant_id, budget_id, scope, scope_id, kind, enforcement, dedupe_key, request_id,
  limit_micro_credits, spent_micro_credits, reserved_micro_credits, threshold_pct, occurred_at)`;
const EVENT_RETURNING = `RETURNING budget_id, scope, kind, enforcement, dedupe_key, limit_micro_credits,
  spent_micro_credits, reserved_micro_credits, threshold_pct`;

function budgetFlag(row: BudgetEventRow): BudgetFlag {
  return {
    budgetId: row.budget_id,
    scope: row.scope,
    kind: row.kind,
    enforcement: row.enforcement,
    limitMicroCredits: row.limit_micro_credits,
    usedMicroCredits: row.spent_micro_credits + row.reserved_micro_credits,
    ...(row.threshold_pct !== null ? { thresholdPct: row.threshold_pct } : {}),
    dedupeKey: row.dedupe_key,
  };
}

/** A settle row joined with its budget's refund row (alias `r`), if any. */
const SETTLE_COLUMNS = `l.request_id, l.tenant_id, l.user_id, l.key_id, l.status, l.amount_micro_credits,
  l.model_code, l.model_kind, l.credential_scope, l.input_tokens, l.output_tokens, l.cached_input_tokens,
  l.cache_write_tokens, l.units_json, l.usage_source, l.price_version, l.catalog_version, l.upstream_id,
  l.account_id, l.error_code, l.occurred_at, r.status AS refund_status, r.error_code AS refund_error_code,
  COALESCE(r.amount_micro_credits, 0) AS refunded_micro_credits`;
const WITH_REFUND = `gateway_usage_ledger l LEFT JOIN gateway_usage_ledger r
  ON r.request_id = l.request_id AND r.budget_id = l.budget_id AND r.kind = 'refund'`;

function budgetState(row: BudgetRow): BudgetState {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    limitMicroCredits: row.limit_micro_credits,
    spentMicroCredits: row.spent_micro_credits,
    reservedMicroCredits: row.reserved_micro_credits,
    version: row.version,
    ...(row.reset_at !== null ? { resetAt: toMs(row.reset_at) } : {}),
    enforcement: row.enforcement,
    ...(row.alert_threshold_pct !== null ? { alertThresholdPct: row.alert_threshold_pct } : {}),
  };
}

/** One request's ledger event; a refunded debit reads as its refund at a net cost of zero. */
function usageEvent(row: SettleRow): UsageEvent {
  const units = parseJson(row.units_json);
  const errorCode = row.refund_status !== null ? row.refund_error_code : row.error_code;
  return {
    requestId: row.request_id,
    tenantId: row.tenant_id,
    userId: row.user_id ?? "",
    ...(row.key_id ? { keyId: row.key_id } : {}),
    modelCode: row.model_code ?? "",
    kind: (row.model_kind ?? "text") as UsageEvent["kind"],
    upstreamId: row.upstream_id ?? "",
    ...(row.account_id ? { accountId: row.account_id } : {}),
    credentialScope: row.credential_scope === "tenant" ? "tenant" : "official",
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedInputTokens: row.cached_input_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      units: units && typeof units === "object" && !Array.isArray(units) ? (units as UsageEvent["usage"]["units"]) : {},
      source: row.usage_source === "estimated" ? "estimated" : "reported",
    },
    costMicroCredits: row.amount_micro_credits - row.refunded_micro_credits,
    priceVersion: row.price_version ?? "",
    catalogVersion: row.catalog_version ?? "",
    status: (row.refund_status ?? row.status) as GatewayLedgerStatus,
    ...(errorCode ? { errorCode } : {}),
    occurredAt: toMs(row.occurred_at),
  };
}

/** One settle row per budget carries the same event; reads take the first by budget id. */
export const ONE_SETTLE_PER_REQUEST = `l.budget_id = (SELECT MIN(s.budget_id) FROM gateway_usage_ledger s
  WHERE s.request_id = l.request_id AND s.kind = 'settle')`;

const SETTLE_INSERT = `INSERT INTO gateway_usage_ledger
   (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id,
    amount_micro_credits, model_code, model_kind, credential_scope,
    input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
    units_json, usage_source, price_version, catalog_version,
    upstream_id, account_id, error_code, occurred_at)
 SELECT ?2 || ':settle:' || ?1, ?2, ?1, 'settle', ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
  WHERE changes() = 1`;

/** A request's `settle` row on one budget, the event and its billing basis (?1 budget, ?2 request). */
const settleBinds = (budgetId: string, event: UsageEvent) =>
  [
    budgetId,
    event.requestId,
    event.status,
    event.tenantId,
    event.userId,
    event.keyId ?? null,
    event.costMicroCredits,
    event.modelCode,
    event.kind,
    event.credentialScope,
    event.usage.inputTokens,
    event.usage.outputTokens,
    event.usage.cachedInputTokens,
    event.usage.cacheWriteTokens,
    JSON.stringify(event.usage.units),
    event.usage.source,
    event.priceVersion,
    event.catalogVersion,
    event.upstreamId,
    event.accountId ?? null,
    event.errorCode ?? null,
    toSeconds(event.occurredAt),
  ] as const;

/** The guard row: violates the ledger's CHECK (amount >= 0), rolling the batch back. */
const refusalGuard = (where: string) => `INSERT INTO gateway_usage_ledger
   (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits, occurred_at)
 SELECT ?2 || ':refused:' || ?1, ?2, ?1, 'release', 'refused', ?3, -1, ?4
  WHERE ${where}`;

export function createD1GatewayBudgetPorts(
  db: D1Database,
  deps: { clock: GatewayClock },
): { budgets: GatewayBudgetPort; ledger: GatewayLedgerPort } {
  async function budgetRows(tenantId: string, budgetIds?: readonly string[]): Promise<BudgetRow[]> {
    if (budgetIds && budgetIds.length === 0) return [];
    const filter = budgetIds ? ` AND id IN (${budgetIds.map(() => "?").join(", ")})` : "";
    const { results } = await db
      .prepare(`SELECT ${BUDGET_COLUMNS} FROM gateway_budget WHERE tenant_id = ?${filter} ORDER BY id`)
      .bind(tenantId, ...(budgetIds ?? []))
      .all<BudgetRow>();
    return results;
  }

  /**
   * The caller's budget ids, sorted. BYOK (#369): a tenant-scope request with
   * no budget row is admitted with no money write (the tenant pays its own
   * upstream, and the core owes it no follow-up). An official-scope request
   * with no budget never is; a BYOK caller with budgets pays them.
   */
  function budgetIdsOf(input: { budgetIds: readonly string[]; credentialScope?: GatewayCredentialScope }): string[] {
    const ids = [...new Set(input.budgetIds)].sort();
    if (ids.length === 0 && input.credentialScope !== "tenant")
      throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", { details: { reason: "no_budget" } });
    return ids;
  }

  /** The caller's budgets, every one found and active, or the coded refusal. */
  async function admissibleBudgets(tenantId: string, ids: readonly string[]): Promise<BudgetState[]> {
    const rows = await budgetRows(tenantId, ids);
    const found = new Set(rows.map((row) => row.id));
    const missing = ids.find((id) => !found.has(id));
    if (missing)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "Budget not found for tenant; a missing budget is never unlimited.",
        details: { budgetId: missing },
      });
    const suspended = rows.find((row) => row.status !== "active");
    if (suspended)
      throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", {
        details: { budgetId: suspended.id, scope: suspended.scope, reason: "suspended" },
      });
    return rows.map(budgetState);
  }

  /** Take the Idempotency-Key's claim in the admission batch: rolls back unless this request owns it. */
  function claimStatements(tenantId: string, requestId: string, claim: IdempotencyClaim | undefined, nowS: number) {
    if (!claim) return [];
    return [
      db
        .prepare(
          `INSERT OR IGNORE INTO gateway_idempotency_claim (tenant_id, idempotency_key, request_id, expires_at)
           VALUES (?1, ?2, ?3, ?4)`,
        )
        .bind(tenantId, claim.key, requestId, toSeconds(claim.expiresAt)),
      db
        .prepare(
          refusalGuard(`NOT EXISTS (SELECT 1 FROM gateway_idempotency_claim
                         WHERE tenant_id = ?3 AND idempotency_key = ?5 AND request_id = ?2)`),
        )
        .bind("idempotency", requestId, tenantId, nowS, claim.key),
    ];
  }

  /** Another request's claim on the key, as its coded refusal; null when the key is free or ours. */
  async function claimRefusal(tenantId: string, requestId: string, claim: IdempotencyClaim | undefined) {
    if (!claim) return null;
    const prior = await db
      .prepare(
        `SELECT request_id, ended_at, expires_at FROM gateway_idempotency_claim
          WHERE tenant_id = ? AND idempotency_key = ?`,
      )
      .bind(tenantId, claim.key)
      .first<{ request_id: string; ended_at: number | null; expires_at: number }>();
    if (!prior || prior.request_id === requestId) return null;
    const open = prior.ended_at === null && prior.expires_at > toSeconds(deps.clock.now());
    return new GatewayError(open ? "GATEWAY_IDEMPOTENCY_IN_PROGRESS" : "GATEWAY_IDEMPOTENCY_ALREADY_SETTLED", {
      details: { requestId: prior.request_id },
    });
  }

  /**
   * The flags a money write (or a text check) raises, in its batch: core
   * budgetFlags in SQL over the counters after the write. A soft budget past
   * its limit once per request, an alert threshold once per limit and threshold.
   */
  function flagStatements(tenantId: string, requestId: string, ids: readonly string[], nowS: number) {
    return ids.flatMap((budgetId) => [
      db
        .prepare(
          `INSERT OR IGNORE INTO gateway_budget_event ${EVENT_COLUMNS}
           SELECT ?3 || ':soft:' || id, tenant_id, id, scope, scope_id, 'soft_exceeded', enforcement, ?3, ?3,
                  limit_micro_credits, spent_micro_credits, reserved_micro_credits, NULL, ?4
             FROM gateway_budget
            WHERE id = ?1 AND tenant_id = ?2 AND enforcement = 'soft' AND limit_micro_credits IS NOT NULL
              AND spent_micro_credits + reserved_micro_credits > limit_micro_credits
           ${EVENT_RETURNING}`,
        )
        .bind(budgetId, tenantId, requestId, nowS),
      db
        .prepare(
          `INSERT OR IGNORE INTO gateway_budget_event ${EVENT_COLUMNS}
           SELECT ?3 || ':alert:' || id, tenant_id, id, scope, scope_id, 'alert_threshold', enforcement,
                  'limit=' || limit_micro_credits || ';pct=' || COALESCE(alert_threshold_pct, 100), ?3,
                  limit_micro_credits, spent_micro_credits, reserved_micro_credits,
                  COALESCE(alert_threshold_pct, 100), ?4
             FROM gateway_budget
            WHERE id = ?1 AND tenant_id = ?2 AND limit_micro_credits IS NOT NULL
              AND (alert_threshold_pct IS NOT NULL OR enforcement = 'alert')
              AND (spent_micro_credits + reserved_micro_credits) * 100
                  >= limit_micro_credits * COALESCE(alert_threshold_pct, 100)
           ${EVENT_RETURNING}`,
        )
        .bind(budgetId, tenantId, requestId, nowS),
    ]);
  }

  const recordedFlags = (results: Awaited<ReturnType<D1Database["batch"]>>, from: number) =>
    results
      .slice(from)
      .flatMap((result) => (result.results ?? []) as BudgetEventRow[])
      .map(budgetFlag);

  /** What the first write of `kind` recorded for the request, if any. */
  async function recorded(requestId: string, tenantId: string, kind: "settle" | "refund") {
    const row = await db
      .prepare(
        `SELECT amount_micro_credits FROM gateway_usage_ledger
          WHERE request_id = ? AND tenant_id = ? AND kind = ? ORDER BY budget_id LIMIT 1`,
      )
      .bind(requestId, tenantId, kind)
      .first<{ amount_micro_credits: number }>();
    return row?.amount_micro_credits;
  }

  const budgets: GatewayBudgetPort = {
    async check(input) {
      assertMicroCredits(input.floorMicroCredits, "floor");
      const ids = budgetIdsOf(input);
      if (ids.length > 0)
        planCheck(await admissibleBudgets(input.tenantId, ids), input.floorMicroCredits, input.requestId);
      const nowS = toSeconds(deps.clock.now());
      const claim = claimStatements(input.tenantId, input.requestId, input.idempotency, nowS);
      if (ids.length === 0 && claim.length === 0) return {};
      let results: Awaited<ReturnType<D1Database["batch"]>>;
      try {
        results = await db.batch([...claim, ...flagStatements(input.tenantId, input.requestId, ids, nowS)]);
      } catch (cause) {
        throw (
          (await claimRefusal(input.tenantId, input.requestId, input.idempotency)) ??
          new GatewayError("GATEWAY_INTERNAL", { message: "The admission check was refused.", cause })
        );
      }
      const flags = recordedFlags(results, claim.length);
      return flags.length ? { flags } : {};
    },

    async debit({ budgetIds, idempotency, ...event }) {
      assertMicroCredits(event.costMicroCredits, "debit");
      const ids = budgetIdsOf({ budgetIds, credentialScope: event.credentialScope });
      const nowS = toSeconds(deps.clock.now());
      const claim = claimStatements(event.tenantId, event.requestId, idempotency, nowS);
      if (ids.length === 0 && claim.length === 0) return {};
      const statements: D1PreparedStatement[] = [...claim];
      for (const budgetId of ids)
        statements.push(
          db
            .prepare(
              `UPDATE gateway_budget
                  SET spent_micro_credits = spent_micro_credits + ?2,
                      version = version + 1, updated_at = ?4
                WHERE id = ?1 AND tenant_id = ?5 AND status = 'active'
                  AND (limit_micro_credits IS NULL OR enforcement <> 'hard'
                       OR spent_micro_credits + reserved_micro_credits + ?2 <= limit_micro_credits)
                  AND NOT EXISTS (SELECT 1 FROM gateway_usage_ledger
                                   WHERE request_id = ?3 AND budget_id = ?1 AND kind = 'settle')`,
            )
            .bind(budgetId, event.costMicroCredits, event.requestId, nowS, event.tenantId),
          db.prepare(SETTLE_INSERT).bind(...settleBinds(budgetId, event)),
          // All or nothing: no settle row above means this guard rolls the batch back.
          db.prepare(refusalGuard("changes() = 0")).bind(budgetId, event.requestId, event.tenantId, nowS),
        );
      let results: Awaited<ReturnType<D1Database["batch"]>>;
      try {
        results = await db.batch([...statements, ...flagStatements(event.tenantId, event.requestId, ids, nowS)]);
      } catch (cause) {
        const refused = await claimRefusal(event.tenantId, event.requestId, idempotency);
        if (refused) throw refused;
        planDebit(await admissibleBudgets(event.tenantId, ids), event.costMicroCredits, event.requestId);
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "The debit was refused.",
          details: { requestId: event.requestId },
          cause,
        });
      }
      const flags = recordedFlags(results, statements.length);
      return flags.length ? { flags } : {};
    },

    async charge({ budgetIds, ...event }: BudgetEntryInput) {
      assertMicroCredits(event.costMicroCredits, "charge");
      const ids = budgetIdsOf({ budgetIds });
      const prior = await recorded(event.requestId, event.tenantId, "settle");
      if (prior !== undefined)
        return { requestId: event.requestId, kind: "charge", costMicroCredits: prior, duplicate: true };
      const nowS = toSeconds(deps.clock.now());
      const statements: D1PreparedStatement[] = [];
      for (const budgetId of ids)
        statements.push(
          // Never refused: the work was done. Suspension and limits only gate admission.
          db
            .prepare(
              `UPDATE gateway_budget
                  SET spent_micro_credits = spent_micro_credits + ?2,
                      version = version + 1, updated_at = ?4
                WHERE id = ?1 AND tenant_id = ?5
                  AND NOT EXISTS (SELECT 1 FROM gateway_usage_ledger
                                   WHERE request_id = ?3 AND budget_id = ?1 AND kind = 'settle')`,
            )
            .bind(budgetId, event.costMicroCredits, event.requestId, nowS, event.tenantId),
          db.prepare(SETTLE_INSERT).bind(...settleBinds(budgetId, event)),
        );
      const results = await db.batch([...statements, ...flagStatements(event.tenantId, event.requestId, ids, nowS)]);
      if (results.some((result, index) => index < statements.length && index % 2 === 1 && result.meta.changes > 0))
        return { requestId: event.requestId, kind: "charge", costMicroCredits: event.costMicroCredits, duplicate: false };
      // A concurrent run charged first: report what it recorded.
      const winner = await recorded(event.requestId, event.tenantId, "settle");
      if (winner === undefined)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "The charge found none of its budgets.",
          details: { requestId: event.requestId },
        });
      return { requestId: event.requestId, kind: "charge", costMicroCredits: winner, duplicate: true };
    },

    async refund(input) {
      const { results: debited } = await db
        .prepare(
          `SELECT budget_id, amount_micro_credits FROM gateway_usage_ledger
            WHERE request_id = ? AND tenant_id = ? AND kind = 'settle' ORDER BY budget_id`,
        )
        .bind(input.requestId, input.tenantId)
        .all<{ budget_id: string; amount_micro_credits: number }>();
      if (debited.length === 0)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "Refund for a request that recorded no money.",
          details: { requestId: input.requestId },
        });
      const amount = debited[0]!.amount_micro_credits;
      const nowS = toSeconds(deps.clock.now());
      const debitRow = `SELECT amount_micro_credits FROM gateway_usage_ledger
        WHERE request_id = ?2 AND budget_id = ?1 AND kind = 'settle'`;
      const statements: D1PreparedStatement[] = [];
      for (const { budget_id: budgetId } of debited)
        statements.push(
          db
            .prepare(
              `UPDATE gateway_budget
                  SET spent_micro_credits = spent_micro_credits - (${debitRow}),
                      version = version + 1, updated_at = ?3
                WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM gateway_usage_ledger
                                               WHERE request_id = ?2 AND budget_id = ?1 AND kind = 'refund')`,
            )
            .bind(budgetId, input.requestId, nowS),
          db
            .prepare(
              `INSERT INTO gateway_usage_ledger
                 (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id, amount_micro_credits,
                  model_code, model_kind, credential_scope, units_json, price_version, catalog_version,
                  upstream_id, account_id, error_code, ref_kind, ref_id, occurred_at)
               SELECT ?2 || ':refund:' || ?1, ?2, ?1, 'refund', ?3, s.tenant_id, s.user_id, s.key_id,
                      s.amount_micro_credits, s.model_code, s.model_kind, s.credential_scope, s.units_json,
                      s.price_version, s.catalog_version, s.upstream_id, s.account_id, ?4, 'settle', s.id, ?5
                 FROM gateway_usage_ledger s
                WHERE s.request_id = ?2 AND s.budget_id = ?1 AND s.kind = 'settle' AND changes() = 1`,
            )
            .bind(budgetId, input.requestId, input.status, input.errorCode ?? null, toSeconds(input.occurredAt)),
        );
      const results = await db.batch(statements);
      const wrote = results.some((result, index) => index % 2 === 1 && result.meta.changes > 0);
      return { requestId: input.requestId, kind: "refund", costMicroCredits: amount, duplicate: !wrote };
    },

    async endIdempotency({ requestId, tenantId }) {
      await db
        .prepare(
          `UPDATE gateway_idempotency_claim SET ended_at = ?3
            WHERE request_id = ?1 AND tenant_id = ?2 AND ended_at IS NULL`,
        )
        .bind(requestId, tenantId, toSeconds(deps.clock.now()))
        .run();
    },

    async snapshot({ tenantId, budgetIds }) {
      return (await budgetRows(tenantId, budgetIds)).map(budgetState);
    },
  };

  const ledger: GatewayLedgerPort = {
    async get({ tenantId, requestId }) {
      const row = await db
        .prepare(
          `SELECT ${SETTLE_COLUMNS} FROM ${WITH_REFUND}
            WHERE l.tenant_id = ? AND l.request_id = ? AND l.kind = 'settle'
            ORDER BY l.budget_id LIMIT 1`,
        )
        .bind(tenantId, requestId)
        .first<SettleRow>();
      return row ? usageEvent(row) : null;
    },
    async query(filter) {
      const { results } = await db
        .prepare(
          `SELECT ${SETTLE_COLUMNS} FROM ${WITH_REFUND}
            WHERE l.tenant_id = ?1 AND l.kind = 'settle' AND ${ONE_SETTLE_PER_REQUEST}
              AND (?2 IS NULL OR l.user_id = ?2) AND (?3 IS NULL OR l.key_id = ?3)
              AND (?4 IS NULL OR l.occurred_at >= ?4) AND (?5 IS NULL OR l.occurred_at < ?5)
            ORDER BY l.occurred_at DESC, l.request_id DESC LIMIT ?6`,
        )
        .bind(
          filter.tenantId,
          filter.userId ?? null,
          filter.keyId ?? null,
          filter.from !== undefined ? toSeconds(filter.from) : null,
          filter.to !== undefined ? Math.ceil(filter.to / 1000) : null,
          filter.limit ?? 100,
        )
        .all<SettleRow>();
      return results.map(usageEvent);
    },
  };

  return { budgets, ledger };
}
