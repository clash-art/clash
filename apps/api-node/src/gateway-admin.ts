/**
 * The Node gateway admin API on its own listener (#371, N14; guide:
 * apps/docs/guide/gateway-admin.md#node-admin-listener).
 *
 * The admin API is served by a second HTTP server (GATEWAY_ADMIN_PORT, on
 * GATEWAY_ADMIN_HOST, loopback by default) so it can sit on a private
 * network; the public data-plane listener answers 404 for every
 * /api/v1/admin path (withoutGatewayAdminPaths), and the admin listener
 * serves nothing else.
 *
 * Every route names one permission (gateway-admin-authz.ts: single
 * platform_admin role); the principal is an admin token
 * (gateway-admin-tokens.ts), never a product user. A mutation carrying an
 * Origin (a browser) must come from GATEWAY_ADMIN_ORIGINS, else
 * GATEWAY_ADMIN_ORIGIN_REJECTED: the CSRF check. Every mutation writes its
 * gateway_admin_audit row in the same transaction. No response carries a
 * secret: token hashes, upstream envelopes and key material are never read
 * into a view.
 *
 * Self-host default (decisions 8 and 10): Node retains no request or response
 * body, so staff prompt viewing is refused (GATEWAY_PROMPT_ACCESS_DISABLED)
 * whatever the role.
 *
 * Under /api/v1/admin/gateway:
 *
 *   GET  /me                                          the caller and its permissions     (any admin)
 *   GET  /tenants                                     teams with wallet                   tenants.list
 *   GET  /tenants/:tenantId/members                   users of a team                    team.members.read
 *   GET  /tenants/:tenantId/budgets                   budgets                            budgets.read
 *   PUT  /tenants/:tenantId/budgets/:scope/:scopeId   allocate a user or key budget      team.budgets.allocate
 *   GET  /tenants/:tenantId/keys                      virtual keys (metadata)            keys.read
 *   POST /tenants/:tenantId/keys/:keyId/revoke        revoke a virtual key               keys.revoke
 *   GET  /usage                                       usage totals (+ events of a tenant) usage.read | usage.read_all
 *   GET  /audit                                       admin audit                        audit.read | audit.read_all
 *   GET  /catalog, /catalog/versions/:version         models                             catalog.read
 *   POST /catalog/versions/:version/clone             new draft from a version           catalog.write
 *   PUT|DELETE /catalog/versions/:v/models/:code      edit a draft                       catalog.write
 *   POST /catalog/versions/:version/publish           publish a draft                    catalog.write
 *   GET  /upstreams                                   routes (credential metadata)       upstreams.read
 *   PATCH /upstreams/:id                              enable, priority, weight, max rps  upstreams.write
 *   GET  /abuse                                       suspensions, failure and spend     abuse.read
 *   POST /abuse/suspensions, /:id/lift                suspend or lift a tenant or key    abuse.suspend
 *   POST /prompts/:requestId/access                   always GATEWAY_PROMPT_ACCESS_DISABLED prompts.view
 *   GET|POST /admin-tokens, POST /admin-tokens/:id/revoke  admin credentials             admin_accounts.*
 *
 * plus the price book, packages, rollover and wallet routes
 * (gateway-billing-routes.ts) and the encryption key ring routes
 * (gateway-key-admin.ts).
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import {
  GatewayBudgetSetRequestSchema,
  GatewayCatalogCloneRequestSchema,
  GatewayCatalogModelRequestSchema,
  GatewayCatalogVersionSchema,
  GatewayError,
  GatewayLiftSuspensionRequestSchema,
  GatewayModelCodeSchema,
  GatewayPromptAccessRequestSchema,
  GatewaySuspendRequestSchema,
  applyGatewayCatalogPolicy,
  gatewayErrorResponseInit,
  isBlockedDeepSeekModel,
  parseGatewayJsonBody,
  presentsGatewayAdminSession,
  toGatewayError,
  type GatewayAdminAccountIdentity,
  type GatewayBillingPort,
  type GatewayPriceBookPort,
} from "@clash/gateway-core";
import { ModelCardSchema } from "@clash/shared-types";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { httpOrigin } from "./config.ts";
import {
  GATEWAY_ADMIN_ROLES,
  gatewayAdminPermissions,
  requireGatewayAdmin,
  type GatewayAdminActor,
  type GatewayAdminPermission,
  type GatewayAdminPrincipal,
} from "./gateway-admin-authz.ts";
import type { PgGatewayAdminTokens } from "./gateway-admin-tokens.ts";
import { createGatewayBillingAdminRoutes } from "./gateway-billing-routes.ts";
import { mountAdminConsole, type AdminWebBuild } from "./gateway-admin-console.ts";
import { createPgAdminReads } from "./gateway-admin-reads.ts";
import type {
  GatewayBudgetDatabase,
  GatewayBudgetSqlClient,
} from "./gateway-budget.ts";
import type { GatewayCredentialStore } from "./gateway-credentials.ts";
import {
  appendGatewayAdminAudit,
  createGatewayKeyAdminRoutes,
} from "./gateway-key-admin.ts";
import type { GatewayKeyRing } from "./gateway-keyring.ts";
import { createPgGatewayLedgerPort } from "./gateway-node.ts";

export const GATEWAY_ADMIN_PREFIX = "/api/v1/admin/gateway";

const NO_STORE = { "cache-control": "no-store" };
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const NOT_FOUND_BODY = {
  error: { type: "not_found_error", message: "Not found." },
};

// ─── Listener separation ─────────────────────────────────────────────────────

/**
 * True for any /api/v1/admin path, however spelled: percent-encoding, case
 * and repeated slashes are normalized first, and an undecodable path counts
 * as admin (refused rather than guessed at).
 */
export function isGatewayAdminPath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  const normalized = decoded.replace(/[\\/]+/g, "/").toLowerCase();
  return normalized === "/api/v1/admin" || normalized.startsWith("/api/v1/admin/");
}

/** The public listener's fetch: 404 for admin paths, served by the admin listener only. */
export function withoutGatewayAdminPaths<Rest extends unknown[]>(
  fetch: (request: Request, ...rest: Rest) => Response | Promise<Response>,
): (request: Request, ...rest: Rest) => Response | Promise<Response> {
  return (request, ...rest) =>
    isGatewayAdminPath(new URL(request.url).pathname)
      ? Response.json(NOT_FOUND_BODY, { status: 404, headers: NO_STORE })
      : fetch(request, ...rest);
}

/**
 * The node's HTTP servers, not yet listening: the public one (admin paths
 * 404) and, when configured, the admin one serving only `adminFetch`.
 */
