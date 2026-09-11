import { describe, expect, it, vi } from "vitest";
import { createProjectCloudSyncCoordinator } from "./project-cloud-sync.js";
import type { ProjectCloudSyncObservation } from "./project-cloud-sync.js";
import type { ProjectCloudAdmission } from "@clash/shared-types";

const base: ProjectCloudAdmission = {
  schemaVersion: 1,
  projectId: "project-1",
  tenantId: "tenant-1",
  userId: "user-1",
  localReplicaId: "replica-1",
  syncBaseUrl: "https://cloud.example.com",
  status: "pending",
  capabilities: { canvas: true, projectMetadata: true, resources: true },
  admittedAt: null,
  updatedAt: "2026-09-04T00:00:00.000Z",
  lastError: null,
};

describe("project cloud sync coordinator", () => {
  it("coalesces concurrent runs and retries a failed idempotent step", async () => {
    let state = base;
    let version = 0;
    const writes: ProjectCloudAdmission[] = [];
    const store = {
      read: vi.fn(async () => ({ admission: state, version })),
      compareAndSet: async (
        expected: ProjectCloudSyncObservation,
        next: ProjectCloudAdmission,
      ) => {
        if (version !== expected.version) return null;
        state = next;
        writes.push(next);
        return { admission: state, version: ++version };
      },
    };
    let resourceAttempt = 0;
    const steps = {
      syncLoro: vi.fn(async () => undefined),
      syncMetadata: vi.fn(async () => undefined),
      syncResources: vi.fn(async () => {
        resourceAttempt += 1;
        if (resourceAttempt === 1) throw new Error("network reset");
      }),
    };
    const coordinator = createProjectCloudSyncCoordinator({
      state: store,
      steps,
      now: () => new Date("2026-09-04T00:01:00.000Z"),
    });

    const first = await Promise.all([coordinator.run(), coordinator.run()]);
    expect(first[0]).toMatchObject({ status: "failed" });
    expect(first[1]).toEqual(first[0]);
    expect(steps.syncLoro).toHaveBeenCalledTimes(1);

    await expect(coordinator.run()).resolves.toMatchObject({ status: "ready" });
    expect(steps.syncResources).toHaveBeenCalledTimes(2);
    expect(state.status).toBe("ready");
    expect(state.admittedAt).toBe("2026-09-04T00:01:00.000Z");
    expect(writes.map((entry) => entry.status)).toEqual([
      "syncing",
      "failed",
      "syncing",
      "ready",
    ]);
  });
});

describe("Project sync concurrency", () => {
  it("does not restore readiness after admission is revoked during Resource upload", async () => {
    let state = { ...base };
    let version = 0;
    const result = await createProjectCloudSyncCoordinator({
      state: {
        read: async () => ({ admission: state, version }),
        compareAndSet: async (expected, next) => {
          if (version !== expected.version) return null;
          state = next;
          return { admission: state, version: ++version };
        },
      },
      steps: {
        syncLoro: async () => undefined,
        syncMetadata: async () => undefined,
        syncResources: async () => {
          state = { ...state, status: "local-only" };
          version++;
        },
      },
    }).run();
    expect(state.status).toBe("local-only");
    expect(result.status).not.toBe("ready");
  });

  it("reconciles new content after an earlier ready result", async () => {
    let state = { ...base, status: "ready" as const } as ProjectCloudAdmission;
    let version = 0;
    let mirrored = false;
    await createProjectCloudSyncCoordinator({
      state: {
        read: async () => ({ admission: state, version }),
        compareAndSet: async (expected, next) => {
          if (version !== expected.version) return null;
          state = next;
          return { admission: state, version: ++version };
        },
      },
      steps: {
        syncLoro: async () => undefined,
        syncMetadata: async () => undefined,
        syncResources: async () => {
          mirrored = true;
        },
      },
    }).run();
    expect(mirrored).toBe(true);
  });
});
