// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveCanvas } from "./InteractiveCanvas";

const playerApi = vi.hoisted(() => ({
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  getCurrentFrame: vi.fn(() => 0),
  pause: vi.fn(),
  play: vi.fn(),
  seekTo: vi.fn(),
  setVolume: vi.fn(),
  mute: vi.fn(),
  unmute: vi.fn(),
  isPlaying: vi.fn(() => false),
}));

vi.mock("@remotion/player", async () => {
  const ReactModule = await import("react");
  return {
    Player: ReactModule.forwardRef((_props, ref) => {
      ReactModule.useImperativeHandle(ref, () => playerApi);
      return <div data-testid="player" />;
    }),
  };
});

vi.mock("@clash/remotion-components", () => ({
  VideoComposition: () => null,
}));

let viewport = { width: 800, height: 600 };
let notifyResize: (() => void) | undefined;

class ResizeObserverStub {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    notifyResize = () => this.callback([], this as unknown as ResizeObserver);
  }

  observe() {
    notifyResize?.();
  }

  disconnect() {}
}

const baseProps = {
  allNodesMap: new Map<string, unknown>(),
  currentFrame: 0,
  compositionWidth: 1920,
  compositionHeight: 1080,
  fps: 30,
  durationInFrames: 90,
  onUpdateItem: vi.fn(),
  onSelectItem: vi.fn(),
};

beforeEach(() => {
  viewport = { width: 800, height: 600 };
  notifyResize = undefined;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => viewport.width,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    () => viewport.height,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: viewport.width,
      bottom: viewport.height,
      width: viewport.width,
      height: viewport.height,
      toJSON: () => ({}),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const visual = {
  id: "clip-1",
  type: "solid" as const,
  color: "#ff0000",
  from: 0,
  durationInFrames: 90,
  properties: {
    x: 0,
    y: 0,
    width: 0.4,
    height: 0.3,
    rotation: 0,
    opacity: 1,
  },
};

const tracks = [{ id: "visual", name: "V1", items: [visual] }];

describe("InteractiveCanvas paintSurface (iframe PreviewHost overlays)", () => {
  it("keeps parent-side selection handles when paint is external", async () => {
    const paint = (
      <div
        data-testid="iframed-remotion-preview"
        data-preview-paint-surface="iframe"
      />
    );
    const { container, rerender } = render(
      <InteractiveCanvas
        {...baseProps}
        tracks={tracks}
        selectedItemId="clip-1"
        paintSurface={paint}
      />,
    );

    await waitFor(() => expect(notifyResize).toBeTypeOf("function"));
    rerender(
      <InteractiveCanvas
        {...baseProps}
        tracks={tracks}
        selectedItemId="clip-1"
        paintSurface={paint}
      />,
    );

    expect(
      screen.getByTestId("interactive-canvas").getAttribute("data-preview-paint"),
    ).toBe("external");
    expect(screen.getByTestId("iframed-remotion-preview")).toBeTruthy();
    expect(screen.queryByTestId("player")).toBeNull();
    expect(playerApi.play).not.toHaveBeenCalled();
    expect(playerApi.seekTo).not.toHaveBeenCalled();
    expect(playerApi.addEventListener).not.toHaveBeenCalled();

    expect(container.querySelector(".item-clickable")).not.toBeNull();
    expect(container.querySelector(".canvas-controls")).not.toBeNull();
    expect(container.querySelectorAll(".control-handle").length).toBeGreaterThan(
      0,
    );
  });

  it("does not mount a main-thread Player when paintSurface is set", async () => {
    const { rerender } = render(
      <InteractiveCanvas
        {...baseProps}
        tracks={tracks}
        selectedItemId={null}
        playing
        paintSurface={<div data-testid="external-paint" />}
      />,
    );
    await waitFor(() => expect(notifyResize).toBeTypeOf("function"));
    rerender(
      <InteractiveCanvas
        {...baseProps}
        tracks={tracks}
        selectedItemId={null}
        playing
        paintSurface={<div data-testid="external-paint" />}
      />,
    );
    expect(screen.getByTestId("external-paint")).toBeTruthy();
    expect(screen.queryByTestId("player")).toBeNull();
    expect(playerApi.addEventListener).not.toHaveBeenCalled();
    expect(playerApi.play).not.toHaveBeenCalled();
  });
});
