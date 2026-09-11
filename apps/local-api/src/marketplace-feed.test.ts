import { describe, expect, it } from "vitest";

import { selectMarketplaceFeed } from "./marketplace-feed";

describe("Marketplace feed selection", () => {
  it("includes curated community skills once while retaining their original source", () => {
    const picked = {
      id: "example.pick",
      type: "skill",
      source: "community",
      curation: { collection: "official-picks", curator: "Clash" },
    };
    const other = { id: "example.other", type: "skill", source: "community" };
    expect(
      selectMarketplaceFeed({ plugins: [], skills: [picked, other] }),
    ).toEqual([picked]);
    expect(
      selectMarketplaceFeed({
        plugins: [],
        skills: [picked, other],
        featuredPluginIds: [picked.id],
      }),
    ).toEqual([picked]);
  });
  it("selects the Clash-relevant mixed feed from the shared catalogs without generic Skills", () => {
    const orphanAction = {
      id: "action.orphan",
      name: "Orphan Action",
      type: "action" as const,
    };
    const codexPlugin = {
      id: "clash.codex-imagegen",
      name: "Codex ImageGen",
      type: "plugin" as const,
      packageId: "clash.codex-imagegen",
    };
    const plugin = {
      id: "clash.storyboard",
      name: "Storyboard",
      type: "plugin" as const,
      packageId: "clash.storyboard",
      artwork: { src: "/brand/avatar-storyboard.png" },
    };
    const relevantSkill = {
      id: "clash.video.sd25-pe",
      name: "sd25-pe",
      type: "skill" as const,
    };
    const unrelatedSkill = {
      id: "clash.openai.define-goal",
      name: "define-goal",
      type: "skill" as const,
    };

    expect(
      selectMarketplaceFeed({
        actions: [orphanAction],
        plugins: [plugin, codexPlugin],
        skills: [relevantSkill, unrelatedSkill],
      }),
    ).toEqual([plugin, codexPlugin, relevantSkill]);

    expect(
      selectMarketplaceFeed({
        actions: [orphanAction],
        plugins: [plugin],
        skills: [],
        featuredPluginIds: ["action.orphan", "clash.storyboard"],
      }),
    ).toEqual([plugin]);
  });
});
