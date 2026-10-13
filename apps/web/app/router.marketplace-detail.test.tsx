// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./layouts/AppLayout", async () => {
  const { Outlet } = await import("react-router");
  return { default: () => <Outlet /> };
});

vi.mock("./layouts/appLayoutLoader", () => ({
  loader: async () => ({ isAuthenticated: true }),
}));

vi.mock("./root", () => ({
  ErrorBoundary: () => <p>Route error</p>,
  HydrateFallback: () => null,
}));

vi.mock("./lib/routeModuleRecovery", () => ({
  clearRouteModuleRecovery: vi.fn(),
}));

import { router } from "./router";

const plugin = {
  id: "clash.openai.workflow",
  type: "skill" as const,
  name: "Workflow skill",
  description: "Turns a brief into an executable workflow.",
  author: "OpenAI",
  version: "1.2.0",
  source: "provider-official",
  executionContract: "prompt-compiler",
  tags: ["planning", "workflow"],
  inputs: ["creative brief", "success criteria"],
  outputs: ["executable workflow"],
  requiredSystemCapabilities: ["project.read"],
};

describe("Marketplace plugin detail route", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://clash.local").pathname;
        if (path === "/api/marketplace/registry") {
          return Response.json({
            version: 1,
            actions: [],
            skills: [plugin],
          });
        }
        return Response.json([]);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // The first navigation imports the lazy route module graph cold, which
  // alone takes most of the default 5s budget when the suite runs in parallel.
  it("renders a directly addressable plugin page with the shared breadcrumb and declarations", { timeout: 30_000 }, async () => {
    await router.navigate("/marketplace/skill/clash.openai.workflow");
    const { container } = render(<RouterProvider router={router} />);

    expect(
      await screen.findByRole("heading", { name: "Workflow skill" }),
    ).toBeTruthy();
    const breadcrumb = screen.getByRole("navigation", {
      name: "Breadcrumb",
    });
    const headerBand = container.querySelector<HTMLElement>(
      '[data-slot="app-page-header-band"]',
    );
    const page = container.querySelector<HTMLElement>('[data-slot="app-page"]');
    expect(headerBand).not.toBeNull();
    expect(headerBand?.className).toContain("sticky");
    expect(headerBand?.className).toContain(
      "top-[var(--app-page-sticky-header-top)]",
    );
    expect(headerBand?.contains(breadcrumb)).toBe(true);
    expect(page?.contains(breadcrumb)).toBe(false);
    expect(
      within(breadcrumb)
        .getByRole("link", { name: "Marketplace" })
        .getAttribute("href"),
    ).toBe("/marketplace/manage");
    expect(
      within(breadcrumb)
        .getByText("Workflow skill")
        .getAttribute("aria-current"),
    ).toBe("page");
    const declarations = screen.getByRole("region", {
      name: "Plugin declarations",
    });
    expect(within(declarations).getByText("creative brief")).toBeTruthy();
    expect(within(declarations).getByText("executable workflow")).toBeTruthy();
    expect(within(declarations).getByText("project.read")).toBeTruthy();
    expect(within(declarations).getByText("prompt-compiler")).toBeTruthy();
    expect(within(declarations).getByText("provider-official")).toBeTruthy();
  });
});
