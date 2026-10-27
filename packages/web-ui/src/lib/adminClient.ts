/**
 * Typed client for the gateway admin console API, /api/v1/admin/gateway (#353;
 * guide: apps/docs/guide/gateway-admin.md), and for the admin sign-in
 * (/api/admin-auth, #394: an admin account session, separate from product
 * sessions). Every failure is an `AdminApiError` carrying the server's coded
 * error (`GATEWAY_*`, or Better Auth's code at sign-in), so forms can show
 * exactly what the server refused. The server authorizes every call;
 * `adminCan` only decides what the UI offers.
 */
import { runtimeFetch } from "./runtimeConfig";

const BASE = "/api/v1/admin/gateway";

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function adminRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await runtimeFetch(path.startsWith("/api/") ? path : `${BASE}${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code =
      response.headers.get("x-clash-error-code") ??
      (typeof error?.code === "string" ? error.code : `HTTP_${response.status}`);
    throw new AdminApiError(
      response.status,
      code,
      typeof error?.message === "string" ? error.message : response.statusText || "Request failed",
    );
  }
  return parsed as T;
}

/** The admin identity's own Better Auth instance (#394); never the product /api/better-auth. */
export const ADMIN_AUTH_BASE = "/api/admin-auth";

async function adminAuthRequest(path: string, body: unknown): Promise<void> {
  const response = await runtimeFetch(`${ADMIN_AUTH_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  // Better Auth answers `{ code, message }`; a rate-limited attempt has a message only.
  const parsed = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  throw new AdminApiError(
    response.status,
    typeof parsed?.code === "string" ? parsed.code : `HTTP_${response.status}`,
    typeof parsed?.message === "string" ? parsed.message : response.statusText || "Request failed",
  );
}

/** Admin sign-in and sign-out: the `clash-admin` session, separate from any product session. */
export const adminAuthApi = {
  signIn: (email: string, password: string) => adminAuthRequest("/sign-in/email", { email, password }),
  signOut: () => adminAuthRequest("/sign-out", {}),
};

/** The console's sign-in page, returning to `returnTo` (a same-origin /admin path only). */
export function adminLoginPath(returnTo?: string): string {
  return returnTo && isAdminReturnPath(returnTo) ? `/admin/login?returnTo=${encodeURIComponent(returnTo)}` : "/admin/login";
}

/** Only console pages are valid return targets: never another origin or a product page. */
export function isAdminReturnPath(path: string): boolean {
  return /^\/admin(?:[/?#]|$)/.test(path) && !path.startsWith("/admin/login");
}

const q = (params: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
};
const seg = encodeURIComponent;

// ─── Types (server views) ─────────────────────────────────────────────────

/**
 * The signed-in admin account (#394): admin accounts are their own identity,
 * never product users, and the console takes nothing else.
 */
export interface AdminMe {
  admin: { id: string; email: string; name: string; role: string };
  /** Every permission the account's role holds. */
  permissions: string[];
  promptAccess: boolean;
}

/** One retained body: the stored bytes as text, with their size and SHA-256. */
export interface RetainedBody {
  contentType: string;
  bytes: number;
  sha256: string;
  body: string;
}

/** A gateway request's retained prompt and response (staff view; every read is audited). */
export interface RetainedPrompt {
  requestId: string;
  tenantId: string;
  userId: string;
  keyId: string | null;
  responseStatus: number;
  storedAt: string;
  expiresAt: string;
  request: RetainedBody;
  response: RetainedBody;
}

/** A configured rate limit (`GatewayRateLimitSchema` on the server). */
export interface RateLimit {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  concurrency?: number;
  /** Media/AIGC generations in flight at once. */
  mediaJobs?: number;
}

export interface CatalogVersionSummary {
  version: string;
  status: "draft" | "published";
  live: boolean;
  models: number;
  publishedAt: string | null;
  createdAt: string;
}

export interface CatalogModel {
  modelCode: string;
  kind: string;
  displayName: string | null;
  enabled: boolean;
  maxOutputTokens: number | null;
  rateLimit: RateLimit | null;
  publishedAt: string | null;
  card: unknown;
}

export interface CatalogVersion {
  version: string;
  status: "draft" | "published";
  models: CatalogModel[];
}

/** POST …/seed: the AIGC/media-first launch draft and why each other card was left out. */
export interface CatalogSeedResult {
  version: CatalogVersion;
  excluded: Array<{ modelCode: string; reason: "deepseek-not-flash" | "text-not-configured" | "no-official-account" }>;
  unknownTextModelCodes: string[];
}

export interface PriceRate {
  modelCode: string;
  upstreamId: string;
  unit: string;
  amountMicroCredits: number;
  per: number;
}

export interface PriceVersion {
  version: string;
  status: "draft" | "published";
  effectiveFrom: string;
  effectiveTo: string | null;
  publishedAt: string | null;
  rates: PriceRate[];
}

export interface UpstreamAccount {
  id: string;
  providerId: string;
  upstreamId: string;
  apiShape: string | null;
  region: string;
  label: string | null;
  enabled: boolean;
  priority: number | null;
  weight: number | null;
  rateLimit: RateLimit | null;
  /** The active key version (sent first). */
  credential: UpstreamKeyVersion & { rotatedAt: string | null };
  /** The previous version while a rotation drains; null otherwise. */
  draining: (UpstreamKeyVersion & { since: string | null }) | null;
  /** The version the next rotation adds. */
  nextKeyVersion: string;
  /** Circuit-breaker state; null when nothing is on record. */
  health: {
    state: "closed" | "open" | "half_open";
    consecutiveFailures: number;
    openUntil: string | null;
    lastFailureCode: string | null;
    lastFailureAt: string | null;
    lastSuccessAt: string | null;
  } | null;
  updatedAt: string;
}

/** One key version as the server shows it: never the key, at most its first characters. */
export interface UpstreamKeyVersion {
  kind: "secret_ref" | "sealed";
  secretRef: string | null;
  fields: string[];
  keyVersion: string;
  keyPrefix: string | null;
  /** For a secret_ref: whether the binding currently resolves. */
  secretPresent?: boolean;
}

export type UpstreamCredential = { secretRef: string } | { apiKey: string; baseUrl?: string };

export interface AdminPackage {
  id: string;
  name: string;
  status: "active" | "archived";
  billingPeriod: "month" | "year";
  priceMinor: number;
  priceCurrency: string;
  periodMicroCredits: number;
  rateLimit: RateLimit | null;
  /** Payment provider price id (#419); null when unset. */
  externalPriceId?: string | null;
}

export interface AdminTopupPack {
  id: string;
  name: string;
  status: "active" | "archived";
  priceMinor: number;
  priceCurrency: string;
  microCredits: number;
  /** Payment provider price id (#419); null when unset. */
  externalPriceId?: string | null;
}

export interface TenantSummary {
  id: string;
  name: string;
  kind: string;
  ownerUserId: string;
  members: number;
  createdAt: string;
}

export interface TenantMember {
  userId: string;
  role: string;
  name: string | null;
  email: string | null;
  joinedAt: string | null;
}

/**
 * Admin account roles (`admin_accounts.role`; the server's
 * GATEWAY_PLATFORM_ROLES): platform_admin holds everything; support_agent
 * (#356) reads and suspends by id, with no key, credential or prompt access.
 */
export const ADMIN_ACCOUNT_ROLES = ["platform_admin", "support_agent"] as const;
export type AdminAccountRole = (typeof ADMIN_ACCOUNT_ROLES)[number];

/** An admin account (admin store, #394). */
export interface AdminAccount {
  id: string;
  email: string;
  name: string;
  role: string;
  disabledAt: string | null;
  createdAt: string;
}

export interface Budget {
  id: string;
  scope: "tenant" | "user" | "key";
  scopeId: string;
  status: string;
  limitMicroCredits: number | null;
  spentMicroCredits: number;
  reservedMicroCredits: number;
  availableMicroCredits: number | null;
  /** hard (refuse), soft (admit and flag), alert (admit and notify). A wallet is always hard. */
  enforcement?: BudgetEnforcement;
  /** Percent of the limit an alert is raised at; null: none (an alert budget alerts at 100%). */
  alertThresholdPct?: number | null;
}

export const BUDGET_ENFORCEMENTS = ["hard", "soft", "alert"] as const;
export type BudgetEnforcement = (typeof BUDGET_ENFORCEMENTS)[number];

export interface Subscription {
  id: string;
  packageId: string;
  status: string;
  currentPeriodEnd: string;
  rateLimit: RateLimit | null;
}

export interface GatewayKey {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  budgetId: string | null;
  rateLimit: RateLimit | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface Overview {
  windowDays: number;
  requests: number;
  spentMicroCredits: number;
  failedRequests: number;
  topModels: Array<{ modelCode: string; requests: number; spentMicroCredits: number }>;
  platform?: {
    tenants: number;
    liveCatalogVersion: string | null;
    liveCatalogModels: number;
    upstreamsEnabled: number;
    upstreams: number;
    activePackages: number;
    adminAccounts: number;
  };
  tenant?: { members: number; activeKeys: number; suspendedBudgets: number };
}

export interface UsageEntry {
  requestId: string;
  kind: string;
  status: string;
  tenantId: string;
  userId: string | null;
  keyId: string | null;
  amountMicroCredits: number;
  modelCode: string | null;
  inputTokens: number;
  outputTokens: number;
  priceVersion: string | null;
  errorCode: string | null;
  occurredAt: string;
}

export interface UsageResult {
  entries: UsageEntry[];
  byModel: Array<{ modelCode: string; requests: number; amountMicroCredits: number; inputTokens: number; outputTokens: number }>;
}

export interface AuditEntry {
  id: string;
  tenantId: string;
  /** `admin` (an admin account), `user` (a team role), `system` (an abuse threshold), `bootstrap` or `migration`. */
  actorKind: string;
  actorId: string;
  actorRole: string | null;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  occurredAt: string;
}

/** Abuse signals (#356; `GATEWAY_ABUSE_SIGNALS` on the server). */
export const ABUSE_SIGNALS = ["spend", "auth_failures", "shared_key", "velocity"] as const;
export type AbuseSignal = (typeof ABUSE_SIGNALS)[number];

/** A signal's threshold (`GatewayAbuseThresholdSchema`); `suspendAt` null: alert only. Spend is in micro-credits. */
export interface AbuseThreshold {
  windowMinutes: number;
  alertAt: number;
  suspendAt: number | null;
}

/** One measured subject: a tenant, a key, or a client fingerprint (no recognized credential). */
export interface AbuseObservation {
  signal: AbuseSignal;
  subjectKind: "tenant" | "key" | "client";
  subjectId: string;
  tenantId: string | null;
  value: number;
}

export interface AbuseAlert {
  id: string;
  signal: AbuseSignal;
  subjectKind: AbuseObservation["subjectKind"];
  subjectId: string;
  tenantId: string | null;
  value: number;
  threshold: number;
  windowMinutes: number;
  windowStart: string;
  action: "alert" | "suspend";
  suspensionId: string | null;
  createdAt: string;
}

export const SUSPENSION_SUBJECTS = ["tenant", "key"] as const;
export type SuspensionSubject = (typeof SUSPENSION_SUBJECTS)[number];

export interface Suspension {
  id: string;
  subjectKind: SuspensionSubject;
  subjectId: string;
  tenantId: string;
  /** `manual` (an admin account) or `auto` (a threshold's suspendAt, with its signal). */
  source: "manual" | "auto";
  signal: AbuseSignal | null;
  reason: string;
  actorKind: "admin" | "system";
  actorId: string;
  createdAt: string;
  liftedAt: string | null;
  liftedBy: string | null;
  liftReason: string | null;
}

export interface AbuseSignals {
  /** Live rate-limit counters: the last minutes of rate windows and open leases. */
  windowMinutes: number;
  rateWindows: Array<{ subject: string; requests: number; tokens: number; lastWindowAt: string }>;
  inflight: Array<{ subject: string; leases: number }>;
  events: { available: false; reason: string };
  /** Each signal's top subjects over its threshold window (or the default window without one). */
  signals: Array<{ signal: AbuseSignal; windowMinutes: number; threshold: AbuseThreshold | null; top: AbuseObservation[] }>;
  alerts: AbuseAlert[];
  /** Active suspensions first. */
  suspensions: Suspension[];
}

export interface UsageFilters {
  tenantId?: string;
  userId?: string;
  keyId?: string;
  modelCode?: string;
  kind?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface AuditFilters {
  tenantId?: string;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
}

// ─── Permissions (UI affordance only; the server decides) ─────────────────

/** Whether the signed-in admin account's role holds `permission`. */
export function adminCan(me: AdminMe, permission: string): boolean {
  return me.permissions.includes(permission);
}

export type AdminPageKey =
  | "overview"
  | "models"
  | "upstreams"
  | "users"
  | "budgets"
  | "packages"
  | "usage"
  | "abuse"
  | "audit";

export interface AdminPage {
  key: AdminPageKey;
  path: string;
  label: string;
  /** The platform permission that opens the page. */
  permission: string;
  /** Whether `?tenant=` narrows the page to one tenant. */
  tenantScoped?: boolean;
}

/** The console pages and the platform permission each needs. */
export const ADMIN_PAGES: readonly AdminPage[] = [
  { key: "overview", path: "/admin", label: "Overview", permission: "usage.read_all", tenantScoped: true },
  { key: "models", path: "/admin/models", label: "Models & prices", permission: "catalog.read" },
  { key: "upstreams", path: "/admin/upstreams", label: "Upstreams", permission: "upstreams.read" },
  { key: "users", path: "/admin/users", label: "Users & teams", permission: "tenants.list", tenantScoped: true },
  { key: "budgets", path: "/admin/budgets", label: "Budgets & limits", permission: "tenants.list", tenantScoped: true },
  { key: "packages", path: "/admin/packages", label: "Packages", permission: "packages.read" },
  { key: "usage", path: "/admin/usage", label: "Usage", permission: "usage.read_all", tenantScoped: true },
  { key: "abuse", path: "/admin/abuse", label: "Abuse", permission: "abuse.read" },
  { key: "audit", path: "/admin/audit", label: "Audit log", permission: "audit.read_all", tenantScoped: true },
];

export function adminPage(key: AdminPageKey): AdminPage {
  return ADMIN_PAGES.find((page) => page.key === key)!;
}

export function canOpenAdminPage(me: AdminMe, page: AdminPage): boolean {
  return adminCan(me, page.permission);
}

/** The tenant a tenant-scoped page shows: the requested one, else undefined (all tenants). */
export function resolveAdminTenant(page: AdminPage, requested: string | null): string | undefined {
  return page.tenantScoped && requested ? requested : undefined;
}

// ─── Calls ────────────────────────────────────────────────────────────────

export const adminApi = {
  me: () => adminRequest<AdminMe>("GET", "/me"),

  overview: (tenantId?: string) => adminRequest<{ overview: Overview }>("GET", `/overview${q({ tenantId })}`),
  usage: (filters: UsageFilters) => adminRequest<UsageResult>("GET", `/usage${q({ ...filters })}`),
  audit: (filters: AuditFilters) => adminRequest<{ entries: AuditEntry[] }>("GET", `/audit${q({ ...filters })}`),
  abuse: () => adminRequest<{ abuse: AbuseSignals }>("GET", "/abuse"),
  setAbuseThreshold: (signal: AbuseSignal, threshold: AbuseThreshold | null, reason?: string) =>
    adminRequest<{ signal: AbuseSignal; threshold: AbuseThreshold | null; changed: boolean }>("PUT", `/abuse/thresholds/${seg(signal)}`, {
      threshold,
      ...(reason ? { reason } : {}),
    }),
  suspend: (body: { subjectKind: SuspensionSubject; subjectId: string; reason: string }) =>
    adminRequest<{ suspension: Suspension }>("POST", "/abuse/suspensions", body),
  liftSuspension: (id: string, reason: string) =>
    adminRequest<{ suspension: Suspension }>("POST", `/abuse/suspensions/${seg(id)}/lift`, { reason }),
  promptAccess: (requestId: string, reason: string) =>
    adminRequest<{ prompt: RetainedPrompt }>("POST", `/prompts/${seg(requestId)}/access`, { reason }),

  catalog: () => adminRequest<{ versions: CatalogVersionSummary[] }>("GET", "/catalog"),
  catalogVersion: (version: string) => adminRequest<{ version: CatalogVersion }>("GET", `/catalog/versions/${seg(version)}`),
  cloneCatalog: (version: string, from: string) =>
    adminRequest<{ version: CatalogVersion }>("POST", `/catalog/versions/${seg(version)}/clone`, { from }),
  seedCatalog: (version: string, textModelCodes: string[]) =>
    adminRequest<CatalogSeedResult>(
      "POST",
      `/catalog/versions/${seg(version)}/seed`,
      textModelCodes.length > 0 ? { textModelCodes } : {},
    ),
  putCatalogModel: (
    version: string,
    modelCode: string,
    body: { card: unknown; displayName?: string | null; enabled: boolean; maxOutputTokens?: number | null; rateLimit?: RateLimit | null },
  ) => adminRequest<{ model: CatalogModel }>("PUT", `/catalog/versions/${seg(version)}/models/${seg(modelCode)}`, body),
  removeCatalogModel: (version: string, modelCode: string) =>
    adminRequest<{ removed: true }>("DELETE", `/catalog/versions/${seg(version)}/models/${seg(modelCode)}`),
  publishCatalog: (version: string) => adminRequest<{ version: CatalogVersion }>("POST", `/catalog/versions/${seg(version)}/publish`),

  prices: () => adminRequest<{ versions: PriceVersion[] }>("GET", "/prices"),
  putPriceDraft: (
    version: string,
    body: { effectiveFrom: string; effectiveTo?: string | null; rates: Array<{ modelCode: string; upstreamId?: string; unit: string; amountMicroCredits: number; per: number }> },
  ) => adminRequest<{ version: PriceVersion }>("PUT", `/prices/versions/${seg(version)}`, body),
  publishPrices: (version: string) => adminRequest<{ version: PriceVersion }>("POST", `/prices/versions/${seg(version)}/publish`),

  upstreams: () => adminRequest<{ upstreams: UpstreamAccount[] }>("GET", "/upstreams"),
  createUpstream: (body: {
    providerId: string;
    upstreamId?: string;
    apiShape?: string | null;
    region?: string;
    label?: string | null;
    priority?: number | null;
    weight?: number | null;
    credential: UpstreamCredential;
  }) => adminRequest<{ upstream: UpstreamAccount }>("POST", "/upstreams", body),
  updateUpstream: (id: string, patch: { enabled?: boolean; label?: string | null; priority?: number | null; weight?: number | null; rateLimit?: RateLimit | null }) =>
    adminRequest<{ upstream: UpstreamAccount }>("PATCH", `/upstreams/${seg(id)}`, patch),
  /** Add the next key version; `drain: false` revokes every previous version at once. */
  rotateUpstream: (id: string, credential: UpstreamCredential, options: { reason?: string; drain?: boolean } = {}) =>
    adminRequest<{ upstream: UpstreamAccount }>("POST", `/upstreams/${seg(id)}/rotate`, {
      credential,
      ...(options.drain === false ? { drain: false } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    }),
  revokeUpstreamKey: (id: string, keyVersion: string, reason?: string) =>
    adminRequest<{ upstream: UpstreamAccount }>("POST", `/upstreams/${seg(id)}/revoke`, { keyVersion, ...(reason ? { reason } : {}) }),

  packages: () => adminRequest<{ packages: AdminPackage[] }>("GET", "/packages"),
  createPackage: (body: { name: string; billingPeriod: "month" | "year"; priceMinor: number; priceCurrency: string; periodMicroCredits: number; rateLimit?: RateLimit; externalPriceId?: string | null }) =>
    adminRequest<{ package: AdminPackage }>("POST", "/packages", body),
  archivePackage: (id: string) => adminRequest<{ package: AdminPackage }>("POST", `/packages/${seg(id)}/archive`),
  setPackageExternalPriceId: (id: string, externalPriceId: string | null) =>
    adminRequest<{ package: AdminPackage }>("POST", `/packages/${seg(id)}/external-price`, { externalPriceId }),
  topupPacks: () => adminRequest<{ packs: AdminTopupPack[] }>("GET", "/topup-packs"),
  createTopupPack: (body: { name: string; priceMinor: number; priceCurrency: string; microCredits: number; externalPriceId?: string | null }) =>
    adminRequest<{ pack: AdminTopupPack }>("POST", "/topup-packs", body),
  archiveTopupPack: (id: string) => adminRequest<{ pack: AdminTopupPack }>("POST", `/topup-packs/${seg(id)}/archive`),
  setTopupPackExternalPriceId: (id: string, externalPriceId: string | null) =>
    adminRequest<{ pack: AdminTopupPack }>("POST", `/topup-packs/${seg(id)}/external-price`, { externalPriceId }),
  rollover: () => adminRequest<{ subscriptions: unknown[]; failed: number }>("POST", "/billing/rollover", {}),

  tenants: (query?: string) => adminRequest<{ tenants: TenantSummary[] }>("GET", `/tenants${q({ query })}`),
  members: (tenantId: string) => adminRequest<{ members: TenantMember[] }>("GET", `/tenants/${seg(tenantId)}/members`),
  adminAccounts: () => adminRequest<{ accounts: AdminAccount[] }>("GET", "/admin-accounts"),
  createAdminAccount: (body: { email: string; name: string; password: string; role?: AdminAccountRole; reason?: string }) =>
    adminRequest<{ account: AdminAccount; accounts: AdminAccount[] }>("POST", "/admin-accounts", body),
  disableAdminAccount: (id: string, reason?: string) =>
    adminRequest<{ disabled: boolean }>("POST", `/admin-accounts/${seg(id)}/disable`, reason ? { reason } : {}),

  // Teams are read-only in the console (#354): owners allocate budgets and set limits in team settings.
  budgets: (tenantId: string) =>
    adminRequest<{ budgets: Budget[]; wallet: Budget | null; subscription: Subscription | null }>("GET", `/tenants/${seg(tenantId)}/budgets`),
  keys: (tenantId: string) => adminRequest<{ keys: GatewayKey[] }>("GET", `/tenants/${seg(tenantId)}/keys`),
  setSubscriptionRateLimit: (tenantId: string, rateLimit: RateLimit | null, reason?: string) =>
    adminRequest<{ subscription: Subscription }>("PUT", `/tenants/${seg(tenantId)}/subscription/rate-limit`, {
      rateLimit,
      ...(reason ? { reason } : {}),
    }),
  adjustWallet: (tenantId: string, body: { deltaMicroCredits: number; reason: string; idempotencyKey: string }) =>
    adminRequest<unknown>("POST", `/tenants/${seg(tenantId)}/wallet/adjust`, body),
  setWalletStatus: (tenantId: string, status: "active" | "suspended", reason: string) =>
    adminRequest<unknown>("POST", `/tenants/${seg(tenantId)}/wallet/status`, { status, reason }),
};

// ─── Formatting and parsing ───────────────────────────────────────────────

export const MICRO = 1_000_000;

/** Micro-credits as credits, e.g. 1500000 -> "1.5". */
export function formatCredits(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return "Unlimited";
  return (micro / MICRO).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** Credits typed by an operator -> integer micro-credits; null when not a number. */
export function parseCredits(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const value = Math.round(Number(trimmed) * MICRO);
  return Number.isSafeInteger(value) ? value : null;
}

/** Rate-limit form fields -> a limit, or null when every field is empty. Throws on a non-integer. */
export function parseRateLimit(fields: {
  requestsPerMinute: string;
  tokensPerMinute: string;
  concurrency: string;
  mediaJobs?: string;
}): RateLimit | null {
  const limit: RateLimit = {};
  for (const key of ["requestsPerMinute", "tokensPerMinute", "concurrency", "mediaJobs"] as const) {
    const text = (fields[key] ?? "").trim();
    if (!text) continue;
    if (!/^\d+$/.test(text) || Number(text) <= 0) throw new Error(`${key} must be a positive whole number.`);
    limit[key] = Number(text);
  }
  return Object.keys(limit).length ? limit : null;
}

/** A signal's value as an operator reads it: spend in credits, the rest as counts. */
export function formatAbuseValue(signal: AbuseSignal, value: number): string {
  return signal === "spend" ? `${formatCredits(value)} credits` : value.toLocaleString();
}

/**
 * Threshold form fields -> a threshold (spend typed in credits, stored in
 * micro-credits); an empty suspendAt means alert only. Throws a readable
 * error; the server validates again with the one schema.
 */
export function parseAbuseThreshold(
  signal: AbuseSignal,
  fields: { windowMinutes: string; alertAt: string; suspendAt: string },
): AbuseThreshold {
  const amount = (label: string, text: string): number => {
    const value = signal === "spend" ? parseCredits(text) : /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
    if (value === null || value <= 0) throw new Error(`${label} must be a positive ${signal === "spend" ? "credit amount" : "whole number"}.`);
    return value;
  };
  const minutes = fields.windowMinutes.trim();
  if (!/^\d+$/.test(minutes) || Number(minutes) <= 0) throw new Error("Window must be a positive whole number of minutes.");
  return {
    windowMinutes: Number(minutes),
    alertAt: amount("Alert at", fields.alertAt),
    suspendAt: fields.suspendAt.trim() ? amount("Suspend at", fields.suspendAt) : null,
  };
}

export function describeRateLimit(limit: RateLimit | null | undefined): string {
  if (!limit) return "No limit";
  const parts = [
    limit.requestsPerMinute ? `${limit.requestsPerMinute} rpm` : null,
    limit.tokensPerMinute ? `${limit.tokensPerMinute.toLocaleString()} tpm` : null,
    limit.concurrency ? `${limit.concurrency} concurrent` : null,
    limit.mediaJobs ? `${limit.mediaJobs} media jobs` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}
