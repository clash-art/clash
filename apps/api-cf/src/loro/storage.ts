/**
 * Loro persistence via Durable Object storage.
 *
 * Storage layout (event-sourcing pattern, Loro shallow-snapshot for compaction):
 *
 *   loro:snapshot              ArrayBuffer    most recent shallow snapshot
 *   loro:snapshot-seq          number         seq number at which snapshot was taken
 *   loro:next-seq              number         next seq for an appended update
 *   loro:u:000000000001        ArrayBuffer    binary update (zero-padded for lexical=numeric ordering)
 *   loro:u:000000000002        ArrayBuffer
 *   ...
 *
 * Why this shape:
 *   - Every doc commit is captured as a small binary update and appended.
 *     We never have to "decide when to save" — Loro tells us via
 *     subscribeLocalUpdates, and remote imports are persisted explicitly
 *     by the caller. No DO-hibernation race window where a write is in
 *     memory only.
 *   - Periodically (every UPDATES_PER_COMPACT updates) the caller runs
 *     compactToSnapshot: take a shallow-snapshot of current state, persist
 *     it, delete the now-redundant updates. This caps load time and
 *     storage size. shallow-snapshot is the Loro-native "GC up to here"
 *     primitive — it strips history older than the chosen frontiers.
 *
 * Backwards compatibility: pre-existing projects only have loro:snapshot
 * (no update log). loadDocState happily handles that — empty list, zero seq.
 * On first new commit the log starts at seq 0.
 */

import { serverLog } from "../logger";
import { LoroDoc } from "loro-crdt";

const storageLog = serverLog.child("loro-storage");

export const SNAPSHOT_KEY = "loro:snapshot";
export const SNAPSHOT_SEQ_KEY = "loro:snapshot-seq";
export const NEXT_SEQ_KEY = "loro:next-seq";
export const CHECKPOINT_REQUESTED_SEQ_KEY = "loro:checkpoint-requested-seq";
export const UPDATE_PREFIX = "loro:u:";
// 12-digit zero-padded sequence: lexical key order matches numeric seq order.
// 10^12 updates per project before this overflows — a few thousand years at
// 10 writes/sec.
const SEQ_PAD = 12;

export function seqKey(seq: number): string {
  return UPDATE_PREFIX + String(seq).padStart(SEQ_PAD, "0");
}

/**
 * Loro returns Uint8Array views into a larger arena buffer. Persisting
 * `view.buffer` directly writes the whole arena (including bytes after the
 * view) — that's what corrupted bf7b4c60. Always slice to exact byteLength.
 */
function exactBuffer(view: Uint8Array): ArrayBuffer {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? (view.buffer as ArrayBuffer)
    : view.slice().buffer;
}

export interface PersistedDocState {
  doc: LoroDoc;
  /** Next sequence number to use when appending an update. */
  nextSeq: number;
  /** Sequence number at which the loaded snapshot was taken. */
  snapshotSeq: number;
}

/**
 * Load doc: import snapshot, then replay all updates appended since.
 *
 * If either step fails we log loud and continue with what we have so a
 * single corrupt update doesn't take the whole room offline.
 */
export async function loadDocState(
  storage: DurableObjectStorage,
): Promise<PersistedDocState> {
  const doc = new LoroDoc();

  const snapshot = await storage.get<ArrayBuffer>(SNAPSHOT_KEY);
  if (snapshot) {
    try {
      doc.import(new Uint8Array(snapshot));
    } catch (e) {
      storageLog.error("loro.snapshot_import_failed", { error: e });
    }
  }

  const updates = await storage.list<ArrayBuffer>({ prefix: UPDATE_PREFIX });
  if (updates.size > 0) {
    const batch: Uint8Array[] = [];
    for (const value of updates.values()) batch.push(new Uint8Array(value));
    try {
      doc.importBatch(batch);
    } catch (e) {
      storageLog.error("loro.update_batch_import_failed", { error: e });
      for (const u of batch) {
        try { doc.import(u); } catch (ee) {
          storageLog.error("loro.update_import_failed", { error: ee });
        }
      }
    }
  }

  const nextSeq = (await storage.get<number>(NEXT_SEQ_KEY)) ?? 0;
  const snapshotSeq = (await storage.get<number>(SNAPSHOT_SEQ_KEY)) ?? 0;
  return { doc, nextSeq, snapshotSeq };
}

/**
 * Append a binary update (local commit OR imported remote update) to the log.
 * Atomic put for both the bytes + the next-seq pointer so a crash can never
 * leave the seq pointer ahead of the actual bytes.
 */
export async function appendUpdate(
  storage: DurableObjectStorage,
  seq: number,
  update: Uint8Array,
): Promise<void> {
  await storage.put({
    [seqKey(seq)]: exactBuffer(update),
    [NEXT_SEQ_KEY]: seq + 1,
  });
}

/**
 * Compact: write a fresh shallow-snapshot of current doc state, then delete
 * every update with seq < compactionSeq.
 *
 * Critical ordering:
 *   1. SYNC capture frontiers + export — no await between them, so they
 *      reference the same doc state.
 *   2. Persist new snapshot BEFORE deleting old updates — a crash here
 *      leaves duplicate data (old snapshot + updates AND new snapshot)
 *      which loadDocState handles correctly (the updates are no-ops on
 *      top of the new snapshot). The reverse order would lose data.
 *   3. Updates appended during compaction's awaits land with seq >=
 *      compactionSeq and survive the delete sweep — they sit on top of
 *      the new snapshot at next load.
 */
export async function compactToSnapshot(
  storage: DurableObjectStorage,
  doc: LoroDoc,
  compactionSeq: number,
): Promise<void> {
  const frontiers = doc.frontiers();
  let snapshot: Uint8Array;
  try {
    snapshot = doc.export({ mode: "shallow-snapshot", frontiers });
  } catch (e) {
    // shallow-snapshot can fail on edge cases (e.g. brand-new empty doc).
    // Fall back to full snapshot — same correctness guarantee, slightly
    // larger storage.
    storageLog.warn("loro.shallow_snapshot_failed", { error: e });
    snapshot = doc.export({ mode: "snapshot" });
  }

  await storage.put({
    [SNAPSHOT_KEY]: exactBuffer(snapshot),
    [SNAPSHOT_SEQ_KEY]: compactionSeq,
  });

  const updates = await storage.list<ArrayBuffer>({ prefix: UPDATE_PREFIX });
  const toDelete: string[] = [];
  for (const key of updates.keys()) {
    const seq = Number(key.slice(UPDATE_PREFIX.length));
    if (Number.isFinite(seq) && seq < compactionSeq) toDelete.push(key);
  }
  if (toDelete.length > 0) await storage.delete(toDelete);
}

/**
 * Wipe all loro state for this room. Used by the /reset-doc admin endpoint
 * to recover a project whose doc state is unrecoverably corrupt.
 */
export async function wipeDocState(storage: DurableObjectStorage): Promise<void> {
  // Legacy keys from the pre-update-log layout; safe to delete unconditionally.
  await storage.delete([
    SNAPSHOT_KEY,
    SNAPSHOT_SEQ_KEY,
    NEXT_SEQ_KEY,
    CHECKPOINT_REQUESTED_SEQ_KEY,
    "loro:version",
    "loro:snapshot",
  ]);
  const updates = await storage.list({ prefix: UPDATE_PREFIX });
  if (updates.size > 0) await storage.delete([...updates.keys()]);
}
