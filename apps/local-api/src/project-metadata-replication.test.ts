import { describe, expect, it, vi } from "vitest";

import { createLocalProjectMetadataReplication } from "./project-metadata-replication.js";

const metadata = {
  projectId: "project-1",
  name: "Local project",
  description: null,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:01:00.000Z",
  deletedAt: null,
};

describe("local project metadata replication", () => {
  it("does not resolve or contact cloud persistence while the total switch is off", async () => {
    const resolveRemotePersistence = vi.fn();
    const localRead = vi.fn();
    const replication = createLocalProjectMetadataReplication({
      syncConfig: {
        getPublicConfig: vi.fn().mockResolvedValue({
          mode: "local-only",
          remote_loro: {
            enabled: false,
            url: null,
            has_token: false,
            source: "none",
          },
          capabilities: {
            canvas: false,
            asset_metadata: false,
            revision_content: false,
            project_metadata: false,
          },
        }),
        resolveRemotePersistence,
      },
      local: { read: localRead, write: vi.fn() },
    });

    await expect(replication.sync("project-1")).resolves.toEqual({
      status: "disabled",
    });
    expect(resolveRemotePersistence).not.toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
  });

  it("uses the metadata transport only after both cloud-sync and its capability are enabled", async () => {
    const saveProjectMetadata = vi.fn();
    const replication = createLocalProjectMetadataReplication({
      syncConfig: {
        getPublicConfig: vi.fn().mockResolvedValue({
          mode: "cloud-sync",
          remote_loro: {
            enabled: true,
            url: "https://cloud.example",
            has_token: true,
            source: "config",
          },
          capabilities: {
            canvas: true,
            asset_metadata: true,
            revision_content: true,
            project_metadata: true,
          },
        }),
        resolveRemotePersistence: vi.fn().mockResolvedValue({
          appendUpdate: vi.fn(),
          loadProjectMetadata: vi.fn().mockResolvedValue(null),
          saveProjectMetadata,
        }),
      },
      local: {
        read: vi.fn().mockResolvedValue(metadata),
        write: vi.fn(),
      },
    });

    await expect(replication.sync("project-1")).resolves.toMatchObject({
      status: "pushed",
      metadata,
    });
    expect(saveProjectMetadata).toHaveBeenCalledWith("project-1", metadata);
  });

  it("coalesces a mutation burst into one remote sync per Project", async () => {
    vi.useFakeTimers();
    try {
      const pull = vi.fn().mockResolvedValue(null);
      const push = vi.fn().mockResolvedValue(undefined);
      const replication = createLocalProjectMetadataReplication({
        debounceMs: 50,
        syncConfig: {
          getPublicConfig: vi.fn().mockResolvedValue({
            mode: "cloud-sync",
            remote_loro: {
              enabled: true,
              url: "https://cloud.example",
              has_token: true,
              source: "config",
            },
            capabilities: {
              canvas: true,
              asset_metadata: true,
              revision_content: true,
              project_metadata: true,
            },
          }),
          resolveRemotePersistence: vi.fn().mockResolvedValue({
            loadProjectMetadata: pull,
            saveProjectMetadata: push,
          }),
          getProjectCloudAdmission: vi.fn(),
        },
        local: {
          read: vi.fn().mockResolvedValue(metadata),
          write: vi.fn(),
        },
      });

      replication.schedule("project-1");
      replication.schedule("project-1");
      replication.schedule("project-1");
      await vi.advanceTimersByTimeAsync(49);
      expect(pull).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await replication.idle();
      expect(pull).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed mirror through the coded-status hook", async () => {
    const failure = new Error("fetch failed");
    const onError = vi.fn();
    const replication = createLocalProjectMetadataReplication({
      onError,
      syncConfig: {
        getPublicConfig: vi.fn().mockResolvedValue({
          mode: "cloud-sync",
          remote_loro: {
            enabled: true,
            url: "https://cloud.example",
            has_token: true,
            source: "config",
          },
          capabilities: {
            canvas: true,
            asset_metadata: true,
            revision_content: true,
            project_metadata: true,
          },
        }),
        resolveRemotePersistence: vi.fn().mockResolvedValue({
          loadProjectMetadata: vi.fn().mockRejectedValue(failure),
          saveProjectMetadata: vi.fn(),
        }),
        getProjectCloudAdmission: vi.fn(),
      },
      local: {
        read: vi.fn().mockResolvedValue(metadata),
        write: vi.fn(),
      },
    });

    replication.schedule("project-1");
    await replication.idle();
    expect(onError).toHaveBeenCalledWith("project-1", failure);
  });
});
