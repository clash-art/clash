/**
 * Cross-origin Remotion preview frame (#435).
 *
 * Hosts `@remotion/player` + `VideoComposition` and speaks
 * `clash.preview-host.v1`. The Player stays the time authority — this page
 * never invents a clock. Separate from `render-frame.html` (export encode
 * budget); do not share one host instance between scrubbing preview and
 * export.
 */
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player, type PlayerRef } from "@remotion/player";
import { VideoComposition } from "@clash/remotion-components";
import type { Track } from "@clash/remotion-core";
import {
  PREVIEW_HOST_PROTOCOL,
  isPreviewHostCommand,
  type PreviewCompositionDescriptor,
  type PreviewHostEvent,
  type PreviewTransportEvent,
} from "@clash/remotion-ui/preview-host";

type MountedScene = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  tracks: Track[];
  allNodes?: Map<string, any>;
  parentOrigin: string;
};

function toNodesMap(raw: unknown): Map<string, any> | undefined {
  if (!raw) return undefined;
  if (raw instanceof Map) return raw as Map<string, any>;
  if (typeof raw === "object") {
    return new Map(Object.entries(raw as Record<string, unknown>));
  }
  return undefined;
}

function post(event: PreviewHostEvent, targetOrigin: string) {
  window.parent.postMessage(event, targetOrigin);
}

function PreviewFrameApp() {
  const playerRef = useRef<PlayerRef>(null);
  const [scene, setScene] = useState<MountedScene | null>(null);
  const parentOriginRef = useRef<string | null>(null);
  const lastEmittedFrameRef = useRef<number | null>(null);

  const reportTransport = (event: PreviewTransportEvent) => {
    const origin = parentOriginRef.current;
    if (!origin) return;
    post(
      { protocol: PREVIEW_HOST_PROTOCOL, type: "transport", event },
      origin,
    );
  };

  const reportFrame = (frame: number) => {
    const origin = parentOriginRef.current;
    if (!origin) return;
    if (frame === lastEmittedFrameRef.current) return;
    lastEmittedFrameRef.current = frame;
    post({ protocol: PREVIEW_HOST_PROTOCOL, type: "frame", frame }, origin);
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isPreviewHostCommand(event.data)) return;
      const command = event.data;
      if (command.type === "mount") {
        // Narrow via runtime guard; cast fields so stale package types still compile.
        const mount = command as {
          parentOrigin: string;
          composition: PreviewCompositionDescriptor & {
            tracks?: unknown[];
            allNodes?: unknown;
          };
        };
        parentOriginRef.current = mount.parentOrigin;
        const { composition } = mount;
        const tracks = Array.isArray(composition.tracks)
          ? (composition.tracks as Track[])
          : [];
        setScene({
          width: composition.width,
          height: composition.height,
          fps: composition.fps,
          durationInFrames: composition.durationInFrames,
          tracks,
          allNodes: toNodesMap(composition.allNodes),
          parentOrigin: mount.parentOrigin,
        });
        return;
      }
      if (command.type === "unmount") {
        setScene(null);
        playerRef.current?.pause();
        return;
      }
      const player = playerRef.current;
      if (!player) return;
      if (command.type === "seek") {
        player.seekTo(command.frame);
        reportFrame(Math.round(command.frame));
        return;
      }
      if (command.type === "play") {
        player.play();
        return;
      }
      if (command.type === "pause") {
        player.pause();
      }
    };
    window.addEventListener("message", onMessage);
    // Announce ready to every embedder that can hear us. The host filters by
    // source + origin; posting to "*" only wakes the waiting parent handshake.
    window.parent.postMessage(
      { protocol: PREVIEW_HOST_PROTOCOL, type: "ready" },
      "*",
    );
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !scene) return;

    const onFrame = () => {
      reportFrame(Math.round(player.getCurrentFrame()));
    };
    const onPlay = () => reportTransport({ type: "play" });
    const onPause = () => reportTransport({ type: "pause" });
    const onEnded = () => reportTransport({ type: "ended" });
    const onWaiting = () => reportTransport({ type: "waiting" });
    const onResume = () => reportTransport({ type: "resume" });
    const onError = (event: { detail: { error: Error } }) => {
      reportTransport({
        type: "error",
        message: event.detail.error?.message || "Preview player error",
      });
    };

    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("ended", onEnded);
    player.addEventListener("waiting", onWaiting);
    player.addEventListener("resume", onResume);
    player.addEventListener("error", onError);
    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      player.removeEventListener("ended", onEnded);
      player.removeEventListener("waiting", onWaiting);
      player.removeEventListener("resume", onResume);
      player.removeEventListener("error", onError);
    };
  }, [scene]);

  const inputProps = useMemo(
    () => ({
      tracks: scene?.tracks ?? [],
      allNodes: scene?.allNodes,
    }),
    [scene],
  );

  if (!scene) {
    return (
      <div
        data-preview-frame="idle"
        style={{
          width: "100%",
          height: "100%",
          display: "grid",
          placeItems: "center",
          color: "#888",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Clash preview frame ready
      </div>
    );
  }

  return (
    <Player
      ref={playerRef}
      component={VideoComposition}
      compositionWidth={scene.width}
      compositionHeight={scene.height}
      durationInFrames={Math.max(1, Math.round(scene.durationInFrames))}
      fps={scene.fps}
      inputProps={inputProps}
      style={{ width: "100%", height: "100%" }}
      controls={false}
      loop={false}
      numberOfSharedAudioTags={0}
    />
  );
}

const root = document.getElementById("preview-frame-root");
if (!root) {
  throw new Error("preview-frame needs #preview-frame-root");
}
createRoot(root).render(
  <StrictMode>
    <PreviewFrameApp />
  </StrictMode>,
);
