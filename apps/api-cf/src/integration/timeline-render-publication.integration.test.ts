/**
 * A server-side Timeline render that the shared `request_timeline_render`
 * Host command creates, driven through NodeProcessor, GenerationWorkflow and
 * publication against a fake render-server. The render node lives outside
 * every Canvas (Project-Asset scope), so publication must not depend on a
 * Canvas read, and a failure must not leave it `generating`.
 */
import { env } from "cloudflare:test";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_ASSET_RENDER_CANVAS_ID,
  listProjectAssets,
  readProjectAsset,
} from "@clash/shared-types";
import { projectProjectAsset } from "@clash/shared-runtime/cloud-project-host/project-assets";
import { durablePublicFailure } from "@clash/shared-runtime/durable-run-engine";
import type { Env } from "../config";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import { publishHostedGeneration } from "../generation/publication";
import type { HostedGenerationPublication } from "../generation/publication";
import { frozenGeneration } from "../generation/runtime";
import {
  createR2ResourceRegistry,
  resourceLocator,
} from "../services/project-content-cloud";

const bindings = env as unknown as Env;
const room = (projectId: string) =>
  bindings.ROOM.get(bindings.ROOM.idFromName(projectId));
const headers = (projectId: string) => ({
  "x-internal-loro": "true",
  "x-loro-project-id": projectId,
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedProject(projectId: string, ownerId: string) {
  await bindings.DB.prepare(
    "INSERT INTO project (id, name, owner_id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(projectId, "Server render", ownerId, ownerId, Date.now(), Date.now())
    .run();
}

async function hostCommand(
  projectId: string,
  userId: string,
  command: Record<string, unknown>,
) {
  const response = await room(projectId).fetch(
    new Request(`https://room/loro/${projectId}/host-command`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers(projectId) },
      body: JSON.stringify({ userId, command }),
    }),
  );
  return { status: response.status, body: (await response.json()) as any };
}

async function snapshot(projectId: string): Promise<LoroDoc> {
  const response = await room(projectId).fetch(
    new Request(`https://room/loro/${projectId}/snapshot`, {
      headers: headers(projectId),
    }),
  );
  const doc = new LoroDoc();
  doc.import(new Uint8Array(await response.arrayBuffer()));
  return doc;
}

const renderNode = (doc: LoroDoc, nodeId: string) =>
  doc.getMap("nodes").get(nodeId) as
    | { canvasId?: string; data: Record<string, unknown> }
    | undefined;

/** Create a Timeline and request its server render through the shared command. */
async function requestRender(projectId: string, owner: string) {
  const created = await hostCommand(projectId, owner, {
    action: "create_timeline",
    timelineId: "cut",
    name: "Cut",
    state: {
      tracks: [
        {
          id: "track",
          items: [
            {
              id: "title",
              type: "text",
              text: "Render me",
              from: 0,
              durationInFrames: 30,
            },
          ],
        },
      ],
    },
  });
  expect(created.status).toBe(200);
  const render = await hostCommand(projectId, owner, {
    action: "request_timeline_render",
    timelineId: "cut",
    actorClientType: "browser",
    ifMatch: created.body.readToken,
  });
  expect(render).toMatchObject({ status: 200, body: { submitted: true } });
  return render.body.renderNodeId as string;
}

/** Poll the persisted room state until the render node leaves pending/generating. */
async function settledRenderNode(projectId: string, nodeId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const doc = await snapshot(projectId);
    const node = renderNode(doc, nodeId);
    if (node?.data.status === "completed" || node?.data.status === "failed")
      return { doc, node };
    doc.free();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Render node ${nodeId} never settled`);
}

async function loadRun(taskId: string) {
  const run = await createD1CloudDurableRunJournal(bindings.DB).load({
    actionRunId: taskId,
    outputSlot: "output",
  });
  expect(run).toBeDefined();
  return run!;
}

describe("hosted Timeline render publication", () => {
  it("completes the shared render node with a ready Project Asset, idempotently", async () => {
    const projectId = `render-${crypto.randomUUID()}`,
      owner = crypto.randomUUID();
    await seedProject(projectId, owner);
    const bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 1, 2, 3]);
    const renderServer = vi.spyOn(globalThis, "fetch").mockImplementation(
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

    const nodeId = await requestRender(projectId, owner);
    const { doc, node } = await settledRenderNode(projectId, nodeId);
    expect(renderServer).toHaveBeenCalledTimes(1);
    expect(node.canvasId).toBe(PROJECT_ASSET_RENDER_CANVAS_ID);
    const taskId = node.data.assetId as string;
    expect(node.data).toMatchObject({ status: "completed", assetId: taskId });
    expect(node.data.pendingTask ?? null).toBeNull();
    expect(taskId).toEqual(expect.any(String));

    const entry = readProjectAsset(doc, taskId, { projectId })!;
    expect(entry).toMatchObject({
      id: taskId,
      kind: "video",
      provenance: { kind: "render", actionRunId: taskId },
      lifecycle: { state: "active" },
    });
    const registry = createR2ResourceRegistry(bindings.R2_BUCKET as never);
    const resolved = await projectProjectAsset(
      {
        readResource: (_projectId, resourceId) => registry(owner, resourceId),
        available: async (_projectId, resource) =>
          (await bindings.R2_BUCKET.head(
            await resourceLocator(owner, resource),
          ))?.size === resource.byteLength,
        mediaUrl: () => "https://media.test/render.mp4",
      },
      { projectId, entry },
    );
    expect(resolved.status).toBe("ready");
    const resource = (await registry(owner, entry.source.resourceId))!;
    expect(
      new Uint8Array(
        await (await bindings.R2_BUCKET.get(
          await resourceLocator(owner, resource),
        ))!.arrayBuffer(),
      ),
    ).toEqual(bytes);
    // A Timeline render is a Project Asset, not a library Asset row.
    expect(
      await bindings.DB.prepare("SELECT id FROM assets WHERE id = ?")
        .bind(taskId)
        .first(),
    ).toBeNull();
    const version = JSON.stringify(doc.oplogVersion().toJSON());
    doc.free();

    // Redelivered publication of the same run: no second Asset, no new write.
    const run = await loadRun(taskId);
    expect(run.phase).toBe("succeeded");
    await publishHostedGeneration(
      bindings,
      frozenGeneration(run).params,
      run.stagedOutput as unknown as HostedGenerationPublication,
    );
    const after = await snapshot(projectId);
    expect(JSON.stringify(after.oplogVersion().toJSON())).toBe(version);
    expect(
      listProjectAssets(after, { projectId }).map((asset) => asset.id),
    ).toEqual([taskId]);
    expect(renderNode(after, nodeId)!.data).toMatchObject({
      status: "completed",
      assetId: taskId,
    });
    after.free();
  });

  it("projects a failed render onto the node only while the run still holds it", async () => {
    const projectId = `render-failure-${crypto.randomUUID()}`,
      owner = crypto.randomUUID();
    await seedProject(projectId, owner);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("composition crashed", { status: 500 }),
    );

    const nodeId = await requestRender(projectId, owner);
    const { doc, node } = await settledRenderNode(projectId, nodeId);
    expect(node.data).toMatchObject({ status: "failed", error: expect.any(String) });
    expect(node.data.pendingTask ?? null).toBeNull();
    expect(listProjectAssets(doc, { projectId })).toEqual([]);
    const version = JSON.stringify(doc.oplogVersion().toJSON());
    const error = node.data.error;
    const errorCode = node.data.errorCode;
    doc.free();

    // The render node's run, found through its journaled frozen params.
    const row = await bindings.DB.prepare(
      "SELECT action_run_id FROM cloud_durable_run_journal WHERE instr(record_json, ?) > 0",
    )
      .bind(nodeId)
      .first<{ action_run_id: string }>();
    const run = await loadRun(row!.action_run_id);
    expect(run.phase).toBe("failed");
    // The node carries the run's public failure code next to its message.
    expect(errorCode).toBe(durablePublicFailure(run.failure!).code);

    // Neither a redelivered nor a stale run's failure rewrites the node.
    const params = frozenGeneration(run).params;
    const failure: HostedGenerationPublication = {
      updates: {},
      failure: { code: "publication_failed", message: "late" },
    };
    await publishHostedGeneration(bindings, params, failure);
    await publishHostedGeneration(
      bindings,
      { ...params, taskId: `stale-${params.taskId}` },
      failure,
    );
    const after = await snapshot(projectId);
    expect(JSON.stringify(after.oplogVersion().toJSON())).toBe(version);
    expect(renderNode(after, nodeId)!.data).toMatchObject({ error, errorCode });
    after.free();
  });
});
