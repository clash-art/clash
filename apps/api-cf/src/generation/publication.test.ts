import { describe, expect, it } from "vitest";
import { Canvas } from "@clash/shared-types";
import { LoroDoc } from "loro-crdt";
import {
  generationAdmissionUpdate,
  generationPublicationUpdate,
} from "./publication";
import { Status } from "../domain/canvas";

describe("hosted generation projection", () => {
  it("prepares on a detached replica, publishes once and rejects a late result for another task", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => undefined);
    canvas.createNode("node", "text", { content: "draft" });
    const publication = {
      taskId: "first",
      nodeId: "node",
      actorUserId: "user",
      updates: { content: "result" },
    };
    const claim = generationAdmissionUpdate(doc, publication)!;
    expect(canvas.readNode("node")?.data.pendingTask).toBeUndefined();
    doc.import(claim);
    const update = generationPublicationUpdate(doc, publication)!;
    expect(canvas.readNode("node")?.data.content).toBe("draft");
    doc.import(update);
    expect(canvas.readNode("node")?.data).toMatchObject({
      content: "result",
      status: Status.Completed,
      generationRunId: "first",
    });
    expect(generationPublicationUpdate(doc, publication)).toBeNull();
    doc.import(
      generationAdmissionUpdate(doc, { ...publication, taskId: "next" })!,
    );
    expect(() => generationPublicationUpdate(doc, publication)).toThrow(
      /different task/,
    );
    expect(canvas.readNode("node")?.data.pendingTask).toBe("next");
    doc.free();
  });
});

it("acknowledges obsolete terminal failure without touching a replacement task", () => {
  const doc = new LoroDoc();
  const canvas = new Canvas(doc, () => undefined);
  canvas.createNode("node", "text", {
    pendingTask: "new-task",
    content: "new content",
  });
  expect(
    generationPublicationUpdate(doc, {
      taskId: "old-task",
      nodeId: "node",
      actorUserId: "user",
      updates: {},
      failure: { code: "publication_failed", message: "failed" },
    }),
  ).toBeNull();
  expect(canvas.readNode("node")?.data).toMatchObject({
    pendingTask: "new-task",
    content: "new content",
  });
  doc.free();
});
