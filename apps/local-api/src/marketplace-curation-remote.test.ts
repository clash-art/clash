import { describe, expect, it, vi } from "vitest";
import {
  applyRemoteOverlayToCatalog,
  fetchMarketplaceCurationOverlay,
  selectMarketplaceFeedWithOverlay,
} from "./marketplace-curation-remote";

describe("remote marketplace curation", () => {
  it("returns empty overlay when URL unset or fetch fails", async () => {
    expect(await fetchMarketplaceCurationOverlay(undefined)).toEqual([]);
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(
      await fetchMarketplaceCurationOverlay("https://example.invalid/c", fetchImpl),
    ).toEqual([]);
  });

  it("parses remote overlay JSON and drives featured selection", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        version: 1,
        items: [
          {
            kind: "plugin",
            itemId: "clash.storyboard",
            featured: true,
            hidden: false,
            sortOrder: 0,
          },
          {
            kind: "skill",
            itemId: "hide.me",
            featured: false,
            hidden: true,
            sortOrder: null,
          },
        ],
      }),
    );
    const overlay = await fetchMarketplaceCurationOverlay(
      "https://example.test/curation",
      fetchImpl,
    );
    expect(overlay).toHaveLength(2);

    const plugins = [
      {
        id: "clash.storyboard",
        type: "plugin",
        packageId: "clash.storyboard",
      },
      { id: "other.plugin", type: "plugin", packageId: "other.plugin" },
    ];
    const skills = [
      { id: "hide.me", type: "skill" },
      { id: "keep.me", type: "skill" },
    ];
    const catalog = applyRemoteOverlayToCatalog([...plugins, ...skills], overlay);
    expect(catalog.items.map((i) => i.id).sort()).toEqual([
      "clash.storyboard",
      "keep.me",
      "other.plugin",
    ]);
    expect(
      selectMarketplaceFeedWithOverlay({ plugins, skills, overlay }).map(
        (i) => i.id,
      ),
    ).toEqual(["clash.storyboard"]);
  });
});
