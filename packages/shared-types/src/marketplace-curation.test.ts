import { describe, expect, it } from "vitest";
import {
  applyMarketplaceCurationOverlay,
  normalizeMarketplaceCurationRows,
  overlayControlsFeatured,
} from "./marketplace-curation";

describe("marketplace curation overlay", () => {
  const skills = [
    {
      id: "a",
      type: "skill" as const,
      title: "A",
      description: "da",
    },
    {
      id: "b",
      type: "skill" as const,
      title: "B",
      description: "db",
    },
    {
      id: "c",
      type: "skill" as const,
      title: "C",
      description: "dc",
    },
  ];

  it("is identity when overlay is empty", () => {
    expect(applyMarketplaceCurationOverlay(skills, [])).toEqual({
      items: skills,
      featuredIds: [],
    });
    expect(overlayControlsFeatured([])).toBe(false);
  });

  it("hides items and applies title/description overrides", () => {
    const overlay = normalizeMarketplaceCurationRows([
      { kind: "skill", item_id: "b", hidden: 1 },
      {
        kind: "skill",
        item_id: "a",
        featured: 1,
        sort_order: 2,
        title_override: "A*",
        description_override: "da*",
      },
      { kind: "skill", item_id: "c", featured: 1, sort_order: 1 },
    ]);
    const result = applyMarketplaceCurationOverlay(skills, overlay);
    expect(result.items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(result.items[0]).toMatchObject({
      id: "a",
      title: "A*",
      description: "da*",
    });
    expect(result.featuredIds).toEqual(["c", "a"]);
    expect(overlayControlsFeatured(overlay)).toBe(true);
  });

  it("ignores overlay rows whose kind does not match the item", () => {
    const plugins = [
      { id: "clash.storyboard", type: "plugin" as const, title: "Storyboard" },
    ];
    const overlay = normalizeMarketplaceCurationRows([
      { kind: "skill", item_id: "clash.storyboard", hidden: 1, featured: 1 },
    ]);
    expect(applyMarketplaceCurationOverlay(plugins, overlay).items).toEqual(
      plugins,
    );
  });
});
