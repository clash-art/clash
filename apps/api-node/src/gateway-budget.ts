/**
 * Postgres gateway budget store — N2 settlement for the Node self-host gateway (#363).
 *
 * Money model (N2). There is no reserve / hold / settle / release path here and no
 * sweeper. Money moves in two shapes only:
 *
 * - Media / AIGC — prepay. `debitMedia` debits the exact price on every budget of
 *   the request in one transaction and writes one `debit` ledger row per budget.
 *   `UNIQUE (request_id, budget_id, kind)` makes the debit charge-once, so a
 *   replayed admission returns the recorded debit instead of moving money twice.
 *   A failed generation calls `refundMedia`, which returns the whole debit
 *   (`refund` rows plus a `spent` rollback), so a failed media request never
 *   leaves a net charge. A successful generation needs no second money write:
 *   the prepay debit is final and `completeMedia` only records the outcome.
 *
 * - Text / LLM — postpay. `admitText` writes nothing: it only checks that every
 *   budget of the request still has `balance > -floor`. After a successful
 *   response `chargeText` writes the actual cost once (`charge` rows). The
 *   balance may go negative, but never past the credit floor: the part of the
 *   cost that does not fit inside `balance + floor` is recorded as
 *   `billing_basis.unbilled_micro_credits` instead of being silently dropped or
 *   silently charged past the floor.
 *
 * The floor is a configuration knob (`gateway_config.settlement.floor_micro_credits`,
 * overridable per store). Scopes are the Node schema's `tenant | user | key`
 * (team wallet, member budget, per-key cap); every scope of a request is charged
 * the same amount and the request is refused when any of them cannot cover it.
 *
 * `checkGatewayInvariants` re-derives the budget balances from the ledger and
 * reports every way this store can drift: a `spent` that does not match the
 * ledger, a refund that does not cancel its debit, a balance below the floor, a
 * reserved amount (N2 has no holds) and a duplicated settlement row.
 *
 * Boundaries: this module owns Postgres only. It has no HTTP surface, no
 * background sweeper and no nightly reconcile — those are separate products.
 */

import { GatewayError, assertMicroCredits } from "@clash/gateway-core";
import { z } from "zod";

// ─── Ports ────────────────────────────────────────────────────────────────────

