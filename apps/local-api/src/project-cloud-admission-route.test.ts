import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectCloudAdmissionResponse } from "@clash/shared-types";
import { createLocalApiApp } from "./app.js";
import { createLocalSyncConfigStore } from "./sync-config.js";

describe("local Project cloud admission route", () => {
  it("admits only the selected Project and keeps the global switch local-only", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-admission-route-"));
    try {
      const ensureProjectSync = vi.fn(async () => undefined);
      const cloudAdmission = {
        admit: vi.fn(async (request): Promise<ProjectCloudAdmissionResponse> => ({
          schemaVersion: 1,
          syncBaseUrl: "https://cloud.example.com",
          admission: {
            schemaVersion: 1,
            projectId: request.projectId,
            tenantId: "personal:user-1",
            userId: "user-1",
            localReplicaId: request.localReplicaId,
            syncBaseUrl: "https://cloud.example.com",
            status: "pending",
            capabilities: { canvas: true, projectMetadata: true, resources: true },
            admittedAt: null,
            updatedAt: "2026-09-04T00:00:00.000Z",
            lastError: null,
          },
        })),
      };
      const app = createLocalApiApp({
        dataDir,
        userId: "user-1",
        cloudAdmission,
        ensureProjectSync,
      });
      const created = await app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Local draft" }),
      });
      const project = (await created.json()) as { id: string };
      const admitted = await app.request(
        `/api/v1/projects/${project.id}/cloud-admission`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ localReplicaId: "replica-1" }),
        },
      );

      expect(admitted.status).toBe(201);
      expect(cloudAdmission.admit).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: project.id,
          localReplicaId: "replica-1",
          metadata: expect.objectContaining({ name: "Local draft" }),
        }),
      );
      expect(ensureProjectSync).toHaveBeenCalledWith(project.id);
      await expect(
        createLocalSyncConfigStore({ dataDir, env: {} }).getPublicConfig(),
      ).resolves.toMatchObject({ mode: "local-only" });
      await expect(
        app.request(
          `/api/v1/projects/${project.id}/cloud-admission?localReplicaId=replica-1`,
        ),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("persists a visible failed state when the cloud admission request is unavailable", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-admission-failed-"));
    try {
      const app = createLocalApiApp({
        dataDir,
        userId: "user-1",
        cloudAdmission: {
          admit: vi.fn(async () => {
            throw new Error("cloud is unreachable");
          }),
        },
      });
      const created = await app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Offline draft" }),
      });
      const project = (await created.json()) as { id: string };
      const response = await app.request(
        `/api/v1/projects/${project.id}/cloud-admission`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ localReplicaId: "replica-1" }),
        },
      );

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        code: "CLOUD_ADMISSION_FAILED",
        admission: {
          projectId: project.id,
          status: "failed",
          lastError: "cloud is unreachable",
        },
      });
      await expect(
        app.request(
          `/api/v1/projects/${project.id}/cloud-admission?localReplicaId=replica-1`,
        ),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
