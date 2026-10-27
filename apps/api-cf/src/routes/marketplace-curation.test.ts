import { describe, expect, it } from "vitest";
import { normalizeMarketplaceCurationRows } from "@clash/shared-types/marketplace-curation";
import {
  applyOverlayToRegistry,
  DEFAULT_FEATURED_MARKETPLACE_IDS,
} from "./marketplace";

describe("marketplace overlay apply on registry", () => {
  it("hides skills and returns featured ids from overlay", () => {
    const registry = {
      version: 1,
      skills: [
        { id: "keep", type: "skill", title: "Keep" },
        { id: "hide-me", type: "skill", title: "Hide" },
        { id: "feature-me", type: "skill", title: "Feature" },
      ],
      plugins: [{ id: "clash.storyboard", type: "plugin", title: "Storyboard" }],
      actions: [],
    };
    const overlay = normalizeMarketplaceCurationRows([
      { kind: "skill", item_id: "hide-me", hidden: 1 },
      { kind: "skill", item_id: "feature-me", featured: 1, sort_order: 1 },
      {
        kind: "plugin",
        item_id: "clash.storyboard",
        featured: 1,
        sort_order: 0,
        title_override: "Storyboard*",
      },
    ]);
    const applied = applyOverlayToRegistry(registry, overlay);
    expect(applied.skills.map((s) => s.id)).toEqual(["keep", "feature-me"]);
    expect(applied.plugins?.[0]).toMatchObject({
      id: "clash.storyboard",
      title: "Storyboard*",
    });
    expect(applied.featuredIds).toEqual([
      "clash.storyboard",
      "feature-me",
    ]);
  });

  it("keeps default featured list constant for empty overlay callers", () => {
    expect(DEFAULT_FEATURED_MARKETPLACE_IDS).toContain("clash.storyboard");
  });
});
