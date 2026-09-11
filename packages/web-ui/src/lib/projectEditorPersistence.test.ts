// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => localStorage.clear());

describe("project editor persistence", () => {
  it("restores canvas interaction preferences globally", async () => {
    const modulePath = "./projectEditorPersistence";
    const persistence = await import(/* @vite-ignore */ modulePath).catch(
      () => null,
    );
    expect(persistence).not.toBeNull();
    if (!persistence) return;

    expect(persistence.loadCanvasPreferences(localStorage)).toEqual({
      mode: "hand",
      minimapCollapsed: false,
      minimapSize: { width: 160, height: 112 },
    });

    persistence.saveCanvasPreferences(localStorage, {
      mode: "hand",
      minimapCollapsed: true,
      minimapSize: { width: 248, height: 168 },
    });

    expect(persistence.loadCanvasPreferences(localStorage)).toEqual({
      mode: "hand",
      minimapCollapsed: true,
      minimapSize: { width: 248, height: 168 },
    });
  });

  it("restores each project's last surface and per-canvas view state", async () => {
    const modulePath = "./projectEditorPersistence";
    const persistence = await import(/* @vite-ignore */ modulePath).catch(
      () => null,
    );
    expect(persistence).not.toBeNull();
    if (!persistence) return;

    persistence.saveProjectEditorSession(localStorage, "project-1", {
      activeCanvasId: "shots",
      workspaceSurface: { kind: "timeline", timelineId: "timeline-7" },
      threadId: "thread-12",
      canvasViews: {
        main: {
          viewport: { x: 18, y: -42, zoom: 0.8 },
          selectedNodeIds: [],
          selectedEdgeIds: [],
        },
        shots: {
          viewport: { x: -320, y: 96, zoom: 1.25 },
          selectedNodeIds: ["image-2", "image-9"],
          selectedEdgeIds: ["edge-4"],
        },
      },
    });

    expect(
      persistence.loadProjectEditorSession(localStorage, "project-1"),
    ).toEqual({
      activeCanvasId: "shots",
      workspaceSurface: { kind: "timeline", timelineId: "timeline-7" },
      threadId: "thread-12",
      canvasViews: {
        main: {
          viewport: { x: 18, y: -42, zoom: 0.8 },
          selectedNodeIds: [],
          selectedEdgeIds: [],
        },
        shots: {
          viewport: { x: -320, y: 96, zoom: 1.25 },
          selectedNodeIds: ["image-2", "image-9"],
          selectedEdgeIds: ["edge-4"],
        },
      },
    });
    expect(
      persistence.loadProjectEditorSession(localStorage, "project-2"),
    ).toBeNull();
  });

  it("ignores malformed persisted state instead of breaking the project", async () => {
    const modulePath = "./projectEditorPersistence";
    const persistence = await import(/* @vite-ignore */ modulePath).catch(
      () => null,
    );
    expect(persistence).not.toBeNull();
    if (!persistence) return;

    localStorage.setItem(
      "clash:canvas-preferences:v1",
      JSON.stringify({
        version: 1,
        mode: "erase",
        minimapCollapsed: "yes",
        minimapSize: { width: -1, height: "large" },
      }),
    );
    localStorage.setItem("clash:project:broken:editor-session:v1", "not-json");

    expect(persistence.loadCanvasPreferences(localStorage)).toEqual({
      mode: "hand",
      minimapCollapsed: false,
      minimapSize: { width: 160, height: 112 },
    });
    expect(
      persistence.loadProjectEditorSession(localStorage, "broken"),
    ).toBeNull();
  });
});
