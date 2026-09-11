import { describe, expect, it, vi } from "vitest";
import { LoroDoc, UndoManager } from "loro-crdt";
import { commitProjectMutation } from "./project-mutation.js";
import {
  createTimelineOnCanvas,
  ensureProjectCanvas,
  readProjectTimeline,
  reconcileProjectTimelineOwnership,
} from "./project-workspace.js";
import {
  createDefaultDirectorStageState,
  createDirectorStageOnCanvas,
  readProjectDirectorStage,
  reconcileProjectDirectorStageOwnership,
} from "./director-stage.js";
import { Canvas } from "./canvas-ops.js";

const operations = [
  {
    name: "Timeline",
    create: createTimelineOnCanvas,
    state: () => ({ tracks: [] }),
    read: readProjectTimeline,
  },
  {
    name: "Director Stage",
    create: createDirectorStageOnCanvas,
    state: createDefaultDirectorStageState,
    read: readProjectDirectorStage,
  },
];

describe.each(operations)(
  "atomic $name creation",
  ({ create, state, read }) => {
    it.each([false, true])(
      "publishes the entity, node and ownership together (explicit canvas=%s)",
      (explicit) => {
        const doc = new LoroDoc();
        if (explicit) ensureProjectCanvas(doc, "shots", "Shots");
        doc.commit();
        const remote = doc.fork();
        const canvasId = explicit ? "shots" : "main";
        const observe = vi.fn((update: Uint8Array) => {
          remote.import(update);
          expect(read(remote, "created")?.owner).toEqual({
            kind: "canvas-action",
            canvasId,
            actionNodeId: "editor",
          });
          expect(
            new Canvas(remote, () => {}, canvasId).readNode("editor"),
          ).not.toBeNull();
          expect(reconcileProjectTimelineOwnership(remote)).toEqual({
            removedActionNodeIds: [],
            detachedTimelineIds: [],
          });
          expect(reconcileProjectDirectorStageOwnership(remote)).toEqual({
            removedActionNodeIds: [],
            detachedStageIds: [],
          });
        });
        doc.subscribeLocalUpdates(observe);
        expect(
          create(doc, {
            id: "created",
            name: "New editor",
            state: state(),
            canvasId,
            actionNodeId: "editor",
          }).ok,
        ).toBe(true);
        expect(observe).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["missing canvas", "occupied node"])(
      "leaves no partial entity or fallback canvas on %s",
      (failure) => {
        const doc = new LoroDoc();
        if (failure === "occupied node")
          doc
            .getMap("nodes")
            .set("editor", {
              type: "text",
              data: { content: "Existing" },
              position: { x: 0, y: 0 },
            });
        doc.commit();
        const before = doc.toJSON();
        const updates = vi.fn();
        doc.subscribeLocalUpdates(updates);
        const result = create(doc, {
          id: "created",
          name: "New editor",
          state: state(),
          canvasId: failure === "missing canvas" ? "missing" : "main",
          actionNodeId: "editor",
        });
        expect(result.ok).toBe(false);
        doc.commit();
        expect(doc.toJSON()).toEqual(before);
        expect(updates).not.toHaveBeenCalled();
      },
    );

    it("undoes and redoes the whole creation as one local edit", () => {
      const doc = new LoroDoc();
      ensureProjectCanvas(doc);
      doc.commit();
      const undo = new UndoManager(doc, { mergeInterval: 0 });
      expect(
        create(doc, {
          id: "created",
          name: "New editor",
          state: state(),
          canvasId: "main",
          actionNodeId: "editor",
        }).ok,
      ).toBe(true);
      undo.undo();
      expect(read(doc, "created")).toBeNull();
      expect(new Canvas(doc, () => {}).readNode("editor")).toBeNull();
      undo.redo();
      expect(read(doc, "created")?.owner.kind).toBe("canvas-action");
      expect(new Canvas(doc, () => {}).readNode("editor")).not.toBeNull();
    });
  },
);

it("discards draft writes even if a nested operation exports and then throws", () => {
  const doc = new LoroDoc();
  const updates = vi.fn();
  doc.subscribeLocalUpdates(updates);
  expect(() =>
    commitProjectMutation(doc, (draft) => {
      draft.getMap("nodes").set("partial", { type: "text" });
      draft.export({ mode: "snapshot" });
      throw new Error("Failed after nested export");
    }),
  ).toThrow("Failed after nested export");
  expect(doc.getMap("nodes").get("partial")).toBeUndefined();
  expect(updates).not.toHaveBeenCalled();
});
