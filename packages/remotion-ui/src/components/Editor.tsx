import React from "react";
import type { TimelineLibraryCategory } from "@clash/shared-types/timeline-library";
import type {
  AgentAnnotationObjectRef,
  TimelineExportProgress,
} from "@clash/shared-types";
import {
  EditorProvider,
  getEditorAssetKey,
  normalizeEditorAsset,
  useEditor,
  useEditorDispatch,
  useEditorStaticState,
  type EditorState,
  type EditorAssetInput,
  type Asset,
  type EditorAssetTranscript,
  type NleAvailability,
  type NleTarget,
} from "@clash/remotion-core";
import { CanvasPreview } from "./CanvasPreview";
import type { TimelineRuntimeNode } from "./CanvasPreview";
import { Timeline } from "./Timeline";
import type { TimelineAssetInsertRequest } from "./timeline/insertAssetRequest";
import type { TimelineLibraryMediaAdmissionInput } from "../library/applyTimelineLibraryItem";
import { AssetPanel } from "./AssetPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { TimelineLibraryPanel } from "./TimelineLibraryPanel";
import { CaptionWorkspace } from "./CaptionWorkspace";
import { RemotionButton } from "./ui/controls";
import { Tooltip } from "./ui/tooltip";
import { OpenInMenu } from "./OpenInMenu";
import { editorTypographyVariables } from "./editorTypography";
import {
  TimelinePrimaryToolIcon,
  type TimelinePrimaryToolIconId,
} from "./TimelinePrimaryToolIcon";
import {
  createPreviewAudioMeterStore,
  PreviewAudioMeter,
} from "./previewAudioMeter";

type EmbeddedPanel = "media" | "library" | "captions";
type EditorWorkspace = "assets" | "canvas" | "timeline";
type TimelinePrimaryToolId = TimelinePrimaryToolIconId;

type TimelinePrimaryTool = {
  id: TimelinePrimaryToolId;
  label: string;
  panel: EmbeddedPanel;
  category?: TimelineLibraryCategory;
};

const TIMELINE_PRIMARY_TOOLS: TimelinePrimaryTool[] = [
  { id: "media", label: "Media", panel: "media" },
  {
    id: "sound-effects",
    label: "Audio",
    panel: "library",
    category: "sound-effects",
  },
  { id: "text", label: "Text", panel: "library", category: "text" },
  { id: "stickers", label: "Graphics", panel: "library", category: "stickers" },
  { id: "fx", label: "Effects", panel: "library", category: "fx" },
  { id: "captions", label: "Captions", panel: "captions" },
  { id: "filters", label: "Color", panel: "library", category: "filters" },
];

const PRIMARY_TOOL_FOR_LIBRARY_CATEGORY: Record<
  TimelineLibraryCategory,
  TimelinePrimaryToolId
> = {
  text: "text",
  stickers: "stickers",
  "sound-effects": "sound-effects",
  transitions: "fx",
  fx: "fx",
  zoom: "fx",
  luts: "filters",
  "audio-fx": "sound-effects",
  captions: "captions",
  filters: "filters",
  adjustments: "filters",
};

const EDITOR_WORKSPACE_ORDER: EditorWorkspace[] = [
  "assets",
  "canvas",
  "timeline",
];
const SIDE_PANEL_MIN_WIDTH = 220;
const SIDE_PANEL_MAX_WIDTH = 480;
const INSPECTOR_PANEL_MIN_WIDTH = 240;
const INSPECTOR_PANEL_MAX_WIDTH = 520;
const TIMELINE_MIN_HEIGHT = 180;
const TIMELINE_MAX_HEIGHT = 560;
const panelCollapseTransitionClass =
  "transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

const clampLayoutSize = (
  value: number,
  minimum: number,
  maximum: number,
): number => Math.min(maximum, Math.max(minimum, value));

const isEditableEditorShortcutTarget = (
  target: EventTarget | null,
): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="slider"], [role="spinbutton"]',
    ),
  );
};

const isInteractiveEditorTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="slider"], [role="spinbutton"], [role="combobox"]',
    ),
  );
};

