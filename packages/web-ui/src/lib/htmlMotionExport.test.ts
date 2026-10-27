import { describe, expect, it } from "vitest";
import {
  hydrateHtmlMotionSourcesForExport,
  validateHtmlMotionExportReadiness,
  HTML_MOTION_EXPORT_PARITY,
  HTML_MOTION_LEGACY_POLICY,
} from "./htmlMotionExport";

const tracks = [
  {
    id: "t1",
    items: [
      {
        id: "html-1",
        type: "composition",
        compositionKind: "motion-graphics",
        runtime: "html",
        compositionId: "doc-1",
        sourceNodeId: "node-html",
        sourcePath: "html-motion/node-html.html",
        from: 0,
        durationInFrames: 90,
      },
      {
        id: "rem-1",
        type: "composition",
        runtime: "remotion",
        sourceNodeId: "node-rem",
        from: 0,
        durationInFrames: 90,
      },
    ],
  },
];

const nodes = {
  "node-html": {
    type: "html-motion",
    data: { content: "<html><body>Hello MG</body></html>", documentId: "doc-1" },
  },
};

describe("htmlMotionExport", () => {
  it("hydrates htmlSource from Canvas html-motion nodes", () => {
    const hydrated = hydrateHtmlMotionSourcesForExport(tracks, nodes);
    const item = (hydrated[0] as { items: Array<{ id: string; htmlSource?: string }> }).items[0];
    expect(item.htmlSource).toContain("Hello MG");
    const rem = (hydrated[0] as { items: Array<{ htmlSource?: string }> }).items[1];
    expect(rem.htmlSource).toBeUndefined();
  });

  it("reports readiness failures for missing sources", () => {
    const result = validateHtmlMotionExportReadiness(tracks, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingSourceNodeIds).toContain("node-html");
  });

  it("documents parity + coexist policy", () => {
    expect(HTML_MOTION_EXPORT_PARITY.identity).toBe("sourceNodeId");
    expect(HTML_MOTION_LEGACY_POLICY.decision).toBe("coexist");
    expect(HTML_MOTION_LEGACY_POLICY.bannedTokens).toContain("MgCompositionSpec");
  });
});
