// @vitest-environment jsdom
import {
  cleanup,
  render as testingRender,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import MarketplaceClient from "./MarketplaceClient";

function render(ui: ReactElement) {
  return testingRender(
    <MemoryRouter initialEntries={["/marketplace/manage"]}>{ui}</MemoryRouter>,
  );
}

describe("MarketplaceClient layout", () => {
  afterEach(cleanup);

  it("uses the shared wide catalog page contract", () => {
    const { container } = render(
      <MarketplaceClient
        items={[]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Marketplace" })).toBeTruthy();
    const page = container.querySelector('[data-slot="app-page"]');
    expect(page).toHaveAttribute("data-width", "wide");
    expect(page).toHaveClass(
      "px-[var(--app-page-inline-inset)]",
      "pt-[var(--app-page-block-start)]",
    );
  });

  it("keeps page identity in flow and discovery controls sticky above a plugin grid", () => {
    const { container } = render(
      <MarketplaceClient
        items={[
          {
            id: "skill-1",
            type: "skill",
            name: "Skill one",
            description: "A useful skill.",
          },
        ]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    const stickyControls = container.querySelector(
      '[data-slot="marketplace-sticky-controls"]',
    );
    const pageHeader = container.querySelector('[data-slot="app-page-header"]');
    expect(stickyControls).toHaveClass(
      "sticky",
      "top-[var(--clash-app-sidebar-section-gap)]",
    );
    expect(stickyControls).not.toContainElement(
      screen.getByRole("heading", { name: "Marketplace" }),
    );
    expect(stickyControls).toContainElement(
      screen.getByRole("searchbox", { name: "Search actions and skills" }),
    );
    expect(
      (pageHeader?.compareDocumentPosition(stickyControls as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const catalog = screen.getByRole("list", { name: "Marketplace catalog" });
    expect(catalog).toHaveAttribute("data-layout", "plugin-grid");
    expect(catalog).toHaveClass("grid");
    const plugin = screen.getByRole("listitem");
    expect(plugin).toHaveAttribute("data-layout", "model-card");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("uses the shared product card surface contract", () => {
    const { container } = render(
      <MarketplaceClient
        items={[
          {
            id: "skill-1",
            type: "skill",
            name: "Skill one",
            description: "A useful skill.",
          },
        ]}
        installedActionIds={[]}
        installedSkillIds={[]}
      />,
    );

    const catalog = container.querySelector(
      '[data-layout="plugin-grid"]',
    ) as HTMLElement;
    const card = container.querySelector(
      '[data-slot="marketplace-item"]',
    ) as HTMLElement;

    expect(catalog.className).toContain("gap-[var(--settings-row-gap)]");
    expect(catalog.className).not.toContain("border-t");
    expect(card.getAttribute("data-layout")).toBe("model-card");
    expect(card).toHaveAttribute("data-ui", "card");
    expect(card).toHaveAttribute("data-interaction", "surface");
  });
});
