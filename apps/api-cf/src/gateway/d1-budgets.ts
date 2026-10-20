/**
 * Budgets and ledger over D1 (`gateway_budget`, `gateway_usage_ledger`).
 *
 * reserve: one `batch` (a D1 transaction) holds on every budget or none. Per
 * budget: a conditional UPDATE (active, under limit, no hold yet for this
 * request, idempotency key unused), the `hold` row appended only when that
 * UPDATE changed a row, and a guard insert that violates the ledger's
 * `amount >= 0` CHECK when it did not, which rolls the whole batch back. A
 * rejected batch is then explained from a snapshot by gateway-core's own
 * `planReserve`, so the coded error matches every other adapter.
 *
 * settle: one batch per request: each open hold is closed (spent += cost,
 * reserved -= stored hold), its status moves to settled/released and a
 * `settle` row carrying the billing basis is appended, once per budget. A
 * repeated settlement finds no open hold and is a no-op.
 *
 * markSettleFailed: when settle itself fails, the still-open hold rows move to
 * status `settle_failed` (error_code = the failure's code) and the budget
 * keeps the amount reserved. A later settle closes `settle_failed` holds like
 * open ones, under the same once-per-request guards, so a retry never charges
 * twice. `gateway_usage_ledger.status` has no CHECK, so this needs no
 * migration.
 *
 * A caller without any budget row is refused (GATEWAY_BUDGET_EXCEEDED,
 * reason `no_budget`): a missing budget is never unlimited. Periodic reset of
 * `daily`/`monthly` budgets is not implemented yet; such budgets keep counting
 * (fail closed) until the reset job lands.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  GatewayError,
  assertMicroCredits,
  planReserve,
  type BudgetScope,
  type BudgetState,
  type GatewayBudgetPort,
  type GatewayClock,
  type GatewayLedgerPort,
  type GatewayLedgerStatus,
  type ReserveInput,
  type UsageEvent,
} from "@clash/gateway-core";

import { parseJson, toMs, toSeconds } from "./d1-common";

const IDEMPOTENCY_REF = "idempotency";

/** A hold no settlement has closed yet: open, or marked after a failed settlement. */
const UNSETTLED_HOLD = "status IN ('open', 'settle_failed')";

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
}

const BUDGET_COLUMNS = `id, tenant_id, scope, scope_id, status, limit_micro_credits,
  spent_micro_credits, reserved_micro_credits, version, reset_at`;

const SETTLE_COLUMNS = `request_id, tenant_id, user_id, key_id, status, amount_micro_credits,
  model_code, model_kind, credential_scope, input_tokens, output_tokens, cached_input_tokens,
  cache_write_tokens, units_json, usage_source, price_version, catalog_version, upstream_id,
  account_id, error_code, occurred_at`;

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
  };
}

function usageEvent(row: SettleRow): UsageEvent {
  const units = parseJson(row.units_json);
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
    costMicroCredits: row.amount_micro_credits,
    priceVersion: row.price_version ?? "",
    catalogVersion: row.catalog_version ?? "",
    status: row.status as GatewayLedgerStatus,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    occurredAt: toMs(row.occurred_at),
  };
}

