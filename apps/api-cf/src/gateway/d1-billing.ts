/**
 * Credit billing over D1 (#352; guide: apps/docs/guide/gateway-price-book.md),
 * the D1 adapter of gateway-core's GatewayBillingPort (billing-port.ts, #425;
 * the Postgres adapter is apps/api-node/src/gateway-billing.ts):
 * subscription packages (`gateway_package`), top-up packs
 * (`gateway_topup_pack`), tenant subscriptions (`gateway_tenant_subscription`)
 * and the tenant wallet (the `tenant`-scope `gateway_budget`).
 *
 * Self-host has no payment provider: a purchase is recorded by a tenant role
 * holding `billing.purchase` (services/gateway-authz.ts) and credits the
 * wallet at once. With a payments plugin (`Plugin.billing.purchaseMode =
 * "provider"`, #419) the product purchase routes are closed and the plugin
 * calls the same operations from verified provider webhooks with a `payment`
 * actor (provider + event id) and the provider's id as idempotency key;
 * refunds and chargebacks are `refund()` (an `adjust` entry, ref_kind
 * `payment_refund`). Packages and packs carry the provider's price id as
 * configuration (`external_price_id`), never in code:
 *
 * - topup:     ledger `topup`, wallet limit += pack credits.
 * - subscribe: subscription row + ledger `grant` for the first period.
 * - rollover:  explicit, idempotent period close for subscriptions whose
 *              period has ended: ledger `expire` of the unused grant, then the
 *              next period's `grant` (or the subscription ends when canceled).
 *              Nothing runs in the background; a scheduler may call it later.
 *
 * Each operation is one D1 batch: the ledger entry, the wallet change, the
 * subscription change and the `gateway_admin_audit` row are all written or
 * none is. Statements are chained with `changes()`, and a final guard row that
 * breaks the ledger's CHECK (amount >= 0) rolls the batch back when any link
 * wrote nothing; the refusal is then explained as a coded error. Ledger
 * `request_id`s are the idempotency anchors (`topup:<tenant>:<key>`,
 * `grant:<subscription>:<period start>`, `expire:<subscription>:<period
 * start>`), unique per (request_id, budget_id, kind).
 *
 * Purchases fund the tenant wallet only; member (`user`) and key budgets the
 * owner allocated are not touched. Usage keeps drawing on the wallet and on
 * those budgets together. There is no automatic overage.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  GATEWAY_BILLING_ADMIN_CREDIT,
  GATEWAY_BILLING_ADMIN_DEBIT,
  GATEWAY_BILLING_MAX_PERIODS_PER_ROLLOVER,
  GATEWAY_BILLING_PAYMENT_REFUND,
  GatewayError,
  assertRefundAmount,
  billingAuditIdentity,
  billingPaymentRef,
  billingPeriod,
  billingRequestIds,
  billingSubscriptionId,
  billingPeriodIndex,
  expiringGrant,
  walletAvailable,
  type GatewayBillingPeriod,
  type GatewayBillingPort,
  type GatewayBillingRateLimit,
  type GatewayClock,
  type GatewayCreditEntryView,
  type GatewayPackageView,
  type GatewayPaymentActor,
  type GatewayPurchaseResult,
  type GatewayRolloverOutcome,
  type GatewaySubscriptionView,
  type GatewayTopupPackView,
  type GatewayWalletView,
} from "@clash/gateway-core";

import { adminAuditStatement, type AuditActor, type GatewayAdminActor } from "./d1-admin-audit";
import { parseJson, toMs, toSeconds } from "./d1-common";

/** A payment provider's verified webhook (#419); shared type (gateway-core billing-port.ts). */
export type PaymentActor = GatewayPaymentActor;

/**
 * The authorized caller (services/gateway-authz.ts): a product user through a
 * team role, or an admin account; or a payment provider's webhook. Ledger
 * `actor_user_id` holds its id (`adm_…` for an admin account, #394;
 * `payment:<provider>` for a payment).
 */
export type BillingActor = GatewayAdminActor | PaymentActor;

/** The audit/ledger identity of an actor; a payment actor is validated first. */
const auditActor = (actor: BillingActor): AuditActor => billingAuditIdentity(actor);
const paymentRef = billingPaymentRef;

/** A stored rate limit (gateway-core GatewayRateLimitSchema). */
export type RateLimitConfig = GatewayBillingRateLimit;
export type PackageView = GatewayPackageView;
export type TopupPackView = GatewayTopupPackView;
export type SubscriptionView = GatewaySubscriptionView;
export type WalletView = GatewayWalletView;
export type CreditEntryView = GatewayCreditEntryView;
export type PurchaseResult<T> = GatewayPurchaseResult<T>;
export type RolloverOutcome = GatewayRolloverOutcome;

interface PackageRow {
  id: string;
  name: string;
  status: string;
  billing_period: string;
  price_minor: number;
  price_currency: string;
  credits_micro: number;
  rate_limit_json: string | null;
  external_price_id: string | null;
  created_at: number;
  updated_at: number;
}

interface TopupPackRow {
  id: string;
  name: string;
  status: string;
  price_minor: number;
  price_currency: string;
  credits_micro: number;
  external_price_id: string | null;
  created_at: number;
  updated_at: number;
}

interface SubscriptionRow {
  id: string;
  tenant_id: string;
  package_id: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  cancel_at: number | null;
  canceled_at: number | null;
  rate_limit_json: string | null;
  created_at: number;
}

interface WalletRow {
  id: string;
  tenant_id: string;
  status: string;
  period: string;
  limit_micro_credits: number | null;
  spent_micro_credits: number;
  reserved_micro_credits: number;
}

interface CreditRow {
  request_id: string;
  kind: CreditEntryView["kind"];
  amount_micro_credits: number;
  ref_kind: string | null;
  ref_id: string | null;
  actor_user_id: string | null;
  occurred_at: number;
}

