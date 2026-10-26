/**
 * Shared GatewayBillingPort / GatewayPriceBookPort contract (#425): one
 * Vitest suite every billing adapter runs against its real store, today D1
 * (apps/api-cf d1-billing.contract.test.ts on node:sqlite), PGlite
 * (apps/api-node gateway-billing.test.ts) and real Postgres (the #379 lite
 * harness). Same inputs, same coded outcomes, same wallet arithmetic.
 *
 * Covered: packages and top-up packs (create, archive, external price ids:
 * taken, lookup, clear), top-up replay / conflict and concurrent duplicates
 * on one provider event id, subscribe / exists / cancel, period rollover
 * (unused grant expires, next period granted, idempotent), refund as an
 * `adjust` with ref_kind payment_refund (replay, conflict, below usage),
 * invalid payment actors, the provider purchase-mode guard, and price book
 * draft / publish / DeepSeek policy.
 *
 * The harness owns time and fixtures: `createTenant` returns a fresh tenant
 * (no wallet), `setNow` moves the adapter clock (epoch ms, forward only).
 */
import { describe, expect, it } from "vitest";

import {
  GATEWAY_BILLING_PAYMENT_REFUND,
  createGatewayBillingHandlers,
  type GatewayBillingPort,
  type GatewayBillingStaffActor,
  type GatewayPaymentActor,
  type GatewayPriceBookPort,
} from "../billing-port.js";
import { isGatewayError, type GatewayErrorCode } from "../errors.js";

export interface GatewayBillingContractHarness {
  billing: GatewayBillingPort;
  priceBook: GatewayPriceBookPort;
  /** A new tenant row with no wallet; ids are unique per call. */
  createTenant(): Promise<string>;
  now(): number;
  setNow(ms: number): void;
}

const DAY = 86_400_000;
const credits = (n: number) => n * 1_000_000;
const admin: GatewayBillingStaffActor = {
  kind: "admin",
  id: "adm_contract",
  role: "platform_admin",
};

async function expectCode(promise: Promise<unknown>, code: GatewayErrorCode) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isGatewayError(error), String(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
  return error as {
    code: string;
    status: number;
    details?: Record<string, unknown>;
  };
}

