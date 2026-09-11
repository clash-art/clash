// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAsset } from "@clash/shared-types";
import { PROJECT_ASSET_DRAG_MIME } from "../lib/projectAssetDrag";
import ProjectWorkspaceNavigator from "./ProjectWorkspaceNavigator";

afterEach(cleanup);

function resolvedAsset(
  input: Pick<ResolvedAsset, "id" | "kind"> & Partial<ResolvedAsset>,
): ResolvedAsset {
  return {
    status: "ready",
    metadata: {},
    lifecycle: { state: "active" },
    ...input,
  };
}

describe("ProjectWorkspaceNavigator", () => {
  it("shows open browser pages as selectable project sidebar tabs", () => {
    const onSelectBrowser = vi.fn();
    const browserProps = {
      browsers: [
        {
          id: "browser-1",
          title: "Clash docs",
          url: "https://clash.example/docs",
        },
      ],
      onSelectBrowser,
      onCreateBrowser: vi.fn(),
      onCloseBrowser: vi.fn(),
    };

    render(
      <ProjectWorkspaceNavigator
        {...browserProps}
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[]}
        assets={[]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Browsers" })).toBeTruthy();
    const browserTab = screen.getByRole("tab", { name: "Clash docs" });
    fireEvent.click(browserTab);
    expect(onSelectBrowser).toHaveBeenCalledWith("browser-1");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const search = screen.getByRole("combobox", { name: "Search project" });
    fireEvent.change(search, { target: { value: "Clash docs" } });
    expect(
      screen.getByRole("option", { name: "Clash docs Browser" }),
    ).toBeTruthy();
  });

  it("lists Canvas text nodes in Assets and selects their first-class workspace page", () => {
    const textAsset = {
      id: "text-script",
      canvasId: "main",
      label: "短剧剧本｜迟到的婚礼",
    };
    const onSelectTextAsset = vi.fn();

    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[]}
        assets={[]}
        textAssets={[textAsset]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onSelectTextAsset={onSelectTextAsset}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    expect(screen.getByRole("list", { name: "Project assets" })).toBeTruthy();
    const row = screen.getByRole("tab", { name: textAsset.label });
    expect(
      row.querySelector('[data-project-text-asset-icon="true"]'),
    ).toBeTruthy();
    fireEvent.click(row);
    expect(onSelectTextAsset).toHaveBeenCalledWith(textAsset);
  });

  it("marks an open Text asset as the active project surface", () => {
    const textAsset = {
      id: "text-script",
      canvasId: "main",
      label: "Short film script",
    };

    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[]}
        assets={[]}
        textAssets={[textAsset]}
        surface={{
          kind: "text-asset",
          nodeId: textAsset.id,
          canvasId: textAsset.canvasId,
        }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onSelectTextAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    const row = screen.getByRole("tab", { name: textAsset.label });
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.className).toContain("bg-brand/[0.09]");
  });

  it("keeps the project search control on the semantic surface in dark mode", () => {
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[]}
        assets={[]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    const search = screen.getByRole("button", { name: "Search project" });
    expect(search.className).toContain("bg-warm-surface");
    expect(search.className).not.toContain("bg-white");
  });

  it("keeps folder add controls readable through dark hover states", () => {
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[]}
        assets={[]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    for (const name of ["New Canvas", "New Timeline", "Add Asset"]) {
      const add = screen.getByRole("button", { name });
      expect(add.className).toContain("text-content-muted");
      expect(add.className).toContain("hover:bg-warm-hover");
      expect(add.className).toContain("hover:text-content-primary");
    }

    const canvasFolder = screen.getByRole("button", { name: "Canvases" });
    expect(canvasFolder.className).toContain("hover:bg-warm-hover");
    expect(canvasFolder.className).not.toContain("hover:bg-black");

    const rowActions = screen.getByRole("button", {
      name: "Canvas actions for Main",
    });
    expect(rowActions.className).toContain("text-content-muted");
    expect(rowActions.className).toContain("hover:bg-warm-hover");
    expect(rowActions.className).toContain("hover:text-content-primary");
  });

  it("keeps destructive Timeline cleanup in the row action menu", async () => {
    const timeline = {
      id: "timeline-proof",
      name: "Temporary proof",
      owner: { kind: "project" as const },
      revisionId: "timeline-revision-v1:proof",
      state: { tracks: [] },
    };
    const onDeleteTimeline = vi.fn();
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[timeline]}
        assets={[]}
        surface={{ kind: "timeline", timelineId: timeline.id }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onDeleteTimeline={onDeleteTimeline}
        onAddAsset={vi.fn()}
      />,
    );

    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Timeline actions for Temporary proof",
      }),
      { button: 0, ctrlKey: false },
    );
    const deleteItem = await screen.findByRole("menuitem", { name: "Delete" });
    fireEvent.click(deleteItem);
    expect(onDeleteTimeline).toHaveBeenCalledWith(timeline);
  });

  it("shows the earliest visual Timeline item as its sidebar first-frame preview", () => {
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[
          {
            id: "timeline-preview",
            name: "Opening cut",
            owner: { kind: "project" },
            revisionId: "timeline-revision-v1:preview",
            state: {
              tracks: [
                {
                  id: "audio",
                  items: [
                    { id: "voice", type: "audio", assetId: "voice", from: 0 },
                  ],
                },
                {
                  id: "video",
                  items: [
                    {
                      id: "later-shot",
                      type: "video",
                      assetId: "later-video",
                      from: 30,
                    },
                    {
                      id: "opening-shot",
                      type: "image",
                      assetId: "opening-image",
                      from: 0,
                    },
                  ],
                },
              ],
            },
          },
        ]}
        assets={[
          resolvedAsset({
            id: "voice",
            kind: "audio",
            url: "/voice.wav",
          }),
          resolvedAsset({
            id: "later-video",
            kind: "video",
            url: "/later.mp4",
            thumbnailUrl: "/later-frame.webp",
          }),
          resolvedAsset({
            id: "opening-image",
            kind: "image",
            url: "/opening-frame.webp",
          }),
        ]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole("img", { name: "Opening cut first frame" })
        .getAttribute("src"),
    ).toBe("/opening-frame.webp");
  });

  it("falls back to the Timeline icon when its first-frame preview fails", () => {
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[
          {
            id: "timeline-broken-preview",
            name: "Broken preview",
            owner: { kind: "project" },
            revisionId: "timeline-revision-v1:broken-preview",
            state: {
              tracks: [
                {
                  id: "video",
                  items: [
                    {
                      id: "opening-shot",
                      type: "video",
                      assetId: "opening-video",
                      from: 0,
                    },
                  ],
                },
              ],
            },
          },
        ]}
        assets={[
          resolvedAsset({
            id: "opening-video",
            kind: "video",
            url: "/opening.mp4",
            thumbnailUrl: "/broken-frame.webp",
          }),
        ]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    fireEvent.error(
      screen.getByRole("img", { name: "Broken preview first frame" }),
    );

    expect(
      screen
        .getByRole("tab", { name: "Broken preview" })
        .querySelector('[data-project-timeline-fallback-icon="true"]'),
    ).toBeTruthy();
  });

  it("lists independently owned Director Stages as first-class Project surfaces", () => {
    const onSelectDirectorStage = vi.fn();
    const onCreateDirectorStage = vi.fn();
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[]}
        directorStages={[
          {
            id: "stage-opening",
            name: "Opening blocking",
            owner: { kind: "project" },
            revisionId: "revision-1",
            state: {
              schemaVersion: 1,
              scene: {
                backgroundColor: "#101114",
                grid: { visible: true, snap: false, size: 1 },
              },
              objects: [],
              cameras: [],
              shots: [],
            },
          },
        ]}
        assets={[]}
        surface={{ kind: "director-stage", stageId: "stage-opening" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectDirectorStage={onSelectDirectorStage}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onCreateDirectorStage={onCreateDirectorStage}
        onAddAsset={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole("tab", { name: "Opening blocking" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "New Director Stage" }));
    expect(onCreateDirectorStage).toHaveBeenCalledOnce();
  });

  it("uses business names and cover thumbnails instead of storage keys", () => {
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[]}
        assets={[
          resolvedAsset({
            id: "image-hero",
            kind: "image",
            url: "/hero-source.png",
            thumbnailUrl: "/hero-cover.webp",
            name: "Opening frame",
          }),
        ]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("tab", { name: "Opening frame" }).getAttribute("title"),
    ).toBe("Opening frame");
    expect(
      screen
        .getByRole("img", { name: "Opening frame thumbnail" })
        .getAttribute("src"),
    ).toBe("/hero-cover.webp");
    expect(screen.queryByText("local-gen-abcd1234.png")).toBeNull();
  });

  it("shows Host-projected thumbnails without decoding video playback bytes", () => {
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[]}
        assets={[
          resolvedAsset({
            id: "image-1",
            url: "/image.png",
            kind: "image",
            metadata: { originalName: "image.png" },
          }),
          resolvedAsset({
            id: "video-1",
            url: "/video.mp4",
            thumbnailUrl: "/video-poster.jpg",
            kind: "video",
            metadata: { originalName: "video.mp4" },
          }),
          resolvedAsset({
            id: "audio-1",
            url: "/audio.wav",
            kind: "audio",
            metadata: { originalName: "audio.wav" },
          }),
        ]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole("img", { name: "image.png thumbnail" })
        .getAttribute("src"),
    ).toBe("/image.png");
    expect(
      screen
        .getByRole("img", { name: "video.mp4 thumbnail" })
        .getAttribute("src"),
    ).toBe("/video-poster.jpg");
    expect(document.querySelector("video")).toBeNull();
    expect(
      screen.queryByRole("img", { name: "audio.wav thumbnail" }),
    ).toBeNull();
  });
  it("keeps only project Assets in the sidebar and offers global assets from the add menu", async () => {
    const onAddAssetToLibrary = vi.fn();
    const onAddGlobalAsset = vi.fn();
    const onAddAsset = vi.fn();
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[]}
        assets={[
          resolvedAsset({
            id: "project-asset",
            url: "/project.png",
            kind: "image",
            metadata: { originalName: "project.png" },
          }),
        ]}
        globalAssets={[
          resolvedAsset({
            id: "global-asset",
            url: "/global.png",
            kind: "image",
            metadata: { originalName: "global.png" },
          }),
        ]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={onAddAsset}
        onAddGlobalAsset={onAddGlobalAsset}
        onAddAssetToLibrary={onAddAssetToLibrary}
      />,
    );

    expect(screen.getByRole("list", { name: "Project assets" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Global Assets" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Global assets" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "global.png" })).toBeNull();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add Asset" }), {
      button: 0,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload from Mac" }));
    expect(onAddAsset).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add Asset" }), {
      button: 0,
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Add from Global Assets" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Add from Global Assets" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add global.png" }));
    expect(onAddGlobalAsset).toHaveBeenCalledWith("global-asset");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Add from Global Assets" }),
      ).toBeNull();
    });

    expect(
      screen.queryByRole("button", {
        name: "Add project.png to global assets",
      }),
    ).toBeNull();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More options for project.png" }),
      { button: 0 },
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Add to Global Assets" }),
    );
    expect(onAddAssetToLibrary).toHaveBeenCalledWith("project-asset");
  });

  it("does not conflate equal Project and Global ids in add actions", async () => {
    const onAddAssetToLibrary = vi.fn();
    const onAddGlobalAsset = vi.fn();
    render(
      <MemoryRouter>
        <ProjectWorkspaceNavigator
          canvases={[{ id: "main", name: "Main", position: 0 }]}
          timelines={[]}
          assets={[
            resolvedAsset({
              id: "same-id",
              name: "Project still",
              url: "/project-still.png",
              kind: "image",
            }),
          ]}
          globalAssets={[
            resolvedAsset({
              id: "same-id",
              name: "Global still",
              url: "/global-still.png",
              kind: "image",
            }),
          ]}
          surface={{ kind: "canvas", canvasId: "main" }}
          onSelectCanvas={vi.fn()}
          onSelectTimeline={vi.fn()}
          onSelectAsset={vi.fn()}
          onCreateCanvas={vi.fn()}
          onRenameCanvas={vi.fn()}
          onDeleteCanvas={vi.fn()}
          onCreateTimeline={vi.fn()}
          onAttachTimeline={vi.fn()}
          onAddAsset={vi.fn()}
          onAddGlobalAsset={onAddGlobalAsset}
          onAddAssetToLibrary={onAddAssetToLibrary}
        />
      </MemoryRouter>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add Asset" }), {
      button: 0,
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Add from Global Assets" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Global still" }));
    expect(onAddGlobalAsset).toHaveBeenCalledWith("same-id");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Add from Global Assets" }),
      ).toBeNull();
    });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More options for Project still" }),
      { button: 0 },
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Add to Global Assets" }),
    );
    expect(onAddAssetToLibrary).toHaveBeenCalledWith("same-id");
  });

  it("renders full sidebar content in a neutral container owned by an external sidebar shell", () => {
    const { container } = render(
      <ProjectWorkspaceNavigator
        canvases={[
          { id: "main", name: "Main", position: 0 },
          { id: "shots", name: "Shots", position: 1 },
        ]}
        timelines={[]}
        assets={[]}
        header={<span>Project header</span>}
        footer={<button type="button">Project settings</button>}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    expect(screen.queryByRole("complementary")).toBeNull();
    expect(container.querySelector("aside")).toBeNull();
    expect(container.querySelector("[data-collapsed]")).toBeNull();

    expect(screen.getByText("Project header")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search project" })).toBeTruthy();
    expect(screen.getByText("⌘K")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Canvases" })).toBeTruthy();
    expect(screen.getByText("Main")).toBeTruthy();
    expect(screen.getByText("Shots")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Project settings" }),
    ).toBeTruthy();
    expect(document.querySelector(".sr-only")).toBeNull();
  });

  it("exposes concrete Canvas, Timeline editor documents, and Asset surfaces", () => {
    const onSelectCanvas = vi.fn();
    const onSelectTimeline = vi.fn();
    const onSelectAsset = vi.fn();
    render(
      <ProjectWorkspaceNavigator
        canvases={[
          { id: "main", name: "Main", position: 0 },
          { id: "shots", name: "Shots", position: 1 },
        ]}
        timelines={[
          {
            id: "timeline-1",
            name: "Episode 1",
            owner: { kind: "project" },
            revisionId: "timeline-revision-v1:test",
            state: { tracks: [] },
          },
          {
            id: "timeline-2",
            name: "Trailer Cut",
            owner: {
              kind: "canvas-action",
              canvasId: "main",
              actionNodeId: "timeline-action-2",
            },
            revisionId: "timeline-revision-v1:attached",
            state: { tracks: [] },
          },
        ]}
        assets={[
          resolvedAsset({
            id: "asset-1",
            url: "/asset-1.png",
            kind: "image",
            metadata: { originalName: "asset-1.png" },
          }),
        ]}
        footer={<button type="button">Project settings</button>}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={onSelectCanvas}
        onSelectTimeline={onSelectTimeline}
        onSelectAsset={onSelectAsset}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("tablist", { name: "Project surfaces" }),
    ).toBeTruthy();
    const mainTab = screen.getByRole("tab", { name: "Main" });
    expect(mainTab.getAttribute("aria-selected")).toBe("true");
    expect(mainTab.className).toContain("w-full");
    expect(mainTab.className).not.toContain("flex-1");
    expect(
      screen.getByRole("button", { name: "Canvas actions for Main" }).className,
    ).toContain("absolute");
    expect(screen.queryByRole("heading", { name: "Library" })).toBeNull();
    const projectControls = screen.getByRole("group", {
      name: "Project controls",
    });
    expect(
      projectControls.contains(
        screen.getByRole("button", { name: "Project settings" }),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "Shots" }));
    fireEvent.click(screen.getByRole("tab", { name: "Episode 1" }));
    fireEvent.click(screen.getByRole("tab", { name: "Trailer Cut" }));
    fireEvent.click(screen.getByRole("tab", { name: "asset-1.png" }));

    expect(onSelectCanvas).toHaveBeenCalledWith("shots");
    expect(onSelectTimeline).toHaveBeenCalledWith("timeline-1");
    expect(onSelectTimeline).toHaveBeenCalledWith("timeline-2");
    expect(onSelectAsset).toHaveBeenCalledWith("asset-1");
  });

  it("uses the same collapsible folder contract for Canvases, Timelines, and Assets", async () => {
    const onCreateCanvas = vi.fn();
    const onCreateTimeline = vi.fn();
    const onAddAsset = vi.fn();
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[
          {
            id: "timeline-1",
            name: "Episode 1",
            owner: { kind: "project" },
            revisionId: "timeline-revision-v1:test",
            state: { tracks: [] },
          },
        ]}
        assets={[
          resolvedAsset({
            id: "asset-1",
            url: "/asset-1.png",
            kind: "image",
            metadata: { originalName: "asset-1.png" },
          }),
        ]}
        surface={{ kind: "asset", assetId: "asset-1" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={onCreateCanvas}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={onCreateTimeline}
        onAttachTimeline={vi.fn()}
        onAddAsset={onAddAsset}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Library" })).toBeNull();
    const folders = ["Canvases", "Timelines", "Assets"].map((name) =>
      screen.getByRole("button", { name }),
    );
    expect(
      folders.map((folder) => folder.getAttribute("aria-expanded")),
    ).toEqual(["true", "true", "true"]);
    expect(new Set(folders.map((folder) => folder.className)).size).toBe(1);
    expect(
      folders.every((folder) => folder.className.includes("justify-start")),
    ).toBe(true);
    expect(
      new Set(
        folders.map(
          (folder) => folder.closest("[data-project-folder-header]")?.className,
        ),
      ).size,
    ).toBe(1);
    expect(
      screen.queryByText("1", {
        selector: '[data-sidebar-action-slot="asset-count"]',
      }),
    ).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "asset-1.png" })
        .getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "New Canvas" }));
    fireEvent.click(screen.getByRole("button", { name: "New Timeline" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add Asset" }), {
      button: 0,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload from Mac" }));
    expect(onCreateCanvas).toHaveBeenCalledOnce();
    expect(onCreateTimeline).toHaveBeenCalledOnce();
    expect(onAddAsset).toHaveBeenCalledOnce();
    expect(
      folders.map((folder) => folder.getAttribute("aria-expanded")),
    ).toEqual(["true", "true", "true"]);

    fireEvent.click(folders[0]);
    expect(folders[0].getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tab", { name: "Main" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Episode 1" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "asset-1.png" })).toBeTruthy();

    fireEvent.click(folders[1]);
    expect(folders[1].getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tab", { name: "Episode 1" })).toBeNull();
    expect(screen.getByRole("tab", { name: "asset-1.png" })).toBeTruthy();

    const scroller = screen.getByRole("tablist", { name: "Project surfaces" });
    const content = document.getElementById(
      folders[2].getAttribute("aria-controls")!,
    )!;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(content, "offsetHeight", {
      configurable: true,
      value: 900,
    });
    scroller.scrollTop = 200;
    fireEvent.click(folders[2]);
    expect(folders[2].getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tab", { name: "asset-1.png" })).toBeNull();
    expect(parseFloat(scroller.style.paddingBottom)).toBeGreaterThan(0);
    expect(scroller.scrollTop).toBe(200);
    const heldPadding = scroller.style.paddingBottom;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(scroller.style.paddingBottom).toBe(heldPadding);
    scroller.scrollTop = 250;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(200);
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    expect(parseFloat(scroller.style.paddingBottom)).toBeLessThan(parseFloat(heldPadding));
    scroller.scrollTop = 150;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(100);
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(scroller.style.paddingBottom).toBe("");
    scroller.scrollTop = 50;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(50);
  });

  it("lists every project asset beneath Assets and makes each item selectable and draggable", () => {
    const onSelectAsset = vi.fn();
    const assets = [
      resolvedAsset({
        id: "asset-image",
        url: "/hero-frame.png",
        kind: "image",
        metadata: { originalName: "hero-frame.png" },
      }),
      resolvedAsset({
        id: "asset-video",
        url: "/teaser.mp4",
        kind: "video",
        metadata: { originalName: "teaser.mp4" },
      }),
    ];
    const props = {
      canvases: [{ id: "main", name: "Main", position: 0 }],
      timelines: [],
      assets,
      surface: { kind: "canvas" as const, canvasId: "main" },
      onSelectCanvas: vi.fn(),
      onSelectTimeline: vi.fn(),
      onSelectAsset,
      onCreateCanvas: vi.fn(),
      onRenameCanvas: vi.fn(),
      onDeleteCanvas: vi.fn(),
      onCreateTimeline: vi.fn(),
      onAttachTimeline: vi.fn(),
      onAddAsset: vi.fn(),
    };
    const { rerender } = render(<ProjectWorkspaceNavigator {...props} />);

    expect(screen.getByRole("list", { name: "Project assets" })).toBeTruthy();
    expect(screen.getByText("hero-frame.png")).toBeTruthy();
    expect(screen.getByText("teaser.mp4")).toBeTruthy();

    const teaser = screen.getByRole("tab", { name: "teaser.mp4" });
    expect(teaser.getAttribute("draggable")).toBe("true");
    fireEvent.click(teaser);
    expect(onSelectAsset).toHaveBeenCalledWith("asset-video");

    const dragData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      setData: vi.fn((type: string, value: string) =>
        dragData.set(type, value),
      ),
    };
    fireEvent.dragStart(teaser, { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(JSON.parse(dragData.get(PROJECT_ASSET_DRAG_MIME) ?? "{}")).toEqual({
      assetId: "asset-video",
    });
    expect(dragData.has("assetId")).toBe(false);
    expect(dragData.has("text/plain")).toBe(false);
    expect(dragData.has("asset")).toBe(false);

    rerender(<ProjectWorkspaceNavigator {...props} />);
    expect(screen.getByRole("list", { name: "Project assets" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "hero-frame.png" })).toBeTruthy();
  });

  it("separates Project Trash from device availability and exposes logical trash and restore actions", async () => {
    const onTrashAsset = vi.fn();
    const onRestoreAsset = vi.fn();
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[]}
        assets={[
          resolvedAsset({
            id: "remote-only",
            kind: "video",
            name: "remote.mp4",
            status: "unavailable",
          }),
          resolvedAsset({
            id: "trashed-image",
            kind: "image",
            name: "old.png",
            status: "unavailable",
            lifecycle: {
              state: "trashed",
              deleteOperationId: "delete-old",
              deletedAt: "2026-08-13T00:00:00.000Z",
              purgeAfter: "2026-09-12T00:00:00.000Z",
            },
          }),
        ]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
        onTrashAsset={onTrashAsset}
        onRestoreAsset={onRestoreAsset}
      />,
    );

    expect(screen.getByRole("tab", { name: "remote.mp4" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "old.png" })).toBeNull();
    expect(
      screen.getByRole("list", { name: "Project asset trash" }),
    ).toBeTruthy();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More options for remote.mp4" }),
      { button: 0 },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    expect(onTrashAsset).toHaveBeenCalledWith("remote-only");

    fireEvent.click(screen.getByRole("button", { name: "Restore old.png" }));
    expect(onRestoreAsset).toHaveBeenCalledWith("trashed-image");
  });

  it("keeps an empty Timeline section quiet instead of spending space on a redundant message", () => {
    render(
      <ProjectWorkspaceNavigator
        canvases={[{ id: "main", name: "Main", position: 0 }]}
        timelines={[]}
        assets={[]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={vi.fn()}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Timelines" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New Timeline" })).toBeTruthy();
    expect(screen.queryByText("No standalone timelines")).toBeNull();
  });

  it("opens project navigation from a Cmd-K command palette without filtering the sidebar itself", () => {
    const onSelectCanvas = vi.fn();
    render(
      <ProjectWorkspaceNavigator
        canvases={[
          { id: "main", name: "Main", position: 0 },
          { id: "shots", name: "Shots", position: 1 },
        ]}
        timelines={[
          {
            id: "timeline-1",
            name: "Episode 1",
            owner: { kind: "project" },
            revisionId: "timeline-revision-v1:test",
            state: { tracks: [] },
          },
        ]}
        assets={[]}
        surface={{ kind: "canvas", canvasId: "main" }}
        onSelectCanvas={onSelectCanvas}
        onSelectTimeline={vi.fn()}
        onSelectAsset={vi.fn()}
        onCreateCanvas={vi.fn()}
        onRenameCanvas={vi.fn()}
        onDeleteCanvas={vi.fn()}
        onCreateTimeline={vi.fn()}
        onAttachTimeline={vi.fn()}
        onAddAsset={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Search project" });
    expect(trigger.className).toContain(
      "h-[var(--clash-project-control-rhythm,2rem)]",
    );
    expect(screen.getByText("⌘K")).toBeTruthy();
    expect(
      screen.queryByRole("combobox", { name: "Search project" }),
    ).toBeNull();

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const search = screen.getByRole("combobox", { name: "Search project" });
    fireEvent.change(search, { target: { value: "shots" } });

    expect(document.getElementById("project-canvas-main")).toBeTruthy();
    expect(document.getElementById("project-timeline-timeline-1")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Shots Canvas" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Main Canvas" })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: "Shots Canvas" }));
    expect(onSelectCanvas).toHaveBeenCalledWith("shots");
    expect(
      screen.queryByRole("combobox", { name: "Search project" }),
    ).toBeNull();
  });
});
