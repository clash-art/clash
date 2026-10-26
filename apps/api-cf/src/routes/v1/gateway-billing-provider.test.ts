/**
 * Provider purchase mode (#419) over the real routes and D1 adapters on
 * node:sqlite: with no billing plugin (self-host) a tenant owner buys credits
 * directly; with a `billing.purchaseMode = "provider"` plugin the purchase
 * routes refuse with GATEWAY_PAYMENT_REQUIRED_VIA_PROVIDER and write nothing,
 * while the server-only credit API records provider-confirmed purchases,
 * cancels and refunds with a `payment` actor, idempotently.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isGatewayError, type GatewayErrorCode } from "@clash/gateway-core";

import { createApp } from "../../app";
import { createD1Billing, monotonicClock, type PaymentActor } from "../../billing";
import { createSqliteD1 } from "../../../../web/app/test-support/sqlite-d1";
import { seedGateway, type SeededGateway } from "../../gateway/test-support";
import { billingPurchaseMode, composePlugins, setPlugins } from "../../plugins/registry";
import type { Plugin } from "../../plugins/types";

const ORIGIN = "http://localhost:8789";
const { d1, sqlite } = createSqliteD1();
const app = createApp();
const payments: Plugin = { name: "payments-test", billing: { purchaseMode: "provider", checkoutPath: "/api/v1/billing/checkout" } };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);

let gateway: SeededGateway;
beforeAll(async () => {
  gateway = await seedGateway(d1);
});
afterEach(() => setPlugins([]));

const env = () => ({
  DB: d1,
  ENVIRONMENT: "test",
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "test-secret-for-gateway-billing-0123456789",
  GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey,
});

function user() {
  const userId = `user-${hex()}`;
  const raw = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  sqlite.prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`).run(userId, `Name ${userId}`, `${hex()}@billing.test`);
  sqlite
    .prepare("INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, 'gw', ?, 'clsh_gw', 1)")
    .run(`tok-${hex()}`, userId, sha256(raw));
  return { userId, auth: { authorization: `Bearer ${raw}` } };
}

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env() as never,
  );
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function expectCode(promise: Promise<unknown>, code: GatewayErrorCode) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isGatewayError(error), String(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
}

async function team() {
  const owner = user();
  const { team: created } = await json<{ team: { tenantId: string } }>(
    await call("POST", "/api/v1/gateway/teams", owner.auth, { name: `Team ${hex()}` }),
    201,
  );
  const packId = `pack-${hex()}`;
  const packageId = `pkg-${hex()}`;
  sqlite
    .prepare(`INSERT INTO gateway_topup_pack (id, name, status, price_minor, price_currency, credits_micro, external_price_id) VALUES (?, 'Pack', 'active', 500, 'USD', 5000000, ?)`)
    .run(packId, `price_${packId}`);
  sqlite
    .prepare(`INSERT INTO gateway_package (id, name, status, billing_period, price_minor, price_currency, credits_micro) VALUES (?, 'Pro', 'active', 'month', 900, 'USD', 7000000)`)
    .run(packageId);
  return { tenantId: created.tenantId, base: `/api/v1/gateway/tenants/${encodeURIComponent(created.tenantId)}`, owner, packId, packageId };
}

const count = (sql: string, ...params: string[]) => (sqlite.prepare(sql).get(...params) as { n: number }).n;
const credits = (tenantId: string) =>
  count(`SELECT COUNT(*) AS n FROM gateway_usage_ledger WHERE tenant_id = ? AND kind IN ('topup', 'grant', 'adjust')`, tenantId);
const limit = (tenantId: string) =>
  (sqlite.prepare(`SELECT limit_micro_credits AS n FROM gateway_budget WHERE tenant_id = ?1 AND scope = 'tenant' AND scope_id = ?1`).get(tenantId) as
    | { n: number }
    | undefined)?.n ?? 0;

describe("billing purchase mode", () => {
  it("composes to free without a billing plugin and to provider (fail closed) with one", () => {
    expect(billingPurchaseMode(composePlugins([]))).toBe("free");
    expect(billingPurchaseMode(composePlugins([{ name: "other" }]))).toBe("free");
    expect(billingPurchaseMode(composePlugins([{ name: "other" }, payments]))).toBe("provider");
    // An unknown mode from untyped plugin code still closes the free path.
    expect(billingPurchaseMode(composePlugins([{ name: "odd", billing: { purchaseMode: "other" as never } }]))).toBe("provider");
  });

  it("self-host (no plugin): the owner tops up, subscribes and cancels directly", async () => {
    const t = await team();
    await json(await call("POST", `${t.base}/topups`, t.owner.auth, { packId: t.packId, idempotencyKey: `k-${hex()}` }), 201);
    await json(await call("POST", `${t.base}/subscription`, t.owner.auth, { packageId: t.packageId, idempotencyKey: `s-${hex()}` }), 201);
    await json(await call("POST", `${t.base}/subscription/cancel`, t.owner.auth));
    expect(limit(t.tenantId)).toBe(12_000_000);
  });

  it("provider mode: purchase routes refuse with a coded 409 pointing to checkout and write nothing; reads still work", async () => {
    const t = await team();
    setPlugins([payments]);
    const before = credits(t.tenantId);
    for (const [path, body] of [
      [`${t.base}/topups`, { packId: t.packId, idempotencyKey: `k-${hex()}` }],
      [`${t.base}/subscription`, { packageId: t.packageId, idempotencyKey: `s-${hex()}` }],
      [`${t.base}/subscription/cancel`, undefined],
    ] as const) {
      const res = await call("POST", path, t.owner.auth, body);
      const text = await res.clone().text();
      expect(res.status, text).toBe(409);
      expect(res.headers.get("x-clash-error-code")).toBe("GATEWAY_PAYMENT_REQUIRED_VIA_PROVIDER");
      expect(text).toContain("/api/v1/billing/checkout");
    }
    expect(credits(t.tenantId)).toBe(before);
    expect(limit(t.tenantId)).toBe(0);
    const summary = await json<{ entries: unknown[] }>(await call("GET", `${t.base}/billing`, t.owner.auth));
    expect(summary.entries).toEqual([]);
    const offers = await json<{ packs: Array<{ id: string; externalPriceId: string | null }> }>(
      await call("GET", `${t.base}/billing/offers`, t.owner.auth),
    );
    expect(offers.packs.find((pack) => pack.id === t.packId)?.externalPriceId).toBe(`price_${t.packId}`);
  });
});

describe("server-only credit API with a payment actor", () => {
  const billing = () => createD1Billing(d1, { clock: monotonicClock() });
  const actor = (eventId = `evt_${hex()}`): PaymentActor => ({ kind: "payment", provider: "polar", eventId });
  const auditRows = (tenantId: string) =>
    sqlite
      .prepare(`SELECT action, actor_kind, actor_id, actor_role, after_json FROM gateway_admin_audit WHERE tenant_id = ? AND actor_kind = 'payment' ORDER BY occurred_at, rowid`)
      .all(tenantId) as Array<{ action: string; actor_kind: string; actor_id: string; actor_role: string; after_json: string }>;

  it("credits a webhook top-up once per provider id and records provider + event id", async () => {
    const t = await team();
    setPlugins([payments]);
    const pack = await billing().topupPackByExternalPriceId(`price_${t.packId}`);
    expect(pack?.id).toBe(t.packId);
    const orderId = `ord_${hex()}`;
    const first = await billing().topup({ tenantId: t.tenantId, packId: t.packId, idempotencyKey: orderId, actor: actor("evt_1") });
    const again = await billing().topup({ tenantId: t.tenantId, packId: t.packId, idempotencyKey: orderId, actor: actor("evt_1_redelivered") });
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    expect(first.entry.actorUserId).toBe("payment:polar");
    expect(limit(t.tenantId)).toBe(5_000_000);
    const [row] = auditRows(t.tenantId);
    expect(row).toMatchObject({ action: "wallet.topup", actor_kind: "payment", actor_id: "payment:polar", actor_role: "polar" });
    expect(JSON.parse(row!.after_json)).toMatchObject({ payment: { provider: "polar", eventId: "evt_1" } });
  });

  it("subscribes and cancels for the provider", async () => {
    const t = await team();
    const sub = await billing().subscribe({ tenantId: t.tenantId, packageId: t.packageId, idempotencyKey: `sub_${hex()}`, actor: actor() });
    expect(sub.entry.kind).toBe("grant");
    const canceled = await billing().cancelSubscription({ tenantId: t.tenantId, actor: actor() });
    expect(canceled.cancelAt).not.toBeNull();
    expect(auditRows(t.tenantId).map((row) => row.action)).toEqual(["subscription.create", "subscription.cancel"]);
  });

  it("refunds as an idempotent adjust that removes credits, never below usage", async () => {
    const t = await team();
    await billing().topup({ tenantId: t.tenantId, packId: t.packId, idempotencyKey: `ord_${hex()}`, actor: actor() });
    const refund = { tenantId: t.tenantId, microCredits: 2_000_000, idempotencyKey: `re_${hex()}`, refId: "ord_x", actor: actor() };
    const first = await billing().refund(refund);
    const again = await billing().refund({ ...refund, actor: actor() });
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    expect(first.entry).toMatchObject({ kind: "adjust", refKind: "payment_refund", refId: "ord_x", amountMicroCredits: 2_000_000 });
    expect(limit(t.tenantId)).toBe(3_000_000);
    expect(count(`SELECT COUNT(*) AS n FROM gateway_usage_ledger WHERE request_id = ? AND kind = 'adjust'`, `refund:${t.tenantId}:${refund.idempotencyKey}`)).toBe(1);
    await expectCode(billing().refund({ ...refund, microCredits: 1 }), "GATEWAY_IDEMPOTENCY_CONFLICT");
    await expectCode(billing().refund({ ...refund, idempotencyKey: `re_${hex()}`, microCredits: 9_000_000 }), "GATEWAY_BUDGET_BELOW_USAGE");
    await expectCode(billing().refund({ ...refund, idempotencyKey: `re_${hex()}`, microCredits: 0 }), "GATEWAY_INVALID_REQUEST");
    expect(limit(t.tenantId)).toBe(3_000_000);
    const summary = await billing().walletSummary(t.tenantId);
    expect(summary.entries.map((entry) => entry.refKind)).toContain("payment_refund");
    expect(auditRows(t.tenantId).map((row) => row.action)).toEqual(["wallet.topup", "wallet.refund"]);
  });

  it("refuses a malformed payment actor before writing", async () => {
    const t = await team();
    await expectCode(
      billing().topup({ tenantId: t.tenantId, packId: t.packId, idempotencyKey: "k", actor: { kind: "payment", provider: "Bad Provider", eventId: "e" } }),
      "GATEWAY_INVALID_REQUEST",
    );
    await expectCode(
      billing().topup({ tenantId: t.tenantId, packId: t.packId, idempotencyKey: "k", actor: { kind: "payment", provider: "polar", eventId: "" } }),
      "GATEWAY_INVALID_REQUEST",
    );
    expect(credits(t.tenantId)).toBe(0);
  });

  it("keeps external price ids unique and editable", async () => {
    const admin = { kind: "admin", id: "adm_419", role: "platform_admin" } as const;
    const a = await billing().createTopupPack({ name: "A", priceMinor: 100, priceCurrency: "USD", microCredits: 1, externalPriceId: `p_${hex()}` }, admin);
    const b = await billing().createTopupPack({ name: "B", priceMinor: 100, priceCurrency: "USD", microCredits: 1 }, admin);
    expect(b.externalPriceId).toBeNull();
    await expectCode(billing().setTopupPackExternalPriceId(b.id, a.externalPriceId, admin), "GATEWAY_EXTERNAL_PRICE_ID_TAKEN");
    expect((await billing().setTopupPackExternalPriceId(b.id, "p_b", admin)).externalPriceId).toBe("p_b");
    expect((await billing().setTopupPackExternalPriceId(b.id, null, admin)).externalPriceId).toBeNull();
    const pkg = await billing().createPackage(
      { name: "P", billingPeriod: "month", priceMinor: 1, priceCurrency: "USD", periodMicroCredits: 1, externalPriceId: "p_pkg_419" },
      admin,
    );
    expect((await billing().packageByExternalPriceId("p_pkg_419"))?.id).toBe(pkg.id);
  });
});
