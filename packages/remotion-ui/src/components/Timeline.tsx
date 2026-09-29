import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  restrictToWindowEdges,
} from "./ui/dnd";
import type {
  DragStartEvent,
  DragOverEvent,
  DragEndEvent,
  DragMoveEvent,
} from "./ui/dnd";
import {
  canTrackAcceptItem,
  normalizeEditorAsset,
  useEditorDispatch,
  useEditorHistory,
  useEditorPlayback,
  useEditorPlaybackRefs,
  useEditorStaticState,
} from "@clash/remotion-core";
import type { EditorState, Item, TrackCategory } from "@clash/remotion-core";
import type { AgentAnnotationObjectRef } from "@clash/shared-types";
import { TimelineHeader } from "./timeline/TimelineHeader";
import { TimelineRuler } from "./timeline/TimelineRuler";
import { TimelineTracksContainer } from "./timeline/TimelineTracksContainer";
import { TimelinePlayhead } from "./timeline/TimelinePlayhead";
import { TimelineItem } from "./timeline/TimelineItem";
import { useKeyboardShortcuts } from "./timeline/hooks/useKeyboardShortcuts";
import { colors, timeline as timelineStyles } from "./timeline/styles";
import {
  getPixelsPerFrame,
  pixelsToFrame,
  frameToPixels,
  secondsToFrames,
} from "./timeline/utils/timeFormatter";
import { calculateSnap } from "./timeline/utils/snapCalculator";
import {
  buildPreview as buildItemDragPreview,
  finalizeDrop as finalizeItemDrop,
} from "./timeline/dnd/itemDragLogic";
import {
  anchoredTimelineScrollLeft,
  clampTimelineZoom,
  fitTimelineZoom,
  stepTimelineZoom,
} from "./timeline/zoom";
import { currentDraggedAsset, currentAssetDragOffset } from "./AssetPanel";
import { currentDraggedLibraryRecord } from "./TimelineLibraryPanel";
import {
  buildTimelineLibraryApplication,
  findTimelineLibraryProjectAsset,
  timelineLibraryMediaAdmissionInput,
  type TimelineLibraryMediaAdmissionInput,
} from "../library/applyTimelineLibraryItem";
import { resolveAssetDropPayload } from "./timeline/assetDropPayload";
import {
  buildTimelineAssetInsertion,
  createTimelineInsertProperties,
  hasTimelineAssetInsertReceipt,
  TIMELINE_INSERT_MEDIA_FIT,
  type TimelineAssetInsertRequest,
} from "./timeline/insertAssetRequest";
import {
  getTrackBandAtY,
  getTimelineTrackHeights,
  getTimelineTracksHeight,
} from "./timeline/trackGeometry";
import { createBrollTrack } from "./timeline/brollTrackNaming";
import { TIMELINE_NOTICE_EVENT } from "./timeline/timelineNotice";

// 声明全局window属性
declare global {
  interface Window {
    currentDraggedItem: { item: Item; trackId: string } | null;
  }
}

// Hoisted so the string literal is allocated once per module (not per render)
// and React can reconcile the <style> element by reference identity.
const TIMELINE_ROOT_STYLES = `
  [data-timeline-container] .timeline-item:focus-visible {
    outline: 2px solid ${colors.accent.primary};
    outline-offset: 2px;
  }
  [data-timeline-container] .timeline-slider:focus-visible {
    outline: 2px solid ${colors.accent.primary};
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    [data-timeline-container] *,
    [data-timeline-container] *::before,
    [data-timeline-container] *::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
      scroll-behavior: auto !important;
    }
  }
`;

const TIMELINE_ZOOM_LIMITS = {
  min: timelineStyles.zoomMin,
  max: timelineStyles.zoomMax,
};

// Scroll offsets are presentation state. Only ruler/playhead subscribe; putting
// them on Timeline itself rerenders every clip through the DnD context.
function createTimelineScrollPosition() {
  let left = 0;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => left,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: (next: number) => {
      if (next === left) return;
      left = next;
      for (const listener of listeners) listener();
    },
  };
}
type TimelineScrollPosition = ReturnType<typeof createTimelineScrollPosition>;

function ScrollSynchronizedRuler({
  scrollPosition,
  ...props
}: Omit<React.ComponentProps<typeof TimelineRuler>, 'scrollLeft'> & {
  scrollPosition: TimelineScrollPosition;
}) {
  const scrollLeft = useSyncExternalStore(scrollPosition.subscribe, scrollPosition.getSnapshot);
  return <TimelineRuler {...props} scrollLeft={scrollLeft} />;
}

type TimelineHeaderControlsProps = {
  zoom: number;
  snapEnabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  selectedItem: Item | null;
  selectedTrackId: string | null;
  onUndo: () => void;
  onRedo: () => void;
  onSplitSelected: (trackId: string, item: Item, frame: number) => void;
  onTrimLeftSelected: (trackId: string, item: Item, frame: number) => void;
  onTrimRightSelected: (trackId: string, item: Item, frame: number) => void;
  onDeleteSelected: (trackId: string, itemId: string) => void;
  onAddVideoTrack: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomToFit: () => void;
  onZoomReset: () => void;
  onToggleSnap: () => void;
  onZoomChange: (zoom: number) => void;
  zoomLimits: { min: number; max: number };
};

const TimelineHeaderControls: React.FC<TimelineHeaderControlsProps> =
  React.memo((props) => {
    const { currentFrame } = useEditorPlayback();
    const canEditSelected = Boolean(
      props.selectedItem &&
      props.selectedItem.type !== "transition" &&
      currentFrame > props.selectedItem.from &&
      currentFrame <
        props.selectedItem.from + props.selectedItem.durationInFrames,
    );
    const invokeSelected = (
      callback: (trackId: string, item: Item, frame: number) => void,
    ) => {
      if (!props.selectedTrackId || !props.selectedItem || !canEditSelected)
        return;
      callback(props.selectedTrackId, props.selectedItem, currentFrame);
    };
    return (
      <TimelineHeader
        zoom={props.zoom}
        snapEnabled={props.snapEnabled}
        canUndo={props.canUndo}
        canRedo={props.canRedo}
        canEditSelected={canEditSelected}
        hasSelectedItem={Boolean(props.selectedItem && props.selectedTrackId)}
        onUndo={props.onUndo}
        onRedo={props.onRedo}
        onSplitSelected={() => invokeSelected(props.onSplitSelected)}
        onTrimLeftSelected={() => invokeSelected(props.onTrimLeftSelected)}
        onTrimRightSelected={() => invokeSelected(props.onTrimRightSelected)}
        onDeleteSelected={() => {
          if (!props.selectedTrackId || !props.selectedItem) return;
          props.onDeleteSelected(props.selectedTrackId, props.selectedItem.id);
        }}
        onAddVideoTrack={props.onAddVideoTrack}
        onZoomIn={props.onZoomIn}
        onZoomOut={props.onZoomOut}
        onZoomToFit={props.onZoomToFit}
        onZoomReset={props.onZoomReset}
        onToggleSnap={props.onToggleSnap}
        onZoomChange={props.onZoomChange}
        zoomLimits={props.zoomLimits}
      />
    );
  });

