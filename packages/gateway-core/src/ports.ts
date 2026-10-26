/**
 * GatewayPorts: the only surface the core touches. Each runtime (Workers/D1,
 * Node/PostgreSQL, Node/SQLite, in-memory tests) supplies one implementation;
 * the core owns decisions, adapters own durability. Every method resolves or
 * rejects with a `GatewayError`; a port a deployment does not implement
 * rejects with GATEWAY_CAPABILITY_UNAVAILABLE (see `unavailablePort`).
 */
import type {
  ModelUpstreamRoute,
  ProviderAccountAvailability,
} from "@clash/shared-types/model-routing";

import type { BudgetFlag, BudgetHold, BudgetState, GatewayOutcome } from "./budget.js";
import type { GatewayUpstreamHealth } from "./circuit.js";
import { GatewayError, type GatewayErrorCode } from "./errors.js";
import type { LimitDecision } from "./limits.js";
import type { GatewayPrice, MicroCredits } from "./pricing.js";
import type { GatewayModelKind } from "./request.js";
import type { GatewayCatalog, GatewayCredentialScope } from "./routing.js";
import type { Usage } from "./usage.js";

/** Who is calling, derived from a verified credential, never from a header claim. */
export interface GatewayIdentity {
  tenantId: string;
  userId: string;
  /** Virtual key / gateway token id when the caller used one. */
  keyId?: string;
  /** Model codes this credential may use; absent means the whole catalog. */
  modelAllowlist?: readonly string[];
  /** Budgets this caller draws on, all reserved together. */
  budgetIds: readonly string[];
  /**
   * Which upstream accounts serve this caller. After admission this is the
   * scope the request was resolved to (see `credentialPriority`).
   */
  credentialScope: GatewayCredentialScope;
  /**
   * User-configurable scope order (N12, #369): the scopes tried, in order,
   * when planning a request; the first scope with a route wins and every
   * attempt of the request stays in it (official and BYOK keys never mix).
   * Absent or empty: `[credentialScope]` only.
   */
  credentialPriority?: readonly GatewayCredentialScope[];
}

export interface GatewayClock {
  /** Epoch milliseconds from the authority that orders windows and expiries. */
  now(): number;
}

export interface GatewayIds {
  /** Globally unique request id; the ledger's idempotency anchor. */
  requestId(): string;
}

export interface GatewayIdentityPort {
  /** Rejects with GATEWAY_AUTH_REQUIRED, GATEWAY_TOKEN_EXPIRED or GATEWAY_TOKEN_REVOKED. */
  authenticate(request: Request): Promise<GatewayIdentity>;
}

export interface GatewayRoutesPort {
  /** Published catalog the caller may route against (configurable data, not compiled cards). */
  catalog(identity: GatewayIdentity): Promise<GatewayCatalog>;
  /** Accounts of exactly one scope; official and tenant accounts are never mixed. */
  providers(
    identity: GatewayIdentity,
    scope: GatewayCredentialScope,
  ): Promise<ProviderAccountAvailability[]>;
  /**
   * Price for a route effective at `at` (epoch ms; default now). Every attempt
   * of one request is priced as of its admission, so a version published
   * mid-request never applies to it. Rejects with GATEWAY_PRICE_UNAVAILABLE
   * when none is published.
   */
  price(input: {
    identity: GatewayIdentity;
    catalogVersion: string;
    route: ModelUpstreamRoute;
    at?: number;
  }): Promise<GatewayPrice>;
}

export interface GatewayUpstreamCredential {
  apiKey: string;
  baseUrl?: string;
  /** Non-secret id (and version) of the key used; recorded, never the key itself. */
  keyId: string;
  keyVersion?: string;
}

export interface GatewayCredentialPort {
  /**
   * Resolve the key for one route within one scope. A route whose account does
   * not belong to `scope` rejects with GATEWAY_KEY_UNAVAILABLE, so an official
   * key can never serve tenant BYOK traffic or vice versa.
   *
   * An account may hold two usable key versions while a rotation drains
   * (#350); the active one resolves first. `excludeKeyVersions` names the
   * versions the upstream already refused for this request: the next usable
   * version resolves instead, and none left rejects with
   * GATEWAY_KEY_UNAVAILABLE (`reason: "no_key_version"`). A version that
   * cannot be read or decrypted rejects with GATEWAY_KEY_UNAVAILABLE too; it
   * never falls back to another version (fail closed).
   */
  resolve(input: {
    route: ModelUpstreamRoute;
    scope: GatewayCredentialScope;
    tenantId: string;
    excludeKeyVersions?: readonly string[];
  }): Promise<GatewayUpstreamCredential>;
}

