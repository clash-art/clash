/**
 * Typed client for team settings (#354; guide: apps/docs/guide/gateway-teams.md):
 * the product API under /api/v1/gateway (teams, invites, members and roles,
 * owner budget allocation, rate limits, the team wallet's purchases, and a
 * member's own usage). It runs on the product session, never the admin one.
 * Every failure is an `AdminApiError` carrying the server's coded error
 * (`GATEWAY_*`), so forms show exactly what was refused; the server
 * authorizes every call and `teamCan` only decides what the UI offers.
 */
import {
  adminDownload,
  adminRequest,
  type BudgetEnforcement,
  type Budget,
  type GatewayKey,
  type RateLimit,
  type Subscription,
} from "./adminClient";

export { AdminApiError as TeamApiError } from "./adminClient";

const BASE = "/api/v1/gateway";
const seg = encodeURIComponent;
const tenantPath = (tenantId: string, path = "") => `${BASE}/tenants/${seg(tenantId)}${path}`;
const request = <T>(method: string, path: string, body?: unknown) => adminRequest<T>(method, path, body);

export type TeamRole = "owner" | "member";

export interface Team {
  tenantId: string;
  name: string;
  kind: "team" | "personal" | string;
  role: TeamRole | string;
  members: number;
}

export interface TeamTenant {
  id: string;
  name: string;
  kind: string;
  ownerUserId: string;
  rateLimit: RateLimit | null;
}

export interface TeamMember {
  userId: string;
  role: TeamRole | string;
  name: string | null;
  email: string | null;
  joinedAt: string | null;
  rateLimit: RateLimit | null;
}

export interface TeamInvite {
  id: string;
  tenantId: string;
  email: string;
  role: TeamRole | string;
  status: string;
  invitedByUserId: string;
  expiresAt: string;
  createdAt: string;
}

export interface TeamBudget extends Budget {
  enforcement: BudgetEnforcement;
  alertThresholdPct: number | null;
}

export interface BudgetEvent {
  id: string;
  budgetId: string;
  scope: string;
  scopeId: string;
  kind: "soft_exceeded" | "alert_threshold";
  enforcement: string;
  requestId: string | null;
  limitMicroCredits: number;
  spentMicroCredits: number;
  reservedMicroCredits: number;
  thresholdPct: number | null;
  occurredAt: string;
}

export interface TeamWallet {
  budgetId: string;
  status: string;
  limitMicroCredits: number | null;
  spentMicroCredits: number;
  reservedMicroCredits: number;
  availableMicroCredits: number | null;
}

export interface TeamPackage {
  id: string;
  name: string;
  billingPeriod: "month" | "year";
  priceMinor: number;
  priceCurrency: string;
  periodMicroCredits: number;
}

export interface TeamTopupPack {
  id: string;
  name: string;
  priceMinor: number;
  priceCurrency: string;
  microCredits: number;
}

export interface TeamUsage {
  requestId: string;
  userId: string;
  keyId: string | null;
  modelCode: string;
  status: string;
  costMicroCredits: number;
  /** Settled at zero although a real request (a failed or partial media generation): never charged. */
  notCharged: boolean;
  inputTokens: number;
  outputTokens: number;
  usageSource: string;
  errorCode: string | null;
  occurredAt: string;
}

export interface TeamAuditEntry {
  id: string;
  actorKind: string;
  actorId: string;
  actorRole: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  occurredAt: string;
}

/** A member's own view: their role, budget, keys and usage, never anyone else's. */
export interface TeamSelf {
  tenant: { id: string; name: string; kind: string };
  member: TeamMember;
  budgets: TeamBudget[];
  keys: GatewayKey[];
  usage: TeamUsage[];
  events: BudgetEvent[];
}

export interface BudgetAllocation {
  limitMicroCredits: number | null;
  status?: "active" | "suspended";
  enforcement?: BudgetEnforcement;
  alertThresholdPct?: number | null;
  /** Set a limit below spend + holds; needs a reason and is audited as an override. */
  override?: true;
  reason?: string;
}

/** Owner-only UI affordances, from the caller's role (the server decides). */
export function teamCan(team: Pick<Team, "role">): { manage: boolean } {
  return { manage: team.role === "owner" };
}

