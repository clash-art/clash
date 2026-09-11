// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import HomeMarketplaceRecommendations from "./HomeMarketplaceRecommendations";

const items = Array.from({ length: 5 }, (_, index) => ({
  id: `plugin-${index + 1}`,
  type: "plugin" as const,
  name: `Plugin ${index + 1}`,
  description: `Real registry plugin ${index + 1}.`,
}));

describe("HomeMarketplaceRecommendations", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not reserve homepage space when the feed has no featured plugins", () => {
    render(
      <MemoryRouter>
        <HomeMarketplaceRecommendations
          featuredPlugins={[]}
          installedActionIds={[]}
          installedPluginIds={[]}
          installedSkillIds={[]}
        />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole("region", { name: "Official Picks" }),
    ).toBeNull();
  });

  it("renders every configured featured plugin and links to the full marketplace", () => {
    const { container } = render(
      <MemoryRouter>
        <HomeMarketplaceRecommendations
          featuredPlugins={items}
          installedActionIds={[]}
          installedPluginIds={[]}
          installedSkillIds={[]}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("region", { name: "Official Picks" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Plugin 1" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Plugin 5" })).toBeTruthy();
    expect(
      container.querySelectorAll('[data-slot="home-marketplace-item"]'),
    ).toHaveLength(5);
    expect(
      screen
        .getByRole("link", { name: "View Marketplace" })
        .getAttribute("href"),
    ).toBe("/marketplace/manage");
    expect(
      screen.getByRole("link", { name: "View Plugin 1 details" }),
    ).toHaveAttribute("href", "/marketplace/plugin/plugin-1");
  });

  it("keeps Home as a lightweight discovery preview without Marketplace operations", () => {
    render(
      <MemoryRouter>
        <HomeMarketplaceRecommendations
          featuredPlugins={[items[0]]}
          installedActionIds={[]}
          installedPluginIds={[]}
          installedSkillIds={[]}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add to Composer" }),
    ).toBeNull();
    expect(screen.getByRole("link", { name: "View Marketplace" })).toBeTruthy();
  });

  it("shows installation state as quiet metadata", () => {
    render(
      <MemoryRouter>
        <HomeMarketplaceRecommendations
          featuredPlugins={[items[0]]}
          installedActionIds={[]}
          installedPluginIds={[items[0].id]}
          installedSkillIds={[]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses Plugin installation state and type metadata for a feed Plugin", () => {
    const storyboard = {
      id: "clash.storyboard",
      type: "plugin" as const,
      name: "Storyboard",
      description: "Draft key elements and shots.",
      artwork: {
        src: "/brand/avatar-storyboard.png",
        alt: "Clash Storyboard plugin",
      },
    };
    const { rerender } = render(
      <MemoryRouter>
        <HomeMarketplaceRecommendations
          featuredPlugins={[storyboard]}
          installedActionIds={[]}
          installedPluginIds={[]}
          installedSkillIds={[]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Plugin")).toBeTruthy();
    expect(screen.queryByText("Skill")).toBeNull();

    rerender(
      <MemoryRouter>
        <HomeMarketplaceRecommendations
          featuredPlugins={[storyboard]}
          installedActionIds={[]}
          installedPluginIds={[storyboard.id]}
          installedSkillIds={[]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Installed")).toBeTruthy();
  });

  it("uses Skill installation state for a Clash-relevant feed Skill", () => {
    render(
      <MemoryRouter>
        <HomeMarketplaceRecommendations
          featuredPlugins={[
            {
              id: "clash.video.sd25-pe",
              type: "skill",
              name: "sd25-pe",
              description: "Seedance prompt engineering.",
            },
          ]}
          installedActionIds={[]}
          installedPluginIds={[]}
          installedSkillIds={["clash.video.sd25-pe"]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Installed")).toBeTruthy();
  });
});
