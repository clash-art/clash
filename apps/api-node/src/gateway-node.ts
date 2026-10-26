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
  GATEWAY_REQUEST_ID_HEADER,
  type GatewayApp,
  type GatewayAppOptions,
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

/**
 * The caller's configured scope order (#369): its member row, else its
 * tenant row, else NULL (the credential's own scope only).
 */
const PRIORITY_SQL = (tenant: string, user: string) =>
  `(SELECT p.priority FROM gateway_credential_priority p
     WHERE p.tenant_id = ${tenant} AND p.user_id IN (${user}, '')
     ORDER BY p.user_id DESC LIMIT 1)`;

export type GatewayCredentialPriority = "official_only" | "tenant_only" | "official_first" | "tenant_first";

const PRIORITY_ORDER: Record<GatewayCredentialPriority, readonly GatewayCredentialScope[]> = {
  official_only: ["official"],
  tenant_only: ["tenant"],
  official_first: ["official", "tenant"],
  tenant_first: ["tenant", "official"],
};

/** Scope order for a stored priority; unknown or absent: `[scope]` only. */
export function credentialPriorityOrder(
  priority: unknown,
  scope: GatewayCredentialScope,
): readonly GatewayCredentialScope[] {
  return typeof priority === "string" && priority in PRIORITY_ORDER
    ? PRIORITY_ORDER[priority as GatewayCredentialPriority]
    : [scope];
}

