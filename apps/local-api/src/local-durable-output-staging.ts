import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AssetKindSchema,
  ProjectAssetMetadataSchema,
  type AssetKind,
  type ProjectAssetMetadata,
} from "@clash/shared-types";

import {
  createLocalResourceStore,
  type LocalResourceStagingProjection,
} from "./local-resource-store.js";
import { createLocalSqliteConnection } from "./local-sqlite-connection.js";

interface SqliteRunResult {
  changes: number | bigint;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface LocalDurableStagedOutput {
  projectId: string;
  actionRunId: string;
  outputSlot: string;
  projectAssetId: string;
  resourceId: string;
  kind: AssetKind;
  contentType: string;
  byteLength: number;
  metadata: ProjectAssetMetadata;
  result?: {
    provider?: string;
    modelEndpoint?: string;
    requestId?: string;
  };
  projection: LocalResourceStagingProjection;
}

export interface LocalDurableOutputStagingStore {
  stage(input: {
    projectId: string;
    actionRunId: string;
    outputSlot: string;
    kind: AssetKind;
    bytes: Uint8Array;
    contentType: string;
    metadata?: ProjectAssetMetadata;
    result?: LocalDurableStagedOutput["result"];
  }): Promise<LocalDurableStagedOutput>;
  resolve(input: {
    projectId: string;
    actionRunId: string;
    outputSlot: string;
  }): Promise<LocalDurableStagedOutput | undefined>;
}

type StoredOutput = Omit<LocalDurableStagedOutput, "projection">;

const nodeRequire = createRequire(import.meta.url);

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function normalizedContentType(value: string): string {
  return required(value, "contentType").toLowerCase();
}

function projectAssetId(input: {
  projectId: string;
  actionRunId: string;
  outputSlot: string;
}): string {
  const digest = createHash("sha256")
    .update(input.projectId)
    .update("\0")
    .update(input.actionRunId)
    .update("\0")
    .update(input.outputSlot)
    .digest("hex");
  return `local-output:${digest}`;
}

function openDatabase(path: string): SqliteDatabase {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS local_durable_output_staging (
      project_id TEXT NOT NULL,
      action_run_id TEXT NOT NULL,
      output_slot TEXT NOT NULL,
      project_asset_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      metadata_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, action_run_id, output_slot)
    );
  `);
  for (const [column, declaration] of [
    ["content_type", "TEXT"],
    ["byte_length", "INTEGER"],
  ] as const) {
    try {
      database.prepare(
        `SELECT ${column} FROM local_durable_output_staging LIMIT 1`,
      );
    } catch {
      database.exec(
        `ALTER TABLE local_durable_output_staging ADD COLUMN ${column} ${declaration}`,
      );
    }
  }
  return database;
}

function parseRow(row: Record<string, unknown>): StoredOutput {
  const projectId = row.project_id;
  const actionRunId = row.action_run_id;
  const outputSlot = row.output_slot;
  const projectAssetIdValue = row.project_asset_id;
  const resourceId = row.resource_id;
  const kind = AssetKindSchema.safeParse(row.kind);
  const contentType = row.content_type;
  const byteLength = row.byte_length;
  if (
    typeof projectId !== "string" ||
    typeof actionRunId !== "string" ||
    typeof outputSlot !== "string" ||
    typeof projectAssetIdValue !== "string" ||
    typeof resourceId !== "string" ||
    !kind.success ||
    (contentType !== null && typeof contentType !== "string") ||
    (byteLength !== null &&
      (typeof byteLength !== "number" ||
        !Number.isSafeInteger(byteLength) ||
        byteLength < 0)) ||
    typeof row.metadata_json !== "string" ||
    (row.result_json !== null && typeof row.result_json !== "string")
  ) {
    throw new Error("Local durable output staging row is corrupt.");
  }
  let metadataValue: unknown;
  try {
    metadataValue = JSON.parse(row.metadata_json);
  } catch {
    throw new Error("Local durable output staging metadata is corrupt.");
  }
  let result: LocalDurableStagedOutput["result"];
  if (typeof row.result_json === "string") {
    const value = JSON.parse(row.result_json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Local durable output staging result is corrupt.");
    }
    const record = value as Record<string, unknown>;
    for (const field of ["provider", "modelEndpoint", "requestId"] as const) {
      if (record[field] !== undefined && typeof record[field] !== "string") {
        throw new Error("Local durable output staging result is corrupt.");
      }
    }
    result = record as LocalDurableStagedOutput["result"];
  }
  const metadata = ProjectAssetMetadataSchema.parse(metadataValue);
  const normalizedType =
    typeof contentType === "string" && contentType
      ? normalizedContentType(contentType)
      : typeof metadata.contentType === "string"
        ? normalizedContentType(metadata.contentType)
        : undefined;
  const normalizedByteLength =
    typeof byteLength === "number" ? byteLength : metadata.bytes;
  if (!normalizedType || normalizedByteLength === undefined) {
    throw new Error("Local durable output staging row is corrupt.");
  }
  return {
    projectId,
    actionRunId,
    outputSlot,
    projectAssetId: projectAssetIdValue,
    resourceId,
    kind: kind.data,
    contentType: normalizedType,
    byteLength: normalizedByteLength,
    metadata,
    ...(result ? { result } : {}),
  };
}

export function createLocalDurableOutputStagingStore(options: {
  dataDir: string;
}): LocalDurableOutputStagingStore {
  const databasePath = join(options.dataDir, "local.sqlite");
  const resources = createLocalResourceStore({ dataDir: options.dataDir });

  const connection = createLocalSqliteConnection({
    dataDir: options.dataDir,
    path: databasePath,
    open: openDatabase,
  });

  async function withDatabase<T>(
    task: (database: SqliteDatabase) => T,
  ): Promise<T> {
    return connection.use(task);
  }

  async function load(input: {
    projectId: string;
    actionRunId: string;
    outputSlot: string;
  }): Promise<StoredOutput | undefined> {
    return withDatabase((database) => {
      const row = database
        .prepare(
          `SELECT project_id, action_run_id, output_slot, project_asset_id,
                  resource_id, kind, content_type, byte_length,
                  metadata_json, result_json
             FROM local_durable_output_staging
            WHERE project_id = ? AND action_run_id = ? AND output_slot = ?`,
        )
        .get(input.projectId, input.actionRunId, input.outputSlot);
      return row ? parseRow(row) : undefined;
    });
  }

  async function resolveStored(
    stored: StoredOutput,
  ): Promise<LocalDurableStagedOutput> {
    const projection = await resources.resolveStaged(stored.resourceId);
    if (projection) {
      if (
        projection.resourceId !== stored.resourceId ||
        projection.byteLength !== stored.byteLength
      ) {
        throw new Error(
          `Durable output ${stored.actionRunId}/${stored.outputSlot} has staged bytes that conflict with its receipt.`,
        );
      }
      return { ...stored, projection };
    }

    // One-time pre-cutover recovery: old durable receipts referenced a sealed
    // Resource. Only a complete receipt that agrees with the re-verified
    // immutable projection may be copied back into unsealed staging; v4
    // inspection and consumer CAS still happen later in the normal workflow.
    const sealed = await resources.resolve(stored.resourceId);
    const sealedContentType = sealed?.resource.contentType
      ?.trim()
      .toLowerCase();
    const metadataContentType = stored.metadata.contentType
      ?.trim()
      .toLowerCase();
    if (
      !sealed ||
      sealed.resource.id !== stored.resourceId ||
      sealed.resource.digest.algorithm !== "sha256" ||
      sealed.resource.id !== `sha256:${sealed.resource.digest.value}` ||
      sealed.resource.kind !== stored.kind ||
      sealed.resource.byteLength !== stored.byteLength ||
      sealedContentType !== stored.contentType ||
      stored.metadata.bytes !== stored.byteLength ||
      metadataContentType !== stored.contentType
    ) {
      throw new Error(
        `Durable output ${stored.actionRunId}/${stored.outputSlot} has no complete pre-cutover receipt matching sealed Resource ${stored.resourceId}.`,
      );
    }
    const recovered = await resources.stage({
      bytes: new Uint8Array(await readFile(sealed.path)),
    });
    if (
      recovered.resourceId !== stored.resourceId ||
      recovered.byteLength !== stored.byteLength
    ) {
      throw new Error(
        `Durable output ${stored.actionRunId}/${stored.outputSlot} recovery does not match its verified sealed Resource.`,
      );
    }
    return { ...stored, projection: recovered };
  }

  return {
    async stage(input) {
      const identity = {
        projectId: required(input.projectId, "projectId"),
        actionRunId: required(input.actionRunId, "actionRunId"),
        outputSlot: required(input.outputSlot, "outputSlot"),
      };
      const existing = await load(identity);
      if (existing) return resolveStored(existing);

      const projection = await resources.stage({
        bytes: input.bytes,
      });
      const contentType = normalizedContentType(input.contentType);
      const metadata = ProjectAssetMetadataSchema.parse({
        ...(input.metadata ?? {}),
        bytes: projection.byteLength,
        contentType,
      });
      const intended: StoredOutput = {
        ...identity,
        projectAssetId: projectAssetId(identity),
        resourceId: projection.resourceId,
        kind: input.kind,
        contentType,
        byteLength: projection.byteLength,
        metadata,
        ...(input.result ? { result: input.result } : {}),
      };
      await withDatabase((database) => {
        database
          .prepare(
            `INSERT OR IGNORE INTO local_durable_output_staging (
               project_id, action_run_id, output_slot, project_asset_id,
               resource_id, kind, content_type, byte_length,
               metadata_json, result_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            intended.projectId,
            intended.actionRunId,
            intended.outputSlot,
            intended.projectAssetId,
            intended.resourceId,
            intended.kind,
            intended.contentType,
            intended.byteLength,
            JSON.stringify(intended.metadata),
            intended.result ? JSON.stringify(intended.result) : null,
            Date.now(),
          );
      });
      const winner = await load(identity);
      if (!winner)
        throw new Error("Durable output staging receipt was not recorded.");
      return resolveStored(winner);
    },

    async resolve(input) {
      const identity = {
        projectId: required(input.projectId, "projectId"),
        actionRunId: required(input.actionRunId, "actionRunId"),
        outputSlot: required(input.outputSlot, "outputSlot"),
      };
      const stored = await load(identity);
      return stored ? resolveStored(stored) : undefined;
    },
  };
}
