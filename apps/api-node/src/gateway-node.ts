/**
 * Node/Postgres adapter for the model gateway data plane (#367). Builds
 * gateway-core's GatewayPorts over the Postgres stores already on master and
 * mounts `createGatewayApp` (the same routing/admission/errors/limits app
 * api-cf mounts over D1) at `/v1/*` and `/api/v1/gateway/*`.
 *
 * Ports:
 *   identity     Better Auth session, `clsh_` API token, or `sk_gw_` virtual
 *                key (gateway_virtual_key). Identity comes from the stored row
 *                only; no header (x-user-id included) is read as identity.
 *   routes       gateway_model / gateway_price / gateway_upstream_credential.
 *   credentials  gateway-credentials.ts (#366): one scope per request.
 *   budgets      gateway-budget.ts (#363, N2): text is postpay — `reserve` is
 *                the read-only credit-floor check, `settle` charges once.
 *   limits       gateway-limits.ts (#364).
 * Nothing is kept in process memory between requests (stateless nodes).
 * Ports this adapter does not implement yet are explicit `unavailablePort`s.
 */
import { createHash } from "node:crypto";
import {
  GatewayError,
  applyGatewayCatalogPolicy,
  createGatewayApp,
  gatewayErrorResponseInit,
  isGatewayPriceUnit,
  toGatewayError,
  unavailablePort,
  type GatewayApp,
  type GatewayBudgetPort,
  type GatewayCatalog,
  type GatewayClock,
  type GatewayCredentialPort,
  type GatewayCredentialScope,
  type GatewayIdentity,
  type GatewayIdentityPort,
  type GatewayLedgerPort,
  type GatewayLogger,
  type GatewayModelCard,
  type GatewayPorts,
  type GatewayPrice,
  type GatewayPriceRate,
  type GatewayRoutesPort,
  type GatewayUpstreamPort,
  type UsageEvent,
} from "@clash/gateway-core";
import { ModelCardSchema } from "@clash/shared-types";
import type { ProviderAccountAvailability } from "@clash/shared-types/model-routing";
import { Hono } from "hono";
import { z } from "zod";
import type {
  GatewayBudgetDatabase,
  GatewayBudgetSqlClient,
  PgGatewayBudgetStore,
} from "./gateway-budget.ts";
import { createPgGatewayBudgetStore } from "./gateway-budget.ts";
import { tenantKeyOf } from "./gateway-credentials.ts";
import type { PgGatewayLimitPort } from "./gateway-limits.ts";
import { apiNodeLog } from "./log.ts";

export const GATEWAY_VIRTUAL_KEY_PREFIX = "sk_gw_";
const VIRTUAL_KEY_PATTERN = /^sk_gw_([0-9a-f]{24})\.([0-9a-f]{64})$/;
export const UNPUBLISHED_CATALOG_VERSION = "unpublished";
export const personalTenantId = (userId: string) => `personal:${userId}`;

/** Process role switch; the full role matrix is #373. Only `api` serves the data plane. */
export type GatewayRole = "api" | "worker" | "admin";
export function gatewayRole(env: Record<string, string | undefined>): GatewayRole {
  const value = env.GATEWAY_ROLE?.trim() || "api";
  if (value !== "api" && value !== "worker" && value !== "admin")
    throw Error("GATEWAY_ROLE must be api, worker or admin");
  return value;
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const toSeconds = (ms: number) => Math.floor(ms / 1000);
const bearer = (request: Request) =>
  request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];

const StringList = z.array(z.string().min(1));
const parseList = (value: unknown): string[] | undefined => {
  const raw = typeof value === "string" ? safeJson(value) : value;
  const parsed = StringList.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};
function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

// ─── Identity ────────────────────────────────────────────────────────────────

/** Budgets a caller draws on: its tenant wallet, member budget and key cap. */
const BUDGET_IDS_SQL = (tenant: string, user: string, key: string) =>
  `COALESCE((SELECT json_agg(b.id ORDER BY b.id) FROM gateway_budget b
     WHERE b.tenant_id = ${tenant}
       AND ((b.scope = 'tenant' AND b.scope_id = ${tenant})
         OR (b.scope = 'user' AND b.scope_id = ${user})
         OR (b.scope = 'key' AND b.scope_id = ${key}))), '[]'::json)`;

