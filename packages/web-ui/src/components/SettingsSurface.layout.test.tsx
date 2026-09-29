// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsSurface } from "./SettingsSurface";

vi.mock("@clash/web-ui/lib/clientActions", () => ({
  listApiTokens: vi.fn().mockResolvedValue([]),
  listVariables: vi.fn().mockResolvedValue([]),
  listInstalledActions: vi.fn().mockResolvedValue([]),
  listInstalledSkills: vi.fn().mockResolvedValue([]),
  listModelProviders: vi.fn().mockResolvedValue([]),
  listModelCatalog: vi.fn().mockResolvedValue([]),
}));

afterEach(cleanup);

describe("SettingsSurface page layout", () => {
  it("uses the shared page inset inside its full-height workspace", () => {
    const { container } = render(
      <SettingsSurface
        active="agents"
        onActiveChange={() => undefined}
        variant="page"
      />,
    );
    const page = container.querySelector('[data-slot="app-page"]');

    expect(page).toHaveAttribute("data-width", "standard");
    expect(page).toHaveClass(
      "px-[var(--app-page-inline-inset)]",
      "pt-[var(--app-page-block-start)]",
      "pb-[var(--app-page-block-end)]",
    );
    expect(
      container.querySelector(".clash-settings-page-content"),
    ).toContainElement(page as HTMLElement);
  });
});

it("offers expansion only when the embedding surface provides it", () => {
  const onExpand = vi.fn();
  const { rerender } = render(<SettingsSurface active="agents" onActiveChange={() => undefined} onExpand={onExpand} />);
  fireEvent.click(screen.getByRole("button", { name: "Open settings page" }));
  expect(onExpand).toHaveBeenCalledOnce();
  rerender(<SettingsSurface active="agents" onActiveChange={() => undefined} />);
  expect(screen.queryByRole("button", { name: "Open settings page" })).not.toBeInTheDocument();
});
