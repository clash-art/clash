import { expect, it } from "vitest";
import { loadTimelineDefinition } from "./timeline-definition.ts";
import { LoroDoc } from "loro-crdt";
import { createLocalTimelineGenerator } from "@clash/shared-runtime/timeline-generator-product";
it("loads the shipped Timeline plugin contract for project editing", () => {
  const definition = loadTimelineDefinition();
  const doc = new LoroDoc();
  try {
    const result = createLocalTimelineGenerator(doc, definition, {
      id: "timeline",
      name: "My timeline",
      owner: { kind: "project" },
      revisionId: "genesis",
      state: { tracks: [] },
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.timeline).toMatchObject({
        name: "My timeline",
        state: { tracks: [] },
      });
  } finally {
    doc.free();
  }
});
