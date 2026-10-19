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
  isProvisional?(projectId: string): Promise<boolean>;
}

export type LocalProjectMetadataSyncResult =
  ProjectMetadataSyncResult | { status: "unsupported" };

export interface LocalProjectMetadataReplicationOptions {
  syncConfig: Pick<
    LocalSyncConfigStore,
    "getPublicConfig" | "resolveRemotePersistence" | "getProjectCloudAdmission"
  >;
  local: LocalProjectMetadataStore;
  /** Coalesce mutation-driven mirrors; one remote sync per quiet period. */
  debounceMs?: number;
  /** Persist a coded per-Project failure; never leave a log-only drift. */
  onError?(projectId: string, error: unknown): void | Promise<void>;
}

export function createLocalProjectMetadataReplication(
  options: LocalProjectMetadataReplicationOptions,
) {
  const inFlight = new Map<string, Promise<LocalProjectMetadataSyncResult>>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;

  function arm(): void {
    if (timer || draining) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, options.debounceMs ?? 300);
    timer.unref?.();
  }

  async function drain(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (draining) return draining;
    const projectIds = [...pending];
    pending.clear();
    if (projectIds.length === 0) return;
    draining = (async () => {
      for (const projectId of projectIds) {
        try {
          await sync(projectId);
        } catch (error) {
          try {
            await options.onError?.(projectId, error);
          } catch (hookError) {
            console.error(
              `[local-api] failed to record Project metadata sync failure for ${projectId}`,
              hookError,
            );
          }
        }
      }
    })().finally(() => {
      draining = undefined;
      if (pending.size > 0) arm();
    });
    return draining;
  }

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
        admission.status === "local-only"
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
        isProvisional: async () =>
          (await options.local.isProvisional?.(projectId)) === true,
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

  function sync(
    projectId: string,
  ): Promise<LocalProjectMetadataSyncResult> {
    const existing = inFlight.get(projectId);
    if (existing) return existing;
    const current = run(projectId).finally(() => {
      if (inFlight.get(projectId) === current) inFlight.delete(projectId);
    });
    inFlight.set(projectId, current);
    return current;
  }

  return {
    sync,
    /** Mutation trigger: coalesce a burst into one remote sync per Project. */
    schedule(projectId: string): void {
      pending.add(projectId);
      arm();
    },
    /** Settles once every sync started so far has finished, whatever its outcome. */
    async idle(): Promise<void> {
      for (;;) {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        await drain();
        while (inFlight.size > 0) {
          await Promise.allSettled([...inFlight.values()]);
        }
        if (pending.size === 0 && !draining && !timer) return;
      }
    },
  };
}
