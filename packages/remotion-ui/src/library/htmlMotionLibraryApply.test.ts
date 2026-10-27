import { describe, expect, it } from "vitest";
import { buildHtmlMotionLibraryApplyActions } from "./htmlMotionLibraryApply";

describe("buildHtmlMotionLibraryApplyActions", () => {
  it("adds a track when no overlay exists", () => {
    const result = buildHtmlMotionLibraryApplyActions(
      { tracks: [] },
      {
        nodeId: "n1",
        documentId: "d1",
        label: "Lower Third",
        durationInFrames: 90,
      },
      (p) => p,
    );
    expect(result.disabledReason).toBeUndefined();
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe("ADD_TRACK");
  });

  it("refuses duplicate sourceNodeId", () => {
    const result = buildHtmlMotionLibraryApplyActions(
      {
        tracks: [
          {
            id: "t1",
            name: "HTML Motion",
            role: "overlay",
            category: "visual",
            items: [
              {
                id: "existing",
                type: "composition",
                compositionKind: "motion-graphics",
                runtime: "html",
                compositionId: "d1",
                sourceNodeId: "n1",
                sourcePath: "html-motion/n1.html",
                from: 0,
                durationInFrames: 90,
              },
            ],
          },
        ],
      },
      {
        nodeId: "n1",
        documentId: "d1",
        label: "Lower Third",
        durationInFrames: 90,
      },
    );
    expect(result.actions).toEqual([]);
    expect(result.disabledReason).toMatch(/already linked/i);
  });
});
