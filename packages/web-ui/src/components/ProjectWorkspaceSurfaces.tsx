import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  ArrowsOutSimple,
  FilmSlate,
  Image as ImageIcon,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  PencilSimple,
  SpeakerHigh,
  Cube,
} from "@phosphor-icons/react";
import {
  buildNleHandoff,
  type Asset as RemotionAsset,
  type EditorAssetInput,
  type EditorAssetTranscript,
  type EditorState,
  type NleAvailability,
  type NleTarget,
  type TimelineDsl,
} from "@clash/remotion-core";
import type { AgentAnnotationObjectRef } from "@clash/shared-types";
import type { TimelineAssetInsertRequest } from "@clash/remotion-ui";
import {
  AsrTimedTranscriptSchema,
  projectTimelineReadToken,
  projectTimelineRevisionId,
  type ProjectCanvas,
  type ProjectTimeline,
  type ResolvedAsset,
  type TimelineExportProgress,
} from "@clash/shared-types";
import { stripSrcFromTracks } from "@clash/web-ui/lib/timelineDsl";
import { resolveAssetMediaUrl } from "../features/assets/media-url";
import { assetAvailabilityLabel } from "../features/assets/availability";
import { getAsset } from "@clash/web-ui/lib/hooks/useAsset";
import { CanvasIcon } from "./ProjectSurfaceIcon";
import {
  hasProjectAssetDragData,
  readProjectAssetDragId,
} from "@clash/web-ui/lib/projectAssetDrag";
import {
  canonicalizeTimelineItemScopeRefs,
  type TimelineMediaInput,
} from "./timelineMediaInputs";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { runtimeApiUrl } from "../lib/runtimeConfig";
import { hydrateTimelineTracksForNle } from "../lib/nleHandoff";

export { ProjectDirectorStageSurface } from "./ProjectDirectorStageSurface";
export type {
  DirectorStageCaptureInput,
  DirectorStageModelGenerationInput,
  DirectorStageUploadedModel,
  DirectorStageUploadedPanorama,
} from "./ProjectDirectorStageSurface";

let timelineEditorModulePromise: ReturnType<
  typeof loadTimelineEditorModule
> | null = null;

function loadTimelineEditorModule() {
  return import("@clash/remotion-ui").then((module) => ({
    default: module.Editor,
  }));
}

export function preloadTimelineEditor() {
  timelineEditorModulePromise ??= loadTimelineEditorModule();
  return timelineEditorModulePromise;
}

const TimelineEditor = lazy(preloadTimelineEditor);

