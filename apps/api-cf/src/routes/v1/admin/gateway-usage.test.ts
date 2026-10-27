/**
 * Usage explorer, retention and nightly reconciliation (#355) through the
 * Worker app on node:sqlite with every migration applied (0052 included):
 *
 * - the explorer filters by tenant, user, key, model, status and time, pages
 *   by cursor without gaps or repeats, shows one settle entry per request, and
 *   exports the same filter as CSV (platform: admin accounts; teams: owner for
 *   the tenant, member for themselves, never the upstream);
 * - a failed media/AIGC request settles at zero and shows as "not charged";
 * - retention clears operational metadata after 30 days and deletes ledger,
 *   audit and reconciliation rows after 13 months, never a live hold;
 * - reconciliation values each difference against the price book and posts
 *   platform `adjust` rows idempotently, records a missing report as such,
 *   and is audited; the scheduled handler runs both jobs at their minutes.
 *
 * Ledger rows are written through the real D1 budget port (`charge` for text
 * postpay; a failed media probe may charge zero so the explorer marks it
 * notCharged — prepaid debit+refund is covered by d1-gateway / settle-run
 * tests). Expected amounts come from gateway-core's priceUsage, never restated.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("../../../containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));

import {
  GATEWAY_LEDGER_RETENTION_MS,
  GATEWAY_METADATA_RETENTION_MS,
  GATEWAY_RECONCILE_UTC_MINUTE_OF_DAY,
  GATEWAY_RETENTION_ENFORCE_MINUTE,
  GATEWAY_USAGE_EXPORT_MAX_ROWS,
  ledgerStatus,
  priceUsage,
  reconcileGatewayUsageDay,
  settleRequest,
  usageExportColumns,
  type GatewayLogger,
  type GatewayPrice,
  type Usage,
  type UsageEvent,
} from "@clash/gateway-core";

import { createApp } from "../../../app";
import { createSqliteD1 } from "../../../../../web/app/test-support/sqlite-d1";
import { createD1GatewayBudgetPorts } from "../../../gateway/d1-budgets";
import {
  createD1ReconciliationPort,
  reconcileGatewayUsageNightly,
  reconcileRunIds,
} from "../../../gateway/d1-reconciliation";
import { enforceGatewayDataRetention } from "../../../gateway/d1-retention";
import { publishedPriceAt } from "../../../gateway/d1-routes";
import { runScheduledGatewayUsageJobs } from "../../../gateway/scheduled";
import { signedInAdmin } from "../../../services/admin-session.test-support";

const ORIGIN = "http://localhost:8789";
const { d1, sqlite } = createSqliteD1();
const app = createApp();

const DAY_MS = 86_400_000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const seconds = (ms: number) => Math.floor(ms / 1000);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Noon UTC `n` days ago: inside an ended day that is still within the metadata window. */
const noonDaysAgo = (n: number) => Date.parse(`${utcDay(Date.now() - n * DAY_MS)}T12:00:00.000Z`);

const env = {
  DB: d1,
  ENVIRONMENT: "test",
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "test-secret-for-gateway-usage-0123456789",
};

const silent: GatewayLogger = { info() {}, warn() {}, error() {} };

function user() {
  const userId = `user-${hex()}`;
  const raw = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  sqlite
    .prepare("INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, 'gw', ?, 'clsh_gw', 1)")
    .run(`tok-${hex()}`, userId, sha256(raw));
  return { userId, auth: { authorization: `Bearer ${raw}` } };
}

const platformAdmin = await signedInAdmin(app, env, ORIGIN);

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env as never,
  );
}

async function expectCode(res: Response, status: number, code: string) {
  const text = await res.clone().text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("x-clash-error-code"), text).toBe(code);
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

/** A team with an owner, a member and a tenant budget the ledger can hold on. */
function team() {
  const tenantId = `team:${hex()}`;
  const owner = user();
  const member = user();
  sqlite.prepare(`INSERT INTO tenant (id, owner_user_id, name, kind) VALUES (?, ?, 'Team', 'team')`).run(tenantId, owner.userId);
  sqlite.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role) VALUES (?, ?, 'owner')`).run(tenantId, owner.userId);
  sqlite.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role) VALUES (?, ?, 'member')`).run(tenantId, member.userId);
  const budgetId = `gwb_${hex()}`;
  sqlite
    .prepare(`INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits) VALUES (?, ?, 'tenant', ?, NULL)`)
    .run(budgetId, tenantId, tenantId);
  const enc = encodeURIComponent(tenantId);
  return { tenantId, owner, member, budgetId, enc, product: `/api/v1/gateway/tenants/${enc}` };
}

const { budgets } = createD1GatewayBudgetPorts(d1, { clock: { now: () => Date.now() } });

function usage(partial: Partial<Usage> = {}): Usage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, units: {}, source: "reported", ...partial };
}

/** One request through the real budget port: a postpaid `charge` on `budgetIds`. */
async function settle(
  t: { tenantId: string; budgetId: string },
  event: Partial<UsageEvent> & { userId: string; modelCode: string },
  options: { budgetIds?: string[] } = {},
): Promise<string> {
  const requestId = event.requestId ?? `gwr_${hex()}${hex()}`;
  await budgets.charge({
    requestId,
    tenantId: t.tenantId,
    kind: "text",
    upstreamId: "openai",
    credentialScope: "official",
    usage: usage(),
    costMicroCredits: 0,
    priceVersion: "p-test",
    catalogVersion: "c-test",
    status: "settled",
    occurredAt: Date.now(),
    ...event,
    budgetIds: options.budgetIds ?? [t.budgetId],
  });
  return requestId;
}

