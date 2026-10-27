export type MarketplaceFeedItem = Record<string, unknown> & { id: string };

export const FEATURED_MARKETPLACE_PLUGIN_IDS = [
  "clash.storyboard",
  "clash.codex-imagegen",
  "clash.video.sd25-pe",
] as const;

/** Build the home Store feed. Pass `featuredPluginIds` from curation overlay when ops control featured; otherwise code defaults + official-picks skills apply. */
export function selectMarketplaceFeed({
  plugins,
  skills = [],
  featuredPluginIds = FEATURED_MARKETPLACE_PLUGIN_IDS,
}: {
  actions?: readonly MarketplaceFeedItem[];
  plugins: readonly MarketplaceFeedItem[];
  skills?: readonly MarketplaceFeedItem[];
  featuredPluginIds?: readonly string[];
}): MarketplaceFeedItem[] {
  const catalog = new Map(
    [...plugins, ...skills].map((plugin) => [plugin.id, plugin]),
  );

  const curatedIds = skills.flatMap((skill) => {
    const curation = skill.curation;
    return curation &&
      typeof curation === "object" &&
      (curation as Record<string, unknown>).collection === "official-picks"
      ? [skill.id]
      : [];
  });
  return [...new Set([...featuredPluginIds, ...curatedIds])].flatMap(
    (pluginId) => {
      const plugin = catalog.get(pluginId);
      return plugin ? [plugin] : [];
    },
  );
}
