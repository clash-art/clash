// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  EditorProvider,
  useEditorHistory,
  useEditorDispatch,
  useEditorPlayback,
  useEditorStaticState,
} from "@clash/remotion-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasPreview } from "./CanvasPreview";
import {
  createPreviewAudioMeterStore,
  type PreviewAudioMeterStore,
} from "./previewAudioMeter";

vi.mock("./InteractiveCanvas", () => ({
  InteractiveCanvas: (props: {
    allNodesMap?: Map<string, unknown>;
    viewportCommand?: { type: string; zoom?: number };
    audioMeterEnabled?: boolean;
    onTransformStart?: () => void;
    onTransformEnd?: () => void;
    onUpdateItem?: (trackId: string, itemId: string, updates: unknown) => void;
    durationInFrames?: number;
  }) => (
    <>
      <div
        data-testid="interactive-canvas"
        data-duration={props.durationInFrames}
        data-runtime-node-ids={[...(props.allNodesMap?.keys() ?? [])].join(",")}
        data-viewport-command={
          props.viewportCommand
            ? `${props.viewportCommand.type}:${props.viewportCommand.zoom ?? ""}`
            : ""
        }
        data-audio-meter-enabled={props.audioMeterEnabled}
      />
      <button
        type="button"
        aria-label="Simulate canvas drag"
        onClick={() => {
          props.onTransformStart?.();
          props.onUpdateItem?.("visual", "clip", {
            properties: {
              x: 10,
              y: 0,
              width: 1,
              height: 1,
              rotation: 0,
              opacity: 1,
            },
          });
          props.onUpdateItem?.("visual", "clip", {
            properties: {
              x: 20,
              y: 0,
              width: 1,
              height: 1,
              rotation: 0,
              opacity: 1,
            },
          });
          props.onTransformEnd?.();
        }}
      >
        Simulate canvas drag
      </button>
    </>
  ),
}));

const PlaybackProbe = () => {
  const playback = useEditorPlayback();
  return (
    <output aria-label="Playback state">{`${playback.currentFrame}:${playback.playing}`}</output>
  );
};

const HistoryProbe = () => {
  const { canUndo, undo } = useEditorHistory();
  const { selectedItemId, tracks } = useEditorStaticState();
  const clip = tracks
    .flatMap((track) => track.items)
    .find((item) => item.id === "clip");
  return (
    <>
      <output aria-label="Canvas item x">{clip?.properties?.x ?? 0}</output>
      <output aria-label="Canvas item count">
        {tracks.flatMap((track) => track.items).length}
      </output>
      <output aria-label="Canvas selected item">
        {selectedItemId ?? "none"}
      </output>
      <button
        type="button"
        aria-label="Undo canvas edit"
        disabled={!canUndo}
        onClick={undo}
      >
        Undo
      </button>
    </>
  );
};