/** The query surface this store needs; `pg` pools and PGlite both satisfy it. */
export interface GatewayBudgetSqlClient {
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

/** A database that can run one money transaction. */
export interface GatewayBudgetDatabase extends GatewayBudgetSqlClient {
  transaction<T>(work: (tx: GatewayBudgetSqlClient) => Promise<T>): Promise<T>;
}

/**
 * Settlement audit sink. It runs inside the money transaction, so a refused
 * audit write rolls the money write back instead of leaving an unlogged
 * movement. Without a sink the ledger stays the only record.
 */
export type GatewayBudgetAuditSink = (
  tx: GatewayBudgetSqlClient,
  event: GatewayBudgetAuditEvent,
) => Promise<void> | void;

export interface GatewayBudgetAuditEvent {
  action: "budget.debit" | "budget.refund" | "budget.charge";
  tenantId: string;
  requestId: string;
  budgetIds: readonly string[];
  amountMicroCredits: number;
  /** Epoch ms. */
  occurredAt: number;
  reason?: string;
}

// ─── Configuration ────────────────────────────────────────────────────────────

/** `gateway_config` key holding the credit floor (micro-credits). */
export const GATEWAY_SETTLEMENT_FLOOR_CONFIG_KEY =
  "settlement.floor_micro_credits";

/** Default life of a `gateway_request` row when the caller gives no expiry. */
const DEFAULT_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface PgGatewayBudgetStoreOptions {
  /** Credit floor in micro-credits; overrides `gateway_config`. */
  floorMicroCredits?: number;
  /** Settlement audit sink, called inside the money transaction. */
  audit?: GatewayBudgetAuditSink;
  /** Clock in epoch milliseconds. */
  now?: () => number;
}

// ─── Inputs and results ───────────────────────────────────────────────────────

export interface GatewayMediaDebitInput {
  requestId: string;
  tenantId: string;
  userId: string;
  keyId?: string;
  /** Every budget the request draws on (tenant wallet, member budget, key cap). */
  budgetIds: readonly string[];
  /** The exact price of the generation. */
  costMicroCredits: number;
  modelCode?: string;
  modelKind?: string;
  upstreamId?: string;
  accountId?: string;
  credentialScope?: string;
  priceVersion?: string;
  catalogVersion?: string;
  idempotencyKey?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

export interface GatewayMediaDebitResult {
  requestId: string;
  budgetIds: readonly string[];
  /** The exact price debited on every budget of the request. */
  debitMicroCredits: number;
  /** The sum of the ledger movements (one `debit` line per budget). */
  totalDebitMicroCredits: number;
  /** True when the request was already debited; no second money write happened. */
  duplicate: boolean;
}

export interface GatewayMediaRefundInput {
  requestId: string;
  tenantId: string;
  /** Why the generation failed, e.g. `upstream_failed`. */
  reason?: string;
  errorCode?: string;
}

export interface GatewayMediaRefundResult {
  requestId: string;
  /** The request cost returned on every budget it was debited from. */
  refundedMicroCredits: number;
  /** The sum of the ledger movements (one `refund` line per budget). */
  totalRefundedMicroCredits: number;
  refundedBudgetIds: readonly string[];
  /** True when the debit was already refunded. */
  duplicate: boolean;
}

export interface GatewayMediaCompleteInput {
  requestId: string;
  tenantId: string;
}

export interface GatewayMediaCompleteResult {
  requestId: string;
  /** False when no request row exists for this id. */
  completed: boolean;
}

export interface GatewayTextAdmissionInput {
  tenantId: string;
  budgetIds: readonly string[];
  /**
   * The floor the data plane resolved for this caller (#399; on this host
   * from `readGatewaySettlementFloor`, so it is the floor `chargeText` caps
   * at). Absent: the configured floor.
   */
  floorMicroCredits?: number;
}

export interface GatewayTextAdmissionResult {
  admitted: true;
  floorMicroCredits: number;
  budgets: readonly GatewayBudgetBalance[];
}

export interface GatewayTextChargeInput {
  requestId: string;
  tenantId: string;
  userId: string;
  keyId?: string;
  budgetIds: readonly string[];
  /** The actual cost of the response. */
  costMicroCredits: number;
  /** Ledger status of the settlement row. */
  status?: string;
  modelCode?: string;
  modelKind?: string;
  upstreamId?: string;
  accountId?: string;
  credentialScope?: string;
  priceVersion?: string;
  catalogVersion?: string;
  idempotencyKey?: string;
  usageSource?: string;
  units?: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  /** Epoch ms. */
  expiresAt?: number;
}

export interface GatewayTextChargeResult {
  requestId: string;
  /** What the budgets were charged. */
  chargedMicroCredits: number;
  /** The actual cost of the response. */
  requestedMicroCredits: number;
  /** The part of the cost that did not fit inside the credit floor. */
  unbilledMicroCredits: number;
  /** True when the request was already charged; no second money write happened. */
  duplicate: boolean;
}

export interface GatewayBudgetSnapshotInput {
  tenantId: string;
  budgetIds?: readonly string[];
}

export interface GatewayBudgetBalance {
  id: string;
  scope: string;
  scopeId: string;
  /** Null when the budget is explicitly unlimited. */
  limitMicroCredits: number | null;
  spentMicroCredits: number;
  /** Null when the budget is explicitly unlimited. */
  balanceMicroCredits: number | null;
  status: string;
  enforcement: string;
}

export interface PgGatewayBudgetStore {
  /** N2 media prepay: debit the exact price atomically. */
  debitMedia(input: GatewayMediaDebitInput): Promise<GatewayMediaDebitResult>;
  /** N2 media failure: return the whole prepay debit. */
  refundMedia(input: GatewayMediaRefundInput): Promise<GatewayMediaRefundResult>;
  /** N2 media success: record the outcome; the prepay debit is final. */
  completeMedia(input: GatewayMediaCompleteInput): Promise<GatewayMediaCompleteResult>;
  /** N2 text admission: read-only balance check against the credit floor. */
  admitText(input: GatewayTextAdmissionInput): Promise<GatewayTextAdmissionResult>;
  /** N2 text postpay: charge the actual cost once. */
  chargeText(input: GatewayTextChargeInput): Promise<GatewayTextChargeResult>;
  /** Read the current balances of a tenant's budgets. */
  snapshot(input: GatewayBudgetSnapshotInput): Promise<GatewayBudgetBalance[]>;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const identifierSchema = z.string().min(1).max(200);
const amountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const mediaDebitSchema = z.object({
  requestId: identifierSchema,
  tenantId: identifierSchema,
  userId: identifierSchema,
  keyId: identifierSchema.optional(),
  budgetIds: z.array(identifierSchema).min(1),
  costMicroCredits: amountSchema,
  modelCode: z.string().min(1).optional(),
  modelKind: z.string().min(1).optional(),
  upstreamId: z.string().optional(),
  accountId: z.string().optional(),
  credentialScope: z.string().optional(),
  priceVersion: z.string().optional(),
  catalogVersion: z.string().optional(),
  idempotencyKey: z.string().min(1).optional(),
  expiresAt: z.number().int().nonnegative().optional(),
});

const mediaRefundSchema = z.object({
  requestId: identifierSchema,
  tenantId: identifierSchema,
  reason: z.string().optional(),
  errorCode: z.string().optional(),
});

const mediaCompleteSchema = z.object({
  requestId: identifierSchema,
  tenantId: identifierSchema,
});

const textAdmissionSchema = z.object({
  tenantId: identifierSchema,
  budgetIds: z.array(identifierSchema).min(1),
  floorMicroCredits: amountSchema.optional(),
});

const textChargeSchema = z.object({
  requestId: identifierSchema,
  tenantId: identifierSchema,
  userId: identifierSchema,
  keyId: identifierSchema.optional(),
  budgetIds: z.array(identifierSchema).min(1),
  costMicroCredits: amountSchema,
  status: z.string().min(1).optional(),
  modelCode: z.string().min(1).optional(),
  modelKind: z.string().min(1).optional(),
  upstreamId: z.string().optional(),
  accountId: z.string().optional(),
  credentialScope: z.string().optional(),
  priceVersion: z.string().optional(),
  catalogVersion: z.string().optional(),
  idempotencyKey: z.string().min(1).optional(),
  usageSource: z.string().optional(),
  units: z.record(z.string(), z.unknown()).optional(),
  inputTokens: amountSchema.optional(),
  outputTokens: amountSchema.optional(),
  cachedInputTokens: amountSchema.optional(),
  cacheWriteTokens: amountSchema.optional(),
  expiresAt: z.number().int().nonnegative().optional(),
});

const snapshotSchema = z.object({
  tenantId: identifierSchema,
  budgetIds: z.array(identifierSchema).min(1).optional(),
});

const floorConfigSchema = z.union([
  amountSchema,
  z.object({ floor_micro_credits: amountSchema }),
]);

function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.infer<Schema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new GatewayError("GATEWAY_INVALID_REQUEST", {
    message: "The gateway settlement input is invalid.",
    details: {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
  });
}

// ─── Money and time helpers ───────────────────────────────────────────────────

/** Postgres returns `bigint` as a string; every amount is a safe integer. */
function readMicroCredits(value: unknown, label: string): number {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: `${label} is not an integer amount of micro-credits.`,
      details: { label },
    });
  }
  return parsed;
}

