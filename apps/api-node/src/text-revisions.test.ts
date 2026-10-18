import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { HTTPException } from "hono/http-exception";
import { expect, it, vi } from "vitest";
import type { TextAppliedRevision } from "@clash/shared-types";
import { textRevisionContentHash } from "@clash/shared-runtime/cloud-project-host/text-revisions";
import { createNodeCloudApp } from "./app.ts";
import { migrateDatabase } from "./migrations.ts";
import {
  createTextRevisionBlobPort,
  TextRevisionStorageError,
} from "./text-revisions.ts";

const HASH = "a".repeat(16);

async function setupDatabase() {
  const db = new PGlite();
  await migrateDatabase(db);
  const token = "clsh_" + "c".repeat(40);
  await db.query(
    "INSERT INTO api_token (id,user_id,name,token_hash,token_prefix) VALUES ($1,$2,$3,$4,$5)",
    [
      "text-revision-token",
      "owner",
      "test",
      createHash("sha256").update(token).digest("hex"),
      "clsh_cccc",
    ],
  );
  await db.query(
    "INSERT INTO project (id,owner_id,tenant_id,name,created_at,updated_at) VALUES ('p1','owner','tn','P',now(),now())",
  );
  return { db, headers: { authorization: `Bearer ${token}` } };
}

function revisionFixture(contentHash = HASH): TextAppliedRevision {
  return {
    schemaVersion: 1,
    kind: "clash.text.revision",
    textId: "text-1",
    revisionId: "rev-1",
    projectId: "p1",
    nodeId: "node-1",
    createdAt: "2026-10-17T00:00:00.000Z",
    contentHash,
    hashAlgorithm: "sha256-64",
    sourceFilePath: "notes/a.md",
    sourceFileHash: contentHash,
  };
}

async function insertRevision(
  db: PGlite,
  revision: TextAppliedRevision,
): Promise<void> {
  await db.query(
    `INSERT INTO text_revisions (project_id,revision_id,node_id,created_at,revision)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [
      revision.projectId,
      revision.revisionId,
      revision.nodeId,
      revision.createdAt,
      JSON.stringify(revision),
    ],
  );
}

it("treats only ENOENT as missing and throws a typed storage error for other fs failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clash-text-revisions-"));
  try {
    const blobs = createTextRevisionBlobPort(directory);
    await expect(blobs.read("p1", HASH)).resolves.toBeNull();
    await expect(blobs.has("p1", HASH)).resolves.toBe(false);

    // A file at the Project directory path makes every blob lookup ENOTDIR.
    await writeFile(join(directory, "p1"), "not a directory");
    const readFailure = await blobs.read("p1", HASH).then(
      () => null,
      (error: unknown) => error,
    );
    const hasFailure = await blobs.has("p1", HASH).then(
      () => null,
      (error: unknown) => error,
    );
    for (const failure of [readFailure, hasFailure]) {
      expect(failure).toBeInstanceOf(TextRevisionStorageError);
      expect(failure).toMatchObject({
        code: "TEXT_REVISION_STORAGE_FAILED",
        status: 500,
        message: "Text revision storage failed (ENOTDIR)",
        cause: { code: "ENOTDIR" },
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("answers an explicit coded failure when a blob directory is a file", async () => {
  const { db, headers } = await setupDatabase();
  const directory = await mkdtemp(join(tmpdir(), "clash-text-revisions-"));
  await writeFile(join(directory, "text-revisions"), "not a directory");
  const revision = revisionFixture();
  await insertRevision(db, revision);
  const app = createNodeCloudApp({
    db,
    syncBaseUrl: "https://node.test",
    assetDirectory: directory,
  });
  try {
    const content = await app.request(
      `/api/v1/projects/${revision.projectId}/text-revisions/${revision.revisionId}/content`,
      { headers },
    );
    expect(content.status).toBe(500);
    expect(await content.json()).toEqual({
      error: "Text revision storage failed (ENOTDIR)",
      code: "TEXT_REVISION_STORAGE_FAILED",
    });

    // The shared history reader does not swallow a failed has(): the list
    // answers the same explicit error instead of dropping or blanking the row.
    const history = await app.request(
      `/api/v1/projects/${revision.projectId}/text-revisions`,
      { headers },
    );
    expect(history.status).toBe(500);
    expect(await history.json()).toEqual({
      error: "Text revision storage failed (ENOTDIR)",
      code: "TEXT_REVISION_STORAGE_FAILED",
    });
    const row = await db.query(
      "SELECT revision_id FROM text_revisions WHERE project_id='p1' AND revision_id='rev-1'",
    );
    expect(row.rows).toEqual([{ revision_id: "rev-1" }]);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps a genuinely missing blob as 404 content and an entry without a descriptor", async () => {
  const { db, headers } = await setupDatabase();
  const directory = await mkdtemp(join(tmpdir(), "clash-text-revisions-"));
  const revision = revisionFixture(textRevisionContentHash("# missing\n"));
  await insertRevision(db, revision);
  const app = createNodeCloudApp({
    db,
    syncBaseUrl: "https://node.test",
    assetDirectory: directory,
  });
  try {
    const content = await app.request(
      `/api/v1/projects/${revision.projectId}/text-revisions/${revision.revisionId}/content`,
      { headers },
    );
    expect(content.status).toBe(404);
    expect(await content.json()).toEqual({
      error: "text revision content not found",
    });

    const history = await app.request(
      `/api/v1/projects/${revision.projectId}/text-revisions`,
      { headers },
    );
    expect(history.status).toBe(200);
    const body = (await history.json()) as {
      revisions: Array<Record<string, unknown>>;
    };
    expect(body.revisions).toHaveLength(1);
    expect(body.revisions[0]).toMatchObject({
      revisionId: revision.revisionId,
      contentHash: revision.contentHash,
    });
    expect(body.revisions[0]).not.toHaveProperty("content");
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("maps an uncoded unhandled error to INTERNAL_ERROR without logging its message", async () => {
  const { db } = await setupDatabase();
  const app = createNodeCloudApp({ db, syncBaseUrl: "https://node.test" });
  app.get("/__test__/uncoded", () => {
    throw new Error("postgres://secret-user:secret-password@database/internal");
  });
  const lines: string[] = [];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    const response = await app.request("/__test__/uncoded");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Cloud request failed",
      code: "INTERNAL_ERROR",
    });
  } finally {
    errorSpy.mockRestore();
    await db.close();
  }
  const logged = lines.join("\n");
  expect(logged).toContain("http.unhandled_error");
  expect(logged).not.toContain("postgres://secret-user:secret-password");
});

it("keeps an HTTPException's own status instead of flattening it to INTERNAL_ERROR", async () => {
  const { db } = await setupDatabase();
  const app = createNodeCloudApp({ db, syncBaseUrl: "https://node.test" });
  app.get("/__test__/http-exception", () => {
    throw new HTTPException(413, { message: "Payload Too Large" });
  });
  try {
    const response = await app.request("/__test__/http-exception");
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Payload Too Large");
  } finally {
    await db.close();
  }
});
