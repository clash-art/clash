import type {
  ProjectCloudAdmission,
  ProjectCloudAdmissionStatus,
} from "@clash/shared-types";

export interface ProjectCloudSyncObservation {
  admission: ProjectCloudAdmission;
  /** Host-owned monotonic record version; never part of Project public state. */
  version: number;
}

export interface ProjectCloudSyncStateStore {
  read(): Promise<ProjectCloudSyncObservation>;
  compareAndSet(
    expected: ProjectCloudSyncObservation,
    next: ProjectCloudAdmission,
  ): Promise<ProjectCloudSyncObservation | null>;
}

/** Each step must be idempotent: Loro and Resource delivery ports already use
 * content/version identities so a retry can safely replay a completed step. */
export interface ProjectCloudSyncSteps {
  syncLoro(): Promise<void>;
  syncMetadata(): Promise<void>;
  syncResources(): Promise<void>;
}

export interface ProjectCloudSyncResult {
  status: ProjectCloudAdmissionStatus;
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
    const observation = await options.state.read();
    const current = observation.admission;
    if (current.status === "local-only") {
      return { status: "local-only", changed: false };
    }
    const now = options.now ?? (() => new Date());
    const syncing = await options.state.compareAndSet(
      observation,
      withStatus(current, "syncing", now().toISOString(), null),
    );
    if (!syncing) {
      return {
        status: (await options.state.read()).admission.status,
        changed: false,
      };
    }
    const stillCurrent = async () => {
      const latest = await options.state.read();
      return latest.version === syncing.version;
    };
    try {
      for (const step of [
        options.steps.syncLoro,
        options.steps.syncMetadata,
        options.steps.syncResources,
      ]) {
        if (!(await stillCurrent()))
          return {
            status: (await options.state.read()).admission.status,
            changed: false,
          };
        await step();
      }
      const committed = await options.state.compareAndSet(
        syncing,
        withStatus(syncing.admission, "ready", now().toISOString(), null),
      );
      return {
        status: (await options.state.read()).admission.status,
        changed: !!committed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const committed = await options.state.compareAndSet(
        syncing,
        withStatus(syncing.admission, "failed", now().toISOString(), message),
      );
      return {
        status: (await options.state.read()).admission.status,
        changed: !!committed,
        error: message,
      };
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
