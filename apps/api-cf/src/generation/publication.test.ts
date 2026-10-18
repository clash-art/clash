import { describe, expect, it } from "vitest";
import { Canvas } from "@clash/shared-types";
import { LoroDoc } from "loro-crdt";
import {
  claimHostedGenerationNode,
  GenerationPublicationConflict,
  generationAdmissionUpdate,
  generationPublicationUpdate,
} from "./publication";
import { Status } from "../domain/canvas";

describe("hosted generation projection", () => {
  it("prepares on a detached replica, publishes once and rejects a late result for another task", async () => {
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
    const update = (await generationPublicationUpdate(doc, publication))!;
    expect(canvas.readNode("node")?.data.content).toBe("draft");
    doc.import(update);
    expect(canvas.readNode("node")?.data).toMatchObject({
      content: "result",
      status: Status.Completed,
      generationRunId: "first",
    });
    expect(await generationPublicationUpdate(doc, publication)).toBeNull();
    doc.import(
      generationAdmissionUpdate(doc, { ...publication, taskId: "next" })!,
    );
    await expect(generationPublicationUpdate(doc, publication)).rejects.toThrow(
      /different task/,
    );
    expect(canvas.readNode("node")?.data.pendingTask).toBe("next");
    doc.free();
  });
});

it("projects a failed run's message and code, and a retried run's success clears both", async () => {
  const doc = new LoroDoc();
  const canvas = new Canvas(doc, () => undefined);
  canvas.createNode("node", "image", { status: Status.Pending });
  const failed = {
    taskId: "first",
    nodeId: "node",
    actorUserId: "user",
    updates: {},
    failure: { code: "contract_violation" as const, message: "Bad output" },
  };
  doc.import(generationAdmissionUpdate(doc, failed)!);
  doc.import((await generationPublicationUpdate(doc, failed))!);
  expect(canvas.readNode("node")?.data).toMatchObject({
    status: Status.Failed,
    error: "Bad output",
    errorCode: "contract_violation",
  });
  // A redelivered failure is idempotent.
  expect(await generationPublicationUpdate(doc, failed)).toBeNull();

  const retry = {
    taskId: "second",
    nodeId: "node",
    actorUserId: "user",
    updates: { assetId: "asset-1" },
  };
  doc.import(generationAdmissionUpdate(doc, retry)!);
  expect(canvas.readNode("node")?.data).toMatchObject({
    status: Status.Generating,
  });
  expect(canvas.readNode("node")?.data.error ?? null).toBeNull();
  expect(canvas.readNode("node")?.data.errorCode ?? null).toBeNull();
  doc.import((await generationPublicationUpdate(doc, retry))!);
  const data = canvas.readNode("node")?.data;
  expect(data).toMatchObject({ status: Status.Completed, assetId: "asset-1" });
  expect(data?.error ?? null).toBeNull();
  expect(data?.errorCode ?? null).toBeNull();
  doc.free();
});

it("success clears a failure left on a node that was re-claimed without admission", async () => {
  const doc = new LoroDoc();
  const canvas = new Canvas(doc, () => undefined);
  canvas.createNode("node", "image", {
    status: Status.Generating,
    pendingTask: "run",
    error: "Run exceeded its deadline",
    errorCode: "deadline_exceeded",
  });
  doc.import(
    (await generationPublicationUpdate(doc, {
      taskId: "run",
      nodeId: "node",
      actorUserId: "user",
      updates: { assetId: "asset-1" },
    }))!,
  );
  const data = canvas.readNode("node")?.data;
  expect(data?.status).toBe(Status.Completed);
  expect(data?.error ?? null).toBeNull();
  expect(data?.errorCode ?? null).toBeNull();
  doc.free();
});

it("acknowledges obsolete terminal failure without touching a replacement task", async () => {
  const doc = new LoroDoc();
  const canvas = new Canvas(doc, () => undefined);
  canvas.createNode("node", "text", {
    pendingTask: "new-task",
    content: "new content",
  });
  expect(
    await generationPublicationUpdate(doc, {
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

describe("Project room admission errors", () => {
  const params = {
    taskId: "task-1",
    nodeId: "node-1",
    projectId: "project-1",
    type: "image_gen",
    actorUserId: "user-1",
  } as never;
  const roomReplying = (response: Response) =>
    ({
      ROOM: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => response }),
      },
    }) as never;

  it("carries the room's code and cause instead of a bare HTTP status", async () => {
    const error = await claimHostedGenerationNode(
      roomReplying(
        Response.json(
          { error: "generation-admission failed in the Project room: storage write timed out", code: "GENERATION_PUBLICATION_FAILED" },
          { status: 503 },
        ),
      ),
      params,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GenerationPublicationConflict);
    expect((error as Error).message).toBe(
      "Project generation admission unavailable (HTTP 503, GENERATION_PUBLICATION_FAILED): generation-admission failed in the Project room: storage write timed out",
    );
    expect(error).toMatchObject({ status: 503, code: "GENERATION_PUBLICATION_FAILED" });
  });

  it("names an unreadable room response explicitly", async () => {
    await expect(
      claimHostedGenerationNode(roomReplying(new Response("upstream reset", { status: 502 })), params),
    ).rejects.toThrow(
      "Project generation admission unavailable (HTTP 502, PROJECT_ROOM_RESPONSE_UNREADABLE): the Project room returned no error message",
    );
  });

  it("keeps a room rejection a conflict, with its reason", async () => {
    const error = await claimHostedGenerationNode(
      roomReplying(Response.json({ error: "Generation node is missing.", code: "GENERATION_PUBLICATION_CONFLICT" }, { status: 409 })),
      params,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenerationPublicationConflict);
    expect((error as Error).message).toBe(
      "Project generation admission rejected (HTTP 409, GENERATION_PUBLICATION_CONFLICT): Generation node is missing.",
    );
  });
});
