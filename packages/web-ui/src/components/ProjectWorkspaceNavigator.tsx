import {
  ArrowCounterClockwise,
  CaretRight,
  ChatCenteredDots,
  Cube,
  DotsThree,
  FilmSlate,
  GlobeSimple,
  Image as ImageIcon,
  Images,
  MagnifyingGlass,
  Plus,
  Shapes,
  TextT,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
  type ComponentProps,
} from "react";
import { Link } from "react-router";
import { motion, useReducedMotion } from "framer-motion";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./ui/collapsible";
import type {
  AgentAnnotationTarget,
  ProjectCanvas,
  ProjectDirectorStage,
  ProjectTimeline,
  ResolvedAsset,
} from "@clash/shared-types";
import { writeProjectAssetDrag } from "@clash/web-ui/lib/projectAssetDrag";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxProvider,
  useComboboxStore,
} from "./ui/combobox";
import { Dialog } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { Tooltip } from "./ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Tab, TabList, TabProvider } from "./ui/tabs";
import { AssetThumbnail } from "../features/assets/AssetThumbnail";
import { projectAssetDisplayName } from "../features/assets/projectAssetPresentation";
import {
  assetThumbnailImageUrl,
  projectAssetPlaybackUrl,
} from "../features/assets/media-url";
import { CanvasIcon } from "./ProjectSurfaceIcon";
import type { ExecutablePluginViewDefinition } from "../hooks/useExecutablePluginViews";

export type ProjectWorkspaceSurface =
  | { kind: "canvas"; canvasId: string }
  | { kind: "plugin-view"; nodeId: string; canvasId: string }
  | { kind: "timeline"; timelineId: string }
  | { kind: "director-stage"; stageId: string }
  | { kind: "text-asset"; nodeId: string; canvasId: string }
  | {
      kind: "asset";
      assetId: string;
    }
  | { kind: "browser"; browserId: string };

export interface ProjectBrowserTab {
  id: string;
  title: string;
  url: string;
}

export interface ProjectTextAsset {
  id: string;
  canvasId: string;
  label: string;
}

export interface ProjectPluginView {
  nodeId: string;
  canvasId: string;
  label: string;
  pluginId: string;
  definitionId: string;
}

interface ProjectWorkspaceNavigatorProps {
  header?: ReactNode;
  footer?: ReactNode;
  canvases: ProjectCanvas[];
  timelines: ProjectTimeline[];
  timelineError?: string | null;
  directorStages?: ProjectDirectorStage[];
  assets: ResolvedAsset[];
  textAssets?: ProjectTextAsset[];
  pluginViews?: ProjectPluginView[];
  pluginViewDefinitions?: ExecutablePluginViewDefinition[];
  globalAssets?: ResolvedAsset[];
  browsers?: ProjectBrowserTab[];
  surface: ProjectWorkspaceSurface;
  onSelectCanvas: (canvasId: string) => void;
  onSelectPluginView?: (view: ProjectPluginView) => void;
  onSelectTimeline: (timelineId: string) => void;
  onSelectDirectorStage?: (stageId: string) => void;
  onSelectAsset: (assetId: string) => void;
  onSelectTextAsset?: (asset: ProjectTextAsset) => void;
  onSelectBrowser?: (browserId: string) => void;
  onCreateCanvas: () => void;
  onCreatePluginView?: (definition: ExecutablePluginViewDefinition) => void;
  onDeletePluginView?: (view: ProjectPluginView) => void;
  onRenameCanvas: (canvas: ProjectCanvas) => void;
  onDeleteCanvas: (canvas: ProjectCanvas) => void;
  onCreateTimeline: () => void;
  onAttachTimeline: (timeline: ProjectTimeline) => void;
  onDeleteTimeline?: (timeline: ProjectTimeline) => void;
  onCreateDirectorStage?: () => void;
  onAttachDirectorStage?: (stage: ProjectDirectorStage) => void;
  onAddAsset: () => void;
  onCreateBrowser?: () => void;
  onCloseBrowser?: (browserId: string) => void;
  onAddGlobalAsset?: (assetId: string) => void | Promise<void>;
  onAddAssetToLibrary?: (assetId: string) => void;
  onTrashAsset?: (assetId: string) => void | Promise<void>;
  onRestoreAsset?: (assetId: string) => void | Promise<void>;
  /** Queues an agent annotation for a sidebar object (project id added by the caller). */
  onAnnotate?: (target: Omit<AgentAnnotationTarget, "projectId">) => void;
}

const sectionHeaderClass =
  "flex h-[var(--clash-project-control-rhythm,2rem)] items-center justify-between pr-1";
const sectionHeadingClass =
  "font-display text-[11px] font-semibold text-stone-500";
const sidebarActionSlotClass =
  "clash-project-sidebar-action-slot h-6 min-h-6 w-6 min-w-6";

type ProjectFolderId =
  "canvases" | "views" | "browsers" | "timelines" | "director-stages" | "assets";

interface ProjectFolderSectionProps {
  id: ProjectFolderId;
  label: string;
  open: boolean;
  addLabel?: string;
  onToggle: () => void;
  onAdd?: () => void;
  addControl?: ReactNode;
  children: ReactNode;
}

function NavigatorTab(props: ComponentProps<typeof Tab>) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      className="min-w-0"
      layout={reducedMotion ? false : "position"}
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        duration: reducedMotion ? 0 : 0.18,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      <Tab {...props} />
    </motion.div>
  );
}

