/** Canonical interactive composition preview. */
import React, { useRef, useEffect, useState, useCallback } from "react";
import { Player, PlayerRef } from "@remotion/player";
import { VideoComposition } from "@clash/remotion-components";
import {
  applyCanvasTransformEdit,
  getItemLookupIds,
  resolveCanvasTransformProperties,
  type Track,
  type Item,
  type ItemProperties,
} from "@clash/remotion-core";
import {
  getPlaybackSyncAction,
  getTimelineEndDisplayFrame,
} from "./playbackSync";
import { useDragGesture } from "./ui/gesture";
import { colors, shadows } from "./timeline/styles";
import {
  calculateMinimapViewport,
  panFromMinimapPoint,
  shouldShowCanvasMinimap,
} from "./canvas/minimap";
import { calculateRms, type StereoAudioLevels } from "./previewAudioMeter";

export type CanvasViewportCommand =
  | { id: number; type: "reset" }
  | { id: number; type: "set-zoom"; zoom: number };

interface InteractiveCanvasProps {
  tracks: Track[];
  allNodesMap?: Map<string, any>; // Map of node ID -> node data for resolving assetId references
  selectedItemId: string | null;
  currentFrame: number;
  compositionWidth: number;
  compositionHeight: number;
  fps: number;
  durationInFrames: number;
  onUpdateItem: (
    trackId: string,
    itemId: string,
    updates: Partial<Item>,
  ) => void;
  onSelectItem?: (itemId: string | null) => void;
  playing?: boolean;
  onSeek?: (frame: number) => void;
  onFrameUpdate?: (frame: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  viewportCommand?: CanvasViewportCommand;
  onViewportZoomChange?: (zoom: number) => void;
  audioMeterEnabled?: boolean;
  onAudioLevelsChange?: (levels: StereoAudioLevels) => void;
  onTransformStart?: () => void;
  onTransformEnd?: () => void;
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

type DragMode =
  "move" | "rotate" | "scale-tl" | "scale-tr" | "scale-bl" | "scale-br" | null;

interface DragState {
  mode: DragMode;
  startX: number;
  startY: number;
  startProperties: ItemProperties;
  item: Item;
  trackId: string;
}

type CanvasTransformMode = Exclude<DragMode, null>;

const CANVAS_TRANSFORMABLE_ITEM_TYPES: ReadonlySet<Item["type"]> = new Set([
  "solid",
  "text",
  "video",
  "image",
  "sticker",
  "composition",
  "derived-overlay",
]);

export const isCanvasTransformableItem = (item: {
  type: Item["type"];
}): boolean => CANVAS_TRANSFORMABLE_ITEM_TYPES.has(item.type);

export const InteractiveCanvas: React.FC<InteractiveCanvasProps> = ({
  tracks,
  allNodesMap,
  selectedItemId,
  currentFrame,
  compositionWidth,
  compositionHeight,
  fps,
  durationInFrames,
  onUpdateItem,
  onSelectItem,
  playing = false,
  onSeek: _onSeek,
  onFrameUpdate,
  onPlayingChange,
  viewportCommand,
  onViewportZoomChange,
  audioMeterEnabled = false,
  onAudioLevelsChange,
  onTransformStart,
  onTransformEnd,
}) => {
  const playerRef = useRef<PlayerRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const selectionBoxRef = useRef<HTMLDivElement>(null);
  const itemsDomMapRef = useRef<Map<string, HTMLElement>>(new Map());
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [snapLines, setSnapLines] = useState<{
    centerX?: boolean;
    centerY?: boolean;
    left?: boolean;
    right?: boolean;
    top?: boolean;
    bottom?: boolean;
  } | null>(null);
  const [, forceUpdate] = useState({});
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSilentOutputRef = useRef<GainNode | null>(null);
  const audioAnalysisGraphsRef = useRef<
    Map<HTMLMediaElement, MediaAnalysisGraph>
  >(new Map());
  const audioMeterAnimationFrameRef = useRef<number | null>(null);
  const previousAudioLevelsRef = useRef<StereoAudioLevels>({
    left: 0,
    right: 0,
  });

  const disconnectAudioAnalysisGraphs = useCallback(() => {
    for (const graph of audioAnalysisGraphsRef.current.values()) {
      graph.source.disconnect();
      graph.splitter.disconnect();
      graph.leftAnalyser.disconnect();
      graph.rightAnalyser.disconnect();
      graph.stream.getTracks().forEach((track) => track.stop());
    }
    audioAnalysisGraphsRef.current.clear();
  }, []);

  // --- Helper: Get natural dimensions from item/asset ---
  const getNaturalDimensions = useCallback(
    (item: Item) => {
      let naturalWidth = compositionWidth;
      let naturalHeight = compositionHeight;
      let asset = null;

      if (allNodesMap) {
        for (const lookupId of getItemLookupIds(item)) {
          asset = allNodesMap.get(lookupId);
          if (asset) {
            break;
          }
        }

        // 2. Try by src
        if (!asset && "src" in item) {
          const itemSrc = (item as any).src;
          for (const [_, node] of allNodesMap.entries()) {
            if (node.data?.src === itemSrc) {
              asset = node;
              break;
            }
          }
        }
      }

      if (asset) {
        const assetData = asset.data || {};
        if (assetData.naturalWidth && assetData.naturalHeight) {
          naturalWidth = assetData.naturalWidth;
          naturalHeight = assetData.naturalHeight;
        } else if (
          assetData.aspectRatio &&
          typeof assetData.aspectRatio === "string"
        ) {
          const ar = assetData.aspectRatio;
          if (ar.includes(":")) {
            const [w, h] = ar.split(":").map(Number);
            if (w && h) {
              naturalWidth = 1920;
              naturalHeight = Math.round((1920 * h) / w);
            }
          }
        }
      }
      return { naturalWidth, naturalHeight };
    },
    [allNodesMap, compositionWidth, compositionHeight],
  );

  // --- 核心坐标系统 ---

  // 1. 计算播放器在容器中的基础尺寸和偏移（未缩放/平移前）
  const getBaseMetrics = useCallback(() => {
    if (!containerRef.current) return null;
    const containerRect = containerRef.current.getBoundingClientRect();
    const containerWidth = viewportSize.width || containerRect.width;
    const containerHeight = viewportSize.height || containerRect.height;
    const containerAspect = containerWidth / containerHeight;
    const compositionAspect = compositionWidth / compositionHeight;

    let width, height;
    if (compositionAspect > containerAspect) {
      width = containerWidth;
      height = containerWidth / compositionAspect;
    } else {
      height = containerHeight;
      width = containerHeight * compositionAspect;
    }

    const left = (containerWidth - width) / 2;
    const top = (containerHeight - height) / 2;

    return {
      width,
      height,
      left,
      top,
      scaleX: width / compositionWidth, // 1单位 composition 对应多少屏幕像素
      scaleY: height / compositionHeight,
    };
  }, [
    compositionWidth,
    compositionHeight,
    viewportSize.height,
    viewportSize.width,
  ]);

  // 2. 数据坐标 (0-1) -> 屏幕像素坐标 (相对于 Container)
  const normalizedToScreen = useCallback(
    (x: number, y: number) => {
      const metrics = getBaseMetrics();
      if (!metrics) return { x: 0, y: 0 };

      // 1. 归一化 -> 基础像素
      const basePxX = x * compositionWidth * metrics.scaleX;
      const basePxY = y * compositionHeight * metrics.scaleY;

      // 2. 应用平移 (panOffset 是在 zoom 后的像素偏移吗？看渲染逻辑：translate(panOffset.x / zoom) -> 实际位移是 panOffset.x)
      // 渲染逻辑: scale(zoom) translate(panX/zoom, panY/zoom)
      // 等价于: P_final = zoom * (P_base + pan/zoom) = P_base * zoom + pan
      // 中心点变换公式:
      // P_screen = Center + (P_base - Center) * zoom + pan

      const centerX = metrics.width / 2;
      const centerY = metrics.height / 2;

      const screenX =
        metrics.left + centerX + (basePxX - centerX) * zoom + panOffset.x;
      const screenY =
        metrics.top + centerY + (basePxY - centerY) * zoom + panOffset.y;

      return { x: screenX, y: screenY };
    },
    [getBaseMetrics, zoom, panOffset, compositionWidth, compositionHeight],
  );

  // 3. 屏幕像素坐标 -> 数据坐标 (0-1)
  const screenToNormalized = useCallback(
    (screenX: number, screenY: number) => {
      const metrics = getBaseMetrics();
      if (!containerRef.current || !metrics) return { x: 0, y: 0 };

      const containerRect = containerRef.current.getBoundingClientRect();
      const relX = screenX - containerRect.left;
      const relY = screenY - containerRect.top;

      const centerX = metrics.width / 2;
      const centerY = metrics.height / 2;

      // 逆运算:
      // relX = metrics.left + centerX + (basePxX - centerX) * zoom + panOffset.x
      // (relX - metrics.left - centerX - panOffset.x) / zoom + centerX = basePxX

      const basePxX =
        (relX - metrics.left - centerX - panOffset.x) / zoom + centerX;
      const basePxY =
        (relY - metrics.top - centerY - panOffset.y) / zoom + centerY;

      return {
        x: basePxX / (compositionWidth * metrics.scaleX),
        y: basePxY / (compositionHeight * metrics.scaleY),
      };
    },
    [getBaseMetrics, zoom, panOffset, compositionWidth, compositionHeight],
  );

  // 4. 尺寸标量转换 (0-1 -> Screen Px)
  // const scalarToScreen = useCallback((w: number) => {
  //   const metrics = getBaseMetrics();
  //   if (!metrics) return 0;
  //   return w * compositionWidth * metrics.scaleX * zoom;
  // }, [getBaseMetrics, zoom, compositionWidth]);

  // 找到选中的 item
  const selectedItemData = React.useMemo(() => {
    if (!selectedItemId) return null;
    for (const track of tracks) {
      const item = track.items.find(
        (candidate) => candidate.id === selectedItemId,
      );
      if (item) {
        return { trackId: track.id, item };
      }
    }
    return null;
  }, [tracks, selectedItemId]);

  // 准备 Player 的 inputProps
  const inputProps = React.useMemo(
    () => ({
      tracks,
      allNodes: allNodesMap,
      selectedItemId,
      selectionBoxRef,
      itemsDomMapRef,
    }),
    [tracks, allNodesMap, selectedItemId],
  );

  // 同步播放状态和当前帧
  // 关键修复：避免在暂停时强制 seek 导致的帧重置问题
  const lastPlayingStateRef = useRef<boolean>(playing);
  const lastSyncedFrameRef = useRef<number>(currentFrame);
  const lastEmittedFrameRef = useRef<number>(Math.round(currentFrame));

  useEffect(() => {
    if (!playerRef.current) return;

    const playerFrame = playerRef.current.getCurrentFrame();
    const action = getPlaybackSyncAction({
      wasPlaying: lastPlayingStateRef.current,
      playing,
      currentFrame,
      playerFrame,
      durationInFrames,
    });

    if (action.kind === "pause") {
      playerRef.current.pause();
      if (action.seekTo !== null) {
        playerRef.current.seekTo(action.seekTo);
      }
      lastSyncedFrameRef.current = action.seekTo ?? playerFrame;
    } else if (action.kind === "play") {
      if (action.seekTo !== null) {
        playerRef.current.seekTo(action.seekTo);
      }
      playerRef.current.play();
      const startFrame = action.seekTo ?? playerFrame;
      lastSyncedFrameRef.current = startFrame;
      lastEmittedFrameRef.current = startFrame;
      if (action.notifyFrame !== null) {
        onFrameUpdate?.(action.notifyFrame);
      }
    } else if (action.kind === "seek" && action.seekTo !== null) {
      playerRef.current.seekTo(action.seekTo);
      lastSyncedFrameRef.current = action.seekTo;
    }

    lastPlayingStateRef.current = playing;
  }, [playing, currentFrame, durationInFrames, onFrameUpdate]);

  // 监听 Player 事件
  useEffect(() => {
    const player = playerRef.current as any;
    if (!player) return;

    const handleFrame = () => {
      const frame = Math.round(player.getCurrentFrame());
      if (frame === lastEmittedFrameRef.current) {
        return;
      }
      lastEmittedFrameRef.current = frame;
      if (onFrameUpdate) {
        onFrameUpdate(frame);
      }
    };

    const handlePlay = () => {
      if (onPlayingChange) {
        onPlayingChange(true);
      }
    };

    const handlePause = () => {
      if (onPlayingChange) {
        onPlayingChange(false);
      }
    };

    const handleEnded = () => {
      const endFrame = getTimelineEndDisplayFrame(durationInFrames);
      lastEmittedFrameRef.current = endFrame;
      if (onFrameUpdate) {
        onFrameUpdate(endFrame);
      }
      if (onPlayingChange) {
        onPlayingChange(false);
      }
    };

    player.addEventListener("frameupdate", handleFrame);
    player.addEventListener("play", handlePlay);
    player.addEventListener("pause", handlePause);
    player.addEventListener("ended", handleEnded);

    return () => {
      player.removeEventListener("frameupdate", handleFrame);
      player.removeEventListener("play", handlePlay);
      player.removeEventListener("pause", handlePause);
      player.removeEventListener("ended", handleEnded);
    };
  }, [durationInFrames, onFrameUpdate, onPlayingChange]);

  const lastViewportCommandIdRef = useRef(0);
  useEffect(() => {
    if (
      !viewportCommand ||
      viewportCommand.id === lastViewportCommandIdRef.current
    ) {
      return;
    }
    lastViewportCommandIdRef.current = viewportCommand.id;
    if (viewportCommand.type === "reset") {
      setZoom(1);
      setPanOffset({ x: 0, y: 0 });
    } else {
      setZoom(Math.max(0.1, Math.min(5, viewportCommand.zoom)));
    }
  }, [viewportCommand]);

  useEffect(() => {
    onViewportZoomChange?.(zoom);
  }, [onViewportZoomChange, zoom]);

  useEffect(() => {
    if (!audioMeterEnabled) {
      disconnectAudioAnalysisGraphs();
      previousAudioLevelsRef.current = { left: 0, right: 0 };
      onAudioLevelsChange?.({ left: 0, right: 0 });
      return;
    }

    const AudioContextConstructor = window.AudioContext;
    if (
      !AudioContextConstructor ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      onAudioLevelsChange?.({ left: 0, right: 0 });
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

    const connectVisibleMedia = () => {
      const container = containerRef.current;
      if (!container) return;
      const visibleMedia = new Set([
        ...Array.from(
          container.querySelectorAll<HTMLMediaElement>("audio, video"),
        ),
        ...Array.from(
          document.querySelectorAll<HTMLAudioElement>(
            "audio[data-timeline-audio]",
          ),
        ),
      ]);

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
          // Media may exist before its audio track is ready. Retry next frame.
        }
      }
    };

    const sampleAudioLevels = () => {
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
      onAudioLevelsChange?.(next);
      audioMeterAnimationFrameRef.current =
        window.requestAnimationFrame(sampleAudioLevels);
    };

    audioMeterAnimationFrameRef.current =
      window.requestAnimationFrame(sampleAudioLevels);
    return () => {
      if (audioMeterAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(audioMeterAnimationFrameRef.current);
        audioMeterAnimationFrameRef.current = null;
      }
      disconnectAudioAnalysisGraphs();
      previousAudioLevelsRef.current = { left: 0, right: 0 };
      onAudioLevelsChange?.({ left: 0, right: 0 });
    };
  }, [audioMeterEnabled, disconnectAudioAnalysisGraphs, onAudioLevelsChange]);

  useEffect(
    () => () => {
      disconnectAudioAnalysisGraphs();
      audioSilentOutputRef.current?.disconnect();
      audioSilentOutputRef.current = null;
      const context = audioContextRef.current;
      audioContextRef.current = null;
      if (context && context.state !== "closed") {
        void context.close().catch(() => undefined);
      }
    },
    [disconnectAudioAnalysisGraphs],
  );

  // 处理滚轮缩放
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const delta = Math.exp(-e.deltaY * 0.0015);
    setZoom((previous) => Math.max(0.1, Math.min(5, previous * delta)));
  }, []);

  // 绑定滚轮事件
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [handleWheel]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const syncViewportSize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      setViewportSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    syncViewportSize();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncViewportSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // 监听窗口 resize，强制更新 bounds
  useEffect(() => {
    const handleResize = () => {
      forceUpdate({});
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  // 获取当前 metrics 用于 CSS
  const currentMetrics = getBaseMetrics();

  const canvasViewportWidth = currentMetrics
    ? Math.min(
        currentMetrics.width * zoom,
        viewportSize.width || currentMetrics.width,
      )
    : compositionWidth;
  const canvasViewportHeight = currentMetrics
    ? Math.min(
        currentMetrics.height * zoom,
        viewportSize.height || currentMetrics.height,
      )
    : compositionHeight;
  const minimapViewport = calculateMinimapViewport({
    canvasWidth: currentMetrics?.width ?? compositionWidth,
    canvasHeight: currentMetrics?.height ?? compositionHeight,
    viewportWidth: canvasViewportWidth,
    viewportHeight: canvasViewportHeight,
    zoom,
    panX: panOffset.x,
    panY: panOffset.y,
  });
  const minimapAspectRatio = compositionWidth / compositionHeight;
  const minimapSize =
    minimapAspectRatio >= 132 / 84
      ? { width: 132, height: 132 / minimapAspectRatio }
      : { width: 84 * minimapAspectRatio, height: 84 };

  const panToMinimapPoint = useCallback(
    (clientX: number, clientY: number) => {
      const map = minimapRef.current;
      const metrics = getBaseMetrics();
      if (!map || !metrics) return;
      const rect = map.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setPanOffset(
        panFromMinimapPoint({
          canvasWidth: metrics.width,
          canvasHeight: metrics.height,
          viewportWidth: Math.min(
            metrics.width * zoom,
            viewportSize.width || metrics.width,
          ),
          viewportHeight: Math.min(
            metrics.height * zoom,
            viewportSize.height || metrics.height,
          ),
          zoom,
          pointX: (clientX - rect.left) / rect.width,
          pointY: (clientY - rect.top) / rect.height,
        }),
      );
    },
    [getBaseMetrics, viewportSize.height, viewportSize.width, zoom],
  );

  const minimapGestureBind = useDragGesture<PointerEvent>(
    ({ event }) => {
      event.preventDefault();
      event.stopPropagation();
      panToMinimapPoint(event.clientX, event.clientY);
    },
    {
      preventDefault: true,
      pointer: { capture: true },
      eventOptions: { passive: false },
    },
  );

  const handleMinimapKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 0.15 : 0.05;
      let centerX = minimapViewport.left + minimapViewport.width / 2;
      let centerY = minimapViewport.top + minimapViewport.height / 2;
      if (event.key === "Home") {
        event.preventDefault();
        setZoom(1);
        setPanOffset({ x: 0, y: 0 });
        return;
      }
      if (event.key === "ArrowLeft") centerX -= step;
      else if (event.key === "ArrowRight") centerX += step;
      else if (event.key === "ArrowUp") centerY -= step;
      else if (event.key === "ArrowDown") centerY += step;
      else return;

      event.preventDefault();
      const metrics = getBaseMetrics();
      if (!metrics) return;
      setPanOffset(
        panFromMinimapPoint({
          canvasWidth: metrics.width,
          canvasHeight: metrics.height,
          viewportWidth: Math.min(
            metrics.width * zoom,
            viewportSize.width || metrics.width,
          ),
          viewportHeight: Math.min(
            metrics.height * zoom,
            viewportSize.height || metrics.height,
          ),
          zoom,
          pointX: centerX,
          pointY: centerY,
        }),
      );
    },
    [
      getBaseMetrics,
      minimapViewport,
      viewportSize.height,
      viewportSize.width,
      zoom,
    ],
  );

  // 屏幕坐标转属性空间 (Composition Pixels, Center Relative)
  const screenToPropertySpace = useCallback(
    (screenX: number, screenY: number) => {
      const norm = screenToNormalized(screenX, screenY);
      return {
        x: (norm.x - 0.5) * compositionWidth,
        y: (norm.y - 0.5) * compositionHeight,
      };
    },
    [screenToNormalized, compositionWidth, compositionHeight],
  );

  const canvasPanGestureBind = useDragGesture<PointerEvent>(
    ({ first, last, movement: [movementX, movementY], memo, event }) => {
      const target = event.target as EventTarget | null;
      const currentTarget = event.currentTarget as EventTarget | null;
      const shouldPan =
        currentTarget === target &&
        (event.metaKey || event.ctrlKey || event.shiftKey);
      if (!memo && !shouldPan) {
        return undefined;
      }

      event.preventDefault();
      event.stopPropagation();

      const startOffset = (memo as typeof panOffset | undefined) ?? panOffset;
      if (first) {
        setIsPanning(true);
      }
      setPanOffset({
        x: startOffset.x + movementX,
        y: startOffset.y + movementY,
      });
      if (last) {
        setIsPanning(false);
      }
      return startOffset;
    },
    {
      preventDefault: true,
      pointer: { capture: true },
      eventOptions: { passive: false },
    },
  );

  const createTransformDragSession = useCallback(
    (
      item: Item,
      trackId: string,
      mode: CanvasTransformMode,
      clientX: number,
      clientY: number,
    ): DragState => {
      const startPoint = screenToPropertySpace(clientX, clientY);
      const visibleProperties = resolveCanvasTransformProperties(
        item,
        currentFrame,
      );

      let startWidth = visibleProperties.width;
      let startHeight = visibleProperties.height;

      // Handle Contain Fit special case for scaling. If we are about to scale
      // from the default fitted state (1, 1), calculate the effective scale so
      // resizing continues from the rendered dimensions.
      if (mode.startsWith("scale") && startWidth === 1 && startHeight === 1) {
        const { naturalWidth, naturalHeight } = getNaturalDimensions(item);
        const scaleX = compositionWidth / naturalWidth;
        const scaleY = compositionHeight / naturalHeight;
        const scale = Math.min(scaleX, scaleY);

        startWidth = scale;
        startHeight = scale;
      }

      return {
        mode,
        startX: startPoint.x, // Composition Pixels (Center Relative)
        startY: startPoint.y,
        startProperties: {
          x: visibleProperties.x,
          y: visibleProperties.y,
          width: startWidth,
          height: startHeight,
          rotation: visibleProperties.rotation ?? 0,
          opacity: visibleProperties.opacity ?? 1,
        },
        item,
        trackId,
      };
    },
    [
      compositionWidth,
      compositionHeight,
      currentFrame,
      getNaturalDimensions,
      screenToPropertySpace,
    ],
  );

  const applyTransformDrag = useCallback(
    (session: DragState, clientX: number, clientY: number) => {
      const currentPoint = screenToPropertySpace(clientX, clientY);
      // Delta in Composition Pixels
      const deltaX = currentPoint.x - session.startX;
      const deltaY = currentPoint.y - session.startY;

      const newProperties: Partial<ItemProperties> = {
        ...session.startProperties,
      };

      // 旋转相关计算
      const startX = session.startProperties.x ?? 0;
      const startY = session.startProperties.y ?? 0;

      switch (session.mode) {
        case "move": {
          // 移动：直接加 Delta (因为 x,y 也是 Composition Pixels)
          let nextX = startX + deltaX;
          let nextY = startY + deltaY;

          // 吸附逻辑 (Snapping) - 完整田字格
          // 阈值：屏幕像素 10px -> 属性空间像素
          const metrics = getBaseMetrics();
          const snapThreshold = metrics ? 10 / metrics.scaleX / zoom : 10; // 约 10px 屏幕距离

          const snapState = {
            centerX: false,
            centerY: false,
            left: false,
            right: false,
            top: false,
            bottom: false,
          };

          // 获取元素的宽高（在属性空间中，单位是 composition pixels）
          // width=1, height=1 means 100% of media's natural size
          const { naturalWidth, naturalHeight } = getNaturalDimensions(
            session.item,
          );

          const itemWidth = (session.startProperties.width ?? 1) * naturalWidth;
          const itemHeight =
            (session.startProperties.height ?? 1) * naturalHeight;

          // 计算元素的边界位置（相对于中心）
          const leftEdge = nextX - itemWidth / 2;
          const rightEdge = nextX + itemWidth / 2;
          const topEdge = nextY - itemHeight / 2;
          const bottomEdge = nextY + itemHeight / 2;

          // 画布边界（相对于中心，composition pixels）
          const canvasLeft = -compositionWidth / 2;
          const canvasRight = compositionWidth / 2;
          const canvasTop = -compositionHeight / 2;
          const canvasBottom = compositionHeight / 2;

          // 吸附优先级：中心 > 边界
          // X轴吸附
          // 1. 中心线吸附
          if (Math.abs(nextX) < snapThreshold) {
            nextX = 0;
            snapState.centerX = true;
          }
          // 2. 左边界吸附（元素左边缘 -> 画布左边界）
          else if (Math.abs(leftEdge - canvasLeft) < snapThreshold) {
            nextX = canvasLeft + itemWidth / 2;
            snapState.left = true;
          }
          // 3. 右边界吸附（元素右边缘 -> 画布右边界）
          else if (Math.abs(rightEdge - canvasRight) < snapThreshold) {
            nextX = canvasRight - itemWidth / 2;
            snapState.right = true;
          }

          // Y轴吸附
          // 1. 中心线吸附
          if (Math.abs(nextY) < snapThreshold) {
            nextY = 0;
            snapState.centerY = true;
          }
          // 2. 上边界吸附（元素上边缘 -> 画布上边界）
          else if (Math.abs(topEdge - canvasTop) < snapThreshold) {
            nextY = canvasTop + itemHeight / 2;
            snapState.top = true;
          }
          // 3. 下边界吸附（元素下边缘 -> 画布下边界）
          else if (Math.abs(bottomEdge - canvasBottom) < snapThreshold) {
            nextY = canvasBottom - itemHeight / 2;
            snapState.bottom = true;
          }

          setSnapLines(snapState);

          newProperties.x = nextX;
          newProperties.y = nextY;
          break;
        }

        case "scale-tl":
        case "scale-tr":
        case "scale-bl":
        case "scale-br": {
          // 缩放
          // 需要考虑旋转，这里简化处理，使用距离变化
          // 更好的方式是将鼠标点投影到对象局部坐标系，这里先实现中心缩放或简单的方向缩放

          // 简单的中心缩放实现：
          // 计算鼠标相对于中心的距离变化
          // 这种方式在旋转后也基本可用，但不是最精确的角落拖拽

          const startDist = Math.hypot(
            session.startX - startX,
            session.startY - startY,
          );
          const curDist = Math.hypot(
            currentPoint.x - startX,
            currentPoint.y - startY,
          );

          // 避免除零
          if (startDist < 1) break;

          const scale = curDist / startDist;

          // 基于初始宽高缩放
          newProperties.width = Math.max(
            0.01,
            session.startProperties.width * scale,
          );
          newProperties.height = Math.max(
            0.01,
            session.startProperties.height * scale,
          );
          break;
        }

        case "rotate": {
          // 旋转
          // 计算当前鼠标相对于 Item 中心的角度
          const angle =
            Math.atan2(currentPoint.y - startY, currentPoint.x - startX) *
            (180 / Math.PI);
          // 此时 angle 是鼠标相对于中心的角度
          // 我们需要 delta angle
          const startAngle =
            Math.atan2(session.startY - startY, session.startX - startX) *
            (180 / Math.PI);
          const deltaAngle = angle - startAngle;

          let nextRotation =
            (session.startProperties.rotation ?? 0) + deltaAngle;

          // 旋转吸附：每 90 度吸附（0°, 90°, 180°, 270°, 360°）
          const snapRotationThreshold = 5; // 5度内吸附
          const rotationMod = nextRotation % 90;

          // 标准化到 -45 ~ 45 范围内判断
          const normalizedMod =
            rotationMod > 45
              ? rotationMod - 90
              : rotationMod < -45
                ? rotationMod + 90
                : rotationMod;

          if (Math.abs(normalizedMod) < snapRotationThreshold) {
            // 吸附到最近的 90 度倍数
            nextRotation = Math.round(nextRotation / 90) * 90;
          }

          newProperties.rotation = nextRotation;
          break;
        }
      }

      const editMode =
        session.mode === "move"
          ? "move"
          : session.mode === "rotate"
            ? "rotate"
            : "scale";
      onUpdateItem(
        session.trackId,
        session.item.id,
        applyCanvasTransformEdit(
          session.item,
          currentFrame,
          editMode,
          newProperties as ItemProperties,
        ),
      );
    },
    [
      screenToPropertySpace,
      onUpdateItem,
      getBaseMetrics,
      zoom,
      getNaturalDimensions,
      compositionWidth,
      compositionHeight,
      currentFrame,
    ],
  );

  const canvasTransformGestureBind = useDragGesture<PointerEvent>(
    ({
      first,
      last,
      args: [mode, item, trackId, selectOnStart],
      event,
      memo,
    }) => {
      event.preventDefault();
      event.stopPropagation();

      let session = memo as DragState | undefined;
      if (first) {
        if (selectOnStart && onSelectItem && selectedItemId !== item.id) {
          onSelectItem(item.id);
        }
        session = createTransformDragSession(
          item,
          trackId,
          mode,
          event.clientX,
          event.clientY,
        );
        onTransformStart?.();
      }

      if (session && !first) {
        applyTransformDrag(session, event.clientX, event.clientY);
      }

      if (last) {
        setSnapLines(null);
        if (session) onTransformEnd?.();
      }

      return session;
    },
    {
      preventDefault: true,
      pointer: { capture: true },
      eventOptions: { passive: false },
    },
  );

  const stopTransformMouseDown = useCallback(
    (event: React.MouseEvent<SVGElement>) => {
      event.stopPropagation();
    },
    [],
  );

  // 获取 Item 在屏幕上的渲染信息 (替换原来的 getItemBounds/getItemScreenPosition)
  // width=1, height=1 means 100% of media's natural size (not composition size)
  const getItemRenderInfo = useCallback(
    (item: Item) => {
      // Resolve implicit transforms for interaction without committing an edit.
      const visibleProperties = resolveCanvasTransformProperties(
        item,
        currentFrame,
      );

      // Properties:
      // x, y: Center relative composition pixels
      // width, height: Scale factor relative to media's natural size (1 = 100% natural size)

      const propX = visibleProperties.x;
      const propY = visibleProperties.y;
      const propW = visibleProperties.width;
      const propH = visibleProperties.height;
      const rotation = visibleProperties.rotation ?? 0;

      // Get natural dimensions from asset node
      const { naturalWidth, naturalHeight } = getNaturalDimensions(item);

      // 转换中心点到 Normalized (0-1 TopLeft)
      const normCx = propX / compositionWidth + 0.5;
      const normCy = propY / compositionHeight + 0.5;

      // 转换中心点到屏幕坐标
      const centerScreen = normalizedToScreen(normCx, normCy);

      const metrics = getBaseMetrics();
      if (!metrics) return null;

      // Calculate pixel size: propW * naturalWidth (then scale to screen)
      // Implement Contain Fit logic when width=1, height=1
      let itemPixelWidth: number;
      let itemPixelHeight: number;

      if (propW === 1 && propH === 1) {
        const scaleX = compositionWidth / naturalWidth;
        const scaleY = compositionHeight / naturalHeight;
        const scale = Math.min(scaleX, scaleY);
        itemPixelWidth = naturalWidth * scale;
        itemPixelHeight = naturalHeight * scale;
      } else {
        itemPixelWidth = propW * naturalWidth;
        itemPixelHeight = propH * naturalHeight;
      }

      const wPx = itemPixelWidth * metrics.scaleX * zoom;
      const hPx = itemPixelHeight * metrics.scaleY * zoom;

      return {
        centerX: centerScreen.x,
        centerY: centerScreen.y,
        width: wPx,
        height: hPx,
        rotation,
        // 屏幕坐标系的 Left/Top (未旋转的包围盒左上角)
        left: centerScreen.x - wPx / 2,
        top: centerScreen.y - hPx / 2,
      };
    },
    [
      normalizedToScreen,
      getBaseMetrics,
      compositionWidth,
      compositionHeight,
      zoom,
      allNodesMap,
      currentFrame,
    ],
  );

  // 当前选中项的屏幕信息
  const bounds = React.useMemo(
    () =>
      selectedItemData && isCanvasTransformableItem(selectedItemData.item)
        ? getItemRenderInfo(selectedItemData.item)
        : null,
    [selectedItemData, getItemRenderInfo],
  );

  const visibleCanvasItems = React.useMemo(() => {
    const items: Array<{
      trackId: string;
      item: Item;
      bounds: NonNullable<ReturnType<typeof getItemRenderInfo>>;
    }> = [];

    for (const track of tracks) {
      for (const item of track.items) {
        if (!isCanvasTransformableItem(item)) continue;
        if (
          currentFrame < item.from ||
          currentFrame >= item.from + item.durationInFrames
        )
          continue;

        const itemBounds = getItemRenderInfo(item);
        if (!itemBounds) continue;

        items.push({
          trackId: track.id,
          item,
          bounds: itemBounds,
        });
      }
    }

    return items;
  }, [tracks, currentFrame, getItemRenderInfo]);

  // 统一的指针按下处理（同时处理选中和拖动）
  // const handlePointerDown = useCallback(
  //   (e: React.MouseEvent) => {
  //     if (!onSelectItem) return;

  //     const target = e.target as HTMLElement;
  //     if (target.closest('.control-handle') || target.closest('.zoom-controls')) {
  //       return;
  //     }
  //     if (target.tagName === 'BUTTON' || target.closest('button')) {
  //       return;
  //     }

  //     const point = screenToPropertySpace(e.clientX, e.clientY);

  //     const hitTarget = findTopItemAtPoint(
  //       point.x,
  //       point.y,
  //       tracks,
  //       currentFrame,
  //       compositionWidth,
  //       compositionHeight
  //     );

  //     if (hitTarget) {
  //       if (selectedItemId !== hitTarget.itemId) {
  //         onSelectItem(hitTarget.itemId);
  //       }

  //       const itemData = tracks
  //         .flatMap((t) => t.items.map((i) => ({ trackId: t.id, item: i })))
  //         .find((x) => x.item.id === hitTarget.itemId);

  //       if (itemData) {
  //         e.preventDefault();
  //         e.stopPropagation();

  //         // startX/Y needs to be in Property Space (Composition Pixels)
  //         setDragState({
  //           mode: 'move',
  //           startX: point.x,
  //           startY: point.y,
  //           startProperties: {
  //             x: itemData.item.properties?.x ?? 0,
  //             y: itemData.item.properties?.y ?? 0,
  //             width: itemData.item.properties?.width ?? 1,
  //             height: itemData.item.properties?.height ?? 1,
  //             rotation: itemData.item.properties?.rotation ?? 0,
  //             opacity: itemData.item.properties?.opacity ?? 1,
  //           },
  //           item: itemData.item,
  //           trackId: itemData.trackId,
  //         });
  //       }
  //     } else {
  //       onSelectItem(null);
  //     }
  //   },
  //   [
  //     tracks,
  //     currentFrame,
  //     compositionWidth,
  //     compositionHeight,
  //     selectedItemId,
  //     onSelectItem,
  //     screenToPropertySpace,
  //   ]
  // );

  // 计算画布的实际显示尺寸（保持宽高比）
  const aspectRatio = compositionWidth / compositionHeight;

  return (
    <div style={styles.container}>
      {/* Remotion Player - 底层渲染 */}
      <div
        ref={containerRef}
        style={{
          ...styles.playerWrapper,
          cursor: isPanning ? "grabbing" : "default",
        }}
        {...canvasPanGestureBind()}
        onMouseDown={() => {
          // 点击空白区域取消选中
          // 如果点击的是元素或控制手柄，他们会 stopPropagation，不会到达这里
          onSelectItem?.(null);
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "relative",
              // 使用 JS 计算的精确像素值，不再使用百分比，确保与 getBaseMetrics 一致
              width: currentMetrics
                ? currentMetrics.width
                : aspectRatio > 1
                  ? "100%"
                  : `${aspectRatio * 100}%`,
              height: currentMetrics
                ? currentMetrics.height
                : aspectRatio > 1
                  ? `${(1 / aspectRatio) * 100}%`
                  : "100%",
              transform: `scale(${zoom}) translate(${panOffset.x / zoom}px, ${panOffset.y / zoom}px)`,
              transformOrigin: "center center",
            }}
          >
            <Player
              ref={playerRef}
              component={VideoComposition}
              compositionWidth={compositionWidth}
              compositionHeight={compositionHeight}
              durationInFrames={durationInFrames}
              fps={fps}
              inputProps={inputProps}
              style={styles.player}
              controls={false}
              loop={false}
              numberOfSharedAudioTags={0}
            />
          </div>
        </div>

        {/* 吸附辅助线 (Snap Lines) - 完整田字格 */}
        <svg
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 900,
          }}
        >
          {(() => {
            // 计算画布边界在屏幕上的位置
            const topLeft = normalizedToScreen(0, 0);
            const topRight = normalizedToScreen(1, 0);
            const bottomLeft = normalizedToScreen(0, 1);
            const bottomRight = normalizedToScreen(1, 1);
            const center = normalizedToScreen(0.5, 0.5);

            const lines: React.ReactNode[] = [];

            // 垂直中心线
            if (snapLines?.centerX) {
              lines.push(
                <line
                  key="center-x"
                  x1={center.x}
                  y1={topLeft.y}
                  x2={center.x}
                  y2={bottomLeft.y}
                  stroke="cyan"
                  strokeWidth="2"
                  strokeDasharray="5,5"
                />,
              );
            }

            // 水平中心线
            if (snapLines?.centerY) {
              lines.push(
                <line
                  key="center-y"
                  x1={topLeft.x}
                  y1={center.y}
                  x2={topRight.x}
                  y2={center.y}
                  stroke="cyan"
                  strokeWidth="2"
                  strokeDasharray="5,5"
                />,
              );
            }

            // 左边界线
            if (snapLines?.left) {
              lines.push(
                <line
                  key="left"
                  x1={topLeft.x}
                  y1={topLeft.y}
                  x2={bottomLeft.x}
                  y2={bottomLeft.y}
                  stroke="cyan"
                  strokeWidth="2"
                  strokeDasharray="5,5"
                />,
              );
            }

            // 右边界线
            if (snapLines?.right) {
              lines.push(
                <line
                  key="right"
                  x1={topRight.x}
                  y1={topRight.y}
                  x2={bottomRight.x}
                  y2={bottomRight.y}
                  stroke="cyan"
                  strokeWidth="2"
                  strokeDasharray="5,5"
                />,
              );
            }

            // 上边界线
            if (snapLines?.top) {
              lines.push(
                <line
                  key="top"
                  x1={topLeft.x}
                  y1={topLeft.y}
                  x2={topRight.x}
                  y2={topRight.y}
                  stroke="cyan"
                  strokeWidth="2"
                  strokeDasharray="5,5"
                />,
              );
            }

            // 下边界线
            if (snapLines?.bottom) {
              lines.push(
                <line
                  key="bottom"
                  x1={bottomLeft.x}
                  y1={bottomLeft.y}
                  x2={bottomRight.x}
                  y2={bottomRight.y}
                  stroke="cyan"
                  strokeWidth="2"
                  strokeDasharray="5,5"
                />,
              );
            }

            return lines;
          })()}
        </svg>

        {/* 交互层1 - 所有可见元素的透明点击区域 */}
        <svg
          className="canvas-items"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "all",
            zIndex: 1000,
          }}
        >
          {/* 全屏透明背景，用于捕获空白点击 */}
          <rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            fill="transparent"
            style={{ pointerEvents: "all" }}
            onPointerDown={(event) => {
              event.stopPropagation();
              onSelectItem?.(null);
            }}
          />

          {/* 为每个可见元素渲染透明点击区域 */}
          {visibleCanvasItems.map(({ trackId, item, bounds: itemBounds }) => (
            <rect
              key={item.id}
              className="item-clickable"
              x={itemBounds.left}
              y={itemBounds.top}
              width={itemBounds.width}
              height={itemBounds.height}
              fill="transparent"
              style={{
                pointerEvents: "all",
                cursor: "pointer",
                transform: `rotate(${itemBounds.rotation}deg)`,
                transformOrigin: `${itemBounds.centerX}px ${itemBounds.centerY}px`,
              }}
              {...canvasTransformGestureBind("move", item, trackId, true)}
              onMouseDown={stopTransformMouseDown}
            />
          ))}
        </svg>

        {/* 交互层2 - 选中元素的蓝框和控制手柄 */}
        {bounds && selectedItemData && (
          <svg
            className="canvas-controls"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              zIndex: 1001,
            }}
          >
            {/* 蓝色边框 */}
            <rect
              className="control-handle"
              x={bounds.left}
              y={bounds.top}
              width={bounds.width}
              height={bounds.height}
              fill="none"
              stroke="var(--clash-accent, #ff6b50)"
              strokeWidth="2"
              style={{
                pointerEvents: "none",
                transform: `rotate(${bounds.rotation}deg)`,
                transformOrigin: `${bounds.centerX}px ${bounds.centerY}px`,
              }}
            />

            {/* 透明的拖拽区域（选中时覆盖在透明层上方，优先响应） */}
            <rect
              className="control-handle"
              x={bounds.left}
              y={bounds.top}
              width={bounds.width}
              height={bounds.height}
              fill="transparent"
              style={{
                transform: `rotate(${bounds.rotation}deg)`,
                transformOrigin: `${bounds.centerX}px ${bounds.centerY}px`,
                cursor: "move",
                pointerEvents: "all",
              }}
              {...canvasTransformGestureBind(
                "move",
                selectedItemData.item,
                selectedItemData.trackId,
                false,
              )}
              onMouseDown={stopTransformMouseDown}
            />

            {/* 四个角的缩放手柄 */}
            {[
              { pos: "tl", x: bounds.left, y: bounds.top },
              { pos: "tr", x: bounds.left + bounds.width, y: bounds.top },
              { pos: "bl", x: bounds.left, y: bounds.top + bounds.height },
              {
                pos: "br",
                x: bounds.left + bounds.width,
                y: bounds.top + bounds.height,
              },
            ].map(({ pos, x, y }) => (
              <circle
                key={pos}
                className="control-handle"
                cx={x}
                cy={y}
                r="6"
                fill="var(--clash-warm-surface, #fffefd)"
                stroke="var(--clash-accent, #ff6b50)"
                strokeWidth="2"
                style={{
                  pointerEvents: "all",
                  cursor: `${pos.includes("t") ? "n" : "s"}${pos.includes("l") ? "w" : "e"}-resize`,
                  transform: `rotate(${bounds.rotation}deg)`,
                  transformOrigin: `${bounds.centerX}px ${bounds.centerY}px`,
                }}
                {...canvasTransformGestureBind(
                  `scale-${pos}` as CanvasTransformMode,
                  selectedItemData.item,
                  selectedItemData.trackId,
                  false,
                )}
                onMouseDown={stopTransformMouseDown}
              />
            ))}

            {/* 旋转手柄 */}
            <circle
              className="control-handle"
              cx={bounds.centerX}
              cy={bounds.top - 30}
              r="6"
              fill="var(--clash-warm-surface, #fffefd)"
              stroke="var(--clash-accent, #ff6b50)"
              strokeWidth="2"
              style={{
                pointerEvents: "all",
                cursor: "crosshair",
                transform: `rotate(${bounds.rotation}deg)`,
                transformOrigin: `${bounds.centerX}px ${bounds.centerY}px`,
              }}
              {...canvasTransformGestureBind(
                "rotate",
                selectedItemData.item,
                selectedItemData.trackId,
                false,
              )}
              onMouseDown={stopTransformMouseDown}
            />
            <line
              className="control-handle"
              x1={bounds.centerX}
              y1={bounds.top}
              x2={bounds.centerX}
              y2={bounds.top - 30}
              stroke="var(--clash-accent, #ff6b50)"
              strokeWidth="2"
              style={{
                transform: `rotate(${bounds.rotation}deg)`,
                transformOrigin: `${bounds.centerX}px ${bounds.centerY}px`,
                pointerEvents: "none",
              }}
            />
          </svg>
        )}
      </div>

      {shouldShowCanvasMinimap(zoom) && (
        <div
          ref={minimapRef}
          role="application"
          tabIndex={0}
          aria-label="Canvas minimap"
          aria-description="Drag to pan the canvas. Use the mouse wheel to zoom."
          title="Drag to pan · Wheel to zoom · Home to fit"
          style={{
            ...styles.minimap,
            width: minimapSize.width,
            height: minimapSize.height,
          }}
          {...minimapGestureBind()}
          onKeyDown={handleMinimapKeyDown}
        >
          <div aria-hidden="true" style={styles.minimapGrid} />
          <div
            aria-hidden="true"
            style={{
              ...styles.minimapViewport,
              left: `${minimapViewport.left * 100}%`,
              top: `${minimapViewport.top * 100}%`,
              width: `${minimapViewport.width * 100}%`,
              height: `${minimapViewport.height * 100}%`,
            }}
          />
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  },
  playerWrapper: {
    width: "100%",
    height: "100%",
    position: "relative",
  },
  player: {
    width: "100%",
    height: "100%",
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "all",
    userSelect: "none",
  },
  minimap: {
    position: "absolute",
    right: 12,
    bottom: 12,
    zIndex: 1100,
    overflow: "hidden",
    border: `1px solid ${colors.border.default}`,
    borderRadius: 6,
    backgroundColor: colors.bg.hover,
    boxShadow: shadows.md,
    cursor: "crosshair",
    touchAction: "none",
  },
  minimapGrid: {
    position: "absolute",
    inset: 0,
    opacity: 0.48,
    backgroundImage: `linear-gradient(${colors.border.subtle} 1px, transparent 1px), linear-gradient(90deg, ${colors.border.subtle} 1px, transparent 1px)`,
    backgroundSize: "25% 25%",
  },
  minimapViewport: {
    position: "absolute",
    minWidth: 3,
    minHeight: 3,
    border: `1px solid ${colors.accent.primary}`,
    borderRadius: 3,
    backgroundColor: "rgba(255, 107, 80, 0.22)",
    boxShadow: "0 0 0 1px rgba(255, 255, 255, 0.6) inset",
    pointerEvents: "none",
  },
};
