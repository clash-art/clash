import type { ResolvedAsset } from "@clash/shared-types";
import type { LoroDoc } from "loro-crdt";

import { listProjectAssets } from "./hooks/useAsset";

type ProjectAssetProjectionSubscription = {
  doc: LoroDoc;
  projectId: string;
  readProjection?: (projectId: string) => Promise<ResolvedAsset[]>;
  onProjection: (assets: ResolvedAsset[]) => void;
  onError?: (error: unknown) => void;
  retryDelayMs?: number;
  /** Upper bound for the exponential retry delay after failed reads. */
  maxRetryDelayMs?: number;
  /**
   * Resolved delivery URLs are short-lived projections (signed cloud read
   * capabilities expire; a Host may finish replicating bytes later). Re-read
   * the projection on this cadence even without a membership change.
   */
  refreshIntervalMs?: number;
};

/** Below the shortest delivery capability lifetime any adapter issues (15 min). */
export const PROJECT_ASSET_PROJECTION_REFRESH_MS = 10 * 60_000;

function projectAssetMembershipFingerprint(doc: LoroDoc): string {
  return JSON.stringify(doc.getMap("projectAssets").toJSON());
}

/**
 * Loro owns Project Asset membership and lifecycle. Resolved delivery URLs stay
 * Host projections, so a membership revision invalidates and re-reads that
 * projection instead of creating a second browser-side asset timeline.
 */
export function subscribeProjectAssetProjection({
  doc,
  projectId,
  readProjection = listProjectAssets,
  onProjection,
  onError,
  retryDelayMs = 500,
  maxRetryDelayMs = 30_000,
  refreshIntervalMs = PROJECT_ASSET_PROJECTION_REFRESH_MS,
}: ProjectAssetProjectionSubscription): () => void {
  let fingerprint = projectAssetMembershipFingerprint(doc);
  let latestRequest = 0;
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const refreshProjection = (request: number, attempt = 0) => {
    void readProjection(projectId)
      .then((assets) => {
        if (disposed || request !== latestRequest) return;
        clearRetry();
        onProjection(assets);
      })
      .catch((error) => {
        if (disposed || request !== latestRequest) return;
        onError?.(error);
        clearRetry();
        retryTimer = setTimeout(
          () => {
            retryTimer = null;
            if (disposed || request !== latestRequest) return;
            refreshProjection(request, attempt + 1);
          },
          Math.min(maxRetryDelayMs, retryDelayMs * 2 ** attempt),
        );
      });
  };

  // Only membership changes can invalidate this projection. Listening to the
  // whole document also serializes every Asset on canvas geometry commits.
  const unsubscribe = doc.getMap("projectAssets").subscribe(() => {
    const nextFingerprint = projectAssetMembershipFingerprint(doc);
    if (nextFingerprint === fingerprint) return;
    fingerprint = nextFingerprint;

    const request = ++latestRequest;
    clearRetry();
    refreshProjection(request);
  });

  // A subscriber may mount after the Host already committed Project Assets to
  // Loro (for example after reopening a project or reconnecting a Desktop
  // Host). Do not wait for another membership mutation before projecting the
  // current replica into device-local delivery URLs.
  refreshProjection(++latestRequest);

  const refreshTimer =
    refreshIntervalMs > 0
      ? setInterval(() => {
          if (disposed) return;
          const request = ++latestRequest;
          clearRetry();
          refreshProjection(request);
        }, refreshIntervalMs)
      : null;

  return () => {
    disposed = true;
    latestRequest += 1;
    clearRetry();
    if (refreshTimer !== null) clearInterval(refreshTimer);
    unsubscribe();
  };
}
