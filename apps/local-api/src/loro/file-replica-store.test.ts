import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileReplicaStore } from "./file-replica-store";

let rootDir = "";

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "clash-file-replica-store-"));
});

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

function projectDir(projectId: string): string {
  return join(rootDir, encodeURIComponent(projectId), "loro");
}

function lengthPrefix(length: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(length, 0);
  return header;
}

describe("FileReplicaStore", () => {
  it("installs an imported snapshot exactly once and accepts exact replay after restart", async () => {
    const projectId = "project/imported";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("portable", {
      type: "text",
      data: { label: "Portable" },
    });
    const snapshot = doc.export({ mode: "snapshot" });

    await expect(
      new FileReplicaStore(rootDir).installSnapshotIfAbsent(
        projectId,
        snapshot,
      ),
    ).resolves.toEqual({ installed: true });
    await expect(
      new FileReplicaStore(rootDir).installSnapshotIfAbsent(
        projectId,
        snapshot,
      ),
    ).resolves.toEqual({ installed: false });
    expect(
      (
        (await new FileReplicaStore(rootDir).recover(projectId))
          .getMap("nodes")
          .get("portable") as any
      ).data.label,
    ).toBe("Portable");
  });

  it("rejects a different snapshot or any existing update history", async () => {
    const projectId = "project/import-conflict";
    const first = new LoroDoc();
    first.getMap("nodes").set("first", { type: "text", data: {} });
    const second = new LoroDoc();
    second.getMap("nodes").set("second", { type: "text", data: {} });
    const store = new FileReplicaStore(rootDir);
    await store.installSnapshotIfAbsent(
      projectId,
      first.export({ mode: "snapshot" }),
    );
    await expect(
      store.installSnapshotIfAbsent(
        projectId,
        second.export({ mode: "snapshot" }),
      ),
    ).rejects.toThrow(/different local replica snapshot/u);

    const updateProjectId = "project/import-update-conflict";
    await store.appendUpdate(
      updateProjectId,
      first.export({ mode: "snapshot" }),
    );
    await expect(
      store.installSnapshotIfAbsent(
        updateProjectId,
        second.export({ mode: "snapshot" }),
      ),
    ).rejects.toThrow(/update history/u);
  });

  it.each([new Uint8Array(), new Uint8Array([1, 2, 3])])(
    "leaves no published or temporary snapshot for invalid import bytes",
    async (snapshot) => {
      const projectId = `project/invalid-${snapshot.byteLength}`;
      await expect(
        new FileReplicaStore(rootDir).installSnapshotIfAbsent(
          projectId,
          snapshot,
        ),
      ).rejects.toThrow();

      await expect(readdir(projectDir(projectId))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("cleans the synced temporary inode when atomic import publication fails", async () => {
    const projectId = "project/publish-failure";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("portable", { type: "text", data: {} });
    const store = new FileReplicaStore(rootDir, {
      publishImportedSnapshot: async () => {
        throw new Error("injected publish failure");
      },
    });

    await expect(
      store.installSnapshotIfAbsent(
        projectId,
        doc.export({ mode: "snapshot" }),
      ),
    ).rejects.toThrow("injected publish failure");
    expect(await readdir(projectDir(projectId))).toEqual([]);
    expect(await store.loadSnapshot(projectId)).toBeNull();
  });

  it("fsyncs the Project Loro directory after publishing an imported snapshot", async () => {
    const projectId = "project/import-directory-sync";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("portable", { type: "text", data: {} });
    const syncedDirectories: string[] = [];
    const store = new FileReplicaStore(rootDir, {
      syncDirectory: async (path) => {
        syncedDirectories.push(path);
      },
    });

    await store.installSnapshotIfAbsent(
      projectId,
      doc.export({ mode: "snapshot" }),
    );

    expect(syncedDirectories).toContain(projectDir(projectId));
  });

  it("fsyncs the update log before appendUpdate acknowledges the edit", async () => {
    const projectId = "project/update-fsync";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("fsync", { type: "text", data: {} });
    const syncUpdateLog = vi.fn(async () => undefined);
    const store = new FileReplicaStore(rootDir, { syncUpdateLog });

    await store.appendUpdate(
      projectId,
      doc.export({ mode: "update", from: doc.oplogVersion() }),
    );
    expect(syncUpdateLog).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge the append before the update-log flush completes", async () => {
    const projectId = "project/update-fsync-barrier";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("barrier", { type: "text", data: {} });
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const syncUpdateLog = vi.fn(async () => {
      await flushGate;
    });
    const store = new FileReplicaStore(rootDir, { syncUpdateLog });

    let acknowledged = false;
    const append = store
      .appendUpdate(
        projectId,
        doc.export({ mode: "update", from: doc.oplogVersion() }),
      )
      .then(() => {
        acknowledged = true;
      });
    await vi.waitFor(() => expect(syncUpdateLog).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The write is issued, but the edit is not acknowledged until fdatasync
    // has completed.
    expect(acknowledged).toBe(false);
    releaseFlush();
    await append;
    expect(acknowledged).toBe(true);
  });

  it("rejects the append when the update log flush fails", async () => {
    const projectId = "project/update-fsync-failure";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("unflushed", { type: "text", data: {} });
    const store = new FileReplicaStore(rootDir, {
      syncUpdateLog: async () => {
        throw new Error("injected EIO");
      },
    });

    await expect(
      store.appendUpdate(
        projectId,
        doc.export({ mode: "update", from: doc.oplogVersion() }),
      ),
    ).rejects.toThrow("injected EIO");
  });

  it("syncs the Loro directory after creating a new update log", async () => {
    const projectId = "project/update-log-directory-sync";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("directory", { type: "text", data: {} });
    const syncedDirectories: string[] = [];
    const store = new FileReplicaStore(rootDir, {
      syncDirectory: async (path) => {
        syncedDirectories.push(path);
      },
    });

    await store.appendUpdate(
      projectId,
      doc.export({ mode: "update", from: doc.oplogVersion() }),
    );
    expect(syncedDirectories).toContain(projectDir(projectId));
  });

  it("stores exact snapshot bytes and appends exact update records under the encoded project path", async () => {
    const store = new FileReplicaStore(rootDir);
    const projectId = "project/with spaces";
    const doc = new LoroDoc();
    doc
      .getMap("nodes")
      .set("from-snapshot", { type: "text", data: { label: "Snapshot" } });
    const snapshotArena = new Uint8Array([
      0,
      ...doc.export({ mode: "snapshot" }),
      255,
    ]);
    const snapshot = snapshotArena.subarray(1, snapshotArena.byteLength - 1);

    const versionBefore = doc.version();
    doc
      .getMap("nodes")
      .set("from-update", { type: "text", data: { label: "Update" } });
    const updateArena = new Uint8Array([
      9,
      ...doc.export({ mode: "update", from: versionBefore }),
      8,
    ]);
    const update = updateArena.subarray(1, updateArena.byteLength - 1);

    await store.saveSnapshotAtomic(projectId, snapshot);
    await store.appendUpdate(projectId, update);

    const loadedSnapshot = await store.loadSnapshot(projectId);
    expect(loadedSnapshot).not.toBeNull();
    expect(Array.from(loadedSnapshot!)).toEqual(Array.from(snapshot));
    const updates = await store.loadUpdateLog(projectId);
    expect(updates).toHaveLength(1);
    expect(Array.from(updates[0])).toEqual(Array.from(update));

    const persistedSnapshot = await readFile(
      join(projectDir(projectId), "snapshot.bin"),
    );
    const persistedLog = await readFile(
      join(projectDir(projectId), "updates.log"),
    );
    expect(Array.from(persistedSnapshot)).toEqual(Array.from(snapshot));
    expect(Array.from(persistedLog.subarray(0, 4))).toEqual(
      Array.from(lengthPrefix(update.byteLength)),
    );
    expect(Array.from(persistedLog.subarray(4))).toEqual(Array.from(update));
  });

  it("persists the derived Main canvas preview as a replaceable cache", async () => {
    const store = new FileReplicaStore(rootDir);
    const projectId = "project/preview cache";
    const first = {
      sourceVersion: "version-1",
      generatedAt: "2026-08-27T00:00:00.000Z",
      preview: {
        canvasId: "main",
        bounds: { x: -100, y: 50, width: 600, height: 400 },
        nodes: [
          {
            id: "hero",
            type: "image",
            x: 100,
            y: 200,
            width: 400,
            height: 225,
            assetId: "asset-hero",
          },
        ],
      },
    };

    await expect(store.readCanvasPreview(projectId)).resolves.toBeNull();
    await store.writeCanvasPreview(projectId, first);
    await expect(store.readCanvasPreview(projectId)).resolves.toEqual(first);

    const second = {
      sourceVersion: "version-2",
      generatedAt: "2026-08-27T00:01:00.000Z",
      preview: {
        canvasId: "main",
        bounds: null,
        nodes: [],
      },
    };
    await store.writeCanvasPreview(projectId, second);
    await expect(store.readCanvasPreview(projectId)).resolves.toEqual(second);
  });

  it("atomically replaces the Main canvas thumbnail instead of retaining revisions", async () => {
    const store = new FileReplicaStore(rootDir);
    const projectId = "project/thumbnail cache";
    const firstRevision = "a".repeat(64);
    const secondRevision = "b".repeat(64);

    await store.writeCanvasThumbnail(
      projectId,
      firstRevision,
      new Uint8Array([1, 2, 3]),
    );
    await store.writeCanvasThumbnail(
      projectId,
      secondRevision,
      new Uint8Array([4, 5, 6]),
    );

    await expect(
      store.readCanvasThumbnail(projectId, firstRevision),
    ).resolves.toBeNull();
    await expect(
      store.readCanvasThumbnail(projectId, secondRevision),
    ).resolves.toEqual(new Uint8Array([4, 5, 6]));
    await expect(
      readdir(join(rootDir, encodeURIComponent(projectId), "derived")),
    ).resolves.toEqual(["main-canvas-thumbnail.cache"]);
  });

  it("recovers a LoroDoc from snapshot plus update log in append order", async () => {
    const store = new FileReplicaStore(rootDir);
    const projectId = "project/recover";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("base", { type: "text", data: { label: "Base" } });
    await store.saveSnapshotAtomic(projectId, doc.export({ mode: "snapshot" }));

    const beforeFirst = doc.version();
    doc
      .getMap("nodes")
      .set("first", { type: "text", data: { label: "First" } });
    await store.appendUpdate(
      projectId,
      doc.export({ mode: "update", from: beforeFirst }),
    );

    const beforeSecond = doc.version();
    doc
      .getMap("nodes")
      .set("second", { type: "text", data: { label: "Second" } });
    await store.appendUpdate(
      projectId,
      doc.export({ mode: "update", from: beforeSecond }),
    );

    const recovered = await store.recover(projectId);
    const nodes = recovered.getMap("nodes");
    expect((nodes.get("base") as any).data.label).toBe("Base");
    expect((nodes.get("first") as any).data.label).toBe("First");
    expect((nodes.get("second") as any).data.label).toBe("Second");
  });

  it("deletes the encoded project replica directory", async () => {
    const store = new FileReplicaStore(rootDir);
    const projectId = "project/delete";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("base", { type: "text", data: { label: "Base" } });
    await store.saveSnapshotAtomic(projectId, doc.export({ mode: "snapshot" }));
    await store.appendUpdate(projectId, new Uint8Array([1, 2, 3]));

    expect(await readdir(projectDir(projectId))).toEqual(
      expect.arrayContaining(["snapshot.bin", "updates.log"]),
    );

    await store.deleteReplica(projectId);

    await expect(
      readdir(join(rootDir, encodeURIComponent(projectId))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.loadSnapshot(projectId)).toBeNull();
    expect(await store.loadUpdateLog(projectId)).toEqual([]);
  });

  it("serializes recover-mutate-save updates for a project", async () => {
    const store = new FileReplicaStore(rootDir);
    const projectId = "project/serialized-update";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("base", { type: "text", data: { label: "Base" } });
    await store.saveSnapshotAtomic(projectId, doc.export({ mode: "snapshot" }));

    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const order: string[] = [];

    const first = store.updateSnapshotAtomic(projectId, async (current) => {
      order.push("first");
      firstStarted();
      expect((current.getMap("nodes").get("base") as any).data.label).toBe(
        "Base",
      );
      await firstCanFinish;
      current
        .getMap("nodes")
        .set("first", { type: "text", data: { label: "First" } });
      return { value: "first" };
    });
    await firstDidStart;

    const second = store.updateSnapshotAtomic(projectId, async (current) => {
      order.push("second");
      expect((current.getMap("nodes").get("first") as any).data.label).toBe(
        "First",
      );
      current
        .getMap("nodes")
        .set("second", { type: "text", data: { label: "Second" } });
      return { value: "second" };
    });

    await Promise.resolve();
    expect(order).toEqual(["first"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(order).toEqual(["first", "second"]);

    const recovered = await store.recover(projectId);
    expect((recovered.getMap("nodes").get("first") as any).data.label).toBe(
      "First",
    );
    expect((recovered.getMap("nodes").get("second") as any).data.label).toBe(
      "Second",
    );
  });

  it("can skip writing a snapshot from a serialized update", async () => {
    const store = new FileReplicaStore(rootDir);
    const projectId = "project/no-save";

    const value = await store.updateSnapshotAtomic(projectId, (current) => {
      current
        .getMap("nodes")
        .set("rejected", { type: "text", data: { label: "Rejected" } });
      return { value: "rejected", save: false };
    });

    expect(value).toBe("rejected");
    expect(await store.loadSnapshot(projectId)).toBeNull();
    expect(
      (await store.recover(projectId)).getMap("nodes").get("rejected"),
    ).toBeUndefined();
  });

  it("ignores and truncates an incomplete trailing update record during recovery", async () => {
    const store = new FileReplicaStore(rootDir);
    const projectId = "project/partial-log";
    const doc = new LoroDoc();
    const before = doc.version();
    doc
      .getMap("nodes")
      .set("valid", { type: "text", data: { label: "Valid" } });
    const update = doc.export({ mode: "update", from: before });
    await store.appendUpdate(projectId, update);

    const logPath = join(projectDir(projectId), "updates.log");
    await appendFile(
      logPath,
      Buffer.concat([
        lengthPrefix(update.byteLength + 99),
        Buffer.from([1, 2, 3]),
      ]),
    );

    const recovered = await store.recover(projectId);
    expect((recovered.getMap("nodes").get("valid") as any).data.label).toBe(
      "Valid",
    );

    const expectedSize = 4 + update.byteLength;
    expect((await stat(logPath)).size).toBe(expectedSize);
    const updates = await store.loadUpdateLog(projectId);
    expect(updates).toHaveLength(1);
  });

  it("writes snapshots through a temp file rename without leaving temp files behind", async () => {
    const store = new FileReplicaStore(rootDir);
    const projectId = "project/atomic";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("old", { type: "text", data: { label: "Old" } });
    await store.saveSnapshotAtomic(projectId, doc.export({ mode: "snapshot" }));

    const replacement = new LoroDoc();
    replacement
      .getMap("nodes")
      .set("new", { type: "text", data: { label: "New" } });
    const snapshot = replacement.export({ mode: "snapshot" });
    await store.saveSnapshotAtomic(projectId, snapshot, replacement.version());

    expect(
      Array.from(await readFile(join(projectDir(projectId), "snapshot.bin"))),
    ).toEqual(Array.from(snapshot));
    expect(await readdir(projectDir(projectId))).toEqual(
      expect.not.arrayContaining([
        expect.stringMatching(/snapshot\.bin\..+\.tmp/),
      ]),
    );
  });

  it("compacts imported update records after writing a covering snapshot", async () => {
    const store = new FileReplicaStore(rootDir);
    const projectId = "project/compact";
    const doc = new LoroDoc();
    doc.getMap("nodes").set("base", { type: "text", data: { label: "Base" } });
    await store.saveSnapshotAtomic(projectId, doc.export({ mode: "snapshot" }));

    const beforeFirst = doc.version();
    doc
      .getMap("nodes")
      .set("first", { type: "text", data: { label: "First" } });
    await store.appendUpdate(
      projectId,
      doc.export({ mode: "update", from: beforeFirst }),
    );

    const beforeSecond = doc.version();
    doc
      .getMap("nodes")
      .set("second", { type: "text", data: { label: "Second" } });
    await store.appendUpdate(
      projectId,
      doc.export({ mode: "update", from: beforeSecond }),
    );

    expect(await store.loadUpdateLog(projectId)).toHaveLength(2);

    await store.compactSnapshot(
      projectId,
      doc.export({ mode: "snapshot" }),
      doc.version(),
    );

    expect(await store.loadUpdateLog(projectId)).toHaveLength(0);
    expect((await stat(join(projectDir(projectId), "updates.log"))).size).toBe(
      0,
    );

    const recovered = await store.recover(projectId);
    expect((recovered.getMap("nodes").get("first") as any).data.label).toBe(
      "First",
    );
    expect((recovered.getMap("nodes").get("second") as any).data.label).toBe(
      "Second",
    );
  });

  it("ignores legacy flat snapshots because v0 only supports the new replica store", async () => {
    const projectId = "project/legacy";
    const legacyDir = join(rootDir, "legacy-loro");
    const store = new FileReplicaStore(join(rootDir, "projects"));
    const legacyDoc = new LoroDoc();
    legacyDoc
      .getMap("nodes")
      .set("legacy", { type: "text", data: { label: "Legacy" } });
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, `${encodeURIComponent(projectId)}.bin`),
      legacyDoc.export({ mode: "snapshot" }),
    );

    const recovered = await store.recover(projectId);
    expect(recovered.getMap("nodes").get("legacy")).toBeUndefined();

    const newDoc = new LoroDoc();
    newDoc.getMap("nodes").set("new", { type: "text", data: { label: "New" } });
    await store.saveSnapshotAtomic(
      projectId,
      newDoc.export({ mode: "snapshot" }),
    );

    const recoveredAfterNewState = await store.recover(projectId);
    expect(
      recoveredAfterNewState.getMap("nodes").get("legacy"),
    ).toBeUndefined();
    expect(
      (recoveredAfterNewState.getMap("nodes").get("new") as any).data.label,
    ).toBe("New");
  });
});