export interface SessionResolver {
  /** The signed-in user of a Better Auth session cookie, or null. */
  (headers: Headers): Promise<{ userId: string } | null>;
}

const unauthenticated = (reason: string) =>
  new GatewayError("GATEWAY_AUTH_REQUIRED", {
    message: "The gateway credential is not recognized.",
    details: { reason },
  });

export function createPgGatewayIdentityPort(deps: {
  db: GatewayBudgetSqlClient;
  clock: GatewayClock;
  session?: SessionResolver;
}): GatewayIdentityPort {
  const { db, clock } = deps;
  return {
    async authenticate(request): Promise<GatewayIdentity> {
      const token =
        bearer(request) ?? request.headers.get("x-api-key")?.trim() ?? undefined;
      if (token?.startsWith(GATEWAY_VIRTUAL_KEY_PREFIX)) {
        if (!VIRTUAL_KEY_PATTERN.test(token)) throw unauthenticated("malformed");
        const { rows } = await db.query<{
          id: string;
          tenant_id: string;
          user_id: string;
          model_allowlist: unknown;
          credential_scope: GatewayCredentialScope;
          expires_at: string | number | null;
          revoked_at: string | number | null;
          budget_ids: unknown;
        }>(
          `SELECT k.id, k.tenant_id, k.user_id, k.model_allowlist, k.credential_scope,
                  k.expires_at, k.revoked_at,
                  ${BUDGET_IDS_SQL("k.tenant_id", "k.user_id", "k.id")} AS budget_ids
             FROM gateway_virtual_key k WHERE k.token_hash = $1 LIMIT 1`,
          [sha256Hex(token)],
        );
        const row = rows[0];
        if (!row) throw unauthenticated("unknown");
        if (row.revoked_at !== null)
          throw new GatewayError("GATEWAY_TOKEN_REVOKED", { details: { keyId: row.id } });
        if (row.expires_at !== null && Number(row.expires_at) <= toSeconds(clock.now()))
          throw new GatewayError("GATEWAY_TOKEN_EXPIRED", { details: { keyId: row.id } });
        const modelAllowlist = parseList(row.model_allowlist);
        return {
          tenantId: row.tenant_id,
          userId: row.user_id,
          keyId: row.id,
          ...(modelAllowlist ? { modelAllowlist } : {}),
          budgetIds: parseList(row.budget_ids) ?? [],
          credentialScope: row.credential_scope,
        };
      }
      if (token?.startsWith("clsh_")) {
        const { rows } = await db.query<{ user_id: string; budget_ids: unknown }>(
          `SELECT a.user_id,
                  ${BUDGET_IDS_SQL("('personal:' || a.user_id)", "a.user_id", "''")} AS budget_ids
             FROM api_token a WHERE a.token_hash = $1 LIMIT 1`,
          [sha256Hex(token)],
        );
        const row = rows[0];
        if (!row) throw unauthenticated("unknown");
        return personalIdentity(row.user_id, row.budget_ids);
      }
      if (!token && deps.session && request.headers.has("cookie")) {
        const session = await deps.session(request.headers).catch(() => null);
        if (session) {
          const tenantId = personalTenantId(session.userId);
          const { rows } = await db.query<{ budget_ids: unknown }>(
            `SELECT ${BUDGET_IDS_SQL("$1::text", "$2::text", "''")} AS budget_ids`,
            [tenantId, session.userId],
          );
          return personalIdentity(session.userId, rows[0]?.budget_ids);
        }
      }
      throw unauthenticated(token ? "unknown" : "missing");
    },
  };
}

