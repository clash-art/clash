/**
 * The admin listener (#372, N15): what a `GATEWAY_ROLE=admin` node serves,
 * and the only role that serves it (server.ts). Guide:
 * apps/docs/guide/gateway-admin.md#node-admin-listener.
 *
 *   /admin, /admin/*      the shared console: the same apps/web build as the
 *                         hosted one (GATEWAY_ADMIN_WEB_DIR = apps/web/dist/client),
 *                         index.html for every console path
 *   /_app/*, /<file>.<ext> that build's static assets (only files it contains)
 *   /api/admin-auth/*     the admin identity's own Better Auth (admin-auth.ts)
 *   /api/v1/admin/*       the admin API, behind gateway-core's admin gate:
 *                         an admin session only (401 / 403
 *                         GATEWAY_ADMIN_SESSION_REQUIRED otherwise)
 *
 * Admin API under /api/v1/admin/gateway (permissions: gateway-core admin-authz.ts):
 *
 *   GET  /me                          account + the permissions it holds here
 *   GET  /overview (?tenantId)        30-day spend, requests, failures      usage.read_all
 *   GET  /usage    (?tenantId, …)     ledger entries + per-model totals     usage.read_all
 *   GET  /tenants  (?query)           every tenant                          tenants.list
 *   GET  /tenants/:tenantId/members   members and roles                     team.members.read
 *   GET  /tenants/:tenantId/budgets   wallet, member and key budgets        budgets.read
 *   GET  /tenants/:tenantId/keys      virtual keys (no hashes)              keys.read
 *   GET  /abuse                       live rate counters and leases         abuse.read
 *   …    packages, top-up packs, prices, rollover, wallet adjust/status
 *        (gateway-billing-routes.ts) and /encryption{,/rotate,/reencrypt}
 *        (gateway-key-admin.ts), mounted here behind the same gate.
 *
 * Any other /api/v1/admin/* path is 501 GATEWAY_CAPABILITY_UNAVAILABLE. The
 * host mounts this app before the product routes, so no product
 * authentication runs on admin paths.
 *
 * `/me` reports the role's permissions that this listener serves
 * (NODE_ADMIN_SERVED_PERMISSIONS): the console offers a page or an action
 * only for a reported permission, so it never shows a page this host cannot
 * answer (catalog, upstreams, audit, admin accounts and abuse actions are
 * not served by Node yet).
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  GATEWAY_ADMIN_API_PREFIX,
  GATEWAY_ADMIN_AUTH_BASE_PATH,
  GatewayError,
  adminConsolePermissions,
  adminRolePermissions,
  gatewayErrorResponseInit,
  resolveGatewayAdminRequest,
  toGatewayError,
  type GatewayAdminAccountIdentity,
  type GatewayBillingPort,
  type GatewayClock,
  type GatewayPermission,
} from "@clash/gateway-core";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type Env } from "hono";
import { z } from "zod";
import { createPgAdminReads, NODE_USAGE_KINDS } from "./gateway-admin-reads.ts";
import type { GatewayBudgetSqlClient } from "./gateway-budget.ts";
import type { GatewayRole } from "./gateway-node.ts";

export const GATEWAY_ADMIN_CONSOLE_API = `${GATEWAY_ADMIN_API_PREFIX}/gateway`;

/** The admin permissions this listener answers; `/me` reports only these. */
export const NODE_ADMIN_SERVED_PERMISSIONS: ReadonlySet<GatewayPermission> = new Set<GatewayPermission>([
  "usage.read_all",
  "tenants.list",
  "team.members.read",
  "budgets.read",
  "keys.read",
  "abuse.read",
  // gateway-billing-routes.ts
  "wallet.adjust",
  "packages.read",
  "packages.write",
  "billing.rollover",
  "prices.read",
  "prices.write",
  // gateway-key-admin.ts
  "encryption.read",
  "encryption.rotate",
]);

/** The shared console build a Node admin listener serves (apps/web `vite build` output). */
export interface AdminWebBuild {
  /** Absolute directory holding index.html and `_app/`. */
  directory: string;
  indexHtml: string;
}

