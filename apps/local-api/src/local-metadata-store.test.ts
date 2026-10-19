import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import type { TextAppliedRevision } from "@clash/shared-types";
import { describe, expect, it } from "vitest";
import { createLocalMetadataStore } from "./local-metadata-store";

const require = createRequire(import.meta.url);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clash-local-metadata-store-"));
}

function readSqlitePragma(
  dataDir: string,
  pragma: string,
): string | number | undefined {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): {
        get(): Record<string, string | number> | undefined;
      };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    const row = db.prepare(`PRAGMA ${pragma}`).get();
    return row ? Object.values(row)[0] : undefined;
  } finally {
    db.close();
  }
}

function readMetadataMigrationMarker(
  dataDir: string,
): Record<string, unknown> | undefined {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): {
        get(...params: unknown[]): Record<string, unknown> | undefined;
      };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    return db
      .prepare("SELECT id, source_path FROM local_migration WHERE id = ?")
      .get("metadata-sqlite-v1");
  } finally {
    db.close();
  }
}

function readSqliteObjectName(
  dataDir: string,
  type: string,
  name: string,
): string | undefined {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): {
        get(...params: unknown[]): Record<string, unknown> | undefined;
      };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
      .get(type, name);
    return typeof row?.name === "string" ? row.name : undefined;
  } finally {
    db.close();
  }
}

function readSqliteTableColumns(dataDir: string, table: string): string[] {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { all(): Array<Record<string, unknown>> };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name ?? ""));
  } finally {
    db.close();
  }
}

function createPartialCoreMetadataSqlite(dataDir: string): void {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    db.exec(`
      CREATE TABLE local_migration (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE project (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE project_preview_asset (project_id TEXT NOT NULL);
      CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE asset_refs (
        asset_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        PRIMARY KEY (asset_id, project_id)
      );
      CREATE TABLE asset_node_refs (asset_id TEXT NOT NULL);
      CREATE TABLE text_revisions (revision_id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE runtime_session (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE agent_member (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE chat_message (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        PRIMARY KEY (session_id, id)
      );
      CREATE TABLE mutation_audit (id TEXT PRIMARY KEY NOT NULL);
    `);
  } finally {
    db.close();
  }
}

function textRevisionFixture(input: {
  revisionId: string;
  projectId: string;
  createdAt?: string;
  actor?: TextAppliedRevision["actor"];
}): TextAppliedRevision {
  return {
    schemaVersion: 1,
    kind: "clash.text.revision",
    textId: `text:${input.projectId}:script`,
    revisionId: input.revisionId,
    projectId: input.projectId,
    nodeId: "script",
    createdAt: input.createdAt ?? "2026-08-14T00:00:00.000Z",
    contentHash: "0123456789abcdef",
    hashAlgorithm: "sha256-64",
    sourceFilePath: "projections/text/script.md",
    sourceFileHash: "0123456789abcdef",
    ...(input.actor ? { actor: input.actor } : {}),
  };
}

