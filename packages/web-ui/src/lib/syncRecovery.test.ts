import { IDBFactory } from "fake-indexeddb";
import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import { archiveRejectedSync, readLatestSyncRecovery } from "./syncRecovery";

async function database() {
  const factory = new IDBFactory();
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("recovery", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function cached(db: IDBDatabase, projectId: string) {
  return new Promise<unknown>((resolve, reject) => {
    const request = db.transaction("snapshots").objectStore("snapshots").get(projectId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

it("archives the full rejected replica and removes only its automatic-sync cache", async () => {
  const db = await database();
  const doc = new LoroDoc();
  const recovered = new LoroDoc();
  try {
    doc.getMap("draft").set("text", "Unsaved local work");
    const snapshot = doc.export({ mode: "snapshot" });
    const seed = db.transaction("snapshots", "readwrite").objectStore("snapshots");
    seed.put(snapshot, "project");
    seed.put("other project cache", "other");
    const saved = await archiveRejectedSync(db, "project", snapshot);
    expect(await cached(db, "project")).toBeUndefined();
    expect(await cached(db, "other")).toBe("other project cache");
    const latest = await readLatestSyncRecovery(db, "project");
    expect(latest).toEqual(saved);
    recovered.import(latest!.snapshot);
    expect(recovered.toJSON()).toEqual(doc.toJSON());
    expect(await readLatestSyncRecovery(db, "other")).toBeUndefined();
  } finally { db.close(); doc.free(); recovered.free(); }
});

it("retains the sync cache and previous backup if the archive transaction aborts", async () => {
  const db = await database();
  const doc = new LoroDoc();
  try {
    const snapshot = doc.export({ mode: "snapshot" });
    const previous = await archiveRejectedSync(db, "project", snapshot);
    db.transaction("snapshots", "readwrite").objectStore("snapshots").put(snapshot, "project");
    const transaction = db.transaction.bind(db);
    db.transaction = ((...args: Parameters<IDBDatabase["transaction"]>) => {
      const tx = transaction(...args);
      if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    }) as IDBDatabase["transaction"];
    await expect(archiveRejectedSync(db, "project", snapshot)).rejects.toThrow();
    expect(await cached(db, "project")).toEqual(snapshot);
    expect(await readLatestSyncRecovery(db, "project")).toEqual(previous);
  } finally { db.close(); doc.free(); }
});
