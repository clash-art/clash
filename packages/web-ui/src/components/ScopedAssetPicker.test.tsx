// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScopedAssetPicker } from "./ScopedAssetPicker";
import { mediaContentResult } from "../features/assets/content.test-fixtures";

describe("ScopedAssetPicker", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("finds media by Host analysis evidence even when its filename does not match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...mediaContentResult("video-3377", [{
      field: "content", attachmentId: "observed", document: { kind: "document", documentAssetId: "notes", revisionId: "notes-v1" }, documentKind: "media.observation", producer: { kind: "actor", actor: { kind: "agent" } }, sourceRefs: [], text: "Folding a shirt", location: { asset: { kind: "media", projectAssetId: "video-3377" }, startMs: 0, endMs: 2000 },
    }, {
      field: "content", attachmentId: "observed", document: { kind: "document", documentAssetId: "notes", revisionId: "notes-v1" }, documentKind: "media.observation", producer: { kind: "actor", actor: { kind: "agent" } }, sourceRefs: [], text: "A child folds a shirt",
    }]), truncated: true })));
    const onSelect = vi.fn();
    render(<ScopedAssetPicker projectId="project-1" open onClose={vi.fn()} onSelect={onSelect} onUpload={vi.fn()} sections={[{ scope: "project", label: "Project", description: "", assets: [{ assetId: "video-3377", name: "3377.mp4", type: "video", src: "/3377.mp4", status: "ready", source: { kind: "project", assetId: "video-3377" } }] }]} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search media" }), { target: { value: "shirt" } });
    expect(await screen.findByText("Search results are incomplete. Refine your search.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Add 3377.mp4" }));
    expect(screen.getByText("Folding a shirt")).toBeTruthy();
    expect(screen.getByText("00:00–00:02")).toBeTruthy();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ assetId: "video-3377" }));
  });

  it("renders scope groups and returns the selected source", () => {
    const onSelect = vi.fn();
    render(
      <ScopedAssetPicker
        open
        onClose={vi.fn()}
        onSelect={onSelect}
        onUpload={vi.fn()}
        sections={[
          {
            scope: "current-canvas",
            label: "Current Canvas",
            description: "Already here.",
            assets: [
              {
                assetId: "asset-1",
                sourceNodeId: "node-1",
                name: "Opening frame",
                type: "image",
                src: "/opening.png",
                thumbnail: "/opening-cover.webp",
                status: "ready",
                source: {
                  kind: "current-canvas",
                  assetId: "asset-1",
                  sourceNodeId: "node-1",
                  canvasId: "main",
                },
              },
            ],
          },
          {
            scope: "external",
            label: "More sources",
            description: "Global or local.",
            assets: [],
            allowLocalUpload: true,
          },
        ]}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Add media" })).toBeTruthy();
    expect(
      screen.getByRole("searchbox", { name: "Search media" }),
    ).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Scope" }));
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Current Canvas" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "More sources" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add Opening frame" }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: "asset-1", sourceNodeId: "node-1" }),
    );
    expect(
      screen.getByRole("button", { name: "Upload from Mac" }),
    ).toBeTruthy();
  });

  it("combines full-text media search with independent AND scope chips", () => {
    render(
      <ScopedAssetPicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onUpload={vi.fn()}
        sections={[
          {
            scope: "current-canvas",
            label: "Current Canvas",
            description: "Already here.",
            assets: [
              {
                assetId: "asset-frame",
                sourceNodeId: "node-frame",
                name: "Opening frame",
                type: "image",
                src: "/opening.png",
                status: "ready",
                source: {
                  kind: "current-canvas",
                  assetId: "asset-frame",
                  sourceNodeId: "node-frame",
                  canvasId: "main",
                },
              },
            ],
          },
          {
            scope: "project",
            label: "Project",
            description: "Project media.",
            assets: [
              {
                assetId: "asset-voice",
                name: "Voice over",
                type: "audio",
                src: "/voice.wav",
                status: "ready",
                source: { kind: "project", assetId: "asset-voice" },
              },
            ],
          },
        ]}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search media" }), {
      target: { value: "voice" },
    });
    expect(
      screen.queryByRole("button", { name: "Add Opening frame" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Add Voice over" })).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search media" }), {
      target: { value: "" },
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Scope" }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Current Canvas" }),
    );
    expect(
      screen.getByRole("button", { name: "Add Opening frame" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add Voice over" })).toBeNull();

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Project" }),
    );
    expect(
      screen.queryByRole("button", { name: "Add Opening frame" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Voice over" })).toBeNull();
    expect(screen.getByText("Scope · Current Canvas")).toBeTruthy();
    expect(screen.getByText("Scope · Project")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Scope filter: Current Canvas",
      }),
    );
    expect(screen.getByRole("button", { name: "Add Voice over" })).toBeTruthy();
  });

  it("updates the shared media filter and results region together", async () => {
    render(
      <ScopedAssetPicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onUpload={vi.fn()}
        sections={[
          {
            scope: "current-canvas",
            label: "Current Canvas",
            description: "Already here.",
            assets: [
              {
                assetId: "asset-frame",
                sourceNodeId: "node-frame",
                name: "Opening frame",
                type: "image",
                src: "/opening.png",
                status: "ready",
                source: {
                  kind: "current-canvas",
                  assetId: "asset-frame",
                  sourceNodeId: "node-frame",
                  canvasId: "main",
                },
              },
            ],
          },
          {
            scope: "project",
            label: "Project",
            description: "Project media.",
            assets: [
              {
                assetId: "asset-voice",
                name: "Voice over",
                type: "audio",
                src: "/voice.wav",
                status: "ready",
                source: { kind: "project", assetId: "asset-voice" },
              },
            ],
          },
        ]}
      />,
    );

    const results = screen.getByRole("region", { name: "Media results" });
    expect(
      within(results).getByRole("button", { name: "Add Opening frame" }),
    ).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Filter" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Scope" }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Current Canvas" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Scope · Current Canvas")).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Add Opening frame" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add Voice over" })).toBeNull();
  });

  it("renders search through the shared control contract", () => {
    render(
      <ScopedAssetPicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onUpload={vi.fn()}
        sections={[]}
      />,
    );

    expect(
      screen.getByRole("searchbox", { name: "Search media" }),
    ).toHaveAttribute("data-slot", "input");
  });

  it("uses the shared dialog search-filter toolbar", () => {
    render(
      <ScopedAssetPicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onUpload={vi.fn()}
        sections={[
          {
            scope: "project",
            label: "Project",
            description: "Project media.",
            assets: [],
          },
        ]}
      />,
    );

    const toolbar = document.querySelector(
      '[data-slot="search-filter-toolbar"][data-context="dialog"]',
    );
    expect(toolbar).toBeTruthy();
    expect(
      within(toolbar as HTMLElement).getByRole("button", { name: "Filter" }),
    ).toBeTruthy();
  });

  it("does not render private paths as visible or accessible copy", () => {
    render(
      <ScopedAssetPicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onUpload={vi.fn()}
        sections={[
          {
            scope: "project",
            label: "Project",
            description: "Project media.",
            assets: [
              {
                assetId: "asset-safe",
                name: "Image",
                type: "image",
                src: "/api/private/projects/secret.png",
                status: "ready",
                source: { kind: "project", assetId: "asset-safe" },
              },
            ],
          },
        ]}
      />,
    );
    expect(document.body.textContent).not.toContain("projects/secret.png");
    expect(screen.getByRole("button", { name: "Add Image" })).toBeTruthy();
  });

  it("shows Host availability and blocks a byte-dependent unavailable choice", () => {
    const onSelect = vi.fn();
    render(
      <ScopedAssetPicker
        open
        onClose={vi.fn()}
        onSelect={onSelect}
        onUpload={vi.fn()}
        sections={[
          {
            scope: "project",
            label: "Project",
            description: "Project media.",
            assets: [
              {
                assetId: "asset-offline",
                name: "Remote cut",
                type: "video",
                src: "",
                status: "downloading",
                progress: 0.42,
                disabledReason: "Downloading 42%",
                source: { kind: "project", assetId: "asset-offline" },
              },
            ],
          },
        ]}
      />,
    );

    const choice = screen.getByRole("button", { name: "Add Remote cut" });
    expect(choice).toBeDisabled();
    expect(screen.getByText("Downloading 42%")).toBeTruthy();
    expect(screen.getByText("0 selectable · 1 not ready")).toBeTruthy();
    fireEvent.click(choice);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps Project and Global entries distinct when their authority-local ids match", () => {
    render(
      <ScopedAssetPicker
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onUpload={vi.fn()}
        sections={[
          {
            scope: "project",
            label: "Project",
            description: "Project media.",
            assets: [
              {
                assetId: "shared-entry-id",
                name: "Project cut",
                type: "video",
                src: "/project-cut.mp4",
                status: "ready",
                source: { kind: "project", assetId: "shared-entry-id" },
              },
            ],
          },
          {
            scope: "external",
            label: "More sources",
            description: "Global media.",
            assets: [
              {
                assetId: "shared-entry-id",
                name: "Global master",
                type: "video",
                src: "/global-master.mp4",
                status: "ready",
                source: {
                  kind: "global-library",
                  assetId: "shared-entry-id",
                },
              },
            ],
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Add Project cut" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add Global master" }),
    ).toBeTruthy();
  });
});
