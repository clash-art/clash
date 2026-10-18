import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { MODEL_CARDS } from "@clash/shared-types";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalWorkflowProcessor } from "./local-processor.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("does not resolve Model Cards while opening a project with no pending work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-processor-lazy-cards-"));
  roots.push(dataDir);
  const modelCards = vi.fn(async () => MODEL_CARDS);
  const processor = createLocalWorkflowProcessor({ dataDir, modelCards });
  const doc = new LoroDoc();
  try {
    await processor.process({
      doc,
      projectId: "plain",
      broadcastJson: () => {},
      checkpoint: async () => {},
    });
    expect(modelCards).not.toHaveBeenCalled();
  } finally {
    doc.free();
  }
});
