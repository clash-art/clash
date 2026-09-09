import { describe, expect, it, vi } from "vitest";

import {
  createProjectMetadataReplicator,
  type ProjectMetadataStore,
  type ProjectMetadataSyncRemote,
} from "./project-metadata-sync.js";
import type { ProjectMetadata } from "@clash/shared-types";

const metadata = {
  projectId: "project-1",
  name: "Draft",
  description: "A local-first project",
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:01:00.000Z",
  deletedAt: null,
};

function localStore(initial: ProjectMetadata | null): ProjectMetadataStore & {
  value: ProjectMetadata | null;
} {
  let value = initial;
  return {
    get value() {
      return value;
    },
    async read() {
      return value;
    },
    async write(next) {
      value = next;
    },
  };
}

describe("project metadata replicator", () => {
  it("does not touch either side while the cloud capability is disabled", async () => {
    const local = localStore(metadata);
    const remote: ProjectMetadataSyncRemote = {
      pull: vi.fn(),
      push: vi.fn(),
    };
    const replicator = createProjectMetadataReplicator({
      enabled: false,
      local,
      remote,
    });

    await expect(replicator.sync()).resolves.toEqual({ status: "disabled" });
    expect(remote.pull).not.toHaveBeenCalled();
    expect(remote.push).not.toHaveBeenCalled();
    expect(local.value).toEqual(metadata);
  });

  it("pushes local metadata when the cloud has no copy", async () => {
    const local = localStore(metadata);
    const remote: ProjectMetadataSyncRemote = {
      pull: vi.fn().mockResolvedValue(null),
      push: vi.fn().mockResolvedValue(undefined),
    };
    const replicator = createProjectMetadataReplicator({
      enabled: true,
      local,
      remote,
    });

    await expect(replicator.sync()).resolves.toEqual({
      status: "pushed",
      metadata,
    });
    expect(remote.push).toHaveBeenCalledWith(metadata);
  });

  it("applies newer remote metadata and never overwrites it with stale local state", async () => {
    const local = localStore(metadata);
    const remoteMetadata = {
      ...metadata,
      name: "Cloud copy",
      updatedAt: "2026-09-04T00:02:00.000Z",
    };
    const remote: ProjectMetadataSyncRemote = {
      pull: vi.fn().mockResolvedValue(remoteMetadata),
      push: vi.fn().mockResolvedValue(undefined),
    };
    const replicator = createProjectMetadataReplicator({
      enabled: true,
      local,
      remote,
    });

    await expect(replicator.sync()).resolves.toEqual({
      status: "pulled",
      metadata: remoteMetadata,
    });
    expect(local.value).toEqual(remoteMetadata);
    expect(remote.push).not.toHaveBeenCalled();
  });

  it("pushes newer local metadata and reports an equal timestamp conflict deterministically", async () => {
    const local = localStore({
      ...metadata,
      name: "Local copy",
      updatedAt: "2026-09-04T00:03:00.000Z",
    });
    const remoteMetadata = {
      ...metadata,
      name: "Cloud copy",
      updatedAt: "2026-09-04T00:02:00.000Z",
    };
    const remote: ProjectMetadataSyncRemote = {
      pull: vi.fn().mockResolvedValue(remoteMetadata),
      push: vi.fn().mockResolvedValue(undefined),
    };
    const replicator = createProjectMetadataReplicator({
      enabled: true,
      local,
      remote,
    });

    await expect(replicator.sync()).resolves.toEqual({
      status: "pushed",
      metadata: local.value,
    });
    expect(remote.push).toHaveBeenCalledWith(local.value);
  });

  it("uses the same tie-breaker when equal metadata arrives with different key order", async () => {
    const local = localStore({
      ...metadata,
      name: "Local copy",
      updatedAt: "2026-09-04T00:02:00.000Z",
    });
    const remoteMetadata = {
      deletedAt: null,
      updatedAt: "2026-09-04T00:02:00.000Z",
      createdAt: metadata.createdAt,
      description: metadata.description,
      projectId: metadata.projectId,
      name: "Cloud copy",
    };
    const remote: ProjectMetadataSyncRemote = {
      pull: vi.fn().mockResolvedValue(remoteMetadata),
      push: vi.fn().mockResolvedValue(undefined),
    };
    const replicator = createProjectMetadataReplicator({
      enabled: true,
      local,
      remote,
    });

    await expect(replicator.sync()).resolves.toMatchObject({
      status: "conflict",
      winner: "local",
      metadata: local.value,
    });
    expect(remote.push).toHaveBeenCalledWith(local.value);
  });
});
