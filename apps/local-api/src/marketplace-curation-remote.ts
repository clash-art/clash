import {
  applyMarketplaceCurationOverlay,
  normalizeMarketplaceCurationRows,
  overlayControlsFeatured,
  type MarketplaceCurationRow,
} from "@clash/shared-types/marketplace-curation";

import {
  FEATURED_MARKETPLACE_PLUGIN_IDS,
  selectMarketplaceFeed,
  type MarketplaceFeedItem,
} from "./marketplace-feed.js";

/** Optional remote overlay for Host. Unset / failed fetch ⇒ empty (code defaults). */
export async function fetchMarketplaceCurationOverlay(
  url: string | undefined | null,
  fetchImpl: typeof fetch = fetch,
): Promise<MarketplaceCurationRow[]> {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) return [];
  try {
    const res = await fetchImpl(trimmed, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: unknown };
    return normalizeMarketplaceCurationRows(body.items ?? body);
  } catch {
    return [];
  }
}

export function applyRemoteOverlayToCatalog<T extends MarketplaceFeedItem>(
  items: readonly T[],
  overlay: readonly MarketplaceCurationRow[],
): { items: T[]; featuredPluginIds: readonly string[] } {
  if (overlay.length === 0) {
    return { items: [...items], featuredPluginIds: FEATURED_MARKETPLACE_PLUGIN_IDS };
  }
  const skills = items.filter((item) => item.type === "skill");
  const plugins = items.filter((item) => item.type === "plugin");
  const skillResult = applyMarketplaceCurationOverlay(skills, overlay);
  const pluginResult = applyMarketplaceCurationOverlay(plugins, overlay);
  const merged = [...pluginResult.items, ...skillResult.items] as T[];
  if (!overlayControlsFeatured(overlay)) {
    return { items: merged, featuredPluginIds: FEATURED_MARKETPLACE_PLUGIN_IDS };
  }
  return {
    items: merged,
    featuredPluginIds: [
      ...new Set([...pluginResult.featuredIds, ...skillResult.featuredIds]),
    ],
  };
}

export function selectMarketplaceFeedWithOverlay({
  plugins,
  skills = [],
  overlay,
}: {
  plugins: readonly MarketplaceFeedItem[];
  skills?: readonly MarketplaceFeedItem[];
  overlay: readonly MarketplaceCurationRow[];
}): MarketplaceFeedItem[] {
  const catalog = applyRemoteOverlayToCatalog(
    [...plugins, ...skills],
    overlay,
  );
  const nextPlugins = catalog.items.filter((item) => item.type === "plugin");
  const nextSkills = catalog.items.filter((item) => item.type === "skill");
  return selectMarketplaceFeed({
    plugins: nextPlugins,
    skills: nextSkills,
    featuredPluginIds: catalog.featuredPluginIds,
  });
}

export function curationUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env.MARKETPLACE_CURATION_URL?.trim();
  return value || undefined;
}
