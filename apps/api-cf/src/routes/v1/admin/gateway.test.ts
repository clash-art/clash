/**
 * Gateway control-plane routes (#352) through the Worker app on node:sqlite:
 * platform-admin-only price book, packages and top-up packs; owner-or-admin
 * tenant purchases; coded errors. Identity is a real clsh_ token row, so the
 * /api/* middleware resolves it exactly as in production.
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

import { createApp } from "../../../app";
import { createSqliteD1 } from "../../../../../web/app/test-support/sqlite-d1";

const ORIGIN = "http://localhost:8789";
const { d1, sqlite } = createSqliteD1();
const app = createApp();

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);

function user() {
  const userId = `user-${hex()}`;
  const raw = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  sqlite
    .prepare("INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, 'gw', ?, 'clsh_gw', 1)")
    .run(`tok-${hex()}`, userId, sha256(raw));
  return { userId, auth: { authorization: `Bearer ${raw}` } };
}

// The platform grant is a D1 row (0036), never an environment variable.
const adminUser = user();
sqlite.prepare(`INSERT INTO gateway_platform_role (user_id, role) VALUES (?, 'platform_admin')`).run(adminUser.userId);
const env = {
  DB: d1,
  ENVIRONMENT: "test",
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "test-secret-for-gateway-admin-0123456789",
} as never;

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    },
    env,
  );
}

async function expectCode(res: Response, status: number, code: string) {
  const text = await res.clone().text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("x-clash-error-code"), text).toBe(code);
  expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(code);
}

const pkgBody = { name: "Team monthly", billingPeriod: "month", priceMinor: 4900, priceCurrency: "USD", periodMicroCredits: 25_000_000 };
const packBody = { name: "Top-up", priceMinor: 1000, priceCurrency: "USD", microCredits: 10_000_000 };
const draftBody = (modelCode: string) => ({
  effectiveFrom: new Date().toISOString(),
  rates: [
    { modelCode, unit: "input_token", amountMicroCredits: 3, per: 1 },
    { modelCode, upstreamId: "openai", unit: "output_token", amountMicroCredits: 9, per: 1 },
  ],
});

function team() {
  const tenantId = `team:${hex()}`;
  const owner = user();
  const member = user();
  sqlite.prepare(`INSERT INTO tenant (id, owner_user_id, name, kind) VALUES (?, ?, 'Team', 'team')`).run(tenantId, owner.userId);
  sqlite.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role) VALUES (?, ?, 'owner')`).run(tenantId, owner.userId);
  sqlite.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role) VALUES (?, ?, 'member')`).run(tenantId, member.userId);
  return { tenantId, owner, member, base: `/api/v1/gateway/tenants/${encodeURIComponent(tenantId)}` };
}

describe("/api/v1/admin/gateway", () => {
  const adminRoutes: Array<[string, string, unknown?]> = [
    ["GET", "/api/v1/admin/gateway/prices"],
    ["GET", "/api/v1/admin/gateway/prices/versions/v1"],
    ["PUT", "/api/v1/admin/gateway/prices/versions/v1", draftBody("m")],
    ["POST", "/api/v1/admin/gateway/prices/versions/v1/publish"],
    ["GET", "/api/v1/admin/gateway/packages"],
    ["POST", "/api/v1/admin/gateway/packages", pkgBody],
    ["POST", "/api/v1/admin/gateway/packages/p/archive"],
    ["GET", "/api/v1/admin/gateway/topup-packs"],
    ["POST", "/api/v1/admin/gateway/topup-packs", packBody],
    ["POST", "/api/v1/admin/gateway/topup-packs/p/archive"],
    ["POST", "/api/v1/admin/gateway/billing/rollover", {}],
  ];

  it("is platform-admin only: anonymous is 401, a signed-in non-admin or a spoofed x-user-id is 403", async () => {
    const stranger = user();
    // A tenant owner is not a platform admin either.
    const { owner } = team();
    for (const [method, path, body] of adminRoutes) {
      await expectCode(await call(method, path, {}, body), 401, "GATEWAY_AUTH_REQUIRED");
      await expectCode(await call(method, path, stranger.auth, body), 403, "GATEWAY_FORBIDDEN");
      await expectCode(await call(method, path, owner.auth, body), 403, "GATEWAY_FORBIDDEN");
      await expectCode(
        await call(method, path, { ...stranger.auth, "x-user-id": adminUser.userId }, body),
        403,
        "GATEWAY_FORBIDDEN",
      );
    }
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM gateway_price`).get()).toEqual({ n: 0 });
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM gateway_package`).get()).toEqual({ n: 0 });
  });

  it("drafts, publishes and lists price versions with coded errors", async () => {
    const model = `admin-model-${hex()}`;
    const path = `/api/v1/admin/gateway/prices/versions/v-${hex()}`;
    const draft = await call("PUT", path, adminUser.auth, draftBody(model));
    expect(draft.status, await draft.clone().text()).toBe(200);
    expect(await draft.json()).toMatchObject({ version: { status: "draft", publishedAt: null } });
    const published = await call("POST", `${path}/publish`, adminUser.auth);
    expect(published.status).toBe(200);
    const { version } = (await published.json()) as { version: { version: string; status: string; rates: unknown[] } };
    expect(version.status).toBe("published");
    expect(version.rates).toHaveLength(draftBody(model).rates.length);
    await expectCode(await call("POST", `${path}/publish`, adminUser.auth), 409, "GATEWAY_PRICE_VERSION_PUBLISHED");
    await expectCode(await call("PUT", path, adminUser.auth, draftBody(model)), 409, "GATEWAY_PRICE_VERSION_PUBLISHED");

    const list = await call("GET", `/api/v1/admin/gateway/prices?status=published&modelCode=${model}`, adminUser.auth);
    expect(((await list.json()) as { versions: Array<{ version: string }> }).versions.map((v) => v.version)).toEqual([
      version.version,
    ]);

    await expectCode(await call("GET", "/api/v1/admin/gateway/prices?status=live", adminUser.auth), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await call("GET", "/api/v1/admin/gateway/prices/versions/nope", adminUser.auth), 404, "GATEWAY_PRICE_VERSION_NOT_FOUND");
    await expectCode(await call("PUT", "/api/v1/admin/gateway/prices/versions/bad%20name", adminUser.auth, draftBody(model)), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await call("PUT", path.replace(/v-\w+$/, "json"), adminUser.auth, "{"), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(
      await call("PUT", path.replace(/v-\w+$/, "frac"), adminUser.auth, {
        ...draftBody(model),
        rates: [{ modelCode: model, unit: "input_token", amountMicroCredits: 0.5, per: 1 }],
      }),
      400,
      "GATEWAY_INVALID_REQUEST",
    );
    await expectCode(
      await call("PUT", path.replace(/v-\w+$/, "extra"), adminUser.auth, { ...draftBody(model), unknownField: 1 }),
      400,
      "GATEWAY_INVALID_REQUEST",
    );
    await expectCode(
      await call("PUT", path.replace(/v-\w+$/, "ds"), adminUser.auth, draftBody("deepseek-v4-pro")),
      400,
      "GATEWAY_PRICE_MODEL_BLOCKED",
    );
  });

  it("creates, lists and archives packages and top-up packs", async () => {
    const created = await call("POST", "/api/v1/admin/gateway/packages", adminUser.auth, pkgBody);
    expect(created.status, await created.clone().text()).toBe(201);
    const { package: pkg } = (await created.json()) as { package: { id: string; status: string } };
    expect(pkg).toMatchObject({ ...pkgBody, status: "active", rateLimit: null });
    const archived = await call("POST", `/api/v1/admin/gateway/packages/${pkg.id}/archive`, adminUser.auth);
    expect(((await archived.json()) as { package: { status: string } }).package.status).toBe("archived");
    const list = (await (await call("GET", "/api/v1/admin/gateway/packages", adminUser.auth)).json()) as {
      packages: Array<{ id: string }>;
    };
    expect(list.packages.map((p) => p.id)).toContain(pkg.id);
    await expectCode(await call("POST", "/api/v1/admin/gateway/packages/none/archive", adminUser.auth), 404, "GATEWAY_PACKAGE_NOT_FOUND");
    await expectCode(
      await call("POST", "/api/v1/admin/gateway/packages", adminUser.auth, { ...pkgBody, priceCurrency: "usd" }),
      400,
      "GATEWAY_INVALID_REQUEST",
    );
    await expectCode(
      await call("POST", "/api/v1/admin/gateway/topup-packs", adminUser.auth, { ...packBody, validityDays: 30 }),
      400,
      "GATEWAY_INVALID_REQUEST",
    );
    const pack = await call("POST", "/api/v1/admin/gateway/topup-packs", adminUser.auth, packBody);
    expect(pack.status).toBe(201);
    await expectCode(await call("POST", "/api/v1/admin/gateway/topup-packs/none/archive", adminUser.auth), 404, "GATEWAY_TOPUP_PACK_NOT_FOUND");
  });
});

describe("/api/v1/gateway/tenants/:tenantId purchases", () => {
  async function createPack() {
    const res = await call("POST", "/api/v1/admin/gateway/topup-packs", adminUser.auth, packBody);
    return ((await res.json()) as { pack: { id: string; microCredits: number } }).pack;
  }
  async function createPackage() {
    const res = await call("POST", "/api/v1/admin/gateway/packages", adminUser.auth, pkgBody);
    return ((await res.json()) as { package: { id: string; periodMicroCredits: number } }).package;
  }

  it("lets the owner or a platform admin buy for the team wallet; other members and strangers are refused", async () => {
    const { owner, member, base, tenantId } = team();
    const pack = await createPack();
    const body = { packId: pack.id, idempotencyKey: "order-1" };
    await expectCode(await call("POST", `${base}/topups`, {}, body), 401, "GATEWAY_AUTH_REQUIRED");
    // A team member neither reads billing nor buys (both are the owner's).
    await expectCode(await call("POST", `${base}/topups`, member.auth, body), 403, "GATEWAY_FORBIDDEN");
    await expectCode(await call("POST", `${base}/topups`, user().auth, body), 403, "GATEWAY_FORBIDDEN");
    await expectCode(await call("GET", `${base}/billing`, member.auth), 403, "GATEWAY_FORBIDDEN");
    expect((await call("GET", `${base}/billing`, owner.auth)).status).toBe(200);

    const bought = await call("POST", `${base}/topups`, owner.auth, body);
    expect(bought.status, await bought.clone().text()).toBe(201);
    expect(await bought.json()).toMatchObject({
      replayed: false,
      entry: { kind: "topup", amountMicroCredits: pack.microCredits, actorUserId: owner.userId },
      wallet: { tenantId, limitMicroCredits: pack.microCredits },
    });
    const replay = await call("POST", `${base}/topups`, owner.auth, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, wallet: { limitMicroCredits: pack.microCredits } });

    const byAdmin = await call("POST", `${base}/topups`, adminUser.auth, { ...body, idempotencyKey: "order-2" });
    expect(byAdmin.status).toBe(201);
    const summary = (await (await call("GET", `${base}/billing`, owner.auth)).json()) as {
      wallet: { limitMicroCredits: number };
      entries: Array<{ kind: string; actorUserId: string }>;
    };
    expect(summary.wallet.limitMicroCredits).toBe(2 * pack.microCredits);
    expect(summary.entries.map((entry) => entry.actorUserId).sort()).toEqual([adminUser.userId, owner.userId].sort());
    const audit = sqlite
      .prepare(`SELECT actor_role FROM gateway_admin_audit WHERE tenant_id = ? ORDER BY actor_role`)
      .all(tenantId) as Array<{ actor_role: string }>;
    expect(audit.map((entry) => entry.actor_role)).toEqual(["owner", "platform_admin"]);
  });

  it("subscribes, refuses a second live subscription, cancels, and codes every failure", async () => {
    const { owner, base } = team();
    const pkg = await createPackage();
    const sub = await call("POST", `${base}/subscription`, owner.auth, { packageId: pkg.id, idempotencyKey: "s1" });
    expect(sub.status, await sub.clone().text()).toBe(201);
    expect(await sub.json()).toMatchObject({ entry: { kind: "grant", amountMicroCredits: pkg.periodMicroCredits } });
    await expectCode(
      await call("POST", `${base}/subscription`, owner.auth, { packageId: pkg.id, idempotencyKey: "s2" }),
      409,
      "GATEWAY_SUBSCRIPTION_EXISTS",
    );
    await expectCode(
      await call("POST", `${base}/subscription`, owner.auth, { packageId: (await createPackage()).id, idempotencyKey: "s1" }),
      409,
      "GATEWAY_IDEMPOTENCY_CONFLICT",
    );
    const canceled = await call("POST", `${base}/subscription/cancel`, owner.auth);
    expect(canceled.status).toBe(200);
    expect(((await canceled.json()) as { subscription: { cancelAt: string | null } }).subscription.cancelAt).not.toBeNull();

    await expectCode(await call("POST", `${base}/topups`, owner.auth, { packId: "none", idempotencyKey: "k" }), 404, "GATEWAY_TOPUP_PACK_NOT_FOUND");
    await expectCode(await call("POST", `${base}/topups`, owner.auth, { packId: "x", idempotencyKey: "bad key" }), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await call("POST", `${base}/topups`, owner.auth, { packId: "x" }), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(
      await call("POST", "/api/v1/gateway/tenants/team%3Amissing/topups", adminUser.auth, { packId: "x", idempotencyKey: "k" }),
      404,
      "GATEWAY_TENANT_NOT_FOUND",
    );
    // Rollover is idempotent and reports per-subscription outcomes; nothing is due yet.
    const rollover = await call("POST", "/api/v1/admin/gateway/billing/rollover", adminUser.auth, {});
    expect(await rollover.json()).toEqual({ subscriptions: [], failed: 0 });
  });
});
