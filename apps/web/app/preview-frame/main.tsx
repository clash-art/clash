/**
 * Cross-origin preview frame (#435 / #447).
 *
 * Speaks `clash.preview-host.v1`. Modes:
 * - Remotion (+ optional HTML MG layers via VideoComposition): `@remotion/player`
 *   remains the time authority for Remotion items.
 * - HTML-only Timeline: `html-scene` PreviewFrameProducer paints sandboxed
 *   HTML MG documents without mounting Remotion Player.
 *
 * Never invents an audio-master-clock. Separate from `render-frame.html`
 * (export encode budget); do not share one host instance between scrubbing
 * preview and export.
 */
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player, type PlayerRef } from "@remotion/player";
import { VideoComposition } from "@clash/remotion-components";
import type { Track } from "@clash/remotion-core";
import {
  PREVIEW_HOST_PROTOCOL,
  compositionIsHtmlOnly,
  createHtmlSceneProducer,
  isPreviewHostCommand,
  type PreviewCompositionDescriptor,
  type PreviewFrameProducer,
  type PreviewHostEvent,
  type PreviewTransportEvent,
} from "@clash/remotion-ui/preview-host";

function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

type CapturableMediaElement = HTMLMediaElement & {
  captureStream?: () => MediaStream;
};

type MediaAnalysisGraph = {
  source: MediaStreamAudioSourceNode;
  stream: MediaStream;
  splitter: ChannelSplitterNode;
  leftAnalyser: AnalyserNode;
  rightAnalyser: AnalyserNode;
  leftSamples: Float32Array<ArrayBuffer>;
  rightSamples: Float32Array<ArrayBuffer>;
};

