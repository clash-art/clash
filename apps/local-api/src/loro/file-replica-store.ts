import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { LoroDoc } from "loro-crdt";
import {
  ProjectCanvasPreviewSchema,
  type ProjectCanvasPreview,
} from "@clash/shared-types";

import { invalidateLocalProjectAssetCaches } from "../local-project-asset-cache.js";

export interface FileReplicaStoreOptions {
  publishImportedSnapshot?: (
    temporaryPath: string,
    finalPath: string,
  ) => Promise<void>;
  syncDirectory?: (path: string) => Promise<void>;
  /** Test/platform seam; the update log is durable only after this resolves. */
  syncUpdateLog?: (handle: FileHandle) => Promise<void>;
}

export interface ImportedProjectReservation {
  schemaVersion: 1;
  kind: "clash.workspace.import-reservation";
  reservationId: string;
  snapshotSha256: string;
}

export interface CachedProjectCanvasPreview {
  /** Content identity of the drawn preview; a timeline edit does not change it. */
  sourceVersion: string;
  /** Identity of the Project document the preview was derived from. */
  docVersion: string;
  generatedAt: string;
  preview: ProjectCanvasPreview;
}

function parseCachedProjectCanvasPreview(
  value: unknown,
): CachedProjectCanvasPreview | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sourceVersion !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.sourceVersion) ||
    typeof candidate.docVersion !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.docVersion) ||
    typeof candidate.generatedAt !== "string" ||
    !candidate.generatedAt.trim()
  ) {
    return null;
  }
  const preview = ProjectCanvasPreviewSchema.safeParse(candidate.preview);
  if (!preview.success) return null;
  return {
    sourceVersion: candidate.sourceVersion,
    docVersion: candidate.docVersion,
    generatedAt: candidate.generatedAt,
    preview: preview.data,
  };
}

