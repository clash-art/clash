// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import HomePageClient from "./HomePageClient";

vi.mock("@clash/web-ui/lib/clientActions", () => ({
  createProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./RecentProjects", () => ({
  default: ({
    projects,
    loading,
  }: {
    projects: Array<{ id: string; name: string }>;
    loading?: boolean;
  }) => (
    <section aria-label="Recently viewed">
      {loading ? <p role="status">Loading projects…</p> : null}
      {projects.map((project) => (
        <a key={project.id} href={`/projects/${project.id}`}>
          {project.name}
        </a>
      ))}
    </section>
  ),
}));
vi.mock("./HomeOperations", () => ({ default: () => null }));
vi.mock("./HomeMarketplaceRecommendations", () => ({ default: () => null }));

afterEach(cleanup);

describe("HomePageClient project streaming", () => {
  it("renders the Dashboard while the project list is pending, then shows the projects", async () => {
    let resolve!: (projects: Array<{ id: string; name: string }>) => void;
    const pending = new Promise<Array<{ id: string; name: string }>>((done) => {
      resolve = done;
    });

    render(
      <MemoryRouter>
        <HomePageClient initialProjects={pending as never} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").textContent).toBe("Loading projects…");
    expect(screen.queryByRole("link")).toBeNull();

    await act(async () => {
      resolve([{ id: "p1", name: "Launch film" }]);
      await pending;
    });

    expect(await screen.findByRole("link", { name: "Launch film" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders an already-loaded list without a loading state", () => {
    render(
      <MemoryRouter>
        <HomePageClient initialProjects={[{ id: "p1", name: "Launch film" }] as never} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Launch film" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
