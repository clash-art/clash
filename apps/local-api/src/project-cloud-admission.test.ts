import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHttpCloudAdmissionClient,
} from "./project-cloud-admission.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";

describe("HTTP project cloud admission client", () => {
  it("sends admission without changing the local sync mode", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          syncBaseUrl: "https://cloud.example.com",
          admission: {
            schemaVersion: 1,
            projectId: "project-1",
            tenantId: "personal:user-1",
            userId: "user-1",
            localReplicaId: "replica-1",
            syncBaseUrl: "https://cloud.example.com",
            status: "pending",
            capabilities: {
              canvas: true,
              projectMetadata: true,
              resources: true,
            },
            admittedAt: null,
            updatedAt: "2026-09-04T00:00:00.000Z",
            lastError: null,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createHttpCloudAdmissionClient({
      baseUrl: "https://cloud.example.com/",
      token: "clsh_token",
      fetch,
    });
    const response = await client.admit({
      schemaVersion: 1,
      projectId: "project-1",
      localReplicaId: "replica-1",
      metadata: {
        projectId: "project-1",
        name: "Demo",
        description: null,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        deletedAt: null,
      },
      resourceIds: [],
    });

    expect(response.admission.status).toBe("pending");
    expect(fetch).toHaveBeenCalledWith(
      "https://cloud.example.com/api/v1/projects/project-1/cloud-admission",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect((request.headers as Headers).get("authorization")).toBe(
      "Bearer clsh_token",
    );
  });

  it("persists one admission per local replica", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-admission-"));
    try {
      const store = createLocalMetadataStore(root);
      const admission = {
        schemaVersion: 1 as const,
        projectId: "project-1",
        tenantId: "personal:user-1",
        userId: "user-1",
        localReplicaId: "replica-1",
        syncBaseUrl: "https://cloud.example.com",
        status: "pending" as const,
        capabilities: { canvas: true, projectMetadata: true, resources: true },
        admittedAt: null,
        updatedAt: "2026-09-04T00:00:00.000Z",
        lastError: null,
      };
      await store.upsertProjectCloudAdmission(admission);
      await expect(
        store.getProjectCloudAdmission("project-1", "replica-1"),
      ).resolves.toEqual(admission);
      await expect(
        store.getLatestProjectCloudAdmission("project-1"),
      ).resolves.toEqual(admission);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
