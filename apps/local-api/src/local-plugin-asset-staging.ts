import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, readFile } from "node:fs/promises";

import { AssetKindSchema, type AssetKind } from "@clash/shared-types";

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

interface StagingRow {
  projectId: string;
  projectAssetId: string;
  resourceId: string;
  kind: AssetKind;
  byteLength: number;
  taskId: string;
  slot: string;
  pluginId: string;
  pluginVersion: string;
  invocationId: string;
  mediaType?: string;
  /** Host-selected Provider account this upload ran under, when the invocation had one. */
  accountId?: string;
  createdAt: number;
}

export interface LocalPluginStagedAsset extends StagingRow {
  projection: LocalResourceStagingProjection;
}

export interface LocalPluginAssetStagingStore {
  projectAssetId(input: {
    projectId: string;
    taskId: string;
    slot: string;
  }): string;
  stage(input: {
    projectId: string;
    taskId: string;
    slot: string;
    pluginId: string;
    pluginVersion: string;
    invocationId: string;
    kind: AssetKind;
    mediaType?: string;
    /** Host-selected Provider account this upload ran under, when the invocation had one. */
    accountId?: string;
    bytes: Uint8Array;
  }): Promise<LocalPluginStagedAsset>;
  resolve(input: {
    projectId: string;
    projectAssetId: string;
  }): Promise<LocalPluginStagedAsset | undefined>;
}

const nodeRequire = createRequire(import.meta.url);