/** Identity fields for a resolved scope order; the first scope is the primary. */
function withPriority(
  priority: unknown,
  scope: GatewayCredentialScope,
): Pick<GatewayIdentity, "credentialScope" | "credentialPriority"> {
  const order = credentialPriorityOrder(priority, scope);
  return { credentialScope: order[0]!, credentialPriority: order };
}

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
          priority: string | null;
        }>(
          `SELECT k.id, k.tenant_id, k.user_id, k.model_allowlist, k.credential_scope,
                  k.expires_at, k.revoked_at,
                  ${BUDGET_IDS_SQL("k.tenant_id", "k.user_id", "k.id")} AS budget_ids,
                  ${PRIORITY_SQL("k.tenant_id", "k.user_id")} AS priority
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
          ...withPriority(row.priority, row.credential_scope),
        };
      }
      if (token?.startsWith("clsh_")) {
        const { rows } = await db.query<{ user_id: string; budget_ids: unknown; priority: string | null }>(
          `SELECT a.user_id,
                  ${BUDGET_IDS_SQL("('personal:' || a.user_id)", "a.user_id", "''")} AS budget_ids,
                  ${PRIORITY_SQL("('personal:' || a.user_id)", "a.user_id")} AS priority
             FROM api_token a WHERE a.token_hash = $1 LIMIT 1`,
          [sha256Hex(token)],
        );
        const row = rows[0];
        if (!row) throw unauthenticated("unknown");
        return personalIdentity(row.user_id, row.budget_ids, row.priority);
      }
      if (!token && deps.session && request.headers.has("cookie")) {
        const session = await deps.session(request.headers).catch(() => null);
        if (session) {
          const tenantId = personalTenantId(session.userId);
          const { rows } = await db.query<{ budget_ids: unknown; priority: string | null }>(
            `SELECT ${BUDGET_IDS_SQL("$1::text", "$2::text", "''")} AS budget_ids,
                    ${PRIORITY_SQL("$1::text", "$2::text")} AS priority`,
            [tenantId, session.userId],
          );
          return personalIdentity(session.userId, rows[0]?.budget_ids, rows[0]?.priority);
        }
      }
      throw unauthenticated(token ? "unknown" : "missing");
    },
  };
}

function personalIdentity(userId: string, budgetIds: unknown, priority?: unknown): GatewayIdentity {
  return {
    tenantId: personalTenantId(userId),
    userId,
    budgetIds: parseList(budgetIds) ?? [],
    ...withPriority(priority, "official"),
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
  /** Retry backoff for a transiently failed charge; SETTLE_RETRY_DELAYS_MS by default. */
  settleRetryDelaysMs?: readonly number[];
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
      // Fail closed: an official-scope request (any caller: virtual key,
      // clsh_, session) is admitted only against a real N2 budget row; no
      // row means no free pass — the coded 402. BYOK (#369): a tenant-scope
      // request with no row is admitted (the tenant pays its own upstream);
      // with a row it is held to that budget like any other.
      if (input.budgetIds.length === 0 && input.credentialScope === "tenant")
        return { requestId: input.requestId, holds: [], expiresAt: input.expiresAt };
      if (input.budgetIds.length === 0)
        throw new GatewayError("GATEWAY_BUDGET_EXCEEDED", { details: { reason: "no_budget" } });
      await store.admitText({ tenantId: input.tenantId, budgetIds: input.budgetIds });
      return { requestId: input.requestId, holds: [], expiresAt: input.expiresAt };
    },
    async settle(event) {
      return settleDurably(() => settleOnce(event), deps.settleRetryDelaysMs ?? SETTLE_RETRY_DELAYS_MS);
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
  async function settleOnce(event: UsageEvent) {
      const budgetIds = await budgetIdsOf(event);
      // An unbudgeted BYOK request moves no platform money (#369).
      if (budgetIds.length === 0 && event.credentialScope === "tenant")
        return { requestId: event.requestId, costMicroCredits: 0, duplicate: false };
      // Admission refused budgetless official callers; a budget vanishing
      // mid-request must not settle for free either.
      if (budgetIds.length === 0)
        throw new GatewayError("GATEWAY_INTERNAL", { details: { reason: "settle_without_budget" } });
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
  }
}

/**
 * Backoff before each retry of a postpay charge. The charge is one Postgres
 * transaction keyed by the ledger's unique `(request_id, budget_id, kind)`, so
 * a retry after an unacknowledged commit is a recorded no-op (`duplicate`),
 * never a second charge.
 */
export const SETTLE_RETRY_DELAYS_MS: readonly number[] = [50, 250, 1000];

/**
 * Durable settle (N2): retry a charge that failed for a transient reason
 * (connection loss, serialization failure — anything not a coded
 * GatewayError) before giving up. Coded refusals (budget gone, idempotency
 * conflict) are final and surface at once.
 */
export async function settleDurably<T>(work: () => Promise<T>, delaysMs: readonly number[]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GatewayError || attempt >= delaysMs.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
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
  settleRetryDelaysMs?: readonly number[];
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
    budgets: createN2GatewayBudgetPort({
      db: input.db,
      ...(input.settleRetryDelaysMs ? { settleRetryDelaysMs: input.settleRetryDelaysMs } : {}),
    }),
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

// ─── Streaming (#368) ────────────────────────────────────────────────────────

/** Idle gap after which an SSE keep-alive comment is sent (proxies cut idle streams). */
export const GATEWAY_SSE_KEEPALIVE_MS = 15_000;
/**
 * TTFT overhead budget: time the node adds between the upstream's first SSE
 * byte and the caller's, on the admission + relay path (mock upstream, PGlite).
 * Enforced by gateway-node-stream.test.ts and logged per stream as `ttftMs`.
 */
export const GATEWAY_NODE_TTFT_OVERHEAD_BUDGET_MS = 50;
export const SSE_KEEPALIVE_COMMENT = ": keep-alive\n\n";

/**
 * Background work a response leaves behind: the settlement of a stream whose
 * caller disconnected or timed out. Node has no `waitUntil`; this registry
 * plays that part so the core always runs the settle, and `drain()` lets a
 * shutting-down process finish those settlements before closing the pool.
 * Nothing in it outlives the request's own settlement (stateless node).
 */
export interface GatewayBackgroundWork {
  waitUntil(promise: Promise<unknown>): void;
  /** Resolves once every registered promise settled, or after `timeoutMs`. */
  drain(timeoutMs?: number): Promise<void>;
  readonly pending: number;
}

export function createGatewayBackgroundWork(): GatewayBackgroundWork {
  const pending = new Set<Promise<unknown>>();
  return {
    waitUntil(promise) {
      const tracked = promise.catch(() => undefined).finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    async drain(timeoutMs = 10_000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      });
      while (pending.size > 0) {
        const done = await Promise.race([Promise.allSettled([...pending]).then(() => true), deadline.then(() => false)]);
        if (!done) break;
      }
      clearTimeout(timer);
    },
    get pending() {
      return pending.size;
    },
  };
}

const isEventStream = (response: Response) =>
  response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;

/**
 * Pass an SSE answer through unchanged, chunk by chunk (no buffering), adding
 * a keep-alive comment after `keepAliveMs` of silence. A comment is only ever
 * written at an event boundary (after a blank line), never inside a split
 * upstream event. Cancelling (caller disconnect) cancels the core's relay,
 * which aborts the upstream and settles observed usage.
 */
export function withSseKeepAlive(
  response: Response,
  input: { keepAliveMs: number; onFirstByte?: () => void },
): Response {
  if (!response.body || !isEventStream(response)) return response;
  const reader = response.body.getReader();
  const comment = new TextEncoder().encode(SSE_KEEPALIVE_COMMENT);
  let lastAt = Date.now();
  let tail = "\n\n"; // before the first byte the stream is at a boundary
  let first = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const tick = Math.max(10, Math.floor(input.keepAliveMs / 3));
      timer = setInterval(() => {
        if (Date.now() - lastAt < input.keepAliveMs || !/\n\r?\n$/.test(tail)) return;
        try {
          controller.enqueue(comment);
          lastAt = Date.now();
        } catch {
          stop();
        }
      }, tick);
      timer.unref?.();
    },
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        stop();
        controller.error(error);
        return;
      }
      if (next.done) {
        stop();
        controller.close();
        return;
      }
      if (first) {
        first = false;
        input.onFirstByte?.();
      }
      const chunk = next.value;
      if (chunk.byteLength > 0) {
        tail = (tail + new TextDecoder().decode(chunk.subarray(Math.max(0, chunk.byteLength - 4)))).slice(-4);
        lastAt = Date.now();
      }
      controller.enqueue(chunk);
    },
    cancel(reason) {
      stop();
      return reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  // Ask reverse proxies (nginx) not to buffer the stream.
  headers.set("x-accel-buffering", "no");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export interface GatewayNodeRoutesOptions {
  /** Background settlements (disconnect / timeout); a private registry by default. */
  work?: GatewayBackgroundWork;
  keepAliveMs?: number;
  logger?: GatewayLogger;
  /** Passed to gateway-core's createGatewayApp (waitUntil is set from `work`). */
  app?: Omit<GatewayAppOptions, "waitUntil" | "basePath">;
}

/**
 * Hono routes for `/v1/*` and `/api/v1/gateway/*`. `/api/v1/gateway/<rest>`
 * is the same surface as `/v1/<rest>` (and `/api/v1/gateway/anthropic/...`
 * the core's `/anthropic/...`).
 *
 * Streams (#368) are gateway-core's relay (stream.ts), unchanged: the core
 * injects `stream_options.include_usage`, tees the upstream body (caller +
 * usage tap), and settles once when the stream ends — completed, truncated,
 * upstream error, timeout or caller disconnect — through the N2 budget port
 * (postpay `charge` of observed usage, estimated from bytes when the upstream
 * reported none). This layer only adds keep-alives and the TTFT log.
 */
export function createGatewayNodeRoutes(ports: GatewayPorts, options: GatewayNodeRoutesOptions = {}): Hono {
  const work = options.work ?? createGatewayBackgroundWork();
  const keepAliveMs = options.keepAliveMs ?? GATEWAY_SSE_KEEPALIVE_MS;
  const logger = options.logger ?? ports.logger;
  const core: GatewayApp = createGatewayApp(ports, { ...options.app, waitUntil: (promise) => work.waitUntil(promise) });
  const serve = async (request: Request) => {
    const started = performance.now();
    const response = await core.fetch(request);
    return withSseKeepAlive(response, {
      keepAliveMs,
      onFirstByte: () =>
        logger.info("gateway.stream_first_byte", {
          requestId: response.headers.get(GATEWAY_REQUEST_ID_HEADER) ?? undefined,
          ttftMs: Math.round(performance.now() - started),
        }),
    });
  };
  const app = new Hono();
  const toCore = (request: Request, path: string) => {
    const url = new URL(request.url);
    url.pathname = path;
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return serve(
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
  app.all("/v1/*", (c) => serve(c.req.raw));
  app.all("/api/v1/gateway/*", (c) => {
    const rest = c.req.path.slice("/api/v1/gateway".length);
    return toCore(c.req.raw, rest.startsWith("/anthropic/") ? rest : `/v1${rest}`);
  });
  return app;
}
