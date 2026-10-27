import {
  applyMarketplaceCurationOverlay,
  normalizeMarketplaceCurationRows,
  overlayControlsFeatured,
  type MarketplaceCurationRow,
} from "@clash/shared-types/marketplace-curation";
import { withMarketplaceInstallation } from "@clash/shared-types/marketplace-installation";
import { Hono } from "hono";
import type { Env } from "../config";
import firstPartyRegistry from "../../../../skills/registry.json";

const REGISTRY_URL =
  "https://raw.githubusercontent.com/clash-community/awesome-actions/main/registry.json";

/** Code defaults for featured feed when no overlay rows opt into featured control. */
export const DEFAULT_FEATURED_MARKETPLACE_IDS = [
  "clash.storyboard",
  "clash.codex-imagegen",
  "clash.video.sd25-pe",
] as const;

interface RegistryData {
  version: number;
  marketplaceSemantics?: Record<string, unknown>;
  /** Historical remote field, never an executable installation contract. */
  actions?: Array<Record<string, unknown>>;
  plugins?: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown> & { id?: unknown }>;
  systemCapabilities?: Array<Record<string, unknown>>;
  thirdPartyReferences?: Array<Record<string, unknown>>;
}

const FIRST_PARTY = firstPartyRegistry as RegistryData;

function readOnlySkill(skill: RegistryData["skills"][number]) {
  return withMarketplaceInstallation(
    { ...skill, id: typeof skill.id === "string" ? skill.id : "" },
    { executablePlugins: false, skills: false },
  );
}

function isRegistryData(value: unknown): value is RegistryData {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<RegistryData>;
  return Array.isArray(maybe.skills);
}

function mergeRegistry(remote: RegistryData | null): RegistryData {
  if (!remote)
    return {
      ...FIRST_PARTY,
      actions: [],
      plugins: [],
      skills: FIRST_PARTY.skills.map(readOnlySkill),
    };

  const seenSkillIds = new Set<string>();
  const skills = [...FIRST_PARTY.skills];
  for (const skill of skills) {
    if (typeof skill.id === "string") seenSkillIds.add(skill.id);
  }
  for (const skill of remote.skills) {
    const id = typeof skill.id === "string" ? skill.id : null;
    if (id && seenSkillIds.has(id)) continue;
    if (id) seenSkillIds.add(id);
    skills.push(skill);
  }

  return {
    version: 1,
    marketplaceSemantics: FIRST_PARTY.marketplaceSemantics,
    actions: [],
    plugins: [],
    skills: skills.map(readOnlySkill),
    systemCapabilities: FIRST_PARTY.systemCapabilities,
    thirdPartyReferences: FIRST_PARTY.thirdPartyReferences,
  };
}

/** Fail-open D1 read: missing binding/table/query ⇒ empty overlay. */
export async function loadMarketplaceCurationOverlay(
  db: D1Database | undefined | null,
): Promise<MarketplaceCurationRow[]> {
  if (!db) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT kind, item_id, featured, hidden, sort_order,
                title_override, description_override, updated_at, updated_by
         FROM marketplace_curation`,
      )
      .all();
    return normalizeMarketplaceCurationRows(results ?? []);
  } catch {
    return [];
  }
}

type CatalogItem = Record<string, unknown> & { id: string; type?: unknown };

function asCatalogItems(
  skills: RegistryData["skills"],
  plugins: Array<Record<string, unknown>>,
): CatalogItem[] {
  const skillItems: CatalogItem[] = skills.map((skill) => {
    const id = typeof skill.id === "string" ? skill.id : "";
    return { ...skill, id, type: skill.type ?? "skill" };
  });
  const pluginItems: CatalogItem[] = plugins.map((plugin) => {
    const id = typeof plugin.id === "string" ? plugin.id : "";
    return { ...plugin, id, type: plugin.type ?? "plugin" };
  });
  return [...skillItems, ...pluginItems];
}

export function applyOverlayToRegistry(
  registry: RegistryData,
  overlay: readonly MarketplaceCurationRow[],
): RegistryData & { featuredIds: string[] } {
  const skillsIn = (registry.skills ?? []).map((skill) => ({
    ...skill,
    id: typeof skill.id === "string" ? skill.id : "",
    type: (skill as { type?: unknown }).type ?? "skill",
  }));
  const pluginsIn = (registry.plugins ?? []).map((plugin) => ({
    ...plugin,
    id: typeof plugin.id === "string" ? plugin.id : "",
    type: (plugin as { type?: unknown }).type ?? "plugin",
  }));

  const skillsResult = applyMarketplaceCurationOverlay(skillsIn, overlay);
  const pluginsResult = applyMarketplaceCurationOverlay(pluginsIn, overlay);
  const featuredIds = [
    ...new Set([...pluginsResult.featuredIds, ...skillsResult.featuredIds]),
  ];

  return {
    ...registry,
    skills: skillsResult.items,
    plugins: pluginsResult.items,
    featuredIds,
  };
}

function selectFeed(
  registry: RegistryData,
  overlay: readonly MarketplaceCurationRow[],
): CatalogItem[] {
  const applied = applyOverlayToRegistry(registry, overlay);
  const catalog = asCatalogItems(applied.skills, applied.plugins ?? []);
  const byId = new Map(catalog.map((item) => [item.id, item]));

  const useOverlayFeatured = overlayControlsFeatured(overlay);
  const featuredIds = useOverlayFeatured
    ? applied.featuredIds
    : [
        ...DEFAULT_FEATURED_MARKETPLACE_IDS,
        ...catalog
          .filter((item) => {
            const curation = item.curation;
            return (
              curation &&
              typeof curation === "object" &&
              (curation as Record<string, unknown>).collection ===
                "official-picks"
            );
          })
          .map((item) => item.id),
      ];

  return [...new Set(featuredIds)].flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

async function loadMergedRegistry(): Promise<RegistryData> {
  try {
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) return mergeRegistry(null);
    const remote = await res.json();
    return mergeRegistry(isRegistryData(remote) ? remote : null);
  } catch {
    return mergeRegistry(null);
  }
}

export const marketplaceRoutes = new Hono<{ Bindings: Env }>();

marketplaceRoutes.get("/registry", async (c) => {
  const registry = await loadMergedRegistry();
  const overlay = await loadMarketplaceCurationOverlay(c.env.DB);
  const applied = applyOverlayToRegistry(registry, overlay);
  const { featuredIds: _featuredIds, ...body } = applied;
  return c.json(body);
});

marketplaceRoutes.get("/feed", async (c) => {
  const registry = await loadMergedRegistry();
  const overlay = await loadMarketplaceCurationOverlay(c.env.DB);
  return c.json({
    version: 1,
    featuredPlugins: selectFeed(registry, overlay),
  });
});

/** Public overlay dump for Host / other consumers (no secrets). */
marketplaceRoutes.get("/curation", async (c) => {
  const overlay = await loadMarketplaceCurationOverlay(c.env.DB);
  return c.json({
    version: 1,
    items: overlay.map((row) => ({
      kind: row.kind,
      itemId: row.itemId,
      featured: row.featured,
      hidden: row.hidden,
      sortOrder: row.sortOrder,
      titleOverride: row.titleOverride,
      descriptionOverride: row.descriptionOverride,
      updatedAt: row.updatedAt ?? null,
      updatedBy: row.updatedBy ?? null,
    })),
  });
});
