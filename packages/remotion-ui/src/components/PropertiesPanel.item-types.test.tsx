// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  EditorProvider,
  type AudioItem,
  type CompositionItem,
  type DerivedOverlayItem,
  type EditorState,
  type ImageItem,
  type Item,
  type StickerItem,
  type TextItem,
  type VideoItem,
  type Asset,
} from "@clash/remotion-core";
import { TIMELINE_MASK_ANIMATION_BINDINGS } from "@clash/shared-types";
import { PropertiesPanel } from "./PropertiesPanel";

afterEach(() => cleanup());

const renderInspector = (
  item?: Item,
  options: {
    role?: EditorState["tracks"][number]["role"];
    assets?: Asset[];
    currentFrame?: number;
  } = {},
) => {
  const stateRef = { current: null as EditorState | null };
  const initialState: Partial<EditorState> = item
    ? {
        tracks: [
          {
            id: "track",
            name: "Track",
            role:
              options.role ?? (item.type === "audio" ? "narration" : "overlay"),
            items: [item],
          },
        ],
        selectedItemId: item.id,
        assets: options.assets ?? [],
        currentFrame: options.currentFrame ?? item.from,
      }
    : {
        tracks: [],
        selectedItemId: null,
        compositionWidth: 1920,
        compositionHeight: 1080,
      };
  render(
    <EditorProvider
      initialState={initialState}
      onStateChange={(state) => {
        stateRef.current = state;
      }}
    >
      <PropertiesPanel />
    </EditorProvider>,
  );
  return stateRef;
};

const latestItem = <T extends Item>(stateRef: {
  current: EditorState | null;
}): T =>
  (stateRef
    .current!.tracks.flatMap((track) => track.items)
    .find((item) => item.id === stateRef.current!.selectedItemId) ??
    stateRef.current!.tracks.flatMap((track) => track.items)[0]) as T;

const chooseInspectorOption = (selectName: string, optionName: string) => {
  fireEvent.click(screen.getByRole("combobox", { name: selectName }));
  fireEvent.click(screen.getByRole("option", { name: optionName }));
};

