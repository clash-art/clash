import React, { useState, useRef, useEffect, useCallback, Fragment } from 'react';
import { createPortal } from 'react-dom';
import {
  findAssetForItem,
  getItemAssetDurationInFrames,
  inferTrackCategory,
  isSpokenMediaTrack,
  useEditorDispatch,
  useEditorHistory,
  useEditorPlaybackRefs,
  useEditorStaticState,
} from '@clash/remotion-core';
import type { Asset, Item, Track, TrackCategory, TransitionItem } from '@clash/remotion-core';
import type { AgentAnnotationObjectRef } from '@clash/shared-types';
import { ScrollViewport } from '@clash/gui/components/ui/scroll-viewport';
import { colors, timeline, spacing, shadows, typography } from './styles';
import { secondsToFrames } from './utils/timeFormatter';
import { TimelineItem } from './TimelineItem';
import { indexItemNeighbors } from './itemNeighbors';
import { currentDraggedAsset, currentAssetDragOffset } from '../AssetPanel';
import { resolveAssetDropPayload } from './assetDropPayload';
import { calculateResizeSnap } from './utils/snapCalculator';
import { getTrackHeightForTrack } from './trackGeometry';
import { getContinuousTransitionBoundaries } from '../../library/applyTimelineLibraryItem';
import { PrimaryTranscriptWordbar } from './PrimaryTranscriptWordbar';
import {
  createTimelineInsertProperties,
  TIMELINE_INSERT_MEDIA_FIT,
} from './insertAssetRequest';

// Declare the global window property for TypeScript
declare global {
  interface Window {
    currentDraggedItem: { item: Item; trackId: string } | null;
  }
}

// Tracks viewport + labels with drag/drop and scroll syncing.
// Notes:
// - `onScrollXChange` keeps ruler and playhead horizontally aligned with tracks.
// - `viewportWidth` prevents empty timeline from scrolling and keeps ruler/track widths stable.
interface TimelineTracksContainerProps {
  durationInFrames: number;
  pixelsPerFrame: number;
  fps: number;
  snapEnabled?: boolean;
  selectedTrackId: string | null;
  selectedItemId: string | null;
  assets: Asset[];
  onSelectTrack: (trackId: string) => void;
  onSelectItem: (itemId: string) => void;
  onDeleteItem: (trackId: string, itemId: string) => void;
  onUpdateItem: (trackId: string, itemId: string, updates: Partial<Item>) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (trackId: string, e: React.DragEvent) => void;
  onEmptyDrop: (e: React.DragEvent) => void;
  onItemDragStart: (e: React.DragEvent, trackId: string, item: Item) => void;
  onItemDragOver: (e: React.DragEvent, trackId: string) => void;
  onItemDrop: (e: React.DragEvent, trackId: string) => void;
  onItemDragEnd: () => void;
  dragPreview: {
    itemId: string;
    item: Item;
    originalTrackId: string;
    originalFrom: number;
    previewTrackId: string;
    previewFrame: number;
    // Optional raw snapped frame before any collision push; used when creating new tracks
    rawPreviewFrame?: number;
    // Snap visualization
    snapEdge?: 'left' | 'right' | null;
    snapTargetType?: 'item-start' | 'item-end' | 'playhead' | 'track-start' | 'grid' | undefined | null;
    snapGuideFrame?: number | null;
    invalidTarget?: boolean;
  } | null;
  // Asset drag preview from AssetPanel
  assetDragPreview?: {
    item: Item;
    trackId: string;
    isTemporaryTrack: boolean;
    insertIndex?: number;
  } | null;
  // Horizontal scroll sync – report viewport scrollLeft to parent
  onScrollXChange?: (scrollLeft: number) => void;
  onViewportElementChange?: (viewport: HTMLDivElement | null) => void;
  // Available viewport content width (without labels), used to clamp min width
  viewportWidth?: number;
  // If provided, render labels panel into this element via portal
  labelsPortal?: HTMLElement | null;
  // Visual left inset for right content (px). Applied as padding on the tracks viewport.
  contentInsetLeftPx?: number;
  // External insert position (for dnd-kit drags). If provided, overrides internal detection
  externalInsertPosition?: number | null;
  onAnnotationTargetContextMenu?: (target: AgentAnnotationObjectRef) => void;
  showTranscriptTimeline?: boolean;
  previewCacheScope?: string;
}

// Store dragged data globally to work around dataTransfer issues
let globalDragData: { assetId?: string; quickAdd?: string; quickAddType?: string; asset?: string } = {};

// Hoisted once: avoids re-allocating this string (and its <style> child) on every render.
const TRACK_LABELS_SCROLLBAR_CSS = `.track-labels-panel::-webkit-scrollbar{display:none;}`;
const GLOBAL_TRANSCRIPT_LANE_HEIGHT = 36;

// Lanes of one kind read as one thing: every track in a category shares the
// canonical category name instead of exposing per-track custom names.
const CATEGORY_TRACK_LABELS: Record<TrackCategory, string> = {
  effect: 'Effects',
  text: 'Text',
  visual: 'Media',
  primary: 'Media',
  audio: 'Audio',
};

const getTimelineTrackLabel = (
  track: Track,
  isPrimary: boolean,
  primaryTrackId?: string | null,
): string => {
  if (isPrimary) return CATEGORY_TRACK_LABELS.primary;
  const category = inferTrackCategory(track, primaryTrackId);
  return category ? CATEGORY_TRACK_LABELS[category] : track.name;
};