export const teamApi = {
  teams: () => request<{ teams: Team[] }>("GET", `${BASE}/teams`),
  createTeam: (name: string) => request<{ team: Team }>("POST", `${BASE}/teams`, { name }),
  lookupInvite: (token: string) =>
    request<{ invite: TeamInvite; team: { tenantId: string; name: string } }>("POST", `${BASE}/invites/lookup`, { token }),
  acceptInvite: (token: string) => request<{ team: Team }>("POST", `${BASE}/invites/accept`, { token }),

  tenant: (tenantId: string) => request<{ tenant: TeamTenant }>("GET", tenantPath(tenantId)),
  setTenantRateLimit: (tenantId: string, rateLimit: RateLimit | null) =>
    request<{ tenant: TeamTenant }>("PUT", tenantPath(tenantId, "/rate-limit"), { rateLimit }),

  members: (tenantId: string) => request<{ members: TeamMember[] }>("GET", tenantPath(tenantId, "/members")),
  setRole: (tenantId: string, userId: string, role: TeamRole) =>
    request<{ member: TeamMember }>("PUT", tenantPath(tenantId, `/members/${seg(userId)}/role`), { role }),
  setMemberRateLimit: (tenantId: string, userId: string, rateLimit: RateLimit | null) =>
    request<{ member: TeamMember }>("PUT", tenantPath(tenantId, `/members/${seg(userId)}/rate-limit`), { rateLimit }),
  removeMember: (tenantId: string, userId: string) =>
    request<{ removed: true }>("DELETE", tenantPath(tenantId, `/members/${seg(userId)}`)),

  invites: (tenantId: string) => request<{ invites: TeamInvite[] }>("GET", tenantPath(tenantId, "/invites")),
  invite: (tenantId: string, email: string, role: TeamRole) =>
    request<{ invite: TeamInvite; token: string; acceptPath: string }>("POST", tenantPath(tenantId, "/invites"), { email, role }),
  revokeInvite: (tenantId: string, inviteId: string) =>
    request<{ revoked: true }>("DELETE", tenantPath(tenantId, `/invites/${seg(inviteId)}`)),

  budgets: (tenantId: string) =>
    request<{ budgets: TeamBudget[]; wallet: TeamWallet | null; subscription: Subscription | null; events: BudgetEvent[] }>(
      "GET",
      tenantPath(tenantId, "/budgets"),
    ),
  setBudget: (tenantId: string, scope: "user" | "key", scopeId: string, body: BudgetAllocation) =>
    request<{ budget: TeamBudget }>("PUT", tenantPath(tenantId, `/budgets/${scope}/${seg(scopeId)}`), body),

  keys: (tenantId: string) => request<{ keys: GatewayKey[] }>("GET", tenantPath(tenantId, "/keys")),
  setKeyRateLimit: (tenantId: string, keyId: string, rateLimit: RateLimit | null) =>
    request<{ key: GatewayKey }>("PUT", tenantPath(tenantId, `/keys/${seg(keyId)}/rate-limit`), { rateLimit }),

  usage: (tenantId: string, page: { cursor?: string } = {}) =>
    request<{ usage: TeamUsage[]; nextCursor: string | null }>(
      "GET",
      tenantPath(tenantId, `/usage${page.cursor ? `?cursor=${seg(page.cursor)}` : ""}`),
    ),
  /** The team's usage as CSV (owner); never the upstream that served it. */
  usageExport: (tenantId: string) => adminDownload(tenantPath(tenantId, "/usage/export"), "gateway-usage.csv"),
  /** The caller's own usage as CSV (any member). */
  myUsageExport: (tenantId: string) => adminDownload(tenantPath(tenantId, "/me/usage/export"), "gateway-usage.csv"),
  audit: (tenantId: string) => request<{ entries: TeamAuditEntry[] }>("GET", tenantPath(tenantId, "/audit")),
  me: (tenantId: string) => request<TeamSelf>("GET", tenantPath(tenantId, "/me")),

  billing: (tenantId: string) =>
    request<{ wallet: TeamWallet | null; subscription: Subscription | null }>("GET", tenantPath(tenantId, "/billing")),
  offers: (tenantId: string) => request<{ packages: TeamPackage[]; packs: TeamTopupPack[] }>("GET", tenantPath(tenantId, "/billing/offers")),
  subscribe: (tenantId: string, packageId: string, idempotencyKey: string) =>
    request<unknown>("POST", tenantPath(tenantId, "/subscription"), { packageId, idempotencyKey }),
  cancelSubscription: (tenantId: string) => request<unknown>("POST", tenantPath(tenantId, "/subscription/cancel")),
  topup: (tenantId: string, packId: string, idempotencyKey: string) =>
    request<unknown>("POST", tenantPath(tenantId, "/topups"), { packId, idempotencyKey }),
};

/** A price in minor units of an ISO 4217 currency, e.g. 500 USD -> "$5.00". */
export function formatPrice(priceMinor: number, currency: string): string {
  try {
    const digits = new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(priceMinor / 10 ** digits);
  } catch {
    return `${priceMinor} ${currency}`;
  }
}