const iso = (seconds: number) => new Date(toMs(seconds)).toISOString();
const newId = (prefix: string) => `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;

/** Subscriptions that are live: they grant credits and their rate limits apply. */
const LIVE_SUBSCRIPTION = "status IN ('trialing', 'active')";
/** Bounds one rollover call for a subscription many periods behind; the next call continues. */
const MAX_PERIODS_PER_ROLLOVER = GATEWAY_BILLING_MAX_PERIODS_PER_ROLLOVER;

const SUBSCRIPTION_COLUMNS = `id, tenant_id, package_id, status, current_period_start,
  current_period_end, cancel_at, canceled_at, rate_limit_json, created_at`;
const WALLET_COLUMNS = `id, tenant_id, status, period, limit_micro_credits, spent_micro_credits,
  reserved_micro_credits`;
const CREDIT_COLUMNS = `request_id, kind, amount_micro_credits, ref_kind, ref_id, actor_user_id, occurred_at`;

/** The tenant wallet row, as a subquery over ?t (tenant id). */
const walletIdSql = (t: string) =>
  `(SELECT id FROM gateway_budget WHERE tenant_id = ${t} AND scope = 'tenant' AND scope_id = ${t})`;
/** ref_kind of a platform wallet correction: the ledger amount is non-negative, so it carries the direction. */
const ADMIN_CREDIT = GATEWAY_BILLING_ADMIN_CREDIT;
const ADMIN_DEBIT = GATEWAY_BILLING_ADMIN_DEBIT;
/** ref_kind of a provider refund or chargeback: an `adjust` that removes credits (#419). */
const PAYMENT_REFUND = GATEWAY_BILLING_PAYMENT_REFUND;
/** A wallet that can hold credits: limited and not periodic. */
const FUNDABLE = "limit_micro_credits IS NOT NULL AND period = 'none'";

function packageView(row: PackageRow): PackageView {
  return {
    id: row.id,
    name: row.name,
    status: row.status === "archived" ? "archived" : "active",
    billingPeriod: row.billing_period === "year" ? "year" : "month",
    priceMinor: row.price_minor,
    priceCurrency: row.price_currency,
    periodMicroCredits: row.credits_micro,
    rateLimit: (parseJson(row.rate_limit_json) as RateLimitConfig | undefined) ?? null,
    externalPriceId: row.external_price_id ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function topupPackView(row: TopupPackRow): TopupPackView {
  return {
    id: row.id,
    name: row.name,
    status: row.status === "archived" ? "archived" : "active",
    priceMinor: row.price_minor,
    priceCurrency: row.price_currency,
    microCredits: row.credits_micro,
    externalPriceId: row.external_price_id ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function subscriptionView(row: SubscriptionRow): SubscriptionView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    packageId: row.package_id,
    status: row.status,
    currentPeriodStart: iso(row.current_period_start),
    currentPeriodEnd: iso(row.current_period_end),
    cancelAt: row.cancel_at === null ? null : iso(row.cancel_at),
    canceledAt: row.canceled_at === null ? null : iso(row.canceled_at),
    rateLimit: (parseJson(row.rate_limit_json) as RateLimitConfig | undefined) ?? null,
  };
}

function walletView(row: WalletRow): WalletView {
  return {
    budgetId: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    limitMicroCredits: row.limit_micro_credits,
    spentMicroCredits: row.spent_micro_credits,
    reservedMicroCredits: row.reserved_micro_credits,
    availableMicroCredits:
      row.limit_micro_credits === null
        ? null
        : walletAvailable({
            limitMicroCredits: row.limit_micro_credits,
            spentMicroCredits: row.spent_micro_credits,
            reservedMicroCredits: row.reserved_micro_credits,
          }),
  };
}

function creditView(row: CreditRow): CreditEntryView {
  return {
    requestId: row.request_id,
    kind: row.kind,
    amountMicroCredits: row.amount_micro_credits,
    refKind: row.ref_kind,
    refId: row.ref_id,
    actorUserId: row.actor_user_id,
    occurredAt: iso(row.occurred_at),
  };
}

function incompatible(wallet: WalletRow): GatewayError {
  return new GatewayError("GATEWAY_WALLET_INCOMPATIBLE", {
    details: {
      budgetId: wallet.id,
      reason: wallet.limit_micro_credits === null ? "unlimited" : "periodic",
    },
  });
}

export function createD1Billing(db: D1Database, deps: { clock: GatewayClock }) {
  const nowSeconds = () => toSeconds(deps.clock.now());

  async function packageRow(id: string): Promise<PackageRow | null> {
    return db.prepare(`SELECT * FROM gateway_package WHERE id = ?`).bind(id).first<PackageRow>();
  }
  async function topupPackRow(id: string): Promise<TopupPackRow | null> {
    return db.prepare(`SELECT * FROM gateway_topup_pack WHERE id = ?`).bind(id).first<TopupPackRow>();
  }
  async function walletRow(tenantId: string): Promise<WalletRow | null> {
    return db
      .prepare(`SELECT ${WALLET_COLUMNS} FROM gateway_budget WHERE tenant_id = ?1 AND scope = 'tenant' AND scope_id = ?1`)
      .bind(tenantId)
      .first<WalletRow>();
  }
  async function liveSubscription(tenantId: string): Promise<SubscriptionRow | null> {
    return db
      .prepare(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM gateway_tenant_subscription
          WHERE tenant_id = ? AND ${LIVE_SUBSCRIPTION} ORDER BY current_period_end DESC LIMIT 1`,
      )
      .bind(tenantId)
      .first<SubscriptionRow>();
  }
  async function creditEntry(requestId: string, kind: CreditEntryView["kind"]): Promise<CreditRow | null> {
    return db
      .prepare(`SELECT ${CREDIT_COLUMNS} FROM gateway_usage_ledger WHERE request_id = ? AND kind = ? LIMIT 1`)
      .bind(requestId, kind)
      .first<CreditRow>();
  }
  async function requireTenant(tenantId: string): Promise<void> {
    const tenant = await db.prepare(`SELECT 1 AS found FROM tenant WHERE id = ?`).bind(tenantId).first();
    if (!tenant)
      throw new GatewayError("GATEWAY_TENANT_NOT_FOUND", {
        details: { tenantId },
      });
  }
  /** Fails before any write when the existing wallet cannot hold credits; a missing one is created at 0. */
  async function requireFundableWallet(tenantId: string): Promise<void> {
    const wallet = await walletRow(tenantId);
    if (wallet && (wallet.limit_micro_credits === null || wallet.period !== "none")) throw incompatible(wallet);
  }

  function audit(input: {
    tenantId: string;
    actor: BillingActor;
    action: string;
    targetType: string;
    targetId: string;
    before?: unknown;
    after: unknown;
    reason?: string | null;
    nowS: number;
    when: string;
  }): D1PreparedStatement {
    return adminAuditStatement(db, {
      ...input,
      actor: auditActor(input.actor),
    });
  }

  /** Creates the tenant wallet at a zero limit when it does not exist yet. */
  const ensureWallet = (tenantId: string, nowS: number) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO gateway_budget
           (id, tenant_id, scope, scope_id, period, limit_micro_credits, created_at, updated_at)
         VALUES (?1, ?2, 'tenant', ?2, 'none', 0, ?3, ?3)`,
      )
      .bind(newId("gwb_w_"), tenantId, nowS);

  /** Appends one credit entry on the wallet when `when` holds (chained on changes()). */
  const creditEntryStatement = (input: {
    requestId: string;
    kind: CreditEntryView["kind"];
    tenantId: string;
    amount: number;
    refKind: string;
    refId: string;
    actorUserId: string | null;
    reason?: string | null;
    nowS: number;
    when: string;
  }) =>
    db
      .prepare(
        `INSERT INTO gateway_usage_ledger
           (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits,
            ref_kind, ref_id, actor_user_id, occurred_at, reason)
         SELECT ?1 || ':' || ?2 || ':' || w.id, ?1, w.id, ?2, 'posted', ?3, ?4, ?5, ?6, ?7, ?8, ?9
           FROM gateway_budget w
          WHERE w.tenant_id = ?3 AND w.scope = 'tenant' AND w.scope_id = ?3 AND ${input.when}`,
      )
      .bind(
        input.requestId,
        input.kind,
        input.tenantId,
        input.amount,
        input.refKind,
        input.refId,
        input.actorUserId,
        input.nowS,
        input.reason ?? null,
      );

  /**
   * limit += delta on a fundable wallet, chained on the previous write. A
   * removal (negative delta) never takes the limit below spend + open holds.
   */
  const moveWalletLimit = (tenantId: string, delta: number, nowS: number) =>
    db
      .prepare(
        `UPDATE gateway_budget
            SET limit_micro_credits = limit_micro_credits + ?2, version = version + 1, updated_at = ?3
          WHERE id = ${walletIdSql("?1")} AND ${FUNDABLE} AND changes() = 1
            AND (?2 >= 0 OR limit_micro_credits + ?2 >= spent_micro_credits + reserved_micro_credits)`,
      )
      .bind(tenantId, delta, nowS);

  /** Rolls the whole batch back unless the previous statement wrote a row. */
  const requirePreviousWrite = (requestId: string, tenantId: string, nowS: number) =>
    db
      .prepare(
        `INSERT INTO gateway_usage_ledger
           (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits, occurred_at)
         SELECT ?1 || ':refused', ?1, '', 'adjust', 'refused', ?2, -1, ?3 WHERE changes() = 0`,
      )
      .bind(requestId, tenantId, nowS);

  async function walletOrThrow(tenantId: string): Promise<WalletView> {
    const wallet = await walletRow(tenantId);
    if (!wallet)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The tenant wallet is missing after a purchase.",
      });
    return walletView(wallet);
  }

  // ─── Packages and top-up packs (platform admin) ────────────────────────

  async function listPackages(): Promise<PackageView[]> {
    const { results } = await db
      .prepare(`SELECT * FROM gateway_package ORDER BY status = 'archived', created_at DESC, id`)
      .all<PackageRow>();
    return results.map(packageView);
  }

  async function createPackage(
    input: {
      name: string;
      billingPeriod: GatewayBillingPeriod;
      priceMinor: number;
      priceCurrency: string;
      periodMicroCredits: number;
      rateLimit?: RateLimitConfig;
      externalPriceId?: string | null;
    },
    actor: BillingActor,
  ): Promise<PackageView> {
    const id = newId("gwpkg_");
    const nowS = nowSeconds();
    await externalPriceInsert(() => db.batch([
      db
        .prepare(
          `INSERT INTO gateway_package
             (id, name, status, billing_period, price_minor, price_currency, credits_micro,
              rate_limit_json, external_price_id, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          input.name,
          input.billingPeriod,
          input.priceMinor,
          input.priceCurrency,
          input.periodMicroCredits,
          input.rateLimit ? JSON.stringify(input.rateLimit) : null,
          input.externalPriceId ?? null,
          nowS,
          nowS,
        ),
      audit({ tenantId: "", actor, action: "package.create", targetType: "package", targetId: id, after: input, nowS, when: "1" }),
    ]), input.externalPriceId);
    const row = await packageRow(id);
    if (!row)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The created package is missing.",
      });
    return packageView(row);
  }

  /** Archive: no new subscriptions; live subscriptions keep renewing. Archiving twice is a no-op. */
  async function archivePackage(id: string, actor: BillingActor): Promise<PackageView> {
    const before = await packageRow(id);
    if (!before)
      throw new GatewayError("GATEWAY_PACKAGE_NOT_FOUND", {
        details: { packageId: id },
      });
    if (before.status !== "archived") {
      const nowS = nowSeconds();
      await db.batch([
        db
          .prepare(`UPDATE gateway_package SET status = 'archived', updated_at = ? WHERE id = ? AND status <> 'archived'`)
          .bind(nowS, id),
        audit({
          tenantId: "",
          actor,
          action: "package.archive",
          targetType: "package",
          targetId: id,
          before: { status: before.status },
          after: { status: "archived" },
          nowS,
          when: "changes() = 1",
        }),
      ]);
    }
    const row = await packageRow(id);
    if (!row)
      throw new GatewayError("GATEWAY_PACKAGE_NOT_FOUND", {
        details: { packageId: id },
      });
    return packageView(row);
  }

  async function listTopupPacks(): Promise<TopupPackView[]> {
    const { results } = await db
      .prepare(`SELECT * FROM gateway_topup_pack ORDER BY status = 'archived', created_at DESC, id`)
      .all<TopupPackRow>();
    return results.map(topupPackView);
  }

  async function createTopupPack(
    input: { name: string; priceMinor: number; priceCurrency: string; microCredits: number; externalPriceId?: string | null },
    actor: BillingActor,
  ): Promise<TopupPackView> {
    const id = newId("gwpack_");
    const nowS = nowSeconds();
    await externalPriceInsert(() => db.batch([
      db
        .prepare(
          `INSERT INTO gateway_topup_pack
             (id, name, status, price_minor, price_currency, credits_micro, validity_days, external_price_id,
              created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .bind(id, input.name, input.priceMinor, input.priceCurrency, input.microCredits, input.externalPriceId ?? null, nowS, nowS),
      audit({ tenantId: "", actor, action: "topup_pack.create", targetType: "topup_pack", targetId: id, after: input, nowS, when: "1" }),
    ]), input.externalPriceId);
    const row = await topupPackRow(id);
    if (!row)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The created top-up pack is missing.",
      });
    return topupPackView(row);
  }

  async function archiveTopupPack(id: string, actor: BillingActor): Promise<TopupPackView> {
    const before = await topupPackRow(id);
    if (!before)
      throw new GatewayError("GATEWAY_TOPUP_PACK_NOT_FOUND", {
        details: { packId: id },
      });
    if (before.status !== "archived") {
      const nowS = nowSeconds();
      await db.batch([
        db
          .prepare(`UPDATE gateway_topup_pack SET status = 'archived', updated_at = ? WHERE id = ? AND status <> 'archived'`)
          .bind(nowS, id),
        audit({
          tenantId: "",
          actor,
          action: "topup_pack.archive",
          targetType: "topup_pack",
          targetId: id,
          before: { status: before.status },
          after: { status: "archived" },
          nowS,
          when: "changes() = 1",
        }),
      ]);
    }
    const row = await topupPackRow(id);
    if (!row)
      throw new GatewayError("GATEWAY_TOPUP_PACK_NOT_FOUND", {
        details: { packId: id },
      });
    return topupPackView(row);
  }

  /** Runs a write that may set an external price id; a duplicate id is GATEWAY_EXTERNAL_PRICE_ID_TAKEN. */
  async function externalPriceInsert<T>(write: () => Promise<T>, externalPriceId: string | null | undefined): Promise<T> {
    try {
      return await write();
    } catch (cause) {
      if (externalPriceId && /UNIQUE constraint failed: .*external_price_id/i.test(String((cause as Error)?.message ?? cause)))
        throw new GatewayError("GATEWAY_EXTERNAL_PRICE_ID_TAKEN", {
          details: { externalPriceId },
          cause,
        });
      throw cause;
    }
  }

  /** Set or clear (null) the provider price id of a package or pack; same value twice is a no-op. */
  async function setExternalPriceId(
    table: "gateway_package" | "gateway_topup_pack",
    id: string,
    externalPriceId: string | null,
    actor: BillingActor,
  ): Promise<void> {
    const isPackage = table === "gateway_package";
    const before = isPackage ? await packageRow(id) : await topupPackRow(id);
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
    await externalPriceInsert(
      () =>
        db.batch([
          db
            .prepare(`UPDATE ${table} SET external_price_id = ?2, updated_at = ?3 WHERE id = ?1 AND external_price_id IS ?4`)
            .bind(id, externalPriceId, nowS, before.external_price_id ?? null),
          audit({
            tenantId: "",
            actor,
            action: isPackage ? "package.external_price" : "topup_pack.external_price",
            targetType: isPackage ? "package" : "topup_pack",
            targetId: id,
            before: { externalPriceId: before.external_price_id ?? null },
            after: { externalPriceId },
            nowS,
            when: "changes() = 1",
          }),
        ]),
      externalPriceId,
    );
  }

  async function setPackageExternalPriceId(id: string, externalPriceId: string | null, actor: BillingActor): Promise<PackageView> {
    await setExternalPriceId("gateway_package", id, externalPriceId, actor);
    const row = await packageRow(id);
    if (!row)
      throw new GatewayError("GATEWAY_PACKAGE_NOT_FOUND", {
        details: { packageId: id },
      });
    return packageView(row);
  }

  async function setTopupPackExternalPriceId(id: string, externalPriceId: string | null, actor: BillingActor): Promise<TopupPackView> {
    await setExternalPriceId("gateway_topup_pack", id, externalPriceId, actor);
    const row = await topupPackRow(id);
    if (!row)
      throw new GatewayError("GATEWAY_TOPUP_PACK_NOT_FOUND", {
        details: { packId: id },
      });
    return topupPackView(row);
  }

  /** The package a provider price id is configured on (a payments plugin resolving a webhook), or null. */
  async function packageByExternalPriceId(externalPriceId: string): Promise<PackageView | null> {
    const row = await db.prepare(`SELECT * FROM gateway_package WHERE external_price_id = ?`).bind(externalPriceId).first<PackageRow>();
    return row ? packageView(row) : null;
  }

  /** The top-up pack a provider price id is configured on, or null. */
  async function topupPackByExternalPriceId(externalPriceId: string): Promise<TopupPackView | null> {
    const row = await db.prepare(`SELECT * FROM gateway_topup_pack WHERE external_price_id = ?`).bind(externalPriceId).first<TopupPackRow>();
    return row ? topupPackView(row) : null;
  }

  // ─── Purchases (platform admin, tenant owner, or payment webhook) ──────

  async function topup(input: {
    tenantId: string;
    packId: string;
    idempotencyKey: string;
    actor: BillingActor;
  }): Promise<PurchaseResult<never>> {
    auditActor(input.actor);
    const requestId = billingRequestIds.topup(input.tenantId, input.idempotencyKey);
    const replay = async (): Promise<PurchaseResult<never> | null> => {
      const prior = await creditEntry(requestId, "topup");
      if (!prior) return null;
      if (prior.ref_id !== input.packId)
        throw new GatewayError("GATEWAY_IDEMPOTENCY_CONFLICT", {
          details: { idempotencyKey: input.idempotencyKey },
        });
      return {
        replayed: true,
        entry: creditView(prior),
        wallet: await walletOrThrow(input.tenantId),
      };
    };
    await requireTenant(input.tenantId);
    const prior = await replay();
    if (prior) return prior;
    const pack = await topupPackRow(input.packId);
    if (!pack)
      throw new GatewayError("GATEWAY_TOPUP_PACK_NOT_FOUND", {
        details: { packId: input.packId },
      });
    if (pack.status !== "active")
      throw new GatewayError("GATEWAY_TOPUP_PACK_ARCHIVED", {
        details: { packId: input.packId },
      });
    await requireFundableWallet(input.tenantId);
    const nowS = nowSeconds();
    try {
      await db.batch([
        ensureWallet(input.tenantId, nowS),
        creditEntryStatement({
          requestId,
          kind: "topup",
          tenantId: input.tenantId,
          amount: pack.credits_micro,
          refKind: "topup_pack",
          refId: pack.id,
          actorUserId: auditActor(input.actor).id,
          nowS,
          when: `w.limit_micro_credits IS NOT NULL AND w.period = 'none'
            AND EXISTS (SELECT 1 FROM gateway_topup_pack WHERE id = ?6 AND status = 'active')
            AND NOT EXISTS (SELECT 1 FROM gateway_usage_ledger WHERE request_id = ?1 AND kind = 'topup')`,
        }),
        moveWalletLimit(input.tenantId, pack.credits_micro, nowS),
        audit({
          tenantId: input.tenantId,
          actor: input.actor,
          action: "wallet.topup",
          targetType: "topup",
          targetId: requestId,
          after: {
            packId: pack.id,
            microCredits: pack.credits_micro,
            ...paymentRef(input.actor),
          },
          nowS,
          when: "changes() = 1",
        }),
        requirePreviousWrite(requestId, input.tenantId, nowS),
      ]);
    } catch (cause) {
      const raced = await replay();
      if (raced) return raced;
      const now = await topupPackRow(input.packId);
      if (now?.status !== "active")
        throw new GatewayError("GATEWAY_TOPUP_PACK_ARCHIVED", {
          details: { packId: input.packId },
        });
      await requireFundableWallet(input.tenantId);
      throw new GatewayError("GATEWAY_CONFLICT", {
        details: { tenantId: input.tenantId },
        cause,
      });
    }
    const entry = await creditEntry(requestId, "topup");
    if (!entry)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The top-up entry is missing.",
      });
    return {
      replayed: false,
      entry: creditView(entry),
      wallet: await walletOrThrow(input.tenantId),
    };
  }

  /** One live subscription per tenant; its first period's credits are granted in the same batch. */
  async function subscribe(input: {
    tenantId: string;
    packageId: string;
    idempotencyKey: string;
    actor: BillingActor;
  }): Promise<PurchaseResult<SubscriptionView>> {
    auditActor(input.actor);
    const subscriptionId = await billingSubscriptionId(input.tenantId, input.idempotencyKey);
    const replay = async (): Promise<PurchaseResult<SubscriptionView> | null> => {
      const prior = await db
        .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM gateway_tenant_subscription WHERE id = ?`)
        .bind(subscriptionId)
        .first<SubscriptionRow>();
      if (!prior) return null;
      if (prior.package_id !== input.packageId)
        throw new GatewayError("GATEWAY_IDEMPOTENCY_CONFLICT", {
          details: { idempotencyKey: input.idempotencyKey },
        });
      const grant = await creditEntry(billingRequestIds.grant(prior.id, prior.created_at), "grant");
      if (!grant)
        throw new GatewayError("GATEWAY_INTERNAL", {
          message: "The first subscription grant is missing.",
        });
      return {
        replayed: true,
        entry: creditView(grant),
        wallet: await walletOrThrow(input.tenantId),
        subscription: subscriptionView(prior),
      };
    };
    await requireTenant(input.tenantId);
    const prior = await replay();
    if (prior) return prior;
    const pkg = await packageRow(input.packageId);
    if (!pkg) throw new GatewayError("GATEWAY_PACKAGE_NOT_FOUND", { details: { packageId: input.packageId } });
    if (pkg.status !== "active")
      throw new GatewayError("GATEWAY_PACKAGE_ARCHIVED", { details: { packageId: input.packageId } });
    const live = await liveSubscription(input.tenantId);
    if (live)
      throw new GatewayError("GATEWAY_SUBSCRIPTION_EXISTS", { details: { subscriptionId: live.id } });
    await requireFundableWallet(input.tenantId);

    const nowS = nowSeconds();
    const period = billingPeriod(toMs(nowS), packageView(pkg).billingPeriod, 0);
    const endS = toSeconds(period.end);
    const grantId = billingRequestIds.grant(subscriptionId, nowS);
    try {
      await db.batch([
        ensureWallet(input.tenantId, nowS),
        db
          .prepare(
            // created_at is the period anchor: period n starts n periods after it.
            `INSERT INTO gateway_tenant_subscription
               (id, tenant_id, package_id, status, current_period_start, current_period_end,
                rate_limit_json, created_at, updated_at)
             SELECT ?1, ?2, p.id, 'active', ?3, ?4, p.rate_limit_json, ?3, ?3
               FROM gateway_package p
              WHERE p.id = ?5 AND p.status = 'active'
                AND NOT EXISTS (SELECT 1 FROM gateway_tenant_subscription
                                 WHERE tenant_id = ?2 AND ${LIVE_SUBSCRIPTION})
                AND EXISTS (SELECT 1 FROM gateway_budget
                             WHERE id = ${walletIdSql("?2")} AND ${FUNDABLE})`,
          )
          .bind(subscriptionId, input.tenantId, nowS, endS, pkg.id),
        creditEntryStatement({
          requestId: grantId,
          kind: "grant",
          tenantId: input.tenantId,
          amount: pkg.credits_micro,
          refKind: "subscription",
          refId: subscriptionId,
          actorUserId: auditActor(input.actor).id,
          nowS,
          when: "changes() = 1",
        }),
        moveWalletLimit(input.tenantId, pkg.credits_micro, nowS),
        audit({
          tenantId: input.tenantId,
          actor: input.actor,
          action: "subscription.create",
          targetType: "subscription",
          targetId: subscriptionId,
          after: {
            packageId: pkg.id,
            periodStart: nowS,
            periodEnd: endS,
            grantMicroCredits: pkg.credits_micro,
            ...paymentRef(input.actor),
          },
          nowS,
          when: "changes() = 1",
        }),
        requirePreviousWrite(grantId, input.tenantId, nowS),
      ]);
    } catch (cause) {
      const raced = await replay();
      if (raced) return raced;
      const nowPkg = await packageRow(input.packageId);
      if (nowPkg?.status !== "active")
        throw new GatewayError("GATEWAY_PACKAGE_ARCHIVED", { details: { packageId: input.packageId } });
      const nowLive = await liveSubscription(input.tenantId);
      if (nowLive)
        throw new GatewayError("GATEWAY_SUBSCRIPTION_EXISTS", { details: { subscriptionId: nowLive.id } });
      await requireFundableWallet(input.tenantId);
      throw new GatewayError("GATEWAY_CONFLICT", { details: { tenantId: input.tenantId }, cause });
    }
    const result = await replay();
    if (!result) throw new GatewayError("GATEWAY_INTERNAL", { message: "The created subscription is missing." });
    return { ...result, replayed: false };
  }

  /** Ends the live subscription at its current period end. Canceling twice is a no-op. */
  async function cancelSubscription(input: { tenantId: string; actor: BillingActor }): Promise<SubscriptionView> {
    auditActor(input.actor);
    await requireTenant(input.tenantId);
    const live = await liveSubscription(input.tenantId);
    if (!live)
      throw new GatewayError("GATEWAY_SUBSCRIPTION_NOT_FOUND", {
        details: { tenantId: input.tenantId },
      });
    if (live.cancel_at === null) {
      const nowS = nowSeconds();
      await db.batch([
        db
          .prepare(
            `UPDATE gateway_tenant_subscription
                SET cancel_at = current_period_end, canceled_at = ?2, updated_at = ?2
              WHERE id = ?1 AND ${LIVE_SUBSCRIPTION} AND cancel_at IS NULL`,
          )
          .bind(live.id, nowS),
        audit({
          tenantId: input.tenantId,
          actor: input.actor,
          action: "subscription.cancel",
          targetType: "subscription",
          targetId: live.id,
          after: {
            cancelAt: live.current_period_end,
            ...paymentRef(input.actor),
          },
          nowS,
          when: "changes() = 1",
        }),
      ]);
    }
    const row = await db
      .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM gateway_tenant_subscription WHERE id = ?`)
      .bind(live.id)
      .first<SubscriptionRow>();
    if (!row)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The subscription is missing.",
      });
    return subscriptionView(row);
  }

  // ─── Period close (platform admin; idempotent, no background state) ────

  /** Close one ended period of `sub`: expire the unused grant, then grant the next period or end. */
  async function closePeriod(
    sub: SubscriptionRow,
    actor: BillingActor,
    nowS: number,
  ): Promise<{ expired: number; granted: number; status: string }> {
    const pkg = await packageRow(sub.package_id);
    if (!pkg)
      throw new GatewayError("GATEWAY_PACKAGE_NOT_FOUND", {
        details: { packageId: sub.package_id },
      });
    const wallet = await walletRow(sub.tenant_id);
    if (!wallet)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The subscribed tenant has no wallet.",
      });
    if (wallet.limit_micro_credits === null || wallet.period !== "none") throw incompatible(wallet);

    const startS = sub.current_period_start;
    const endS = sub.current_period_end;
    const [grantRow, spentRow] = await db.batch([
      db
        .prepare(`SELECT amount_micro_credits FROM gateway_usage_ledger WHERE request_id = ? AND kind = 'grant' LIMIT 1`)
        .bind(billingRequestIds.grant(sub.id, startS)),
      db
        .prepare(
          `SELECT COALESCE(SUM(CASE kind WHEN 'settle' THEN amount_micro_credits ELSE -amount_micro_credits END), 0) AS spent
             FROM gateway_usage_ledger
            WHERE budget_id = ?1 AND kind IN ('settle', 'refund') AND occurred_at >= ?2 AND occurred_at < ?3`,
        )
        .bind(wallet.id, startS, endS),
    ]);
    const granted = (grantRow?.results?.[0] as { amount_micro_credits: number } | undefined)?.amount_micro_credits ?? 0;
    const spent = Math.max(0, (spentRow?.results?.[0] as { spent: number } | undefined)?.spent ?? 0);
    const expired = expiringGrant({
      grantedMicroCredits: granted,
      spentInPeriodMicroCredits: spent,
      availableMicroCredits: walletAvailable({
        limitMicroCredits: wallet.limit_micro_credits,
        spentMicroCredits: wallet.spent_micro_credits,
        reservedMicroCredits: wallet.reserved_micro_credits,
      }),
    });
    const ends = sub.cancel_at !== null && sub.cancel_at <= endS;
    // Periods are contiguous: the next one starts where this one ended and
    // ends on the anchor's calendar (created_at is the anchor).
    const cadence = packageView(pkg).billingPeriod;
    const anchorMs = toMs(sub.created_at);
    const nextStartS = endS;
    const nextEndS = toSeconds(billingPeriod(anchorMs, cadence, billingPeriodIndex(anchorMs, cadence, toMs(endS))).end);
    const grantNext = ends ? 0 : pkg.credits_micro;
    const expireId = billingRequestIds.expire(sub.id, startS);

    const statements: D1PreparedStatement[] = [
      ends
        ? db
            .prepare(
              `UPDATE gateway_tenant_subscription SET status = 'expired', updated_at = ?3
                WHERE id = ?1 AND current_period_start = ?2 AND ${LIVE_SUBSCRIPTION}`,
            )
            .bind(sub.id, startS, nowS)
        : db
            .prepare(
              `UPDATE gateway_tenant_subscription
                  SET current_period_start = ?3, current_period_end = ?4, updated_at = ?5
                WHERE id = ?1 AND current_period_start = ?2 AND ${LIVE_SUBSCRIPTION}`,
            )
            .bind(sub.id, startS, nextStartS, nextEndS, nowS),
      creditEntryStatement({
        requestId: expireId,
        kind: "expire",
        tenantId: sub.tenant_id,
        amount: expired,
        refKind: "subscription",
        refId: sub.id,
        actorUserId: auditActor(actor).id,
        nowS,
        when: "changes() = 1",
      }),
      moveWalletLimit(sub.tenant_id, -expired, nowS),
    ];
    if (!ends)
      statements.push(
        creditEntryStatement({
          requestId: billingRequestIds.grant(sub.id, nextStartS),
          kind: "grant",
          tenantId: sub.tenant_id,
          amount: grantNext,
          refKind: "subscription",
          refId: sub.id,
          actorUserId: auditActor(actor).id,
          nowS,
          when: "changes() = 1",
        }),
        moveWalletLimit(sub.tenant_id, grantNext, nowS),
      );
    statements.push(
      audit({
        tenantId: sub.tenant_id,
        actor,
        action: ends ? "subscription.end" : "subscription.renew",
        targetType: "subscription",
        targetId: sub.id,
        before: { periodStart: startS, periodEnd: endS },
        after: ends
          ? { status: "expired", expiredMicroCredits: expired }
          : { periodStart: nextStartS, periodEnd: nextEndS, expiredMicroCredits: expired, grantMicroCredits: grantNext },
        nowS,
        when: "changes() = 1",
      }),
      requirePreviousWrite(expireId, sub.tenant_id, nowS),
    );
    await db.batch(statements);
    return { expired, granted: grantNext, status: ends ? "expired" : "active" };
  }

  /**
   * Close every ended period of live subscriptions (optionally of one tenant)
   * as of now. Idempotent: a closed period is never closed again (the
   * subscription's period start is the compare-and-set), so a repeated or
   * concurrent call does nothing more. Each period close is atomic; a failed
   * one is reported with its code and retried by the next call.
   */
  async function rollover(input: { tenantId?: string; actor: BillingActor }): Promise<RolloverOutcome[]> {
    const nowS = nowSeconds();
    if (input.tenantId !== undefined) await requireTenant(input.tenantId);
    const { results: due } = await db
      .prepare(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM gateway_tenant_subscription
          WHERE ${LIVE_SUBSCRIPTION} AND current_period_end <= ?1 AND (?2 IS NULL OR tenant_id = ?2)
          ORDER BY current_period_end, id`,
      )
      .bind(nowS, input.tenantId ?? null)
      .all<SubscriptionRow>();
    const outcomes: RolloverOutcome[] = [];
    for (const first of due) {
      const outcome: RolloverOutcome = {
        subscriptionId: first.id,
        tenantId: first.tenant_id,
        periodsClosed: 0,
        expiredMicroCredits: 0,
        grantedMicroCredits: 0,
        status: first.status,
      };
      let sub: SubscriptionRow | null = first;
      while (sub && sub.current_period_end <= nowS && outcome.periodsClosed < MAX_PERIODS_PER_ROLLOVER) {
        try {
          const closed = await closePeriod(sub, input.actor, nowS);
          outcome.periodsClosed += 1;
          outcome.expiredMicroCredits += closed.expired;
          outcome.grantedMicroCredits += closed.granted;
          outcome.status = closed.status;
        } catch (cause) {
          const current: SubscriptionRow | null = await db
            .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM gateway_tenant_subscription WHERE id = ?`)
            .bind(sub.id)
            .first<SubscriptionRow>();
          // Another call closed this period first: continue from its state.
          if (current && (current.current_period_start !== sub.current_period_start || current.status !== sub.status)) {
            outcome.status = current.status;
            if (current.status !== "active" && current.status !== "trialing") break;
            sub = current;
            continue;
          }
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
        sub = await db
          .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM gateway_tenant_subscription WHERE id = ? AND ${LIVE_SUBSCRIPTION}`)
          .bind(first.id)
          .first<SubscriptionRow>();
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /** The tenant wallet, its live subscription and its newest credit entries. */
  async function walletSummary(tenantId: string, limit = 50) {
    await requireTenant(tenantId);
    const [wallet, subscription, entries] = await Promise.all([
      walletRow(tenantId),
      liveSubscription(tenantId),
      db
        .prepare(
          `SELECT ${CREDIT_COLUMNS} FROM gateway_usage_ledger
            WHERE tenant_id = ? AND (kind IN ('grant', 'topup', 'expire')
                  OR (kind = 'adjust' AND ref_kind IN ('${ADMIN_CREDIT}', '${ADMIN_DEBIT}', '${PAYMENT_REFUND}')))
            ORDER BY occurred_at DESC, request_id DESC LIMIT ?`,
        )
        .bind(tenantId, limit)
        .all<CreditRow>(),
    ]);
    return {
      wallet: wallet ? walletView(wallet) : null,
      subscription: subscription ? subscriptionView(subscription) : null,
      entries: entries.results.map(creditView),
    };
  }

  // ─── Platform corrections and overrides (platform admin) ───────────────

  /**
   * Credit correction on the tenant wallet: limit += delta, as a ledger
   * `adjust` entry (amount |delta|; ref_kind `admin_credit` or `admin_debit`
   * gives the direction) carrying the operator's reason, plus the audit row,
   * in one batch. A debit never takes the wallet below spend + open holds
   * (GATEWAY_BUDGET_BELOW_USAGE). One idempotency key is one correction.
   */
  async function adjustWallet(input: {
    tenantId: string;
    deltaMicroCredits: number;
    reason: string;
    idempotencyKey: string;
    actor: BillingActor;
  }): Promise<PurchaseResult<never>> {
    return adjustment({
      ...input,
      requestId: billingRequestIds.adjust(input.tenantId, input.idempotencyKey),
      refKind: input.deltaMicroCredits >= 0 ? ADMIN_CREDIT : ADMIN_DEBIT,
      refId: input.tenantId,
      action: "wallet.adjust",
    });
  }

  /**
   * A provider refund or chargeback (#419): removes `microCredits` from the
   * tenant wallet as a ledger `adjust` entry (ref_kind `payment_refund`,
   * request id `refund:<tenant>:<key>`, unique on (request_id, kind)), with
   * the audit row naming provider and event id. One idempotency key (use the
   * provider's refund id) is one refund: a redelivered webhook replays it, the
   * same key with another amount or ref is GATEWAY_IDEMPOTENCY_CONFLICT. Like
   * an admin debit it never takes the wallet below spend + open holds
   * (GATEWAY_BUDGET_BELOW_USAGE: credits already used are not clawed back; the
   * plugin decides, e.g. suspend the wallet with setWalletStatus).
   */
  async function refund(input: {
    tenantId: string;
    microCredits: number;
    idempotencyKey: string;
    /** What was refunded, e.g. the provider order id; default the tenant id. */
    refId?: string;
    reason?: string;
    actor: PaymentActor;
  }): Promise<PurchaseResult<never>> {
    assertRefundAmount(input.microCredits);
    return adjustment({
      tenantId: input.tenantId,
      deltaMicroCredits: -input.microCredits,
      reason: input.reason ?? `${input.actor.provider} refund`,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      requestId: billingRequestIds.refund(input.tenantId, input.idempotencyKey),
      refKind: PAYMENT_REFUND,
      refId: input.refId ?? input.tenantId,
      action: "wallet.refund",
    });
  }

  async function adjustment(input: {
    tenantId: string;
    deltaMicroCredits: number;
    reason: string;
    idempotencyKey: string;
    actor: BillingActor;
    requestId: string;
    refKind: string;
    refId: string;
    action: string;
  }): Promise<PurchaseResult<never>> {
    auditActor(input.actor);
    const { requestId, refKind } = input;
    const amount = Math.abs(input.deltaMicroCredits);
    const replay = async (): Promise<PurchaseResult<never> | null> => {
      const prior = await creditEntry(requestId, "adjust");
      if (!prior) return null;
      if (prior.ref_kind !== refKind || prior.amount_micro_credits !== amount || prior.ref_id !== input.refId)
        throw new GatewayError("GATEWAY_IDEMPOTENCY_CONFLICT", {
          details: { idempotencyKey: input.idempotencyKey },
        });
      return {
        replayed: true,
        entry: creditView(prior),
        wallet: await walletOrThrow(input.tenantId),
      };
    };
    const requireCover = async () => {
      if (input.deltaMicroCredits >= 0) return;
      const wallet = await walletRow(input.tenantId);
      const limit = wallet?.limit_micro_credits ?? 0;
      const used = (wallet?.spent_micro_credits ?? 0) + (wallet?.reserved_micro_credits ?? 0);
      if (limit - amount < used)
        throw new GatewayError("GATEWAY_BUDGET_BELOW_USAGE", {
          details: {
            tenantId: input.tenantId,
            ...(wallet ? { budgetId: wallet.id } : {}),
          },
        });
    };
    await requireTenant(input.tenantId);
    const prior = await replay();
    if (prior) return prior;
    await requireFundableWallet(input.tenantId);
    await requireCover();
    const nowS = nowSeconds();
    try {
      await db.batch([
        ensureWallet(input.tenantId, nowS),
        creditEntryStatement({
          requestId,
          kind: "adjust",
          tenantId: input.tenantId,
          amount,
          refKind,
          refId: input.refId,
          actorUserId: auditActor(input.actor).id,
          reason: input.reason,
          nowS,
          when: `w.limit_micro_credits IS NOT NULL AND w.period = 'none'
            AND NOT EXISTS (SELECT 1 FROM gateway_usage_ledger WHERE request_id = ?1 AND kind = 'adjust')`,
        }),
        moveWalletLimit(input.tenantId, input.deltaMicroCredits, nowS),
        audit({
          tenantId: input.tenantId,
          actor: input.actor,
          action: input.action,
          targetType: "wallet",
          targetId: requestId,
          after: {
            deltaMicroCredits: input.deltaMicroCredits,
            ...paymentRef(input.actor),
          },
          reason: input.reason,
          nowS,
          when: "changes() = 1",
        }),
        requirePreviousWrite(requestId, input.tenantId, nowS),
      ]);
    } catch (cause) {
      const raced = await replay();
      if (raced) return raced;
      await requireFundableWallet(input.tenantId);
      await requireCover();
      throw new GatewayError("GATEWAY_CONFLICT", {
        details: { tenantId: input.tenantId },
        cause,
      });
    }
    const entry = await creditEntry(requestId, "adjust");
    if (!entry)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The adjustment entry is missing.",
      });
    return {
      replayed: false,
      entry: creditView(entry),
      wallet: await walletOrThrow(input.tenantId),
    };
  }

  /** Suspend or reactivate the tenant wallet: a suspended wallet admits no request. */
  async function setWalletStatus(input: {
    tenantId: string;
    status: "active" | "suspended";
    reason: string;
    actor: BillingActor;
  }): Promise<WalletView> {
    await requireTenant(input.tenantId);
    const before = await walletRow(input.tenantId);
    if (!before) throw new GatewayError("GATEWAY_BUDGET_NOT_FOUND", { details: { tenantId: input.tenantId, scope: "tenant" } });
    if (before.status !== input.status) {
      const nowS = nowSeconds();
      const [updated] = await db.batch([
        db
          .prepare(
            `UPDATE gateway_budget SET status = ?2, version = version + 1, updated_at = ?3
              WHERE id = ?1 AND status = ?4`,
          )
          .bind(before.id, input.status, nowS, before.status),
        audit({
          tenantId: input.tenantId,
          actor: input.actor,
          action: "wallet.status",
          targetType: "budget",
          targetId: before.id,
          before: { status: before.status },
          after: { status: input.status },
          reason: input.reason,
          nowS,
          when: "changes() = 1",
        }),
      ]);
      if (!updated?.meta.changes)
        throw new GatewayError("GATEWAY_CONFLICT", {
          details: { budgetId: before.id },
        });
    }
    return walletOrThrow(input.tenantId);
  }

  /** Override the live subscription's tenant rate limits; null restores no tenant limit. */
  async function setSubscriptionRateLimit(input: {
    tenantId: string;
    rateLimit: RateLimitConfig | null;
    reason?: string;
    actor: BillingActor;
  }): Promise<SubscriptionView> {
    await requireTenant(input.tenantId);
    const live = await liveSubscription(input.tenantId);
    if (!live)
      throw new GatewayError("GATEWAY_SUBSCRIPTION_NOT_FOUND", {
        details: { tenantId: input.tenantId },
      });
    const nowS = nowSeconds();
    const next = input.rateLimit ? JSON.stringify(input.rateLimit) : null;
    const [updated] = await db.batch([
      db
        .prepare(
          `UPDATE gateway_tenant_subscription SET rate_limit_json = ?2, updated_at = ?3
            WHERE id = ?1 AND ${LIVE_SUBSCRIPTION} AND rate_limit_json IS ?4`,
        )
        .bind(live.id, next, nowS, live.rate_limit_json),
      audit({
        tenantId: input.tenantId,
        actor: input.actor,
        action: "subscription.rate_limit",
        targetType: "subscription",
        targetId: live.id,
        before: { rateLimit: parseJson(live.rate_limit_json) ?? null },
        after: { rateLimit: input.rateLimit },
        reason: input.reason ?? null,
        nowS,
        when: "changes() = 1",
      }),
    ]);
    if (!updated?.meta.changes)
      throw new GatewayError("GATEWAY_CONFLICT", {
        details: { subscriptionId: live.id },
      });
    const row = await db
      .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM gateway_tenant_subscription WHERE id = ?`)
      .bind(live.id)
      .first<SubscriptionRow>();
    if (!row)
      throw new GatewayError("GATEWAY_INTERNAL", {
        message: "The subscription is missing.",
      });
    return subscriptionView(row);
  }

  const port = {
    adjustWallet,
    refund,
    setWalletStatus,
    setSubscriptionRateLimit,
    listPackages,
    createPackage,
    archivePackage,
    listTopupPacks,
    createTopupPack,
    archiveTopupPack,
    setPackageExternalPriceId,
    setTopupPackExternalPriceId,
    packageByExternalPriceId,
    topupPackByExternalPriceId,
    topup,
    subscribe,
    cancelSubscription,
    rollover,
    walletSummary,
  } satisfies GatewayBillingPort;
  return port;
}

export type D1Billing = ReturnType<typeof createD1Billing>;
