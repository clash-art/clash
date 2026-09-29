import { PGlite } from "@electric-sql/pglite";
import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";
import { migrateDatabase } from "./migrations.ts";
import { createPostgresReplicaLog } from "./replica-log.ts";
import {
  buildProjectCheckpoint,
  loadProjectCheckpoint,
  createPostgresCheckpointStore,
} from "./checkpoint.ts";

it("keeps the published checkpoint on interruption and leaves concurrent appends in the recovered tail", async () => {
  const db = new PGlite();
  const source = new LoroDoc();
  const recovered = new LoroDoc();
  try {
    await migrateDatabase(db);
    const log = createPostgresReplicaLog(db, "concurrent-checkpoint");
    async function append(key: string) {
      const from = source.version();
      try {
        source.getMap("entries").set(key, key);
        source.commit();
        return await log.append({
          id: key,
          update: source.export({ mode: "update", from }),
        });
      } finally {
        from.free();
      }
    }
    await append("base");
    await buildProjectCheckpoint(db, "concurrent-checkpoint");
    const prior = await loadProjectCheckpoint(db, "concurrent-checkpoint");
    const next = await append("before-capture");
    let onPage: (() => Promise<void>) | undefined;
    const interleaved: PostgresQueryPort = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
      ) {
        if (sql.includes("FROM project_replica_event") && onPage) {
          const action = onPage;
          onPage = undefined;
          await action();
        }
        return db.query<Row>(sql, parameters);
      },
    };
    const abort = new AbortController();
    onPage = async () => {
      abort.abort(Error("checkpoint interrupted"));
    };
    await expect(
      buildProjectCheckpoint(interleaved, "concurrent-checkpoint", {
        pageSize: 1,
        signal: abort.signal,
      }),
    ).rejects.toThrow("checkpoint interrupted");
    expect(await loadProjectCheckpoint(db, "concurrent-checkpoint")).toEqual(
      prior,
    );

    onPage = async () => {
      await append("during-checkpoint");
    };
    await buildProjectCheckpoint(interleaved, "concurrent-checkpoint", {
      pageSize: 1,
    });
    const saved = await loadProjectCheckpoint(db, "concurrent-checkpoint");
    expect(saved?.cursor).toBe(next.event.cursor);
    recovered.import(saved!.data);
    expect(recovered.getMap("entries").toJSON()).toEqual({
      base: "base",
      "before-capture": "before-capture",
    });
    const tail = await log.readAfter(saved!.cursor);
    for (const event of tail) recovered.import(event.update);
    expect(recovered.getMap("entries").toJSON()).toEqual(
      source.getMap("entries").toJSON(),
    );
    await buildProjectCheckpoint(db, "concurrent-checkpoint");
    expect(
      (await loadProjectCheckpoint(db, "concurrent-checkpoint"))?.cursor,
    ).toBe(tail.at(-1)!.cursor);
  } finally {
    source.free();
    recovered.free();
    await db.close();
  }
});

it("restores a full Loro snapshot and its tail including offline edits", async () => {
  const db = new PGlite();
  const doc = new LoroDoc();
  const recovered = new LoroDoc();
  try {
    await migrateDatabase(db);
    const log = createPostgresReplicaLog(db, "checkpoint");
    doc.getText("text").insert(0, "hello");
    doc.commit();
    const first = doc.export({ mode: "update" });
    const offline = doc.fork();
    try {
      const initial = await log.append({ id: "first", update: first });
      await buildProjectCheckpoint(db, "checkpoint");
      const saved = await loadProjectCheckpoint(db, "checkpoint");
      expect(saved?.cursor).toBe(initial.event.cursor);
      expect(saved).not.toBeNull();
      recovered.import(saved!.data);
      expect(recovered.getText("text").toString()).toBe("hello");
      const before = doc.version();
      doc.getText("text").insert(5, " world");
      doc.commit();
      await log.append({
        id: "tail",
        update: doc.export({ mode: "update", from: before }),
      });
      for (const event of await log.readAfter(saved!.cursor))
        recovered.import(event.update);
      expect(recovered.getText("text").toString()).toBe("hello world");
      const old = offline.version();
      offline.getMap("metadata").set("note", "offline");
      offline.commit();
      await log.append({
        id: "offline",
        update: offline.export({ mode: "update", from: old }),
      });
      await buildProjectCheckpoint(db, "checkpoint");
      const newer = await loadProjectCheckpoint(db, "checkpoint");
      await createPostgresCheckpointStore(db, "checkpoint").save(saved!);
      expect((await loadProjectCheckpoint(db, "checkpoint"))?.cursor).toBe(
        newer!.cursor,
      );
      recovered.import(newer!.data);
      expect(recovered.getMap("metadata").get("note")).toBe("offline");
    } finally {
      offline.free();
    }
  } finally {
    doc.free();
    recovered.free();
    await db.close();
  }
});

it("does not advance a checkpoint past missing Loro dependencies", async () => {
  const db = new PGlite();
  const doc = new LoroDoc();
  try {
    await migrateDatabase(db);
    const log = createPostgresReplicaLog(db, "dependencies");
    doc.getText("text").insert(0, "first");
    doc.commit();
    const first = doc.export({ mode: "update" });
    const before = doc.version();
    doc.getText("text").insert(5, " second");
    doc.commit();
    await log.append({
      id: "second",
      update: doc.export({ mode: "update", from: before }),
    });
    await expect(buildProjectCheckpoint(db, "dependencies")).rejects.toThrow(
      "dependencies",
    );
    expect(await loadProjectCheckpoint(db, "dependencies")).toBeNull();
    const late = await log.append({ id: "first", update: first });
    await buildProjectCheckpoint(db, "dependencies", { pageSize: 1 });
    const saved = await loadProjectCheckpoint(db, "dependencies");
    const restored = new LoroDoc();
    try {
      restored.import(saved!.data);
      expect(restored.getText("text").toString()).toBe("first second");
      expect(saved!.cursor).toBe(late.event.cursor);
    } finally {
      restored.free();
    }
  } finally {
    doc.free();
    await db.close();
  }
});

it("covers empty no-op updates without dropping valid state", async () => {
  const db = new PGlite();
  const doc = new LoroDoc();
  try {
    await migrateDatabase(db);
    const log = createPostgresReplicaLog(db, "empty");
    doc.getMap("metadata").set("name", "Kept");
    doc.commit();
    await log.append({ id: "content", update: doc.export({ mode: "update" }) });
    const noop = await log.append({ id: "noop", update: new Uint8Array() });
    await buildProjectCheckpoint(db, "empty");
    const saved = await loadProjectCheckpoint(db, "empty");
    const restored = new LoroDoc();
    try {
      restored.import(saved!.data);
      expect(restored.getMap("metadata").get("name")).toBe("Kept");
      expect(saved!.cursor).toBe(noop.event.cursor);
    } finally {
      restored.free();
    }
  } finally {
    doc.free();
    await db.close();
  }
});