function openDatabase(path: string): SqliteDatabase {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS local_plugin_asset_staging (
      project_id TEXT NOT NULL,
      project_asset_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      media_type TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, project_asset_id)
    );
    CREATE INDEX IF NOT EXISTS local_plugin_asset_staging_resource
      ON local_plugin_asset_staging (resource_id);
  `);
  try {
    database.prepare(
      "SELECT byte_length FROM local_plugin_asset_staging LIMIT 1",
    );
  } catch {
    database.exec(
      "ALTER TABLE local_plugin_asset_staging ADD COLUMN byte_length INTEGER",
    );
  }
  try {
    database.prepare(
      "SELECT account_id FROM local_plugin_asset_staging LIMIT 1",
    );
  } catch {
    database.exec(
      "ALTER TABLE local_plugin_asset_staging ADD COLUMN account_id TEXT",
    );
  }
  return database;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function parseRow(row: Record<string, unknown>): StagingRow {
  const projectId = row.project_id;
  const projectAssetId = row.project_asset_id;
  const resourceId = row.resource_id;
  const kind = AssetKindSchema.safeParse(row.kind);
  const byteLength = row.byte_length;
  const taskId = row.task_id;
  const slot = row.slot;
  const pluginId = row.plugin_id;
  const pluginVersion = row.plugin_version;
  const invocationId = row.invocation_id;
  const mediaType = row.media_type;
  const accountId = row.account_id;
  const createdAt = row.created_at;
  if (
    typeof projectId !== "string" ||
    typeof projectAssetId !== "string" ||
    typeof resourceId !== "string" ||
    !kind.success ||
    (byteLength !== null &&
      (typeof byteLength !== "number" ||
        !Number.isSafeInteger(byteLength) ||
        byteLength < 0)) ||
    typeof taskId !== "string" ||
    typeof slot !== "string" ||
    typeof pluginId !== "string" ||
    typeof pluginVersion !== "string" ||
    typeof invocationId !== "string" ||
    (mediaType !== null && typeof mediaType !== "string") ||
    (accountId !== null &&
      accountId !== undefined &&
      typeof accountId !== "string") ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt)
  ) {
    throw new Error("Local plugin Asset staging row is corrupt.");
  }
  return {
    projectId,
    projectAssetId,
    resourceId,
    kind: kind.data,
    byteLength: typeof byteLength === "number" ? byteLength : -1,
    taskId,
    slot,
    pluginId,
    pluginVersion,
    invocationId,
    ...(typeof mediaType === "string" && mediaType ? { mediaType } : {}),
    ...(typeof accountId === "string" && accountId ? { accountId } : {}),
    createdAt,
  };
}

/**
 * Stable future ProjectAsset identity selected by the Host before plugin execution.
 *
 * The receipt is scoped to one Project and one Action output slot. It deliberately does not expose
 * the Resource digest: a plugin that happens to know a digest must not gain access to another
 * Project's bytes, and two Actions producing identical bytes still retain distinct provenance.
 */
export function pluginOutputProjectAssetId(input: {
  projectId: string;
  taskId: string;
  slot: string;
}): string {
  const digest = createHash("sha256")
    .update(required(input.projectId, "projectId"))
    .update("\0")
    .update(required(input.taskId, "taskId"))
    .update("\0")
    .update(required(input.slot, "slot"))
    .digest("hex");
  return `plugin-output:${digest}`;
}

export function createLocalPluginAssetStagingStore(options: {
  dataDir: string;
  clashRoot?: string;
}): LocalPluginAssetStagingStore {
  const databasePath = `${options.dataDir}/local.sqlite`;
  const resources = createLocalResourceStore({
    dataDir: options.dataDir,
    ...(options.clashRoot ? { clashRoot: options.clashRoot } : {}),
  });

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
    projectAssetId: string;
  }): Promise<StagingRow | undefined> {
    return withDatabase((database) => {
      const row = database
        .prepare(
          `
        SELECT project_id, project_asset_id, resource_id, kind, task_id, slot,
               byte_length, plugin_id, plugin_version, invocation_id,
               media_type, account_id, created_at
        FROM local_plugin_asset_staging
        WHERE project_id = ? AND project_asset_id = ?
      `,
        )
        .get(input.projectId, input.projectAssetId);
      return row ? parseRow(row) : undefined;
    });
  }

  async function resolved(row: StagingRow): Promise<LocalPluginStagedAsset> {
    const projection = await resources.resolveStaged(row.resourceId);
    if (projection) {
      if (projection.resourceId !== row.resourceId) {
        throw new Error(
          `Staged plugin Asset ${row.projectAssetId} receipt does not match its staged bytes.`,
        );
      }
      const byteLength =
        row.byteLength < 0 ? projection.byteLength : row.byteLength;
      if (projection.byteLength !== byteLength) {
        throw new Error(
          `Staged plugin Asset ${row.projectAssetId} byte length does not match its receipt.`,
        );
      }
      return { ...row, byteLength, projection };
    }

    // One-time pre-cutover recovery: old plugin receipts pointed at a sealed
    // Resource and had no byte_length column. Re-verify the immutable Resource
    // projection, require every persisted claim to agree, then copy the exact
    // bytes back into unsealed staging so current v4 inspection remains the
    // only publication path.
    const sealed = await resources.resolve(row.resourceId);
    const receiptMediaType = row.mediaType?.trim().toLowerCase();
    const sealedMediaType = sealed?.resource.contentType?.trim().toLowerCase();
    const sealedByteLength = sealed?.resource.byteLength;
    const receiptByteLength =
      row.byteLength < 0 ? sealedByteLength : row.byteLength;
    if (
      !sealed ||
      sealed.resource.id !== row.resourceId ||
      sealed.resource.digest.algorithm !== "sha256" ||
      sealed.resource.id !== `sha256:${sealed.resource.digest.value}` ||
      sealed.resource.kind !== row.kind ||
      !receiptMediaType ||
      receiptMediaType !== sealedMediaType ||
      receiptByteLength === undefined ||
      receiptByteLength !== sealedByteLength
    ) {
      throw new Error(
        `Staged plugin Asset ${row.projectAssetId} has no complete pre-cutover receipt matching sealed Resource ${row.resourceId}.`,
      );
    }
    const recovered = await resources.stage({
      bytes: new Uint8Array(await readFile(sealed.path)),
    });
    if (
      recovered.resourceId !== row.resourceId ||
      recovered.byteLength !== receiptByteLength
    ) {
      throw new Error(
        `Staged plugin Asset ${row.projectAssetId} recovery does not match its verified sealed Resource.`,
      );
    }
    return {
      ...row,
      byteLength: receiptByteLength,
      projection: recovered,
    };
  }

  return {
    projectAssetId: pluginOutputProjectAssetId,

    async stage(input) {
      const projectId = required(input.projectId, "projectId");
      const taskId = required(input.taskId, "taskId");
      const slot = required(input.slot, "slot");
      const projectAssetId = pluginOutputProjectAssetId({
        projectId,
        taskId,
        slot,
      });
      const existing = await load({ projectId, projectAssetId });
      if (existing) {
        if (
          existing.taskId !== taskId ||
          existing.slot !== slot ||
          existing.kind !== input.kind
        ) {
          throw new Error(
            `Staged plugin Asset receipt ${projectAssetId} conflicts with its identity.`,
          );
        }
        return resolved(existing);
      }

      const projection = await resources.stage({
        bytes: input.bytes,
      });
      const intended: StagingRow = {
        projectId,
        projectAssetId,
        resourceId: projection.resourceId,
        kind: input.kind,
        byteLength: projection.byteLength,
        taskId,
        slot,
        pluginId: required(input.pluginId, "pluginId"),
        pluginVersion: input.pluginVersion.trim(),
        invocationId: required(input.invocationId, "invocationId"),
        ...(input.mediaType?.trim()
          ? { mediaType: input.mediaType.trim().toLowerCase() }
          : {}),
        ...(input.accountId?.trim() ? { accountId: input.accountId.trim() } : {}),
        createdAt: Date.now(),
      };
      await withDatabase((database) => {
        database
          .prepare(
            `
          INSERT OR IGNORE INTO local_plugin_asset_staging (
            project_id, project_asset_id, resource_id, kind, task_id, slot,
            byte_length, plugin_id, plugin_version, invocation_id,
            media_type, account_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            intended.projectId,
            intended.projectAssetId,
            intended.resourceId,
            intended.kind,
            intended.taskId,
            intended.slot,
            intended.byteLength,
            intended.pluginId,
            intended.pluginVersion,
            intended.invocationId,
            intended.mediaType ?? null,
            intended.accountId ?? null,
            intended.createdAt,
          );
      });
      const stored = await load({ projectId, projectAssetId });
      if (!stored)
        throw new Error(
          `Staged plugin Asset ${projectAssetId} was not recorded.`,
        );
      // First durable receipt wins. A Provider retry may legitimately return different bytes after
      // an ambiguous request; the Action still publishes exactly one output for this slot.
      return resolved(stored);
    },

    async resolve(input) {
      const projectId = required(input.projectId, "projectId");
      const projectAssetId = required(input.projectAssetId, "projectAssetId");
      const row = await load({ projectId, projectAssetId });
      return row ? resolved(row) : undefined;
    },
  };
}
