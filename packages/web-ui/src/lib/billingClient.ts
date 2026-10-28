/**
 * Legacy typed client for the retired `/api/v1/billing/{plans,balance,ledger,checkout}`
 * shapes used by the presentational `BillingClient` (visual-language tests).
 *
 * Hosted Polar billing (#420) lives in clash-hosted's console-plugins overlay:
 * it reads gateway `…/tenants/:tenantId/billing` + `/billing/offers` and posts
 * `POST /api/v1/billing/tenants/:tenantId/checkout`. Account chrome uses
 * `useBillingBalance` → `teamApi.billing` instead of this module.
 *
 * OSS self-host registers no billing route/nav (empty `consolePlugins`).
 */
import { runtimeApiUrl } from "./runtimeConfig";
import type { ProviderUsageAuditEvent } from "@clash/shared-types";
export type { ProviderUsageAuditEvent } from "@clash/shared-types";

export interface PlanFeatures {
  storage_mb: number;
  max_projects: number;
  max_resolution: "720p" | "1080p" | "4K";
  max_duration_s: number;
  model_whitelist?: string[];
  commercial: boolean;
}

export interface Plan {
  id: string;
  name: string;
  price_usd_cents: number;
  monthly_credits: number;
  features: PlanFeatures;
}

export interface TopupPack {
  pack_id: string;
  credits: number;
  price_usd_cents: number;
  paddle_price_id: string | null;
  label: string;
}

export interface PlansResponse {
  plans: Plan[];
  packs: TopupPack[];
}

export interface Balance {
  topup: number;
  grant: number;
  grant_expires_at: number | null;
  hold: number;
  available: number;
}

export interface LedgerEntry {
  id: string;
  user_id: string;
  kind:
    | "topup" | "grant" | "hold" | "settle" | "release" | "refund" | "adjust" | "expire";
  amount: number;
  topup_after: number;
  grant_after: number;
  hold_after: number;
  ref_kind: string | null;
  ref_id: string | null;
  model_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: number;
}

export class BillingNotEnabledError extends Error {
  constructor() {
    super("Billing is not enabled on this deployment.");
    this.name = "BillingNotEnabledError";
  }
}

async function billingFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(runtimeApiUrl(`/api/v1/billing${path}`), {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (res.status === 404) throw new BillingNotEnabledError();
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // ignore
    }
    throw new Error(`billing: ${msg}`);
  }
  return res.json() as Promise<T>;
}

export function fetchPlans(): Promise<PlansResponse> {
  return billingFetch<PlansResponse>("/plans");
}

export function fetchBalance(): Promise<{ balance: Balance }> {
  return billingFetch<{ balance: Balance }>("/balance");
}

export function fetchLedger(limit = 20): Promise<{ entries: LedgerEntry[] }> {
  return billingFetch<{ entries: LedgerEntry[] }>(`/ledger?limit=${limit}`);
}

export async function fetchProviderUsage(limit = 100): Promise<{ events: ProviderUsageAuditEvent[] }> {
  const response = await fetch(runtimeApiUrl(`/api/v1/provider-usage?limit=${limit}`), {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`provider usage: ${response.status}`);
  return response.json() as Promise<{ events: ProviderUsageAuditEvent[] }>;
}

export function createCheckout(opts: {
  pack_id?: string;
  plan_id?: string;
  email?: string;
}): Promise<{ url: string }> {
  return billingFetch<{ url: string }>("/checkout", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}
