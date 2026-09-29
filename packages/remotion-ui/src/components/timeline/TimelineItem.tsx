import React, { useState, useCallback, CSSProperties } from 'react';
import { useDraggable } from '../ui/dnd';
import type { Item, BaseItem, Asset, Track } from '@clash/remotion-core';
import {
  AUDIO_GAIN_DB_MAX,
  AUDIO_GAIN_DB_MIN,
  clampAudioGainDb,
  findAssetForItem,
  getItemResolvedSrc,
  getItemResolvedType,
  getItemSourceNodeId,
  isSpokenMediaTrack,
  loadAudioWaveform,
  resolveAudioFadeInFrames,
  resolveAudioFadeOutFrames,
  resolveAudioGainDb,
  useEditorDispatch,
  useEditorStaticState,
} from '@clash/remotion-core';
import { frameToPixels, secondsToFrames } from './utils/timeFormatter';
import { getRendererForItem } from './items/registry';
import { generateVideoThumbnailAtTime, thumbnailCache } from '../../utils/thumbnailCache';
import {
  createFilmstripColumnMapping,
  createFilmstripCacheEntry,
  createSerializedTaskQueue,
  drawFilmstripColumnsForSample,
  type FilmstripCacheEntry,
  generateVideoFilmstrip,
  getAdaptiveFilmstripSampleCount,
  getBoundedFilmstripCanvasWidth,
  getOrCreatePendingTask,
  getPersistentMediaCacheId,
  renderFilmstripToCanvas,
} from './videoThumbnailUtils';
import { createBoundedWaveformCache } from './waveformCache';
import { TimelineTextInput } from '../ui/controls';
import { useDragGesture } from '../ui/gesture';
import { getTimelineItemDisplayLabel } from './itemDisplayLabel';
import {
  colors,
  getTimelineItemTone,
  shadows,
  timeline,
} from './styles';
import { PRIMARY_TRANSCRIPT_WORDBAR_HEIGHT } from './PrimaryTranscriptWordbar';
import {
  TIMELINE_KEYFRAME_CHANNELS,
  type AgentAnnotationObjectRef,
} from '@clash/shared-types';
import {
  createOneSidedWaveformPath,
  getWaveformBuildCacheKey,
  getWaveformSampleCount,
} from './waveformPresentation';
import { createTimelineTextEditUpdates } from './textItemEditing';
import { AudioFadeEnvelope } from './AudioFadeEnvelope';
import { getTrackHeightForTrack, getTextKeyframeBandHeight } from './trackGeometry';

export type TimelineKeyframeMarker = {
  channels: Array<(typeof TIMELINE_KEYFRAME_CHANNELS)[number]>;
  edge: 'start' | 'middle' | 'end';
  frame: number;
  leftPercent: number;
};

export const getTimelineKeyframeMarkers = (item: Item): TimelineKeyframeMarker[] => {
  const lastFrame = Math.max(1, item.durationInFrames - 1);
  const channelsByFrame = new Map<
    number,
    Array<(typeof TIMELINE_KEYFRAME_CHANNELS)[number]>
  >();

  TIMELINE_KEYFRAME_CHANNELS.forEach((channel) => {
    (item.keyframes?.[channel] ?? []).forEach((keyframe) => {
      const channels = channelsByFrame.get(keyframe.frame) ?? [];
      channels.push(channel);
      channelsByFrame.set(keyframe.frame, channels);
    });
  });

  return [...channelsByFrame.entries()]
    .sort(([leftFrame], [rightFrame]) => leftFrame - rightFrame)
    .map(([frame, channels]) => ({
      channels,
      edge: frame <= 0 ? 'start' : frame >= lastFrame ? 'end' : 'middle',
      frame,
      leftPercent: (frame / lastFrame) * 100,
    }));
};

export type TimelineKeyframeMarkerLayout = {
  bottom: number;
  buttonLeft: number | string;
  buttonTransform: string;
  glyph: 'start-cap' | 'diamond' | 'end-cap';
};

export const getTimelineKeyframeMarkerLayout = (
  marker: TimelineKeyframeMarker,
): TimelineKeyframeMarkerLayout => {
  if (marker.edge === 'start') {
    return {
      bottom: 4,
      buttonLeft: 0,
      buttonTransform: 'none',
      glyph: 'start-cap',
    };
  }
  if (marker.edge === 'end') {
    return {
      bottom: 4,
      buttonLeft: '100%',
      buttonTransform: 'translateX(-100%)',
      glyph: 'end-cap',
    };
  }
  return {
    bottom: 4,
    buttonLeft: `${marker.leftPercent}%`,
    buttonTransform: 'translateX(-50%)',
    glyph: 'diamond',
  };
};

// Store dragged item globally on window object for cross-module access
declare global {
  interface Window {
    currentDraggedItem: { item: Item; trackId: string } | null;
  }
}

const pendingFilmstripBuilds = new Map<string, Promise<string | undefined>>();
const enqueueFilmstripBuild = createSerializedTaskQueue();
const generatedWaveformCache = createBoundedWaveformCache({
  maxEntries: 48,
  maxSamples: 48 * 8_192,
  ttlMs: 30 * 60 * 1_000,
});
const pendingWaveformBuilds = new Map<string, Promise<number[]>>();

const formatDb = (db: number) => (
  db <= AUDIO_GAIN_DB_MIN ? '-∞ dB' : `${db.toFixed(1)} dB`
);

const audioGainDbToLaneY = (db: number, height: number): number => {
  const top = 1;
  const bottom = Math.max(top, height - 1);
  const middle = (top + bottom) / 2;
  const clamped = clampAudioGainDb(db);
  if (clamped >= 0) {
    return middle - (clamped / AUDIO_GAIN_DB_MAX) * (middle - top);
  }
  return middle + (-clamped / Math.abs(AUDIO_GAIN_DB_MIN)) * (bottom - middle);
};

const laneYToAudioGainDb = (y: number, height: number): number => {
  const top = 1;
  const bottom = Math.max(top, height - 1);
  const middle = (top + bottom) / 2;
  const clampedY = Math.max(top, Math.min(bottom, y));
  const db = clampedY <= middle
    ? ((middle - clampedY) / Math.max(1, middle - top)) * AUDIO_GAIN_DB_MAX
    : -((clampedY - middle) / Math.max(1, bottom - middle)) * Math.abs(AUDIO_GAIN_DB_MIN);
  return Math.round(clampAudioGainDb(db) * 10) / 10;
};

