import { readdir, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { listProjectAssets } from "@clash/shared-types";

import { clashHomeForLocalDataDir } from "./local-paths.js";
import { withLocalBlobDigestLock } from "./local-resource-store.js";
import {
  createLocalSqliteConnection,
  type LocalSqliteDatabase,
} from "./local-sqlite-connection.js";
import { FileReplicaStore } from "./loro/file-replica-store.js";

export const LOCAL_BLOB_SWEEP_FAILED = "LOCAL_BLOB_SWEEP_FAILED";

/**
 * How long a blob nothing references survives. It outlasts every path that has
 * sealed bytes but not yet published the Project Asset that references them.
 */
export const LOCAL_BLOB_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/** One blob or reference source the sweep could not process; the next sweep retries it. */
export interface LocalBlobSweepFailure {
  code: typeof LOCAL_BLOB_SWEEP_FAILED;
  path: string;
  errno?: string;
  message: string;
}

export interface LocalBlobSweepResult {
  /** Content addresses considered by this sweep. */
  scanned: number;
  /** Content addresses fully removed. */
  deleted: number;
  /** Bytes unlinked, including those of an address that was only partly removed. */
  bytes: number;
  failed: LocalBlobSweepFailure[];
}

interface ResourceRow {
  resourceId: string;
  digest: string;
  storageKey: string;
  createdAt: number;
}

interface BlobFile {
  name: string;
  size: number;
  mtimeMs: number;
}

interface BlobDirectory {
  /** Sealed bytes and crash leftovers this sweep may remove. */
  removable: BlobFile[];
  /** A `staging` name or its temporary: an import may own this address. */
  staging: boolean;
  newestMtimeMs: number;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ORIGINAL_NAME_PATTERN = /^original(\.[a-z0-9]{1,10})?$/;
const ORIGINAL_TEMPORARY_PATTERN =
  /^original(\.[a-z0-9]{1,10})?\.(repair|staging)-[a-f0-9-]+$/;
const STAGING_NAME_PATTERN = /^staging(\.(repair|staging)-[a-f0-9-]+)?$/;
/** A legacy Asset names bytes by storage key, in either slash form or inside its metadata JSON. */
const LEGACY_BLOB_KEY_PATTERN = /blobs[\\/]+([a-f0-9]{64})(?![a-f0-9])/g;

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function failure(path: string, error: unknown): LocalBlobSweepFailure {
  const errno = errnoOf(error);
  return {
    code: LOCAL_BLOB_SWEEP_FAILED,
    path,
    ...(errno ? { errno } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

function parseResourceRow(row: Record<string, unknown>): ResourceRow {
  const { resource_id, digest_sha256, storage_key, created_at } = row;
  if (
    typeof resource_id !== "string" ||
    typeof digest_sha256 !== "string" ||
    !DIGEST_PATTERN.test(digest_sha256) ||
    typeof storage_key !== "string" ||
    typeof created_at !== "number"
  ) {
    throw new Error("Local Resource registry row is corrupt.");
  }
  return {
    resourceId: resource_id,
    digest: digest_sha256,
    storageKey: storage_key,
    createdAt: created_at,
  };
}

async function readBlobDirectory(path: string): Promise<BlobDirectory> {
  const directory: BlobDirectory = {
    removable: [],
    staging: false,
    newestMtimeMs: 0,
  };
  const names = await readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names) {
    const isStaging = STAGING_NAME_PATTERN.test(name);
    if (
      !isStaging &&
      !ORIGINAL_NAME_PATTERN.test(name) &&
      !ORIGINAL_TEMPORARY_PATTERN.test(name)
    ) {
      continue;
    }
    const info = await stat(join(path, name)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!info) continue;
    directory.newestMtimeMs = Math.max(directory.newestMtimeMs, info.mtimeMs);
    if (isStaging) directory.staging = true;
    else if (info.isFile()) {
      directory.removable.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  return directory;
}

/**
 * Mark-and-sweep over the immutable Resource store. Roots are Project Assets in
 * every replica on disk (a tombstoned Project stays restorable, so it counts),
 * the global library, durable and plugin output receipts, legacy Assets whose
 * owner still exists and Project previews; representations are reached from
 * their source.
 *
 * Marking fails closed: when any source cannot be read, nothing is deleted,
 * because an unreadable replica might hold the only reference to a blob.
 * Identity is the digest, since replicated Resource ids share one file.
 *
 * Rows are deleted before files, matching the store's crash ordering: a failed
 * unlink leaves a file with no row, which the next sweep picks up again.
 */
export async function sweepLocalBlobs(options: {
  dataDir: string;
  clashRoot?: string;
  olderThanMs?: number;
  now?: number;
}): Promise<LocalBlobSweepResult> {
  const olderThanMs = options.olderThanMs ?? LOCAL_BLOB_SWEEP_GRACE_MS;
  if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) {
    throw new Error(
      "A local blob sweep age must be a non-negative safe integer.",
    );
  }
  const cutoff = (options.now ?? Date.now()) - olderThanMs;
  const blobsRoot = join(
    clashHomeForLocalDataDir(options.dataDir, options.clashRoot),
    "assets",
    "blobs",
  );
  const result: LocalBlobSweepResult = {
    scanned: 0,
    deleted: 0,
    bytes: 0,
    failed: [],
  };
  try {
    await sweep({ ...options, cutoff, blobsRoot, result });
  } catch (error) {
    result.failed.push(failure(blobsRoot, error));
  }
  return result;
}

async function sweep(input: {
  dataDir: string;
  cutoff: number;
  blobsRoot: string;
  result: LocalBlobSweepResult;
}): Promise<void> {
  const { dataDir, cutoff, blobsRoot, result } = input;
  const connection = createLocalSqliteConnection({ dataDir });
  const database = connection.db;
  const projectsRoot = join(dataDir, "projects");

  const rows = (
    await database
      .prepare(
        "SELECT resource_id, digest_sha256, storage_key, created_at FROM local_resources",
      )
      .all()
  ).map(parseResourceRow);
  const digestEntries = await readdir(blobsRoot, {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const candidates = new Set(rows.map((row) => row.digest));
  for (const entry of digestEntries) {
    if (entry.isDirectory() && DIGEST_PATTERN.test(entry.name)) {
      candidates.add(entry.name);
    }
  }
  result.scanned = candidates.size;
  if (candidates.size === 0) return;

  const digestByResourceId = new Map(
    rows.map((row) => [row.resourceId, row.digest]),
  );
  const resourceIdsByDigest = new Map<string, string[]>();
  for (const row of rows) {
    const ids = resourceIdsByDigest.get(row.digest) ?? [];
    ids.push(row.resourceId);
    resourceIdsByDigest.set(row.digest, ids);
  }
  const live = new Set<string>();
  const markResource = (resourceId: string) => {
    const digest =
      digestByResourceId.get(resourceId) ??
      /^sha256:([a-f0-9]{64})$/.exec(resourceId)?.[1];
    if (digest) live.add(digest);
  };

  // Receipts are read before the live Project set: a receipt seen here belongs
  // to a Project that already existed when that set is read.
  const outputReceipts = [
    ...(
      await database
        .prepare(
          "SELECT project_id, resource_id FROM local_durable_output_staging",
        )
        .all()
    ).map((row) => ({ table: "local_durable_output_staging", row })),
    ...(
      await database
        .prepare(
          "SELECT project_id, resource_id FROM local_plugin_asset_staging",
        )
        .all()
    ).map((row) => ({ table: "local_plugin_asset_staging", row })),
  ];

  const replicaEntries = await readdir(projectsRoot, {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const replicaDirectories = replicaEntries.filter((entry) =>
    entry.isDirectory(),
  );
  const liveProjects = new Set<string>();
  for (const row of await database.prepare("SELECT id FROM project").all()) {
    if (typeof row.id === "string") liveProjects.add(row.id);
  }

  const replicas = new FileReplicaStore(projectsRoot);
  let markFailed = false;
  for (const entry of replicaDirectories) {
    const path = join(projectsRoot, entry.name);
    try {
      const projectId = decodeURIComponent(entry.name);
      liveProjects.add(projectId);
      const doc = await replicas.recover(projectId);
      try {
        for (const asset of listProjectAssets(doc, { projectId })) {
          if (asset.lifecycle.state !== "purged") {
            markResource(asset.source.resourceId);
          }
        }
      } finally {
        doc.free();
      }
    } catch (error) {
      markFailed = true;
      result.failed.push(failure(path, error));
    }
  }

  for (const row of await database
    .prepare(
      "SELECT resource_id FROM global_asset_entry WHERE lifecycle_state <> 'purged'",
    )
    .all()) {
    if (typeof row.resource_id === "string") markResource(row.resource_id);
  }

  // A receipt outlives its run so a retry can recover its bytes. Once its
  // Project is purged nothing can retry, and it must not pin the blob forever.
  for (const { table, row } of outputReceipts) {
    if (typeof row.project_id !== "string") continue;
    if (liveProjects.has(row.project_id)) {
      if (typeof row.resource_id === "string") markResource(row.resource_id);
    } else {
      await database
        .prepare(`DELETE FROM ${table} WHERE project_id = ?`)
        .run(row.project_id);
    }
  }

  for (const row of await database
    .prepare("SELECT digest_sha256 FROM local_resource_staging")
    .all()) {
    if (typeof row.digest_sha256 === "string") live.add(row.digest_sha256);
  }

  await markLegacyReferences(database, liveProjects, live);

  // Young or import-owned addresses are roots too, so their representations
  // survive with them.
  const directories = new Map<string, BlobDirectory>();
  for (const digest of candidates) {
    const path = join(blobsRoot, digest);
    try {
      const directory = await readBlobDirectory(path);
      directories.set(digest, directory);
      if (directory.staging || directory.newestMtimeMs > cutoff) {
        live.add(digest);
      }
    } catch (error) {
      live.add(digest);
      result.failed.push(failure(path, error));
    }
  }
  for (const row of rows) {
    if (row.createdAt > cutoff) live.add(row.digest);
  }

  const representationsBySource = new Map<string, string[]>();
  for (const row of await database
    .prepare(
      "SELECT source_resource_id, result_json FROM local_asset_representations WHERE role <> 'failure'",
    )
    .all()) {
    try {
      const representation = JSON.parse(String(row.result_json)) as {
        resourceId?: unknown;
      };
      if (
        typeof representation.resourceId === "string" &&
        typeof row.source_resource_id === "string"
      ) {
        const ids = representationsBySource.get(row.source_resource_id) ?? [];
        ids.push(representation.resourceId);
        representationsBySource.set(row.source_resource_id, ids);
      }
    } catch (error) {
      markFailed = true;
      result.failed.push(
        failure(`local_asset_representations:${String(row.source_resource_id)}`, error),
      );
    }
  }
  // `live` grows while it is iterated: a Set visits entries added mid-loop.
  for (const digest of live) {
    const ids = resourceIdsByDigest.get(digest) ?? [`sha256:${digest}`];
    for (const id of ids) {
      for (const representationId of representationsBySource.get(id) ?? []) {
        markResource(representationId);
      }
    }
  }

  if (markFailed) return;

  for (const digest of candidates) {
    if (live.has(digest)) continue;
    const path = join(blobsRoot, digest);
    try {
      await withLocalBlobDigestLock(digest, () =>
        reclaimDigest({ connection, digest, path, cutoff, result }),
      );
    } catch (error) {
      result.failed.push(failure(path, error));
    }
  }
}

async function markLegacyReferences(
  database: LocalSqliteDatabase,
  liveProjects: ReadonlySet<string>,
  live: Set<string>,
): Promise<void> {
  const markKeys = (text: unknown) => {
    if (typeof text !== "string") return;
    for (const match of text.matchAll(LEGACY_BLOB_KEY_PATTERN)) {
      live.add(match[1]!);
    }
  };
  const ownedAssets = new Set<string>();
  for (const row of await database
    .prepare("SELECT asset_id FROM asset_library_refs")
    .all()) {
    if (typeof row.asset_id === "string") ownedAssets.add(row.asset_id);
  }
  for (const row of await database
    .prepare("SELECT asset_id, project_id FROM asset_refs")
    .all()) {
    if (
      typeof row.asset_id === "string" &&
      typeof row.project_id === "string" &&
      liveProjects.has(row.project_id)
    ) {
      ownedAssets.add(row.asset_id);
    }
  }
  // Legacy rows are read-only cutover input and survive a purge, so one only
  // counts while an owner that could still materialize it exists.
  for (const row of await database
    .prepare(
      "SELECT id, project_id, src_r2_key, cover_r2_key, metadata FROM assets",
    )
    .all()) {
    const owned =
      typeof row.project_id !== "string" ||
      liveProjects.has(row.project_id) ||
      (typeof row.id === "string" && ownedAssets.has(row.id));
    if (!owned) continue;
    markKeys(row.src_r2_key);
    markKeys(row.cover_r2_key);
    markKeys(row.metadata);
  }
  for (const row of await database
    .prepare("SELECT storage_key FROM project_preview_asset")
    .all()) {
    markKeys(row.storage_key);
  }
}

/** Runs under the digest lock, so no seal of this address interleaves. */
async function reclaimDigest(input: {
  connection: ReturnType<typeof createLocalSqliteConnection>;
  digest: string;
  path: string;
  cutoff: number;
  result: LocalBlobSweepResult;
}): Promise<void> {
  const { connection, digest, path, cutoff, result } = input;
  const database = connection.db;
  // Marking took a while: an import may have claimed this address since.
  if (
    await database
      .prepare(
        "SELECT 1 AS present FROM local_resource_staging WHERE digest_sha256 = ? LIMIT 1",
      )
      .get(digest)
  ) {
    return;
  }
  const rows = (
    await database
      .prepare(
        "SELECT resource_id, digest_sha256, storage_key, created_at FROM local_resources WHERE digest_sha256 = ?",
      )
      .all(digest)
  ).map(parseResourceRow);
  if (rows.some((row) => row.createdAt > cutoff)) return;
  const directory = await readBlobDirectory(path);
  if (directory.staging || directory.newestMtimeMs > cutoff) return;
  const contentAddress = `local-blobs/${digest}/`;
  const foreign = rows.find(
    (row) =>
      !row.storageKey.startsWith(contentAddress) ||
      !ORIGINAL_NAME_PATTERN.test(row.storageKey.slice(contentAddress.length)),
  );
  if (foreign) {
    throw new Error(
      `Local Resource ${foreign.resourceId} is stored outside its content address (${foreign.storageKey}); keeping it.`,
    );
  }

  if (rows.length > 0) {
    await connection.use(async (session) => {
      await session.exec("BEGIN IMMEDIATE");
      try {
        for (const { resourceId } of rows) {
          for (const statement of [
            "DELETE FROM local_asset_inspections WHERE source_resource_id = ?",
            "DELETE FROM local_asset_representations WHERE source_resource_id = ?",
            "DELETE FROM local_resources WHERE resource_id = ?",
          ]) {
            await session.prepare(statement).run(resourceId);
          }
        }
        await session.exec("COMMIT");
      } catch (error) {
        await session.exec("ROLLBACK");
        throw error;
      }
    });
  }

  let removedAll = true;
  for (const file of directory.removable) {
    const filePath = join(path, file.name);
    try {
      await unlink(filePath);
      result.bytes += file.size;
    } catch (error) {
      if (errnoOf(error) === "ENOENT") continue;
      removedAll = false;
      result.failed.push(failure(filePath, error));
    }
  }
  // Best effort: a directory an import just reused, or one holding a file this
  // sweep does not own, simply stays.
  await rmdir(path).catch(() => undefined);
  if (removedAll && (rows.length > 0 || directory.removable.length > 0)) {
    result.deleted += 1;
  }
}
