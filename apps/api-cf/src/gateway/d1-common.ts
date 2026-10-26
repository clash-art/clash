/**
 * Shared pieces of the Workers/D1 gateway ports. D1 gateway columns are unix
 * seconds; gateway-core speaks epoch milliseconds. Conversion happens through
 * these helpers only.
 */
import type { GatewayClock } from "@clash/gateway-core";

/** Epoch ms -> unix seconds (floor: a second has started once its first ms has). */
export const toSeconds = (ms: number) => Math.floor(ms / 1000);

/** Unix seconds -> epoch ms. */
export const toMs = (seconds: number) => seconds * 1000;

/** Every `gateway_upstream_account.id` starts with this; tenant BYOK account ids are minted elsewhere. */
export const GATEWAY_UPSTREAM_ACCOUNT_ID_PREFIX = "gwu_";

/** Wall clock that never goes backwards within one isolate. */
export function monotonicClock(): GatewayClock {
  let last = 0;
  return { now: () => (last = Math.max(last, Date.now())) };
}

/**
 * Subquery for the published catalog version at `nowParam` (unix seconds):
 * the newest `published_at` that has started. Unpublished rows (published_at
 * NULL) are drafts and never route.
 */
export const publishedCatalogVersionSql = (nowParam: string) => `(SELECT catalog_version FROM gateway_model
   WHERE published_at IS NOT NULL AND published_at <= ${nowParam}
   ORDER BY published_at DESC, catalog_version DESC LIMIT 1)`;

export function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function stringList(value: string | null): string[] | undefined {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return undefined;
  const list = parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  return list.length ? list : undefined;
}

export function numberRecord(value: string | null): Record<string, number> | undefined {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}
