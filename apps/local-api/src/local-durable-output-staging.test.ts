import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalDurableOutputStagingStore } from "./local-durable-output-staging.js";
import { createLocalResourceStore } from "./local-resource-store.js";
import { closeLocalSqliteClient } from "./local-sqlite-connection.js";

const cleanups: string[] = [];
const nodeRequire = createRequire(import.meta.url);

interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-durable-staging-"));
  cleanups.push(dataDir);
  return {
    dataDir,
    resources: createLocalResourceStore({ dataDir }),
    staging: createLocalDurableOutputStagingStore({ dataDir }),
  };
}

async function legacySealedReceipt(input?: {
  kind?: "video" | "audio";
  metadataBytes?: number;
  metadataContentType?: string | null;
}) {
  const result = await fixture();
  const bytes = new TextEncoder().encode("complete legacy render");
  const sealed = await result.resources.install({
    kind: "video",
    contentType: "video/mp4",
    bytes,
  });
  const identity = {
    projectId: "project-legacy",
    actionRunId: "run-legacy",
    outputSlot: "media",
  };
  const metadata = {
    bytes: input?.metadataBytes ?? bytes.byteLength,
    ...(input?.metadataContentType === null
      ? {}
      : {
          contentType: input?.metadataContentType ?? "video/mp4",
        }),
  };
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { timeout?: number }) => TestDatabase;
  };
  // A pre-cutover data dir: close the Host SQLite worker so the next store
  // call reopens and migrates the legacy table, as a Host restart does.
  await closeLocalSqliteClient();
  const database = new DatabaseSync(join(result.dataDir, "local.sqlite"), { timeout: 5_000 });
  try {
    database.exec(`
      DROP TABLE local_durable_output_staging;
      CREATE TABLE local_durable_output_staging (
        project_id TEXT NOT NULL,
        action_run_id TEXT NOT NULL,
        output_slot TEXT NOT NULL,
        project_asset_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, action_run_id, output_slot)
      );
    `);
    database
      .prepare("DELETE FROM local_resource_staging WHERE resource_id = ?")
      .run(sealed.resource.id);
    database
      .prepare(
        `INSERT INTO local_durable_output_staging (
           project_id, action_run_id, output_slot, project_asset_id,
           resource_id, kind, metadata_json, result_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        identity.projectId,
        identity.actionRunId,
        identity.outputSlot,
        "local-output:legacy-stable-id",
        sealed.resource.id,
        input?.kind ?? "video",
        JSON.stringify(metadata),
        JSON.stringify({ provider: "legacy-provider" }),
        Date.now(),
      );
  } finally {
    database.close();
  }
  return {
    ...result,
    bytes,
    identity,
    resourceId: sealed.resource.id,
  };
}

describe("local durable output staging", () => {
  it("persists restart-safe bytes without declaring a canonical Resource", async () => {
    const { dataDir, resources, staging } = await fixture();
    const bytes = new Uint8Array([1, 2, 3]);
    const staged = await staging.stage({
      projectId: "project-a",
      actionRunId: "run-1",
      outputSlot: "media",
      kind: "audio",
      contentType: " AUDIO/MPEG ",
      bytes,
    });

    expect(staged).toMatchObject({
      projectId: "project-a",
      actionRunId: "run-1",
      outputSlot: "media",
      kind: "audio",
      metadata: { bytes: 3, contentType: "audio/mpeg" },
      projection: { byteLength: 3 },
    });
    expect(staged.projection).not.toHaveProperty("resource");
    await expect(resources.resolve(staged.resourceId)).resolves.toBeUndefined();
    await expect(
      resources.resolveStaged(staged.resourceId),
    ).resolves.toMatchObject({ resourceId: staged.resourceId, byteLength: 3 });
    await expect(readFile(staged.projection.path)).resolves.toEqual(
      Buffer.from(bytes),
    );

    const reopened = createLocalDurableOutputStagingStore({ dataDir });
    const recovered = await reopened.resolve({
      projectId: "project-a",
      actionRunId: "run-1",
      outputSlot: "media",
    });
    expect(recovered).toMatchObject({
      resourceId: staged.resourceId,
      projectAssetId: staged.projectAssetId,
      kind: "audio",
      metadata: { bytes: 3, contentType: "audio/mpeg" },
    });
    await expect(readFile(recovered!.projection.path)).resolves.toEqual(
      Buffer.from(bytes),
    );
  });

  it("keeps the first receipt when an at-least-once output returns different bytes", async () => {
    const { resources, staging } = await fixture();
    const identity = {
      projectId: "project-a",
      actionRunId: "run-1",
      outputSlot: "media",
      kind: "video" as const,
      contentType: "video/mp4",
    };
    const firstBytes = new TextEncoder().encode("first complete render");
    const retryBytes = new TextEncoder().encode("different retry render");

    const first = await staging.stage({ ...identity, bytes: firstBytes });
    const retry = await staging.stage({ ...identity, bytes: retryBytes });

    const firstDigest = createHash("sha256").update(firstBytes).digest("hex");
    expect(first.resourceId).toBe(`sha256:${firstDigest}`);
    expect(retry.resourceId).toBe(first.resourceId);
    expect(retry.projectAssetId).toBe(first.projectAssetId);
    await expect(readFile(retry.projection.path)).resolves.toEqual(
      Buffer.from(firstBytes),
    );
    await expect(resources.resolve(first.resourceId)).resolves.toBeUndefined();
  });

  it("recovers a complete pre-cutover sealed receipt as unsealed staging after restart", async () => {
    const result = await legacySealedReceipt();
    await expect(
      result.resources.resolveStaged(result.resourceId),
    ).resolves.toBeUndefined();

    const recovered = await createLocalDurableOutputStagingStore({
      dataDir: result.dataDir,
    }).resolve(result.identity);

    expect(recovered).toMatchObject({
      resourceId: result.resourceId,
      projectAssetId: "local-output:legacy-stable-id",
      kind: "video",
      contentType: "video/mp4",
      byteLength: result.bytes.byteLength,
      metadata: {
        bytes: result.bytes.byteLength,
        contentType: "video/mp4",
      },
      projection: {
        resourceId: result.resourceId,
        byteLength: result.bytes.byteLength,
      },
    });
    expect(recovered!.projection).not.toHaveProperty("resource");
    await expect(readFile(recovered!.projection.path)).resolves.toEqual(
      Buffer.from(result.bytes),
    );
  });

  it.each([
    {
      label: "kind",
      receipt: { kind: "audio" as const },
    },
    {
      label: "byte length",
      receipt: { metadataBytes: 99 },
    },
    {
      label: "content type",
      receipt: { metadataContentType: "audio/mpeg" },
    },
    {
      label: "missing content type",
      receipt: { metadataContentType: null },
    },
  ])(
    "fails closed without restaging when a pre-cutover durable receipt has conflicting $label",
    async ({ receipt }) => {
      const result = await legacySealedReceipt(receipt);

      await expect(
        createLocalDurableOutputStagingStore({
          dataDir: result.dataDir,
        }).resolve(result.identity),
      ).rejects.toThrow();
      await expect(
        result.resources.resolveStaged(result.resourceId),
      ).resolves.toBeUndefined();
    },
  );
});