/** Read the console build once at startup; a missing or incomplete build fails the start. */
export function loadAdminWebBuild(directory: string | undefined): AdminWebBuild {
  if (!directory?.trim())
    throw Error("GATEWAY_ROLE=admin requires GATEWAY_ADMIN_WEB_DIR (the apps/web build: apps/web/dist/client)");
  const absolute = resolve(directory.trim());
  const index = resolve(absolute, "index.html");
  if (!existsSync(index)) throw Error(`GATEWAY_ADMIN_WEB_DIR has no index.html: ${absolute}`);
  return { directory: absolute, indexHtml: readFileSync(index, "utf8") };
}

/**
 * The node's root app: on GATEWAY_ROLE=admin the admin listener, routed
 * before every product route; on any other role the listener is never built,
 * so no console page, asset or admin API path is served there.
 */
export function withGatewayAdminListener<E extends Env>(role: GatewayRole, product: Hono<E>, createListener: () => Hono): Hono {
  const root = new Hono();
  if (role === "admin") root.route("/", createListener());
  root.route("/", product);
  return root;
}

const NO_STORE = { "cache-control": "no-store" };

function fail(c: Context, error: unknown) {
  const init = gatewayErrorResponseInit(toGatewayError(error), "openai");
  return c.json(init.body, init.status as 400, { ...init.headers, ...NO_STORE });
}

function parse<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { param: name } });
  return parsed.data;
}

const TenantIdSchema = z.string().min(1).max(256);
const identifier = () => z.string().regex(/^[A-Za-z0-9._:@/-]{1,256}$/);
const limit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const UsageQuerySchema = z
  .object({
    tenantId: TenantIdSchema.optional(),
    userId: identifier().optional(),
    keyId: identifier().optional(),
    modelCode: z.string().regex(/^[A-Za-z0-9._:/-]{1,256}$/).optional(),
    kind: z.enum(NODE_USAGE_KINDS).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: limit(500, 100),
  })
  .strict();
const TenantListQuerySchema = z.object({ query: z.string().trim().min(1).max(128).optional(), limit: limit(500, 100) }).strict();
const OverviewQuerySchema = z.object({ tenantId: TenantIdSchema.optional() }).strict();

export interface GatewayAdminListenerDeps {
  db: GatewayBudgetSqlClient;
  billing: Pick<GatewayBillingPort, "walletSummary">;
  build: AdminWebBuild;
  /** The admin account behind the request's admin session cookie (admin-auth.ts), or null. */
  verifyAdminSession: (request: Request) => Promise<GatewayAdminAccountIdentity | null>;
  /** The admin Better Auth handler for /api/admin-auth/*. */
  adminAuthHandler: (request: Request) => Promise<Response>;
  /**
   * Admin route apps mounted behind the gate (billing, key ring). Their
   * `verifyAdmin` is `gatedAdmin`, the identity the gate already verified.
   */
  routes?: (gatedAdmin: (request: Request) => Promise<GatewayAdminAccountIdentity | null>) => Hono[];
  clock?: GatewayClock;
}

