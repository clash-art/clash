import {
  classifySyncError,
  type ProjectCloudAdmission,
  type ProjectCloudAdmissionStatus,
} from "@clash/shared-types";

/** Prefix of a failed admission's lastError that needs the user before retrying. */
export const SYNC_ACTION_REQUIRED_PREFIX = "Action required: ";

/**
 * Stable codes carried by a failed cloud sync's `lastError`. They name the
 * plane that fell behind (Loro stream, Project metadata, immutable Resources)
 * so a caller can distinguish a cloud drift from an unrelated local failure.
 */
export const PROJECT_CLOUD_MIRROR_FAILED = "PROJECT_CLOUD_MIRROR_FAILED";
export const PROJECT_METADATA_SYNC_FAILED = "PROJECT_METADATA_SYNC_FAILED";
export const PROJECT_CLOUD_RESOURCE_SYNC_FAILED =
  "PROJECT_CLOUD_RESOURCE_SYNC_FAILED";

export function isActionRequiredSyncFailure(
  admission: Pick<ProjectCloudAdmission, "status" | "lastError">,
): boolean {
  return (
    admission.status === "failed" &&
    !!admission.lastError?.startsWith(SYNC_ACTION_REQUIRED_PREFIX)
  );
}

/**
 * Map a sync step failure to the lastError shown next to "Retry sync".
 *
 * `fallbackCode` names the failing plane when the error has no code of its
 * own; a coded error keeps its more specific code. The code always leads the
 * message so the persisted, user-visible state is self-describing.
 */
export function projectCloudSyncFailureMessage(
  error: unknown,
  fallbackCode?: string,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const errorCode = (error as { code?: unknown } | null)?.code;
  const status = (error as { status?: unknown } | null)?.status;
  const code =
    typeof errorCode === "string" && errorCode.trim()
      ? errorCode
      : fallbackCode;
  const labeled = code ? `${code}: ${raw}` : raw;
  const { severity, action } = classifySyncError({
    code: typeof errorCode === "string" ? errorCode : undefined,
    httpStatus: typeof status === "number" ? status : undefined,
  });
  if (severity !== "user_action_required") return labeled;
  if (action === "free_disk")
    return `${SYNC_ACTION_REQUIRED_PREFIX}this computer is out of disk space. Free some space, then choose Retry sync. (${labeled})`;
  if (action === "reauthenticate")
    return `${SYNC_ACTION_REQUIRED_PREFIX}cloud sign-in expired or access was revoked. Sign in again, then choose Retry sync. (${labeled})`;
  if (action === "reduce_size")
    return `${SYNC_ACTION_REQUIRED_PREFIX}a file or project field is too large for cloud sync. Reduce it, then choose Retry sync. (${labeled})`;
  return `${SYNC_ACTION_REQUIRED_PREFIX}${labeled}`;
}

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
    let failingCode: string | undefined;
    try {
      for (const step of [
        {
          code: PROJECT_CLOUD_MIRROR_FAILED,
          run: options.steps.syncLoro,
        },
        {
          code: PROJECT_METADATA_SYNC_FAILED,
          run: options.steps.syncMetadata,
        },
        {
          code: PROJECT_CLOUD_RESOURCE_SYNC_FAILED,
          run: options.steps.syncResources,
        },
      ]) {
        if (!(await stillCurrent()))
          return {
            status: (await options.state.read()).admission.status,
            changed: false,
          };
        failingCode = step.code;
        await step.run();
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
      const message = projectCloudSyncFailureMessage(error, failingCode);
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
