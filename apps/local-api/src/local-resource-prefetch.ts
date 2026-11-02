import { statfs } from "node:fs/promises";
import type { AssetKind } from "@clash/shared-types";
import { createStructuredLogger } from "@clash/shared-runtime/logging";
import { LocalResourceStreamMismatchError } from "./local-resource-store.js";
import { CloudContentIntegrityError } from "./project-cloud-content.js";

const prefetchLog = createStructuredLogger({
  component: "local-api",
  module: "resource-prefetch",
});

/** Coded reason a cloud Resource could not be downloaded into this Host's store. */
export type LocalResourceDownloadCode =
  | "LOCAL_RESOURCE_DOWNLOAD_FAILED"
  | "LOCAL_RESOURCE_DOWNLOAD_INTEGRITY"
  | "LOCAL_RESOURCE_REMOTE_MISSING"
  | "LOCAL_STORE_DISK_FULL";

export class LocalResourceDownloadError extends Error {
  constructor(
    readonly code: LocalResourceDownloadCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "LocalResourceDownloadError";
  }
}

/** Host-private download state projected into `ResolvedAsset.status`. */
export type LocalResourceAvailability =
  | { status: "downloading"; progress: number }
  | { status: "failed"; errorCode: LocalResourceDownloadCode; error: string };

export interface LocalResourceDownloadContext {
  /** Throws `LOCAL_STORE_DISK_FULL` before any byte is written when the store volume lacks room. */
  preflight(byteLength: number): Promise<void>;
  /** Bytes received so far; the reported fraction never moves backwards. */
  progress(received: number, byteLength: number): void;
}

export type LocalResourcePrefetchRef = { resourceId: string; kind: AssetKind };

/** Lower ranks download first. */
export const PREFETCH_RANK = { visible: 0, timeline: 1, rest: 2 } as const;

export interface LocalResourcePrefetchPlanItem extends LocalResourcePrefetchRef {
  rank: number;
}

export interface LocalResourcePrefetcherOptions {
  /** A directory on the store volume; `statfs` reads its free space. */
  storePath: string;
  /** The queue's own downloader. The cloud-sync coordinator calls `run` with its own. */
  download(
    projectId: string,
    ref: LocalResourcePrefetchRef,
    context: LocalResourceDownloadContext,
  ): Promise<void>;
  freeBytes?(path: string): Promise<number>;
  /** Free space kept on the volume after a download (default 256 MiB). */
  reserveBytes?: number;
  /** Downloads in flight per Host (default 2). */
  maxConcurrent?: number;
  /** Downloads in flight per Project (default 1). */
  maxPerProject?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Automatic attempts before an Asset stays failed until the next open or hint. */
  maxAttempts?: number;
  /** How often a queue paused by a full disk re-checks free space. */
  diskRetryMs?: number;
  /** Project-level coded store state; `undefined` clears it. */
  onStoreState?(
    projectId: string,
    state: { code: "LOCAL_STORE_DISK_FULL"; message: string } | undefined,
  ): void;
}

function errnoChain(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 8; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code === "ENOSPC" || code === "EDQUOT") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function resourceDownloadFailureCode(
  error: unknown,
): LocalResourceDownloadCode {
  if (error instanceof LocalResourceDownloadError) return error.code;
  if (errnoChain(error)) return "LOCAL_STORE_DISK_FULL";
  if (
    error instanceof LocalResourceStreamMismatchError ||
    error instanceof CloudContentIntegrityError
  )
    return "LOCAL_RESOURCE_DOWNLOAD_INTEGRITY";
  if ((error as { status?: unknown } | null)?.status === 404)
    return "LOCAL_RESOURCE_REMOTE_MISSING";
  return "LOCAL_RESOURCE_DOWNLOAD_FAILED";
}

async function statfsFreeBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bavail) * Number(info.bsize);
}

interface QueueEntry extends LocalResourcePrefetchRef {
  projectId: string;
  rank: number;
  seq: number;
}

/**
 * One downloader per Host. The cloud-sync coordinator and the open-time
 * prefetch queue share its in-flight map, so a Resource is fetched at most
 * once at a time whichever of them asks first. Bytes are digest-verified while
 * streaming into staging and published only after they match.
 */
