import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLocalApiApp } from "./app";
import { createLocalMetadataStore } from "./local-metadata-store";
let dataDir = "";
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clash-metadata-retired-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
it("retires public metadata writes and retains historical index queries", async () => {
  const target = {
    kind: "project-asset" as const,
    projectId: "project",
    assetId: "asset",
  };
  const identity = {
    kind: "media.description",
    schemaVersion: 1,
    text: "Historical description",
    sourceHash: `sha256:${"a".repeat(64)}`,
  };
  const store = createLocalMetadataStore(dataDir);
  await store.upsertMetadataAttachmentIndex({
    target,
    metadataKind: identity.kind,
    producer: "historical",
    identity,
  });
  const app = createLocalApiApp({ dataDir, userId: "local-user" });
  const response = await app.request("/api/v1/local/asset-metadata", {
    method: "PUT",
    body: JSON.stringify({
      actionId: "old-writer",
      target,
      metadataKind: identity.kind,
      producer: "legacy",
      metadata: identity,
    }),
  });
  expect(response.status).toBe(410);
  await expect(response.json()).resolves.toMatchObject({
    code: "METADATA_WRITE_RETIRED",
    error: expect.stringContaining("assets documents"),
  });
  const read = await app.request(
    "/api/v1/local/asset-metadata?projectId=project&kind=media.description",
  );
  expect(read.status).toBe(200);
  const body = (await read.json()) as {
    metadata: Array<{ identity: unknown; producer: string }>;
  };
  expect(body.metadata.map((entry) => entry.identity)).toEqual([identity]);
  expect(body.metadata[0].producer).toBe("historical");
});