export function createGatewayHttpServers(input: {
  publicFetch: (request: Request) => Response | Promise<Response>;
  adminFetch?: (request: Request) => Response | Promise<Response>;
}): { server: Server; adminServer?: Server } {
  const serve = (fetch: (request: Request) => Response | Promise<Response>) => {
    const server = createServer(getRequestListener(fetch));
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    return server;
  };
  return {
    server: serve(withoutGatewayAdminPaths(input.publicFetch)),
    ...(input.adminFetch ? { adminServer: serve(input.adminFetch) } : {}),
  };
}

export interface GatewayAdminListenerConfig {
  port: number;
  hostname: string;
  /** Browser origins allowed to send admin mutations; none: CLI/API clients only. */
  allowedOrigins: readonly string[];
}

/**
 * GATEWAY_ADMIN_PORT (unset: no admin listener), GATEWAY_ADMIN_HOST
 * (127.0.0.1) and GATEWAY_ADMIN_ORIGINS (comma-separated http(s) origins).
 * The admin port is never the public one.
 */
export function gatewayAdminListenerFromEnv(
  env: Record<string, string | undefined>,
  publicPort: number,
): GatewayAdminListenerConfig | undefined {
  const raw = env.GATEWAY_ADMIN_PORT?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("GATEWAY_ADMIN_PORT must be an integer between 1 and 65535");
  if (port === publicPort)
    throw Error("GATEWAY_ADMIN_PORT must differ from PORT");
  const allowedOrigins = (env.GATEWAY_ADMIN_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => httpOrigin(value, "GATEWAY_ADMIN_ORIGINS"));
  return {
    port,
    hostname: env.GATEWAY_ADMIN_HOST?.trim() || "127.0.0.1",
    allowedOrigins,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Sql = GatewayBudgetSqlClient;
type Num = string | number;
type Json = Record<string, unknown>;

const toSeconds = (ms: number) => Math.floor(ms / 1000);
const num = (value: Num) => Number(value);
const numOrNull = (value: Num | null) => (value === null ? null : Number(value));
const iso = (seconds: Num | null) =>
  seconds === null ? null : new Date(Number(seconds) * 1000).toISOString();
const newId = (prefix: string) => `${prefix}${randomBytes(16).toString("hex")}`;

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9._:@/-]{1,256}$/);
const reason = () => z.string().trim().min(1).max(500);
const OptionalReasonSchema = z.object({ reason: reason().optional() }).strict();
const limitQuery = (max: number, fallback: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);
const instantQuery = () => z.iso.datetime({ offset: true }).optional();

function fail(c: Context, error: unknown) {
  const init = gatewayErrorResponseInit(toGatewayError(error), "openai");
  return c.json(init.body, init.status as 400, { ...init.headers, ...NO_STORE });
}

function param<T>(schema: z.ZodType<T>, value: string | undefined, name: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new GatewayError("GATEWAY_INVALID_REQUEST", { details: { param: name } });
  return parsed.data;
}

function query<T>(schema: z.ZodType<T>, c: Context): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success)
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      details: {
        fields: parsed.error.issues.slice(0, 20).map((issue) => issue.path.join(".")),
      },
    });
  return parsed.data;
}

const body = async <T>(c: Context, schema: z.ZodType<T>) =>
  parseGatewayJsonBody(await c.req.text(), schema);

async function locked(tx: Sql, key: string) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
}

/** Validate a card for `modelCode` against ModelCardSchema and the catalog policy (as api-cf). */
export function validateGatewayCatalogCard(modelCode: string, card: unknown) {
  const parsed = ModelCardSchema.safeParse(card);
  if (!parsed.success)
    throw new GatewayError("GATEWAY_CATALOG_MODEL_INVALID", {
      details: {
        modelCode,
        fields: parsed.error.issues.slice(0, 20).map((issue) => issue.path.join(".")),
      },
    });
  if (parsed.data.id !== modelCode)
    throw new GatewayError("GATEWAY_CATALOG_MODEL_INVALID", {
      details: { modelCode, reason: "id_mismatch" },
    });
  const { excluded } = applyGatewayCatalogPolicy({ version: "draft", models: [parsed.data] });
  if (excluded.length > 0 || isBlockedDeepSeekModel(modelCode))
    throw new GatewayError("GATEWAY_CATALOG_MODEL_BLOCKED", { details: { modelCode } });
  return parsed.data;
}

// ─── Views (no secret column is ever selected) ───────────────────────────────

interface BudgetRow extends Json {
  id: string;
  tenant_id: string;
  scope: string;
  scope_id: string;
  parent_budget_id: string | null;
  limit_micro_credits: Num | null;
  spent_micro_credits: Num;
  reserved_micro_credits: Num;
  status: string;
  enforcement: string;
  alert_threshold_pct: number | null;
  version: Num;
  updated_at: Num;
}
const BUDGET_COLUMNS = `id, tenant_id, scope, scope_id, parent_budget_id, limit_micro_credits,
  spent_micro_credits, reserved_micro_credits, status, enforcement, alert_threshold_pct, version, updated_at`;
const budgetView = (row: BudgetRow) => ({
  id: row.id,
  scope: row.scope,
  scopeId: row.scope_id,
  parentBudgetId: row.parent_budget_id,
  limitMicroCredits: numOrNull(row.limit_micro_credits),
  spentMicroCredits: num(row.spent_micro_credits),
  reservedMicroCredits: num(row.reserved_micro_credits),
  status: row.status,
  enforcement: row.enforcement,
  alertThresholdPct: row.alert_threshold_pct,
  updatedAt: iso(row.updated_at),
});
const budgetSnapshot = (row: BudgetRow) => ({
  limitMicroCredits: numOrNull(row.limit_micro_credits),
  status: row.status,
  enforcement: row.enforcement,
  alertThresholdPct: row.alert_threshold_pct,
  spentMicroCredits: num(row.spent_micro_credits),
  reservedMicroCredits: num(row.reserved_micro_credits),
});

interface KeyRow extends Json {
  id: string;
  user_id: string;
  token_prefix: string;
  label: string | null;
  model_allowlist: unknown;
  credential_scope: string;
  expires_at: Num | null;
  revoked_at: Num | null;
  created_at: Num;
}
const KEY_COLUMNS =
  "id, user_id, token_prefix, label, model_allowlist, credential_scope, expires_at, revoked_at, created_at";
const keyView = (row: KeyRow) => ({
  id: row.id,
  userId: row.user_id,
  prefix: row.token_prefix,
  label: row.label,
  modelAllowlist: Array.isArray(row.model_allowlist) ? row.model_allowlist : null,
  credentialScope: row.credential_scope,
  expiresAt: iso(row.expires_at),
  revokedAt: iso(row.revoked_at),
  createdAt: iso(row.created_at),
});

