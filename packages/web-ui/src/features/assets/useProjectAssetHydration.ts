import { createLogger } from "../../lib/logger";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Node } from "@xyflow/react";
import type { LoroDoc } from "loro-crdt";
import type { ResolvedAsset } from "@clash/shared-types";
import { watchAssetProjection } from "../../lib/hooks/useAsset";
import { mergeResolvedAssetProjection } from "./projectAssetPresentation";

const assetLog = createLogger("assets");

type AssetPublisher = Dispatch<SetStateAction<ResolvedAsset[]>>;
type ProjectionWatch = {
  stop: () => void;
  settled: boolean;
  fallback: ResolvedAsset | undefined;
  publish: AssetPublisher;
};

export function useProjectAssetHydration({
  doc,
  nodes,
  projectId,
  projectAssets,
  onAssetsChange,
}: {
  doc: LoroDoc | null;
  nodes: readonly Pick<Node, "data">[];
  projectId: string;
  projectAssets: readonly ResolvedAsset[];
  onAssetsChange: AssetPublisher;
}) {
  const watches = useRef(new Map<string, ProjectionWatch>());
  // Geometry and other targets must not reset a running poll's deadline. Its
  // lifetime belongs to its Project/document and the target Asset membership.
  useEffect(
    () => () => {
      for (const watch of watches.current.values()) watch.stop();
      watches.current.clear();
    },
    [doc, projectId],
  );

  useEffect(() => {
    const targets = new Map<string, ResolvedAsset | undefined>();
    const projectAssetIds = new Set(projectAssets.map((asset) => asset.id));
    for (const asset of projectAssets) {
      if (asset.status !== "ready" || !asset.url) targets.set(asset.id, asset);
    }
    for (const node of nodes) {
      const assetId = node.data?.assetId;
      if (
        node.data?.status === "completed" &&
        typeof assetId === "string" &&
        assetId &&
        !targets.has(assetId) &&
        !projectAssetIds.has(assetId)
      ) {
        targets.set(assetId, undefined);
      }
    }
    if (doc) {
      for (const [, raw] of doc.getMap("nodes").entries()) {
        if (!raw || typeof raw !== "object") continue;
        const data = (raw as { data?: Record<string, unknown> }).data;
        if (
          data?.status === "completed" &&
          typeof data.assetId === "string" &&
          !targets.has(data.assetId) &&
          !projectAssetIds.has(data.assetId)
        ) {
          targets.set(data.assetId, undefined);
        }
      }
    }
    for (const [assetId, watch] of watches.current) {
      if (targets.has(assetId)) continue;
      watch.stop();
      watches.current.delete(assetId);
    }
    for (const [assetId, fallback] of targets) {
      const current = watches.current.get(assetId);
      if (current && !current.settled) {
        current.fallback = fallback;
        current.publish = onAssetsChange;
        continue;
      }
      // Retain the existing retry-on-input-change behavior after a stopped or
      // failed read; an actively polling projection is the only reused work.
      current?.stop();
      const watch: ProjectionWatch = {
        stop: () => {},
        settled: false,
        fallback,
        publish: onAssetsChange,
      };
      watches.current.set(assetId, watch);
      watch.stop = watchAssetProjection({
        projectId,
        assetId,
        onProjection(asset) {
          if (watches.current.get(assetId) !== watch) return;
          watch.settled =
            asset.lifecycle.state !== "active" ||
            asset.status === "ready" ||
            asset.status === "failed";
          if (
            asset.kind !== "image" &&
            asset.kind !== "video" &&
            asset.kind !== "audio"
          )
            return;
          const projection = mergeResolvedAssetProjection(
            asset,
            watch.fallback,
          );
          if (JSON.stringify(projection) === JSON.stringify(watch.fallback))
            return;
          watch.publish((current) => {
            const existing = current.find(
              (candidate) => candidate.id === projection.id,
            );
            return JSON.stringify(existing) === JSON.stringify(projection)
              ? current
              : [
                  projection,
                  ...current.filter(
                    (candidate) => candidate.id !== projection.id,
                  ),
                ];
          });
        },
        onError(error) {
          watch.settled = true;
          assetLog.warn("asset.hydration_failed", {
            projectId,
            assetId,
            error,
          });
        },
      });
    }
  }, [doc, nodes, projectId, projectAssets, onAssetsChange]);
}
