import { memo, useCallback, useEffect } from "react";
import {
  Handle,
  Position,
  useReactFlow,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { FilmStrip } from "@phosphor-icons/react";
import { Player } from "@remotion/player";
import { RemotionSourceComposition } from "@clash/remotion-components";

import { useOptionalLoroSyncContext } from "../LoroSyncContext";
import {
  normalizeElementOverrides,
  resolveRemotionMgComponentProps,
  type MgElementOverrides,
} from "../../lib/remotionElementEdit";
import {
  useMgPreviewOpenRequest,
  useOptionalMgPreview,
} from "../MgPreviewContext";
import { calculateScaledDimensions } from "./assetNodeSizing";

export const DEFAULT_REMOTION_COMPONENT_SOURCE = `import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

type MgOverrides = Record<string, { text?: string; x?: number; y?: number }>;

export default function Component(props: { mgElementOverrides?: MgOverrides }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: "clamp",
  });
  const title = props.mgElementOverrides?.title;
  const text = title?.text ?? "Edit this Remotion component";
  const x = title?.x ?? 0;
  const y = title?.y ?? 0;
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#171717",
        color: "white",
        fontFamily: "Inter, sans-serif",
        fontSize: 72,
        opacity,
      }}
    >
      <div
        data-mg-id="title"
        data-mg-editable="text,position"
        data-mg-default-text="Edit this Remotion component"
        data-mg-default-x={0}
        data-mg-default-y={0}
        data-mg-x={x}
        data-mg-y={y}
        style={{
          transform: \`translate(\${x}px, \${y}px)\`,
          cursor: "grab",
          userSelect: "none",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
}
`;

const REMOTION_COMPONENT_HEADER_HEIGHT = 44;

export function calculateRemotionComponentNodeDimensions(
  compositionWidth: number,
  compositionHeight: number,
) {
  const preview = calculateScaledDimensions(
    compositionWidth,
    compositionHeight,
  );
  return {
    width: preview.width,
    height: preview.height + REMOTION_COMPONENT_HEADER_HEIGHT,
    preview,
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : fallback;
}

function componentValue(data: Record<string, unknown>, id: string) {
  const elementOverrides: MgElementOverrides = normalizeElementOverrides(
    data.elementOverrides,
  );
  return {
    label: typeof data.label === "string" ? data.label : "Remotion Component",
    componentId:
      typeof data.componentId === "string" && data.componentId.trim()
        ? data.componentId.trim()
        : id,
    source:
      typeof data.content === "string" && data.content.trim()
        ? data.content
        : DEFAULT_REMOTION_COMPONENT_SOURCE,
    elementOverrides,
    componentProps: resolveRemotionMgComponentProps(data),
    width: positiveInteger(data.compositionWidth, 720),
    height: positiveInteger(data.compositionHeight, 1280),
    fps: positiveInteger(data.fps, 30),
    durationInFrames: positiveInteger(data.durationInFrames, 120),
  };
}

const RemotionComponentNode = ({
  data,
  selected,
  id,
  width,
  height,
}: NodeProps<Node<Record<string, unknown>>>) => {
  const loroSync = useOptionalLoroSyncContext();
  const mg = useOptionalMgPreview();
  const { getNode, setNodes } = useReactFlow();
  const persisted = componentValue(data, id);
  const nodeDimensions = calculateRemotionComponentNodeDimensions(
    persisted.width,
    persisted.height,
  );
  const previewSize = nodeDimensions.preview;

  const openPreview = useCallback(() => {
    mg?.openMgPreview({
      nodeId: id,
      kind: "remotion-component",
      label: persisted.label,
      source: persisted.source,
      elementOverrides: persisted.elementOverrides,
      width: persisted.width,
      height: persisted.height,
      fps: persisted.fps,
      durationInFrames: persisted.durationInFrames,
      componentId: persisted.componentId,
    });
  }, [
    id,
    mg,
    persisted.componentId,
    persisted.durationInFrames,
    persisted.elementOverrides,
    persisted.fps,
    persisted.height,
    persisted.label,
    persisted.source,
    persisted.width,
  ]);
  useMgPreviewOpenRequest(id, openPreview);

  useEffect(() => {
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      (width === nodeDimensions.width && height === nodeDimensions.height)
    ) {
      return;
    }
    const style = {
      ...(getNode(id)?.style ?? {}),
      width: nodeDimensions.width,
      height: nodeDimensions.height,
    };
    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? {
              ...node,
              width: nodeDimensions.width,
              height: nodeDimensions.height,
              style,
            }
          : node,
      ),
    );
    loroSync?.updateNode(id, {
      width: nodeDimensions.width,
      height: nodeDimensions.height,
      style,
    });
  }, [
    getNode,
    height,
    id,
    loroSync,
    nodeDimensions.height,
    nodeDimensions.width,
    setNodes,
    width,
  ]);

  const player = (
    <Player
      key={`${persisted.componentId}:${persisted.source}`}
      component={RemotionSourceComposition}
      compositionWidth={persisted.width}
      compositionHeight={persisted.height}
      durationInFrames={persisted.durationInFrames}
      fps={persisted.fps}
      inputProps={{
        source: persisted.source,
        componentId: persisted.componentId,
        componentProps: persisted.componentProps,
      }}
      controls={false}
      loop
      style={{ width: "100%", height: "100%" }}
    />
  );

  return (
    <div
      data-testid="remotion-component-node"
      className="group relative"
      style={{ width: previewSize.width }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        openPreview();
      }}
    >
      <article
        className={`flex flex-col overflow-hidden rounded-matrix bg-warm-surface shadow-lg ring-1 ring-warm-border ${
          selected ? "ring-4 ring-brand ring-offset-2" : ""
        }`}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-warm-border px-3">
          <FilmStrip className="h-4 w-4 text-brand" weight="duotone" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-content-primary">
            {persisted.label}
          </span>
        </header>
        <div
          data-testid="remotion-component-preview"
          className="pointer-events-none shrink-0 select-none bg-black"
          style={{ width: previewSize.width, height: previewSize.height }}
        >
          {player}
        </div>
      </article>
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        className="!h-4 !w-4 !translate-x-2 !border-4 !border-warm-surface !bg-content-muted shadow-sm transition-all hover:scale-125 hover:!bg-brand"
      />
    </div>
  );
};

export default memo(RemotionComponentNode);
