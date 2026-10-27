/**
 * Gateway credit billing routes over Postgres (#425): the same paths, bodies,
 * codes and handlers as api-cf (apps/api-cf/src/routes/v1/gateway-billing.ts,
 * gateway-team.ts offers, admin/gateway.ts and admin/gateway-tenants.ts). The
 * tenant handlers are gateway-core's createGatewayBillingHandlers; the port is
 * createPgGatewayBilling (gateway-billing.ts).
 *
 * Tenant routes, mounted at /api/v1/gateway (a product session; the tenant
 * owner holds billing.read and billing.purchase, as on api-cf):
 *
 *   GET  /tenants/:tenantId/billing              wallet, live subscription, credit entries
 *   GET  /tenants/:tenantId/billing/offers       packages and top-up packs
 *   POST /tenants/:tenantId/subscription         subscribe to a package (first period granted)
 *   POST /tenants/:tenantId/subscription/cancel  end at the current period end
 *   POST /tenants/:tenantId/topups               buy a top-up pack
 *
 * The purchase mode is config (GATEWAY_BILLING_PURCHASE_MODE = free |
 * provider, GATEWAY_BILLING_CHECKOUT_PATH): in provider mode the three write
 * routes answer 409 GATEWAY_PAYMENT_REQUIRED_VIA_PROVIDER before reading the
 * body, and credits arrive only through the provider's verified webhooks
 * calling the port with a payment actor.
 *
 * Admin routes, at /api/v1/admin/gateway (createGatewayBillingAdminRoutes),
 * served by the admin listener only (gateway-admin.ts, #371): the host
 * injects `verifyAdmin` like the key-ring admin routes (gateway-key-admin.ts,
 * #394), and each route names its permission (gateway-admin-authz.ts:
 * prices.*, packages.*, billing.rollover, wallet.adjust, as hosted). Every
 * mutation writes its gateway_admin_audit row in the same transaction.
 */
import {
  GatewayError,
  GatewayExternalPriceIdRequestSchema,
  GatewayPackageCreateRequestSchema,
  GatewayPriceDraftRequestSchema,
  GatewayPriceVersionSchema,
  GatewayRolloverRequestSchema,
  GatewayTopupPackCreateRequestSchema,
  GatewayWalletAdjustRequestSchema,
  GatewayWalletStatusRequestSchema,
  createGatewayBillingHandlers,
  gatewayErrorResponseInit,
  parseGatewayBillingPurchaseMode,
  parseGatewayJsonBody,
  toGatewayError,
  type GatewayBillingPort,
  type GatewayBillingPurchaseConfig,
  type GatewayBillingStaffActor,
  type GatewayPriceBookPort,
} from "@clash/gateway-core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { GatewayBudgetSqlClient } from "./gateway-budget.ts";
import type { GatewayAdminPermission } from "./gateway-admin-authz.ts";
import {
  authorizeGatewayAdminRequest,
  type GatewayAdminIdentity,
} from "./gateway-key-admin.ts";

export const GATEWAY_BILLING_TENANT_PREFIX = "/api/v1/gateway";
export const GATEWAY_BILLING_ADMIN_PREFIX = "/api/v1/admin/gateway";

const NO_STORE = { "cache-control": "no-store" };
const TenantIdSchema = z.string().min(1).max(256);
const IdSchema = z.string().min(1).max(128);
const PriceStatusSchema = z.enum(["draft", "published"]).optional();
/** Tenant roles holding billing.read and billing.purchase (api-cf services/gateway-authz.ts). */
const BILLING_ROLES = new Set(["owner"]);

/** This host's purchase mode from env; unset is `free` (self-host grants credits directly). */
export function gatewayBillingPurchaseConfigFromEnv(
  env: Record<string, string | undefined>,
): GatewayBillingPurchaseConfig {
  const purchaseMode = parseGatewayBillingPurchaseMode(
    env.GATEWAY_BILLING_PURCHASE_MODE,
  );
  const checkoutPath = env.GATEWAY_BILLING_CHECKOUT_PATH?.trim();
  return { purchaseMode, ...(checkoutPath ? { checkoutPath } : {}) };
}

function fail(c: Context, error: unknown) {
  const init = gatewayErrorResponseInit(toGatewayError(error), "openai");
  return c.json(init.body, init.status as 400, {
    ...init.headers,
    ...NO_STORE,
  });
}
function param<T>(
  schema: z.ZodType<T>,
  value: string | undefined,
  name: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      details: { param: name },
    });
  return parsed.data;
}

