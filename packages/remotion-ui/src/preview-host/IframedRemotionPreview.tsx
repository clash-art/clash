/**
 * Timeline Remotion preview hosted in a PreviewHost iframe.
 *
 * Opt-in via VITE_PREVIEW_HOST_MODE=iframe + VITE_PREVIEW_FRAME_ORIGIN.
 * The Remotion Player inside the frame remains the time authority — this
 * component never invents a clock. Transform overlays / audio meter from
 * InteractiveCanvas are out of scope for this cutover slice.
 */
import React, { useEffect, useMemo, useRef } from "react";
import type { Track } from "@clash/remotion-core";
import type { PlayerTransportEvent } from "../components/playerTransport";
import { createPreviewHost } from "./createPreviewHost";
import { createPostMessageFrameBridge } from "./postMessageFrame";
import type { PreviewCompositionDescriptor } from "./protocol";
import type { PreviewHost } from "./types";

export type IframedRemotionPreviewProps = {
  tracks: Track[];
  allNodesMap?: Map<string, unknown>;
  currentFrame: number;
  compositionWidth: number;
  compositionHeight: number;
  fps: number;
  durationInFrames: number;
  playing?: boolean;
  frameUrl: string;
  frameOrigin: string;
  onFrameUpdate?: (frame: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onTransportEvent?: (event: PlayerTransportEvent) => void;
};

function nodesRecord(
  map: Map<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!map || map.size === 0) return undefined;
  const record: Record<string, unknown> = {};
  for (const [id, value] of map) {
    record[id] = value;
  }
  return record;
}

export const IframedRemotionPreview: React.FC<IframedRemotionPreviewProps> =
  React.memo(function IframedRemotionPreview({
    tracks,
    allNodesMap,
    currentFrame,
    compositionWidth,
    compositionHeight,
    fps,
    durationInFrames,
    playing = false,
    frameUrl,
    frameOrigin,
    onFrameUpdate,
    onPlayingChange,
    onTransportEvent,
  }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const hostRef = useRef<PreviewHost | null>(null);
    const onFrameUpdateRef = useRef(onFrameUpdate);
    onFrameUpdateRef.current = onFrameUpdate;
    const onPlayingChangeRef = useRef(onPlayingChange);
    onPlayingChangeRef.current = onPlayingChange;
    const onTransportEventRef = useRef(onTransportEvent);
    onTransportEventRef.current = onTransportEvent;
    const lastEmittedFrameRef = useRef<number | null>(null);
    const lastPlayingRef = useRef(playing);

    const composition = useMemo<PreviewCompositionDescriptor>(
      () => ({
        width: compositionWidth,
        height: compositionHeight,
        fps,
        durationInFrames,
        tracks,
        allNodes: nodesRecord(allNodesMap),
      }),
      [
        compositionWidth,
        compositionHeight,
        fps,
        durationInFrames,
        tracks,
        allNodesMap,
      ],
    );

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const parentOrigin = window.location.origin;
      const host = createPreviewHost({
        mode: "iframe",
        iframe: {
          parentOrigin,
          createBridge: () =>
            createPostMessageFrameBridge({
              container,
              frameUrl,
              frameOrigin,
              title: "Clash Remotion preview",
              visible: true,
            }),
        },
      });
      hostRef.current = host;
      const unsubscribe = host.subscribe((fact) => {
        if (fact.type === "frame") {
          if (fact.frame === lastEmittedFrameRef.current) return;
          lastEmittedFrameRef.current = fact.frame;
          onFrameUpdateRef.current?.(fact.frame);
          return;
        }
        if (fact.type === "transport") {
          onTransportEventRef.current?.(fact.event);
          if (fact.event.type === "play") {
            onPlayingChangeRef.current?.(true);
          } else if (
            fact.event.type === "pause" ||
            fact.event.type === "ended"
          ) {
            onPlayingChangeRef.current?.(false);
          }
          return;
        }
        if (fact.type === "error") {
          onTransportEventRef.current?.({
            type: "error",
            message: fact.message,
          });
        }
      });
      host.mount(composition);
      return () => {
        unsubscribe();
        host.unmount();
        hostRef.current = null;
      };
      // Mount once per frame URL / origin. Composition updates remount below.
    }, [frameUrl, frameOrigin]);

    useEffect(() => {
      hostRef.current?.mount(composition);
    }, [composition]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      if (playing) {
        if (Math.round(currentFrame) !== lastEmittedFrameRef.current) {
          host.seek(Math.round(currentFrame));
        }
        host.play();
      } else {
        host.pause();
        host.seek(Math.round(currentFrame));
      }
      lastPlayingRef.current = playing;
    }, [playing, currentFrame]);

    return (
      <div
        ref={containerRef}
        data-testid="iframed-remotion-preview"
        data-preview-host-mode="iframe"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          background: "#000",
        }}
      />
    );
  });
