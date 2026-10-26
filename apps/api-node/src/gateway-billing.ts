/**
 * Credit billing and price book over Postgres (#425): the api-node adapters
 * of gateway-core's GatewayBillingPort and GatewayPriceBookPort. The D1
 * adapters are apps/api-cf/src/gateway/d1-billing.ts and d1-price-book.ts;
 * gateway-core's shared billing contract suite runs against both (PGlite in
 * gateway-billing.test.ts, real Postgres in the #379 lite harness).
 *
 * Same model as D1: the tenant wallet is the `tenant`-scope gateway_budget;
 * purchases and grants raise its limit, never touch member or key budgets;
 * ledger kinds grant / topup / expire / adjust (ref_kind admin_credit,
 * admin_debit, payment_refund) with the shared request ids as idempotency
 * anchors on the unchanged UNIQUE (request_id, budget_id, kind).
 *
 * Atomicity: every operation is one transaction. A purchase first creates the
 * wallet (at limit 0) if missing, then locks it FOR UPDATE, so writes to one
 * tenant's wallet serialize; the idempotency replay, the pack / package
 * status and the one-live-subscription rule are re-checked under that lock
 * (and the live subscription by its partial unique index, 0020). A
 * concurrent duplicate of a purchase (the same provider event redelivered)
 * waits on the lock and then answers the first one as a replay.
 *
 * Usage spent in a period (for the unused-grant expiry) is the N2 money of
 * that period on the wallet: debit + charge - refund (gateway-budget.ts).
 */
import { randomUUID } from "node:crypto";
import {
  GATEWAY_BILLING_ADJUST_REF_KINDS,
  GATEWAY_BILLING_ADMIN_CREDIT,
  GATEWAY_BILLING_ADMIN_DEBIT,
  GATEWAY_BILLING_MAX_PERIODS_PER_ROLLOVER,
  GATEWAY_BILLING_PAYMENT_REFUND,
  GatewayError,
  assertPriceDraftPolicy,
  assertRefundAmount,
  billingAuditIdentity,
  billingPaymentRef,
  billingPeriod,
  billingPeriodIndex,
  billingRequestIds,
  billingSubscriptionId,
  expiringGrant,
  walletAvailable,
  type GatewayBillingActor,
  type GatewayBillingPort,
  type GatewayBillingRateLimit,
  type GatewayBillingStaffActor,
  type GatewayCreditEntryView,
  type GatewayPackageView,
  type GatewayPriceBookPort,
  type GatewayPriceDraftInput,
  type GatewayPriceUnit,
  type GatewayPriceVersionView,
  type GatewayPurchaseResult,
  type GatewayRolloverOutcome,
  type GatewaySubscriptionView,
  type GatewayTopupPackView,
  type GatewayWalletView,
} from "@clash/gateway-core";
import type {
  GatewayBudgetDatabase,
  GatewayBudgetSqlClient,
} from "./gateway-budget.ts";

type Sql = GatewayBudgetSqlClient;

export interface PgGatewayBillingOptions {
  db: GatewayBudgetDatabase;
  /** Clock in epoch milliseconds. */
  now?: () => number;
}

const toSeconds = (ms: number) => Math.floor(ms / 1000);
const toMs = (s: number) => s * 1000;
const iso = (s: number) => new Date(toMs(s)).toISOString();
const num = (value: unknown): number =>
  value === null || value === undefined ? 0 : Number(value);
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const newId = (prefix: string) =>
  `${prefix}${randomUUID().replaceAll("-", "")}`;
const jsonOrNull = (value: unknown) =>
  value === undefined || value === null ? null : JSON.stringify(value);
const LIVE = "status IN ('trialing', 'active')";

type Row = Record<string, unknown>;

interface PackageRow extends Row {
  id: string;
  name: string;
  status: string;
  billing_period: string;
  price_minor: string | number;
  price_currency: string;
  credits_micro: string | number;
  rate_limit_json: GatewayBillingRateLimit | null;
  external_price_id: string | null;
  created_at: string | number;
  updated_at: string | number;
}
interface PackRow extends Row {
  id: string;
  name: string;
  status: string;
  price_minor: string | number;
  price_currency: string;
  credits_micro: string | number;
  external_price_id: string | null;
  created_at: string | number;
  updated_at: string | number;
}
interface SubscriptionRow extends Row {
  id: string;
  tenant_id: string;
  package_id: string;
  status: string;
  current_period_start: string | number;
  current_period_end: string | number;
  cancel_at: string | number | null;
  canceled_at: string | number | null;
  rate_limit_json: GatewayBillingRateLimit | null;
  created_at: string | number;
}
interface WalletRow extends Row {
  id: string;
  tenant_id: string;
  status: string;
  period: string;
  limit_micro_credits: string | number | null;
  spent_micro_credits: string | number;
  reserved_micro_credits: string | number;
}
interface CreditRow extends Row {
  request_id: string;
  kind: GatewayCreditEntryView["kind"];
  amount_micro_credits: string | number;
  ref_kind: string | null;
  ref_id: string | null;
  actor_user_id: string | null;
  occurred_at: string | number;
}

const SUBSCRIPTION_COLUMNS = `id, tenant_id, package_id, status, current_period_start,
  current_period_end, cancel_at, canceled_at, rate_limit_json, created_at`;
const WALLET_COLUMNS = `id, tenant_id, status, period, limit_micro_credits, spent_micro_credits,
  reserved_micro_credits`;
const CREDIT_COLUMNS = `request_id, kind, amount_micro_credits, ref_kind, ref_id, actor_user_id, occurred_at`;

