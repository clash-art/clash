// @vitest-environment jsdom
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
} from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveProject } from "@clash/web-ui/lib/clientActions";
import type { ResolvedAsset } from "@clash/shared-types";

import { ConfirmDialogProvider } from "./ConfirmDialog";
import ProjectCard from "./ProjectCard";
import type { ProjectReference } from "./dashboardComposerReferences";

vi.mock("@clash/web-ui/lib/clientActions", () => ({
  archiveProject: vi.fn(),
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => (
      <>{children}</>
    ),
    motion: new Proxy(
      {},
      {
        get:
          (_target, tag: string) =>
          ({
            children,
            whileHover: _whileHover,
            whileTap: _whileTap,
            transition: _transition,
            ...props
          }: {
            children?: ReactNode;
            [key: string]: unknown;
          }) =>
            React.createElement(tag, props, children),
      },
    ),
  };
});

function DragHarness({
  children,
  onDragStart,
}: {
  children: ReactNode;
  onDragStart?: (event: DragStartEvent) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  return (
    <DndContext sensors={sensors} onDragStart={onDragStart}>
      {children}
    </DndContext>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current location">{location.pathname}</output>;
}

describe("ProjectCard", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(archiveProject).mockClear();
    globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
  });

  function renderCard(
    projectOverrides: Record<string, unknown> = {},
    referenceProps: {
      composerProjectReferenceId?: string | null;
      onAddProjectReference?: (project: ProjectReference) => void;
    } = {},
    onDragStart?: (event: DragStartEvent) => void,
  ) {
    return render(
      <MemoryRouter>
        <ConfirmDialogProvider>
          <DragHarness onDragStart={onDragStart}>
            <ProjectCard
              project={{
                id: "project-1",
                name: "Storyboard draft",
                createdAt: "2026-06-03T00:00:00.000Z",
                updatedAt: "2026-06-03T00:00:00.000Z",
                assets: [],
                ...projectOverrides,
              }}
              {...referenceProps}
            />
          </DragHarness>
          <LocationProbe />
        </ConfirmDialogProvider>
      </MemoryRouter>,
    );
  }

  it("keeps Desktop project navigation in its application tab",()=>{
    globalThis.__CLASH_RUNTIME_CONFIG__={mode:"desktop"};
    renderCard();
    const link=screen.getByRole("link",{name:/storyboard draft/i});
    expect(link.getAttribute("target")).toBeNull();
    fireEvent.click(link);
    expect(screen.getByLabelText("Current location").textContent).toBe("/projects/project-1");
  });

  function visualAsset(id: string, createdAt: number): ResolvedAsset {
    return {
      id,
      kind: "image",
      url: `https://media.clash.test/assets/${id}`,
      createdAt,
      metadata: {},
      lifecycle: { state: "active" },
      status: "ready",
    };
  }

  it("keeps archive controls outside the project link", () => {
    renderCard();

    const link = screen.getByRole("link", { name: /storyboard draft/i });
    const archiveButton = screen.getByRole("button", {
      name: /archive project storyboard draft/i,
    });

    expect(link.contains(archiveButton)).toBe(false);
  });

  it("keeps preview actions legible over visual media", () => {
    renderCard({}, { onAddProjectReference: vi.fn() });

    const addButton = screen.getByRole("button", {
      name: "Add project Storyboard draft to composer",
    });
    const archiveButton = screen.getByRole("button", {
      name: "Archive project Storyboard draft",
    });

    expect(addButton).toHaveClass("clash-project-card-action");
    expect(archiveButton).toHaveClass("clash-project-card-action");
  });

  it("adds only the stable project reference and keeps its control outside the link", () => {
    const onAddProjectReference = vi.fn();
    renderCard({}, { onAddProjectReference });

    const link = screen.getByRole("link", { name: /storyboard draft/i });
    const addButton = screen.getByRole("button", {
      name: "Add project Storyboard draft to composer",
    });

    fireEvent.click(addButton);
    expect(onAddProjectReference).toHaveBeenCalledWith({
      id: "project-1",
      name: "Storyboard draft",
    });
    expect(link.contains(addButton)).toBe(false);
    expect(
      screen.queryByRole("button", {
        name: "Drag project Storyboard draft to composer",
      }),
    ).toBeNull();
  });

  it("keeps normal project navigation and delete outside pointer dragging", () => {
    const onDragStart = vi.fn();
    renderCard({}, { onAddProjectReference: vi.fn() }, onDragStart);

    const projectLink=screen.getByRole("link", {name:/storyboard draft/i});
    expect(projectLink.getAttribute("target")).toBe("_blank");
    expect(projectLink.getAttribute("rel")).toContain("noopener");
    expect(onDragStart).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: /archive project storyboard draft/i,
      }),
    );
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it("locks other project reference controls without disabling navigation or archive", () => {
    const onDragStart = vi.fn();
    renderCard(
      {},
      {
        composerProjectReferenceId: "project-2",
        onAddProjectReference: vi.fn(),
      },
      onDragStart,
    );

    expect(
      screen.getByRole("button", {
        name: "Add project Storyboard draft to composer",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("link", { name: /storyboard draft/i }),
    ).not.toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("button", {
        name: /archive project storyboard draft/i,
      }),
    ).not.toBeDisabled();

    const preview = screen
      .getByRole("link", { name: /storyboard draft/i })
      .querySelector<HTMLElement>(".clash-project-card-frame");
    if (!preview) throw new Error("Missing project preview");
    fireEvent.pointerDown(preview, {
      button: 0,
      pointerId: 2,
      clientX: 10,
      clientY: 10,
      isPrimary: true,
    });
    fireEvent.pointerMove(document, {
      pointerId: 2,
      clientX: 30,
      clientY: 10,
      isPrimary: true,
    });
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it("keeps the preview automatic when a legacy cover id is present", () => {
    const { container } = renderCard({
      coverAssetId: "video-cover",
      assets: [
        {
          id: "newer-but-not-cover",
          kind: "image",
          url: "https://media.clash.test/assets/newer",
          metadata: {},
          lifecycle: { state: "active" },
          status: "ready",
        },
        {
          id: "video-cover",
          kind: "video",
          url: "https://media.clash.test/assets/video-cover",
          thumbnailUrl: "https://media.clash.test/thumbnails/video-cover",
          metadata: {},
          lifecycle: { state: "active" },
          status: "ready",
        },
      ],
      canvasPreview: {
        canvasId: "main",
        bounds: { x: 0, y: 0, width: 800, height: 450 },
        nodes: [
          {
            id: "newer-node",
            type: "image",
            x: 0,
            y: 0,
            width: 500,
            height: 280,
            assetId: "newer-but-not-cover",
          },
          {
            id: "video-node",
            type: "video",
            x: 520,
            y: 180,
            width: 280,
            height: 270,
            assetId: "video-cover",
          },
        ],
      },
    });

    const images = Array.from(
      container.querySelectorAll<SVGImageElement>(
        ".clash-project-card-preview-img",
      ),
    );

    expect(images).toHaveLength(2);
    expect(images.map((image) => image.getAttribute("href"))).toEqual([
      "https://media.clash.test/assets/newer",
      "https://media.clash.test/thumbnails/video-cover",
    ]);
    expect(images.every((image) => image.closest("svg") !== null)).toBe(true);
  });

  it("previews an available visual Project Asset when no cover is selected", () => {
    const { container } = renderCard({
      assets: [
        {
          id: "available-image",
          kind: "image",
          url: "https://media.clash.test/assets/available-image",
          metadata: {},
          lifecycle: { state: "active" },
          status: "ready",
        },
      ],
      canvasPreview: {
        canvasId: "main",
        bounds: { x: 40, y: 80, width: 640, height: 360 },
        nodes: [
          {
            id: "available-node",
            type: "image",
            x: 40,
            y: 80,
            width: 640,
            height: 360,
            assetId: "available-image",
          },
        ],
      },
    });

    expect(
      container
        .querySelector<SVGImageElement>(".clash-project-card-preview-img")
        ?.getAttribute("href"),
    ).toBe("https://media.clash.test/assets/available-image");
    expect(
      container.querySelector('[data-slot="project-empty-copy"]'),
    ).toBeNull();
  });

  it("previews at most the four most recently produced visual assets", () => {
    const { container } = renderCard({
      assets: [
        visualAsset("oldest", 100),
        visualAsset("newest", 500),
        visualAsset("middle", 300),
        visualAsset("second-newest", 400),
        visualAsset("second-oldest", 200),
      ],
      canvasPreview: {
        canvasId: "main",
        bounds: { x: 0, y: 0, width: 1000, height: 700 },
        nodes: [
          {
            id: "newest-node",
            type: "image",
            x: 0,
            y: 0,
            width: 300,
            height: 200,
            assetId: "newest",
          },
          {
            id: "second-newest-node",
            type: "image",
            x: 350,
            y: 0,
            width: 300,
            height: 200,
            assetId: "second-newest",
          },
          {
            id: "middle-node",
            type: "image",
            x: 0,
            y: 250,
            width: 300,
            height: 200,
            assetId: "middle",
          },
          {
            id: "second-oldest-node",
            type: "image",
            x: 350,
            y: 250,
            width: 300,
            height: 200,
            assetId: "second-oldest",
          },
          {
            id: "oldest-node",
            type: "image",
            x: 700,
            y: 500,
            width: 300,
            height: 200,
            assetId: "oldest",
          },
        ],
      },
    });

    const sources = Array.from(
      container.querySelectorAll<SVGImageElement>(
        ".clash-project-card-preview-img",
      ),
      (image) => image.getAttribute("href"),
    );
    expect(sources).toEqual([
      "https://media.clash.test/assets/newest",
      "https://media.clash.test/assets/second-newest",
      "https://media.clash.test/assets/middle",
      "https://media.clash.test/assets/second-oldest",
    ]);
  });

  it("renders the actual Main canvas geometry instead of rearranging recent assets", () => {
    const { container } = renderCard({
      assets: [
        {
          ...visualAsset("landscape", 400),
          metadata: { width: 1600, height: 900 },
        },
        {
          ...visualAsset("portrait", 300),
          metadata: { width: 900, height: 1600 },
        },
      ],
      canvasPreview: {
        canvasId: "main",
        bounds: { x: -100, y: 50, width: 600, height: 400 },
        nodes: [
          {
            id: "main-image",
            type: "image",
            x: 100,
            y: 200,
            width: 400,
            height: 225,
            assetId: "landscape",
            label: "Hero",
          },
          {
            id: "main-note",
            type: "text",
            x: -100,
            y: 50,
            width: 300,
            height: 400,
            label: "Outline",
          },
        ],
      },
    });

    const preview = container.querySelector<SVGElement>(
      ".clash-project-canvas-preview",
    );
    const imageNode = preview?.querySelector<SVGElement>(
      '[data-canvas-node-id="main-image"]',
    );
    const noteNode = preview?.querySelector<SVGElement>(
      '[data-canvas-node-id="main-note"]',
    );

    expect(preview).toHaveAttribute("data-canvas-id", "main");
    expect(imageNode).toHaveAttribute("transform", "translate(100 200)");
    expect(imageNode?.querySelector("rect")).toHaveAttribute("width", "400");
    expect(imageNode?.querySelector("rect")).toHaveAttribute("height", "225");
    expect(noteNode).toHaveAttribute("transform", "translate(-100 50)");
    expect(
      container.querySelector(".clash-project-card-preview-panel"),
    ).toBeNull();
  });

  it("loads one derived Main snapshot instead of every canvas media node", () => {
    const { container } = renderCard({
      assets: [visualAsset("first", 200), visualAsset("second", 100)],
      canvasThumbnail: {
        url: "http://127.0.0.1:61631/api/v1/projects/project-1/canvas/thumbnail?revision=abc",
        revision: "abc",
        width: 640,
        height: 360,
      },
      canvasPreview: {
        canvasId: "main",
        bounds: { x: 0, y: 0, width: 800, height: 450 },
        nodes: [
          {
            id: "first-node",
            type: "image",
            x: 0,
            y: 0,
            width: 400,
            height: 225,
            assetId: "first",
          },
          {
            id: "second-node",
            type: "image",
            x: 400,
            y: 225,
            width: 400,
            height: 225,
            assetId: "second",
          },
        ],
      },
    });

    const snapshot = container.querySelector<HTMLImageElement>(
      ".clash-project-card-canvas-thumbnail",
    );
    expect(snapshot?.src).toBe(
      "http://127.0.0.1:61631/api/v1/projects/project-1/canvas/thumbnail?revision=abc",
    );
    expect(
      container.querySelectorAll(".clash-project-card-preview-img"),
    ).toHaveLength(0);
    expect(
      container.querySelector(".clash-project-canvas-preview"),
    ).not.toBeNull();

    fireEvent.error(snapshot!);
    expect(snapshot).toHaveAttribute("data-state", "failed");
  });

  it("distinguishes canvas tools and unloaded media from document nodes", () => {
    const { container } = renderCard({
      canvasPreview: {
        canvasId: "main",
        bounds: { x: 0, y: 0, width: 1_200, height: 800 },
        nodes: [
          {
            id: "generated-image",
            type: "image",
            x: 0,
            y: 0,
            width: 400,
            height: 225,
            assetId: "not-in-the-bounded-preview-set",
            label: "Generated image",
          },
          {
            id: "generate-action",
            type: "action-badge",
            x: 0,
            y: 280,
            width: 260,
            height: 58,
            label: "Generate image",
          },
          {
            id: "image-editor",
            type: "image-editor",
            x: 460,
            y: 0,
            width: 300,
            height: 300,
            label: "Image Editor",
          },
          {
            id: "timeline",
            type: "video-editor",
            x: 820,
            y: 0,
            width: 320,
            height: 220,
            label: "Timeline",
          },
          {
            id: "notes",
            type: "text",
            x: 460,
            y: 360,
            width: 300,
            height: 240,
            label: "Notes",
          },
        ],
      },
    });

    const previewState = (nodeId: string) =>
      container
        .querySelector(`[data-canvas-node-id="${nodeId}"]`)
        ?.getAttribute("data-canvas-node-preview");

    expect(previewState("generated-image")).toBe("media-placeholder");
    expect(previewState("generate-action")).toBe("action");
    expect(previewState("image-editor")).toBe("image-editor");
    expect(previewState("timeline")).toBe("timeline");
    expect(previewState("notes")).toBe("document");
    expect(
      container.querySelectorAll(".clash-project-canvas-preview-content-mark"),
    ).not.toHaveLength(0);
  });

  it("uses a quiet text-only empty state when no cover exists", () => {
    const { container } = renderCard();

    expect(
      container.querySelector('[data-slot="project-empty-artwork"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="project-empty-copy"]'),
    ).toHaveTextContent("Nothing to see. Yet.");
    expect(
      container.querySelector('[data-slot="project-placeholder-avatar"]'),
    ).toBeNull();
    expect(
      container.querySelector(".clash-project-card-empty-mark"),
    ).toBeNull();
  });

  it("does not rewrite a Host-projected preview against the runtime API origin", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      apiBaseUrl: "http://127.0.0.1:49321",
    };

    const { container } = renderCard({
      coverAssetId: "local-api-asset",
      assets: [
        {
          id: "local-api-asset",
          kind: "image",
          url: "https://media.clash.test/assets/local-api-asset",
          metadata: {},
          lifecycle: { state: "active" },
          status: "ready",
        },
      ],
      canvasPreview: {
        canvasId: "main",
        bounds: { x: 0, y: 0, width: 400, height: 225 },
        nodes: [
          {
            id: "local-api-node",
            type: "image",
            x: 0,
            y: 0,
            width: 400,
            height: 225,
            assetId: "local-api-asset",
          },
        ],
      },
    });

    const image = container.querySelector<SVGImageElement>(
      ".clash-project-card-preview-img",
    );

    expect(image?.getAttribute("href")).toBe(
      "https://media.clash.test/assets/local-api-asset",
    );
  });

  it("does not try to render audio assets as project-cover images", () => {
    const { container } = renderCard({
      coverAssetId: "voice",
      assets: [
        {
          id: "voice",
          kind: "audio",
          url: "https://media.clash.test/assets/voice",
          metadata: {},
          lifecycle: { state: "active" },
          status: "ready",
        },
        {
          id: "music",
          kind: "audio",
          url: "https://media.clash.test/assets/music",
          metadata: {},
          lifecycle: { state: "active" },
          status: "ready",
        },
      ],
    });

    expect(
      container.querySelectorAll(".clash-project-card-preview-img"),
    ).toHaveLength(0);
    expect(
      container.querySelector(".clash-project-card-preview-grid"),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="project-empty-copy"]'),
    ).toHaveTextContent("Nothing to see. Yet.");
  });

  it("archives projects through a recoverable confirmation", async () => {
    renderCard();

    fireEvent.click(
      screen.getByRole("button", {
        name: /archive project storyboard draft/i,
      }),
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("data-state")).toBe("open");
    expect(dialog.textContent).toContain("Archive project?");
    expect(dialog.textContent).toContain(
      "Storyboard draft will be hidden from the project browser.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(archiveProject).toHaveBeenCalledWith("project-1");
    });
  });

  it("drags the stable project reference from the whole preview after the pointer threshold", () => {
    const onDragStart = vi.fn();
    const { container } = renderCard(
      {},
      { onAddProjectReference: vi.fn() },
      onDragStart,
    );
    const preview = container.querySelector<HTMLElement>(
      ".clash-project-card-frame",
    );
    if (!preview) throw new Error("Missing project preview");
    expect(preview).toHaveAttribute("data-ui", "card");

    fireEvent.pointerDown(preview, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
      isPrimary: true,
    });
    fireEvent.pointerMove(document, {
      pointerId: 1,
      clientX: 16,
      clientY: 10,
      isPrimary: true,
    });
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.pointerMove(document, {
      pointerId: 1,
      clientX: 19,
      clientY: 10,
      isPrimary: true,
    });

    expect(onDragStart).toHaveBeenCalledOnce();
    expect(onDragStart.mock.calls[0]?.[0].active.data.current).toEqual({
      type: "dashboard-project-reference",
      reference: { id: "project-1", name: "Storyboard draft" },
    });
  });
});