interface TimelineItemProps {
  item: Item;
  trackId: string;
  track: Track;
  pixelsPerFrame: number;
  isSelected: boolean;
  assets: Asset[];
  onSelect: () => void;
  onDelete: () => void;
  onUpdate: (itemId: string, updates: Partial<Item>) => void;
  // Legacy native DnD callbacks (kept for compatibility with old flow if needed)
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onResizeStart?: (edge: 'left' | 'right') => void;
  onResize?: (edge: 'left' | 'right', deltaFrames: number) => void;
  onRollEdit?: (edge: 'left' | 'right', deltaFrames: number) => void; // Roll edit with adjacent item
  hasAdjacentItemOnLeft?: boolean;
  hasAdjacentItemOnRight?: boolean;
  onResizeEnd?: () => void;
  style?: CSSProperties;
  // DragOverlay mode: disable positioning, let DragOverlay handle it
  isDragOverlay?: boolean;
  onAnnotationTargetContextMenu?: (target: AgentAnnotationObjectRef) => void;
  /** Height of a projected UI sublane without changing the persisted track model. */
  presentationTrackHeight?: number;
  /** Override transcript reservation when a track is projected inside another lane. */
  presentationReservesTranscriptWordbar?: boolean;
  /** Opaque Host authority scope used to isolate disposable media previews. */
  previewCacheScope?: string;
}

