import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import SourceHandleMenu from "./SourceHandleMenu";
import DraftPlaceholder from "./DraftPlaceholder";
import { Eye, Image as ImageIcon, TextT } from "@phosphor-icons/react";
import { useMediaViewer } from "../MediaViewerContext";
import { useOptionalLoroSyncContext } from "../LoroSyncContext";
import { usePeersSelectingNode } from "../PresenceAwarenessContext";
import PeerSelectionRing from "../PeerSelectionRing";
import AttributionLine from "./AttributionLine";
import {
  normalizeStatus,
  isActiveStatus,
  type AssetStatus,
} from "@clash/web-ui/lib/assetStatus";
import { ProjectedImage } from "../ProjectedMedia";
import { useAsset } from "@clash/web-ui/lib/hooks/useAsset";
import { useProject } from "../ProjectContext";
import {
  calculateDimensionsFromAspectRatio,
  calculateScaledDimensions,
  resolveInitialMediaSize,
} from "./assetNodeSizing";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
import { IconButton } from "../ui/icon-button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Tooltip } from "../ui/tooltip";
import { PendingAssetConnectionHint } from "./PendingAssetConnectionHint";
import { AssetGenerationPreview } from "./AssetGenerationPreview";

const MEDIA_NODE_CONTROL_CLASS =
  "nodrag nopan bg-black/50 text-white backdrop-blur-sm hover:bg-black/70 focus-visible:ring-white/80 focus-visible:ring-offset-black/20";

