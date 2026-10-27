/**
 * gateway-core's GatewayBudgetPort over the Postgres budget store (#399, the
 * hybrid settlement model; store: gateway-budget.ts, #363):
 *
 *   check   text admission: the read-only credit-floor check (`admitText`),
 *           then the Idempotency-Key claim. No money is written.
 *   debit   media admission: the claim, then the exact prepaid debit
 *           (`debitMedia`, charge-once per request); a refused debit
 *           releases the claim it took, so it writes nothing.
 *   charge  the provider step of a `charge` settle run (`chargeText`).
 *   refund  the provider step of a `refund` settle run (`refundMedia`).
 *
 * Budget ids come from the intent (the identity authenticated at admission),
 * never re-derived later. `check` applies the floor the data plane resolved;
 * on this host that is the store's knob (`readGatewaySettlementFloor`,
 * `gateway_config` key GATEWAY_SETTLEMENT_FLOOR_CONFIG_KEY, wired as the
 * app's `creditFloor` in server.ts), the same floor the `charge` cap reads.
 *
 * Ledger kinds on this schema: `debit` (media prepay), `charge` (text
 * postpay), `refund` (a failed media debit), each unique per
 * (request_id, budget_id, kind). There are no holds.
 */
import {
  GatewayError,
  type GatewayBudgetPort,
  type GatewayClock,
  type IdempotencyClaim,
} from "@clash/gateway-core";
import {
  createPgGatewayBudgetStore,
  type GatewayBudgetDatabase,
  type GatewayBudgetSqlClient,
  type PgGatewayBudgetStore,
} from "./gateway-budget.ts";

const toSeconds = (ms: number) => Math.floor(ms / 1000);

const noBudget = () => new GatewayError("GATEWAY_BUDGET_EXCEEDED", { details: { reason: "no_budget" } });