type TimelinePlayheadOverlayProps = {
  pixelsPerFrame: number;
  fps: number;
  timelineHeight: number;
  onSeek: (frame: number) => void;
  scrollPosition: TimelineScrollPosition;
  leftOffset: number;
  durationInFrames: number;
  onPlayEnd: () => void;
};

const TimelinePlayheadOverlay: React.FC<TimelinePlayheadOverlayProps> =
  React.memo((props) => {
    const { currentFrame } = useEditorPlayback();

    const scrollLeft = useSyncExternalStore(props.scrollPosition.subscribe, props.scrollPosition.getSnapshot);

    return (
      <TimelinePlayhead
        currentFrame={currentFrame}
        pixelsPerFrame={props.pixelsPerFrame}
        fps={props.fps}
        timelineHeight={props.timelineHeight}
        onSeek={props.onSeek}
        scrollLeft={scrollLeft}
        leftOffset={props.leftOffset}
        durationInFrames={props.durationInFrames}
        onPlayEnd={props.onPlayEnd}
      />
    );
  });

export const Timeline: React.FC<{
  insertAssetRequest?: TimelineAssetInsertRequest;
  onInsertAssetRequestHandled?: (requestId: string) => void;
  onAnnotationTargetContextMenu?: (target: AgentAnnotationObjectRef) => void;
  showTranscriptTimeline?: boolean;
  onAdmitLibraryMedia?: (
    input: TimelineLibraryMediaAdmissionInput,
  ) => Promise<import("@clash/remotion-core").EditorAssetInput>;
  previewCacheScope?: string;
}> = ({
  insertAssetRequest,
  onInsertAssetRequestHandled,
  onAnnotationTargetContextMenu,
  showTranscriptTimeline = false,
  onAdmitLibraryMedia,
  previewCacheScope,
}) => {
  const dispatch = useEditorDispatch();
  const { canUndo, canRedo, undo, redo, beginHistoryGroup, endHistoryGroup } =
    useEditorHistory();
  const { currentFrameRef, playingRef } = useEditorPlaybackRefs();
  const {
    tracks,
    primaryTrackId,
    selectedItemId,
    selectedTrackId,
    zoom,
    fps,
    durationInFrames,
    assets,
    assetTranscripts,
    compositionWidth,
    compositionHeight,
  } = useEditorStaticState();

  const [snapEnabled, setSnapEnabled] = useState(true);
  const [timelineNotice, setTimelineNotice] = useState<string | null>(null);
  const timelineNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [draggedItem, setDraggedItem] = useState<{
    trackId: string;
    item: Item;
  } | null>(null);
  // const [dragOffset, setDragOffset] = useState<number>(0); // Unused
  // const [assetDragOffset, setAssetDragOffset] = useState<number>(0); // Unused
  const lastDragTopRef = useRef<number | null>(null);

  // 拖动预览状态：存储预期的落点位置（snap后的）
  const [dragPreview, setDragPreview] = useState<{
    itemId: string;
    item: Item;
    originalTrackId: string;
    originalFrom: number;
    previewTrackId: string;
    previewFrame: number;
    rawPreviewFrame?: number;
    // Snap visualization info
    snapEdge?: "left" | "right" | null;
    snapTargetType?:
      | "item-start"
      | "item-end"
      | "playhead"
      | "track-start"
      | "grid"
      | undefined
      | null;
    snapGuideFrame?: number | null; // vertical guide line frame (only for item-start/item-end)
    invalidTarget?: boolean;
  } | null>(null);
  const [insertPosition, setInsertPosition] = useState<number | null>(null);

  // Asset拖动预览状态（从AssetPanel拖入时的预览框）
  const [assetDragPreview, setAssetDragPreview] = useState<{
    item: Item;
    trackId: string;
    isTemporaryTrack: boolean;
    insertIndex?: number;
  } | null>(null);

  const showTimelineNotice = useCallback((message: string) => {
    if (timelineNoticeTimerRef.current)
      clearTimeout(timelineNoticeTimerRef.current);
    setTimelineNotice(message);
    timelineNoticeTimerRef.current = setTimeout(() => {
      setTimelineNotice(null);
      timelineNoticeTimerRef.current = null;
    }, 2400);
  }, []);

  useEffect(
    () => () => {
      if (timelineNoticeTimerRef.current)
        clearTimeout(timelineNoticeTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const handleNotice = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (typeof message === "string" && message) showTimelineNotice(message);
    };
    window.addEventListener(TIMELINE_NOTICE_EVENT, handleNotice);
    return () =>
      window.removeEventListener(TIMELINE_NOTICE_EVENT, handleNotice);
  }, [showTimelineNotice]);

  const containerRef = useRef<HTMLDivElement>(null);
  const handledInsertRequestRef = useRef<string | null>(null);
  const insertRequestCommitted = insertAssetRequest
    ? hasTimelineAssetInsertReceipt(tracks, insertAssetRequest.requestId)
    : false;

  useEffect(() => {
    if (
      !insertAssetRequest ||
      insertRequestCommitted ||
      handledInsertRequestRef.current === insertAssetRequest.requestId
    )
      return;
    handledInsertRequestRef.current = insertAssetRequest.requestId;
    const insertion = buildTimelineAssetInsertion({
      ...insertAssetRequest,
      frame: currentFrameRef.current,
      fps,
      compositionWidth,
      compositionHeight,
    });
    dispatch({ type: "UPSERT_ASSET", payload: insertion.asset });
    dispatch({
      type: "INSERT_TRACK",
      payload: { track: insertion.track, index: tracks.length },
    });
    dispatch({ type: "SELECT_ITEM", payload: insertion.track.items[0].id });
  }, [
    compositionHeight,
    compositionWidth,
    currentFrameRef,
    dispatch,
    fps,
    insertAssetRequest,
    insertRequestCommitted,
    tracks.length,
  ]);

  useEffect(() => {
    if (!insertAssetRequest || !insertRequestCommitted) return;
    handledInsertRequestRef.current = insertAssetRequest.requestId;
    onInsertAssetRequestHandled?.(insertAssetRequest.requestId);
  }, [insertAssetRequest, insertRequestCommitted, onInsertAssetRequestHandled]);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const zoomWheelTargetRef = useRef<HTMLDivElement>(null);
  const tracksViewportRef = useRef<HTMLDivElement | null>(null);
  // Mount point for labels (left column) when externalized from tracks container
  const labelsPortalRef = useRef<HTMLDivElement>(null);
  const [labelsPortalEl, setLabelsPortalEl] = useState<HTMLDivElement | null>(
    null,
  );

  const handleTracksViewportElementChange = useCallback(
    (element: HTMLDivElement | null) => {
      tracksViewportRef.current = element;
    },
    [],
  );

  useEffect(() => {
    // Mount once so TracksContainer receives a stable portal target
    setLabelsPortalEl(labelsPortalRef.current);
  }, []);

  // Sync horizontal scroll position of tracks viewport with ruler and playhead
  const [scrollPosition] = useState(createTimelineScrollPosition);
  const [viewportContentWidth, setViewportContentWidth] = useState(0);
  const pendingZoomAnchorRef = useRef<{
    targetZoom: number;
    anchorOffset: number;
    oldPixelsPerFrame: number;
    oldScrollLeft: number;
    resetScroll: boolean;
  } | null>(null);
  // Visual inset to shift right-pane content without changing layout
  const contentInsetLeftPx = timelineStyles.contentInsetLeft;

  const pixelsPerFrame = getPixelsPerFrame(zoom);
  // dnd-kit sensors
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 2 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 120, tolerance: 6 },
    }),
    useSensor(KeyboardSensor),
  );

  // dnd-kit: item drag start
  const onDndItemStart = useCallback((event: DragStartEvent) => {
    const data: any = event.active.data.current;
    if (!data || !data.item) return;
    const item = data.item as Item;
    const trackId = data.trackId as string;
    setDraggedItem({ trackId, item });
    // Do not set window.currentDraggedItem for dnd-kit flow; keep it for native drag only

    // const initialLeft = event.active.rect.current.initial?.left ?? 0;
    // const activator = event.activatorEvent as PointerEvent | MouseEvent | null;
    // const offsetX = activator && 'clientX' in activator ? activator.clientX - initialLeft : 0;
    // setDragOffset(offsetX);

    const nextPreview = {
      itemId: item.id,
      item,
      originalTrackId: trackId,
      originalFrom: item.from,
      previewTrackId: trackId,
      previewFrame: item.from,
      rawPreviewFrame: item.from,
    };
    setDragPreview(nextPreview);
  }, []);

  // dnd-kit: item drag move/over -> update preview
  const updatePreviewFromDnd = useCallback(
    (leftOnViewport: number, topOnViewport: number, heightPx: number) => {
      if (!draggedItem || !dragPreview) return;

      const container = containerRef.current;
      const viewportEl = tracksViewportRef.current;
      if (!container || !viewportEl) return;

      const containerRect = container.getBoundingClientRect();
      const viewportRect = viewportEl.getBoundingClientRect();
      const leftWithinTracks =
        leftOnViewport -
        containerRect.left -
        timelineStyles.trackLabelWidth -
        contentInsetLeftPx +
        viewportEl.scrollLeft;
      // Use DragOverlay position relative to viewport, then add scrollTop to get absolute position in content
      // (viewport position is visual, we need absolute position in the entire scrollable content)
      const topY = topOnViewport - viewportRect.top + viewportEl.scrollTop;

      const trackHeights = getTimelineTrackHeights(tracks, primaryTrackId);
      const shortestTrackHeight =
        trackHeights.length > 0
          ? Math.min(...trackHeights)
          : timelineStyles.trackHeight;
      const insertThresholdPx = Math.min(
        8,
        Math.floor(shortestTrackHeight * 0.2),
      );
      const preview = buildItemDragPreview({
        leftWithinTracksPx: leftWithinTracks,
        itemTopY: topY,
        itemHeightPx: heightPx,
        prevItemTopY: lastDragTopRef.current ?? undefined,
        pixelsPerFrame,
        tracks,
        item: draggedItem.item,
        originalTrackId: dragPreview.originalTrackId,
        currentFrame: currentFrameRef.current,
        snapEnabled: !!snapEnabled,
        trackHeight: timelineStyles.trackHeight,
        trackHeights,
        insertThresholdPx: insertThresholdPx,
      });
      const previewTrack = tracks.find(
        (track) => track.id === preview.previewTrackId,
      );
      const invalidTarget =
        !preview.willCreateNewTrack &&
        Boolean(
          previewTrack &&
          !canTrackAcceptItem(previewTrack, draggedItem.item, primaryTrackId),
        );

      setInsertPosition(
        preview.willCreateNewTrack ? preview.insertIndex : null,
      );
      setDragPreview({
        ...dragPreview,
        previewTrackId: preview.previewTrackId,
        previewFrame: preview.previewFrame,
        rawPreviewFrame: preview.rawPreviewFrame,
        snapEdge: undefined,
        snapTargetType: undefined,
        snapGuideFrame: preview.snapGuideFrame,
        invalidTarget,
      });
      lastDragTopRef.current = topY;
    },
    [
      draggedItem,
      dragPreview,
      pixelsPerFrame,
      tracks,
      primaryTrackId,
      snapEnabled,
      currentFrameRef,
    ],
  );

  const onDndItemMove = useCallback(
    (event: DragMoveEvent) => {
      const translated = event.active.rect.current.translated;
      const height =
        translated?.height || event.active.rect.current.initial?.height || 0;
      const left =
        translated?.left ??
        (event.active.rect.current.initial?.left || 0) + event.delta.x;
      const top =
        translated?.top ??
        (event.active.rect.current.initial?.top || 0) + event.delta.y;
      updatePreviewFromDnd(left, top, height);
    },
    [updatePreviewFromDnd],
  );

  const onDndItemOver = useCallback(
    (event: DragOverEvent) => {
      const translated = event.active.rect.current.translated;
      const height =
        translated?.height || event.active.rect.current.initial?.height || 0;
      const left =
        translated?.left ??
        (event.active.rect.current.initial?.left || 0) + (event.delta?.x || 0);
      const top =
        translated?.top ??
        (event.active.rect.current.initial?.top || 0) + (event.delta?.y || 0);
      updatePreviewFromDnd(left, top, height);
    },
    [updatePreviewFromDnd],
  );

  // dnd-kit: item drag end -> commit move
  const onDndItemEnd = useCallback(
    (_event: DragEndEvent) => {
      if (!dragPreview) {
        setDraggedItem(null);
        // setDragOffset(0);
        setDragPreview(null);
        window.currentDraggedItem = null;
        return;
      }

      if (dragPreview.invalidTarget) {
        setDraggedItem(null);
        setDragPreview(null);
        setInsertPosition(null);
        window.currentDraggedItem = null;
        return;
      }

      const { item, originalTrackId } = dragPreview;
      const drop = finalizeItemDrop(
        {
          previewTrackId: dragPreview.previewTrackId,
          previewFrame: dragPreview.previewFrame,
          rawPreviewFrame:
            dragPreview.rawPreviewFrame ?? dragPreview.previewFrame,
          insertIndex: insertPosition,
          willCreateNewTrack: insertPosition != null,
          snapGuideFrame: dragPreview.snapGuideFrame ?? null,
        },
        tracks,
        originalTrackId,
      );

      if (drop.type === "create-track") {
        beginHistoryGroup();
        const newTrack = {
          id: `track-${Date.now()}`,
          name: item.type.charAt(0).toUpperCase() + item.type.slice(1),
          items: [{ ...item, from: drop.frame }],
        };
        dispatch({
          type: "INSERT_TRACK",
          payload: { track: newTrack, index: drop.insertIndex },
        });
        dispatch({
          type: "REMOVE_ITEM",
          payload: { trackId: originalTrackId, itemId: item.id },
        });
        endHistoryGroup();
      } else if (drop.type === "move-within-track") {
        dispatch({
          type: "UPDATE_ITEM",
          payload: {
            trackId: drop.targetTrackId,
            itemId: item.id,
            updates: { from: drop.frame },
          },
        });
      } else if (drop.type === "move-to-track") {
        // 如果目标track和源track相同，当作同track移动处理
        if (drop.targetTrackId === originalTrackId) {
          dispatch({
            type: "UPDATE_ITEM",
            payload: {
              trackId: drop.targetTrackId,
              itemId: item.id,
              updates: { from: drop.frame },
            },
          });
        } else {
          dispatch({
            type: "MOVE_ITEM",
            payload: {
              sourceTrackId: originalTrackId,
              targetTrackId: drop.targetTrackId,
              itemId: item.id,
              from: drop.frame,
            },
          });
        }
      }

      dispatch({ type: "SELECT_ITEM", payload: item.id });
      setDraggedItem(null);
      // setDragOffset(0);
      setDragPreview(null);
      setInsertPosition(null);
      window.currentDraggedItem = null;
    },
    [
      beginHistoryGroup,
      dragPreview,
      dispatch,
      endHistoryGroup,
      insertPosition,
      tracks,
    ],
  );

  // Measure available content width (excluding the fixed track label gutter).
  // We use it to:
  // 1) prevent the empty timeline from scrolling horizontally;
  // 2) clamp the ruler/track min widths for a stable layout.
  useEffect(() => {
    const measure = () => {
      const el = workspaceRef.current ?? containerRef.current;
      if (!el) return;
      const width =
        el.getBoundingClientRect().width - timelineStyles.trackLabelWidth;
      setViewportContentWidth(Math.max(0, Math.floor(width)));
    };
    measure();
    const el = workspaceRef.current ?? containerRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (el) resizeObserver?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Derive display length for UI (ruler + tracks)
  // Longest content end (in frames) across all tracks.
  // This is the authoritative bound for generating ticks/labels.
  const contentEndInFrames = useMemo(() => {
    // Longest item end frame
    let maxEnd = 0;
    for (const t of tracks) {
      for (const it of t.items) {
        const end = (it.from || 0) + (it.durationInFrames || 0);
        if (end > maxEnd) maxEnd = end;
      }
    }

    return maxEnd;
  }, [tracks]);

  // Final UI width in frames for ruler + tracks.
  // With items: extend to 1.3x of longest item for better UX headroom.
  // Without items: fill exactly the visible viewport width (no horizontal scroll).
  const displayDurationInFrames = useMemo(() => {
    const framesFromItems =
      contentEndInFrames > 0 ? Math.ceil(contentEndInFrames * 1.3) : 0;

    if (tracks.length === 0 || framesFromItems === 0) {
      if (viewportContentWidth <= 0) return durationInFrames; // fallback
      return Math.max(
        1,
        Math.floor(viewportContentWidth / getPixelsPerFrame(zoom)),
      );
    }

    const neededPx = Math.max(
      frameToPixels(framesFromItems, getPixelsPerFrame(zoom)),
      viewportContentWidth,
    );
    return Math.ceil(neededPx / getPixelsPerFrame(zoom));
  }, [
    tracks.length,
    contentEndInFrames,
    fps,
    zoom,
    viewportContentWidth,
    durationInFrames,
  ]);

  // no extra alignment

  // ==================== 缩放控制 ====================
  const calculateFitZoom = useCallback(() => {
    return fitTimelineZoom({
      contentEndInFrames,
      viewportWidth: viewportContentWidth,
      ...TIMELINE_ZOOM_LIMITS,
    });
  }, [contentEndInFrames, viewportContentWidth]);

  const applyZoom = useCallback(
    (
      requestedZoom: number,
      options?: {
        anchorOffset?: number;
        resetScroll?: boolean;
      },
    ) => {
      const nextZoom = clampTimelineZoom(
        requestedZoom,
        TIMELINE_ZOOM_LIMITS.min,
        TIMELINE_ZOOM_LIMITS.max,
      );
      if (Math.abs(nextZoom - zoom) < 0.000001) return;
      const viewport = tracksViewportRef.current;
      pendingZoomAnchorRef.current = {
        targetZoom: nextZoom,
        anchorOffset:
          options?.anchorOffset ??
          (viewport?.clientWidth ?? viewportContentWidth) / 2,
        oldPixelsPerFrame: pixelsPerFrame,
        oldScrollLeft: viewport?.scrollLeft ?? scrollPosition.getSnapshot(),
        resetScroll: options?.resetScroll ?? false,
      };
      dispatch({ type: "SET_ZOOM", payload: nextZoom });
    },
    [dispatch, pixelsPerFrame, scrollPosition, viewportContentWidth, zoom],
  );

  useLayoutEffect(() => {
    const pending = pendingZoomAnchorRef.current;
    if (!pending || Math.abs(pending.targetZoom - zoom) > 0.000001) return;
    const viewport = tracksViewportRef.current;
    if (!viewport) {
      pendingZoomAnchorRef.current = null;
      return;
    }
    const nextScrollLeft = pending.resetScroll
      ? 0
      : anchoredTimelineScrollLeft({
          scrollLeft: pending.oldScrollLeft,
          anchorOffset: pending.anchorOffset,
          contentInset: contentInsetLeftPx,
          oldPixelsPerFrame: pending.oldPixelsPerFrame,
          newPixelsPerFrame: pixelsPerFrame,
          maxScrollLeft: Math.max(
            0,
            viewport.scrollWidth - viewport.clientWidth,
          ),
        });
    viewport.scrollLeft = nextScrollLeft;
    scrollPosition.set(nextScrollLeft);
    pendingZoomAnchorRef.current = null;
  }, [pixelsPerFrame, scrollPosition, zoom]);

  const handleZoomIn = useCallback(() => {
    applyZoom(
      stepTimelineZoom(
        zoom,
        "in",
        TIMELINE_ZOOM_LIMITS.min,
        TIMELINE_ZOOM_LIMITS.max,
      ),
    );
  }, [applyZoom, zoom]);

  const handleZoomOut = useCallback(() => {
    applyZoom(
      stepTimelineZoom(
        zoom,
        "out",
        TIMELINE_ZOOM_LIMITS.min,
        TIMELINE_ZOOM_LIMITS.max,
      ),
    );
  }, [applyZoom, zoom]);

  // Zoom to fit all content
  const handleZoomToFit = useCallback(() => {
    applyZoom(calculateFitZoom(), { resetScroll: true });
  }, [applyZoom, calculateFitZoom]);

  // Reset zoom to default
  const handleZoomReset = useCallback(() => {
    applyZoom(timelineStyles.zoomDefault);
  }, [applyZoom]);

  // Handle zoom change from slider
  const handleZoomChange = useCallback(
    (newZoom: number) => {
      applyZoom(newZoom);
    },
    [applyZoom],
  );

  const handleZoomWheel = useCallback(
    (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const viewport = tracksViewportRef.current;
      if (!viewport) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const anchorOffset = Math.max(
        0,
        Math.min(viewport.clientWidth, event.clientX - rect.left),
      );
      const factor = Math.exp(-event.deltaY * 0.002);
      applyZoom(zoom * factor, { anchorOffset });
    },
    [applyZoom, zoom],
  );

  useEffect(() => {
    const target = zoomWheelTargetRef.current;
    if (!target) return;
    target.addEventListener("wheel", handleZoomWheel, { passive: false });
    return () => target.removeEventListener("wheel", handleZoomWheel);
  }, [handleZoomWheel]);

  // ==================== 播放头控制 ====================
  const handleSeek = useCallback(
    (frame: number) => {
      dispatch({
        type: "SET_CURRENT_FRAME",
        payload: Math.max(0, Math.min(frame, durationInFrames)),
      });
    },
    [dispatch, durationInFrames],
  );

  const handleSelectTrack = useCallback(
    (trackId: string) => {
      dispatch({ type: "SELECT_TRACK", payload: trackId });
      dispatch({ type: "SELECT_ITEM", payload: null });
    },
    [dispatch],
  );

  const handleAddVideoTrack = useCallback(() => {
    const track = createBrollTrack({
      id: `b-roll-${Date.now().toString(36)}`,
      tracks,
      primaryTrackId,
    });
    dispatch({
      type: "ADD_TRACK",
      payload: track,
    });
    dispatch({ type: "SELECT_TRACK", payload: track.id });
    dispatch({ type: "SELECT_ITEM", payload: null });
  }, [dispatch, primaryTrackId, tracks]);

  // ==================== 素材项操作 ====================
  const handleSelectItem = useCallback(
    (itemId: string) => {
      dispatch({ type: "SELECT_ITEM", payload: itemId });
    },
    [dispatch],
  );

  const handleDeleteItem = useCallback(
    (trackId: string, itemId: string) => {
      dispatch({
        type: "REMOVE_ITEM",
        payload: { trackId, itemId },
      });
    },
    [dispatch],
  );

  const handleUpdateItem = useCallback(
    (trackId: string, itemId: string, updates: Partial<Item>) => {
      dispatch({
        type: "UPDATE_ITEM",
        payload: { trackId, itemId, updates },
      });
    },
    [dispatch],
  );

  const selectedTimelineEntry = useMemo(() => {
    if (!selectedItemId) return null;
    for (const track of tracks) {
      const item = track.items.find(
        (candidate) => candidate.id === selectedItemId,
      );
      if (item) return { trackId: track.id, item };
    }
    return null;
  }, [selectedItemId, tracks]);

  const splitSelectedAtPlayhead = useCallback(
    (trackId: string, item: Item, frame: number) => {
      if (frame <= item.from || frame >= item.from + item.durationInFrames)
        return;
      dispatch({
        type: "SPLIT_ITEM",
        payload: { trackId, itemId: item.id, splitFrame: frame },
      });
    },
    [dispatch],
  );

  const trimSelectedStartToPlayhead = useCallback(
    (trackId: string, item: Item, frame: number) => {
      const endFrame = item.from + item.durationInFrames;
      if (frame <= item.from || frame >= endFrame) return;
      const consumedFrames = frame - item.from;
      handleUpdateItem(trackId, item.id, {
        from: frame,
        durationInFrames: endFrame - frame,
        ...(item.type === "video" || item.type === "audio"
          ? {
              sourceStartInFrames:
                (item.sourceStartInFrames ?? 0) + consumedFrames,
            }
          : {}),
      } as Partial<Item>);
    },
    [handleUpdateItem],
  );

  const trimSelectedEndToPlayhead = useCallback(
    (trackId: string, item: Item, frame: number) => {
      if (frame <= item.from || frame >= item.from + item.durationInFrames)
        return;
      handleUpdateItem(trackId, item.id, {
        durationInFrames: frame - item.from,
      } as Partial<Item>);
    },
    [handleUpdateItem],
  );

  // ==================== 拖放处理（从 AssetPanel 拖入素材 + Timeline内移动）====================
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";

      // 如果是拖动已有item，不处理（由dnd-kit处理）
      if (draggedItem) {
        if (assetDragPreview) setAssetDragPreview(null);
        return;
      }

      if (currentDraggedLibraryRecord) {
        if (assetDragPreview) setAssetDragPreview(null);
        setInsertPosition(null);
        return;
      }

      // 检查是否是从AssetPanel拖入的asset
      // 注意：某些浏览器在dragOver中无法访问dataTransfer数据
      // 所以我们需要依赖AssetPanel中设置的全局变量
      const assetId = e.dataTransfer.getData("assetId");
      const isQuickAdd = e.dataTransfer.getData("quickAdd") === "true";
      const quickAddType = e.dataTransfer.getData("quickAddType");

      // 使用导入的 currentDraggedAsset
      const draggedAsset = currentDraggedAsset;

      if (!assetId && !isQuickAdd && !draggedAsset) {
        if (assetDragPreview) setAssetDragPreview(null);
        return;
      }

      // 计算鼠标位置和目标位置
      const viewportEl = tracksViewportRef.current;
      if (!viewportEl) return;

      const rect = viewportEl.getBoundingClientRect();
      // 计算鼠标相对于 viewport 的位置
      const mouseX =
        e.clientX - rect.left + viewportEl.scrollLeft - contentInsetLeftPx;
      const y = e.clientY - rect.top + viewportEl.scrollTop;

      // 计算 asset 左边缘的位置（减去拖动偏移量）
      const assetLeftX = mouseX - currentAssetDragOffset;
      const rawFrame = Math.max(0, Math.round(assetLeftX / pixelsPerFrame));
      const snapResult = calculateSnap(
        rawFrame,
        tracks,
        null,
        currentFrameRef.current,
        snapEnabled,
        timelineStyles.snapThreshold,
      );
      const frame = Math.max(0, snapResult.snappedFrame);

      const band = getTrackBandAtY(y, tracks, primaryTrackId);
      const tracksHeight = getTimelineTracksHeight(tracks, primaryTrackId);
      const trackIndex = band?.index ?? -1;
      const relativeY = band ? y - band.top : 0;
      const threshold = band ? Math.min(12, Math.floor(band.height * 0.25)) : 0;

      let targetTrackId: string | null = null;
      let insertIdx: number | null = null;

      // 与 item 拖动逻辑保持一致：检测是否在轨道边界附近（要插入新 track）
      if (!band && tracks.length > 0 && y >= tracksHeight) {
        insertIdx = tracks.length;
        setInsertPosition(insertIdx);
        if (assetDragPreview) setAssetDragPreview(null);
        return;
      }
      if (
        band &&
        tracks.length > 0 &&
        (relativeY < threshold || relativeY > band.height - threshold)
      ) {
        // 在轨道边界附近 - 准备插入新 track
        insertIdx = relativeY < threshold ? trackIndex : trackIndex + 1;
        if (insertIdx >= 0 && insertIdx <= tracks.length) {
          // 设置 insertPosition，清除预览框（与 item 拖动一致）
          setInsertPosition(insertIdx);
          if (assetDragPreview) setAssetDragPreview(null);
          return;
        }
      } else if (trackIndex >= 0 && trackIndex < tracks.length) {
        // 在现有轨道上 - 显示预览框
        targetTrackId = tracks[trackIndex].id;
      } else if (tracks.length === 0) {
        // 空时间轴 - 准备创建第一个 track
        insertIdx = 0;
        setInsertPosition(insertIdx);
        if (assetDragPreview) setAssetDragPreview(null);
        return;
      }

      if (!targetTrackId) {
        if (assetDragPreview) setAssetDragPreview(null);
        setInsertPosition(null);
        return;
      }

      // 清除插入位置（因为现在是在现有 track 上）
      setInsertPosition(null);

      // 创建预览item（包含完整信息以正确计算高度）
      let duration = 90; // 默认duration
      let itemType: any = "video";
      let previewItem: Item;

      if (!isQuickAdd) {
        // 优先使用全局draggedAsset，其次尝试从assets中查找
        const asset = draggedAsset || assets.find((a) => a.id === assetId);
        if (asset) {
          itemType = asset.type;
          if (asset.duration) {
            duration = secondsToFrames(asset.duration, fps);
          }

          // 根据类型创建包含完整属性的预览item
          if (asset.type === "video") {
            previewItem = {
              id: `preview-${Date.now()}`,
              type: "video",
              from: frame,
              durationInFrames: duration,
              src: asset.src,
              waveform: asset.waveform,
            } as Item;
          } else if (asset.type === "audio") {
            previewItem = {
              id: `preview-${Date.now()}`,
              type: "audio",
              from: frame,
              durationInFrames: duration,
              src: asset.src,
              waveform: asset.waveform,
            } as Item;
          } else if (asset.type === "image") {
            previewItem = {
              id: `preview-${Date.now()}`,
              type: "image",
              from: frame,
              durationInFrames: duration,
              src: asset.src,
            } as Item;
          } else {
            previewItem = {
              id: `preview-${Date.now()}`,
              type: itemType,
              from: frame,
              durationInFrames: duration,
            } as Item;
          }
        } else {
          previewItem = {
            id: `preview-${Date.now()}`,
            type: itemType,
            from: frame,
            durationInFrames: duration,
          } as Item;
        }
      } else {
        itemType = quickAddType;
        if (quickAddType === "solid") {
          duration = 60;
        }
        previewItem = {
          id: `preview-${Date.now()}`,
          type: itemType,
          from: frame,
          durationInFrames: duration,
        } as Item;
      }

      const targetTrack = tracks.find((track) => track.id === targetTrackId);
      if (
        !targetTrack ||
        !canTrackAcceptItem(targetTrack, previewItem, primaryTrackId)
      ) {
        e.dataTransfer.dropEffect = "none";
        if (assetDragPreview) setAssetDragPreview(null);
        return;
      }

      setAssetDragPreview({
        item: previewItem,
        trackId: targetTrackId,
        isTemporaryTrack: false, // 始终为 false，与 item 拖动逻辑一致
        insertIndex: undefined,
      });
    },
    [
      draggedItem,
      assets,
      tracks,
      primaryTrackId,
      snapEnabled,
      pixelsPerFrame,
      fps,
      assetDragPreview,
      currentFrameRef,
    ],
  );

  // 创建素材项的辅助函数
  //
  // Contract: items carry `sourceNodeId` for the canvas node reference and
  // `assetId` for the Project Asset, matching the Action binding contract.
  // `src` is populated only for fast within-session rendering and stripped on
  // persistence.
  const createItemFromAsset = useCallback(
    (asset: any, frame: number): Item | null => {
      const baseId = `item-${Date.now()}`;
      const sourceNodeId: string | undefined = asset?.sourceNodeId ?? asset?.id;
      const projectAssetId: string | undefined = asset?.projectAssetId;
      if (!projectAssetId) return null;
      const defaultProperties = createTimelineInsertProperties();

      switch (asset.type) {
        case "video":
          return {
            id: baseId,
            type: "video" as const,
            assetId: projectAssetId,
            sourceNodeId,
            from: frame,
            // asset.duration is seconds; convert to frames using current fps (with overhang clamp)
            durationInFrames: asset.duration
              ? secondsToFrames(asset.duration, fps)
              : 90,
            src: asset.src,
            sourceStartInFrames: 0,
            waveform: asset.waveform,
            properties: defaultProperties,
            mediaFit: TIMELINE_INSERT_MEDIA_FIT,
          } as Item;
        case "audio":
          return {
            id: baseId,
            type: "audio" as const,
            assetId: projectAssetId,
            sourceNodeId,
            from: frame,
            durationInFrames: asset.duration
              ? secondsToFrames(asset.duration, fps)
              : 90,
            src: asset.src,
            sourceStartInFrames: 0,
            waveform: asset.waveform,
            properties: defaultProperties,
          } as Item;
        case "image":
          return {
            id: baseId,
            type: "image" as const,
            assetId: projectAssetId,
            sourceNodeId,
            from: frame,
            durationInFrames: 90,
            src: asset.src,
            properties: defaultProperties,
            mediaFit: TIMELINE_INSERT_MEDIA_FIT,
          } as Item;
        default:
          return null;
      }
    },
    [fps],
  );

  const applyLibraryDrop = useCallback(
    async (frame: number, targetTrackId?: string): Promise<void> => {
      const record = currentDraggedLibraryRecord;
      if (!record) return;

      const targetTrack = targetTrackId
        ? tracks.find((track) => track.id === targetTrackId)
        : undefined;
      const needsItemTarget = [
        "transitions",
        "fx",
        "zoom",
        "luts",
        "audio-fx",
        "captions",
        "filters",
        "adjustments",
      ].includes(record.item.category);
      let dropSelectedItemId = selectedItemId;
      if (needsItemTarget && targetTrack) {
        const exact = targetTrack.items.find(
          (item) =>
            frame >= item.from && frame < item.from + item.durationInFrames,
        );
        if (exact) {
          dropSelectedItemId = exact.id;
        }
      }

      const stateForDrop: EditorState = {
        tracks,
        primaryTrackId,
        selectedItemId: dropSelectedItemId,
        selectedTrackId,
        currentFrame: frame,
        playing: false,
        zoom,
        assets,
        assetTranscripts,
        compositionWidth,
        compositionHeight,
        fps,
        durationInFrames,
      };
      let idIndex = 0;
      const admissionInput = timelineLibraryMediaAdmissionInput(record);
      let mediaAsset = findTimelineLibraryProjectAsset(stateForDrop, record);
      if (!mediaAsset && admissionInput) {
        if (!onAdmitLibraryMedia) {
          showTimelineNotice(
            "This catalog media must be added to the Project before use.",
          );
          return;
        }
        try {
          mediaAsset = normalizeEditorAsset(
            await onAdmitLibraryMedia(admissionInput),
          );
        } catch (error) {
          showTimelineNotice(
            error instanceof Error
              ? error.message
              : "Could not add catalog media to the Project.",
          );
          return;
        }
      }
      const application = buildTimelineLibraryApplication({
        state: stateForDrop,
        record,
        targetTrackId,
        transitionTarget:
          record.item.category === "transitions"
            ? { trackId: targetTrackId ?? "", frame }
            : undefined,
        createId: (prefix) =>
          `${prefix}-${Date.now().toString(36)}-${++idIndex}`,
        mediaAsset,
      });
      if (application.disabledReason) {
        showTimelineNotice(application.disabledReason);
        setAssetDragPreview(null);
        setInsertPosition(null);
        return;
      }
      application.actions.forEach(dispatch);
      setAssetDragPreview(null);
      setInsertPosition(null);
    },
    [
      assetTranscripts,
      assets,
      compositionHeight,
      compositionWidth,
      dispatch,
      durationInFrames,
      fps,
      onAdmitLibraryMedia,
      primaryTrackId,
      selectedItemId,
      selectedTrackId,
      showTimelineNotice,
      tracks,
      zoom,
    ],
  );

  // 处理拖放到空白时间轴区域（自动创建轨道）
  const handleTimelineDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();

      if (currentDraggedLibraryRecord) {
        void applyLibraryDrop(currentFrameRef.current);
        return;
      }

      const isQuickAdd = e.dataTransfer.getData("quickAdd") === "true";
      const quickAddType = e.dataTransfer.getData("quickAddType");
      const assetId = e.dataTransfer.getData("assetId");
      const droppedAsset = isQuickAdd
        ? undefined
        : resolveAssetDropPayload({
            assetId,
            dataTransfer: e.dataTransfer,
            assets,
            currentDraggedAsset,
          });

      // 如果没有轨道，先创建一个
      if (tracks.length === 0) {
        const itemType = isQuickAdd
          ? quickAddType
          : droppedAsset?.type || "Track";
        const category: TrackCategory =
          itemType === "text"
            ? "text"
            : itemType === "audio"
              ? "audio"
              : "visual";
        const newTrack = {
          id: `track-${Date.now()}`,
          name: itemType.charAt(0).toUpperCase() + itemType.slice(1),
          category,
          items: [],
        };
        dispatch({ type: "ADD_TRACK", payload: newTrack });

        // 然后添加素材到新轨道
        setTimeout(() => {
          let newItem: Item | null = null;

          if (isQuickAdd) {
            // Handle quick add items
            const defaultProperties = {
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              rotation: 0,
              opacity: 1,
            };

            if (quickAddType === "text") {
              newItem = {
                id: `text-${Date.now()}`,
                type: "text",
                text: "Double click to edit",
                color: "#000000",
                from: 0,
                durationInFrames: 90,
                fontSize: 60,
                properties: defaultProperties,
              } as Item;
            } else if (quickAddType === "solid") {
              newItem = {
                id: `solid-${Date.now()}`,
                type: "solid",
                color: "#" + Math.floor(Math.random() * 16777215).toString(16),
                from: 0,
                durationInFrames: 60,
                properties: defaultProperties,
              } as Item;
            }
          } else {
            // Handle regular assets
            const asset = droppedAsset;
            if (!asset) {
              return;
            }
            newItem = createItemFromAsset(asset, 0);
          }

          if (newItem) {
            dispatch({
              type: "ADD_ITEM",
              payload: { trackId: newTrack.id, item: newItem },
            });
            dispatch({ type: "SELECT_ITEM", payload: newItem.id });
          }

          // 清除asset预览
          setAssetDragPreview(null);
          setInsertPosition(null);
        }, 0);
      }
    },
    [
      applyLibraryDrop,
      assets,
      tracks,
      dispatch,
      createItemFromAsset,
      currentFrameRef,
    ],
  );

  const handleItemDragEnd = useCallback(() => {
    setDraggedItem(null);
    // setDragOffset(0);
    setDragPreview(null);
    setAssetDragPreview(null);
    setInsertPosition(null);
    window.currentDraggedItem = null;
  }, []);

  const handleDrop = useCallback(
    (trackId: string, e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // 如果是拖动已有item，dragEnd会清理状态
      if (draggedItem) {
        return;
      }

      // ========== 处理从AssetPanel拖入新素材 ==========
      const isQuickAdd = e.dataTransfer.getData("quickAdd") === "true";
      const quickAddType = e.dataTransfer.getData("quickAddType");
      const assetId = e.dataTransfer.getData("assetId");

      // 计算放置位置（与 handleDragOver 逻辑保持一致）
      const rect = e.currentTarget.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      // 减去 asset 拖动偏移量，使 drop 位置与预览位置一致
      const assetLeftX = mouseX - currentAssetDragOffset;
      const rawFrame = pixelsToFrame(assetLeftX, pixelsPerFrame);

      // 应用吸附
      const snapResult = calculateSnap(
        rawFrame,
        tracks,
        null,
        currentFrameRef.current,
        snapEnabled,
        timelineStyles.snapThreshold,
      );

      const frame = Math.max(0, snapResult.snappedFrame);

      if (currentDraggedLibraryRecord) {
        void applyLibraryDrop(frame, trackId);
        return;
      }

      let newItem: Item | null = null;

      if (isQuickAdd) {
        // Handle quick add items
        const defaultProperties = {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          rotation: 0,
          opacity: 1,
        };

        if (quickAddType === "text") {
          newItem = {
            id: `text-${Date.now()}`,
            type: "text",
            text: "Double click to edit",
            color: "#ffffff",
            from: frame,
            durationInFrames: 90,
            fontSize: 60,
            properties: defaultProperties,
          } as Item;
        } else if (quickAddType === "solid") {
          newItem = {
            id: `solid-${Date.now()}`,
            type: "solid",
            color: "#" + Math.floor(Math.random() * 16777215).toString(16),
            from: frame,
            durationInFrames: 60,
            properties: defaultProperties,
          } as Item;
        }
      } else {
        // Handle regular assets
        const asset = resolveAssetDropPayload({
          assetId,
          dataTransfer: e.dataTransfer,
          assets,
          currentDraggedAsset,
        });
        if (!asset) {
          return;
        }
        newItem = createItemFromAsset(asset, frame);
      }

      if (!newItem) return;

      const targetTrack = tracks.find((track) => track.id === trackId);
      if (
        !targetTrack ||
        !canTrackAcceptItem(targetTrack, newItem, primaryTrackId)
      ) {
        setAssetDragPreview(null);
        setInsertPosition(null);
        return;
      }

      dispatch({
        type: "ADD_ITEM",
        payload: { trackId, item: newItem },
      });

      // 选中新添加的素材
      dispatch({ type: "SELECT_ITEM", payload: newItem.id });

      // 清除asset预览
      setAssetDragPreview(null);
      setInsertPosition(null);
    },
    [
      applyLibraryDrop,
      draggedItem,
      assets,
      tracks,
      primaryTrackId,
      snapEnabled,
      pixelsPerFrame,
      dispatch,
      createItemFromAsset,
      currentFrameRef,
    ],
  );

  // ==================== 键盘快捷键 ====================
  useKeyboardShortcuts(
    {
      onDelete: () => {
        if (selectedItemId) {
          // 找到包含该素材的轨道
          const track = tracks.find((t) =>
            t.items.some((i) => i.id === selectedItemId),
          );
          if (track) {
            handleDeleteItem(track.id, selectedItemId);
          }
        }
      },
      onPlayPause: () => {
        dispatch({ type: "SET_PLAYING", payload: !playingRef.current });
      },
      onFrameForward: (frames) => {
        handleSeek(currentFrameRef.current + frames);
      },
      onFrameBackward: (frames) => {
        handleSeek(currentFrameRef.current - frames);
      },
      onZoomIn: handleZoomIn,
      onZoomOut: handleZoomOut,
      onCopy: () => {},
      onPaste: () => {},
      onDuplicate: () => {},
      onUndo: undo,
      onRedo: redo,
    },
    true,
  );

  return (
    <div
      ref={containerRef}
      data-timeline-container
      onDragEnd={() => {
        setAssetDragPreview(null);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) {
          setAssetDragPreview(null);
        }
      }}
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: colors.bg.primary,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <style>{TIMELINE_ROOT_STYLES}</style>
      {timelineNotice ? (
        <div
          role="status"
          aria-live="polite"
          data-timeline-notice=""
          style={{
            position: "absolute",
            top: timelineStyles.headerHeight + 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 80,
            maxWidth: "min(420px, calc(100% - 32px))",
            border: `1px solid ${colors.border.default}`,
            borderRadius: 999,
            background: colors.bg.primary,
            boxShadow: "0 8px 24px rgba(66, 48, 35, 0.14)",
            color: colors.text.primary,
            fontSize: 12,
            fontWeight: 600,
            lineHeight: "18px",
            padding: "8px 14px",
            pointerEvents: "none",
            textAlign: "center",
          }}
        >
          {timelineNotice}
        </div>
      ) : null}
      {/* 头部工具栏 - 固定高度 */}
      <TimelineHeaderControls
        zoom={zoom}
        snapEnabled={snapEnabled}
        canUndo={canUndo}
        canRedo={canRedo}
        selectedItem={selectedTimelineEntry?.item ?? null}
        selectedTrackId={selectedTimelineEntry?.trackId ?? null}
        onUndo={undo}
        onRedo={redo}
        onSplitSelected={splitSelectedAtPlayhead}
        onTrimLeftSelected={trimSelectedStartToPlayhead}
        onTrimRightSelected={trimSelectedEndToPlayhead}
        onDeleteSelected={handleDeleteItem}
        onAddVideoTrack={handleAddVideoTrack}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomToFit={handleZoomToFit}
        onZoomReset={handleZoomReset}
        onToggleSnap={() => setSnapEnabled(!snapEnabled)}
        onZoomChange={handleZoomChange}
        zoomLimits={TIMELINE_ZOOM_LIMITS}
      />

      {/* 工作区域：两列布局（左：标签列；右：标尺+轨道） */}
      <div
        className="timeline-workspace"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "row",
          overflow: "hidden",
          position: "relative",
        }}
        ref={workspaceRef}
      >
        {/* 左列：上方标尺占位 + 下方标签列表（通过 Portal 注入）*/}
        <div
          style={{
            width: timelineStyles.trackLabelWidth,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            background: colors.bg.primary,
            borderRight: `1px solid ${colors.border.subtle}`,
            boxSizing: "border-box",
          }}
        >
          {/* 左侧 ruler 顶部占位 */}
          <div
            style={{
              height: timelineStyles.rulerHeight,
              flexShrink: 0,
              position: "sticky",
              top: 0,
              zIndex: 30,
              background: colors.bg.primary,
            }}
          />
          {/* 标签面板挂载点 */}
          <div ref={labelsPortalRef} style={{ flex: 1, minHeight: 0 }} />
        </div>

        {/* 右列：上方标尺 + 下方轨道视口 */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            position: "relative",
            overflow: "hidden", // clip playhead/ruler overflow to right column
            background: colors.bg.primary,
          }}
          data-playhead-container
          ref={zoomWheelTargetRef}
        >
          {/* 标尺 */}
          <div
            style={{
              height: timelineStyles.rulerHeight,
              flexShrink: 0,
              position: "sticky",
              top: 0,
              zIndex: 15,
              background: colors.bg.primary,
              overflow: "hidden",
            }}
          >
            <ScrollSynchronizedRuler
              durationInFrames={displayDurationInFrames}
              pixelsPerFrame={pixelsPerFrame}
              fps={fps}
              onSeek={handleSeek}
              zoom={zoom}
              scrollPosition={scrollPosition}
              viewportWidth={viewportContentWidth}
              leftOffset={contentInsetLeftPx}
            />
          </div>

          {/* 轨道容器 - dnd-kit 包裹，仅用于 item 移动；资产拖入仍走原生 */}
          <DndContext
            sensors={sensors}
            modifiers={[restrictToWindowEdges]}
            onDragStart={onDndItemStart}
            onDragMove={onDndItemMove}
            onDragOver={onDndItemOver}
            onDragEnd={onDndItemEnd}
            autoScroll={{
              enabled: true,
              threshold: { x: 0.2, y: 0.2 },
              acceleration: 10,
            }}
          >
            <TimelineTracksContainer
              durationInFrames={displayDurationInFrames}
              pixelsPerFrame={pixelsPerFrame}
              fps={fps}
              snapEnabled={snapEnabled}
              selectedTrackId={selectedTrackId}
              selectedItemId={selectedItemId}
              assets={assets}
              onSelectTrack={handleSelectTrack}
              onSelectItem={handleSelectItem}
              onDeleteItem={handleDeleteItem}
              onUpdateItem={handleUpdateItem}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onEmptyDrop={handleTimelineDrop}
              // 关闭原生 item 拖拽通道
              onItemDragStart={() => {}}
              onItemDragOver={() => {}}
              onItemDrop={() => {}}
              onItemDragEnd={handleItemDragEnd}
              dragPreview={dragPreview}
              assetDragPreview={assetDragPreview}
              onScrollXChange={scrollPosition.set}
              onViewportElementChange={handleTracksViewportElementChange}
              viewportWidth={viewportContentWidth}
              labelsPortal={labelsPortalEl}
              contentInsetLeftPx={contentInsetLeftPx}
              externalInsertPosition={insertPosition}
              onAnnotationTargetContextMenu={onAnnotationTargetContextMenu}
              showTranscriptTimeline={showTranscriptTimeline}
              previewCacheScope={previewCacheScope}
            />

            <DragOverlay dropAnimation={null}>
              {draggedItem ? (
                <TimelineItem
                  item={draggedItem.item}
                  trackId={draggedItem.trackId}
                  track={
                    tracks.find((t) => t.id === draggedItem.trackId) ||
                    tracks[0]
                  }
                  pixelsPerFrame={pixelsPerFrame}
                  isSelected={false}
                  assets={assets}
                  onSelect={() => {}}
                  onDelete={() => {}}
                  onUpdate={() => {}}
                  isDragOverlay={true}
                  previewCacheScope={previewCacheScope}
                  style={{
                    cursor: dragPreview?.invalidTarget
                      ? "not-allowed"
                      : "grabbing",
                    opacity: dragPreview?.invalidTarget ? 0.45 : 0.95,
                    boxShadow: dragPreview?.invalidTarget
                      ? "0 0 0 1px rgba(248,113,113,0.8)"
                      : "0 8px 24px rgba(0,0,0,0.4)",
                  }}
                />
              ) : null}
            </DragOverlay>
          </DndContext>

          {/* 播放头 - 仅覆盖右侧 */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              pointerEvents: "none",
              zIndex: 20,
            }}
          >
            <TimelinePlayheadOverlay
              pixelsPerFrame={pixelsPerFrame}
              fps={fps}
              timelineHeight={
                getTimelineTracksHeight(tracks, primaryTrackId) +
                timelineStyles.rulerHeight
              }
              onSeek={handleSeek}
              scrollPosition={scrollPosition}
              leftOffset={contentInsetLeftPx}
              durationInFrames={durationInFrames}
              onPlayEnd={() =>
                dispatch({ type: "SET_PLAYING", payload: false })
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
};
