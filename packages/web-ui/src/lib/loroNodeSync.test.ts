import { LoroDoc } from "loro-crdt";
import { Canvas } from "@clash/shared-types";
import { expect, it } from "vitest";
import { applyCanvasLayout } from "./loroNodeSync";

it("rejects an entire layout when a later node has downstream references", () => {
  const doc = new LoroDoc();
  const canvas = new Canvas(doc, () => {});
  try {
    for (const id of ["editable", "source", "target"])
      canvas.createNode(id, "text", { content: id });
    canvas.insertEdge("reference", "source", "target");
    const before = doc.toJSON();
    expect(() =>
      applyCanvasLayout(doc, "main", [
        { id: "editable", patch: { position: { x: 123, y: 456 } } },
        { id: "source", patch: { position: { x: 789, y: 456 } } },
      ]),
    ).toThrow(/IMMUTABLE_NODE/);
    expect(doc.toJSON()).toEqual(before);
  } finally {
    doc.free();
  }
});

it("publishes only complete layout updates to sync observers", () => {
  const doc = new LoroDoc();
  const canvas = new Canvas(doc, () => {});
  for (const id of ["first", "second"])
    canvas.createNode(id, "text", { content: id });
  const observer = LoroDoc.fromSnapshot(doc.export({ mode: "snapshot" }));
  const positions = [
    { x: 123, y: 456 },
    { x: 789, y: 456 },
  ];
  const received: unknown[] = [];
  const unsubscribe = doc.subscribeLocalUpdates((bytes) => {
    observer.import(bytes);
    const view = new Canvas(observer, () => {});
    received.push([
      view.readNode("first")?.position,
      view.readNode("second")?.position,
    ]);
  });
  try {
    applyCanvasLayout(
      doc,
      "main",
      ["first", "second"].map((id, i) => ({
        id,
        patch: { position: positions[i] },
      })),
    );
    expect(received).not.toEqual([]);
    for (const snapshot of received) expect(snapshot).toEqual(positions);
  } finally {
    unsubscribe();
    observer.free();
    doc.free();
  }
});