interface UpstreamRow extends Json {
  id: string;
  scope: string;
  tenant_key: string;
  provider_id: string;
  upstream_id: string;
  account_id: string;
  region: string;
  label: string | null;
  key_version: string;
  enabled: number;
  priority: number | null;
  weight: number | null;
  max_rps: number | null;
  updated_at: Num;
}
// Never encrypted_credentials.
const UPSTREAM_COLUMNS = `id, scope, tenant_key, provider_id, upstream_id, account_id, region, label,
  key_version, enabled, priority, weight, max_rps, updated_at`;
const upstreamView = (row: UpstreamRow) => ({
  id: row.id,
  scope: row.scope,
  tenantId: row.tenant_key || null,
  providerId: row.provider_id,
  upstreamId: row.upstream_id || null,
  accountId: row.account_id || null,
  region: row.region || null,
  label: row.label,
  keyVersion: row.key_version,
  enabled: row.enabled === 1,
  priority: row.priority,
  weight: row.weight,
  maxRps: row.max_rps,
  updatedAt: iso(row.updated_at),
});
const upstreamSnapshot = (row: UpstreamRow) => ({
  enabled: row.enabled === 1,
  priority: row.priority,
  weight: row.weight,
  maxRps: row.max_rps,
});

interface ModelRow extends Json {
  catalog_version: string;
  model_code: string;
  kind: string;
  display_name: string | null;
  enabled: number;
  card_json: unknown;
  max_output_tokens: number | null;
  rate_limit_json: unknown;
  published_at: Num | null;
}
const MODEL_COLUMNS = `catalog_version, model_code, kind, display_name, enabled, card_json,
  max_output_tokens, rate_limit_json, published_at`;
const modelView = (row: ModelRow) => ({
  modelCode: row.model_code,
  kind: row.kind,
  displayName: row.display_name,
  enabled: row.enabled === 1,
  maxOutputTokens: row.max_output_tokens,
  rateLimit: row.rate_limit_json ?? null,
  publishedAt: iso(row.published_at),
  card: row.card_json,
});
const modelSnapshot = (row: Pick<ModelRow, "kind" | "display_name" | "enabled" | "max_output_tokens" | "rate_limit_json">) => ({
  kind: row.kind,
  displayName: row.display_name,
  enabled: row.enabled === 1,
  maxOutputTokens: row.max_output_tokens,
  rateLimit: row.rate_limit_json ?? null,
});

/** The catalog version the data plane routes now (gateway-node.ts routes port). */
const LIVE_CATALOG_SQL = `(SELECT catalog_version FROM gateway_model
   WHERE published_at IS NOT NULL AND published_at <= $1
   ORDER BY published_at DESC, catalog_version DESC LIMIT 1)`;

// ─── Request bodies specific to the Node listener ────────────────────────────

const nullableCount = () => z.number().int().min(0).max(1_000_000).nullable().optional();
const UpstreamPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    priority: nullableCount(),
    weight: nullableCount(),
    maxRps: nullableCount(),
    reason: reason().optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.enabled !== undefined ||
      patch.priority !== undefined ||
      patch.weight !== undefined ||
      patch.maxRps !== undefined,
    { message: "nothing to change" },
  );

const AdminTokenCreateSchema = z
  .object({
    role: z.enum(GATEWAY_ADMIN_ROLES),
    label: z.string().trim().min(1).max(100).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    reason: reason().optional(),
  })
  .strict();

const UsageQuerySchema = z.object({
  tenantId: IdentifierSchema.optional(),
  userId: IdentifierSchema.optional(),
  keyId: IdentifierSchema.optional(),
  from: instantQuery(),
  to: instantQuery(),
  limit: limitQuery(500, 100),
});
const AuditQuerySchema = z.object({
  tenantId: IdentifierSchema.optional(),
  action: z.string().regex(/^[a-z_.]{1,64}$/).optional(),
  limit: limitQuery(500, 100),
});
const AbuseQuerySchema = z.object({
  windowMinutes: z.coerce.number().int().min(1).max(1440).default(60),
  limit: limitQuery(200, 50),
});
const BudgetScopeSchema = z.enum(["user", "key"]);

// ─── App ─────────────────────────────────────────────────────────────────────

export interface GatewayAdminAppDeps {
  db: GatewayBudgetDatabase;
  tokens: PgGatewayAdminTokens;
  billing: GatewayBillingPort;
  priceBook: GatewayPriceBookPort;
  /** The key ring routes are mounted only on a node holding the ring. */
  keyRing?: { ring: GatewayKeyRing; store: GatewayCredentialStore };
  /** Browser origins allowed to send mutations (the CSRF check). */
  allowedOrigins?: readonly string[];
  /** Epoch milliseconds. */
  now?: () => number;
  /**
   * Shared `/admin` SPA (#372): only when GATEWAY_ROLE=admin. Mounts the
   * apps/web build and optional Better Auth handler for console sign-in.
   * API-only admin listeners (GATEWAY_ADMIN_PORT without admin role) omit this.
   */
  console?: {
    build: AdminWebBuild;
    adminAuthHandler?: (request: Request) => Promise<Response>;
    /** Admin Better Auth session → principal (alongside gwa_ tokens). */
    verifyAdminSession?: (request: Request) => Promise<GatewayAdminAccountIdentity | null>;
  };
}