/**
 * Circuit-breaker counters per upstream account (circuit.ts decides; this
 * port stores). Advisory: the data plane routes as if every circuit were
 * closed when a call rejects.
 */
export interface GatewayUpstreamHealthPort {
  /** Counters of these accounts; an account with no failure on record has no entry. */
  read(input: { accountIds: readonly string[] }): Promise<GatewayUpstreamHealth[]>;
  /**
   * Count one failure atomically (concurrent failures never lose a count):
   * `consecutiveFailures + 1`, the failure's code and time, and `openUntil`
   * set when the new count reaches `threshold` (unchanged below it). Answers
   * the counters after the write.
   */
  recordFailure(input: {
    accountId: string;
    code: GatewayErrorCode;
    at: number;
    threshold: number;
    openUntil: number;
  }): Promise<GatewayUpstreamHealth>;
  /** Close the circuit: count 0, no `openUntil`, `lastSuccessAt`. A no-op for an account with no counters. */
  recordSuccess(input: { accountId: string; at: number }): Promise<void>;
}

export interface ReserveInput {
  requestId: string;
  tenantId: string;
  budgetIds: readonly string[];
  /**
   * Scope every attempt of this request is served from. An adapter may admit
   * a `tenant` (BYOK) request with no budget row (the tenant pays its own
   * upstream); an `official` request with no budget always refuses (#369).
   */
  credentialScope: GatewayCredentialScope;
  holdMicroCredits: MicroCredits;
  /** Epoch ms after which the sweeper may expire the hold. */
  expiresAt: number;
  idempotencyKey?: string;
}

export interface Reservation {
  requestId: string;
  holds: BudgetHold[];
  expiresAt: number;
  /**
   * Budget states this reservation recorded instead of refusing (a soft
   * budget past its limit, a newly crossed alert threshold). Empty or absent:
   * none.
   */
  flags?: BudgetFlag[];
}

export interface SettleResult {
  requestId: string;
  /** Cost recorded by the first settlement; a duplicate returns it unchanged. */
  costMicroCredits: MicroCredits;
  duplicate: boolean;
}

export interface SettleFailedInput {
  requestId: string;
  tenantId: string;
  /** Code of the settlement failure, recorded on the marked holds. */
  errorCode: string;
}

export interface GatewayBudgetPort {
  /**
   * Atomically hold on every budget or none. Rejects with GATEWAY_BUDGET_EXCEEDED
   * (a `hard` budget the hold does not fit), GATEWAY_IDEMPOTENCY_IN_PROGRESS or
   * GATEWAY_IDEMPOTENCY_ALREADY_SETTLED. `soft` and `alert` budgets hold past
   * their limit; in the same transaction the adapter records each flag
   * `planReserve` raises (`soft_exceeded` once per request and budget,
   * `alert_threshold` once per budget and dedupe key) and returns the flags
   * it recorded.
   */
  reserve(input: ReserveInput): Promise<Reservation>;
  /**
   * End a reservation: in one transaction, append the ledger row and move each
   * open hold from reserved to spent at `event.costMicroCredits` (zero releases
   * it). Every reservation ends in exactly one settlement; a duplicate is a
   * no-op keyed by request id. A request id that was never reserved rejects
   * with GATEWAY_INTERNAL.
   */
  settle(event: UsageEvent): Promise<SettleResult>;
  /**
   * Durably record that `settle` failed for this request: every still-open
   * hold moves to `settle_failed` with `errorCode`, and its amount stays
   * reserved; no money moves. Idempotent. Answers `settled` when a settlement
   * was in fact recorded (the failure was spurious) and `settle_failed`
   * otherwise. A later `settle` closes `settle_failed` holds exactly like open
   * ones, once. A request id that was never reserved rejects with
   * GATEWAY_INTERNAL.
   */
  markSettleFailed(input: SettleFailedInput): Promise<{ status: "settled" | "settle_failed" }>;
  snapshot(input: { tenantId: string; budgetIds?: readonly string[] }): Promise<BudgetState[]>;
  /**
   * Requests with an `open` hold whose `expiresAt <= before`, oldest first, at
   * most `limit`. `settle_failed` holds are never listed: they stay reserved
   * until reconciliation.
   */
  expiredHolds(input: { before: number; limit: number }): Promise<ExpiredHold[]>;
  /**
   * Close one abandoned request (the stale-hold sweeper): in one transaction,
   * release each `open` hold past `before` and append a zero-cost ledger row
   * with status `expired`, once. A later `settle` for the request is a
   * duplicate and charges nothing. Answers `expired: false` when there was
   * nothing to expire (settled, settle_failed, not yet due, or already
   * expired), so repeating it is a no-op.
   */
  expire(input: { requestId: string; tenantId: string; before: number }): Promise<{ expired: boolean }>;
}

