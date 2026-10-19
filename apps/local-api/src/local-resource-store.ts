import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { createRequire } from "node:module";
import {
  access,
  chmod,
  link,
  open,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";

import { PROJECT_ASSET_IMPORT_MAX_BYTES } from "@clash/asset-sdk";
import {
  AssetKindSchema,
  ResourceSchema,
  type AssetKind,
  type LocalResourceErrorCode,
  type Resource,
} from "@clash/shared-types";

import {
  assetPathForDelete,
  assetPathForRead,
  assetPathForWrite,
  normalizeLocalBlobStorageKey,
} from "./local-asset-paths.js";
import { clashHomeForLocalDataDir } from "./local-paths.js";
import { createLocalSqliteConnection } from "./local-sqlite-connection.js";

interface SqliteRunResult {
  changes: number | bigint;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface LocalResourceRow {
  resourceId: string;
  kind: AssetKind;
  digest: string;
  byteLength: number;
  contentType?: string;
  storageKey: string;
  factsVerified: boolean;
  createdAt: number;
}

interface LocalResourceStagingRow {
  resourceId: string;
  digest: string;
  byteLength: number;
  storageKey: string;
}

export interface LocalResourceProjection {
  resource: Resource;
  createdAt: number;
  storageKey: string;
  path: string;
}

export interface LocalResourceStagingReceipt {
  resourceId: string;
  digest: string;
  byteLength: number;
}

/** Host-private bytes that are available for verification but are not yet a Resource. */
export interface LocalResourceStagingProjection {
  receipt: LocalResourceStagingReceipt;
  resourceId: string;
  digest: string;
  byteLength: number;
  storageKey: string;
  path: string;
}

export type LocalResourceByteSource = AsyncIterable<Uint8Array> | Readable;

/** A structured event worth surfacing in the Host log (e.g. an EXDEV fallback). */
export interface LocalResourceStoreEvent {
  level: "info" | "error";
  event: string;
  fields: Record<string, unknown>;
}

/** The streamed bytes contradict what the transport declared; no staging receipt exists. */
export class LocalResourceStreamMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalResourceStreamMismatchError";
  }
}

/** The streamed bytes do not match the transport's declared byte length. */
export class LocalResourceStreamLengthMismatchError extends LocalResourceStreamMismatchError {
  constructor(message: string) {
    super(message);
    this.name = "LocalResourceStreamLengthMismatchError";
  }
}

/** A local import exceeds the product's single-request byte limit. */
export class LocalResourceStreamLimitError extends Error {
  readonly code = "CLOUD_CONTENT_TOO_LARGE";

  constructor(readonly maxBytes: number) {
    super(
      `Project Asset import exceeds its maximum byte length (maxBytes=${maxBytes}).`,
    );
    this.name = "LocalResourceStreamLimitError";
  }
}

/**
 * This Host cannot serve a Resource's immutable local bytes. Reads only stat
 * the file: the digest is computed once while the bytes are imported and is
 * checked again only when they are uploaded to the cloud.
 */
export class LocalResourceError extends Error {
  readonly code: LocalResourceErrorCode;
  readonly resourceId?: string;
  /** Node errno code of the failed filesystem call, when there was one. */
  readonly errno?: string;

  constructor(
    code: LocalResourceErrorCode,
    message: string,
    options?: ErrorOptions & { resourceId?: string; errno?: string },
  ) {
    super(`${code}: ${message}`, options);
    this.name = "LocalResourceError";
    this.code = code;
    this.resourceId = options?.resourceId;
    this.errno = options?.errno;
  }
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function localResourceFileError(
  resourceId: string,
  error: unknown,
): LocalResourceError {
  const errno = errnoCode(error);
  if (errno === "ENOENT") {
    return new LocalResourceError(
      "LOCAL_RESOURCE_MISSING",
      `Local Resource ${resourceId} has no immutable bytes on this Host.`,
      { cause: error, resourceId, errno },
    );
  }
  return new LocalResourceError(
    "LOCAL_RESOURCE_UNREADABLE",
    `Local Resource ${resourceId} bytes cannot be read${errno ? ` (${errno})` : ""}.`,
    { cause: error, resourceId, ...(errno ? { errno } : {}) },
  );
}

/**
 * Proves the immutable file is present, readable and of its registered length
 * without reading its content.
 */
async function assertLocalResourceFile(input: {
  resourceId: string;
  byteLength: number;
  path: () => Promise<string>;
}): Promise<string> {
  let path: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    path = await input.path();
    info = await stat(path);
  } catch (error) {
    throw localResourceFileError(input.resourceId, error);
  }
  if (!info.isFile()) {
    throw new LocalResourceError(
      "LOCAL_RESOURCE_UNREADABLE",
      `Local Resource ${input.resourceId} bytes are not a regular file.`,
      { resourceId: input.resourceId },
    );
  }
  if (info.size !== input.byteLength) {
    throw new LocalResourceError(
      "LOCAL_RESOURCE_SIZE_MISMATCH",
      `Local Resource ${input.resourceId} has ${info.size} bytes on disk; its registry facts say ${input.byteLength}.`,
      { resourceId: input.resourceId },
    );
  }
  try {
    await access(path, constants.R_OK);
  } catch (error) {
    throw localResourceFileError(input.resourceId, error);
  }
  return path;
}

/** Caller-held bytes, or a byte source the Host hashes and writes chunk by chunk. */
export type LocalResourceStageInput =
  | { bytes: Uint8Array; source?: never; declaredByteLength?: never }
  | {
      source: LocalResourceByteSource;
      /** Exact byte length the transport declared, when it declared one. */
      declaredByteLength?: number;
      /** Lowercase SHA-256 the caller already computed for these bytes. */
      expectedDigest?: string;
      bytes?: never;
    };

