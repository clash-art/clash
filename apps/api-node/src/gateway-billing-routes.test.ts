/**
 * The api-node billing routes (#425) over PGlite: session and owner
 * authorization, the env purchase mode (provider: 409 before the body), and
 * the injected admin verifier, through HTTP.
 */
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  GatewayBudgetDatabase,
  GatewayBudgetSqlClient,
} from "./gateway-budget.ts";
import {
  createPgGatewayBilling,
  createPgGatewayPriceBook,
} from "./gateway-billing.ts";
import {
  createGatewayBillingAdminRoutes,
  createGatewayBillingTenantRoutes,
  gatewayBillingPurchaseConfigFromEnv,
} from "./gateway-billing-routes.ts";
import { migrateDatabase } from "./migrations.ts";

function adapt(pglite: PGlite): GatewayBudgetDatabase {
  const client = (q: Pick<PGlite, "query">): GatewayBudgetSqlClient => ({
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) {
      return { rows: (await q.query<Row>(sql, parameters ?? [])).rows };
    },
  });
  return {
    ...client(pglite),
    transaction: (work) => pglite.transaction((tx) => work(client(tx))),
  };
}

const json = (body: unknown, user?: string) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(user ? { "x-test-user": user } : {}),
  },
  body: JSON.stringify(body),
});

describe("api-node gateway billing routes", () => {
  let db: GatewayBudgetDatabase;
  let packId: string;
  const tenant = "tnt_routes";

  const apps = (env: Record<string, string | undefined>) => {
    const billing = createPgGatewayBilling({ db });
    return {
      tenant: createGatewayBillingTenantRoutes({
        billing,
        db,
        session: async (headers) => {
          const user = headers.get("x-test-user");
          return user ? { userId: user } : null;
        },
        purchase: gatewayBillingPurchaseConfigFromEnv(env),
      }),
      admin: createGatewayBillingAdminRoutes({
        billing,
        priceBook: createPgGatewayPriceBook({ db }),
        verifyAdmin: async (request) => {
          const role = request.headers.get("x-test-admin");
          return role ? { id: "adm_routes", role } : null;
        },
      }),
    };
  };

  beforeEach(async () => {
    const pglite = new PGlite();
    await migrateDatabase(pglite);
    db = adapt(pglite);
    await db.query(
      `INSERT INTO tenant (id, owner_user_id, name) VALUES ($1, 'usr_owner', 'Team')`,
      [tenant],
    );
    await db.query(
      `INSERT INTO tenant_member (tenant_id, user_id, role) VALUES ($1, 'usr_owner', 'owner'), ($1, 'usr_member', 'member')`,
      [tenant],
    );
    const res = await apps({}).admin.request(
      "/api/v1/admin/gateway/topup-packs",
      {
        ...json({
          name: "Five",
          priceMinor: 500,
          priceCurrency: "USD",
          microCredits: 5_000_000,
        }),
        headers: {
          "content-type": "application/json",
          "x-test-admin": "platform_admin",
        },
      },
    );
    expect(res.status).toBe(201);
    packId = ((await res.json()) as { pack: { id: string } }).pack.id;
  });

  it("lets the tenant owner buy in free mode; members and anonymous callers are refused", async () => {
    const { tenant: app } = apps({});
    const path = `/api/v1/gateway/tenants/${tenant}/topups`;
    expect(
      (await app.request(path, json({ packId, idempotencyKey: "k1" }))).status,
    ).toBe(401);
    const member = await app.request(
      path,
      json({ packId, idempotencyKey: "k1" }, "usr_member"),
    );
    expect(member.status).toBe(403);
    expect(
      ((await member.json()) as { error: { code: string } }).error.code,
    ).toBe("GATEWAY_FORBIDDEN");
    const bought = await app.request(
      path,
      json({ packId, idempotencyKey: "k1" }, "usr_owner"),
    );
    expect(bought.status).toBe(201);
    expect(bought.headers.get("cache-control")).toBe("no-store");
    expect(
      (
        await app.request(
          path,
          json({ packId, idempotencyKey: "k1" }, "usr_owner"),
        )
      ).status,
    ).toBe(200);
    const summary = await app.request(
      `/api/v1/gateway/tenants/${tenant}/billing`,
      { headers: { "x-test-user": "usr_owner" } },
    );
    expect(
      ((await summary.json()) as { wallet: { limitMicroCredits: number } })
        .wallet.limitMicroCredits,
    ).toBe(5_000_000);
    const offers = await app.request(
      `/api/v1/gateway/tenants/${tenant}/billing/offers`,
      { headers: { "x-test-user": "usr_owner" } },
    );
    expect(offers.status).toBe(200);
  });

  it("answers 409 GATEWAY_PAYMENT_REQUIRED_VIA_PROVIDER in provider mode, even for an unreadable body", async () => {
    const { tenant: app } = apps({
      GATEWAY_BILLING_PURCHASE_MODE: "provider",
      GATEWAY_BILLING_CHECKOUT_PATH: "/checkout",
    });
    for (const path of ["topups", "subscription", "subscription/cancel"]) {
      const res = await app.request(
        `/api/v1/gateway/tenants/${tenant}/${path}`,
        {
          method: "POST",
          headers: { "x-test-user": "usr_owner" },
          body: "{not json",
        },
      );
      expect(res.status).toBe(409);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("GATEWAY_PAYMENT_REQUIRED_VIA_PROVIDER");
    }
    expect(() =>
      gatewayBillingPurchaseConfigFromEnv({
        GATEWAY_BILLING_PURCHASE_MODE: "stripe",
      }),
    ).toThrow();
  });

  it("requires a platform admin for the admin billing routes", async () => {
    const { admin } = apps({});
    const anonymous = await admin.request("/api/v1/admin/gateway/packages");
    expect(anonymous.status).toBe(403);
    expect(
      ((await anonymous.json()) as { error: { code: string } }).error.code,
    ).toBe("GATEWAY_ADMIN_SESSION_REQUIRED");
    expect(
      (
        await admin.request("/api/v1/admin/gateway/packages", {
          headers: { "x-test-admin": "viewer" },
        })
      ).status,
    ).toBe(403);
    const ok = await admin.request("/api/v1/admin/gateway/topup-packs", {
      headers: { "x-test-admin": "platform_admin" },
    });
    expect(((await ok.json()) as { packs: unknown[] }).packs).toHaveLength(1);
    const adjust = await admin.request(
      `/api/v1/admin/gateway/tenants/${tenant}/wallet/adjust`,
      {
        ...json({
          deltaMicroCredits: 1_000_000,
          reason: "goodwill",
          idempotencyKey: "a1",
        }),
        headers: {
          "content-type": "application/json",
          "x-test-admin": "platform_admin",
        },
      },
    );
    expect(adjust.status).toBe(201);
  });
});
