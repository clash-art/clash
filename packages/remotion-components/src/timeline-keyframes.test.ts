import { describe, expect, it } from "vitest";
import type { ImageItem } from "@clash/remotion-core";
import {
  computeTimelineItemMaskClipPath,
  computeTimelineItemMaskGeometry,
  computeTimelineItemMaskStyle,
  computeTimelineItemLocalFrame,
  computeTimelineItemTransformStyle,
  mergeContiguousMediaItems,
} from "./VideoComposition";

describe("Timeline item keyframe rendering", () => {
  it("encodes feathered inverted masks as a raster alpha mask", () => {
    const item: ImageItem = {
      id: "masked",
      type: "image",
      src: "image.png",
      from: 0,
      durationInFrames: 30,
      mask: {
        shape: "ellipse",
        position: [50, 40],
        size: [60, 30],
        rotation: 90,
        feather: 25,
        inverted: true,
      },
    };

    const style = computeTimelineItemMaskStyle({
      item,
      itemLocalFrame: 0,
      renderedWidth: 1600,
      renderedHeight: 900,
    });
    const geometry = computeTimelineItemMaskGeometry({
      item,
      itemLocalFrame: 0,
      renderedWidth: 1600,
      renderedHeight: 900,
    });

    expect(String(style.maskImage)).toMatch(
      /^url\("data:image\/png;base64,/,
    );
    expect(style.WebkitMaskImage).toBe(style.maskImage);
    expect(style.maskPosition).toBe("0% 0%");
    expect(style.maskSize).toBe("100% 100%");
    expect(geometry?.featherPixels).toBeCloseTo(11.25, 5);
    expect(geometry?.inverted).toBe(true);
    expect(geometry?.primitive).toBe("ellipse");
  });

  it("uses clip-path for unfeathered masks and rotates polygons in physical space", () => {
    const item: ImageItem = {
      id: "masked",
      type: "image",
      src: "image.png",
      from: 0,
      durationInFrames: 30,
      mask: {
        shape: "rectangle",
        position: [50, 50],
        size: [40, 20],
        rotation: 90,
        feather: 0,
        inverted: false,
      },
    };
    const geometry = computeTimelineItemMaskGeometry({
      item,
      itemLocalFrame: 0,
      renderedWidth: 1600,
      renderedHeight: 900,
    });
    expect(geometry).not.toBeNull();

    const style = computeTimelineItemMaskStyle({
      item,
      itemLocalFrame: 0,
      renderedWidth: 1600,
      renderedHeight: 900,
    });
    expect(style.maskImage).toBeUndefined();
    expect(String(style.clipPath)).toMatch(/^polygon\(/);
    expect(
      computeTimelineItemMaskClipPath(geometry!, 1600, 900),
    ).toContain("55.625% 14.4444%");
  });

  it("derives item-local time from composition time even for the contiguous-sequence offset", () => {
    expect(computeTimelineItemLocalFrame({
      sequenceFrame: 1,
      sequenceFrom: 99,
      itemFrom: 100,
    })).toBe(0);
  });

  it("applies sampled transform channels over the static item size", () => {
    const item: ImageItem & { naturalWidth: number; naturalHeight: number } = {
      id: "overlay",
      type: "image",
      src: "overlay.png",
      from: 100,
      durationInFrames: 21,
      naturalWidth: 200,
      naturalHeight: 100,
      properties: {
        x: 10,
        y: 20,
        width: 0.5,
        height: 0.5,
        rotation: 0,
        opacity: 1,
      },
      keyframes: {
        position: [
          { frame: 0, value: [0, 0], interpolation: "linear" },
          { frame: 20, value: [100, 50], interpolation: "linear" },
        ],
        scale: [
          { frame: 0, value: [1, 1], interpolation: "linear" },
          { frame: 20, value: [2, 0.5], interpolation: "linear" },
        ],
        rotation: [
          { frame: 0, value: 0, interpolation: "linear" },
          { frame: 20, value: 90, interpolation: "linear" },
        ],
        opacity: [
          { frame: 0, value: 0, interpolation: "linear" },
          { frame: 20, value: 1, interpolation: "linear" },
        ],
      },
    };

    expect(computeTimelineItemTransformStyle({
      item,
      itemLocalFrame: 10,
      compositionWidth: 1000,
      compositionHeight: 500,
    })).toEqual({
      position: "absolute",
      left: "calc(50% + 50px)",
      top: "calc(50% + 25px)",
      width: "10%",
      height: "10%",
      transform: "translate(-50%, -50%) rotate(45deg) scale(1.5, 0.75)",
      opacity: 0.5,
    });
  });

  it("does not merge contiguous source clips when either clip owns item-local keyframes", () => {
    const first = {
      id: "first",
      type: "video" as const,
      src: "clip.mp4",
      resolvedSrcUrl: "/clip.mp4",
      from: 0,
      durationInFrames: 20,
      sourceStartInFrames: 0,
      keyframes: {
        opacity: [
          { frame: 0, value: 0, interpolation: "linear" as const },
          { frame: 19, value: 1, interpolation: "linear" as const },
        ],
      },
    };
    const second = {
      ...first,
      id: "second",
      from: 20,
      sourceStartInFrames: 20,
      keyframes: {
        opacity: [
          { frame: 0, value: 1, interpolation: "linear" as const },
          { frame: 19, value: 0, interpolation: "linear" as const },
        ],
      },
    };

    expect(mergeContiguousMediaItems([first, second]).map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("does not merge contiguous clips when either clip owns a mask", () => {
    const first = {
      id: "first",
      type: "video" as const,
      src: "clip.mp4",
      resolvedSrcUrl: "/clip.mp4",
      from: 0,
      durationInFrames: 20,
      sourceStartInFrames: 0,
      mask: {
        shape: "ellipse" as const,
        position: [50, 50] as const,
        size: [70, 70] as const,
        rotation: 0,
        feather: 0,
        inverted: false,
      },
    };
    const second = {
      ...first,
      id: "second",
      from: 20,
      sourceStartInFrames: 20,
      mask: undefined,
    };

    expect(mergeContiguousMediaItems([first, second]).map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
  });
});