function packageView(row: PackageRow): GatewayPackageView {
  return {
    id: row.id,
    name: row.name,
    status: row.status === "archived" ? "archived" : "active",
    billingPeriod: row.billing_period === "year" ? "year" : "month",
    priceMinor: num(row.price_minor),
    priceCurrency: row.price_currency,
    periodMicroCredits: num(row.credits_micro),
    rateLimit: row.rate_limit_json ?? null,
    externalPriceId: row.external_price_id ?? null,
    createdAt: iso(num(row.created_at)),
    updatedAt: iso(num(row.updated_at)),
  };
}
function packView(row: PackRow): GatewayTopupPackView {
  return {
    id: row.id,
    name: row.name,
    status: row.status === "archived" ? "archived" : "active",
    priceMinor: num(row.price_minor),
    priceCurrency: row.price_currency,
    microCredits: num(row.credits_micro),
    externalPriceId: row.external_price_id ?? null,
    createdAt: iso(num(row.created_at)),
    updatedAt: iso(num(row.updated_at)),
  };
}
function subscriptionView(row: SubscriptionRow): GatewaySubscriptionView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    packageId: row.package_id,
    status: row.status,
    currentPeriodStart: iso(num(row.current_period_start)),
    currentPeriodEnd: iso(num(row.current_period_end)),
    cancelAt: row.cancel_at === null ? null : iso(num(row.cancel_at)),
    canceledAt: row.canceled_at === null ? null : iso(num(row.canceled_at)),
    rateLimit: row.rate_limit_json ?? null,
  };
}
function walletView(row: WalletRow): GatewayWalletView {
  const limit = numOrNull(row.limit_micro_credits);
  const spent = num(row.spent_micro_credits);
  const reserved = num(row.reserved_micro_credits);
  return {
    budgetId: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    limitMicroCredits: limit,
    spentMicroCredits: spent,
    reservedMicroCredits: reserved,
    availableMicroCredits:
      limit === null
        ? null
        : walletAvailable({
            limitMicroCredits: limit,
            spentMicroCredits: spent,
            reservedMicroCredits: reserved,
          }),
  };
}
function creditView(row: CreditRow): GatewayCreditEntryView {
  return {
    requestId: row.request_id,
    kind: row.kind,
    amountMicroCredits: num(row.amount_micro_credits),
    refKind: row.ref_kind,
    refId: row.ref_id,
    actorUserId: row.actor_user_id,
    occurredAt: iso(num(row.occurred_at)),
  };
}
const fundable = (wallet: WalletRow) =>
  wallet.limit_micro_credits !== null && wallet.period === "none";
function incompatible(wallet: WalletRow): GatewayError {
  return new GatewayError("GATEWAY_WALLET_INCOMPATIBLE", {
    details: {
      budgetId: wallet.id,
      reason: wallet.limit_micro_credits === null ? "unlimited" : "periodic",
    },
  });
}
const isUniqueViolation = (cause: unknown, index: RegExp) => {
  const error = cause as
    { code?: string; constraint?: string; message?: string } | undefined;
  return (
    error?.code === "23505" &&
    index.test(`${error.constraint ?? ""} ${error.message ?? ""}`)
  );
};

async function one<T extends Row>(
  sql: Sql,
  text: string,
  params: unknown[],
): Promise<T | null> {
  const { rows } = await sql.query<T>(text, params);
  return rows[0] ?? null;
}

