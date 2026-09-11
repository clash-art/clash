import { useNavigate } from "react-router";
import { isDesktopRuntime } from "../lib/runtimeConfig";
import { usePageHistorySwipe } from "./usePageHistorySwipe";
import { Check } from "@phosphor-icons/react";
import type { RegistryItem } from "@clash/web-ui/lib/clientActions";

import { AppBreadcrumb, AppPage, AppPageHeaderBand } from "./AppPage";
import {
  MarketplaceItemArtwork,
  MarketplacePluginDeclarations,
} from "./MarketplaceItemCard";
import { Badge } from "./ui/badge";

export default function MarketplacePluginDetail({
  installed,
  item,
}: {
  installed: boolean;
  item: RegistryItem;
}) {
  const navigate = useNavigate();
  const historySwipe = usePageHistorySwipe(
    () => navigate(-1),
    isDesktopRuntime(),
  );
  return (
    <div className="min-h-screen" {...historySwipe()}>
      <AppPageHeaderBand width="narrow">
        <AppBreadcrumb
          className="mb-0 w-full"
          items={[
            { label: "Marketplace", to: "/marketplace/manage" },
            { label: item.name },
          ]}
        />
      </AppPageHeaderBand>

      <AppPage width="narrow">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <span className="flex size-16 shrink-0 items-center justify-center">
            <MarketplaceItemArtwork item={item} context="preview" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="text-3xl font-bold tracking-tight text-content-primary">
                {item.name}
              </h1>
              {installed ? (
                <Badge variant="secondary" tone="sage">
                  <Check className="size-3" weight="bold" aria-hidden="true" />
                  Installed
                </Badge>
              ) : null}
            </div>
            {item.author || item.version ? (
              <p className="mt-1 text-sm text-content-muted">
                {item.author ? `@${item.author}` : null}
                {item.author && item.version ? " · " : null}
                {item.version ? `v${item.version}` : null}
              </p>
            ) : null}
            {item.description ? (
              <p className="mt-3 max-w-[65ch] text-base leading-6 text-content-secondary">
                {item.description}
              </p>
            ) : null}
          </div>
        </header>

        <section aria-label="Plugin declarations" className="mt-10">
          <h2 className="mb-4 text-lg font-semibold text-content-primary">
            Declared capabilities
          </h2>
          <MarketplacePluginDeclarations item={item} />
        </section>
      </AppPage>
    </div>
  );
}