/** Stages either input shape through the one Resource store; a source is never buffered whole. */
export function stageLocalResourceInput(
  resources: Pick<LocalResourceStore, "stage" | "stageStream">,
  input: LocalResourceStageInput,
  originalNameInput?: string,
): Promise<LocalResourceStagingProjection> {
  const originalName = originalNameInput
    ? { originalName: originalNameInput }
    : {};
  if (input.source === undefined) {
    // A caller that already holds the bytes gets the same product cap as the
    // streaming transports; nothing is staged when the array is too large.
    if (input.bytes.byteLength > PROJECT_ASSET_IMPORT_MAX_BYTES) {
      throw new LocalResourceStreamLimitError(PROJECT_ASSET_IMPORT_MAX_BYTES);
    }
    return resources.stage({ bytes: input.bytes, ...originalName });
  }
  // The product cap bounds every streamed import, whichever transport carried
  // it. The request route rejects a larger declaration before reading a body;
  // this also bounds a chunked body that declares no length.
  if (
    input.declaredByteLength !== undefined &&
    input.declaredByteLength > PROJECT_ASSET_IMPORT_MAX_BYTES
  ) {
    throw new LocalResourceStreamLimitError(PROJECT_ASSET_IMPORT_MAX_BYTES);
  }
  return resources.stageStream({
    source: input.source,
    ...(input.declaredByteLength === undefined
      ? {}
      : { declaredByteLength: input.declaredByteLength }),
    ...(input.expectedDigest === undefined
      ? {}
      : { expectedDigest: input.expectedDigest }),
    maxByteLength: PROJECT_ASSET_IMPORT_MAX_BYTES,
    ...originalName,
  });
}

/** Host-private immutable read handle. Storage paths and keys stay inside the Resource store. */
export interface LocalResourceStreamProjection {
  resource: Resource;
  stream: Readable;
}

export interface LocalResourceStore {
  /** Registry facts only; does not open or hash the immutable byte file. */
  readFacts(resourceId: string): Promise<Resource | undefined>;
  /** Replicate opaque identity only from a locally inspected, verified Resource. */
  installReplica(input: {
    resource: Resource;
    verifiedResourceId: string;
  }): Promise<LocalResourceProjection>;
  stage(input: {
    bytes: Uint8Array;
    originalName?: string;
  }): Promise<LocalResourceStagingProjection>;
  stageStream(input: {
    source: LocalResourceByteSource;
    /** Exact Content-Length when the transport declared one. */
    declaredByteLength?: number;
    /** Hard Host limit, enforced while consuming the source. */
    maxByteLength: number;
    /** Optional lowercase SHA-256 claimed by the transport. */
    expectedDigest?: string;
    originalName?: string;
  }): Promise<LocalResourceStagingProjection>;
  /**
   * Takes ownership of a file already assembled elsewhere (with its digest
   * computed in that assembly pass) without hashing or copying it: the file is
   * renamed into the staging path and the same inode is sealed later. If the
   * rename crosses filesystems (EXDEV) it is streamed instead and the fallback
   * is reported through `onEvent`.
   */
  adoptAssembled(input: {
    sourcePath: string;
    digest: string;
    byteLength: number;
  }): Promise<LocalResourceStagingProjection>;
  /** Drops a staging receipt and its file; a sealed original is unaffected. */
  discardStaged(resourceId: string): Promise<void>;
  resolveStaged(
    resourceId: string,
  ): Promise<LocalResourceStagingProjection | undefined>;
  /**
   * Drops a staging receipt and its staging file once the same digest is a
   * verified sealed Resource. A receipt whose bytes are not sealed is kept.
   */
  releaseStaged(resourceId: string): Promise<void>;
  seal(
    input: (
      | { receipt: LocalResourceStagingReceipt; resourceId?: never }
      | { resourceId: string; receipt?: never }
    ) & {
      kind: AssetKind;
      contentType?: string;
    },
  ): Promise<LocalResourceProjection>;
  /** Legacy/private compatibility wrapper. New publication flows must stage, inspect, then seal. */
  install(input: {
    kind: AssetKind;
    bytes: Uint8Array;
    contentType?: string;
    originalName?: string;
  }): Promise<LocalResourceProjection>;
  /** Legacy/private compatibility wrapper for already-installed CLI bytes. */
  adopt(input: {
    kind: AssetKind;
    digest: string;
    byteLength: number;
    contentType?: string;
    localBlobKey: string;
  }): Promise<LocalResourceProjection>;
  /**
   * Stats the immutable file without reading it; bytes this Host cannot serve
   * throw a coded {@link LocalResourceError}.
   */
  resolve(resourceId: string): Promise<LocalResourceProjection | undefined>;
  resolveStream(
    resourceId: string,
  ): Promise<LocalResourceStreamProjection | undefined>;
}

type LocalResourceSealInput = Parameters<LocalResourceStore["seal"]>[0];
type LocalResourceFacts = Omit<
  LocalResourceRow,
  "storageKey" | "factsVerified" | "createdAt"
>;

export function resourceIdForSha256(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(
      "A Resource SHA-256 digest must be 64 lowercase hexadecimal characters.",
    );
  }
  return `sha256:${digest}`;
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
    CREATE TABLE IF NOT EXISTS local_resources (
      resource_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      digest_sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      content_type TEXT,
      storage_key TEXT NOT NULL,
      facts_verified INTEGER NOT NULL DEFAULT 0 CHECK (facts_verified IN (0, 1)),
      created_at INTEGER NOT NULL
    );
    DROP INDEX IF EXISTS local_resources_digest;
    CREATE INDEX IF NOT EXISTS local_resources_digest_lookup
      ON local_resources (digest_sha256);
    CREATE TABLE IF NOT EXISTS local_resource_staging (
      resource_id TEXT PRIMARY KEY,
      digest_sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const resourcesTable = database
    .prepare(
      `
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'local_resources'
    `,
    )
    .get();
  if (
    typeof resourcesTable?.sql !== "string" ||
    !/\bfacts_verified\b/i.test(resourcesTable.sql)
  ) {
    database.exec(`
      ALTER TABLE local_resources
        ADD COLUMN facts_verified INTEGER NOT NULL DEFAULT 0
        CHECK (facts_verified IN (0, 1));
    `);
  }
  return database;
}