/** Appends one billing audit row inside the caller's transaction (gateway_admin_audit, 0017 + 0020). */
async function audit(
  tx: Sql,
  input: {
    tenantId: string;
    actor: GatewayBillingActor;
    action: string;
    targetType: string;
    targetId: string;
    before?: unknown;
    after: unknown;
    reason?: string | null;
    nowS: number;
  },
): Promise<void> {
  const actor = billingAuditIdentity(input.actor);
  await tx.query(
    `INSERT INTO gateway_admin_audit
       (id, tenant_id, actor_kind, actor_id, actor_role, action, target_type, target_id,
        before_json, after_json, reason, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
    [
      newId("gaa_"),
      input.tenantId,
      actor.kind,
      actor.id,
      actor.role,
      input.action,
      input.targetType,
      input.targetId,
      jsonOrNull(input.before),
      jsonOrNull(input.after),
      input.reason ?? null,
      input.nowS,
    ],
  );
}

export function createPgGatewayBilling(
  options: PgGatewayBillingOptions,
): GatewayBillingPort {
  const { db } = options;
  const nowSeconds = () => toSeconds((options.now ?? Date.now)());

  const packageRow = (sql: Sql, id: string) =>
    one<PackageRow>(sql, `SELECT * FROM gateway_package WHERE id = $1`, [id]);
  const packRow = (sql: Sql, id: string) =>
    one<PackRow>(sql, `SELECT * FROM gateway_topup_pack WHERE id = $1`, [id]);
  const walletRow = (sql: Sql, tenantId: string, lock = false) =>
    one<WalletRow>(
      sql,
      `SELECT ${WALLET_COLUMNS} FROM gateway_budget WHERE tenant_id = $1 AND scope = 'tenant' AND scope_id = $1${lock ? " FOR UPDATE" : ""}`,
      [tenantId],
    );
  const subscriptionRow = (sql: Sql, id: string) =>
    one<SubscriptionRow>(
      sql,
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM gateway_tenant_subscription WHERE id = $1`,
      [id],
    );
  const liveSubscription = (sql: Sql, tenantId: string) =>
    one<SubscriptionRow>(
      sql,
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM gateway_tenant_subscription
        WHERE tenant_id = $1 AND ${LIVE} ORDER BY current_period_end DESC LIMIT 1`,
      [tenantId],
    );
  const creditEntry = (
    sql: Sql,
    requestId: string,
    kind: GatewayCreditEntryView["kind"],
  ) =>
    one<CreditRow>(
      sql,
      `SELECT ${CREDIT_COLUMNS} FROM gateway_usage_ledger WHERE request_id = $1 AND kind = $2 LIMIT 1`,
      [requestId, kind],
    );

  async function requireTenant(tenantId: string): Promise<void> {
    if (
      !(await one(db, `SELECT 1 AS found FROM tenant WHERE id = $1`, [
        tenantId,
      ]))
    )
      throw new GatewayError("GATEWAY_TENANT_NOT_FOUND", {
        details: { tenantId },
      });
  }
  async function requireFundableWallet(
    sql: Sql,
    tenantId: string,
  ): Promise<void> {
    const wallet = await walletRow(sql, tenantId);
    if (wallet && !fundable(wallet)) throw incompatible(wallet);
  }
  async function walletOrThrow(
    sql: Sql,
    tenantId: string,
  ): Promise<GatewayWalletView> {
    const wallet = await walletRow(sql, tenantId);
    if (!wallet)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The tenant wallet is missing after a purchase.",
      });
    return walletView(wallet);
  }

  /** Creates the wallet at limit 0 when missing, then locks it; refuses a wallet that cannot hold credits. */
  async function lockFundableWallet(
    tx: Sql,
    tenantId: string,
    nowS: number,
  ): Promise<WalletRow> {
    await tx.query(
      `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, period, limit_micro_credits, created_at, updated_at)
       VALUES ($1, $2, 'tenant', $2, 'none', 0, $3, $3)
       ON CONFLICT (tenant_id, scope, scope_id) DO NOTHING`,
      [newId("gwb_w_"), tenantId, nowS],
    );
    const wallet = await walletRow(tx, tenantId, true);
    if (!wallet)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The tenant wallet is missing.",
      });
    if (!fundable(wallet)) throw incompatible(wallet);
    return wallet;
  }

  async function insertCredit(
    tx: Sql,
    wallet: WalletRow,
    input: {
      requestId: string;
      kind: GatewayCreditEntryView["kind"];
      amount: number;
      refKind: string;
      refId: string;
      actor: GatewayBillingActor;
      reason?: string | null;
      nowS: number;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO gateway_usage_ledger
         (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits,
          ref_kind, ref_id, actor_user_id, reason, occurred_at, created_at)
       VALUES ($1, $2, $3, $4, 'posted', $5, $6, $7, $8, $9, $10, $11, $11)`,
      [
        `${input.requestId}:${input.kind}:${wallet.id}`,
        input.requestId,
        wallet.id,
        input.kind,
        wallet.tenant_id,
        input.amount,
        input.refKind,
        input.refId,
        billingAuditIdentity(input.actor).id,
        input.reason ?? null,
        input.nowS,
      ],
    );
  }

  /** limit += delta on the locked wallet; a removal never takes the limit below spend + holds. */
  async function moveWalletLimit(
    tx: Sql,
    wallet: WalletRow,
    delta: number,
    nowS: number,
  ): Promise<void> {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE gateway_budget
          SET limit_micro_credits = limit_micro_credits + $2, version = version + 1, updated_at = $3
        WHERE id = $1 AND limit_micro_credits IS NOT NULL AND period = 'none'
          AND ($2 >= 0 OR limit_micro_credits + $2 >= spent_micro_credits + reserved_micro_credits)
        RETURNING id`,
      [wallet.id, delta, nowS],
    );
    if (!rows[0])
      throw new GatewayError("GATEWAY_BUDGET_BELOW_USAGE", {
        details: { tenantId: wallet.tenant_id, budgetId: wallet.id },
      });
  }

  async function externalPriceWrite<T>(
    write: () => Promise<T>,
    externalPriceId: string | null | undefined,
  ): Promise<T> {
    try {
      return await write();
    } catch (cause) {
      if (externalPriceId && isUniqueViolation(cause, /external_price/))
        throw new GatewayError("GATEWAY_EXTERNAL_PRICE_ID_TAKEN", {
          details: { externalPriceId },
          cause,
        });
      throw cause;
    }
  }

  // ─── Packages and top-up packs ─────────────────────────────────────────

  async function listPackages(): Promise<GatewayPackageView[]> {
    const { rows } = await db.query<PackageRow>(
      `SELECT * FROM gateway_package ORDER BY status = 'archived', created_at DESC, id`,
    );
    return rows.map(packageView);
  }

  async function createPackage(
    input: Parameters<GatewayBillingPort["createPackage"]>[0],
    actor: GatewayBillingActor,
  ): Promise<GatewayPackageView> {
    billingAuditIdentity(actor);
    const id = newId("gwpkg_");
    const nowS = nowSeconds();
    await externalPriceWrite(
      () =>
        db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO gateway_package
               (id, name, status, billing_period, price_minor, price_currency, credits_micro,
                rate_limit_json, external_price_id, created_at, updated_at)
             VALUES ($1, $2, 'active', $3, $4, $5, $6, $7::jsonb, $8, $9, $9)`,
            [
              id,
              input.name,
              input.billingPeriod,
              input.priceMinor,
              input.priceCurrency,
              input.periodMicroCredits,
              jsonOrNull(input.rateLimit),
              input.externalPriceId ?? null,
              nowS,
            ],
          );
          await audit(tx, {
            tenantId: "",
            actor,
            action: "package.create",
            targetType: "package",
            targetId: id,
            after: input,
            nowS,
          });
        }),
      input.externalPriceId,
    );
    const row = await packageRow(db, id);
    if (!row)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The created package is missing.",
      });
    return packageView(row);
  }

  async function archive(
    table: "gateway_package" | "gateway_topup_pack",
    id: string,
    actor: GatewayBillingActor,
  ): Promise<void> {
    const isPackage = table === "gateway_package";
    const notFound = () =>
      isPackage
        ? new GatewayError("GATEWAY_PACKAGE_NOT_FOUND", {
            details: { packageId: id },
          })
        : new GatewayError("GATEWAY_TOPUP_PACK_NOT_FOUND", {
            details: { packId: id },
          });
    billingAuditIdentity(actor);
    const before = await one<{ status: string }>(
      db,
      `SELECT status FROM ${table} WHERE id = $1`,
      [id],
    );
    if (!before) throw notFound();
    if (before.status === "archived") return;
    const nowS = nowSeconds();
    await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE ${table} SET status = 'archived', updated_at = $2 WHERE id = $1 AND status <> 'archived' RETURNING id`,
        [id, nowS],
      );
      if (!rows[0]) return;
      await audit(tx, {
        tenantId: "",
        actor,
        action: isPackage ? "package.archive" : "topup_pack.archive",
        targetType: isPackage ? "package" : "topup_pack",
        targetId: id,
        before: { status: before.status },
        after: { status: "archived" },
        nowS,
      });
    });
  }

  async function archivePackage(
    id: string,
    actor: GatewayBillingActor,
  ): Promise<GatewayPackageView> {
    await archive("gateway_package", id, actor);
    const row = await packageRow(db, id);
    if (!row)
      throw new GatewayError("GATEWAY_PACKAGE_NOT_FOUND", {
        details: { packageId: id },
      });
    return packageView(row);
  }

  async function listTopupPacks(): Promise<GatewayTopupPackView[]> {
    const { rows } = await db.query<PackRow>(
      `SELECT * FROM gateway_topup_pack ORDER BY status = 'archived', created_at DESC, id`,
    );
    return rows.map(packView);
  }

  async function createTopupPack(
    input: Parameters<GatewayBillingPort["createTopupPack"]>[0],
    actor: GatewayBillingActor,
  ): Promise<GatewayTopupPackView> {
    billingAuditIdentity(actor);
    const id = newId("gwpack_");
    const nowS = nowSeconds();
    await externalPriceWrite(
      () =>
        db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO gateway_topup_pack
               (id, name, status, price_minor, price_currency, credits_micro, validity_days, external_price_id,
                created_at, updated_at)
             VALUES ($1, $2, 'active', $3, $4, $5, NULL, $6, $7, $7)`,
            [
              id,
              input.name,
              input.priceMinor,
              input.priceCurrency,
              input.microCredits,
              input.externalPriceId ?? null,
              nowS,
            ],
          );
          await audit(tx, {
            tenantId: "",
            actor,
            action: "topup_pack.create",
            targetType: "topup_pack",
            targetId: id,
            after: input,
            nowS,
          });
        }),
      input.externalPriceId,
    );
    const row = await packRow(db, id);
    if (!row)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The created top-up pack is missing.",
      });
    return packView(row);
  }

  async function archiveTopupPack(
    id: string,
    actor: GatewayBillingActor,
  ): Promise<GatewayTopupPackView> {
    await archive("gateway_topup_pack", id, actor);
    const row = await packRow(db, id);
    if (!row)
      throw new GatewayError("GATEWAY_TOPUP_PACK_NOT_FOUND", {
        details: { packId: id },
      });
    return packView(row);
  }

  async function setExternalPriceId(
    table: "gateway_package" | "gateway_topup_pack",
    id: string,
    externalPriceId: string | null,
    actor: GatewayBillingActor,
  ): Promise<void> {
    const isPackage = table === "gateway_package";
    billingAuditIdentity(actor);
    const before = await one<{ external_price_id: string | null }>(
      db,
      `SELECT external_price_id FROM ${table} WHERE id = $1`,
      [id],
    );
    if (!before)
      throw isPackage
        ? new GatewayError("GATEWAY_PACKAGE_NOT_FOUND", {
            details: { packageId: id },
          })
        : new GatewayError("GATEWAY_TOPUP_PACK_NOT_FOUND", {
            details: { packId: id },
          });
    if ((before.external_price_id ?? null) === externalPriceId) return;
    const nowS = nowSeconds();
    await externalPriceWrite(
      () =>
        db.transaction(async (tx) => {
          const { rows } = await tx.query(
            `UPDATE ${table} SET external_price_id = $2, updated_at = $3
              WHERE id = $1 AND external_price_id IS NOT DISTINCT FROM $4 RETURNING id`,
            [id, externalPriceId, nowS, before.external_price_id ?? null],
          );
          if (!rows[0]) return;
          await audit(tx, {
            tenantId: "",
            actor,
            action: isPackage
              ? "package.external_price"
              : "topup_pack.external_price",
            targetType: isPackage ? "package" : "topup_pack",
            targetId: id,
            before: { externalPriceId: before.external_price_id ?? null },
            after: { externalPriceId },
            nowS,
          });
        }),
      externalPriceId,
    );
  }

  // ─── Purchases ─────────────────────────────────────────────────────────

  async function topup(
    input: Parameters<GatewayBillingPort["topup"]>[0],
  ): Promise<GatewayPurchaseResult<never>> {
    billingAuditIdentity(input.actor);
    const requestId = billingRequestIds.topup(
      input.tenantId,
      input.idempotencyKey,
    );
    const replay = async (
      sql: Sql,
    ): Promise<GatewayPurchaseResult<never> | null> => {
      const prior = await creditEntry(sql, requestId, "topup");
      if (!prior) return null;
      if (prior.ref_id !== input.packId)
        throw new GatewayError("GATEWAY_IDEMPOTENCY_CONFLICT", {
          details: { idempotencyKey: input.idempotencyKey },
        });
      return {
        replayed: true,
        entry: creditView(prior),
        wallet: await walletOrThrow(sql, input.tenantId),
      };
    };
    await requireTenant(input.tenantId);
    const prior = await replay(db);
    if (prior) return prior;
    const pack = await packRow(db, input.packId);
    if (!pack)
      throw new GatewayError("GATEWAY_TOPUP_PACK_NOT_FOUND", {
        details: { packId: input.packId },
      });
    if (pack.status !== "active")
      throw new GatewayError("GATEWAY_TOPUP_PACK_ARCHIVED", {
        details: { packId: input.packId },
      });
    await requireFundableWallet(db, input.tenantId);
    const nowS = nowSeconds();
    return db.transaction(async (tx) => {
      const wallet = await lockFundableWallet(tx, input.tenantId, nowS);
      const raced = await replay(tx);
      if (raced) return raced;
      const current = await packRow(tx, input.packId);
      if (current?.status !== "active")
        throw new GatewayError("GATEWAY_TOPUP_PACK_ARCHIVED", {
          details: { packId: input.packId },
        });
      const amount = num(current.credits_micro);
      await insertCredit(tx, wallet, {
        requestId,
        kind: "topup",
        amount,
        refKind: "topup_pack",
        refId: current.id,
        actor: input.actor,
        nowS,
      });
      await moveWalletLimit(tx, wallet, amount, nowS);
      await audit(tx, {
        tenantId: input.tenantId,
        actor: input.actor,
        action: "wallet.topup",
        targetType: "topup",
        targetId: requestId,
        after: {
          packId: current.id,
          microCredits: amount,
          ...billingPaymentRef(input.actor),
        },
        nowS,
      });
      const entry = await creditEntry(tx, requestId, "topup");
      if (!entry)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "The top-up entry is missing.",
        });
      return {
        replayed: false,
        entry: creditView(entry),
        wallet: await walletOrThrow(tx, input.tenantId),
      };
    });
  }

  async function subscribe(
    input: Parameters<GatewayBillingPort["subscribe"]>[0],
  ): Promise<GatewayPurchaseResult<GatewaySubscriptionView>> {
    billingAuditIdentity(input.actor);
    const subscriptionId = await billingSubscriptionId(
      input.tenantId,
      input.idempotencyKey,
    );
    const replay = async (
      sql: Sql,
    ): Promise<GatewayPurchaseResult<GatewaySubscriptionView> | null> => {
      const prior = await subscriptionRow(sql, subscriptionId);
      if (!prior) return null;
      if (prior.package_id !== input.packageId)
        throw new GatewayError("GATEWAY_IDEMPOTENCY_CONFLICT", {
          details: { idempotencyKey: input.idempotencyKey },
        });
      const grant = await creditEntry(
        sql,
        billingRequestIds.grant(prior.id, num(prior.created_at)),
        "grant",
      );
      if (!grant)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "The first subscription grant is missing.",
        });
      return {
        replayed: true,
        entry: creditView(grant),
        wallet: await walletOrThrow(sql, input.tenantId),
        subscription: subscriptionView(prior),
      };
    };
    await requireTenant(input.tenantId);
    const prior = await replay(db);
    if (prior) return prior;
    const pkg = await packageRow(db, input.packageId);
    if (!pkg)
      throw new GatewayError("GATEWAY_PACKAGE_NOT_FOUND", {
        details: { packageId: input.packageId },
      });
    if (pkg.status !== "active")
      throw new GatewayError("GATEWAY_PACKAGE_ARCHIVED", {
        details: { packageId: input.packageId },
      });
    const live = await liveSubscription(db, input.tenantId);
    if (live)
      throw new GatewayError("GATEWAY_SUBSCRIPTION_EXISTS", {
        details: { subscriptionId: live.id },
      });
    await requireFundableWallet(db, input.tenantId);
    const nowS = nowSeconds();
    let created = false;
    try {
      await db.transaction(async (tx) => {
        const wallet = await lockFundableWallet(tx, input.tenantId, nowS);
        // A duplicate that waited on the wallet lock answers as a replay.
        if (await subscriptionRow(tx, subscriptionId)) return;
        const current = await packageRow(tx, input.packageId);
        if (current?.status !== "active")
          throw new GatewayError("GATEWAY_PACKAGE_ARCHIVED", {
            details: { packageId: input.packageId },
          });
        const nowLive = await liveSubscription(tx, input.tenantId);
        if (nowLive)
          throw new GatewayError("GATEWAY_SUBSCRIPTION_EXISTS", {
            details: { subscriptionId: nowLive.id },
          });
        const view = packageView(current);
        const endS = toSeconds(
          billingPeriod(toMs(nowS), view.billingPeriod, 0).end,
        );
        // created_at is the period anchor: period n starts n periods after it.
        await tx.query(
          `INSERT INTO gateway_tenant_subscription
             (id, tenant_id, package_id, status, current_period_start, current_period_end,
              rate_limit_json, created_at, updated_at)
           VALUES ($1, $2, $3, 'active', $4, $5, $6::jsonb, $4, $4)`,
          [
            subscriptionId,
            input.tenantId,
            current.id,
            nowS,
            endS,
            jsonOrNull(current.rate_limit_json),
          ],
        );
        const amount = view.periodMicroCredits;
        await insertCredit(tx, wallet, {
          requestId: billingRequestIds.grant(subscriptionId, nowS),
          kind: "grant",
          amount,
          refKind: "subscription",
          refId: subscriptionId,
          actor: input.actor,
          nowS,
        });
        await moveWalletLimit(tx, wallet, amount, nowS);
        await audit(tx, {
          tenantId: input.tenantId,
          actor: input.actor,
          action: "subscription.create",
          targetType: "subscription",
          targetId: subscriptionId,
          after: {
            packageId: current.id,
            periodStart: nowS,
            periodEnd: endS,
            grantMicroCredits: amount,
            ...billingPaymentRef(input.actor),
          },
          nowS,
        });
        created = true;
      });
    } catch (cause) {
      // Another transaction took the one live slot (partial unique index) or this very key.
      if (isUniqueViolation(cause, /gateway_tenant_subscription/)) {
        const raced = await replay(db);
        if (raced) return raced;
        const nowLive = await liveSubscription(db, input.tenantId);
        if (nowLive)
          throw new GatewayError("GATEWAY_SUBSCRIPTION_EXISTS", {
            details: { subscriptionId: nowLive.id },
          });
        throw new GatewayError("GATEWAY_CONFLICT", {
          details: { tenantId: input.tenantId },
          cause,
        });
      }
      throw cause;
    }
    const result = await replay(db);
    if (!result)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The created subscription is missing.",
      });
    return { ...result, replayed: !created };
  }

  async function cancelSubscription(input: {
    tenantId: string;
    actor: GatewayBillingActor;
  }): Promise<GatewaySubscriptionView> {
    billingAuditIdentity(input.actor);
    await requireTenant(input.tenantId);
    const live = await liveSubscription(db, input.tenantId);
    if (!live)
      throw new GatewayError("GATEWAY_SUBSCRIPTION_NOT_FOUND", {
        details: { tenantId: input.tenantId },
      });
    if (live.cancel_at === null) {
      const nowS = nowSeconds();
      await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE gateway_tenant_subscription
              SET cancel_at = current_period_end, canceled_at = $2, updated_at = $2
            WHERE id = $1 AND ${LIVE} AND cancel_at IS NULL RETURNING id`,
          [live.id, nowS],
        );
        if (!rows[0]) return;
        await audit(tx, {
          tenantId: input.tenantId,
          actor: input.actor,
          action: "subscription.cancel",
          targetType: "subscription",
          targetId: live.id,
          after: {
            cancelAt: num(live.current_period_end),
            ...billingPaymentRef(input.actor),
          },
          nowS,
        });
      });
    }
    const row = await subscriptionRow(db, live.id);
    if (!row)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The subscription is missing.",
      });
    return subscriptionView(row);
  }

  // ─── Period close ──────────────────────────────────────────────────────

  /** Close one ended period: expire the unused grant, then grant the next period or end. Null: closed elsewhere. */
  async function closePeriod(
    sub: SubscriptionRow,
    actor: GatewayBillingActor,
    nowS: number,
  ): Promise<{ expired: number; granted: number; status: string } | null> {
    return db.transaction(async (tx) => {
      const wallet = await walletRow(tx, sub.tenant_id, true);
      if (!wallet)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "The subscribed tenant has no wallet.",
        });
      if (!fundable(wallet)) throw incompatible(wallet);
      const startS = num(sub.current_period_start);
      const current = await one<SubscriptionRow>(
        tx,
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM gateway_tenant_subscription
          WHERE id = $1 AND current_period_start = $2 AND ${LIVE} FOR UPDATE`,
        [sub.id, startS],
      );
      if (!current) return null;
      const pkg = await packageRow(tx, current.package_id);
      if (!pkg)
        throw new GatewayError("GATEWAY_PACKAGE_NOT_FOUND", {
          details: { packageId: current.package_id },
        });
      const endS = num(current.current_period_end);
      const grant = await creditEntry(
        tx,
        billingRequestIds.grant(current.id, startS),
        "grant",
      );
      const spentRow = await one<{ spent: string | number }>(
        tx,
        `SELECT COALESCE(SUM(CASE WHEN kind IN ('debit', 'charge') THEN amount_micro_credits ELSE -amount_micro_credits END), 0) AS spent
           FROM gateway_usage_ledger
          WHERE budget_id = $1 AND kind IN ('debit', 'charge', 'refund') AND occurred_at >= $2 AND occurred_at < $3`,
        [wallet.id, startS, endS],
      );
      const view = walletView(wallet);
      const expired = expiringGrant({
        grantedMicroCredits: grant ? num(grant.amount_micro_credits) : 0,
        spentInPeriodMicroCredits: Math.max(0, num(spentRow?.spent)),
        availableMicroCredits: view.availableMicroCredits ?? 0,
      });
      const ends = current.cancel_at !== null && num(current.cancel_at) <= endS;
      const cadence = packageView(pkg).billingPeriod;
      const anchorMs = toMs(num(current.created_at));
      const nextStartS = endS;
      const nextEndS = toSeconds(
        billingPeriod(
          anchorMs,
          cadence,
          billingPeriodIndex(anchorMs, cadence, toMs(endS)),
        ).end,
      );
      const grantNext = ends ? 0 : num(pkg.credits_micro);
      if (ends)
        await tx.query(
          `UPDATE gateway_tenant_subscription SET status = 'expired', updated_at = $2 WHERE id = $1`,
          [current.id, nowS],
        );
      else
        await tx.query(
          `UPDATE gateway_tenant_subscription SET current_period_start = $2, current_period_end = $3, updated_at = $4 WHERE id = $1`,
          [current.id, nextStartS, nextEndS, nowS],
        );
      await insertCredit(tx, wallet, {
        requestId: billingRequestIds.expire(current.id, startS),
        kind: "expire",
        amount: expired,
        refKind: "subscription",
        refId: current.id,
        actor,
        nowS,
      });
      await moveWalletLimit(tx, wallet, -expired, nowS);
      if (!ends) {
        await insertCredit(tx, wallet, {
          requestId: billingRequestIds.grant(current.id, nextStartS),
          kind: "grant",
          amount: grantNext,
          refKind: "subscription",
          refId: current.id,
          actor,
          nowS,
        });
        await moveWalletLimit(tx, wallet, grantNext, nowS);
      }
      await audit(tx, {
        tenantId: current.tenant_id,
        actor,
        action: ends ? "subscription.end" : "subscription.renew",
        targetType: "subscription",
        targetId: current.id,
        before: { periodStart: startS, periodEnd: endS },
        after: ends
          ? { status: "expired", expiredMicroCredits: expired }
          : {
              periodStart: nextStartS,
              periodEnd: nextEndS,
              expiredMicroCredits: expired,
              grantMicroCredits: grantNext,
            },
        nowS,
      });
      return {
        expired,
        granted: grantNext,
        status: ends ? "expired" : "active",
      };
    });
  }

  async function rollover(input: {
    tenantId?: string;
    actor: GatewayBillingActor;
  }): Promise<GatewayRolloverOutcome[]> {
    billingAuditIdentity(input.actor);
    const nowS = nowSeconds();
    if (input.tenantId !== undefined) await requireTenant(input.tenantId);
    const { rows: due } = await db.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM gateway_tenant_subscription
        WHERE ${LIVE} AND current_period_end <= $1 AND ($2::text IS NULL OR tenant_id = $2)
        ORDER BY current_period_end, id`,
      [nowS, input.tenantId ?? null],
    );
    const outcomes: GatewayRolloverOutcome[] = [];
    for (const first of due) {
      const outcome: GatewayRolloverOutcome = {
        subscriptionId: first.id,
        tenantId: first.tenant_id,
        periodsClosed: 0,
        expiredMicroCredits: 0,
        grantedMicroCredits: 0,
        status: first.status,
      };
      let sub: SubscriptionRow | null = first;
      while (
        sub &&
        num(sub.current_period_end) <= nowS &&
        outcome.periodsClosed < GATEWAY_BILLING_MAX_PERIODS_PER_ROLLOVER
      ) {
        try {
          const closed = await closePeriod(sub, input.actor, nowS);
          if (closed) {
            outcome.periodsClosed += 1;
            outcome.expiredMicroCredits += closed.expired;
            outcome.grantedMicroCredits += closed.granted;
            outcome.status = closed.status;
          }
        } catch (cause) {
          const error =
            cause instanceof GatewayError
              ? cause
              : new GatewayError("GATEWAY_CONFLICT", {
                  details: { subscriptionId: sub.id },
                  cause,
                });
          outcome.error = { code: error.code, message: error.message };
          break;
        }
        // Another call may have closed this period first: continue from its state.
        const next: SubscriptionRow | null = await subscriptionRow(
          db,
          first.id,
        );
        if (next && next.status !== "active" && next.status !== "trialing") {
          outcome.status = next.status;
          break;
        }
        sub = next;
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }

  async function walletSummary(tenantId: string, limit = 50) {
    await requireTenant(tenantId);
    const [wallet, subscription, entries] = await Promise.all([
      walletRow(db, tenantId),
      liveSubscription(db, tenantId),
      db.query<CreditRow>(
        `SELECT ${CREDIT_COLUMNS} FROM gateway_usage_ledger
          WHERE tenant_id = $1 AND (kind IN ('grant', 'topup', 'expire')
                OR (kind = 'adjust' AND ref_kind = ANY($2::text[])))
          ORDER BY occurred_at DESC, request_id DESC LIMIT $3`,
        [tenantId, [...GATEWAY_BILLING_ADJUST_REF_KINDS], limit],
      ),
    ]);
    return {
      wallet: wallet ? walletView(wallet) : null,
      subscription: subscription ? subscriptionView(subscription) : null,
      entries: entries.rows.map(creditView),
    };
  }

  // ─── Corrections and refunds ───────────────────────────────────────────

  async function adjustment(input: {
    tenantId: string;
    deltaMicroCredits: number;
    reason: string;
    idempotencyKey: string;
    actor: GatewayBillingActor;
    requestId: string;
    refKind: string;
    refId: string;
    action: string;
  }): Promise<GatewayPurchaseResult<never>> {
    billingAuditIdentity(input.actor);
    const { requestId, refKind } = input;
    const amount = Math.abs(input.deltaMicroCredits);
    const replay = async (
      sql: Sql,
    ): Promise<GatewayPurchaseResult<never> | null> => {
      const prior = await creditEntry(sql, requestId, "adjust");
      if (!prior) return null;
      if (
        prior.ref_kind !== refKind ||
        num(prior.amount_micro_credits) !== amount ||
        prior.ref_id !== input.refId
      )
        throw new GatewayError("GATEWAY_IDEMPOTENCY_CONFLICT", {
          details: { idempotencyKey: input.idempotencyKey },
        });
      return {
        replayed: true,
        entry: creditView(prior),
        wallet: await walletOrThrow(sql, input.tenantId),
      };
    };
    const requireCover = (wallet: WalletRow | null) => {
      if (input.deltaMicroCredits >= 0) return;
      const limit = numOrNull(wallet?.limit_micro_credits) ?? 0;
      const used =
        num(wallet?.spent_micro_credits) + num(wallet?.reserved_micro_credits);
      if (limit - amount < used)
        throw new GatewayError("GATEWAY_BUDGET_BELOW_USAGE", {
          details: {
            tenantId: input.tenantId,
            ...(wallet ? { budgetId: wallet.id } : {}),
          },
        });
    };
    await requireTenant(input.tenantId);
    const prior = await replay(db);
    if (prior) return prior;
    await requireFundableWallet(db, input.tenantId);
    requireCover(await walletRow(db, input.tenantId));
    const nowS = nowSeconds();
    return db.transaction(async (tx) => {
      const wallet = await lockFundableWallet(tx, input.tenantId, nowS);
      const raced = await replay(tx);
      if (raced) return raced;
      requireCover(wallet);
      await insertCredit(tx, wallet, {
        requestId,
        kind: "adjust",
        amount,
        refKind,
        refId: input.refId,
        actor: input.actor,
        reason: input.reason,
        nowS,
      });
      await moveWalletLimit(tx, wallet, input.deltaMicroCredits, nowS);
      await audit(tx, {
        tenantId: input.tenantId,
        actor: input.actor,
        action: input.action,
        targetType: "wallet",
        targetId: requestId,
        after: {
          deltaMicroCredits: input.deltaMicroCredits,
          ...billingPaymentRef(input.actor),
        },
        reason: input.reason,
        nowS,
      });
      const entry = await creditEntry(tx, requestId, "adjust");
      if (!entry)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "The adjustment entry is missing.",
        });
      return {
        replayed: false,
        entry: creditView(entry),
        wallet: await walletOrThrow(tx, input.tenantId),
      };
    });
  }

  const port: GatewayBillingPort = {
    adjustWallet: async (input) =>
      adjustment({
        ...input,
        requestId: billingRequestIds.adjust(
          input.tenantId,
          input.idempotencyKey,
        ),
        refKind:
          input.deltaMicroCredits >= 0
            ? GATEWAY_BILLING_ADMIN_CREDIT
            : GATEWAY_BILLING_ADMIN_DEBIT,
        refId: input.tenantId,
        action: "wallet.adjust",
      }),
    async refund(input) {
      assertRefundAmount(input.microCredits);
      return adjustment({
        tenantId: input.tenantId,
        deltaMicroCredits: -input.microCredits,
        reason: input.reason ?? `${input.actor.provider} refund`,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        requestId: billingRequestIds.refund(
          input.tenantId,
          input.idempotencyKey,
        ),
        refKind: GATEWAY_BILLING_PAYMENT_REFUND,
        refId: input.refId ?? input.tenantId,
        action: "wallet.refund",
      });
    },
    async setWalletStatus(input) {
      await requireTenant(input.tenantId);
      const before = await walletRow(db, input.tenantId);
      if (!before)
        throw new GatewayError("GATEWAY_BUDGET_NOT_FOUND", {
          details: { tenantId: input.tenantId, scope: "tenant" },
        });
      if (before.status !== input.status) {
        const nowS = nowSeconds();
        await db.transaction(async (tx) => {
          const { rows } = await tx.query(
            `UPDATE gateway_budget SET status = $2, version = version + 1, updated_at = $3
              WHERE id = $1 AND status = $4 RETURNING id`,
            [before.id, input.status, nowS, before.status],
          );
          if (!rows[0])
            throw new GatewayError("GATEWAY_CONFLICT", {
              details: { budgetId: before.id },
            });
          await audit(tx, {
            tenantId: input.tenantId,
            actor: input.actor,
            action: "wallet.status",
            targetType: "budget",
            targetId: before.id,
            before: { status: before.status },
            after: { status: input.status },
            reason: input.reason,
            nowS,
          });
        });
      }
      return walletOrThrow(db, input.tenantId);
    },
    async setSubscriptionRateLimit(input) {
      await requireTenant(input.tenantId);
      const live = await liveSubscription(db, input.tenantId);
      if (!live)
        throw new GatewayError("GATEWAY_SUBSCRIPTION_NOT_FOUND", {
          details: { tenantId: input.tenantId },
        });
      const nowS = nowSeconds();
      await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE gateway_tenant_subscription SET rate_limit_json = $2::jsonb, updated_at = $3
            WHERE id = $1 AND ${LIVE} AND rate_limit_json IS NOT DISTINCT FROM $4::jsonb RETURNING id`,
          [
            live.id,
            jsonOrNull(input.rateLimit),
            nowS,
            jsonOrNull(live.rate_limit_json),
          ],
        );
        if (!rows[0])
          throw new GatewayError("GATEWAY_CONFLICT", {
            details: { subscriptionId: live.id },
          });
        await audit(tx, {
          tenantId: input.tenantId,
          actor: input.actor,
          action: "subscription.rate_limit",
          targetType: "subscription",
          targetId: live.id,
          before: { rateLimit: live.rate_limit_json ?? null },
          after: { rateLimit: input.rateLimit },
          reason: input.reason ?? null,
          nowS,
        });
      });
      const row = await subscriptionRow(db, live.id);
      if (!row)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "The subscription is missing.",
        });
      return subscriptionView(row);
    },
    listPackages,
    createPackage,
    archivePackage,
    listTopupPacks,
    createTopupPack,
    archiveTopupPack,
    async setPackageExternalPriceId(id, externalPriceId, actor) {
      await setExternalPriceId("gateway_package", id, externalPriceId, actor);
      const row = await packageRow(db, id);
      if (!row)
        throw new GatewayError("GATEWAY_PACKAGE_NOT_FOUND", {
          details: { packageId: id },
        });
      return packageView(row);
    },
    async setTopupPackExternalPriceId(id, externalPriceId, actor) {
      await setExternalPriceId(
        "gateway_topup_pack",
        id,
        externalPriceId,
        actor,
      );
      const row = await packRow(db, id);
      if (!row)
        throw new GatewayError("GATEWAY_TOPUP_PACK_NOT_FOUND", {
          details: { packId: id },
        });
      return packView(row);
    },
    async packageByExternalPriceId(externalPriceId) {
      const row = await one<PackageRow>(
        db,
        `SELECT * FROM gateway_package WHERE external_price_id = $1`,
        [externalPriceId],
      );
      return row ? packageView(row) : null;
    },
    async topupPackByExternalPriceId(externalPriceId) {
      const row = await one<PackRow>(
        db,
        `SELECT * FROM gateway_topup_pack WHERE external_price_id = $1`,
        [externalPriceId],
      );
      return row ? packView(row) : null;
    },
    topup,
    subscribe,
    cancelSubscription,
    rollover,
    walletSummary,
  };
  return port;
}

