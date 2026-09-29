import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createD1CloudProjectAdmissionStore } from "../services/cloud-project-admission";

describe("Project cloud admission in Miniflare D1", () => {
  it("creates an implicit personal Tenant and is idempotent per replica", async () => {
    const store = createD1CloudProjectAdmissionStore(env.DB);
    const request = {
      schemaVersion: 1 as const,
      projectId: "integration-admission-project",
      localReplicaId: "integration-replica-1",
      metadata: {
        projectId: "integration-admission-project",
        name: "Integration project",
        description: null,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        deletedAt: null,
      },
      resourceIds: [],
    };
    const first = await store.admit({
      userId: "integration-user",
      request,
      syncBaseUrl: "https://cloud.example.com",
    });
    await env.DB.prepare(
      "UPDATE project_cloud_admission SET status = 'ready', admitted_at = 1700000000 WHERE project_id = ?",
    )
      .bind(request.projectId)
      .run();
    const second = await store.admit({
      userId: "integration-user",
      request,
      syncBaseUrl: "https://new.example.com",
    });

    expect(second.admission.status).toBe("ready");
    expect(second.admission.admittedAt).not.toBeNull();
    expect(second.syncBaseUrl).toBe(second.admission.syncBaseUrl);
    expect(second.syncBaseUrl).toBe(first.syncBaseUrl);
    await expect(
      store.admit({
        userId: "other",
        request,
        syncBaseUrl: "https://cloud.example.com",
      }),
    ).rejects.toThrow("Forbidden");
    expect(
      await store.read({
        userId: "other",
        projectId: request.projectId,
        localReplicaId: request.localReplicaId,
      }),
    ).toBeNull();
    await env.DB.prepare(
      "UPDATE project SET deleted_at = 1700000000 WHERE id = ?",
    )
      .bind(request.projectId)
      .run();
    await expect(
      store.admit({
        userId: "integration-user",
        request,
        syncBaseUrl: "https://cloud.example.com",
      }),
    ).rejects.toThrow("Forbidden");
    expect(
      await store.read({
        userId: "integration-user",
        projectId: request.projectId,
        localReplicaId: request.localReplicaId,
      }),
    ).toBeNull();
    await env.DB.exec(
      "CREATE TRIGGER reject_admission_test BEFORE INSERT ON project_cloud_admission WHEN NEW.local_replica_id = 'reject' BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    );
    try {
      await expect(
        store.admit({
          userId: "rollback-owner",
          syncBaseUrl: "https://cloud.example.com",
          request: {
            ...request,
            projectId: "rollback-project",
            localReplicaId: "reject",
            metadata: { ...request.metadata, projectId: "rollback-project" },
          },
        }),
      ).rejects.toThrow();
      expect(
        await env.DB.prepare(
          "SELECT id FROM project WHERE id = 'rollback-project'",
        ).first(),
      ).toBeNull();
      expect(
        await env.DB.prepare(
          "SELECT id FROM tenant WHERE id = 'personal:rollback-owner'",
        ).first(),
      ).toBeNull();
    } finally {
      await env.DB.exec("DROP TRIGGER reject_admission_test");
    }
    expect(first.admission.tenantId).toBe("personal:integration-user");
    expect(first.admission.status).toBe("pending");
    expect(second.admission.projectId).toBe(first.admission.projectId);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM tenant").first<{
        count: number;
      }>(),
    ).resolves.toMatchObject({ count: 1 });
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM project_cloud_admission WHERE project_id = ?",
      )
        .bind(request.projectId)
        .first<{ count: number }>(),
    ).resolves.toMatchObject({ count: 1 });
  });
});