function parseStagingRow(
  row: Record<string, unknown>,
): LocalResourceStagingRow {
  const resourceId = row.resource_id;
  const digest = row.digest_sha256;
  const byteLength = row.byte_length;
  const storageKey = row.storage_key;
  if (
    typeof resourceId !== "string" ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    typeof storageKey !== "string"
  ) {
    throw new Error("Local Resource staging row is corrupt.");
  }
  if (resourceId !== resourceIdForSha256(digest)) {
    throw new Error(
      `Local Resource staging receipt ${resourceId} has a mismatched digest identity.`,
    );
  }
  return { resourceId, digest, byteLength, storageKey };
}

function parseRow(row: Record<string, unknown>): LocalResourceRow {
  const resourceId = row.resource_id;
  const kind = AssetKindSchema.safeParse(row.kind);
  const digest = row.digest_sha256;
  const byteLength = row.byte_length;
  const contentType = row.content_type;
  const storageKey = row.storage_key;
  const factsVerified = row.facts_verified;
  const createdAt = row.created_at;
  if (
    typeof resourceId !== "string" ||
    !kind.success ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    typeof byteLength !== "number" ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    (contentType !== null && typeof contentType !== "string") ||
    typeof storageKey !== "string" ||
    (factsVerified !== 0 && factsVerified !== 1) ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  ) {
    throw new Error("Local Resource registry row is corrupt.");
  }
  // Resource identity is opaque across Hosts. Local staging uses a digest id,
  // while replicated identities may name the same verified immutable bytes.
  return {
    resourceId,
    kind: kind.data,
    digest,
    byteLength,
    ...(typeof contentType === "string" && contentType ? { contentType } : {}),
    storageKey,
    factsVerified: factsVerified === 1,
    createdAt,
  };
}

function resourceFromRow(row: LocalResourceRow): Resource {
  return ResourceSchema.parse({
    id: row.resourceId,
    kind: row.kind,
    digest: { algorithm: "sha256", value: row.digest },
    byteLength: row.byteLength,
    ...(row.contentType ? { contentType: row.contentType } : {}),
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedByteLength(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new Error("Local Resource stream stopped making write progress.");
    }
    offset += bytesWritten;
  }
}

/** Bounded copy for the cross-filesystem adoption fallback. */
async function copyFileBounded(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const handle = await open(targetPath, "w", 0o444);
  let handleOpen = true;
  try {
    for await (const chunk of createReadStream(sourcePath)) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error(
          "Local Resource copy stream returned a non-byte chunk.",
        );
      }
      await writeAll(handle, chunk);
    }
    await handle.sync();
    await handle.close();
    handleOpen = false;
  } catch (error) {
    if (handleOpen) await handle.close().catch(() => undefined);
    await unlink(targetPath).catch(() => undefined);
    throw error;
  }
}

function pathlessReadStream(path: string): Readable {
  return Readable.from(
    (async function* () {
      const source = createReadStream(path);
      try {
        for await (const chunk of source) {
          if (!(chunk instanceof Uint8Array)) {
            throw new Error(
              "Local Resource read stream returned a non-byte chunk.",
            );
          }
          yield chunk;
        }
      } finally {
        source.destroy();
      }
    })(),
  );
}

function normalizedContentType(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function extensionFor(input: {
  contentType?: string;
  originalName?: string;
}): string {
  const named = extname(input.originalName ?? "").toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(named)) return named;
  const byType: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "model/gltf-binary": ".glb",
  };
  return byType[normalizedContentType(input.contentType) ?? ""] ?? ".bin";
}

function sameFacts(
  existing: LocalResourceRow,
  intended: LocalResourceFacts,
): boolean {
  return (
    existing.resourceId === intended.resourceId &&
    existing.kind === intended.kind &&
    existing.digest === intended.digest &&
    existing.byteLength === intended.byteLength &&
    existing.contentType === intended.contentType
  );
}