type MountedScene = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  tracks: Track[];
  allNodes?: Map<string, any>;
  parentOrigin: string;
  htmlOnly: boolean;
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
  const rootRef = useRef<HTMLDivElement>(null);
  const htmlMountRef = useRef<HTMLDivElement>(null);
  const htmlProducerRef = useRef<PreviewFrameProducer | null>(null);
  const [scene, setScene] = useState<MountedScene | null>(null);
  const [audioMeterEnabled, setAudioMeterEnabled] = useState(false);
  const parentOriginRef = useRef<string | null>(null);
  const lastEmittedFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSilentOutputRef = useRef<GainNode | null>(null);
  const audioAnalysisGraphsRef = useRef<Map<HTMLMediaElement, MediaAnalysisGraph>>(
    new Map(),
  );
  const previousAudioLevelsRef = useRef({ left: 0, right: 0 });

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

  const reportAudioLevels = (left: number, right: number) => {
    const origin = parentOriginRef.current;
    if (!origin) return;
    post(
      { protocol: PREVIEW_HOST_PROTOCOL, type: "audio-levels", left, right },
      origin,
    );
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isPreviewHostCommand(event.data)) return;
      const command = event.data;
      if (command.type === "mount") {
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
        const descriptor: PreviewCompositionDescriptor = {
          width: composition.width,
          height: composition.height,
          fps: composition.fps,
          durationInFrames: composition.durationInFrames,
          tracks,
          allNodes: composition.allNodes,
        };
        setScene({
          width: composition.width,
          height: composition.height,
          fps: composition.fps,
          durationInFrames: composition.durationInFrames,
          tracks,
          allNodes: toNodesMap(composition.allNodes),
          parentOrigin: mount.parentOrigin,
          htmlOnly: compositionIsHtmlOnly(descriptor),
        });
        return;
      }
      if (command.type === "unmount") {
        setScene(null);
        setAudioMeterEnabled(false);
        playerRef.current?.pause();
        htmlProducerRef.current?.pause();
        return;
      }
      if (command.type === "set-audio-meter") {
        setAudioMeterEnabled(command.enabled);
        return;
      }

      const htmlProducer = htmlProducerRef.current;
      if (htmlProducer && scene?.htmlOnly) {
        if (command.type === "seek") {
          void htmlProducer.seek(command.frame);
          return;
        }
        if (command.type === "play") {
          void htmlProducer.play();
          return;
        }
        if (command.type === "pause") {
          void htmlProducer.pause();
          return;
        }
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
    window.parent.postMessage(
      { protocol: PREVIEW_HOST_PROTOCOL, type: "ready" },
      "*",
    );
    return () => window.removeEventListener("message", onMessage);
  }, [scene?.htmlOnly]);

  // HTML-only producer mount
  useEffect(() => {
    if (!scene?.htmlOnly || !htmlMountRef.current) {
      htmlProducerRef.current?.dispose();
      htmlProducerRef.current = null;
      return;
    }
    const producer = createHtmlSceneProducer({
      mountElement: htmlMountRef.current,
      reporter: {
        reportFrame,
        reportTransport,
        reportError: (message) =>
          reportTransport({ type: "error", message }),
      },
    });
    htmlProducerRef.current = producer;
    const descriptor: PreviewCompositionDescriptor = {
      width: scene.width,
      height: scene.height,
      fps: scene.fps,
      durationInFrames: scene.durationInFrames,
      tracks: scene.tracks,
      allNodes: scene.allNodes
        ? Object.fromEntries(scene.allNodes.entries())
        : undefined,
    };
    void producer.prepare(descriptor);
    return () => {
      void producer.dispose();
      if (htmlProducerRef.current === producer) {
        htmlProducerRef.current = null;
      }
    };
  }, [scene]);

  useEffect(() => {
    if (scene?.htmlOnly) return;
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

  useEffect(() => {
    if (!audioMeterEnabled) {
      for (const graph of audioAnalysisGraphsRef.current.values()) {
        graph.source.disconnect();
        graph.splitter.disconnect();
        graph.leftAnalyser.disconnect();
        graph.rightAnalyser.disconnect();
        graph.stream.getTracks().forEach((track) => track.stop());
      }
      audioAnalysisGraphsRef.current.clear();
      previousAudioLevelsRef.current = { left: 0, right: 0 };
      reportAudioLevels(0, 0);
      return;
    }

    const AudioContextConstructor = window.AudioContext;
    if (
      !AudioContextConstructor ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      reportAudioLevels(0, 0);
      return;
    }

    if (!audioContextRef.current) {
      const context = new AudioContextConstructor();
      const silentOutput = context.createGain();
      silentOutput.gain.value = 0;
      silentOutput.connect(context.destination);
      audioContextRef.current = context;
      audioSilentOutputRef.current = silentOutput;
    }

    const context = audioContextRef.current;
    const silentOutput = audioSilentOutputRef.current;
    if (!context || !silentOutput) return;
    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }

    let raf: number | null = null;

    const connectVisibleMedia = () => {
      const container = rootRef.current;
      if (!container) return;
      const visibleMedia = new Set(
        Array.from(container.querySelectorAll<HTMLMediaElement>("audio, video")),
      );
      for (const [element, graph] of audioAnalysisGraphsRef.current) {
        if (visibleMedia.has(element)) continue;
        graph.source.disconnect();
        graph.splitter.disconnect();
        graph.leftAnalyser.disconnect();
        graph.rightAnalyser.disconnect();
        graph.stream.getTracks().forEach((track) => track.stop());
        audioAnalysisGraphsRef.current.delete(element);
      }
      for (const element of visibleMedia) {
        if (audioAnalysisGraphsRef.current.has(element)) continue;
        const captureStream = (element as CapturableMediaElement).captureStream;
        if (typeof captureStream !== "function") continue;
        try {
          const stream = captureStream.call(element);
          if (stream.getAudioTracks().length === 0) {
            stream.getTracks().forEach((track) => track.stop());
            continue;
          }
          const source = context.createMediaStreamSource(stream);
          const splitter = context.createChannelSplitter(2);
          const leftAnalyser = context.createAnalyser();
          const rightAnalyser = context.createAnalyser();
          leftAnalyser.fftSize = 256;
          rightAnalyser.fftSize = 256;
          source.connect(splitter);
          splitter.connect(leftAnalyser, 0);
          splitter.connect(rightAnalyser, 1);
          leftAnalyser.connect(silentOutput);
          rightAnalyser.connect(silentOutput);
          audioAnalysisGraphsRef.current.set(element, {
            source,
            stream,
            splitter,
            leftAnalyser,
            rightAnalyser,
            leftSamples: new Float32Array(leftAnalyser.fftSize),
            rightSamples: new Float32Array(rightAnalyser.fftSize),
          });
        } catch {
          // Media may exist before its audio track is ready.
        }
      }
    };

    const sample = () => {
      connectVisibleMedia();
      let leftSquared = 0;
      let rightSquared = 0;
      for (const [element, graph] of audioAnalysisGraphsRef.current) {
        graph.leftAnalyser.getFloatTimeDomainData(graph.leftSamples);
        graph.rightAnalyser.getFloatTimeDomainData(graph.rightSamples);
        const outputGain = element.muted ? 0 : element.volume;
        const left = calculateRms(graph.leftSamples) * outputGain;
        let right = calculateRms(graph.rightSamples) * outputGain;
        if (right < 0.0001 && left >= 0.0001) right = left;
        leftSquared += left * left;
        rightSquared += right * right;
      }
      const raw = {
        left: Math.min(1, Math.sqrt(leftSquared)),
        right: Math.min(1, Math.sqrt(rightSquared)),
      };
      const previous = previousAudioLevelsRef.current;
      const next = {
        left:
          raw.left >= previous.left
            ? raw.left
            : previous.left * 0.82 + raw.left * 0.18,
        right:
          raw.right >= previous.right
            ? raw.right
            : previous.right * 0.82 + raw.right * 0.18,
      };
      previousAudioLevelsRef.current = next;
      reportAudioLevels(next.left, next.right);
      raf = window.requestAnimationFrame(sample);
    };

    raf = window.requestAnimationFrame(sample);
    return () => {
      if (raf !== null) window.cancelAnimationFrame(raf);
      for (const graph of audioAnalysisGraphsRef.current.values()) {
        graph.source.disconnect();
        graph.splitter.disconnect();
        graph.leftAnalyser.disconnect();
        graph.rightAnalyser.disconnect();
        graph.stream.getTracks().forEach((track) => track.stop());
      }
      audioAnalysisGraphsRef.current.clear();
    };
  }, [audioMeterEnabled, scene]);

  const inputProps = useMemo(
    () => ({
      tracks: scene?.tracks ?? [],
      allNodes: scene?.allNodes,
    }),
    [scene],
  );

  if (scene?.htmlOnly) {
    return (
      <div
        ref={htmlMountRef}
        data-preview-frame="html-scene"
        data-html-scene-producer=""
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          background: "#000",
        }}
      />
    );
  }

  return (
    <div
      ref={rootRef}
      data-preview-frame={scene ? "mounted" : "idle"}
      data-audio-meter={audioMeterEnabled ? "on" : "off"}
      style={{ width: "100%", height: "100%" }}
    >
      {!scene ? (
        <div
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
      ) : (
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
      )}
    </div>
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
