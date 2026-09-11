// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => [] as string[]);
vi.mock("@clash/web-ui/components/ProjectEditor", () => ({
  default: function Editor({ project }: { project: { id: string } }) {
    // Represents an editor's mount-owned replica, undo stack and connection.
    useEffect(() => {
      lifecycle.push(`open:${project.id}`);
      return () => { lifecycle.push(`close:${project.id}`); };
    }, []);
    return <span>{project.id}</span>;
  },
}));
vi.mock("../root", () => ({ ErrorBoundary: () => null }));

import ProjectRoute from "./project.$id";

afterEach(() => { cleanup(); lifecycle.length = 0; });

it("releases the previous editor when changing projects and preserves it for same-project navigation", async () => {
  const router = createMemoryRouter([{
    path: "/projects/:id",
    loader: ({ params }) => ({ project: { id: params.id } }),
    Component: ProjectRoute,
    HydrateFallback: () => null,
  }], { initialEntries: ["/projects/first"] });
  const mounted = render(<RouterProvider router={router} />);
  try {
    await waitFor(() => expect(lifecycle).toEqual(["open:first"]));
    await act(async () => { await router.navigate("/projects/first?thread=selected"); });
    expect(lifecycle).toEqual(["open:first"]);
    await act(async () => { await router.navigate("/projects/second"); });
    expect(lifecycle).toEqual(["open:first", "close:first", "open:second"]);
    mounted.unmount();
    expect(lifecycle).toEqual(["open:first", "close:first", "open:second", "close:second"]);
  } finally { mounted.unmount(); router.dispose(); }
});