/** The Node gateway stores unix seconds; the product surface speaks epoch ms. */
function toSeconds(epochMs: number): number {
  return Math.floor(epochMs / 1000);
}

interface BudgetRow {
  id: string;
  scope: string;
  scope_id: string;
  limit_micro_credits: number | string | null;
  spent_micro_credits: number | string;
  reserved_micro_credits: number | string;
  status: string;
  enforcement: string;
  [column: string]: unknown;
}

interface LedgerRow {
  id: string;
  request_id: string;
  budget_id: string;
  kind: string;
  amount_micro_credits: number | string;
  user_id: string | null;
  key_id: string | null;
  [column: string]: unknown;
}

const BUDGET_COLUMNS =
  "id, scope, scope_id, limit_micro_credits, spent_micro_credits, reserved_micro_credits, status, enforcement";

function limitOf(budget: BudgetRow): number | null {
  return budget.limit_micro_credits === null
    ? null
    : readMicroCredits(budget.limit_micro_credits, "limit_micro_credits");
}

function spentOf(budget: BudgetRow): number {
  return readMicroCredits(budget.spent_micro_credits, "spent_micro_credits");
}

/** Null when the budget is explicitly unlimited. */
function balanceOf(budget: BudgetRow): number | null {
  const limit = limitOf(budget);
  return limit === null ? null : limit - spentOf(budget);
}