/** The admin listener's whole app: admin routes, nothing else. */
export function createGatewayAdminApp(deps: GatewayAdminAppDeps): Hono {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const nowS = () => toSeconds(now());
  const allowed = new Set(deps.allowedOrigins ?? []);
  // Dual identity (#371 tokens + #372 admin sessions for the shared SPA):
  // no credential at all is 401; a product credential (cookie, clsh_, sk_gw_,
  // x-api-key) is GATEWAY_ADMIN_SESSION_REQUIRED; a gwa_ token or clash-admin
  // session is the principal.
  const verifyAdmin = async (request: Request): Promise<GatewayAdminPrincipal | null> => {
    const headers = request.headers;
    if (!headers.has("authorization") && !headers.has("x-api-key") && !headers.has("cookie"))
      throw new GatewayError("GATEWAY_AUTH_REQUIRED");
    const tokenPrincipal = await deps.tokens.verify(request);
    if (tokenPrincipal) return tokenPrincipal;
    if (deps.console?.verifyAdminSession && presentsGatewayAdminSession(request)) {
      const session = await deps.console.verifyAdminSession(request);
      if (session)
        return { id: session.id, role: session.role, email: session.email, name: session.name };
    }
    return null;
  };
  const app = new Hono();

  // CSRF: a browser (it sends Origin, or Sec-Fetch-Site) may change admin
  // state only from an allowed origin. Tokens travel in Authorization only,
  // and no CORS header is ever sent, so cross-origin reads are not exposed.
  app.use("*", async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      const rejected =
        origin !== undefined
          ? !allowed.has(origin)
          : site !== undefined && site !== "same-origin" && site !== "none";
      if (rejected)
        return fail(
          c,
          new GatewayError("GATEWAY_ADMIN_ORIGIN_REJECTED", {
            details: { origin: origin ?? null },
          }),
        );
    }
    await next();
  });

  async function principal(c: Context): Promise<GatewayAdminPrincipal> {
    const identity = await verifyAdmin(c.req.raw);
    if (!identity) throw new GatewayError("GATEWAY_ADMIN_SESSION_REQUIRED");
    return identity;
  }

  type Run = (
    c: Context,
    actor: GatewayAdminActor,
    tenantId: string | undefined,
  ) => Promise<[unknown] | [unknown, 200 | 201]>;

  /** A route allowed `permission`; on `:tenantId` when the path names one. */
  const route = (permission: GatewayAdminPermission, run: Run) => async (c: Context) => {
    try {
      const raw = c.req.param("tenantId");
      const tenantId = raw === undefined ? undefined : param(IdentifierSchema, raw, "tenantId");
      const actor = requireGatewayAdmin(await principal(c), permission, tenantId);
      const [result, status] = await run(c, actor, tenantId);
      return c.json(result as object, status ?? 200, NO_STORE);
    } catch (error) {
      return fail(c, error);
    }
  };

  /**
   * A route whose scope is a query `tenantId`: the tenant permission on that
   * tenant, else the platform-wide one (every tenant).
   */
  const scopedRoute =
    (
      tenantPermission: GatewayAdminPermission,
      platformPermission: GatewayAdminPermission,
      run: (c: Context, tenantId: string | undefined) => Promise<unknown>,
    ) =>
    async (c: Context) => {
      try {
        const raw = c.req.query("tenantId");
        const tenantId = raw === undefined ? undefined : param(IdentifierSchema, raw, "tenantId");
        const caller = await principal(c);
        if (tenantId) requireGatewayAdmin(caller, tenantPermission, tenantId);
        else requireGatewayAdmin(caller, platformPermission);
        return c.json((await run(c, tenantId)) as object, 200, NO_STORE);
      } catch (error) {
        return fail(c, error);
      }
    };

  const p = GATEWAY_ADMIN_PREFIX;

  app.get(`${p}/me`, async (c) => {
    try {
      const caller = await principal(c);
      // Omit encryption.* when this listener has no key ring so the shared
      // console never offers the encryption page against an empty host.
      const permissions = gatewayAdminPermissions(caller).filter(
        (permission) => deps.keyRing || (permission !== "encryption.read" && permission !== "encryption.rotate"),
      );
      return c.json(
        {
          admin: {
            id: caller.id,
            role: caller.role,
            email: caller.email ?? "",
            name: caller.name ?? "",
          },
          permissions,
          promptAccess: false,
        },
        200,
        NO_STORE,
      );
    } catch (error) {
      return fail(c, error);
    }
  });

  // ─── Teams and users ───────────────────────────────────────────────────────

  app.get(
    `${p}/tenants`,
    route("tenants.list", async (c) => {
      const { limit } = query(z.object({ limit: limitQuery(500, 100) }), c);
      const { rows } = await db.query<{
        id: string;
        name: string;
        owner_user_id: string;
        members: number;
        wallet_id: string | null;
        limit_micro_credits: Num | null;
        spent_micro_credits: Num | null;
        wallet_status: string | null;
      }>(
        `SELECT t.id, t.name, t.owner_user_id,
                (SELECT count(*)::int FROM tenant_member m WHERE m.tenant_id = t.id) AS members,
                b.id AS wallet_id, b.limit_micro_credits, b.spent_micro_credits, b.status AS wallet_status
           FROM tenant t
           LEFT JOIN gateway_budget b ON b.tenant_id = t.id AND b.scope = 'tenant' AND b.scope_id = t.id
          ORDER BY t.id LIMIT $1`,
        [limit],
      );
      return [
        {
          tenants: rows.map((row) => ({
            id: row.id,
            name: row.name,
            ownerUserId: row.owner_user_id,
            members: row.members,
            wallet: row.wallet_id
              ? {
                  budgetId: row.wallet_id,
                  limitMicroCredits: numOrNull(row.limit_micro_credits),
                  spentMicroCredits: num(row.spent_micro_credits ?? 0),
                  status: row.wallet_status,
                }
              : null,
          })),
        },
      ];
    }),
  );

  app.get(
    `${p}/tenants/:tenantId/members`,
    route("team.members.read", async (_c, _actor, tenantId) => {
      const { rows } = await db.query<{
        user_id: string;
        role: string;
        email: string | null;
        name: string | null;
      }>(
        `SELECT m.user_id, m.role, u.email, u.name
           FROM tenant_member m LEFT JOIN auth_user u ON u.id = m.user_id
          WHERE m.tenant_id = $1 ORDER BY m.user_id`,
        [tenantId],
      );
      return [
        {
          members: rows.map((row) => ({
            userId: row.user_id,
            role: row.role,
            email: row.email,
            name: row.name,
          })),
        },
      ];
    }),
  );

  // ─── Budgets ───────────────────────────────────────────────────────────────

  const budgetRow = async (sql: Sql, tenantId: string, scope: string, scopeId: string) =>
    (
      await sql.query<BudgetRow>(
        `SELECT ${BUDGET_COLUMNS} FROM gateway_budget WHERE tenant_id = $1 AND scope = $2 AND scope_id = $3`,
        [tenantId, scope, scopeId],
      )
    ).rows[0];

  app.get(
    `${p}/tenants/:tenantId/budgets`,
    route("budgets.read", async (_c, _actor, tenantId) => {
      const { rows } = await db.query<BudgetRow>(
        `SELECT ${BUDGET_COLUMNS} FROM gateway_budget WHERE tenant_id = $1
          ORDER BY scope <> 'tenant', scope, scope_id`,
        [tenantId],
      );
      return [{ budgets: rows.map(budgetView) }];
    }),
  );

  /**
   * Set a member (`user`) or key budget under the tenant wallet, as the
   * hosted team settings do (d1-tenant-admin.ts setBudget): a limit below
   * spend + reserved is GATEWAY_BUDGET_BELOW_USAGE unless overridden with a
   * reason (`budget.override`). null is explicitly unlimited.
   */
  app.put(
    `${p}/tenants/:tenantId/budgets/:scope/:scopeId`,
    route("team.budgets.allocate", async (c, actor, tenantId) => {
      const tenant = tenantId!;
      const scope = param(BudgetScopeSchema, c.req.param("scope"), "scope");
      const scopeId = param(IdentifierSchema, c.req.param("scopeId"), "scopeId");
      const input = await body(c, GatewayBudgetSetRequestSchema);
      if (scope === "user") {
        const member =
          tenant === `personal:${scopeId}` ||
          (
            await db.query(`SELECT 1 AS found FROM tenant_member WHERE tenant_id = $1 AND user_id = $2`, [
              tenant,
              scopeId,
            ])
          ).rows.length > 0;
        if (!member)
          throw new GatewayError("GATEWAY_MEMBER_NOT_FOUND", { details: { tenantId: tenant, userId: scopeId } });
      } else if (
        (await db.query(`SELECT 1 AS found FROM gateway_virtual_key WHERE id = $1 AND tenant_id = $2`, [scopeId, tenant]))
          .rows.length === 0
      )
        throw new GatewayError("GATEWAY_KEY_NOT_FOUND", { details: { tenantId: tenant, keyId: scopeId } });
      const override = input.override === true;
      const target = `${scope}:${scopeId}`;
      const belowUsage = (row: BudgetRow) =>
        new GatewayError("GATEWAY_BUDGET_BELOW_USAGE", {
          details: {
            budgetId: row.id,
            spentMicroCredits: num(row.spent_micro_credits),
            reservedMicroCredits: num(row.reserved_micro_credits),
          },
        });
      const written = await db.transaction(async (tx) => {
        await locked(tx, `gateway_budget:${tenant}:${target}`);
        const before = await budgetRow(tx, tenant, scope, scopeId);
        const limit = input.limitMicroCredits;
        const status = input.status ?? before?.status ?? "active";
        const enforcement = input.enforcement ?? before?.enforcement ?? "hard";
        const alertThresholdPct =
          input.alertThresholdPct !== undefined ? input.alertThresholdPct : (before?.alert_threshold_pct ?? null);
        if (
          before &&
          !override &&
          limit !== null &&
          limit < num(before.spent_micro_credits) + num(before.reserved_micro_credits)
        )
          throw belowUsage(before);
        const at = nowS();
        if (before)
          await tx.query(
            `UPDATE gateway_budget
                SET limit_micro_credits = $2, status = $3, enforcement = $4, alert_threshold_pct = $5,
                    version = version + 1, updated_at = $6
              WHERE id = $1`,
            [before.id, limit, status, enforcement, alertThresholdPct, at],
          );
        else
          await tx.query(
            `INSERT INTO gateway_budget
               (id, tenant_id, scope, scope_id, parent_budget_id, allocated_by_user_id, period,
                limit_micro_credits, status, enforcement, alert_threshold_pct, created_at, updated_at)
             VALUES ($1, $2, $3, $4,
                     (SELECT id FROM gateway_budget WHERE tenant_id = $2 AND scope = 'tenant' AND scope_id = $2),
                     $5, 'none', $6, $7, $8, $9, $10, $10)`,
            [newId(`gwb_${scope[0]}_`), tenant, scope, scopeId, actor.id, limit, status, enforcement, alertThresholdPct, at],
          );
        await appendGatewayAdminAudit(
          tx,
          {
            tenantId: tenant,
            actor,
            action: override ? "budget.override" : before ? "budget.update" : "budget.create",
            targetType: "budget",
            targetId: target,
            ...(before ? { before: budgetSnapshot(before) } : {}),
            after: { limitMicroCredits: limit, status, enforcement, alertThresholdPct },
            ...(input.reason ? { reason: input.reason } : {}),
          },
          at,
        );
        return (await budgetRow(tx, tenant, scope, scopeId))!;
      });
      return [{ budget: budgetView(written) }];
    }),
  );

  // ─── Keys ──────────────────────────────────────────────────────────────────

  app.get(
    `${p}/tenants/:tenantId/keys`,
    route("keys.read", async (_c, _actor, tenantId) => {
      const { rows } = await db.query<KeyRow>(
        `SELECT ${KEY_COLUMNS} FROM gateway_virtual_key WHERE tenant_id = $1 ORDER BY created_at DESC, id`,
        [tenantId],
      );
      return [{ keys: rows.map(keyView) }];
    }),
  );

  app.post(
    `${p}/tenants/:tenantId/keys/:keyId/revoke`,
    route("keys.revoke", async (c, actor, tenantId) => {
      const keyId = param(IdentifierSchema, c.req.param("keyId"), "keyId");
      const input = await body(c, OptionalReasonSchema);
      const key = await db.transaction(async (tx) => {
        const at = nowS();
        const { rows } = await tx.query<KeyRow>(
          `UPDATE gateway_virtual_key SET revoked_at = $3
            WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING ${KEY_COLUMNS}`,
          [keyId, tenantId, at],
        );
        if (rows[0]) {
          await appendGatewayAdminAudit(
            tx,
            {
              tenantId: tenantId!,
              actor,
              action: "key.revoke",
              targetType: "key",
              targetId: keyId,
              before: { revokedAt: null },
              after: { revokedAt: iso(at) },
              ...(input.reason ? { reason: input.reason } : {}),
            },
            at,
          );
          return rows[0];
        }
        const existing = await tx.query<KeyRow>(
          `SELECT ${KEY_COLUMNS} FROM gateway_virtual_key WHERE id = $1 AND tenant_id = $2`,
          [keyId, tenantId],
        );
        if (!existing.rows[0])
          throw new GatewayError("GATEWAY_KEY_NOT_FOUND", { details: { tenantId, keyId } });
        // Already revoked: nothing changes, nothing is audited.
        return existing.rows[0];
      });
      return [{ key: keyView(key) }];
    }),
  );

  // ─── Overview, usage and audit (#372 console shapes via gateway-admin-reads) ─

  const reads = createPgAdminReads(db, { clock: { now } });

  app.get(
    `${p}/overview`,
    scopedRoute("usage.read", "usage.read_all", async (c, tenantId) => {
      return { overview: await reads.overview(tenantId) };
    }),
  );

  app.get(
    `${p}/usage`,
    scopedRoute("usage.read", "usage.read_all", async (c, tenantId) => {
      const filter = query(
        UsageQuerySchema.extend({
          modelCode: z.string().regex(/^[A-Za-z0-9._:/-]{1,256}$/).optional(),
          kind: z
            .enum([
              "settle",
              "hold",
              "release",
              "charge",
              "debit",
              "refund",
              "adjust",
              "grant",
              "topup",
              "expire",
            ])
            .optional(),
        }),
        c,
      );
      const from = filter.from ? Date.parse(filter.from) : undefined;
      const to = filter.to ? Date.parse(filter.to) : undefined;
      const result = await reads.usage({
        ...(tenantId ? { tenantId } : {}),
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.keyId ? { keyId: filter.keyId } : {}),
        ...(filter.modelCode ? { modelCode: filter.modelCode } : {}),
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        limit: filter.limit,
      });
      return { ...result, nextCursor: null };
    }),
  );

  app.get(
    `${p}/audit`,
    scopedRoute("audit.read", "audit.read_all", async (c, tenantId) => {
      const filter = query(AuditQuerySchema, c);
      const { rows } = await db.query<{
        id: string;
        tenant_id: string;
        actor_kind: string;
        actor_id: string;
        actor_role: string;
        action: string;
        target_type: string;
        target_id: string;
        before_json: unknown;
        after_json: unknown;
        reason: string | null;
        created_at: Num;
      }>(
        `SELECT id, tenant_id, actor_kind, actor_id, actor_role, action, target_type, target_id,
                before_json, after_json, reason, created_at
           FROM gateway_admin_audit
          WHERE ($1::text IS NULL OR tenant_id = $1) AND ($2::text IS NULL OR action = $2)
          ORDER BY created_at DESC, id DESC LIMIT $3`,
        [tenantId ?? null, filter.action ?? null, filter.limit],
      );
      return {
        audit: rows.map((row) => ({
          id: row.id,
          tenantId: row.tenant_id || null,
          actor: { kind: row.actor_kind, id: row.actor_id, role: row.actor_role },
          action: row.action,
          targetType: row.target_type,
          targetId: row.target_id,
          before: row.before_json,
          after: row.after_json,
          reason: row.reason,
          at: iso(row.created_at),
        })),
      };
    }),
  );

  // ─── Catalog (models) ──────────────────────────────────────────────────────
  // As api-cf (d1-catalog-admin.ts, same response shapes): clone the live
  // version into a draft, edit the draft, publish it. Published rows never
  // change again.

  const versionRows = async (sql: Sql, version: string) =>
    (
      await sql.query<ModelRow>(
        `SELECT ${MODEL_COLUMNS} FROM gateway_model WHERE catalog_version = $1 ORDER BY model_code`,
        [version],
      )
    ).rows;
  const requireDraft = async (sql: Sql, version: string) => {
    const rows = await versionRows(sql, version);
    const published = rows.find((row) => row.published_at !== null);
    if (published)
      throw new GatewayError("GATEWAY_CATALOG_VERSION_PUBLISHED", {
        details: { version, publishedAt: iso(published.published_at) },
      });
    return rows;
  };
  const readVersion = async (sql: Sql, version: string) => {
    const rows = await versionRows(sql, version);
    if (rows.length === 0) throw new GatewayError("GATEWAY_CATALOG_VERSION_NOT_FOUND", { details: { version } });
    return {
      version,
      status: rows.some((row) => row.published_at !== null) ? "published" : "draft",
      models: rows.map(modelView),
    };
  };
  const versionParam = (c: Context) => param(GatewayCatalogVersionSchema, c.req.param("version"), "version");
  const modelParam = (c: Context) => param(GatewayModelCodeSchema, c.req.param("modelCode"), "modelCode");

  app.get(
    `${p}/catalog`,
    route("catalog.read", async () => {
      const { rows } = await db.query<{
        catalog_version: string;
        models: number;
        published_at: Num | null;
        created_at: Num;
        live: boolean | null;
      }>(
        `SELECT catalog_version, count(*)::int AS models, max(published_at) AS published_at,
                min(created_at) AS created_at, catalog_version = ${LIVE_CATALOG_SQL} AS live
           FROM gateway_model GROUP BY catalog_version
          ORDER BY (max(published_at) IS NULL) DESC, max(published_at) DESC, min(created_at) DESC, catalog_version DESC`,
        [nowS()],
      );
      return [
        {
          versions: rows.map((row) => ({
            version: row.catalog_version,
            status: row.published_at === null ? "draft" : "published",
            live: row.live === true,
            models: row.models,
            publishedAt: iso(row.published_at),
            createdAt: iso(row.created_at),
          })),
        },
      ];
    }),
  );

  app.get(
    `${p}/catalog/versions/:version`,
    route("catalog.read", async (c) => [{ version: await readVersion(db, versionParam(c)) }]),
  );

  app.post(
    `${p}/catalog/versions/:version/clone`,
    route("catalog.write", async (c, actor) => {
      const version = versionParam(c);
      const { from } = await body(c, GatewayCatalogCloneRequestSchema);
      const catalog = await db.transaction(async (tx) => {
        await locked(tx, `gateway_catalog:${version}`);
        if ((await versionRows(tx, version)).length > 0)
          throw new GatewayError("GATEWAY_CONFLICT", { details: { version, reason: "exists" } });
        const source = await versionRows(tx, from);
        if (source.length === 0)
          throw new GatewayError("GATEWAY_CATALOG_VERSION_NOT_FOUND", { details: { version: from } });
        const at = nowS();
        for (const row of source)
          await tx.query(
            `INSERT INTO gateway_model
               (id, catalog_version, model_code, kind, display_name, enabled, card_json,
                max_output_tokens, rate_limit_json, published_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,NULL,$10)`,
            [
              newId("gwm_"),
              version,
              row.model_code,
              row.kind,
              row.display_name,
              row.enabled,
              JSON.stringify(row.card_json),
              row.max_output_tokens,
              row.rate_limit_json === null ? null : JSON.stringify(row.rate_limit_json),
              at,
            ],
          );
        await appendGatewayAdminAudit(
          tx,
          {
            actor,
            action: "catalog.clone",
            targetType: "catalog_version",
            targetId: version,
            after: { from, models: source.map((row) => row.model_code) },
          },
          at,
        );
        return readVersion(tx, version);
      });
      return [{ version: catalog }, 201];
    }),
  );

  app.put(
    `${p}/catalog/versions/:version/models/:modelCode`,
    route("catalog.write", async (c, actor) => {
      const version = versionParam(c);
      const modelCode = modelParam(c);
      const input = await body(c, GatewayCatalogModelRequestSchema);
      const card = validateGatewayCatalogCard(modelCode, input.card);
      const model = await db.transaction(async (tx) => {
        await locked(tx, `gateway_catalog:${version}`);
        const before = (await requireDraft(tx, version)).find((row) => row.model_code === modelCode);
        const next = {
          kind: card.kind,
          display_name: input.displayName ?? null,
          enabled: input.enabled ? 1 : 0,
          max_output_tokens: input.maxOutputTokens ?? null,
          rate_limit_json: input.rateLimit ?? null,
        };
        const at = nowS();
        await tx.query(
          `INSERT INTO gateway_model
             (id, catalog_version, model_code, kind, display_name, enabled, card_json,
              max_output_tokens, rate_limit_json, published_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,NULL,$10)
           ON CONFLICT (catalog_version, model_code) DO UPDATE SET
             kind = EXCLUDED.kind, display_name = EXCLUDED.display_name, enabled = EXCLUDED.enabled,
             card_json = EXCLUDED.card_json, max_output_tokens = EXCLUDED.max_output_tokens,
             rate_limit_json = EXCLUDED.rate_limit_json`,
          [
            newId("gwm_"),
            version,
            modelCode,
            next.kind,
            next.display_name,
            next.enabled,
            JSON.stringify(card),
            next.max_output_tokens,
            next.rate_limit_json === null ? null : JSON.stringify(next.rate_limit_json),
            at,
          ],
        );
        await appendGatewayAdminAudit(
          tx,
          {
            actor,
            action: before ? "catalog.model.update" : "catalog.model.create",
            targetType: "catalog_model",
            targetId: `${version}/${modelCode}`,
            ...(before ? { before: modelSnapshot(before) } : {}),
            after: modelSnapshot(next),
          },
          at,
        );
        return (await versionRows(tx, version)).find((row) => row.model_code === modelCode)!;
      });
      return [{ model: modelView(model) }];
    }),
  );

  app.delete(
    `${p}/catalog/versions/:version/models/:modelCode`,
    route("catalog.write", async (c, actor) => {
      const version = versionParam(c);
      const modelCode = modelParam(c);
      await db.transaction(async (tx) => {
        await locked(tx, `gateway_catalog:${version}`);
        const before = (await requireDraft(tx, version)).find((row) => row.model_code === modelCode);
        if (!before)
          throw new GatewayError("GATEWAY_CATALOG_VERSION_NOT_FOUND", { details: { version, modelCode } });
        const at = nowS();
        await tx.query(
          `DELETE FROM gateway_model WHERE catalog_version = $1 AND model_code = $2 AND published_at IS NULL`,
          [version, modelCode],
        );
        await appendGatewayAdminAudit(
          tx,
          {
            actor,
            action: "catalog.model.remove",
            targetType: "catalog_model",
            targetId: `${version}/${modelCode}`,
            before: modelSnapshot(before),
          },
          at,
        );
      });
      return [{ removed: true }];
    }),
  );

  app.post(
    `${p}/catalog/versions/:version/publish`,
    route("catalog.write", async (c, actor) => {
      const version = versionParam(c);
      const catalog = await db.transaction(async (tx) => {
        await locked(tx, `gateway_catalog:${version}`);
        const rows = await requireDraft(tx, version);
        if (rows.length === 0) throw new GatewayError("GATEWAY_CATALOG_VERSION_NOT_FOUND", { details: { version } });
        // Re-check so a policy change can never publish a blocked model.
        for (const row of rows) validateGatewayCatalogCard(row.model_code, row.card_json);
        const at = nowS();
        await tx.query(
          `UPDATE gateway_model SET published_at = $2 WHERE catalog_version = $1 AND published_at IS NULL`,
          [version, at],
        );
        await appendGatewayAdminAudit(
          tx,
          {
            actor,
            action: "catalog.publish",
            targetType: "catalog_version",
            targetId: version,
            before: { status: "draft" },
            after: { status: "published", publishedAt: at, models: rows.map((row) => row.model_code) },
          },
          at,
        );
        return readVersion(tx, version);
      });
      return [{ version: catalog }];
    }),
  );

  // ─── Routes (upstream credentials, metadata only) ──────────────────────────

  app.get(
    `${p}/upstreams`,
    route("upstreams.read", async (c) => {
      const filter = query(
        z.object({ scope: z.enum(["official", "tenant"]).optional(), tenantId: IdentifierSchema.optional() }),
        c,
      );
      const { rows } = await db.query<UpstreamRow>(
        `SELECT ${UPSTREAM_COLUMNS} FROM gateway_upstream_credential
          WHERE ($1::text IS NULL OR scope = $1) AND ($2::text IS NULL OR tenant_key = $2)
          ORDER BY scope, tenant_key, COALESCE(priority, 1000), id`,
        [filter.scope ?? null, filter.tenantId ?? null],
      );
      return [{ upstreams: rows.map(upstreamView) }];
    }),
  );

  app.patch(
    `${p}/upstreams/:id`,
    route("upstreams.write", async (c, actor) => {
      const id = param(IdentifierSchema, c.req.param("id"), "id");
      const patch = await body(c, UpstreamPatchSchema);
      const upstream = await db.transaction(async (tx) => {
        const { rows } = await tx.query<UpstreamRow>(
          `SELECT ${UPSTREAM_COLUMNS} FROM gateway_upstream_credential WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const before = rows[0];
        if (!before) throw new GatewayError("GATEWAY_UPSTREAM_NOT_FOUND", { details: { upstreamId: id } });
        const at = nowS();
        const after = (
          await tx.query<UpstreamRow>(
            `UPDATE gateway_upstream_credential
                SET enabled = $2, priority = $3, weight = $4, max_rps = $5, updated_at = $6
              WHERE id = $1 RETURNING ${UPSTREAM_COLUMNS}`,
            [
              id,
              patch.enabled === undefined ? before.enabled : patch.enabled ? 1 : 0,
              patch.priority === undefined ? before.priority : patch.priority,
              patch.weight === undefined ? before.weight : patch.weight,
              patch.maxRps === undefined ? before.max_rps : patch.maxRps,
              at,
            ],
          )
        ).rows[0]!;
        await appendGatewayAdminAudit(
          tx,
          {
            ...(before.tenant_key ? { tenantId: before.tenant_key } : {}),
            actor,
            action: "upstream.update",
            targetType: "upstream",
            targetId: id,
            before: upstreamSnapshot(before),
            after: upstreamSnapshot(after),
            ...(patch.reason ? { reason: patch.reason } : {}),
          },
          at,
        );
        return after;
      });
      return [{ upstream: upstreamView(upstream) }];
    }),
  );

  // ─── Abuse ─────────────────────────────────────────────────────────────────
  // Node has no abuse signal store (gateway-node.ts ports.abuse): a
  // suspension is the `suspended` status of the subject's budget (a tenant's
  // wallet, a key's cap), which admission already refuses
  // (gateway-budget.ts). Its id is that budget's id. A key with no budget of
  // its own is stopped by revoking it (keys.revoke).

  const suspensionView = (row: BudgetRow) => ({
    id: row.id,
    subjectKind: row.scope,
    subjectId: row.scope_id,
    tenantId: row.tenant_id,
    status: row.status === "suspended" ? "active" : "lifted",
    since: iso(row.updated_at),
  });

  app.get(
    `${p}/abuse`,
    route("abuse.read", async () => {
      // Console shape (#372): live rate counters; Node has no abuse signal store yet.
      return [{ abuse: await reads.abuse() }];
    }),
  );

  app.post(
    `${p}/abuse/suspensions`,
    route("abuse.suspend", async (c, actor) => {
      const input = await body(c, GatewaySuspendRequestSchema);
      const suspension = await db.transaction(async (tx) => {
        let tenantId = input.subjectId;
        if (input.subjectKind === "key") {
          const { rows } = await tx.query<{ tenant_id: string }>(
            `SELECT tenant_id FROM gateway_virtual_key WHERE id = $1`,
            [input.subjectId],
          );
          if (!rows[0])
            throw new GatewayError("GATEWAY_ABUSE_SUBJECT_NOT_FOUND", {
              details: { subjectKind: input.subjectKind, subjectId: input.subjectId },
            });
          tenantId = rows[0].tenant_id;
        }
        await locked(tx, `gateway_budget:${tenantId}:${input.subjectKind}:${input.subjectId}`);
        const before = await budgetRow(tx, tenantId, input.subjectKind, input.subjectId);
        if (!before)
          throw new GatewayError("GATEWAY_ABUSE_SUBJECT_NOT_FOUND", {
            message:
              input.subjectKind === "key"
                ? "The key has no budget of its own to suspend; revoke the key instead."
                : "The tenant has no wallet to suspend.",
            details: { subjectKind: input.subjectKind, subjectId: input.subjectId, reason: "no_budget" },
          });
        if (before.status === "suspended")
          throw new GatewayError("GATEWAY_SUSPENSION_EXISTS", { details: { suspensionId: before.id } });
        const at = nowS();
        const after = (
          await tx.query<BudgetRow>(
            `UPDATE gateway_budget SET status = 'suspended', version = version + 1, updated_at = $2
              WHERE id = $1 RETURNING ${BUDGET_COLUMNS}`,
            [before.id, at],
          )
        ).rows[0]!;
        await appendGatewayAdminAudit(
          tx,
          {
            tenantId,
            actor,
            action: "abuse.suspend",
            targetType: "budget",
            targetId: before.id,
            before: { status: before.status },
            after: { status: "suspended", subjectKind: input.subjectKind, subjectId: input.subjectId },
            reason: input.reason,
          },
          at,
        );
        return suspensionView(after);
      });
      return [{ suspension }, 201];
    }),
  );

  app.post(
    `${p}/abuse/suspensions/:suspensionId/lift`,
    route("abuse.suspend", async (c, actor) => {
      const suspensionId = param(IdentifierSchema, c.req.param("suspensionId"), "suspensionId");
      const input = await body(c, GatewayLiftSuspensionRequestSchema);
      const suspension = await db.transaction(async (tx) => {
        const at = nowS();
        const { rows } = await tx.query<BudgetRow>(
          `UPDATE gateway_budget SET status = 'active', version = version + 1, updated_at = $2
            WHERE id = $1 AND status = 'suspended' AND scope IN ('tenant', 'key') RETURNING ${BUDGET_COLUMNS}`,
          [suspensionId, at],
        );
        const lifted = rows[0];
        if (!lifted) throw new GatewayError("GATEWAY_SUSPENSION_NOT_FOUND", { details: { suspensionId } });
        await appendGatewayAdminAudit(
          tx,
          {
            tenantId: lifted.tenant_id,
            actor,
            action: "abuse.lift",
            targetType: "budget",
            targetId: lifted.id,
            before: { status: "suspended" },
            after: { status: "active" },
            reason: input.reason,
          },
          at,
        );
        return suspensionView(lifted);
      });
      return [{ suspension }];
    }),
  );

  // ─── Prompts: never on self-host ───────────────────────────────────────────

  app.post(
    `${p}/prompts/:requestId/access`,
    route("prompts.view", async (c) => {
      param(IdentifierSchema, c.req.param("requestId"), "requestId");
      await body(c, GatewayPromptAccessRequestSchema);
      // Node keeps no request or response body (ports.retention is unavailable),
      // so there is nothing to show and the hosted staff policy does not apply.
      throw new GatewayError("GATEWAY_PROMPT_ACCESS_DISABLED", {
        details: { deployment: "self-host", retention: "none" },
      });
    }),
  );

  // ─── Admin tokens ──────────────────────────────────────────────────────────

  app.get(
    `${p}/admin-tokens`,
    route("admin_accounts.read", async () => [{ adminTokens: await deps.tokens.list() }]),
  );

  app.post(
    `${p}/admin-tokens`,
    route("admin_accounts.write", async (c, actor) => {
      const input = await body(c, AdminTokenCreateSchema);
      const issued = await deps.tokens.issue({
        role: input.role,
        ...(input.label ? { label: input.label } : {}),
        ...(input.expiresAt ? { expiresAt: toSeconds(Date.parse(input.expiresAt)) } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        actor,
      });
      // The plaintext token is in this response only; it is never stored or shown again.
      return [issued, 201];
    }),
  );

  app.post(
    `${p}/admin-tokens/:id/revoke`,
    route("admin_accounts.write", async (c, actor) => {
      const id = param(IdentifierSchema, c.req.param("id"), "id");
      const input = await body(c, OptionalReasonSchema);
      return [
        {
          adminToken: await deps.tokens.revoke({ id, actor, ...(input.reason ? { reason: input.reason } : {}) }),
        },
      ];
    }),
  );

  // ─── Shared admin route sets ───────────────────────────────────────────────

  app.route(
    "/",
    createGatewayBillingAdminRoutes({ billing: deps.billing, priceBook: deps.priceBook, verifyAdmin }),
  );
  if (deps.keyRing)
    app.route(
      "/",
      createGatewayKeyAdminRoutes({ db, ring: deps.keyRing.ring, store: deps.keyRing.store, verifyAdmin }),
    );

  // Shared /admin SPA + admin Better Auth (#372), only when the admin role asked for it.
  if (deps.console) {
    mountAdminConsole(app, {
      build: deps.console.build,
      ...(deps.console.adminAuthHandler ? { adminAuthHandler: deps.console.adminAuthHandler } : {}),
    });
  }

  // The admin listener serves nothing else (no data plane, no product API).
  app.notFound((c) => c.json(NOT_FOUND_BODY, 404, NO_STORE));
  return app;
}
