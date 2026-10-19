import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";

import type {
  CachedProjectCanvasPreview,
  FileReplicaStore,
} from "./loro/file-replica-store.js";
import {
  projectCanvasDocVersion,
  projectCanvasPreviewCacheEntryFromDoc,
  readThroughProjectCanvasPreviewEntry,
} from "./project-canvas-preview-cache.js";

function memoryStore(initial: CachedProjectCanvasPreview | null = null) {
  let cached = initial;
  return {
    readCanvasPreview: async () => cached,
    writeCanvasPreview: async (
      _projectId: string,
      entry: CachedProjectCanvasPreview,
    ) => {
      cached = entry;
    },
    current: () => cached,
  };
}

function canvasDoc(): LoroDoc {
  const doc = new LoroDoc();
  doc.getMap("timelines").set("timeline", { id: "timeline" });
  doc.commit();
  return doc;
}

describe("readThroughProjectCanvasPreviewEntry", () => {
  it("does not invalidate a timeline-only edit", async () => {
    const doc = canvasDoc();
    const store = memoryStore();
    const options = {
      projectId: "project-1",
      store: store as unknown as FileReplicaStore,
      inspect: async <T>(read: (doc: LoroDoc) => T | Promise<T>) => read(doc),
    };

    const first = await readThroughProjectCanvasPreviewEntry(options);
    doc.getMap("timelines").set("timeline", { id: "timeline", name: "cut" });
    doc.commit();
    const second = await readThroughProjectCanvasPreviewEntry(options);

    expect(second.docVersion).not.toBe(first.docVersion);
    expect(second.sourceVersion).toBe(first.sourceVersion);
    expect(store.current()?.docVersion).toBe(second.docVersion);
  });

  it("regenerates a preview left stale by a Host stop inside the debounce", async () => {
    const doc = canvasDoc();
    const stale = projectCanvasPreviewCacheEntryFromDoc(doc);
    doc.getMap("nodes").set("hero", {
      canvasId: "main",
      type: "image",
      position: { x: 0, y: 0 },
      width: 320,
      height: 180,
      data: { assetId: "asset-hero" },
    });
    doc.commit();
    const store = memoryStore({
      ...stale,
      preview: { ...stale.preview, bounds: null, nodes: [] },
    });

    const entry = await readThroughProjectCanvasPreviewEntry({
      projectId: "project-1",
      store: store as unknown as FileReplicaStore,
      inspect: async <T>(read: (doc: LoroDoc) => T | Promise<T>) => read(doc),
    });

    expect(entry.docVersion).toBe(projectCanvasDocVersion(doc));
    expect(entry.preview.nodes.map((node) => node.id)).toEqual(["hero"]);
    expect(store.current()?.preview.nodes.map((node) => node.id)).toEqual([
      "hero",
    ]);
  });
});