function TimelineEditorLoadingShell() {
  const placeholder = "rounded-md bg-warm-muted";

  return (
    <div
      role="status"
      aria-label="Preparing timeline"
      data-timeline-loading-shell=""
      className="grid h-full min-h-0 [--clash-timeline-gutter:var(--clash-project-chrome-gutter,0.5rem)] [--clash-timeline-control-gap:var(--clash-control-gap,0.25rem)] [--clash-timeline-control-size:var(--clash-project-control-height,2rem)] gap-[var(--clash-timeline-gutter)] overflow-hidden bg-warm-page pb-[var(--clash-timeline-gutter)] pl-[var(--clash-timeline-gutter)] pr-[var(--clash-timeline-gutter)] [grid-template-columns:minmax(0,min(25%,300px))_minmax(0,1fr)_minmax(0,min(28%,340px))] [grid-template-rows:var(--clash-project-sidebar-header-height,2.5rem)_minmax(0,1fr)_280px]"
    >
      <header
        data-loading-region="command-bar"
        className="flex h-[var(--clash-project-sidebar-header-height,2.5rem)] min-h-0 min-w-0 items-center gap-0.5 overflow-hidden bg-warm-page [grid-column:1/4] [grid-row:1]"
      >
        <div
          data-loading-command-bar-content=""
          className="clash-project-chrome-header-content flex min-w-0 flex-1 items-center gap-0.5"
        >
          <span className="h-8 w-8 shrink-0 rounded-matrix bg-brand/[0.09]" />
          {Array.from({ length: 7 }, (_, index) => (
            <span key={index} className={`${placeholder} h-8 w-8 shrink-0`} />
          ))}
        </div>
      </header>
      <aside
        data-loading-region="media"
        className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-warm-page [grid-column:1] [grid-row:2]"
      >
        <div
          data-loading-asset-panel=""
          className="clash-timeline-panel-surface flex min-h-0 flex-1 flex-col gap-4 overflow-hidden rounded-matrix bg-warm-surface p-3"
        >
          <div className="flex items-center justify-between gap-3">
            <span className={`${placeholder} h-4 w-24`} />
            <span className={`${placeholder} h-8 w-8 shrink-0`} />
          </div>
          <span className="h-9 w-full rounded-md bg-brand/[0.09]" />
          <span className={`${placeholder} mt-2 h-4 w-28`} />
          <span className={`${placeholder} h-14 w-full opacity-70`} />
        </div>
      </aside>
      <main
        data-loading-region="preview"
        className="flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-warm-page [grid-column:2] [grid-row:2]"
      >
        <div className="clash-timeline-preview-surface clash-timeline-panel-surface relative h-full w-full overflow-hidden rounded-matrix bg-warm-surface">
          <span className="absolute inset-x-[12%] top-1/2 aspect-video -translate-y-1/2 rounded-matrix bg-warm-muted" />
        </div>
      </main>
      <aside
        data-loading-region="inspector"
        className="min-h-0 min-w-0 overflow-hidden bg-warm-page [grid-column:3] [grid-row:2]"
      >
        <div
          data-loading-inspector-panel=""
          className="clash-timeline-panel-surface flex h-full flex-col gap-4 overflow-hidden rounded-matrix bg-warm-surface p-3"
        >
          <span className={`${placeholder} h-4 w-20`} />
          <span className={`${placeholder} mt-3 h-3 w-16`} />
          <span className={`${placeholder} h-9 w-full`} />
          <span className={`${placeholder} h-9 w-full opacity-70`} />
        </div>
      </aside>
      <div
        data-loading-region="timeline"
        className="clash-timeline-floating-surface clash-timeline-panel-surface flex min-h-0 min-w-0 flex-col overflow-hidden rounded-matrix bg-warm-surface [grid-column:1/4] [grid-row:3]"
      >
        <div className="flex h-12 items-center justify-between px-4">
          <span className={`${placeholder} h-7 w-36`} />
          <span className="h-8 w-8 rounded-full bg-brand/[0.09]" />
          <span className={`${placeholder} h-7 w-44`} />
        </div>
        <div className="grid h-8 grid-cols-[180px_1fr]">
          <span className="bg-warm-page" />
          <span className="bg-warm-muted/70" />
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[180px_1fr]">
          <span className="bg-warm-page" />
          <span
            data-loading-timeline-canvas=""
            className="mb-2 mr-2 bg-warm-surface"
          />
        </div>
      </div>
      <span className="sr-only">Loading Timeline editor</span>
    </div>
  );
}

type ProjectTimelineEditorState = Pick<
  EditorState,
  | "tracks"
  | "primaryTrackId"
  | "compositionWidth"
  | "compositionHeight"
  | "fps"
  | "durationInFrames"
  | "assetTranscripts"
>;

