import {
  createProjectMetadataReplicator,
  type ProjectMetadataSyncResult,
} from "@clash/shared-runtime";
import {
  ProjectMetadataSchema,
  type ProjectMetadata,
} from "@clash/shared-types";

import type { RemoteLoroPersistence } from "./sync.js";
import type { LocalSyncConfigStore } from "./sync-config.js";

export interface LocalProjectMetadataStore {
  read(projectId: string): Promise<ProjectMetadata | null>;
  write(metadata: ProjectMetadata): Promise<void>;
}

export type LocalProjectMetadataSyncResult =
  ProjectMetadataSyncResult | { status: "unsupported" };

export interface LocalProjectMetadataReplicationOptions {
  syncConfig: Pick<
    LocalSyncConfigStore,
    "getPublicConfig" | "resolveRemotePersistence" | "getProjectCloudAdmission"
  >;
  local: LocalProjectMetadataStore;
}

export function createLocalProjectMetadataReplication(
  options: LocalProjectMetadataReplicationOptions,
) {
  const inFlight = new Map<string, Promise<LocalProjectMetadataSyncResult>>();

  async function run(
    projectId: string,
  ): Promise<LocalProjectMetadataSyncResult> {
    const config = await options.syncConfig.getPublicConfig();
    if (
      config.mode === "cloud-sync" &&
      config.capabilities.project_metadata !== true
    ) {
      return { status: "disabled" };
    }
    if (config.mode === "local-only") {
      const admission = await options.syncConfig.getProjectCloudAdmission?.(
        projectId,
      );
      if (
        !admission ||
        admission.status === "local-only" ||
        admission.status === "failed"
      ) {
        return { status: "disabled" };
      }
    }

    const remote: RemoteLoroPersistence | undefined =
      await options.syncConfig.resolveRemotePersistence(projectId);
    if (!remote?.loadProjectMetadata || !remote.saveProjectMetadata) {
      return { status: "unsupported" };
    }

    return createProjectMetadataReplicator({
      enabled: true,
      local: {
        read: () => options.local.read(projectId),
        write: (metadata) => options.local.write(metadata),
      },
      remote: {
        pull: () => remote.loadProjectMetadata!(projectId),
        push: (metadata) =>
          remote.saveProjectMetadata!(
            projectId,
            ProjectMetadataSchema.parse(metadata),
          ),
      },
    }).sync();
  }

  return {
    sync(projectId: string): Promise<LocalProjectMetadataSyncResult> {
      const existing = inFlight.get(projectId);
      if (existing) return existing;
      const current = run(projectId).finally(() => {
        if (inFlight.get(projectId) === current) inFlight.delete(projectId);
      });
      inFlight.set(projectId, current);
      return current;
    },
  };
}
