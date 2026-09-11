import { getLocalReplicaId } from "./local-replica-identity.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectCloudAdmissionResponse } from "@clash/shared-types";
import { createLocalApiApp } from "./app.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import { createLocalSyncConfigStore } from "./sync-config.js";

describe("local Project cloud admission route", () => {
  it("admits only the selected Project and keeps the global switch local-only", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-admission-route-"));
    try {
      const ensureProjectSync = vi.fn(async () => undefined);
      const cloudAdmission = {
        admit: vi.fn(
          async (request): Promise<ProjectCloudAdmissionResponse> => ({
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
        ),
      };
      const app = createLocalApiApp({
        dataDir,
        userId: "user-1",
        resolveCloudAdmission: async () => cloudAdmission,
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
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("reports only this Host's Project admission and never treats admission as completed replication", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-readiness-"));
    try {
      const app = createLocalApiApp({
        dataDir,
        userId: "user-1",
        syncConfig: {
          ...createLocalSyncConfigStore({ dataDir, env: {} }),
          resolveRemotePersistence: async () => undefined,
        },
        cloudAdmission: {
          admit: async (request) => ({
            schemaVersion: 1,
            syncBaseUrl: "https://cloud.example.com",
            admission: {
              schemaVersion: 1,
              projectId: request.projectId,
              localReplicaId: request.localReplicaId,
              tenantId: "tenant-1",
              userId: "user-1",
              syncBaseUrl: "https://cloud.example.com",
              status: "ready",
              capabilities: {
                canvas: true,
                projectMetadata: true,
                resources: true,
              },
              admittedAt: "2026-09-04T00:00:00Z",
              updatedAt: "2026-09-04T00:00:00Z",
              lastError: null,
            },
          }),
        },
      });
      const create = async (name: string) =>
        (await (
          await app.request("/api/v1/projects", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          })
        ).json()) as { id: string };
      const selected = await create("Selected");
      const other = await create("Local only");
      const response = await app.request(
        `/api/v1/projects/${selected.id}/cloud-admission`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        admission: { status: "pending" },
      });
      const selectedStatus = await (
        await app.request(`/api/v1/projects/${selected.id}/status`)
      ).json();
      expect(selectedStatus).toMatchObject({
        collaboration: {
          mode: "synced",
          webOpenable: false,
          actions: {
            shareProject: { allowed: false },
            runLocalAgent: { allowed: true },
          },
        },
      });
      const store = createLocalMetadataStore(dataDir);
      const recorded = await store.getProjectCloudAdmission(
        selected.id,
        await getLocalReplicaId(dataDir),
      );
      expect(recorded).not.toBeNull();
      for (const state of ["ready", "failed", "local-only"] as const) {
        await store.upsertProjectCloudAdmission({
          ...recorded!,
          status: state,
          lastError: state === "failed" ? "Resource upload failed" : null,
        });
        const observed = await (
          await app.request(`/api/v1/projects/${selected.id}/status`)
        ).json();
        expect(observed.collaboration.webOpenable).toBe(state === "ready");
        expect(observed.collaboration.actions.shareProject.allowed).toBe(
          state === "ready",
        );
        expect(observed.collaboration.actions.runLocalAgent.allowed).toBe(true);
        expect(observed.collaboration.syncReadiness.status).toBe(
          state === "local-only" ? "disabled" : state,
        );
      }
      const otherStatus = await (
        await app.request(`/api/v1/projects/${other.id}/status`)
      ).json();
      expect(otherStatus).toMatchObject({
        collaboration: { mode: "local-only", webOpenable: false },
      });
      const foreign = await create("Other replica");
      await app.request(`/api/v1/projects/${foreign.id}/cloud-admission`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localReplicaId: "another-host" }),
      });
      expect(
        await (
          await app.request(`/api/v1/projects/${foreign.id}/status`)
        ).json(),
      ).toMatchObject({
        collaboration: { mode: "local-only", webOpenable: false },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