export interface ExpiredHold {
  requestId: string;
  tenantId: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface LimitInput {
  tenantId: string;
  userId: string;
  keyId?: string;
  modelCode: string;
  estimatedTokens: number;
  /** A media/AIGC generation: also counted against `mediaJobs`. */
  media?: boolean;
}

export interface GatewayLimitPort {
  /**
   * Count this request against rate windows and in-flight concurrency. Every
   * counter is tenant-scoped: one tenant's traffic never throttles another's.
   */
  admit(input: LimitInput): Promise<LimitDecision>;
  /** End the in-flight lease from an allowed decision; idempotent. */
  release(input: { leaseId: string }): Promise<void>;
}

export type GatewayLedgerStatus = Exclude<GatewayOutcome, "completed"> | "settled";

/** Ledger statuses for an outcome: a normal completion is `settled`. */
export function ledgerStatus(outcome: GatewayOutcome): GatewayLedgerStatus {
  return outcome === "completed" ? "settled" : outcome;
}

export interface UsageEvent {
  requestId: string;
  tenantId: string;
  userId: string;
  keyId?: string;
  modelCode: string;
  kind: GatewayModelKind;
  upstreamId: string;
  accountId?: string;
  credentialScope: GatewayCredentialScope;
  usage: Usage;
  costMicroCredits: MicroCredits;
  priceVersion: string;
  catalogVersion: string;
  status: GatewayLedgerStatus;
  errorCode?: string;
  occurredAt: number;
}

export interface LedgerFilter {
  tenantId: string;
  userId?: string;
  keyId?: string;
  from?: number;
  to?: number;
  limit?: number;
}

/** Read side of the ledger; rows are written only by `budgets.settle`. */
export interface GatewayLedgerPort {
  get(input: { tenantId: string; requestId: string }): Promise<UsageEvent | null>;
  /** Rows of one tenant only, newest first. */
  query(filter: LedgerFilter): Promise<UsageEvent[]>;
}

export interface GatewayBlob {
  body: Uint8Array;
  contentType?: string;
}

/**
 * Media outputs and retained request/response bodies (retention.ts); a subset
 * of AssetDeliveryStore. `delete` of a missing key resolves.
 */
export interface GatewayBlobPort {
  put(key: string, blob: GatewayBlob): Promise<void>;
  get(key: string): Promise<GatewayBlob | null>;
  delete(key: string): Promise<void>;
}

/**
 * `stored`: both bodies are in blobs. `failed`: they could not be stored
 * (`errorCode`); nothing to show. `purged`: past retention, bodies deleted.
 */
export type GatewayRetentionStatus = "stored" | "failed" | "purged";

/** Where and what one retained body is; never the body itself. */
export interface GatewayRetainedBodyMeta {
  key: string;
  bytes: number;
  /** Lowercase hex SHA-256 of the stored bytes. */
  sha256: string;
  contentType: string;
  /**
   * The stored bytes are the first part of a longer streamed answer, cut at
   * the retention cap and followed by the GATEWAY_RETENTION_TRUNCATED marker.
   */
  truncated?: true;
  /** With `truncated`: how many bytes the caller actually received. */
  observedBytes?: number;
}

/** Metadata of one request's retained bodies. Bodies live in blobs only. */
export interface GatewayRetentionEntry {
  requestId: string;
  tenantId: string;
  userId: string;
  keyId?: string;
  status: GatewayRetentionStatus;
  errorCode?: string;
  request: GatewayRetainedBodyMeta;
  response: GatewayRetainedBodyMeta;
  /** HTTP status of the answer the caller received. */
  responseStatus: number;
  /** Epoch ms. */
  storedAt: number;
  expiresAt: number;
  purgedAt?: number;
}

export interface GatewayRetentionPort {
  /** Write one request's row; the first write per request id wins, a duplicate is a no-op. */
  record(entry: Omit<GatewayRetentionEntry, "status" | "purgedAt"> & { status: "stored" | "failed" }): Promise<void>;
  get(input: { requestId: string }): Promise<GatewayRetentionEntry | null>;
  /** Rows not yet purged whose `expiresAt <= before`, oldest first. */
  expired(input: { before: number; limit: number }): Promise<GatewayRetentionEntry[]>;
  /** Mark a row purged; idempotent (an already purged row keeps its first `purgedAt`). */
  markPurged(input: { requestId: string; at: number }): Promise<void>;
}

export interface GatewayJob {
  /** Caller-chosen id; enqueueing the same id twice schedules one job. */
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  runAt?: number;
}

/** Durable work after the response: media polling, settlement retries, sweeps. */
export interface GatewaySchedulerPort {
  enqueue(job: GatewayJob): Promise<{ jobId: string; duplicate: boolean }>;
}

export interface GatewayAuditEvent {
  id: string;
  actor: string;
  tenantId: string;
  action: string;
  target: string;
  /** Redacted snapshots; never key material or prompt content. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  requestId?: string;
  at: number;
}

export interface GatewayAuditPort {
  append(event: GatewayAuditEvent): Promise<void>;
  query(filter: { tenantId: string; limit?: number }): Promise<GatewayAuditEvent[]>;
}

export type GatewayLogFields = Record<string, string | number | boolean | null | undefined>;

/** Metadata-only logs: ids, counts, codes and durations; never prompts or keys. Must not throw. */
export interface GatewayLogger {
  info(event: string, fields?: GatewayLogFields): void;
  warn(event: string, fields?: GatewayLogFields): void;
  error(event: string, fields?: GatewayLogFields): void;
}

export interface GatewayUpstreamPort {
  /** Platform fetch, injectable so tests point at a mock upstream. */
  fetch(request: Request): Promise<Response>;
}

export interface GatewayPorts {
  clock: GatewayClock;
  ids: GatewayIds;
  identity: GatewayIdentityPort;
  routes: GatewayRoutesPort;
  credentials: GatewayCredentialPort;
  upstreamHealth: GatewayUpstreamHealthPort;
  budgets: GatewayBudgetPort;
  limits: GatewayLimitPort;
  ledger: GatewayLedgerPort;
  blobs: GatewayBlobPort;
  retention: GatewayRetentionPort;
  scheduler: GatewaySchedulerPort;
  audit: GatewayAuditPort;
  logger: GatewayLogger;
  upstream: GatewayUpstreamPort;
}

export type GatewayPortName = keyof GatewayPorts;

export const GATEWAY_PORT_NAMES = [
  "clock",
  "ids",
  "identity",
  "routes",
  "credentials",
  "upstreamHealth",
  "budgets",
  "limits",
  "ledger",
  "blobs",
  "retention",
  "scheduler",
  "audit",
  "logger",
  "upstream",
] as const satisfies readonly GatewayPortName[];

// Compile-time proof that GATEWAY_PORT_NAMES lists every port.
const _everyPortListed: [
  Exclude<GatewayPortName, (typeof GATEWAY_PORT_NAMES)[number]>,
] extends [never]
  ? true
  : never = true;

/**
 * A port this deployment does not implement: every method rejects with
 * GATEWAY_CAPABILITY_UNAVAILABLE (HTTP 501), never a silent no-op or a 404.
 */
export function unavailablePort<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      return () =>
        Promise.reject(
          new GatewayError("GATEWAY_CAPABILITY_UNAVAILABLE", {
            details: { port: name, method },
          }),
        );
    },
  });
}
