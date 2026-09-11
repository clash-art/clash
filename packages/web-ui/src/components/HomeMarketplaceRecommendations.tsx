import { ArrowUpRight, Check } from "@phosphor-icons/react";
import type { RegistryItem } from "@clash/web-ui/lib/clientActions";
import { Link } from "react-router";

import { Card } from "./ui/card";
import { MarketplaceItemArtwork } from "./MarketplaceItemCard";
import { marketplacePluginPath } from "./marketplaceRouting";
import { HomeSectionActionLink, HomeSectionHeader } from "./HomeSectionHeader";

export default function HomeMarketplaceRecommendations({
  featuredPlugins,
  installedActionIds,
  installedPluginIds,
  installedSkillIds,
}: {
  featuredPlugins: RegistryItem[];
  installedActionIds: string[];
  installedPluginIds: string[];
  installedSkillIds: string[];
}) {
  if (featuredPlugins.length === 0) return null;

  const installedActions = new Set(installedActionIds);
  const installedPlugins = new Set(installedPluginIds);
  const installedSkills = new Set(installedSkillIds);

  return (
    <section
      aria-labelledby="home-marketplace-heading"
      className="clash-home-section"
    >
      <HomeSectionHeader
        id="home-marketplace-heading"
        title="Official Picks"
        action={
          <HomeSectionActionLink to="/marketplace/manage">
            View Marketplace
          </HomeSectionActionLink>
        }
      />

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {featuredPlugins.map((item) => {
          const installed =
            item.type === "action"
              ? installedActions.has(item.id)
              : item.type === "plugin"
                ? installedPlugins.has(item.id)
                : installedSkills.has(item.id);

          return (
            <li
              key={`${item.type}-${item.id}`}
              data-slot="home-marketplace-item"
              className="min-w-0"
            >
              <Card asChild interaction="surface" padding="sm">
                <Link
                  to={marketplacePluginPath(item)}
                  aria-label={`View ${item.name} details`}
                  className="flex h-full min-w-0 flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <MarketplaceItemArtwork item={item} context="preview" />
                    <ArrowUpRight
                      className="size-4 text-content-muted"
                      aria-hidden="true"
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <h3 className="truncate text-sm font-semibold text-content-primary">
                      {item.name}
                    </h3>
                    {item.description ? (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-content-secondary">
                        {item.description}
                      </p>
                    ) : null}
                    <span className="mt-auto flex items-center gap-1 pt-4 text-xs text-content-muted">
                      {installed ? (
                        <Check
                          className="size-3"
                          weight="bold"
                          aria-hidden="true"
                        />
                      ) : null}
                      {installed
                        ? "Installed"
                        : item.type === "action"
                          ? "Action"
                          : item.type === "plugin"
                            ? "Plugin"
                            : "Skill"}
                    </span>
                  </div>
                </Link>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
