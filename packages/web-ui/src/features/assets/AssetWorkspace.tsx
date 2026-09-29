import { useCallback, useEffect, useMemo, useState } from "react";
import type { LoroDoc } from "loro-crdt";
import { readMediaAssetGeneration } from "@clash/shared-types";
import type {
  ActionAssetBinding,
  ProjectCanvas,
  ProjectTimeline,
  ResolvedAsset,
} from "@clash/shared-types";
import { useAsset } from "../../lib/hooks/useAsset";
import type { EditApplyResult } from "./action-client";
import { ImageEditorPanel } from "../../components/ImageEditorContext";
import { VideoClipperPanel } from "../../components/VideoClipperContext";
import {
  ProjectAssetSurface,
  type ProjectAssetEditMetadata,
} from "../../components/ProjectWorkspaceSurfaces";
import { AssetRelationsPanel } from "./AssetRelationsPanel";
import { mergeResolvedAssetProjection } from "./projectAssetPresentation";
import { useAssetEvidence } from "./useAssetEvidence";
import { AssetEvidencePanel } from "./AssetEvidencePanel";
import {
  buildAssetRelationSummary,
  type AssetRelationEdge,
  type AssetRelationNode,
} from "./relations";

/**
 * Asset feature entry point. Preview and edit are presentation states of the
 * same workspace; edit execution remains an immutable asset action.
 */
export function EditableProjectAssetSurface({
  asset,
  projectId,
  projectAssets = [],
  canvases = [],
  timelines = [],
  relationNodes = [],
  relationEdges = [],
  relationBindings = [],
  relationDoc,
  onOpenCanvas,
  onOpenTimeline,
  onOpenAsset,
  onApplied,
  headerEndInset = 0,
  startMs,
}: {
  asset: ResolvedAsset;
  projectId: string;
  projectAssets?: ResolvedAsset[];
  canvases?: ProjectCanvas[];
  timelines?: ProjectTimeline[];
  relationNodes?: AssetRelationNode[];
  relationEdges?: AssetRelationEdge[];
  relationBindings?: ActionAssetBinding[];
  relationDoc?: LoroDoc | null;
  onOpenCanvas?: (canvasId: string, nodeId?: string) => void;
  onOpenTimeline?: (timelineId: string) => void;
  onOpenAsset?: (assetId: string) => void;
  onApplied: (result: EditApplyResult) => void | Promise<void>;
  headerEndInset?: number;
  startMs?: number;
}) {
  const sourceAssetId = asset.id;
  const [seekRequest, setSeekRequest] = useState<{ startMs: number } | undefined>(() => startMs === undefined ? undefined : { startMs });
  useEffect(() => { setSeekRequest(startMs === undefined ? undefined : { startMs }); }, [sourceAssetId, startMs]);
  const evidence = useAssetEvidence({ projectId, assetId: sourceAssetId, doc: relationDoc });
  const assetRecord = useAsset(projectId, sourceAssetId);
  const resolvedAsset = assetRecord
    ? mergeResolvedAssetProjection(assetRecord, asset)
    : asset;
  const sourceUrl =
    resolvedAsset.status === "ready" ? resolvedAsset.url?.trim() : undefined;
  const actionRunId = resolvedAsset.provenance?.actionRunId;
  // The Loro document is mutable. Re-read the selected Asset's immutable facts
  // on each project render instead of memoizing by document identity.
  const generation =
    relationDoc && actionRunId
      ? readMediaAssetGeneration(relationDoc, {
          projectAssetId: sourceAssetId,
          actionRunId,
        })
      : null;
  const relations = useMemo(
    () =>
      buildAssetRelationSummary({
        assetId: sourceAssetId,
        asset: resolvedAsset,
        projectAssets,
        canvases,
        timelines,
        nodes: relationNodes,
        edges: relationEdges,
        bindings: relationBindings,
        generation,
      }),
    [
      canvases,
      generation,
      projectAssets,
      relationBindings,
      relationEdges,
      relationNodes,
      resolvedAsset,
      sourceAssetId,
      timelines,
    ],
  );

  const renderEditor = useCallback(
    (metadata: ProjectAssetEditMetadata, close: () => void) => {
      if (!sourceUrl) return null;
      if (resolvedAsset.kind === "image" && "naturalWidth" in metadata) {
        return (
          <ImageEditorPanel
            input={{
              projectId,
              sourceAssetId,
              sourceUrl,
              naturalWidth: metadata.naturalWidth,
              naturalHeight: metadata.naturalHeight,
              initialParams: {},
              origin: "asset-preview",
              onApplied,
            }}
            loroSync={null}
            onClose={close}
          />
        );
      }
      if (resolvedAsset.kind === "video" && "durationSec" in metadata) {
        return (
          <VideoClipperPanel
            input={{
              projectId,
              sourceAssetId,
              sourceUrl,
              durationSec: metadata.durationSec,
              initialParams: undefined,
              origin: "asset-preview",
              onApplied,
            }}
            loroSync={null}
            onClose={close}
          />
        );
      }
      return null;
    },
    [onApplied, projectId, resolvedAsset.kind, sourceAssetId, sourceUrl],
  );

  return (
    <ProjectAssetSurface
      asset={resolvedAsset}
      seekRequest={seekRequest}
      headerEndInset={headerEndInset}
      renderEditor={sourceUrl ? renderEditor : undefined}
      inspector={
        <AssetRelationsPanel
          relations={relations}
          hasEvidence={evidence.matches.length > 0 || evidence.truncated}
          evidence={<AssetEvidencePanel projectId={projectId} {...evidence} assets={projectAssets} onOpenAsset={onOpenAsset} onSeek={resolvedAsset.kind === "video" || resolvedAsset.kind === "audio" ? (time) => setSeekRequest({ startMs: time }) : undefined} />}
          onOpenCanvas={onOpenCanvas}
          onOpenTimeline={onOpenTimeline}
          onOpenAsset={onOpenAsset}
        />
      }
    />
  );
}
