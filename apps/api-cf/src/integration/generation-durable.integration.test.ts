import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { Canvas } from "@clash/shared-types";
import { LoroDoc } from "loro-crdt";
import type { Env } from "../config";
import { startGeneration } from "../generation/start";
import { hostedGenerationStatus } from "../generation/status";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import { Status } from "../domain/canvas";
import type { ProjectRoom } from "../agents/project-room";

afterEach(() => {
  vi.restoreAllMocks();
});

it("runs the default dispatcher, registry, receipt broker and publisher against D1/R2/ProjectRoom", async () => {
  const bindings = env as unknown as Env;
  const id = crypto.randomUUID(),
    projectId = `generation-${id}`,
    userId = `user-${id}`,
    taskId = `task-${id}`;
  await bindings.DB.prepare(
    "INSERT INTO project (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(projectId, userId, "Generation", Date.now(), Date.now())
    .run();
  const doc = new LoroDoc();
  new Canvas(doc, () => undefined).createNode("result", "video", {
    label: "Render result",
  });
  const room = bindings.ROOM.get(bindings.ROOM.idFromName(projectId));
  const headers = { "x-internal-loro": "true", "x-loro-project-id": projectId };
  expect(
    (
      await room.fetch(
        new Request(`http://internal/loro/${projectId}/updates`, {
          method: "POST",
          headers,
          body: doc.export({ mode: "snapshot" }),
        }),
      )
    ).status,
  ).toBe(204);
  doc.free();
  const bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112]);
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(bytes, {
        headers: {
          "content-type": "video/mp4",
          "x-render-width": "640",
          "x-render-height": "360",
          "x-render-duration-ms": "1000",
        },
      }),
  );
  await startGeneration(bindings, taskId, {
    taskId,
    nodeId: "result",
    projectId,
    type: "video_render",
    actorType: "user",
    actorUserId: userId,
    timelineDsl: {},
  });
  let status = await hostedGenerationStatus(bindings, taskId);
  for (
    let attempt = 0;
    attempt < 100 &&
    status?.status !== Status.Completed &&
    status?.status !== Status.Failed;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = await hostedGenerationStatus(bindings, taskId);
  }
  if (status?.status === Status.Failed)
    throw new Error(
      JSON.stringify(
        await createD1CloudDurableRunJournal(bindings.DB).load({
          actionRunId: taskId,
          outputSlot: "output",
        }),
      ),
    );
  expect(status).toMatchObject({ status: Status.Completed, assetId: taskId });
  const run = await createD1CloudDurableRunJournal(bindings.DB).load({
    actionRunId: taskId,
    outputSlot: "output",
  });
  expect(run?.providerOutputs?.[0]).toMatchObject({
    kind: "asset",
    asset: { uri: expect.stringMatching(/^clash-asset:\/\//) },
  });
  const asset = await bindings.DB.prepare(
    "SELECT src_r2_key FROM assets WHERE id = ?",
  )
    .bind(taskId)
    .first<{ src_r2_key: string }>();
  expect(
    new Uint8Array(
      await (await bindings.R2_BUCKET.get(asset!.src_r2_key))!.arrayBuffer(),
    ),
  ).toEqual(bytes);
  const workflow = await bindings.GENERATION_WORKFLOW.get(taskId);
  for (
    let attempt = 0;
    attempt < 100 && (await workflow.status()).status !== "complete";
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  await evictDurableObject(room);
  const persisted = new LoroDoc();
  persisted.import(
    new Uint8Array(
      await (
        await room.fetch(
          new Request(`http://internal/loro/${projectId}/snapshot`, {
            headers,
          }),
        )
      ).arrayBuffer(),
    ),
  );
  expect(
    new Canvas(persisted, () => undefined).readNode("result")?.data,
  ).toMatchObject({ assetId: taskId, status: Status.Completed });
  persisted.free();
});

it("recovers a pending render during room initialization without deadlocking on self admission", async () => {
  const bindings = env as unknown as Env;
  const id = crypto.randomUUID(),
    projectId = `init-${id}`,
    userId = `owner-${id}`;
  await bindings.DB.prepare(
    "INSERT INTO project (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(projectId, userId, "Recovery", Date.now(), Date.now())
    .run();
  const doc = new LoroDoc();
  new Canvas(doc, () => undefined).createNode("pending-render", "video", {
    label: "Recovered render",
    status: Status.Pending,
    actorUserId: userId,
    actorType: "user",
    timelineDsl: { tracks: [] },
  });
  const room = bindings.ROOM.get(bindings.ROOM.idFromName(projectId));
  const headers = { "x-internal-loro": "true", "x-loro-project-id": projectId };
  expect(
    (
      await room.fetch(
        new Request(`http://internal/loro/${projectId}/updates`, {
          method: "POST",
          headers,
          body: doc.export({ mode: "snapshot" }),
        }),
      )
    ).status,
  ).toBe(204);
  doc.free();
  await evictDurableObject(room);
  const render = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () =>
        new Response(new Uint8Array([9, 8, 7]), {
          headers: { "content-type": "video/mp4" },
        }),
    );
  const response = await room.fetch(
    new Request(`https://internal/sync/${projectId}`, {
      headers: { Upgrade: "websocket", "x-internal-agent": "true" },
    }),
  );
  expect(response.status).toBe(101);
  response.webSocket!.accept();
  response.webSocket!.close();
  let data: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = new LoroDoc();
    snapshot.import(
      new Uint8Array(
        await (
          await room.fetch(
            new Request(`http://internal/loro/${projectId}/snapshot`, {
              headers,
            }),
          )
        ).arrayBuffer(),
      ),
    );
    data = new Canvas(snapshot, () => undefined).readNode(
      "pending-render",
    )!.data;
    snapshot.free();
    if (data.status === Status.Completed || data.status === Status.Failed)
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(data).toMatchObject({
    status: Status.Completed,
    generationRunId: expect.any(String),
    assetId: expect.any(String),
  });
  expect(render).toHaveBeenCalledTimes(1);
  expect(
    await hostedGenerationStatus(bindings, data.generationRunId as string),
  ).toMatchObject({ status: Status.Completed });
});

it("does not expose a stale task's prepared Asset in the Project catalog", async () => {
  const { publishHostedGeneration } = await import("../generation/publication");
  const bindings = env as unknown as Env;
  const suffix = crypto.randomUUID(),
    projectId = `stale-${suffix}`,
    userId = `user-${suffix}`,
    taskId = `old-${suffix}`;
  await bindings.DB.prepare(
    "INSERT INTO project (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(projectId, userId, "Stale output", Date.now(), Date.now())
    .run();
  const doc = new LoroDoc();
  new Canvas(doc, () => undefined).createNode("result", "video", {
    status: Status.Generating,
    pendingTask: "newer-task",
  });
  const room = bindings.ROOM.get(bindings.ROOM.idFromName(projectId));
  const headers = { "x-internal-loro": "true", "x-loro-project-id": projectId };
  await room.fetch(
    new Request(`http://internal/loro/${projectId}/updates`, {
      method: "POST",
      headers,
      body: doc.export({ mode: "snapshot" }),
    }),
  );
  doc.free();
  const params = {
    taskId,
    nodeId: "result",
    projectId,
    actorType: "user" as const,
    actorUserId: userId,
    type: "video_gen" as const,
  };
  await expect(
    publishHostedGeneration(bindings, params, {
      updates: { assetId: taskId },
      asset: {
        id: taskId,
        sourceTaskId: taskId,
        projectId,
        userId,
        kind: "video",
        srcR2Key: "private-prepared-output",
        metadata: {},
      },
    }),
  ).rejects.toThrow(/rejected/);
  expect(
    await bindings.DB.prepare(
      "SELECT asset_id FROM asset_refs WHERE project_id = ? AND asset_id = ?",
    )
      .bind(projectId, taskId)
      .first(),
  ).toBeNull();
  await publishHostedGeneration(bindings, params, {
    updates: { errorMessage: "superseded" },
    failure: { code: "publication_failed", message: "superseded" },
  });
  const persisted = new LoroDoc();
  persisted.import(
    new Uint8Array(
      await (
        await room.fetch(
          new Request(`http://internal/loro/${projectId}/snapshot`, {
            headers,
          }),
        )
      ).arrayBuffer(),
    ),
  );
  expect(
    new Canvas(persisted, () => undefined).readNode("result")!.data,
  ).toMatchObject({ pendingTask: "newer-task", status: Status.Generating });
  persisted.free();
});