/** One settle row per budget carries the same event; reads take the first by budget id. */
const ONE_SETTLE_PER_REQUEST = `l.budget_id = (SELECT MIN(s.budget_id) FROM gateway_usage_ledger s
  WHERE s.request_id = l.request_id AND s.kind = 'settle')`;

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

  /** Why a reserve batch was refused, as the same coded error every adapter raises. */
  async function explainRefusal(input: ReserveInput, ids: readonly string[], cause: unknown): Promise<GatewayError> {
    if (input.idempotencyKey) {
      const prior = await db
        .prepare(
          `SELECT request_id, MAX(${UNSETTLED_HOLD}) AS open FROM gateway_usage_ledger
            WHERE tenant_id = ? AND kind = 'hold' AND ref_kind = ? AND ref_id = ? AND request_id <> ?
            GROUP BY request_id LIMIT 1`,
        )
        .bind(input.tenantId, IDEMPOTENCY_REF, input.idempotencyKey, input.requestId)
        .first<{ request_id: string; open: number }>();
      if (prior)
        return new GatewayError(
          prior.open ? "GATEWAY_IDEMPOTENCY_IN_PROGRESS" : "GATEWAY_IDEMPOTENCY_ALREADY_SETTLED",
          { details: { requestId: prior.request_id } },
        );
    }
    const rows = await budgetRows(input.tenantId, ids);
    const found = new Set(rows.map((row) => row.id));
    const missing = ids.find((id) => !found.has(id));
    if (missing)
      return new GatewayError("GATEWAY_INTERNAL", {
        message: "Budget not found for tenant; a missing budget is never unlimited.",
        details: { budgetId: missing },
      });
    const suspended = rows.find((row) => row.status !== "active");
    if (suspended)
      return new GatewayError("GATEWAY_BUDGET_EXCEEDED", {
        details: { budgetId: suspended.id, scope: suspended.scope, reason: "suspended" },
      });
    try {
      planReserve(rows.map(budgetState), input.holdMicroCredits);
    } catch (error) {
      return error as GatewayError;
    }
    return new GatewayError("GATEWAY_INTERNAL", {
      message: "The reservation was refused.",
      details: { requestId: input.requestId },
      cause,
    });
  }

  const budgets: GatewayBudgetPort = {
    async reserve(input) {
      assertMicroCredits(input.holdMicroCredits, "hold");
      const ids = [...new Set(input.budgetIds)].sort();
      if (ids.length === 0)
        throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", { details: { reason: "no_budget" } });
      const nowS = toSeconds(deps.clock.now());
      const expiresS = Math.ceil(input.expiresAt / 1000);
      const key = input.idempotencyKey ?? null;
      const statements: D1PreparedStatement[] = [];
      for (const budgetId of ids) {
        statements.push(
          db
            .prepare(
              `UPDATE gateway_budget
                  SET reserved_micro_credits = reserved_micro_credits + ?2,
                      version = version + 1, updated_at = ?4
                WHERE id = ?1 AND tenant_id = ?5 AND status = 'active'
                  AND (limit_micro_credits IS NULL
                       OR spent_micro_credits + reserved_micro_credits + ?2 <= limit_micro_credits)
                  AND NOT EXISTS (SELECT 1 FROM gateway_usage_ledger
                                   WHERE request_id = ?3 AND budget_id = ?1 AND kind = 'hold')
                  AND (?6 IS NULL OR NOT EXISTS (
                        SELECT 1 FROM gateway_usage_ledger
                         WHERE tenant_id = ?5 AND kind = 'hold' AND ref_kind = '${IDEMPOTENCY_REF}'
                           AND ref_id = ?6 AND request_id <> ?3))`,
            )
            .bind(budgetId, input.holdMicroCredits, input.requestId, nowS, input.tenantId, key),
          db
            .prepare(
              `INSERT INTO gateway_usage_ledger
                 (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits,
                  ref_kind, ref_id, expires_at, occurred_at)
               SELECT ?3 || ':hold:' || ?1, ?3, ?1, 'hold', 'open', ?5, ?2,
                      CASE WHEN ?6 IS NULL THEN NULL ELSE '${IDEMPOTENCY_REF}' END, ?6, ?7, ?4
                WHERE changes() = 1`,
            )
            .bind(budgetId, input.holdMicroCredits, input.requestId, nowS, input.tenantId, key, expiresS),
          // All or nothing: no hold row above means this insert breaks the
          // ledger's CHECK (amount_micro_credits >= 0) and the batch rolls back.
          db
            .prepare(
              `INSERT INTO gateway_usage_ledger
                 (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits, occurred_at)
               SELECT ?2 || ':refused:' || ?1, ?2, ?1, 'release', 'refused', ?3, -1, ?4
                WHERE changes() = 0`,
            )
            .bind(budgetId, input.requestId, input.tenantId, nowS),
        );
      }
      try {
        await db.batch(statements);
      } catch (cause) {
        throw await explainRefusal(input, ids, cause);
      }
      return {
        requestId: input.requestId,
        holds: ids.map((budgetId) => ({ budgetId, microCredits: input.holdMicroCredits })),
        expiresAt: input.expiresAt,
      };
    },

    async settle(event) {
      assertMicroCredits(event.costMicroCredits, "cost");
      const existing = await db
        .prepare(
          `SELECT amount_micro_credits FROM gateway_usage_ledger
            WHERE request_id = ? AND tenant_id = ? AND kind = 'settle' LIMIT 1`,
        )
        .bind(event.requestId, event.tenantId)
        .first<{ amount_micro_credits: number }>();
      if (existing)
        return { requestId: event.requestId, costMicroCredits: existing.amount_micro_credits, duplicate: true };
      const { results: holds } = await db
        .prepare(
          `SELECT budget_id FROM gateway_usage_ledger
            WHERE request_id = ? AND tenant_id = ? AND kind = 'hold' AND ${UNSETTLED_HOLD}
            ORDER BY budget_id`,
        )
        .bind(event.requestId, event.tenantId)
        .all<{ budget_id: string }>();
      if (holds.length === 0)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "Settlement for a request with no open reservation.",
          details: { requestId: event.requestId },
        });
      const nowS = toSeconds(deps.clock.now());
      const holdStatus = event.costMicroCredits > 0 ? "settled" : "released";
      const openHold = `SELECT amount_micro_credits FROM gateway_usage_ledger
        WHERE request_id = ?2 AND budget_id = ?1 AND kind = 'hold' AND ${UNSETTLED_HOLD}`;
      const statements: D1PreparedStatement[] = [];
      for (const { budget_id: budgetId } of holds)
        statements.push(
          db
            .prepare(
              `UPDATE gateway_budget
                  SET spent_micro_credits = spent_micro_credits + ?3,
                      reserved_micro_credits = reserved_micro_credits - (${openHold}),
                      version = version + 1, updated_at = ?4
                WHERE id = ?1 AND EXISTS (${openHold})`,
            )
            .bind(budgetId, event.requestId, event.costMicroCredits, nowS),
          db
            .prepare(
              `UPDATE gateway_usage_ledger SET status = ?3
                WHERE request_id = ?2 AND budget_id = ?1 AND kind = 'hold' AND ${UNSETTLED_HOLD}`,
            )
            .bind(budgetId, event.requestId, holdStatus),
          db
            .prepare(
              `INSERT INTO gateway_usage_ledger
                 (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id,
                  amount_micro_credits, model_code, model_kind, credential_scope,
                  input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
                  units_json, usage_source, price_version, catalog_version,
                  upstream_id, account_id, error_code, occurred_at)
               SELECT ?2 || ':settle:' || ?1, ?2, ?1, 'settle', ?3, ?4, ?5, ?6,
                      ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
                WHERE changes() = 1`,
            )
            .bind(
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
            ),
        );
      const results = await db.batch(statements);
      const wrote = results.some((result, index) => index % 3 === 2 && result.meta.changes > 0);
      if (wrote) return { requestId: event.requestId, costMicroCredits: event.costMicroCredits, duplicate: false };
      // A concurrent settlement closed the holds first: report its cost.
      const winner = await db
        .prepare(
          `SELECT amount_micro_credits FROM gateway_usage_ledger
            WHERE request_id = ? AND tenant_id = ? AND kind = 'settle' LIMIT 1`,
        )
        .bind(event.requestId, event.tenantId)
        .first<{ amount_micro_credits: number }>();
      if (!winner)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "Settlement wrote nothing.",
          details: { requestId: event.requestId },
        });
      return { requestId: event.requestId, costMicroCredits: winner.amount_micro_credits, duplicate: true };
    },

    async markSettleFailed({ requestId, tenantId, errorCode }) {
      // Only the hold rows change; budget counters keep the hold reserved.
      const [, state] = await db.batch([
        db
          .prepare(
            `UPDATE gateway_usage_ledger SET status = 'settle_failed', error_code = ?3
              WHERE request_id = ?1 AND tenant_id = ?2 AND kind = 'hold' AND status = 'open'`,
          )
          .bind(requestId, tenantId, errorCode),
        db
          .prepare(
            `SELECT MAX(kind = 'settle') AS settled, MAX(kind = 'hold' AND status = 'settle_failed') AS failed
               FROM gateway_usage_ledger WHERE request_id = ?1 AND tenant_id = ?2`,
          )
          .bind(requestId, tenantId),
      ]);
      const row = (state?.results as Array<{ settled: number | null; failed: number | null }> | undefined)?.[0];
      if (row?.settled) return { status: "settled" };
      if (row?.failed) return { status: "settle_failed" };
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "Settlement failure for a request with no reservation.",
        details: { requestId },
      });
    },

    async snapshot({ tenantId, budgetIds }) {
      return (await budgetRows(tenantId, budgetIds)).map(budgetState);
    },
  };

  const ledger: GatewayLedgerPort = {
    async get({ tenantId, requestId }) {
      const row = await db
        .prepare(
          `SELECT ${SETTLE_COLUMNS} FROM gateway_usage_ledger l
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
          `SELECT ${SETTLE_COLUMNS} FROM gateway_usage_ledger l
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