function ProjectFolderSection({
  id,
  label,
  open,
  addLabel,
  onToggle,
  onAdd,
  addControl,
  children,
}: ProjectFolderSectionProps) {
  const headingId = `project-${id}-heading`;
  const contentId = `project-${id}-list`;

  return (
    <Collapsible open={open} onOpenChange={onToggle} asChild>
      <section
        data-project-folder={id}
        aria-labelledby={headingId}
        className="mt-[var(--clash-project-action-phase,0.5rem)] first:mt-0"
      >
        <div data-project-folder-header className={sectionHeaderClass}>
          <h2 className="min-w-0 flex-1">
            <CollapsibleTrigger asChild>
              <Button
                aria-label={label}
                aria-expanded={open}
                aria-controls={contentId}
                variant={null}
                size={null}
                shape={null}
                className="flex h-[var(--clash-project-control-rhythm,2rem)] w-full min-w-0 items-center justify-start gap-1.5 rounded-md bg-transparent pl-2 pr-1 text-left shadow-none hover:bg-warm-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-0"
              >
                <CaretRight
                  className={`h-3 w-3 shrink-0 text-stone-400 transition-transform ${open ? "rotate-90" : ""}`}
                  weight="bold"
                />
                <span id={headingId} className={sectionHeadingClass}>
                  {label}
                </span>
              </Button>
            </CollapsibleTrigger>
          </h2>
          {addControl ??
            (addLabel && onAdd ? (
              <Tooltip label={addLabel}>
                <IconButton
                  label={addLabel}
                  icon={<Plus className="h-3 w-3" weight="bold" />}
                  size="sm"
                  shape="rounded"
                  onClick={onAdd}
                  className={`${sidebarActionSlotClass} rounded-md bg-transparent text-content-muted hover:bg-warm-hover hover:text-content-primary`}
                />
              </Tooltip>
            ) : null)}
        </div>
        <CollapsibleContent
          id={contentId}
          data-project-folder-content
          className="overflow-hidden"
        >
          <div className="space-y-0 pt-1">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

interface SidebarContextAction {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * Right-click menu for a sidebar row: annotate-for-agent first, then the
 * row's own actions (the same ones its "…" dropdown offers).
 */
function SidebarItemContextMenu({
  label,
  onAnnotate,
  actions = [],
  children,
}: {
  label: string;
  onAnnotate?: () => void;
  actions?: SidebarContextAction[];
  children: ReactNode;
}) {
  if (!onAnnotate && actions.length === 0) return <>{children}</>;
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{label}</ContextMenuLabel>
        {onAnnotate ? (
          <ContextMenuItem onSelect={onAnnotate}>
            <ChatCenteredDots
              className="h-4 w-4 shrink-0 text-stone-500 dark:text-stone-400"
              weight="duotone"
            />
            <span className="min-w-0 flex-1 truncate font-medium">
              Annotate for agent
            </span>
          </ContextMenuItem>
        ) : null}
        {onAnnotate && actions.length > 0 ? <ContextMenuSeparator /> : null}
        {actions.map((action) => (
          <ContextMenuItem
            key={action.key}
            onSelect={action.onSelect}
            className={
              action.danger
                ? "text-red-600 data-[highlighted]:text-red-700 dark:text-red-400"
                : undefined
            }
          >
            {action.icon}
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

type ProjectSearchResult =
  | { kind: "canvas"; id: string; label: string; searchText: string }
  | { kind: "plugin-view"; id: string; label: string; searchText: string }
  | { kind: "browser"; id: string; label: string; searchText: string }
  | { kind: "timeline"; id: string; label: string; searchText: string }
  | { kind: "director-stage"; id: string; label: string; searchText: string }
  | {
      kind: "asset";
      id: string;
      label: string;
      searchText: string;
    }
  | {
      kind: "text-asset";
      id: string;
      label: string;
      searchText: string;
    };

function rowClass(active: boolean): string {
  return [
    "group/menu-button relative grid grid-cols-[1.25rem_minmax(0,1fr)] [&>svg]:justify-self-center h-[var(--clash-project-control-rhythm,2rem)] w-full min-w-0 items-center gap-2 rounded-md px-2 pr-8 text-left text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
    active
      ? "bg-brand/[0.09] font-semibold text-slate-950 dark:text-neutral-100"
      : "text-stone-600 hover:bg-black/[0.035] hover:text-slate-950 dark:text-neutral-400 dark:hover:bg-white/[0.045] dark:hover:text-neutral-100",
  ].join(" ");
}

function canvasTabId(canvasId: string): string {
  return `project-canvas-${canvasId}`;
}

function timelineTabId(timelineId: string): string {
  return `project-timeline-${timelineId}`;
}

function pluginViewTabId(nodeId: string): string {
  return `project-plugin-view-${nodeId}`;
}

function browserTabId(browserId: string): string {
  return `project-browser-${browserId}`;
}

function directorStageTabId(stageId: string): string {
  return `project-director-stage-${stageId}`;
}

function assetTabId(assetId: string): string {
  return `project-asset-${assetId}`;
}

function textAssetTabId(nodeId: string): string {
  return `project-text-asset-${nodeId}`;
}

function selectedTabId(surface: ProjectWorkspaceSurface): string {
  if (surface.kind === "canvas") return canvasTabId(surface.canvasId);
  if (surface.kind === "plugin-view") return pluginViewTabId(surface.nodeId);
  if (surface.kind === "browser") return browserTabId(surface.browserId);
  if (surface.kind === "timeline") return timelineTabId(surface.timelineId);
  if (surface.kind === "director-stage")
    return directorStageTabId(surface.stageId);
  if (surface.kind === "text-asset") return textAssetTabId(surface.nodeId);
  return assetTabId(surface.assetId);
}

function assetNavigationLabel(asset: ResolvedAsset): {
  label: string;
  path: string;
} {
  const path = asset.metadata.originalName?.trim() || asset.id;
  const label = projectAssetDisplayName(asset);
  return { label, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function timelineFirstFrameAsset(
  timeline: ProjectTimeline,
  assetsById: ReadonlyMap<string, ResolvedAsset>,
): ResolvedAsset | null {
  if (!isRecord(timeline.state) || !Array.isArray(timeline.state.tracks)) {
    return null;
  }

  let first: { asset: ResolvedAsset; from: number; order: number } | null = null;
  let order = 0;
  for (const track of timeline.state.tracks) {
    if (!isRecord(track) || !Array.isArray(track.items)) continue;
    for (const item of track.items) {
      const itemOrder = order++;
      if (!isRecord(item) || typeof item.assetId !== "string") continue;
      const asset = assetsById.get(item.assetId);
      if (!asset || (asset.kind !== "image" && asset.kind !== "video")) {
        continue;
      }
      const from =
        typeof item.from === "number" && Number.isFinite(item.from)
          ? item.from
          : 0;
      if (
        !first ||
        from < first.from ||
        (from === first.from && itemOrder < first.order)
      ) {
        first = { asset, from, order: itemOrder };
      }
    }
  }
  return first?.asset ?? null;
}

function TimelineSidebarPreview({
  timeline,
  asset,
  active,
}: {
  timeline: ProjectTimeline;
  asset: ResolvedAsset | null;
  active: boolean;
}) {
  const source = asset ? assetThumbnailImageUrl(asset) : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (!source || failedSource === source) {
    return (
      <FilmSlate
        data-project-timeline-fallback-icon="true"
        className={
          active
            ? "h-3.5 w-3.5 shrink-0 text-brand"
            : "h-3.5 w-3.5 shrink-0 text-stone-400"
        }
        weight={active ? "fill" : "regular"}
      />
    );
  }

  return (
    <span className="flex h-5 w-5 shrink-0 overflow-hidden rounded-[3px] border border-warm-border/80 bg-warm-muted">
      <img
        src={source}
        alt={`${timeline.name} first frame`}
        className="h-full w-full object-cover"
        draggable={false}
        onError={() => setFailedSource(source)}
      />
    </span>
  );
}

export default function ProjectWorkspaceNavigator({
  header,
  footer,
  canvases,
  timelines,
  timelineError,
  directorStages = [],
  assets,
  textAssets = [],
  pluginViews = [],
  pluginViewDefinitions = [],
  globalAssets = [],
  browsers = [],
  surface,
  onSelectCanvas,
  onSelectPluginView,
  onSelectTimeline,
  onSelectDirectorStage,
  onSelectAsset,
  onSelectTextAsset,
  onSelectBrowser,
  onCreateCanvas,
  onCreatePluginView,
  onDeletePluginView,
  onRenameCanvas,
  onDeleteCanvas,
  onCreateTimeline,
  onAttachTimeline,
  onDeleteTimeline,
  onCreateDirectorStage,
  onAttachDirectorStage,
  onAddAsset,
  onCreateBrowser,
  onCloseBrowser,
  onAddGlobalAsset,
  onAddAssetToLibrary,
  onTrashAsset,
  onRestoreAsset,
  onAnnotate,
}: ProjectWorkspaceNavigatorProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const activeAssets = useMemo(
    () => assets.filter((asset) => asset.lifecycle.state === "active"),
    [assets],
  );
  const trashedAssets = useMemo(
    () => assets.filter((asset) => asset.lifecycle.state === "trashed"),
    [assets],
  );
  const activeAssetsById = useMemo(
    () => new Map(activeAssets.map((asset) => [asset.id, asset])),
    [activeAssets],
  );
  const [openFolders, setOpenFolders] = useState<
    Record<ProjectFolderId, boolean>
  >({
    canvases: true,
    views: true,
    browsers: true,
    timelines: true,
    "director-stages": true,
    assets: true,
  });
  const searchResults = useMemo<ProjectSearchResult[]>(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const results: ProjectSearchResult[] = [
      ...canvases.map((canvas) => ({
        kind: "canvas" as const,
        id: canvas.id,
        label: canvas.name,
        searchText: `${canvas.name} canvas canvases`,
      })),
      ...pluginViews.map((view) => ({
        kind: "plugin-view" as const,
        id: view.nodeId,
        label: view.label,
        searchText: `${view.label} ${view.pluginId} ${view.definitionId} plugin view`,
      })),
      ...browsers.map((browser) => ({
        kind: "browser" as const,
        id: browser.id,
        label: browser.title,
        searchText: `${browser.title} ${browser.url} browser web page`,
      })),
      ...timelines.map((timeline) => ({
        kind: "timeline" as const,
        id: timeline.id,
        label: timeline.name,
        searchText: `${timeline.name} timeline timelines`,
      })),
      ...directorStages.map((stage) => ({
        kind: "director-stage" as const,
        id: stage.id,
        label: stage.name,
        searchText: `${stage.name} director stage 3d blocking camera`,
      })),
      ...activeAssets.map((asset) => {
        const { label, path } = assetNavigationLabel(asset);
        return {
          kind: "asset" as const,
          id: asset.id,
          label,
          searchText: [label, path, asset.id, asset.kind, "asset assets media"]
            .filter((value): value is string => typeof value === "string")
            .join(" "),
        };
      }),
      ...textAssets.map((asset) => ({
        kind: "text-asset" as const,
        id: asset.id,
        label: asset.label,
        searchText: `${asset.label} text script document asset ${asset.canvasId}`,
      })),
    ];

    if (!normalizedQuery) return results;
    return results.filter((result) =>
      result.searchText.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [
    activeAssets,
    browsers,
    canvases,
    directorStages,
    pluginViews,
    searchQuery,
    textAssets,
    timelines,
  ]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const handleSearchSelection = useCallback(
    (selectedValue: string) => {
      const [kind, ...idParts] = selectedValue.split(":");
      const id = idParts.join(":");
      if (kind === "canvas") onSelectCanvas(id);
      if (kind === "plugin-view") {
        const view = pluginViews.find((candidate) => candidate.nodeId === id);
        if (view) onSelectPluginView?.(view);
      }
      if (kind === "browser") onSelectBrowser?.(id);
      if (kind === "timeline") onSelectTimeline(id);
      if (kind === "director-stage") onSelectDirectorStage?.(id);
      if (kind === "asset") onSelectAsset(id);
      if (kind === "text-asset") {
        const textAsset = textAssets.find((candidate) => candidate.id === id);
        if (textAsset) onSelectTextAsset?.(textAsset);
      }
      closeSearch();
    },
    [
      closeSearch,
      onSelectAsset,
      onSelectCanvas,
      onSelectPluginView,
      onSelectBrowser,
      onSelectDirectorStage,
      onSelectTextAsset,
      onSelectTimeline,
      pluginViews,
      textAssets,
    ],
  );

  const searchStore = useComboboxStore({
    value: searchQuery,
    setValue: setSearchQuery,
    setSelectedValue: (selectedValue) => {
      if (typeof selectedValue === "string")
        handleSearchSelection(selectedValue);
    },
    focusLoop: true,
    focusWrap: true,
    orientation: "vertical",
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLocaleLowerCase() === "k"
      ) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const folderId: ProjectFolderId =
      surface.kind === "canvas"
        ? "canvases"
        : surface.kind === "plugin-view"
          ? "views"
        : surface.kind === "browser"
          ? "browsers"
          : surface.kind === "timeline"
            ? "timelines"
            : surface.kind === "director-stage"
              ? "director-stages"
              : "assets";
    setOpenFolders((current) =>
      current[folderId] ? current : { ...current, [folderId]: true },
    );
  }, [surface]);

  const surfacesRef = useRef<HTMLDivElement>(null);
  const pendingInset = useRef<{
    base: number;
    original: string;
    limit: number;
    ceiling: number;
    extra: number;
  } | null>(null);

  const consumePendingInset = useCallback(() => {
    const scroller = surfacesRef.current;
    const pending = pendingInset.current;
    if (!scroller || !pending) return;
    const offset = Math.min(scroller.scrollTop, pending.ceiling);
    if (scroller.scrollTop > offset) scroller.scrollTop = offset;
    pending.ceiling = offset;
    if (offset <= Math.max(0, pending.limit)) {
      scroller.style.paddingBottom = pending.original;
      pendingInset.current = null;
    } else {
      pending.extra = offset - pending.limit;
      scroller.style.paddingBottom = `${pending.base + pending.extra}px`;
    }
  }, []);

  const toggleFolder = useCallback(
    (folderId: ProjectFolderId) => {
      const scroller = surfacesRef.current;
      const content = scroller?.querySelector<HTMLElement>(
        `[data-project-folder="${folderId}"] [data-project-folder-content]`,
      );
      if (openFolders[folderId] && scroller && content) {
        const currentPadding =
          parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
        const base = pendingInset.current?.base ?? currentPadding;
        const previousExtra = currentPadding - base;
        // Keep a negative limit: content shorter than the viewport needs that
        // additional space too, otherwise the browser immediately clamps to zero.
        const limit =
          scroller.scrollHeight -
          previousExtra -
          content.offsetHeight -
          scroller.clientHeight;
        if (scroller.scrollTop > Math.max(0, limit)) {
          const extra = scroller.scrollTop - limit;
          pendingInset.current = {
            base,
            original:
              pendingInset.current?.original ?? scroller.style.paddingBottom,
            limit,
            ceiling: scroller.scrollTop,
            extra,
          };
          scroller.style.paddingBottom = `${base + extra}px`;
        }
      }
      setOpenFolders((current) => ({
        ...current,
        [folderId]: !current[folderId],
      }));
    },
    [openFolders],
  );

  const releaseInsetAfterExpansion = useCallback(() => {
    const scroller = surfacesRef.current;
    const pending = pendingInset.current;
    if (!scroller || !pending) return;
    pending.limit =
      scroller.scrollHeight - pending.extra - scroller.clientHeight;
    consumePendingInset();
  }, [consumePendingInset]);

  const reducedMotion = useReducedMotion();
  const previousFolders = useRef(openFolders);
  useEffect(() => {
    const expanded = (Object.keys(openFolders) as ProjectFolderId[]).some(
      (id) => openFolders[id] && !previousFolders.current[id],
    );
    previousFolders.current = openFolders;
    if (expanded && reducedMotion) releaseInsetAfterExpansion();
  }, [openFolders, reducedMotion, releaseInsetAfterExpansion]);

  const handleSelectedTabChange = (tabId: string | null | undefined) => {
    if (!tabId) return;
    const canvas = canvases.find(
      (candidate) => canvasTabId(candidate.id) === tabId,
    );
    if (canvas) {
      onSelectCanvas(canvas.id);
      return;
    }
    const pluginView = pluginViews.find(
      (candidate) => pluginViewTabId(candidate.nodeId) === tabId,
    );
    if (pluginView) {
      onSelectPluginView?.(pluginView);
      return;
    }
    const browser = browsers.find(
      (candidate) => browserTabId(candidate.id) === tabId,
    );
    if (browser) {
      onSelectBrowser?.(browser.id);
      return;
    }
    const timeline = timelines.find(
      (candidate) => timelineTabId(candidate.id) === tabId,
    );
    if (timeline) {
      onSelectTimeline(timeline.id);
      return;
    }
    const directorStage = directorStages.find(
      (candidate) => directorStageTabId(candidate.id) === tabId,
    );
    if (directorStage) {
      onSelectDirectorStage?.(directorStage.id);
      return;
    }
    const asset = activeAssets.find(
      (candidate) => assetTabId(candidate.id) === tabId,
    );
    if (asset) {
      onSelectAsset(asset.id);
      return;
    }
    const textAsset = textAssets.find(
      (candidate) => textAssetTabId(candidate.id) === tabId,
    );
    if (textAsset) onSelectTextAsset?.(textAsset);
  };

  const searchButton = (
    <Button
      aria-label="Search project"
      variant={null}
      size={null}
      shape={null}
      onClick={() => setSearchOpen(true)}
      className="h-[var(--clash-project-control-rhythm,2rem)] w-full justify-start gap-2 rounded-md border border-warm-border/80 bg-warm-surface px-2 text-[12px] font-normal text-stone-500 shadow-none hover:bg-warm-muted focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-offset-0 dark:text-neutral-400 dark:hover:text-neutral-200"
      leftIcon={<MagnifyingGlass className="h-3.5 w-3.5" weight="regular" />}
    >
      <span className="min-w-0 flex-1 truncate text-left">Search</span>
      <kbd className="font-sans text-[10px] font-medium text-stone-400">⌘K</kbd>
    </Button>
  );
  return (
    <div
      data-project-navigator-body="true"
      className="relative z-20 flex h-full min-h-0 w-full flex-col overflow-hidden bg-warm-page"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-30 w-px bg-warm-border"
      />
      {header ? (
        <div className="clash-project-sidebar-header flex h-10 shrink-0 items-center px-2">
          {header}
        </div>
      ) : null}
      <div className="clash-project-sidebar-search flex h-[var(--clash-project-search-row-height,2.5rem)] shrink-0 items-start px-2 pt-[var(--clash-project-action-phase,0.5rem)]">
        {searchButton}
      </div>
      <TabProvider
        selectedId={selectedTabId(surface)}
        setSelectedId={handleSelectedTabChange}
        orientation="vertical"
        focusLoop
      >
        <TabList
          ref={surfacesRef}
          onScroll={consumePendingInset}
          onAnimationEnd={(event) => {
            const target = event.target as HTMLElement;
            if (target.hasAttribute("data-project-folder-content") && target.dataset.state === "open") {
              releaseInsetAfterExpansion();
            }
          }}
          aria-label="Project surfaces"
          className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable] px-2 pb-4 pt-[var(--clash-project-action-phase,0.5rem)]"
        >
          <ProjectFolderSection
            id="canvases"
            label="Canvases"
            open={openFolders.canvases}
            addLabel="New Canvas"
            onToggle={() => toggleFolder("canvases")}
            onAdd={onCreateCanvas}
          >
            {canvases.map((canvas) => {
              const active =
                surface.kind === "canvas" && surface.canvasId === canvas.id;
              const tab = (
                <NavigatorTab
                  id={canvasTabId(canvas.id)}
                  aria-label={canvas.name}
                  className={rowClass(active)}
                >
                  <CanvasIcon
                    className={
                      active
                        ? "h-3.5 w-3.5 text-brand"
                        : "h-3.5 w-3.5 text-stone-400"
                    }
                    weight={active ? "fill" : "regular"}
                  />
                  <span className="truncate">{canvas.name}</span>
                </NavigatorTab>
              );
              return (
                <SidebarItemContextMenu
                  key={canvas.id}
                  label={canvas.name}
                  onAnnotate={
                    onAnnotate
                      ? () =>
                          onAnnotate({
                            surface: "canvas",
                            surfaceId: canvas.id,
                            surfaceLabel: canvas.name,
                            objectId: canvas.id,
                            objectType: "canvas",
                            objectLabel: canvas.name,
                            objectPath: `canvases/${canvas.id}`,
                            capabilities: ["read", "modify"],
                          })
                      : undefined
                  }
                  actions={[
                    {
                      key: "rename",
                      label: "Rename",
                      onSelect: () => onRenameCanvas(canvas),
                    },
                    {
                      key: "delete",
                      label: "Delete",
                      danger: true,
                      icon: <Trash className="h-4 w-4 shrink-0" />,
                      onSelect: () => onDeleteCanvas(canvas),
                    },
                  ]}
                >
                  <div className="group/menu-item relative min-w-0">
                    {tab}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          label={`Canvas actions for ${canvas.name}`}
                          icon={<DotsThree className="h-4 w-4" weight="bold" />}
                          size="sm"
                          shape="rounded"
                          className={`${sidebarActionSlotClass} absolute right-1 top-1/2 -translate-y-1/2 rounded-md bg-transparent text-content-muted opacity-0 hover:bg-warm-hover hover:text-content-primary group-hover/menu-item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100`}
                        />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        side="right"
                        align="start"
                        className="min-w-36 rounded-md p-1"
                      >
                        <DropdownMenuItem
                          onSelect={() => onRenameCanvas(canvas)}
                        >
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => onDeleteCanvas(canvas)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </SidebarItemContextMenu>
              );
            })}
          </ProjectFolderSection>

          <ProjectFolderSection
            id="views"
            label="Views"
            open={openFolders.views}
            onToggle={() => toggleFolder("views")}
            addControl={
              pluginViewDefinitions.length > 0 && onCreatePluginView ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      label="Add View"
                      icon={<Plus className="h-3 w-3" weight="bold" />}
                      size="sm"
                      shape="rounded"
                      className={`${sidebarActionSlotClass} rounded-md bg-transparent text-content-muted hover:bg-warm-hover hover:text-content-primary`}
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="start" className="min-w-52 rounded-xl p-1">
                    {pluginViewDefinitions.map((definition) => (
                      <DropdownMenuItem
                        key={`${definition.pluginId}:${definition.definitionId}:${definition.version}`}
                        onSelect={() => onCreatePluginView(definition)}
                      >
                        <Shapes className="h-4 w-4 text-brand" weight="duotone" />
                        {definition.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : undefined
            }
          >
            {pluginViews.map((view) => {
              const active = surface.kind === "plugin-view" && surface.nodeId === view.nodeId;
              return (
                <SidebarItemContextMenu
                  key={view.nodeId}
                  label={view.label}
                  actions={onDeletePluginView ? [{
                    key: "delete",
                    label: "Delete",
                    danger: true,
                    icon: <Trash className="h-4 w-4 shrink-0" />,
                    onSelect: () => onDeletePluginView(view),
                  }] : []}
                >
                  <div className="group/menu-item relative min-w-0">
                    <NavigatorTab
                      id={pluginViewTabId(view.nodeId)}
                      aria-label={view.label}
                      className={rowClass(active)}
                    >
                      <Shapes
                        className={active ? "h-3.5 w-3.5 text-brand" : "h-3.5 w-3.5 text-stone-400"}
                        weight={active ? "fill" : "regular"}
                      />
                      <span className="truncate">{view.label}</span>
                    </NavigatorTab>
                    {onDeletePluginView ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            label={`View actions for ${view.label}`}
                            icon={<DotsThree className="h-4 w-4" weight="bold" />}
                            size="sm"
                            shape="rounded"
                            className={`${sidebarActionSlotClass} absolute right-1 top-1/2 -translate-y-1/2 rounded-md bg-transparent text-content-muted opacity-0 hover:bg-warm-hover hover:text-content-primary group-hover/menu-item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100`}
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="right" align="start" className="min-w-36 rounded-md p-1">
                          <DropdownMenuItem className="text-red-600 focus:text-red-700" onSelect={() => onDeletePluginView(view)}>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </SidebarItemContextMenu>
              );
            })}
          </ProjectFolderSection>

          {onCreateBrowser ? (
            <ProjectFolderSection
              id="browsers"
              label="Browsers"
              open={openFolders.browsers}
              addLabel="Open Browser"
              onToggle={() => toggleFolder("browsers")}
              onAdd={onCreateBrowser}
            >
              {browsers.map((browser) => {
                const active =
                  surface.kind === "browser" &&
                  surface.browserId === browser.id;
                const tab = (
                  <NavigatorTab
                    id={browserTabId(browser.id)}
                    aria-label={browser.title}
                    title={browser.url}
                    className={rowClass(active)}
                  >
                    <GlobeSimple
                      className={
                        active
                          ? "h-3.5 w-3.5 shrink-0 text-brand"
                          : "h-3.5 w-3.5 shrink-0 text-stone-400"
                      }
                      weight={active ? "fill" : "regular"}
                    />
                    <span className="truncate">{browser.title}</span>
                  </NavigatorTab>
                );
                const closeAction: SidebarContextAction[] = onCloseBrowser
                  ? [
                      {
                        key: "close",
                        label: "Close Browser",
                        onSelect: () => onCloseBrowser(browser.id),
                      },
                    ]
                  : [];
                return (
                  <SidebarItemContextMenu
                    key={browser.id}
                    label={browser.title}
                    actions={closeAction}
                  >
                    <div className="group/menu-item relative min-w-0">
                      {tab}
                      {onCloseBrowser ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton
                              label={`Browser actions for ${browser.title}`}
                              icon={
                                <DotsThree className="h-4 w-4" weight="bold" />
                              }
                              size="sm"
                              shape="rounded"
                              className={`${sidebarActionSlotClass} absolute right-1 top-1/2 -translate-y-1/2 rounded-md bg-transparent text-content-muted opacity-0 hover:bg-warm-hover hover:text-content-primary group-hover/menu-item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100`}
                            />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            side="right"
                            align="start"
                            className="min-w-36 rounded-md p-1"
                          >
                            <DropdownMenuItem
                              onSelect={() => onCloseBrowser(browser.id)}
                            >
                              Close Browser
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  </SidebarItemContextMenu>
                );
              })}
            </ProjectFolderSection>
          ) : null}

          <ProjectFolderSection
            id="timelines"
            label="Timelines"
            open={openFolders.timelines}
            addLabel="New Timeline"
            onToggle={() => toggleFolder("timelines")}
            onAdd={onCreateTimeline}
          >
            {timelineError ? <p role="alert" className="px-3 py-2 text-xs text-red-600">{timelineError}</p> : null}
            {timelines.map((timeline) => {
              const active =
                surface.kind === "timeline" &&
                surface.timelineId === timeline.id;
              const firstFrameAsset = timelineFirstFrameAsset(
                timeline,
                activeAssetsById,
              );
              const tab = (
                <NavigatorTab
                  id={timelineTabId(timeline.id)}
                  aria-label={timeline.name}
                  className={rowClass(active)}
                >
                  <TimelineSidebarPreview
                    timeline={timeline}
                    asset={firstFrameAsset}
                    active={active}
                  />
                  <span className="truncate">{timeline.name}</span>
                </NavigatorTab>
              );
              return (
                <SidebarItemContextMenu
                  key={timeline.id}
                  label={timeline.name}
                  onAnnotate={
                    onAnnotate
                      ? () =>
                          onAnnotate({
                            surface: "timeline",
                            surfaceId: timeline.id,
                            surfaceLabel: timeline.name,
                            objectId: timeline.id,
                            objectType: "timeline",
                            objectLabel: timeline.name,
                            objectPath: `timelines/${timeline.id}`,
                            capabilities: ["read", "modify"],
                          })
                      : undefined
                  }
                  actions={[
                    {
                      key: "attach",
                      label: "Move to current Canvas",
                      onSelect: () => onAttachTimeline(timeline),
                    },
                    ...(onDeleteTimeline
                      ? [
                          {
                            key: "delete",
                            label: "Delete",
                            danger: true,
                            icon: <Trash className="h-4 w-4 shrink-0" />,
                            onSelect: () => onDeleteTimeline(timeline),
                          },
                        ]
                      : []),
                  ]}
                >
                  <div className="group/menu-item relative min-w-0">
                    {tab}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          label={`Timeline actions for ${timeline.name}`}
                          icon={<DotsThree className="h-4 w-4" weight="bold" />}
                          size="sm"
                          shape="rounded"
                          className={`${sidebarActionSlotClass} absolute right-1 top-1/2 -translate-y-1/2 rounded-md bg-transparent text-content-muted opacity-0 hover:bg-warm-hover hover:text-content-primary group-hover/menu-item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100`}
                        />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        side="right"
                        align="start"
                        className="min-w-44 rounded-md p-1"
                      >
                        <DropdownMenuItem
                          onSelect={() => onAttachTimeline(timeline)}
                        >
                          Move to current Canvas
                        </DropdownMenuItem>
                        {onDeleteTimeline ? (
                          <DropdownMenuItem
                            className="text-red-600 focus:text-red-700"
                            onSelect={() => onDeleteTimeline(timeline)}
                          >
                            Delete
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </SidebarItemContextMenu>
              );
            })}
          </ProjectFolderSection>

          <ProjectFolderSection
            id="director-stages"
            label="Director Stages"
            open={openFolders["director-stages"]}
            addLabel={onCreateDirectorStage ? "New Director Stage" : undefined}
            onToggle={() => toggleFolder("director-stages")}
            onAdd={onCreateDirectorStage}
          >
            {directorStages.map((stage) => {
              const active =
                surface.kind === "director-stage" &&
                surface.stageId === stage.id;
              const tab = (
                <NavigatorTab
                  id={directorStageTabId(stage.id)}
                  aria-label={stage.name}
                  className={rowClass(active)}
                >
                  <Cube
                    className={
                      active
                        ? "h-3.5 w-3.5 text-brand"
                        : "h-3.5 w-3.5 text-stone-400"
                    }
                    weight={active ? "fill" : "regular"}
                  />
                  <span className="truncate">{stage.name}</span>
                </NavigatorTab>
              );
              return (
                <SidebarItemContextMenu
                  key={stage.id}
                  label={stage.name}
                  onAnnotate={
                    onAnnotate
                      ? () =>
                          onAnnotate({
                            surface: "director-stage",
                            surfaceId: stage.id,
                            surfaceLabel: stage.name,
                            objectId: stage.id,
                            objectType: "director-stage",
                            objectLabel: stage.name,
                            objectPath: `director-stages/${stage.id}`,
                            capabilities: ["read", "modify"],
                          })
                      : undefined
                  }
                  actions={
                    onAttachDirectorStage
                      ? [
                          {
                            key: "attach",
                            label: "Move to current Canvas",
                            onSelect: () => onAttachDirectorStage(stage),
                          },
                        ]
                      : []
                  }
                >
                  <div className="group/menu-item relative min-w-0">
                    {tab}
                    {onAttachDirectorStage ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            label={`Director Stage actions for ${stage.name}`}
                            icon={
                              <DotsThree className="h-4 w-4" weight="bold" />
                            }
                            size="sm"
                            shape="rounded"
                            className={`${sidebarActionSlotClass} absolute right-1 top-1/2 -translate-y-1/2 rounded-md bg-transparent text-content-muted opacity-0 hover:bg-warm-hover hover:text-content-primary group-hover/menu-item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100`}
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          side="right"
                          align="start"
                          className="min-w-44 rounded-md p-1"
                        >
                          <DropdownMenuItem
                            onSelect={() => onAttachDirectorStage(stage)}
                          >
                            Move to current Canvas
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </SidebarItemContextMenu>
              );
            })}
          </ProjectFolderSection>

          <ProjectFolderSection
            id="assets"
            label="Assets"
            open={openFolders.assets}
            onToggle={() => toggleFolder("assets")}
            addControl={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    label="Add Asset"
                    icon={<Plus className="h-3 w-3" weight="bold" />}
                    size="sm"
                    shape="rounded"
                    className={`${sidebarActionSlotClass} rounded-md bg-transparent text-content-muted hover:bg-warm-hover hover:text-content-primary`}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="right"
                  align="start"
                  className="min-w-52 rounded-xl p-1"
                >
                  <DropdownMenuItem onSelect={onAddAsset}>
                    <UploadSimple className="h-4 w-4 text-stone-500" />
                    Upload from Mac
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setLibraryPickerOpen(true)}>
                    <Images className="h-4 w-4 text-stone-500" />
                    Add from Global Assets
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            }
          >
            {activeAssets.length > 0 || textAssets.length > 0 ? (
              <ul aria-label="Project assets" className="space-y-0">
                {textAssets.map((asset) => {
                  const active =
                    surface.kind === "text-asset" &&
                    surface.nodeId === asset.id;
                  const tab = (
                    <NavigatorTab
                      id={textAssetTabId(asset.id)}
                      aria-label={asset.label}
                      title={asset.label}
                      className={rowClass(active)}
                    >
                      <TextT
                        data-project-text-asset-icon="true"
                        className={
                          active
                            ? "h-3.5 w-3.5 shrink-0 text-brand"
                            : "h-3.5 w-3.5 shrink-0 text-stone-400"
                        }
                        weight={active ? "bold" : "regular"}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {asset.label}
                      </span>
                    </NavigatorTab>
                  );
                  return (
                    <SidebarItemContextMenu
                      key={`text-${asset.id}`}
                      label={asset.label}
                      onAnnotate={
                        onAnnotate
                          ? () =>
                              onAnnotate({
                                surface: "canvas",
                                surfaceId: asset.canvasId,
                                surfaceLabel:
                                  canvases.find(
                                    (canvas) => canvas.id === asset.canvasId,
                                  )?.name ?? asset.canvasId,
                                objectId: asset.id,
                                objectType: "canvas-text",
                                objectLabel: asset.label,
                                objectPath: `canvases/${asset.canvasId}/nodes/${asset.id}`,
                                capabilities: ["read", "modify"],
                              })
                          : undefined
                      }
                      actions={[]}
                    >
                      <li
                        data-agent-annotation-object-id={asset.id}
                        className="group/menu-item relative min-w-0"
                      >
                        {tab}
                      </li>
                    </SidebarItemContextMenu>
                  );
                })}
                {activeAssets.map((asset) => {
                  const { label } = assetNavigationLabel(asset);
                  const active =
                    surface.kind === "asset" && surface.assetId === asset.id;
                  const tab = (
                    <NavigatorTab
                      id={assetTabId(asset.id)}
                      aria-label={label}
                      title={label}
                      draggable
                      onDragStart={(event) =>
                        writeProjectAssetDrag(event.dataTransfer, asset)
                      }
                      className={`${rowClass(active)} cursor-grab active:cursor-grabbing`}
                    >
                      <AssetThumbnail
                        kind={asset.kind}
                        src={projectAssetPlaybackUrl(asset) ?? ""}
                        thumbnailSrc={asset.thumbnailUrl}
                        status={asset.status}
                        label={label}
                        active={active}
                      />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                    </NavigatorTab>
                  );
                  const assetRowId = asset.id;
                  const canAddToLibrary = Boolean(onAddAssetToLibrary);
                  const actions: SidebarContextAction[] = [];
                  if (canAddToLibrary && onAddAssetToLibrary) {
                    actions.push({
                      key: "add-to-library",
                      label: "Add to Global Assets",
                      icon: (
                        <Images className="h-4 w-4 shrink-0 text-stone-500" />
                      ),
                      onSelect: () => onAddAssetToLibrary(assetRowId),
                    });
                  }
                  if (onTrashAsset) {
                    actions.push({
                      key: "trash",
                      label: "Move to Trash",
                      icon: <Trash className="h-4 w-4 shrink-0 text-red-500" />,
                      danger: true,
                      onSelect: () => void onTrashAsset(assetRowId),
                    });
                  }
                  return (
                    <SidebarItemContextMenu
                      key={asset.id}
                      label={label}
                      onAnnotate={
                        onAnnotate
                          ? () =>
                              onAnnotate({
                                surface: "asset",
                                surfaceId: asset.id,
                                surfaceLabel: label,
                                objectId: assetRowId,
                                objectType: `asset-${asset.kind}`,
                                objectLabel: label,
                                objectPath: `assets/${assetRowId}`,
                                capabilities: ["read", "modify"],
                                ...(asset.kind === "image" ||
                                asset.kind === "video"
                                  ? { previewAssetId: assetRowId }
                                  : {}),
                              })
                          : undefined
                      }
                      actions={actions}
                    >
                      <li
                        data-agent-annotation-object-id={assetRowId}
                        className="group/menu-item relative min-w-0"
                      >
                        {tab}
                        {canAddToLibrary || onTrashAsset ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <IconButton
                                label={`More options for ${label}`}
                                icon={
                                  <DotsThree
                                    className="h-4 w-4"
                                    weight="bold"
                                  />
                                }
                                size="sm"
                                shape="rounded"
                                className={`${sidebarActionSlotClass} absolute right-1 top-1/2 -translate-y-1/2 rounded-md bg-transparent text-content-muted opacity-0 hover:bg-warm-hover hover:text-content-primary group-hover/menu-item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100`}
                              />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              side="right"
                              align="start"
                              className="min-w-48 rounded-xl p-1"
                            >
                              {canAddToLibrary && onAddAssetToLibrary ? (
                                <DropdownMenuItem
                                  onSelect={() => onAddAssetToLibrary(asset.id)}
                                >
                                  <Images className="h-4 w-4 text-stone-500" />
                                  Add to Global Assets
                                </DropdownMenuItem>
                              ) : null}
                              {onTrashAsset ? (
                                <DropdownMenuItem
                                  onSelect={() => void onTrashAsset(asset.id)}
                                  className="text-red-600 data-[highlighted]:text-red-700 dark:text-red-400"
                                >
                                  <Trash className="h-4 w-4" />
                                  Move to Trash
                                </DropdownMenuItem>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </li>
                    </SidebarItemContextMenu>
                  );
                })}
              </ul>
            ) : null}
            {trashedAssets.length > 0 ? (
              <div className="mt-2 border-t border-warm-border/75 pt-2">
                <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-content-muted">
                  Trash
                </p>
                <ul aria-label="Project asset trash" className="space-y-0">
                  {trashedAssets.map((asset) => {
                    const { label } = assetNavigationLabel(asset);
                    return (
                      <li key={asset.id} className="relative min-w-0">
                        <Button
                          variant={null}
                          size={null}
                          shape={null}
                          aria-label={`Restore ${label}`}
                          onClick={() => void onRestoreAsset?.(asset.id)}
                          disabled={!onRestoreAsset}
                          className={`${rowClass(false)} bg-transparent shadow-none`}
                          leftIcon={
                            <ArrowCounterClockwise className="h-3.5 w-3.5 text-content-muted" />
                          }
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {label}
                          </span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </ProjectFolderSection>
        </TabList>
      </TabProvider>
      {footer ? (
        <div
          role="group"
          aria-label="Project controls"
          className="clash-project-sidebar-footer flex h-12 shrink-0 items-center border-t border-warm-border/75 px-2"
        >
          {footer}
        </div>
      ) : null}
      <Dialog
        open={libraryPickerOpen}
        onClose={() => setLibraryPickerOpen(false)}
        title="Add from Global Assets"
        description="Choose reusable media to add to this project."
        size="lg"
      >
        {globalAssets.length > 0 ? (
          <ul
            aria-label="Available global assets"
            className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3"
          >
            {globalAssets.map((asset) => {
              const { label } = assetNavigationLabel(asset);
              return (
                <li key={asset.id}>
                  <button
                    type="button"
                    aria-label={`Add ${label}`}
                    onClick={() => {
                      void Promise.resolve(onAddGlobalAsset?.(asset.id)).then(
                        () => setLibraryPickerOpen(false),
                      );
                    }}
                    className="group w-full rounded-xl border border-warm-border bg-warm-page/50 p-2 text-left transition-colors hover:border-brand/30 hover:bg-brand/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <span className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-warm-muted">
                      <AssetThumbnail
                        kind={asset.kind}
                        src={projectAssetPlaybackUrl(asset) ?? ""}
                        thumbnailSrc={asset.thumbnailUrl}
                        status={asset.status}
                        label={label}
                        variant="card"
                        decorative
                      />
                    </span>
                    <span className="mt-2 block truncate text-sm font-semibold text-content-primary">
                      {label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="mt-5 border-y border-dashed border-warm-border py-12 text-center">
            <p className="text-sm font-semibold text-content-primary">
              No reusable assets available
            </p>
            <p className="mt-1 text-sm text-content-secondary">
              Add reusable media in Global Assets first.
            </p>
            <Link
              to="/assets"
              className="mt-4 inline-flex min-h-9 items-center justify-center rounded-lg border border-warm-border bg-warm-surface px-3 text-sm font-semibold text-content-primary shadow-sm hover:bg-warm-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Open Global Assets
            </Link>
          </div>
        )}
      </Dialog>
      <Dialog
        open={searchOpen}
        onClose={closeSearch}
        ariaLabel="Search project"
        size="auto"
        hideCloseButton
        unstyled
        containerClassName="items-start pt-[12vh]"
        contentClassName="w-full max-w-lg overflow-hidden rounded-lg border border-warm-border bg-warm-surface shadow-lg"
      >
        <ComboboxProvider store={searchStore}>
          <div className="relative border-b border-warm-border/80">
            <MagnifyingGlass
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
            />
            <Combobox
              aria-label="Search project"
              autoComplete="list"
              autoSelect
              autoFocus
              placeholder="Search canvases, browsers, stages, timelines, and assets"
              className="h-12 w-full bg-transparent pl-10 pr-4 text-sm text-slate-950 outline-none placeholder:text-stone-400 focus-visible:ring-0 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
          </div>
          <ComboboxList
            aria-label="Project search results"
            alwaysVisible
            className="max-h-80 overflow-y-auto p-1.5"
          >
            {searchResults.length === 0 ? (
              <div
                role="status"
                className="flex h-12 items-center justify-center text-xs text-stone-400"
              >
                No results
              </div>
            ) : (
              searchResults.map((result) => {
                const value = `${result.kind}:${result.id}`;
                const kindLabel =
                  result.kind === "asset"
                    ? "Asset"
                    : result.kind === "plugin-view"
                      ? "View"
                    : result.kind === "canvas"
                      ? "Canvas"
                      : result.kind === "browser"
                        ? "Browser"
                        : result.kind === "director-stage"
                          ? "Director Stage"
                          : "Timeline";
                const ResultIcon =
                  result.kind === "asset"
                    ? ImageIcon
                    : result.kind === "plugin-view"
                      ? Shapes
                    : result.kind === "canvas"
                      ? CanvasIcon
                      : result.kind === "browser"
                        ? GlobeSimple
                        : result.kind === "director-stage"
                          ? Cube
                          : FilmSlate;
                return (
                  <ComboboxItem
                    key={value}
                    value={value}
                    focusOnHover
                    setValueOnClick={false}
                    aria-label={`${result.label} ${kindLabel}`}
                    className="flex h-10 w-full cursor-default items-center gap-3 rounded-md px-2.5 text-left text-[13px] text-slate-900 outline-none hover:bg-warm-muted data-[active-item]:bg-warm-muted focus-visible:bg-warm-muted dark:text-neutral-100"
                  >
                    <ResultIcon
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-stone-400"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {result.label}
                    </span>
                    <span className="text-[11px] text-stone-400">
                      {kindLabel}
                    </span>
                  </ComboboxItem>
                );
              })
            )}
          </ComboboxList>
        </ComboboxProvider>
      </Dialog>
    </div>
  );
}