export function createGatewayBillingTenantRoutes(deps: {
  billing: GatewayBillingPort;
  db: GatewayBudgetSqlClient;
  /** The signed-in product user, or null. */
  session: (headers: Headers) => Promise<{ userId: string } | null>;
  purchase: GatewayBillingPurchaseConfig | (() => GatewayBillingPurchaseConfig);
}): Hono {
  const app = new Hono();
  const handlers = createGatewayBillingHandlers(deps.billing, deps.purchase);

  async function owner(
    c: Context,
    permission: "billing.read" | "billing.purchase",
  ) {
    const tenantId = param(TenantIdSchema, c.req.param("tenantId"), "tenantId");
    const session = await deps.session(c.req.raw.headers);
    if (!session) throw new GatewayError("GATEWAY_AUTH_REQUIRED");
    const { rows } = await deps.db.query<{ role: string }>(
      `SELECT role FROM tenant_member WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, session.userId],
    );
    const role = rows[0]?.role;
    if (!role || !BILLING_ROLES.has(role))
      throw new GatewayError("GATEWAY_FORBIDDEN", {
        details: { permission, tenantId },
      });
    return {
      tenantId,
      actor: { kind: "user" as const, id: session.userId, role },
    };
  }
  const route =
    (
      permission: "billing.read" | "billing.purchase",
      run: (
        c: Context,
        tenantId: string,
        actor: GatewayBillingStaffActor,
      ) => Promise<{ status: 200 | 201; body: unknown }>,
    ) =>
    async (c: Context) => {
      try {
        const { tenantId, actor } = await owner(c, permission);
        const result = await run(c, tenantId, actor);
        return c.json(result.body as object, result.status, NO_STORE);
      } catch (error) {
        return fail(c, error);
      }
    };

  const p = GATEWAY_BILLING_TENANT_PREFIX;
  app.get(
    `${p}/tenants/:tenantId/billing`,
    route("billing.read", (_c, t) => handlers.summary(t)),
  );
  app.get(
    `${p}/tenants/:tenantId/billing/offers`,
    route("billing.read", () => handlers.offers()),
  );
  app.post(
    `${p}/tenants/:tenantId/subscription`,
    route("billing.purchase", (c, t, a) =>
      handlers.subscribe(t, () => c.req.text(), a),
    ),
  );
  app.post(
    `${p}/tenants/:tenantId/subscription/cancel`,
    route("billing.purchase", (_c, t, a) => handlers.cancel(t, a)),
  );
  app.post(
    `${p}/tenants/:tenantId/topups`,
    route("billing.purchase", (c, t, a) =>
      handlers.topup(t, () => c.req.text(), a),
    ),
  );
  return app;
}

export function createGatewayBillingAdminRoutes(deps: {
  billing: GatewayBillingPort;
  priceBook: GatewayPriceBookPort;
  verifyAdmin: (request: Request) => Promise<GatewayAdminIdentity | null>;
}): Hono {
  const { billing, priceBook } = deps;
  const app = new Hono();
  const body = async <T>(c: Context, schema: z.ZodType<T>) =>
    parseGatewayJsonBody(await c.req.text(), schema);
  const route =
    (
      permission: GatewayAdminPermission,
      run: (
        c: Context,
        actor: GatewayBillingStaffActor,
      ) => Promise<[unknown] | [unknown, 200 | 201]>,
    ) =>
    async (c: Context) => {
      try {
        const actor = await authorizeGatewayAdminRequest(
          deps.verifyAdmin,
          c.req.raw,
          permission,
        );
        const [result, status] = await run(c, actor);
        return c.json(result as object, status ?? 200, NO_STORE);
      } catch (error) {
        return fail(c, error);
      }
    };
  const p = GATEWAY_BILLING_ADMIN_PREFIX;

  app.get(
    `${p}/prices`,
    route("prices.read", async (c) => {
      const modelCode = c.req.query("modelCode");
      const status = param(PriceStatusSchema, c.req.query("status"), "status");
      return [
        {
          versions: await priceBook.list({
            ...(modelCode ? { modelCode } : {}),
            ...(status ? { status } : {}),
          }),
        },
      ];
    }),
  );
  app.get(
    `${p}/prices/versions/:version`,
    route("prices.read", async (c) => [
      {
        version: await priceBook.read(
          param(GatewayPriceVersionSchema, c.req.param("version"), "version"),
        ),
      },
    ]),
  );
  app.put(
    `${p}/prices/versions/:version`,
    route("prices.write", async (c, actor) => {
      const version = param(
        GatewayPriceVersionSchema,
        c.req.param("version"),
        "version",
      );
      const draft = await body(c, GatewayPriceDraftRequestSchema);
      return [
        {
          version: await priceBook.putDraft({
            version,
            effectiveFrom: Date.parse(draft.effectiveFrom),
            effectiveTo: draft.effectiveTo
              ? Date.parse(draft.effectiveTo)
              : null,
            rates: draft.rates.map((rate) => ({
              modelCode: rate.modelCode,
              upstreamId: rate.upstreamId ?? "",
              unit: rate.unit,
              microCredits: rate.amountMicroCredits,
              per: rate.per,
            })),
            actor,
          }),
        },
      ];
    }),
  );
  app.post(
    `${p}/prices/versions/:version/publish`,
    route("prices.write", async (c, actor) => [
      {
        version: await priceBook.publish({
          version: param(
            GatewayPriceVersionSchema,
            c.req.param("version"),
            "version",
          ),
          actor,
        }),
      },
    ]),
  );

  app.get(
    `${p}/packages`,
    route("packages.read", async () => [
      { packages: await billing.listPackages() },
    ]),
  );
  app.post(
    `${p}/packages`,
    route("packages.write", async (c, actor) => [
      {
        package: await billing.createPackage(
          await body(c, GatewayPackageCreateRequestSchema),
          actor,
        ),
      },
      201,
    ]),
  );
  app.post(
    `${p}/packages/:id/archive`,
    route("packages.write", async (c, actor) => [
      {
        package: await billing.archivePackage(
          param(IdSchema, c.req.param("id"), "id"),
          actor,
        ),
      },
    ]),
  );
  app.post(
    `${p}/packages/:id/external-price`,
    route("packages.write", async (c, actor) => {
      const id = param(IdSchema, c.req.param("id"), "id");
      const { externalPriceId } = await body(
        c,
        GatewayExternalPriceIdRequestSchema,
      );
      return [
        {
          package: await billing.setPackageExternalPriceId(
            id,
            externalPriceId,
            actor,
          ),
        },
      ];
    }),
  );
  app.get(
    `${p}/topup-packs`,
    route("packages.read", async () => [
      { packs: await billing.listTopupPacks() },
    ]),
  );
  app.post(
    `${p}/topup-packs`,
    route("packages.write", async (c, actor) => [
      {
        pack: await billing.createTopupPack(
          await body(c, GatewayTopupPackCreateRequestSchema),
          actor,
        ),
      },
      201,
    ]),
  );
  app.post(
    `${p}/topup-packs/:id/archive`,
    route("packages.write", async (c, actor) => [
      {
        pack: await billing.archiveTopupPack(
          param(IdSchema, c.req.param("id"), "id"),
          actor,
        ),
      },
    ]),
  );
  app.post(
    `${p}/topup-packs/:id/external-price`,
    route("packages.write", async (c, actor) => {
      const id = param(IdSchema, c.req.param("id"), "id");
      const { externalPriceId } = await body(
        c,
        GatewayExternalPriceIdRequestSchema,
      );
      return [
        {
          pack: await billing.setTopupPackExternalPriceId(
            id,
            externalPriceId,
            actor,
          ),
        },
      ];
    }),
  );
  app.post(
    `${p}/billing/rollover`,
    route("billing.rollover", async (c, actor) => {
      const input = await body(c, GatewayRolloverRequestSchema);
      const subscriptions = await billing.rollover({
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        actor,
      });
      return [
        {
          subscriptions,
          failed: subscriptions.filter((outcome) => outcome.error).length,
        },
      ];
    }),
  );
  app.post(
    `${p}/tenants/:tenantId/wallet/adjust`,
    route("wallet.adjust", async (c, actor) => {
      const tenantId = param(
        TenantIdSchema,
        c.req.param("tenantId"),
        "tenantId",
      );
      const input = await body(c, GatewayWalletAdjustRequestSchema);
      const result = await billing.adjustWallet({ tenantId, ...input, actor });
      return [result, result.replayed ? 200 : 201];
    }),
  );
  app.post(
    `${p}/tenants/:tenantId/wallet/status`,
    route("wallet.adjust", async (c, actor) => {
      const tenantId = param(
        TenantIdSchema,
        c.req.param("tenantId"),
        "tenantId",
      );
      const input = await body(c, GatewayWalletStatusRequestSchema);
      return [
        {
          wallet: await billing.setWalletStatus({ tenantId, ...input, actor }),
        },
      ];
    }),
  );
  return app;
}
