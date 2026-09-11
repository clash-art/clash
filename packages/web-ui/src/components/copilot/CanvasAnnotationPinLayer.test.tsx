// @vitest-environment jsdom
import type { RefObject } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CanvasAnnotationPinLayer } from "./CanvasAnnotationPinLayer";

vi.mock("@xyflow/react", () => ({
  ViewportPortal: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="canvas-annotation-viewport-portal">{children}</div>
  ),
  useViewport: () => ({ x: 120, y: 60, zoom: 2 }),
}));

afterEach(() => {
  cleanup();
  document
    .querySelectorAll(".react-flow__node")
    .forEach((node) => node.remove());
  vi.restoreAllMocks();
});

describe("CanvasAnnotationPinLayer", () => {
  it("renders the pin in the React Flow viewport at the annotated node edge", async () => {
    const flow = document.createElement("div");
    vi.spyOn(flow, "getBoundingClientRect").mockReturnValue({
      left: 40,
      top: 80,
      right: 940,
      bottom: 680,
      width: 900,
      height: 600,
      x: 40,
      y: 80,
      toJSON: () => ({}),
    });
    const node = document.createElement("div");
    node.className = "react-flow__node";
    node.dataset.id = "node-1";
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      left: 240,
      top: 180,
      right: 440,
      bottom: 260,
      width: 200,
      height: 80,
      x: 240,
      y: 180,
      toJSON: () => ({}),
    });
    document.body.append(node);

    render(
      <CanvasAnnotationPinLayer
        annotations={[
          {
            id: "annotation-1",
            kind: "agent-annotation",
            note: "Move this earlier.",
            target: {
              projectId: "project-1",
              surface: "canvas",
              surfaceId: "main",
              surfaceLabel: "Main",
              objectId: "node-1",
              objectType: "canvas-image",
              objectLabel: "Hero still",
              objectPath: "canvases/main/nodes/node-1",
              capabilities: ["read", "modify"],
            },
          },
        ]}
        canvasId="main"
        flowBoundsRef={{ current: flow } as RefObject<HTMLDivElement | null>}
        activeId={null}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    const pin = await screen.findByRole("button", { name: "Annotation 1" });
    expect(
      screen.getByTestId("canvas-annotation-viewport-portal"),
    ).toBeTruthy();
    expect(pin.style.left).toBe("140px");
    expect(pin.style.top).toBe("20px");
  });

  it("routes pin clicks into the source-anchored annotation editor", async () => {
    const flow = document.createElement("div");
    vi.spyOn(flow, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 900,
      bottom: 600,
      width: 900,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const node = document.createElement("div");
    node.className = "react-flow__node";
    node.dataset.id = "node-1";
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 80,
      right: 300,
      bottom: 180,
      width: 200,
      height: 100,
      x: 100,
      y: 80,
      toJSON: () => ({}),
    });
    document.body.append(node);
    const onSelect = vi.fn();

    render(
      <CanvasAnnotationPinLayer
        annotations={[
          {
            id: "annotation-1",
            kind: "agent-annotation",
            note: "",
            target: {
              projectId: "project-1",
              surface: "canvas",
              surfaceId: "main",
              surfaceLabel: "Main",
              objectId: "node-1",
              objectType: "canvas-image",
              objectLabel: "Hero still",
              objectPath: "canvases/main/nodes/node-1",
              capabilities: ["read", "modify"],
            },
          },
        ]}
        canvasId="main"
        flowBoundsRef={{ current: flow } as RefObject<HTMLDivElement | null>}
        activeId={null}
        onSelect={onSelect}
        onRemove={vi.fn()}
      />,
    );

    const pin = await screen.findByRole("button", { name: "Annotation 1" });
    pin.click();

    expect(onSelect).toHaveBeenCalledWith("annotation-1");
  });
});

it("stops DOM measurements while the canvas is inactive and restores pins on return", () => {
  vi.useFakeTimers();
  try {
    const flow = document.createElement("div");
    const bounds = vi.spyOn(flow, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 900,
      bottom: 600,
      width: 900,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const node = document.createElement("div");
    node.className = "react-flow__node";
    node.dataset.id = "node-1";
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 80,
      right: 300,
      bottom: 180,
      width: 200,
      height: 100,
      x: 100,
      y: 80,
      toJSON: () => ({}),
    });
    document.body.append(node);
    const props = {
      annotations: [
        {
          id: "note",
          kind: "agent-annotation" as const,
          note: "Keep this",
          target: {
            projectId: "project-1",
            surface: "canvas" as const,
            surfaceId: "main",
            surfaceLabel: "Main",
            objectId: "node-1",
            objectType: "canvas-image",
            objectLabel: "Image",
            objectPath: "canvases/main/nodes/node-1",
            capabilities: ["read" as const],
          },
        },
      ],
      canvasId: "main",
      flowBoundsRef: { current: flow },
      activeId: null,
      onSelect: vi.fn(),
      onRemove: vi.fn(),
    };
    const view = render(<CanvasAnnotationPinLayer {...props} active={false} />);
    act(() => vi.advanceTimersByTime(64));
    expect(bounds).not.toHaveBeenCalled();
    view.rerender(<CanvasAnnotationPinLayer {...props} active />);
    expect(screen.getByRole("button", { name: "Annotation 1" })).toBeTruthy();
    view.rerender(<CanvasAnnotationPinLayer {...props} active={false} />);
    bounds.mockClear();
    act(() => vi.advanceTimersByTime(64));
    expect(bounds).not.toHaveBeenCalled();
    view.rerender(<CanvasAnnotationPinLayer {...props} active />);
    fireEvent.click(screen.getByRole("button", { name: "Annotation 1" }));
    expect(props.onSelect).toHaveBeenCalledWith("note");
    view.unmount();
  } finally {
    vi.useRealTimers();
  }
});
