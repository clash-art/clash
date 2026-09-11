export interface SyncRecoveryDraft {
  id: string;
  projectId: string;
  createdAt: number;
  snapshot: Uint8Array;
}

const latestKey = (projectId: string) => ["sync-recovery-latest", projectId];

/** Cache removal must never commit without the recoverable local snapshot. */
export async function archiveRejectedSync(db: IDBDatabase, projectId: string, snapshot: Uint8Array): Promise<SyncRecoveryDraft> {
  const draft: SyncRecoveryDraft = { id: crypto.randomUUID(), projectId, createdAt: Date.now(), snapshot: snapshot.slice() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction("snapshots", "readwrite");
    tx.oncomplete = () => resolve(draft);
    tx.onabort = () => reject(tx.error ?? new Error("Recovery archive was aborted; the local draft was retained."));
    const store = tx.objectStore("snapshots");
    store.add(draft, ["sync-recovery", projectId, draft.id]);
    store.put(draft.id, latestKey(projectId));
    store.delete(projectId);
  });
}

export async function readLatestSyncRecovery(db: IDBDatabase, projectId: string): Promise<SyncRecoveryDraft | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("snapshots", "readonly");
    let draft: SyncRecoveryDraft | undefined;
    tx.oncomplete = () => resolve(draft);
    tx.onabort = () => reject(tx.error ?? new Error("Could not read the recovery archive."));
    const store = tx.objectStore("snapshots");
    const latest = store.get(latestKey(projectId));
    latest.onsuccess = () => {
      if (typeof latest.result !== "string") return;
      const record = store.get(["sync-recovery", projectId, latest.result]);
      record.onsuccess = () => { draft = record.result; };
    };
  });
}