describe("PropertiesPanel item type coverage", () => {
  it("labels static item size as a source multiplier instead of pixels", () => {
    const image: ImageItem = {
      id: "scaled-image",
      type: "image",
      src: "image.png",
      from: 0,
      durationInFrames: 30,
      properties: { x: 0, y: 0, width: 1, height: 1 },
    };

    renderInspector(image);

    expect(screen.getByText("Base source scale")).toBeTruthy();
    expect(screen.getByText(/Unitless multipliers, not pixels/i)).toBeTruthy();
    expect(
      screen.getByRole("spinbutton", { name: "Width source scale multiplier" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("spinbutton", {
        name: "Height source scale multiplier",
      }),
    ).toBeTruthy();
  });

  it("adds a real clip mask and authors mask motion at the item-local playhead", () => {
    const video: VideoItem = {
      id: "masked-video",
      type: "video",
      src: "video.mp4",
      from: 30,
      durationInFrames: 60,
      keyframes: {
        position: [{ frame: 0, value: [0, 0], interpolation: "linear" }],
      },
    };
    const stateRef = renderInspector(video, { currentFrame: 40 });

    fireEvent.click(screen.getByRole("button", { name: "Add mask" }));
    expect((latestItem<VideoItem>(stateRef) as any).mask).toEqual({
      shape: "rectangle",
      position: [50, 50],
      size: [70, 70],
      rotation: 0,
      feather: 0,
      inverted: false,
    });
    for (const binding of TIMELINE_MASK_ANIMATION_BINDINGS) {
      expect(
        screen.getByRole("button", {
          name: `Add ${binding.label} keyframe at current frame`,
        }),
      ).toBeTruthy();
    }

    chooseInspectorOption("Mask shape", "Ellipse");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Mask position keyframe at current frame",
      }),
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Mask center X percent" }),
      {
        target: { value: "65" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Mask feather keyframe at current frame",
      }),
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Mask feather percent" }),
      {
        target: { value: "24" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Invert mask" }));

    expect(latestItem<VideoItem>(stateRef)).toMatchObject({
      mask: {
        shape: "ellipse",
        inverted: true,
      },
      keyframes: {
        maskPosition: [{ frame: 10, value: [65, 50], interpolation: "linear" }],
        maskFeather: [{ frame: 10, value: 24, interpolation: "linear" }],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove mask" }));
    expect((latestItem<VideoItem>(stateRef) as any).mask).toBeUndefined();
    expect(latestItem<VideoItem>(stateRef).keyframes).toEqual({
      position: [{ frame: 0, value: [0, 0], interpolation: "linear" }],
    });
  });

  it("adds and updates an item-local Position keyframe at the current playhead", () => {
    const video: VideoItem = {
      id: "animated",
      type: "video",
      src: "video.mp4",
      from: 30,
      durationInFrames: 60,
      properties: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        rotation: 0,
        opacity: 1,
      },
    };
    const stateRef = renderInspector(video, { currentFrame: 40 });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Position keyframe at current frame",
      }),
    );
    expect(latestItem<VideoItem>(stateRef).keyframes?.position).toEqual([
      { frame: 10, value: [0, 0], interpolation: "linear" },
    ]);

    fireEvent.change(
      screen.getByRole("spinbutton", { name: "X position in pixels" }),
      {
        target: { value: "120" },
      },
    );
    expect(latestItem<VideoItem>(stateRef).keyframes?.position).toEqual([
      { frame: 10, value: [120, 0], interpolation: "linear" },
    ]);
    expect(latestItem<VideoItem>(stateRef).properties?.x).toBe(0);
  });

  it("authors Scale, Rotation, and Opacity channels without replacing static size", () => {
    const image: ImageItem = {
      id: "animated-image",
      type: "image",
      src: "image.png",
      from: 0,
      durationInFrames: 30,
      properties: {
        x: 0,
        y: 0,
        width: 0.5,
        height: 0.25,
        rotation: 0,
        opacity: 1,
      },
    };
    const stateRef = renderInspector(image, { currentFrame: 10 });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Scale keyframe at current frame",
      }),
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "X animated scale" }),
      {
        target: { value: "1.5" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Rotation keyframe at current frame",
      }),
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Rotation in degrees" }),
      {
        target: { value: "30" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Opacity keyframe at current frame",
      }),
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Opacity" }), {
      target: { value: "0.4" },
    });

    expect(latestItem<ImageItem>(stateRef)).toMatchObject({
      properties: { width: 0.5, height: 0.25 },
      keyframes: {
        scale: [{ frame: 10, value: [1.5, 1], interpolation: "linear" }],
        rotation: [{ frame: 10, value: 30, interpolation: "linear" }],
        opacity: [{ frame: 10, value: 0.4, interpolation: "linear" }],
      },
    });
  });

  it("navigates adjacent Position keys and edits the outgoing interpolation", () => {
    const image: ImageItem = {
      id: "moving-image",
      type: "image",
      src: "image.png",
      from: 30,
      durationInFrames: 40,
      properties: { x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1 },
      keyframes: {
        position: [
          { frame: 0, value: [0, 0], interpolation: "linear" },
          { frame: 20, value: [200, 0], interpolation: "linear" },
        ],
      },
    };
    const stateRef = renderInspector(image, { currentFrame: 40 });

    expect(
      (
        screen.getByRole("spinbutton", {
          name: "X position in pixels",
        }) as HTMLInputElement
      ).value,
    ).toBe("100");
    fireEvent.click(
      screen.getByRole("button", { name: "Next Position keyframe" }),
    );
    expect(
      (
        screen.getByRole("spinbutton", {
          name: "X position in pixels",
        }) as HTMLInputElement
      ).value,
    ).toBe("200");
    chooseInspectorOption("Position keyframe interpolation", "Hold");

    expect(latestItem<ImageItem>(stateRef).keyframes?.position?.[1]).toEqual({
      frame: 20,
      value: [200, 0],
      interpolation: "hold",
    });
  });

  it.each([0, 100])("does not silently edit a boundary key when the playhead is outside the selected clip at %s", (currentFrame) => {
    const image: ImageItem = {
      id: "outside-clip",
      type: "image",
      src: "image.png",
      from: 30,
      durationInFrames: 40,
      keyframes: {
        position: [
          { frame: 0, value: [15, 20], interpolation: "linear" },
          { frame: 39, value: [200, 20], interpolation: "linear" },
        ],
      },
    };
    const stateRef = renderInspector(image, { currentFrame });
    const toggle = screen.getByRole("button", {name: /Position keyframe at current frame/}) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect((screen.getByRole("spinbutton", {name: "X position in pixels"}) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(toggle);
    expect(latestItem<ImageItem>(stateRef).keyframes).toEqual(image.keyframes);
    // Navigation must enter the nearest key, including the first/last frame.
    fireEvent.click(screen.getByRole("button", {name: currentFrame < image.from ? "Next Position keyframe" : "Previous Position keyframe"}));
    expect((screen.getByRole("spinbutton", {name: "X position in pixels"}) as HTMLInputElement).value).toBe(currentFrame < image.from ? "15" : "200");
    expect((screen.getByRole("button", {name: "Remove Position keyframe at current frame"}) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps keyframe actions readable in the narrow Inspector layout", () => {
    const image: ImageItem = {
      id: "compact-keyframes",
      type: "image",
      src: "image.png",
      from: 0,
      durationInFrames: 30,
      properties: { x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1 },
      keyframes: {
        position: [
          { frame: 0, value: [0, 0], interpolation: "linear" },
          { frame: 10, value: [100, 50], interpolation: "linear" },
          { frame: 20, value: [200, 100], interpolation: "linear" },
        ],
      },
    };
    renderInspector(image, { currentFrame: 10 });

    const toggle = screen.getByRole("button", {
      name: "Remove Position keyframe at current frame",
    });
    const previous = screen.getByRole("button", {
      name: "Previous Position keyframe",
    });
    expect(previous.parentElement).not.toBe(toggle.parentElement);
    expect(
      screen.getByTestId("scalar-keyframe-controls").className,
    ).not.toContain("grid-cols-2");
  });

  it("edits a custom Canvas ratio with one real composition-size update", () => {
    const stateRef = renderInspector();

    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Aspect ratio numerator" }),
      {
        target: { value: "2" },
      },
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Aspect ratio denominator" }),
      {
        target: { value: "1" },
      },
    );
    fireEvent.blur(
      screen.getByRole("spinbutton", { name: "Aspect ratio denominator" }),
    );

    expect(stateRef.current?.compositionWidth).toBe(2160);
    expect(stateRef.current?.compositionHeight).toBe(1080);
    expect(
      screen
        .getByRole("button", { name: "Custom" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("keeps audio visual-transform-free and exposes its real source in-point", () => {
    const audio: AudioItem = {
      id: "voice",
      type: "audio",
      src: "voice.wav",
      sourceStartInFrames: 12,
      from: 30,
      durationInFrames: 90,
    };
    const stateRef = renderInspector(audio);

    expect(screen.queryByText("Transform")).toBeNull();
    expect(screen.queryByText("Mask")).toBeNull();
    expect(screen.getByText("Audio")).toBeTruthy();
    const sourceStart = screen.getByRole("spinbutton", {
      name: "Source start frame",
    });
    expect((sourceStart as HTMLInputElement).value).toBe("12");
    fireEvent.change(sourceStart, { target: { value: "24" } });
    expect(latestItem<AudioItem>(stateRef).sourceStartInFrames).toBe(24);
  });

  it("resolves an asset-backed source instead of showing an empty fake path", () => {
    const audio: AudioItem = {
      id: "voice",
      type: "audio",
      src: "",
      sourceNodeId: "asset-voice",
      from: 0,
      durationInFrames: 90,
    };
    renderInspector(audio, {
      assets: [
        {
          id: "asset-voice",
          name: "Voice master",
          type: "audio",
          src: "assets/voice-master.wav",
          duration: 3,
          createdAt: 1,
        },
      ],
    });

    expect(screen.getByText("assets/voice-master.wav")).toBeTruthy();
  });

  it.each([
    [
      "video",
      {
        id: "video",
        type: "video",
        src: "video.mp4",
        from: 0,
        durationInFrames: 90,
      } satisfies VideoItem,
    ],
    [
      "image",
      {
        id: "image",
        type: "image",
        src: "image.png",
        from: 0,
        durationInFrames: 90,
      } satisfies ImageItem,
    ],
    [
      "sticker",
      {
        id: "sticker",
        type: "sticker",
        src: "sticker.webp",
        from: 0,
        durationInFrames: 90,
      } satisfies StickerItem,
    ],
    [
      "derived overlay",
      {
        id: "derived",
        type: "derived-overlay",
        mediaType: "image",
        src: "generated/crop.png",
        sourceAssetId: "asset-source",
        derivedAssetId: "asset-derived",
        derivation: { kind: "crop" },
        from: 0,
        durationInFrames: 90,
      } satisfies DerivedOverlayItem,
    ],
  ])("edits the rendered media fit for %s", (_label, item) => {
    const stateRef = renderInspector(item);
    chooseInspectorOption("Media fit", "Cover");

    expect(
      (latestItem(stateRef) as Item & { mediaFit?: string }).mediaFit,
    ).toBe("cover");
  });

  it("stores video entrance and exit animations as renderer-backed Timeline DSL fields", () => {
    const video: VideoItem = {
      id: "video",
      type: "video",
      src: "video.mp4",
      from: 0,
      durationInFrames: 90,
    };
    const stateRef = renderInspector(video);

    expect(screen.getByText("Animation")).toBeTruthy();
    expect(screen.queryByText("Fades")).toBeNull();
    chooseInspectorOption("Entrance animation type", "Zoom in");
    fireEvent.change(
      screen.getByRole("spinbutton", {
        name: "Entrance animation duration in frames",
      }),
      {
        target: { value: "18" },
      },
    );
    chooseInspectorOption("Exit animation type", "Fade");
    fireEvent.change(
      screen.getByRole("spinbutton", {
        name: "Exit animation duration in frames",
      }),
      {
        target: { value: "12" },
      },
    );

    expect(latestItem<VideoItem>(stateRef)).toMatchObject({
      entranceAnimation: {
        type: "zoom-in",
        durationInFrames: 18,
      },
      exitAnimation: {
        type: "fade",
        durationInFrames: 12,
      },
    });
  });

  it("edits plain text layout fields that are honored by the renderer", () => {
    const text: TextItem = {
      id: "title",
      type: "text",
      text: "Launch",
      color: "#ffffff",
      from: 0,
      durationInFrames: 90,
    };
    const stateRef = renderInspector(text);

    chooseInspectorOption("Text alignment", "Left");
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Text letter spacing in pixels" }),
      {
        target: { value: "3" },
      },
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Text line height" }),
      {
        target: { value: "1.3" },
      },
    );

    expect(latestItem<TextItem>(stateRef)).toMatchObject({
      textAlign: "left",
      letterSpacingPx: 3,
      lineHeight: 1.3,
    });
  });

  it("treats timed subtitles as Captions and edits their rendered style instead of stale aggregate text", () => {
    const captions: TextItem = {
      id: "captions",
      type: "text",
      text: "Hello\nworld",
      color: "#ffffff",
      from: 0,
      durationInFrames: 90,
      cues: [
        { id: "a", startFrame: 0, durationInFrames: 30, text: "Hello" },
        { id: "b", startFrame: 30, durationInFrames: 30, text: "world" },
      ],
      style: {
        color: "#ffffff",
        backgroundColor: "#000000",
        position: "bottom",
      },
    };
    const stateRef = renderInspector(captions, { role: "subtitle" });

    expect(screen.getByText("Captions")).toBeTruthy();
    // Subtitle tracks normalize continuous cue collections into editable
    // sentence Text stickers. The selected sticker therefore owns one cue.
    expect(screen.getByText("1 cue")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Text content" })).toBeNull();
    chooseInspectorOption("Caption position", "Top");
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Caption font size" }),
      {
        target: { value: "58" },
      },
    );
    chooseInspectorOption("Caption font weight", "Extra bold");

    expect(latestItem<TextItem>(stateRef).style).toMatchObject({
      position: "top",
      fontSize: 58,
      fontWeight: 800,
      backgroundColor: "#000000",
    });
  });

  it("shows a live Remotion composition identity without exposing the removed MG spec editor", () => {
    const composition: CompositionItem = {
      id: "live-card",
      type: "composition",
      compositionKind: "custom",
      runtime: "remotion",
      compositionId: "LiveCard",
      sourceNodeId: "remotion-node-fixed",
      sourcePath: "components/live-card.tsx",
      spec: { legacy: "must remain inert" },
      from: 0,
      durationInFrames: 90,
    };
    const stateRef = renderInspector(composition);

    expect(screen.getByText("Remotion Component")).toBeTruthy();
    expect(screen.getByText("remotion-node-fixed")).toBeTruthy();
    expect(
      screen.queryByRole("searchbox", { name: "Search MG layers" }),
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: "MG background" })).toBeNull();
    expect(latestItem<CompositionItem>(stateRef).spec).toEqual({
      legacy: "must remain inert",
    });
  });

  it("edits image fade colors as real renderer-backed fields", () => {
    const image: ImageItem = {
      id: "still",
      type: "image",
      src: "still.png",
      from: 0,
      durationInFrames: 90,
      imageFadeInColor: "#ffffff",
      imageFadeOutColor: "#000000",
    };
    const stateRef = renderInspector(image);

    fireEvent.change(
      screen.getByRole("textbox", { name: "Image fade in color" }),
      {
        target: { value: "#ff6b50" },
      },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Image fade out color" }),
      {
        target: { value: "#172033" },
      },
    );

    expect(latestItem<ImageItem>(stateRef)).toMatchObject({
      imageFadeInColor: "#ff6b50",
      imageFadeOutColor: "#172033",
    });
  });

  it("shows immutable derived-media provenance without fake editable identity fields", () => {
    const item: DerivedOverlayItem = {
      id: "derived",
      type: "derived-overlay",
      mediaType: "video",
      src: "generated/caption-burn.mp4",
      sourceAssetId: "asset-source",
      derivedAssetId: "asset-derived",
      derivation: {
        kind: "caption-burn",
        description: "Burned approved captions into a copy",
      },
      from: 0,
      durationInFrames: 90,
    };
    renderInspector(item);

    expect(screen.getByText("Derived Media")).toBeTruthy();
    expect(screen.getByText("asset-source")).toBeTruthy();
    expect(screen.getByText("asset-derived")).toBeTruthy();
    expect(
      screen.getByText("Burned approved captions into a copy"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Source asset ID" }),
    ).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Derived asset ID" }),
    ).toBeNull();
  });
});