const ImageNode = ({
  data,
  selected,
  id,
  width,
  height,
}: NodeProps<Node<Record<string, any>>>) => {
  const [label, setLabel] = useState(data.label || "Image Node");
  const { projectId } = useProject();
  const { openAssetPreview, openViewer } = useMediaViewer();
  const { setNodes } = useReactFlow();
  const loroSync = useOptionalLoroSyncContext();
  // Peers (other connected users) who currently have THIS node selected.
  // Empty array reference is stable when no peer is selecting us, so the
  // memoised PeerSelectionRing renders nothing without extra reconciles.
  const peersSelecting = usePeersSelectingNode(id);
  const [status, setStatus] = useState<AssetStatus>(
    normalizeStatus(data.status) || (data.assetId ? "completed" : "generating"),
  );
  const asset = useAsset(projectId, data.assetId);
  const imageUrl = asset?.url;
  const [description, setDescription] = useState(data.description || "");
  const pendingAwaitingConnection =
    data.status === "pending" && loroSync?.connected === false;

  const legacyCustomAspectRatio = (() => {
    if (typeof data.aspectRatio === "string") return undefined;
    const value = data.customActionParams?.aspect_ratio;
    if (typeof value !== "string") return undefined;
    const match = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(value);
    if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0)
      return undefined;
    return `${Number(match[1])}:${Number(match[2])}`;
  })();
  const effectiveAspectRatio = data.aspectRatio ?? legacyCustomAspectRatio;
  const aspectRatioDimensions = useMemo(
    () => calculateDimensionsFromAspectRatio(effectiveAspectRatio),
    [effectiveAspectRatio],
  );
  const measuredWidth = width;
  const measuredHeight = height;

  // Size = measuredSize (Loro) OR aspectRatio placeholder. See
  // assetNodeSizing.ts — the previous four-layer precedence (preview +
  // natural + measured + aspectRatio) collapsed into two because the only
  // size that matters is what's in Loro; `asset.metadata` is only used
  // below by the reconciliation effect to repair drift.
  const currentSize = useMemo(
    () =>
      resolveInitialMediaSize({
        measuredWidth: legacyCustomAspectRatio ? undefined : measuredWidth,
        measuredHeight: legacyCustomAspectRatio ? undefined : measuredHeight,
        aspectRatioDimensions,
      }),
    [
      legacyCustomAspectRatio,
      measuredWidth,
      measuredHeight,
      aspectRatioDimensions,
    ],
  );

  const nodeWidth = currentSize.width;
  const nodeHeight = currentSize.height;

  // Sync state with props when they change (resolved via assetId when present).
  useEffect(() => {
    setStatus((prev: AssetStatus) => {
      const next = normalizeStatus(data.status);
      return next !== prev ? next : prev;
    });
    setDescription((prev: string) =>
      data.description && data.description !== prev ? data.description : prev,
    );
  }, [data.status, data.description]);

  // Loro sync handles state updates - no polling needed

  // Older custom-action outputs persisted their provider parameters but
  // omitted the derived aspectRatio, so layout stored the 400×400 fallback.
  // Repair that legacy projection once; new nodes receive aspectRatio before
  // insertion and skip this path entirely.
  useEffect(() => {
    if (!legacyCustomAspectRatio) return;
    const target = aspectRatioDimensions;
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id !== id) return node;
        return {
          ...node,
          width: target.width,
          height: target.height,
          style: {
            ...node.style,
            width: target.width,
            height: target.height,
          },
          data: {
            ...node.data,
            aspectRatio: legacyCustomAspectRatio,
          },
        };
      }),
    );
    loroSync?.updateNode(id, {
      width: target.width,
      height: target.height,
      data: { aspectRatio: legacyCustomAspectRatio },
    });
  }, [aspectRatioDimensions, id, legacyCustomAspectRatio, loroSync, setNodes]);

  // Reconciliation effect: whenever asset.metadata is available, compare
  // it to Loro's measuredSize. If they disagree — either first write
  // (measuredSize absent) or drift (Loro isn't atomically consistent
  // across the {width, height, data.assetId} triple, so partial writes
  // can leave the node in a mismatched state) — repair to the asset-
  // authoritative value. Idempotent: if multiple clients reconcile at
  // once they all write the same target value, Loro CRDT converges.
  useEffect(() => {
    const assetW = asset?.metadata?.width;
    const assetH = asset?.metadata?.height;
    if (!assetW || !assetH) return;
    const target = calculateScaledDimensions(assetW, assetH);
    const mw = Number(measuredWidth);
    const mh = Number(measuredHeight);
    if (mw === target.width && mh === target.height) return;
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id !== id) return node;
        return {
          ...node,
          width: target.width,
          height: target.height,
          style: {
            ...node.style,
            width: target.width,
            height: target.height,
          },
        };
      }),
    );
    if (loroSync) {
      loroSync.updateNode(id, { width: target.width, height: target.height });
    }
  }, [
    asset?.metadata?.width,
    asset?.metadata?.height,
    measuredWidth,
    measuredHeight,
    id,
    setNodes,
    loroSync,
  ]);

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (imageUrl && status === "completed") {
      openViewer("image", imageUrl, label);
    }
  };

  return (
    <div className="group relative">
      {/* Floating Title Input */}
      <div
        className="absolute -top-8 left-4 z-10"
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Input
          className="bg-transparent text-lg font-bold font-display text-slate-700 dark:text-slate-300 focus:text-slate-900 focus:outline-none"
          value={label}
          onChange={(evt) => {
            const newLabel = evt.target.value;
            setLabel(newLabel);
            setNodes((nds) =>
              nds.map((node) => {
                if (node.id === id) {
                  return {
                    ...node,
                    data: {
                      ...node.data,
                      label: newLabel,
                    },
                  };
                }
                return node;
              }),
            );
          }}
        />
        {/* Phase 0 attribution chip — shown only when actor info is
                    populated. Legacy nodes (pre-rollout) render nothing. */}
        <AttributionLine
          actorType={data.actorType as "user" | "agent" | undefined}
          actorUserId={data.actorUserId as string | undefined}
          actorAgentId={data.actorAgentId as string | undefined}
        />
      </div>

      {/* Peer selection rings — drawn behind the card so the local
                blue ring (inset on the card itself) reads cleanly on top. */}
      <PeerSelectionRing peers={peersSelecting} />

      {/* Main Card */}
      <Collapsible
        className={`group/description relative bg-warm-surface shadow-md rounded-matrix overflow-hidden transition-all duration-300 hover:shadow-lg ${
          selected
            ? "ring-4 ring-brand ring-offset-2"
            : "ring-1 ring-warm-border"
        }`}
        style={{
          width: nodeWidth,
          height: nodeHeight,
          minWidth: 240,
          minHeight: 180,
        }}
        onDoubleClick={handleDoubleClick}
      >
        {status === "draft" ? (
          <DraftPlaceholder nodeId={id} modality="image" />
        ) : imageUrl ? (
          // Show the resolved asset whenever it's available — even when
          // Loro still says `status:'failed'`. Stale-failed states leak
          // in when D1 schema migrations lag behind code (e.g. TaskPolling
          // sees a SELECT exception and writes failed). The asset row +
          // R2 blob are intact; rendering them is correct.
          <div className="relative">
            <ProjectedImage
              src={imageUrl}
              alt={label}
              className="block"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
              }}
            />
            {/* Top Right Controls */}
            <div className="absolute top-2 right-2 flex gap-1 z-10">
              {typeof data.assetId === "string" &&
              data.assetId &&
              openAssetPreview ? (
                <Tooltip label="Preview asset">
                  <IconButton
                    label="Preview asset"
                    icon={<Eye size={14} weight="bold" />}
                    size="sm"
                    shape="circle"
                    className={MEDIA_NODE_CONTROL_CLASS}
                    onClick={(event) => {
                      event.stopPropagation();
                      openAssetPreview(data.assetId);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  />
                </Tooltip>
              ) : null}
              <Tooltip label="Toggle description">
                <CollapsibleTrigger asChild>
                  <IconButton
                    label="Toggle description"
                    icon={<TextT size={12} weight="bold" />}
                    size="sm"
                    shape="circle"
                    className={`${MEDIA_NODE_CONTROL_CLASS} group-data-[state=open]/description:bg-black/80`}
                  />
                </CollapsibleTrigger>
              </Tooltip>
            </div>
          </div>
        ) : status === "uploading" && data.previewUrl ? (
          <div className="relative" style={{ width: "100%", height: "100%" }}>
            <ProjectedImage
              src={data.previewUrl as string}
              alt={label}
              className="block"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                filter: "blur(6px)",
                transform: "scale(1.03)",
              }}
            />
            <div className="absolute inset-0 bg-black/25" />
            <div className="absolute inset-0 flex items-center justify-center backdrop-blur-[2px]">
              <div className="flex flex-col items-center gap-2">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white" />
                <span className="text-xs font-medium text-white animate-pulse">
                  Uploading...
                </span>
              </div>
            </div>
          </div>
        ) : isActiveStatus(status) ? (
          <div
            className="flex items-center justify-center bg-warm-muted text-slate-700 dark:text-slate-300"
            style={{ width: "100%", height: "100%" }}
          >
            {pendingAwaitingConnection ? (
              <PendingAssetConnectionHint />
            ) : (
              <AssetGenerationPreview kind="image" />
            )}
          </div>
        ) : status === "failed" ? (
          <div
            className="flex items-center justify-center bg-red-50 text-red-400"
            style={{ width: "100%", height: "100%" }}
          >
            <div className="flex flex-col items-center gap-2">
              <ImageIcon size={32} weight="duotone" />
              <span className="text-xs font-medium">Generation Failed</span>
              {typeof data.error === "string" && data.error && (
                <p className="nodrag nowheel max-h-32 overflow-auto break-words px-4 text-center text-xs text-red-700 select-text">
                  {data.error}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div
            className="flex items-center justify-center bg-warm-muted text-slate-700 dark:text-slate-300"
            style={{ width: "100%", height: "100%" }}
          >
            <div className="flex flex-col items-center gap-2">
              <ImageIcon size={32} />
              <span className="text-xs">No Image</span>
            </div>
          </div>
        )}

        {/* Description Box */}
        <CollapsibleContent
          className="absolute left-0 right-0 bottom-0 z-20 border-t border-warm-border bg-warm-surface/95 p-3 backdrop-blur"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Textarea
            className="w-full h-24 resize-none bg-transparent text-xs text-slate-700 dark:text-slate-300 focus:outline-none"
            value={
              description ||
              (status === "completed"
                ? "Generating description..."
                : "No description available.")
            }
            readOnly
          />
        </CollapsibleContent>
      </Collapsible>

      {/* Asset nodes only have output (source) */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={{ top: "50%", left: "-8px" }}
        className="!h-4 !w-4 !border-4 !border-warm-surface !bg-stone-400 transition-all hover:!bg-brand hover:scale-125 shadow-sm !opacity-0 !pointer-events-none"
      />
      <SourceHandleMenu nodeId={id} sourceType="image" />
    </div>
  );
};

export default memo(ImageNode);