const TrackCategoryIcon: React.FC<{ category: TrackCategory; isPrimary: boolean }> = ({ category, isPrimary }) => {
  const common = {
    width: 15,
    height: 15,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  let glyph: React.ReactNode;
  if (category === 'effect') {
    glyph = <path d="M8 1.9l1.35 3.55L13 6.8l-3.65 1.35L8 11.8 6.65 8.15 3 6.8l3.65-1.35L8 1.9Z" />;
  } else if (category === 'text') {
    glyph = <><path d="M3 3.5h10" /><path d="M8 3.5v9" /><path d="M5.5 12.5h5" /></>;
  } else if (category === 'audio') {
    glyph = <><path d="M3 6v4" /><path d="M6.3 3.5v9" /><path d="M9.7 5v6" /><path d="M13 7v2" /></>;
  } else {
    glyph = <><rect x="2" y="3.25" width="12" height="9.5" rx="1.25" /><path d="m7 6 3.25 2L7 10V6Z" /></>;
  }
  return (
    <span
      data-track-category-icon={category}
      style={{
        alignItems: 'center',
        color: isPrimary ? colors.accent.primary : colors.text.tertiary,
        display: 'inline-flex',
        flex: '0 0 auto',
      }}
    >
      <svg {...common}>{glyph}</svg>
    </span>
  );
};

const TrackLaneBubbleSurface: React.FC = () => (
  <div
    data-track-bubble-surface=""
    data-track-bubble-edge="lane"
    aria-hidden="true"
    style={{
      position: 'absolute',
      top: timeline.trackBubbleInset,
      bottom: timeline.trackBubbleInset,
      left: 0,
      right: 0,
      borderRadius: timeline.trackBubbleRadius,
      backgroundColor: colors.bg.secondary,
      boxShadow: shadows.trackBubble,
      pointerEvents: 'none',
    }}
  />
);

type TransitionResizeEdge = 'start' | 'end';

const TransitionRangeOverlay: React.FC<{
  boundaryFrame: number;
  fps: number;
  maxDurationInFrames: number;
  pixelsPerFrame: number;
  selected: boolean;
  transition: TransitionItem;
  bottomOffset?: number;
  onResizeEnd: () => void;
  onResizeStart: () => void;
  onSelect: () => void;
  onUpdateDuration: (durationInFrames: number) => void;
}> = ({
  boundaryFrame,
  fps,
  maxDurationInFrames,
  pixelsPerFrame,
  selected,
  transition,
  bottomOffset,
  onResizeEnd,
  onResizeStart,
  onSelect,
  onUpdateDuration,
}) => {
  const resizeRef = useRef<{
    edge: TransitionResizeEdge;
    pointerId: number;
    startClientX: number;
    startDurationInFrames: number;
  } | null>(null);
  const durationInFrames = Math.max(1, transition.durationInFrames);
  const durationSeconds = durationInFrames / Math.max(1, fps);
  const label = `${transition.transitionType} transition, ${durationSeconds.toFixed(2)} seconds`;
  const visibleWidth = Math.max(12, durationInFrames * pixelsPerFrame);

  const finishResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const active = resizeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onResizeEnd();
  }, [onResizeEnd]);

  const resizeHandle = (edge: TransitionResizeEdge) => ({
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      resizeRef.current = {
        edge,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startDurationInFrames: durationInFrames,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      onResizeStart();
      onSelect();
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const active = resizeRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const outwardDeltaPx = active.edge === 'start'
        ? active.startClientX - event.clientX
        : event.clientX - active.startClientX;
      const nextDuration = Math.max(
        1,
        Math.min(
          maxDurationInFrames,
          active.startDurationInFrames + Math.round((outwardDeltaPx * 2) / Math.max(0.01, pixelsPerFrame)),
        ),
      );
      onUpdateDuration(nextDuration);
    },
    onPointerUp: finishResize,
    onPointerCancel: finishResize,
  });

  return (
    <div
      data-transition-range=""
      data-transition-range-visual="seam-window"
      data-transition-frame={boundaryFrame}
      data-transition-duration-frames={durationInFrames}
      aria-label={label}
      role="group"
      title={label}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      style={{
        background: selected
          ? 'rgba(255, 255, 255, 0.24)'
          : 'rgba(255, 255, 255, 0.16)',
        border: '2px solid rgba(255, 255, 255, 0.96)',
        borderRadius: 4,
        boxShadow: selected
          ? '0 0 0 1px rgba(15, 23, 42, 0.34), 0 4px 10px rgba(15, 23, 42, 0.18)'
          : '0 0 0 1px rgba(15, 23, 42, 0.24), 0 2px 7px rgba(15, 23, 42, 0.14)',
        boxSizing: 'border-box',
        cursor: 'pointer',
        left: boundaryFrame * pixelsPerFrame,
        overflow: 'visible',
        position: 'absolute',
        top: timeline.trackBubbleInset,
        bottom: bottomOffset ?? timeline.trackBubbleInset,
        transform: 'translateX(-50%)',
        width: visibleWidth,
        zIndex: 16,
      }}
    >
      <span
        data-transition-seam-line=""
        aria-hidden="true"
        style={{
          background: 'rgba(15, 23, 42, 0.42)',
          bottom: 0,
          left: '50%',
          pointerEvents: 'none',
          position: 'absolute',
          top: 0,
          transform: 'translateX(-50%)',
          width: 1,
        }}
      />
      <span
        data-transition-seam-icon=""
        aria-hidden="true"
        style={{
          alignItems: 'center',
          display: 'inline-flex',
          filter: 'drop-shadow(0 1px 1px rgba(15, 23, 42, 0.55))',
          height: 24,
          justifyContent: 'center',
          left: '50%',
          pointerEvents: 'none',
          position: 'absolute',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 24,
          zIndex: 1,
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="rgba(255, 255, 255, 0.98)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4.5 5.5 12 12l-7.5 6.5v-13Z" />
          <path d="M19.5 5.5 12 12l7.5 6.5v-13Z" />
        </svg>
      </span>
      {(['start', 'end'] as const).map((edge) => (
        <div
          key={edge}
          data-transition-resize-handle={edge}
          {...resizeHandle(edge)}
          aria-label={`Resize ${transition.transitionType} ${edge}`}
          aria-orientation="vertical"
          role="separator"
          style={{
            bottom: 0,
            cursor: 'ew-resize',
            position: 'absolute',
            top: 0,
            width: 10,
            ...(edge === 'start' ? { left: -5 } : { right: -5 }),
          }}
        />
      ))}
    </div>
  );
};

const TrackLabelDividers: React.FC<{ showTop: boolean }> = ({ showTop }) => {
  const dividerStyle: React.CSSProperties = {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    height: 1,
    backgroundColor: colors.border.default,
    opacity: 0.72,
    pointerEvents: 'none',
  };

  return (
    <>
      {showTop ? (
        <span
          data-track-label-divider="top"
          aria-hidden="true"
          style={{ ...dividerStyle, top: 0 }}
        />
      ) : null}
      <span
        data-track-label-divider="bottom"
        aria-hidden="true"
        style={{ ...dividerStyle, bottom: 0 }}
      />
    </>
  );
};

const GlobalTranscriptTrackLabel: React.FC<{ showTop: boolean }> = ({ showTop }) => (
  <div
    data-global-transcript-label=""
    style={{
      alignItems: 'center',
      backgroundColor: 'transparent',
      boxSizing: 'border-box',
      color: colors.text.primary,
      display: 'flex',
      fontSize: typography.fontSize.sm,
      fontWeight: 600,
      gap: 8,
      height: GLOBAL_TRANSCRIPT_LANE_HEIGHT,
      padding: '0 12px',
      position: 'relative',
      whiteSpace: 'nowrap',
    }}
  >
    <TrackCategoryIcon category="text" isPrimary={false} />
    <span>Transcript</span>
    <TrackLabelDividers showTop={showTop} />
  </div>
);

export const TimelineTracksContainer: React.FC<TimelineTracksContainerProps> = ({
  durationInFrames,
  pixelsPerFrame,
  fps,
  snapEnabled = true,
  selectedItemId,
  assets,
  onSelectTrack,
  onSelectItem,
  onDeleteItem,
  onUpdateItem,
  onDragOver,
  onDrop,
  onEmptyDrop,
  onItemDragStart,
  onItemDragOver,
  onItemDrop,
  onItemDragEnd,
  dragPreview,
  assetDragPreview,
  onScrollXChange,
  onViewportElementChange,
  viewportWidth,
  labelsPortal,
  contentInsetLeftPx,
  externalInsertPosition,
  onAnnotationTargetContextMenu,
  showTranscriptTimeline = false,
  previewCacheScope,
}) => {
  const dispatch = useEditorDispatch();
  const { beginHistoryGroup, endHistoryGroup } = useEditorHistory();
  const { tracks, primaryTrackId } = useEditorStaticState();
  const { currentFrameRef } = useEditorPlaybackRefs();


  // Debug: log when assetDragPreview changes
  useEffect(() => {
  }, [assetDragPreview]);

  const narrationTrack = React.useMemo(
    () => tracks.find(
      (track) => track.id !== primaryTrackId && track.role === 'narration',
    ) ?? null,
    [primaryTrackId, tracks],
  );
  const primaryTrack = React.useMemo(
    () => tracks.find((track) => track.id === primaryTrackId) ?? null,
    [primaryTrackId, tracks],
  );
  // Voiceover keeps its own audio lane. Its word timing is projected beneath
  // Media so transcript-based editing stays aligned with the visual spine.
  const primaryTranscriptSourceTrack = narrationTrack
    ?? (
      primaryTrack && isSpokenMediaTrack(primaryTrack, primaryTrackId)
        ? primaryTrack
        : null
    );
  const displayTracks = React.useMemo(
    () => tracks.filter((track) => track.role !== 'transition'),
    [tracks],
  );
  // Lane DOM identities survive item edits. Only membership/order changes need
  // new observations; the browser already observes geometry changes in place.
  const displayTrackIdsKey = JSON.stringify(displayTracks.map(track => track.id));
  const neighborsByTrack = React.useMemo(
    () => new Map(displayTracks.map(track => [track.id, indexItemNeighbors(track.items)])),
    [displayTracks],
  );
  const getPresentationTrackHeight = useCallback(
    (track: Track) => getTrackHeightForTrack(track, primaryTrackId),
    [primaryTrackId],
  );
  const getPresentationTrackBandAtY = useCallback((y: number) => {
    if (y < 0) return null;
    let top = 0;
    for (let displayIndex = 0; displayIndex < displayTracks.length; displayIndex += 1) {
      const track = displayTracks[displayIndex];
      const height = getPresentationTrackHeight(track);
      const bottom = top + height;
      if (y < bottom) {
        const trackIndex = tracks.findIndex((candidate) => candidate.id === track.id);
        return {
          displayIndex,
          top,
          height,
          bottom,
          targetTrack: track,
          insertBefore: trackIndex,
          insertAfter: trackIndex + 1,
        };
      }
      top = bottom;
    }
    return null;
  }, [
    displayTracks,
    getPresentationTrackHeight,
    tracks,
  ]);
  const transitionItems = React.useMemo(
    () => tracks.flatMap((track) => track.items
      .filter((item): item is TransitionItem => item.type === 'transition')
      .map((item) => ({ item, trackId: track.id }))),
    [tracks],
  );

  const renderTrackLabel = (track: Track) => {
    const category = inferTrackCategory(track, primaryTrackId) ?? 'visual';
    const isPrimary = track.id === primaryTrackId;
    const label = getTimelineTrackLabel(track, isPrimary, primaryTrackId);
    return (
      <div
        style={{
          alignItems: 'center',
          color: colors.text.primary,
          display: 'flex',
          fontSize: typography.fontSize.sm,
          fontWeight: 600,
          gap: 8,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <TrackCategoryIcon category={category} isPrimary={isPrimary} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </span>
      </div>
    );
  };

  const containerRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [observedViewport, setObservedViewport] = useState<HTMLDivElement | null>(null);
  const [distantTracks, setDistantTracks] = useState<ReadonlySet<string>>(() => new Set());
  const handleInsertDropRef = useRef<((e: React.DragEvent, position: number) => void) | null>(null);

  const setViewportElement = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    setObservedViewport(node);
    onViewportElementChange?.(node);
  }, [onViewportElementChange]);

  useEffect(() => {
    setDistantTracks(new Set());
    if (!observedViewport || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (!active) return;
      setDistantTracks((previous) => {
        const next = new Set(previous);
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.timelineTrackId;
          if (!id) continue;
          if (entry.isIntersecting) next.delete(id);
          else next.add(id);
        }
        return next.size === previous.size && [...next].every(id => previous.has(id)) ? previous : next;
      });
    }, { root: observedViewport, rootMargin: '200px 0px' });
    // Keep lane shells mounted: their authored heights remain the source of
    // scroll and drop geometry, while distant clip controls can be released.
    observedViewport.querySelectorAll('[data-timeline-track-id]').forEach(lane => observer.observe(lane));
    return () => { active = false; observer.disconnect(); };
  }, [observedViewport, displayTrackIdsKey]);

  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [insertPosition, setInsertPosition] = useState<number | null>(null);
  // Show insert guideline only while a drag is actually active
  const hasDndKitDrag = !!dragPreview || !!window.currentDraggedItem;
  const effectiveInsertPosition = (isDraggingOver || hasDndKitDrag)
    ? (externalInsertPosition ?? insertPosition)
    : null;
  // Keep the track labels vertically aligned with tracks when a horizontal
  // scrollbar appears in the tracks viewport (e.g. on Windows where scrollbars take space).
  // We measure the horizontal scrollbar height and add equivalent bottom padding to the
  // left labels panel so both columns end at the same visual baseline.
  const [hScrollbar, setHScrollbar] = useState(0);

  const measureScrollbars = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    // Horizontal scrollbar thickness (height) = offsetHeight - clientHeight
    const horiz = Math.max(0, vp.offsetHeight - vp.clientHeight);
    // Only update when changed to avoid re-renders while scrolling
    setHScrollbar((prev) => (prev !== horiz ? horiz : prev));
  }, []);

  // Compute preview item height to match actual item render sizing
  const getPreviewItemHeight = useCallback((item: Item): number => {
    // Waveform items (audio/video with waveform) are taller
    const hasWaveform = (item.type === 'audio' || item.type === 'video') && (item as any).waveform;
    // Video with waveform + thumbnail is slightly taller in actual renderer
    let hasVideoWithThumbnail = false;
    if (item.type === 'video' && hasWaveform) {
      const asset = findAssetForItem(item, assets);
      hasVideoWithThumbnail = !!asset?.thumbnail;
    }
    if (hasVideoWithThumbnail) return 60;
    if (hasWaveform) return 56;
    return 44;
  }, [assets]);

  // 同步垂直滚动（标签面板 ↔ 轨道视口）
  // Sync vertical scroll between labels and tracks; report horizontal scroll to parent.
  const handleViewportScroll = useCallback(() => {
    if (viewportRef.current && labelsRef.current) {
      const scrollTop = viewportRef.current.scrollTop;
      labelsRef.current.scrollTop = scrollTop;

      // Sync horizontal scroll to consumers (ruler, playhead, etc.)
      const scrollLeft = viewportRef.current.scrollLeft;
      onScrollXChange?.(scrollLeft);
      // Re-measure in case scrollbar visibility changed while scrolling
      measureScrollbars();
    }
  }, [onScrollXChange, measureScrollbars]);

  const handleLabelsScroll = useCallback(() => {
    if (labelsRef.current && viewportRef.current) {
      const scrollTop = labelsRef.current.scrollTop;
      viewportRef.current.scrollTop = scrollTop;
    }
  }, []);

  // Measure on mount and whenever layout-affecting props change
  useEffect(() => {
    measureScrollbars();
    const onResize = () => measureScrollbars();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measureScrollbars, durationInFrames, pixelsPerFrame, viewportWidth]);

  // 拖放处理
  const handleContainerDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(true);

    // Store drag data globally when entering
    globalDragData = {
      assetId: e.dataTransfer.getData('assetId') || e.dataTransfer.getData('text/plain'),
      quickAdd: e.dataTransfer.getData('quickAdd'),
      quickAddType: e.dataTransfer.getData('quickAddType'),
      asset: e.dataTransfer.getData('asset'),
    };
  }, []);

  const handleContainerDragLeave = useCallback((e: React.DragEvent) => {
    // 检查是否是真正离开容器
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const isOutside =
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom;

    if (isOutside) {
      setIsDraggingOver(false);
      setInsertPosition(null);
    }
  }, []);

  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); // CRITICAL: Must prevent default to allow drop
    e.dataTransfer.dropEffect = 'copy'; // CRITICAL: Must match effectAllowed from drag source
    onDragOver(e); // Call the parent's handler
  }, [onDragOver]);

  const handleContainerDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);

    const currentInsertPosition = effectiveInsertPosition;
    setInsertPosition(null);

    // 如果有插入位置，调用 handleInsertDrop
    if (currentInsertPosition !== null) {
      if (handleInsertDropRef.current) {
        handleInsertDropRef.current(e, currentInsertPosition);
      }
      return;
    }

    // 如果没有轨道，调用空状态的 drop 处理
    if (tracks.length === 0) {
      onEmptyDrop(e);
      return;
    }

    // NEW: Handle drop onto an existing track (when not at edge)
    if (!viewportRef.current) return;
    
    const dragType = e.dataTransfer.getData('dragType') || 
                     (window.currentDraggedItem ? 'item' : 'asset');
    
    // Only handle asset drops here (item drops are handled by TimelineItem)
    if (dragType !== 'item' && !window.currentDraggedItem) {
      const rect = viewportRef.current.getBoundingClientRect();
      const y = e.clientY - rect.top + viewportRef.current.scrollTop;
      const targetTrack = getPresentationTrackBandAtY(y)?.targetTrack;

      if (targetTrack) {
        // Drop onto existing track
        onDrop(targetTrack.id, e);
      }
    }
  }, [
    effectiveInsertPosition,
    getPresentationTrackBandAtY,
    onDrop,
    onEmptyDrop,
    tracks.length,
  ]);

  // 检测鼠标是否在两个轨道之间
  const detectInsertPosition = useCallback((e: React.DragEvent) => {
    if (!viewportRef.current) return;

    // 如果timeline是空的，总是在位置0插入新轨道
    if (tracks.length === 0) {
      setInsertPosition(0);
      return 0;
    }

    const rect = viewportRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top + viewportRef.current.scrollTop;
    const band = getPresentationTrackBandAtY(y);
    if (!band) {
      setInsertPosition(y < 0 ? 0 : tracks.length);
      return y < 0 ? 0 : tracks.length;
    }
    const relativeY = y - band.top;

    // Check if this is an existing item drag (different behavior for new assets)
    const dragType = e.dataTransfer.types.includes('dragType')
      ? e.dataTransfer.getData('dragType')
      : (window.currentDraggedItem ? 'item' : 'asset');

    // For existing items, use tighter threshold (only at very edges)
    // For new assets, use wider threshold to make track insertion easier
    const threshold = Math.min(dragType === 'item' ? 8 : 12, Math.floor(band.height * 0.25));

    // 如果鼠标在轨道边界附近
    if (relativeY < threshold || relativeY > band.height - threshold) {
      const position = relativeY < threshold ? band.insertBefore : band.insertAfter;
      if (position >= 0 && position <= tracks.length) {
        setInsertPosition(position);
        return position;
      }
    }

    setInsertPosition(null);
    return null;
  }, [getPresentationTrackBandAtY, tracks.length]);

  // 处理轨道间插入
  const handleInsertDrop = useCallback((e: React.DragEvent, position: number) => {
    e.preventDefault();
    e.stopPropagation();

    // Check if this is an existing item being moved
    const dragType = e.dataTransfer.getData('dragType');
    // const itemId = e.dataTransfer.getData('itemId'); // unused
    const sourceTrackId = e.dataTransfer.getData('trackId');


    if (dragType === 'item' || window.currentDraggedItem) {
      // Moving an existing item to a new track

      const itemToMove = window.currentDraggedItem?.item;
      const sourceTrack = window.currentDraggedItem?.trackId || sourceTrackId;


      if (!itemToMove || !sourceTrack) {
        return;
      }

      // 立即清除window.currentDraggedItem，防止dragOver继续处理
      window.currentDraggedItem = null;

      // 找到当前item所在的实际track（可能已经被dragOver移动过）
      const currentTrack = tracks.find(t => t.items.some(i => i.id === itemToMove.id));
      const actualSourceTrackId = currentTrack?.id || sourceTrack;


      // Create new track with the item already in it
      // This way we avoid the issue of REMOVE_ITEM auto-deleting empty tracks
      const newTrack = {
        id: `track-${Date.now()}`,
        name: itemToMove.type.charAt(0).toUpperCase() + itemToMove.type.slice(1),
        items: [itemToMove]  // Start with the item already in the track
      };

      // Insert new track at the specified position (with item already in it)
      dispatch({
        type: 'INSERT_TRACK',
        payload: { track: newTrack, index: position }
      });

      // Then remove item from the source track
      setTimeout(() => {
        dispatch({
          type: 'REMOVE_ITEM',
          payload: { trackId: actualSourceTrackId, itemId: itemToMove.id }
        });

        // Select the moved item
        dispatch({ type: 'SELECT_ITEM', payload: itemToMove.id });
      }, 0);

      return;
    }

    // Otherwise, handle creating new items from assets
    // Try to get assetId from multiple sources, fallback to global data
    let assetId = e.dataTransfer.getData('assetId') ||
                  e.dataTransfer.getData('text/plain') ||
                  globalDragData.assetId;

    const isQuickAdd = (e.dataTransfer.getData('quickAdd') || globalDragData.quickAdd) === 'true';
    const quickAddType = e.dataTransfer.getData('quickAddType') || globalDragData.quickAddType;
    // const assetData = e.dataTransfer.getData('asset') || globalDragData.asset; // unused

    // If we still don't have assetId, try to get it from currentDraggedAsset
    let finalIsQuickAdd = isQuickAdd;
    let finalQuickAddType = quickAddType;

    if (!assetId && currentDraggedAsset) {
      assetId = currentDraggedAsset.id;
      if (currentDraggedAsset.quickAdd) {
        finalIsQuickAdd = true;
        finalQuickAddType = currentDraggedAsset.quickAddType;
      }
    }
    const droppedAsset = finalIsQuickAdd ? undefined : resolveAssetDropPayload({
      assetId,
      dataTransfer: e.dataTransfer,
      assets,
      currentDraggedAsset,
    });


    // 创建新轨道并插入到指定位置
    const itemType = (finalIsQuickAdd ? finalQuickAddType : droppedAsset?.type) ?? 'track';
    const category: TrackCategory = itemType === 'text'
      ? 'text'
      : itemType === 'audio'
        ? 'audio'
        : 'visual';
    const newTrack = {
      id: `track-${Date.now()}`,
      name: itemType.charAt(0).toUpperCase() + itemType.slice(1),
      category,
      items: []
    };

    // 插入轨道到指定位置
    dispatch({
      type: 'INSERT_TRACK',
      payload: { track: newTrack, index: position }
    });

    // 计算 drop 位置（与 Timeline.handleDrop 保持一致）
    const viewportEl = viewportRef.current;
    if (!viewportEl) {
      return;
    }

    const rect = viewportEl.getBoundingClientRect();
    const mouseX = e.clientX - rect.left + viewportEl.scrollLeft;
    // 减去 asset 拖动偏移量，与预览位置保持一致
    const assetLeftX = mouseX - currentAssetDragOffset;
    const rawFrame = Math.max(0, Math.round(assetLeftX / pixelsPerFrame));


    const dropFrame = Math.max(0, rawFrame);

    // 添加素材到新轨道
    setTimeout(() => {
      let newItem: any = null;

      if (finalIsQuickAdd) {
        // Handle quick add items
        if (finalQuickAddType === 'text') {
          newItem = {
            id: `text-${Date.now()}`,
            type: 'text',
            text: 'Double click to edit',
            color: '#000000',
            from: dropFrame,
            durationInFrames: 90,
            fontSize: 60,
          };
        } else if (finalQuickAddType === 'solid') {
          newItem = {
            id: `solid-${Date.now()}`,
            type: 'solid',
            color: '#' + Math.floor(Math.random() * 16777215).toString(16),
            from: dropFrame,
            durationInFrames: 60,
          };
        }
      } else {
        // Handle regular assets
        const asset = droppedAsset;
        if (!asset) {
          return;
        }
        const sourceNodeId: string | undefined = (asset as any).sourceNodeId ?? asset.id;
        const projectAssetId: string | undefined = (asset as any).projectAssetId;
        if (!projectAssetId) return;

        switch (asset.type) {
          case 'video':
            newItem = {
              id: `item-${Date.now()}`,
              type: 'video',
              assetId: projectAssetId,
              sourceNodeId,
              from: dropFrame,
              durationInFrames: (asset && asset.duration) ? secondsToFrames(asset.duration, fps) : 90,
              src: asset ? asset.src : '',
              waveform: asset ? asset.waveform : undefined,
              properties: createTimelineInsertProperties(),
              mediaFit: TIMELINE_INSERT_MEDIA_FIT,
            };
            break;
          case 'audio':
            newItem = {
              id: `item-${Date.now()}`,
              type: 'audio',
              assetId: projectAssetId,
              sourceNodeId,
              from: dropFrame,
              durationInFrames: asset.duration ? secondsToFrames(asset.duration, fps) : 90,
              src: asset.src,
              waveform: asset.waveform,
              properties: createTimelineInsertProperties(),
            };
            break;
          case 'image':
            newItem = {
              id: `item-${Date.now()}`,
              type: 'image',
              assetId: projectAssetId,
              sourceNodeId,
              from: dropFrame,
              durationInFrames: 90,
              src: asset.src,
              properties: createTimelineInsertProperties(),
              mediaFit: TIMELINE_INSERT_MEDIA_FIT,
            };
            break;
        }
      }

      if (newItem) {
        dispatch({
          type: 'ADD_ITEM',
          payload: { trackId: newTrack.id, item: newItem }
        });
        dispatch({ type: 'SELECT_ITEM', payload: newItem.id });
      }
    }, 0);
  }, [assets, dispatch]);

  // 更新 handleInsertDrop 的 ref
  useEffect(() => {
    handleInsertDropRef.current = handleInsertDrop;
  }, [handleInsertDrop]);

  // 扩展拖动悬停处理
  const handleTrackAreaDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); // CRITICAL: Must prevent default to allow drop
    e.dataTransfer.dropEffect = 'copy'; // CRITICAL: Must match effectAllowed from drag source
    onDragOver(e);
    detectInsertPosition(e);
  }, [onDragOver, detectInsertPosition]);

  // Keep content at least as wide as the viewport to avoid empty scroll area on empty timeline
  const totalWidth = Math.max(durationInFrames * pixelsPerFrame, viewportWidth ?? 0);

  const content = (
    <div
      ref={containerRef}
      className="timeline-tracks-container"
      style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden',
        background: isDraggingOver ? colors.bg.hover : colors.bg.primary,
        borderRadius: 0,
        margin: 0, // Remove all margins to eliminate gaps
        // Avoid mixing border shorthand with borderLeft to prevent React warning.
        borderTop: 0,
        borderRight: 0,
        borderBottom: 0,
        borderLeft: 0,
        position: 'relative',
      }}
      onDragEnter={handleContainerDragEnter}
      onDragLeave={handleContainerDragLeave}
      onDragOver={handleContainerDragOver}
      onDrop={handleContainerDrop}
      onClick={(e) => {
        // 点击 timeline 空白区域时取消选中 item
        // 只在点击的是最外层容器自身时才取消选中(不是子元素冒泡上来的)
        if (e.target === e.currentTarget) {
          onSelectItem('');
        }
      }}
    >
      {/* 左侧标签面板（若提供 labelsPortal 则不内联渲染） */}
      {!labelsPortal && (
        <div
          ref={labelsRef}
          className="track-labels-panel"
          style={{
            width: timeline.trackLabelWidth,
            flexShrink: 0,
            background: colors.bg.primary,
            borderRight: `1px solid ${colors.border.subtle}`,
            boxSizing: 'border-box',
            overflowY: 'auto',
            overflowX: 'hidden',
            position: 'sticky',
            left: 0,
            zIndex: 30,
            // Reserve space equal to the horizontal scrollbar in the tracks viewport
            // so the last row aligns when scrolled to bottom (esp. on Windows).
            paddingBottom: hScrollbar,
            // 隐藏滚动条但保持可滚动
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
          onScroll={handleLabelsScroll}
        >
          <style>{TRACK_LABELS_SCROLLBAR_CSS}</style>

          {tracks.length === 0 ? (
            <div
              aria-hidden="true"
              style={{
                height: 200,
              }}
            />
          ) : (
            <>
            {displayTracks.map((track, index) => {
              const isPrimary = track.id === primaryTrackId;
              const trackLabel = getTimelineTrackLabel(track, isPrimary, primaryTrackId);
              const trackHeight = getPresentationTrackHeight(track);
              return (
              <div
                key={track.id}
                data-primary-track={isPrimary || undefined}
                data-agent-annotation-object-id={track.id}
                data-agent-annotation-object-type="timeline-track"
                data-agent-annotation-object-label={trackLabel}
                className="select-text"
                style={{
                  height: trackHeight,
                  padding: '0 12px',
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  backgroundColor: 'transparent',
                  position: 'relative',
                  boxSizing: 'border-box',
                  transition: 'background-color 0.15s ease',
                }}
                onClick={() => onSelectTrack(track.id)}
                onContextMenu={() => onAnnotationTargetContextMenu?.({
                  objectId: track.id,
                  objectType: 'timeline-track',
                  objectLabel: trackLabel,
                })}
              >
                <div style={{ minWidth: 0 }}>{renderTrackLabel(track)}</div>
                <TrackLabelDividers showTop={index === 0} />
              </div>
              );
            })}
            {showTranscriptTimeline ? (
              <GlobalTranscriptTrackLabel showTop={displayTracks.length === 0} />
            ) : null}
            </>
          )}
        </div>
      )}

      {/* 右侧轨道视口 */}
      <ScrollViewport
        containerStyle={{ flex: 1 }}
        data-timeline-editing-canvas=""
        ref={setViewportElement}
        className="tracks-viewport bg-transparent"
        style={{
          flex: 1,
          position: 'relative',
          minWidth: 0,
          minHeight: 0,
          background: colors.bg.primary,
          paddingLeft: contentInsetLeftPx ?? 0,
        }}
        onScroll={handleViewportScroll}
        onDragOver={handleTrackAreaDragOver}
      >
        <div
          style={{
            position: 'relative',
            minWidth: totalWidth,
            minHeight: '100%',
            background: colors.bg.primary,
          }}
          onClick={(e) => {
            // 点击轨道视口的空白区域时取消选中
            if (e.target === e.currentTarget) {
              onSelectItem('');
            }
          }}
          onDrop={(e) => {
            // Handle drops when inserting between tracks or at the end
            if (effectiveInsertPosition !== null) {
              e.preventDefault();
              e.stopPropagation();
              handleInsertDrop(e, effectiveInsertPosition);
              setInsertPosition(null);
              setIsDraggingOver(false);
            } else {
              // Intentionally empty
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy'; // CRITICAL: Must match effectAllowed from drag source
            // Only use internal detection when no external insert position is provided
            if (externalInsertPosition == null) {
              detectInsertPosition(e);
            }
          }}
        >
          {tracks.length === 0 ? (
            // 空状态 - 使用 pointerEvents: 'none' 让 drop 事件穿透到父元素
            <div
              style={{
                height: 200,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: colors.text.tertiary,
                gap: spacing.sm,
                pointerEvents: 'none', // 让拖放事件穿透到父元素
              }}
            >
              <div style={{ width: 24, height: 2, borderRadius: 999, background: colors.accent.primary, opacity: 0.72, marginBottom: spacing.sm }} />
              <div style={{ fontSize: typography.fontSize.lg, fontWeight: 600, color: colors.text.secondary }}>Drop media to start editing</div>
              <div style={{ fontSize: typography.fontSize.sm, color: colors.text.tertiary }}>
                Drag from Media, or add text and color from Quick add.
              </div>
            </div>
          ) : (
            // 轨道列表 - 只渲染轨道内容区，不包括标签
            displayTracks.map((track, index) => {
              const isPrimary = track.id === primaryTrackId;
              const trackHeight = getPresentationTrackHeight(track);
              const trackIndex = tracks.findIndex((candidate) => candidate.id === track.id);
              const insertBeforeIndex = trackIndex;
              const transitionBoundaries = getContinuousTransitionBoundaries(track);
              const keepTrackContents = !distantTracks.has(track.id)
                || track.items.some(item => item.id === selectedItemId)
                || dragPreview?.originalTrackId === track.id
                || window.currentDraggedItem?.trackId === track.id
                || transitionBoundaries.some(boundary => transitionItems.some(({ item }) =>
                  item.id === selectedItemId && item.fromItemId === boundary.fromItem.id && item.toItemId === boundary.toItem.id));
              return (
              <Fragment key={track.id}>
                {/* 插入指示器 - 轨道上方 */}
                {effectiveInsertPosition === insertBeforeIndex && (
                  <div
                    style={{
                      position: 'relative',
                      height: 2,
                      backgroundColor: colors.accent.primary,
                      marginTop: -1,
                      marginBottom: -1,
                      zIndex: 10,
                      pointerEvents: 'none',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor: colors.accent.primary,
                      }}
                    />
                  </div>
                )}

                <div
                  data-track-lane=""
                  data-timeline-track-id={track.id}
                  data-primary-track={isPrimary || undefined}
                  style={{
                    height: trackHeight,
                    position: 'relative',
                    backgroundColor: 'transparent',
                    boxSizing: 'border-box',
                  }}
                  onClick={(e) => {
                    // 点击轨道空白区域时取消选中 item
                    if (e.target === e.currentTarget) {
                      onSelectTrack(track.id);
                      onSelectItem(''); // 传空字符串取消选中
                    }
                  }}
                  onContextMenu={(event) => {
                    if (event.target !== event.currentTarget) return;
                    onAnnotationTargetContextMenu?.({
                      objectId: track.id,
                      objectType: 'timeline-track',
                      objectLabel: isPrimary ? 'Media' : track.name,
                    });
                  }}
                  onDragOver={(e) => {
                    // 检测插入位置
                    const insertPos = detectInsertPosition(e);
                    // 只在不是插入位置时才处理item拖动
                    if (insertPos === null) {
                      onItemDragOver(e, track.id);
                    }
                  }}
                  onDrop={(e) => {
                    // Don't handle drops that are meant for insertion
                    if (insertPosition !== null) {
                      return;  // Let the container handle it
                    }

                    // Clear any residual insert guideline when dropping onto a track
                    setInsertPosition(null);
                    setIsDraggingOver(false);

                    // Check if this is an existing item being dragged (not a new asset)
                    const dragType = e.dataTransfer.getData('dragType');
                    const isExistingItemDrag = dragType === 'item' || window.currentDraggedItem || dragPreview;
                    
                    if (isExistingItemDrag) {
                      // Item drag - call onItemDrop
                      onItemDrop(e, track.id);
                    } else {
                      // New asset from AssetPanel - add to existing track
                      e.preventDefault();
                      e.stopPropagation();
                      onDrop(track.id, e);
                    }
                  }}
                >
                  <TrackLaneBubbleSurface />
                  <div
                    data-track-leading-gutter=""
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: -1,
                      left: -(contentInsetLeftPx ?? 0),
                      width: contentInsetLeftPx ?? 0,
                      boxSizing: 'border-box',
                      backgroundColor: 'transparent',
                      pointerEvents: 'none',
                    }}
                  />
                  {keepTrackContents && transitionBoundaries.map((boundary) => {
                    const boundTransition = transitionItems.find(({ item }) => (
                      item.fromItemId === boundary.fromItem.id
                      && item.toItemId === boundary.toItem.id
                    ));
                    if (!boundTransition) return null;
                    const isSelected = selectedItemId === boundTransition.item.id;
                    const maxDurationInFrames = Math.max(
                      1,
                      Math.min(boundary.fromItem.durationInFrames, boundary.toItem.durationInFrames) * 2,
                    );
                    return (
                      <TransitionRangeOverlay
                        key={`${boundary.fromItem.id}:${boundary.toItem.id}`}
                        boundaryFrame={boundary.frame}
                        fps={fps}
                        maxDurationInFrames={maxDurationInFrames}
                        pixelsPerFrame={pixelsPerFrame}
                        selected={isSelected}
                        transition={boundTransition.item}
                        onResizeStart={beginHistoryGroup}
                        onResizeEnd={endHistoryGroup}
                        onSelect={() => {
                          dispatch({ type: 'SET_CURRENT_FRAME', payload: boundary.frame });
                          onSelectItem(boundTransition.item.id);
                        }}
                        onUpdateDuration={(nextDuration) => {
                          onUpdateItem(boundTransition.trackId, boundTransition.item.id, {
                            from: boundary.frame - Math.floor(nextDuration / 2),
                            durationInFrames: nextDuration,
                          });
                        }}
                      />
                    );
                  })}
                  {/* 使用 TimelineItem 组件保留所有功能 */}
                  {keepTrackContents && track.items.map((item) => {
                    // 检测相邻的 item（用于 Roll Edit）
                    const neighbors = neighborsByTrack.get(track.id)?.get(item.id);
                    const leftItem = neighbors?.left ?? null;
                    const rightItem = neighbors?.right ?? null;

                    const hasAdjacentLeft = leftItem && (leftItem.from + leftItem.durationInFrames === item.from);
                    const hasAdjacentRight = rightItem && (item.from + item.durationInFrames === rightItem.from);

                    // Roll Edit 模式：当两个 item 相邻且都未选中时启用
                    const isInRollEditLeft = hasAdjacentLeft && selectedItemId !== item.id && selectedItemId !== leftItem.id;
                    const isInRollEditRight = hasAdjacentRight && selectedItemId !== item.id && selectedItemId !== rightItem.id;


                    return (<TimelineItem
                      key={item.id}
                      item={item}
                      trackId={track.id}
                      track={track}
                      pixelsPerFrame={pixelsPerFrame}
                      isSelected={selectedItemId === item.id}
                      assets={assets}
                      presentationReservesTranscriptWordbar={false}
                      previewCacheScope={previewCacheScope}
                      onSelect={() => onSelectItem(item.id)}
                      onDelete={() => onDeleteItem(track.id, item.id)}
                      onUpdate={(itemId, updates) => onUpdateItem(track.id, itemId, updates)}
                      onDragStart={(e) => onItemDragStart(e, track.id, item)}
                      onDragEnd={onItemDragEnd}
                      hasAdjacentItemOnLeft={isInRollEditLeft || undefined}
                      hasAdjacentItemOnRight={isInRollEditRight || undefined}
                      onResizeStart={beginHistoryGroup}
                      onResizeEnd={endHistoryGroup}
                      onAnnotationTargetContextMenu={onAnnotationTargetContextMenu}
                      onResize={(edge, deltaFrames) => {
                        // 获取素材总帧数
                        let totalFramesForAsset: number | undefined;
                        if (item.type === 'video' || item.type === 'audio') {
                          totalFramesForAsset = getItemAssetDurationInFrames(item, assets, fps);
                        }

                        const currentOffset = ((item as any).sourceStartInFrames || 0);
                        let newFrom = item.from;
                        let newDuration = item.durationInFrames;

                        if (edge === 'left') {
                          const rawFrom = Math.max(0, item.from + deltaFrames);

                          // 应用吸附（左边缘）
                          const snapped = calculateResizeSnap(
                            rawFrom,
                            'left',
                            tracks,
                            item.id,
                            currentFrameRef.current,
                            !!snapEnabled,
                            timeline.snapThreshold
                          );
                          newFrom = snapped.snappedFrame;
                          newDuration = item.from + item.durationInFrames - newFrom;

                          // 检查与同一 track 中其他 item 的重叠
                          const otherItems = track.items.filter(i => i.id !== item.id);
                          for (const other of otherItems) {
                            const otherEnd = other.from + other.durationInFrames;
                            // 如果新位置会与其他 item 重叠，限制在其右边缘
                            if (newFrom < otherEnd && (item.from + item.durationInFrames) > other.from) {
                              if (newFrom < otherEnd) {
                                newFrom = otherEnd;
                                newDuration = item.from + item.durationInFrames - newFrom;
                              }
                            }
                          }

                          // 计算新的源偏移
                          const consumed = newFrom - item.from;
                          const proposedOffset = Math.max(0, currentOffset + consumed);

                          // 基于新的偏移来限制最大时长
                          if (totalFramesForAsset !== undefined) {
                            const maxDurByAsset = Math.max(0, totalFramesForAsset - proposedOffset);
                            if (newDuration > maxDurByAsset) {
                              newDuration = Math.max(15, maxDurByAsset);
                            }
                          }
                        } else {
                          // 右侧 resize
                          const rawDuration = Math.max(15, item.durationInFrames + deltaFrames);
                          const rawRight = item.from + rawDuration;

                          // 应用吸附（右边缘）
                          const snapped = calculateResizeSnap(
                            rawRight,
                            'right',
                            tracks,
                            item.id,
                            currentFrameRef.current,
                            !!snapEnabled,
                            timeline.snapThreshold
                          );
                          newDuration = Math.max(15, snapped.snappedFrame - item.from);

                          // 检查与同一 track 中其他 item 的重叠
                          const otherItems = track.items.filter(i => i.id !== item.id);
                          for (const other of otherItems) {
                            const newEnd = item.from + newDuration;
                            // 如果新的右边缘会与其他 item 重叠，限制在其左边缘
                            if (newEnd > other.from && item.from < (other.from + other.durationInFrames)) {
                              if (newEnd > other.from) {
                                newDuration = Math.max(15, other.from - item.from);
                              }
                            }
                          }

                          // 基于当前偏移来限制最大时长
                          if (totalFramesForAsset !== undefined) {
                            const maxDurByAsset = Math.max(0, totalFramesForAsset - currentOffset);
                            if (newDuration > maxDurByAsset) {
                              newDuration = Math.max(15, maxDurByAsset);
                            }
                          }
                        }

                        if (newDuration >= 15) {
                          const consumed = newFrom - item.from;
                          const newSourceOffset = Math.max(0, ((item as any).sourceStartInFrames || 0) + (edge === 'left' ? consumed : 0));
                          onUpdateItem(track.id, item.id, {
                            from: newFrom,
                            durationInFrames: newDuration,
                            ...(item.type === 'video' || item.type === 'audio' ? { sourceStartInFrames: newSourceOffset } : {}),
                          } as any);
                        }
                      }}
                      onRollEdit={(edge, deltaFrames) => {
                        const left = edge === 'left' ? leftItem : item;
                        const right = edge === 'left' ? item : rightItem;
                        if (!left || !right) return;
                        dispatch({ type: 'ROLL_EDIT', payload: {
                          trackId: track.id, leftItemId: left.id, rightItemId: right.id,
                          boundaryFrame: right.from + deltaFrames,
                        } });
                      }}
                    />
                  );
                  })}
                  {/* Asset拖动预览框（纯视觉预览，不是真实item） */}
                  {/* 与 item 拖动预览保持一致：当要插入新 track 时（externalInsertPosition != null），不显示预览 */}
                  {assetDragPreview && assetDragPreview.trackId === track.id && externalInsertPosition == null && (
                    <div
                      style={{
                        position: 'absolute',
                        left: assetDragPreview.item.from * pixelsPerFrame,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: assetDragPreview.item.durationInFrames * pixelsPerFrame,
                        height: getPreviewItemHeight(assetDragPreview.item),
                        backgroundColor: 'rgba(100,180,255,0.25)',
                        border: '2px dashed rgba(100,180,255,0.7)',
                        borderRadius: timeline.itemBorderRadius,
                        pointerEvents: 'none',
                        zIndex: 2,
                        boxSizing: 'border-box',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'rgba(255,255,255,0.6)',
                        fontSize: typography.fontSize.sm,
                        opacity: 0.8,
                      }}
                    >
                      {assetDragPreview.item.type}
                    </div>
                  )}

                  {/* 渲染预览框（目标位置指示器）- 显示松手后item会落在哪里 */}
                  {dragPreview && dragPreview.previewTrackId === track.id && externalInsertPosition == null && (
                    <div
                      style={{
                        position: 'absolute',
                        left: dragPreview.previewFrame * pixelsPerFrame,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: dragPreview.item.durationInFrames * pixelsPerFrame,
                        height: getPreviewItemHeight(dragPreview.item),
                        backgroundColor: dragPreview.invalidTarget
                          ? 'rgba(248,113,113,0.08)'
                          : 'rgba(255,255,255,0.15)',
                        border: dragPreview.invalidTarget
                          ? '2px dashed rgba(248,113,113,0.75)'
                          : '2px dashed rgba(255,255,255,0.5)',
                        borderRadius: timeline.itemBorderRadius,
                        pointerEvents: 'none',
                        zIndex: 1,
                        boxSizing: 'border-box',
                      }}
                    />
                  )}
                </div>

                {/* 插入指示器 - 最后一个轨道下方 */}
                {effectiveInsertPosition === tracks.length && index === displayTracks.length - 1 && (
                  <div
                    style={{
                      position: 'relative',
                      height: 2,
                      backgroundColor: colors.accent.primary,
                      marginTop: -1,
                      zIndex: 10,
                      pointerEvents: 'none',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor: colors.accent.primary,
                      }}
                    />
                  </div>
                )}
              </Fragment>
              );
            })
          )}

          {showTranscriptTimeline ? (
            <div
              data-track-lane=""
              data-global-transcript-lane=""
              data-transcript-source-track-id={primaryTranscriptSourceTrack?.id}
              style={{
                boxSizing: 'border-box',
                height: GLOBAL_TRANSCRIPT_LANE_HEIGHT,
                position: 'relative',
              }}
            >
              <TrackLaneBubbleSurface />
              {primaryTranscriptSourceTrack ? (
                <PrimaryTranscriptWordbar
                  trackId={primaryTranscriptSourceTrack.id}
                  pixelsPerFrame={pixelsPerFrame}
                />
              ) : (
                <span
                  style={{
                    bottom: timeline.trackBubbleInset,
                    color: colors.text.tertiary,
                    fontSize: typography.fontSize.xs,
                    height: 24,
                    left: 8,
                    lineHeight: '24px',
                    position: 'absolute',
                  }}
                >
                  Recognize speech to show transcript timing
                </span>
              )}
            </div>
          ) : null}

          {/* 垂直吸附指示线（对齐到其他素材边缘时显示） */}
          {dragPreview?.snapGuideFrame != null && (
            <div
              style={{
                position: 'absolute',
                left: dragPreview.snapGuideFrame * pixelsPerFrame,
                top: 0,
                bottom: 0,
                width: 2,
                backgroundColor: colors.accent.primary,
                opacity: 0.9,
                pointerEvents: 'none',
                zIndex: 50,
              }}
            />
          )}
        </div>
      </ScrollViewport>

      {/* 拖放指示器 */}
      {isDraggingOver && tracks.length === 0 && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `color-mix(in srgb, ${colors.accent.primary} 7%, transparent)`,
            border: `2px dashed ${colors.accent.primary}`,
            borderRadius: 4,
            pointerEvents: 'none',
            zIndex: 100,
          }}
        >
          <div
            style={{
              background: colors.bg.elevated,
              padding: `${spacing.lg}px ${spacing.xxl}px`,
              borderRadius: 6,
              boxShadow: shadows.lg,
              color: colors.text.primary,
              fontSize: typography.fontSize.lg,
              fontWeight: 500,
            }}
          >
            Release to add to Timeline
          </div>
        </div>
      )}
    </div>
  );

  // Optional: Render labels panel externally using a portal
  if (labelsPortal) {
    const labelsNode = (
      <div
        ref={labelsRef}
        className="track-labels-panel"
        style={{
          width: timeline.trackLabelWidth,
          flexShrink: 0,
          background: colors.bg.primary,
          borderRight: `1px solid ${colors.border.subtle}`,
          boxSizing: 'border-box',
          overflowY: 'auto',
          overflowX: 'hidden',
          position: 'sticky',
          left: 0,
          zIndex: 30,
          paddingBottom: hScrollbar,
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          height: '100%',
        }}
        onScroll={handleLabelsScroll}
      >
        <style>{TRACK_LABELS_SCROLLBAR_CSS}</style>
        {tracks.length === 0 ? (
          <div
            aria-hidden="true"
            style={{
              height: 200,
            }}
          />
        ) : (
          <>
          {displayTracks.map((track, index) => {
            const isPrimary = track.id === primaryTrackId;
            const trackLabel = getTimelineTrackLabel(track, isPrimary, primaryTrackId);
            const trackHeight = getPresentationTrackHeight(track);
            return (
             <div
               key={track.id}
               data-primary-track={isPrimary || undefined}
               data-agent-annotation-object-id={track.id}
               data-agent-annotation-object-type="timeline-track"
               data-agent-annotation-object-label={trackLabel}
               className="select-text"
              style={{
                height: trackHeight,
                padding: '0 12px',
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
                backgroundColor: 'transparent',
                position: 'relative',
                boxSizing: 'border-box',
                transition: 'background-color 0.15s ease',
              }}
              onClick={() => onSelectTrack(track.id)}
              onContextMenu={() => onAnnotationTargetContextMenu?.({
                objectId: track.id,
                objectType: 'timeline-track',
                objectLabel: trackLabel,
              })}
            >
              <div style={{ minWidth: 0 }}>{renderTrackLabel(track)}</div>
              <TrackLabelDividers showTop={index === 0} />
            </div>
            );
          })}
          {showTranscriptTimeline ? (
            <GlobalTranscriptTrackLabel showTop={displayTracks.length === 0} />
          ) : null}
          </>
        )}
      </div>
    );

    return (
      <>
        {createPortal(labelsNode, labelsPortal)}
        {content}
      </>
    );
  }

  return content;
};