export function createGatewayAdminListener(deps: GatewayAdminListenerDeps): Hono {
  const app = new Hono();
  const reads = createPgAdminReads(deps.db, { clock: deps.clock ?? { now: () => Date.now() } });
  // The admin the gate verified for a request; mounted routes read it instead of a second session lookup.
  const verified = new WeakMap<Request, GatewayAdminAccountIdentity>();
  const gatedAdmin = async (request: Request) => verified.get(request) ?? null;

  // ─── Admin identity and the gate ─────────────────────────────────────────
  app.on(["GET", "POST"], `${GATEWAY_ADMIN_AUTH_BASE_PATH}/*`, (c) => deps.adminAuthHandler(c.req.raw));
  app.use(`${GATEWAY_ADMIN_API_PREFIX}/*`, async (c, next) => {
    const resolved = await resolveGatewayAdminRequest(c.req.raw, deps.verifyAdminSession);
    if ("error" in resolved) return fail(c, resolved.error);
    verified.set(c.req.raw, resolved.admin);
    await next();
  });

  const route =
    (permission: GatewayPermission, run: (c: Context) => Promise<unknown>) =>
    async (c: Context) => {
      try {
        const admin = verified.get(c.req.raw);
        if (!admin) throw new GatewayError("GATEWAY_AUTH_REQUIRED");
        if (!adminRolePermissions(admin.role).includes(permission))
          throw new GatewayError("GATEWAY_FORBIDDEN", { details: { permission } });
        return c.json((await run(c)) as object, 200, NO_STORE);
      } catch (error) {
        return fail(c, error);
      }
    };
  const query = (c: Context) => c.req.query();
  const tenantParam = (c: Context) => parse(TenantIdSchema, c.req.param("tenantId"), "tenantId");
  const p = GATEWAY_ADMIN_CONSOLE_API;

  app.get(`${p}/me`, (c) => {
    const admin = verified.get(c.req.raw)!;
    return c.json(
      {
        admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
        permissions: adminConsolePermissions(admin.role, (permission) => NODE_ADMIN_SERVED_PERMISSIONS.has(permission)),
        // Staff prompt access is hosted-only (#353); Node retains no bodies.
        promptAccess: false,
      },
      200,
      NO_STORE,
    );
  });
  app.get(
    `${p}/overview`,
    route("usage.read_all", async (c) => ({
      overview: await reads.overview(parse(OverviewQuerySchema, query(c), "query").tenantId),
    })),
  );
  app.get(
    `${p}/usage`,
    route("usage.read_all", async (c) => {
      const q = parse(UsageQuerySchema, query(c), "query");
      return reads.usage({
        ...(q.tenantId ? { tenantId: q.tenantId } : {}),
        ...(q.userId ? { userId: q.userId } : {}),
        ...(q.keyId ? { keyId: q.keyId } : {}),
        ...(q.modelCode ? { modelCode: q.modelCode } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.from ? { from: Date.parse(q.from) } : {}),
        ...(q.to ? { to: Date.parse(q.to) } : {}),
        limit: q.limit,
      });
    }),
  );
  app.get(
    `${p}/tenants`,
    route("tenants.list", async (c) => {
      const q = parse(TenantListQuerySchema, query(c), "query");
      return { tenants: await reads.tenants({ ...(q.query ? { query: q.query } : {}), limit: q.limit }) };
    }),
  );
  app.get(`${p}/tenants/:tenantId/members`, route("team.members.read", async (c) => ({ members: await reads.members(tenantParam(c)) })));
  app.get(
    `${p}/tenants/:tenantId/budgets`,
    route("budgets.read", async (c) => {
      const tenantId = tenantParam(c);
      // As api-cf: the wallet and live subscription come from the billing port (#425).
      const [budgets, summary] = await Promise.all([reads.budgets(tenantId), deps.billing.walletSummary(tenantId, 0)]);
      return { budgets, wallet: summary.wallet, subscription: summary.subscription };
    }),
  );
  app.get(`${p}/tenants/:tenantId/keys`, route("keys.read", async (c) => ({ keys: await reads.keys(tenantParam(c)) })));
  app.get(`${p}/abuse`, route("abuse.read", async () => ({ abuse: await reads.abuse() })));

  for (const mounted of deps.routes?.(gatedAdmin) ?? []) app.route("/", mounted);
  // The admin namespace ends here: an admin route this host does not serve is coded, never a product route.
  app.all(`${GATEWAY_ADMIN_API_PREFIX}/*`, (c) =>
    fail(c, new GatewayError("GATEWAY_CAPABILITY_UNAVAILABLE", { details: { path: c.req.path } })),
  );

  // ─── The console build ───────────────────────────────────────────────────
  const index = (c: Context) =>
    c.html(deps.build.indexHtml, 200, {
      ...NO_STORE,
      "x-content-type-options": "nosniff",
      "content-security-policy": "frame-ancestors 'none'",
    });
  app.get("/admin", index);
  app.get("/admin/*", index);
  // serveStatic resolves its root against the working directory.
  const root = relative(process.cwd(), deps.build.directory) || ".";
  app.use(
    "/_app/*",
    async (c, next) => {
      await next();
      // Vite content-hashes every file under _app. (serveStatic's onFound runs after its response is built.)
      if (c.res.status === 200) c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
    },
    serveStatic({ root }),
  );
  // The build's top-level files (favicon, manifest, icons) only: serveStatic answers when the file exists.
  app.get("/:file{[A-Za-z0-9][A-Za-z0-9._-]*\\.[A-Za-z0-9]+}", serveStatic({ root }));
  return app;
}
