import { memo } from "react";
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Code } from "@phosphor-icons/react";

import { calculateScaledDimensions } from "./assetNodeSizing";

/**
 * Default HTML MG document. Production preview must host this in a sandboxed
 * cross-site iframe (allow-scripts, no allow-same-origin) — see
 * docs/spikes/mg-html-canvas-node-436.md and Hilo interactive hosting notes.
 * This Canvas node stores the document only; it does not introduce a clock.
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
      }
      h1 { font-size: 48px; font-weight: 600; margin: 0; }
    </style>
  </head>
  <body>
    <h1>Edit this HTML Motion document</h1>
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

const HtmlMotionNode = ({
  data,
  selected,
  id,
  width,
  height,
}: NodeProps<Node<Record<string, unknown>>>) => {
  const persisted = documentValue(data, id);
  const dimensions = calculateHtmlMotionNodeDimensions(
    persisted.width,
    persisted.height,
  );

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
    >
      <div className="flex h-11 items-center gap-2 border-b border-neutral-800 px-3">
        <Code size={16} className="shrink-0 text-cyan-300" />
        <span className="truncate text-sm font-medium">{persisted.label}</span>
      </div>
      <div
        data-testid="html-motion-preview"
        className="flex items-center justify-center bg-neutral-900 text-center text-xs text-neutral-400"
        style={{
          width: dimensions.preview.width,
          height: dimensions.preview.height,
        }}
      >
        HTML Motion source
        <br />
        {persisted.width}×{persisted.height} · {persisted.fps}fps ·{" "}
        {persisted.durationInFrames}f
        <br />
        <span className="text-neutral-500">
          Live iframe preview ships with the isolation host
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
    </div>
  );
};

export default memo(HtmlMotionNode);
