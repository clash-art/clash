// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  EditorProvider,
  applyCanvasTransformEdit,
  useEditorDispatch,
  useEditorPlayback,
  type EditorState,
  type ImageItem,
} from "@clash/remotion-core";
import { PropertiesPanel } from "./PropertiesPanel";

afterEach(cleanup);

function Playhead() {
  const dispatch = useEditorDispatch();
  const { currentFrame } = useEditorPlayback();
  return (
    <>
      <output aria-label="Playhead">{currentFrame}</output>
      {[0, 20].map((frame) => (
        <button key={frame} onClick={() => dispatch({ type: "SET_CURRENT_FRAME", payload: frame })}>
          Seek {frame}
        </button>
      ))}
    </>
  );
}

function mount(item: ImageItem, currentFrame = 10) {
  const ref: { state?: EditorState } = {};
  render(
    <EditorProvider
      initialState={{
        fps: 30,
        tracks: [{ id: "track", name: "Photos", items: [item] }],
        selectedItemId: item.id,
        currentFrame,
      }}
      onStateChange={(state) => { ref.state = state; }}
    >
      <Playhead />
      <PropertiesPanel />
    </EditorProvider>,
  );
  return () => ref.state!.tracks[0]!.items[0] as ImageItem;
}

const image = (overrides: Partial<ImageItem> = {}): ImageItem => ({
  id: "shot",
  type: "image",
  src: "photo.png",
  from: 0,
  durationInFrames: 120,
  properties: { x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1 },
  ...overrides,
});

const diamond = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`^(Add|Remove) ${label} keyframe at current frame$`) });

describe("CapCut-style keyframe diamonds", () => {
  it.each([
    ["Position", "位置", "position", [0, 0]],
    ["Scale", "缩放", "scale", [1, 1]],
    ["Rotation", "旋转", "rotation", 0],
    ["Opacity", "不透明度", "opacity", 1],
  ] as const)("toggles a %s keyframe at the playhead with a hollow/filled diamond", (label, name, channel, value) => {
    const read = mount(image());
    const hollow = diamond(label);
    expect(hollow.getAttribute("data-keyframe-diamond")).toBe("hollow");
    expect(hollow.getAttribute("aria-pressed")).toBe("false");
    expect(hollow.getAttribute("title")).toBe(`在 00:00:00:10 添加${name}关键帧`);

    fireEvent.click(hollow);
    expect(read().keyframes?.[channel]).toEqual([{ frame: 10, value, interpolation: "linear" }]);
    const filled = diamond(label);
    expect(filled.getAttribute("data-keyframe-diamond")).toBe("filled");
    expect(filled.getAttribute("title")).toBe(`删除 00:00:00:10 的${name}关键帧`);

    fireEvent.click(filled);
    expect(read().keyframes).toBeUndefined();
    expect(diamond(label).getAttribute("data-keyframe-diamond")).toBe("hollow");
  });

  it("replaces the text toggle and the explanatory copy", () => {
    mount(image());
    expect(screen.queryByText(/Add keyframe|Remove keyframe/)).toBeNull();
    expect(screen.queryByText(/Move the playhead, add a keyframe/)).toBeNull();
    expect(screen.queryByText(/Between keyframes|On keyframe/)).toBeNull();
  });

  it("disables the diamond with a reason while the playhead is outside the clip", () => {
    mount(image(), 200);
    const toggle = diamond("Position") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("title")).toBe("将播放头移到所选片段内以编辑关键帧");
  });

  it("auto-keys a keyed property and keeps editing the static value of an unkeyed one", () => {
    const read = mount(image({
      keyframes: { position: [{ frame: 0, value: [0, 0], interpolation: "linear" }] },
    }), 20);
    expect(diamond("Position").getAttribute("data-keyframe-diamond")).toBe("hollow");
    fireEvent.change(screen.getByRole("spinbutton", { name: "X position in pixels" }), {
      target: { value: "240" },
    });
    expect(read().keyframes?.position).toEqual([
      { frame: 0, value: [0, 0], interpolation: "linear" },
      { frame: 20, value: [240, 0], interpolation: "linear" },
    ]);
    expect(read().properties?.x).toBe(0);
    expect(diamond("Position").getAttribute("data-keyframe-diamond")).toBe("filled");

    // Updating on an existing key replaces it rather than adding one.
    fireEvent.change(screen.getByRole("spinbutton", { name: "X position in pixels" }), {
      target: { value: "300" },
    });
    expect(read().keyframes?.position).toHaveLength(2);
    expect(read().keyframes?.position?.[1]).toEqual({ frame: 20, value: [300, 0], interpolation: "linear" });

    fireEvent.change(screen.getByRole("spinbutton", { name: "Rotation in degrees" }), {
      target: { value: "45" },
    });
    expect(read().properties?.rotation).toBe(45);
    expect(read().keyframes?.rotation).toBeUndefined();
  });

  it("shows Scale as the effective size the preview handles edit", () => {
    const item = image({
      properties: { x: 0, y: 0, width: 0.5, height: 0.5, rotation: 0, opacity: 1 },
      keyframes: { scale: [{ frame: 0, value: [1, 1], interpolation: "linear" }] },
    });
    // A handle drag to a visible width of 1 at frame 10 auto-keys a 2× multiplier.
    const handled = { ...item, ...applyCanvasTransformEdit(item, 10, "scale", {
      x: 0, y: 0, width: 1, height: 0.5, rotation: 0, opacity: 1,
    }) } as ImageItem;
    expect(handled.keyframes?.scale).toContainEqual({ frame: 10, value: [2, 1], interpolation: "linear" });
    expect(handled.properties).toMatchObject({ width: 0.5, height: 0.5 });

    const read = mount(handled, 10);
    const scaleX = screen.getByRole("spinbutton", { name: "X scale" }) as HTMLInputElement;
    expect(scaleX.value).toBe("1");
    fireEvent.change(scaleX, { target: { value: "1.5" } });
    expect(read().keyframes?.scale).toContainEqual({ frame: 10, value: [3, 1], interpolation: "linear" });
    expect(read().properties).toMatchObject({ width: 0.5, height: 0.5 });
  });

  it("navigates with ‹ › beside the diamond and shows interpolation only on a keyframe", () => {
    mount(image({
      keyframes: {
        position: [
          { frame: 0, value: [0, 0], interpolation: "linear" },
          { frame: 20, value: [100, 0], interpolation: "linear" },
        ],
      },
    }), 10);
    const previous = screen.getByRole("button", { name: "Previous Position keyframe" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next Position keyframe" }) as HTMLButtonElement;
    expect(previous.getAttribute("title")).toBe("上一个位置关键帧");
    expect(next.getAttribute("title")).toBe("下一个位置关键帧");
    expect(screen.queryByRole("combobox", { name: "Position keyframe interpolation" })).toBeNull();

    fireEvent.click(next);
    expect(screen.getByLabelText("Playhead").textContent).toBe("20");
    expect(diamond("Position").getAttribute("data-keyframe-diamond")).toBe("filled");
    expect((screen.getByRole("button", { name: "Next Position keyframe" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("Position keyframe interpolation")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous Position keyframe" }));
    expect(screen.getByLabelText("Playhead").textContent).toBe("0");
    expect((screen.getByRole("button", { name: "Previous Position keyframe" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides ‹ › for a property without keyframes", () => {
    mount(image());
    expect(screen.queryByRole("button", { name: "Previous Rotation keyframe" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next Rotation keyframe" })).toBeNull();
  });
});
