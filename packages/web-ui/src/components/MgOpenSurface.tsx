/**
 * Hilo-homage MG open chrome: full-bleed stage + right inspector strip.
 *
 * Topology mirrors Hilo's MotionNativeSurface (center stage) +
 * MotionGraphicInspector lite + MotionElementInspector (text/x/y) +
 * HtmlMotionPreviewControls (trusted transport) + bottom scrub bar.
 *
 * Preview + HTML element edit lite — no SessionDraft / Edit code / Edit HTML
 * (#469). Local playhead only — no audio-master-clock.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { useReactFlow } from "@xyflow/react";
import { Code, FilmStrip, X } from "@phosphor-icons/react";
import { Player, type PlayerRef } from "@remotion/player";
import { HtmlSceneSurface, RemotionSourceComposition } from "@clash/remotion-components";

import { useOptionalLoroSyncContext } from "./LoroSyncContext";
import {
  applyHtmlMotionElementPatch,
  listHtmlMotionEditableElements,
  type MgEditableElement,
  type MgElementPatch,
} from "../lib/htmlMotionElementEdit";
import { Dialog } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export type MgOpenSession = {
  nodeId: string;
  kind: "remotion-component" | "html-motion";
  label: string;
  source: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  componentId?: string;
  documentId?: string;
};

function durationSeconds(fps: number, durationInFrames: number): string {
  return (durationInFrames / Math.max(1, fps)).toFixed(2);
}

function formatTimecode(frame: number, fps: number): string {
  const safeFps = Math.max(1, fps);
  const totalSec = Math.max(0, frame) / safeFps;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  const f = Math.max(0, frame) % safeFps;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

function StageProgressBar({
  frame,
  durationInFrames,
  fps,
  onSeek,
}: {
  frame: number;
  durationInFrames: number;
  fps: number;
  onSeek: (frame: number) => void;
}) {
  const max = Math.max(0, durationInFrames - 1);
  return (
    <div
      data-testid="mg-open-progress-bar"
      className="flex w-full shrink-0 items-center gap-3 border-t border-white/10 bg-black/80 px-4 py-2"
      aria-label="Preview progress"
    >
      <span
        data-testid="mg-open-progress-timecode"
        className="shrink-0 text-xs tabular-nums text-neutral-300"
      >
        {formatTimecode(frame, fps)}
      </span>
      <input
        data-testid="mg-open-progress-range"
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(frame, max)}
        aria-label="Scrub frame"
        className="h-1.5 w-full flex-1 cursor-pointer accent-cyan-400"
        onChange={(event) => onSeek(Number(event.target.value))}
      />
      <span
        data-testid="mg-open-progress-frame"
        className="shrink-0 text-xs tabular-nums text-neutral-400"
      >
        {frame} / {durationInFrames}f
      </span>
    </div>
  );
}

function HtmlStage({
  session,
  source,
  frame,
  onElementEdit,
  onElementSelect,
}: {
  session: MgOpenSession;
  source: string;
  frame: number;
  onElementEdit: (elementId: string, patch: MgElementPatch) => void;
  onElementSelect: (elementId: string | null) => void;
}) {
  return (
    <div
      data-testid="mg-open-stage-html"
      className="relative flex min-h-0 flex-1 items-center justify-center bg-black"
    >
      <div
        className="h-full max-h-full w-full max-w-full overflow-hidden"
        style={{ aspectRatio: `${session.width} / ${session.height}` }}
      >
        <HtmlSceneSurface
          source={source}
          frame={frame}
          fps={session.fps}
          durationInFrames={session.durationInFrames}
          title={session.label}
          sourceNodeId={session.nodeId}
          className="h-full w-full"
          style={{ width: "100%", height: "100%", border: 0 }}
          elementEdit
          sceneWidth={session.width}
          onElementEdit={(event) =>
            onElementEdit(event.elementId, event.patch)
          }
          onElementSelect={(event) => onElementSelect(event.elementId)}
        />
      </div>
    </div>
  );
}

function RemotionStage({
  session,
  playerRef,
  autoPlay,
}: {
  session: MgOpenSession;
  playerRef: RefObject<PlayerRef | null>;
  autoPlay: boolean;
}) {
  return (
    <div
      data-testid="mg-open-stage-remotion"
      className="flex min-h-0 flex-1 items-center justify-center bg-black"
    >
      <div
        className="h-full max-h-full w-full max-w-full overflow-hidden"
        style={{ aspectRatio: `${session.width} / ${session.height}` }}
      >
        <Player
          ref={playerRef}
          key={`mg-open:${session.componentId ?? session.nodeId}:${session.source}`}
          component={RemotionSourceComposition}
          compositionWidth={session.width}
          compositionHeight={session.height}
          durationInFrames={session.durationInFrames}
          fps={session.fps}
          inputProps={{
            source: session.source,
            componentId: session.componentId ?? session.nodeId,
          }}
          controls={false}
          autoPlay={autoPlay}
          loop
          clickToPlay={false}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
}

function MgElementInspector({
  elements,
  selectedId,
  onSelect,
  onPatch,
}: {
  elements: MgEditableElement[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPatch: (elementId: string, patch: MgElementPatch) => void;
}) {
  const selected =
    elements.find((item) => item.id === selectedId) ?? elements[0] ?? null;

  if (!elements.length) {
    return (
      <div
        data-testid="mg-open-element-inspector-empty"
        className="space-y-1 border-t border-warm-border pt-4"
      >
        <p className="text-xs font-medium text-content-secondary">Elements</p>
        <p className="text-xs leading-relaxed text-content-muted">
          No editable elements. Author{" "}
          <code className="text-[10px]">data-mg-id</code> +{" "}
          <code className="text-[10px]">data-mg-editable=&quot;text,position&quot;</code>{" "}
          on nodes (default create template includes one).
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="mg-open-element-inspector"
      className="space-y-3 border-t border-warm-border pt-4"
      aria-label="Motion element inspector"
    >
      <p className="text-xs font-medium text-content-secondary">Elements</p>
      <ul className="space-y-1" data-testid="mg-open-element-list">
        {elements.map((el) => (
          <li key={el.id}>
            <button
              type="button"
              data-testid={`mg-open-element-${el.id}`}
              aria-pressed={selected?.id === el.id}
              className={`w-full truncate rounded px-2 py-1.5 text-left text-xs ${
                selected?.id === el.id
                  ? "bg-warm-hover text-content-primary"
                  : "text-content-secondary hover:bg-warm-hover/60"
              }`}
              onClick={() => onSelect(el.id)}
            >
              {el.id}
            </button>
          </li>
        ))}
      </ul>

      {selected ? (
        <div className="space-y-3" data-testid="mg-open-element-fields">
          <p className="truncate text-xs text-content-muted">{selected.id}</p>
          {selected.editable.includes("text") ? (
            <label className="block space-y-1 text-xs text-content-secondary">
              <span>Text</span>
              <Input
                data-testid="mg-open-element-text"
                aria-label="Element text"
                value={selected.text}
                maxLength={8192}
                onChange={(event) =>
                  onPatch(selected.id, { text: event.target.value })
                }
              />
            </label>
          ) : null}
          {selected.editable.includes("position") ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1 text-xs text-content-secondary">
                <span>X</span>
                <Input
                  data-testid="mg-open-element-x"
                  aria-label="Element X"
                  type="number"
                  step={1}
                  value={String(Math.round(selected.x * 100) / 100)}
                  onChange={(event) => {
                    const n = Number(event.target.value);
                    if (!Number.isFinite(n)) return;
                    onPatch(selected.id, { x: n });
                  }}
                />
              </label>
              <label className="block space-y-1 text-xs text-content-secondary">
                <span>Y</span>
                <Input
                  data-testid="mg-open-element-y"
                  aria-label="Element Y"
                  type="number"
                  step={1}
                  value={String(Math.round(selected.y * 100) / 100)}
                  onChange={(event) => {
                    const n = Number(event.target.value);
                    if (!Number.isFinite(n)) return;
                    onPatch(selected.id, { y: n });
                  }}
                />
              </label>
            </div>
          ) : null}
          <p className="text-[11px] leading-relaxed text-content-muted">
            Drag on stage to move position; double-click text on stage to edit.
            Changes write back to the Canvas HTML document.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function MgInspector({
  session,
  frame,
  playing,
  elements,
  selectedElementId,
  onSelectElement,
  onElementPatch,
  onTogglePlay,
  onSeek,
  onClose,
}: {
  session: MgOpenSession;
  frame: number;
  playing: boolean;
  elements: MgEditableElement[];
  selectedElementId: string | null;
  onSelectElement: (id: string) => void;
  onElementPatch: (elementId: string, patch: MgElementPatch) => void;
  onTogglePlay: () => void;
  onSeek: (frame: number) => void;
  onClose: () => void;
}) {
  const [frameDraft, setFrameDraft] = useState(String(frame));
  useEffect(() => {
    setFrameDraft(String(frame));
  }, [frame]);

  const submitSeek = (event: FormEvent) => {
    event.preventDefault();
    const next = Number(frameDraft);
    if (!Number.isFinite(next)) return;
    const clamped = Math.max(
      0,
      Math.min(session.durationInFrames - 1, Math.round(next)),
    );
    onSeek(clamped);
  };

  const KindIcon = session.kind === "html-motion" ? Code : FilmStrip;

  return (
    <aside
      data-testid="mg-open-inspector"
      aria-label="Motion graphic inspector"
      className="flex h-full w-[300px] shrink-0 flex-col border-l border-warm-border bg-warm-surface"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-warm-border px-3">
        <KindIcon className="h-4 w-4 shrink-0 text-brand" weight="duotone" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-content-primary">
          {session.label}
        </h2>
        <IconButton
          label={
            session.kind === "html-motion"
              ? "Close HTML Motion preview"
              : "Close Remotion preview"
          }
          onClick={onClose}
          icon={<X className="h-5 w-5" weight="bold" />}
          size="sm"
          shape="circle"
          className="text-content-secondary hover:bg-warm-hover hover:text-content-primary"
        />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="space-y-1">
          <p className="text-xs font-medium text-content-secondary">Name</p>
          <p
            data-testid="mg-open-inspector-name"
            className="truncate text-sm text-content-primary"
          >
            {session.label}
          </p>
        </div>

        <p
          data-testid="mg-open-inspector-meta"
          className="text-xs tabular-nums text-content-muted"
        >
          {session.width} × {session.height} · {session.fps} fps ·{" "}
          {durationSeconds(session.fps, session.durationInFrames)} s
        </p>

        <div
          data-testid="mg-open-transport"
          className="space-y-3 border-t border-warm-border pt-4"
          aria-label="Preview transport"
        >
          <p className="text-xs font-medium text-content-secondary">Transport</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="mg-open-play-pause"
              onClick={onTogglePlay}
            >
              {playing ? "Pause" : "Play"}
            </Button>
            <span
              data-testid="mg-open-frame-readout"
              className="text-xs tabular-nums text-content-muted"
            >
              {frame} / {session.durationInFrames}f
            </span>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={submitSeek}
            data-testid="mg-open-seek-form"
          >
            <Input
              aria-label="Frame"
              data-testid="mg-open-frame-input"
              className="h-8 w-24"
              type="number"
              min={0}
              max={Math.max(0, session.durationInFrames - 1)}
              value={frameDraft}
              onChange={(event) => setFrameDraft(event.target.value)}
            />
            <Button type="submit" variant="default" size="sm">
              Seek
            </Button>
          </form>
        </div>

        {session.kind === "html-motion" ? (
          <MgElementInspector
            elements={elements}
            selectedId={selectedElementId}
            onSelect={onSelectElement}
            onPatch={onElementPatch}
          />
        ) : (
          <p
            data-testid="mg-open-remotion-element-note"
            className="border-t border-warm-border pt-4 text-xs leading-relaxed text-content-muted"
          >
            Element text/position edit applies to HTML Motion (
            <code className="text-[10px]">data-mg-*</code>). Remotion open keeps
            stage scrub + transport only in this phase.
          </p>
        )}

        <p className="mt-auto text-xs leading-relaxed text-content-muted">
          Preview + HTML element edit lite — Hilo surface homage. Edit code /
          Edit HTML dialogs are not restored. No audio-master-clock.
        </p>
      </div>
    </aside>
  );
}

export function MgOpenSurface({
  session,
  onClose,
}: {
  session: MgOpenSession;
  onClose: () => void;
}) {
  const playerRef = useRef<PlayerRef>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [source, setSource] = useState(session.source);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(
    null,
  );
  const loroSync = useOptionalLoroSyncContext();
  const reactFlow = useReactFlow();

  useEffect(() => {
    setSource(session.source);
    setSelectedElementId(null);
    setFrame(0);
    setPlaying(true);
  }, [session.nodeId, session.source, session.kind]);

  const elements = useMemo(
    () =>
      session.kind === "html-motion"
        ? listHtmlMotionEditableElements(source)
        : [],
    [session.kind, source],
  );

  useEffect(() => {
    if (!elements.length) {
      setSelectedElementId(null);
      return;
    }
    if (
      selectedElementId &&
      elements.some((item) => item.id === selectedElementId)
    ) {
      return;
    }
    setSelectedElementId(elements[0]!.id);
  }, [elements, selectedElementId]);

  const persistSource = useCallback(
    (nextSource: string) => {
      setSource(nextSource);
      const nodeId = session.nodeId;
      try {
        reactFlow.setNodes((nodes) =>
          nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    content: nextSource,
                  },
                }
              : node,
          ),
        );
      } catch {
        // Outside ReactFlow in unit tests — persistence via loro still attempted.
      }
      loroSync?.updateNode?.(nodeId, {
        data: { content: nextSource },
      });
    },
    [loroSync, reactFlow, session.nodeId],
  );

  const applyElementPatch = useCallback(
    (elementId: string, patch: MgElementPatch) => {
      try {
        const next = applyHtmlMotionElementPatch(source, elementId, patch);
        persistSource(next);
      } catch {
        // Invalid patch — keep previous source.
      }
    },
    [persistSource, source],
  );

  // HTML: local interval playhead (not audio-master-clock).
  useEffect(() => {
    if (session.kind !== "html-motion" || !playing) return;
    const intervalMs = Math.max(1, Math.round(1000 / session.fps));
    const timer = window.setInterval(() => {
      setFrame((current) => (current + 1) % Math.max(1, session.durationInFrames));
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [playing, session.durationInFrames, session.fps, session.kind]);

  // Remotion: sync frame + playing from PlayerRef events.
  useEffect(() => {
    if (session.kind !== "remotion-component") return;
    const player = playerRef.current;
    if (!player) return;

    const onFrame = (event: { detail: { frame: number } }) => {
      setFrame(event.detail.frame);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    setPlaying(player.isPlaying());
    setFrame(player.getCurrentFrame());
    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
    };
  }, [session.kind, session.nodeId, session.source]);

  const togglePlay = () => {
    if (session.kind === "html-motion") {
      setPlaying((value) => !value);
      return;
    }
    const player = playerRef.current;
    if (!player) return;
    if (player.isPlaying()) player.pause();
    else player.play();
  };

  const seek = (next: number) => {
    const clamped = Math.max(
      0,
      Math.min(session.durationInFrames - 1, Math.round(next)),
    );
    if (session.kind === "html-motion") {
      setFrame(clamped);
      return;
    }
    playerRef.current?.seekTo(clamped);
    setFrame(clamped);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      ariaLabel={`Motion graphic: ${session.label}`}
      size="auto"
      hideCloseButton
      unstyled
      disableBackdropClose
      overlayClassName="z-[9999] bg-black/85 backdrop-blur-none"
      containerClassName="z-[9999] !inset-0 !p-0 flex items-stretch justify-stretch"
      contentClassName="!max-w-none !w-screen !h-screen !rounded-none !border-0 !shadow-none !p-0 overflow-hidden bg-neutral-950"
    >
      <div
        data-testid="mg-open-surface"
        data-mg-kind={session.kind}
        className="flex h-full min-h-0 w-full"
      >
        <div
          data-testid={
            session.kind === "html-motion"
              ? "html-motion-fullscreen-preview"
              : "remotion-component-fullscreen-preview"
          }
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {session.kind === "html-motion" ? (
            <HtmlStage
              session={session}
              source={source}
              frame={frame}
              onElementEdit={applyElementPatch}
              onElementSelect={setSelectedElementId}
            />
          ) : (
            <RemotionStage
              session={session}
              playerRef={playerRef}
              autoPlay={playing}
            />
          )}
          <StageProgressBar
            frame={frame}
            durationInFrames={session.durationInFrames}
            fps={session.fps}
            onSeek={seek}
          />
        </div>
        <MgInspector
          session={session}
          frame={frame}
          playing={playing}
          elements={elements}
          selectedElementId={selectedElementId}
          onSelectElement={setSelectedElementId}
          onElementPatch={applyElementPatch}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onClose={onClose}
        />
      </div>
    </Dialog>
  );
}