const EditorPanelToggleIcon: React.FC<{ collapsed: boolean }> = ({
  collapsed,
}) => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
    <rect
      x="2.5"
      y="3"
      width="15"
      height="14"
      rx="2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path d="M7 3.5v13" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path
      d={collapsed ? "m10.5 7 3 3-3 3" : "m13.5 7-3 3 3 3"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const InspectorPanelToggleIcon: React.FC<{ collapsed: boolean }> = ({
  collapsed,
}) => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
    <rect
      x="2.5"
      y="3"
      width="15"
      height="14"
      rx="2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path d="M13 3.5v13" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path
      d={collapsed ? "m9.5 7-3 3 3 3" : "m6.5 7 3 3-3 3"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const InspectorRevealIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
    <path
      d="M3.5 5.5h4M11 5.5h5.5M3.5 10h8M15 10h1.5M3.5 14.5h2M9 14.5h7.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <circle cx="9.25" cy="5.5" r="1.5" fill="currentColor" />
    <circle cx="13.25" cy="10" r="1.5" fill="currentColor" />
    <circle cx="7.25" cy="14.5" r="1.5" fill="currentColor" />
  </svg>
);

const AssetInitializer = ({ assets }: { assets: EditorAssetInput[] }) => {
  const dispatch = useEditorDispatch();
  const { assets: editorAssets } = useEditorStaticState();

  React.useEffect(() => {
    if (!assets || assets.length === 0) return;
    assets.forEach((asset) => {
      const assetKey = getEditorAssetKey(asset);
      const next = normalizeEditorAsset(asset);
      const existing = editorAssets.find(
        (candidate) =>
          getEditorAssetKey(candidate) === assetKey ||
          candidate.id === next.id ||
          candidate.src === next.src,
      );
      if (!existing) {
        dispatch({ type: "ADD_ASSET", payload: next });
        return;
      }
      const changed =
        existing.name !== next.name ||
        existing.src !== next.src ||
        existing.thumbnail !== next.thumbnail ||
        existing.width !== next.width ||
        existing.height !== next.height ||
        existing.duration !== next.duration ||
        existing.waveform !== next.waveform ||
        existing.projectAssetId !== next.projectAssetId;
      if (changed) {
        dispatch({
          type: "UPSERT_ASSET",
          payload: { ...next, createdAt: existing.createdAt },
        });
      }
    });
  }, [assets, editorAssets, dispatch]);
  return null;
};

/**
 * Syncs editor state to an external ref without triggering re-renders.
 * Used for "save on close" pattern - parent reads ref when editor closes.
 */
const StateSyncer = ({
  stateRef,
}: {
  stateRef: React.MutableRefObject<EditorState | null>;
}) => {
  const { state } = useEditor();
  // Update ref on every render, no useEffect needed - this is intentional
  stateRef.current = state;
  return null;
};

type EditorProps = {
  initialAssets?: EditorAssetInput[];
  initialState?: Partial<EditorState>;
  /** Non-media Canvas nodes that Timeline runtime items resolve by sourceNodeId. */
  runtimeNodes?: TimelineRuntimeNode[];
  /** Ref to read final state on close - avoids onStateChange overhead during playback */
  stateRef?: React.MutableRefObject<EditorState | null>;
  /** @deprecated Use stateRef for better performance */
  onStateChange?: (state: EditorState) => void;
  onBack?: () => void;
  backLabel?: string;
  /** Optional project-level navigation shown only in the embedded header. */
  headerLeadingAction?: React.ReactNode;
  /** Compact end spacing reserved for a host-owned header control. */
  headerEndInset?: number;
  onAssetUpload?: (file: File, type: "video" | "image" | "audio") => void;
  availableAssets?: EditorAssetInput[];
  onAssetPicked?: (asset: EditorAssetInput) => void;
  /** Opens the host workspace's scope-aware asset picker. */
  onRequestAsset?: () => void;
  /** Runs real word-aligned ASR for one immutable media asset. */
  onTranscribeAsset?: (asset: Asset) => Promise<EditorAssetTranscript>;
  /** Inserts a scope-approved picker/upload asset into the live Timeline. */
  insertAssetRequest?: TimelineAssetInsertRequest;
  /** Acknowledges a request after its asset and track have been dispatched. */
  onInsertAssetRequestHandled?: (requestId: string) => void;
  /** Admits media-backed catalog entries before Timeline creates an item binding. */
  onAdmitTimelineLibraryMedia?: (
    input: TimelineLibraryMediaAdmissionInput,
  ) => Promise<EditorAssetInput>;
  /** Unique key to force remount when opening different editors */
  editorKey?: string;
  /** Export video callback */
  onExport?: () => Promise<void>;
  /** Persisted render jobs for this Timeline, including optional real progress. */
  exportProgress?: readonly TimelineExportProgress[];
  /** Cancels the executor-owned part of an active render; absent for Host jobs. */
  onCancelExport?: () => void;
  /** Creates a revision-pinned interchange package and opens the selected NLE. */
  onOpenInNle?: (target: NleTarget) => Promise<void>;
  /** Installed external editors detected by the desktop main process. */
  nleAvailability?: NleAvailability[] | null;
  nleAvailabilityError?: string | null;
  onRefreshNleAvailability?: () => Promise<void>;
  /** Shows a scoped drop target over the Timeline for a host Project Asset drag. */
  projectAssetDropActive?: boolean;
  /** Reports the exact Timeline track/item opened by the shared agent annotation context menu. */
  onAnnotationTargetContextMenu?: (target: AgentAnnotationObjectRef) => void;
  /** Embedded keeps editing tools left and restores Inspector on the right. */
  layout?: "standalone" | "embedded";
  /** Opaque Host authority scope for disposable poster, filmstrip, and waveform caches. */
  previewCacheScope?: string;
};

export const Editor: React.FC<EditorProps> = ({
  initialAssets,
  initialState,
  runtimeNodes,
  stateRef,
  onStateChange,
  onBack,
  backLabel,
  headerLeadingAction,
  headerEndInset = 0,
  onAssetUpload,
  availableAssets,
  onAssetPicked,
  onRequestAsset,
  onTranscribeAsset,
  insertAssetRequest,
  onInsertAssetRequestHandled,
  onAdmitTimelineLibraryMedia,
  editorKey,
  onExport,
  exportProgress,
  onCancelExport,
  onOpenInNle,
  nleAvailability = null,
  nleAvailabilityError,
  onRefreshNleAvailability,
  projectAssetDropActive = false,
  onAnnotationTargetContextMenu,
  layout = "standalone",
  previewCacheScope,
}) => {
  const [embeddedPanel, setEmbeddedPanel] =
    React.useState<EmbeddedPanel>("media");
  const [libraryCategory, setLibraryCategory] =
    React.useState<TimelineLibraryCategory | null>("fx");
  const [sidePanelCollapsed, setSidePanelCollapsed] = React.useState(false);
  const [sidePanelWidth, setSidePanelWidth] = React.useState(300);
  const [inspectorWidth, setInspectorWidth] = React.useState(300);
  const [timelineHeight, setTimelineHeight] = React.useState(280);
  const [layoutResizing, setLayoutResizing] = React.useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = React.useState(false);
  const [transcriptWorkspaceExpanded, setTranscriptWorkspaceExpanded] =
    React.useState(false);
  const [audioMeterOpen, setAudioMeterOpen] = React.useState(false);
  const audioMeterStore = React.useMemo(createPreviewAudioMeterStore, []);
  const editorRootRef = React.useRef<HTMLDivElement>(null);
  const activeWorkspaceRef = React.useRef<EditorWorkspace>("canvas");
  const sidePanelResizeRef = React.useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const inspectorResizeRef = React.useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const timelineResizeRef = React.useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const toggleAudioMeter = React.useCallback(() => {
    setAudioMeterOpen((open) => !open);
  }, []);
  const activePrimaryTool =
    embeddedPanel === "media"
      ? "media"
      : embeddedPanel === "captions"
        ? "captions"
        : libraryCategory
          ? PRIMARY_TOOL_FOR_LIBRARY_CATEGORY[libraryCategory]
          : null;
  const transcriptWorkspaceActive =
    transcriptWorkspaceExpanded &&
    !sidePanelCollapsed &&
    embeddedPanel === "captions";
  const reserveHeaderEndGutter = headerEndInset > 0;
  const selectPrimaryTool = React.useCallback((tool: TimelinePrimaryTool) => {
    setEmbeddedPanel(tool.panel);
    if (tool.category) {
      setLibraryCategory(tool.category);
    }
    setSidePanelCollapsed(false);
  }, []);
  const getSidePanelMaximum = React.useCallback(() => {
    const rootWidth =
      editorRootRef.current?.getBoundingClientRect().width ?? 1440;
    const reservedPreviewWidth = 336;
    const reservedInspectorWidth = inspectorCollapsed ? 0 : inspectorWidth;
    const reservedGutters = 16;
    return Math.min(
      SIDE_PANEL_MAX_WIDTH,
      Math.max(
        SIDE_PANEL_MIN_WIDTH,
        rootWidth -
          reservedPreviewWidth -
          reservedInspectorWidth -
          reservedGutters,
      ),
    );
  }, [inspectorCollapsed, inspectorWidth]);
  const getInspectorMaximum = React.useCallback(() => {
    const rootWidth =
      editorRootRef.current?.getBoundingClientRect().width ?? 1440;
    const reservedPreviewWidth = 336;
    const reservedSidePanelWidth = sidePanelCollapsed ? 0 : sidePanelWidth;
    const reservedGutters = 16;
    return Math.min(
      INSPECTOR_PANEL_MAX_WIDTH,
      Math.max(
        INSPECTOR_PANEL_MIN_WIDTH,
        rootWidth -
          reservedPreviewWidth -
          reservedSidePanelWidth -
          reservedGutters,
      ),
    );
  }, [sidePanelCollapsed, sidePanelWidth]);
  const resizeSidePanelBy = React.useCallback(
    (delta: number) => {
      setSidePanelWidth((width) =>
        clampLayoutSize(
          width + delta,
          SIDE_PANEL_MIN_WIDTH,
          getSidePanelMaximum(),
        ),
      );
    },
    [getSidePanelMaximum],
  );
  const resizeTimelineBy = React.useCallback((delta: number) => {
    const rootHeight =
      editorRootRef.current?.getBoundingClientRect().height ?? 900;
    const maximum = Math.min(
      TIMELINE_MAX_HEIGHT,
      Math.max(TIMELINE_MIN_HEIGHT, rootHeight - 260),
    );
    setTimelineHeight((height) =>
      clampLayoutSize(height + delta, TIMELINE_MIN_HEIGHT, maximum),
    );
  }, []);
  const resizeInspectorBy = React.useCallback(
    (delta: number) => {
      setInspectorWidth((width) =>
        clampLayoutSize(
          width + delta,
          INSPECTOR_PANEL_MIN_WIDTH,
          getInspectorMaximum(),
        ),
      );
    },
    [getInspectorMaximum],
  );
  const handleSidePanelResizePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      sidePanelResizeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: sidePanelWidth,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setLayoutResizing(true);
    },
    [sidePanelWidth],
  );
  const handleSidePanelResizePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const resize = sidePanelResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      setSidePanelWidth(
        clampLayoutSize(
          resize.startWidth + event.clientX - resize.startX,
          SIDE_PANEL_MIN_WIDTH,
          getSidePanelMaximum(),
        ),
      );
    },
    [getSidePanelMaximum],
  );
  const finishSidePanelResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (sidePanelResizeRef.current?.pointerId !== event.pointerId) return;
      sidePanelResizeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setLayoutResizing(false);
    },
    [],
  );
  const handleInspectorResizePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      inspectorResizeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: inspectorWidth,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setLayoutResizing(true);
    },
    [inspectorWidth],
  );
  const handleInspectorResizePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const resize = inspectorResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      setInspectorWidth(
        clampLayoutSize(
          resize.startWidth + resize.startX - event.clientX,
          INSPECTOR_PANEL_MIN_WIDTH,
          getInspectorMaximum(),
        ),
      );
    },
    [getInspectorMaximum],
  );
  const finishInspectorResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (inspectorResizeRef.current?.pointerId !== event.pointerId) return;
      inspectorResizeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setLayoutResizing(false);
    },
    [],
  );
  const handleTimelineResizePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      timelineResizeRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: timelineHeight,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setLayoutResizing(true);
    },
    [timelineHeight],
  );
  const handleTimelineResizePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const resize = timelineResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      const rootHeight =
        editorRootRef.current?.getBoundingClientRect().height ?? 900;
      const maximum = Math.min(
        TIMELINE_MAX_HEIGHT,
        Math.max(TIMELINE_MIN_HEIGHT, rootHeight - 260),
      );
      setTimelineHeight(
        clampLayoutSize(
          resize.startHeight + resize.startY - event.clientY,
          TIMELINE_MIN_HEIGHT,
          maximum,
        ),
      );
    },
    [],
  );
  const finishTimelineResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (timelineResizeRef.current?.pointerId !== event.pointerId) return;
      timelineResizeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setLayoutResizing(false);
    },
    [],
  );

  React.useEffect(() => {
    const root = editorRootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const keepSidePanelInsideWorkspace = () => {
      setSidePanelWidth((width) =>
        clampLayoutSize(width, SIDE_PANEL_MIN_WIDTH, getSidePanelMaximum()),
      );
    };
    const observer = new ResizeObserver(keepSidePanelInsideWorkspace);
    observer.observe(root);
    keepSidePanelInsideWorkspace();
    return () => observer.disconnect();
  }, [getSidePanelMaximum]);

  React.useEffect(() => {
    const root = editorRootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const keepInspectorInsideWorkspace = () => {
      setInspectorWidth((width) =>
        clampLayoutSize(
          width,
          INSPECTOR_PANEL_MIN_WIDTH,
          getInspectorMaximum(),
        ),
      );
    };
    const observer = new ResizeObserver(keepInspectorInsideWorkspace);
    observer.observe(root);
    keepInspectorInsideWorkspace();
    return () => observer.disconnect();
  }, [getInspectorMaximum]);

  React.useEffect(() => {
    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return;
      if (isEditableEditorShortcutTarget(event.target)) return;

      const root = editorRootRef.current;
      if (!root) return;
      const focusedWorkspace =
        document.activeElement instanceof HTMLElement
          ? document.activeElement.closest<HTMLElement>(
              "[data-editor-workspace]",
            )
          : null;
      const current = focusedWorkspace?.dataset.editorWorkspace as
        EditorWorkspace | undefined;
      const available = EDITOR_WORKSPACE_ORDER.filter(
        (workspace) => workspace !== "assets" || !sidePanelCollapsed,
      );
      const currentIndex = available.indexOf(
        current ?? activeWorkspaceRef.current,
      );
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const startingIndex =
        currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
      const nextIndex =
        (startingIndex + direction + available.length) % available.length;
      const nextWorkspace = available[nextIndex];
      const nextElement = root.querySelector<HTMLElement>(
        `[data-editor-workspace="${nextWorkspace}"]`,
      );
      if (!nextElement) return;

      event.preventDefault();
      activeWorkspaceRef.current = nextWorkspace;
      if (nextWorkspace === "assets" && layout === "embedded") {
        setEmbeddedPanel("media");
      }
      nextElement.focus({ preventScroll: true });
    };

    window.addEventListener("keydown", handleWorkspaceShortcut);
    return () => window.removeEventListener("keydown", handleWorkspaceShortcut);
  }, [layout, sidePanelCollapsed]);
  // Seed assets into initialState synchronously so the first render already
  // has them in state.assets. Without this, `CanvasPreview` → `VideoComposition`
  // renders once with an empty assets map; items whose `src` was stripped on
  // persist (see timelineDsl.stripSrcFromTracks) resolve to `src=""`, Remotion's
  // <Img>/<OffthreadVideo> throw "No src prop", the Player's ErrorBoundary
  // latches on the error UI and never recovers even once AssetInitializer's
  // effect lands the assets on a subsequent pass.
  const seededAssets = React.useMemo(
    () => (initialAssets ?? []).map((asset) => normalizeEditorAsset(asset)),
    [initialAssets],
  );
  const seededInitialState = { ...initialState, assets: seededAssets };
  const inspectorRevealButton = (
    <RemotionButton
      type="button"
      aria-label="Expand Properties"
      title="Expand Properties"
      onClick={() => setInspectorCollapsed((collapsed) => !collapsed)}
      className="clash-workbench-control-button flex h-8 w-8 shrink-0 items-center justify-center bg-brand/[0.09] text-brand transition-colors hover:bg-brand/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <InspectorRevealIcon />
    </RemotionButton>
  );
  const collapseInspectorButton = (
    <RemotionButton
      type="button"
      aria-label="Collapse Properties"
      title="Collapse Properties"
      onClick={() => setInspectorCollapsed((collapsed) => !collapsed)}
      className="clash-workbench-control-button flex h-8 w-8 shrink-0 items-center justify-center bg-transparent text-content-muted transition-colors hover:bg-warm-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <InspectorPanelToggleIcon collapsed={false} />
    </RemotionButton>
  );
  const sidePanelRevealButton = (
    <RemotionButton
      type="button"
      aria-label="Expand editor panel"
      title="Expand editor panel"
      onClick={() => setSidePanelCollapsed(false)}
      className="clash-workbench-control-button flex h-8 w-8 shrink-0 items-center justify-center bg-brand/[0.09] text-brand transition-colors hover:bg-brand/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <EditorPanelToggleIcon collapsed={true} />
    </RemotionButton>
  );
  const collapseSidePanelButton = (
    <RemotionButton
      type="button"
      aria-label="Collapse editor panel"
      title="Collapse editor panel"
      onClick={() => setSidePanelCollapsed(true)}
      className="clash-workbench-control-button flex h-8 w-8 shrink-0 items-center justify-center bg-transparent text-content-muted transition-colors hover:bg-warm-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <EditorPanelToggleIcon collapsed={false} />
    </RemotionButton>
  );
  return (
    <EditorProvider
      initialState={seededInitialState}
      onStateChange={onStateChange}
      key={editorKey}
    >
      {stateRef && <StateSyncer stateRef={stateRef} />}
      <AssetInitializer assets={initialAssets || []} />
      <div
        ref={editorRootRef}
        data-layout={layout}
        style={editorTypographyVariables}
        className="h-full w-full overflow-hidden bg-warm-page font-sans text-content-primary"
      >
        {layout === "embedded" ? (
          <div
            data-editor-grid=""
            data-side-panel-collapsed={sidePanelCollapsed ? "true" : "false"}
            data-inspector-collapsed={inspectorCollapsed ? "true" : "false"}
            data-transcript-workspace-expanded={
              transcriptWorkspaceActive ? "true" : "false"
            }
            style={
              {
                "--clash-timeline-side-panel-min-width": sidePanelCollapsed
                  ? "0px"
                  : "min(12rem,25%)",
                "--clash-timeline-side-panel-width": sidePanelCollapsed
                  ? "0px"
                  : `${sidePanelWidth}px`,
                "--clash-timeline-preview-min-width": "min(21rem,42%)",
                "--clash-timeline-height": `${timelineHeight}px`,
                "--clash-timeline-inspector-min-width": inspectorCollapsed
                  ? "0px"
                  : "min(13rem,28%)",
                "--clash-timeline-inspector-width": inspectorCollapsed
                  ? "0px"
                  : `${inspectorWidth}px`,
              } as React.CSSProperties
            }
            className={`clash-timeline-editor group/timeline-editor grid h-full min-h-0 [--clash-timeline-gutter:var(--clash-project-chrome-gutter,0.5rem)] [--clash-timeline-control-gap:var(--clash-control-gap,0.25rem)] [--clash-timeline-control-size:var(--clash-project-control-height,2rem)] gap-[var(--clash-timeline-gutter)] overflow-hidden bg-warm-page pb-[var(--clash-timeline-gutter)] pl-[var(--clash-timeline-gutter)] ${reserveHeaderEndGutter ? "pr-[var(--clash-timeline-gutter)]" : ""} motion-reduce:transition-none [grid-template-columns:minmax(var(--clash-timeline-side-panel-min-width),var(--clash-timeline-side-panel-width))_minmax(var(--clash-timeline-preview-min-width),1fr)_minmax(var(--clash-timeline-inspector-min-width),var(--clash-timeline-inspector-width))] [grid-template-rows:var(--clash-project-sidebar-header-height,2.5rem)_minmax(0,1fr)_var(--clash-timeline-height)] ${
              layoutResizing
                ? ""
                : "transition-[grid-template-columns,grid-template-rows] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
            }`}
          >
            <header
              data-editor-primary-toolbar=""
              data-editor-region="command-bar"
              className="flex h-[var(--clash-project-sidebar-header-height,2.5rem)] min-h-0 min-w-0 items-center gap-1 overflow-hidden bg-warm-page [grid-column:1/4] [grid-row:1]"
            >
              <div
                data-editor-command-bar-content=""
                className="clash-project-chrome-header-content flex min-w-0 flex-1 items-center gap-1"
              >
                <div
                  data-editor-panel-controls=""
                  className="flex w-max shrink-0 items-center gap-[var(--clash-timeline-control-gap)]"
                >
                  <div className="flex shrink-0 items-center">
                    {headerLeadingAction}
                  </div>
                  {!sidePanelCollapsed ? (
                    <nav
                      data-editor-primary-nav=""
                      aria-label="Timeline editing tools"
                      role="tablist"
                      aria-orientation="horizontal"
                      className="flex flex-none items-center gap-0.5"
                    >
                      {TIMELINE_PRIMARY_TOOLS.map((tool) => (
                        <Tooltip key={tool.id} label={tool.label}>
                          <RemotionButton
                            type="button"
                            role="tab"
                            data-editor-primary-tool={tool.id}
                            aria-selected={activePrimaryTool === tool.id}
                            aria-controls={`editor-${tool.panel}-panel`}
                            aria-label={tool.label}
                            onClick={() => selectPrimaryTool(tool)}
                            className={`clash-workbench-control-button flex h-8 w-8 shrink-0 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                              activePrimaryTool === tool.id
                                ? "bg-brand/[0.09] text-brand hover:bg-brand/[0.14]"
                                : "text-content-muted hover:bg-warm-hover hover:text-content-primary"
                            }`}
                          >
                            <TimelinePrimaryToolIcon tool={tool.id} />
                          </RemotionButton>
                        </Tooltip>
                      ))}
                    </nav>
                  ) : (
                    sidePanelRevealButton
                  )}
                </div>
                <div
                  data-editor-region="inspector-actions"
                  className="ml-auto flex w-max shrink-0 items-center justify-end gap-2"
                  style={{ paddingRight: headerEndInset }}
                >
                  {inspectorCollapsed ? inspectorRevealButton : null}
                  {onExport || onOpenInNle ? (
                    <OpenInMenu
                      onExport={onExport}
                      exportProgress={exportProgress}
                      onCancelExport={onCancelExport}
                      onOpenInNle={onOpenInNle}
                      availability={nleAvailability}
                      availabilityError={nleAvailabilityError}
                      onRefreshAvailability={onRefreshNleAvailability}
                    />
                  ) : null}
                </div>
              </div>
            </header>
            <aside
              data-editor-region="side-panel"
              data-editor-workspace="assets"
              aria-hidden={sidePanelCollapsed}
              tabIndex={-1}
              onPointerDownCapture={() => {
                activeWorkspaceRef.current = "assets";
              }}
              onFocusCapture={() => {
                activeWorkspaceRef.current = "assets";
              }}
              className={`flex min-h-0 min-w-0 flex-col overflow-hidden bg-warm-page [grid-row:2] ${transcriptWorkspaceActive ? "[grid-column:1/4]" : "[grid-column:1]"} ${panelCollapseTransitionClass} ${
                sidePanelCollapsed
                  ? "pointer-events-none -translate-x-2 opacity-0"
                  : `translate-x-0 opacity-100 ${transcriptWorkspaceActive ? "z-10" : ""}`
              }`}
            >
              <div
                id={`editor-${embeddedPanel}-panel`}
                role="tabpanel"
                className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
              >
                {embeddedPanel === "media" ? (
                  <div
                    data-editor-region="media"
                    className="min-h-0 min-w-0 flex-1 overflow-hidden"
                  >
                    <AssetPanel
                      onAssetUpload={onAssetUpload}
                      availableAssets={availableAssets}
                      onAssetPicked={onAssetPicked}
                      onRequestAsset={onRequestAsset}
                      showHeader={false}
                      compact
                      headerTrailingAction={collapseSidePanelButton}
                    />
                  </div>
                ) : embeddedPanel === "captions" ? (
                  <div
                    data-editor-region="captions"
                    className="min-h-0 flex-1 overflow-hidden"
                  >
                    <CaptionWorkspace
                      onTranscribeAsset={onTranscribeAsset}
                      headerTrailingAction={collapseSidePanelButton}
                      onTimelineEditModeChange={setTranscriptWorkspaceExpanded}
                    />
                  </div>
                ) : embeddedPanel === "library" ? (
                  <div
                    data-editor-region="library"
                    className="min-h-0 flex-1 overflow-hidden"
                  >
                    <TimelineLibraryPanel
                      selectedCategory={libraryCategory}
                      onSelectedCategoryChange={setLibraryCategory}
                      headerTrailingAction={collapseSidePanelButton}
                      onAdmitLibraryMedia={onAdmitTimelineLibraryMedia}
                    />
                  </div>
                ) : null}
              </div>
            </aside>
            {!sidePanelCollapsed && !transcriptWorkspaceActive ? (
              <div
                data-editor-resize-handle="side-panel"
                role="separator"
                aria-label="Resize editor panel"
                aria-orientation="vertical"
                aria-valuemin={SIDE_PANEL_MIN_WIDTH}
                aria-valuemax={SIDE_PANEL_MAX_WIDTH}
                aria-valuenow={Math.round(sidePanelWidth)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") resizeSidePanelBy(-12);
                  if (event.key === "ArrowRight") resizeSidePanelBy(12);
                }}
                onPointerDown={handleSidePanelResizePointerDown}
                onPointerMove={handleSidePanelResizePointerMove}
                onPointerUp={finishSidePanelResize}
                onPointerCancel={finishSidePanelResize}
                className="group/side-resize z-20 flex w-3 translate-x-[calc(50%+var(--clash-timeline-gutter)/2)] cursor-col-resize touch-none items-center justify-center justify-self-end outline-none [grid-column:1] [grid-row:2]"
              >
                <span className="h-12 w-0.5 rounded-full bg-stone-300/0 transition-colors group-hover/side-resize:bg-brand/45 group-focus/side-resize:bg-brand/60" />
              </div>
            ) : null}
            <main
              data-editor-region="preview"
              data-editor-workspace="canvas"
              aria-hidden={transcriptWorkspaceActive}
              tabIndex={-1}
              onPointerDownCapture={(event) => {
                activeWorkspaceRef.current = "canvas";
                if (!isEditableEditorShortcutTarget(event.target)) {
                  event.currentTarget.focus({ preventScroll: true });
                }
              }}
              onMouseDownCapture={(event) => {
                activeWorkspaceRef.current = "canvas";
                if (!isEditableEditorShortcutTarget(event.target)) {
                  event.currentTarget.focus({ preventScroll: true });
                }
              }}
              onClickCapture={(event) => {
                activeWorkspaceRef.current = "canvas";
                if (!isInteractiveEditorTarget(event.target)) {
                  event.currentTarget.focus({ preventScroll: true });
                }
              }}
              onFocusCapture={() => {
                activeWorkspaceRef.current = "canvas";
              }}
              className={`flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-warm-page [grid-column:2] [grid-row:2] transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
                transcriptWorkspaceActive
                  ? "pointer-events-none scale-[0.995] opacity-0"
                  : "scale-100 opacity-100"
              }`}
            >
              <div className="clash-timeline-preview-surface clash-timeline-panel-surface h-full w-full overflow-hidden bg-warm-surface">
                <CanvasPreview
                  runtimeNodes={runtimeNodes}
                  audioMeterOpen={audioMeterOpen}
                  onToggleAudioMeter={toggleAudioMeter}
                  audioMeterStore={audioMeterStore}
                />
              </div>
            </main>
            {!inspectorCollapsed && !transcriptWorkspaceActive ? (
              <div
                data-editor-resize-handle="inspector"
                role="separator"
                aria-label="Resize Properties panel"
                aria-orientation="vertical"
                aria-valuemin={INSPECTOR_PANEL_MIN_WIDTH}
                aria-valuemax={INSPECTOR_PANEL_MAX_WIDTH}
                aria-valuenow={Math.round(inspectorWidth)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") resizeInspectorBy(12);
                  if (event.key === "ArrowRight") resizeInspectorBy(-12);
                }}
                onPointerDown={handleInspectorResizePointerDown}
                onPointerMove={handleInspectorResizePointerMove}
                onPointerUp={finishInspectorResize}
                onPointerCancel={finishInspectorResize}
                className="group/inspector-resize z-20 flex w-3 -translate-x-[calc(50%+var(--clash-timeline-gutter)/2)] cursor-col-resize touch-none items-center justify-center justify-self-start outline-none [grid-column:3] [grid-row:2]"
              >
                <span className="h-12 w-0.5 rounded-full bg-stone-300/0 transition-colors group-hover/inspector-resize:bg-brand/45 group-focus/inspector-resize:bg-brand/60" />
              </div>
            ) : null}
            <aside
              data-editor-region="inspector"
              aria-label="Timeline Properties"
              aria-hidden={inspectorCollapsed || transcriptWorkspaceActive}
              className={`flex min-h-0 min-w-0 flex-col overflow-hidden bg-warm-page [grid-column:3] [grid-row:2] ${panelCollapseTransitionClass} ${
                inspectorCollapsed || transcriptWorkspaceActive
                  ? "pointer-events-none translate-x-2 opacity-0"
                  : "translate-x-0 opacity-100"
              }`}
            >
              <div
                data-editor-inspector-panel=""
                className="clash-timeline-panel-surface min-h-0 flex-1 overflow-hidden bg-warm-surface"
              >
                <PropertiesPanel
                  title="Properties"
                  headerAction={collapseInspectorButton}
                />
              </div>
            </aside>
            <div
              data-editor-region="timeline"
              data-editor-workspace="timeline"
              tabIndex={-1}
              onPointerDownCapture={() => {
                activeWorkspaceRef.current = "timeline";
              }}
              onFocusCapture={() => {
                activeWorkspaceRef.current = "timeline";
              }}
              className="clash-timeline-floating-surface clash-timeline-panel-surface relative flex min-h-0 min-w-0 overflow-hidden bg-warm-surface [grid-column:1/4] [grid-row:3]"
            >
              <div
                data-editor-resize-handle="timeline"
                role="separator"
                aria-label="Resize Timeline height"
                aria-orientation="horizontal"
                aria-valuemin={TIMELINE_MIN_HEIGHT}
                aria-valuemax={TIMELINE_MAX_HEIGHT}
                aria-valuenow={Math.round(timelineHeight)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp") resizeTimelineBy(12);
                  if (event.key === "ArrowDown") resizeTimelineBy(-12);
                }}
                onPointerDown={handleTimelineResizePointerDown}
                onPointerMove={handleTimelineResizePointerMove}
                onPointerUp={finishTimelineResize}
                onPointerCancel={finishTimelineResize}
                className="group/timeline-resize absolute inset-x-0 top-0 z-30 flex h-3 -translate-y-1/2 cursor-row-resize touch-none items-center justify-center outline-none"
              >
                <span className="h-0.5 w-12 rounded-full bg-stone-300/0 transition-colors group-hover/timeline-resize:bg-brand/45 group-focus/timeline-resize:bg-brand/60" />
              </div>
              <div className="min-w-0 flex-1">
                <Timeline
                  insertAssetRequest={insertAssetRequest}
                  onInsertAssetRequestHandled={onInsertAssetRequestHandled}
                  onAnnotationTargetContextMenu={onAnnotationTargetContextMenu}
                  showTranscriptTimeline={transcriptWorkspaceActive}
                  onAdmitLibraryMedia={onAdmitTimelineLibraryMedia}
                  previewCacheScope={previewCacheScope}
                />
              </div>
              {audioMeterOpen ? (
                <PreviewAudioMeter store={audioMeterStore} />
              ) : null}
              {projectAssetDropActive ? (
                <div
                  data-timeline-project-asset-drop-indicator=""
                  className="pointer-events-none absolute inset-1 z-40 rounded-matrix border border-dashed border-brand/50 bg-brand/[0.04] shadow-[inset_0_0_0_1px_rgba(255,107,82,0.06)]"
                >
                  <span className="absolute left-3 top-3 inline-flex items-center gap-2 rounded-md border border-brand/20 bg-warm-surface/95 px-2.5 py-1.5 text-xs font-medium text-content-primary shadow-sm">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                    Release to add media
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex h-full gap-3 overflow-hidden p-3">
            <aside
              data-editor-workspace="assets"
              tabIndex={-1}
              onPointerDownCapture={() => {
                activeWorkspaceRef.current = "assets";
              }}
              onFocusCapture={() => {
                activeWorkspaceRef.current = "assets";
              }}
              className="shrink-0 overflow-hidden rounded-xl border border-warm-border bg-warm-surface shadow-sm"
              style={{ width: "22%", minWidth: 220, maxWidth: 360 }}
            >
              <AssetPanel
                onBack={onBack}
                backLabel={backLabel}
                onAssetUpload={onAssetUpload}
                availableAssets={availableAssets}
                onAssetPicked={onAssetPicked}
                onRequestAsset={onRequestAsset}
                onExport={onExport}
              />
            </aside>

            <main className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex min-h-0 flex-1 gap-3">
                <div
                  data-editor-workspace="canvas"
                  tabIndex={-1}
                  onPointerDownCapture={(event) => {
                    activeWorkspaceRef.current = "canvas";
                    if (!isEditableEditorShortcutTarget(event.target)) {
                      event.currentTarget.focus({ preventScroll: true });
                    }
                  }}
                  onMouseDownCapture={(event) => {
                    activeWorkspaceRef.current = "canvas";
                    if (!isEditableEditorShortcutTarget(event.target)) {
                      event.currentTarget.focus({ preventScroll: true });
                    }
                  }}
                  onClickCapture={(event) => {
                    activeWorkspaceRef.current = "canvas";
                    if (!isInteractiveEditorTarget(event.target)) {
                      event.currentTarget.focus({ preventScroll: true });
                    }
                  }}
                  onFocusCapture={() => {
                    activeWorkspaceRef.current = "canvas";
                  }}
                  className="flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-warm-border bg-warm-muted p-3 shadow-sm"
                  style={{ minHeight: 0 }}
                >
                  <div className="h-full w-full overflow-hidden rounded-lg bg-warm-surface shadow-inner ring-1 ring-warm-border/70">
                    <CanvasPreview
                      runtimeNodes={runtimeNodes}
                      audioMeterOpen={audioMeterOpen}
                      onToggleAudioMeter={toggleAudioMeter}
                      audioMeterStore={audioMeterStore}
                    />
                  </div>
                </div>
                <aside className="w-[320px] shrink-0 overflow-hidden rounded-xl border border-warm-border bg-warm-surface shadow-sm">
                  <PropertiesPanel />
                </aside>
              </div>

              <div
                data-editor-workspace="timeline"
                tabIndex={-1}
                onPointerDownCapture={() => {
                  activeWorkspaceRef.current = "timeline";
                }}
                onFocusCapture={() => {
                  activeWorkspaceRef.current = "timeline";
                }}
                className="relative flex overflow-hidden rounded-xl border border-warm-border bg-warm-surface shadow-sm"
                style={{ height: 300, flexShrink: 0 }}
              >
                <div className="min-w-0 flex-1">
                  <Timeline
                    insertAssetRequest={insertAssetRequest}
                    onInsertAssetRequestHandled={onInsertAssetRequestHandled}
                    onAnnotationTargetContextMenu={
                      onAnnotationTargetContextMenu
                    }
                    onAdmitLibraryMedia={onAdmitTimelineLibraryMedia}
                    previewCacheScope={previewCacheScope}
                  />
                </div>
                {audioMeterOpen ? (
                  <PreviewAudioMeter store={audioMeterStore} />
                ) : null}
              </div>
            </main>
          </div>
        )}
      </div>
    </EditorProvider>
  );
};
