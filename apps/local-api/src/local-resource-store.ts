import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";

import {
  AssetKindSchema,
  ResourceSchema,
  type AssetKind,
  type Resource,
} from "@clash/shared-types";

import {
  assetPathForRead,
  assetPathForWrite,
  normalizeLocalBlobStorageKey,
} from "./local-asset-paths.js";

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

/** Host-private immutable read handle. Storage paths and keys stay inside the Resource store. */
export interface LocalResourceStreamProjection {
  resource: Resource;
  stream: Readable;
}

export interface LocalResourceStore {
  /** Registry facts only; does not open or hash the immutable byte file. */
  readFacts(resourceId: string): Promise<Resource | undefined>;
  /** Replicate opaque identity only from a locally inspected, verified Resource. */
  installReplica(input: { resource: Resource; verifiedResourceId: string }): Promise<LocalResourceProjection>;
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
  resolveStaged(
    resourceId: string,
  ): Promise<LocalResourceStagingProjection | undefined>;
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
}): LocalResourceStore {
  const databasePath = `${options.dataDir}/local.sqlite`;

  async function withDatabase<T>(
    task: (database: SqliteDatabase) => T,
  ): Promise<T> {
    await mkdir(options.dataDir, { recursive: true });
    const database = openDatabase(databasePath);
    try {
      return task(database);
    } finally {
      database.close();
      await chmod(databasePath, 0o600).catch(() => undefined);
    }
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

  async function projection(
    row: LocalResourceRow,
  ): Promise<LocalResourceProjection> {
    let path: string;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      path = await assetPathForRead(
        options.dataDir,
        row.storageKey,
        options.clashRoot,
      );
      info = await stat(path);
    } catch (error) {
      throw new Error(
        `Local Resource ${row.resourceId} is corrupt: immutable bytes are missing.`,
        {
          cause: error,
        },
      );
    }
    if (!info.isFile() || info.size !== row.byteLength) {
      throw new Error(
        `Local Resource ${row.resourceId} is corrupt: byte length does not match its registry facts.`,
      );
    }
    try {
      await verifyBytes({
        path,
        digest: row.digest,
        byteLength: row.byteLength,
      });
    } catch (error) {
      throw new Error(
        `Local Resource ${row.resourceId} is corrupt: bytes do not match its immutable digest.`,
        { cause: error },
      );
    }
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
    const path = await assetPathForRead(
      options.dataDir,
      row.storageKey,
      options.clashRoot,
    );
    await verifyBytes({ path, digest: row.digest, byteLength: row.byteLength });
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

  async function verifyBytes(input: {
    path: string;
    digest: string;
    byteLength: number;
  }): Promise<void> {
    const digest = createHash("sha256");
    let byteLength = 0;
    for await (const chunk of createReadStream(input.path)) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error(
          "Local Resource read stream returned a non-byte chunk.",
        );
      }
      byteLength += chunk.byteLength;
      digest.update(chunk);
    }
    if (byteLength !== input.byteLength) {
      throw new Error(
        "Local Resource byte length does not match the claimed immutable facts.",
      );
    }
    if (digest.digest("hex") !== input.digest) {
      throw new Error(
        "Local Resource digest does not match the claimed immutable facts.",
      );
    }
  }

  async function materializeStagedBytes(input: {
    sourcePath: string;
    targetPath: string;
    digest: string;
    byteLength: number;
  }): Promise<void> {
    await link(input.sourcePath, input.targetPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    try {
      await verifyBytes({
        path: input.targetPath,
        digest: input.digest,
        byteLength: input.byteLength,
      });
    } catch {
      const temporaryPath = `${input.targetPath}.repair-${randomUUID()}`;
      await link(input.sourcePath, temporaryPath);
      try {
        await rename(temporaryPath, input.targetPath);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
    await chmod(input.targetPath, 0o444);
    await verifyBytes({
      path: input.targetPath,
      digest: input.digest,
      byteLength: input.byteLength,
    });
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
        if (!stagedRow) throw error;
        const staged = await stagingProjection(stagedRow);
        const path = await assetPathForWrite(
          options.dataDir,
          existing.storageKey,
          options.clashRoot,
        );
        await materializeStagedBytes({
          sourcePath: staged.path,
          targetPath: path,
          digest: existing.digest,
          byteLength: existing.byteLength,
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
      digest: stagedRow.digest,
      byteLength: stagedRow.byteLength,
    });
    return persist(intended, storageKey, factsVerified);
  }

  const store: LocalResourceStore = {
    async readFacts(resourceId) { const row = await rowFor(resourceId); return row ? resourceFromRow(row) : undefined; },
    async installReplica({ resource: input, verifiedResourceId }) {
      const resource = ResourceSchema.parse(input);
      const verified = await rowFor(verifiedResourceId);
      if (!verified?.factsVerified || verified.kind !== resource.kind || verified.digest !== resource.digest.value || verified.byteLength !== resource.byteLength || verified.contentType !== resource.contentType) {
        throw new Error("Replicated Resource facts must match a locally verified Resource");
      }
      await projection(verified);
      return persist({ resourceId: resource.id, kind: resource.kind, digest: resource.digest.value, byteLength: resource.byteLength, ...(resource.contentType ? { contentType: resource.contentType } : {}) }, verified.storageKey, true);
    },
    async stage(input) {
      const digest = sha256(input.bytes);
      const resourceId = resourceIdForSha256(digest);
      const byteLength = input.bytes.byteLength;
      const existing = await stagingRowFor(resourceId);
      if (existing) {
        try {
          return await stagingProjection(existing);
        } catch {
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
            await verifyBytes({ path: temporaryPath, digest, byteLength });
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
      try {
        await link(temporaryPath, path).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      await chmod(path, 0o444);
      await verifyBytes({ path, digest, byteLength });
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
      return stagingProjection(stored);
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
        throw new Error(
          "Local Resource stream declared byte length exceeds its maximum byte length.",
        );
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
            throw new Error(
              "Local Resource stream exceeds its maximum byte length.",
            );
          }
          if (
            declaredByteLength !== undefined &&
            nextByteLength > declaredByteLength
          ) {
            throw new Error(
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
          throw new Error(
            `Local Resource stream byte length ${byteLength} does not match its declared byte length ${declaredByteLength}.`,
          );
        }
        const digest = digestState.digest("hex");
        if (
          input.expectedDigest !== undefined &&
          digest !== input.expectedDigest
        ) {
          throw new Error(
            `Local Resource stream digest mismatch: expected ${input.expectedDigest}, got ${digest}.`,
          );
        }
        await handle.sync();
        await handle.close();
        handleOpen = false;
        await chmod(temporaryPath, 0o444);

        const resourceId = resourceIdForSha256(digest);
        const storageKey = `local-blobs/${digest}/staging`;
        const path = await assetPathForWrite(
          options.dataDir,
          storageKey,
          options.clashRoot,
        );
        try {
          await link(temporaryPath, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            await verifyBytes({ path, digest, byteLength });
          } catch {
            await rename(temporaryPath, path);
          }
        }
        await chmod(path, 0o444);
        await verifyBytes({ path, digest, byteLength });
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
        return stagingProjection(stored);
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
      await verifyBytes({
        path,
        digest: input.digest,
        byteLength: input.byteLength,
      });
      const staged = await store.stage({
        bytes: new Uint8Array(await readFile(path)),
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