export function describeGatewayBillingContract(
  name: string,
  setup: () =>
    Promise<GatewayBillingContractHarness> | GatewayBillingContractHarness,
): void {
  describe(`gateway billing contract: ${name}`, () => {
    let n = 0;
    // Each backend runs on a fresh database; the suite name keeps ids readable.
    const nonce = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const unique = (prefix: string) => `${prefix}_${nonce}_${++n}`;
    const payment = (eventId = unique("evt")): GatewayPaymentActor => ({
      kind: "payment",
      provider: "stripe",
      eventId,
    });

    async function harness() {
      const h = await setup();
      const pack = await h.billing.createTopupPack(
        {
          name: unique("pack"),
          priceMinor: 500,
          priceCurrency: "USD",
          microCredits: credits(5),
        },
        admin,
      );
      const pkg = await h.billing.createPackage(
        {
          name: unique("plan"),
          billingPeriod: "month",
          priceMinor: 1000,
          priceCurrency: "USD",
          periodMicroCredits: credits(10),
        },
        admin,
      );
      return { h, pack, pkg, tenantId: await h.createTenant() };
    }

    it("creates, lists, archives packages and packs; archived items cannot be bought", async () => {
      const { h, pack, pkg, tenantId } = await harness();
      expect(pack).toMatchObject({
        status: "active",
        microCredits: credits(5),
        priceMinor: 500,
        externalPriceId: null,
      });
      expect(pkg).toMatchObject({
        status: "active",
        billingPeriod: "month",
        periodMicroCredits: credits(10),
      });
      expect((await h.billing.listTopupPacks()).map((p) => p.id)).toContain(
        pack.id,
      );
      expect((await h.billing.listPackages()).map((p) => p.id)).toContain(
        pkg.id,
      );

      expect((await h.billing.archiveTopupPack(pack.id, admin)).status).toBe(
        "archived",
      );
      expect((await h.billing.archiveTopupPack(pack.id, admin)).status).toBe(
        "archived",
      );
      await expectCode(
        h.billing.topup({
          tenantId,
          packId: pack.id,
          idempotencyKey: unique("k"),
          actor: admin,
        }),
        "GATEWAY_TOPUP_PACK_ARCHIVED",
      );
      expect((await h.billing.archivePackage(pkg.id, admin)).status).toBe(
        "archived",
      );
      await expectCode(
        h.billing.subscribe({
          tenantId,
          packageId: pkg.id,
          idempotencyKey: unique("k"),
          actor: admin,
        }),
        "GATEWAY_PACKAGE_ARCHIVED",
      );
      await expectCode(
        h.billing.archivePackage(unique("missing"), admin),
        "GATEWAY_PACKAGE_NOT_FOUND",
      );
      await expectCode(
        h.billing.topup({
          tenantId,
          packId: unique("missing"),
          idempotencyKey: unique("k"),
          actor: admin,
        }),
        "GATEWAY_TOPUP_PACK_NOT_FOUND",
      );
    });

    it("maps external price ids to one item each", async () => {
      const { h, pack, pkg } = await harness();
      const priceId = unique("price");
      expect(
        (await h.billing.setTopupPackExternalPriceId(pack.id, priceId, admin))
          .externalPriceId,
      ).toBe(priceId);
      expect((await h.billing.topupPackByExternalPriceId(priceId))?.id).toBe(
        pack.id,
      );
      const other = await h.billing.createTopupPack(
        {
          name: unique("pack"),
          priceMinor: 100,
          priceCurrency: "USD",
          microCredits: credits(1),
        },
        admin,
      );
      await expectCode(
        h.billing.setTopupPackExternalPriceId(other.id, priceId, admin),
        "GATEWAY_EXTERNAL_PRICE_ID_TAKEN",
      );
      await expectCode(
        h.billing.createTopupPack(
          {
            name: unique("pack"),
            priceMinor: 1,
            priceCurrency: "USD",
            microCredits: 1,
            externalPriceId: priceId,
          },
          admin,
        ),
        "GATEWAY_EXTERNAL_PRICE_ID_TAKEN",
      );

      const planPrice = unique("price");
      await h.billing.setPackageExternalPriceId(pkg.id, planPrice, admin);
      expect((await h.billing.packageByExternalPriceId(planPrice))?.id).toBe(
        pkg.id,
      );
      expect(
        await h.billing.packageByExternalPriceId(unique("none")),
      ).toBeNull();

      expect(
        (await h.billing.setTopupPackExternalPriceId(pack.id, null, admin))
          .externalPriceId,
      ).toBeNull();
      expect(await h.billing.topupPackByExternalPriceId(priceId)).toBeNull();
      expect(
        (await h.billing.setTopupPackExternalPriceId(other.id, priceId, admin))
          .externalPriceId,
      ).toBe(priceId);
    });

    it("tops up once per idempotency key; a different pack under the key conflicts", async () => {
      const { h, pack, tenantId } = await harness();
      const key = unique("k");
      const first = await h.billing.topup({
        tenantId,
        packId: pack.id,
        idempotencyKey: key,
        actor: admin,
      });
      expect(first.replayed).toBe(false);
      expect(first.entry).toMatchObject({
        kind: "topup",
        amountMicroCredits: credits(5),
        refKind: "topup_pack",
        refId: pack.id,
      });
      expect(first.wallet.limitMicroCredits).toBe(credits(5));
      const again = await h.billing.topup({
        tenantId,
        packId: pack.id,
        idempotencyKey: key,
        actor: admin,
      });
      expect(again.replayed).toBe(true);
      expect(again.entry.requestId).toBe(first.entry.requestId);
      expect(again.wallet.limitMicroCredits).toBe(credits(5));
      const other = await h.billing.createTopupPack(
        {
          name: unique("pack"),
          priceMinor: 100,
          priceCurrency: "USD",
          microCredits: credits(1),
        },
        admin,
      );
      await expectCode(
        h.billing.topup({
          tenantId,
          packId: other.id,
          idempotencyKey: key,
          actor: admin,
        }),
        "GATEWAY_IDEMPOTENCY_CONFLICT",
      );
      const summary = await h.billing.walletSummary(tenantId);
      expect(summary.entries.filter((e) => e.kind === "topup")).toHaveLength(1);
      expect(summary.wallet?.availableMicroCredits).toBe(credits(5));
    });

    it("credits a concurrently redelivered provider event exactly once", async () => {
      const { h, pack, tenantId } = await harness();
      const eventId = unique("evt");
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          h.billing.topup({
            tenantId,
            packId: pack.id,
            idempotencyKey: eventId,
            actor: payment(eventId),
          }),
        ),
      );
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.entry.requestId)).size).toBe(1);
      const summary = await h.billing.walletSummary(tenantId);
      expect(summary.wallet?.limitMicroCredits).toBe(credits(5));
      expect(summary.entries.filter((e) => e.kind === "topup")).toHaveLength(1);
      expect(summary.entries[0]?.actorUserId).toBe("payment:stripe");
    });

    it("refuses an invalid payment actor before any write", async () => {
      const { h, pack, tenantId } = await harness();
      for (const actor of [
        { kind: "payment", provider: "Stripe!", eventId: "evt_1" },
        { kind: "payment", provider: "stripe", eventId: "" },
        { kind: "payment", provider: "stripe", eventId: "x".repeat(257) },
      ] as GatewayPaymentActor[])
        await expectCode(
          h.billing.topup({
            tenantId,
            packId: pack.id,
            idempotencyKey: unique("k"),
            actor,
          }),
          "GATEWAY_INVALID_REQUEST",
        );
      expect((await h.billing.walletSummary(tenantId)).wallet).toBeNull();
    });

    it("subscribes once, refuses a second live subscription, and cancels at period end", async () => {
      const { h, pkg, tenantId } = await harness();
      const key = unique("k");
      const sub = await h.billing.subscribe({
        tenantId,
        packageId: pkg.id,
        idempotencyKey: key,
        actor: payment(),
      });
      expect(sub.replayed).toBe(false);
      expect(sub.subscription).toMatchObject({
        tenantId,
        packageId: pkg.id,
        status: "active",
        cancelAt: null,
      });
      expect(sub.entry).toMatchObject({
        kind: "grant",
        amountMicroCredits: credits(10),
      });
      expect(sub.wallet.limitMicroCredits).toBe(credits(10));
      const replay = await h.billing.subscribe({
        tenantId,
        packageId: pkg.id,
        idempotencyKey: key,
        actor: admin,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.subscription?.id).toBe(sub.subscription?.id);
      await expectCode(
        h.billing.subscribe({
          tenantId,
          packageId: pkg.id,
          idempotencyKey: unique("k"),
          actor: admin,
        }),
        "GATEWAY_SUBSCRIPTION_EXISTS",
      );
      const canceled = await h.billing.cancelSubscription({
        tenantId,
        actor: admin,
      });
      expect(canceled.cancelAt).toBe(sub.subscription?.currentPeriodEnd);
      expect(
        (await h.billing.cancelSubscription({ tenantId, actor: admin }))
          .canceledAt,
      ).toBe(canceled.canceledAt);
      const other = await h.createTenant();
      await expectCode(
        h.billing.cancelSubscription({ tenantId: other, actor: admin }),
        "GATEWAY_SUBSCRIPTION_NOT_FOUND",
      );
    });

    it("rolls periods over: the unused grant expires, the next is granted, once", async () => {
      const { h, pkg, pack, tenantId } = await harness();
      await h.billing.topup({
        tenantId,
        packId: pack.id,
        idempotencyKey: unique("k"),
        actor: admin,
      });
      await h.billing.subscribe({
        tenantId,
        packageId: pkg.id,
        idempotencyKey: unique("k"),
        actor: admin,
      });
      expect(await h.billing.rollover({ tenantId, actor: admin })).toEqual([]);
      h.setNow(h.now() + 32 * DAY);
      const [outcome] = await h.billing.rollover({ tenantId, actor: admin });
      expect(outcome).toMatchObject({
        tenantId,
        periodsClosed: 1,
        status: "active",
      });
      expect(outcome?.error).toBeUndefined();
      expect(outcome?.expiredMicroCredits).toBe(credits(10));
      expect(outcome?.grantedMicroCredits).toBe(credits(10));
      expect(await h.billing.rollover({ tenantId, actor: admin })).toEqual([]);
      const summary = await h.billing.walletSummary(tenantId);
      // Top-up credits never expire; one period's grant is live.
      expect(summary.wallet?.limitMicroCredits).toBe(credits(15));
      expect(summary.entries.filter((e) => e.kind === "expire")).toHaveLength(
        1,
      );
      expect(summary.entries.filter((e) => e.kind === "grant")).toHaveLength(2);

      await h.billing.cancelSubscription({ tenantId, actor: admin });
      h.setNow(h.now() + 32 * DAY);
      const [ended] = await h.billing.rollover({ tenantId, actor: admin });
      expect(ended).toMatchObject({
        periodsClosed: 1,
        status: "expired",
        grantedMicroCredits: 0,
      });
      expect((await h.billing.walletSummary(tenantId)).subscription).toBeNull();
      expect(
        (await h.billing.walletSummary(tenantId)).wallet?.limitMicroCredits,
      ).toBe(credits(5));
    });

    it("refunds as an adjust (payment_refund) once per key, never below usage", async () => {
      const { h, pack, tenantId } = await harness();
      await h.billing.topup({
        tenantId,
        packId: pack.id,
        idempotencyKey: unique("k"),
        actor: payment(),
      });
      const key = unique("re");
      const actor = payment();
      const refund = await h.billing.refund({
        tenantId,
        microCredits: credits(2),
        idempotencyKey: key,
        refId: "ord_1",
        actor,
      });
      expect(refund.replayed).toBe(false);
      expect(refund.entry).toMatchObject({
        kind: "adjust",
        refKind: GATEWAY_BILLING_PAYMENT_REFUND,
        refId: "ord_1",
        amountMicroCredits: credits(2),
        actorUserId: "payment:stripe",
      });
      expect(refund.wallet.limitMicroCredits).toBe(credits(3));
      const replay = await h.billing.refund({
        tenantId,
        microCredits: credits(2),
        idempotencyKey: key,
        refId: "ord_1",
        actor,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.wallet.limitMicroCredits).toBe(credits(3));
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () =>
          h.billing.refund({
            tenantId,
            microCredits: credits(2),
            idempotencyKey: key,
            refId: "ord_1",
            actor,
          }),
        ),
      );
      expect(concurrent.every((r) => r.replayed)).toBe(true);
      await expectCode(
        h.billing.refund({
          tenantId,
          microCredits: credits(1),
          idempotencyKey: key,
          refId: "ord_1",
          actor,
        }),
        "GATEWAY_IDEMPOTENCY_CONFLICT",
      );
      await expectCode(
        h.billing.refund({
          tenantId,
          microCredits: credits(4),
          idempotencyKey: unique("re"),
          actor,
        }),
        "GATEWAY_BUDGET_BELOW_USAGE",
      );
      await expectCode(
        h.billing.refund({
          tenantId,
          microCredits: 0,
          idempotencyKey: unique("re"),
          actor,
        }),
        "GATEWAY_INVALID_REQUEST",
      );
      const summary = await h.billing.walletSummary(tenantId);
      expect(summary.wallet?.limitMicroCredits).toBe(credits(3));
      expect(
        summary.entries.filter(
          (e) => e.refKind === GATEWAY_BILLING_PAYMENT_REFUND,
        ),
      ).toHaveLength(1);
    });

    it("corrects a wallet with admin adjustments and suspends it", async () => {
      const { h, tenantId } = await harness();
      const credit = await h.billing.adjustWallet({
        tenantId,
        deltaMicroCredits: credits(3),
        reason: "goodwill",
        idempotencyKey: unique("adj"),
        actor: admin,
      });
      expect(credit.entry).toMatchObject({
        kind: "adjust",
        refKind: "admin_credit",
        amountMicroCredits: credits(3),
      });
      await expectCode(
        h.billing.adjustWallet({
          tenantId,
          deltaMicroCredits: -credits(4),
          reason: "x",
          idempotencyKey: unique("adj"),
          actor: admin,
        }),
        "GATEWAY_BUDGET_BELOW_USAGE",
      );
      const debit = await h.billing.adjustWallet({
        tenantId,
        deltaMicroCredits: -credits(1),
        reason: "fix",
        idempotencyKey: unique("adj"),
        actor: admin,
      });
      expect(debit.entry.refKind).toBe("admin_debit");
      expect(debit.wallet.limitMicroCredits).toBe(credits(2));
      expect(
        (
          await h.billing.setWalletStatus({
            tenantId,
            status: "suspended",
            reason: "abuse",
            actor: admin,
          })
        ).status,
      ).toBe("suspended");
      expect(
        (
          await h.billing.setWalletStatus({
            tenantId,
            status: "active",
            reason: "ok",
            actor: admin,
          })
        ).status,
      ).toBe("active");
      await expectCode(
        h.billing.topup({
          tenantId: unique("ghost"),
          packId: "x",
          idempotencyKey: unique("k"),
          actor: admin,
        }),
        "GATEWAY_TENANT_NOT_FOUND",
      );
    });

    it("refuses self-credit routes in provider mode before reading the body", async () => {
      const { h, pack, tenantId } = await harness();
      const handlers = createGatewayBillingHandlers(h.billing, {
        purchaseMode: "provider",
        checkoutPath: "/billing/checkout",
      });
      let reads = 0;
      const readBody = async () => {
        reads += 1;
        return JSON.stringify({ packId: pack.id, idempotencyKey: unique("k") });
      };
      for (const call of [
        () => handlers.topup(tenantId, readBody, admin),
        () => handlers.subscribe(tenantId, readBody, admin),
        () => handlers.cancel(tenantId, admin),
      ]) {
        const error = await expectCode(
          call(),
          "GATEWAY_PAYMENT_REQUIRED_VIA_PROVIDER",
        );
        expect(error.status).toBe(409);
      }
      expect(reads).toBe(0);
      expect((await handlers.summary(tenantId)).status).toBe(200);
      expect((await handlers.offers()).status).toBe(200);
      const free = createGatewayBillingHandlers(h.billing, {
        purchaseMode: "free",
      });
      expect((await free.topup(tenantId, readBody, admin)).status).toBe(201);
      expect(reads).toBe(1);
    });

    it("drafts and publishes a price version; DeepSeek outside Flash is blocked", async () => {
      const { h } = await harness();
      const version = unique("v").replaceAll("_", "-");
      const rates = [
        {
          modelCode: "contract-model",
          upstreamId: "",
          unit: "input_token" as const,
          microCredits: 2,
          per: 1,
        },
        {
          modelCode: "contract-model",
          upstreamId: "",
          unit: "output_token" as const,
          microCredits: 5,
          per: 1,
        },
      ];
      const draft = await h.priceBook.putDraft({
        version,
        effectiveFrom: h.now(),
        effectiveTo: null,
        rates,
        actor: admin,
      });
      expect(draft).toMatchObject({
        version,
        status: "draft",
        publishedAt: null,
      });
      expect(draft.rates).toHaveLength(2);
      const replaced = await h.priceBook.putDraft({
        version,
        effectiveFrom: h.now(),
        effectiveTo: null,
        rates: rates.slice(0, 1),
        actor: admin,
      });
      expect(replaced.rates).toHaveLength(1);
      const published = await h.priceBook.publish({ version, actor: admin });
      expect(published.status).toBe("published");
      await expectCode(
        h.priceBook.publish({ version, actor: admin }),
        "GATEWAY_PRICE_VERSION_PUBLISHED",
      );
      await expectCode(
        h.priceBook.putDraft({
          version,
          effectiveFrom: h.now(),
          effectiveTo: null,
          rates,
          actor: admin,
        }),
        "GATEWAY_PRICE_VERSION_PUBLISHED",
      );
      expect(
        (
          await h.priceBook.list({
            modelCode: "contract-model",
            status: "published",
          })
        ).map((v) => v.version),
      ).toContain(version);
      await expectCode(
        h.priceBook.read(unique("nope")),
        "GATEWAY_PRICE_VERSION_NOT_FOUND",
      );
      await expectCode(
        h.priceBook.putDraft({
          version: unique("ds").replaceAll("_", "-"),
          effectiveFrom: h.now(),
          effectiveTo: null,
          rates: [
            {
              modelCode: "deepseek-chat",
              upstreamId: "",
              unit: "input_token",
              microCredits: 1,
              per: 1,
            },
          ],
          actor: admin,
        }),
        "GATEWAY_PRICE_MODEL_BLOCKED",
      );
      const flash = unique("fl").replaceAll("_", "-");
      await h.priceBook.putDraft({
        version: flash,
        effectiveFrom: h.now(),
        effectiveTo: null,
        rates: [
          {
            modelCode: "deepseek-v4-flash",
            upstreamId: "",
            unit: "input_token",
            microCredits: 1,
            per: 1,
          },
        ],
        actor: admin,
      });
      await expectCode(
        h.priceBook.putDraft({
          version: flash,
          effectiveFrom: h.now(),
          effectiveTo: h.now() - 1,
          rates,
          actor: admin,
        }),
        "GATEWAY_PRICE_WINDOW_INVALID",
      );
    });
  });
}