export function createPgGatewayBudgetPort(deps: {
  db: GatewayBudgetDatabase;
  store?: PgGatewayBudgetStore;
  clock?: GatewayClock;
}): GatewayBudgetPort {
  const { db } = deps;
  const store = deps.store ?? createPgGatewayBudgetStore(db);
  const clock = deps.clock ?? { now: () => Date.now() };

  /**
   * Take `claim` for `requestId`, or reject with the coded conflict when
   * another request holds it (open: IN_PROGRESS; ended or expired:
   * ALREADY_SETTLED). Re-taking one's own claim is a no-op.
   */
  async function takeClaim(
    client: GatewayBudgetSqlClient,
    input: { tenantId: string; requestId: string; claim: IdempotencyClaim },
  ): Promise<void> {
    const nowS = toSeconds(clock.now());
    const inserted = await client.query<{ request_id: string }>(
      `INSERT INTO gateway_idempotency_claim (tenant_id, idempotency_key, request_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING request_id`,
      [input.tenantId, input.claim.key, input.requestId, toSeconds(input.claim.expiresAt), nowS],
    );
    if (inserted.rows.length === 1) return;
    const { rows } = await client.query<{ request_id: string; expires_at: string | number; ended_at: string | number | null }>(
      `SELECT request_id, expires_at, ended_at FROM gateway_idempotency_claim
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [input.tenantId, input.claim.key],
    );
    const prior = rows[0];
    if (!prior || prior.request_id === input.requestId) return;
    const open = prior.ended_at === null && nowS < Number(prior.expires_at);
    throw new GatewayError(open ? "GATEWAY_IDEMPOTENCY_IN_PROGRESS" : "GATEWAY_IDEMPOTENCY_ALREADY_SETTLED", {
      details: { requestId: prior.request_id },
    });
  }

  const releaseClaim = (tenantId: string, requestId: string) =>
    db.query(
      `DELETE FROM gateway_idempotency_claim WHERE tenant_id = $1 AND request_id = $2 AND ended_at IS NULL`,
      [tenantId, requestId],
    );

  return {
    async check(input) {
      // Fail closed: an official-scope request is admitted only against a
      // real budget row. BYOK (#369): an unbudgeted tenant-scope request is
      // admitted (the tenant pays its own upstream); with rows it is held to them.
      if (input.budgetIds.length === 0 && input.credentialScope !== "tenant") throw noBudget();
      if (input.budgetIds.length > 0)
        await store.admitText({
          tenantId: input.tenantId,
          budgetIds: input.budgetIds,
          floorMicroCredits: input.floorMicroCredits,
        });
      if (input.idempotency)
        await takeClaim(db, { tenantId: input.tenantId, requestId: input.requestId, claim: input.idempotency });
      return {};
    },

    async debit({ budgetIds, idempotency, ...event }) {
      if (budgetIds.length === 0 && event.credentialScope !== "tenant") throw noBudget();
      if (idempotency) await takeClaim(db, { tenantId: event.tenantId, requestId: event.requestId, claim: idempotency });
      if (budgetIds.length === 0) return {};
      try {
        await store.debitMedia({
          requestId: event.requestId,
          tenantId: event.tenantId,
          userId: event.userId,
          ...(event.keyId ? { keyId: event.keyId } : {}),
          budgetIds,
          costMicroCredits: event.costMicroCredits,
          modelCode: event.modelCode,
          modelKind: event.kind,
          upstreamId: event.upstreamId,
          ...(event.accountId ? { accountId: event.accountId } : {}),
          credentialScope: event.credentialScope,
          priceVersion: event.priceVersion,
          catalogVersion: event.catalogVersion,
          ...(idempotency ? { idempotencyKey: idempotency.key, expiresAt: idempotency.expiresAt } : {}),
        });
      } catch (error) {
        if (idempotency) await releaseClaim(event.tenantId, event.requestId).catch(() => undefined);
        throw error;
      }
      return {};
    },

    async charge({ budgetIds, ...event }) {
      // A charge never invents a free budget (the core owes none without one).
      if (budgetIds.length === 0) throw noBudget();
      const result = await store.chargeText({
        requestId: event.requestId,
        tenantId: event.tenantId,
        userId: event.userId,
        ...(event.keyId ? { keyId: event.keyId } : {}),
        budgetIds,
        costMicroCredits: event.costMicroCredits,
        status: event.status,
        modelCode: event.modelCode,
        modelKind: event.kind,
        upstreamId: event.upstreamId,
        ...(event.accountId ? { accountId: event.accountId } : {}),
        credentialScope: event.credentialScope,
        priceVersion: event.priceVersion,
        catalogVersion: event.catalogVersion,
        usageSource: event.usage.source,
        units: event.usage.units,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cachedInputTokens: event.usage.cachedInputTokens,
        cacheWriteTokens: event.usage.cacheWriteTokens,
      });
      return {
        requestId: event.requestId,
        kind: "charge",
        costMicroCredits: result.chargedMicroCredits,
        duplicate: result.duplicate,
      };
    },

    async refund(input) {
      const result = await store.refundMedia({
        requestId: input.requestId,
        tenantId: input.tenantId,
        reason: input.status,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      });
      // Nothing debited and nothing refunded: a refund of nothing is the
      // ledger's refusal, never retried into a write.
      if (!result.duplicate && result.refundedBudgetIds.length === 0)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "Refund for a request that recorded no debit.",
          details: { requestId: input.requestId },
        });
      return {
        requestId: input.requestId,
        kind: "refund",
        costMicroCredits: result.refundedMicroCredits,
        duplicate: result.duplicate,
      };
    },

    async endIdempotency({ requestId, tenantId }) {
      await db.query(
        `UPDATE gateway_idempotency_claim SET ended_at = $3
          WHERE tenant_id = $1 AND request_id = $2 AND ended_at IS NULL`,
        [tenantId, requestId, toSeconds(clock.now())],
      );
    },

    async snapshot(input) {
      const rows = await store.snapshot({
        tenantId: input.tenantId,
        ...(input.budgetIds?.length ? { budgetIds: input.budgetIds } : {}),
      });
      return rows.map((row) => ({
        id: row.id,
        scope: row.scope as "tenant" | "user" | "key",
        scopeId: row.scopeId,
        limitMicroCredits: row.limitMicroCredits,
        spentMicroCredits: row.spentMicroCredits,
        reservedMicroCredits: 0,
        version: 0,
        enforcement: row.enforcement as "hard" | "soft" | "alert",
      }));
    },
  };
}
