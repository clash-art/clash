import { memo, useCallback, useEffect, useState } from "react";
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Code, X } from "@phosphor-icons/react";
import { HtmlSceneSurface } from "@clash/remotion-components";

import { useMgPreviewOpenRequest } from "../MgPreviewContext";
import { IconButton } from "../ui/icon-button";
import { calculateScaledDimensions } from "./assetNodeSizing";
import { NodeModalDialog } from "./NodeModalDialog";

/**
 * Default HTML MG document. Production preview must host this in a sandboxed
 * cross-site iframe (allow-scripts, no allow-same-origin) — see
 * docs/spikes/mg-html-canvas-node-436.md and Hilo interactive hosting notes.
 * Fullscreen open uses HtmlSceneSurface (Hilo-style sandbox); no audio-master-clock.
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

function HtmlMotionFullscreenPreview({
  label,
  source,
  fps,
  durationInFrames,
  width,
  height,
  sourceNodeId,
  onClose,
}: {
  label: string;
  source: string;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  sourceNodeId: string;
  onClose: () => void;
}) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const intervalMs = Math.max(1, Math.round(1000 / fps));
    const timer = window.setInterval(() => {
      setFrame((current) => (current + 1) % Math.max(1, durationInFrames));
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [durationInFrames, fps, playing]);

  return (
    <div
      data-testid="html-motion-fullscreen-preview"
      className="flex h-full min-h-0 flex-col"
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-warm-border px-4">
        <Code className="h-4 w-4 shrink-0 text-cyan-500" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-content-primary">
          {label}
        </h2>
        <span className="shrink-0 text-xs tabular-nums text-content-muted">
          {width}×{height} · {fps}fps · {frame}/{durationInFrames}f
        </span>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs font-medium text-content-secondary hover:bg-warm-hover hover:text-content-primary"
          onClick={() => setPlaying((value) => !value)}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <IconButton
          label="Close HTML Motion preview"
          onClick={onClose}
          icon={<X className="h-5 w-5" weight="bold" />}
          size="sm"
          shape="circle"
          className="text-content-secondary hover:bg-warm-hover hover:text-content-primary"
        />
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4">
        <div
          className="h-full max-h-full w-full max-w-full overflow-hidden rounded-lg"
          style={{ aspectRatio: `${width} / ${height}` }}
        >
          <HtmlSceneSurface
            source={source}
            frame={frame}
            fps={fps}
            durationInFrames={durationInFrames}
            title={label}
            sourceNodeId={sourceNodeId}
            className="h-full w-full"
            style={{ width: "100%", height: "100%", border: 0 }}
          />
        </div>
      </div>
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
  const [previewOpen, setPreviewOpen] = useState(false);
  const persisted = documentValue(data, id);
  const dimensions = calculateHtmlMotionNodeDimensions(
    persisted.width,
    persisted.height,
  );

  const openPreview = useCallback(() => setPreviewOpen(true), []);
  const closePreview = useCallback(() => setPreviewOpen(false), []);
  useMgPreviewOpenRequest(id, openPreview);

  return (
    <>
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
          <span className="text-neutral-500">Double-click for fullscreen preview</span>
        </div>
        <Handle type="source" position={Position.Right} />
        <Handle type="target" position={Position.Left} />
      </div>

      <NodeModalDialog
        open={previewOpen}
        onClose={closePreview}
        ariaLabel={`Preview ${persisted.label}`}
        overlayClassName="bg-black/70"
        contentClassName="max-h-[95vh] max-w-[95vw] h-[92vh] w-[95vw] rounded-2xl border-warm-border/60 bg-warm-surface p-0"
      >
        {previewOpen ? (
          <HtmlMotionFullscreenPreview
            label={persisted.label}
            source={persisted.source}
            fps={persisted.fps}
            durationInFrames={persisted.durationInFrames}
            width={persisted.width}
            height={persisted.height}
            sourceNodeId={id}
            onClose={closePreview}
          />
        ) : null}
      </NodeModalDialog>
    </>
  );
};

export default memo(HtmlMotionNode);
