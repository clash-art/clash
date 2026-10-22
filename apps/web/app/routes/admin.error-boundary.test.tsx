// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import AdminUpstreamsRoute, { ErrorBoundary, loader } from "./admin.upstreams";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin route error boundary", () => {
  it("shows the coded 403 when the admin account's role does not open the page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          admin: { id: "adm_1", email: "a@admin.test", name: "A", role: "platform_admin" },
          permissions: [],
          promptAccess: false,
        }),
      ),
    );
    const router = createMemoryRouter([{ path: "/admin/upstreams", loader, Component: AdminUpstreamsRoute, ErrorBoundary }], {
      initialEntries: ["/admin/upstreams"],
    });
    render(<RouterProvider router={router} />);
    expect((await screen.findByRole("alert")).textContent).toContain("GATEWAY_FORBIDDEN");
    expect(screen.getByRole("heading", { name: "You do not have access to this page" })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Upstream accounts" })).toBeNull();
  });
});