export type ProjectAssetEditMetadata =
  { naturalWidth: number; naturalHeight: number } | { durationSec: number };

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function ImagePreview({
  src,
  label,
  onError,
  onMetadata,
}: {
  src: string;
  label: string;
  onError: () => void;
  onMetadata: (metadata: {
    naturalWidth: number;
    naturalHeight: number;
  }) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const setSteppedZoom = useCallback((direction: 1 | -1) => {
    setZoom((current) => {
      const index = ZOOM_STEPS.findIndex((step) => step >= current - 0.001);
      const next =
        ZOOM_STEPS[
          Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + direction))
        ];
      return next ?? current;
    });
  }, []);

  const fitImage = useCallback(() => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image?.naturalWidth || !image.naturalHeight) return;
    const next = Math.min(
      (stage.clientWidth - 48) / image.naturalWidth,
      (stage.clientHeight - 48) / image.naturalHeight,
      1,
    );
    setZoom(Math.max(0.05, next));
    setPan({ x: 0, y: 0 });
  }, []);

  const actualSize = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  return (
    <div
      ref={stageRef}
      data-testid="project-image-preview-stage"
      className={`relative h-full w-full overflow-hidden bg-warm-page ${zoom > 1 ? "cursor-grab active:cursor-grabbing" : ""}`}
      onWheel={(event) => {
        event.preventDefault();
        setSteppedZoom(event.deltaY < 0 ? 1 : -1);
      }}
      onPointerDown={(event) => {
        if (zoom <= 1) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          originX: pan.x,
          originY: pan.y,
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        setPan({
          x: drag.originX + event.clientX - drag.x,
          y: drag.originY + event.clientY - drag.y,
        });
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId)
          dragRef.current = null;
      }}
    >
      <div className="absolute inset-0 flex items-center justify-center p-6">
        <img
          ref={imageRef}
          src={src}
          alt={label}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain shadow-[0_12px_40px_rgba(41,37,36,0.12)]"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center",
          }}
          onLoad={(event) =>
            onMetadata({
              naturalWidth: event.currentTarget.naturalWidth,
              naturalHeight: event.currentTarget.naturalHeight,
            })
          }
          onError={onError}
        />
      </div>
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-warm-border bg-warm-surface/95 p-1 shadow-lg backdrop-blur">
        <IconButton
          label="Zoom out"
          icon={<MagnifyingGlassMinus className="h-4 w-4" />}
          size="sm"
          shape="rounded"
          onClick={() => setSteppedZoom(-1)}
        />
        <span className="w-12 text-center text-[11px] font-semibold tabular-nums text-stone-600">
          {Math.round(zoom * 100)}%
        </span>
        <IconButton
          label="Zoom in"
          icon={<MagnifyingGlassPlus className="h-4 w-4" />}
          size="sm"
          shape="rounded"
          onClick={() => setSteppedZoom(1)}
        />
        <span className="mx-1 h-5 w-px bg-warm-border" aria-hidden="true" />
        <Button
          size="sm"
          shape="rounded"
          onClick={fitImage}
          className="h-7 min-h-7 px-2 text-[11px] text-stone-600"
        >
          Fit image
        </Button>
        <IconButton
          label="Actual size"
          icon={<ArrowsOutSimple className="h-4 w-4" />}
          size="sm"
          shape="rounded"
          onClick={actualSize}
        />
      </div>
    </div>
  );
}

