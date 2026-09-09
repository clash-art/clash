import { describe, expect, it } from "vitest";
import {
  ProjectCloudAdmissionRequestSchema,
  ProjectCloudAdmissionSchema,
} from "./project-cloud-admission.js";

const metadata = {
  projectId: "project-1",
  name: "Demo",
  description: null,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
  deletedAt: null,
};

describe("Project cloud admission contracts", () => {
  it("keeps admission project-scoped and explicit", () => {
    const parsed = ProjectCloudAdmissionRequestSchema.parse({
      schemaVersion: 1,
      projectId: "project-1",
      localReplicaId: "replica-1",
      metadata,
      resourceIds: ["resource-1"],
    });
    expect(parsed.projectId).toBe("project-1");
    expect(parsed.resourceIds).toEqual(["resource-1"]);
  });

  it("rejects a failed admission without an explanatory error", () => {
    expect(() =>
      ProjectCloudAdmissionSchema.parse({
        schemaVersion: 1,
        projectId: "project-1",
        tenantId: "tenant-1",
        userId: "user-1",
        localReplicaId: "replica-1",
        syncBaseUrl: "https://cloud.example.com",
        status: "failed",
        capabilities: { canvas: true, projectMetadata: true, resources: true },
        admittedAt: null,
        updatedAt: "2026-09-04T00:00:00.000Z",
        lastError: null,
      }),
    ).toThrow();
  });
});
