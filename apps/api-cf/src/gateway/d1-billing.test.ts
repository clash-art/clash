/**
 * Price book and credit billing (#352) over the real D1 adapters on
 * node:sqlite with the web/drizzle migrations: draft/publish, effective-date
 * selection, no repricing of settled usage through the real data plane,
 * grant/topup/expire idempotency, team wallet funding, atomic refusals with
 * coded errors. Amounts are fixture inputs; assertions compare the ledger and
 * wallet against each other, never against numbers copied from the adapter.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGatewayApp,
  GATEWAY_REQUEST_ID_HEADER,
  isGatewayError,
  type GatewayClock,
  type GatewayErrorCode,
  type GatewayPorts,
} from "@clash/gateway-core";

import { createSqliteD1 } from "../../../web/app/test-support/sqlite-d1";
import { sha256Hex } from "../services/api-token";
import { createGatewayTokenStore } from "../services/gateway-tokens";
import { createD1Billing, type BillingActor } from "./d1-billing";
import { toSeconds } from "./d1-common";
import { createD1PriceBook } from "./d1-price-book";
import { createD1GatewayPorts } from "./index";
import { CONTRACT_ORIGIN, seedGateway, type SeededGateway } from "./test-support";

const { d1, sqlite } = createSqliteD1();
const seeded: Promise<SeededGateway> = seedGateway(d1);

const admin: BillingActor = { kind: "admin", id: "adm_billing", role: "platform_admin" };
const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const credits = (n: number) => n * 1_000_000;

async function expectCode(promise: Promise<unknown>, code: GatewayErrorCode) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isGatewayError(error), String(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
  return error as { code: string; details?: Record<string, unknown> };
}

const rows = <T>(sql: string, ...params: Array<string | number | null>) =>
  sqlite.prepare(sql).all(...params) as T[];
const row = <T>(sql: string, ...params: Array<string | number | null>) =>
  sqlite.prepare(sql).get(...params) as T | undefined;

interface WalletRow {
  id: string;
  limit_micro_credits: number | null;
  spent_micro_credits: number;
  reserved_micro_credits: number;
}
const wallet = (tenantId: string) =>
  row<WalletRow>(
    `SELECT id, limit_micro_credits, spent_micro_credits, reserved_micro_credits FROM gateway_budget
      WHERE tenant_id = ?1 AND scope = 'tenant' AND scope_id = ?1`,
    tenantId,
  );

describe("price book and billing over D1 (node:sqlite)", () => {
  let gateway: SeededGateway;
  let t: number;
  const clock: GatewayClock = { now: () => t };
  const priceBook = () => createD1PriceBook(d1, { clock });
  const billing = () => createD1Billing(d1, { clock });
  let ports: GatewayPorts;
  let app: ReturnType<typeof createGatewayApp>;

  beforeAll(async () => {
    gateway = await seeded;
  });
  beforeEach(() => {
    // Within the seeded tokens' lifetime; each test moves forward from here.
    t = gateway.clock.now() + 1_000;
    ports = createD1GatewayPorts({
      db: d1,
      clock,
      secrets: { encryptionKey: gateway.encryptionKey, secret: () => undefined },
      logger: { info() {}, warn() {}, error() {} },
      upstream: {
        fetch: async (request) =>
          Response.json({
            id: "chatcmpl-price-book",
            object: "chat.completion",
            model: ((await request.json()) as { model: string }).model,
            choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
          }),
      },
    });
    app = createGatewayApp(ports, { basePath: "/gateway" });
  });

  const chat = (token: string) =>
    app.fetch(
      new Request(`${CONTRACT_ORIGIN}/gateway/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: gateway.textModel,
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 32,
        }),
      }),
    );

  async function settled(res: Response) {
    expect(res.status, await res.clone().text()).toBe(200);
    const requestId = res.headers.get(GATEWAY_REQUEST_ID_HEADER)!;
    return rows<{ budget_id: string; price_version: string; amount_micro_credits: number }>(
      `SELECT budget_id, price_version, amount_micro_credits FROM gateway_usage_ledger
        WHERE request_id = ? AND kind = 'settle' ORDER BY budget_id`,
      requestId,
    );
  }

  // Price-selection tests price their own model code so versions published by
  // one test never shadow another's; only the data-plane tests use the
  // seeded catalog model.
  let model: string;
  beforeEach(() => {
    model = `price-model-${hex(4)}`;
  });
  const textRates = (input: number, output: number, modelCode = model) => [
    { modelCode, upstreamId: "", unit: "input_token" as const, microCredits: input, per: 1 },
    { modelCode, upstreamId: "", unit: "output_token" as const, microCredits: output, per: 1 },
  ];
  const routeOf = () => ({
    identity: { tenantId: "t", userId: "u", budgetIds: [], credentialScope: "official" } as never,
    catalogVersion: gateway.catalogVersion,
    route: { modelCode: model, kind: "text", providerId: "official", upstreamId: "openai" } as never,
  });
  const version = (prefix: string) => `${prefix}-${hex(4)}`;

  describe("draft -> publish", () => {
    it("never charges a draft, and publishing makes the version the price at request time", async () => {
      const route = routeOf();
      await expectCode(ports.routes.price(route), "GATEWAY_PRICE_UNAVAILABLE");
      const draft = version("draft");
      const view = await priceBook().putDraft({
        version: draft,
        effectiveFrom: t,
        effectiveTo: null,
        rates: textRates(7, 9),
        actor: admin,
      });
      expect(view).toMatchObject({ version: draft, status: "draft", publishedAt: null });
      await expectCode(ports.routes.price(route), "GATEWAY_PRICE_UNAVAILABLE");
      const older = version("older");
      await priceBook().putDraft({ version: older, effectiveFrom: t, effectiveTo: null, rates: textRates(1, 1), actor: admin });
      await priceBook().publish({ version: older, actor: admin });
      expect((await ports.routes.price(route)).version).toBe(older);

      t += 5_000;
      const published = await priceBook().publish({ version: draft, actor: admin });
      expect(published.status).toBe("published");
      // A start already past moves to the publish instant: nothing is backdated.
      expect(Date.parse(published.effectiveFrom)).toBe(toSeconds(t) * 1000);
      expect(Date.parse(published.publishedAt!)).toBe(toSeconds(t) * 1000);
      expect((await ports.routes.price(route)).version).toBe(draft);
      // A request admitted before publication is still priced by the older version.
      expect((await ports.routes.price({ ...route, at: t - 2_000 })).version).toBe(older);
      const audit = rows<{ action: string }>(
        `SELECT action FROM gateway_admin_audit WHERE target_type = 'price_version' AND target_id = ? ORDER BY occurred_at, action`,
        draft,
      );
      expect(audit.map((entry) => entry.action).sort()).toEqual(["price.draft", "price.publish"]);
    });

    it("selects by effective date: a future version applies only from its start", async () => {
      const route = routeOf();
      const current = version("current");
      await priceBook().putDraft({ version: current, effectiveFrom: t, effectiveTo: null, rates: textRates(1, 2), actor: admin });
      await priceBook().publish({ version: current, actor: admin });
      const future = version("future");
      const startsAt = t + 100_000;
      await priceBook().putDraft({
        version: future,
        effectiveFrom: startsAt,
        effectiveTo: startsAt + 50_000,
        rates: textRates(3, 4),
        actor: admin,
      });
      await priceBook().publish({ version: future, actor: admin });
      expect((await ports.routes.price(route)).version).toBe(current);
      expect((await ports.routes.price({ ...route, at: startsAt - 1_000 })).version).toBe(current);
      expect((await ports.routes.price({ ...route, at: startsAt })).version).toBe(future);
      // effective_to closes the window; the older open-ended version applies again.
      expect((await ports.routes.price({ ...route, at: startsAt + 50_000 })).version).toBe(current);
    });

    it("lets a newer version supersede an older exact-upstream row", async () => {
      const route = routeOf();
      const exact = version("exact");
      await priceBook().putDraft({
        version: exact,
        effectiveFrom: t,
        effectiveTo: null,
        rates: textRates(1, 2).map((rate) => ({ ...rate, upstreamId: "openai" })),
        actor: admin,
      });
      await priceBook().publish({ version: exact, actor: admin });
      expect((await ports.routes.price(route)).version).toBe(exact);
      t += 2_000;
      const wide = version("wide");
      await priceBook().putDraft({ version: wide, effectiveFrom: t, effectiveTo: null, rates: textRates(5, 6), actor: admin });
      await priceBook().publish({ version: wide, actor: admin });
      expect((await ports.routes.price(route)).version).toBe(wide);
    });

    it("replaces a draft wholly and refuses to change a published version", async () => {
      const name = version("edit");
      await priceBook().putDraft({ version: name, effectiveFrom: t, effectiveTo: null, rates: textRates(1, 2), actor: admin });
      const replaced = await priceBook().putDraft({
        version: name,
        effectiveFrom: t,
        effectiveTo: null,
        rates: textRates(3, 4).slice(0, 1),
        actor: admin,
      });
      expect(replaced.rates).toEqual([
        { modelCode: model, upstreamId: "", unit: "input_token", amountMicroCredits: 3, per: 1 },
      ]);
      await priceBook().publish({ version: name, actor: admin });
      const rowsBefore = rows(`SELECT * FROM gateway_price WHERE price_version = ? ORDER BY id`, name);
      await expectCode(
        priceBook().putDraft({ version: name, effectiveFrom: t, effectiveTo: null, rates: textRates(8, 8), actor: admin }),
        "GATEWAY_PRICE_VERSION_PUBLISHED",
      );
      await expectCode(priceBook().publish({ version: name, actor: admin }), "GATEWAY_PRICE_VERSION_PUBLISHED");
      expect(rows(`SELECT * FROM gateway_price WHERE price_version = ? ORDER BY id`, name)).toEqual(rowsBefore);
    });

    it("answers every refusal with a coded error and writes nothing", async () => {
      const audits = () => row<{ n: number }>(`SELECT COUNT(*) AS n FROM gateway_admin_audit`)!.n;
      const before = audits();
      await expectCode(priceBook().publish({ version: "missing", actor: admin }), "GATEWAY_PRICE_VERSION_NOT_FOUND");
      await expectCode(
        priceBook().putDraft({ version: version("w"), effectiveFrom: t, effectiveTo: t, rates: textRates(1, 1), actor: admin }),
        "GATEWAY_PRICE_WINDOW_INVALID",
      );
      const blocked = await expectCode(
        priceBook().putDraft({
          version: version("ds"),
          effectiveFrom: t,
          effectiveTo: null,
          rates: [{ modelCode: "deepseek-v4-pro", upstreamId: "", unit: "input_token", microCredits: 1, per: 1 }],
          actor: admin,
        }),
        "GATEWAY_PRICE_MODEL_BLOCKED",
      );
      expect(blocked.details).toMatchObject({ modelCode: "deepseek-v4-pro" });
      const ended = version("ended");
      await priceBook().putDraft({ version: ended, effectiveFrom: t, effectiveTo: t + 1_000, rates: textRates(1, 1), actor: admin });
      t += 5_000;
      await expectCode(priceBook().publish({ version: ended, actor: admin }), "GATEWAY_PRICE_WINDOW_INVALID");
      expect((await priceBook().read(ended)).status).toBe("draft");
      // Only the successful draft of `ended` was audited.
      expect(audits()).toBe(before + 1);
    });

    it("lists versions newest effective first, filtered by model and status", async () => {
      const name = version("listed");
      await priceBook().putDraft({ version: name, effectiveFrom: t + 500_000, effectiveTo: null, rates: textRates(1, 1), actor: admin });
      const drafts = await priceBook().list({ status: "draft" });
      expect(drafts.every((entry) => entry.status === "draft")).toBe(true);
      expect(drafts.map((entry) => entry.version)).toContain(name);
      const live = version("live");
      await priceBook().putDraft({ version: live, effectiveFrom: t, effectiveTo: null, rates: textRates(1, 1), actor: admin });
      await priceBook().publish({ version: live, actor: admin });
      const published = await priceBook().list({ status: "published", modelCode: model });
      expect(published.map((entry) => entry.version)).toEqual([live]);
      const all = await priceBook().list();
      const starts = all.map((entry) => Date.parse(entry.effectiveFrom));
      expect(starts).toEqual([...starts].sort((a, b) => b - a));
    });
  });

  describe("settled usage is never repriced", () => {
    it("keeps each settle row on the version it was charged under", async () => {
      const caller = await gateway.tenantToken();
      t += 60_000;
      const cheap = version("cheap");
      await priceBook().putDraft({
        version: cheap,
        effectiveFrom: t,
        effectiveTo: null,
        rates: textRates(1, 2, gateway.textModel),
        actor: admin,
      });
      await priceBook().publish({ version: cheap, actor: admin });
      const first = await settled(await chat(caller.token));
      expect(new Set(first.map((entry) => entry.price_version))).toEqual(new Set([cheap]));
      const firstRows = rows(`SELECT * FROM gateway_usage_ledger WHERE kind = 'settle' ORDER BY id`);

      t += 10_000;
      const dear = version("dear");
      await priceBook().putDraft({
        version: dear,
        effectiveFrom: t,
        effectiveTo: null,
        rates: textRates(10, 20, gateway.textModel),
        actor: admin,
      });
      await priceBook().publish({ version: dear, actor: admin });
      expect(rows(`SELECT * FROM gateway_usage_ledger WHERE kind = 'settle' ORDER BY id`).slice(0, firstRows.length)).toEqual(firstRows);

      const second = await settled(await chat(caller.token));
      expect(new Set(second.map((entry) => entry.price_version))).toEqual(new Set([dear]));
      expect(second[0]!.amount_micro_credits).toBeGreaterThan(first[0]!.amount_micro_credits);
    });
  });

  describe("purchases", () => {
    async function tenant(kind: "personal" | "team" = "team") {
      const tenantId = `${kind}:${hex(6)}`;
      const ownerId = `owner-${hex(4)}`;
      sqlite.prepare(`INSERT INTO tenant (id, owner_user_id, name, kind) VALUES (?, ?, 'Team', ?)`).run(tenantId, ownerId, kind);
      sqlite.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role) VALUES (?, ?, 'owner')`).run(tenantId, ownerId);
      return { tenantId, ownerId, owner: { kind: "user", id: ownerId, role: "owner" } as BillingActor };
    }
    const pack = (microCredits = credits(20)) =>
      billing().createTopupPack({ name: "Pack", priceMinor: 1000, priceCurrency: "USD", microCredits }, admin);
    const monthly = (periodMicroCredits = credits(10)) =>
      billing().createPackage(
        { name: "Monthly", billingPeriod: "month", priceMinor: 2000, priceCurrency: "USD", periodMicroCredits, rateLimit: { requestsPerMinute: 30 } },
        admin,
      );
    const entries = (tenantId: string, kind: string) =>
      rows<{ request_id: string; amount_micro_credits: number }>(
        `SELECT request_id, amount_micro_credits FROM gateway_usage_ledger WHERE tenant_id = ? AND kind = ? ORDER BY occurred_at, request_id`,
        tenantId,
        kind,
      );

    it("tops up the tenant wallet once per idempotency key", async () => {
      const { tenantId, owner } = await tenant();
      const p = await pack();
      expect(wallet(tenantId)).toBeUndefined();
      const first = await billing().topup({ tenantId, packId: p.id, idempotencyKey: "order-1", actor: owner });
      expect(first.replayed).toBe(false);
      expect(first.entry).toMatchObject({ kind: "topup", amountMicroCredits: p.microCredits, refKind: "topup_pack", refId: p.id });
      expect(first.wallet.limitMicroCredits).toBe(p.microCredits);
      const replay = await billing().topup({ tenantId, packId: p.id, idempotencyKey: "order-1", actor: owner });
      expect(replay).toMatchObject({ replayed: true, entry: first.entry });
      expect(wallet(tenantId)!.limit_micro_credits).toBe(p.microCredits);
      expect(entries(tenantId, "topup")).toHaveLength(1);
      const other = await pack(credits(5));
      await expectCode(
        billing().topup({ tenantId, packId: other.id, idempotencyKey: "order-1", actor: owner }),
        "GATEWAY_IDEMPOTENCY_CONFLICT",
      );
      await billing().topup({ tenantId, packId: other.id, idempotencyKey: "order-2", actor: owner });
      expect(wallet(tenantId)!.limit_micro_credits).toBe(p.microCredits + other.microCredits);
      expect(row<{ n: number }>(`SELECT COUNT(*) AS n FROM gateway_admin_audit WHERE tenant_id = ? AND action = 'wallet.topup'`, tenantId)!.n).toBe(2);
    });

    it("funds the team wallet and leaves owner-allocated member budgets alone", async () => {
      const { tenantId, owner, ownerId } = await tenant("team");
      const memberId = `member-${hex(4)}`;
      sqlite.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role) VALUES (?, ?, 'member')`).run(tenantId, memberId);
      const memberBudget = `gwb_m_${hex(4)}`;
      sqlite
        .prepare(
          `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, allocated_by_user_id, limit_micro_credits)
           VALUES (?, ?, 'user', ?, ?, ?)`,
        )
        .run(memberBudget, tenantId, memberId, ownerId, credits(3));
      const p = await pack();
      const { wallet: funded } = await billing().topup({ tenantId, packId: p.id, idempotencyKey: "team-1", actor: owner });
      sqlite.prepare(`UPDATE gateway_budget SET parent_budget_id = ? WHERE id = ?`).run(funded.budgetId, memberBudget);
      const member = () => row<WalletRow>(`SELECT id, limit_micro_credits, spent_micro_credits, reserved_micro_credits FROM gateway_budget WHERE id = ?`, memberBudget)!;
      expect(member().limit_micro_credits).toBe(credits(3));

      // A member's request draws on the team wallet and their own budget together.
      const parentId = `parent-${hex(4)}`;
      sqlite
        .prepare(`INSERT INTO api_token (id, user_id, name, token_hash, token_prefix) VALUES (?, ?, 'gw', ?, 'clsh_gw')`)
        .run(parentId, memberId, await sha256Hex(`clsh_${hex(20)}`));
      const minted = await createGatewayTokenStore(d1, { clock }).mint({
        userId: memberId,
        parent: { kind: "api_token", id: parentId },
        tenantId,
      });
      const charged = await settled(await chat(minted.token));
      expect(charged.map((entry) => entry.budget_id).sort()).toEqual([funded.budgetId, memberBudget].sort());
      const cost = charged[0]!.amount_micro_credits;
      expect(wallet(tenantId)).toMatchObject({ limit_micro_credits: p.microCredits, spent_micro_credits: cost });
      expect(member()).toMatchObject({ limit_micro_credits: credits(3), spent_micro_credits: cost });
    });

    it("refuses with coded errors and writes nothing", async () => {
      const { tenantId, owner } = await tenant();
      const p = await pack();
      const ledgerCount = () => row<{ n: number }>(`SELECT COUNT(*) AS n FROM gateway_usage_ledger WHERE tenant_id = ?`, tenantId)!.n;
      await expectCode(billing().topup({ tenantId: "missing", packId: p.id, idempotencyKey: "k", actor: admin }), "GATEWAY_TENANT_NOT_FOUND");
      await expectCode(billing().topup({ tenantId, packId: "nope", idempotencyKey: "k", actor: owner }), "GATEWAY_TOPUP_PACK_NOT_FOUND");
      await expectCode(billing().subscribe({ tenantId, packageId: "nope", idempotencyKey: "k", actor: owner }), "GATEWAY_PACKAGE_NOT_FOUND");
      const archived = await billing().archiveTopupPack((await pack()).id, admin);
      expect(archived.status).toBe("archived");
      expect((await billing().archiveTopupPack(archived.id, admin)).status).toBe("archived");
      await expectCode(billing().topup({ tenantId, packId: archived.id, idempotencyKey: "k", actor: owner }), "GATEWAY_TOPUP_PACK_ARCHIVED");
      const archivedPackage = await billing().archivePackage((await monthly()).id, admin);
      await expectCode(
        billing().subscribe({ tenantId, packageId: archivedPackage.id, idempotencyKey: "k", actor: owner }),
        "GATEWAY_PACKAGE_ARCHIVED",
      );
      await expectCode(billing().cancelSubscription({ tenantId, actor: owner }), "GATEWAY_SUBSCRIPTION_NOT_FOUND");

      // An unlimited or periodic wallet cannot hold purchased credits.
      sqlite
        .prepare(`INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits) VALUES (?, ?, 'tenant', ?, NULL)`)
        .run(`gwb_${hex(4)}`, tenantId, tenantId);
      const unlimited = await expectCode(
        billing().topup({ tenantId, packId: p.id, idempotencyKey: "k", actor: owner }),
        "GATEWAY_WALLET_INCOMPATIBLE",
      );
      expect(unlimited.details).toMatchObject({ reason: "unlimited" });
      sqlite.prepare(`UPDATE gateway_budget SET limit_micro_credits = 0, period = 'monthly' WHERE tenant_id = ?`).run(tenantId);
      await expectCode(billing().topup({ tenantId, packId: p.id, idempotencyKey: "k", actor: owner }), "GATEWAY_WALLET_INCOMPATIBLE");
      await expectCode(
        billing().subscribe({ tenantId, packageId: (await monthly()).id, idempotencyKey: "k", actor: owner }),
        "GATEWAY_WALLET_INCOMPATIBLE",
      );
      expect(ledgerCount()).toBe(0);
      expect(row<{ n: number }>(`SELECT COUNT(*) AS n FROM gateway_tenant_subscription WHERE tenant_id = ?`, tenantId)!.n).toBe(0);
      expect(row<{ n: number }>(`SELECT COUNT(*) AS n FROM gateway_admin_audit WHERE tenant_id = ?`, tenantId)!.n).toBe(0);
    });

    it("grants the first period on subscribe, once per idempotency key, one live subscription per tenant", async () => {
      const { tenantId, owner } = await tenant();
      const pkg = await monthly();
      const first = await billing().subscribe({ tenantId, packageId: pkg.id, idempotencyKey: "sub-1", actor: owner });
      expect(first.replayed).toBe(false);
      expect(first.subscription).toMatchObject({ tenantId, packageId: pkg.id, status: "active", cancelAt: null });
      expect(first.entry).toMatchObject({ kind: "grant", amountMicroCredits: pkg.periodMicroCredits, refId: first.subscription!.id });
      expect(first.wallet.limitMicroCredits).toBe(pkg.periodMicroCredits);
      // The package's rate limits apply to the tenant while subscribed.
      expect(row<{ rate_limit_json: string }>(`SELECT rate_limit_json FROM gateway_tenant_subscription WHERE id = ?`, first.subscription!.id))
        .toEqual({ rate_limit_json: JSON.stringify(pkg.rateLimit) });

      const replay = await billing().subscribe({ tenantId, packageId: pkg.id, idempotencyKey: "sub-1", actor: owner });
      expect(replay).toMatchObject({ replayed: true, entry: first.entry, subscription: first.subscription });
      await expectCode(
        billing().subscribe({ tenantId, packageId: (await monthly()).id, idempotencyKey: "sub-1", actor: owner }),
        "GATEWAY_IDEMPOTENCY_CONFLICT",
      );
      await expectCode(billing().subscribe({ tenantId, packageId: pkg.id, idempotencyKey: "sub-2", actor: owner }), "GATEWAY_SUBSCRIPTION_EXISTS");
      expect(entries(tenantId, "grant")).toHaveLength(1);
      expect(wallet(tenantId)!.limit_micro_credits).toBe(pkg.periodMicroCredits);
    });

    it("rolls a period over: expires the unconsumed grant, grants the next period, and is idempotent", async () => {
      const caller = await gateway.tenantToken();
      const pkg = await monthly();
      const sub = await billing().subscribe({ tenantId: caller.tenantId, packageId: pkg.id, idempotencyKey: "roll", actor: admin });
      const start = wallet(caller.tenantId)!;
      t += 10_000;
      const spend = await settled(await chat(caller.token));
      const spentInPeriod = spend.find((entry) => entry.budget_id === start.id)!.amount_micro_credits;

      // Not due yet: nothing happens.
      expect(await billing().rollover({ actor: admin, tenantId: caller.tenantId })).toEqual([]);

      t = Date.parse(sub.subscription!.currentPeriodEnd) + 1_000;
      const [outcome] = await billing().rollover({ actor: admin, tenantId: caller.tenantId });
      expect(outcome).toMatchObject({ subscriptionId: sub.subscription!.id, periodsClosed: 1, status: "active" });
      expect(outcome!.error).toBeUndefined();
      const expired = entries(caller.tenantId, "expire");
      expect(expired).toHaveLength(1);
      expect(expired[0]!.amount_micro_credits).toBe(pkg.periodMicroCredits - spentInPeriod);
      const grants = entries(caller.tenantId, "grant");
      expect(grants).toHaveLength(2);
      const after = wallet(caller.tenantId)!;
      expect(after.limit_micro_credits).toBe(
        start.limit_micro_credits! - expired[0]!.amount_micro_credits + grants[1]!.amount_micro_credits,
      );
      const renewed = (await billing().walletSummary(caller.tenantId)).subscription!;
      expect(renewed.currentPeriodStart).toBe(sub.subscription!.currentPeriodEnd);

      // Repeating the call closes nothing more.
      expect(await billing().rollover({ actor: admin, tenantId: caller.tenantId })).toEqual([]);
      expect(entries(caller.tenantId, "expire")).toHaveLength(1);
      expect(wallet(caller.tenantId)).toEqual(after);
    });

    it("never expires credits that back an open hold", async () => {
      const caller = await gateway.tenantToken();
      const pkg = await monthly();
      const sub = await billing().subscribe({ tenantId: caller.tenantId, packageId: pkg.id, idempotencyKey: "hold", actor: admin });
      const funded = wallet(caller.tenantId)!;
      const keep = credits(1);
      await ports.budgets.reserve({
        requestId: `gwr_hold_${hex(4)}`,
        tenantId: caller.tenantId,
        budgetIds: [funded.id],
        holdMicroCredits: funded.limit_micro_credits! - funded.spent_micro_credits - keep,
        expiresAt: t + 60_000,
      });
      t = Date.parse(sub.subscription!.currentPeriodEnd) + 1_000;
      const [outcome] = await billing().rollover({ actor: admin, tenantId: caller.tenantId });
      expect(outcome!.expiredMicroCredits).toBe(keep);
      const after = wallet(caller.tenantId)!;
      expect(after.limit_micro_credits! - after.spent_micro_credits - after.reserved_micro_credits).toBe(
        outcome!.grantedMicroCredits,
      );
    });

    it("ends a canceled subscription at its period end without a further grant", async () => {
      const { tenantId, owner } = await tenant();
      const pkg = await monthly();
      const sub = await billing().subscribe({ tenantId, packageId: pkg.id, idempotencyKey: "cancel", actor: owner });
      const canceled = await billing().cancelSubscription({ tenantId, actor: owner });
      expect(canceled.cancelAt).toBe(sub.subscription!.currentPeriodEnd);
      expect(await billing().cancelSubscription({ tenantId, actor: owner })).toEqual(canceled);
      t = Date.parse(sub.subscription!.currentPeriodEnd) + 1_000;
      const [outcome] = await billing().rollover({ actor: admin, tenantId });
      expect(outcome).toMatchObject({ subscriptionId: sub.subscription!.id, status: "expired", grantedMicroCredits: 0 });
      expect(entries(tenantId, "expire")).toEqual([
        { request_id: expect.any(String), amount_micro_credits: pkg.periodMicroCredits },
      ]);
      expect(entries(tenantId, "grant")).toHaveLength(1);
      expect(wallet(tenantId)!.limit_micro_credits).toBe(0);
      expect((await billing().walletSummary(tenantId)).subscription).toBeNull();
      // A new subscription is allowed once the old one ended.
      await billing().subscribe({ tenantId, packageId: pkg.id, idempotencyKey: "again", actor: owner });
    });

    it("catches up on several missed periods in one call", async () => {
      const { tenantId, owner } = await tenant();
      const pkg = await monthly();
      const sub = await billing().subscribe({ tenantId, packageId: pkg.id, idempotencyKey: "late", actor: owner });
      t = Date.parse(sub.subscription!.currentPeriodStart) + 100 * 24 * 3600 * 1000;
      const [outcome] = await billing().rollover({ actor: admin, tenantId });
      const live = (await billing().walletSummary(tenantId)).subscription!;
      expect(Date.parse(live.currentPeriodStart)).toBeLessThanOrEqual(t);
      expect(Date.parse(live.currentPeriodEnd)).toBeGreaterThan(t);
      expect(entries(tenantId, "expire")).toHaveLength(outcome!.periodsClosed);
      expect(entries(tenantId, "grant")).toHaveLength(outcome!.periodsClosed + 1);
      // Only the current period's grant remains spendable.
      expect(wallet(tenantId)!.limit_micro_credits).toBe(pkg.periodMicroCredits);
    });
  });
});
