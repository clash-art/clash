import { describe, expect, it } from "vitest";

import {
  appendHtmlMotionToTimelineState,
  deriveHtmlMotionConnectionUpdate,
} from "./htmlMotionTimeline";

describe("appendHtmlMotionToTimelineState", () => {
  it("adds a live motion-graphics HTML item that references the Canvas node id", () => {
    const next = appendHtmlMotionToTimelineState(
      {
        tracks: [],
        compositionWidth: 1920,
        compositionHeight: 1080,
        fps: 30,
        durationInFrames: 180,
      },
      {
        nodeId: "html-lower-third",
        documentId: "LowerThird",
        label: "Lower third",
        durationInFrames: 90,
      },
    );

    expect(next.tracks).toHaveLength(1);
    expect(next.tracks[0]).toMatchObject({
      role: "overlay",
      category: "visual",
      name: "HTML Motion",
    });
    expect(next.tracks[0]?.items).toEqual([
      expect.objectContaining({
        type: "composition",
        runtime: "html",
        compositionKind: "motion-graphics",
        compositionId: "LowerThird",
        sourceNodeId: "html-lower-third",
        sourcePath: "html-motion/html-lower-third.html",
        from: 0,
        durationInFrames: 90,
      }),
    ]);
  });

  it("keeps the reference stable and does not snapshot HTML source", () => {
    const next = appendHtmlMotionToTimelineState(
      { tracks: [] },
      {
        nodeId: "fixed-html-node",
        documentId: "Card",
        label: "Card",
        durationInFrames: 60,
      },
    );

    const item = next.tracks[0]?.items[0] as Record<string, unknown>;
    expect(item.sourceNodeId).toBe("fixed-html-node");
    expect(item).not.toHaveProperty("content");
    expect(item).not.toHaveProperty("renderedAssetPath");
    expect(item).not.toHaveProperty("spec");
  });

  it("reuses an existing visual overlay track", () => {
    const next = appendHtmlMotionToTimelineState(
      {
        tracks: [
          {
            id: "visual-overlays",
            name: "Overlays",
            role: "overlay",
            category: "visual",
            items: [],
          },
        ],
      },
      {
        nodeId: "fixed-html-node",
        documentId: "Card",
        label: "Card",
        durationInFrames: 60,
      },
    );

    expect(next.tracks).toHaveLength(1);
    expect(next.tracks[0]?.id).toBe("visual-overlays");
    expect(next.tracks[0]?.items).toHaveLength(1);
  });

  it("is idempotent for the same sourceNodeId", () => {
    const first = appendHtmlMotionToTimelineState(
      { tracks: [] },
      {
        nodeId: "same-node",
        documentId: "A",
        label: "A",
        durationInFrames: 30,
      },
    );
    const second = appendHtmlMotionToTimelineState(first, {
      nodeId: "same-node",
      documentId: "A",
      label: "A",
      durationInFrames: 30,
    });
    expect(second).toBe(first);
  });
});

describe("deriveHtmlMotionConnectionUpdate", () => {
  it("wires html-motion → video-editor into a live HTML Timeline item", () => {
    const update = deriveHtmlMotionConnectionUpdate({
      sourceId: "html-1",
      targetId: "editor-1",
      nodes: [
        {
          id: "html-1",
          type: "html-motion",
          data: {
            documentId: "Intro",
            label: "Intro card",
            durationInFrames: 45,
          },
        },
        {
          id: "editor-1",
          type: "video-editor",
          data: { timelineId: "tl-1" },
        },
      ],
      timelines: [{ id: "tl-1", state: { tracks: [] } }],
    });

    expect(update?.timelineId).toBe("tl-1");
    expect(update?.state.tracks[0]?.items[0]).toMatchObject({
      runtime: "html",
      compositionKind: "motion-graphics",
      sourceNodeId: "html-1",
      compositionId: "Intro",
      durationInFrames: 45,
    });
  });

  it("ignores non html-motion sources", () => {
    expect(
      deriveHtmlMotionConnectionUpdate({
        sourceId: "remotion-1",
        targetId: "editor-1",
        nodes: [
          { id: "remotion-1", type: "remotion-component", data: {} },
          {
            id: "editor-1",
            type: "video-editor",
            data: { timelineId: "tl-1" },
          },
        ],
        timelines: [{ id: "tl-1", state: { tracks: [] } }],
      }),
    ).toBeNull();
  });
});