export function ProjectAssetSurface({
  asset,
  renderEditor,
  inspector,
  headerAction,
  headerEndInset = 0,
}: {
  asset: ResolvedAsset;
  renderEditor?: (
    metadata: ProjectAssetEditMetadata,
    close: () => void,
  ) => ReactNode;
  inspector?: ReactNode;
  headerAction?: ReactNode;
  headerEndInset?: number;
}) {
  const [failed, setFailed] = useState(false);
  const [mediaMetadata, setMediaMetadata] =
    useState<ProjectAssetEditMetadata | null>(null);
  const [editing, setEditing] = useState(false);
  const label =
    asset.name?.trim() || asset.metadata.originalName?.trim() || asset.id;
  const ready = asset.status === "ready";
  const previewUrl = ready ? (resolveAssetMediaUrl(asset.url) ?? "") : "";
  const availabilityLabel = assetAvailabilityLabel(asset);

  useEffect(() => {
    setFailed(false);
    setMediaMetadata(null);
    setEditing(false);
  }, [asset.id, asset.url]);

  const fallback = (
    <div className="flex flex-col items-center gap-2 text-content-muted">
      {asset.kind === "video" ? (
        <FilmSlate className="h-7 w-7" weight="regular" aria-hidden="true" />
      ) : asset.kind === "audio" ? (
        <SpeakerHigh className="h-7 w-7" weight="regular" aria-hidden="true" />
      ) : asset.kind === "model" ? (
        <Cube className="h-7 w-7" weight="regular" aria-hidden="true" />
      ) : (
        <ImageIcon className="h-7 w-7" weight="regular" aria-hidden="true" />
      )}
      <span className="text-xs">
        {asset.kind === "model"
          ? "3D preview unavailable"
          : ready
            ? "Preview unavailable"
            : availabilityLabel}
      </span>
    </div>
  );

  return (
    <main
      aria-label={`${label} ${editing ? "editor" : "preview"}`}
      className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden bg-warm-page"
    >
      <header
        className="flex h-10 shrink-0 items-center gap-2 border-b border-warm-border/80 px-3"
        style={{ paddingRight: headerEndInset }}
      >
        {asset.kind === "video" ? (
          <FilmSlate
            className="h-3.5 w-3.5 shrink-0 text-content-muted"
            weight="regular"
          />
        ) : asset.kind === "audio" ? (
          <SpeakerHigh
            className="h-3.5 w-3.5 shrink-0 text-content-muted"
            weight="regular"
          />
        ) : (
          <ImageIcon
            className="h-3.5 w-3.5 shrink-0 text-content-muted"
            weight="regular"
          />
        )}
        <span
          title={label}
          className="min-w-0 flex-1 truncate text-xs font-medium text-content-secondary"
        >
          {label}
        </span>
        {headerAction}
        {ready &&
        renderEditor &&
        !editing &&
        (asset.kind === "image" || asset.kind === "video") ? (
          <Button
            size="sm"
            shape="rounded"
            leftIcon={<PencilSimple className="h-3.5 w-3.5" weight="regular" />}
            disabled={!mediaMetadata}
            onClick={() => mediaMetadata && setEditing(true)}
            aria-label={asset.kind === "video" ? "Edit video" : "Edit image"}
            className="h-7 min-h-7 rounded-md border-warm-border bg-warm-surface px-2.5 text-xs font-semibold text-content-secondary shadow-none hover:bg-warm-hover hover:text-content-primary"
          >
            Edit
          </Button>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden bg-warm-muted">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col items-stretch justify-stretch overflow-hidden">
          {editing && mediaMetadata && renderEditor ? (
            renderEditor(mediaMetadata, () => setEditing(false))
          ) : failed || !previewUrl || asset.kind === "model" ? (
            <div className="flex h-full items-center justify-center">
              {fallback}
            </div>
          ) : asset.kind === "video" ? (
            <div className="flex h-full w-full items-center justify-center bg-stone-950 p-6">
              <video
                src={previewUrl}
                aria-label={label}
                className="max-h-full max-w-full bg-black object-contain shadow-2xl"
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) =>
                  setMediaMetadata({
                    durationSec: event.currentTarget.duration,
                  })
                }
                onError={() => setFailed(true)}
              />
            </div>
          ) : asset.kind === "audio" ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="w-full max-w-xl rounded-2xl border border-warm-border bg-warm-surface p-5 shadow-sm">
                <audio
                  src={previewUrl}
                  aria-label={label}
                  className="w-full"
                  controls
                  preload="metadata"
                  onError={() => setFailed(true)}
                />
              </div>
            </div>
          ) : (
            <ImagePreview
              src={previewUrl}
              label={label}
              onMetadata={setMediaMetadata}
              onError={() => setFailed(true)}
            />
          )}
        </div>
        {!editing ? inspector : null}
      </div>
    </main>
  );
}

