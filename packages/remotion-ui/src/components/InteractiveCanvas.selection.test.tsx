// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

describe("InteractiveCanvas selection geometry", () => {
  it("opens and selects a clip with implicit transforms without writing defaults", async () => {
    const onUpdateItem = vi.fn();
    const clip = { id: "implicit", type: "video" as const, src: "/clip.mp4", from: 0, durationInFrames: 90 };
    const tracks = [{ id: "main", name: "Media", items: [clip] }];
    const { container, rerender } = render(
      <InteractiveCanvas {...baseProps} tracks={tracks} selectedItemId={clip.id} onUpdateItem={onUpdateItem} />,
    );
    await waitFor(() => expect(notifyResize).toBeTypeOf("function"));
    rerender(
      <InteractiveCanvas {...baseProps} tracks={tracks} currentFrame={20} selectedItemId={clip.id} onUpdateItem={onUpdateItem} />,
    );
    expect(onUpdateItem).not.toHaveBeenCalled();
    expect(container.querySelector(".item-clickable")).not.toBeNull();
    expect(container.querySelector(".canvas-controls")).not.toBeNull();
    expect(clip).not.toHaveProperty("properties");
  });

  it("keeps the preview player mounted when the canvas ratio changes", () => {
    const { rerender } = render(
      <InteractiveCanvas
        {...baseProps}
        tracks={[]}
        selectedItemId={null}
      />,
    );
    const player = screen.getByTestId("player");

    rerender(
      <InteractiveCanvas
        {...baseProps}
        compositionWidth={1080}
        compositionHeight={1920}
        tracks={[]}
        selectedItemId={null}
      />,
    );

    expect(screen.getByTestId("player")).toBe(player);
  });

  it("does not create canvas hit targets or transform controls for audio items", async () => {
    const audio = {
      id: "audio",
      type: "audio" as const,
      src: "/voice.wav",
      from: 0,
      durationInFrames: 90,
      properties: { x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1 },
    };
    const { container, rerender } = render(
      <InteractiveCanvas
        {...baseProps}
        tracks={[{ id: "audio-track", name: "Audio", items: [audio] }]}
        selectedItemId={audio.id}
      />,
    );

    await waitFor(() => expect(notifyResize).toBeTypeOf("function"));
    rerender(
      <InteractiveCanvas
        {...baseProps}
        tracks={[{ id: "audio-track", name: "Audio", items: [audio] }]}
        selectedItemId={audio.id}
      />,
    );
    expect(container.querySelector(".item-clickable")).toBeNull();
    expect(container.querySelector(".canvas-controls")).toBeNull();
  });

  it("recomputes transform controls when the preview container resizes", async () => {
    const visual = {
      id: "visual",
      type: "solid" as const,
      color: "#f5ddd8",
      from: 0,
      durationInFrames: 90,
      properties: { x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1 },
    };
    const { container, rerender } = render(
      <InteractiveCanvas
        {...baseProps}
        tracks={[{ id: "visual-track", name: "Visual", items: [visual] }]}
        selectedItemId={visual.id}
      />,
    );

    const getSelectionRect = () =>
      container.querySelector(".canvas-controls rect");
    await waitFor(() => expect(notifyResize).toBeTypeOf("function"));
    rerender(
      <InteractiveCanvas
        {...baseProps}
        tracks={[{ id: "visual-track", name: "Visual", items: [visual] }]}
        selectedItemId={visual.id}
      />,
    );
    await waitFor(() =>
      expect(getSelectionRect()?.getAttribute("width")).toBe("800"),
    );

    viewport = { width: 600, height: 600 };
    act(() => notifyResize?.());

    await waitFor(() =>
      expect(getSelectionRect()?.getAttribute("width")).toBe("600"),
    );
  });

  it("clears the selected item when the pointer presses the Canvas background", async () => {
    const onSelectItem = vi.fn();
    const visual = {
      id: "visual",
      type: "solid" as const,
      color: "#f5ddd8",
      from: 0,
      durationInFrames: 90,
      properties: {
        x: 0,
        y: 0,
        width: 0.5,
        height: 0.5,
        rotation: 0,
        opacity: 1,
      },
    };
    const { container } = render(
      <InteractiveCanvas
        {...baseProps}
        tracks={[{ id: "visual-track", name: "Visual", items: [visual] }]}
        selectedItemId={visual.id}
        onSelectItem={onSelectItem}
      />,
    );

    await waitFor(() => expect(notifyResize).toBeTypeOf("function"));
    const background = container.querySelector<SVGRectElement>(
      ".canvas-items > rect",
    );
    expect(background).toBeTruthy();
    fireEvent.pointerDown(background!);

    expect(onSelectItem).toHaveBeenCalledWith(null);
  });
});