function balanceView(budget: BudgetRow): GatewayBudgetBalance {
  return {
    id: budget.id,
    scope: budget.scope,
    scopeId: budget.scope_id,
    limitMicroCredits: limitOf(budget),
    spentMicroCredits: spentOf(budget),
    balanceMicroCredits: balanceOf(budget),
    status: budget.status,
    enforcement: budget.enforcement,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function readBudgets(
  client: GatewayBudgetSqlClient,
  tenantId: string,
  budgetIds: readonly string[],
  lock: boolean,
): Promise<BudgetRow[]> {
  const placeholders = budgetIds.map((_, index) => `$${index + 2}`).join(", ");
  const { rows } = await client.query<BudgetRow>(
    `SELECT ${BUDGET_COLUMNS}
       FROM gateway_budget
      WHERE tenant_id = $1 AND id IN (${placeholders})
      ORDER BY id${lock ? " FOR UPDATE" : ""}`,
    [tenantId, ...budgetIds],
  );
  return rows;
}

async function readSettlementRows(
  client: GatewayBudgetSqlClient,
  tenantId: string,
  requestId: string,
  kind: "debit" | "charge" | "refund",
): Promise<LedgerRow[]> {
  const { rows } = await client.query<LedgerRow>(
    `SELECT id, request_id, budget_id, kind, amount_micro_credits, user_id, key_id
       FROM gateway_usage_ledger
      WHERE tenant_id = $1 AND request_id = $2 AND kind = $3
      ORDER BY budget_id`,
    [tenantId, requestId, kind],
  );
  return rows;
}

function missingBudgets(
  budgetIds: readonly string[],
  budgets: readonly BudgetRow[],
): string[] {
  const found = new Set(budgets.map((budget) => budget.id));
  return budgetIds.filter((id) => !found.has(id));
}

/** A request id belongs to one tenant; another tenant may not reuse it. */
async function assertRequestTenant(
  client: GatewayBudgetSqlClient,
  requestId: string,
  tenantId: string,
): Promise<void> {
  const { rows } = await client.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM gateway_request WHERE id = $1",
    [requestId],
  );
  const owner = rows[0];
  if (owner && owner.tenant_id !== tenantId) {
    throw new GatewayError("GATEWAY_FORBIDDEN", {
      message: "The request id belongs to another tenant.",
      details: { requestId },
    });
  }
}

/**
 * The credit floor knob on this host (#399): `gateway_config` key
 * GATEWAY_SETTLEMENT_FLOOR_CONFIG_KEY, 0 when unset. The data plane's
 * `creditFloor` reads it (server.ts), so text admission and the postpaid
 * charge cap agree on one floor.
 */
export function readGatewaySettlementFloor(db: GatewayBudgetSqlClient): Promise<number> {
  return resolveConfiguredFloor(db, undefined);
}

async function resolveConfiguredFloor(
  db: GatewayBudgetSqlClient,
  override: number | undefined,
): Promise<number> {
  if (override !== undefined) {
    assertMicroCredits(override, "floorMicroCredits");
    return override;
  }
  const { rows } = await db.query<{ value: unknown }>(
    "SELECT value FROM gateway_config WHERE key = $1",
    [GATEWAY_SETTLEMENT_FLOOR_CONFIG_KEY],
  );
  if (rows.length === 0) return 0;
  const parsed = floorConfigSchema.safeParse(rows[0].value);
  if (!parsed.success) {
    throw new GatewayError("GATEWAY_INTERNAL", {
      message: `The ${GATEWAY_SETTLEMENT_FLOOR_CONFIG_KEY} config is invalid.`,
      details: { key: GATEWAY_SETTLEMENT_FLOOR_CONFIG_KEY },
    });
  }
  const value =
    typeof parsed.data === "number"
      ? parsed.data
      : parsed.data.floor_micro_credits;
  assertMicroCredits(value, "floorMicroCredits");
  return value;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export function createPgGatewayBudgetStore(
  db: GatewayBudgetDatabase,
  options: PgGatewayBudgetStoreOptions = {},
): PgGatewayBudgetStore {
  const now = options.now ?? (() => Date.now());
  const audit = options.audit;

  async function resolveFloor(): Promise<number> {
    return resolveConfiguredFloor(db, options.floorMicroCredits);
  }

  async function debitMedia(
    input: GatewayMediaDebitInput,
  ): Promise<GatewayMediaDebitResult> {
    const parsed = parseInput(mediaDebitSchema, input);
    const cost = parsed.costMicroCredits;
    const occurredAt = now();
    const occurredAtS = toSeconds(occurredAt);
    const expiresAtS = toSeconds(
      parsed.expiresAt ?? occurredAt + DEFAULT_REQUEST_TTL_MS,
    );

    try {
      return await db.transaction(async (tx) => {
        // Charge-once: an existing debit is the recorded money movement. It is
        // read once, after the budget row locks (#379 keeps the query budget).
        const recorded = async () => {
          const debits = await readSettlementRows(
            tx,
            parsed.tenantId,
            parsed.requestId,
            "debit",
          );
          if (debits.length === 0) return undefined;
          return {
            requestId: parsed.requestId,
            budgetIds: debits.map((row) => row.budget_id),
            debitMicroCredits: readMicroCredits(
              debits[0].amount_micro_credits,
              "amount_micro_credits",
            ),
            totalDebitMicroCredits: debits.reduce(
              (total, row) =>
                total +
                readMicroCredits(row.amount_micro_credits, "amount_micro_credits"),
              0,
            ),
            duplicate: true,
          };
        };

        await assertRequestTenant(tx, parsed.requestId, parsed.tenantId);

        const budgets = await readBudgets(
          tx,
          parsed.tenantId,
          parsed.budgetIds,
          true,
        );
        // A concurrent debit of the same request (another node) may have
        // committed while this one waited for the budget locks; under READ
        // COMMITTED the re-read now sees it (#379, real Postgres).
        const raced = await recorded();
        if (raced) return raced;
        const missing = missingBudgets(parsed.budgetIds, budgets);
        if (missing.length > 0) {
          throw new GatewayError("GATEWAY_BUDGET_NOT_FOUND", {
            message: "A budget of this request does not exist.",
            details: { budgetIds: missing },
          });
        }

        for (const budget of budgets) {
          if (budget.status !== "active") {
            throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", {
              message: `Budget ${budget.id} is ${budget.status}.`,
              details: {
                budgetId: budget.id,
                scope: budget.scope,
                status: budget.status,
              },
            });
          }
          const limit = limitOf(budget);
          const spent = spentOf(budget);
          if (limit !== null && spent + cost > limit) {
            throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", {
              message: `Budget ${budget.id} cannot cover ${cost} micro-credits.`,
              details: {
                budgetId: budget.id,
                scope: budget.scope,
                limitMicroCredits: limit,
                spentMicroCredits: spent,
                requiredMicroCredits: cost,
                remainingMicroCredits: limit - spent,
              },
            });
          }
        }

        await tx.query(
          `INSERT INTO gateway_request
             (id, tenant_id, user_id, team_id, key_id, idempotency_key, model_id, model_kind,
              state, debit_micro_credits, charged_micro_credits, attempt, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, '', $4, $5, $6, $7, 'admitted', $8, NULL, 1, $9, $10, $10)
           ON CONFLICT (id) DO UPDATE
              SET debit_micro_credits = EXCLUDED.debit_micro_credits,
                  state = 'admitted',
                  updated_at = EXCLUDED.updated_at
            WHERE gateway_request.tenant_id = EXCLUDED.tenant_id`,
          [
            parsed.requestId,
            parsed.tenantId,
            parsed.userId,
            parsed.keyId ?? "",
            parsed.idempotencyKey ?? null,
            parsed.modelCode ?? null,
            parsed.modelKind ?? null,
            cost,
            expiresAtS,
            occurredAtS,
          ],
        );

        for (const budget of budgets) {
          const updated = await tx.query<{ id: string }>(
            `UPDATE gateway_budget
                SET spent_micro_credits = spent_micro_credits + $3,
                    version = version + 1,
                    updated_at = $4
              WHERE id = $1 AND tenant_id = $2
                AND status = 'active'
                AND (limit_micro_credits IS NULL OR spent_micro_credits + $3 <= limit_micro_credits)
            RETURNING id`,
            [budget.id, parsed.tenantId, cost, occurredAtS],
          );
          if (updated.rows.length !== 1) {
            throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", {
              message: `Budget ${budget.id} cannot cover ${cost} micro-credits.`,
              details: {
                budgetId: budget.id,
                scope: budget.scope,
                requiredMicroCredits: cost,
              },
            });
          }

          await tx.query(
            `INSERT INTO gateway_usage_ledger
               (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id,
                amount_micro_credits, model_code, model_kind, credential_scope,
                price_version, catalog_version, upstream_id, account_id, billing_basis,
                occurred_at, created_at)
             VALUES ($1, $2, $3, 'debit', 'settled', $4, $5, $6, $7, $8, $9, $10,
                     $11, $12, $13, $14, $15::jsonb, $16, $16)
             ON CONFLICT (request_id, budget_id, kind) DO NOTHING`,
            [
              `${parsed.requestId}:debit:${budget.id}`,
              parsed.requestId,
              budget.id,
              parsed.tenantId,
              parsed.userId,
              parsed.keyId ?? "",
              cost,
              parsed.modelCode ?? null,
              parsed.modelKind ?? null,
              parsed.credentialScope ?? null,
              parsed.priceVersion ?? null,
              parsed.catalogVersion ?? null,
              parsed.upstreamId ?? null,
              parsed.accountId ?? null,
              JSON.stringify({
                settlement: "prepay",
                requestedMicroCredits: cost,
              }),
              occurredAtS,
            ],
          );
        }

        if (audit) {
          await audit(tx, {
            action: "budget.debit",
            tenantId: parsed.tenantId,
            requestId: parsed.requestId,
            budgetIds: budgets.map((budget) => budget.id),
            amountMicroCredits: cost,
            occurredAt,
          });
        }

        return {
          requestId: parsed.requestId,
          budgetIds: budgets.map((budget) => budget.id),
          debitMicroCredits: cost,
          totalDebitMicroCredits: cost * budgets.length,
          duplicate: false,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new GatewayError("GATEWAY_IDEMPOTENCY_CONFLICT", {
          message: "The idempotency key already belongs to another request.",
          details: { requestId: parsed.requestId },
          cause: error,
        });
      }
      throw error;
    }
  }

  async function refundMedia(
    input: GatewayMediaRefundInput,
  ): Promise<GatewayMediaRefundResult> {
    const parsed = parseInput(mediaRefundSchema, input);
    const occurredAt = now();
    const occurredAtS = toSeconds(occurredAt);

    return db.transaction(async (tx) => {
      const debits = await readSettlementRows(
        tx,
        parsed.tenantId,
        parsed.requestId,
        "debit",
      );
      if (debits.length === 0) {
        // Nothing was debited: a refund is a no-op, never an error.
        return {
          requestId: parsed.requestId,
          refundedMicroCredits: 0,
          totalRefundedMicroCredits: 0,
          refundedBudgetIds: [],
          duplicate: false,
        };
      }

      let refundedMicroCredits = 0;
      let totalRefundedMicroCredits = 0;
      const refundedBudgetIds: string[] = [];

      for (const debit of debits) {
        const amount = readMicroCredits(
          debit.amount_micro_credits,
          "amount_micro_credits",
        );
        // A period rollover (#365) may have cleared this debit's spend
        // already; then only what is still in `spent` is taken back, and the
        // ledger row records how much so the invariant check stays exact.
        const locked = await tx.query<{
          spent_micro_credits: number | string;
          period: string;
        }>(
          `SELECT spent_micro_credits, period FROM gateway_budget
            WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [debit.budget_id, parsed.tenantId],
        );
        const current = locked.rows[0];
        const periodic =
          current !== undefined &&
          (current.period === "daily" || current.period === "monthly");
        const rollback = periodic
          ? Math.min(
              amount,
              readMicroCredits(current.spent_micro_credits, "spent_micro_credits"),
            )
          : amount;
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO gateway_usage_ledger
             (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id,
              amount_micro_credits, ref_kind, ref_id, reason, error_code, billing_basis,
              occurred_at, created_at)
           VALUES ($1, $2, $3, 'refund', 'settled', $4, $5, $6, $7, 'debit', $8, $9, $10,
                   $11::jsonb, $12, $12)
           ON CONFLICT (request_id, budget_id, kind) DO NOTHING
           RETURNING id`,
          [
            `${parsed.requestId}:refund:${debit.budget_id}`,
            parsed.requestId,
            debit.budget_id,
            parsed.tenantId,
            debit.user_id ?? "",
            debit.key_id ?? "",
            amount,
            debit.id,
            parsed.reason ?? null,
            parsed.errorCode ?? null,
            JSON.stringify({
              settlement: "refund",
              refundedMicroCredits: amount,
              ...(rollback === amount
                ? {}
                : { spentRolledBackMicroCredits: rollback }),
            }),
            occurredAtS,
          ],
        );
        if (inserted.rows.length === 0) continue; // already refunded

        const updated = await tx.query<{ id: string }>(
          `UPDATE gateway_budget
              SET spent_micro_credits = spent_micro_credits - $3,
                  version = version + 1,
                  updated_at = $4
            WHERE id = $1 AND tenant_id = $2 AND spent_micro_credits >= $3
            RETURNING id`,
          [debit.budget_id, parsed.tenantId, rollback, occurredAtS],
        );
        if (updated.rows.length !== 1) {
          throw new GatewayError("GATEWAY_SETTLEMENT_FAILED", {
            message: `Budget ${debit.budget_id} cannot take back its debit.`,
            details: {
              budgetId: debit.budget_id,
              requestId: parsed.requestId,
              refundedMicroCredits: amount,
            },
          });
        }

        refundedMicroCredits = amount;
        totalRefundedMicroCredits += amount;
        refundedBudgetIds.push(debit.budget_id);
      }

      await tx.query(
        `UPDATE gateway_request
            SET state = 'failed', charged_micro_credits = 0, updated_at = $3
          WHERE id = $1 AND tenant_id = $2`,
        [parsed.requestId, parsed.tenantId, occurredAtS],
      );

      if (audit && refundedMicroCredits > 0) {
        await audit(tx, {
          action: "budget.refund",
          tenantId: parsed.tenantId,
          requestId: parsed.requestId,
          budgetIds: refundedBudgetIds,
          amountMicroCredits: refundedMicroCredits,
          occurredAt,
          reason: parsed.reason,
        });
      }

      return {
        requestId: parsed.requestId,
        refundedMicroCredits,
        totalRefundedMicroCredits,
        refundedBudgetIds,
        duplicate: refundedMicroCredits === 0,
      };
    });
  }

  async function completeMedia(
    input: GatewayMediaCompleteInput,
  ): Promise<GatewayMediaCompleteResult> {
    const parsed = parseInput(mediaCompleteSchema, input);
    const occurredAtS = toSeconds(now());
    // Bookkeeping only: the prepay debit is the final money write.
    const { rows } = await db.query<{ id: string }>(
      `UPDATE gateway_request
          SET state = 'completed',
              charged_micro_credits = debit_micro_credits,
              updated_at = $3
        WHERE id = $1 AND tenant_id = $2
        RETURNING id`,
      [parsed.requestId, parsed.tenantId, occurredAtS],
    );
    return { requestId: parsed.requestId, completed: rows.length > 0 };
  }

  async function admitText(
    input: GatewayTextAdmissionInput,
  ): Promise<GatewayTextAdmissionResult> {
    const parsed = parseInput(textAdmissionSchema, input);
    const floor = parsed.floorMicroCredits ?? (await resolveFloor());
    const budgets = await readBudgets(
      db,
      parsed.tenantId,
      parsed.budgetIds,
      false,
    );
    const missing = missingBudgets(parsed.budgetIds, budgets);
    if (missing.length > 0) {
      throw new GatewayError("GATEWAY_BUDGET_NOT_FOUND", {
        message: "A budget of this request does not exist.",
        details: { budgetIds: missing },
      });
    }

    for (const budget of budgets) {
      if (budget.status !== "active") {
        throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", {
          message: `Budget ${budget.id} is ${budget.status}.`,
          details: {
            budgetId: budget.id,
            scope: budget.scope,
            status: budget.status,
          },
        });
      }
      const balance = balanceOf(budget);
      if (balance !== null && !(balance > -floor)) {
        throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", {
          message: `Budget ${budget.id} is at or below the credit floor.`,
          details: {
            budgetId: budget.id,
            scope: budget.scope,
            balanceMicroCredits: balance,
            floorMicroCredits: floor,
            reason: "below_floor",
          },
        });
      }
    }

    return {
      admitted: true,
      floorMicroCredits: floor,
      budgets: budgets.map(balanceView),
    };
  }

  async function chargeText(
    input: GatewayTextChargeInput,
  ): Promise<GatewayTextChargeResult> {
    const parsed = parseInput(textChargeSchema, input);
    const cost = parsed.costMicroCredits;
    const floor = await resolveFloor();
    const occurredAt = now();
    const occurredAtS = toSeconds(occurredAt);
    const expiresAtS = toSeconds(
      parsed.expiresAt ?? occurredAt + DEFAULT_REQUEST_TTL_MS,
    );

    try {
      return await db.transaction(async (tx) => {
        // Charge-once: an existing charge is the recorded money movement. It is
        // read once, after the budget row locks (#379 keeps the query budget).
        const recorded = async () => {
          const charges = await readSettlementRows(
            tx,
            parsed.tenantId,
            parsed.requestId,
            "charge",
          );
          if (charges.length === 0) return undefined;
          return {
            requestId: parsed.requestId,
            chargedMicroCredits: readMicroCredits(
              charges[0].amount_micro_credits,
              "amount_micro_credits",
            ),
            requestedMicroCredits: cost,
            unbilledMicroCredits: 0,
            duplicate: true,
          };
        };

        await assertRequestTenant(tx, parsed.requestId, parsed.tenantId);

        const budgets = await readBudgets(
          tx,
          parsed.tenantId,
          parsed.budgetIds,
          true,
        );
        // A concurrent settle of the same request (another node) may have
        // committed while this one waited for the budget locks; it is the
        // recorded charge, so report a duplicate and leave gateway_request
        // alone (#379, real Postgres).
        const raced = await recorded();
        if (raced) return raced;
        const missing = missingBudgets(parsed.budgetIds, budgets);
        if (missing.length > 0) {
          throw new GatewayError("GATEWAY_BUDGET_NOT_FOUND", {
            message: "A budget of this request does not exist.",
            details: { budgetIds: missing },
          });
        }

        // The balance may go negative, but never past the credit floor.
        let chargeable = cost;
        for (const budget of budgets) {
          const balance = balanceOf(budget);
          if (balance === null) continue; // unlimited
          const available = balance + floor;
          if (available < chargeable) chargeable = available;
        }
        chargeable = Math.max(0, Math.min(cost, chargeable));
        const unbilledMicroCredits = cost - chargeable;

        for (const budget of budgets) {
          const inserted = await tx.query<{ id: string }>(
            `INSERT INTO gateway_usage_ledger
               (id, request_id, budget_id, kind, status, tenant_id, user_id, key_id,
                amount_micro_credits, model_code, model_kind, credential_scope, units_json,
                usage_source, price_version, catalog_version, upstream_id, account_id,
                input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
                billing_basis, occurred_at, created_at)
             VALUES ($1, $2, $3, 'charge', $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13,
                     $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23, $23)
             ON CONFLICT (request_id, budget_id, kind) DO NOTHING
             RETURNING id`,
            [
              `${parsed.requestId}:charge:${budget.id}`,
              parsed.requestId,
              budget.id,
              parsed.status ?? "settled",
              parsed.tenantId,
              parsed.userId,
              parsed.keyId ?? "",
              chargeable,
              parsed.modelCode ?? null,
              parsed.modelKind ?? null,
              parsed.credentialScope ?? null,
              JSON.stringify(parsed.units ?? {}),
              parsed.usageSource ?? null,
              parsed.priceVersion ?? null,
              parsed.catalogVersion ?? null,
              parsed.upstreamId ?? null,
              parsed.accountId ?? null,
              parsed.inputTokens ?? 0,
              parsed.outputTokens ?? 0,
              parsed.cachedInputTokens ?? 0,
              parsed.cacheWriteTokens ?? 0,
              JSON.stringify({
                settlement: "postpay",
                requestedMicroCredits: cost,
                chargedMicroCredits: chargeable,
                unbilledMicroCredits,
                floorMicroCredits: floor,
              }),
              occurredAtS,
            ],
          );
          if (inserted.rows.length === 0) continue; // already charged

          const updated = await tx.query<{ id: string }>(
            `UPDATE gateway_budget
                SET spent_micro_credits = spent_micro_credits + $3,
                    version = version + 1,
                    updated_at = $4
              WHERE id = $1 AND tenant_id = $2
            RETURNING id`,
            [budget.id, parsed.tenantId, chargeable, occurredAtS],
          );
          if (updated.rows.length !== 1) {
            throw new GatewayError("GATEWAY_SETTLEMENT_FAILED", {
              message: `Budget ${budget.id} could not be charged.`,
              details: { budgetId: budget.id, requestId: parsed.requestId },
            });
          }
        }

        await tx.query(
          `INSERT INTO gateway_request
             (id, tenant_id, user_id, team_id, key_id, idempotency_key, model_id, model_kind,
              state, debit_micro_credits, charged_micro_credits, attempt, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, '', $4, $5, $6, $7, 'completed', 0, $8, 1, $9, $10, $10)
           ON CONFLICT (id) DO UPDATE
              SET charged_micro_credits = EXCLUDED.charged_micro_credits,
                  state = 'completed',
                  updated_at = EXCLUDED.updated_at
            WHERE gateway_request.tenant_id = EXCLUDED.tenant_id`,
          [
            parsed.requestId,
            parsed.tenantId,
            parsed.userId,
            parsed.keyId ?? "",
            parsed.idempotencyKey ?? null,
            parsed.modelCode ?? null,
            parsed.modelKind ?? null,
            chargeable,
            expiresAtS,
            occurredAtS,
          ],
        );

        if (audit) {
          await audit(tx, {
            action: "budget.charge",
            tenantId: parsed.tenantId,
            requestId: parsed.requestId,
            budgetIds: budgets.map((budget) => budget.id),
            amountMicroCredits: chargeable,
            occurredAt,
          });
        }

        return {
          requestId: parsed.requestId,
          chargedMicroCredits: chargeable,
          requestedMicroCredits: cost,
          unbilledMicroCredits,
          duplicate: false,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new GatewayError("GATEWAY_IDEMPOTENCY_CONFLICT", {
          message: "The idempotency key already belongs to another request.",
          details: { requestId: parsed.requestId },
          cause: error,
        });
      }
      throw error;
    }
  }

  async function snapshot(
    input: GatewayBudgetSnapshotInput,
  ): Promise<GatewayBudgetBalance[]> {
    const parsed = parseInput(snapshotSchema, input);
    if (parsed.budgetIds) {
      const budgets = await readBudgets(
        db,
        parsed.tenantId,
        parsed.budgetIds,
        false,
      );
      return budgets.map(balanceView);
    }
    const { rows } = await db.query<BudgetRow>(
      `SELECT ${BUDGET_COLUMNS}
         FROM gateway_budget
        WHERE tenant_id = $1
        ORDER BY scope, scope_id, id`,
      [parsed.tenantId],
    );
    return rows.map(balanceView);
  }

  return {
    debitMedia,
    refundMedia,
    completeMedia,
    admitText,
    chargeText,
    snapshot,
  };
}

// ─── Invariants ───────────────────────────────────────────────────────────────

export type GatewayInvariantRule =
  | "non-negative"
  | "reserved-is-zero"
  | "spent-matches-ledger"
  | "refund-matches-debit"
  | "floor-respected"
  | "settlement-charge-once";

export interface GatewayInvariantViolation {
  rule: GatewayInvariantRule;
  budgetId?: string;
  requestId?: string;
  detail: Record<string, unknown>;
}

export interface GatewayInvariantReport {
  ok: boolean;
  floorMicroCredits: number;
  budgetsChecked: number;
  ledgerRowsChecked: number;
  violations: GatewayInvariantViolation[];
}

export interface GatewayInvariantOptions {
  /** Restrict the check to one tenant. */
  tenantId?: string;
  /** Credit floor to check against; defaults to the configured floor. */
  floorMicroCredits?: number;
}

/** Settlement kinds plus the period-rollover `adjust` rows (#365). */
const SPEND_KINDS =
  "(kind IN ('debit', 'charge', 'refund') OR (kind = 'adjust' AND ref_kind = 'period_rollover'))";

/** A refund after a rollover may take back less than it refunds. */
function refundRollbackOf(row: LedgerRow, amount: number): number {
  const basis = row.billing_basis as
    | { spentRolledBackMicroCredits?: unknown }
    | null
    | undefined;
  const rolled = basis?.spentRolledBackMicroCredits;
  return rolled === undefined
    ? amount
    : readMicroCredits(rolled, "spentRolledBackMicroCredits");
}

/**
 * Re-derive the budgets from the ledger and report every drift this store can
 * produce. Admin movements (`grant`, `topup`, `expire`, `adjust`) move a
 * budget's limit, not its spend, so only the settlement kinds take part in the
 * spend reconciliation.
 */
export async function checkGatewayInvariants(
  db: GatewayBudgetDatabase,
  options: GatewayInvariantOptions = {},
): Promise<GatewayInvariantReport> {
  const violations: GatewayInvariantViolation[] = [];
  const floor = await resolveConfiguredFloor(db, options.floorMicroCredits);

  const budgetFilter = options.tenantId === undefined ? "" : " WHERE tenant_id = $1";
  const { rows: budgets } = await db.query<BudgetRow>(
    `SELECT ${BUDGET_COLUMNS} FROM gateway_budget${budgetFilter} ORDER BY id`,
    options.tenantId === undefined ? [] : [options.tenantId],
  );

  const ledgerFilter =
    options.tenantId === undefined
      ? ` WHERE ${SPEND_KINDS}`
      : ` WHERE tenant_id = $1 AND ${SPEND_KINDS}`;
  const { rows: ledgerRows } = await db.query<LedgerRow>(
    `SELECT id, request_id, budget_id, kind, amount_micro_credits, user_id, key_id,
            ref_kind, billing_basis
       FROM gateway_usage_ledger${ledgerFilter}
      ORDER BY request_id, budget_id, kind`,
    options.tenantId === undefined ? [] : [options.tenantId],
  );

  const spend = new Map<string, number>();
  const debits = new Map<string, number>();
  const refunds = new Map<string, number>();
  const owners = new Map<string, { requestId: string; budgetId: string }>();
  const seen = new Set<string>();
  for (const row of ledgerRows) {
    const amount = readMicroCredits(
      row.amount_micro_credits,
      "amount_micro_credits",
    );
    const key = `${row.request_id} ${row.budget_id}`;
    owners.set(key, { requestId: row.request_id, budgetId: row.budget_id });
    const settlementKey = `${key} ${row.kind}`;
    if (seen.has(settlementKey)) {
      violations.push({
        rule: "settlement-charge-once",
        requestId: row.request_id,
        budgetId: row.budget_id,
        detail: { kind: row.kind, ledgerId: row.id },
      });
    }
    seen.add(settlementKey);
    if (row.kind === "debit") {
      debits.set(key, (debits.get(key) ?? 0) + amount);
      spend.set(row.budget_id, (spend.get(row.budget_id) ?? 0) + amount);
    } else if (row.kind === "charge") {
      spend.set(row.budget_id, (spend.get(row.budget_id) ?? 0) + amount);
    } else if (row.kind === "adjust") {
      // Period rollover (#365): the spend it cleared.
      spend.set(row.budget_id, (spend.get(row.budget_id) ?? 0) - amount);
    } else {
      refunds.set(key, (refunds.get(key) ?? 0) + amount);
      spend.set(
        row.budget_id,
        (spend.get(row.budget_id) ?? 0) - refundRollbackOf(row, amount),
      );
    }
  }

  for (const [key, refunded] of refunds) {
    const debited = debits.get(key) ?? 0;
    if (debited !== refunded) {
      const owner = owners.get(key);
      violations.push({
        rule: "refund-matches-debit",
        requestId: owner?.requestId,
        budgetId: owner?.budgetId,
        detail: { debitedMicroCredits: debited, refundedMicroCredits: refunded },
      });
    }
  }

  for (const budget of budgets) {
    const spent = spentOf(budget);
    const reserved = readMicroCredits(
      budget.reserved_micro_credits,
      "reserved_micro_credits",
    );
    if (spent < 0) {
      violations.push({
        rule: "non-negative",
        budgetId: budget.id,
        detail: { spentMicroCredits: spent },
      });
    }
    if (reserved !== 0) {
      violations.push({
        rule: "reserved-is-zero",
        budgetId: budget.id,
        detail: { reservedMicroCredits: reserved },
      });
    }
    const expected = spend.get(budget.id) ?? 0;
    if (spent !== expected) {
      violations.push({
        rule: "spent-matches-ledger",
        budgetId: budget.id,
        detail: { spentMicroCredits: spent, ledgerMicroCredits: expected },
      });
    }
    const balance = balanceOf(budget);
    if (balance !== null && balance < -floor) {
      violations.push({
        rule: "floor-respected",
        budgetId: budget.id,
        detail: {
          balanceMicroCredits: balance,
          floorMicroCredits: floor,
        },
      });
    }
  }

  return {
    ok: violations.length === 0,
    floorMicroCredits: floor,
    budgetsChecked: budgets.length,
    ledgerRowsChecked: ledgerRows.length,
    violations,
  };
}
