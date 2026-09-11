import { normalizeMarketplaceItems } from "@clash/web-ui/lib/marketplaceCatalog";
import { redirect } from "react-router";
import type { RegistryItem } from "@clash/web-ui/lib/clientActions";
import { runtimeApiUrl } from "@clash/web-ui/lib/runtimeConfig";

interface RegistryData {
  version: number;
  actions: RegistryItem[];
  skills: RegistryItem[];
  plugins: RegistryItem[];
}

export interface MarketplaceData {
  items: RegistryItem[];
  installedActionIds: string[];
  installedSkillIds: string[];
  installedPluginIds: string[];
}

interface MarketplaceFeedResponse {
  version: number;
  featuredPlugins: RegistryItem[];
}

export interface MarketplaceFeedData {
  featuredPlugins: RegistryItem[];
  installedActionIds: string[];
  installedPluginIds: string[];
  installedSkillIds: string[];
}

const emptyRegistry: RegistryData = {
  version: 1,
  actions: [],
  skills: [],
  plugins: [],
};

export const emptyMarketplaceData: MarketplaceData = {
  items: [],
  installedActionIds: [],
  installedSkillIds: [],
  installedPluginIds: [],
};

const emptyMarketplaceFeedResponse: MarketplaceFeedResponse = {
  version: 1,
  featuredPlugins: [],
};

export const emptyMarketplaceFeedData: MarketplaceFeedData = {
  featuredPlugins: [],
  installedActionIds: [],
  installedPluginIds: [],
  installedSkillIds: [],
};

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 2000);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function fetchRegistry(): Promise<RegistryData> {
  try {
    const response = await fetchWithTimeout(
      runtimeApiUrl("/api/marketplace/registry"),
    );
    if (!response.ok) return emptyRegistry;
    const registry = (await response.json()) as Partial<RegistryData>;
    return {
      version: typeof registry.version === "number" ? registry.version : 1,
      actions: normalizeMarketplaceItems(registry.actions, "action"),
      skills: normalizeMarketplaceItems(registry.skills, "skill"),
      plugins: normalizeMarketplaceItems(registry.plugins, "plugin"),
    };
  } catch {
    return emptyRegistry;
  }
}

async function fetchMarketplaceFeed(): Promise<MarketplaceFeedResponse> {
  try {
    const response = await fetchWithTimeout(
      runtimeApiUrl("/api/marketplace/feed"),
    );
    if (!response.ok) return emptyMarketplaceFeedResponse;
    const feed = (await response.json()) as Partial<MarketplaceFeedResponse>;
    return {
      version: typeof feed.version === "number" ? feed.version : 1,
      featuredPlugins: normalizeMarketplaceItems(feed.featuredPlugins),
    };
  } catch {
    return emptyMarketplaceFeedResponse;
  }
}

async function fetchInstalled<T>(path: string): Promise<T[]> {
  try {
    const response = await fetchWithTimeout(runtimeApiUrl(path), {
      credentials: "include",
    });
    if (response.status === 401) throw redirect("/login");
    if (!response.ok) return [];
    const installed = await response.json();
    return Array.isArray(installed) ? (installed as T[]) : [];
  } catch (error) {
    if (error instanceof Response) throw error;
    return [];
  }
}

export async function loadMarketplaceData(options?: {
  includeSkills?: boolean | "official-picks";
}): Promise<MarketplaceData> {
  const [registry, actions, skills, plugins] = await Promise.all([
    fetchRegistry(),
    fetchInstalled<{ actionId?: unknown }>("/api/settings/actions"),
    fetchInstalled<{ skillId?: unknown }>("/api/settings/skills"),
    fetchInstalled<{ id?: unknown; drifted?: unknown }>("/api/v1/local/plugins"),
  ]);

  return {
    items: [
      ...registry.actions,
      ...registry.plugins,
      ...(options?.includeSkills === false
        ? []
        : options?.includeSkills === "official-picks"
          ? registry.skills.filter(
              (skill) => skill.curation?.collection === "official-picks",
            )
          : registry.skills),
    ],
    installedActionIds: actions.flatMap((action) =>
      typeof action.actionId === "string" ? [action.actionId] : [],
    ),
    installedSkillIds: skills.flatMap((skill) =>
      typeof skill.skillId === "string" ? [skill.skillId] : [],
    ),
    installedPluginIds: plugins.flatMap((plugin) =>
      typeof plugin.id === "string" && plugin.drifted === false ? [plugin.id] : [],
    ),
  };
}

export async function loadMarketplaceFeedData(): Promise<MarketplaceFeedData> {
  const [feed, actions, plugins, skills] = await Promise.all([
    fetchMarketplaceFeed(),
    fetchInstalled<{ actionId?: unknown }>("/api/settings/actions"),
    fetchInstalled<{ id?: unknown; drifted?: unknown }>("/api/v1/local/plugins"),
    fetchInstalled<{ skillId?: unknown }>("/api/settings/skills"),
  ]);

  return {
    featuredPlugins: feed.featuredPlugins,
    installedActionIds: actions.flatMap((action) =>
      typeof action.actionId === "string" ? [action.actionId] : [],
    ),
    installedPluginIds: plugins.flatMap((plugin) =>
      typeof plugin.id === "string" && plugin.drifted === false ? [plugin.id] : [],
    ),
    installedSkillIds: skills.flatMap((skill) =>
      typeof skill.skillId === "string" ? [skill.skillId] : [],
    ),
  };
}