function insertTextRevisionRows(
  dataDir: string,
  revisions: readonly TextAppliedRevision[],
): void {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    const insert = db.prepare(`
      INSERT INTO text_revisions (
        revision_id, text_id, parent_revision_id, project_id, node_id,
        created_at, content_hash, hash_algorithm, source_file_path,
        source_file_hash, actor_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const revision of revisions) {
        insert.run(
          revision.revisionId,
          revision.textId,
          revision.parentRevisionId ?? null,
          revision.projectId,
          revision.nodeId,
          revision.createdAt,
          revision.contentHash,
          revision.hashAlgorithm,
          revision.sourceFilePath,
          revision.sourceFileHash,
          revision.actor ? JSON.stringify(revision.actor) : null,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function corruptTextRevisionActor(dataDir: string, revisionId: string): void {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    db.prepare(
      "UPDATE text_revisions SET actor_json = ? WHERE revision_id = ?",
    ).run("{not-json", revisionId);
  } finally {
    db.close();
  }
}

describe("local metadata store", () => {
  it("initializes sqlite metadata with WAL journal mode for local multi-client safety", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);

    await store.save({
      projects: [],
      assets: [],
      assetRefs: [],
      assetNodeRefs: [],
      sessions: [],
      agentMembers: [],
      sessionMessages: [],
    });

    expect(readSqlitePragma(dataDir, "journal_mode")).toBe("wal");
    expect(readSqliteObjectName(dataDir, "table", "local_config")).toBe(
      "local_config",
    );
    expect(
      readSqliteObjectName(dataDir, "table", "timeline_revisions"),
    ).toBeUndefined();
  });

  it("keeps legacy Asset migration rows read-only during ordinary metadata saves", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);
    const legacy = {
      projects: [],
      assets: [
        {
          id: "legacy-asset",
          userId: "legacy-user",
          kind: "image" as const,
          srcR2Key: "uploads/legacy.png",
          coverR2Key: null,
          metadata: { contentType: "image/png" },
          sourceModel: null,
          sourcePrompt: null,
          sourceTaskId: null,
          sources: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      assetRefs: [
        { assetId: "legacy-asset", projectId: "project-1", importedAt: 1 },
      ],
      libraryAssetRefs: [
        { assetId: "legacy-asset", userId: "legacy-user", addedAt: 1 },
      ],
      assetNodeRefs: [
        {
          assetId: "legacy-asset",
          projectId: "project-1",
          nodeId: "node-1",
          nodeType: "image",
          fieldPath: "data.assetId",
          referenceRole: "asset",
          observedAt: 1,
        },
      ],
      sessions: [],
      agentMembers: [],
      sessionMessages: [],
    };

    await store.save(legacy, { replaceLegacyAssetMigrationInput: true });
    await store.save({
      ...legacy,
      assets: [],
      assetRefs: [],
      libraryAssetRefs: [],
      assetNodeRefs: [],
      projects: [
        {
          id: "project-1",
          ownerId: "local-user",
          name: "Project",
          description: null,
          createdAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:00.000Z",
          assets: [],
        },
      ],
    });

    await expect(store.load()).resolves.toMatchObject({
      assets: [{ id: "legacy-asset", srcR2Key: "uploads/legacy.png" }],
      assetRefs: [{ assetId: "legacy-asset", projectId: "project-1" }],
      libraryAssetRefs: [{ assetId: "legacy-asset", userId: "legacy-user" }],
      assetNodeRefs: [
        {
          assetId: "legacy-asset",
          projectId: "project-1",
          nodeId: "node-1",
        },
      ],
      projects: [{ id: "project-1" }],
    });
  });

  it("upgrades partial sqlite metadata and projection tables before local-api metadata access", async () => {
    const dataDir = await tempDir();
    createPartialCoreMetadataSqlite(dataDir);
    const store = createLocalMetadataStore(dataDir);

    await expect(store.load()).resolves.toMatchObject({
      projects: [],
      assets: [],
      assetRefs: [],
      sessions: [],
    });
    await expect(
      store.save({
        projects: [
          {
            id: "project-upgraded",
            ownerId: "local-user",
            name: "Upgraded Project",
            description: null,
            createdAt: "2026-07-08T00:00:00.000Z",
            updatedAt: "2026-07-08T00:01:00.000Z",
            assets: [],
          },
        ],
        assets: [],
        assetRefs: [],
        assetNodeRefs: [],
        sessions: [],
        agentMembers: [],
        sessionMessages: [],
      }),
    ).resolves.toBeUndefined();
    await expect(store.load()).resolves.toMatchObject({
      projects: [
        {
          id: "project-upgraded",
          ownerId: "local-user",
        },
      ],
    });
  });

  it("round-trips soft-deleted project metadata", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);

    await store.save({
      projects: [
        {
          id: "project-deleted",
          ownerId: "local-user",
          name: "Deleted Project",
          description: null,
          createdAt: "2026-07-07T00:00:00.000Z",
          updatedAt: "2026-07-07T00:01:00.000Z",
          deletedAt: "2026-07-07T00:02:00.000Z",
          assets: [],
        },
      ],
      assets: [],
      assetRefs: [],
      assetNodeRefs: [],
      sessions: [],
      agentMembers: [],
      sessionMessages: [],
    });

    await expect(store.load()).resolves.toMatchObject({
      projects: [
        {
          id: "project-deleted",
          deletedAt: "2026-07-07T00:02:00.000Z",
        },
      ],
    });
  });

  it("persists sanitized local mutation audit records outside metadata rewrites", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);

    await store.appendMutationAudit({
      id: "audit-project-purge",
      createdAt: 1783428000000,
      operation: "project_purge",
      entity: { kind: "project", id: "project-audit" },
      actorClientType: "agent",
      accepted: true,
      reason: "project purge",
      resultEntityId: "project-audit",
      error: null,
      mutation: {
        operation: "project_purge",
        entity: { kind: "project", id: "project-audit" },
        accepted: true,
        resultEntityId: "project-audit",
      },
    });

    await store.save({
      projects: [],
      assets: [],
      assetRefs: [],
      assetNodeRefs: [],
      sessions: [],
      agentMembers: [],
      sessionMessages: [],
    });

    await expect(
      store.listMutationAudit({ operation: "project_purge", limit: 10 }),
    ).resolves.toEqual([
      {
        id: "audit-project-purge",
        createdAt: 1783428000000,
        operation: "project_purge",
        entity: { kind: "project", id: "project-audit" },
        actorClientType: "agent",
        accepted: true,
        reason: "project purge",
        resultEntityId: "project-audit",
        error: null,
        mutation: {
          operation: "project_purge",
          entity: { kind: "project", id: "project-audit" },
          accepted: true,
          resultEntityId: "project-audit",
        },
      },
    ]);
    expect(readSqliteTableColumns(dataDir, "mutation_audit")).not.toContain(
      "forced",
    );
  });

  it("marks sqlite metadata authoritative after an audit-only write", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);

    await store.appendMutationAudit({
      id: "audit-rejected-text-apply",
      createdAt: 1783428000000,
      operation: "text_revision_index",
      entity: { kind: "text", id: "project-text:script" },
      actorClientType: "agent",
      accepted: false,
      reason: "text revision rejected",
      resultEntityId: null,
      error: "text revision contentHash does not match content",
      mutation: {
        operation: "text_revision_index",
        entity: { kind: "text", id: "project-text:script" },
        accepted: false,
        error: "text revision contentHash does not match content",
      },
    });

    expect(readMetadataMigrationMarker(dataDir)).toMatchObject({
      id: "metadata-sqlite-v1",
      source_path: join(dataDir, "local.sqlite"),
    });
  });

  it("persists typed plugin SDK audit without credential material", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir) as ReturnType<
      typeof createLocalMetadataStore
    > & {
      appendPluginBrokerAudit(record: Record<string, unknown>): Promise<void>;
      listPluginBrokerAudit(filter?: {
        pluginId?: string;
        limit?: number;
      }): Promise<Array<Record<string, unknown>>>;
    };
    expect(typeof store.appendPluginBrokerAudit).toBe("function");
    expect(typeof store.listPluginBrokerAudit).toBe("function");
    if (!store.appendPluginBrokerAudit || !store.listPluginBrokerAudit) return;

    await store.appendPluginBrokerAudit({
      id: "broker-audit-1",
      occurredAt: "2026-08-04T12:00:00.000Z",
      pluginId: "test.broker-plugin",
      pluginVersion: "1.0.0",
      projectId: "project-1",
      invocationId: "invocation-1",
      requestId: "store-1",
      operation: "store.get",
      target: "apiKey",
      status: "ok",
    });

    const records = await store.listPluginBrokerAudit({
      pluginId: "test.broker-plugin",
      limit: 10,
    });
    expect(records).toEqual([
      {
        id: "broker-audit-1",
        occurredAt: "2026-08-04T12:00:00.000Z",
        pluginId: "test.broker-plugin",
        pluginVersion: "1.0.0",
        projectId: "project-1",
        invocationId: "invocation-1",
        requestId: "store-1",
        operation: "store.get",
        target: "apiKey",
        status: "ok",
        error: null,
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("super-secret");
  });
});

describe("Workspace text revision inventory", () => {
  it("returns every Project row in stable revision-identity order across Host restart", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);
    const projectId = "project-workspace-export";

    // Initialize the authority before bulk-seeding more history than either a
    // public page (200) or the former export ceiling (1,000) can represent.
    await store.listTextRevisions({ projectId });
    const targetRows = Array.from({ length: 1_005 }, (_, index) =>
      textRevisionFixture({
        revisionId: `revision-${String(index).padStart(4, "0")}`,
        projectId,
        createdAt:
          index % 2 === 0
            ? "2026-08-15T00:00:00.000Z"
            : "2026-08-13T00:00:00.000Z",
      }),
    );
    insertTextRevisionRows(dataDir, [
      ...[...targetRows].reverse(),
      textRevisionFixture({
        revisionId: "revision-other-project",
        projectId: "project-not-exported",
      }),
    ]);

    const publicHistory = await store.listTextRevisions({
      projectId,
      limit: 1_000,
    });
    expect(publicHistory).toHaveLength(200);

    const expectedRevisionIds = targetRows
      .map((revision) => revision.revisionId)
      .sort();
    const all = await store.listWorkspaceTextRevisions(projectId);
    expect(all.map((revision) => revision.revisionId)).toEqual(
      expectedRevisionIds,
    );
    expect(all).toHaveLength(targetRows.length);
    expect(all.every((revision) => revision.projectId === projectId)).toBe(
      true,
    );

    const restartedStore = createLocalMetadataStore(dataDir);
    await expect(
      restartedStore.listWorkspaceTextRevisions(projectId),
    ).resolves.toEqual(all);
  });

  it("fails closed instead of returning a partial export when a row is corrupt", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);
    const projectId = "project-corrupt-text-history";
    const valid = textRevisionFixture({
      revisionId: "revision-valid",
      projectId,
    });
    const corrupt = textRevisionFixture({
      revisionId: "revision-corrupt",
      projectId,
      actor: {
        actorType: "agent",
        actorUserId: "user-1",
        actorAgentId: "agent-1",
      },
    });
    await store.upsertTextRevision(valid);
    await store.upsertTextRevision(corrupt);
    corruptTextRevisionActor(dataDir, corrupt.revisionId);

    await expect(store.listWorkspaceTextRevisions(projectId)).rejects.toThrow(
      /revision-corrupt/u,
    );
  });
});

describe("Workspace import receipts", () => {
  it("stores only portable bundle and receiver Project provenance", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);
    const bundleDigest = "a".repeat(64);

    await store.commitWorkspaceImport({
      bundleDigest,
      importedAt: "2026-08-14T00:00:00.000Z",
      project: {
        id: "project-imported",
        ownerId: "receiver-owner",
        name: "Imported",
        description: null,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        deletedAt: null,
        assets: [],
      },
      textRevisions: [],
    });

    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        prepare(sql: string): {
          all(): Array<Record<string, unknown>>;
        };
        exec(sql: string): void;
        close(): void;
      };
    };
    const legacyDb = new DatabaseSync(join(dataDir, "local.sqlite"));
    try {
      legacyDb.exec(
        "ALTER TABLE workspace_import_receipt ADD COLUMN source_workspace_id TEXT NOT NULL DEFAULT 'legacy-machine'",
      );
    } finally {
      legacyDb.close();
    }

    const restarted = createLocalMetadataStore(dataDir);
    await expect(
      restarted.readWorkspaceImportReceipt(bundleDigest),
    ).resolves.toEqual({
      bundleDigest,
      projectId: "project-imported",
      importedAt: "2026-08-14T00:00:00.000Z",
    });

    const db = new DatabaseSync(join(dataDir, "local.sqlite"));
    try {
      expect(
        db
          .prepare("PRAGMA table_info(workspace_import_receipt)")
          .all()
          .map((row) => row.name),
      ).toEqual(["bundle_digest", "project_id", "imported_at"]);
    } finally {
      db.close();
    }
  });
});

describe("typed metadata attachment projection index", () => {
  it("keeps ProjectAsset and ActionRevision rows with the same ids independent", async () => {
    const store = createLocalMetadataStore(await tempDir());
    const identity = {
      kind: "media.transcript",
      schemaVersion: 1,
      backendId: "mlx-whisper",
      contentHash: `sha256:${"b".repeat(64)}`,
      bodyHash: `sha256:${"c".repeat(64)}`,
      summary: { wordCount: 17, durationMs: 4_820 },
    };
    await store.upsertMetadataAttachmentIndex({
      target: {
        kind: "project-asset",
        projectId: "project-1",
        assetId: "shared-id",
      },
      metadataKind: "media.transcript",
      schemaVersion: 1,
      contentHash: identity.contentHash,
      bodyHash: identity.bodyHash,
      producer: "clash.local.asr",
      summary: identity.summary,
      identity,
    });
    await store.upsertMetadataAttachmentIndex({
      target: {
        kind: "action-revision",
        projectId: "project-1",
        actionId: "shared-id",
        actionRevisionId: "revision-1",
      },
      metadataKind: "media.transcript",
      schemaVersion: 1,
      contentHash: identity.contentHash,
      bodyHash: `sha256:${"d".repeat(64)}`,
      producer: "clash.local.asr",
      summary: { wordCount: 18, durationMs: 5_000 },
      identity: { ...identity, bodyHash: `sha256:${"d".repeat(64)}` },
    });

    const all = await store.listMetadataAttachmentIndex({
      projectId: "project-1",
    });
    expect(all).toHaveLength(2);
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authority: "projection-index",
          target: {
            kind: "project-asset",
            projectId: "project-1",
            assetId: "shared-id",
          },
          bodyHash: identity.bodyHash,
        }),
        expect.objectContaining({
          authority: "projection-index",
          target: {
            kind: "action-revision",
            projectId: "project-1",
            actionId: "shared-id",
            actionRevisionId: "revision-1",
          },
          bodyHash: `sha256:${"d".repeat(64)}`,
        }),
      ]),
    );

    const actionRows = await store.listMetadataAttachmentIndex({
      target: {
        kind: "action-revision",
        projectId: "project-1",
        actionId: "shared-id",
        actionRevisionId: "revision-1",
      },
      metadataKind: "media.transcript",
    });
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      summary: { wordCount: 18, durationMs: 5_000 },
    });
  });

  it("rejects legacy assetId writes and keeps them in a private read-only migration API", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);
    await store.listMetadataAttachmentIndex();

    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        prepare(sql: string): { run(...params: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new DatabaseSync(join(dataDir, "local.sqlite"));
    try {
      db.prepare(
        `INSERT INTO asset_metadata_index (
          asset_id, metadata_kind, project_id, producer, identity_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "legacy-asset",
        "media.description",
        "project-legacy",
        "migration",
        JSON.stringify({
          kind: "media.description",
          schemaVersion: 1,
          text: "Legacy row",
        }),
        1,
      );
    } finally {
      db.close();
    }

    await expect(
      (
        store.upsertMetadataAttachmentIndex as (value: unknown) => Promise<void>
      )({
        assetId: "legacy-asset",
        metadataKind: "media.description",
        producer: "new-write",
        identity: { kind: "media.description" },
      }),
    ).rejects.toThrow();

    const legacy = await store.listLegacyAssetMetadataIndex({
      assetId: "legacy-asset",
    });
    expect(legacy).toEqual([
      expect.objectContaining({
        assetId: "legacy-asset",
        projectId: "project-legacy",
        metadataKind: "media.description",
      }),
    ]);
    expect(await store.listMetadataAttachmentIndex()).toEqual([]);
  });

  it("persists every runtime session event and replays them by append order", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);

    await store.appendSessionEvent("session-history", {
      type: "user_prompt",
      data: { turn_id: "turn-history", text: "Inspect" },
      ts: 1_000,
    });
    await store.appendSessionEvent("session-history", {
      type: "session.event",
      data: {
        turn_id: "turn-history",
        event: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done" },
        },
      },
      ts: 1_250,
    });
    await store.appendSessionEvent("session-history", {
      type: "turn_completed",
      data: { turn_id: "turn-history" },
      ts: 2_000,
    });

    expect(await store.listSessionEvents("session-history")).toEqual([
      expect.objectContaining({ seq: 1, type: "user_prompt", ts: 1_000 }),
      expect.objectContaining({ seq: 2, type: "session.event", ts: 1_250 }),
      expect.objectContaining({ seq: 3, type: "turn_completed", ts: 2_000 }),
    ]);
  });

  it("applies an event and its scoped session patch in one transaction", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);
    const at = "2026-10-18T00:00:00.000Z";
    await store.save({
      projects: [],
      assets: [],
      assetRefs: [],
      libraryAssetRefs: [],
      assetNodeRefs: [],
      sessions: [
        {
          id: "session-scoped",
          projectId: "project-1",
          title: "New session",
          type: "runtime",
          agentTemplateId: "clash",
          status: "starting",
          createdAt: at,
          updatedAt: at,
        },
      ],
      agentMembers: [],
      sessionMessages: [],
    });

    await store.appendSessionEvent(
      "session-scoped",
      { type: "user_prompt", data: { text: "Fix the render" }, ts: 1_000 },
      {
        updatedAt: "2026-10-18T00:00:01.000Z",
        updateSession: () => ({ title: "Fix the render", status: "error" }),
      },
    );

    expect(await store.listSessionEvents("session-scoped")).toEqual([
      expect.objectContaining({
        seq: 1,
        type: "user_prompt",
        data: { text: "Fix the render" },
      }),
    ]);
    expect((await store.load()).sessions).toEqual([
      expect.objectContaining({
        id: "session-scoped",
        title: "Fix the render",
        status: "error",
        updatedAt: "2026-10-18T00:00:01.000Z",
      }),
    ]);
  });

  it("preserves session columns an event patch does not change", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);
    const createdAt = "2026-10-18T00:00:00.000Z";
    await store.save({
      projects: [],
      assets: [],
      assetRefs: [],
      libraryAssetRefs: [],
      assetNodeRefs: [],
      sessions: [
        {
          id: "session-preserve",
          projectId: "project-1",
          title: "New session",
          type: "runtime",
          status: "active",
          createdAt,
          updatedAt: createdAt,
        },
      ],
      agentMembers: [],
      sessionMessages: [],
    });

    const session = async () =>
      (await store.load()).sessions.find(
        (candidate) => candidate.id === "session-preserve",
      );
    const ordinaryEvent = (ts: number) => ({
      type: "session.event",
      data: {
        turn_id: "turn-preserve",
        event: { sessionUpdate: "agent_message_chunk" },
      },
      ts,
    });

    for (const [index, updatedAt] of [
      "2026-10-18T00:00:01.000Z",
      "2026-10-18T00:00:02.000Z",
      "2026-10-18T00:00:03.000Z",
    ].entries()) {
      await store.appendSessionEvent("session-preserve", ordinaryEvent(index), {
        updatedAt,
        updateSession: () => ({}),
      });
      expect(await session()).toMatchObject({
        title: "New session",
        status: "active",
        updatedAt,
      });
    }

    await store.appendSessionEvent(
      "session-preserve",
      { type: "user_prompt", data: { text: "Keep the status" }, ts: 2_000 },
      {
        updatedAt: "2026-10-18T00:00:04.000Z",
        updateSession: () => ({ title: "Keep the status" }),
      },
    );
    expect(await session()).toMatchObject({
      title: "Keep the status",
      status: "active",
      updatedAt: "2026-10-18T00:00:04.000Z",
    });

    await store.appendSessionEvent(
      "session-preserve",
      { type: "turn_failed", data: { message: "boom" }, ts: 3_000 },
      {
        updatedAt: "2026-10-18T00:00:05.000Z",
        updateSession: () => ({ status: "error" }),
      },
    );
    expect(await session()).toMatchObject({
      title: "Keep the status",
      status: "error",
      updatedAt: "2026-10-18T00:00:05.000Z",
    });
  });

  it("rolls back the event insert when the session patch fails", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);
    const at = "2026-10-18T00:00:00.000Z";
    await store.save({
      projects: [],
      assets: [],
      assetRefs: [],
      libraryAssetRefs: [],
      assetNodeRefs: [],
      sessions: [
        {
          id: "session-atomic",
          projectId: "project-1",
          title: "Keep this title",
          type: "runtime",
          status: "active",
          createdAt: at,
          updatedAt: at,
        },
      ],
      agentMembers: [],
      sessionMessages: [],
    });
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const sqlite = new DatabaseSync(join(dataDir, "local.sqlite"));
    try {
      sqlite.exec(`
        CREATE TRIGGER fail_runtime_session_update
        BEFORE UPDATE ON runtime_session
        BEGIN
          SELECT RAISE(ABORT, 'session update failed');
        END;
      `);
    } finally {
      sqlite.close();
    }

    await expect(
      store.appendSessionEvent(
        "session-atomic",
        { type: "turn_failed", data: { message: "boom" }, ts: 2_000 },
        {
          updatedAt: "2026-10-18T00:00:02.000Z",
          updateSession: () => ({ status: "error" }),
        },
      ),
    ).rejects.toMatchObject({ code: "SESSION_EVENT_PERSIST_FAILED" });

    expect(await store.listSessionEvents("session-atomic")).toEqual([]);
    expect((await store.load()).sessions).toEqual([
      expect.objectContaining({
        id: "session-atomic",
        title: "Keep this title",
        status: "active",
        updatedAt: at,
      }),
    ]);
  });

  it("moves and deletes the append-only log with its runtime session", async () => {
    const dataDir = await tempDir();
    const store = createLocalMetadataStore(dataDir);

    await store.appendSessionEvent("session-temporary", {
      type: "user_prompt",
      data: { turn_id: "turn-history", text: "Keep this transcript" },
      ts: 1_000,
    });

    await store.renameSessionEvents("session-temporary", "session-final");
    expect(await store.listSessionEvents("session-temporary")).toEqual([]);
    expect(await store.listSessionEvents("session-final")).toEqual([
      expect.objectContaining({
        type: "user_prompt",
        data: { turn_id: "turn-history", text: "Keep this transcript" },
      }),
    ]);

    await store.deleteSessionEvents("session-final");
    expect(await store.listSessionEvents("session-final")).toEqual([]);
  });
});
