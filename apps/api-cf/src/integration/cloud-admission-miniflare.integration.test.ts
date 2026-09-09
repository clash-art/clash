import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createD1CloudProjectAdmissionStore,
} from "../services/cloud-project-admission";

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
    const second = await store.admit({
      userId: "integration-user",
      request,
      syncBaseUrl: "https://cloud.example.com",
    });

    expect(first.admission.tenantId).toBe("personal:integration-user");
    expect(first.admission.status).toBe("pending");
    expect(second.admission.projectId).toBe(first.admission.projectId);
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM tenant").first<{ count: number }>(),
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