// ─── Price book ───────────────────────────────────────────────────────────

interface PriceRow extends Row {
  price_version: string;
  model_code: string;
  upstream_id: string;
  unit: string;
  amount_micro: string | number;
  per: number;
  effective_from: string | number;
  effective_to: string | number | null;
  published_at: string | number | null;
  created_by_user_id: string | null;
}

const PRICE_COLUMNS = `price_version, model_code, upstream_id, unit, amount_micro, per,
  effective_from, effective_to, published_at, created_by_user_id`;

function versionViews(rows: readonly PriceRow[]): GatewayPriceVersionView[] {
  const views = new Map<string, GatewayPriceVersionView>();
  for (const row of rows) {
    let view = views.get(row.price_version);
    if (!view) {
      view = {
        version: row.price_version,
        status: row.published_at === null ? "draft" : "published",
        effectiveFrom: iso(num(row.effective_from)),
        effectiveTo:
          row.effective_to === null ? null : iso(num(row.effective_to)),
        publishedAt:
          row.published_at === null ? null : iso(num(row.published_at)),
        createdByUserId: row.created_by_user_id,
        rates: [],
      };
      views.set(row.price_version, view);
    }
    view.rates.push({
      modelCode: row.model_code,
      upstreamId: row.upstream_id,
      unit: row.unit as GatewayPriceUnit,
      amountMicroCredits: num(row.amount_micro),
      per: Number(row.per),
    });
  }
  return [...views.values()];
}

