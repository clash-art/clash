import { LoroDoc } from "loro-crdt";
import { Canvas } from "@clash/shared-types";
import { expect, it } from "vitest";
import { addCanvasGraph } from "./addCanvasGraph";

it("publishes a complete copied graph without intermediate node-only updates", () => {
  const doc = new LoroDoc();
  new Canvas(doc, () => {}).createNode("existing", "text", { content: "Keep" });
  const observer = LoroDoc.fromSnapshot(doc.export({ mode: "snapshot" }));
  const received: boolean[] = [];
  const unsubscribe = doc.subscribeLocalUpdates((bytes) => {
    observer.import(bytes);
    const canvas = new Canvas(observer, () => {});
    received.push(
      Boolean(
        canvas.readNode("context") &&
        canvas.readNode("draft") &&
        canvas
          .listEdges()
          .some((edge) => edge.source === "context" && edge.target === "draft"),
      ),
    );
  });
  try {
    addCanvasGraph(
      doc,
      "main",
      [
        { id: "context", type: "text", data: { content: "Reference" } },
        {
          id: "draft",
          type: "action-badge",
          data: {
            actionType: "video-gen",
            modelId: "minimax-h3",
            content: "Scene",
          },
        },
      ],
      [{ id: "context-draft", source: "context", target: "draft" }],
    );
    expect(received).not.toEqual([]);
    expect(received.every(Boolean)).toBe(true);
    expect(new Canvas(doc, () => {}).readNode("existing")?.data.content).toBe(
      "Keep",
    );
    const before = doc.toJSON();
    expect(() =>
      addCanvasGraph(
        doc,
        "main",
        [{ id: "context", type: "text", data: { content: "Overwrite" } }],
        [],
      ),
    ).toThrow(/exists/);
    expect(doc.toJSON()).toEqual(before);
    expect(() =>
      addCanvasGraph(
        doc,
        "main",
        [{ id: "orphan", type: "text" }],
        [{ id: "bad", source: "orphan", target: "missing" }],
      ),
    ).toThrow();
    expect(doc.toJSON()).toEqual(before);
  } finally {
    unsubscribe();
    observer.free();
    doc.free();
  }
});
