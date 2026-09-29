import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { migrateDatabase } from "./migrations.ts";
import { createPostgresReplicaLog } from "./replica-log.ts";
import { withProjectDocument } from "./project-document.ts";
it("reads the durable replica and appends successful commands without persisting rejected mutations", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    await db.query(
      "INSERT INTO project(id,owner_id,name,created_at,updated_at) VALUES('p','owner','Project',now(),now())",
    );
    const local = new LoroDoc();
    local.getMap("notes").set("draft", "browser");
    local.commit();
    await createPostgresReplicaLog(db, "p").append({
      id: "browser-update",
      update: local.export({ mode: "snapshot" }),
    });
    expect(
      await withProjectDocument(db, "owner", "p", false, (doc) =>
        doc.getMap("notes").get("draft"),
      ),
    ).toBe("browser");
    await expect(
      withProjectDocument(db, "other", "p", false, () => null),
    ).rejects.toThrow("Project not found");
    await withProjectDocument(db, "owner", "p", true, (doc) => {
      doc.getMap("notes").set("reply", "server");
      return { ok: true };
    });
    await expect(
      withProjectDocument(db, "owner", "p", true, (doc) => {
        doc.getMap("notes").set("reply", "rejected");
        throw Error("stale write");
      }),
    ).rejects.toThrow("stale write");
    expect(
      await withProjectDocument(db, "owner", "p", false, (doc) =>
        doc.getMap("notes").get("reply"),
      ),
    ).toBe("server");
    local.free();
  } finally {
    await db.close();
  }
});