export const TimelineItem: React.FC<TimelineItemProps> = ({
  item,
  trackId,
  track,
  pixelsPerFrame,
  isSelected,
  assets,
  onSelect,
  onUpdate,
  onDragStart: _onDragStartProp,
  onDragEnd: _onDragEndProp,
  onResizeStart,
  onResize,
  onResizeEnd,
  onRollEdit,
  hasAdjacentItemOnLeft,
  hasAdjacentItemOnRight,
  style: customStyle,
  isDragOverlay = false,
  onAnnotationTargetContextMenu,
  presentationTrackHeight,
  presentationReservesTranscriptWordbar,
  previewCacheScope,
}) => {
  const { fps, primaryTrackId } = useEditorStaticState();
  const dispatch = useEditorDispatch();
  const [isHovered, setIsHovered] = useState(false);
  const [resizingEdge, setResizingEdge] = useState<'left' | 'right' | null>(null);
  const [hoveredResizeEdge, setHoveredResizeEdge] = useState<'left' | 'right' | null>(null);
  const [draggingFade, setDraggingFade] = useState<{ type: 'in' | 'out' } | null>(null);
  const [draggingVolumeDb, setDraggingVolumeDb] = useState<number | null>(null);
  const [isEditingText, setIsEditingText] = useState(false);
  const [tempText, setTempText] = useState('');
  const waveformContainerRef = React.useRef<HTMLDivElement | null>(null);

  const width = frameToPixels(item.durationInFrames, pixelsPerFrame);

  // Resolve item type and src from asset if using reference-based model
  // This is needed because reference-based items only have assetId, not type/src directly
  const resolvedItemType = React.useMemo(() => {
    return getItemResolvedType(item as BaseItem & { type?: Item['type']; src?: string }, assets);
  }, [item, assets]);

  const resolvedItemSrc = React.useMemo(() => {
    return getItemResolvedSrc(item as BaseItem & { src?: string }, assets);
  }, [item, assets]);

  const itemTone = getTimelineItemTone(
    resolvedItemType,
    resolvedItemType === 'solid' ? (item as any).color : undefined,
  );

  // Get asset data (for thumbnail and waveform) - use resolved type
  const asset = React.useMemo(() => {
    return findAssetForItem(item as BaseItem & { src?: string; type?: Item['type'] }, assets);
  }, [item, assets]);

  const sourceNodeId = getItemSourceNodeId(item);
  const itemProjectAssetId = item.sourceNodeId ? item.assetId : undefined;
  const persistentMediaCacheId = React.useMemo(
    () => getPersistentMediaCacheId(
      asset?.projectAssetId ?? itemProjectAssetId,
      sourceNodeId,
      resolvedItemSrc,
      previewCacheScope,
    ),
    [
      asset?.projectAssetId,
      itemProjectAssetId,
      previewCacheScope,
      resolvedItemSrc,
      sourceNodeId,
    ],
  );

  const staticThumbnail = asset?.thumbnail || (resolvedItemType === 'image' ? resolvedItemSrc : undefined);
  const persistedWaveform: number[] | undefined =
    resolvedItemType === 'audio' || resolvedItemType === 'video'
      ? ((item as any).waveform as number[] | undefined) ?? asset?.waveform
      : undefined;
  const resolvedMediaDurationSeconds = asset?.duration
    ?? (item.durationInFrames / Math.max(1, fps));
  const waveformSampleCount = getWaveformSampleCount(resolvedMediaDurationSeconds);
  const waveformCacheKey = getWaveformBuildCacheKey(
    resolvedItemType,
    resolvedItemSrc,
    waveformSampleCount,
    persistentMediaCacheId ?? undefined,
  );
  const [generatedWaveform, setGeneratedWaveform] = React.useState<number[] | undefined>(
    () => waveformCacheKey ? generatedWaveformCache.get(waveformCacheKey) : undefined,
  );
  React.useEffect(() => {
    if (
      !waveformCacheKey
      || !resolvedItemSrc
      || (persistedWaveform?.length ?? 0) >= waveformSampleCount
    ) {
      setGeneratedWaveform(undefined);
      return;
    }
    const cached = generatedWaveformCache.get(waveformCacheKey);
    if (cached) {
      setGeneratedWaveform(cached);
      return;
    }
    let cancelled = false;
    const pending = pendingWaveformBuilds.get(waveformCacheKey)
      ?? loadAudioWaveform(resolvedItemSrc, waveformSampleCount);
    pendingWaveformBuilds.set(waveformCacheKey, pending);
    void pending
      .then((waveform) => {
        generatedWaveformCache.set(waveformCacheKey, waveform);
        if (!cancelled) setGeneratedWaveform(waveform);
      })
      .catch(() => {
        if (!cancelled) setGeneratedWaveform(undefined);
      })
      .finally(() => {
        if (pendingWaveformBuilds.get(waveformCacheKey) === pending) {
          pendingWaveformBuilds.delete(waveformCacheKey);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    persistedWaveform,
    resolvedItemSrc,
    waveformCacheKey,
    waveformSampleCount,
  ]);
  const itemWaveform = generatedWaveform ?? persistedWaveform;
  const hasWaveform: boolean = Array.isArray(itemWaveform) && itemWaveform.length > 0;
  const sourceStartInFrames = (item as any).sourceStartInFrames || 0;
  const fallbackThumbnailCacheKey = persistentMediaCacheId
    ? `thumb:${persistentMediaCacheId}:${sourceStartInFrames}`
    : null;
  const [filmstripThumbnail, setFilmstripThumbnail] = React.useState<string | null>(null);
  const [fallbackVideoThumbnail, setFallbackVideoThumbnail] = React.useState<string | null>(null);
  const [isGeneratingThumbnail, setIsGeneratingThumbnail] = React.useState(false);
  const filmstripGenerationRef = React.useRef(0);
  const fallbackThumbnailGenerationRef = React.useRef(0);
  const attemptedFilmstripKeyRef = React.useRef<string | null>(null);
  const progressiveFilmstripCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [hasProgressiveFilmstripFrame, setHasProgressiveFilmstripFrame] = React.useState(false);

  const displayThumbnail = resolvedItemType === 'video'
    ? (fallbackVideoThumbnail || asset?.thumbnail || undefined)
    : staticThumbnail;
  // Reserve the embedded-audio band from the first render. Thumbnail readiness
  // must never change clip geometry or move the fade/dB controls.
  const hasEmbeddedVideoAudio = resolvedItemType === 'video' && hasWaveform;
  const trackHeight = presentationTrackHeight
    ?? getTrackHeightForTrack(track, primaryTrackId);
  const reservesTranscriptWordbar = presentationReservesTranscriptWordbar
    ?? (!isDragOverlay && isSpokenMediaTrack(track, primaryTrackId));
  const maxItemHeight = trackHeight
    - (timeline.trackBubbleInset * 2)
    - (reservesTranscriptWordbar ? PRIMARY_TRANSCRIPT_WORDBAR_HEIGHT : 0);
  const itemHeight = maxItemHeight;
  const borderSize = isSelected ? 2 : 1;
  const availableHeight = itemHeight - (borderSize * 2);
  // For video items with both thumbnail and waveform, use a 7:3 ratio (thumbnail:waveform)
  // Keep existing behavior for other item types
  const thumbnailHeight = hasEmbeddedVideoAudio
    ? Math.max(1, Math.floor(availableHeight * 0.7))
    : (
      resolvedItemType === 'audio' && hasWaveform
        ? 0
        : (hasWaveform ? Math.floor(availableHeight * 0.6) : 44)
    );

  const fullVideoFrames = secondsToFrames(resolvedMediaDurationSeconds, fps);
  const fullVideoPixelWidth = frameToPixels(fullVideoFrames, pixelsPerFrame);
  const filmstripSampleCount = getAdaptiveFilmstripSampleCount({
    fullVideoPixelWidth,
    thumbnailHeight: Math.max(16, thumbnailHeight || itemHeight),
  });
  const filmstripCacheKey = persistentMediaCacheId
    ? `filmstrip:${persistentMediaCacheId}:${filmstripSampleCount}`
    : null;
  const filmstripCanvasWidth = React.useMemo(
    () => getBoundedFilmstripCanvasWidth(fullVideoPixelWidth),
    [fullVideoPixelWidth]
  );

  React.useEffect(() => {
    attemptedFilmstripKeyRef.current = null;
    setHasProgressiveFilmstripFrame(false);
  }, [filmstripCacheKey]);

  React.useEffect(() => {
    if (resolvedItemType !== 'video') {
      setFilmstripThumbnail(null);
      setFallbackVideoThumbnail(null);
      return;
    }

    setFilmstripThumbnail(filmstripCacheKey ? thumbnailCache.get(filmstripCacheKey) : null);
    setFallbackVideoThumbnail(
      fallbackThumbnailCacheKey ? thumbnailCache.get(fallbackThumbnailCacheKey) : null
    );
  }, [resolvedItemType, filmstripCacheKey, fallbackThumbnailCacheKey]);

  React.useEffect(() => {
    if (
      resolvedItemType !== 'video' ||
      !filmstripThumbnail
    ) {
      return;
    }

    let cancelled = false;
    const targetCanvas = progressiveFilmstripCanvasRef.current;
    const targetContext = targetCanvas?.getContext('2d');
    if (!targetCanvas || !targetContext) {
      return;
    }

    const destHeight = Math.max(16, Math.floor(hasWaveform ? thumbnailHeight : itemHeight));
    const renderCachedStrip = (image: HTMLImageElement) => {
      if (cancelled) {
        return;
      }

      const stripWidth = image.naturalWidth || image.width;
      const stripHeight = image.naturalHeight || image.height;
      if (!stripWidth || !stripHeight) {
        return;
      }

      const stripCanvas = document.createElement('canvas');
      stripCanvas.width = stripWidth;
      stripCanvas.height = stripHeight;
      const stripContext = stripCanvas.getContext('2d');
      if (!stripContext) {
        return;
      }

      stripContext.drawImage(image, 0, 0, stripWidth, stripHeight);

      const entry = createFilmstripCacheEntry({
        canvas: stripCanvas,
        sampleCount: filmstripSampleCount,
        duration: resolvedMediaDurationSeconds,
      });

      targetCanvas.width = filmstripCanvasWidth;
      targetCanvas.height = destHeight;
      targetContext.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
      renderFilmstripToCanvas({
        target: targetContext,
        entry,
        destHeight,
        fullVideoPixelWidth: filmstripCanvasWidth,
      });
      setHasProgressiveFilmstripFrame(true);
    };

    const image = new Image();
    image.decoding = 'async';
    image.onload = () => renderCachedStrip(image);
    image.onerror = () => {
      if (!cancelled) {
        setHasProgressiveFilmstripFrame(false);
      }
    };
    image.src = filmstripThumbnail;

    if (image.complete && image.naturalWidth > 0) {
      renderCachedStrip(image);
    }

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [
    resolvedItemType,
    filmstripThumbnail,
    resolvedMediaDurationSeconds,
    filmstripCanvasWidth,
    hasWaveform,
    thumbnailHeight,
    itemHeight,
    filmstripSampleCount,
  ]);

  React.useEffect(() => {
    if (
      resolvedItemType !== 'video' ||
      !resolvedItemSrc ||
      !fallbackThumbnailCacheKey ||
      filmstripThumbnail ||
      fallbackVideoThumbnail ||
      asset?.thumbnail
    ) {
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let idleId: number | null = null;

    const run = async () => {
      const generationId = fallbackThumbnailGenerationRef.current + 1;
      fallbackThumbnailGenerationRef.current = generationId;

      const cached = thumbnailCache.get(fallbackThumbnailCacheKey);
      if (cached) {
        if (!cancelled && fallbackThumbnailGenerationRef.current === generationId) {
          setFallbackVideoThumbnail(cached);
        }
        return;
      }

      const generated = await generateVideoThumbnailAtTime(
        resolvedItemSrc,
        sourceStartInFrames / fps
      );

      if (
        cancelled ||
        fallbackThumbnailGenerationRef.current !== generationId ||
        !generated
      ) {
        return;
      }

      thumbnailCache.set(fallbackThumbnailCacheKey, generated);
      setFallbackVideoThumbnail(generated);
    };

    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(run, { timeout: 500 });
    } else {
      timeoutId = setTimeout(run, 120);
    }

    return () => {
      cancelled = true;
      if (idleId !== null && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [
    resolvedItemType,
    resolvedItemSrc,
    fallbackThumbnailCacheKey,
    filmstripThumbnail,
    fallbackVideoThumbnail,
    asset?.thumbnail,
    sourceStartInFrames,
    fps,
  ]);

  React.useEffect(() => {
    if (
      resolvedItemType !== 'video' ||
      !resolvedItemSrc ||
      resolvedMediaDurationSeconds <= 0 ||
      !filmstripCacheKey ||
      filmstripThumbnail ||
      attemptedFilmstripKeyRef.current === filmstripCacheKey
    ) {
      return;
    }

    attemptedFilmstripKeyRef.current = filmstripCacheKey;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let idleId: number | null = null;

    const run = async () => {
      setIsGeneratingThumbnail(true);
      setHasProgressiveFilmstripFrame(false);
      const generationId = filmstripGenerationRef.current + 1;
      filmstripGenerationRef.current = generationId;
      const destHeight = Math.max(16, Math.floor(hasWaveform ? thumbnailHeight : itemHeight));
      const previewCanvas = progressiveFilmstripCanvasRef.current;
      const previewContext = previewCanvas?.getContext('2d');
      let progressiveMapping: ReturnType<typeof createFilmstripColumnMapping> | null = null;

      if (previewCanvas && previewContext) {
        previewCanvas.width = filmstripCanvasWidth;
        previewCanvas.height = destHeight;
        previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      }

      const generated = await getOrCreatePendingTask(
        pendingFilmstripBuilds,
        filmstripCacheKey,
        () =>
          enqueueFilmstripBuild(() =>
            generateVideoFilmstrip({
              videoSrc: resolvedItemSrc,
              duration: resolvedMediaDurationSeconds,
              sampleCount: filmstripSampleCount,
              onSample:
                previewContext && previewCanvas
                  ? (snapshot: FilmstripCacheEntry, sampleIndex: number) => {
                    if (cancelled || filmstripGenerationRef.current !== generationId) {
                      return;
                    }

                    progressiveMapping ??= createFilmstripColumnMapping({
                      entry: snapshot,
                      destHeight,
                      fullVideoPixelWidth: filmstripCanvasWidth,
                    });

                    const drawnColumns = drawFilmstripColumnsForSample({
                      target: previewContext,
                      entry: snapshot,
                      mapping: progressiveMapping,
                      sampleIndex,
                      destHeight,
                    });

                    if (drawnColumns > 0) {
                      setHasProgressiveFilmstripFrame(true);
                    }
                  }
                  : undefined,
            })
          )
      );

      if (cancelled || filmstripGenerationRef.current !== generationId) {
        return;
      }

      if (generated) {
        thumbnailCache.set(filmstripCacheKey, generated);
        setFilmstripThumbnail(generated);
      }

      setIsGeneratingThumbnail(false);
    };

    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(run, { timeout: 700 });
    } else {
      timeoutId = setTimeout(run, 120);
    }

    return () => {
      cancelled = true;
      if (idleId !== null && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      setIsGeneratingThumbnail(false);
      setHasProgressiveFilmstripFrame(false);
    };
  }, [
    resolvedItemType,
    resolvedItemSrc,
    resolvedMediaDurationSeconds,
    filmstripCacheKey,
    filmstripThumbnail,
    filmstripCanvasWidth,
    hasWaveform,
    thumbnailHeight,
    itemHeight,
    filmstripSampleCount,
  ]);

  // Match 3:7 ratio when video has waveform; otherwise keep previous calculation
  const waveformHeight = hasWaveform
    ? (hasEmbeddedVideoAudio
      ? Math.max(0, availableHeight - thumbnailHeight)
      : availableHeight)
    : 0;

  // Canonical Timeline DSL fields win; legacy aliases remain readable only.
  const audioFadeIn = resolveAudioFadeInFrames(item);
  const audioFadeOut = resolveAudioFadeOutFrames(item);
  const maxFadeFrames = Math.floor((item.durationInFrames * 2) / 3);
  const itemVolumeDb = resolveAudioGainDb(item);
  const displayedVolumeDb = draggingVolumeDb ?? itemVolumeDb;
  const audioLaneTop = hasEmbeddedVideoAudio ? thumbnailHeight : 0;
  const audioLaneHeight = Math.max(1, waveformHeight);
  const audioLaneBottom = audioLaneTop + audioLaneHeight;
  const volumeLineY = audioLaneTop + audioGainDbToLaneY(displayedVolumeDb, audioLaneHeight);
  const fadeInWidth = Math.min(width, audioFadeIn * pixelsPerFrame);
  const fadeOutWidth = Math.min(width, audioFadeOut * pixelsPerFrame);

  const getItemLabel = () => getTimelineItemDisplayLabel({
    type: resolvedItemType,
    text: resolvedItemType === 'text' ? (item as any).text : undefined,
    assetName: asset?.name,
  });

  // Keep sample geometry independent of zoom. SVG maps these source-sample
  // coordinates to the current width without regenerating thousands of points.
  const waveformCoordinateWidth = Math.max(1, (itemWaveform?.length ?? 0) - 1);
  const envelopePath = React.useMemo(() => itemWaveform ? createOneSidedWaveformPath({
    waveform: itemWaveform,
    width: waveformCoordinateWidth,
    height: waveformHeight,
    volume: 1,
  }) : '', [itemWaveform, waveformCoordinateWidth, waveformHeight]);

  const renderWaveform = (
    waveform: number[],
    height: number
  ) => {
    // Persisted local assets may not have duration metadata yet. The clip
    // duration remains a useful, visible fallback until probing completes.
    const fullWidth = frameToPixels(fullVideoFrames, pixelsPerFrame);

    const waveformColor = colors.audio.waveform;

    return (
      <svg
        width={fullWidth}
        height={height}
        viewBox={`0 0 ${waveformCoordinateWidth} ${height}`}
        data-waveform-renderer="one-sided-area"
        data-waveform-sample-count={waveform.length}
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          pointerEvents: 'none',
        }}
        preserveAspectRatio="none"
      >
        <line
          data-waveform-baseline=""
          x1={0}
          x2={waveformCoordinateWidth}
          y1={Math.max(0, height - 0.5)}
          y2={Math.max(0, height - 0.5)}
          stroke={waveformColor}
          strokeOpacity={0.18}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <path
          data-waveform-envelope=""
          d={envelopePath}
          fill={waveformColor}
          fillOpacity={0.9}
        />
      </svg>
    );
  };

  const renderAudioControls = () => {
    if (!hasWaveform || availableHeight <= 0) return null;

    return (
      <svg
        data-audio-volume-control=""
        width={width}
        height={availableHeight}
        style={{
          inset: 0,
          overflow: 'visible',
          pointerEvents: 'none',
          position: 'absolute',
          zIndex: 3,
        }}
      >
        <line
          data-volume-db-line=""
          x1={0}
          x2={width}
          y1={volumeLineY}
          y2={volumeLineY}
          stroke={colors.audio.volumeLine}
          strokeWidth={0.75}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  };

  const updateFade = useCallback((type: 'in' | 'out', value: number) => {
    const frames = Math.max(0, Math.min(maxFadeFrames, Math.round(value)));
    onUpdate(
      item.id,
      type === 'in'
        ? { audioFadeInFrames: frames, audioFadeIn: undefined }
        : { audioFadeOutFrames: frames, audioFadeOut: undefined },
    );
  }, [item.id, maxFadeFrames, onUpdate]);

  const updateVolumeDb = useCallback((value: number) => {
    onUpdate(item.id, {
      audioGainDb: clampAudioGainDb(value),
      volume: undefined,
    });
  }, [item.id, onUpdate]);

  const getTimelineItemRect = (element: HTMLElement): DOMRect => {
    const timelineItem = element.closest('.timeline-item') as HTMLElement | null;
    return (timelineItem ?? element).getBoundingClientRect();
  };

  const moveFadeFromPointer = (
    type: 'in' | 'out',
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (draggingFade?.type !== type) return;
    const rect = getTimelineItemRect(event.currentTarget);
    const pixelOffset = type === 'in'
      ? event.clientX - rect.left - borderSize
      : rect.right - borderSize - event.clientX;
    updateFade(type, pixelOffset / Math.max(0.001, pixelsPerFrame));
  };

  const moveVolumeFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (draggingVolumeDb === null) return;
    const rect = getTimelineItemRect(event.currentTarget);
    const db = laneYToAudioGainDb(
      event.clientY - rect.top - borderSize - audioLaneTop,
      audioLaneHeight,
    );
    setDraggingVolumeDb(db);
    updateVolumeDb(db);
  };

  // Text editing handlers (use resolved type)
  const handleTextEdit = () => {
    if (resolvedItemType === 'text') {
      setTempText((item as any).text);
      setIsEditingText(true);
    }
  };

  const handleTextSave = () => {
    if (resolvedItemType === 'text' && tempText.trim()) {
      onUpdate(
        item.id,
        createTimelineTextEditUpdates(item as Extract<Item, { type: 'text' }>, tempText.trim()),
      );
    }
    setIsEditingText(false);
  };

  const handleTextCancel = () => {
    setIsEditingText(false);
    setTempText('');
  };

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect();
  }, [onSelect]);

  const resizeOrigin = React.useRef<{
    pixelsPerFrame: number;
    onResize: typeof onResize;
    onRollEdit: typeof onRollEdit;
  } | null>(null);
  const resizeGestureBind = useDragGesture<PointerEvent>(
    ({ first, last, movement: [movementX], args: [edge, isRollEdit], event }) => {
      event.preventDefault();
      event.stopPropagation();

      if (first) {
        // use-gesture movement is measured from pointer-down. Keep the geometry
        // captured by these callbacks, even as each update renders new props.
        resizeOrigin.current = { pixelsPerFrame, onResize, onRollEdit };
        setResizingEdge(edge);
        onResizeStart?.(edge);
      }

      const origin = resizeOrigin.current;
      if (!origin) return;
      const deltaFrames = Math.round(movementX / origin.pixelsPerFrame);

      if (isRollEdit && origin.onRollEdit) {
        origin.onRollEdit(edge, deltaFrames);
      } else {
        origin.onResize?.(edge, deltaFrames);
      }

      const viewportEl = (event.currentTarget as HTMLElement | null)?.closest('.tracks-viewport') as HTMLDivElement | null;
      if (viewportEl) {
        const SCROLL_EDGE = 40;
        const MAX_STEP = 40;
        const viewportRect = viewportEl.getBoundingClientRect();
        const pointerX = event.clientX;
        let step = 0;

        if (pointerX > viewportRect.right - SCROLL_EDGE) {
          step = Math.min(MAX_STEP, (pointerX - (viewportRect.right - SCROLL_EDGE)) * 0.5);
        } else if (pointerX < viewportRect.left + SCROLL_EDGE) {
          step = -Math.min(MAX_STEP, ((viewportRect.left + SCROLL_EDGE) - pointerX) * 0.5);
        }

        if (step !== 0) {
          viewportEl.scrollLeft += step;
        }
      }

      if (last) {
        resizeOrigin.current = null;
        setResizingEdge(null);
        onResizeEnd?.();
      }
    },
    {
      preventDefault: true,
      pointer: { capture: true },
      eventOptions: { passive: false },
    },
  );

  // dnd-kit draggable (overlay-only integration; does not alter static layout)
  // DragOverlay中的item不需要draggable
  const draggableHook = useDraggable({
    id: `item-${item.id}`,
    data: {
      item,
      trackId,
      from: item.from,
      durationInFrames: item.durationInFrames,
    },
    disabled: isDragOverlay, // DragOverlay中禁用draggable
  });
  
  const {attributes, listeners, setNodeRef, isDragging} = isDragOverlay 
    ? { attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }
    : draggableHook;

  // Decoupled renderers: first enable for image/text, others keep existing path
  // Use resolved type for determining which renderer to use
  const useNewRenderer = resolvedItemType === 'image' || resolvedItemType === 'text';

  // Create a resolved item with type for the renderer registry
  const resolvedItemForRenderer = React.useMemo(() => {
    if (item.type) return item;
    // If item.type is not set, create a copy with resolved type
    return resolvedItemType ? { ...(item as BaseItem), type: resolvedItemType } as Item : item;
  }, [item, resolvedItemType]);

  const Renderer = React.useMemo(() => getRendererForItem(resolvedItemForRenderer), [resolvedItemForRenderer]);

  return (
    <div
      // dnd-kit takes over dragging; disable native dragging to avoid conflicts
      draggable={false}
      ref={setNodeRef}
      {...attributes}
      data-dnd-id={`item-${item.id}`}
      data-agent-annotation-object-id={item.id}
      data-agent-annotation-object-type={`timeline-${resolvedItemType ?? 'item'}`}
      data-agent-annotation-object-label={getItemLabel()}
      data-agent-annotation-parent-id={trackId}
      role={isDragOverlay ? undefined : 'button'}
      tabIndex={isDragOverlay ? undefined : 0}
      aria-label={`${resolvedItemType ?? 'item'}: ${getItemLabel()}`}
      aria-pressed={isSelected}
      className="timeline-item"
      onMouseEnter={() => {
        setIsHovered(true);
      }}
      onMouseLeave={() => {
        setIsHovered(false);
        setHoveredResizeEdge(null);
      }}
      onClick={handleClick}
      onDoubleClick={handleTextEdit}
      onContextMenu={() => {
        if (isDragOverlay) return;
        onAnnotationTargetContextMenu?.({
          objectId: item.id,
          objectType: `timeline-${resolvedItemType ?? 'item'}`,
          objectLabel: getItemLabel(),
          parentId: trackId,
        });
      }}
      style={{
        position: isDragOverlay ? undefined : 'absolute',
        left: isDragOverlay ? undefined : frameToPixels(item.from, pixelsPerFrame),
        width: width,
        height: `${itemHeight}px`,
        top: isDragOverlay
          ? undefined
          : reservesTranscriptWordbar
            ? timeline.trackBubbleInset
            : '50%',
        transform: isDragOverlay || reservesTranscriptWordbar ? undefined : 'translateY(-50%)',
        backgroundColor: itemTone.background,
        borderRadius: `${timeline.itemBorderRadius}px`,
        border: isSelected
          ? `${borderSize}px solid ${colors.bg.primary}`
          : `${borderSize}px solid transparent`,
        boxShadow: isSelected
          ? shadows.itemSelected
          : (isHovered ? shadows.itemHover : shadows.itemRest),
        cursor: 'move',
        overflow: 'visible', // 改为 visible,让 resize handles 可以延伸出去
        boxSizing: 'border-box',
        opacity: isDragging ? 0 : (track.hidden ? 0.3 : 1),
        outline: isDragging ? '1px dashed rgba(0, 153, 255, 0.8)' : 'none',
        transition: 'box-shadow 150ms ease, opacity 150ms ease',
        ...customStyle, // 应用自定义样式（可以覆盖默认样式，如opacity）
      }}
    >
      {/* 内层可拖动区域 - 排除 resize handles,让它们可以独立工作 */}
      <div
        {...listeners}
        style={{
          position: 'absolute',
          inset: '0 6px 0 6px', // 左右各留出 6px,因为 handles 向外延伸
          cursor: 'move',
          zIndex: 5,
          pointerEvents: 'auto', // 确保可以捕获拖动事件
        }}
      />

      {/* 内容裁剪容器 - 防止内容溢出到 resize handles */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          pointerEvents: 'none', // 让事件穿透到内层元素
          borderRadius: `${timeline.itemBorderRadius}px`,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.24)',
        }}
      >
        {/* 背景图片(非视频类型) - use resolved type */}
        {!useNewRenderer && resolvedItemType !== 'video' && resolvedItemType !== 'audio' && displayThumbnail && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: `url(${displayThumbnail})`,
              backgroundSize: 'cover',
              backgroundPosition: 'left top',
              backgroundRepeat: 'no-repeat',
            }}
          />
        )}

        {/* New renderer (image/text) */}
        {useNewRenderer && (
          <div style={{ position: 'absolute', inset: 0 }}>
            <Renderer item={resolvedItemForRenderer} asset={asset} width={width} height={resolvedItemType === 'text' ? availableHeight - getTextKeyframeBandHeight(track, primaryTrackId) : itemHeight} pixelsPerFrame={pixelsPerFrame} />
          </div>
        )}

        {/* Thumbnail for video (with or without waveform) - use resolved type */}
        {resolvedItemType === 'video' && (
          <div
            data-thumbnail-id={item.id}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: hasWaveform ? `${thumbnailHeight}px` : '100%',
              zIndex: 1,
              overflow: 'hidden',
              backgroundColor: displayThumbnail ? 'transparent' : '#000',
              backgroundImage: displayThumbnail ? `url(${displayThumbnail})` : undefined,
              backgroundSize: 'auto 100%',
              backgroundPosition: 'left top',
              backgroundRepeat: 'repeat-x',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                height: '100%',
                width: `${fullVideoPixelWidth}px`,
                transform: `translateX(${(-(sourceStartInFrames) * pixelsPerFrame)}px)`,
                willChange: 'transform',
                opacity: hasProgressiveFilmstripFrame ? 1 : 0,
              }}
            >
              <canvas
                ref={progressiveFilmstripCanvasRef}
                data-filmstrip-renderer="adaptive-sample-buckets"
                data-filmstrip-sample-count={filmstripSampleCount}
                data-filmstrip-backing-width={filmstripCanvasWidth}
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'block',
                }}
              />
            </div>
            {isGeneratingThumbnail && !displayThumbnail && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                }}
              />
            )}
          </div>
      )}

      {/* Waveform */}
      {hasWaveform && itemWaveform && (
        <div
          ref={waveformContainerRef}
          data-waveform-id={item.id}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: `${waveformHeight}px`,
            backgroundColor: colors.item.audio,
            overflow: 'hidden',
            zIndex: 2,
            contain: 'strict',
          }}
        >
          {/* 内容容器：通过 transform 平移显示正确的波形部分 */}
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              height: '100%',
              transform: `translateX(${(-((item as any).sourceStartInFrames || 0) * pixelsPerFrame)}px)`,
              willChange: 'transform',
            }}
          >
            {itemWaveform ? renderWaveform(itemWaveform, waveformHeight) : null}
          </div>
        </div>
      )}

      {hasWaveform && (resolvedItemType === 'audio' || resolvedItemType === 'video') ? (
        <AudioFadeEnvelope
          width={width}
          height={availableHeight}
          boundaryY={audioLaneTop}
          bottomY={audioLaneBottom}
          fadeInWidth={fadeInWidth}
          fadeOutWidth={fadeOutWidth}
        />
      ) : null}
      {renderAudioControls()}
      </div>
      {/* 内容裁剪容器结束 */}

      {isSelected && !isDragOverlay
        ? getTimelineKeyframeMarkers(item).map((marker) => {
          const layout = getTimelineKeyframeMarkerLayout(marker);
          const glyphPath = layout.glyph === 'start-cap'
            ? 'M 1 2 L 5 6 L 1 10 Z'
            : layout.glyph === 'end-cap'
              ? 'M 11 2 L 7 6 L 11 10 Z'
              : 'M 6 2 L 10 6 L 6 10 L 2 6 Z';
          return (
            <button
              key={marker.frame}
              type="button"
              aria-label={`Go to ${marker.channels.join(', ')} keyframe${marker.channels.length === 1 ? '' : 's'} at frame ${marker.frame}`}
              data-timeline-keyframe-marker=""
              data-keyframe-channels={marker.channels.join(',')}
              data-keyframe-edge={marker.edge}
              data-keyframe-frame={marker.frame}
              data-keyframe-count={marker.channels.length}
              data-keyframe-glyph={layout.glyph}
              title={`${marker.channels.join(' + ')} · frame ${marker.frame}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                dispatch({
                  type: 'SET_CURRENT_FRAME',
                  payload: item.from + marker.frame,
                });
              }}
              style={{
                position: 'absolute',
                bottom: layout.bottom,
                left: layout.buttonLeft,
                width: 18,
                height: 18,
                padding: 0,
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                transform: layout.buttonTransform,
                zIndex: 9,
              }}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 12 12"
                width="12"
                height="12"
                style={{
                  position: 'absolute',
                  top: 3,
                  left: layout.glyph === 'start-cap'
                    ? -1
                    : layout.glyph === 'diamond'
                      ? 3
                      : undefined,
                  right: layout.glyph === 'end-cap' ? -1 : undefined,
                  overflow: 'visible',
                  pointerEvents: 'none',
                }}
              >
                {marker.channels.length > 1 ? (
                  <path
                    d={glyphPath}
                    fill="none"
                    stroke="rgba(255,107,82,0.3)"
                    strokeWidth="4"
                    strokeLinejoin="round"
                  />
                ) : null}
                <path
                  d={glyphPath}
                  fill={colors.accent.primary}
                  stroke="rgba(255,255,255,0.9)"
                  strokeWidth="1"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          );
        })
        : null}

      {/* Gain is an interior track event. Its 12px hit target follows the
          horizontal line and never covers the full clip or either fade point. */}
      {hasWaveform && (resolvedItemType === 'audio' || resolvedItemType === 'video') ? (
        <>
          <div
            data-volume-db-hit-target=""
            role="slider"
            tabIndex={0}
            aria-label="Volume level"
            aria-orientation="vertical"
            aria-valuemin={AUDIO_GAIN_DB_MIN}
            aria-valuemax={AUDIO_GAIN_DB_MAX}
            aria-valuenow={displayedVolumeDb}
            aria-valuetext={formatDb(displayedVolumeDb)}
            title={isHovered ? `Volume: ${formatDb(displayedVolumeDb)}` : ''}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture?.(event.pointerId);
              setDraggingVolumeDb(itemVolumeDb);
            }}
            onPointerMove={moveVolumeFromPointer}
            onPointerUp={(event) => {
              event.stopPropagation();
              event.currentTarget.releasePointerCapture?.(event.pointerId);
              setDraggingVolumeDb(null);
            }}
            onPointerCancel={() => setDraggingVolumeDb(null)}
            onBlur={() => setDraggingVolumeDb(null)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              const delta = event.key === 'ArrowUp' || event.key === 'ArrowRight'
                ? 0.5
                : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
                  ? -0.5
                  : 0;
              if (delta === 0) return;
              event.preventDefault();
              updateVolumeDb(displayedVolumeDb + delta);
            }}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${volumeLineY - 6}px`,
              width: '100%',
              height: '12px',
              cursor: 'ns-resize',
              opacity: 0,
              pointerEvents: isHovered || draggingVolumeDb !== null ? 'auto' : 'none',
              touchAction: 'none',
              zIndex: 32,
            }}
          />
          {draggingVolumeDb !== null ? (
            <span
              data-volume-db-readout=""
              style={{
                background: 'rgba(15, 22, 27, 0.94)',
                borderRadius: 5,
                color: '#fff',
                fontSize: 11,
                fontWeight: 650,
                left: Math.max(8, Math.min(width - 58, width * 0.25)),
                padding: '3px 6px',
                pointerEvents: 'none',
                position: 'absolute',
                top: Math.max(3, volumeLineY - 25),
                zIndex: 34,
              }}
            >
              {formatDb(draggingVolumeDb)}
            </span>
          ) : null}
        </>
      ) : null}

      {/* Fade handles sit on the waveform boundary. The persistent black mask
          and thin envelope line are rendered below the independent dB line. */}
      {hasWaveform && (resolvedItemType === 'audio' || resolvedItemType === 'video') ? (
        <div
          data-audio-fade-handles=""
          style={{
            inset: 0,
            pointerEvents: 'none',
            position: 'absolute',
            zIndex: 33,
          }}
        >
          {isHovered || draggingFade ? (
            <>
              <div
                data-audio-fade-handle="in"
                role="slider"
                tabIndex={0}
                aria-label="Fade in duration"
                aria-valuemin={0}
                aria-valuemax={maxFadeFrames}
                aria-valuenow={audioFadeIn}
                aria-valuetext={`${(audioFadeIn / fps).toFixed(2)} seconds`}
                title={`Fade In: ${(audioFadeIn / fps).toFixed(2)}s`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  setDraggingFade({ type: 'in' });
                }}
                onPointerMove={(event) => moveFadeFromPointer('in', event)}
                onPointerUp={(event) => {
                  event.stopPropagation();
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                  setDraggingFade(null);
                }}
                onPointerCancel={() => setDraggingFade(null)}
                onBlur={() => setDraggingFade(null)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  const delta = event.key === 'ArrowRight'
                    ? 1
                    : event.key === 'ArrowLeft'
                      ? -1
                      : 0;
                  if (delta === 0) return;
                  event.preventDefault();
                  updateFade('in', audioFadeIn + delta);
                }}
                style={{
                  background: colors.bg.elevated,
                  border: `1px solid ${colors.audio.fadeEdge}`,
                  borderRadius: '50%',
                  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.36)',
                  cursor: 'ew-resize',
                  height: '10px',
                  left: `${fadeInWidth - 5}px`,
                  pointerEvents: 'auto',
                  position: 'absolute',
                  top: `${audioLaneTop - 5}px`,
                  touchAction: 'none',
                  width: '10px',
                }}
              />
              <div
                data-audio-fade-handle="out"
                role="slider"
                tabIndex={0}
                aria-label="Fade out duration"
                aria-valuemin={0}
                aria-valuemax={maxFadeFrames}
                aria-valuenow={audioFadeOut}
                aria-valuetext={`${(audioFadeOut / fps).toFixed(2)} seconds`}
                title={`Fade Out: ${(audioFadeOut / fps).toFixed(2)}s`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  setDraggingFade({ type: 'out' });
                }}
                onPointerMove={(event) => moveFadeFromPointer('out', event)}
                onPointerUp={(event) => {
                  event.stopPropagation();
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                  setDraggingFade(null);
                }}
                onPointerCancel={() => setDraggingFade(null)}
                onBlur={() => setDraggingFade(null)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  const delta = event.key === 'ArrowLeft'
                    ? 1
                    : event.key === 'ArrowRight'
                      ? -1
                      : 0;
                  if (delta === 0) return;
                  event.preventDefault();
                  updateFade('out', audioFadeOut + delta);
                }}
                style={{
                  background: colors.bg.elevated,
                  border: `1px solid ${colors.audio.fadeEdge}`,
                  borderRadius: '50%',
                  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.36)',
                  cursor: 'ew-resize',
                  height: '10px',
                  pointerEvents: 'auto',
                  position: 'absolute',
                  right: `${fadeOutWidth - 5}px`,
                  top: `${audioLaneTop - 5}px`,
                  touchAction: 'none',
                  width: '10px',
                }}
              />
            </>
          ) : null}
          {draggingFade?.type === 'in' ? (
            <span
              data-audio-fade-readout="in"
              style={{
                background: 'rgba(15, 22, 27, 0.94)',
                borderRadius: 5,
                color: '#fff',
                fontSize: 11,
                fontWeight: 650,
                left: Math.max(4, Math.min(width - 50, fadeInWidth - 22)),
                padding: '3px 6px',
                pointerEvents: 'none',
                position: 'absolute',
                top: 10,
                zIndex: 34,
              }}
            >
              {(audioFadeIn / fps).toFixed(2)}s
            </span>
          ) : null}
          {draggingFade?.type === 'out' ? (
            <span
              data-audio-fade-readout="out"
              style={{
                background: 'rgba(15, 22, 27, 0.94)',
                borderRadius: 5,
                color: '#fff',
                fontSize: 11,
                fontWeight: 650,
                padding: '3px 6px',
                pointerEvents: 'none',
                position: 'absolute',
                right: Math.max(4, Math.min(width - 50, fadeOutWidth - 22)),
                top: 10,
                zIndex: 34,
              }}
            >
              {(audioFadeOut / fps).toFixed(2)}s
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Media labels stay separate; Text renderers already draw the editable
          sticker copy and only need this overlay while inline editing. */}
      {(resolvedItemType !== 'text' || isEditingText) ? <span style={{
        position: 'absolute',
        top: '4px',
        right: '4px',
        fontSize: '12px',
        color: (displayThumbnail || hasWaveform) ? '#ffffff' : itemTone.foreground,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        backgroundColor: (displayThumbnail || hasWaveform) ? 'rgba(0, 0, 0, 0.7)' : 'transparent',
        padding: (displayThumbnail || hasWaveform) ? '2px 6px' : '0',
        borderRadius: (displayThumbnail || hasWaveform) ? '3px' : '0',
        zIndex: 1,
        maxWidth: 'calc(100% - 16px)',
        pointerEvents: 'none',
      }}>
        {isEditingText && resolvedItemType === 'text' ? (
          <TimelineTextInput
            value={tempText}
            onChange={(e) => setTempText(e.target.value)}
            onBlur={handleTextSave}
            onCommit={handleTextSave}
            onCancel={handleTextCancel}
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#FFFFFF',
              width: '100%',
              font: 'inherit',
            }}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          getItemLabel()
        )}
      </span> : null}

      {/* Resize handles */}
      {/* Stable transparent targets; only the edge under the pointer lights up. */}
      {!isDragOverlay && (
        <>
          {/* 左边缘手柄 - 向左延伸,覆盖边界 */}
          <div
            {...resizeGestureBind('left', Boolean(hasAdjacentItemOnLeft && onRollEdit))}
            data-timeline-resize-edge="left"
            onPointerEnter={() => setHoveredResizeEdge('left')}
            onPointerLeave={() => setHoveredResizeEdge(null)}
            style={{
              position: 'absolute',
              left: -6,  // 向左延伸 6px,覆盖边界
              top: 0,
              bottom: 0,
              width: 12,
              cursor: 'ew-resize',
              zIndex: 10,
              backgroundColor: 'transparent',
              touchAction: 'none', // 防止触摸事件干扰
            }}
          >
            {(hoveredResizeEdge === 'left' || resizingEdge === 'left') && <div data-resize-edge-line="" style={{ position: 'absolute', left: 6, top: 4, bottom: 4, width: 2, borderRadius: 1, background: colors.accent.primary, pointerEvents: 'none' }} />}
          </div>
          {/* 右边缘手柄 - 向右延伸,覆盖边界 */}
          <div
            {...resizeGestureBind('right', Boolean(hasAdjacentItemOnRight && onRollEdit))}
            data-timeline-resize-edge="right"
            onPointerEnter={() => setHoveredResizeEdge('right')}
            onPointerLeave={() => setHoveredResizeEdge(null)}
            style={{
              position: 'absolute',
              right: -6,  // 向右延伸 6px,覆盖边界
              top: 0,
              bottom: 0,
              width: 12,
              cursor: 'ew-resize',
              zIndex: 10,
              backgroundColor: 'transparent',
              touchAction: 'none', // 防止触摸事件干扰
            }}
          >
            {(hoveredResizeEdge === 'right' || resizingEdge === 'right') && <div data-resize-edge-line="" style={{ position: 'absolute', right: 6, top: 4, bottom: 4, width: 2, borderRadius: 1, background: colors.accent.primary, pointerEvents: 'none' }} />}
          </div>
        </>
      )}

    </div>
  );
};