export function createLocalResourcePrefetcher(
  options: LocalResourcePrefetcherOptions,
) {
  const freeBytes = options.freeBytes ?? statfsFreeBytes;
  const reserveBytes = Math.max(0, options.reserveBytes ?? 256 * 1024 * 1024);
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
  const maxPerProject = Math.max(1, options.maxPerProject ?? 1);
  const retryBaseMs = Math.max(0, options.retryBaseMs ?? 30_000);
  const retryMaxMs = Math.max(retryBaseMs, options.retryMaxMs ?? 30 * 60_000);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 6);
  const diskRetryMs = Math.max(0, options.diskRetryMs ?? 60_000);

  const inFlight = new Map<string, { projectId: string; task: Promise<void> }>();
  const availability = new Map<string, LocalResourceAvailability>();
  const queue = new Map<string, QueueEntry>();
  const attempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Projects told about a full store, so the state is cleared exactly once. */
  const diskFullProjects = new Set<string>();
  let diskTimer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  let closed = false;
  let seq = 0;

  const key = (projectId: string, resourceId: string) =>
    JSON.stringify([projectId, resourceId]);

  function projectInFlight(projectId: string): number {
    let count = 0;
    for (const flight of inFlight.values())
      if (flight.projectId === projectId) count += 1;
    return count;
  }

  function markQueued(resourceId: string): void {
    const current = availability.get(resourceId);
    if (current?.status === "downloading") return;
    availability.set(resourceId, { status: "downloading", progress: 0 });
  }

  function pauseForDisk(message: string): void {
    paused = true;
    const projects = new Set<string>();
    for (const entry of queue.values()) {
      projects.add(entry.projectId);
      if (!inFlight.has(entry.resourceId))
        availability.set(entry.resourceId, {
          status: "failed",
          errorCode: "LOCAL_STORE_DISK_FULL",
          error: message,
        });
    }
    for (const projectId of projects) {
      diskFullProjects.add(projectId);
      options.onStoreState?.(projectId, {
        code: "LOCAL_STORE_DISK_FULL",
        message,
      });
    }
    if (diskTimer || closed) return;
    diskTimer = setTimeout(() => {
      diskTimer = undefined;
      resume();
    }, diskRetryMs);
    diskTimer.unref?.();
  }

  function resume(): void {
    if (!paused || closed) return;
    paused = false;
    if (diskTimer) clearTimeout(diskTimer);
    diskTimer = undefined;
    for (const entry of queue.values()) {
      const current = availability.get(entry.resourceId);
      if (current?.status === "failed") availability.delete(entry.resourceId);
      markQueued(entry.resourceId);
    }
    pump();
  }

  function clearDiskState(projectId: string): void {
    if (!diskFullProjects.delete(projectId)) return;
    options.onStoreState?.(projectId, undefined);
  }

  function scheduleRetry(entry: QueueEntry): void {
    const attempt = (attempts.get(entry.resourceId) ?? 0) + 1;
    attempts.set(entry.resourceId, attempt);
    if (attempt >= maxAttempts || closed) return;
    const base = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1));
    const delay = Math.round(base * (0.5 + Math.random()));
    const id = key(entry.projectId, entry.resourceId);
    const previous = retryTimers.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      retryTimers.delete(id);
      if (closed || queue.has(id)) return;
      queue.set(id, { ...entry, seq: seq++ });
      markQueued(entry.resourceId);
      pump();
    }, delay);
    timer.unref?.();
    retryTimers.set(id, timer);
  }

  function pick(): QueueEntry | undefined {
    let best: QueueEntry | undefined;
    for (const entry of queue.values()) {
      if (inFlight.has(entry.resourceId)) continue;
      if (projectInFlight(entry.projectId) >= maxPerProject) continue;
      if (
        !best ||
        entry.rank < best.rank ||
        (entry.rank === best.rank && entry.seq < best.seq)
      )
        best = entry;
    }
    return best;
  }

  function pump(): void {
    while (!closed && !paused && inFlight.size < maxConcurrent) {
      const entry = pick();
      if (!entry) return;
      queue.delete(key(entry.projectId, entry.resourceId));
      void start(
        entry.projectId,
        entry,
        (context) => options.download(entry.projectId, entry, context),
        entry,
      ).then(
        () => clearDiskState(entry.projectId),
        (error: unknown) => {
          // A full disk waits with the queue (see start) instead of backing off alone.
          if (resourceDownloadFailureCode(error) !== "LOCAL_STORE_DISK_FULL")
            scheduleRetry(entry);
        },
      );
    }
  }

  /**
   * Runs one download, or joins the one already in flight for this Resource.
   * Failures are recorded as coded Asset state and rethrown unchanged, so the
   * coordinator keeps its own failure semantics.
   */
  function run(
    projectId: string,
    ref: LocalResourcePrefetchRef,
    task: (context: LocalResourceDownloadContext) => Promise<void>,
  ): Promise<void> {
    return start(projectId, ref, task);
  }

  function start(
    projectId: string,
    ref: LocalResourcePrefetchRef,
    task: (context: LocalResourceDownloadContext) => Promise<void>,
    entry?: QueueEntry,
  ): Promise<void> {
    const { resourceId } = ref;
    const existing = inFlight.get(resourceId);
    if (existing) return existing.task;
    availability.set(resourceId, { status: "downloading", progress: 0 });
    const context: LocalResourceDownloadContext = {
      async preflight(byteLength) {
        const available = await freeBytes(options.storePath);
        if (available >= byteLength + reserveBytes) return;
        throw new LocalResourceDownloadError(
          "LOCAL_STORE_DISK_FULL",
          `Resource ${resourceId} needs ${byteLength} bytes plus a ${reserveBytes}-byte reserve; the Host store volume has ${available} bytes free. Free some space to continue downloading.`,
        );
      },
      progress(received, byteLength) {
        const current = availability.get(resourceId);
        if (current?.status !== "downloading") return;
        const fraction =
          byteLength > 0 ? Math.min(1, Math.max(0, received / byteLength)) : 1;
        if (fraction > current.progress)
          availability.set(resourceId, {
            status: "downloading",
            progress: fraction,
          });
      },
    };
    const flight = (async () => {
      try {
        await task(context);
        availability.delete(resourceId);
        attempts.delete(resourceId);
        // A later plan may still list it; the bytes are installed now.
        for (const [id, queued] of queue)
          if (queued.resourceId === resourceId) queue.delete(id);
      } catch (error) {
        const errorCode = resourceDownloadFailureCode(error);
        const message = error instanceof Error ? error.message : String(error);
        availability.set(resourceId, {
          status: "failed",
          errorCode,
          error: message.startsWith(`${errorCode}:`)
            ? message
            : `${errorCode}: ${message}`,
        });
        prefetchLog.warn("resource_prefetch.download_failed", {
          code: errorCode,
          projectId,
          resourceId,
          message,
        });
        if (errorCode === "LOCAL_STORE_DISK_FULL" && !closed) {
          // Nothing was written. Keep it queued and pause until space returns.
          const id = key(projectId, resourceId);
          queue.set(id, {
            projectId,
            resourceId,
            kind: ref.kind,
            rank: entry?.rank ?? queue.get(id)?.rank ?? PREFETCH_RANK.rest,
            seq: entry?.seq ?? queue.get(id)?.seq ?? seq++,
          });
          pauseForDisk(
            (availability.get(resourceId) as { error: string }).error,
          );
        }
        throw error;
      } finally {
        inFlight.delete(resourceId);
        queueMicrotask(pump);
      }
    })();
    inFlight.set(resourceId, { projectId, task: flight });
    return flight;
  }

  return {
    run,
    /**
     * Queues a Project's missing Resources. Re-planning keeps in-flight work;
     * a fresh open or hint also resumes a queue paused by a full disk and
     * gives exhausted retries another attempt.
     */
    enqueue(projectId: string, items: LocalResourcePrefetchPlanItem[]): void {
      if (closed) return;
      for (const item of items) {
        const id = key(projectId, item.resourceId);
        const previous = queue.get(id);
        const pendingRetry = retryTimers.get(id);
        if (pendingRetry) {
          clearTimeout(pendingRetry);
          retryTimers.delete(id);
        }
        attempts.delete(item.resourceId);
        queue.set(id, {
          projectId,
          resourceId: item.resourceId,
          kind: item.kind,
          rank: Math.min(item.rank, previous?.rank ?? item.rank),
          seq: previous?.seq ?? seq++,
        });
        if (!inFlight.has(item.resourceId)) {
          if (availability.get(item.resourceId)?.status === "failed")
            availability.delete(item.resourceId);
          markQueued(item.resourceId);
        }
      }
      if (paused) resume();
      else pump();
    },
    availability(resourceId: string): LocalResourceAvailability | undefined {
      return availability.get(resourceId);
    },
    /** Settles once nothing is queued or in flight (tests and shutdown). */
    async idle(): Promise<void> {
      for (;;) {
        const flights = [...inFlight.values()].map((flight) =>
          flight.task.catch(() => undefined),
        );
        if (flights.length === 0) {
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          if (inFlight.size === 0) return;
          continue;
        }
        await Promise.all(flights);
      }
    },
    async close(): Promise<void> {
      closed = true;
      if (diskTimer) clearTimeout(diskTimer);
      diskTimer = undefined;
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      queue.clear();
      await Promise.all(
        [...inFlight.values()].map((flight) =>
          flight.task.catch(() => undefined),
        ),
      );
    },
  };
}

export type LocalResourcePrefetcher = ReturnType<
  typeof createLocalResourcePrefetcher
>;