function renderPreview(
  props: {
    audioMeterOpen?: boolean;
    onToggleAudioMeter?: () => void;
    audioMeterStore?: PreviewAudioMeterStore;
    runtimeNodes?: Array<{
      id: string;
      type: string;
      data: Record<string, unknown>;
    }>;
  } = {},
) {
  return render(
    <EditorProvider
      initialState={{
        fps: 30,
        durationInFrames: 90,
        currentFrame: 0,
        playing: false,
        compositionWidth: 1920,
        compositionHeight: 1080,
        selectedItemId: "clip",
        tracks: [
          {
            id: "visual",
            name: "Visual",
            items: [
              {
                id: "clip",
                type: "solid",
                color: "#f5ddd8",
                from: 0,
                durationInFrames: 90,
              },
            ],
          },
        ],
      }}
    >
      <CanvasPreview {...props} />
      <PlaybackProbe />
      <HistoryProbe />
    </EditorProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CanvasPreview transport", () => {
  it("previews the authored composition duration, including empty tail frames and later duration edits", () => {
    const DurationControl = () => {
      const dispatch = useEditorDispatch();
      return (
        <button onClick={() => dispatch({ type: "SET_DURATION", payload: 60 })}>
          Change duration
        </button>
      );
    };
    render(
      <EditorProvider
        initialState={{
          fps: 30,
          durationInFrames: 180,
          tracks: [
            {
              id: "visual",
              name: "Visual",
              items: [
                {
                  id: "short",
                  type: "solid",
                  color: "red",
                  from: 0,
                  durationInFrames: 30,
                },
              ],
            },
          ],
        }}
      >
        <CanvasPreview />
        <DurationControl />
      </EditorProvider>,
    );
    expect(screen.getByLabelText("Duration timecode").textContent).toBe(
      "00:00:06:00",
    );
    expect(
      screen.getByTestId("interactive-canvas").getAttribute("data-duration"),
    ).toBe("180");
    fireEvent.click(screen.getByText("Change duration"));
    expect(screen.getByLabelText("Duration timecode").textContent).toBe(
      "00:00:02:00",
    );
    expect(
      screen.getByTestId("interactive-canvas").getAttribute("data-duration"),
    ).toBe("60");
  });
  it("passes live non-media runtime nodes into the shared VideoComposition resolver", () => {
    renderPreview({
      runtimeNodes: [
        {
          id: "remotion-live",
          type: "remotion-component",
          data: {
            content: "export default function Live(){ return <div />; }",
          },
        },
      ],
    });

    expect(
      screen
        .getByTestId("interactive-canvas")
        .getAttribute("data-runtime-node-ids"),
    ).toContain("remotion-live");
  });

  it("owns frame-accurate time and playback without a progress bar", async () => {
    renderPreview();

    expect(screen.getByLabelText("Current timecode").textContent).toBe(
      "00:00:00:00",
    );
    expect(screen.getByLabelText("Duration timecode").textContent).toBe(
      "00:00:03:00",
    );
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom out" })).toBeNull();
    expect(
      screen.queryByRole("slider", { name: "Preview position" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Playback state").textContent).toBe(
        "0:true",
      ),
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("groups a continuous Canvas transform into one Undo step", async () => {
    renderPreview();

    fireEvent.click(
      screen.getByRole("button", { name: "Simulate canvas drag" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Canvas item x").textContent).toBe("20"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo canvas edit" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Canvas item x").textContent).toBe("0"),
    );
    expect(
      screen
        .getByRole("button", { name: "Undo canvas edit" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("takes keyboard focus when pressed and deletes the selected Canvas item with Backspace", async () => {
    renderPreview();
    const stalePropertiesInput = document.createElement("input");
    document.body.appendChild(stalePropertiesInput);
    stalePropertiesInput.focus();

    const preview = screen.getByTestId("canvas-preview");
    const stage = preview.querySelector<HTMLElement>("[data-preview-stage]");
    expect(stage).toBeTruthy();
    fireEvent.click(stage!);
    expect(document.activeElement).toBe(stage);
    fireEvent.keyDown(stalePropertiesInput, { key: "Backspace" });

    await waitFor(() =>
      expect(screen.getByLabelText("Canvas item count").textContent).toBe("0"),
    );
    stalePropertiesInput.remove();
  });

  it("clears the selected item when the Preview background is pressed", async () => {
    renderPreview();

    expect(screen.getByLabelText("Canvas selected item").textContent).toBe(
      "clip",
    );
    fireEvent.pointerDown(screen.getByTestId("interactive-canvas"));

    await waitFor(() =>
      expect(screen.getByLabelText("Canvas selected item").textContent).toBe(
        "none",
      ),
    );
  });

  it("leaves Backspace to an input after the user returns to Properties", () => {
    renderPreview();
    const preview = screen.getByTestId("canvas-preview");
    const stage = preview.querySelector<HTMLElement>("[data-preview-stage]");
    const propertiesInput = document.createElement("input");
    document.body.appendChild(propertiesInput);

    fireEvent.click(stage!);
    fireEvent.mouseDown(propertiesInput);
    propertiesInput.focus();
    fireEvent.keyDown(propertiesInput, { key: "Backspace" });

    expect(screen.getByLabelText("Canvas item count").textContent).toBe("1");
    propertiesInput.remove();
  });

  it("opens a real canvas zoom regulator from the viewport icon", () => {
    renderPreview();

    expect(
      screen.queryByRole("dialog", { name: "Canvas zoom controls" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Canvas zoom" }));

    expect(
      screen.getByRole("dialog", { name: "Canvas zoom controls" }),
    ).toBeTruthy();
    const zoom = screen.getByRole("slider", {
      name: "Canvas zoom level",
    }) as HTMLInputElement;
    expect(zoom.value).toBe("100");

    fireEvent.change(zoom, { target: { value: "150" } });
    expect(
      screen
        .getByTestId("interactive-canvas")
        .getAttribute("data-viewport-command"),
    ).toBe("set-zoom:1.5");

    fireEvent.click(screen.getByRole("button", { name: "Fit canvas" }));
    expect(
      screen
        .getByTestId("interactive-canvas")
        .getAttribute("data-viewport-command"),
    ).toBe("reset:");
  });

  it("toggles a read-only live audio meter instead of changing volume", () => {
    const onToggleAudioMeter = vi.fn();
    const { rerender } = renderPreview({
      audioMeterOpen: false,
      onToggleAudioMeter,
    });

    expect(
      screen.queryByRole("slider", { name: /Preview volume/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Mute preview/i })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Audio level meter" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen
        .getByTestId("interactive-canvas")
        .getAttribute("data-audio-meter-enabled"),
    ).toBe("false");

    fireEvent.click(toggle);
    expect(onToggleAudioMeter).toHaveBeenCalledOnce();

    rerender(
      <EditorProvider
        initialState={{
          fps: 30,
          currentFrame: 0,
          playing: false,
          compositionWidth: 1920,
          compositionHeight: 1080,
          tracks: [],
        }}
      >
        <CanvasPreview audioMeterOpen onToggleAudioMeter={onToggleAudioMeter} />
        <PlaybackProbe />
      </EditorProvider>,
    );
    expect(
      screen
        .getByRole("button", { name: "Audio level meter" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("interactive-canvas")
        .getAttribute("data-audio-meter-enabled"),
    ).toBe("true");
  });

  it("represents the live meter as paired left and right channel columns", () => {
    renderPreview();

    const toggle = screen.getByRole("button", { name: "Audio level meter" });
    const channels = Array.from(
      toggle.querySelectorAll<SVGGElement>("[data-audio-meter-channel]"),
    ).map((channel) => channel.getAttribute("data-audio-meter-channel"));

    expect(channels).toEqual(["L", "R"]);
    expect(toggle.querySelector("[data-stereo-meter-icon]")).toBeTruthy();
  });

  it("keeps the compact L/R meter live while the full meter is closed", () => {
    const audioMeterStore = createPreviewAudioMeterStore();
    renderPreview({ audioMeterOpen: false, audioMeterStore });

    expect(
      screen
        .getByTestId("interactive-canvas")
        .getAttribute("data-audio-meter-enabled"),
    ).toBe("true");
    const toggle = screen.getByRole("button", { name: "Audio level meter" });
    const leftFill = toggle.querySelector<SVGRectElement>(
      '[data-audio-meter-fill="L"]',
    );
    const rightFill = toggle.querySelector<SVGRectElement>(
      '[data-audio-meter-fill="R"]',
    );
    expect(leftFill?.getAttribute("height")).toBe("0");
    expect(rightFill?.getAttribute("height")).toBe("0");
    expect(leftFill?.getAttribute("fill")).toBe("var(--clash-accent, #ff6b50)");
    expect(rightFill?.getAttribute("fill")).toBe(
      "var(--clash-accent, #ff6b50)",
    );

    act(() => audioMeterStore.setLevels({ left: 0.5, right: 0.25 }));

    expect(Number(leftFill?.getAttribute("height"))).toBeGreaterThan(
      Number(rightFill?.getAttribute("height")),
    );
    expect(Number(rightFill?.getAttribute("height"))).toBeGreaterThan(0);
  });

  it("hides secondary transport labels when the Preview reaches its minimum width", () => {
    const packageRoot = process.cwd().endsWith("packages/remotion-ui")
      ? process.cwd()
      : resolve(process.cwd(), "packages/remotion-ui");
    const source = readFileSync(
      resolve(packageRoot, "src/components/CanvasPreview.tsx"),
      "utf8",
    );

    expect(source).toContain("display: none !important;");
  });

  it("uses the panel surface around the video and exposes native fullscreen", () => {
    const { container } = renderPreview();
    const root = screen.getByTestId("canvas-preview");
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(root, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });

    expect(root.getAttribute("data-surface")).toBe("warm-panel");
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-preview-stage]")).toBeTruthy();
  });
});
