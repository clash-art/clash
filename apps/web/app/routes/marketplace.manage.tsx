import { useLoaderData } from "react-router";
import MarketplaceClient from "@clash/web-ui/components/MarketplaceClient";
import { loadMarketplaceData } from "../lib/marketplaceData";

export async function loader() {
  return loadMarketplaceData({ includeSkills: "official-picks" });
}

export default function MarketplaceManageRoute() {
  const { items, installedActionIds, installedSkillIds, installedPluginIds } =
    useLoaderData<typeof loader>();
  return (
    <MarketplaceClient
      items={items}
      installedActionIds={installedActionIds}
      installedSkillIds={installedSkillIds}
      installedPluginIds={installedPluginIds}
      catalogScope="official-picks"
      mode="manage"
    />
  );
}
