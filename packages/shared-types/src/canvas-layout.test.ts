import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";

import {
  CANVAS_NODE_LAYOUTS,
  assertCanvasLayoutMutation,
} from "./canvas-layout.js";

function docsWithNode(): { current: LoroDoc; candidate: LoroDoc } {
  const current = new LoroDoc();
  current.getMap("nodes").set("node", {
    id: "node",
    type: "image",
    canvasId: "main",
    data: {},
  });
  current.commit();
  const candidate = LoroDoc.fromSnapshot(current.export({ mode: "snapshot" }));
  return { current, candidate };
}

function outcome(
  current: LoroDoc,
  candidate: LoroDoc,
  changedIds?: ReadonlySet<string>,
): "ok" | string {
  try {
    assertCanvasLayoutMutation(current, candidate, changedIds);
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("assertCanvasLayoutMutation", () => {
  it("accepts a deleted layout with and without changedIds", () => {
    const { current, candidate } = docsWithNode();
    current
      .getMap(CANVAS_NODE_LAYOUTS)
      .set("node", { position: { x: 12, y: 24 } });
    current.commit();
    candidate.import(current.export({ mode: "snapshot" }));
    candidate.getMap(CANVAS_NODE_LAYOUTS).delete("node");

    try {
      expect(() =>
        assertCanvasLayoutMutation(current, candidate),
      ).not.toThrow();
      expect(() =>
        assertCanvasLayoutMutation(current, candidate, new Set(["node"])),
      ).not.toThrow();
    } finally {
      current.free();
      candidate.free();
    }
  });

  it("matches the full scan for add, update, and delete", () => {
    const scenarios: Array<{
      name: string;
      prepare: (doc: LoroDoc) => void;
    }> = [
      {
        name: "add",
        prepare: (doc) =>
          doc
            .getMap(CANVAS_NODE_LAYOUTS)
            .set("node", { position: { x: 1, y: 2 } }),
      },
      {
        name: "update",
        prepare: (doc) =>
          doc
            .getMap(CANVAS_NODE_LAYOUTS)
            .set("node", { position: { x: 99, y: 100 } }),
      },
      {
        name: "delete",
        prepare: (doc) => doc.getMap(CANVAS_NODE_LAYOUTS).delete("node"),
      },
    ];

    for (const scenario of scenarios) {
      const { current, candidate } = docsWithNode();
      if (scenario.name !== "add") {
        current
          .getMap(CANVAS_NODE_LAYOUTS)
          .set("node", { position: { x: 12, y: 24 } });
        current.commit();
        candidate.import(current.export({ mode: "snapshot" }));
      }
      scenario.prepare(candidate);
      candidate.commit();
      try {
        const fullScan = outcome(current, candidate);
        const changedOnly = outcome(current, candidate, new Set(["node"]));
        expect(fullScan).toBe("ok");
        expect(changedOnly).toBe(fullScan);
      } finally {
        current.free();
        candidate.free();
      }
    }
  });

  it("still validates an invalid layout when the id is supplied", () => {
    const { current, candidate } = docsWithNode();
    candidate
      .getMap(CANVAS_NODE_LAYOUTS)
      .set("node", { position: { x: Infinity, y: 0 } });
    candidate.commit();

    try {
      const expected = outcome(current, candidate);
      expect(expected).not.toBe("ok");
      expect(outcome(current, candidate, new Set(["node"]))).toBe(expected);
    } finally {
      current.free();
      candidate.free();
    }
  });
});
