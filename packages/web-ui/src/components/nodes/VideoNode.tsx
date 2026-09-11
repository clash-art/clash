import { memo, useEffect, useMemo, useState } from "react";
/* eslint-disable @next/next/no-img-element */
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import SourceHandleMenu from "./SourceHandleMenu";
import DraftPlaceholder from "./DraftPlaceholder";
import { Eye, FilmSlate, TextT } from "@phosphor-icons/react";
import { useMediaViewer } from "../MediaViewerContext";
import { useOptionalLoroSyncContext } from "../LoroSyncContext";
import {
  normalizeStatus,
  isActiveStatus,
  type AssetStatus,
} from "@clash/web-ui/lib/assetStatus";
import { useAsset } from "@clash/web-ui/lib/hooks/useAsset";
import { useProject } from "../ProjectContext";
import { VideoPoster } from "../../features/assets/VideoPoster";
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

const VideoNode = ({
  data,
  selected,
  id,
  width,
  height,
}: NodeProps<Node<Record<string, any>>>) => {
  const [label, setLabel] = useState(data.label || "Video Node");
  const { projectId } = useProject();
  const { openAssetPreview, openViewer } = useMediaViewer();
  const { setNodes } = useReactFlow();
  const loroSync = useOptionalLoroSyncContext();
  const [status, setStatus] = useState<AssetStatus>(
    normalizeStatus(data.status) || (data.assetId ? "completed" : "generating"),
  );
  const nodeAssetId = data.assetId as string | undefined;
  const asset = useAsset(projectId, nodeAssetId);
  const videoUrl = asset?.url;
  const [description, setDescription] = useState(data.description || "");
  const pendingAwaitingConnection =
    data.status === "pending" && loroSync?.connected === false;
  const posterUrl = asset?.thumbnailUrl;

  const aspectRatioDimensions = calculateDimensionsFromAspectRatio(
    data.aspectRatio,
  );
  const measuredWidth = width;
  const measuredHeight = height;

  // Size = measuredSize (Loro) OR aspectRatio placeholder. See ImageNode /
  // assetNodeSizing.ts — asset.metadata only drives the reconciliation
  // effect below, never direct render-path sizing.
  const currentSize = useMemo(
    () =>
      resolveInitialMediaSize({
        measuredWidth,
        measuredHeight,
        aspectRatioDimensions,
      }),
    [measuredWidth, measuredHeight, aspectRatioDimensions],
  );

  const nodeWidth = currentSize.width;
  const nodeHeight = currentSize.height;

  // Sync mutable presentation state from Loro data changes. Media itself is
  // always projected from the stable Project Asset id above.
  useEffect(() => {
    setStatus((prev: AssetStatus) => {
      const next = normalizeStatus(data.status);
      return next !== prev ? next : prev;
    });
    setDescription((prev: string) =>
      (data.description || "") !== prev ? data.description || "" : prev,
    );
  }, [data.status, data.description]);

  // Reconciliation — same pattern as ImageNode. asset.metadata is the
  // authoritative size; every time it's available compare against Loro's
  // measuredSize and repair any drift. Idempotent across clients.
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

  // Loro sync handles state updates - no polling needed

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (videoUrl && asset?.status === "ready" && status === "completed") {
      openViewer("video", videoUrl, label);
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
      </div>

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
          <DraftPlaceholder nodeId={id} modality="video" />
        ) : asset?.status === "ready" && videoUrl ? (
          // Same as ImageNode: prefer the resolved asset over a stale
          // `status:'failed'` state (asset row + R2 blob are intact).
          <div className="relative" style={{ width: "100%", height: "100%" }}>
            <VideoPoster
              thumbnailSrc={posterUrl}
              videoSrc={videoUrl}
              status={asset.status}
              alt={`${label} thumbnail`}
              className="block h-full w-full object-contain pointer-events-none"
              fallback={
                <div className="absolute inset-0 flex items-center justify-center bg-black/25 backdrop-blur-[2px]">
                  <div className="relative z-10 flex flex-col items-center gap-2">
                    <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white" />
                    <span className="text-xs font-medium text-white animate-pulse">
                      Preparing preview...
                    </span>
                  </div>
                </div>
              }
            />

            {/* Top Right Controls */}
            <div className="absolute top-2 right-2 flex gap-1 z-10">
              {nodeAssetId && openAssetPreview ? (
                <Tooltip label="Preview asset">
                  <IconButton
                    label="Preview asset"
                    icon={<Eye size={14} weight="bold" />}
                    size="sm"
                    shape="circle"
                    className={MEDIA_NODE_CONTROL_CLASS}
                    onClick={(event) => {
                      event.stopPropagation();
                      openAssetPreview(nodeAssetId);
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
              <div className="rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white backdrop-blur-sm">
                Video
              </div>
            </div>

            {/* Play overlay hint */}
            <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 bg-black/10 pointer-events-none">
              <div className="rounded-full bg-white/20 p-2 backdrop-blur-sm">
                <FilmSlate size={24} className="text-white" weight="fill" />
              </div>
            </div>
          </div>
        ) : status === "uploading" && data.previewUrl ? (
          <div className="relative" style={{ width: "100%", height: "100%" }}>
            <video
              src={data.previewUrl as string}
              controls={false}
              className="block h-full w-full pointer-events-none object-contain opacity-70"
              preload="metadata"
              muted
              playsInline
            />
            {/* Loading Overlay */}
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 backdrop-blur-[2px]">
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
              <AssetGenerationPreview kind="video" />
            )}
          </div>
        ) : status === "failed" ? (
          <div
            className="flex items-center justify-center bg-red-50 text-red-400"
            style={{ width: "100%", height: "100%" }}
          >
            <div className="flex flex-col items-center gap-2">
              <FilmSlate size={32} weight="duotone" />
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
              <FilmSlate size={32} />
              <span className="text-xs">No Video</span>
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
      <SourceHandleMenu nodeId={id} sourceType="video" />
    </div>
  );
};

export default memo(VideoNode);
