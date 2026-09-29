import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { LoroDoc } from "loro-crdt";
import type { AssetEvidenceMatch } from "@clash/shared-types";
import { createAssetSearchClient } from "@clash/shared-runtime/asset-search-client";
import { runtimeApiUrl } from "../../lib/runtimeConfig";

/** The Host supplies the same pinned evidence to humans and agents. */
export function useAssetEvidence({
  projectId,
  query,
  assetId,
  enabled = true,
  doc,
}: {
  projectId?: string;
  query?: string;
  assetId?: string;
  enabled?: boolean;
  doc?: LoroDoc | null;
}) {
  const subscribe = useCallback(
    (notify: () => void) =>
      doc?.getMap("documentAttachments").subscribe(notify) ?? (() => {}),
    [doc],
  );
  const snapshot = useCallback(
    () =>
      doc ? JSON.stringify(doc.getMap("documentAttachments").toJSON()) : "",
    [doc],
  );
  const version = useSyncExternalStore(subscribe, snapshot, snapshot);
  const key = JSON.stringify([
    projectId,
    query?.trim(),
    assetId,
    enabled,
    version,
  ]);
  const [loaded, setLoaded] = useState<{
    key: string;
    matches: AssetEvidenceMatch[];
    truncated: boolean;
    error?: string;
  }>();
  const active = Boolean(enabled && projectId && (assetId || query?.trim()));
  useEffect(() => {
    if (!active || !projectId) return;
    let current = true;
    const controller = new AbortController();
    const client = createAssetSearchClient((path, init) =>
      fetch(runtimeApiUrl(path), {
        ...init,
        credentials: "include",
        signal: controller.signal,
      }),
    );
    const timer = setTimeout(
      () => {
        void client
          .search(projectId, {
            ...(query?.trim() ? { query: query.trim() } : {}),
            ...(assetId ? { assetId } : {}),
          })
          .then(({ matches, truncated }) => {
            if (current) setLoaded({ key, matches, truncated });
          })
          .catch((cause) => {
            if (current)
              setLoaded({
                key,
                matches: [],
                truncated: false,
                error: cause instanceof Error ? cause.message : String(cause),
              });
          });
      },
      assetId ? 0 : 150,
    );
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, projectId, query, assetId, key]);
  return {
    matches: active && loaded?.key === key ? loaded.matches : [],
    truncated: active && loaded?.key === key ? loaded.truncated : false,
    loading: active && loaded?.key !== key,
    error: active && loaded?.key === key ? loaded.error : undefined,
  };
}

export function evidenceTimeRange(
  match: Pick<AssetEvidenceMatch, "startMs" | "endMs">,
): string | undefined {
  if (match.startMs === undefined || match.endMs === undefined)
    return undefined;
  const time = (ms: number) =>
    `${Math.floor(ms / 60000)
      .toString()
      .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
      .toString()
      .padStart(
        2,
        "0",
      )}${ms % 1000 ? `.${(ms % 1000).toString().padStart(3, "0")}` : ""}`;
  return `${time(match.startMs)}–${time(match.endMs)}`;
}

/** Keep one navigable hit per Asset; a source time is more useful than a summary. */
export function preferredAssetEvidence(matches: AssetEvidenceMatch[]) {
  const byAsset = new Map<string, AssetEvidenceMatch>();
  for (const match of matches) {
    const current = byAsset.get(match.projectAssetId);
    if (!current || (current.startMs === undefined && match.startMs !== undefined)) {
      byAsset.set(match.projectAssetId, match);
    }
  }
  return byAsset;
}