export function ProjectTimelineEditorSurface({
  projectId,
  timeline,
  mediaInputs,
  runtimeNodes = [],
  canvases,
  onSave,
  onExport,
  exportProgress,
  onOpenCanvas,
  onRequestAsset,
  insertAssetRequest,
  onInsertAssetRequestHandled,
  onAdmitTimelineLibraryMedia,
  onProjectAssetDrop,
  onAnnotationTargetContextMenu,
  rightInset = 0,
  headerEndInset = 0,
}: {
  projectId?: string;
  timeline: ProjectTimeline;
  mediaInputs: TimelineMediaInput[];
  runtimeNodes?: Array<{
    id: string;
    type: string;
    data: Record<string, unknown>;
  }>;
  canvases: ProjectCanvas[];
  onSave: (
    timelineId: string,
    state: ProjectTimelineEditorState,
    expectedReadToken: string,
  ) => ProjectTimeline | false | Promise<ProjectTimeline | false>;
  onExport?: (timelineId: string) => Promise<void> | void;
  exportProgress?: readonly TimelineExportProgress[];
  onOpenCanvas: (canvasId: string) => void;
  onRequestAsset?: () => void;
  insertAssetRequest?: TimelineAssetInsertRequest;
  onInsertAssetRequestHandled?: (requestId: string) => void;
  onAdmitTimelineLibraryMedia?: (
    input: EditorAssetInput & { catalogId: string },
  ) => Promise<EditorAssetInput>;
  onProjectAssetDrop?: (assetId: string) => void | Promise<void>;
  onAnnotationTargetContextMenu?: (target: AgentAnnotationObjectRef) => void;
  rightInset?: number;
  headerEndInset?: number;
}) {
  const [isProjectAssetDropActive, setIsProjectAssetDropActive] =
    useState(false);
  const [editorMountReadyTimelineId, setEditorMountReadyTimelineId] = useState<
    string | null
  >(null);
  const [editorRevisionKey, setEditorRevisionKey] = useState(
    timeline.revisionId,
  );
  const [nleAvailability, setNleAvailability] = useState<
    NleAvailability[] | null
  >(null);
  const [nleAvailabilityError, setNleAvailabilityError] = useState<
    string | null
  >(null);
  const editorStateRef = useRef<EditorState | null>(null);
  const editorBaseRevisionRef = useRef(timeline.revisionId);
  const lastIncomingRevisionRef = useRef(timeline.revisionId);
  const editorBaseReadTokenRef = useRef(projectTimelineReadToken(timeline));
  const lastObservedProjectionRef = useRef<string | null>(null);
  const hasLocalTimelineChangesRef = useRef(false);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(
    null,
  );
  const previousRightInsetRef = useRef(rightInset);
  const shouldAnimateInset =
    previousRightInsetRef.current !== rightInset &&
    (previousRightInsetRef.current <= 8 || rightInset <= 8);
  useEffect(() => {
    previousRightInsetRef.current = rightInset;
  }, [rightInset]);
  useEffect(() => {
    if (editorMountReadyTimelineId === timeline.id) return;
    if (typeof window.requestAnimationFrame !== "function") {
      const timeoutId = globalThis.setTimeout(() => {
        setEditorMountReadyTimelineId(timeline.id);
      }, 0);
      return () => globalThis.clearTimeout(timeoutId);
    }

    let mountFrame: number | null = null;
    const paintFrame = window.requestAnimationFrame(() => {
      mountFrame = window.requestAnimationFrame(() => {
        setEditorMountReadyTimelineId(timeline.id);
      });
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      if (mountFrame !== null) window.cancelAnimationFrame(mountFrame);
    };
  }, [editorMountReadyTimelineId, timeline.id]);
  const initialState =
    timeline.state && typeof timeline.state === "object"
      ? (timeline.state as Partial<EditorState>)
      : undefined;
  const seededEditorAssets = useMemo<EditorAssetInput[]>(
    () =>
      mediaInputs.map((input) => ({
        id: input.sourceNodeId,
        projectAssetId: input.projectAssetId,
        sourceNodeId: input.sourceNodeId,
        name: input.displayName,
        src: input.src,
        type: input.type,
      })),
    [mediaInputs],
  );
  const [editorAssets, setEditorAssets] =
    useState<EditorAssetInput[]>(seededEditorAssets);
  useEffect(() => {
    let cancelled = false;
    setEditorAssets(seededEditorAssets);
    void Promise.all(
      mediaInputs.map(async (input): Promise<EditorAssetInput> => {
        try {
          if (!projectId) throw new Error("Project scope unavailable");
          const asset = await getAsset(projectId, input.projectAssetId);
          const src = asset.url || input.src;
          const thumbnail = asset.thumbnailUrl;
          return {
            id: input.sourceNodeId,
            projectAssetId: input.projectAssetId,
            sourceNodeId: input.sourceNodeId,
            name: input.displayName || asset.metadata?.originalName,
            src,
            thumbnail,
            type: input.type,
            width: asset.metadata?.width,
            height: asset.metadata?.height,
            duration: asset.metadata?.durationMs
              ? asset.metadata.durationMs / 1000
              : undefined,
            waveform: asset.metadata?.waveform,
          };
        } catch {
          return seededEditorAssets.find(
            (asset) => asset.sourceNodeId === input.sourceNodeId,
          )!;
        }
      }),
    ).then((resolved) => {
      if (!cancelled) setEditorAssets(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [mediaInputs, projectId, seededEditorAssets]);

  const persistedTimelineState = useCallback(
    (state: EditorState, resolveMedia = true): ProjectTimelineEditorState => ({
      tracks: stripSrcFromTracks(
        resolveMedia ? canonicalizeTimelineItemScopeRefs(state.tracks, mediaInputs) : state.tracks,
      ),
      primaryTrackId: state.primaryTrackId,
      compositionWidth: state.compositionWidth,
      compositionHeight: state.compositionHeight,
      fps: state.fps,
      durationInFrames: state.durationInFrames,
      assetTranscripts: state.assetTranscripts,
    }),
    [mediaInputs],
  );

  const persistCurrentState = useCallback((): Promise<boolean> => {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    // Install the shared promise before invoking the callback. Autosave, export,
    // and teardown must all wait for the same write, never submit it twice.
    const pending = Promise.resolve().then(async () => {
      try {
        while (editorStateRef.current && hasLocalTimelineChangesRef.current) {
          const persistedState = persistedTimelineState(editorStateRef.current);
          // Media discovery is not an edit. Compare the editor content before resolving
          // navigation hints, both here and when observing subsequent changes.
          const submittedProjection = projectTimelineRevisionId(timeline.id, persistedTimelineState(editorStateRef.current, false));
          const accepted = await onSave(timeline.id, persistedState, editorBaseReadTokenRef.current);
          if (!accepted) throw new Error("Timeline save was rejected. Read the latest Timeline before saving again.");
          if (accepted.id !== timeline.id || !accepted.revisionId) {
            throw new Error("Timeline save did not return its accepted revision.");
          }
          editorBaseRevisionRef.current = accepted.revisionId;
          editorBaseReadTokenRef.current = projectTimelineReadToken(accepted);
          // This fingerprint only detects local edits. It is never a Generator revision.
          hasLocalTimelineChangesRef.current = submittedProjection !== lastObservedProjectionRef.current;
        }
        return true;
      } catch (error) {
        window.dispatchEvent(new CustomEvent<string>("clash:timeline-notice", {
          detail: error instanceof Error ? error.message : String(error),
        }));
        return false;
      } finally {
        saveInFlightRef.current = null;
      }
    });
    saveInFlightRef.current = pending;
    return pending;
  }, [onSave, persistedTimelineState, timeline.id]);

  const scheduleStatePersist = useCallback(
    (state: EditorState) => {
      // A child editor can emit its initial projection before our parent effect.
      // Recognize a genuinely new incoming revision, not an old prop left behind
      // briefly after our own asynchronous save acknowledgement.
      if (timeline.revisionId !== lastIncomingRevisionRef.current && !hasLocalTimelineChangesRef.current) {
        if (saveTimerRef.current !== null) {
          globalThis.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        lastIncomingRevisionRef.current = timeline.revisionId;
        editorBaseRevisionRef.current = timeline.revisionId;
        editorBaseReadTokenRef.current = projectTimelineReadToken(timeline);
        lastObservedProjectionRef.current = null;
        setEditorRevisionKey(timeline.revisionId);
      }
      editorStateRef.current = state;
      const projectionRevision = projectTimelineRevisionId(
        timeline.id,
        persistedTimelineState(state, false),
      );
      if (lastObservedProjectionRef.current === null) {
        lastObservedProjectionRef.current = projectionRevision;
        return;
      }
      if (lastObservedProjectionRef.current === projectionRevision) return;
      lastObservedProjectionRef.current = projectionRevision;
      hasLocalTimelineChangesRef.current = true;
      if (saveTimerRef.current !== null) {
        globalThis.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = globalThis.setTimeout(() => {
        saveTimerRef.current = null;
        void persistCurrentState();
      }, 180);
    },
    [persistCurrentState, persistedTimelineState, timeline],
  );

  useEffect(() => {
    const incomingReadToken = projectTimelineReadToken(timeline);
    if (timeline.revisionId === editorBaseRevisionRef.current) {
      lastIncomingRevisionRef.current = timeline.revisionId;
      editorBaseReadTokenRef.current = incomingReadToken;
      return;
    }
    if (hasLocalTimelineChangesRef.current) return;
    if (timeline.revisionId === lastIncomingRevisionRef.current) return;

    if (saveTimerRef.current !== null) {
      globalThis.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    lastIncomingRevisionRef.current = timeline.revisionId;
    editorBaseRevisionRef.current = timeline.revisionId;
    editorBaseReadTokenRef.current = incomingReadToken;
    lastObservedProjectionRef.current = null;
    editorStateRef.current = null;
    setEditorRevisionKey(timeline.revisionId);
  }, [timeline]);

  const refreshNleAvailability = useCallback(async () => {
    const desktop = globalThis.__CLASH_DESKTOP__;
    setNleAvailability(null);
    setNleAvailabilityError(null);
    if (!desktop?.getNleAvailability) {
      setNleAvailabilityError("Installed editor detection is unavailable.");
      return;
    }
    try {
      setNleAvailability(await desktop.getNleAvailability());
    } catch (reason) {
      setNleAvailabilityError(
        reason instanceof Error
          ? reason.message
          : "Could not check installed editors.",
      );
    }
  }, []);

  useEffect(() => {
    if (!globalThis.__CLASH_DESKTOP__?.openInNle) return;
    void refreshNleAvailability();
  }, [refreshNleAvailability]);

  const openInNle = useCallback(
    async (target: NleTarget) => {
      const desktop = globalThis.__CLASH_DESKTOP__;
      if (!desktop?.openInNle)
        throw new Error("Open in is available in the Clash desktop app.");
      if (!(await persistCurrentState()))
        throw new Error(
          "Save the Timeline before opening it in another editor.",
        );
      const state = editorStateRef.current;
      if (!state) throw new Error("Timeline is still loading.");
      const handoffTimeline: TimelineDsl = {
        tracks: hydrateTimelineTracksForNle(state.tracks, state.assets),
        primaryTrackId: state.primaryTrackId,
        compositionWidth: state.compositionWidth,
        compositionHeight: state.compositionHeight,
        fps: state.fps,
        durationInFrames: state.durationInFrames,
      };
      const revisionId = editorBaseRevisionRef.current;
      const handoff = buildNleHandoff({
        target,
        timelineName: timeline.name,
        revisionId,
        timeline: handoffTimeline,
      });
      await desktop.openInNle({
        target,
        timelineName: timeline.name,
        revisionId,
        extension: handoff.extension,
        content: handoff.content,
        assets: handoff.assets,
      });
    },
    [persistCurrentState, persistedTimelineState, timeline.id, timeline.name],
  );

  const exportTimelineVideo = useCallback(async () => {
    if (!(await persistCurrentState()))
      throw new Error("Save the Timeline before exporting it.");
    if (!onExport)
      throw new Error("The Timeline render backend is unavailable.");
    await onExport(timeline.id);
  }, [onExport, persistCurrentState, timeline.id]);

  const transcribeAsset = useCallback(
    async (asset: RemotionAsset): Promise<EditorAssetTranscript> => {
      const assetId = asset.projectAssetId ?? asset.id;
      const mediaResponse = await fetch(asset.src);
      if (!mediaResponse.ok) {
        throw new Error(
          `Could not read ${asset.name} for transcription (HTTP ${mediaResponse.status})`,
        );
      }
      const mediaBlob = await mediaResponse.blob();
      const form = new FormData();
      form.append(
        "file",
        new File([mediaBlob], asset.name || `${assetId}.${asset.type}`, {
          type:
            mediaBlob.type ||
            (asset.type === "video" ? "video/mp4" : "audio/wav"),
        }),
      );
      const response = await fetch(
        runtimeApiUrl("/api/v1/local/audio/transcriptions"),
        {
          method: "POST",
          credentials: "include",
          body: form,
        },
      );
      const raw = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const message =
          raw &&
          typeof raw === "object" &&
          "error" in raw &&
          typeof raw.error === "string"
            ? raw.error
            : `Local transcription failed (HTTP ${response.status})`;
        throw new Error(message);
      }
      const transcript = AsrTimedTranscriptSchema.parse(raw);
      return {
        schemaVersion: 1,
        kind: "clash.editor.asset-transcript",
        assetId,
        text: transcript.text,
        durationMs: transcript.durationMs,
        words: transcript.words,
        backendId: transcript.backendId,
        modelId: transcript.modelId,
        ...(transcript.language ? { language: transcript.language } : {}),
      };
    },
    [],
  );

  const persistRef = useRef(persistCurrentState);
  persistRef.current = persistCurrentState;
  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        globalThis.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void persistRef.current();
    },
    [timeline.id],
  );

  const parentCanvasId =
    timeline.owner.kind === "canvas-action"
      ? timeline.owner.canvasId
      : undefined;
  const parentCanvas = parentCanvasId
    ? canvases.find((canvas) => canvas.id === parentCanvasId)
    : undefined;
  const parentCanvasAction = parentCanvas ? (
    <Tooltip label={`Open parent Canvas ${parentCanvas.name}`}>
      <IconButton
        label={`Open parent Canvas ${parentCanvas.name}`}
        icon={<CanvasIcon className="h-4 w-4" weight="regular" />}
        size="sm"
        shape="rounded"
        onClick={() => onOpenCanvas(parentCanvas.id)}
        className="h-8 min-h-8 w-8 min-w-8 rounded-md text-content-muted hover:bg-warm-hover hover:text-content-primary"
      />
    </Tooltip>
  ) : undefined;
  const handleProjectAssetDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!hasProjectAssetDragData(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setIsProjectAssetDropActive(true);
    },
    [],
  );
  const handleProjectAssetDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!hasProjectAssetDragData(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const assetId = readProjectAssetDragId(event.dataTransfer);
      setIsProjectAssetDropActive(false);
      const reportFailure = (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        window.dispatchEvent(
          new CustomEvent<string>("clash:timeline-notice", {
            detail: message,
          }),
        );
      };
      if (!assetId) {
        reportFailure(new Error("Invalid Project Asset drop"));
        return;
      }
      if (!onProjectAssetDrop) {
        reportFailure(new Error("Project Asset insertion is unavailable"));
        return;
      }
      try {
        void Promise.resolve(onProjectAssetDrop(assetId)).catch(reportFailure);
      } catch (cause) {
        reportFailure(cause);
      }
    },
    [onProjectAssetDrop],
  );
  const editorContentRight =
    rightInset > 0
      ? `calc(${rightInset}px - var(--clash-project-chrome-gutter, 0.5rem))`
      : 0;

  return (
    <main
      data-testid="project-timeline-editor"
      data-project-asset-drop-active={
        isProjectAssetDropActive ? "true" : "false"
      }
      aria-label={`${timeline.name} editor`}
      onDragOverCapture={handleProjectAssetDragOver}
      onDragLeaveCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        setIsProjectAssetDropActive(false);
      }}
      onDropCapture={handleProjectAssetDrop}
      className="absolute inset-0 z-10 min-h-0 overflow-hidden bg-warm-page"
    >
      <div
        data-testid="project-timeline-editor-content"
        className="absolute inset-y-0 left-0 min-w-0 overflow-hidden motion-reduce:transition-none"
        style={{
          right: editorContentRight,
          transition: shouldAnimateInset
            ? "right 240ms cubic-bezier(0.22, 1, 0.36, 1)"
            : "none",
        }}
      >
        {editorMountReadyTimelineId === timeline.id ? (
          <Suspense fallback={<TimelineEditorLoadingShell />}>
            <TimelineEditor
              layout="embedded"
              initialAssets={editorAssets}
              runtimeNodes={runtimeNodes}
              initialState={initialState}
              stateRef={editorStateRef}
              onStateChange={scheduleStatePersist}
              headerLeadingAction={parentCanvasAction}
              headerEndInset={headerEndInset}
              onRequestAsset={onRequestAsset}
              onTranscribeAsset={transcribeAsset}
              insertAssetRequest={insertAssetRequest}
              onInsertAssetRequestHandled={onInsertAssetRequestHandled}
              onAdmitTimelineLibraryMedia={onAdmitTimelineLibraryMedia}
              onExport={onExport ? exportTimelineVideo : undefined}
              exportProgress={exportProgress}
              onOpenInNle={
                globalThis.__CLASH_DESKTOP__?.openInNle ? openInNle : undefined
              }
              nleAvailability={nleAvailability}
              nleAvailabilityError={nleAvailabilityError}
              onRefreshNleAvailability={refreshNleAvailability}
              projectAssetDropActive={isProjectAssetDropActive}
              onAnnotationTargetContextMenu={onAnnotationTargetContextMenu}
              editorKey={`${timeline.id}:${editorRevisionKey}`}
              previewCacheScope={projectId}
            />
          </Suspense>
        ) : (
          <TimelineEditorLoadingShell />
        )}
      </div>
    </main>
  );
}
