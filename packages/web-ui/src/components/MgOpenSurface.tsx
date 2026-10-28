/**
 * Hilo-homage MG open chrome: full-bleed stage + right inspector strip.
 *
 * Topology mirrors Hilo's MotionNativeSurface (center stage) +
 * MotionGraphicInspector lite + HtmlMotionPreviewControls (trusted transport).
 * Preview-only — no SessionDraft / edit-session / Edit code / Edit HTML (#469).
 * Local playhead only — no audio-master-clock.
 */
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { Code, FilmStrip, X } from "@phosphor-icons/react";
import { Player, type PlayerRef } from "@remotion/player";
import { HtmlSceneSurface, RemotionSourceComposition } from "@clash/remotion-components";

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

function HtmlStage({
  session,
  frame,
}: {
  session: MgOpenSession;
  frame: number;
}) {
  return (
    <div
      data-testid="mg-open-stage-html"
      className="flex h-full min-h-0 w-full items-center justify-center bg-black"
    >
      <div
        className="h-full max-h-full w-full max-w-full overflow-hidden"
        style={{ aspectRatio: `${session.width} / ${session.height}` }}
      >
        <HtmlSceneSurface
          source={session.source}
          frame={frame}
          fps={session.fps}
          durationInFrames={session.durationInFrames}
          title={session.label}
          sourceNodeId={session.nodeId}
          className="h-full w-full"
          style={{ width: "100%", height: "100%", border: 0 }}
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
      className="flex h-full min-h-0 w-full items-center justify-center bg-black"
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

function MgInspector({
  session,
  frame,
  playing,
  onTogglePlay,
  onSeek,
  onClose,
}: {
  session: MgOpenSession;
  frame: number;
  playing: boolean;
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

        <p className="mt-auto text-xs leading-relaxed text-content-muted">
          Preview session — open chrome homage of Hilo MG surface. Edit code /
          Edit HTML are not restored.
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
            <HtmlStage session={session} frame={frame} />
          ) : (
            <RemotionStage
              session={session}
              playerRef={playerRef}
              autoPlay={playing}
            />
          )}
        </div>
        <MgInspector
          session={session}
          frame={frame}
          playing={playing}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onClose={onClose}
        />
      </div>
    </Dialog>
  );
}
