import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { createPostgresCloudProjectAdmissionStore } from "./project-cloud-admission-postgres";

it("persists repeat admission, denies other owners/deleted projects, and rolls back failed writes", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      await readFile(
        new URL(
          "../../shared-cloud-schema/postgres/0001_project_admission.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const store = createPostgresCloudProjectAdmissionStore(db);
    const input = {
      userId: "owner",
      syncBaseUrl: "https://cloud.example.com/",
      request: {
        schemaVersion: 1 as const,
        projectId: "project",
        localReplicaId: "replica",
        resourceIds: [],
        metadata: {
          projectId: "project",
          name: "Project",
          description: null,
          createdAt: "2026-09-04T00:00:00.000Z",
          updatedAt: "2026-09-04T00:00:00.000Z",
          deletedAt: null,
        },
      },
    };
    const first = await store.admit(input);
    expect(first.admission.status).toBe("pending");
    await db.exec(
      "UPDATE project_cloud_admission SET status='ready', admitted_at=CURRENT_TIMESTAMP",
    );
    const repeat = await store.admit({
      ...input,
      syncBaseUrl: "https://new.example.com/",
    });
    expect(repeat.admission.status).toBe("ready");
    expect(repeat.admission.admittedAt).not.toBeNull();
    expect(repeat.syncBaseUrl).toBe(repeat.admission.syncBaseUrl);
    expect(repeat.syncBaseUrl).toBe("https://cloud.example.com");
    await expect(store.admit({ ...input, userId: "intruder" })).rejects.toThrow(
      "Forbidden",
    );
    expect(
      await store.read({
        userId: "intruder",
        projectId: "project",
        localReplicaId: "replica",
      }),
    ).toBeNull();
    await db.exec("UPDATE project SET tenant_id='other-tenant'");
    await expect(store.admit(input)).rejects.toThrow("Forbidden");
    expect(
      await store.read({
        userId: "owner",
        projectId: "project",
        localReplicaId: "replica",
      }),
    ).toBeNull();
    await db.exec("UPDATE project SET tenant_id='personal:owner'");
    const contenders = await Promise.allSettled(
      ["one", "two"].map((userId) =>
        store.admit({
          ...input,
          userId,
          request: {
            ...input.request,
            projectId: "contended",
            metadata: { ...input.request.metadata, projectId: "contended" },
          },
        }),
      ),
    );
    const winner = contenders.find((result) => result.status === "fulfilled");
    const loser = contenders.find((result) => result.status === "rejected");
    expect(winner?.status).toBe("fulfilled");
    expect(loser?.status === "rejected" && loser.reason.message).toBe(
      "Forbidden",
    );
    const persisted = await db.query(
      "SELECT owner_id FROM project WHERE id='contended'",
    );
    if (winner?.status === "fulfilled")
      expect(persisted.rows).toEqual([
        { owner_id: winner.value.admission.userId },
      ]);
    await db.exec("UPDATE project SET deleted_at=CURRENT_TIMESTAMP");
    await expect(store.admit(input)).rejects.toThrow("Forbidden");
    expect(
      await store.read({
        userId: "owner",
        projectId: "project",
        localReplicaId: "replica",
      }),
    ).toBeNull();
    await db.exec(
      "ALTER TABLE project_cloud_admission ADD CONSTRAINT reject_test CHECK (local_replica_id <> 'reject')",
    );
    await expect(
      store.admit({
        ...input,
        userId: "rollback-owner",
        request: {
          ...input.request,
          projectId: "rollback",
          localReplicaId: "reject",
          metadata: { ...input.request.metadata, projectId: "rollback" },
        },
      }),
    ).rejects.toThrow();
    expect(
      (await db.query("SELECT id FROM project WHERE id='rollback'")).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT id FROM tenant WHERE owner_user_id='rollback-owner'",
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await db.close();
  }
});