interface ExplorerEntry {
  id: string;
  requestId: string;
  kind: string;
  status: string;
  tenantId: string;
  userId: string | null;
  keyId: string | null;
  modelCode: string | null;
  amountMicroCredits: number;
  chargeMicroCredits: number;
  notCharged: boolean;
  upstreamId: string | null;
  refKind: string | null;
  refId: string | null;
}
interface ExplorerPage {
  entries: ExplorerEntry[];
  byModel: Array<{ modelCode: string; requests: number; amountMicroCredits: number; notCharged: number }>;
  nextCursor: string | null;
}

const explore = async (query: string, auth = platformAdmin.auth) =>
  json<ExplorerPage>(await call("GET", `/api/v1/admin/gateway/usage?${query}`, auth));

/** RFC 4180 rows of a CSV body (no quoted line breaks in these fixtures). */
function csvRows(text: string): string[][] {
  return text
    .split("\r\n")
    .filter(Boolean)
    .map((line) => line.match(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)!.slice(0, -1).map((cell) => cell.replace(/,$/, "")));
}

describe("usage explorer", () => {
  it("filters by tenant, user, key, model, status and time, one settle entry per request", async () => {
    const t = team();
    const other = team();
    const model = `test-model-${hex()}`;
    const second = `gwb_${hex()}`;
    sqlite
      .prepare(`INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits) VALUES (?, ?, 'user', ?, NULL)`)
      .run(second, t.tenantId, t.member.userId);
    const old = Date.now() - 3 * 60 * 60 * 1000;
    // Settled on two budgets: two settle rows, one request.
    const twoBudgets = await settle(
      t,
      { userId: t.member.userId, keyId: "gwk_a", modelCode: model, costMicroCredits: 700, usage: usage({ inputTokens: 7 }) },
      { budgetIds: [t.budgetId, second] },
    );
    const keyB = await settle(t, { userId: t.owner.userId, keyId: "gwk_b", modelCode: model, costMicroCredits: 300 });
    const earlier = await settle(t, { userId: t.owner.userId, modelCode: `${model}-x`, costMicroCredits: 100, occurredAt: old });
    const failed = await settle(t, { userId: t.member.userId, modelCode: model, status: "upstream_failed", errorCode: "GATEWAY_UPSTREAM_ERROR" });
    await settle(other, { userId: other.owner.userId, modelCode: model, costMicroCredits: 999 });

    const all = await explore(`tenantId=${t.enc}&kind=settle`);
    expect(all.entries.map((entry) => entry.requestId).sort()).toEqual([twoBudgets, keyB, earlier, failed].sort());
    expect(all.entries.every((entry) => entry.tenantId === t.tenantId)).toBe(true);
    const byModel = all.byModel.find((row) => row.modelCode === model)!;
    expect(byModel).toMatchObject({ requests: 3, amountMicroCredits: 1_000, notCharged: 1 });

    expect((await explore(`tenantId=${t.enc}&userId=${t.member.userId}`)).entries.map((e) => e.requestId).sort()).toEqual([twoBudgets, failed].sort());
    expect((await explore(`tenantId=${t.enc}&keyId=gwk_b`)).entries.map((e) => e.requestId)).toEqual([keyB]);
    expect((await explore(`tenantId=${t.enc}&modelCode=${model}-x`)).entries.map((e) => e.requestId)).toEqual([earlier]);
    expect((await explore(`tenantId=${t.enc}&status=upstream_failed`)).entries.map((e) => e.requestId)).toEqual([failed]);
    const window = `from=${encodeURIComponent(new Date(old - 1000).toISOString())}&to=${encodeURIComponent(new Date(old + 1000).toISOString())}`;
    expect((await explore(`tenantId=${t.enc}&${window}`)).entries.map((e) => e.requestId)).toEqual([earlier]);
    // Without a kind: everything but holds and releases; with one, only it.
    // New requests write no holds (#399); seed one historical row so the filter is covered.
    sqlite
      .prepare(
        `INSERT INTO gateway_usage_ledger
           (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits, occurred_at)
         VALUES (?, ?, ?, 'hold', 'expired', ?, 0, strftime('%s', 'now'))`,
      )
      .run(`gwl_hold_${hex()}`, `gwr_hold_${hex()}`, t.budgetId, t.tenantId);
    expect((await explore(`tenantId=${t.enc}`)).entries.every((e) => e.kind !== "hold" && e.kind !== "release")).toBe(true);
    expect((await explore(`tenantId=${t.enc}&kind=hold`)).entries.length).toBeGreaterThan(0);

    await expectCode(await call("GET", `/api/v1/admin/gateway/usage?tenantId=${t.enc}&to=${encodeURIComponent(new Date(old).toISOString())}&from=${encodeURIComponent(new Date(old).toISOString())}`, platformAdmin.auth), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await call("GET", `/api/v1/admin/gateway/usage?cursor=bm90LWEtY3Vyc29y`, platformAdmin.auth), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await call("GET", `/api/v1/admin/gateway/usage?tenantId=${t.enc}`, t.owner.auth), 403, "GATEWAY_ADMIN_SESSION_REQUIRED");
  });

  it("pages newest first by cursor without gaps or repeats", async () => {
    const t = team();
    const model = `page-model-${hex()}`;
    const at = Date.now() - 60_000;
    const ids: string[] = [];
    // Several in the same second, so the cursor's id tiebreak matters.
    for (let index = 0; index < 7; index += 1)
      ids.push(await settle(t, { userId: t.owner.userId, modelCode: model, costMicroCredits: 1, occurredAt: at + (index % 2) * 1000 }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ExplorerPage = await explore(`tenantId=${t.enc}&kind=settle&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.entries.length).toBeLessThanOrEqual(3);
      seen.push(...page.entries.map((entry) => entry.requestId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen.sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
  });

  it("shows a failed media/AIGC request at zero (notCharged) and charges a partial text request", async () => {
    const t = team();
    // Settled as the data plane settles them (gateway-core settleRequest), at
    // a price under which the produced image and the delivered tokens are not free.
    const price: GatewayPrice = {
      modelCode: "any",
      version: "p-test",
      rates: [
        { unit: "image", microCredits: 20_000, per: 1 },
        { unit: "output_token", microCredits: 14, per: 1 },
      ],
    };
    const failedMedia = settleRequest({
      request: { protocol: "media" },
      outcome: "upstream_failed",
      usage: usage({ units: { image: 1 } }),
      price,
    });
    const partialText = settleRequest({
      request: { protocol: "openai-chat" },
      outcome: "partial",
      usage: usage({ outputTokens: 3, source: "estimated" }),
      price,
    });
    expect(priceUsage(usage({ units: { image: 1 } }), price).microCredits).toBeGreaterThan(0);
    const media = await settle(t, {
      userId: t.member.userId,
      modelCode: `image-${hex()}`,
      kind: "image",
      status: ledgerStatus(failedMedia.outcome),
      usage: failedMedia.usage,
      costMicroCredits: failedMedia.costMicroCredits,
      errorCode: "GATEWAY_UPSTREAM_ERROR",
    });
    const partial = await settle(t, {
      userId: t.member.userId,
      modelCode: `text-${hex()}`,
      status: ledgerStatus(partialText.outcome),
      costMicroCredits: partialText.costMicroCredits,
      usage: partialText.usage,
    });
    const { entries } = await explore(`tenantId=${t.enc}&kind=settle`);
    const failedEntry = entries.find((entry) => entry.requestId === media)!;
    expect(failedEntry).toMatchObject({ status: "upstream_failed", amountMicroCredits: 0, chargeMicroCredits: 0, notCharged: true });
    expect(entries.find((entry) => entry.requestId === partial)).toMatchObject({
      status: "partial",
      chargeMicroCredits: priceUsage(usage({ outputTokens: 3, source: "estimated" }), price).microCredits,
      notCharged: false,
    });
    // The team sees the same: zero, marked not charged.
    const teamView = await json<{ usage: Array<{ requestId: string; costMicroCredits: number; notCharged: boolean }> }>(
      await call("GET", `${t.product}/usage`, t.owner.auth),
    );
    expect(teamView.usage.find((entry) => entry.requestId === media)).toMatchObject({ costMicroCredits: 0, notCharged: true });
    const csv = csvRows(await (await call("GET", `/api/v1/admin/gateway/usage/export?tenantId=${t.enc}&kind=settle`, platformAdmin.auth)).text());
    const header = csv[0]!;
    const row = csv.find((cells) => cells[header.indexOf("request_id")] === media)!;
    expect(row[header.indexOf("charge_micro_credits")]).toBe("0");
    expect(row[header.indexOf("not_charged")]).toBe("true");
  });
});

describe("usage export", () => {
  it("exports the explorer filter as CSV with metadata only, formula cells neutralized", async () => {
    const t = team();
    const model = `csv-model-${hex()}`;
    const ids = [
      await settle(t, { userId: t.owner.userId, modelCode: model, costMicroCredits: 5 }),
      await settle(t, { userId: t.member.userId, modelCode: model, costMicroCredits: 6, errorCode: "=HYPERLINK(\"x\")" }),
    ];
    const res = await call("GET", `/api/v1/admin/gateway/usage/export?tenantId=${t.enc}&modelCode=${model}&kind=settle`, platformAdmin.auth);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="gateway-usage-team_[A-Za-z0-9._-]+-all-all\.csv"$/);
    expect(res.headers.get("x-gateway-export-rows")).toBe("2");
    const text = await res.text();
    const rows = csvRows(text);
    expect(rows[0]).toEqual(usageExportColumns("platform").map(([name]) => name));
    // Metadata only: no column can carry a prompt or response body.
    for (const name of rows[0]!) expect(name).not.toMatch(/prompt|body|content|message|response/);
    expect(rows.slice(1).map((cells) => cells[rows[0]!.indexOf("request_id")]).sort()).toEqual(ids.sort());
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);

    await expectCode(await call("GET", `/api/v1/admin/gateway/usage/export?tenantId=${t.enc}`, t.owner.auth), 403, "GATEWAY_ADMIN_SESSION_REQUIRED");
  });

  it("gives a team owner the tenant's export and a member only their own, never the upstream", async () => {
    const t = team();
    const model = `team-csv-${hex()}`;
    const ownerRequest = await settle(t, { userId: t.owner.userId, modelCode: model, costMicroCredits: 5, upstreamId: "openai" });
    const memberRequest = await settle(t, { userId: t.member.userId, modelCode: model, costMicroCredits: 6, upstreamId: "openai" });
    const tenantColumns = usageExportColumns("tenant").map(([name]) => name);
    expect(tenantColumns).not.toContain("upstream_id");

    const ownerCsv = csvRows(await (await call("GET", `${t.product}/usage/export?modelCode=${model}`, t.owner.auth)).text());
    expect(ownerCsv[0]).toEqual(tenantColumns);
    expect(ownerCsv.slice(1).map((cells) => cells[tenantColumns.indexOf("request_id")]).sort()).toEqual([ownerRequest, memberRequest].sort());

    await expectCode(await call("GET", `${t.product}/usage/export`, t.member.auth), 403, "GATEWAY_FORBIDDEN");
    await expectCode(await call("GET", `${t.product}/usage`, t.member.auth), 403, "GATEWAY_FORBIDDEN");
    // A member's own routes pin the user, whatever the query asks for.
    const own = csvRows(await (await call("GET", `${t.product}/me/usage/export?userId=${t.owner.userId}`, t.member.auth)).text());
    expect(own.slice(1).map((cells) => cells[tenantColumns.indexOf("request_id")])).toEqual([memberRequest]);
    const ownPage = await json<{ usage: Array<{ requestId: string; userId: string }>; nextCursor: string | null }>(
      await call("GET", `${t.product}/me/usage?userId=${t.owner.userId}`, t.member.auth),
    );
    expect(ownPage.usage.map((entry) => entry.requestId)).toEqual([memberRequest]);
    expect(JSON.stringify(ownPage)).not.toContain("upstream");

    // The owner filters the team view by member and pages it.
    const filtered = await json<{ usage: Array<{ requestId: string }>; nextCursor: string | null }>(
      await call("GET", `${t.product}/usage?userId=${t.member.userId}&limit=1`, t.owner.auth),
    );
    expect(filtered.usage.map((entry) => entry.requestId)).toEqual([memberRequest]);
    expect(filtered.nextCursor).toBeNull();
    const outsider = user();
    await expectCode(await call("GET", `${t.product}/me/usage/export`, outsider.auth), 403, "GATEWAY_FORBIDDEN");
  });

  it("refuses an export larger than one download before sending a byte", async () => {
    const tenantId = `team:big-${hex()}`;
    const insert = sqlite.prepare(
      `INSERT INTO gateway_usage_ledger (id, request_id, kind, status, tenant_id, amount_micro_credits, occurred_at)
       VALUES (?, ?, 'settle', 'settled', ?, 1, ?)`,
    );
    const at = seconds(Date.now());
    sqlite.exec("BEGIN");
    for (let index = 0; index <= GATEWAY_USAGE_EXPORT_MAX_ROWS; index += 1) insert.run(`big_${tenantId}_${index}`, `big_${tenantId}_${index}`, tenantId, at);
    sqlite.exec("COMMIT");
    await expectCode(
      await call("GET", `/api/v1/admin/gateway/usage/export?tenantId=${encodeURIComponent(tenantId)}`, platformAdmin.auth),
      413,
      "GATEWAY_EXPORT_TOO_LARGE",
    );
    sqlite.prepare(`DELETE FROM gateway_usage_ledger WHERE tenant_id = ?`).run(tenantId);
  });
});

describe("retention", () => {
  const count = (sql: string, ...args: unknown[]) => (sqlite.prepare(sql).get(...(args as never[])) as { n: number }).n;

  it("clears metadata after 30 days, deletes after 13 months, keeps live holds, audited only when it changed something", async () => {
    const now = Date.now();
    const tenantId = `team:ret-${hex()}`;
    const metaOld = seconds(now - GATEWAY_METADATA_RETENTION_MS - DAY_MS);
    const ledgerOld = seconds(now - GATEWAY_LEDGER_RETENTION_MS - DAY_MS);
    const recent = seconds(now - DAY_MS);
    const ledger = sqlite.prepare(
      `INSERT INTO gateway_usage_ledger (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits, model_code,
         input_tokens, upstream_id, account_id, provider_request_id, error_code, occurred_at)
       VALUES (?, ?, 'b', ?, ?, ?, 10, 'm', 5, 'openai', 'acct', 'prov-1', 'GATEWAY_UPSTREAM_ERROR', ?)`,
    );
    ledger.run(`${tenantId}:meta`, `${tenantId}:meta`, "settle", "settled", tenantId, metaOld);
    ledger.run(`${tenantId}:gone`, `${tenantId}:gone`, "settle", "settled", tenantId, ledgerOld);
    ledger.run(`${tenantId}:live`, `${tenantId}:live`, "hold", "open", tenantId, ledgerOld);
    ledger.run(`${tenantId}:recent`, `${tenantId}:recent`, "settle", "settled", tenantId, recent);
    const token = sqlite.prepare(`INSERT INTO gateway_token (id, token_hash, tenant_id, user_id, expires_at, revoked_at) VALUES (?, ?, ?, 'u', ?, ?)`);
    token.run(`${tenantId}:tok-ended`, sha256(`${tenantId}a`), tenantId, metaOld, null);
    token.run(`${tenantId}:tok-revoked`, sha256(`${tenantId}b`), tenantId, seconds(now + DAY_MS), metaOld);
    token.run(`${tenantId}:tok-live`, sha256(`${tenantId}c`), tenantId, seconds(now + DAY_MS), null);
    const invite = sqlite.prepare(
      `INSERT INTO tenant_invite (id, tenant_id, email, role, token_hash, invited_by_user_id, status, expires_at, updated_at)
       VALUES (?, ?, 'x@example.com', 'member', ?, 'u', ?, ?, ?)`,
    );
    invite.run(`${tenantId}:inv-accepted`, tenantId, sha256(`${tenantId}i1`), "accepted", seconds(now + DAY_MS), metaOld);
    invite.run(`${tenantId}:inv-pending`, tenantId, sha256(`${tenantId}i2`), "pending", seconds(now + DAY_MS), metaOld);
    sqlite
      .prepare(
        `INSERT INTO gateway_upstream_report (id, day, source, groups, imported_at, imported_by) VALUES (?, ?, 'invoice', 0, ?, 'a')`,
      )
      .run(`${tenantId}:report`, utcDay(now - GATEWAY_LEDGER_RETENTION_MS - 2 * DAY_MS), ledgerOld);
    const audit = sqlite.prepare(
      `INSERT INTO gateway_admin_audit (id, tenant_id, actor_id, actor_kind, action, target_type, target_id, occurred_at)
       VALUES (?, ?, 'a', 'admin', 'test', 'test', 't', ?)`,
    );
    audit.run(`${tenantId}:audit-old`, tenantId, ledgerOld);
    audit.run(`${tenantId}:audit-recent`, tenantId, recent);

    for (const credential of [team().owner.auth, user().auth])
      await expectCode(await call("POST", "/api/v1/admin/gateway/retention/enforce", credential, {}), 403, "GATEWAY_ADMIN_SESSION_REQUIRED");

    const auditsBefore = count(`SELECT COUNT(*) AS n FROM gateway_admin_audit WHERE action = 'retention.enforce'`);
    const first = await json<{ retention: Record<string, number | boolean> }>(
      await call("POST", "/api/v1/admin/gateway/retention/enforce", platformAdmin.auth, {}),
    );
    expect(first.retention.ledgerMetadataCleared).toBeGreaterThan(0);
    expect(first.retention.ledgerDeleted).toBeGreaterThan(0);

    const rows = sqlite
      .prepare(`SELECT id, amount_micro_credits, input_tokens, model_code, upstream_id, account_id, provider_request_id, error_code FROM gateway_usage_ledger WHERE tenant_id = ? ORDER BY id`)
      .all(tenantId) as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.id)).toEqual([`${tenantId}:live`, `${tenantId}:meta`, `${tenantId}:recent`]);
    // Past 30 days: operational columns gone, money and counts kept.
    expect(rows[1]).toEqual({
      id: `${tenantId}:meta`,
      amount_micro_credits: 10,
      input_tokens: 5,
      model_code: "m",
      upstream_id: null,
      account_id: null,
      provider_request_id: null,
      error_code: null,
    });
    // A live hold and a recent row are untouched.
    expect(rows[0]).toMatchObject({ upstream_id: "openai", provider_request_id: "prov-1" });
    expect(rows[2]).toMatchObject({ upstream_id: "openai", provider_request_id: "prov-1" });
    expect((sqlite.prepare(`SELECT id FROM gateway_token WHERE tenant_id = ? ORDER BY id`).all(tenantId) as Array<{ id: string }>).map((row) => row.id)).toEqual([
      `${tenantId}:tok-live`,
    ]);
    expect((sqlite.prepare(`SELECT id FROM tenant_invite WHERE tenant_id = ?`).all(tenantId) as Array<{ id: string }>).map((row) => row.id)).toEqual([
      `${tenantId}:inv-pending`,
    ]);
    expect(count(`SELECT COUNT(*) AS n FROM gateway_upstream_report WHERE id = ?`, `${tenantId}:report`)).toBe(0);
    expect((sqlite.prepare(`SELECT id FROM gateway_admin_audit WHERE tenant_id = ?`).all(tenantId) as Array<{ id: string }>).map((row) => row.id)).toEqual([
      `${tenantId}:audit-recent`,
    ]);
    expect(count(`SELECT COUNT(*) AS n FROM gateway_admin_audit WHERE action = 'retention.enforce'`)).toBe(auditsBefore + 1);

    // Idempotent: nothing left to do, nothing audited.
    const second = await json<{ retention: Record<string, number | boolean> }>(
      await call("POST", "/api/v1/admin/gateway/retention/enforce", platformAdmin.auth, {}),
    );
    expect(Object.entries(second.retention).filter(([key, value]) => key !== "more" && value !== 0)).toEqual([]);
    expect(count(`SELECT COUNT(*) AS n FROM gateway_admin_audit WHERE action = 'retention.enforce'`)).toBe(auditsBefore + 1);
  });

  it("is bounded per run and reports that more is due", async () => {
    const tenantId = `team:bound-${hex()}`;
    const old = seconds(Date.now() - GATEWAY_METADATA_RETENTION_MS - DAY_MS);
    const insert = sqlite.prepare(
      `INSERT INTO gateway_usage_ledger (id, request_id, kind, status, tenant_id, amount_micro_credits, upstream_id, occurred_at)
       VALUES (?, ?, 'settle', 'settled', ?, 1, 'openai', ?)`,
    );
    for (let index = 0; index < 3; index += 1) insert.run(`${tenantId}:${index}`, `${tenantId}:${index}`, tenantId, old);
    const first = await enforceGatewayDataRetention(d1, { limit: 2 });
    expect(first).toMatchObject({ ledgerMetadataCleared: 2, more: true });
    const remaining = () => count(`SELECT COUNT(*) AS n FROM gateway_usage_ledger WHERE tenant_id = ? AND upstream_id IS NOT NULL`, tenantId);
    expect(remaining()).toBe(1);
    await enforceGatewayDataRetention(d1, { limit: 2 });
    expect(remaining()).toBe(0);
  });
});

// ─── Reconciliation ───────────────────────────────────────────────────────

/** An official upstream account and a published credit price for a fresh model on it. */
function upstreamFixture() {
  const upstreamId = `up-${hex()}`;
  const accountId = `gwu_${hex()}`;
  const modelCode = `rec-model-${hex()}`;
  sqlite
    .prepare(`INSERT INTO gateway_upstream_account (id, provider_id, upstream_id, secret_ref) VALUES (?, 'official', ?, 'env:TEST')`)
    .run(accountId, upstreamId);
  const price = sqlite.prepare(
    `INSERT INTO gateway_price (id, price_version, model_code, upstream_id, unit, amount_micro, per, effective_from, published_at)
     VALUES (?, ?, ?, ?, ?, ?, 1000, 0, 1)`,
  );
  const version = `pv-${hex()}`;
  price.run(`gp_${hex()}`, version, modelCode, upstreamId, "input_token", 2_000);
  price.run(`gp_${hex()}`, version, modelCode, upstreamId, "output_token", 8_000);
  return { upstreamId, accountId, modelCode };
}

type Fixture = ReturnType<typeof upstreamFixture>;

async function meteredRequest(t: { tenantId: string; budgetId: string; owner: { userId: string } }, f: Fixture, at: number, tokens: Partial<Usage>) {
  return settle(t, {
    userId: t.owner.userId,
    modelCode: f.modelCode,
    upstreamId: f.upstreamId,
    accountId: f.accountId,
    occurredAt: at,
    usage: usage(tokens),
    costMicroCredits: 1,
  });
}

function reportGroup(f: Fixture, counts: { requests: number; inputTokens?: number; outputTokens?: number }) {
  return { upstreamId: f.upstreamId, accountId: f.accountId, modelCode: f.modelCode, ...counts };
}

async function importReport(day: string, groups: unknown[], source = "invoice") {
  return call("PUT", `/api/v1/admin/gateway/reconciliation/reports/${day}/${source}`, platformAdmin.auth, { groups, reason: "test import" });
}

interface RunView {
  id: string;
  day: string;
  status: string;
  errorCode: string | null;
  adjustments: number;
  adjustedMicroCredits: number;
  diffs?: Array<{ accountId: string; deltaMicroCredits: number | null; adjustMicroCredits: number; errorCode?: string }>;
}

async function runDay(day: string, source?: string) {
  return json<{ run: RunView; posted: number }>(
    await call("POST", "/api/v1/admin/gateway/reconciliation/runs", platformAdmin.auth, { day, ...(source ? { source } : {}) }),
    201,
  );
}

function adjustments(f: Fixture) {
  return sqlite
    .prepare(
      `SELECT request_id, kind, status, tenant_id, amount_micro_credits, ref_kind, ref_id FROM gateway_usage_ledger
        WHERE kind = 'adjust' AND account_id = ? ORDER BY request_id`,
    )
    .all(f.accountId) as Array<{ request_id: string; status: string; tenant_id: string; amount_micro_credits: number; ref_kind: string; ref_id: string }>;
}

const signed = (row: { status: string; amount_micro_credits: number }) =>
  row.status === "upstream_over" ? row.amount_micro_credits : -row.amount_micro_credits;

/** The upstream value minus the ledger value at the published price, as the data plane prices a request. */
async function valuedDelta(f: Fixture, day: string, ledger: Partial<Usage>, upstream: Partial<Usage>) {
  const price = await publishedPriceAt(d1, { modelCode: f.modelCode, upstreamId: f.upstreamId, at: Date.parse(`${day}T23:59:59.000Z`) }, { logger: silent });
  return priceUsage(usage(upstream), price).microCredits - priceUsage(usage(ledger), price).microCredits;
}

describe("reconciliation", () => {
  it("posts the valued difference as platform adjust rows, idempotently, and reverses it after a corrected report", async () => {
    const t = team();
    const f = upstreamFixture();
    const at = noonDaysAgo(3);
    const day = utcDay(at);
    await meteredRequest(t, f, at, { inputTokens: 100, outputTokens: 10 });
    await meteredRequest(t, f, at + 1000, { inputTokens: 100, outputTokens: 10 });
    const ledgerTotals = { inputTokens: 200, outputTokens: 20 };
    const upstreamTotals = { inputTokens: 300, outputTokens: 30 };

    const imported = await json<{ report: { day: string; groups: number } }>(
      await importReport(day, [reportGroup(f, { requests: 3, ...upstreamTotals })]),
    );
    expect(imported.report).toMatchObject({ day, groups: 1 });
    const delta = await valuedDelta(f, day, ledgerTotals, upstreamTotals);
    expect(delta).toBeGreaterThan(0);

    const first = await runDay(day);
    expect(first.run).toMatchObject({ day, status: "adjusted", adjustments: 1, adjustedMicroCredits: delta });
    expect(first.posted).toBe(1);
    expect(adjustments(f)).toEqual([
      expect.objectContaining({ status: "upstream_over", tenant_id: "", amount_micro_credits: delta, ref_kind: "reconcile", ref_id: first.run.id }),
    ]);
    // A platform record, not a tenant charge: visible platform-wide as an adjust entry charging nothing, absent from the team.
    const platform = await explore(`kind=adjust&modelCode=${f.modelCode}`);
    expect(platform.entries).toEqual([expect.objectContaining({ tenantId: "", refKind: "reconcile", chargeMicroCredits: 0 })]);
    expect((await explore(`tenantId=${t.enc}&modelCode=${f.modelCode}`)).entries.every((entry) => entry.kind === "settle")).toBe(true);

    // Re-running the same day posts nothing more.
    const again = await runDay(day);
    expect(again.posted).toBe(0);
    expect(again.run.status).toBe("adjusted");
    expect(adjustments(f)).toHaveLength(1);

    // A corrected report that now matches the ledger reverses what was posted.
    await json(await importReport(day, [reportGroup(f, { requests: 2, ...ledgerTotals })]));
    const corrected = await runDay(day);
    expect(corrected.posted).toBe(1);
    const rows = adjustments(f);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + signed(row), 0)).toBe(0);
    expect(rows[1]).toMatchObject({ status: "upstream_under", amount_micro_credits: delta });
    expect((await runDay(day)).run).toMatchObject({ status: "matched", adjustments: 0 });

    // Every import and run is audited platform-wide.
    const audited = sqlite
      .prepare(`SELECT action FROM gateway_admin_audit WHERE tenant_id = '' AND (target_id = ? OR target_id IN (SELECT id FROM gateway_reconciliation_run WHERE day = ?))`)
      .all(`${day}:invoice`, day) as Array<{ action: string }>;
    expect(audited.filter((row) => row.action === "reconciliation.import")).toHaveLength(2);
    expect(audited.filter((row) => row.action === "reconciliation.run")).toHaveLength(4);
    const detail = await json<{ run: RunView }>(await call("GET", `/api/v1/admin/gateway/reconciliation/runs/${first.run.id}`, platformAdmin.auth));
    expect(detail.run.diffs).toEqual([expect.objectContaining({ accountId: f.accountId, deltaMicroCredits: delta, adjustMicroCredits: delta })]);
  });

  it("never posts twice when two runs of a day race", async () => {
    const t = team();
    const f = upstreamFixture();
    const at = noonDaysAgo(4);
    const day = utcDay(at);
    await meteredRequest(t, f, at, { inputTokens: 50 });
    await json(await importReport(day, [reportGroup(f, { requests: 1, inputTokens: 80 })]));
    const ports = {
      reconciliation: createD1ReconciliationPort(d1, { logger: silent }),
      ids: reconcileRunIds,
      clock: { now: () => Date.now() },
      logger: silent,
    };
    const results = await Promise.all([reconcileGatewayUsageDay(ports, { day }), reconcileGatewayUsageDay(ports, { day })]);
    const delta = await valuedDelta(f, day, { inputTokens: 50 }, { inputTokens: 80 });
    expect(results.reduce((sum, result) => sum + result.posted, 0)).toBe(1);
    expect(adjustments(f).reduce((sum, row) => sum + signed(row), 0)).toBe(delta);
  });

  it("records a day without a report as source_missing and an unpriced group as incomplete, posting nothing", async () => {
    const missingDay = utcDay(noonDaysAgo(5));
    const missing = await runDay(missingDay, "ai_gateway");
    expect(missing.run).toMatchObject({ status: "source_missing", errorCode: "GATEWAY_RECONCILE_SOURCE_MISSING", adjustments: 0 });
    const listed = await json<{ runs: RunView[] }>(await call("GET", `/api/v1/admin/gateway/reconciliation/runs?day=${missingDay}&status=source_missing`, platformAdmin.auth));
    expect(listed.runs.map((run) => run.id)).toContain(missing.run.id);

    const f = upstreamFixture();
    sqlite.prepare(`DELETE FROM gateway_price WHERE model_code = ?`).run(f.modelCode);
    const day = utcDay(noonDaysAgo(6));
    await json(await importReport(day, [reportGroup(f, { requests: 1, inputTokens: 10 })]));
    const unpriced = await runDay(day);
    expect(unpriced.run.status).toBe("incomplete");
    const detail = await json<{ run: RunView }>(await call("GET", `/api/v1/admin/gateway/reconciliation/runs/${unpriced.run.id}`, platformAdmin.auth));
    expect(detail.run.diffs).toEqual([expect.objectContaining({ deltaMicroCredits: null, adjustMicroCredits: 0, errorCode: "GATEWAY_PRICE_UNAVAILABLE" })]);
    expect(adjustments(f)).toEqual([]);
  });

  it("refuses days it cannot reconcile and reports it cannot accept", async () => {
    await expectCode(
      await call("POST", "/api/v1/admin/gateway/reconciliation/runs", platformAdmin.auth, { day: utcDay(Date.now()) }),
      409,
      "GATEWAY_RECONCILE_WINDOW_CLOSED",
    );
    await expectCode(
      await call("POST", "/api/v1/admin/gateway/reconciliation/runs", platformAdmin.auth, { day: utcDay(Date.now() - 31 * DAY_MS) }),
      409,
      "GATEWAY_RECONCILE_WINDOW_CLOSED",
    );
    await expectCode(
      await call("POST", "/api/v1/admin/gateway/reconciliation/runs", platformAdmin.auth, { day: "2026-02-30" }),
      400,
      "GATEWAY_INVALID_REQUEST",
    );
    await expectCode(await call("GET", "/api/v1/admin/gateway/reconciliation/runs/gwrec_000000000000000000000000", platformAdmin.auth), 404, "GATEWAY_RECONCILE_RUN_NOT_FOUND");

    const f = upstreamFixture();
    const day = utcDay(noonDaysAgo(7));
    await expectCode(await importReport(utcDay(Date.now() + 2 * DAY_MS), [reportGroup(f, { requests: 1 })]), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await importReport(day, [reportGroup(f, { requests: 1 }), reportGroup(f, { requests: 2 })]), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await importReport(day, [{ ...reportGroup(f, { requests: 1 }), accountId: "gwu_unknown" }]), 404, "GATEWAY_UPSTREAM_NOT_FOUND");
    await expectCode(await importReport(day, [{ ...reportGroup(f, { requests: 1 }), upstreamId: "other" }]), 404, "GATEWAY_UPSTREAM_NOT_FOUND");
    // DeepSeek is Flash-only.
    await expectCode(await importReport(day, [{ ...reportGroup(f, { requests: 1 }), modelCode: "deepseek-test" }]), 400, "GATEWAY_CATALOG_MODEL_BLOCKED");
    await json(await importReport(day, [{ ...reportGroup(f, { requests: 1 }), modelCode: "deepseek-v4-flash" }]));
    const reports = await json<{ reports: Array<{ day: string; source: string; groups: number }> }>(
      await call("GET", `/api/v1/admin/gateway/reconciliation/reports?from=${day}`, platformAdmin.auth),
    );
    expect(reports.reports).toContainEqual(expect.objectContaining({ day, source: "invoice", groups: 1 }));

    const owner = team().owner;
    for (const [method, path, body] of [
      ["GET", "/api/v1/admin/gateway/reconciliation/runs", undefined],
      ["POST", "/api/v1/admin/gateway/reconciliation/runs", { day }],
      ["PUT", `/api/v1/admin/gateway/reconciliation/reports/${day}/invoice`, { groups: [] }],
    ] as const)
      await expectCode(await call(method, path, owner.auth, body), 403, "GATEWAY_ADMIN_SESSION_REQUIRED");
  });

  it("reconciles yesterday and every day whose report changed since its last run, nightly", async () => {
    const t = team();
    const f = upstreamFixture();
    const at = noonDaysAgo(8);
    const day = utcDay(at);
    await meteredRequest(t, f, at, { inputTokens: 10 });
    await json(await importReport(day, [reportGroup(f, { requests: 1, inputTokens: 20 })]));
    const yesterday = utcDay(Date.now() - DAY_MS);

    const nightly = await reconcileGatewayUsageNightly(env, { logger: silent });
    expect(nightly.failed).toBe(0);
    const days = nightly.runs.map((run) => run.day);
    expect(days).toContain(yesterday);
    expect(nightly.runs.find((run) => run.day === day)).toMatchObject({ status: "adjusted", posted: 1 });
    expect(adjustments(f).reduce((sum, row) => sum + signed(row), 0)).toBe(await valuedDelta(f, day, { inputTokens: 10 }, { inputTokens: 20 }));
    // The nightly actor is the system, and its runs are not admin-audited.
    const run = sqlite.prepare(`SELECT actor_kind, actor_id FROM gateway_reconciliation_run WHERE day = ? ORDER BY started_at DESC LIMIT 1`).get(day);
    expect(run).toEqual({ actor_kind: "system", actor_id: "nightly" });
  });

  it("runs retention and reconciliation from the scheduled handler at their minutes only", async () => {
    const midnight = Date.parse(`${utcDay(Date.now())}T00:00:00.000Z`);
    const nightlyAt = midnight + GATEWAY_RECONCILE_UTC_MINUTE_OF_DAY * 60_000;
    const retentionAt = midnight + 3 * 60 * 60_000 + GATEWAY_RETENTION_ENFORCE_MINUTE * 60_000;
    const logged: string[] = [];
    const logger: GatewayLogger = { ...silent, info: (event) => logged.push(event), error: (event) => logged.push(event) };
    expect(await runScheduledGatewayUsageJobs(env, nightlyAt, logger)).toEqual({ retention: false, reconciliation: true });
    expect(await runScheduledGatewayUsageJobs(env, retentionAt, logger)).toEqual({ retention: true, reconciliation: false });
    expect(await runScheduledGatewayUsageJobs(env, nightlyAt + 60_000, logger)).toEqual({ retention: false, reconciliation: false });
    expect(logged).toContain("gateway.reconcile_nightly");
    expect(logged).toContain("gateway.retention_enforced");
    expect(logged.filter((event) => event.endsWith("_failed"))).toEqual([]);
  });
});