export function createLocalResourceStore(options: {
  dataDir: string;
  clashRoot?: string;
  onEvent?: (event: LocalResourceStoreEvent) => void;
}): LocalResourceStore {
  const databasePath = `${options.dataDir}/local.sqlite`;

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

  async function rowFor(
    resourceId: string,
  ): Promise<LocalResourceRow | undefined> {
    return withDatabase((database) => {
      const row = database
        .prepare(
          `
          SELECT resource_id, kind, digest_sha256, byte_length,
                 content_type, storage_key, facts_verified, created_at
          FROM local_resources
          WHERE resource_id = ?
        `,
        )
        .get(resourceId);
      return row ? parseRow(row) : undefined;
    });
  }

  async function stagingRowFor(
    resourceId: string,
  ): Promise<LocalResourceStagingRow | undefined> {
    return withDatabase((database) => {
      const row = database
        .prepare(
          `
          SELECT resource_id, digest_sha256, byte_length, storage_key
          FROM local_resource_staging
          WHERE resource_id = ?
        `,
        )
        .get(resourceId);
      return row ? parseStagingRow(row) : undefined;
    });
  }

  const pathForRead = (storageKey: string) => () =>
    assetPathForRead(options.dataDir, storageKey, options.clashRoot);

  /** Stat only: the registered digest is the identity computed at import. */
  async function projection(
    row: LocalResourceRow,
  ): Promise<LocalResourceProjection> {
    const path = await assertLocalResourceFile({
      resourceId: row.resourceId,
      byteLength: row.byteLength,
      path: pathForRead(row.storageKey),
    });
    return {
      resource: resourceFromRow(row),
      createdAt: row.createdAt,
      storageKey: row.storageKey,
      path,
    };
  }

  async function stagingProjection(
    row: LocalResourceStagingRow,
  ): Promise<LocalResourceStagingProjection> {
    const path = await assertLocalResourceFile({
      resourceId: row.resourceId,
      byteLength: row.byteLength,
      path: pathForRead(row.storageKey),
    });
    return {
      receipt: {
        resourceId: row.resourceId,
        digest: row.digest,
        byteLength: row.byteLength,
      },
      resourceId: row.resourceId,
      digest: row.digest,
      byteLength: row.byteLength,
      storageKey: row.storageKey,
      path,
    };
  }

  async function persist(
    intended: LocalResourceFacts,
    storageKey: string,
    factsVerified: boolean,
  ): Promise<LocalResourceProjection> {
    await withDatabase((database) => {
      database
        .prepare(
          `
          INSERT OR IGNORE INTO local_resources (
            resource_id, kind, digest_sha256, byte_length,
            content_type, storage_key, facts_verified, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          intended.resourceId,
          intended.kind,
          intended.digest,
          intended.byteLength,
          intended.contentType ?? null,
          storageKey,
          factsVerified ? 1 : 0,
          Date.now(),
        );
    });
    let stored = await rowFor(intended.resourceId);
    if (!stored) {
      throw new Error(`Local Resource ${intended.resourceId} was not indexed.`);
    }
    if (factsVerified && !stored.factsVerified) {
      await promoteVerifiedFacts(intended);
      stored = await rowFor(intended.resourceId);
      if (!stored) {
        throw new Error(
          `Local Resource ${intended.resourceId} was not indexed.`,
        );
      }
    }
    if (
      !sameFacts(stored, intended) ||
      (factsVerified && !stored.factsVerified)
    ) {
      throw new Error(
        `Local Resource ${intended.resourceId} already exists with different immutable facts.`,
      );
    }
    return projection(stored);
  }

  async function promoteVerifiedFacts(
    intended: LocalResourceFacts,
  ): Promise<void> {
    await withDatabase((database) => {
      database
        .prepare(
          `
          UPDATE local_resources
          SET kind = ?, content_type = ?, facts_verified = 1
          WHERE resource_id = ? AND facts_verified = 0
        `,
        )
        .run(intended.kind, intended.contentType ?? null, intended.resourceId);
    });
  }

  /**
   * Publishes the staged inode, whose digest was computed while it was
   * written, at the sealed path. Any other file already there is replaced by
   * that inode instead of being re-hashed.
   */
  async function materializeStagedBytes(input: {
    sourcePath: string;
    targetPath: string;
  }): Promise<void> {
    try {
      await link(input.sourcePath, input.targetPath);
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      const [source, target] = await Promise.all([
        stat(input.sourcePath),
        stat(input.targetPath).catch(() => undefined),
      ]);
      if (!target || target.dev !== source.dev || target.ino !== source.ino) {
        const temporaryPath = `${input.targetPath}.repair-${randomUUID()}`;
        await link(input.sourcePath, temporaryPath);
        try {
          await rename(temporaryPath, input.targetPath);
        } finally {
          await unlink(temporaryPath).catch(() => undefined);
        }
      }
    }
    await chmod(input.targetPath, 0o444);
  }

  async function sealResource(
    input: LocalResourceSealInput,
    factsVerified: boolean,
  ): Promise<LocalResourceProjection> {
    const kind = AssetKindSchema.parse(input.kind);
    const rawResourceId = input.receipt?.resourceId ?? input.resourceId;
    if (typeof rawResourceId !== "string") {
      throw new Error("Local Resource staging receipt is invalid.");
    }
    const requestedResourceId = rawResourceId.trim();
    const existing = await rowFor(requestedResourceId);
    const stagedRow = await stagingRowFor(requestedResourceId);
    const receipt =
      input.receipt ??
      (existing
        ? {
            resourceId: existing.resourceId,
            digest: existing.digest,
            byteLength: existing.byteLength,
          }
        : stagedRow
          ? {
              resourceId: stagedRow.resourceId,
              digest: stagedRow.digest,
              byteLength: stagedRow.byteLength,
            }
          : undefined);
    if (!receipt) {
      throw new Error(
        `Local Resource staging receipt ${requestedResourceId} is not available.`,
      );
    }
    const resourceId = resourceIdForSha256(receipt.digest);
    if (
      receipt.resourceId !== resourceId ||
      receipt.resourceId !== requestedResourceId ||
      !Number.isSafeInteger(receipt.byteLength) ||
      receipt.byteLength < 0
    ) {
      throw new Error("Local Resource staging receipt is invalid.");
    }
    const contentType = normalizedContentType(input.contentType);
    const intended: LocalResourceFacts = {
      resourceId,
      kind,
      digest: receipt.digest,
      byteLength: receipt.byteLength,
      ...(contentType ? { contentType } : {}),
    };
    if (existing) {
      try {
        await projection(existing);
      } catch (error) {
        if (!stagedRow || !(error instanceof LocalResourceError)) throw error;
        const staged = await stagingProjection(stagedRow);
        const path = await assetPathForWrite(
          options.dataDir,
          existing.storageKey,
          options.clashRoot,
        );
        await materializeStagedBytes({
          sourcePath: staged.path,
          targetPath: path,
        });
      }
      if (factsVerified && !existing.factsVerified) {
        await promoteVerifiedFacts(intended);
        const winner = await rowFor(resourceId);
        if (!winner || !winner.factsVerified || !sameFacts(winner, intended)) {
          throw new Error(
            `Local Resource ${resourceId} already exists with different immutable facts.`,
          );
        }
        return projection(winner);
      }
      if (!sameFacts(existing, intended)) {
        throw new Error(
          `Local Resource ${resourceId} already exists with different immutable facts.`,
        );
      }
      return projection(existing);
    }

    if (
      !stagedRow ||
      stagedRow.digest !== receipt.digest ||
      stagedRow.byteLength !== receipt.byteLength
    ) {
      throw new Error(
        `Local Resource staging receipt ${resourceId} is not available.`,
      );
    }
    const staged = await stagingProjection(stagedRow);
    const storageKey = `local-blobs/${stagedRow.digest}/original${extensionFor({ contentType })}`;
    const path = await assetPathForWrite(
      options.dataDir,
      storageKey,
      options.clashRoot,
    );
    await materializeStagedBytes({
      sourcePath: staged.path,
      targetPath: path,
    });
    return persist(intended, storageKey, factsVerified);
  }

  const store: LocalResourceStore = {
    async readFacts(resourceId) {
      const row = await rowFor(resourceId);
      return row ? resourceFromRow(row) : undefined;
    },
    async installReplica({ resource: input, verifiedResourceId }) {
      const resource = ResourceSchema.parse(input);
      const verified = await rowFor(verifiedResourceId);
      if (
        !verified?.factsVerified ||
        verified.kind !== resource.kind ||
        verified.digest !== resource.digest.value ||
        verified.byteLength !== resource.byteLength ||
        verified.contentType !== resource.contentType
      ) {
        throw new Error(
          "Replicated Resource facts must match a locally verified Resource",
        );
      }
      await projection(verified);
      return persist(
        {
          resourceId: resource.id,
          kind: resource.kind,
          digest: resource.digest.value,
          byteLength: resource.byteLength,
          ...(resource.contentType
            ? { contentType: resource.contentType }
            : {}),
        },
        verified.storageKey,
        true,
      );
    },
    async stage(input) {
      const digest = sha256(input.bytes);
      const resourceId = resourceIdForSha256(digest);
      const byteLength = input.bytes.byteLength;
      const existing = await stagingRowFor(resourceId);
      if (existing) {
        try {
          return await stagingProjection(existing);
        } catch (error) {
          if (!(error instanceof LocalResourceError)) throw error;
          // A retry that supplies the exact digest bytes can restore a staging
          // projection damaged outside the Host without publishing a Resource.
          const path = await assetPathForWrite(
            options.dataDir,
            existing.storageKey,
            options.clashRoot,
          );
          const temporaryPath = `${path}.repair-${randomUUID()}`;
          await writeFile(temporaryPath, input.bytes, {
            flag: "wx",
            mode: 0o444,
          });
          try {
            await rename(temporaryPath, path);
          } finally {
            await unlink(temporaryPath).catch(() => undefined);
          }
          await chmod(path, 0o444);
          return stagingProjection(existing);
        }
      }

      const storageKey = `local-blobs/${digest}/staging`;
      const path = await assetPathForWrite(
        options.dataDir,
        storageKey,
        options.clashRoot,
      );
      const temporaryPath = `${path}.staging-${randomUUID()}`;
      await writeFile(temporaryPath, input.bytes, { flag: "wx", mode: 0o444 });
      let linked = false;
      try {
        try {
          await link(temporaryPath, path);
        } catch (error) {
          if (errnoCode(error) !== "EEXIST") throw error;
          // An unreferenced file left at this path is replaced by the bytes
          // just hashed rather than re-read.
          await rename(temporaryPath, path);
        }
        linked = true;
        await chmod(path, 0o444);
        await withDatabase((database) => {
          database
            .prepare(
              `
            INSERT OR IGNORE INTO local_resource_staging (
              resource_id, digest_sha256, byte_length, storage_key, created_at
            ) VALUES (?, ?, ?, ?, ?)
          `,
            )
            .run(resourceId, digest, byteLength, storageKey, Date.now());
        });
        const stored = await stagingRowFor(resourceId);
        if (!stored) {
          throw new Error(
            `Local Resource staging receipt ${resourceId} was not indexed.`,
          );
        }
        return await stagingProjection(stored);
      } catch (error) {
        // A failure after the staging name exists must remove both that name
        // and its receipt; otherwise the bytes leak with nothing pointing at
        // them. The caller rethrows the original coded error.
        if (linked) {
          await unlink(path).catch(() => undefined);
          await withDatabase((database) => {
            database
              .prepare(
                "DELETE FROM local_resource_staging WHERE resource_id = ?",
              )
              .run(resourceId);
          }).catch(() => undefined);
        }
        throw error;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    },

    async stageStream(input) {
      const maxByteLength = boundedByteLength(
        input.maxByteLength,
        "Local Resource stream maximum byte length",
      );
      const declaredByteLength =
        input.declaredByteLength === undefined
          ? undefined
          : boundedByteLength(
              input.declaredByteLength,
              "Local Resource stream declared byte length",
            );
      if (
        declaredByteLength !== undefined &&
        declaredByteLength > maxByteLength
      ) {
        throw new LocalResourceStreamLimitError(maxByteLength);
      }
      if (input.expectedDigest !== undefined) {
        resourceIdForSha256(input.expectedDigest);
      }

      const temporaryStorageKey = `local-blobs/stream-staging/${randomUUID()}.tmp`;
      const temporaryPath = await assetPathForWrite(
        options.dataDir,
        temporaryStorageKey,
        options.clashRoot,
      );
      const handle = await open(temporaryPath, "wx", 0o600);
      let handleOpen = true;
      let linkedPath: string | undefined;
      let linkedResourceId: string | undefined;
      try {
        const digestState = createHash("sha256");
        let byteLength = 0;
        for await (const chunk of input.source) {
          if (!(chunk instanceof Uint8Array)) {
            throw new Error(
              "Local Resource stream must yield Uint8Array chunks.",
            );
          }
          const nextByteLength = byteLength + chunk.byteLength;
          if (
            !Number.isSafeInteger(nextByteLength) ||
            nextByteLength > maxByteLength
          ) {
            throw new LocalResourceStreamLimitError(maxByteLength);
          }
          if (
            declaredByteLength !== undefined &&
            nextByteLength > declaredByteLength
          ) {
            throw new LocalResourceStreamLengthMismatchError(
              "Local Resource stream exceeds its declared byte length.",
            );
          }
          await writeAll(handle, chunk);
          digestState.update(chunk);
          byteLength = nextByteLength;
        }
        if (
          declaredByteLength !== undefined &&
          byteLength !== declaredByteLength
        ) {
          throw new LocalResourceStreamLengthMismatchError(
            `Local Resource stream byte length ${byteLength} does not match its declared byte length ${declaredByteLength}.`,
          );
        }
        const digest = digestState.digest("hex");
        if (
          input.expectedDigest !== undefined &&
          digest !== input.expectedDigest
        ) {
          throw new LocalResourceStreamMismatchError(
            `Local Resource stream digest mismatch: expected ${input.expectedDigest}, got ${digest}.`,
          );
        }
        await handle.sync();
        await handle.close();
        handleOpen = false;
        await chmod(temporaryPath, 0o444);

        const resourceId = resourceIdForSha256(digest);
        linkedResourceId = resourceId;
        const storageKey = `local-blobs/${digest}/staging`;
        const path = await assetPathForWrite(
          options.dataDir,
          storageKey,
          options.clashRoot,
        );
        try {
          await link(temporaryPath, path);
        } catch (error) {
          if (errnoCode(error) !== "EEXIST") throw error;
          // The bytes just hashed while streaming replace whatever file is
          // already at this path; it is never re-read to decide.
          await rename(temporaryPath, path);
        }
        linkedPath = path;
        await chmod(path, 0o444);
        await withDatabase((database) => {
          database
            .prepare(
              `
              INSERT OR IGNORE INTO local_resource_staging (
                resource_id, digest_sha256, byte_length, storage_key, created_at
              ) VALUES (?, ?, ?, ?, ?)
            `,
            )
            .run(resourceId, digest, byteLength, storageKey, Date.now());
        });
        const stored = await stagingRowFor(resourceId);
        if (
          !stored ||
          stored.digest !== digest ||
          stored.byteLength !== byteLength ||
          stored.storageKey !== storageKey
        ) {
          throw new Error(
            `Local Resource staging receipt ${resourceId} was not indexed with the streamed facts.`,
          );
        }
        return await stagingProjection(stored);
      } catch (error) {
        // Never leave the staging name or its receipt behind for a failed
        // stream: both are unreferenced once this call fails.
        if (linkedPath) {
          await unlink(linkedPath).catch(() => undefined);
          const resourceId = linkedResourceId;
          if (resourceId) {
            await withDatabase((database) => {
              database
                .prepare(
                  "DELETE FROM local_resource_staging WHERE resource_id = ?",
                )
                .run(resourceId);
            }).catch(() => undefined);
          }
        }
        throw error;
      } finally {
        if (handleOpen) await handle.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
      }
    },

    async resolveStaged(resourceId) {
      const normalized = resourceId.trim();
      if (!normalized) return undefined;
      const row = await stagingRowFor(normalized);
      return row ? stagingProjection(row) : undefined;
    },

    async adoptAssembled(input) {
      const digest = input.digest.trim().toLowerCase();
      resourceIdForSha256(digest);
      if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
        throw new Error(
          "An assembled Resource byte length must be a non-negative safe integer.",
        );
      }
      const resourceId = resourceIdForSha256(digest);
      const existing = await stagingRowFor(resourceId);
      if (existing) {
        try {
          return await stagingProjection(existing);
        } catch (error) {
          if (!(error instanceof LocalResourceError)) throw error;
        }
      }
      const source = await stat(input.sourcePath).catch(
        (error: NodeJS.ErrnoException) => {
          throw new Error(
            `Assembled Resource ${resourceId} has no file at ${input.sourcePath}${error.code ? ` (${error.code})` : ""}.`,
            { cause: error },
          );
        },
      );
      if (!source.isFile() || source.size !== input.byteLength) {
        throw new Error(
          `Assembled Resource ${resourceId} is ${source.size} bytes; the assembly reported ${input.byteLength}.`,
        );
      }
      const storageKey = `local-blobs/${digest}/staging`;
      const path = await assetPathForWrite(
        options.dataDir,
        storageKey,
        options.clashRoot,
      );
      let moved = false;
      try {
        try {
          await rename(input.sourcePath, path);
        } catch (error) {
          const errno = errnoCode(error);
          if (errno === "EXDEV") {
            const started = Date.now();
            await copyFileBounded(input.sourcePath, path);
            options.onEvent?.({
              level: "info",
              event: "project_asset_import.exdev_fallback",
              fields: {
                resourceId,
                bytes: input.byteLength,
                ms: Date.now() - started,
                reason: errno,
              },
            });
          } else if (errno === "EEXIST" || errno === "EPERM") {
            // Windows refuses to replace an existing target with rename.
            await unlink(path).catch((removeError: NodeJS.ErrnoException) => {
              if (removeError.code !== "ENOENT") throw removeError;
            });
            await rename(input.sourcePath, path);
          } else {
            throw error;
          }
        }
        moved = true;
        await chmod(path, 0o444);
        await withDatabase((database) => {
          database
            .prepare(
              `
              INSERT OR IGNORE INTO local_resource_staging (
                resource_id, digest_sha256, byte_length, storage_key, created_at
              ) VALUES (?, ?, ?, ?, ?)
            `,
            )
            .run(resourceId, digest, input.byteLength, storageKey, Date.now());
        });
        const stored = await stagingRowFor(resourceId);
        if (
          !stored ||
          stored.digest !== digest ||
          stored.byteLength !== input.byteLength ||
          stored.storageKey !== storageKey
        ) {
          throw new Error(
            `Local Resource staging receipt ${resourceId} was not indexed with the assembled facts.`,
          );
        }
        return stagingProjection(stored);
      } catch (error) {
        // No receipt and no partially adopted file: the import session's
        // staging delete and the finalize error still explain the failure.
        if (moved) {
          await unlink(path).catch(() => undefined);
          await withDatabase((database) => {
            database
              .prepare(
                "DELETE FROM local_resource_staging WHERE resource_id = ?",
              )
              .run(resourceId);
          }).catch(() => undefined);
        }
        throw error;
      }
    },

    async discardStaged(resourceIdInput) {
      const resourceId = resourceIdInput.trim();
      if (!resourceId) return;
      const staged = await stagingRowFor(resourceId);
      if (!staged) return;
      // Receipt first: a crash in between leaves an unreferenced file, never a
      // receipt without bytes.
      await withDatabase((database) => {
        database
          .prepare("DELETE FROM local_resource_staging WHERE resource_id = ?")
          .run(staged.resourceId);
      });
      const path = await assetPathForDelete(
        options.dataDir,
        staged.storageKey,
        options.clashRoot,
      );
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },

    async releaseStaged(resourceId) {
      const staged = await stagingRowFor(resourceId.trim());
      if (!staged) return;
      const sealed = await rowFor(staged.resourceId);
      if (
        !sealed ||
        sealed.digest !== staged.digest ||
        sealed.byteLength !== staged.byteLength ||
        sealed.storageKey === staged.storageKey
      ) {
        return;
      }
      // The staging file may be the last intact copy; only a sealed file that
      // is present at its registered length may replace it.
      await projection(sealed);
      // Receipt first: a crash in between leaves an unreferenced file that the
      // next stage of the same digest replaces, never a receipt without bytes.
      await withDatabase((database) => {
        database
          .prepare("DELETE FROM local_resource_staging WHERE resource_id = ?")
          .run(staged.resourceId);
      });
      const path = await assetPathForWrite(
        options.dataDir,
        staged.storageKey,
        options.clashRoot,
      );
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },

    seal(input) {
      return sealResource(input, true);
    },

    async install(input) {
      const staged = await store.stage({
        bytes: input.bytes,
        ...(input.originalName ? { originalName: input.originalName } : {}),
      });
      return sealResource(
        {
          receipt: staged.receipt,
          kind: input.kind,
          ...(input.contentType ? { contentType: input.contentType } : {}),
        },
        false,
      );
    },

    async adopt(input) {
      const kind = AssetKindSchema.parse(input.kind);
      resourceIdForSha256(input.digest);
      if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
        throw new Error(
          "A Local Resource byte length must be a non-negative safe integer.",
        );
      }
      const storageKey = normalizeLocalBlobStorageKey(input.localBlobKey);
      const path = await assetPathForRead(
        options.dataDir,
        storageKey,
        options.clashRoot,
      );
      // The one hash pass over the adopted bytes both checks the claimed digest
      // and stages them.
      const staged = await store.stageStream({
        source: createReadStream(path),
        declaredByteLength: input.byteLength,
        maxByteLength: input.byteLength,
        expectedDigest: input.digest,
      });
      const sealed = await sealResource(
        {
          receipt: staged.receipt,
          kind,
          ...(input.contentType ? { contentType: input.contentType } : {}),
        },
        false,
      );
      await chmod(path, 0o444);
      return sealed;
    },

    async resolve(resourceId) {
      const normalized = resourceId.trim();
      if (!normalized) return undefined;
      const row = await rowFor(normalized);
      return row ? projection(row) : undefined;
    },

    async resolveStream(resourceId) {
      const normalized = resourceId.trim();
      if (!normalized) return undefined;
      const row = await rowFor(normalized);
      if (!row) return undefined;
      const resolved = await projection(row);
      return {
        resource: resolved.resource,
        stream: pathlessReadStream(resolved.path),
      };
    },
  };
  return store;
}

/** One staging receipt or file the Host removed during a sweep. */
export interface LocalResourceStagingSweepRemoval {
  resourceId?: string;
  storageKey?: string;
  reason:
    "unreferenced" | "sealed" | "missing_file" | "orphan_file" | "stream_temp";
}

/** A staging cleanup the sweep could not finish; the next sweep retries it. */
export interface LocalResourceStagingSweepFailure {
  resourceId?: string;
  storageKey?: string;
  message: string;
}

export interface LocalResourceStagingSweepResult {
  /** Staging receipts and files considered by this sweep. */
  scanned: number;
  removed: LocalResourceStagingSweepRemoval[];
  failed: LocalResourceStagingSweepFailure[];
}

export const PROJECT_ASSET_IMPORT_STAGING_REMOVED =
  "PROJECT_ASSET_IMPORT_STAGING_REMOVED";

/**
 * Removes Local Resource staging that no import can still own: receipts and
 * files older than the caller's safe age whose sealed original is either
 * already present or never existed. Entries younger than the age are left
 * alone even when they look unreferenced, so an in-flight `stageStream` (which
 * creates the staging name before its receipt row) is never swept.
 *
 * The receipt row is deleted before its file, matching the store's crash
 * ordering: a crash leaves an unreferenced file, never a receipt without
 * bytes. The next sweep catches either half.
 */
export async function sweepLocalResourceStaging(options: {
  dataDir: string;
  clashRoot?: string;
  olderThanMs: number;
  now?: number;
}): Promise<LocalResourceStagingSweepResult> {
  if (!Number.isSafeInteger(options.olderThanMs) || options.olderThanMs < 0) {
    throw new Error(
      "A Local Resource staging sweep age must be a non-negative safe integer.",
    );
  }
  const now = options.now ?? Date.now();
  const cutoff = now - options.olderThanMs;
  const connection = createLocalSqliteConnection({
    dataDir: options.dataDir,
    path: `${options.dataDir}/local.sqlite`,
    open: openDatabase,
  });
  const removed: LocalResourceStagingSweepRemoval[] = [];
  const failed: LocalResourceStagingSweepFailure[] = [];
  let scanned = 0;
  const blobsRoot = join(
    clashHomeForLocalDataDir(options.dataDir, options.clashRoot),
    "assets",
    "blobs",
  );

  const stagingRows = async () =>
    connection.use((database) =>
      database
        .prepare(
          `
          SELECT resource_id, digest_sha256, byte_length, storage_key, created_at
          FROM local_resource_staging
        `,
        )
        .all(),
    );

  const assertSealedOriginalPresent = async (input: {
    digest: string;
    storageKey: string;
    byteLength: number;
    keep: "staging bytes" | "staging file";
  }): Promise<void> => {
    try {
      const path = await assetPathForRead(
        options.dataDir,
        input.storageKey,
        options.clashRoot,
      );
      const file = await stat(path);
      if (!file.isFile() || file.size !== input.byteLength) {
        throw new Error("registered length does not match");
      }
    } catch (error) {
      throw new Error(
        `Sealed Resource ${input.digest} is not present at its registered length; keeping its ${input.keep}.`,
        { cause: error },
      );
    }
  };

  try {
    const rows = await stagingRows();
    for (const row of rows) {
      scanned += 1;
      const resourceId =
        typeof row.resource_id === "string" ? row.resource_id : undefined;
      const digest =
        typeof row.digest_sha256 === "string" ? row.digest_sha256 : undefined;
      const storageKey =
        typeof row.storage_key === "string" ? row.storage_key : undefined;
      const createdAt =
        typeof row.created_at === "number" ? row.created_at : undefined;
      if (!resourceId || !digest || !storageKey || createdAt === undefined) {
        failed.push({
          ...(resourceId ? { resourceId } : {}),
          ...(storageKey ? { storageKey } : {}),
          message: "Local Resource staging row is corrupt.",
        });
        continue;
      }
      if (createdAt > cutoff) continue;
      try {
        const path = await assetPathForDelete(
          options.dataDir,
          storageKey,
          options.clashRoot,
        );
        const file = await stat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        // A receipt can be older than a file that a concurrent retry just
        // replaced at the same content address. Only sweep a file that is also
        // past the safe age.
        if (file && file.mtimeMs > cutoff) continue;
        const sealed = await connection.use((database) =>
          database
            .prepare(
              "SELECT storage_key, byte_length FROM local_resources WHERE digest_sha256 = ? LIMIT 1",
            )
            .get(digest),
        );
        if (sealed) {
          const sealedStorageKey =
            typeof sealed.storage_key === "string" ? sealed.storage_key : "";
          // A corrupt/legacy sealed row can point at the staging name itself.
          // Unlinking it would delete the only copy of the sealed bytes.
          if (sealedStorageKey === storageKey) {
            throw new Error(
              `Sealed Resource ${digest} is registered at its staging storage key ${storageKey}; refusing to unlink the staging path.`,
            );
          }
          // The staging name can be the last intact copy of these bytes. Keep
          // it unless the sealed original is present at its registered length.
          await assertSealedOriginalPresent({
            digest,
            storageKey: sealedStorageKey,
            byteLength:
              typeof sealed.byte_length === "number" ? sealed.byte_length : -1,
            keep: "staging bytes",
          });
        }
        await connection.use((database) => {
          database
            .prepare("DELETE FROM local_resource_staging WHERE resource_id = ?")
            .run(resourceId);
        });
        if (file) {
          await unlink(path);
        }
        removed.push({
          resourceId,
          storageKey,
          reason: file ? (sealed ? "sealed" : "unreferenced") : "missing_file",
        });
      } catch (error) {
        failed.push({
          resourceId,
          storageKey,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // A crash between deleting a receipt and unlinking its file leaves a
    // `local-blobs/<digest>/staging` name with no row. Only the staging name is
    // removed; a sealed `original.*` is a different directory entry and is
    // never touched.
    const digestDirectories = await readdir(blobsRoot, {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of digestDirectories) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      scanned += 1;
      const storageKey = `local-blobs/${entry.name}/staging`;
      const path = join(blobsRoot, entry.name, "staging");
      try {
        const file = await stat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!file || file.mtimeMs > cutoff) continue;
        const row = await connection.use((database) =>
          database
            .prepare(
              "SELECT resource_id FROM local_resource_staging WHERE storage_key = ? LIMIT 1",
            )
            .get(storageKey),
        );
        if (row) continue;
        const sealed = await connection.use((database) =>
          database
            .prepare(
              "SELECT storage_key, byte_length FROM local_resources WHERE digest_sha256 = ? LIMIT 1",
            )
            .get(entry.name),
        );
        if (sealed) {
          const sealedStorageKey =
            typeof sealed.storage_key === "string" ? sealed.storage_key : "";
          // Same defensive rule as the receipt loop: never treat the staging
          // name as redundant when it is the sealed Resource's storage.
          if (sealedStorageKey === storageKey) {
            throw new Error(
              `Sealed Resource ${entry.name} is registered at its staging storage key ${storageKey}; refusing to unlink the staging path.`,
            );
          }
          await assertSealedOriginalPresent({
            digest: entry.name,
            storageKey: sealedStorageKey,
            byteLength:
              typeof sealed.byte_length === "number" ? sealed.byte_length : -1,
            keep: "staging file",
          });
        }
        await unlink(path);
        removed.push({
          storageKey,
          reason: "orphan_file",
        });
      } catch (error) {
        failed.push({
          storageKey,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Streamed imports write a temporary name before their content address is
    // known. A crash can leave one behind with no receipt at all.
    const streamRoot = join(blobsRoot, "stream-staging");
    const streamTemporaries = await readdir(streamRoot).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const name of streamTemporaries) {
      const storageKey = `local-blobs/stream-staging/${name}`;
      const path = join(streamRoot, name);
      scanned += 1;
      try {
        const file = await stat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!file || file.mtimeMs > cutoff) continue;
        await unlink(path);
        removed.push({ storageKey, reason: "stream_temp" });
      } catch (error) {
        failed.push({
          storageKey,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await connection.close();
  }

  return { scanned, removed, failed };
}