/** The Postgres adapter of gateway-core's GatewayPriceBookPort (gateway_price, 0016). */
export function createPgGatewayPriceBook(
  options: PgGatewayBillingOptions,
): GatewayPriceBookPort {
  const { db } = options;
  const nowSeconds = () => toSeconds((options.now ?? Date.now)());
  const lockVersion = (tx: Sql, version: string) =>
    tx.query(
      `SELECT pg_advisory_xact_lock(hashtext('clash:gateway:price:' || $1))`,
      [version],
    );
  const versionRows = async (sql: Sql, version: string) =>
    (
      await sql.query<PriceRow>(
        `SELECT ${PRICE_COLUMNS} FROM gateway_price WHERE price_version = $1 AND currency = 'credit'
          ORDER BY model_code, upstream_id, unit`,
        [version],
      )
    ).rows;
  const published = (version: string, publishedAt: string | null) =>
    new GatewayError("GATEWAY_PRICE_VERSION_PUBLISHED", {
      details: { version, publishedAt },
    });
  const audit = (
    tx: Sql,
    action: string,
    version: string,
    actor: GatewayBillingStaffActor,
    before: unknown,
    after: unknown,
    nowS: number,
  ) =>
    tx.query(
      `INSERT INTO gateway_admin_audit
         (id, tenant_id, actor_kind, actor_id, actor_role, action, target_type, target_id, before_json, after_json, created_at)
       VALUES ($1, '', $2, $3, $4, $5, 'price_version', $6, $7::jsonb, $8::jsonb, $9)`,
      [
        newId("gaa_"),
        actor.kind,
        actor.id,
        actor.role,
        action,
        version,
        jsonOrNull(before),
        jsonOrNull(after),
        nowS,
      ],
    );

  async function read(version: string): Promise<GatewayPriceVersionView> {
    const view = versionViews(await versionRows(db, version))[0];
    if (!view)
      throw new GatewayError("GATEWAY_PRICE_VERSION_NOT_FOUND", {
        details: { version },
      });
    return view;
  }

  return {
    async list(filter = {}) {
      const { rows } = await db.query<PriceRow>(
        `SELECT ${PRICE_COLUMNS} FROM gateway_price
          WHERE currency = 'credit'
            AND ($1::text IS NULL OR price_version IN (SELECT price_version FROM gateway_price WHERE model_code = $1))
            AND ($2::text IS NULL OR ($2 = 'draft') = (published_at IS NULL))
          ORDER BY effective_from DESC, price_version DESC, model_code, upstream_id, unit`,
        [filter.modelCode ?? null, filter.status ?? null],
      );
      return versionViews(rows);
    },
    read,
    async putDraft(input: GatewayPriceDraftInput) {
      assertPriceDraftPolicy(input.rates);
      const fromS = toSeconds(input.effectiveFrom);
      const toS =
        input.effectiveTo === null ? null : toSeconds(input.effectiveTo);
      if (toS !== null && toS <= fromS)
        throw new GatewayError("GATEWAY_PRICE_WINDOW_INVALID", {
          details: { param: "effectiveTo" },
        });
      const nowS = nowSeconds();
      await db.transaction(async (tx) => {
        await lockVersion(tx, input.version);
        const before = versionViews(await versionRows(tx, input.version))[0];
        if (before?.status === "published")
          throw published(input.version, before.publishedAt);
        await tx.query(
          `DELETE FROM gateway_price WHERE price_version = $1 AND published_at IS NULL`,
          [input.version],
        );
        for (const rate of input.rates)
          await tx.query(
            `INSERT INTO gateway_price
               (id, price_version, model_code, upstream_id, unit, amount_micro, per, currency,
                effective_from, effective_to, source, created_by_user_id, created_at, published_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'credit', $8, $9, 'manual', $10, $11, NULL)`,
            [
              newId("gwp_"),
              input.version,
              rate.modelCode,
              rate.upstreamId,
              rate.unit,
              rate.microCredits,
              rate.per,
              fromS,
              toS,
              input.actor.id,
              nowS,
            ],
          );
        await audit(
          tx,
          "price.draft",
          input.version,
          input.actor,
          before,
          {
            effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo,
            rates: input.rates,
          },
          nowS,
        );
      });
      return read(input.version);
    },
    async publish(input) {
      const nowS = nowSeconds();
      await db.transaction(async (tx) => {
        await lockVersion(tx, input.version);
        const before = versionViews(await versionRows(tx, input.version))[0];
        if (!before)
          throw new GatewayError("GATEWAY_PRICE_VERSION_NOT_FOUND", {
            details: { version: input.version },
          });
        if (before.status === "published")
          throw published(input.version, before.publishedAt);
        if (
          before.effectiveTo !== null &&
          toSeconds(Date.parse(before.effectiveTo)) <= nowS
        )
          throw new GatewayError("GATEWAY_PRICE_WINDOW_INVALID", {
            details: {
              version: input.version,
              reason: "ended",
              effectiveTo: before.effectiveTo,
            },
          });
        await tx.query(
          `UPDATE gateway_price SET published_at = $2, effective_from = GREATEST(effective_from, $2)
            WHERE price_version = $1 AND published_at IS NULL`,
          [input.version, nowS],
        );
        await audit(
          tx,
          "price.publish",
          input.version,
          input.actor,
          { status: "draft" },
          { status: "published", publishedAt: nowS },
          nowS,
        );
      });
      return read(input.version);
    },
  };
}
