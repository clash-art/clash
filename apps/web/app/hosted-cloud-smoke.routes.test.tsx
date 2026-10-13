// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { RouterProvider, matchRoutes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./layouts/AppLayout", async () => {
  const { Outlet } = await import("react-router");
  return { default: () => <Outlet /> };
});

vi.mock("./layouts/appLayoutLoader", () => ({
  loader: async () => ({ isAuthenticated: true }),
}));

import { findRouteError, projectRoutePath } from "../e2e/hosted-cloud-routes";
import { router } from "./router";

afterEach(cleanup);

describe("hosted cloud smoke route contract", () => {
  it("visits a project path the app router matches", () => {
    const matches = matchRoutes(router.routes, projectRoutePath("project one"));

    expect(matches?.at(-1)?.params).toEqual({ id: "project one" });
  });

  it("detects the route error surface an unmatched path renders", async () => {
    // The singular path the smoke used to visit; the router has no such route.
    await router.navigate("/project/project-one");
    render(<RouterProvider router={router} />);

    await screen.findByRole("heading", { level: 1 });

    expect(findRouteError(document.body.textContent ?? "")).not.toBeNull();
  });

  it("does not flag a page without the route error surface", () => {
    expect(findRouteError("Projects\nNew project")).toBeNull();
  });
});