function personalIdentity(userId: string, budgetIds: unknown): GatewayIdentity {
  return {
    tenantId: personalTenantId(userId),
    userId,
    budgetIds: parseList(budgetIds) ?? [],
    credentialScope: "official",
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export function createPgGatewayRoutesPort(deps: {
  db: GatewayBudgetSqlClient;
  clock: GatewayClock;
  logger: GatewayLogger;
}): GatewayRoutesPort {
  const { db, clock, logger } = deps;
  return {
    async catalog(): Promise<GatewayCatalog> {
      const { rows } = await db.query<{
        catalog_version: string;
        model_code: string;
        kind: string;
        card_json: unknown;
      }>(
        `SELECT catalog_version, model_code, kind, card_json FROM gateway_model
          WHERE enabled = 1 AND catalog_version = (
            SELECT catalog_version FROM gateway_model
             WHERE published_at IS NOT NULL AND published_at <= $1
             ORDER BY published_at DESC, catalog_version DESC LIMIT 1)
          ORDER BY model_code`,
        [toSeconds(clock.now())],
      );
      const models: GatewayModelCard[] = [];
      for (const row of rows) {
        const parsed = ModelCardSchema.safeParse(row.card_json);
        if (!parsed.success || parsed.data.id !== row.model_code || parsed.data.kind !== row.kind) {
          // A malformed published card is unroutable, never guessed at.
          logger.warn("gateway.catalog_card_invalid", {
            catalogVersion: row.catalog_version,
            model: row.model_code,
          });
          continue;
        }
        models.push(parsed.data);
      }
      return { version: rows[0]?.catalog_version ?? UNPUBLISHED_CATALOG_VERSION, models };
    },

    /**
     * Accounts are the enabled credential rows of exactly one scope (and, for
     * `tenant`, one tenant): the credential id is the route's account id.
     * The key itself is opened only by the credential port.
     */
    async providers(identity, scope): Promise<ProviderAccountAvailability[]> {
      const { rows } = await db.query<{
        id: string;
        provider_id: string;
        upstream_id: string;
        region: string;
        label: string | null;
        priority: number | null;
        weight: number | null;
      }>(
        `SELECT id, provider_id, upstream_id, region, label, priority, weight
           FROM gateway_upstream_credential
          WHERE enabled = 1 AND scope = $1 AND tenant_key = $2
          ORDER BY COALESCE(priority, 1000), id`,
        [scope, tenantKeyOf(scope, identity.tenantId)],
      );
      return rows.map((row) => ({
        id: row.id,
        providerId: row.provider_id,
        ...(row.upstream_id ? { upstreamId: row.upstream_id } : {}),
        ...(row.region ? { region: row.region } : {}),
        ...(row.label ? { label: row.label } : {}),
        enabled: true,
        // Sealed rows always hold an apiKey; resolve() fails closed otherwise.
        configuredCredentials: ["apiKey", "baseUrl"],
        ...(row.priority !== null ? { priority: row.priority } : {}),
        ...(row.weight !== null ? { weight: row.weight } : {}),
      }));
    },

    async price({ catalogVersion, route, at }): Promise<GatewayPrice> {
      const atS = toSeconds(at ?? clock.now());
      const { rows } = await db.query<{
        price_version: string;
        upstream_id: string;
        unit: string;
        amount_micro: string | number;
        per: number;
        max_output_tokens: number | null;
      }>(
        `SELECT p.price_version, p.upstream_id, p.unit, p.amount_micro, p.per,
                (SELECT m.max_output_tokens FROM gateway_model m
                  WHERE m.catalog_version = $4 AND m.model_code = $1 LIMIT 1) AS max_output_tokens
           FROM gateway_price p
          WHERE p.model_code = $1 AND p.upstream_id IN ($2, '') AND p.currency = 'credit'
            AND p.published_at IS NOT NULL
            AND p.effective_from <= $3 AND (p.effective_to IS NULL OR p.effective_to > $3)
          ORDER BY p.effective_from DESC, p.price_version DESC, p.upstream_id = '' ASC`,
        [route.modelCode, route.upstreamId, atS, catalogVersion],
      );
      const chosen = rows[0];
      if (!chosen)
        throw new GatewayError("GATEWAY_PRICE_UNAVAILABLE", {
          details: { modelCode: route.modelCode, upstreamId: route.upstreamId },
        });
      const rates: GatewayPriceRate[] = [];
      for (const row of rows) {
        if (row.price_version !== chosen.price_version || row.upstream_id !== chosen.upstream_id) continue;
        if (!isGatewayPriceUnit(row.unit)) {
          logger.warn("gateway.price_unit_unknown", { model: route.modelCode, priceVersion: row.price_version });
          continue;
        }
        rates.push({ unit: row.unit, microCredits: Number(row.amount_micro), per: row.per });
      }
      return {
        modelCode: route.modelCode,
        ...(chosen.upstream_id ? { upstreamId: chosen.upstream_id } : {}),
        version: chosen.price_version,
        rates,
        ...(typeof chosen.max_output_tokens === "number"
          ? { maxOutputTokens: chosen.max_output_tokens }
          : {}),
      };
    },
  };
}

// ─── Budgets (N2 text postpay over the core reserve/settle contract) ─────────

/**
 * The core's reserve/settle contract mapped onto N2 (#363): `reserve` is the
 * read-only credit-floor check (no hold is written), `settle` is the one
 * postpay charge. Budget ids are re-derived from the ledger owner on settle,
 * so no state lives in this process between the two calls.
 */
export function createN2GatewayBudgetPort(deps: {
  db: GatewayBudgetDatabase;
  store?: PgGatewayBudgetStore;
}): Pick<GatewayBudgetPort, "reserve" | "settle" | "markSettleFailed" | "snapshot" | "expiredHolds" | "expire"> {
  const store = deps.store ?? createPgGatewayBudgetStore(deps.db);
  async function budgetIdsOf(event: UsageEvent): Promise<string[]> {
    const { rows } = await deps.db.query<{ budget_ids: unknown }>(
      `SELECT ${BUDGET_IDS_SQL("$1::text", "$2::text", "$3::text")} AS budget_ids`,
      [event.tenantId, event.userId, event.keyId ?? ""],
    );
    return parseList(rows[0]?.budget_ids) ?? [];
  }
  return {
    async reserve(input) {
      if (input.budgetIds.length > 0)
        await store.admitText({ tenantId: input.tenantId, budgetIds: input.budgetIds });
      return { requestId: input.requestId, holds: [], expiresAt: input.expiresAt };
    },
    async settle(event) {
      const budgetIds = await budgetIdsOf(event);
      if (budgetIds.length === 0)
        return { requestId: event.requestId, costMicroCredits: event.costMicroCredits, duplicate: false };
      const result = await store.chargeText({
        requestId: event.requestId,
        tenantId: event.tenantId,
        userId: event.userId,
        ...(event.keyId ? { keyId: event.keyId } : {}),
        budgetIds,
        costMicroCredits: event.costMicroCredits,
        status: event.status,
        modelCode: event.modelCode,
        modelKind: event.kind,
        upstreamId: event.upstreamId,
        ...(event.accountId ? { accountId: event.accountId } : {}),
        credentialScope: event.credentialScope,
        priceVersion: event.priceVersion,
        catalogVersion: event.catalogVersion,
        usageSource: event.usage.source,
        units: event.usage.units,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cachedInputTokens: event.usage.cachedInputTokens,
        cacheWriteTokens: event.usage.cacheWriteTokens,
      });
      return {
        requestId: event.requestId,
        costMicroCredits: result.chargedMicroCredits,
        duplicate: result.duplicate,
      };
    },
    // N2 writes no hold, so a failed settlement has nothing reserved to mark.
    async markSettleFailed() {
      return { status: "settle_failed" as const };
    },
    async snapshot(input) {
      const rows = await store.snapshot({
        tenantId: input.tenantId,
        ...(input.budgetIds?.length ? { budgetIds: input.budgetIds } : {}),
      });
      return rows.map((row) => ({
        id: row.id,
        scope: row.scope as "tenant" | "user" | "key",
        scopeId: row.scopeId,
        limitMicroCredits: row.limitMicroCredits,
        spentMicroCredits: row.spentMicroCredits,
        reservedMicroCredits: 0,
        version: 0,
        enforcement: row.enforcement as "hard" | "soft" | "alert",
      }));
    },
    async expiredHolds() {
      return [];
    },
    async expire() {
      return { expired: false };
    },
  };
}

/** Read side of the N2 ledger: one tenant's `charge` rows, one per request. */
export function createPgGatewayLedgerPort(db: GatewayBudgetSqlClient): GatewayLedgerPort {
  type Row = {
    request_id: string;
    tenant_id: string;
    user_id: string | null;
    key_id: string | null;
    model_code: string | null;
    model_kind: string | null;
    upstream_id: string | null;
    account_id: string | null;
    credential_scope: string | null;
    amount_micro_credits: string | number;
    price_version: string | null;
    catalog_version: string | null;
    status: string;
    error_code: string | null;
    input_tokens: string | number;
    output_tokens: string | number;
    cached_input_tokens: string | number;
    cache_write_tokens: string | number;
    units_json: Record<string, number> | null;
    usage_source: string | null;
    occurred_at: string | number;
  };
  const COLUMNS = `DISTINCT ON (request_id) request_id, tenant_id, user_id, key_id, model_code, model_kind,
    upstream_id, account_id, credential_scope, amount_micro_credits, price_version, catalog_version,
    status, error_code, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens,
    units_json, usage_source, occurred_at`;
  const toEvent = (row: Row): UsageEvent => ({
    requestId: row.request_id,
    tenantId: row.tenant_id,
    userId: row.user_id ?? "",
    ...(row.key_id ? { keyId: row.key_id } : {}),
    modelCode: row.model_code ?? "",
    kind: (row.model_kind ?? "text") as UsageEvent["kind"],
    upstreamId: row.upstream_id ?? "",
    ...(row.account_id ? { accountId: row.account_id } : {}),
    credentialScope: (row.credential_scope ?? "official") as GatewayCredentialScope,
    usage: {
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      units: row.units_json ?? {},
      source: row.usage_source === "estimated" ? "estimated" : "reported",
    },
    costMicroCredits: Number(row.amount_micro_credits),
    priceVersion: row.price_version ?? "",
    catalogVersion: row.catalog_version ?? "",
    status: row.status as UsageEvent["status"],
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    occurredAt: Number(row.occurred_at) * 1000,
  });
  return {
    async get({ tenantId, requestId }) {
      const { rows } = await db.query<Row>(
        `SELECT ${COLUMNS} FROM gateway_usage_ledger
          WHERE tenant_id = $1 AND request_id = $2 AND kind = 'charge'
          ORDER BY request_id, budget_id`,
        [tenantId, requestId],
      );
      return rows[0] ? toEvent(rows[0]) : null;
    },
    async query(filter) {
      const { rows } = await db.query<Row>(
        `SELECT * FROM (SELECT ${COLUMNS} FROM gateway_usage_ledger
          WHERE tenant_id = $1 AND kind = 'charge'
            AND ($2::text IS NULL OR user_id = $2) AND ($3::text IS NULL OR key_id = $3)
            AND ($4::bigint IS NULL OR occurred_at >= $4) AND ($5::bigint IS NULL OR occurred_at < $5)
          ORDER BY request_id, budget_id) t
          ORDER BY occurred_at DESC, request_id DESC LIMIT $6`,
        [
          filter.tenantId,
          filter.userId ?? null,
          filter.keyId ?? null,
          filter.from === undefined ? null : toSeconds(filter.from),
          filter.to === undefined ? null : toSeconds(filter.to),
          filter.limit ?? 100,
        ],
      );
      return rows.map(toEvent);
    },
  };
}

// ─── Ports + app ─────────────────────────────────────────────────────────────

function nodeLogger(): GatewayLogger {
  const log = apiNodeLog.child("gateway");
  const safe =
    (level: "info" | "warn" | "error") =>
    (event: string, fields?: Record<string, unknown>) => {
      try {
        log[level](event, fields as never);
      } catch {
        // A logger must never throw into the data plane.
      }
    };
  return { info: safe("info"), warn: safe("warn"), error: safe("error") };
}

export interface PgGatewayPortsInput {
  db: GatewayBudgetDatabase;
  credentials: GatewayCredentialPort;
  limits: PgGatewayLimitPort;
  session?: SessionResolver;
  clock?: GatewayClock;
  logger?: GatewayLogger;
  upstream?: GatewayUpstreamPort;
}

export function createPgGatewayPorts(input: PgGatewayPortsInput): GatewayPorts {
  const clock = input.clock ?? { now: () => Date.now() };
  const logger = input.logger ?? nodeLogger();
  return {
    clock,
    ids: { requestId: () => `gwr_${crypto.randomUUID().replaceAll("-", "")}` },
    identity: createPgGatewayIdentityPort({
      db: input.db,
      clock,
      ...(input.session ? { session: input.session } : {}),
    }),
    routes: createPgGatewayRoutesPort({ db: input.db, clock, logger }),
    credentials: input.credentials,
    // Advisory circuits without a shared store yet: every circuit reads closed
    // and nothing is kept per node (stateless). Failover still applies per request.
    upstreamHealth: {
      read: async () => [],
      recordFailure: async ({ accountId, code, at }) => ({
        accountId,
        consecutiveFailures: 1,
        lastFailureCode: code,
        lastFailureAt: at,
      }),
      recordSuccess: async () => {},
    },
    budgets: createN2GatewayBudgetPort({ db: input.db }),
    limits: input.limits,
    ledger: createPgGatewayLedgerPort(input.db),
    blobs: unavailablePort("blobs"),
    retention: unavailablePort("retention"),
    scheduler: unavailablePort("scheduler"),
    audit: unavailablePort("audit"),
    logger,
    upstream: input.upstream ?? { fetch: (request) => fetch(request) },
  };
}

/** OpenAI `GET /v1/models`: the published catalog the caller may use. */
async function listModels(ports: GatewayPorts, request: Request): Promise<Response> {
  try {
    const identity = await ports.identity.authenticate(request);
    const { catalog } = applyGatewayCatalogPolicy(await ports.routes.catalog(identity));
    const allow = identity.modelAllowlist ? new Set(identity.modelAllowlist) : undefined;
    const data = catalog.models
      .filter((card) => !allow || allow.has(card.id))
      .map((card) => ({ id: card.id, object: "model" as const, created: 0, owned_by: "clash" }));
    return Response.json({ object: "list", data }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const init = gatewayErrorResponseInit(toGatewayError(error), "openai");
    return Response.json(init.body, { status: init.status, headers: init.headers });
  }
}

export const GATEWAY_NODE_PREFIXES = ["/v1", "/api/v1/gateway"] as const;

/**
 * Hono routes for `/v1/*` and `/api/v1/gateway/*`. `/api/v1/gateway/<rest>`
 * is the same surface as `/v1/<rest>` (and `/api/v1/gateway/anthropic/...`
 * the core's `/anthropic/...`).
 */
export function createGatewayNodeRoutes(ports: GatewayPorts): Hono {
  const core: GatewayApp = createGatewayApp(ports);
  const app = new Hono();
  const toCore = (request: Request, path: string) => {
    const url = new URL(request.url);
    url.pathname = path;
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return core.fetch(
      new Request(url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        ...(hasBody ? { body: request.body, duplex: "half" } : {}),
      } as RequestInit),
    );
  };
  app.get("/v1/models", (c) => listModels(ports, c.req.raw));
  app.get("/api/v1/gateway/models", (c) => listModels(ports, c.req.raw));
  app.all("/v1/*", (c) => core.fetch(c.req.raw));
  app.all("/api/v1/gateway/*", (c) => {
    const rest = c.req.path.slice("/api/v1/gateway".length);
    return toCore(c.req.raw, rest.startsWith("/anthropic/") ? rest : `/v1${rest}`);
  });
  return app;
}
