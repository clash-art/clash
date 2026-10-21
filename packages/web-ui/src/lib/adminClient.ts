/**
 * Typed client for the gateway admin console API, /api/v1/admin/gateway (#353;
 * guide: apps/docs/guide/gateway-admin.md). Every failure is an
 * `AdminApiError` carrying the server's coded error (`GATEWAY_*`), so forms
 * can show exactly what the server refused. The server authorizes every call;
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

const q = (params: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
};
const seg = encodeURIComponent;

// ─── Types (server views) ─────────────────────────────────────────────────

export type TenantRole = "owner" | "admin" | "finance" | "support" | "viewer";
export const ADMIN_MEMBER_ROLES = ["owner", "admin", "finance", "support", "viewer", "member"] as const;

export interface AdminMe {
  userId: string;
  platformRoles: string[];
  platformPermissions: string[];
  tenants: Array<{ tenantId: string; name: string; kind: string; role: string; permissions: string[] }>;
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

export interface RateLimit {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  concurrency?: number;
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
  credential: {
    kind: "secret_ref" | "sealed";
    secretRef: string | null;
    fields: string[];
    keyVersion: string;
    rotatedAt: string | null;
  };
  updatedAt: string;
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
}

export interface AdminTopupPack {
  id: string;
  name: string;
  status: "active" | "archived";
  priceMinor: number;
  priceCurrency: string;
  microCredits: number;
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

export interface PlatformAdmin {
  userId: string;
  name: string | null;
  email: string | null;
  grantedByUserId: string | null;
  grantedAt: string;
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
}

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
    platformAdmins: number;
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
  actorUserId: string;
  actorRole: string | null;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  occurredAt: string;
}

export interface AbuseSignals {
  windowMinutes: number;
  rateWindows: Array<{ subject: string; requests: number; tokens: number; lastWindowAt: string }>;
  inflight: Array<{ subject: string; leases: number }>;
  events: { available: false; reason: string };
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
  actorUserId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
}

// ─── Permissions (UI affordance only; the server decides) ─────────────────

export function adminCan(me: AdminMe, permission: string, tenantId?: string): boolean {
  if (me.platformPermissions.includes(permission)) return true;
  if (tenantId === undefined) return false;
  return me.tenants.some((tenant) => tenant.tenantId === tenantId && tenant.permissions.includes(permission));
}

/** The first tenant where the caller holds `permission`. */
export function firstTenantWith(me: AdminMe, permission: string): string | undefined {
  return me.tenants.find((tenant) => tenant.permissions.includes(permission))?.tenantId;
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
  /** Opens with this permission in a tenant the caller belongs to. */
  tenant?: string;
  /** Opens with this platform permission (platform-wide view). */
  platform?: string;
}

/** The console pages and the permission each needs (one of). */
export const ADMIN_PAGES: readonly AdminPage[] = [
  { key: "overview", path: "/admin", label: "Overview", tenant: "tenant.read", platform: "usage.read_all" },
  { key: "models", path: "/admin/models", label: "Models & prices", platform: "catalog.read" },
  { key: "upstreams", path: "/admin/upstreams", label: "Upstreams", platform: "upstreams.read" },
  { key: "users", path: "/admin/users", label: "Users & teams", tenant: "members.read", platform: "tenants.list" },
  { key: "budgets", path: "/admin/budgets", label: "Budgets & limits", tenant: "budgets.read", platform: "tenants.list" },
  { key: "packages", path: "/admin/packages", label: "Packages", platform: "packages.read" },
  { key: "usage", path: "/admin/usage", label: "Usage", tenant: "usage.read", platform: "usage.read_all" },
  { key: "abuse", path: "/admin/abuse", label: "Abuse", platform: "abuse.read" },
  { key: "audit", path: "/admin/audit", label: "Audit log", tenant: "audit.read", platform: "audit.read_all" },
];

export function adminPage(key: AdminPageKey): AdminPage {
  return ADMIN_PAGES.find((page) => page.key === key)!;
}

/** Whether the caller can open `page` at all (platform-wide or in some tenant). */
export function canOpenAdminPage(me: AdminMe, page: AdminPage): boolean {
  return (
    (page.platform !== undefined && me.platformPermissions.includes(page.platform)) ||
    (page.tenant !== undefined && firstTenantWith(me, page.tenant) !== undefined)
  );
}

/**
 * The tenant a tenant-scoped page shows: the requested one when the caller
 * may see it there, else their first tenant with the permission. Undefined
 * means the platform-wide view (platform staff) or no access.
 */
export function resolveAdminTenant(me: AdminMe, page: AdminPage, requested: string | null): string | undefined {
  if (!page.tenant) return undefined;
  if (requested && adminCan(me, page.tenant, requested)) return requested;
  if (page.platform && me.platformPermissions.includes(page.platform)) return undefined;
  return firstTenantWith(me, page.tenant);
}

// ─── Calls ────────────────────────────────────────────────────────────────

