/**
 * Issue #84: a synced Project read by hosted Web while its ProjectRoom is
 * cold (no socket has initialized this instance). The card and canvas reads
 * must come from the persisted replica, not the instance's empty document.
 */
import { env, evictDurableObject } from "cloudflare:test";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import {
  Canvas,
  createProjectAsset,
  markProjectAssetAuthority,
} from "@clash/shared-types";
import { createMetadataService } from "@clash/metadata-service";
import type { Env } from "../config";
import { createCloudflareMetadataPorts } from "../services/metadata-cloud";
import { readProjectRoomAssetIds } from "../services/project-room-asset-ids";

const bindings = env as unknown as Env;

/** What a local Host replicates for a Project with one placed image Asset. */
async function seedSyncedProject(projectId: string, ownerId: string) {
  await bindings.DB.prepare(
    "INSERT INTO project (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(projectId, ownerId, "Synced", Date.now(), Date.now())
    .run();
  const doc = new LoroDoc();
  markProjectAssetAuthority(doc);
  const created = createProjectAsset(doc, {
    id: "asset-dog",
    kind: "image",
    source: { kind: "owned", resourceId: "resource-dog" },
    lifecycle: { state: "active" },
    name: "Dog",
    metadata: { contentType: "image/png" },
  });
  expect(created.ok).toBe(true);
  new Canvas(doc, () => undefined).createNode("dog", "image", {
    label: "Dog",
    assetId: "asset-dog",
  });
  doc.commit();
  const room = bindings.ROOM.get(bindings.ROOM.idFromName(projectId));
  const response = await room.fetch(
    new Request(`http://internal/loro/${projectId}/updates`, {
      method: "POST",
      headers: { "x-internal-loro": "true", "x-loro-project-id": projectId },
      body: doc.export({ mode: "snapshot" }),
    }),
  );
  expect(response.status).toBe(204);
  doc.free();
  // Drop the instance that imported the update: the next request starts cold.
  await evictDurableObject(room);
  return room;
}

describe("ProjectRoom cold reads (#84)", () => {
  it("serves internal node reads from the persisted replica after eviction", async () => {
    const projectId = `cold-nodes-${crypto.randomUUID()}`;
    const room = await seedSyncedProject(projectId, "owner-nodes");

    const nodes = await room.fetch(`https://room/sync/${projectId}/nodes`);
    expect(nodes.status).toBe(200);
    expect(await nodes.json()).toEqual([
      expect.objectContaining({
        type: "image",
        data: expect.objectContaining({ assetId: "asset-dog" }),
      }),
    ]);

    await evictDurableObject(room);
    const dump = await room.fetch(`https://room/sync/${projectId}/loro-dump`);
    expect(dump.status).toBe(200);
    expect(Object.keys(((await dump.json()) as { nodes: object }).nodes)).toEqual(
      ["dog"],
    );
  });

  it("reads the Project Asset ids a card counts from a cold room", async () => {
    const projectId = `cold-assets-${crypto.randomUUID()}`;
    await seedSyncedProject(projectId, "owner-assets");

    await expect(
      readProjectRoomAssetIds(bindings.ROOM as never, projectId),
    ).resolves.toEqual(["asset-dog"]);
  });

  it("counts a synced Project's Assets on the hosted project card", async () => {
    const projectId = `cold-card-${crypto.randomUUID()}`;
    const ownerId = `owner-${crypto.randomUUID()}`;
    await seedSyncedProject(projectId, ownerId);

    const service = createMetadataService({
      ...createCloudflareMetadataPorts(bindings as never),
      // Identity is not under test; the D1 directory and ProjectRoom are real.
      identity: { verify: async () => ({ userId: ownerId }) },
    });
    const response = await service.handle(
      new Request(`https://clash.test/api/v1/projects/${projectId}`),
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      id: projectId,
      assetCount: 1,
    });
  });
});
