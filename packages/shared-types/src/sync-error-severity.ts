/**
 * Sync error severity taxonomy.
 *
 * This does not add new error codes. It classifies the codes and signals that
 * the sync stack already produces (asset-sdk ResourceReplicationErrorCode and
 * AssetDeliveryErrorCode, api-cf HTTP statuses incl. MultipartContentError,
 * ProjectRoom WebSocket close codes, and the Loro protocol's
 * update-rejected statuses), so every layer picks the same retry policy,
 * UI surface and log level.
 */

export type SyncErrorSeverity =
  /** Auto-retry with backoff; silent in UI. */
  | "transient"
  /** Keeps working; non-blocking notice (status pill / info toast). */
  | "degraded"
  /** Stop retrying this operation; actionable UI (re-auth, free disk, shrink). */
  | "user_action_required"
  /** Possible data loss/corruption; blocking UI + telemetry. */
  | "fatal";

export interface SyncErrorSeverityPolicy {
  retry: "backoff" | "none";
  ui: "silent" | "notice" | "actionable" | "blocking";
  /** Same names as @clash/shared-runtime LogLevel. */
  log: "debug" | "info" | "warn" | "error";
  telemetry: boolean;
}

export const SYNC_ERROR_SEVERITY_POLICY: Readonly<
  Record<SyncErrorSeverity, SyncErrorSeverityPolicy>
> = Object.freeze({
  transient: { retry: "backoff", ui: "silent", log: "info", telemetry: false },
  degraded: { retry: "backoff", ui: "notice", log: "warn", telemetry: false },
  user_action_required: {
    retry: "none",
    ui: "actionable",
    log: "warn",
    telemetry: false,
  },
  fatal: { retry: "none", ui: "blocking", log: "error", telemetry: true },
});

export type SyncUserAction = "reauthenticate" | "free_disk" | "reduce_size" | "none";

export interface SyncErrorClassification {
  severity: SyncErrorSeverity;
  action: SyncUserAction;
  policy: SyncErrorSeverityPolicy;
}

/** Existing error codes from @clash/asset-sdk (kept as literals to avoid a dependency cycle). */
const CODE_SEVERITY: Readonly<
  Record<string, readonly [SyncErrorSeverity, SyncUserAction]>
> = {
  // ResourceReplicationErrorCode
  UPLOAD_FAILED: ["transient", "none"],
  DOWNLOAD_FAILED: ["transient", "none"],
  REMOTE_NOT_FOUND: ["degraded", "none"],
  LOCAL_RESOURCE_MISSING: ["degraded", "none"],
  INVALID_RESOURCE: ["fatal", "none"],
  INTEGRITY_MISMATCH: ["fatal", "none"],
  // AssetDeliveryErrorCode
  INVALID_INPUT: ["fatal", "none"],
  FORBIDDEN: ["user_action_required", "reauthenticate"],
  SIGNING_FAILED: ["transient", "none"],
  // Node fs errors surfaced by Host content writes
  ENOSPC: ["user_action_required", "free_disk"],
  EDQUOT: ["user_action_required", "free_disk"],
};

export interface SyncErrorSignal {
  /** An existing error code (asset-sdk codes or a Node errno code). */
  code?: string;
  /** HTTP status of a REST call or a failed WebSocket upgrade. */
  httpStatus?: number;
  /** WebSocket close code. */
  wsCloseCode?: number;
}

function classified(
  severity: SyncErrorSeverity,
  action: SyncUserAction = "none",
): SyncErrorClassification {
  return { severity, action, policy: SYNC_ERROR_SEVERITY_POLICY[severity] };
}

export function classifySyncError(signal: SyncErrorSignal): SyncErrorClassification {
  if (signal.code && CODE_SEVERITY[signal.code]) {
    const [severity, action] = CODE_SEVERITY[signal.code]!;
    return classified(severity, action);
  }
  const close = signal.wsCloseCode;
  if (close !== undefined) {
    // ProjectRoom closes 1008 when project authorization expired or was revoked.
    if (close === 1008) return classified("user_action_required", "reauthenticate");
    if (close === 1009) return classified("user_action_required", "reduce_size");
    // 1000/1001 normal/going-away (deploy, DO restart), 1006 abnormal, 1011/1012/1013 server.
    return classified("transient");
  }
  const status = signal.httpStatus;
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return classified("user_action_required", "reauthenticate");
    }
    if (status === 413) return classified("user_action_required", "reduce_size");
    if (status === 408 || status === 425 || status === 429) return classified("transient");
    if (status === 409 || status === 412) return classified("degraded");
    if (status >= 500) return classified("transient");
    if (status >= 400) return classified("fatal");
  }
  return classified("transient");
}

/**
 * loro-protocol UpdateStatusCode (numeric) carried by update-rejected acks:
 * 1 Unknown, 3 PermissionDenied, 4 InvalidUpdate, 5 PayloadTooLarge,
 * 6 RateLimited, 7 FragmentTimeout, 127 AppError.
 */
export function classifyLoroUpdateRejection(status: number): SyncErrorClassification {
  switch (status) {
    case 3:
      return classified("user_action_required", "reauthenticate");
    case 5:
      return classified("user_action_required", "reduce_size");
    case 1:
    case 6:
    case 7:
      return classified("transient");
    default:
      // InvalidUpdate/AppError: the local replica holds operations the cloud
      // refused; later ops can depend on them (data-risk).
      return classified("fatal");
  }
}
