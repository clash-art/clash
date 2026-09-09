import type {
  ProjectCloudAdmission,
  ProjectCloudAdmissionStatus,
} from "@clash/shared-types";

export interface ProjectCloudSyncStateStore {
  read(): Promise<ProjectCloudAdmission>;
  write(state: ProjectCloudAdmission): Promise<void>;
}

/** Each step must be idempotent: Loro and Resource delivery ports already use
 * content/version identities so a retry can safely replay a completed step. */
export interface ProjectCloudSyncSteps {
  syncLoro(): Promise<void>;
  syncMetadata(): Promise<void>;
  syncResources(): Promise<void>;
}

export interface ProjectCloudSyncResult {
  status: Exclude<ProjectCloudAdmissionStatus, "local-only">;
  changed: boolean;
  error?: string;
}

function withStatus(
  state: ProjectCloudAdmission,
  status: Exclude<ProjectCloudAdmissionStatus, "local-only">,
  now: string,
  lastError: string | null,
): ProjectCloudAdmission {
  return {
    ...state,
    status,
    updatedAt: now,
    lastError,
    ...(status === "ready" && state.admittedAt === null
      ? { admittedAt: now }
      : {}),
  };
}

export function createProjectCloudSyncCoordinator(options: {
  state: ProjectCloudSyncStateStore;
  steps: ProjectCloudSyncSteps;
  now?: () => Date;
}) {
  let inFlight: Promise<ProjectCloudSyncResult> | undefined;

  const run = async (): Promise<ProjectCloudSyncResult> => {
    const current = await options.state.read();
    if (current.status === "local-only") {
      return { status: "pending", changed: false };
    }
    if (current.status === "ready") {
      return { status: "ready", changed: false };
    }
    const now = options.now ?? (() => new Date());
    await options.state.write(
      withStatus(current, "syncing", now().toISOString(), null),
    );
    try {
      await options.steps.syncLoro();
      await options.steps.syncMetadata();
      await options.steps.syncResources();
      // A retry may have refreshed the admission while the idempotent steps
      // were running. Preserve that latest record instead of overwriting it
      // with the stale pre-run snapshot.
      const latest = await options.state.read();
      await options.state.write(
        withStatus(latest, "ready", now().toISOString(), null),
      );
      return { status: "ready", changed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = await options.state.read();
      await options.state.write(
        withStatus(latest, "failed", now().toISOString(), message),
      );
      return { status: "failed", changed: true, error: message };
    }
  };

  return {
    run(): Promise<ProjectCloudSyncResult> {
      if (!inFlight) {
        const task = run().finally(() => {
          if (inFlight === task) inFlight = undefined;
        });
        inFlight = task;
      }
      return inFlight;
    },
  };
}
