// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectBrowserSurfaces } from "./ProjectBrowserSurfaces";

afterEach(cleanup);

describe("ProjectBrowserSurfaces", () => {
  it("keeps every sidebar browser tab mounted while activating only the selected page", () => {
    const { container } = render(
      <ProjectBrowserSurfaces
        projectId="project-1"
        tabs={[
          { id: "browser-1", title: "One", url: "https://one.example" },
          { id: "browser-2", title: "Two", url: "https://two.example" },
        ]}
        activeBrowserId="browser-2"
        annotations={[]}
        activeAnnotationId={null}
        onTabChange={vi.fn()}
        onCreateAnnotation={vi.fn()}
        onSelectAnnotation={vi.fn()}
      />,
    );

    const slots = Array.from(
      container.querySelectorAll<HTMLElement>("[data-project-browser-slot]"),
    );
    expect(slots).toHaveLength(2);
    expect(slots.map((slot) => slot.dataset.active)).toEqual(["false", "true"]);
    expect(container.querySelectorAll("webview")).toHaveLength(2);
  });

  it("reserves the Director-style header inset for the collapsed agent launcher", () => {
    const props = {
      projectId: "project-1",
      tabs: [{ id: "browser-1", title: "One", url: "https://one.example" }],
      activeBrowserId: "browser-1",
      annotations: [],
      activeAnnotationId: null,
      onTabChange: vi.fn(),
      onCreateAnnotation: vi.fn(),
      onSelectAnnotation: vi.fn(),
      headerEndInset: 40,
    } as const;
    const { container } = render(<ProjectBrowserSurfaces {...props} />);

    expect(
      container.querySelector<HTMLElement>("[data-browser-toolbar]"),
    ).toHaveStyle({ paddingRight: "40px" });
  });
});

it("retains page state and event wiring when switching tabs or rerendering the workspace", () => {
  const props = {
    projectId: "project-1",
    tabs: [
      { id: "one", title: "One", url: "https://one.example" },
      { id: "two", title: "Two", url: "https://two.example" },
    ],
    activeBrowserId: "one",
    annotations: [],
    activeAnnotationId: null,
    onTabChange: vi.fn(),
    onCreateAnnotation: vi.fn(),
    onSelectAnnotation: vi.fn(),
  };
  const view = render(<ProjectBrowserSurfaces {...props} />);
  const pages = Array.from(view.container.querySelectorAll("webview"));
  const listen = pages.map((page) => vi.spyOn(page, "addEventListener"));
  const input = view.container.querySelector("input")!;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "unfinished address" } });
  view.rerender(<ProjectBrowserSurfaces {...props} activeBrowserId="two" />);
  expect(Array.from(view.container.querySelectorAll("webview"))).toEqual(pages);
  expect(input.value).toBe("unfinished address");
  for (const subscribe of listen) expect(subscribe).not.toHaveBeenCalled();
  fireEvent(
    pages[0],
    Object.assign(new Event("page-title-updated"), { title: "New title" }),
  );
  expect(props.onTabChange).toHaveBeenCalledWith("one", { title: "New title" });
});