export const adminApi = {
  me: () => adminRequest<AdminMe>("GET", "/me"),

  overview: (tenantId?: string) => adminRequest<{ overview: Overview }>("GET", `/overview${q({ tenantId })}`),
  usage: (filters: UsageFilters) => adminRequest<UsageResult>("GET", `/usage${q({ ...filters })}`),
  audit: (filters: AuditFilters) => adminRequest<{ entries: AuditEntry[] }>("GET", `/audit${q({ ...filters })}`),
  abuse: () => adminRequest<{ abuse: AbuseSignals }>("GET", "/abuse"),
  promptAccess: (requestId: string, reason: string) =>
    adminRequest<{ prompt: RetainedPrompt }>("POST", `/prompts/${seg(requestId)}/access`, { reason }),

  catalog: () => adminRequest<{ versions: CatalogVersionSummary[] }>("GET", "/catalog"),
  catalogVersion: (version: string) => adminRequest<{ version: CatalogVersion }>("GET", `/catalog/versions/${seg(version)}`),
  cloneCatalog: (version: string, from: string) =>
    adminRequest<{ version: CatalogVersion }>("POST", `/catalog/versions/${seg(version)}/clone`, { from }),
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
  rotateUpstream: (id: string, credential: UpstreamCredential, reason?: string) =>
    adminRequest<{ upstream: UpstreamAccount }>("POST", `/upstreams/${seg(id)}/rotate`, { credential, ...(reason ? { reason } : {}) }),

  packages: () => adminRequest<{ packages: AdminPackage[] }>("GET", "/packages"),
  createPackage: (body: { name: string; billingPeriod: "month" | "year"; priceMinor: number; priceCurrency: string; periodMicroCredits: number; rateLimit?: RateLimit }) =>
    adminRequest<{ package: AdminPackage }>("POST", "/packages", body),
  archivePackage: (id: string) => adminRequest<{ package: AdminPackage }>("POST", `/packages/${seg(id)}/archive`),
  topupPacks: () => adminRequest<{ packs: AdminTopupPack[] }>("GET", "/topup-packs"),
  createTopupPack: (body: { name: string; priceMinor: number; priceCurrency: string; microCredits: number }) =>
    adminRequest<{ pack: AdminTopupPack }>("POST", "/topup-packs", body),
  archiveTopupPack: (id: string) => adminRequest<{ pack: AdminTopupPack }>("POST", `/topup-packs/${seg(id)}/archive`),
  rollover: () => adminRequest<{ subscriptions: unknown[]; failed: number }>("POST", "/billing/rollover", {}),

  tenants: (query?: string) => adminRequest<{ tenants: TenantSummary[] }>("GET", `/tenants${q({ query })}`),
  members: (tenantId: string) => adminRequest<{ members: TenantMember[] }>("GET", `/tenants/${seg(tenantId)}/members`),
  setMemberRole: (tenantId: string, userId: string, role: string, reason?: string) =>
    adminRequest<{ member: TenantMember }>("PUT", `/tenants/${seg(tenantId)}/members/${seg(userId)}/role`, {
      role,
      ...(reason ? { reason } : {}),
    }),
  platformAdmins: () => adminRequest<{ admins: PlatformAdmin[] }>("GET", "/platform-admins"),
  grantPlatformAdmin: (userId: string, reason?: string) =>
    adminRequest<{ granted: boolean }>("POST", "/platform-admins", { userId, ...(reason ? { reason } : {}) }),
  revokePlatformAdmin: (userId: string, reason?: string) =>
    adminRequest<{ revoked: boolean }>("POST", `/platform-admins/${seg(userId)}/revoke`, reason ? { reason } : {}),

  budgets: (tenantId: string) =>
    adminRequest<{ budgets: Budget[]; wallet: Budget | null; subscription: Subscription | null }>("GET", `/tenants/${seg(tenantId)}/budgets`),
  setBudget: (tenantId: string, scope: "user" | "key", scopeId: string, body: { limitMicroCredits: number | null; status?: "active" | "suspended"; reason?: string }) =>
    adminRequest<{ budget: Budget }>("PUT", `/tenants/${seg(tenantId)}/budgets/${scope}/${seg(scopeId)}`, body),
  keys: (tenantId: string) => adminRequest<{ keys: GatewayKey[] }>("GET", `/tenants/${seg(tenantId)}/keys`),
  setKeyRateLimit: (tenantId: string, keyId: string, rateLimit: RateLimit | null) =>
    adminRequest<{ key: GatewayKey }>("PUT", `/tenants/${seg(tenantId)}/keys/${seg(keyId)}/rate-limit`, { rateLimit }),
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
export function parseRateLimit(fields: { requestsPerMinute: string; tokensPerMinute: string; concurrency: string }): RateLimit | null {
  const limit: RateLimit = {};
  for (const key of ["requestsPerMinute", "tokensPerMinute", "concurrency"] as const) {
    const text = fields[key].trim();
    if (!text) continue;
    if (!/^\d+$/.test(text) || Number(text) <= 0) throw new Error(`${key} must be a positive whole number.`);
    limit[key] = Number(text);
  }
  return Object.keys(limit).length ? limit : null;
}

export function describeRateLimit(limit: RateLimit | null | undefined): string {
  if (!limit) return "No limit";
  const parts = [
    limit.requestsPerMinute ? `${limit.requestsPerMinute} rpm` : null,
    limit.tokensPerMinute ? `${limit.tokensPerMinute.toLocaleString()} tpm` : null,
    limit.concurrency ? `${limit.concurrency} concurrent` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}