function exactBytes(view: Uint8Array): Uint8Array {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? view
    : new Uint8Array(view);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isExistingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function canvasThumbnailRevision(value: string): string {
  const revision = value.trim();
  if (!/^[a-f0-9]{64}$/u.test(revision)) {
    throw new TypeError("Project canvas thumbnail revision is invalid.");
  }
  return revision;
}

const CANVAS_THUMBNAIL_CACHE_MAGIC = "CLASH_MAIN_CANVAS_THUMBNAIL_V1\n";

export class FileReplicaStore {
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly durableUpdateLogDirectories = new Set<string>();
  private readonly publishImportedSnapshot: (
    temporaryPath: string,
    finalPath: string,
  ) => Promise<void>;
  private readonly syncDirectory: (path: string) => Promise<void>;
  private readonly syncUpdateLog: (handle: FileHandle) => Promise<void>;

  constructor(
    private readonly rootDir: string,
    options: FileReplicaStoreOptions = {},
  ) {
    this.publishImportedSnapshot =
      options.publishImportedSnapshot ??
      (async (temporaryPath, finalPath) => {
        await link(temporaryPath, finalPath);
      });
    this.syncDirectory =
      options.syncDirectory ??
      (async (path) => {
        // Windows cannot flush a directory handle; the file's own fsync is the durability there.
        if (process.platform === "win32") return;
        const handle = await open(path, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
    this.syncUpdateLog =
      options.syncUpdateLog ?? ((handle) => handle.datasync());
  }

  async readImportReservation(
    projectId: string,
  ): Promise<ImportedProjectReservation | null> {
    let raw: string;
    try {
      raw = await readFile(this.importReservationPath(projectId), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    const value = JSON.parse(raw) as Partial<ImportedProjectReservation>;
    if (
      value.schemaVersion !== 1 ||
      value.kind !== "clash.workspace.import-reservation" ||
      typeof value.reservationId !== "string" ||
      !value.reservationId.trim() ||
      value.reservationId.length > 500 ||
      typeof value.snapshotSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.snapshotSha256)
    ) {
      throw new Error(
        `Project ${projectId} has a corrupt Workspace import reservation.`,
      );
    }
    return {
      schemaVersion: 1,
      kind: "clash.workspace.import-reservation",
      reservationId: value.reservationId,
      snapshotSha256: value.snapshotSha256,
    };
  }

  async reserveImportedProject(
    projectId: string,
    reservation: ImportedProjectReservation,
  ): Promise<void> {
    await this.enqueueProjectWrite(projectId, async () => {
      const normalized = this.validateImportReservation(reservation);
      const existing = await this.readImportReservation(projectId);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(normalized)) return;
        throw new Error(
          `Project ${projectId} is reserved by another Workspace import.`,
        );
      }
      const dir = this.loroDir(projectId);
      await mkdir(dir, { recursive: true });
      const temporaryPath = join(
        dir,
        `import-reservation.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(normalized)}\n`, {
            encoding: "utf8",
          });
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporaryPath, this.importReservationPath(projectId));
          await this.syncDirectory(dir);
        } catch (error) {
          if (
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            (error as NodeJS.ErrnoException).code !== "EEXIST"
          ) {
            throw error;
          }
          const raced = await this.readImportReservation(projectId);
          if (JSON.stringify(raced) !== JSON.stringify(normalized)) {
            throw new Error(
              `Project ${projectId} is reserved by another Workspace import.`,
            );
          }
        }
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        await this.syncDirectory(dir).catch(() => undefined);
      }
    });
  }

  async clearImportedProjectReservation(
    projectId: string,
    reservation: ImportedProjectReservation,
  ): Promise<void> {
    await this.enqueueProjectWrite(projectId, async () => {
      const normalized = this.validateImportReservation(reservation);
      const existing = await this.readImportReservation(projectId);
      if (!existing) return;
      if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
        throw new Error(
          `Project ${projectId} is reserved by another Workspace import.`,
        );
      }
      const dir = this.loroDir(projectId);
      await rm(this.importReservationPath(projectId));
      await this.syncDirectory(dir);
    });
  }

  async loadSnapshot(projectId: string): Promise<Uint8Array | null> {
    try {
      return exactBytes(await readFile(this.snapshotPath(projectId)));
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  /**
   * Cheap durable identity for a Project replica. Snapshot renames and update
   * log appends change it, so derived Dashboard cards can reject stale rows
   * without recovering the whole Loro document on every list.
   */
  async replicaStamp(projectId: string): Promise<string> {
    const parts = await Promise.all(
      [this.snapshotPath(projectId), this.updateLogPath(projectId)].map(
        async (path) => {
          try {
            const info = await stat(path, { bigint: true });
            return `${info.size}:${info.mtimeNs}`;
          } catch (error) {
            if (!isMissingFile(error)) throw error;
            return "missing";
          }
        },
      ),
    );
    return parts.join("|");
  }

  async loadReplicaCheckpointCursor(projectId: string): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(this.replicaCheckpointCursorPath(projectId), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return 0;
      throw error;
    }
    const cursor = Number(raw.trim());
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error(
        `Project ${projectId} has a corrupt replica checkpoint cursor.`,
      );
    }
    return cursor;
  }

  async saveReplicaCheckpointCursor(
    projectId: string,
    cursor: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TypeError("Replica checkpoint cursor is invalid.");
    }
    await this.enqueueProjectWrite(projectId, async () => {
      const dir = this.loroDir(projectId);
      await mkdir(dir, { recursive: true });
      const temporaryPath = join(
        dir,
        `checkpoint.cursor.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(`${cursor}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(
          temporaryPath,
          this.replicaCheckpointCursorPath(projectId),
        );
        await this.syncDirectory(dir);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
  }

  async readCanvasPreview(
    projectId: string,
  ): Promise<CachedProjectCanvasPreview | null> {
    let raw: string;
    try {
      raw = await readFile(this.canvasPreviewPath(projectId), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    return parseCachedProjectCanvasPreview(JSON.parse(raw) as unknown);
  }

  async writeCanvasPreview(
    projectId: string,
    entry: CachedProjectCanvasPreview,
  ): Promise<void> {
    const normalized = parseCachedProjectCanvasPreview(entry);
    if (!normalized) {
      throw new TypeError("Cached Project canvas preview is invalid.");
    }
    await this.enqueueProjectWrite(projectId, async () => {
      const dir = this.derivedDir(projectId);
      await mkdir(dir, { recursive: true });
      const finalPath = this.canvasPreviewPath(projectId);
      const temporaryPath = join(
        dir,
        `main-canvas-preview.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(normalized)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, finalPath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
  }

  async readCanvasThumbnail(
    projectId: string,
    sourceVersion: string,
  ): Promise<Uint8Array | null> {
    const revision = canvasThumbnailRevision(sourceVersion);
    try {
      const persisted = await readFile(this.canvasThumbnailPath(projectId));
      const header = Buffer.from(
        `${CANVAS_THUMBNAIL_CACHE_MAGIC}${revision}\n`,
        "utf8",
      );
      if (
        persisted.byteLength <= header.byteLength ||
        !persisted.subarray(0, header.byteLength).equals(header)
      ) {
        return null;
      }
      // Return a view, not a copy: the route streams these bytes directly.
      return persisted.subarray(header.byteLength);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async writeCanvasThumbnail(
    projectId: string,
    sourceVersion: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const revision = canvasThumbnailRevision(sourceVersion);
    if (bytes.byteLength === 0) {
      throw new TypeError("Cached Project canvas thumbnail must not be empty.");
    }
    await this.enqueueProjectWrite(projectId, async () => {
      const dir = this.derivedDir(projectId);
      await mkdir(dir, { recursive: true });
      const finalPath = this.canvasThumbnailPath(projectId);
      const temporaryPath = join(
        dir,
        `main-canvas-thumbnail.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(
            Buffer.concat([
              Buffer.from(
                `${CANVAS_THUMBNAIL_CACHE_MAGIC}${revision}\n`,
                "utf8",
              ),
              Buffer.from(bytes),
            ]),
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, finalPath);
        const legacyFiles = (await readdir(dir)).filter((name) =>
          /^main-canvas-thumbnail\.[a-f0-9]{64}\.webp$/u.test(name),
        );
        await Promise.all(
          legacyFiles.map((name) => rm(join(dir, name), { force: true })),
        );
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
  }

  async appendUpdate(projectId: string, update: Uint8Array): Promise<void> {
    await this.enqueueProjectWrite(projectId, async () => {
      await this.appendUpdateUnsafe(projectId, update);
    });
  }

  private async appendUpdateUnsafe(
    projectId: string,
    update: Uint8Array,
  ): Promise<void> {
    const dir = this.loroDir(projectId);
    const logPath = this.updateLogPath(projectId);
    await mkdir(dir, { recursive: true });
    const updateBytes = exactBytes(update);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(updateBytes.byteLength, 0);
    const handle = await open(logPath, "a", 0o600);
    try {
      await handle.writeFile(Buffer.concat([header, Buffer.from(updateBytes)]));
      // The caller acknowledges the edit only after this resolves. A crash
      // before it can therefore only drop work the client never saw acked.
      await this.syncUpdateLog(handle);
    } finally {
      await handle.close();
    }
    if (!this.durableUpdateLogDirectories.has(dir)) {
      // The file's data is durable, but a freshly created log also needs its
      // directory entry. One directory sync per Project/process is enough.
      await this.syncDirectory(dir);
      this.durableUpdateLogDirectories.add(dir);
    }
  }

  async updateLogSize(projectId: string): Promise<number> {
    try {
      return (await stat(this.updateLogPath(projectId))).size;
    } catch (error) {
      if (isMissingFile(error)) return 0;
      throw error;
    }
  }

  async loadUpdateLog(projectId: string): Promise<Uint8Array[]> {
    const logPath = this.updateLogPath(projectId);
    let log: Buffer;
    try {
      log = await readFile(logPath);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }

    const updates: Uint8Array[] = [];
    let offset = 0;
    while (offset < log.byteLength) {
      if (offset + 4 > log.byteLength) {
        await truncate(logPath, offset);
        break;
      }

      const length = log.readUInt32BE(offset);
      const recordStart = offset + 4;
      const recordEnd = recordStart + length;
      if (recordEnd > log.byteLength) {
        await truncate(logPath, offset);
        break;
      }

      updates.push(exactBytes(log.subarray(recordStart, recordEnd)));
      offset = recordEnd;
    }

    return updates;
  }

  async saveSnapshotAtomic(
    projectId: string,
    snapshot: Uint8Array,
    _version?: unknown,
  ): Promise<void> {
    await this.enqueueProjectWrite(projectId, async () => {
      await this.saveSnapshotAtomicUnsafe(projectId, snapshot);
    });
  }

  /**
   * Installs an imported Project replica without replacing local authority.
   * Exact replay is idempotent; any pre-existing snapshot or update history
   * with different bytes is a hard identity collision.
   */
  async installSnapshotIfAbsent(
    projectId: string,
    snapshot: Uint8Array,
  ): Promise<{ installed: boolean }> {
    return this.enqueueProjectWrite(projectId, async () => {
      const snapshotBytes = exactBytes(snapshot);
      const [existing, updates] = await Promise.all([
        this.loadSnapshot(projectId),
        this.loadUpdateLog(projectId),
      ]);
      if (updates.some((update) => update.byteLength > 0)) {
        throw new Error(
          `Project ${projectId} already has local replica update history.`,
        );
      }
      if (existing) {
        if (Buffer.from(existing).equals(Buffer.from(snapshotBytes))) {
          return { installed: false };
        }
        throw new Error(
          `Project ${projectId} already has a different local replica snapshot.`,
        );
      }
      const doc = new LoroDoc();
      if (snapshotBytes.byteLength === 0) {
        throw new Error("An imported Project snapshot cannot be empty.");
      }
      doc.import(snapshotBytes);
      const dir = this.loroDir(projectId);
      await mkdir(dir, { recursive: true });
      const finalPath = this.snapshotPath(projectId);
      const temporaryPath = join(
        dir,
        `snapshot.import.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(snapshotBytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // A hard link publishes the fully-synced inode only if the final name
        // is absent. Unlike rename, it cannot overwrite a Project snapshot
        // that appeared after the read-side emptiness check.
        await this.publishImportedSnapshot(temporaryPath, finalPath);
        await this.syncDirectory(dir);
        this.invalidateProjectAssetCaches(projectId);
        return { installed: true };
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        await this.syncDirectory(dir).catch(() => undefined);
      }
    });
  }

  async compactSnapshot(
    projectId: string,
    snapshot: Uint8Array,
    _version?: unknown,
  ): Promise<void> {
    await this.enqueueProjectWrite(projectId, async () => {
      await this.saveSnapshotAtomicUnsafe(projectId, snapshot);
      await this.truncateUpdateLog(projectId);
    });
  }

  async updateSnapshotAtomic<T>(
    projectId: string,
    mutate: (
      doc: LoroDoc,
    ) => Promise<{ value: T; save?: boolean }> | { value: T; save?: boolean },
  ): Promise<T> {
    return this.enqueueProjectWrite(projectId, async () => {
      const doc = await this.recoverUnsafe(projectId);
      const result = await mutate(doc);
      if (result.save !== false) {
        await this.saveSnapshotAtomicUnsafe(
          projectId,
          doc.export({ mode: "snapshot" }),
        );
      }
      return result.value;
    });
  }

  private async saveSnapshotAtomicUnsafe(
    projectId: string,
    snapshot: Uint8Array,
  ): Promise<void> {
    const dir = this.loroDir(projectId);
    await mkdir(dir, { recursive: true });
    const finalPath = this.snapshotPath(projectId);
    const tempPath = join(
      dir,
      `snapshot.bin.${process.pid}.${randomUUID()}.tmp`,
    );
    const snapshotBytes = exactBytes(snapshot);

    try {
      const handle = await open(tempPath, "wx");
      try {
        await handle.writeFile(snapshotBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, finalPath);
      // The snapshot must be durable before a checkpoint truncates its update
      // log; otherwise a power loss could leave neither copy of the state.
      await this.syncDirectory(dir);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async truncateUpdateLog(projectId: string): Promise<void> {
    const dir = this.loroDir(projectId);
    const logPath = this.updateLogPath(projectId);
    await mkdir(dir, { recursive: true });
    const truncateExisting = async (): Promise<void> => {
      // "r+" requests FILE_WRITE_DATA as well as FILE_READ_DATA on Windows;
      // "a" only grants FILE_APPEND_DATA, so ftruncate there fails with EPERM.
      // Keeping the same inode also avoids splitting concurrent readers.
      const handle = await open(logPath, "r+", 0o600);
      try {
        await handle.truncate(0);
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    try {
      await truncateExisting();
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      try {
        const handle = await open(logPath, "wx", 0o600);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (createError) {
        if (!isExistingFile(createError)) throw createError;
        // Another writer won the create race between ENOENT and "wx"; the
        // file now exists, so retry the write-capable truncate exactly once.
        await truncateExisting();
      }
      await this.syncDirectory(dir);
    }
  }

  async truncateReplicaEventLog(projectId: string): Promise<void> {
    await this.enqueueProjectWrite(projectId, () =>
      this.truncateUpdateLog(projectId),
    );
  }

  async recover(projectId: string): Promise<LoroDoc> {
    return this.recoverUnsafe(projectId);
  }

  /**
   * Drops every process-lifetime Project Asset cache for one replica.
   *
   * `deleteReplica` and `installSnapshotIfAbsent` call this themselves; Project
   * metadata delete/restore callers use it because a later same-id replica can
   * otherwise reuse a materialization fact that describes the old one.
   */
  invalidateProjectAssetCaches(projectId: string): void {
    invalidateLocalProjectAssetCaches({
      projectsRoot: resolve(this.rootDir),
      projectId,
    });
  }

  async deleteReplica(projectId: string): Promise<void> {
    await this.enqueueProjectWrite(projectId, async () => {
      await rm(this.projectDir(projectId), { recursive: true, force: true });
      this.invalidateProjectAssetCaches(projectId);
    });
  }

  private async recoverUnsafe(projectId: string): Promise<LoroDoc> {
    const doc = new LoroDoc();
    const updates = await this.loadUpdateLog(projectId);
    const snapshot = await this.loadSnapshot(projectId);

    if (snapshot?.byteLength) doc.import(snapshot);
    for (const update of updates) {
      if (update.byteLength) doc.import(update);
    }
    return doc;
  }

  private loroDir(projectId: string): string {
    return join(this.projectDir(projectId), "loro");
  }

  private derivedDir(projectId: string): string {
    return join(this.projectDir(projectId), "derived");
  }

  private projectDir(projectId: string): string {
    return join(this.rootDir, encodeURIComponent(projectId));
  }

  private snapshotPath(projectId: string): string {
    return join(this.loroDir(projectId), "snapshot.bin");
  }

  private updateLogPath(projectId: string): string {
    return join(this.loroDir(projectId), "updates.log");
  }

  private replicaCheckpointCursorPath(projectId: string): string {
    return join(this.loroDir(projectId), "checkpoint.cursor");
  }

  private importReservationPath(projectId: string): string {
    return join(this.loroDir(projectId), "import-reservation.json");
  }

  private canvasPreviewPath(projectId: string): string {
    return join(this.derivedDir(projectId), "main-canvas-preview.json");
  }

  private canvasThumbnailPath(projectId: string): string {
    return join(this.derivedDir(projectId), "main-canvas-thumbnail.cache");
  }

  private validateImportReservation(
    reservation: ImportedProjectReservation,
  ): ImportedProjectReservation {
    if (
      reservation.schemaVersion !== 1 ||
      reservation.kind !== "clash.workspace.import-reservation" ||
      !reservation.reservationId.trim() ||
      reservation.reservationId.length > 500 ||
      !/^[a-f0-9]{64}$/u.test(reservation.snapshotSha256)
    ) {
      throw new TypeError("Workspace import reservation is invalid.");
    }
    return {
      schemaVersion: 1,
      kind: "clash.workspace.import-reservation",
      reservationId: reservation.reservationId,
      snapshotSha256: reservation.snapshotSha256,
    };
  }

  private async enqueueProjectWrite<T>(
    projectId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = encodeURIComponent(projectId);
    const previous =
      this.writeQueues.get(key)?.catch(() => undefined) ?? Promise.resolve();
    const next = previous.then(task);
    const queued = next.then(
      () => undefined,
      () => undefined,
    );
    this.writeQueues.set(key, queued);
    try {
      return await next;
    } finally {
      if (this.writeQueues.get(key) === queued) this.writeQueues.delete(key);
    }
  }
}
