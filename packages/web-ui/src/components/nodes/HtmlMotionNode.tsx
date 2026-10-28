import { memo, useCallback, useEffect, useState } from "react";
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Code } from "@phosphor-icons/react";
import { HtmlSceneSurface } from "@clash/remotion-components";

import {
  useMgPreviewOpenRequest,
  useOptionalMgPreview,
} from "../MgPreviewContext";
import { calculateScaledDimensions } from "./assetNodeSizing";

/**
 * Default HTML MG document. Production preview must host this in a sandboxed
 * cross-site iframe (allow-scripts, no allow-same-origin) — see
 * docs/spikes/mg-html-canvas-node-436.md and Hilo interactive hosting notes.
 * Open uses shared MgOpenSurface (Hilo-style stage+inspector); no audio-master-clock.
 */
export const DEFAULT_HTML_MOTION_SOURCE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>HTML Motion</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: #171717;
        color: #f5f5f5;
        font-family: Inter, system-ui, sans-serif;
        display: grid;
        place-items: center;
        overflow: hidden;
      }
      h1 {
        margin: 0;
        font-size: 48px;
        font-weight: 600;
        transform: translate(0px, 0px);
        cursor: grab;
        user-select: none;
      }
    </style>
  </head>
  <body>
    <h1
      data-mg-id="title"
      data-mg-editable="text,position"
      data-mg-x="0"
      data-mg-y="0"
    >Edit this HTML Motion document</h1>
  </body>
</html>
`;

const HTML_MOTION_HEADER_HEIGHT = 44;

export function calculateHtmlMotionNodeDimensions(
  compositionWidth: number,
  compositionHeight: number,
) {
  const preview = calculateScaledDimensions(
    compositionWidth,
    compositionHeight,
  );
  return {
    width: preview.width,
    height: preview.height + HTML_MOTION_HEADER_HEIGHT,
    preview,
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : fallback;
}

function documentValue(data: Record<string, unknown>, id: string) {
  return {
    label: typeof data.label === "string" ? data.label : "HTML Motion",
    documentId:
      typeof data.documentId === "string" && data.documentId.trim()
        ? data.documentId.trim()
        : id,
    source:
      typeof data.content === "string" && data.content.trim()
        ? data.content
        : DEFAULT_HTML_MOTION_SOURCE,
    width: positiveInteger(data.compositionWidth, 1920),
    height: positiveInteger(data.compositionHeight, 1080),
    fps: positiveInteger(data.fps, 30),
    durationInFrames: positiveInteger(data.durationInFrames, 120),
  };
}

/** Miniaturized in-node paint — frame 0 only, pointer-events none (drag surface). */
function HtmlMotionInNodePreview({
  source,
  label,
  sourceNodeId,
  width,
  height,
  fps,
  durationInFrames,
  previewWidth,
  previewHeight,
}: {
  source: string;
  label: string;
  sourceNodeId: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  previewWidth: number;
  previewHeight: number;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [source]);

  return (
    <div
      data-testid="html-motion-preview"
      className="pointer-events-none relative shrink-0 select-none overflow-hidden bg-neutral-900"
      style={{ width: previewWidth, height: previewHeight }}
    >
      {failed ? (
        <div className="flex h-full w-full items-center justify-center px-3 text-center text-xs text-neutral-400">
          HTML Motion
          <br />
          {width}×{height} · {fps}fps
        </div>
      ) : (
        <HtmlSceneSurface
          source={source}
          frame={0}
          fps={fps}
          durationInFrames={durationInFrames}
          title={label}
          sourceNodeId={sourceNodeId}
          className="h-full w-full"
          style={{ width: "100%", height: "100%", border: 0 }}
          onCapacityError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

const HtmlMotionNode = ({
  data,
  selected,
  id,
  width,
  height,
}: NodeProps<Node<Record<string, unknown>>>) => {
  const mg = useOptionalMgPreview();
  const persisted = documentValue(data, id);
  const dimensions = calculateHtmlMotionNodeDimensions(
    persisted.width,
    persisted.height,
  );

  const openPreview = useCallback(() => {
    mg?.openMgPreview({
      nodeId: id,
      kind: "html-motion",
      label: persisted.label,
      source: persisted.source,
      width: persisted.width,
      height: persisted.height,
      fps: persisted.fps,
      durationInFrames: persisted.durationInFrames,
      documentId: persisted.documentId,
    });
  }, [
    id,
    mg,
    persisted.documentId,
    persisted.durationInFrames,
    persisted.fps,
    persisted.height,
    persisted.label,
    persisted.source,
    persisted.width,
  ]);
  useMgPreviewOpenRequest(id, openPreview);

  return (
    <div
      data-testid="html-motion-node"
      className={`relative overflow-hidden rounded-xl border bg-neutral-950 text-neutral-100 shadow-lg ${
        selected ? "border-cyan-400" : "border-neutral-700"
      }`}
      style={{
        width: width ?? dimensions.width,
        height: height ?? dimensions.height,
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        openPreview();
      }}
    >
      <div className="flex h-11 items-center gap-2 border-b border-neutral-800 px-3">
        <Code size={16} className="shrink-0 text-cyan-300" />
        <span className="truncate text-sm font-medium">{persisted.label}</span>
      </div>
      <HtmlMotionInNodePreview
        source={persisted.source}
        label={persisted.label}
        sourceNodeId={id}
        width={persisted.width}
        height={persisted.height}
        fps={persisted.fps}
        durationInFrames={persisted.durationInFrames}
        previewWidth={dimensions.preview.width}
        previewHeight={dimensions.preview.height}
      />
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
    </div>
  );
};

export default memo(HtmlMotionNode);
