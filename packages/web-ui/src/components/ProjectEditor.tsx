import { createLogger } from "../lib/logger";
import { TextDocumentReadSurface } from "./TextDocumentReadSurface";
import {
  lazy,
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  useMemo,
  type DragEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import type { EditorAssetInput } from "@clash/remotion-core";
import {
  ReactFlow,
  BezierEdge,
  Background,
  BackgroundVariant,
  MiniMap,
  useNodesState,
  useEdgesState,
  applyNodeChanges,
  addEdge,
  Connection,
  Edge,
  Node,
  NodeChange,
  type ReactFlowInstance,
  type EdgeTypes,
  type OnError,
  useViewport,
  SelectionMode,
} from "@xyflow/react";

// Use a flexible data type to preserve v11-style data access patterns throughout the codebase.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppNode = Node<Record<string, any>>;
type AgentFollowTarget = { nodeId: string; canvasId: string };
type ProjectPluginViewRecord = ProjectPluginView & {
  version: string;
  schemaHash: string;
  state: StoryboardViewState;
};
import "@xyflow/react/dist/style.css";
import { AnimatePresence, motion } from "framer-motion";
import { Toolbar } from "radix-ui";
import {
  FilmSlate,
  TextT,
  Image as ImageIcon,
  MagicWand,
  ArrowLeft,
  ArrowCounterClockwise,
  ArrowClockwise,
  Square,
  CursorClick,
  HandGrabbing,
  FolderSimple,
  Gear,
  X,
  ArrowsInSimple,
  Crosshair,
  MapTrifold,
  MagnifyingGlass,
  Plus,
} from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router";
import { useHotkeys } from "react-hotkeys-hook";
import type { Project } from "@clash/web-ui/lib/types";
import {
  hasProjectAssetDragData,
  readProjectAssetDrag,
} from "@clash/web-ui/lib/projectAssetDrag";
import { useAppFeedback } from "./AppFeedback";
import { isMcpProjectApp, sendMcpProjectRequest } from "../lib/mcpProject";
import { McpProjectContext } from "./McpProjectContext";
const ChatbotCopilot = lazy(() => import("./ChatbotCopilot"));
import type { ClashProjectEntity } from "./copilot/AcpInlineRenderers";
import { clampCopilotPanelWidthForViewport } from "./copilotPanelLayout";
import { useSessionHistory } from "@clash/web-ui/hooks/useSessionHistory";
import { listModelCatalog, listModelProviders, updateProjectName } from "@clash/web-ui/lib/clientActions";
import { deriveRemotionComponentConnectionUpdate } from "@clash/web-ui/lib/remotionComponentTimeline";
import { withProjectSessionSearch } from "@clash/web-ui/lib/projectSessionRoute";
import VideoNode from "./nodes/VideoNode";
import ImageNode from "./nodes/ImageNode";
import TextNode from "./nodes/TextNode";
import RemotionComponentNode, {
  calculateRemotionComponentNodeDimensions,
  DEFAULT_REMOTION_COMPONENT_SOURCE,
} from "./nodes/RemotionComponentNode";
import AudioNode from "./nodes/AudioNode";
import PromptActionNode from "./nodes/ActionBadge"; // Renamed: ActionBadge -> PromptActionNode
import GroupNode from "./nodes/GroupNode";
import VideoEditorNode from "./nodes/VideoEditorNode";
import ImageEditorNode from "./nodes/ImageEditorNode";
import VideoClipperNode from "./nodes/VideoClipperNode";
import DirectorStageNode from "./nodes/DirectorStageNode";
import PluginViewNode from "./nodes/PluginViewNode";
import { generationConnectionAcceptsSource } from "./nodes/generationConnectionCompatibility";
import { MediaViewerProvider } from "./MediaViewerContext";
import { enabledModelCatalogEntries, ProjectProvider } from "./ProjectContext";
import { VideoEditorProvider } from "./VideoEditorContext";
import { DirectorStageProvider } from "./DirectorStageContext";
import { PluginViewProvider } from "./PluginViewContext";
import { PluginStoryboardSurface } from "./PluginStoryboardSurface";
import { ImageEditorProvider } from "./ImageEditorContext";
import { VideoClipperProvider } from "./VideoClipperContext";
import { LayoutActionsProvider } from "./LayoutActionsContext";
import { TextNodeEditorProvider } from "./TextNodeEditorContext";
import { TextDocumentEditorSurface } from "./TextDocumentEditorSurface";
import { TextNodePreviewDialog } from "./TextNodePreviewDialog";
import {
  getAbsoluteRect,
  getAbsolutePosition,
  rectContains,
  rectOverlaps,
  determineGroupOwnership,
  recursiveGroupScale,
  applyGroupScales,
  resolveCollisions,
  applyResolution,
  createMesh,
  getNestingDepth,
  isDescendant,
  relayoutToGrid,
  shrinkGroupsToFit,
  ACTION_BADGE_NODE_SIZE,
} from "@clash/web-ui/lib/layout";
import { useLoroSync } from "@clash/web-ui/hooks/useLoroSync";
import { actionIsCheckpointLocked } from "@clash/web-ui/lib/actionCheckpoint";
import {
  annotationLocateSelector,
  centerAndHighlightAnnotationTarget,
} from "@clash/web-ui/lib/agentAnnotationLocate";
import { LoroSyncProvider } from "./LoroSyncContext";
import {
  planAssetScopeCascade,
  createDirectorReferencePacket,
  createDefaultDirectorStageState,
  Canvas,
  DEFAULT_CANVAS_ID,
  GeneratorDefinitionSchema,
  StoryboardViewStateSchema,
  listActionAssetBindings,
  projectDirectorStageRevisionId,
  projectTimelineReadToken,
  listTimelineExportProgress,
  type AssetScopeTarget,
  type ActivityMessage,
  type AgentAnnotationDraft,
  type AgentAnnotationObjectRef,
  type AgentAnnotationTarget,
  type ResolvedAsset,
  type ProjectCanvas,
  type ProjectTimeline,
  type ProjectDirectorStage,
  type GeneratorDefinition,
  type StoryboardViewMaterial,
  type StoryboardViewResource,
  type StoryboardViewState,
} from "@clash/shared-types";
import { executeAssetScopeCascade } from "./assetScopeCascadeExecutor";
import { useActivityToasts } from "./ActivityToast";
import NodeActivityIndicator, {
  useNodeHighlights,
} from "./NodeActivityIndicator";
import AwarenessLayer from "./AwarenessLayer";
import { PresenceAwarenessProvider } from "./PresenceAwarenessContext";
import { usePresenceAwareness } from "@clash/web-ui/hooks/usePresenceAwareness";
import type { AwarenessBroadcastMessage } from "@clash/shared-types";
import { CascadeRunnerMount } from "@clash/web-ui/hooks/useCascadeRunner";
import { MODEL_CARDS, customActionDefaultParams } from "@clash/shared-types";
import { useExecutablePluginActions } from "@clash/web-ui/hooks/useExecutablePluginActions";
import {
  useExecutablePluginViews,
  type ExecutablePluginViewDefinition,
} from "@clash/web-ui/hooks/useExecutablePluginViews";
import { createGeneratorClient } from "@clash/shared-runtime/generator-client";
import { createCanvasModelDraft, createCanvasActionDraft } from "../lib/createCanvasModelDraft";
import { connectNativeModelInput } from "../lib/connectNativeModelInput";
import { projectCanvasModelGeneratorData, canvasAssetRevision, referenceModality } from "@clash/shared-types";
import {
  runStoryboardMaterialGenerator,
  storyboardGeneratorChoices,
  type StoryboardGeneratorChoice,
} from "@clash/web-ui/lib/storyboardGenerator";
import { CustomActionsProvider } from "./CustomActionsContext";
import {
  applyLayoutPatchesToLoro,
  collectLayoutNodePatches,
} from "@clash/web-ui/lib/loroNodeSync";
import {
  calculateDimensionsFromAspectRatio,
  calculateScaledDimensions,
} from "./nodes/assetNodeSizing";
import {
  admitPersonalGlobalAssetToProject,
  getAsset,
  importProjectAssetFile as importProjectAssetBytes,
  listPersonalGlobalAssets,
  publishDirectorStageOutputFile as publishDirectorStageOutputBytes,
  publishProjectAssetToPersonalLibrary,
  restoreProjectAsset as restoreProjectAssetThroughHost,
  trashProjectAsset as trashProjectAssetThroughHost,
  useAsset,
} from "@clash/web-ui/lib/hooks/useAsset";
import { subscribeProjectAssetProjection } from "@clash/web-ui/lib/liveProjectAssets";
import { runtimeApiUrl } from "@clash/web-ui/lib/runtimeConfig";
import betterAuthClient from "@clash/web-ui/lib/betterAuthClient";
import {
  DESKTOP_TAB_TITLE_EVENT,
  dispatchDesktopTabConnection,
  type DesktopTabConnectionEventDetail,
  type DesktopTabTitleEventDetail,
} from "@clash/web-ui/lib/desktopTabs";
import {
  PROJECT_NAVIGATOR_VISIBILITY_EVENT,
  type ProjectNavigatorVisibilityDetail,
} from "@clash/web-ui/lib/projectNavigatorChrome";
import { dispatchHostMutationEvent } from "@clash/web-ui/lib/hostMutationEvents";
import { SyncRecoveryDialog } from "./SyncRecoveryDialog";
import {
  averageRectCenters,
  collapseVelocityFromPointer,
  DEFAULT_MINIMAP_SIZE,
  isExpandedMinimapSize,
  isImplicitCanvasRoot,
  resizeMinimapFromTopRight,
  shouldCollapseMinimap,
  type MinimapSize,
} from "@clash/web-ui/lib/canvasViewport";
import {
  nodeChangesRequireZIndexNormalization,
  nodeChangesRequireStructuralSanitize,
  isUserResizeChange,
  normalizeCanvasNodeZIndex,
  sanitizeNodesForReactFlow,
} from "@clash/web-ui/lib/canvasNodeOrder";
import {
  reconcileSyncedCanvasEdges,
  reconcileSyncedCanvasNodes,
} from "@clash/web-ui/lib/canvasElementReconciliation";
import UserControls from "./UserControls";
import { CanvasCreateMenuItems } from "./CanvasCreateMenuItems";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { Input } from "./ui/input";
import { Tooltip } from "./ui/tooltip";
import {
  CanvasTransientUiProvider,
  createCanvasTransientUiStore,
} from "./CanvasTransientUiContext";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./ui/accordion";
import DesktopAutoHideSidebar, {
  DesktopSidebarCollapseButton,
} from "./DesktopAutoHideSidebar";
import ProjectWorkspaceNavigator, {
  type ProjectBrowserTab,
  type ProjectTextAsset,
  type ProjectPluginView,
  type ProjectWorkspaceSurface,
} from "./ProjectWorkspaceNavigator";
import { ProjectBrowserSurfaces } from "./ProjectBrowserSurfaces";
import {
  closeProjectBrowserTab,
  ensureProjectBrowserTab,
  loadProjectBrowserSession,
  openProjectBrowserTab,
  saveProjectBrowserSession,
  shouldActivateProjectBrowserTab,
  updateProjectBrowserTab,
} from "../lib/projectBrowserTabs";
import {
  loadCanvasPreferences,
  loadProjectEditorSession,
  saveCanvasPreferences,
  saveProjectEditorSession,
  type CanvasMode,
  type CanvasPreferences,
  type PersistedCanvasView,
} from "../lib/projectEditorPersistence";
import {
  preloadTimelineEditor,
  ProjectTimelineEditorSurface,
} from "./ProjectWorkspaceSurfaces";
import {
  ProjectDirectorStageSurface,
  type DirectorStageCaptureInput,
  type DirectorStageModelGenerationInput,
  type DirectorStagePanoramaGenerationInput,
  type DirectorStageVideoExportInput,
} from "./ProjectDirectorStageSurface";
import {
  DIRECTOR_BUILTIN_MODEL_ASSET_URLS,
  inspectDirectorModelFile,
  renderDirectorPanoramaReference,
} from "@clash/director-ui";
import type { EditApplyResult } from "../features/assets/action-client";
import { EditableProjectAssetSurface } from "../features/assets/AssetWorkspace";
import { AssetThumbnail } from "../features/assets/AssetThumbnail";
import { useProjectAssetHydration } from "../features/assets/useProjectAssetHydration";
import {
  canvasNodeAssetDisplayName,
  projectAssetDisplayName,
  resolveCanvasNodeProjectAsset,
} from "../features/assets/projectAssetPresentation";
import {
  assetThumbnailImageUrl,
  projectAssetPlaybackUrl,
} from "../features/assets/media-url";
import { readAssetRelationGraph } from "../features/assets/relations";
import { selectTimelineMediaInputs } from "./timelineMediaInputs";
import { ScopedAssetPicker } from "./ScopedAssetPicker";
import {
  buildScopedAssetSections,
  commitScopedTimelineAssetInsertion,
  safeScopedAssetName,
  type ScopedAssetOption,
} from "./scopedAssetPickerModel";
import {
  buildProjectMentionSources,
  type BrowserAgentContext,
  type CopilotWorkspaceContext,
} from "@clash/web-ui/lib/copilotWorkspaceContext";
import { AgentAnnotationContextMenu } from "./copilot/AgentAnnotationContextMenu";
import { AgentAnnotationEditor } from "./copilot/AgentAnnotationBlock";
import { AgentAnnotationDomPinLayer } from "./copilot/AnnotationDomPinLayer";
import { CanvasAnnotationPinLayer } from "./copilot/CanvasAnnotationPinLayer";
import {
  AgentSelectionAnnotationOverlay,
  type AgentSelectionAnnotationOverlayHandle,
} from "./copilot/AgentSelectionAnnotationOverlay";
import { handleSelectionAnnotationContextMenu } from "./copilot/selectionAnnotationContextMenu";

const CHILD_NODE_Z_INDEX_BASE = 1000;
const EMPTY_COPILOT_MESSAGES: [] = [];
const COPILOT_PANEL_GUTTER_PX = 8;
const CANVAS_FOLDER_ASSET_TYPES = new Set([
  "image",
  "video",
  "audio",
  "text",
  "context",
]);

type CanvasFolderEntry = {
  kind: "group" | "asset";
  node: AppNode;
  asset?: ResolvedAsset;
  depth: number;
  label: string;
};

function isProjectAssetRenderNode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  const renderTarget = (data as { renderTarget?: unknown }).renderTarget;
  return Boolean(
    renderTarget &&
    typeof renderTarget === "object" &&
    (renderTarget as { kind?: unknown }).kind === "project-assets",
  );
}

async function normalizeDirectorPanorama(
  source: string | Blob,
  label: string,
): Promise<File> {
  const target = { width: 2048, height: 1024 } as const;
  const sourceBlob =
    typeof source === "string"
      ? await (async () => {
          const response = await fetch(source);
          if (!response.ok) {
            throw new Error(
              `Failed to read generated panorama: ${response.status}`,
            );
          }
          return response.blob();
        })()
      : source;
  let bitmap: ImageBitmap | undefined;
  let image: HTMLImageElement | undefined;
  let objectUrl: string | undefined;
  try {
    bitmap = await createImageBitmap(sourceBlob);
  } catch {
    objectUrl = URL.createObjectURL(sourceBlob);
    image = new Image();
    image.decoding = "async";
    image.src = objectUrl;
    await image.decode();
  }
  try {
    const renderSource = bitmap ?? image;
    if (!renderSource)
      throw new Error("Failed to decode the generated panorama");
    const sourceWidth = bitmap?.width ?? image?.naturalWidth ?? 0;
    const sourceHeight = bitmap?.height ?? image?.naturalHeight ?? 0;
    if (sourceWidth !== sourceHeight * 2) {
      throw new RangeError(
        `Director panorama must be exact 2:1; received ${sourceWidth}x${sourceHeight}`,
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context)
      throw new Error("Canvas 2D is unavailable for panorama normalization");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    // Only uniformly resample an already-valid equirectangular image. Never stretch
    // a cinematic frame into 2:1 because its horizon and meridians would no longer
    // describe the same directions as the Director Stage world.
    context.drawImage(renderSource, 0, 0, target.width, target.height);
    const normalizedBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Failed to encode panorama")),
        "image/webp",
        0.92,
      );
    });
    const safeLabel =
      label
        .trim()
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-")
        .slice(0, 48) || "director-panorama";
    return new File(
      [normalizedBlob],
      `${safeLabel}-${target.width}x${target.height}.webp`,
      {
        type: "image/webp",
      },
    );
  } finally {
    bitmap?.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function createDirectorPanoramaReferenceFile(
  calibration: DirectorStagePanoramaGenerationInput["calibration"],
): Promise<{
  file: File;
  calibration: ReturnType<
    typeof renderDirectorPanoramaReference
  >["calibration"];
}> {
  const reference = renderDirectorPanoramaReference({
    width: 2048,
    height: 1024,
    calibration,
  });
  const canvas = document.createElement("canvas");
  canvas.width = reference.width;
  canvas.height = reference.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error(
      "Canvas 2D is unavailable for panorama reference rendering",
    );
  }
  const imageData = context.createImageData(reference.width, reference.height);
  imageData.data.set(reference.pixels);
  context.putImageData(imageData, 0, 0);
  const referenceBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Failed to encode panorama reference image")),
      "image/png",
    );
  });
  return {
    file: new File(
      [referenceBlob],
      `director-panorama-reference-${reference.width}x${reference.height}.png`,
      { type: "image/png" },
    ),
    calibration: reference.calibration,
  };
}

function canvasFolderNodeLabel(node: AppNode): string {
  const data = node.data ?? {};
  for (const value of [data.label, data.name, data.fileName]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return node.type === "group" ? "Untitled group" : "Untitled asset";
}

function buildCanvasFolderEntries(
  nodes: AppNode[],
  projectAssets: readonly ResolvedAsset[],
): CanvasFolderEntry[] {
  const folderNodes = nodes.filter((node) => node.type === "group");
  const folderIds = new Set(folderNodes.map((node) => node.id));
  const children = new Map<string | null, Omit<CanvasFolderEntry, "depth">[]>();

  for (const node of nodes) {
    const kind =
      node.type === "group"
        ? ("group" as const)
        : node.type && CANVAS_FOLDER_ASSET_TYPES.has(node.type)
          ? ("asset" as const)
          : null;
    if (!kind) continue;

    const asset =
      kind === "asset"
        ? resolveCanvasNodeProjectAsset(node, projectAssets)
        : undefined;
    const parentId =
      node.parentId && folderIds.has(node.parentId) ? node.parentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push({
      kind,
      node,
      ...(asset ? { asset } : {}),
      label:
        kind === "asset"
          ? canvasNodeAssetDisplayName(node, asset)
          : canvasFolderNodeLabel(node),
    });
    children.set(parentId, siblings);
  }

  for (const siblings of children.values()) {
    siblings.sort(
      (left, right) =>
        Number(left.kind === "asset") - Number(right.kind === "asset") ||
        left.label.localeCompare(right.label),
    );
  }

  const entries: CanvasFolderEntry[] = [];
  const visited = new Set<string>();
  const appendChildren = (parentId: string | null, depth: number) => {
    for (const entry of children.get(parentId) ?? []) {
      if (visited.has(entry.node.id)) continue;
      visited.add(entry.node.id);
      entries.push({ ...entry, depth });
      if (entry.kind === "group") appendChildren(entry.node.id, depth + 1);
    }
  };

  appendChildren(null, 0);
  for (const folder of folderNodes) {
    if (!visited.has(folder.id)) {
      const entry = {
        kind: "group" as const,
        node: folder,
        label: canvasFolderNodeLabel(folder),
      };
      entries.push({ ...entry, depth: 0 });
      visited.add(folder.id);
      appendChildren(folder.id, 1);
    }
  }

  return entries;
}

function filterCanvasFolderEntries(
  entries: CanvasFolderEntry[],
  query: string,
): CanvasFolderEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return entries;

  const byId = new Map(entries.map((entry) => [entry.node.id, entry]));
  const matchedIds = new Set(
    entries
      .filter((entry) =>
        entry.label.toLocaleLowerCase().includes(normalizedQuery),
      )
      .map((entry) => entry.node.id),
  );
  const visibleIds = new Set(matchedIds);

  for (const matchedId of matchedIds) {
    let parentId = byId.get(matchedId)?.node.parentId;
    while (parentId) {
      visibleIds.add(parentId);
      parentId = byId.get(parentId)?.node.parentId;
    }
  }

  for (const entry of entries) {
    let parentId = entry.node.parentId;
    while (parentId) {
      if (matchedIds.has(parentId)) {
        visibleIds.add(entry.node.id);
        break;
      }
      parentId = byId.get(parentId)?.node.parentId;
    }
  }

  return entries.filter((entry) => visibleIds.has(entry.node.id));
}

function CanvasFolderEntryVisual({
  entry,
  projectId,
}: {
  entry: CanvasFolderEntry;
  projectId: string;
}) {
  const assetId =
    typeof entry.node.data?.assetId === "string"
      ? entry.node.data.assetId
      : undefined;
  const asset = useAsset(projectId, assetId);
  const resolvedAsset = asset ?? entry.asset;
  const previewSource = resolvedAsset
    ? (projectAssetPlaybackUrl(resolvedAsset) ?? "")
    : "";
  const previewThumbnail = resolvedAsset
    ? assetThumbnailImageUrl(resolvedAsset)
    : null;

  if (entry.kind === "group") {
    return (
      <FolderSimple
        className="h-4 w-4 shrink-0 text-stone-400"
        weight="regular"
      />
    );
  }
  if (
    entry.node.type === "audio" ||
    ((entry.node.type === "image" || entry.node.type === "video") &&
      (previewSource || previewThumbnail))
  ) {
    return (
      <AssetThumbnail
        kind={entry.node.type}
        src={previewSource}
        thumbnailSrc={previewThumbnail}
        status={resolvedAsset?.status}
        label={entry.label}
        variant="sidebar"
        decorative
      />
    );
  }
  if (entry.node.type === "image") {
    return (
      <ImageIcon className="h-4 w-4 shrink-0 text-stone-400" weight="regular" />
    );
  }
  if (entry.node.type === "video") {
    return (
      <FilmSlate className="h-4 w-4 shrink-0 text-stone-400" weight="regular" />
    );
  }
  return <TextT className="h-4 w-4 shrink-0 text-stone-400" weight="regular" />;
}

function CanvasFolderEntries({
  entries,
  projectId,
  onSelect,
  nested = false,
}: {
  entries: CanvasFolderEntry[];
  projectId: string;
  onSelect: (node: AppNode) => void;
  nested?: boolean;
}) {
  return entries.map((entry) => (
    <li key={entry.node.id}>
      <button
        type="button"
        onClick={() => onSelect(entry.node)}
        className={`flex h-[var(--clash-project-control-rhythm)] w-full items-center gap-2 rounded-md pr-2 text-left text-xs text-content-secondary transition-colors hover:bg-warm-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${entry.kind === "group" ? "font-medium" : "font-normal"}`}
        style={{
          paddingLeft: `${8 + entry.depth * 14 + (nested ? 8 : 0)}px`,
        }}
      >
        <CanvasFolderEntryVisual entry={entry} projectId={projectId} />
        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
      </button>
    </li>
  ));
}

type CopilotCanvasNode = Pick<AppNode, "id" | "type" | "data">;
type AgentMutationOptions = {
  actorClientType?: string;
  ifMatch?: string;
};

function reconcileCopilotCanvasNodes(
  previous: CopilotCanvasNode[],
  nodes: CopilotCanvasNode[],
): CopilotCanvasNode[] {
  const unchanged =
    previous.length === nodes.length &&
    nodes.every((node, index) => {
      const previousNode = previous[index];
      return (
        previousNode?.id === node.id &&
        previousNode.type === node.type &&
        previousNode.data === node.data
      );
    });

  if (unchanged) return previous;
  return nodes.map(({ id, type, data }) => ({ id, type, data }));
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable ||
    !!target.closest('[contenteditable="true"]')
  );
}
const DEFAULT_COPILOT_PANEL_FRACTION = 1 / 3;

function clampCopilotPanelWidth(width: number) {
  if (typeof window === "undefined") return width;
  return clampCopilotPanelWidthForViewport(width, window.innerWidth);
}

function defaultCopilotPanelWidth() {
  if (typeof window === "undefined") return 720;
  return clampCopilotPanelWidth(
    Math.round(window.innerWidth * DEFAULT_COPILOT_PANEL_FRACTION),
  );
}

interface ProjectEditorProps {
  project: Project;
  initialPrompt?: string;
  initialThreadId?: string;
}

const nodeTypes = {
  video: VideoNode,
  image: ImageNode,
  text: TextNode,
  context: TextNode, // Remap context to TextNode
  "remotion-component": RemotionComponentNode,
  audio: AudioNode,
  "action-badge": PromptActionNode, // Merged: Prompt + Action
  group: GroupNode,
  "video-editor": VideoEditorNode,
  "image-editor": ImageEditorNode,
  "video-clipper": VideoClipperNode,
  "director-stage": DirectorStageNode,
  "plugin-view": PluginViewNode,
};

export const projectCanvasEdgeTypes: EdgeTypes = {
  "copy-on-write": BezierEdge,
  reference: BezierEdge,
};

const editorLog = createLogger("canvas");

export function createProjectCanvasErrorHandler(
  log: (message: string) => void = (message) => editorLog.warn("canvas.reactflow_warning", { message }),
): OnError {
  const seen = new Set<string>();
  return (id, message) => {
    const key = `${id}:${message}`;
    if (seen.has(key)) return;
    if (seen.size >= 256) seen.delete(seen.values().next().value!);
    seen.add(key);
    log(`[React Flow ${id}] ${message}`);
  };
}

const projectCanvasOnError = createProjectCanvasErrorHandler();

const ProjectSettingsDialog = lazy(() => import("./SettingsDialog").then((module) => ({ default: module.SettingsDialog })));
const defaultImageModel = MODEL_CARDS.find((card) => card.kind === "image");
const directorPanoramaModel = MODEL_CARDS.find(
  (card) => card.id === "gpt-image-2",
);
const defaultVideoModel = MODEL_CARDS.find((card) => card.kind === "video");
const defaultAudioModel = MODEL_CARDS.find((card) => card.kind === "audio");
const defaultTextModel = MODEL_CARDS.find((card) => card.kind === "text");

const sanitizeNodes = (nodes: AppNode[]): AppNode[] => {
  return sanitizeNodesForReactFlow(nodes, {
    onInvalidParent: (node, parentId) => {
      editorLog.warn("canvas.parent_repaired", { nodeId: node.id, parentId });
    },
  });
};

/**
 * Floating "Group" pill that appears above the bounding box of the current
 * marquee/shift selection. Mounted inside <ReactFlow> so it can read the
 * viewport transform — position tracks pan/zoom, size stays in screen space.
 */
function SelectionGroupButton({
  bounds,
  onGroup,
}: {
  bounds: {
    absMinX: number;
    absMinY: number;
    absMaxX: number;
    absMaxY: number;
  } | null;
  onGroup: () => void;
}) {
  const { x, y, zoom } = useViewport();
  if (!bounds) return null;

  const screenLeft = bounds.absMinX * zoom + x;
  const screenTop = bounds.absMinY * zoom + y;
  const screenWidth = (bounds.absMaxX - bounds.absMinX) * zoom;

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-visible"
      style={{ zIndex: 10000 }}
    >
      <Tooltip label="Wrap selected nodes in a new Group">
        <Button
          onClick={onGroup}
          leftIcon={<Square className="h-3.5 w-3.5" weight="regular" />}
          size="sm"
          shape="rounded"
          className="nodrag nopan pointer-events-auto absolute h-7 min-h-7 rounded-md border-overlay-border bg-overlay-surface px-2.5 text-xs font-medium text-content-secondary shadow-overlay backdrop-blur hover:bg-warm-hover hover:text-content-primary"
          style={{
            left: screenLeft + screenWidth / 2,
            top: screenTop - 36,
            transform: "translateX(-50%)",
          }}
        >
          Group
        </Button>
      </Tooltip>
    </div>
  );
}

function DebugNodeIds({ nodes }: { nodes: AppNode[] }) {
  const { x, y, zoom } = useViewport();

  // Build absolute positions by traversing parent chain
  const posById = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    const getAbs = (node: AppNode): { x: number; y: number } => {
      if (map.has(node.id)) return map.get(node.id)!;
      let { x: nx, y: ny } = node.position;
      if (node.parentId) {
        const parent = nodes.find((n) => n.id === node.parentId);
        if (parent) {
          const p = getAbs(parent);
          nx += p.x;
          ny += p.y;
        }
      }
      const abs = { x: nx, y: ny };
      map.set(node.id, abs);
      return abs;
    };
    nodes.forEach(getAbs);
    return map;
  }, [nodes]);

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 9999 }}
    >
      <Accordion
        type="single"
        collapsible
        style={{
          transform: `translate(${x}px, ${y}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      >
        {nodes.map((node) => {
          const d = node.data ?? {};
          const parts = [node.id];
          if (d.status) parts.push(d.status);
          if (d.pendingTask) parts.push(`task:${d.pendingTask.slice(0, 8)}`);
          if (d.src) parts.push("src:✓");
          if (d.description) parts.push("desc:✓");
          if (d.error) parts.push(`err:${d.error.slice(0, 20)}`);
          if (d.modelId) parts.push(d.modelId);
          if (d._log?.length) parts.push(`log:${d._log.length}`);
          const abs = posById.get(node.id) ?? node.position;
          return (
            <AccordionItem
              key={`dbg-${node.id}`}
              value={node.id}
              className="pointer-events-auto absolute cursor-pointer"
              style={{
                left: abs.x,
                top: abs.y - 20,
              }}
            >
              <AccordionTrigger asChild>
                <Button
                  aria-label={`Toggle debug details for ${node.id}`}
                  className="h-auto min-h-0 rounded border-0 bg-black/85 px-1.5 py-0.5 font-mono text-[10px] text-green-400 shadow-none hover:bg-black/85 hover:text-green-300"
                >
                  <span className="whitespace-nowrap select-all">
                    {parts.join(" | ")}
                  </span>
                </Button>
              </AccordionTrigger>
              {d._log?.length > 0 && (
                <AccordionContent>
                  <div className="mt-1 rounded bg-black/90 p-2 font-mono text-[10px] text-gray-300 max-w-[400px] max-h-[200px] overflow-auto">
                    {d._log.map((entry: string, i: number) => (
                      <div
                        key={i}
                        className={
                          entry.includes("FAILED") ? "text-red-400" : ""
                        }
                      >
                        {entry}
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              )}
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}

export default function ProjectEditor({
  project,
  initialPrompt,
  initialThreadId,
}: ProjectEditorProps) {
  const nativeAgent = isMcpProjectApp();
  const { notify } = useAppFeedback();
  const session = betterAuthClient.useSession();
  const timelineExportActorUserId = session.data?.user?.id || project.ownerId;
  const transientUiStore = useMemo(() => createCanvasTransientUiStore(), []);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [modelCatalogVersion, setModelCatalogVersion] = useState(0);
  const [activeCanvasId, setActiveCanvasId] = useState("main");
  const [workspaceSurface, setWorkspaceSurface] =
    useState<ProjectWorkspaceSurface>({
      kind: "canvas",
      canvasId: "main",
    });
  const [canvasViews, setCanvasViews] = useState<
    Record<string, PersistedCanvasView>
  >({});
  const [projectSessionHydratedProjectId, setProjectSessionHydratedProjectId] =
    useState<string | null>(null);
  const [browserTabs, setBrowserTabs] = useState<ProjectBrowserTab[]>([]);
  const [browserAgentContexts, setBrowserAgentContexts] = useState<
    Record<string, BrowserAgentContext>
  >({});
  const [browserSessionHydratedProjectId, setBrowserSessionHydratedProjectId] =
    useState<string | null>(null);
  const [previewTextNodeId, setPreviewTextNodeId] = useState<string | null>(
    null,
  );
  const [isCanvasAssetDropActive, setIsCanvasAssetDropActive] = useState(false);
  const previousWorkspaceSurfaceRef = useRef(workspaceSurface);
  const activeCanvasIdRef = useRef(activeCanvasId);
  const workspaceSurfaceRef = useRef(workspaceSurface);
  const canvasViewsRef = useRef(canvasViews);
  const projectSessionHydratedProjectIdRef = useRef<string | null>(null);
  const threadIdRef = useRef(initialThreadId ?? "");
  const routedThreadIdRef = useRef(initialThreadId);
  const canvasSelectionRestorePendingRef = useRef(new Set<string>());
  const canvasEdgeSelectionRestorePendingRef = useRef(new Set<string>());
  const canvasViewportRestorePendingRef = useRef(new Set<string>());
  activeCanvasIdRef.current = activeCanvasId;
  workspaceSurfaceRef.current = workspaceSurface;
  canvasViewsRef.current = canvasViews;
  projectSessionHydratedProjectIdRef.current = projectSessionHydratedProjectId;

  const updateCanvasView = useCallback(
    (
      canvasId: string,
      update: (current: PersistedCanvasView) => PersistedCanvasView,
    ) => {
      const existing = canvasViewsRef.current[canvasId] ?? {
        viewport: null,
        selectedNodeIds: [],
        selectedEdgeIds: [],
      };
      const next = {
        ...canvasViewsRef.current,
        [canvasId]: update(existing),
      };
      canvasViewsRef.current = next;
      setCanvasViews(next);
      if (projectSessionHydratedProjectIdRef.current === project.id) {
        saveProjectEditorSession(window.localStorage, project.id, {
          activeCanvasId: activeCanvasIdRef.current,
          workspaceSurface: workspaceSurfaceRef.current,
          threadId: threadIdRef.current || null,
          canvasViews: next,
        });
      }
    },
    [project.id],
  );

  useEffect(() => {
    const restored = loadProjectEditorSession(window.localStorage, project.id);
    if (restored) {
      threadIdRef.current = initialThreadId ?? restored.threadId ?? "";
      activeCanvasIdRef.current = restored.activeCanvasId;
      workspaceSurfaceRef.current = restored.workspaceSurface;
      canvasViewsRef.current = restored.canvasViews;
      canvasSelectionRestorePendingRef.current = new Set(
        Object.keys(restored.canvasViews),
      );
      canvasEdgeSelectionRestorePendingRef.current = new Set(
        Object.keys(restored.canvasViews),
      );
      canvasViewportRestorePendingRef.current = new Set([
        restored.activeCanvasId,
      ]);
      setActiveCanvasId(restored.activeCanvasId);
      setWorkspaceSurface(restored.workspaceSurface);
      setCanvasViews(restored.canvasViews);
    } else {
      threadIdRef.current = initialThreadId ?? "";
      activeCanvasIdRef.current = "main";
      workspaceSurfaceRef.current = { kind: "canvas", canvasId: "main" };
      canvasViewsRef.current = {};
      canvasSelectionRestorePendingRef.current.clear();
      canvasEdgeSelectionRestorePendingRef.current.clear();
      canvasViewportRestorePendingRef.current.clear();
      setActiveCanvasId("main");
      setWorkspaceSurface({ kind: "canvas", canvasId: "main" });
      setCanvasViews({});
    }
    projectSessionHydratedProjectIdRef.current = project.id;
    setProjectSessionHydratedProjectId(project.id);
  }, [project.id]);

  useEffect(() => {
    if (projectSessionHydratedProjectId !== project.id) return;
    saveProjectEditorSession(window.localStorage, project.id, {
      activeCanvasId,
      workspaceSurface,
      threadId: threadIdRef.current || null,
      canvasViews,
    });
  }, [
    activeCanvasId,
    canvasViews,
    project.id,
    projectSessionHydratedProjectId,
    workspaceSurface,
  ]);

  useEffect(
    () => () => {
      if (projectSessionHydratedProjectIdRef.current !== project.id) return;
      saveProjectEditorSession(window.localStorage, project.id, {
        activeCanvasId: activeCanvasIdRef.current,
        workspaceSurface: workspaceSurfaceRef.current,
        threadId: threadIdRef.current || null,
        canvasViews: canvasViewsRef.current,
      });
    },
    [project.id],
  );

  useEffect(() => {
    const previous = previousWorkspaceSurfaceRef.current;
    const changed =
      previous.kind !== workspaceSurface.kind ||
      (previous.kind === "canvas" &&
        workspaceSurface.kind === "canvas" &&
        previous.canvasId !== workspaceSurface.canvasId) ||
      (previous.kind === "timeline" &&
        workspaceSurface.kind === "timeline" &&
        previous.timelineId !== workspaceSurface.timelineId) ||
      (previous.kind === "director-stage" &&
        workspaceSurface.kind === "director-stage" &&
        previous.stageId !== workspaceSurface.stageId) ||
      (previous.kind === "asset" &&
        workspaceSurface.kind === "asset" &&
        previous.assetId !== workspaceSurface.assetId) ||
      (previous.kind === "browser" &&
        workspaceSurface.kind === "browser" &&
        previous.browserId !== workspaceSurface.browserId) ||
      (previous.kind === "text-asset" &&
        workspaceSurface.kind === "text-asset" &&
        (previous.nodeId !== workspaceSurface.nodeId ||
          previous.canvasId !== workspaceSurface.canvasId));
    if (changed) transientUiStore.dismiss();
    previousWorkspaceSurfaceRef.current = workspaceSurface;
  }, [transientUiStore, workspaceSurface]);

  const [followingAgent, setFollowingAgent] = useState(false);
  const followingAgentRef = useRef(false);
  const lastAgentTargetRef = useRef<AgentFollowTarget | null>(null);
  const pendingAgentTargetRef = useRef<AgentFollowTarget | null>(null);
  const pendingAssetRelationTargetRef = useRef<AgentFollowTarget | null>(null);
  const queueAgentFollowTargetRef = useRef<(target: AgentFollowTarget) => void>(
    () => {},
  );
  const reactFlowInstanceRef = useRef<ReactFlowInstance<AppNode, Edge> | null>(
    null,
  );
  const canvasViewportRestoreFrameRef = useRef<number | null>(null);

  const restoreCanvasViewport = useCallback(
    (canvasId: string, instance = reactFlowInstanceRef.current): void => {
      if (!instance) return;
      if (canvasViewportRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(canvasViewportRestoreFrameRef.current);
      }
      canvasViewportRestoreFrameRef.current = window.requestAnimationFrame(
        () => {
          canvasViewportRestoreFrameRef.current = null;
          const viewport = canvasViewsRef.current[canvasId]?.viewport;
          if (viewport) {
            void instance.setViewport(viewport, { duration: 0 });
          } else {
            void instance.fitView({ padding: 0.1, duration: 0 });
          }
        },
      );
    },
    [],
  );

  useEffect(
    () => () => {
      if (canvasViewportRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(canvasViewportRestoreFrameRef.current);
      }
    },
    [],
  );

  const setFollowingAgentMode = useCallback((following: boolean) => {
    followingAgentRef.current = following;
    setFollowingAgent(following);
    if (!following) {
      pendingAgentTargetRef.current = null;
      return;
    }
    if (lastAgentTargetRef.current) {
      queueAgentFollowTargetRef.current(lastAgentTargetRef.current);
    }
  }, []);

  const stopFollowingAgent = useCallback(() => {
    if (followingAgentRef.current) setFollowingAgentMode(false);
  }, [setFollowingAgentMode]);

  const recordAgentTarget = useCallback((nodeId: string, canvasId?: string) => {
    const id = nodeId.trim();
    if (!id) return;
    const target = {
      nodeId: id,
      canvasId: canvasId?.trim() || activeCanvasIdRef.current,
    };
    lastAgentTargetRef.current = target;
    if (followingAgentRef.current) queueAgentFollowTargetRef.current(target);
  }, []);

  // Loro remains the single source of truth. These asset-ref nodes are only
  // a recovery bootstrap for old projects whose Loro document is empty while
  // the project still owns media assets.
  const [nodes, setNodesInternal] = useNodesState<AppNode>([]);
  // Keep visible object identity available to browser accessibility/annotation
  // tools; these are the same IDs accepted by Canvas tools, not DOM indices.
  const readableNodes = useMemo(() => nodes.map((node) => ({
    ...node,
    ariaLabel: `${typeof node.data.label === "string" ? node.data.label : node.type ?? "Node"} (${node.type ?? "node"}, node ${node.id})`,
  })), [nodes]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const nodesRef = useRef<AppNode[]>(nodes);
  const edgesRef = useRef<Edge[]>(edges);
  const copilotNodesRef = useRef<CopilotCanvasNode[]>([]);

  const copilotNodes = useMemo(() => {
    const next = reconcileCopilotCanvasNodes(copilotNodesRef.current, nodes);
    copilotNodesRef.current = next;
    return next;
  }, [nodes]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  // Wrap setNodes to ALWAYS sanitize before setting - this prevents "Parent node X not found" errors
  // The sanitization must happen BEFORE nodes are set to state, not after
  const setNodes = useCallback(
    (updater: Node[] | ((nodes: Node[]) => Node[])) => {
      setNodesInternal((currentNodes) => {
        const newNodes =
          typeof updater === "function" ? updater(currentNodes) : updater;
        return sanitizeNodes(newNodes);
      });
    },
    [setNodesInternal],
  );
  const [projectName, setProjectName] = useState(project.name);
  const projectTitleInputRef = useRef<HTMLInputElement>(null);
  const location = useLocation();
  const [showDebugIds, setShowDebugIds] = useState(false);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("hand");
  const [preferredCanvasMode, setPreferredCanvasMode] =
    useState<CanvasMode>("hand");
  const [canvasPreferencesHydrated, setCanvasPreferencesHydrated] =
    useState(false);
  const [canvasFoldersOpen, setCanvasFoldersOpen] = useState(false);
  const [canvasFolderQuery, setCanvasFolderQuery] = useState("");
  const [minimapCollapsed, setMinimapCollapsed] = useState(false);
  const [minimapResizing, setMinimapResizing] = useState(false);
  const [minimapCollapseVelocity, setMinimapCollapseVelocity] = useState(0);
  const [minimapSize, setMinimapSize] =
    useState<MinimapSize>(DEFAULT_MINIMAP_SIZE);
  const minimapSizeRef = useRef<MinimapSize>(DEFAULT_MINIMAP_SIZE);
  const lastExpandedMinimapSizeRef = useRef<MinimapSize>(DEFAULT_MINIMAP_SIZE);
  const canvasPreferencesRef = useRef<CanvasPreferences>({
    mode: "select",
    minimapCollapsed: false,
    minimapSize: DEFAULT_MINIMAP_SIZE,
  });
  const canvasPreferencesHydratedRef = useRef(false);
  const minimapResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startSize: MinimapSize;
    lastPointer: { x: number; y: number; time: number };
    collapseVelocity: number;
  } | null>(null);

  canvasPreferencesRef.current = {
    mode: preferredCanvasMode,
    minimapCollapsed,
    minimapSize,
  };

  useEffect(() => {
    const preferences = loadCanvasPreferences(window.localStorage);
    setCanvasMode(preferences.mode);
    setPreferredCanvasMode(preferences.mode);
    setMinimapCollapsed(preferences.minimapCollapsed);
    setMinimapSize(preferences.minimapSize);
    minimapSizeRef.current = preferences.minimapSize;
    lastExpandedMinimapSizeRef.current = preferences.minimapSize;
    canvasPreferencesRef.current = preferences;
    canvasPreferencesHydratedRef.current = true;
    setCanvasPreferencesHydrated(true);
  }, []);

  useEffect(() => {
    if (!canvasPreferencesHydrated) return;
    const preferences = {
      mode: preferredCanvasMode,
      minimapCollapsed,
      minimapSize,
    } satisfies CanvasPreferences;
    canvasPreferencesRef.current = preferences;
    saveCanvasPreferences(window.localStorage, preferences);
  }, [
    canvasPreferencesHydrated,
    minimapCollapsed,
    minimapSize,
    preferredCanvasMode,
  ]);

  useEffect(
    () => () => {
      if (!canvasPreferencesHydratedRef.current) return;
      saveCanvasPreferences(window.localStorage, canvasPreferencesRef.current);
    },
    [],
  );

  const selectCanvasMode = useCallback((mode: CanvasMode) => {
    const preferences = { ...canvasPreferencesRef.current, mode };
    canvasPreferencesRef.current = preferences;
    if (canvasPreferencesHydratedRef.current) {
      saveCanvasPreferences(window.localStorage, preferences);
    }
    setPreferredCanvasMode(mode);
    setCanvasMode(mode);
  }, []);
  useHotkeys("mod+shift+i", () => setShowDebugIds((visible) => !visible), {
    enabled: process.env.NODE_ENV === "development",
    preventDefault: true,
  });
  const handleProjectNameSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    projectTitleInputRef.current?.blur();
  };

  useEffect(() => {
    const detail: DesktopTabTitleEventDetail = {
      path: location.pathname,
      title: projectName || project.name || "Untitled",
    };
    window.dispatchEvent(new CustomEvent(DESKTOP_TAB_TITLE_EVENT, { detail }));
  }, [location.pathname, project.name, projectName]);

  const { addToast } = useActivityToasts();
  const { highlights, addHighlight } = useNodeHighlights();

  // Awareness: live cursor + selection over the same WS.
  // The handler ref is set by usePresenceAwareness below; useLoroSync
  // forwards every `awareness.broadcast` frame into it.
  const awarenessSinkRef = useRef<
    ((msg: AwarenessBroadcastMessage) => void) | null
  >(null);
  const flowBoundsRef = useRef<HTMLDivElement | null>(null);
  const registerOnAwareness = useCallback(
    (handler: ((msg: AwarenessBroadcastMessage) => void) | null) => {
      awarenessSinkRef.current = handler;
    },
    [],
  );

  // Loro CRDT sync
  const loroSync = useLoroSync({
    projectId: project.id,
    canvasId: activeCanvasId,
    onActivity: (activity: ActivityMessage) => {
      addToast(activity);
      addHighlight(activity);
      if (
        activity.actor.clientType === "agent" &&
        activity.action !== "deleted"
      ) {
        recordAgentTarget(activity.nodeId, activity.canvasId);
      }
    },
    onMutation: (mutation) => dispatchHostMutationEvent(project.id, mutation),
    onAwareness: (msg) => {
      awarenessSinkRef.current?.(msg);
    },
    onNodesChange: (syncedNodes) => {
      // Loro is the SINGLE SOURCE OF TRUTH - use its state directly
      // Only preserve spatial state during active interaction (drag/resize).
      // Selection is UI-only and should NOT block remote/local layout updates.
      const currentNodes = nodesRef.current;
      const currentNodesMap = new Map(currentNodes.map((n) => [n.id, n]));
      let processedNodes = syncedNodes.map((syncedNode) => {
        const currentNode = currentNodesMap.get(syncedNode.id);

        // Fix: Ensure text nodes have correct dimensions (300x400)
        // TextNode renders at w-[300px] h-[400px] but data might have wrong height
        let correctedNode = syncedNode;
        if (syncedNode.type === "text") {
          const currentHeight = syncedNode.height || syncedNode.style?.height;
          const currentWidth = syncedNode.width || syncedNode.style?.width;

          if (currentHeight !== 400 || currentWidth !== 300) {
            correctedNode = {
              ...syncedNode,
              width: 300,
              height: 400,
              style: {
                ...syncedNode.style,
                width: 300,
                height: 400,
              },
            };
          }
        }

        if (!currentNode) return correctedNode;

        const isInteracting = !!(currentNode.dragging || currentNode.resizing);
        return {
          ...correctedNode, // Trust Loro for data + layout unless interacting
          position: isInteracting
            ? currentNode.position
            : correctedNode.position,
          parentId: isInteracting
            ? currentNode.parentId
            : correctedNode.parentId,
          width: isInteracting ? currentNode.width : correctedNode.width,
          height: isInteracting ? currentNode.height : correctedNode.height,
          style: isInteracting ? currentNode.style : correctedNode.style,
          // Always preserve UI-only flags
          selected: currentNode.selected,
          dragging: currentNode.dragging,
          resizing: currentNode.resizing,
        };
      });
      processedNodes = sanitizeNodes(processedNodes);
      processedNodes = normalizeCanvasNodeZIndex(
        processedNodes as AppNode[],
        CHILD_NODE_Z_INDEX_BASE,
      );
      processedNodes = reconcileSyncedCanvasNodes(currentNodes, processedNodes);

      const currentCanvasId = activeCanvasIdRef.current;
      if (canvasSelectionRestorePendingRef.current.delete(currentCanvasId)) {
        const selectedNodeIds = new Set(
          canvasViewsRef.current[currentCanvasId]?.selectedNodeIds ?? [],
        );
        processedNodes = processedNodes.map((node) => ({
          ...node,
          selected: selectedNodeIds.has(node.id),
        }));
        const restoredSelection = processedNodes.filter(
          (node) => node.selected,
        );
        selectedNodesRef.current = restoredSelection;
        setSelectedNodes(restoredSelection);
      }
      nodesRef.current = processedNodes as AppNode[];
      setNodesInternal(processedNodes as AppNode[]);

      if (canvasViewportRestorePendingRef.current.delete(currentCanvasId)) {
        restoreCanvasViewport(currentCanvasId);
      }


    },
    onEdgesChange: (syncedEdges) => {
      let processedEdges = reconcileSyncedCanvasEdges(
        edgesRef.current,
        syncedEdges,
      );
      const currentCanvasId = activeCanvasIdRef.current;
      if (
        canvasEdgeSelectionRestorePendingRef.current.delete(currentCanvasId)
      ) {
        const selectedEdgeIds = new Set(
          canvasViewsRef.current[currentCanvasId]?.selectedEdgeIds ?? [],
        );
        processedEdges = processedEdges.map((edge) => ({
          ...edge,
          selected: selectedEdgeIds.has(edge.id),
        }));
      }
      edgesRef.current = processedEdges;
      setEdges(processedEdges);
    },
  });
  useEffect(() => {
    const detail: DesktopTabConnectionEventDetail = {
      path: location.pathname,
      connection: !loroSync.isInitialized
        ? "connecting"
        : loroSync.connected
          ? "connected"
          : "disconnected",
    };
    dispatchDesktopTabConnection(detail);
  }, [location.pathname, loroSync.connected, loroSync.isInitialized]);
  useEffect(() => {
    const path = location.pathname;
    return () => {
      const detail: DesktopTabConnectionEventDetail = {
        path,
        connection: undefined,
      };
      dispatchDesktopTabConnection(detail);
    };
  }, [location.pathname]);
  const canvasFolderCanvases = useMemo(
    () =>
      loroSync.canvases.filter((canvas) => !isImplicitCanvasRoot(canvas.name)),
    [loroSync.canvases],
  );
  const activeCanvasUsesImplicitRoot = useMemo(
    () =>
      loroSync.canvases.some(
        (canvas) =>
          canvas.id === activeCanvasId && isImplicitCanvasRoot(canvas.name),
      ),
    [activeCanvasId, loroSync.canvases],
  );
  const minimapControlOffset = `calc(${minimapCollapsed ? 32 : minimapSize.height}px + var(--clash-project-chrome-gutter) + var(--clash-project-chrome-gutter))`;

  // Ref to access loroSync in callbacks without causing re-renders
  const loroSyncRef = useRef(loroSync);
  useEffect(() => {
    loroSyncRef.current = loroSync;
  }, [loroSync]);

  useEffect(() => {
    if (projectSessionHydratedProjectId !== project.id || !loroSync.doc) return;
    if (loroSync.canvases.length === 0) return;
    if (loroSync.canvases.some((canvas) => canvas.id === activeCanvasId))
      return;
    const nextCanvasId = loroSync.canvases[0].id;
    canvasSelectionRestorePendingRef.current.add(nextCanvasId);
    canvasEdgeSelectionRestorePendingRef.current.add(nextCanvasId);
    canvasViewportRestorePendingRef.current.add(nextCanvasId);
    setActiveCanvasId(nextCanvasId);
    setWorkspaceSurface({ kind: "canvas", canvasId: nextCanvasId });
  }, [
    activeCanvasId,
    loroSync.canvases,
    loroSync.doc,
    project.id,
    projectSessionHydratedProjectId,
  ]);

  useEffect(() => {
    if (
      projectSessionHydratedProjectId !== project.id ||
      !loroSync.isInitialized
    ) {
      return;
    }
    restoreCanvasViewport(activeCanvasId);
  }, [
    activeCanvasId,
    loroSync.isInitialized,
    project.id,
    projectSessionHydratedProjectId,
    restoreCanvasViewport,
  ]);

  // Awareness: cursor + selection. Rides on loroSync's WS via sendSideband.
  // sendSideband doesn't change identity once loroSync is created, so we
  // pass it directly without ref'ing.
  const awareness = usePresenceAwareness({
    registerOnAwareness,
    sendSideband: loroSync.sendSideband,
  });

  // File upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const assetFileInputRef = useRef<HTMLInputElement>(null);
  const [locallyAddedProjectAssets, setLocallyAddedProjectAssets] = useState<
    ResolvedAsset[]
  >([]);
  const [syncedProjectAssets, setSyncedProjectAssets] = useState<
    ResolvedAsset[]
  >(project.assets ?? []);
  const [globalProjectAssets, setGlobalProjectAssets] = useState<
    ResolvedAsset[]
  >([]);
  const activeProjectAssetProjectIdRef = useRef(project.id);
  const canvasModeBeforeSpace = useRef<CanvasMode>("hand");
  const [pendingNodeType, setPendingNodeType] = useState<string | null>(null);
  const [assetPickerTarget, setAssetPickerTarget] =
    useState<(AssetScopeTarget & { position?: { x: number; y: number } }) | null>(null);
  const [assetPickerBusy, setAssetPickerBusy] = useState(false);
  const [timelineInsertRequest, setTimelineInsertRequest] = useState<{
    timelineId: string;
    requestId: string;
    asset: EditorAssetInput;
  } | null>(null);
  const [assetRelationRevision, setAssetRelationRevision] = useState(0);

  useEffect(() => {
    setLocallyAddedProjectAssets([]);
    setSyncedProjectAssets(project.assets ?? []);
    activeProjectAssetProjectIdRef.current = project.id;
  }, [project.assets, project.id]);

  useEffect(() => {
    if (!loroSync.doc) return;
    return subscribeProjectAssetProjection({
      doc: loroSync.doc,
      projectId: project.id,
      onProjection: (assets) => {
        if (activeProjectAssetProjectIdRef.current !== project.id) return;
        setSyncedProjectAssets(assets);
        setLocallyAddedProjectAssets([]);
      },
      onError: (error) =>
        editorLog.warn("asset.projection_refresh_failed", { projectId: project.id, error }),
    });
  }, [loroSync.doc, project.id]);

  useEffect(() => {
    let cancelled = false;
    void listPersonalGlobalAssets()
      .then((assets) => {
        if (cancelled) return;
        setGlobalProjectAssets(
          assets.filter(
            (asset) =>
              asset.kind === "image" ||
              asset.kind === "video" ||
              asset.kind === "audio",
          ),
        );
      })
      .catch((error) => editorLog.warn("asset.catalog_load_failed", { error }));
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Sidebar state
  // Sidebar state starts with server defaults; localStorage is read post-mount to avoid hydration mismatch.
  const [sidebarWidth, setSidebarWidth] = useState(defaultCopilotPanelWidth);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const projectWorkspaceShellRef = useRef<HTMLDivElement>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [pendingAgentAnnotations, setPendingAgentAnnotations] = useState<
    AgentAnnotationDraft[]
  >([]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null,
  );
  const [annotationContextTarget, setAnnotationContextTarget] =
    useState<AgentAnnotationTarget | null>(null);
  const selectionAnnotationOverlayRef =
    useRef<AgentSelectionAnnotationOverlayHandle>(null);
  const [isProjectNavigatorCollapsed, setIsProjectNavigatorCollapsed] =
    useState(false);
  const [sidebarHydrated, setSidebarHydrated] = useState(false);
  const shouldReserveCopilotSpace =
    !nativeAgent && workspaceSurface.kind !== "canvas" && !isSidebarCollapsed;
  const copilotWorkspaceRight = shouldReserveCopilotSpace
    ? sidebarWidth + COPILOT_PANEL_GUTTER_PX * 2
    : 0;
  const copilotHeaderInset =
    !nativeAgent && isSidebarCollapsed && workspaceSurface.kind !== "canvas" ? 40 : 0;
  const handleCopilotWidthPreview = useCallback(
    (width: number) => {
      const nextWidth = clampCopilotPanelWidth(width);
      sidebarWidthRef.current = nextWidth;
      const shell = projectWorkspaceShellRef.current;
      if (shell) {
        if (shouldReserveCopilotSpace) {
          shell.style.right = `${nextWidth + COPILOT_PANEL_GUTTER_PX * 2}px`;
        } else {
          shell.style.right = "0px";
        }
      }
      return nextWidth;
    },
    [shouldReserveCopilotSpace],
  );
  const handleCopilotWidthChange = useCallback(
    (width: number) => {
      const nextWidth = handleCopilotWidthPreview(width);
      setSidebarWidth((current) =>
        current === nextWidth ? current : nextWidth,
      );
    },
    [handleCopilotWidthPreview],
  );
  const handleCopilotResizeStateChange = useCallback((resizing: boolean) => {
    const shell = projectWorkspaceShellRef.current;
    if (!shell) return;
    shell.dataset.copilotResizing = resizing ? "true" : "false";
  }, []);

  const clearAnnotationContextTarget = useCallback(() => {
    setAnnotationContextTarget(null);
  }, []);

  const showAnnotationContextTarget = useCallback(
    (target: AgentAnnotationTarget) => {
      setAnnotationContextTarget(target);
    },
    [],
  );

  const openAgentAnnotation = useCallback((annotationId: string) => {
    setActiveAnnotationId(annotationId);
  }, []);

  const queueAgentAnnotation = useCallback(
    (target: AgentAnnotationTarget, note = ""): string => {
      const selection = target.selection;
      const existing = pendingAgentAnnotations.find(
        (annotation) =>
          annotation.target.objectPath === target.objectPath &&
          annotation.target.selection?.exact === selection?.exact &&
          annotation.target.selection?.prefix === selection?.prefix &&
          annotation.target.selection?.suffix === selection?.suffix,
      );
      if (existing) {
        openAgentAnnotation(existing.id);
        return existing.id;
      }
      const id = `agent-annotation-${Date.now().toString(36)}-${
        pendingAgentAnnotations.length + 1
      }`;
      setPendingAgentAnnotations((current) => [
        ...current,
        {
          id,
          kind: "agent-annotation",
          note,
          target,
        },
      ]);
      openAgentAnnotation(id);
      return id;
    },
    [openAgentAnnotation, pendingAgentAnnotations],
  );

  const changeAgentAnnotation = useCallback(
    (annotationId: string, note: string) => {
      setPendingAgentAnnotations((current) =>
        current.map((annotation) =>
          annotation.id === annotationId ? { ...annotation, note } : annotation,
        ),
      );
    },
    [],
  );

  const removeAgentAnnotation = useCallback((annotationId: string) => {
    setPendingAgentAnnotations((current) =>
      current.filter((annotation) => annotation.id !== annotationId),
    );
    setActiveAnnotationId((current) =>
      current === annotationId ? null : current,
    );
  }, []);

  const clearSubmittedAgentAnnotations = useCallback(
    (annotationIds: string[]) => {
      const submitted = new Set(annotationIds);
      setPendingAgentAnnotations((current) =>
        current.filter((annotation) => !submitted.has(annotation.id)),
      );
      setActiveAnnotationId((current) =>
        current && submitted.has(current) ? null : current,
      );
    },
    [],
  );

  useEffect(() => {
    const savedWidth = localStorage.getItem("copilot-sidebar-width");
    if (savedWidth) {
      const parsedWidth = parseInt(savedWidth, 10);
      const nextDefault = defaultCopilotPanelWidth();
      setSidebarWidth(
        Number.isFinite(parsedWidth)
          ? clampCopilotPanelWidth(parsedWidth)
          : nextDefault,
      );
    }
    setIsSidebarCollapsed(
      localStorage.getItem("copilot-sidebar-collapsed") === "true",
    );
    setIsProjectNavigatorCollapsed(
      localStorage.getItem("project-navigator-collapsed") === "true",
    );
    setSidebarHydrated(true);
  }, []);

  useEffect(() => {
    const constrainPanelToViewport = () => {
      handleCopilotWidthChange(sidebarWidthRef.current);
    };
    window.addEventListener("resize", constrainPanelToViewport);
    return () => window.removeEventListener("resize", constrainPanelToViewport);
  }, [handleCopilotWidthChange]);

  useEffect(() => {
    if (sidebarHydrated)
      localStorage.setItem("copilot-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth, sidebarHydrated]);
  useEffect(() => {
    if (loroSync.timelines.length === 0 || workspaceSurface.kind === "timeline")
      return;

    const warmTimelineEditor = () => {
      void preloadTimelineEditor();
    };
    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(warmTimelineEditor, {
        timeout: 1200,
      });
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = globalThis.setTimeout(warmTimelineEditor, 250);
    return () => globalThis.clearTimeout(timeoutId);
  }, [loroSync.timelines.length, workspaceSurface.kind]);
  useEffect(() => {
    if (sidebarHydrated)
      localStorage.setItem(
        "copilot-sidebar-collapsed",
        String(isSidebarCollapsed),
      );
  }, [isSidebarCollapsed, sidebarHydrated]);
  useEffect(() => {
    if (sidebarHydrated)
      localStorage.setItem(
        "project-navigator-collapsed",
        String(isProjectNavigatorCollapsed),
      );
  }, [isProjectNavigatorCollapsed, sidebarHydrated]);
  useEffect(() => {
    const handleProjectNavigatorVisibility = (event: Event) => {
      const detail = (event as CustomEvent<ProjectNavigatorVisibilityDetail>)
        .detail;
      if (typeof detail?.collapsed === "boolean") {
        setIsProjectNavigatorCollapsed(detail.collapsed);
      }
    };

    window.addEventListener(
      PROJECT_NAVIGATOR_VISIBILITY_EVENT,
      handleProjectNavigatorVisibility,
    );
    return () =>
      window.removeEventListener(
        PROJECT_NAVIGATOR_VISIBILITY_EVENT,
        handleProjectNavigatorVisibility,
      );
  }, []);

  // Chat session state
  const [threadId, setThreadId] = useState<string>(threadIdRef.current);
  const [sessionKey, setSessionKey] = useState(0);
  const [chatInitialPrompt, setChatInitialPrompt] = useState<
    string | undefined
  >(initialPrompt);
  const editorRouter = useNavigate();
  const {
    sessions: sessionHistory,
    hasMoreSessions: sessionHistoryHasMore,
    isLoadingMoreSessions: sessionHistoryLoadingMore,
    loadMoreSessions: loadMoreSessionHistory,
    upsertSession,
    archiveSession,
    renameSession,
  } = useSessionHistory(project.id, { loadActive: !nativeAgent });

  useEffect(() => {
    if (routedThreadIdRef.current !== initialThreadId) {
      routedThreadIdRef.current = initialThreadId;
      threadIdRef.current = initialThreadId ?? "";
    }
    if (projectSessionHydratedProjectId === project.id) {
      setThreadId(threadIdRef.current);
      saveProjectEditorSession(window.localStorage, project.id, {
        activeCanvasId: activeCanvasIdRef.current,
        workspaceSurface: workspaceSurfaceRef.current,
        threadId: threadIdRef.current || null,
        canvasViews: canvasViewsRef.current,
      });
    }
  }, [initialThreadId, project.id, projectSessionHydratedProjectId]);

  const replaceProjectSessionRoute = useCallback(
    (nextThreadId: string | null) => {
      const next = nextThreadId ?? "";
      threadIdRef.current = next;
      setThreadId(next);
      if (projectSessionHydratedProjectIdRef.current === project.id) {
        saveProjectEditorSession(window.localStorage, project.id, {
          activeCanvasId: activeCanvasIdRef.current,
          workspaceSurface: workspaceSurfaceRef.current,
          threadId: next || null,
          canvasViews: canvasViewsRef.current,
        });
      }
      const nextSearch = withProjectSessionSearch(
        location.search,
        nextThreadId,
      );
      if (nextSearch === location.search) return;
      void editorRouter(
        {
          pathname: location.pathname,
          search: nextSearch,
          hash: location.hash,
        },
        { replace: true },
      );
    },
    [
      editorRouter,
      location.hash,
      location.pathname,
      location.search,
      project.id,
    ],
  );

  const handleReturnToProjects = useCallback(() => {
    if (nativeAgent) {
      void sendMcpProjectRequest(project.id, "close", "").catch((error) => {
        notify({ title: "Could not return to the conversation", message: error instanceof Error ? error.message : String(error), variant: "error" });
      });
      return;
    }
    editorRouter("/projects");
  }, [editorRouter, nativeAgent, project.id, notify]);

  const handleCreateSession = useCallback(
    async (
      initialMessage?: string,
    ): Promise<{ threadId: string; title: string } | null> => {
      try {
        const title = initialMessage
          ? initialMessage.slice(0, 40).trim() +
            (initialMessage.length > 40 ? "..." : "")
          : `Session`;
        const res = await fetch(runtimeApiUrl("/api/v1/sessions"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: project.id, title }),
        });
        if (!res.ok) throw new Error("Failed to create session");
        const data = (await res.json()) as { threadId: string };
        // Don't update any state here — caller batches all state updates together
        return { threadId: data.threadId as string, title };
      } catch (err) {
        editorLog.error("session.create_failed", { projectId: project.id, error: err });
        return null;
      }
    },
    [project.id],
  );

  const handleNewSession = useCallback(() => {
    lastAgentTargetRef.current = null;
    setFollowingAgentMode(false);
    setChatInitialPrompt(undefined);
    replaceProjectSessionRoute(null);
    setSessionKey((k) => k + 1);
  }, [replaceProjectSessionRoute, setFollowingAgentMode]);

  const handleSwitchSession = useCallback(
    (id: string) => {
      lastAgentTargetRef.current = null;
      setFollowingAgentMode(false);
      setChatInitialPrompt(undefined);
      replaceProjectSessionRoute(id);
      setSessionKey((key) => key + 1);
    },
    [replaceProjectSessionRoute, setFollowingAgentMode],
  );

  const handleArchiveSession = useCallback(
    async (id: string) => {
      await archiveSession(id);
      if (id === threadId) {
        lastAgentTargetRef.current = null;
        setFollowingAgentMode(false);
        replaceProjectSessionRoute(null);
        setSessionKey((key) => key + 1);
      }
    },
    [
      archiveSession,
      replaceProjectSessionRoute,
      setFollowingAgentMode,
      threadId,
    ],
  );

  const handleRenameSession = useCallback(
    async (id: string, title: string) => {
      await renameSession(id, title);
    },
    [renameSession],
  );

  const handleCopilotCreateSession = useCallback(
    async (initialMessage: string) => {
      const result = await handleCreateSession(initialMessage);
      if (!result) throw new Error("Failed to create session");
      upsertSession({
        threadId: result.threadId,
        title: result.title,
        type: "cloud",
      });
      setChatInitialPrompt(initialMessage);
      replaceProjectSessionRoute(result.threadId);
      setSessionKey((k) => k + 1);
    },
    [handleCreateSession, replaceProjectSessionRoute, upsertSession],
  );

  // Home passes its first prompt straight into ChatbotCopilot. The copilot
  // submits it through the same runtime/harness path as an in-project prompt;
  // creating a cloud thread here would fork the two composer contracts.

  // Selection state
  const [selectedNodes, setSelectedNodes] = useState<Node[]>([]);
  const selectedNodesRef = useRef<Node[]>([]);
  const [isNodeDragging, setIsNodeDragging] = useState(false);
  // True while the user is actively dragging the marquee. We hide the
  // "Group" pill until release — otherwise it flickers in mid-drag as the
  // selection rectangle grows past 2 nodes.
  const [isMarqueeing, setIsMarqueeing] = useState(false);

  const applyAutoZIndex = useCallback(
    (nodeList: Node[]): Node[] =>
      normalizeCanvasNodeZIndex(nodeList, CHILD_NODE_Z_INDEX_BASE),
    [],
  );

  // Custom onNodesChange to handle recursive resizing
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const currentNodes = nodesRef.current;
      let updatedNodes = applyNodeChanges(
        changes as NodeChange<AppNode>[],
        currentNodes,
      );

      // Check for dimension changes (resizing)
      const resizeChanges = changes.filter(isUserResizeChange);
      if (resizeChanges.length > 0) {
        let hasUpdates = false;

        resizeChanges.forEach((change) => {
          if (change.type === "dimensions" && change.dimensions) {
            const node = updatedNodes.find((n) => n.id === change.id);
            if (!node) return;

            // Update the node's dimensions in our temp list
            const nodeIndex = updatedNodes.findIndex((n) => n.id === change.id);
            if (nodeIndex !== -1) {
              updatedNodes[nodeIndex] = {
                ...updatedNodes[nodeIndex],
                width: change.dimensions.width,
                height: change.dimensions.height,
                style: {
                  ...updatedNodes[nodeIndex].style,
                  width: change.dimensions.width,
                  height: change.dimensions.height,
                },
              };
            }

            // CASE 1: If a GROUP is resized, check if any nodes should become children
            if (node.type === "group") {
              const resizedGroup = updatedNodes[nodeIndex];
              const groupAbsRect = getAbsoluteRect(resizedGroup, updatedNodes);

              // Check all non-descendant nodes to see if they're now inside this group
              updatedNodes.forEach((otherNode, otherIndex) => {
                // Skip the group itself and its existing descendants
                if (otherNode.id === node.id) return;
                if (isDescendant(otherNode.id, node.id, updatedNodes)) return;

                // Skip nodes that are ancestors of this group (can't put parent inside child)
                if (isDescendant(node.id, otherNode.id, updatedNodes)) return;

                const otherAbsRect = getAbsoluteRect(otherNode, updatedNodes);
                const isInside = rectContains(groupAbsRect, otherAbsRect);
                const wasInside = otherNode.parentId === node.id;

                if (isInside && !wasInside) {
                  const groupAbsPos = getAbsolutePosition(
                    resizedGroup,
                    updatedNodes,
                  );
                  const relativePos = {
                    x: otherAbsRect.x - groupAbsPos.x,
                    y: otherAbsRect.y - groupAbsPos.y,
                  };
                  updatedNodes[otherIndex] = {
                    ...otherNode,
                    parentId: node.id,
                    position: relativePos,
                    extent: undefined,
                  };
                  hasUpdates = true;
                }
              });
            }

            // CASE 2: If a node with parentId is resized, scale parent groups
            if (node.parentId) {
              const scales = recursiveGroupScale(change.id, updatedNodes);
              if (scales.size > 0) {
                updatedNodes = applyGroupScales(updatedNodes, scales);
                hasUpdates = true;

                const mesh = createMesh({
                  cellWidth: 50,
                  cellHeight: 50,
                  maxColumns: 10,
                });
                for (const groupId of scales.keys()) {
                  const result = resolveCollisions(
                    updatedNodes,
                    groupId,
                    mesh,
                    { maxIterations: 10 },
                  );
                  if (result.steps.length > 0) {
                    updatedNodes = applyResolution(updatedNodes, result);
                  }
                }
              }
            }
          }
        });

        if (!hasUpdates) {
          // no-op
        }

        // Persist any derived layout changes caused by resizing (dimensions/group scaling/collision resolution)
        // NOTE: We intentionally do NOT sync drag position changes here; those are handled in onNodeDragStop.
        const patches = collectLayoutNodePatches(currentNodes, updatedNodes);
        applyLayoutPatchesToLoro(loroSync, patches);
      }

      if (nodeChangesRequireZIndexNormalization(changes)) {
        updatedNodes = applyAutoZIndex(updatedNodes);
      }

      // Position and selection changes cannot invalidate parent ordering, so keep
      // those frame-rate-sensitive updates on the direct ReactFlow path.
      // Keep CRDT writes outside React state updater functions because React may replay them.
      const nextNodes = nodeChangesRequireStructuralSanitize(changes)
        ? (sanitizeNodes(updatedNodes) as AppNode[])
        : updatedNodes;
      nodesRef.current = nextNodes;
      setNodesInternal(nextNodes);

      // Handle node deletions - sync to Loro (Fallback if onNodesDelete doesn't fire)
      const removeChanges = changes.filter((c) => c.type === "remove");
      if (removeChanges.length > 0) {
        loroSync.removeNodes(removeChanges.map((change) => change.id));
      }
    },
    [setNodesInternal, loroSync, applyAutoZIndex],
  );

  // GC-style protection: a canvas asset that's been consumed by a
  // materialized ActionBadge checkpoint can't be silently yanked out from
  // under it. A previously run action without materialized downstream is
  // still editable; the checkpoint boundary is the downstream output.
  const onBeforeDelete = useCallback(
    async ({ nodes: nds, edges: eds }: { nodes: Node[]; edges: Edge[] }) => {
      const checkpointActionIds = new Set<string>();
      for (const n of nodes) {
        if (
          n.type === "action-badge" &&
          actionIsCheckpointLocked({ nodeId: n.id, nodes, edges })
        ) {
          checkpointActionIds.add(n.id);
        }
      }
      if (checkpointActionIds.size === 0) return { nodes: nds, edges: eds };

      const lockedEdgeIds = new Set<string>();
      const pinnedNodeIds = new Set<string>();
      for (const e of edges) {
        if (checkpointActionIds.has(e.target)) {
          lockedEdgeIds.add(e.id);
          pinnedNodeIds.add(e.source);
        }
      }

      const allowedNodes = nds.filter((n) => !pinnedNodeIds.has(n.id));
      const allowedEdges = eds.filter((e) => !lockedEdgeIds.has(e.id));
      return { nodes: allowedNodes, edges: allowedEdges };
    },
    [nodes, edges],
  );

  // Reliable sync handlers
  const onNodesDelete = useCallback(
    (deletedNodes: Node[]) => {
      loroSync.removeNodes(deletedNodes.map((node) => node.id));
    },
    [loroSync],
  );

  const onNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: AppNode, _allNodes: AppNode[]) => {
      setIsNodeDragging(false);
      let patchesToSync: Array<{ id: string; patch: any }> = [];
      let draggedNodePatch: any | null = null;

      flushSync(() => {
        setNodes((nds) => {
          const currentNode = nds.find((n) => n.id === node.id) ?? node;
          const draggedNode: AppNode = {
            ...currentNode,
            position: node.position,
            width: node.width ?? currentNode.width,
            height: node.height ?? currentNode.height,
          };
          (draggedNode as any).measured =
            (node as any).measured ?? (currentNode as any).measured;

          // Group ownership is based on FULL CONTAINMENT:
          // the node joins a group only when its rect is fully inside that group.
          const nodeAbsRect = getAbsoluteRect(draggedNode, nds);
          const ownership = determineGroupOwnership(
            nodeAbsRect,
            draggedNode.id,
            nds,
          );

          const nextNode: Node = {
            ...draggedNode,
            parentId: ownership.newParentId,
            position: ownership.relativePosition,
            extent: undefined,
          };

          // If a group is nested, ensure it stays above its parent.
          if (nextNode.type === "group" && ownership.newParentId) {
            const parent = nds.find((n) => n.id === ownership.newParentId);
            const parentZIndex = Number((parent?.style as any)?.zIndex ?? 0);
            nextNode.style = {
              ...nextNode.style,
              zIndex: parentZIndex + 1,
            };
          }

          let updatedNodes = nds.map((n) =>
            n.id === draggedNode.id ? nextNode : n,
          );

          // Auto-resize ancestors to fit the moved node (including nested groups).
          const scales = recursiveGroupScale(nextNode.id, updatedNodes);
          if (scales.size > 0) {
            updatedNodes = applyGroupScales(updatedNodes, scales);

            const mesh = createMesh({
              cellWidth: 50,
              cellHeight: 50,
              maxColumns: 10,
            });
            for (const groupId of scales.keys()) {
              const result = resolveCollisions(updatedNodes, groupId, mesh, {
                maxIterations: 10,
              });
              if (result.steps.length > 0) {
                updatedNodes = applyResolution(updatedNodes, result);
              }
            }
          }

          updatedNodes = applyAutoZIndex(updatedNodes);
          draggedNodePatch = {
            position: nextNode.position,
            parentId: nextNode.parentId,
            extent: nextNode.extent,
            style: nextNode.style,
          };

          patchesToSync = collectLayoutNodePatches(nds, updatedNodes).filter(
            (p) => p.id !== draggedNode.id,
          );
          return updatedNodes;
        });
      });

      if (draggedNodePatch) {
        loroSync.updateNode(node.id, draggedNodePatch);
      }
      applyLayoutPatchesToLoro(loroSync, patchesToSync);
    },
    [setNodes, loroSync, applyAutoZIndex],
  );

  const onSelectionChange = useCallback(
    ({ nodes, edges: selectedEdges }: { nodes: Node[]; edges: Edge[] }) => {
      selectedNodesRef.current = nodes;
      setSelectedNodes(nodes);
      if (
        projectSessionHydratedProjectIdRef.current === project.id &&
        !canvasSelectionRestorePendingRef.current.has(activeCanvasIdRef.current)
      ) {
        updateCanvasView(activeCanvasIdRef.current, (current) => ({
          ...current,
          selectedNodeIds: nodes.map((node) => node.id),
          selectedEdgeIds: selectedEdges.map((edge) => edge.id),
        }));
      }
      // Broadcast selection to peers via the awareness sideband. Throttled
      // inside the hook, so frequent selection-rectangle drags don't flood.
      awareness.setLocalSelection(nodes.map((n) => n.id));
    },
    [awareness, project.id, updateCanvasView],
  );

  // Show a "Group" pill when 2+ siblings are selected. We collapse selected
  // descendants into their selected ancestor (otherwise we'd nest a node and
  // its own parent), and require everything left to share a parent so the
  // new Group can sit at one well-defined level in the hierarchy.
  const selectionBounds = useMemo(() => {
    if (isNodeDragging || isMarqueeing) return null;
    if (selectedNodes.length < 2) return null;
    // Suppress while a node is being moved — bounds would lag behind the
    // drag and the pill would float over moving content.
    if (selectedNodes.some((n) => n.dragging)) return null;

    const selectedIds = new Set(selectedNodes.map((n) => n.id));
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    const topLevel = selectedNodes.filter((n) => {
      let pid = (nodesById.get(n.id) ?? n).parentId;
      while (pid) {
        if (selectedIds.has(pid)) return false;
        pid = nodesById.get(pid)?.parentId;
      }
      return true;
    });
    if (topLevel.length < 2) return null;

    const commonParent = (nodesById.get(topLevel[0].id) ?? topLevel[0])
      .parentId;
    if (
      !topLevel.every(
        (n) => (nodesById.get(n.id) ?? n).parentId === commonParent,
      )
    )
      return null;

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const sel of topLevel) {
      const node = nodesById.get(sel.id) ?? sel;
      const rect = getAbsoluteRect(node, nodes);
      if (rect.x < minX) minX = rect.x;
      if (rect.y < minY) minY = rect.y;
      if (rect.x + rect.width > maxX) maxX = rect.x + rect.width;
      if (rect.y + rect.height > maxY) maxY = rect.y + rect.height;
    }
    if (!Number.isFinite(minX)) return null;

    return {
      absMinX: minX,
      absMinY: minY,
      absMaxX: maxX,
      absMaxY: maxY,
      topLevelIds: topLevel.map((n) => n.id),
      parentId: commonParent,
    };
  }, [isNodeDragging, isMarqueeing, selectedNodes, nodes]);

  const groupSelectedNodes = useCallback(() => {
    if (!selectionBounds) return;
    const {
      absMinX,
      absMinY,
      absMaxX,
      absMaxY,
      topLevelIds,
      parentId: commonParentId,
    } = selectionBounds;
    const PADDING = 40;
    const TITLE_GAP = 32; // space above for the floating group title input

    const groupAbsX = absMinX - PADDING;
    const groupAbsY = absMinY - TITLE_GAP - PADDING;
    const groupWidth = absMaxX - absMinX + PADDING * 2;
    const groupHeight = absMaxY - absMinY + TITLE_GAP + PADDING * 2;

    // Convert the group's absolute position into the common parent's local space.
    let groupX = groupAbsX;
    let groupY = groupAbsY;
    if (commonParentId) {
      const parent = nodes.find((n) => n.id === commonParentId);
      if (parent) {
        const parentAbs = getAbsolutePosition(parent, nodes);
        groupX = groupAbsX - parentAbs.x;
        groupY = groupAbsY - parentAbs.y;
      }
    }

    // z-index: mirror the addNode('group', ...) branch so collision/depth
    // assumptions elsewhere keep holding.
    let zIndex: number | undefined;
    if (commonParentId) {
      const parent = nodes.find((n) => n.id === commonParentId);
      const parentZIndex = Number(parent?.style?.zIndex ?? 0);
      zIndex = parentZIndex + 1;
    } else {
      const groupNodes = nodes.filter((n) => n.type === "group");
      const minZIndex = groupNodes.reduce(
        (min, n) => Math.min(min, Number(n.style?.zIndex ?? 0)),
        0,
      );
      zIndex = minZIndex - 1;
    }

    const groupId = `group-${Date.now()}`;
    const newGroup: Node = {
      id: groupId,
      type: "group",
      position: { x: groupX, y: groupY },
      data: { label: "Group" },
      parentId: commonParentId,
      width: groupWidth,
      height: groupHeight,
      style: { width: groupWidth, height: groupHeight, zIndex },
      className: "group-node",
      extent: undefined,
    };

    const selectedSet = new Set(topLevelIds);
    const childUpdates: Array<{
      id: string;
      parentId: string;
      position: { x: number; y: number };
    }> = [];

    setNodes((nds) => {
      const absPos = new Map<string, { x: number; y: number }>();
      for (const id of selectedSet) {
        const n = nds.find((node) => node.id === id);
        if (n) absPos.set(id, getAbsolutePosition(n, nds));
      }

      let updated = [...nds, newGroup];
      updated = updated.map((n) => {
        if (!selectedSet.has(n.id)) return n;
        const abs = absPos.get(n.id);
        if (!abs) return n;
        const nextPos = { x: abs.x - groupAbsX, y: abs.y - groupAbsY };
        childUpdates.push({ id: n.id, parentId: groupId, position: nextPos });
        return {
          ...n,
          parentId: groupId,
          position: nextPos,
          extent: undefined,
          selected: false,
        };
      });
      updated = applyAutoZIndex(updated);
      return updated;
    });

    loroSync.addNode(groupId, newGroup);
    for (const upd of childUpdates) {
      loroSync.updateNode(upd.id, {
        parentId: upd.parentId,
        position: upd.position,
      });
    }

    // Clear local selection so the pill disappears after grouping.
    setSelectedNodes([]);
    awareness.setLocalSelection([]);
    selectedNodesRef.current = [];
  }, [selectionBounds, nodes, setNodes, loroSync, applyAutoZIndex, awareness]);

  // Auto-save logic removed: Loro is the single source of truth.

  // Suppress browser-level zoom (Cmd/Ctrl + wheel, trackpad pinch, Safari
  // gesture events) for events that fire OUTSIDE the React Flow pane. RF
  // owns wheel/pinch inside the canvas — we don't touch those — but elsewhere
  // accidental zoom rescales the whole page and the canvas content "vanishes"
  // off-screen. preventDefault on the bubble phase suppresses the browser
  // gesture without interfering with RF's own zoom handler.
  useEffect(() => {
    const isInsideCanvas = (target: EventTarget | null): boolean => {
      return target instanceof Element && !!target.closest(".react-flow");
    };
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (isInsideCanvas(e.target)) return;
      e.preventDefault();
    };
    const onGesture = (e: Event) => {
      if (isInsideCanvas(e.target)) return;
      e.preventDefault();
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("gesturestart", onGesture as EventListener, {
      passive: false,
    });
    window.addEventListener("gesturechange", onGesture as EventListener, {
      passive: false,
    });
    window.addEventListener("gestureend", onGesture as EventListener, {
      passive: false,
    });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("gesturestart", onGesture as EventListener);
      window.removeEventListener("gesturechange", onGesture as EventListener);
      window.removeEventListener("gestureend", onGesture as EventListener);
    };
  }, []);

  const generatorClient = useMemo(
    () =>
      createGeneratorClient((path, init) =>
        globalThis.fetch(runtimeApiUrl(path), {
          ...init,
          credentials: "include",
        }),
      ),
    [],
  );

  // Custom handleEdgesChange to sync edge deletions to Loro
  const handleEdgesChange = useCallback(
    (changes: import("@xyflow/react").EdgeChange[]) => {
      onEdgesChange(changes);

      // Handle edge deletions - sync to Loro
      const removeChanges = changes.filter((c) => c.type === "remove");
      if (removeChanges.length > 0) {
        removeChanges.forEach((change) => {
          if (change.type === "remove") {
            loroSync.removeEdge(change.id);
          }
        });
      }
    },
    [onEdgesChange, loroSync],
  );

  const executablePluginActions = useExecutablePluginActions();
  const customActions = executablePluginActions;

  const onConnect = useCallback(
    async (params: Connection | Edge) => {
      // Reject invalid connections (e.g. video → image-gen ActionBadge can't use video as reference image)
      const srcId = (params as Connection).source;
      const tgtId = (params as Connection).target;
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      if (srcId && tgtId) {
        const src = currentNodes.find((n) => n.id === srcId);
        const tgt = currentNodes.find((n) => n.id === tgtId);
        // GC-style protection: refs of materialized checkpoints are
        // lineage, not editable inputs. Draft-only action chains remain
        // editable.
        if (
          tgt?.type === "action-badge" &&
          actionIsCheckpointLocked({
            nodeId: tgt.id,
            nodes: currentNodes,
            edges: currentEdges,
          })
        ) {
          editorLog.warn("canvas.connection_rejected", { sourceId: srcId, targetId: tgtId, reason: "immutable_checkpoint" });
          return;
        }
        if (
          tgt?.type === "action-badge" &&
          !generationConnectionAcceptsSource({
            sourceType: src?.type,
            targetData: loroSync.doc ? projectCanvasModelGeneratorData(loroSync.doc, tgt.type, tgt.data) : tgt.data,
          })
        ) {
          editorLog.warn("canvas.connection_rejected", { sourceId: srcId, targetId: tgtId, reason: "incompatible_source", sourceType: src?.type });
          return;
        }
        if (src && tgt?.type === "action-badge" && typeof tgt.data.generatorId === "string") {
          try {
            const asset = canvasAssetRevision(src);
            const kind = referenceModality(src);
            if (!asset || !kind) throw new Error("Connect an applied Asset. Draft text can be added through the prompt editor.");
            await connectNativeModelInput({ client: generatorClient, projectId: project.id,
              generatorId: tgt.data.generatorId, canvasId: activeCanvasIdRef.current,
              actionCard: customActions.find((card) => card.id === tgt.data.actionCardId)?.generator,
              sourceNodeId: src.id, targetNodeId: tgt.id, asset, kind });
          } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
          return;
        }
      }
      const remotionTimelineUpdate =
        srcId && tgtId
          ? deriveRemotionComponentConnectionUpdate({
              sourceId: srcId,
              targetId: tgtId,
              nodes: currentNodes,
              timelines: loroSync.timelines,
            })
          : null;
      // Canonical edgeId — same shape ActionBadge.addRefNode uses.
      // Without this, drag-connect and @-mention auto-connect produce
      // two parallel edges (different ids, same source/target) and
      // the badge surfaces the same ref twice.
      const canonicalId = `${(params as Connection).source}-${(params as Connection).target}`;
      const paramsWithDefaults = {
        ...params,
        id: canonicalId,
        interactionWidth: 30,
        focusable: true,
        selectable: true,
        deletable: true,
      };
      if (currentEdges.some((edge) => edge.id === canonicalId)) return;
      const nextEdges = addEdge(paramsWithDefaults as any, currentEdges);
      const addedEdge = nextEdges.find((edge) => edge.id === canonicalId);
      if (addedEdge) {
        if (!loroSync.addEdge(addedEdge.id, addedEdge)) return;
        if (
          remotionTimelineUpdate &&
          !(await loroSync.applyTimelineState(
            remotionTimelineUpdate.timelineId,
            remotionTimelineUpdate.state,
          ))
        ) {
          loroSync.removeEdge(addedEdge.id);
          return;
        }
      }
      edgesRef.current = nextEdges;
      setEdges(nextEdges);
    },
    [setEdges, loroSync, generatorClient, project.id, customActions],
  );

  const handleGlobalHotkey = useCallback(
    (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "+" || e.key === "-" || e.key === "=")
      ) {
        e.preventDefault();
        return;
      }

      // Avoid triggering editor shortcuts while the user is typing.
      if (isEditableKeyboardTarget(e.target)) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (e.shiftKey) {
          if (loroSync.canRedo) {
            e.preventDefault();
            loroSync.redo();
          }
        } else if (loroSync.canUndo) {
          e.preventDefault();
          loroSync.undo();
        }
      }

      // Ctrl/Cmd+Shift+D: toggle debug node IDs (dev only)
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key === "D" &&
        process.env.NODE_ENV === "development"
      ) {
        e.preventDefault();
        setShowDebugIds((v) => !v);
      }

      // Del/Backspace: delete selected edges (ReactFlow's deleteKeyCode isn't firing reliably).
      // Honor the same checkpoint guard as `onBeforeDelete`.
      if (e.key === "Delete" || e.key === "Backspace") {
        const checkpointActionIds = new Set(
          nodes
            .filter(
              (n) =>
                n.type === "action-badge" &&
                actionIsCheckpointLocked({ nodeId: n.id, nodes, edges }),
            )
            .map((n) => n.id),
        );
        const selectedEdgeIds = edges
          .filter((ed) => ed.selected && !checkpointActionIds.has(ed.target))
          .map((ed) => ed.id);
        if (selectedEdgeIds.length > 0) {
          e.preventDefault();
          setEdges((eds) =>
            eds.filter((ed) => !selectedEdgeIds.includes(ed.id)),
          );
          selectedEdgeIds.forEach((eid) => loroSync.removeEdge(eid));
        }
      }

      // V: select mode, H: hand mode (Figma-style)
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (e.key === "v") selectCanvasMode("select");
        if (e.key === "h") selectCanvasMode("hand");
      }

      // Space: temporary hand mode
      if (e.key === " " && !e.repeat) {
        e.preventDefault();
        setCanvasMode((prev) => {
          canvasModeBeforeSpace.current = prev;
          return "hand";
        });
      }
    },
    [edges, loroSync, nodes, selectCanvasMode, setEdges],
  );

  const handleSpaceKeyUp = useCallback((e: KeyboardEvent) => {
    if (isEditableKeyboardTarget(e.target)) return;
    if (e.key === " ") {
      setCanvasMode(canvasModeBeforeSpace.current);
    }
  }, []);

  useHotkeys(
    "*",
    handleGlobalHotkey,
    {
      enableOnContentEditable: true,
      enableOnFormTags: true,
      keydown: true,
      keyup: false,
    },
    [handleGlobalHotkey],
  );
  useHotkeys(
    "*",
    handleSpaceKeyUp,
    {
      enableOnContentEditable: true,
      enableOnFormTags: true,
      keydown: false,
      keyup: true,
    },
    [handleSpaceKeyUp],
  );

  // Activated executable plugin Cards are the only Action catalog. Runtime registrations in
  // Project Loro belonged to the retired ClashAgent websocket protocol.
  const executablePluginViews = useExecutablePluginViews();
  const [nativeGeneratorDefinitions, setNativeGeneratorDefinitions] = useState<
    GeneratorDefinition[]
  >([]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void globalThis
      .fetch(runtimeApiUrl("/api/v1/generator-definitions"), {
        credentials: "include",
        signal: controller.signal,
      })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { definitions?: unknown };
        const parsed = GeneratorDefinitionSchema.array().safeParse(
          payload.definitions,
        );
        if (active && parsed.success)
          setNativeGeneratorDefinitions(parsed.data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      controller.abort();
    };
  }, []);
  const storyboardGenerators = useMemo(
    () => storyboardGeneratorChoices(nativeGeneratorDefinitions),
    [nativeGeneratorDefinitions],
  );


  const addNode = useCallback(
    async (type: string, extraData: any = {}) => {
      if (type === "video-editor") {
        const actionNodeId = extraData.id || `timeline-action-${Date.now()}`;
        const timelineId = extraData.timelineId || `timeline-${Date.now()}`;
        const name =
          typeof extraData.label === "string" && extraData.label.trim()
            ? extraData.label.trim()
            : "Untitled Timeline";
        const created = await loroSync.createTimelineOnCanvas({
          id: timelineId,
          name,
          state: { tracks: [] },
          actionNodeId,
          canvasId: activeCanvasIdRef.current,
          ...(extraData.position ? { position: extraData.position } : {}),
        });
        if (!created.ok) {
          window.alert(created.error);
          return "";
        }
        return actionNodeId;
      }

      if (type === "director-stage") {
        const actionNodeId =
          extraData.id || `director-stage-action-${Date.now()}`;
        const stageId = extraData.stageId || `director-stage-${Date.now()}`;
        const name =
          typeof extraData.label === "string" && extraData.label.trim()
            ? extraData.label.trim()
            : "Untitled Director Stage";
        const created = loroSync.createDirectorStageOnCanvas({
          id: stageId,
          name,
          state: createDefaultDirectorStageState(),
          actionNodeId,
          canvasId: activeCanvasIdRef.current,
          ...(extraData.position ? { position: extraData.position } : {}),
        });
        if (!created.ok) {
          window.alert(created.error);
          return "";
        }
        return actionNodeId;
      }

      let nodeType = type;
      let nodeData: any = { label: `New ${type}`, ...extraData };
      const imageModelDefaults = {
        modelId: defaultImageModel?.id ?? "nano-banana-2",
        model: defaultImageModel?.id ?? "nano-banana-2",
        modelParams: { ...(defaultImageModel?.defaultParams ?? {}) },
      };
      const videoModelDefaults = {
        modelId: defaultVideoModel?.id ?? "sora-2",
        model: defaultVideoModel?.id ?? "sora-2",
        modelParams: { ...(defaultVideoModel?.defaultParams ?? {}) },
      };
      const audioModelDefaults = {
        modelId: defaultAudioModel?.id ?? "gemini-3.1-flash-tts",
        model: defaultAudioModel?.id ?? "gemini-3.1-flash-tts",
        modelParams: { ...(defaultAudioModel?.defaultParams ?? {}) },
      };
      const textModelDefaults = {
        modelId: defaultTextModel?.id ?? "gpt-5.4",
        model: defaultTextModel?.id ?? "gpt-5.4",
        modelParams: { ...(defaultTextModel?.defaultParams ?? {}) },
      };

      if (type === "action-badge-image" || type === "image-gen") {
        nodeType = "action-badge";
        nodeData = {
          label: "Image Prompt",
          actionType: "image-gen",
          ...imageModelDefaults,
          content: "# Prompt\nEnter your prompt here...",
          ...nodeData,
        };
      } else if (type === "action-badge-video" || type === "video-gen") {
        nodeType = "action-badge";
        nodeData = {
          label: "Video Prompt",
          actionType: "video-gen",
          ...videoModelDefaults,
          content: "# Prompt\nEnter your prompt here...",
          ...nodeData,
        };
      } else if (type === "action-badge-audio" || type === "audio-gen") {
        nodeType = "action-badge";
        nodeData = {
          label: "Audio Prompt",
          actionType: "audio-gen",
          ...audioModelDefaults,
          content: "# Prompt\nEnter your prompt here...",
          ...nodeData,
        };
      } else if (type === "action-badge-text" || type === "text-gen") {
        nodeType = "action-badge";
        nodeData = {
          label: "Text Prompt",
          actionType: "text-gen",
          ...textModelDefaults,
          content: "# Prompt\nEnter your prompt here...",
          ...nodeData,
        };
      } else if (type.startsWith("action-badge-custom-")) {
        const customId = type.replace("action-badge-custom-", "");
        const def = customActions.find((a) => a.id === customId);
        nodeType = "action-badge";
        nodeData = {
          actionType: `custom:${customId}`,
          customActionId: customId,
          customActionParams: def ? customActionDefaultParams(def) : {},
          ...(def?.pluginBinding ? { pluginBinding: def.pluginBinding } : {}),
          content: "# Prompt\nEnter your prompt here...",
          ...nodeData,
          label: typeof extraData.label === "string" ? extraData.label : def?.name || "Custom Action",
        };
      } else if (type === "text") {
        nodeData = {
          label: "Text Node",
          content: "# Hello World\nDouble click to edit.",
          ...nodeData,
        };
      } else if (type === "remotion-component") {
        nodeData = {
          label: "Remotion Component",
          componentId: "Component",
          content: DEFAULT_REMOTION_COMPONENT_SOURCE,
          compositionWidth: 720,
          compositionHeight: 1280,
          fps: 30,
          durationInFrames: 120,
          ...extraData,
        };
      } else if (type === "context") {
        // Remap context creation to text node style but keep label if needed, or just treat as text
        nodeData = {
          label: "Context",
          content: "# Context\nAdd background information here...",
          ...nodeData,
        };
        // Note: We are using TextNode component for 'context' type now (via nodeTypes map),
        // so it will render as a TextNode.
      } else if (type === "video-editor") {
        nodeData = { label: "Video Editor", inputs: [], ...nodeData };
      }
      const nds = nodesRef.current;

      // If caller didn't specify a parentId, default to "current group context":
      // - Prefer the selected group (deepest if multiple)
      // - Otherwise, use the parentId of the first selected node (if any)
      let insertionParentId: string | undefined = extraData.parentId;
      const selectedNodesForInsertion = selectedNodesRef.current;
      if (!insertionParentId && selectedNodesForInsertion.length > 0) {
        const byId = new Map(nds.map((n) => [n.id, n]));
        const selectedGroups = selectedNodesForInsertion
          .map((n) => byId.get(n.id) ?? n)
          .filter((n) => n.type === "group");

        if (selectedGroups.length > 0) {
          insertionParentId = selectedGroups
            .slice()
            .sort(
              (a, b) => getNestingDepth(b.id, nds) - getNestingDepth(a.id, nds),
            )[0]?.id;
        } else {
          const first =
            byId.get(selectedNodesForInsertion[0].id) ??
            selectedNodesForInsertion[0];
          insertionParentId = first.parentId;
        }
      }
      if (insertionParentId !== extraData.parentId) {
        extraData = { ...extraData, parentId: insertionParentId };
      }

      // For group nodes, calculate z-index
      let zIndex: number | undefined = undefined;
      if (nodeType === "group") {
        if (extraData.parentId) {
          // Nested Group: Must be ABOVE parent
          const parent = nds.find((n) => n.id === extraData.parentId);
          const parentZIndex = Number(parent?.style?.zIndex ?? 0);
          zIndex = parentZIndex + 1;
        } else {
          // Root Group: Keep existing logic (behind other groups)
          const groupNodes = nds.filter((n) => n.type === "group");
          const minZIndex = groupNodes.reduce((min, n) => {
            const nodeZIndex = Number(n.style?.zIndex ?? 0);
            return Math.min(min, nodeZIndex);
          }, 0);
          zIndex = minZIndex - 1;
        }
      }

      const newNodeId = extraData.id || `${nds.length + 1}-${Date.now()}`;
      if (nds.some((node) => node.id === newNodeId)) return newNodeId;

      const nativeAction = nodeType === "action-badge" ? customActions.find((card) => card.id === nodeData.customActionId && card.generator) : undefined;
      if (nativeAction) {
        try {
          const prompt = typeof nodeData.content === "string" ? nodeData.content : "";
          await createCanvasActionDraft({
            projectId: project.id, client: generatorClient, card: nativeAction,
            params: nodeData.customActionParams ?? {}, prompt: prompt.trim() === "# Prompt\nEnter your prompt here..." ? "" : prompt,
            placement: { canvasId: activeCanvasIdRef.current, nodeId: newNodeId, label: nodeData.label,
              ...(insertionParentId ? { parentId: insertionParentId } : {}),
              ...(extraData.position ? { position: extraData.position } : {}),
            },
          });
          return newNodeId;
        } catch (error) {
          window.alert(error instanceof Error ? error.message : String(error));
          return "";
        }
      }

      if (nodeType === "action-badge" && nodeData.modelId !== "local-acp" && ["image-gen", "video-gen", "audio-gen", "model-gen", "text-gen"].includes(nodeData.actionType)) {
        try {
          const [catalog, providers] = await Promise.all([listModelCatalog(), listModelProviders()]);
          const kind = nodeData.actionType.replace(/-gen$/, "");
          const available = enabledModelCatalogEntries(catalog, providers).filter(entry => entry.model.kind === kind);
          if (!available.length) {
            setModelSettingsOpen(true);
            return "";
          }
          const model = available.find(entry => entry.model.id === extraData.modelId)?.model ?? available[0].model;
          nodeData.modelId = model.id;
          nodeData.modelParams = { ...model.defaultParams, ...(extraData.modelParams ?? {}) };
          const prompt = typeof nodeData.content === "string" ? nodeData.content : "";
          await createCanvasModelDraft({
            projectId: project.id, client: generatorClient,
            kind: nodeData.actionType.replace(/-gen$/, "") as "image" | "video" | "audio" | "model" | "text",
            modelId: nodeData.modelId, params: nodeData.modelParams ?? {},
            prompt: prompt.trim() === "# Prompt\nEnter your prompt here..." ? "" : prompt,
            placement: { canvasId: activeCanvasIdRef.current, nodeId: newNodeId,
              label: nodeData.label,
              ...(insertionParentId ? { parentId: insertionParentId } : {}),
              ...(extraData.position ? { position: extraData.position } : {}),
            },
          });
          return newNodeId;
        } catch (error) {
          window.alert(error instanceof Error ? error.message : String(error));
          return "";
        }
      }

      // 1. Determine Dimensions FIRST
      let defaultWidth: number | undefined = 300;
      let defaultHeight: number | undefined = 300;
      let layoutWidth = 300;
      let layoutHeight = 300;

      if (nodeType === "group") {
        defaultWidth = 400;
        defaultHeight = 400;
        layoutWidth = 400;
        layoutHeight = 400;
      } else if (nodeType === "text") {
        defaultWidth = 300;
        defaultHeight = 400;
        layoutWidth = 300;
        layoutHeight = 400;
      } else if (nodeType === "action-badge") {
        defaultWidth = ACTION_BADGE_NODE_SIZE.width;
        defaultHeight = ACTION_BADGE_NODE_SIZE.height;
        layoutWidth = ACTION_BADGE_NODE_SIZE.width;
        layoutHeight = ACTION_BADGE_NODE_SIZE.height;
      } else if (nodeType === "remotion-component") {
        const compositionWidth =
          typeof nodeData.compositionWidth === "number" &&
          Number.isFinite(nodeData.compositionWidth) &&
          nodeData.compositionWidth > 0
            ? nodeData.compositionWidth
            : 720;
        const compositionHeight =
          typeof nodeData.compositionHeight === "number" &&
          Number.isFinite(nodeData.compositionHeight) &&
          nodeData.compositionHeight > 0
            ? nodeData.compositionHeight
            : 1280;
        const dimensions = calculateRemotionComponentNodeDimensions(
          compositionWidth,
          compositionHeight,
        );
        defaultWidth = dimensions.width;
        defaultHeight = dimensions.height;
        layoutWidth = dimensions.width;
        layoutHeight = dimensions.height;
      } else if (nodeType === "prompt") {
        defaultWidth = 300;
        defaultHeight = 150;
        layoutWidth = 300;
        layoutHeight = 150;
      } else if (nodeType === "video-editor") {
        defaultWidth = 400;
        defaultHeight = 225;
        layoutWidth = 400;
        layoutHeight = 225;
      }
      if (nodeType === "image" || nodeType === "video") {
        defaultWidth = undefined;
        defaultHeight = undefined;
        layoutWidth = 300;
        layoutHeight = 300;
      }
      if (
        (nodeType === "image" || nodeType === "video") &&
        Number.isFinite(extraData.naturalWidth) &&
        Number.isFinite(extraData.naturalHeight)
      ) {
        const scaled = calculateScaledDimensions(
          extraData.naturalWidth,
          extraData.naturalHeight,
        );
        defaultWidth = scaled.width;
        defaultHeight = scaled.height;
        layoutWidth = scaled.width;
        layoutHeight = scaled.height;
      }
      if (Number.isFinite(extraData.width)) {
        defaultWidth = extraData.width;
        layoutWidth = extraData.width;
      }
      if (Number.isFinite(extraData.height)) {
        defaultHeight = extraData.height;
        layoutHeight = extraData.height;
      }

      // 2. Determine Position with Collision Detection
      let parentId = extraData.parentId;

      // Validate parentId exists
      if (parentId) {
        const parentExists = nds.find((n) => n.id === parentId);
        if (!parentExists) {
          editorLog.warn("canvas.parent_missing", { parentId, nodeCount: nds.length });
          parentId = undefined;
        }
      }

      const explicitPosition =
        extraData.position &&
        Number.isFinite(extraData.position.x) &&
        Number.isFinite(extraData.position.y)
          ? { x: extraData.position.x, y: extraData.position.y }
          : null;
      let targetPos = explicitPosition ?? { x: 100, y: 100 };

      // If no parentId, place below all existing root nodes
      if (!explicitPosition && !parentId && nds.length > 0) {
        let maxBottom = 0;
        let leftmostX = Infinity;

        nds.forEach((n) => {
          if (!n.parentId) {
            const h = n.height || Number(n.style?.height) || 300;
            const bottom = n.position.y + h;
            if (bottom > maxBottom) maxBottom = bottom;
            leftmostX = Math.min(leftmostX, n.position.x);
          }
        });

        if (maxBottom > 0) {
          targetPos = {
            x: Number.isFinite(leftmostX) ? leftmostX : 100,
            y: maxBottom + 50,
          };
        }
      }

      const upstreamList = Array.isArray(extraData.upstreamNodeIds)
        ? extraData.upstreamNodeIds
        : [];

      if (parentId && !explicitPosition) {
        // Start at top-left of group
        targetPos = { x: 50, y: 50 };

        // 1. Upstream Node Placement (Highest Priority)
        const primaryUpstream = upstreamList[0];
        if (primaryUpstream) {
          const upstreamNode = nds.find((n) => n.id === primaryUpstream);
          if (upstreamNode) {
            // Calculate Upstream Node's Absolute Position
            const upstreamAbsPos = getAbsolutePosition(upstreamNode, nds);
            const upstreamWidth =
              upstreamNode.width || Number(upstreamNode.style?.width) || 300;
            const upstreamHeight =
              upstreamNode.height || Number(upstreamNode.style?.height) || 300;
            const upstreamCenterY = upstreamAbsPos.y + upstreamHeight / 2;

            // Calculate Parent Group's Absolute Position
            const parentGroup = nds.find((n) => n.id === parentId);
            const parentAbsPos = parentGroup
              ? getAbsolutePosition(parentGroup, nds)
              : { x: 0, y: 0 };

            // Calculate Target Position Relative to Parent Group
            // We want the new node to be to the right of the upstream node
            const targetAbsX = upstreamAbsPos.x + upstreamWidth + 80;
            const targetAbsY = upstreamCenterY - layoutHeight / 2;

            let relativeX = targetAbsX - parentAbsPos.x;
            let relativeY = targetAbsY - parentAbsPos.y;

            // Ensure the node is at least somewhat inside the group (or will cause expansion)
            // If relativeX is negative, it means upstream is to the left of the group.
            // We should probably place it at the left edge (padding) so the group expands left?
            // Or just let it be negative and let the user/layout handle it?
            // Current resize logic only handles expansion to right/bottom.
            // So we should clamp to minimum padding if we want to avoid "jumping" or weirdness.
            // BUT, if we clamp, it might be far from upstream.
            // Let's try to place it at least at x=50 if it would be negative, to keep it inside.
            // This effectively "pulls" the node into the group.

            if (relativeX < 50) relativeX = 50;
            if (relativeY < 50) relativeY = 50;

            targetPos = {
              x: relativeX,
              y: relativeY,
            };
          }
        }
        // 2. Layout Direction (Right vs Bottom)
        else {
          const children = nds.filter((n) => n.parentId === parentId);
          if (children.length > 0) {
            if (extraData.layoutDirection === "right") {
              // Find the right-most child
              const rightMostChild = children.reduce((prev, current) => {
                return prev.position.x > current.position.x ? prev : current;
              });
              const childWidth =
                rightMostChild.width ||
                Number(rightMostChild.style?.width) ||
                layoutWidth;

              targetPos = {
                x: rightMostChild.position.x + childWidth + 50,
                y: rightMostChild.position.y, // Keep same Y level
              };
            } else {
              // Default: Vertical stacking (bottom)
              const bottomChild = children.reduce((prev, current) => {
                return prev.position.y > current.position.y ? prev : current;
              });
              const childHeight =
                bottomChild.height || Number(bottomChild.style?.height) || 200;
              targetPos = {
                x: 50,
                y: bottomChild.position.y + childHeight + 50,
              };
            }
          }
        }
      } else if (!explicitPosition) {
        // Root level placement (e.g. new groups)
        if (nodeType === "group") {
          // Place new group below existing groups
          const existingGroups = nds.filter((n) => n.type === "group");
          if (existingGroups.length > 0) {
            let maxBottom = 0;
            let leftmostX = Infinity;
            for (const g of existingGroups) {
              const h = g.height || Number(g.style?.height) || 400;
              maxBottom = Math.max(maxBottom, g.position.y + h);
              leftmostX = Math.min(leftmostX, g.position.x);
            }
            targetPos = {
              x: Number.isFinite(leftmostX) ? leftmostX : 100,
              y: maxBottom + 100,
            };
          }
        }
      }

      // Use mesh-based layout only for nodes inside groups
      // Root-level nodes use the calculated rightmost position directly
      let position = targetPos;
      const mesh = createMesh({
        cellWidth: 50,
        cellHeight: 50,
        maxColumns: 10,
      });

      if (parentId && !explicitPosition) {
        // Inside a group: use mesh for collision-free placement
        const siblingRects = nds
          .filter((n) => n.parentId === parentId && n.type !== "group")
          .map((n) => getAbsoluteRect(n, nds));
        position = mesh.findNonOverlappingPosition(
          targetPos,
          { width: layoutWidth, height: layoutHeight },
          siblingRects,
        );
      } else if (!explicitPosition) {
        // Root level: use the rightmost position directly
        // Only adjust if there's a direct overlap at the exact position
        const directRect = {
          x: targetPos.x,
          y: targetPos.y,
          width: layoutWidth,
          height: layoutHeight,
        };
        const rootNodes = nds.filter((n) => !n.parentId);
        const hasDirectOverlap = rootNodes.some((n) => {
          const nodeRect = getAbsoluteRect(n, nds);
          return rectOverlaps(directRect, nodeRect);
        });

        if (hasDirectOverlap) {
          // Shift down to avoid overlap
          position = { x: targetPos.x, y: targetPos.y + layoutHeight + 50 };
        }
      }

      const explicitStyle =
        extraData.style &&
        typeof extraData.style === "object" &&
        !Array.isArray(extraData.style)
          ? extraData.style
          : {};
      const baseStyle: Record<string, string | number | undefined> = {
        ...(explicitStyle as Record<string, string | number | undefined>),
        ...(nodeType === "group"
          ? { width: layoutWidth, height: layoutHeight, zIndex }
          : {}),
      };
      if (defaultWidth && defaultHeight) {
        baseStyle.width = defaultWidth;
        baseStyle.height = defaultHeight;
      }

      const newNode: Node = {
        id: newNodeId,
        type: nodeType,
        data: nodeData,
        position,
        parentId,
        width: defaultWidth,
        height: defaultHeight,
        // CRITICAL FIX: Do NOT set extent: 'parent'.
        // If set to 'parent', React Flow restricts the node's movement to within the parent's bounds.
        // This prevents the user from dragging the node OUT of the group to detach it.
        // We want to allow dragging out, so we leave extent undefined.
        extent: undefined,
        style: baseStyle,
        className: nodeType === "group" ? "group-node" : "",
      };

      // 3. Update nodes with Recursive Group Resizing using new layout system
      let updatedNodes = [...nds, newNode];

      // Use new recursive group scale
      const scales = recursiveGroupScale(newNode.id, updatedNodes);
      if (scales.size > 0) {
        updatedNodes = applyGroupScales(updatedNodes, scales);

        // Resolve collisions caused by scaling
        for (const groupId of scales.keys()) {
          const result = resolveCollisions(updatedNodes, groupId, mesh, {
            maxIterations: 10,
          });
          if (result.steps.length > 0) {
            updatedNodes = applyResolution(updatedNodes, result);
          }
        }
      }

      updatedNodes = applyAutoZIndex(updatedNodes);
      const finalNodes = sanitizeNodes(updatedNodes) as AppNode[];
      nodesRef.current = finalNodes;
      setNodes(finalNodes);

      // Persist derived layout updates (group resize / collision resolution)
      applyLayoutPatchesToLoro(
        loroSync,
        collectLayoutNodePatches(nds, finalNodes),
      );

      // Sync new node to Loro
      const createdNode = finalNodes.find((n) => n.id === newNodeId);
      if (createdNode) {
        loroSync.addNode(newNodeId, createdNode);
      }

      return newNodeId;
    },
    [setNodes, loroSync, applyAutoZIndex, customActions, generatorClient, project.id,
      defaultImageModel, defaultVideoModel, defaultAudioModel, defaultTextModel],
  );

  const [canvasCreateMenu, setCanvasCreateMenu] = useState<{
    anchor: { x: number; y: number };
    position: { x: number; y: number };
  } | null>(null);
  const [createdNodeTarget, setCreatedNodeTarget] = useState<AgentFollowTarget | null>(null);

  const openCreateMenuFromPane = (event: ReactMouseEvent) => {
    if (!(event.target instanceof Element) || !event.target.classList.contains("react-flow__pane")) return;
    const instance = reactFlowInstanceRef.current;
    if (!instance) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    stopFollowingAgent();
    transientUiStore.dismiss();
    setCanvasCreateMenu({
      anchor: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      position: instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    });
  };

  useEffect(() => {
    if (!createdNodeTarget) return;
    if (createdNodeTarget.canvasId !== activeCanvasId || workspaceSurface.kind !== "canvas") {
      setCreatedNodeTarget(null);
      return;
    }
    const instance = reactFlowInstanceRef.current;
    const node = nodes.find((candidate) => candidate.id === createdNodeTarget.nodeId);
    if (!instance || !node) return;
    // Offscreen nodes are virtualized. Bring the layout bounds into view so
    // ReactFlow can mount and measure the node before the final fit.
    if (!node.measured?.width || !node.measured.height) {
      const bounds = getAbsoluteRect(node, nodes);
      void instance.setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
        zoom: Math.min(instance.getZoom(), 1.2),
        duration: 0,
      });
      return;
    }
    setNodesInternal((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === node.id })));
    setEdges((current) => current.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
    void instance.fitView({ nodes: [{ id: node.id }], padding: 0.22, duration: 240, maxZoom: 1.2 });
    setCreatedNodeTarget(null);
  }, [createdNodeTarget, activeCanvasId, workspaceSurface.kind, nodes, setNodesInternal, setEdges]);

  const removeCanvasNodeFromCopilot = useCallback(
    (nodeId: string, options?: AgentMutationOptions) => {
      const currentNodes = nodesRef.current;
      if (!currentNodes.some((node) => node.id === nodeId)) return;
      if (!loroSyncRef.current.removeNode(nodeId, options)) return;

      const nextNodes = currentNodes.filter((node) => node.id !== nodeId);
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
    },
    [setNodes],
  );

  const addCanvasEdgeFromCopilot = useCallback(
    (edge: Edge | Connection, options?: AgentMutationOptions) => {
      if (!edge.source || !edge.target) return;

      const edgeId =
        "id" in edge && edge.id ? edge.id : `${edge.source}-${edge.target}`;
      const edgeWithDefaults: Edge = {
        ...edge,
        id: edgeId,
        type: "type" in edge && edge.type ? edge.type : "default",
      };
      const currentEdges = edgesRef.current;
      if (currentEdges.some((existingEdge) => existingEdge.id === edgeId))
        return;

      const nextEdges = addEdge(edgeWithDefaults, currentEdges);
      const addedEdge = nextEdges.find((candidate) => candidate.id === edgeId);
      if (
        addedEdge &&
        !loroSyncRef.current.addEdge(addedEdge.id, addedEdge, options)
      ) {
        return;
      }

      edgesRef.current = nextEdges;
      setEdges(nextEdges);
    },
    [setEdges],
  );

  const updateCanvasEdgeFromCopilot = useCallback(
    (
      edgeId: string,
      edgePatch: Record<string, unknown>,
      options?: AgentMutationOptions,
    ) => {
      const currentEdges = edgesRef.current;
      if (!currentEdges.some((edge) => edge.id === edgeId)) return;
      if (!loroSyncRef.current.updateEdge(edgeId, edgePatch, options)) return;

      const nextEdges = currentEdges.map((edge) =>
        edge.id === edgeId ? { ...edge, ...edgePatch } : edge,
      );
      edgesRef.current = nextEdges;
      setEdges(nextEdges);
    },
    [setEdges],
  );

  const removeCanvasEdgeFromCopilot = useCallback(
    (edgeId: string, options?: AgentMutationOptions) => {
      const currentEdges = edgesRef.current;
      if (!currentEdges.some((edge) => edge.id === edgeId)) return;
      if (!loroSyncRef.current.removeEdge(edgeId, options)) return;

      const nextEdges = currentEdges.filter((edge) => edge.id !== edgeId);
      edgesRef.current = nextEdges;
      setEdges(nextEdges);
    },
    [setEdges],
  );

  const applyCanvasTimelineFromCopilot = useCallback(
    async (nodeId: string, timelineDsl: unknown, options?: AgentMutationOptions) => {
      await loroSyncRef.current.applyTimelineDsl(nodeId, timelineDsl, options);
    },
    [],
  );

  const handleToolClick = async (type: string, position?: { x: number; y: number }) => {
    stopFollowingAgent();
    transientUiStore.dismiss();
    if (type === "assets" || ["image", "video", "audio"].includes(type)) {
      setAssetPickerTarget({ kind: "canvas", canvasId: activeCanvasId, position });
    } else {
      const nodeId = await addNode(type, position ? { position } : {});
      if (nodeId) setCreatedNodeTarget({ canvasId: activeCanvasId, nodeId });
    }
  };

  const dismissTransientUiOnMenuOpen = useCallback(
    (open: boolean) => {
      if (open) transientUiStore.dismiss();
    },
    [transientUiStore],
  );

  const importProjectAssetFile = useCallback(
    async (file: File): Promise<ResolvedAsset & { url: string }> => {
      const assetType = file.type.startsWith("video/")
        ? "video"
        : file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("audio/")
            ? "audio"
            : null;
      if (!assetType)
        throw new Error(
          `Unsupported project asset type: ${file.type || file.name}`,
        );

      const projectAsset = await importProjectAssetBytes(project.id, file, {
        kind: assetType,
      });
      if (!projectAsset.url) {
        throw new Error("Imported project asset is not locally available");
      }
      setLocallyAddedProjectAssets((current) => [
        projectAsset,
        ...current.filter((asset) => asset.id !== projectAsset.id),
      ]);
      return { ...projectAsset, url: projectAsset.url };
    },
    [project.id],
  );

  const publishDirectorStageOutputFile = useCallback(
    async (input: {
      stageId: string;
      sourceStageRevisionId: string;
      artifactId: string;
      kind: "image" | "video";
      file: File;
    }): Promise<ResolvedAsset> => {
      const asset = await publishDirectorStageOutputBytes({
        projectId: project.id,
        ...input,
      });
      setLocallyAddedProjectAssets((current) => [
        asset,
        ...current.filter((candidate) => candidate.id !== asset.id),
      ]);
      return asset;
    },
    [project.id],
  );

  const admitTimelineLibraryMedia = useCallback(
    async (
      input: EditorAssetInput & { catalogId: string },
    ): Promise<EditorAssetInput> => {
      if (!input.src) throw new Error("Catalog media bytes are unavailable");
      const response = await fetch(input.src);
      if (!response.ok) {
        throw new Error(
          `Could not read catalog media (HTTP ${response.status})`,
        );
      }
      const blob = await response.blob();
      const mime =
        blob.type ||
        (input.type === "audio"
          ? "audio/wav"
          : input.type === "video"
            ? "video/mp4"
            : "image/svg+xml");
      const extension = mime.includes("wav")
        ? "wav"
        : mime.includes("svg")
          ? "svg"
          : mime.includes("png")
            ? "png"
            : mime.includes("jpeg")
              ? "jpg"
              : mime.includes("webm")
                ? "webm"
                : "mp4";
      const baseName =
        (input.name || input.catalogId)
          .replace(/[^a-z0-9_-]+/gi, "-")
          .replace(/^-+|-+$/g, "") || "catalog-media";
      const projectAsset = await importProjectAssetFile(
        new File([blob], `${baseName}.${extension}`, { type: mime }),
      );
      return {
        ...input,
        id: input.catalogId,
        sourceNodeId: input.catalogId,
        projectAssetId: projectAsset.id,
        src: projectAsset.url,
        thumbnail: projectAsset.thumbnailUrl,
        width: projectAsset.metadata.width,
        height: projectAsset.metadata.height,
        duration: projectAsset.metadata.durationMs
          ? projectAsset.metadata.durationMs / 1000
          : input.duration,
      };
    },
    [importProjectAssetFile],
  );

  const openProjectAssetPicker = useCallback(() => {
    if (!assetFileInputRef.current) return;
    assetFileInputRef.current.value = "";
    assetFileInputRef.current.click();
  }, []);

  const handleProjectAssetFiles = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const files = Array.from(input.files ?? []);
      try {
        for (const file of files) await importProjectAssetFile(file);
      } catch (error) {
        editorLog.error("asset.import_failed", { projectId: project.id, error });
      } finally {
        input.value = "";
      }
    },
    [importProjectAssetFile],
  );

  const uploadFileAsAssetNode = useCallback(
    async (
      file: File,
      assetType: "image" | "video" | "audio",
    ): Promise<{
      id: string;
      type: "image" | "video" | "audio";
      assetId?: string;
      sourceNodeId?: string;
      projectAssetId?: string;
      src: string;
      name: string;
      width?: number;
      height?: number;
      duration?: number;
      createdAt: number;
    } | null> => {
      const placeholderId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const localPreviewUrl = URL.createObjectURL(file);

      // HTML probe purely to size the placeholder node. Result goes
      // straight into node.width/height (measuredSize) — no need for
      // a parallel set of data.preview* fields. The server re-probes
      // authoritatively after upload and the reconciliation effect in
      // ImageNode/VideoNode repairs any drift.
      let probedW: number | undefined;
      let probedH: number | undefined;
      if (file.type.startsWith("image/")) {
        try {
          const dims = await new Promise<{ width: number; height: number }>(
            (resolve, reject) => {
              const img = new Image();
              img.onload = () =>
                resolve({ width: img.naturalWidth, height: img.naturalHeight });
              img.onerror = reject;
              img.src = localPreviewUrl;
            },
          );
          probedW = dims.width;
          probedH = dims.height;
        } catch (err) {
          editorLog.warn("asset.image_probe_failed", { projectId: project.id, error: err });
        }
      } else if (file.type.startsWith("video/")) {
        try {
          const info = await new Promise<{ width: number; height: number }>(
            (resolve, reject) => {
              const video = document.createElement("video");
              video.preload = "metadata";
              video.onloadedmetadata = () =>
                resolve({
                  width: video.videoWidth,
                  height: video.videoHeight,
                });
              video.onerror = () =>
                reject(new Error("Failed to read video metadata"));
              video.src = localPreviewUrl;
            },
          );
          probedW = info.width;
          probedH = info.height;
        } catch (err) {
          editorLog.warn("asset.video_probe_failed", { projectId: project.id, error: err });
        }
      }

      addNode(assetType, {
        id: placeholderId,
        label: file.name,
        status: "uploading",
        createdAt: Date.now(),
      });
      // Upload previews are device-local UI only. Never write blob URLs into
      // the Project Loro replica shared with collaborators.
      setNodes((current) =>
        current.map((node) =>
          node.id === placeholderId
            ? {
                ...node,
                data: { ...node.data, previewUrl: localPreviewUrl },
              }
            : node,
        ),
      );

      // Seed the node's measuredSize with the probed dimensions so the
      // placeholder renders at the correct aspect ratio immediately.
      if (probedW && probedH) {
        const scaled = calculateScaledDimensions(probedW, probedH);
        setNodes((nds) =>
          nds.map((n) =>
            n.id === placeholderId
              ? {
                  ...n,
                  width: scaled.width,
                  height: scaled.height,
                  style: {
                    ...n.style,
                    width: scaled.width,
                    height: scaled.height,
                  },
                }
              : n,
          ),
        );
        loroSync.updateNode(placeholderId, {
          width: scaled.width,
          height: scaled.height,
        });
      }

      try {
        const importedAsset = await importProjectAssetBytes(project.id, file, {
          kind: assetType,
        });
        const assetId = importedAsset.id;
        setLocallyAddedProjectAssets((current) => [
          importedAsset,
          ...current.filter((asset) => asset.id !== importedAsset.id),
        ]);

        // The import primes the Project-scoped ResolvedAsset cache before the
        // node becomes completed. projectVisibleNodeData strips previewUrl
        // from synchronized state as soon as status leaves `uploading`.
        const completedPatch = {
          assetId,
          status: "completed" as const,
        };
        setNodes((nds) =>
          nds.map((node) =>
            node.id === placeholderId
              ? { ...node, data: { ...node.data, ...completedPatch } }
              : node,
          ),
        );
        loroSync.updateNode(placeholderId, { data: completedPatch });
        URL.revokeObjectURL(localPreviewUrl);

        // Resolve the asset row for the VideoEditor's internal Asset
        // shape (it wants a signed src / dimensions / duration).
        // Uses the same Project-scoped ResolvedAsset projection as Canvas nodes.
        const resolvedSrc = importedAsset.url ?? "";
        const width = importedAsset.metadata.width;
        const height = importedAsset.metadata.height;
        const duration =
          importedAsset.metadata.durationMs != null
            ? importedAsset.metadata.durationMs / 1000
            : undefined;
        return {
          id: placeholderId,
          type: assetType,
          assetId,
          sourceNodeId: placeholderId,
          projectAssetId: assetId,
          src: resolvedSrc,
          name: file.name,
          width,
          height,
          duration,
          createdAt: Date.now(),
        };
      } catch (err) {
        editorLog.error("asset.upload_failed", { projectId: project.id, error: err });
        setNodes((nds) =>
          nds.map((node) =>
            node.id === placeholderId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    status: "failed",
                  },
                }
              : node,
          ),
        );
        URL.revokeObjectURL(localPreviewUrl);
        loroSync.updateNode(placeholderId, {
          data: { status: "failed" },
        });
        return null;
      }
    },
    [addNode, loroSync, project.id, setNodes],
  );

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (file && pendingNodeType) {
      try {
        await uploadFileAsAssetNode(
          file,
          pendingNodeType as "image" | "video" | "audio",
        );
      } finally {
        setPendingNodeType(null);
        if (event.target) {
          event.target.value = "";
        }
      }
    }
  };

  const applyRelayout = useCallback(
    (
      currentNodes: Node[],
      currentEdges: Edge[],
      scopeParentId: string | undefined,
    ) => {
      let updated = [...currentNodes];

      // 1. Recursive group scale (ensure containers are large enough)
      const nodesToCheck = updated.filter((n) => n.parentId === scopeParentId);
      const mergedScales = new Map<string, { width: number; height: number }>();

      for (const node of nodesToCheck) {
        const scales = recursiveGroupScale(node.id, updated);
        for (const [groupId, size] of scales.entries()) {
          const prev = mergedScales.get(groupId);
          mergedScales.set(groupId, {
            width: Math.max(prev?.width ?? 0, size.width),
            height: Math.max(prev?.height ?? 0, size.height),
          });
        }
      }
      if (mergedScales.size > 0)
        updated = applyGroupScales(updated, mergedScales);

      // 2. Relayout to grid
      updated = relayoutToGrid(updated, {
        gapX: 80,
        gapY: 60,
        centerInCell: false,
        scopeParentId: scopeParentId,
        edges: currentEdges,
        compact: true,
      });

      // 3. Post-layout scale (ensure containers fit new layout)
      const postLayoutScales = new Map<
        string,
        { width: number; height: number }
      >();
      const postLayoutNodesToCheck = updated.filter(
        (n) => n.parentId === scopeParentId,
      );

      for (const node of postLayoutNodesToCheck) {
        const scales = recursiveGroupScale(node.id, updated);
        for (const [groupId, size] of scales.entries()) {
          const prev = postLayoutScales.get(groupId);
          postLayoutScales.set(groupId, {
            width: Math.max(prev?.width ?? 0, size.width),
            height: Math.max(prev?.height ?? 0, size.height),
          });
        }
      }
      if (postLayoutScales.size > 0)
        updated = applyGroupScales(updated, postLayoutScales);

      // 4. Shrink groups to fit
      updated = shrinkGroupsToFit(updated, scopeParentId, 40);

      // 5. Apply Z-Index
      updated = applyAutoZIndex(updated);

      return updated;
    },
    [],
  );

  const relayoutParent = useCallback(
    (parentId: string | undefined) => {
      const currentNodes = nodesRef.current;
      const updated = applyRelayout(currentNodes, edgesRef.current, parentId);
      const applied = applyLayoutPatchesToLoro(
        loroSync,
        collectLayoutNodePatches(currentNodes, updated),
      );
      if (!applied) {
        window.alert("Auto Layout could not be applied. The previous layout is retained. Nodes with downstream references must be copied before moving them.");
        return;
      }
      nodesRef.current = updated;
      setNodes(updated);
    },
    [setNodes, applyRelayout, loroSync],
  );

  const onLayout = useCallback(() => {
    // Global relayout = relayout root-level (parentId undefined) only.
    relayoutParent(undefined);
  }, [relayoutParent]);

  // Inverse of groupSelectedNodes: promote each direct child of the group to
  // the group's own parent (preserving absolute position), then delete the
  // group. Nested groups bubble up one level — they stay groups.
  const ungroup = useCallback(
    (groupId: string) => {
      const currentNodes = nodesRef.current;
      const group = currentNodes.find((n) => n.id === groupId);
      if (!group || group.type !== "group") return;

      const newParentId = group.parentId;
      const directChildren = currentNodes.filter((n) => n.parentId === groupId);

      const childUpdates = directChildren.map((c) => ({
        id: c.id,
        parentId: newParentId,
        position: {
          x: group.position.x + c.position.x,
          y: group.position.y + c.position.y,
        },
      }));

      let updated = currentNodes.map((n) => {
        const upd = childUpdates.find((u) => u.id === n.id);
        if (!upd) return n;
        return {
          ...n,
          parentId: newParentId,
          position: upd.position,
          extent: undefined,
        };
      });
      updated = updated.filter((n) => n.id !== groupId);
      updated = applyAutoZIndex(updated);
      nodesRef.current = updated as AppNode[];
      setNodes(updated);

      for (const upd of childUpdates) {
        loroSync.updateNode(upd.id, {
          parentId: upd.parentId,
          position: upd.position,
        });
      }
      loroSync.removeNode(groupId);
    },
    [setNodes, loroSync, applyAutoZIndex],
  );

  const layoutActions = useMemo(
    () => ({ relayoutParent, ungroup }),
    [relayoutParent, ungroup],
  );
  const allProjectAssets = useMemo(() => {
    const persistedAssets = syncedProjectAssets;
    const persistedIds = new Set(persistedAssets.map((asset) => asset.id));
    const localById = new Map(
      locallyAddedProjectAssets.map((asset) => [asset.id, asset]),
    );
    return [
      ...locallyAddedProjectAssets.filter(
        (asset) => !persistedIds.has(asset.id),
      ),
      ...persistedAssets.map((asset) => localById.get(asset.id) ?? asset),
    ];
  }, [locallyAddedProjectAssets, syncedProjectAssets]);
  const projectAssets = useMemo(
    () =>
      allProjectAssets.filter((asset) => asset.lifecycle.state === "active"),
    [allProjectAssets],
  );
  const activeGlobalProjectAssets = useMemo(
    () =>
      globalProjectAssets.filter((asset) => asset.lifecycle.state === "active"),
    [globalProjectAssets],
  );
  const projectTextAssets = useMemo<ProjectTextAsset[]>(() => {
    const byId = new Map<string, ProjectTextAsset>();
    if (loroSync.doc) {
      for (const [id, value] of loroSync.doc.getMap("nodes").entries()) {
        if (!value || typeof value !== "object") continue;
        const raw = value as {
          type?: unknown;
          canvasId?: unknown;
          data?: Record<string, unknown>;
        };
        if (raw.type !== "text" || isProjectAssetRenderNode(raw)) continue;
        const label =
          typeof raw.data?.label === "string" && raw.data.label.trim()
            ? raw.data.label.trim()
            : "Untitled text";
        byId.set(id, {
          id,
          canvasId:
            typeof raw.canvasId === "string" && raw.canvasId
              ? raw.canvasId
              : activeCanvasId,
          label,
        });
      }
    }
    for (const node of nodes) {
      if (node.type !== "text" || isProjectAssetRenderNode(node)) continue;
      byId.set(node.id, {
        id: node.id,
        canvasId: activeCanvasId,
        label: canvasFolderNodeLabel(node),
      });
    }
    return [...byId.values()].sort((left, right) =>
      left.label.localeCompare(right.label),
    );
  }, [activeCanvasId, loroSync.doc, nodes]);
  const projectPluginViews = useMemo<ProjectPluginViewRecord[]>(() => {
    if (!loroSync.doc) return [];
    return new Canvas(loroSync.doc, () => {}, DEFAULT_CANVAS_ID)
      .listNodes("plugin-view")
      .flatMap((node) => {
        const data = node.data;
        const view = data.view;
        if (!view || typeof view !== "object" || Array.isArray(view)) return [];
        const reference = view as Record<string, unknown>;
        const state = StoryboardViewStateSchema.safeParse(data.state);
        if (
          !state.success ||
          typeof reference.pluginId !== "string" ||
          typeof reference.definitionId !== "string" ||
          typeof reference.version !== "string" ||
          typeof reference.schemaHash !== "string"
        )
          return [];
        return [
          {
            nodeId: node.id,
            canvasId: DEFAULT_CANVAS_ID,
            label:
              typeof data.label === "string" && data.label.trim()
                ? data.label
                : "Untitled View",
            pluginId: reference.pluginId,
            definitionId: reference.definitionId,
            version: reference.version,
            schemaHash: reference.schemaHash,
            state: state.data,
          },
        ];
      })
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [loroSync.doc, nodes]);
  const copilotMentionSources = useMemo(() => {
    const allNodes = loroSync.doc
      ? Array.from(loroSync.doc.getMap("nodes").entries()).flatMap(
          ([id, value]) => {
            if (!value || typeof value !== "object") return [];
            if (isProjectAssetRenderNode(value)) return [];
            const raw = value as Record<string, unknown>;
            return [
              {
                id,
                type: typeof raw.type === "string" ? raw.type : "node",
                canvasId:
                  typeof raw.canvasId === "string" ? raw.canvasId : "main",
                data:
                  raw.data && typeof raw.data === "object"
                    ? (raw.data as Record<string, unknown>)
                    : {},
              },
            ];
          },
        )
      : nodes.map((node) => ({
          id: node.id,
          type: node.type,
          canvasId: activeCanvasId,
          data: node.data,
        }));
    return buildProjectMentionSources({
      activeCanvasId,
      activeSurface:
        workspaceSurface.kind === "text-asset" ||
        workspaceSurface.kind === "browser" ||
        workspaceSurface.kind === "plugin-view"
          ? {
              kind: "canvas",
              canvasId:
                workspaceSurface.kind === "text-asset" ||
                workspaceSurface.kind === "plugin-view"
                  ? workspaceSurface.canvasId
                  : activeCanvasId,
            }
          : workspaceSurface,
      canvases: loroSync.canvases,
      nodes: allNodes,
      assets: projectAssets,
      timelines: loroSync.timelines,
      directorStages: loroSync.directorStages,
    });
  }, [
    activeCanvasId,
    loroSync.canvases,
    loroSync.doc,
    loroSync.directorStages,
    loroSync.timelines,
    nodes,
    projectAssets,
    workspaceSurface,
  ]);
  const copilotWorkspaceContext = useMemo<CopilotWorkspaceContext>(() => {
    if (workspaceSurface.kind === "browser") {
      const browser = browserTabs.find(
        (candidate) => candidate.id === workspaceSurface.browserId,
      );
      return {
        projectId: project.id,
        projectName,
        activeSurface: {
          kind: "browser",
          id: workspaceSurface.browserId,
          name: browser?.title || workspaceSurface.browserId,
          browser: browserAgentContexts[workspaceSurface.browserId] ?? {
            url: browser?.url || "about:blank",
            title: browser?.title || "New Browser",
            text: "",
            interactiveElements: [],
          },
        },
      };
    }
    if (
      workspaceSurface.kind === "canvas" ||
      workspaceSurface.kind === "text-asset" ||
      workspaceSurface.kind === "plugin-view"
    ) {
      const canvasId = workspaceSurface.canvasId;
      const canvas = loroSync.canvases.find(
        (candidate) => candidate.id === canvasId,
      );
      return {
        projectId: project.id,
        projectName,
        activeSurface: {
          kind: "canvas",
          id: canvasId,
          name: canvas?.name || canvasId,
        },
      };
    }
    if (workspaceSurface.kind === "timeline") {
      const timeline = loroSync.timelines.find(
        (candidate) => candidate.id === workspaceSurface.timelineId,
      );
      return {
        projectId: project.id,
        projectName,
        activeSurface: {
          kind: "timeline",
          id: workspaceSurface.timelineId,
          name: timeline?.name || workspaceSurface.timelineId,
        },
      };
    }
    if (workspaceSurface.kind === "director-stage") {
      const stage = loroSync.directorStages.find(
        (candidate) => candidate.id === workspaceSurface.stageId,
      );
      return {
        projectId: project.id,
        projectName,
        activeSurface: {
          kind: "director-stage",
          id: workspaceSurface.stageId,
          name: stage?.name || workspaceSurface.stageId,
        },
      };
    }
    const asset = projectAssets.find(
      (candidate) => candidate.id === workspaceSurface.assetId,
    );
    return {
      projectId: project.id,
      projectName,
      activeSurface: {
        kind: "asset",
        id: workspaceSurface.assetId,
        name: asset ? projectAssetDisplayName(asset) : workspaceSurface.assetId,
      },
    };
  }, [
    browserAgentContexts,
    browserTabs,
    loroSync.canvases,
    loroSync.directorStages,
    loroSync.timelines,
    project.id,
    projectAssets,
    projectName,
    workspaceSurface,
  ]);
  const canvasFolderEntries = useMemo(
    () => buildCanvasFolderEntries(nodes, projectAssets),
    [nodes, projectAssets],
  );
  const filteredCanvasFolderEntries = useMemo(
    () => filterCanvasFolderEntries(canvasFolderEntries, canvasFolderQuery),
    [canvasFolderEntries, canvasFolderQuery],
  );
  const assetRelationGraph = useMemo(() => {
    if (!loroSync.doc) return { nodes: [], edges: [] };
    const visibleNodeEntries = Array.from(
      loroSync.doc.getMap("nodes").entries(),
    ).filter(([, value]) => !isProjectAssetRenderNode(value));
    return readAssetRelationGraph(
      visibleNodeEntries,
      loroSync.doc.getMap("edges").entries(),
    );
  }, [
    assetRelationRevision,
    edges,
    loroSync.canvases,
    loroSync.doc,
    loroSync.timelines,
    nodes,
  ]);

  useProjectAssetHydration({
    doc: loroSync.doc,
    nodes,
    projectId: project.id,
    projectAssets,
    onAssetsChange: setLocallyAddedProjectAssets,
  });
  const selectedAsset =
    workspaceSurface.kind === "asset"
      ? projectAssets.find((asset) => asset.id === workspaceSurface.assetId)
      : undefined;
  const selectedTextAsset =
    workspaceSurface.kind === "text-asset"
      ? projectTextAssets.find((asset) => asset.id === workspaceSurface.nodeId)
      : undefined;
  const selectedTextNode =
    workspaceSurface.kind === "text-asset"
      ? nodes.find((node) => node.id === workspaceSurface.nodeId)
      : undefined;
  const selectedPluginView =
    workspaceSurface.kind === "plugin-view"
      ? projectPluginViews.find(
          (view) => view.nodeId === workspaceSurface.nodeId,
        )
      : undefined;
  const previewTextNode = previewTextNodeId
    ? nodes.find((node) => node.id === previewTextNodeId)
    : undefined;
  const handleEditedAssetApplied = useCallback(
    async (result: EditApplyResult) => {
      const asset = await getAsset(project.id, result.assetId);
      if (
        asset.kind !== "image" &&
        asset.kind !== "video" &&
        asset.kind !== "audio"
      )
        return;
      const projectAsset = asset;
      setLocallyAddedProjectAssets((current) => [
        projectAsset,
        ...current.filter((candidate) => candidate.id !== projectAsset.id),
      ]);
      setWorkspaceSurface({ kind: "asset", assetId: projectAsset.id });
    },
    [project.id],
  );
  const addProjectAssetToLibrary = useCallback(
    async (assetId: string) => {
      const asset = await publishProjectAssetToPersonalLibrary(
        project.id,
        assetId,
      );
      setGlobalProjectAssets((current) => [
        asset,
        ...current.filter((candidate) => candidate.id !== asset.id),
      ]);
    },
    [project.id],
  );
  const addGlobalAssetToProject = useCallback(
    async (globalAssetId: string): Promise<string> => {
      const projectAsset = await admitPersonalGlobalAssetToProject(
        project.id,
        globalAssetId,
      );
      setLocallyAddedProjectAssets((current) => [
        projectAsset,
        ...current.filter((candidate) => candidate.id !== projectAsset.id),
      ]);
      return projectAsset.id;
    },
    [project.id],
  );
  const replaceProjectAssetProjection = useCallback((asset: ResolvedAsset) => {
    setLocallyAddedProjectAssets((current) => [
      asset,
      ...current.filter((candidate) => candidate.id !== asset.id),
    ]);
  }, []);
  const trashProjectAssetFromNavigator = useCallback(
    async (assetId: string) => {
      const asset = projectAssets.find((candidate) => candidate.id === assetId);
      if (!asset) return;
      const label = projectAssetDisplayName(asset);
      if (!window.confirm(`Move "${label}" to Trash?`)) return;
      try {
        const trashed = await trashProjectAssetThroughHost(project.id, assetId);
        replaceProjectAssetProjection(trashed);
        if (
          workspaceSurface.kind === "asset" &&
          workspaceSurface.assetId === assetId
        ) {
          setWorkspaceSurface({ kind: "canvas", canvasId: activeCanvasId });
        }
      } catch (cause) {
        window.alert(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [
      activeCanvasId,
      project.id,
      projectAssets,
      replaceProjectAssetProjection,
      workspaceSurface,
    ],
  );
  const restoreProjectAssetFromNavigator = useCallback(
    async (assetId: string) => {
      try {
        replaceProjectAssetProjection(
          await restoreProjectAssetThroughHost(project.id, assetId),
        );
      } catch (cause) {
        window.alert(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [project.id, replaceProjectAssetProjection],
  );
  const assetPickerSections = useMemo(
    () =>
      assetPickerTarget
        ? buildScopedAssetSections({
            target: assetPickerTarget,
            bindings: loroSync.doc ? listActionAssetBindings(loroSync.doc) : [],
            projectAssets,
            globalAssets: activeGlobalProjectAssets,
            nodes: assetRelationGraph.nodes,
          })
        : [],
    [
      assetPickerTarget,
      assetRelationGraph.nodes,
      activeGlobalProjectAssets,
      loroSync.doc,
      projectAssets,
    ],
  );

  const applyScopedAssetSelection = useCallback(
    async (
      option: ScopedAssetOption,
      target: AssetScopeTarget & { position?: { x: number; y: number } },
      behavior: { insertIntoTimeline?: boolean } = {},
    ): Promise<void> => {
      setAssetPickerBusy(true);
      try {
        const steps = planAssetScopeCascade({ source: option.source, target });

        const runCascade = () =>
          executeAssetScopeCascade({
            steps,
            initial: {
              assetId: option.assetId,
              sourceNodeId: option.sourceNodeId,
            },
            adapter: {
              ensureProjectReference: addGlobalAssetToProject,
              ensureCanvasPlacement: async ({ canvasId, assetId }) => {
                const existing = assetRelationGraph.nodes.find(
                  (node) =>
                    node.canvasId === canvasId &&
                    node.data?.assetId === assetId &&
                    (node.type === "image" ||
                      node.type === "video" ||
                      node.type === "audio"),
                );
                if (existing) {
                  if (target.kind === "canvas") setCreatedNodeTarget({ canvasId, nodeId: existing.id });
                  return existing.id;
                }
                const nodeId = `asset-placement-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
                const canvasNodeCount = assetRelationGraph.nodes.filter(
                  (node) => node.canvasId === canvasId,
                ).length;
                const node = {
                  id: nodeId,
                  type: option.type,
                  position: target.position ?? {
                    x: 120 + (canvasNodeCount % 5) * 36,
                    y: 120 + (canvasNodeCount % 7) * 36,
                  },
                  data: {
                    assetId,
                    label: option.name,
                    status: "completed",
                  },
                } satisfies Pick<AppNode, "id" | "type" | "position" | "data">;
                if (!loroSync.addNodeToCanvas(canvasId, nodeId, node)) {
                  throw new Error("Failed to add the asset to the Canvas");
                }
                if (canvasId === activeCanvasId) {
                  setNodes((current) =>
                    current.some((candidate) => candidate.id === nodeId)
                      ? current
                      : [...current, node as AppNode],
                  );
                }
                if (target.kind === "canvas") setCreatedNodeTarget({ canvasId, nodeId });
                return nodeId;
              },
            },
          });
        if (
          target.kind === "timeline" &&
          behavior.insertIntoTimeline !== false
        ) {
          await commitScopedTimelineAssetInsertion({
            option,
            target,
            runCascade,
            resolveProjectAsset: (projectAssetId) =>
              getAsset(project.id, projectAssetId),
            createRequestId: () =>
              `${target.timelineId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            publishRequest: setTimelineInsertRequest,
          });
        } else {
          await runCascade();
        }
        setAssetRelationRevision((revision) => revision + 1);
        setAssetPickerTarget(null);
      } finally {
        setAssetPickerBusy(false);
      }
    },
    [
      activeCanvasId,
      addGlobalAssetToProject,
      assetRelationGraph.nodes,
      loroSync,
      project.id,
      setNodes,
    ],
  );

  const uploadScopedAsset = useCallback(
    async (file: File) => {
      if (!assetPickerTarget) return;
      setAssetPickerBusy(true);
      try {
        const asset = await importProjectAssetFile(file);
        await applyScopedAssetSelection(
          {
            assetId: asset.id,
            name: asset.name || file.name,
            type: asset.kind as "image" | "video" | "audio",
            src: asset.url ?? "",
            thumbnail: asset.thumbnailUrl,
            status: asset.status,
            ...(asset.progress === undefined
              ? {}
              : { progress: asset.progress }),
            ...(asset.error === undefined ? {} : { error: asset.error }),
            source: { kind: "project", assetId: asset.id },
          },
          assetPickerTarget,
        );
      } finally {
        setAssetPickerBusy(false);
      }
    },
    [applyScopedAssetSelection, assetPickerTarget, importProjectAssetFile],
  );
  const selectedTimeline =
    workspaceSurface.kind === "timeline"
      ? loroSync.timelines.find(
          (timeline) => timeline.id === workspaceSurface.timelineId,
        )
      : undefined;
  const selectedTimelineExportProgress = useMemo(() => {
    const doc = loroSync.doc;
    if (!selectedTimeline || !doc) return [];
    return listTimelineExportProgress(doc, selectedTimeline.id).filter(
      (entry) => entry.status === "queued" || entry.status === "rendering",
    );
  }, [loroSync.doc, selectedTimeline]);
  const selectedDirectorStage =
    workspaceSurface.kind === "director-stage"
      ? loroSync.directorStages.find(
          (stage) => stage.id === workspaceSurface.stageId,
        )
      : undefined;
  const savePluginViewState = useCallback(
    (state: StoryboardViewState) => {
      if (!selectedPluginView) return;
      const parsed = StoryboardViewStateSchema.safeParse(state);
      if (!parsed.success) {
        window.alert(parsed.error.message);
        return;
      }
      if (
        !loroSync.updateNode(selectedPluginView.nodeId, { state: parsed.data })
      ) {
        window.alert(
          "The View changed elsewhere. Read it again before saving.",
        );
      }
    },
    [loroSync, selectedPluginView],
  );
  const generatePluginViewMaterial = useCallback(
    async (
      material: StoryboardViewMaterial,
      choice: StoryboardGeneratorChoice,
    ): Promise<StoryboardViewResource> => {
      const suffix =
        globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      const generatorId = `storyboard-${suffix}`;
      const candidate = await runStoryboardMaterialGenerator({
        client: generatorClient,
        projectId: project.id,
        definition: choice.definition,
        actionId: choice.actionId,
        outputSlot: choice.outputSlot,
        prompt: material.promptDraft?.text ?? "",
        ids: {
          generatorId,
          generatorRevisionId: `${generatorId}:r1`,
          actionRunId: `${generatorId}:run`,
        },
      });
      const asset = await getAsset(project.id, candidate.projectAssetId);
      setLocallyAddedProjectAssets((current) => [
        asset,
        ...current.filter((entry) => entry.id !== asset.id),
      ]);
      return candidate;
    },
    [generatorClient, project.id],
  );
  const handleTimelineAnnotationTarget = useCallback(
    (object: AgentAnnotationObjectRef) => {
      if (!selectedTimeline) return;
      const objectPath =
        object.objectType === "timeline-track"
          ? `timelines/${selectedTimeline.id}/tracks/${object.objectId}`
          : `timelines/${selectedTimeline.id}/tracks/${object.parentId ?? "unknown"}/items/${object.objectId}`;
      showAnnotationContextTarget({
        projectId: project.id,
        surface: "timeline",
        surfaceId: selectedTimeline.id,
        surfaceLabel: selectedTimeline.name,
        revisionId: selectedTimeline.revisionId,
        ...object,
        objectPath,
        capabilities: ["read", "modify"],
      });
    },
    [project.id, selectedTimeline, showAnnotationContextTarget],
  );
  const handleDirectorAnnotationTarget = useCallback(
    (object: AgentAnnotationObjectRef) => {
      if (!selectedDirectorStage) return;
      const collection =
        object.objectType === "director-scene"
          ? "scene"
          : object.objectType === "director-camera"
            ? "cameras"
            : "objects";
      const objectPath =
        collection === "scene"
          ? `director-stages/${selectedDirectorStage.id}/scene`
          : `director-stages/${selectedDirectorStage.id}/${collection}/${object.objectId}`;
      showAnnotationContextTarget({
        projectId: project.id,
        surface: "director-stage",
        surfaceId: selectedDirectorStage.id,
        surfaceLabel: selectedDirectorStage.name,
        revisionId: selectedDirectorStage.revisionId,
        ...object,
        objectPath,
        capabilities: ["read", "modify"],
      });
    },
    [project.id, selectedDirectorStage, showAnnotationContextTarget],
  );
  const activeSurfaceAnnotationTarget =
    useMemo<AgentAnnotationTarget | null>(() => {
      if (workspaceSurface.kind === "text-asset") {
        const canvas = loroSync.canvases.find(
          (candidate) => candidate.id === workspaceSurface.canvasId,
        );
        return {
          projectId: project.id,
          surface: "canvas",
          surfaceId: workspaceSurface.canvasId,
          surfaceLabel: canvas?.name ?? workspaceSurface.canvasId,
          objectId: workspaceSurface.nodeId,
          objectType: "canvas-text",
          objectLabel: selectedTextAsset?.label ?? "Untitled text",
          objectPath: `canvases/${workspaceSurface.canvasId}/nodes/${workspaceSurface.nodeId}`,
          capabilities: ["read", "modify"],
        };
      }
      if (workspaceSurface.kind === "timeline" && selectedTimeline) {
        return {
          projectId: project.id,
          surface: "timeline",
          surfaceId: selectedTimeline.id,
          surfaceLabel: selectedTimeline.name,
          revisionId: selectedTimeline.revisionId,
          objectId: selectedTimeline.id,
          objectType: "timeline",
          objectLabel: selectedTimeline.name,
          objectPath: `timelines/${selectedTimeline.id}`,
          capabilities: ["read", "modify"],
        };
      }
      if (workspaceSurface.kind === "director-stage" && selectedDirectorStage) {
        return {
          projectId: project.id,
          surface: "director-stage",
          surfaceId: selectedDirectorStage.id,
          surfaceLabel: selectedDirectorStage.name,
          revisionId: selectedDirectorStage.revisionId,
          objectId: selectedDirectorStage.id,
          objectType: "director-stage",
          objectLabel: selectedDirectorStage.name,
          objectPath: `director-stages/${selectedDirectorStage.id}`,
          capabilities: ["read", "modify"],
        };
      }
      if (workspaceSurface.kind === "canvas") {
        const activeCanvas = loroSync.canvases.find(
          (canvas) => canvas.id === activeCanvasId,
        );
        return {
          projectId: project.id,
          surface: "canvas",
          surfaceId: activeCanvasId,
          surfaceLabel: activeCanvas?.name ?? activeCanvasId,
          objectId: activeCanvasId,
          objectType: "canvas",
          objectLabel: activeCanvas?.name ?? activeCanvasId,
          objectPath: `canvases/${activeCanvasId}`,
          capabilities: ["read", "modify"],
        };
      }
      return null;
    }, [
      activeCanvasId,
      loroSync.canvases,
      project.id,
      selectedDirectorStage,
      selectedTextAsset?.label,
      selectedTimeline,
      workspaceSurface,
    ]);
  const timelineMediaInputs = useMemo(
    () =>
      selectedTimeline
        ? selectTimelineMediaInputs({
            timeline: selectedTimeline,
            assets: projectAssets,
            nodes: assetRelationGraph.nodes,
            edges: assetRelationGraph.edges,
          })
        : [],
    [
      assetRelationGraph.edges,
      assetRelationGraph.nodes,
      projectAssets,
      selectedTimeline,
      loroSync.doc,
    ],
  );
  const handleTimelineProjectAssetDrop = useCallback(
    async (projectAssetId: string) => {
      if (!selectedTimeline) return;
      const asset = await getAsset(project.id, projectAssetId);
      const assetId = asset.id;
      if (asset.kind === "model") {
        throw new Error("3D models cannot be inserted into a Timeline");
      }
      await applyScopedAssetSelection(
        {
          assetId,
          name: safeScopedAssetName(asset),
          type: asset.kind,
          src: projectAssetPlaybackUrl(asset) ?? "",
          thumbnail: asset.thumbnailUrl,
          status: asset.status,
          ...(asset.progress === undefined ? {} : { progress: asset.progress }),
          ...(asset.error === undefined ? {} : { error: asset.error }),
          source: { kind: "project", assetId },
        },
        {
          kind: "timeline",
          timelineId: selectedTimeline.id,
          owner: selectedTimeline.owner,
        },
      );
    },
    [applyScopedAssetSelection, project.id, selectedTimeline],
  );
  const handleTimelineInsertAssetRequestHandled = useCallback(
    (requestId: string) => {
      setTimelineInsertRequest((current) =>
        current?.requestId === requestId ? null : current,
      );
    },
    [],
  );

  const openTimelineFromCanvasAction = useCallback(
    (timelineId: string) => {
      if (!loroSync.timelines.some((timeline) => timeline.id === timelineId))
        return;
      stopFollowingAgent();
      void preloadTimelineEditor();
      setWorkspaceSurface({ kind: "timeline", timelineId });
    },
    [loroSync.timelines, stopFollowingAgent],
  );

  const openDirectorStageFromCanvasAction = useCallback(
    (stageId: string) => {
      if (!loroSync.directorStages.some((stage) => stage.id === stageId))
        return;
      stopFollowingAgent();
      setWorkspaceSurface({ kind: "director-stage", stageId });
    },
    [loroSync.directorStages, stopFollowingAgent],
  );

  const activateCanvasData = useCallback(
    (canvasId: string) => {
      if (activeCanvasIdRef.current !== canvasId) {
        setNodes([]);
        setEdges([]);
        setActiveCanvasId(canvasId);
      }
      if (activeCanvasIdRef.current !== canvasId) {
        canvasSelectionRestorePendingRef.current.add(canvasId);
        canvasEdgeSelectionRestorePendingRef.current.add(canvasId);
        canvasViewportRestorePendingRef.current.add(canvasId);
      }
      activeCanvasIdRef.current = canvasId;
    },
    [setEdges, setNodes],
  );

  const selectCanvas = useCallback(
    (canvasId: string) => {
      activateCanvasData(canvasId);
      workspaceSurfaceRef.current = { kind: "canvas", canvasId };
      setWorkspaceSurface({ kind: "canvas", canvasId });
    },
    [activateCanvasData],
  );

  const openPluginView = useCallback(
    (nodeId: string) => {
      if (!loroSync.doc) return;
      const node = new Canvas(
        loroSync.doc,
        () => {},
        DEFAULT_CANVAS_ID,
      ).readNode(nodeId);
      if (node?.type !== "plugin-view") return;
      stopFollowingAgent();
      setWorkspaceSurface({
        kind: "plugin-view",
        nodeId,
        canvasId: DEFAULT_CANVAS_ID,
      });
    },
    [loroSync.doc, stopFollowingAgent],
  );

  const openBrowserTab = useCallback(
    (initial?: { url?: string }, activate = true) => {
      if (activate) stopFollowingAgent();
      const id = globalThis.crypto?.randomUUID?.()
        ? `browser-${globalThis.crypto.randomUUID()}`
        : `browser-${Date.now().toString(36)}`;
      setBrowserTabs(
        (current) => openProjectBrowserTab(current, id, initial).tabs,
      );
      if (!activate) return;
      const surface: ProjectWorkspaceSurface = {
        kind: "browser",
        browserId: id,
      };
      workspaceSurfaceRef.current = surface;
      setWorkspaceSurface(surface);
    },
    [stopFollowingAgent],
  );

  const createBrowserFromNavigator = useCallback(
    () => openBrowserTab(),
    [openBrowserTab],
  );

  useEffect(() => {
    const subscribe = globalThis.__CLASH_DESKTOP__?.onProjectBrowserOpenTab;
    if (!subscribe) return;
    return subscribe(({ url, disposition }) =>
      openBrowserTab({ url }, shouldActivateProjectBrowserTab(disposition)),
    );
  }, [openBrowserTab]);

  const selectBrowserFromNavigator = useCallback(
    (browserId: string) => {
      if (!browserTabs.some((tab) => tab.id === browserId)) return;
      stopFollowingAgent();
      const surface: ProjectWorkspaceSurface = { kind: "browser", browserId };
      workspaceSurfaceRef.current = surface;
      setWorkspaceSurface(surface);
    },
    [browserTabs, stopFollowingAgent],
  );

  const updateBrowserFromSurface = useCallback(
    (
      browserId: string,
      patch: Partial<Pick<ProjectBrowserTab, "title" | "url">>,
    ) => {
      setBrowserTabs((current) =>
        updateProjectBrowserTab(current, browserId, patch),
      );
    },
    [],
  );

  const updateBrowserAgentContext = useCallback(
    (browserId: string, context: BrowserAgentContext) => {
      setBrowserAgentContexts((current) =>
        current[browserId] === context
          ? current
          : { ...current, [browserId]: context },
      );
    },
    [],
  );

  const closeBrowserFromNavigator = useCallback(
    (browserId: string) => {
      const result = closeProjectBrowserTab(browserTabs, browserId);
      setBrowserTabs(result.tabs);
      setBrowserAgentContexts((current) => {
        if (!(browserId in current)) return current;
        const next = { ...current };
        delete next[browserId];
        return next;
      });
      const surface = workspaceSurfaceRef.current;
      if (surface.kind !== "browser" || surface.browserId !== browserId) return;
      if (result.nextBrowserId) {
        const next: ProjectWorkspaceSurface = {
          kind: "browser",
          browserId: result.nextBrowserId,
        };
        workspaceSurfaceRef.current = next;
        setWorkspaceSurface(next);
        return;
      }
      selectCanvas(activeCanvasIdRef.current);
    },
    [browserTabs, selectCanvas],
  );

  useEffect(() => {
    const restored = loadProjectBrowserSession(window.localStorage, project.id);
    setBrowserTabs(restored?.tabs ?? []);
    setBrowserAgentContexts({});
    if (restored?.activeBrowserId) {
      const surface: ProjectWorkspaceSurface = {
        kind: "browser",
        browserId: restored.activeBrowserId,
      };
      workspaceSurfaceRef.current = surface;
      setWorkspaceSurface(surface);
    } else if (workspaceSurfaceRef.current.kind === "browser") {
      selectCanvas(activeCanvasIdRef.current);
    }
    setBrowserSessionHydratedProjectId(project.id);
  }, [project.id, selectCanvas]);

  useEffect(() => {
    if (browserSessionHydratedProjectId !== project.id) return;
    saveProjectBrowserSession(window.localStorage, project.id, {
      tabs: browserTabs,
      activeBrowserId:
        workspaceSurface.kind === "browser" ? workspaceSurface.browserId : null,
    });
  }, [
    browserSessionHydratedProjectId,
    browserTabs,
    project.id,
    workspaceSurface,
  ]);

  const focusPendingAssetRelationTarget = useCallback(() => {
    const target = pendingAssetRelationTargetRef.current;
    const instance = reactFlowInstanceRef.current;
    if (!target || !instance) return;
    if (activeCanvasIdRef.current !== target.canvasId) return;
    const surface = workspaceSurfaceRef.current;
    if (surface.kind !== "canvas" || surface.canvasId !== target.canvasId)
      return;
    const node = nodesRef.current.find(
      (candidate) => candidate.id === target.nodeId,
    );
    if (!node) return;
    setNodesInternal((current) =>
      current.map((candidate) => ({
        ...candidate,
        selected: candidate.id === target.nodeId,
      })),
    );
    instance.fitView({
      nodes: [node],
      padding: 0.22,
      duration: 320,
      maxZoom: 1.2,
    });
    pendingAssetRelationTargetRef.current = null;
  }, [setNodesInternal]);

  const openAssetRelationCanvas = useCallback(
    (canvasId: string, nodeId?: string) => {
      stopFollowingAgent();
      pendingAssetRelationTargetRef.current = nodeId
        ? { canvasId, nodeId }
        : null;
      selectCanvas(canvasId);
      if (nodeId) window.requestAnimationFrame(focusPendingAssetRelationTarget);
    },
    [focusPendingAssetRelationTarget, selectCanvas, stopFollowingAgent],
  );

  const openAssetRelationTimeline = useCallback(
    (timelineId: string) => {
      if (!loroSync.timelines.some((timeline) => timeline.id === timelineId))
        return;
      stopFollowingAgent();
      void preloadTimelineEditor();
      setWorkspaceSurface({ kind: "timeline", timelineId });
    },
    [loroSync.timelines, stopFollowingAgent],
  );

  const openRelatedAsset = useCallback(
    (assetId: string) => {
      const relatedAsset = projectAssets.find(
        (candidate) => candidate.id === assetId,
      );
      if (!relatedAsset) return;
      stopFollowingAgent();
      setWorkspaceSurface({ kind: "asset", assetId: relatedAsset.id });
    },
    [projectAssets, stopFollowingAgent],
  );
  const openProjectTextAsset = useCallback(
    (asset: ProjectTextAsset) => {
      stopFollowingAgent();
      setPreviewTextNodeId(null);
      activateCanvasData(asset.canvasId);
      const surface: ProjectWorkspaceSurface = {
        kind: "text-asset",
        nodeId: asset.id,
        canvasId: asset.canvasId,
      };
      workspaceSurfaceRef.current = surface;
      setWorkspaceSurface(surface);
    },
    [activateCanvasData, stopFollowingAgent],
  );
  const openCanvasTextEditor = useCallback(
    (nodeId: string) => {
      const asset = projectTextAssets.find(
        (candidate) => candidate.id === nodeId,
      ) ?? {
        id: nodeId,
        canvasId: activeCanvasIdRef.current,
        label: "Untitled text",
      };
      openProjectTextAsset(asset);
    },
    [openProjectTextAsset, projectTextAssets],
  );
  const openCanvasTextPreview = useCallback(
    (nodeId: string) => {
      if (nodesRef.current.find((node) => node.id === nodeId)?.data.documentRevision !== undefined) {
        openCanvasTextEditor(nodeId);
        return;
      }
      stopFollowingAgent();
      setPreviewTextNodeId(nodeId);
    },
    [stopFollowingAgent, openCanvasTextEditor],
  );
  const closeTextEditor = useCallback(() => {
    const surface = workspaceSurfaceRef.current;
    if (surface.kind !== "text-asset") return;
    selectCanvas(surface.canvasId);
  }, [selectCanvas]);
  const saveTextDocument = useCallback(
    (nodeId: string, next: { label: string; content: string }) => {
      const updatedNodes = nodesRef.current.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                label: next.label,
                content: next.content,
              },
            }
          : node,
      );
      nodesRef.current = updatedNodes;
      setNodesInternal(updatedNodes);
      loroSync.updateNode(nodeId, {
        data: { label: next.label, content: next.content },
      });
    },
    [loroSync, setNodesInternal],
  );

  const openCopilotClashEntity = useCallback(
    (entity: ClashProjectEntity) => {
      if (entity.kind === "canvas") {
        if (!loroSync.canvases.some((canvas) => canvas.id === entity.id))
          return;
        openAssetRelationCanvas(entity.id);
        return;
      }
      if (entity.kind === "canvas-node") {
        openAssetRelationCanvas(
          entity.canvasId ?? activeCanvasIdRef.current,
          entity.id,
        );
        return;
      }
      if (entity.kind === "timeline") {
        openAssetRelationTimeline(entity.id);
        return;
      }
      if (entity.kind === "director-stage") {
        openDirectorStageFromCanvasAction(entity.id);
        return;
      }
      openRelatedAsset(entity.id);
    },
    [
      loroSync.canvases,
      openAssetRelationCanvas,
      openAssetRelationTimeline,
      openDirectorStageFromCanvasAction,
      openRelatedAsset,
    ],
  );

  useEffect(() => {
    if (!pendingAssetRelationTargetRef.current) return;
    const frame = window.requestAnimationFrame(focusPendingAssetRelationTarget);
    const settleTimer = window.setTimeout(focusPendingAssetRelationTarget, 480);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
    };
  }, [
    activeCanvasId,
    focusPendingAssetRelationTarget,
    nodes,
    workspaceSurface,
  ]);

  const focusCanvasFolderNode = useCallback(
    (node: AppNode) => {
      stopFollowingAgent();
      setNodesInternal((current) =>
        current.map((candidate) => {
          const selected = candidate.id === node.id;
          return candidate.selected === selected
            ? candidate
            : { ...candidate, selected };
        }),
      );
      reactFlowInstanceRef.current?.fitView({
        nodes: [node],
        padding: 0.18,
        duration: 240,
        maxZoom: 1.25,
      });
    },
    [setNodesInternal, stopFollowingAgent],
  );

  const centerViewportOnAverageNodePosition = useCallback(() => {
    const instance = reactFlowInstanceRef.current;
    if (!instance) return;
    const allNodes = nodesRef.current;
    const center = averageRectCenters(
      allNodes.map((node) => getAbsoluteRect(node, allNodes)),
    );
    if (!center) return;
    stopFollowingAgent();
    transientUiStore.dismiss();
    reactFlowInstanceRef.current?.setCenter(center.x, center.y, {
      zoom: instance.getZoom(),
      duration: 240,
    });
  }, [stopFollowingAgent, transientUiStore]);

  const startMinimapResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      minimapResizeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startSize: minimapSizeRef.current,
        lastPointer: {
          x: event.clientX,
          y: event.clientY,
          time: event.timeStamp,
        },
        collapseVelocity: 0,
      };
      setMinimapCollapseVelocity(0);
      setMinimapResizing(true);
    },
    [],
  );

  const resizeMinimap = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resize = minimapResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const currentPointer = {
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
      };
      const collapseVelocity = collapseVelocityFromPointer(
        resize.lastPointer,
        currentPointer,
      );
      resize.lastPointer = currentPointer;
      resize.collapseVelocity = collapseVelocity;
      const nextSize = resizeMinimapFromTopRight(resize.startSize, {
        deltaX: event.clientX - resize.startX,
        deltaY: event.clientY - resize.startY,
      });

      if (shouldCollapseMinimap(nextSize)) {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        minimapResizeRef.current = null;
        setMinimapCollapseVelocity(collapseVelocity);
        setMinimapResizing(false);
        setMinimapCollapsed(true);
        return;
      }

      minimapSizeRef.current = nextSize;
      setMinimapSize(nextSize);
      if (isExpandedMinimapSize(nextSize)) {
        lastExpandedMinimapSizeRef.current = nextSize;
      }
    },
    [],
  );

  const finishMinimapResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resize = minimapResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      minimapResizeRef.current = null;
      setMinimapResizing(false);
      if (shouldCollapseMinimap(minimapSizeRef.current)) {
        setMinimapCollapseVelocity(resize.collapseVelocity);
        setMinimapCollapsed(true);
      }
    },
    [],
  );

  const collapseMinimap = useCallback(() => {
    if (isExpandedMinimapSize(minimapSizeRef.current)) {
      lastExpandedMinimapSizeRef.current = minimapSizeRef.current;
    }
    setMinimapCollapseVelocity(0);
    setMinimapResizing(false);
    setMinimapCollapsed(true);
  }, []);

  const expandMinimap = useCallback(() => {
    const expandedSize = lastExpandedMinimapSizeRef.current;
    minimapSizeRef.current = expandedSize;
    setMinimapSize(expandedSize);
    setMinimapCollapseVelocity(0);
    setMinimapResizing(false);
    setMinimapCollapsed(false);
  }, []);

  const focusPendingAgentTarget = useCallback(() => {
    const target = pendingAgentTargetRef.current;
    const instance = reactFlowInstanceRef.current;
    if (!target || !instance || !followingAgentRef.current) return;
    if (activeCanvasIdRef.current !== target.canvasId) return;
    const surface = workspaceSurfaceRef.current;
    if (surface.kind !== "canvas" || surface.canvasId !== target.canvasId)
      return;

    const currentNodes = nodesRef.current;
    const node = currentNodes.find(
      (candidate) => candidate.id === target.nodeId,
    );
    if (!node) return;
    const layoutRect = getAbsoluteRect(node, currentNodes);
    const internalNode = instance.getInternalNode(target.nodeId);
    const absolute = internalNode?.internals.positionAbsolute ?? {
      x: layoutRect.x,
      y: layoutRect.y,
    };
    const width = internalNode?.measured.width ?? layoutRect.width;
    const height = internalNode?.measured.height ?? layoutRect.height;
    const zoom = Math.min(Math.max(instance.getZoom(), 0.9), 1.2);
    const flowBounds = flowBoundsRef.current?.getBoundingClientRect();
    if (!flowBounds) return;
    const copilotPanel = document.querySelector<HTMLElement>(
      "#clash-copilot-panel",
    );
    const copilotBounds = copilotPanel?.getBoundingClientRect();
    const panelCoversCanvas =
      copilotPanel?.getAttribute("aria-hidden") !== "true" &&
      !!copilotBounds &&
      copilotBounds.left > flowBounds.left &&
      copilotBounds.left < flowBounds.right &&
      copilotBounds.bottom > flowBounds.top &&
      copilotBounds.top < flowBounds.bottom;
    const visibleRight = panelCoversCanvas
      ? Math.max(0, copilotBounds.left - flowBounds.left - 12)
      : flowBounds.width;
    const targetCenterX = absolute.x + width / 2;
    const targetCenterY = absolute.y + height / 2;
    instance.setViewport(
      {
        x: visibleRight / 2 - targetCenterX * zoom,
        y: flowBounds.height / 2 - targetCenterY * zoom,
        zoom,
      },
      {
        duration: 420,
      },
    );
  }, []);

  const queueAgentFollowTarget = useCallback(
    (target: AgentFollowTarget) => {
      lastAgentTargetRef.current = target;
      if (!followingAgentRef.current) return;
      pendingAgentTargetRef.current = target;
      if (activeCanvasIdRef.current !== target.canvasId) {
        selectCanvas(target.canvasId);
      } else if (
        workspaceSurfaceRef.current.kind !== "canvas" ||
        workspaceSurfaceRef.current.canvasId !== target.canvasId
      ) {
        const surface: ProjectWorkspaceSurface = {
          kind: "canvas",
          canvasId: target.canvasId,
        };
        workspaceSurfaceRef.current = surface;
        setWorkspaceSurface(surface);
      }
      window.requestAnimationFrame(focusPendingAgentTarget);
    },
    [focusPendingAgentTarget, selectCanvas],
  );
  queueAgentFollowTargetRef.current = queueAgentFollowTarget;

  /** Jumps the workspace to an annotation's object and flashes a 3s highlight. */
  const locateAgentAnnotation = useCallback(
    (annotationId: string) => {
      const annotation = pendingAgentAnnotations.find(
        (candidate) => candidate.id === annotationId,
      );
      if (!annotation) return;
      const { target } = annotation;
      stopFollowingAgent();

      if (target.surface === "canvas") {
        if (activeCanvasIdRef.current !== target.surfaceId) {
          selectCanvas(target.surfaceId);
        } else if (
          workspaceSurfaceRef.current.kind !== "canvas" ||
          workspaceSurfaceRef.current.canvasId !== target.surfaceId
        ) {
          setWorkspaceSurface({ kind: "canvas", canvasId: target.surfaceId });
        }
      } else if (target.surface === "timeline") {
        void preloadTimelineEditor();
        setWorkspaceSurface({ kind: "timeline", timelineId: target.surfaceId });
      } else if (target.surface === "asset") {
        setWorkspaceSurface({ kind: "asset", assetId: target.surfaceId });
      } else if (target.surface === "browser") {
        setBrowserTabs((current) =>
          ensureProjectBrowserTab(
            current,
            target.surfaceId,
            target.browser?.title || target.surfaceLabel,
            target.browser?.url || "about:blank",
          ),
        );
        setWorkspaceSurface({ kind: "browser", browserId: target.surfaceId });
      } else {
        setWorkspaceSurface({
          kind: "director-stage",
          stageId: target.surfaceId,
        });
      }

      const isCanvasNode =
        target.surface === "canvas" && target.objectType !== "canvas-edge";
      const isBrowserAnnotation = target.surface === "browser";
      let attemptsLeft = 16;
      let panned = false;
      let canvasCenter: Promise<unknown> | null = null;
      const attempt = () => {
        if (isCanvasNode && !panned) {
          const instance = reactFlowInstanceRef.current;
          const node = nodesRef.current.find(
            (candidate) => candidate.id === target.objectId,
          );
          if (instance && node) {
            const layoutRect = getAbsoluteRect(node, nodesRef.current);
            const internalNode = instance.getInternalNode(target.objectId);
            const absolute = internalNode?.internals.positionAbsolute ?? {
              x: layoutRect.x,
              y: layoutRect.y,
            };
            const width = internalNode?.measured.width ?? layoutRect.width;
            const height = internalNode?.measured.height ?? layoutRect.height;
            const zoom = Math.min(Math.max(instance.getZoom(), 0.9), 1.2);
            canvasCenter = instance.setCenter(
              absolute.x + width / 2,
              absolute.y + height / 2,
              { zoom, duration: 420 },
            );
            panned = true;
          }
        }
        const element = isBrowserAnnotation
          ? (Array.from(
              document.querySelectorAll<HTMLElement>(
                "[data-browser-annotation-marker]",
              ),
            ).find(
              (candidate) =>
                candidate.dataset.browserAnnotationMarker === annotationId,
            ) ?? null)
          : document.querySelector<HTMLElement>(
              annotationLocateSelector(target),
            );
        if (element && (!isCanvasNode || panned)) {
          const completedCanvasCenter = canvasCenter;
          centerAndHighlightAnnotationTarget(
            element,
            completedCanvasCenter ? () => completedCanvasCenter : undefined,
          );
          return;
        }
        if (attemptsLeft > 0) {
          attemptsLeft -= 1;
          window.setTimeout(attempt, 150);
        }
      };
      window.requestAnimationFrame(attempt);
    },
    [pendingAgentAnnotations, selectCanvas, stopFollowingAgent],
  );

  useEffect(() => {
    if (!pendingAgentTargetRef.current || !followingAgent) return;
    const frame = window.requestAnimationFrame(focusPendingAgentTarget);
    const settleTimer = window.setTimeout(focusPendingAgentTarget, 480);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
    };
  }, [
    activeCanvasId,
    focusPendingAgentTarget,
    followingAgent,
    isSidebarCollapsed,
    nodes,
    sidebarWidth,
    workspaceSurface,
  ]);

  const selectCanvasFromNavigator = useCallback(
    (canvasId: string) => {
      stopFollowingAgent();
      selectCanvas(canvasId);
    },
    [selectCanvas, stopFollowingAgent],
  );

  const createCanvasFromNavigator = useCallback(() => {
    stopFollowingAgent();
    const name = window.prompt("Canvas name")?.trim();
    if (!name) return;
    const stem =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "canvas";
    const canvasId = `${stem}-${Date.now().toString(36)}`;
    const result = loroSync.createCanvas({ id: canvasId, name });
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    selectCanvas(canvasId);
  }, [loroSync, selectCanvas, stopFollowingAgent]);

  const createPluginViewFromNavigator = useCallback(
    (definition: ExecutablePluginViewDefinition) => {
      stopFollowingAgent();
      const nodeId = `plugin-view-${Date.now().toString(36)}`;
      const result = loroSync.createPluginView({
        nodeId,
        label: definition.name,
        canvasId: DEFAULT_CANVAS_ID,
        view: {
          pluginId: definition.pluginId,
          definitionId: definition.definitionId,
          version: definition.version,
          schemaHash: definition.schemaHash,
        },
        state: definition.initialState,
      });
      if (!result.ok) {
        window.alert(result.error);
        return;
      }
      setWorkspaceSurface({
        kind: "plugin-view",
        nodeId,
        canvasId: DEFAULT_CANVAS_ID,
      });
    },
    [loroSync, stopFollowingAgent],
  );

  const deletePluginViewFromNavigator = useCallback(
    (view: ProjectPluginView) => {
      if (!window.confirm(`Delete "${view.label}"?`)) return;
      if (!loroSync.removeNode(view.nodeId)) {
        window.alert(
          "This View could not be deleted because it changed or has downstream references.",
        );
        return;
      }
      if (
        workspaceSurface.kind === "plugin-view" &&
        workspaceSurface.nodeId === view.nodeId
      ) {
        selectCanvas(DEFAULT_CANVAS_ID);
      }
    },
    [loroSync, selectCanvas, workspaceSurface],
  );

  const renameCanvasFromNavigator = useCallback(
    (canvas: ProjectCanvas) => {
      const name = window.prompt("Canvas name", canvas.name)?.trim();
      if (!name || name === canvas.name) return;
      const result = loroSync.renameCanvas(canvas.id, name);
      if (!result.ok) window.alert(result.error);
    },
    [loroSync],
  );

  const deleteCanvasFromNavigator = useCallback(
    (canvas: ProjectCanvas) => {
      stopFollowingAgent();
      if (!window.confirm(`Delete Canvas "${canvas.name}"?`)) return;
      const fallback = loroSync.canvases.find(
        (candidate) => candidate.id !== canvas.id,
      );
      const result = loroSync.deleteCanvas(canvas.id);
      if (!result.ok) {
        window.alert(result.error);
        return;
      }
      if (activeCanvasId === canvas.id && fallback) selectCanvas(fallback.id);
    },
    [activeCanvasId, loroSync, selectCanvas, stopFollowingAgent],
  );

  const createTimelineFromNavigator = useCallback(async () => {
    stopFollowingAgent();
    const name = window.prompt("Timeline name")?.trim();
    if (!name) return;
    const timelineId = `timeline-${Date.now().toString(36)}`;
    const result = await loroSync.createTimelineOnCanvas({
      id: timelineId,
      actionNodeId: `timeline-action-${Date.now().toString(36)}`,
      canvasId: DEFAULT_CANVAS_ID,
      name,
      state: { tracks: [] },
    });
    if (!result.ok) {
      window.alert(result.error);
      return;
    }

    void preloadTimelineEditor();
    setWorkspaceSurface({ kind: "timeline", timelineId });
  }, [loroSync, stopFollowingAgent]);

  const attachTimelineFromNavigator = useCallback(
    async (timeline: ProjectTimeline) => {
      stopFollowingAgent();
      const actionNodeId = `timeline-action-${Date.now().toString(36)}`;
      const result = await loroSync.attachTimeline({
        timelineId: timeline.id,
        actionNodeId,
      });
      if (!result.ok) {
        window.alert(result.error);
        return;
      }
      setWorkspaceSurface({ kind: "canvas", canvasId: activeCanvasId });
    },
    [activeCanvasId, loroSync, stopFollowingAgent],
  );

  const deleteTimelineFromNavigator = useCallback(
    async (timeline: ProjectTimeline) => {
      stopFollowingAgent();
      if (!window.confirm(`Delete Timeline "${timeline.name}"?`)) return;
      const fallback = loroSync.timelines.find(
        (candidate) => candidate.id !== timeline.id,
      );
      const result = await loroSync.deleteTimeline(
        timeline.id,
        projectTimelineReadToken(timeline),
      );
      if (!result.ok) {
        window.alert(result.error);
        return;
      }
      if (
        workspaceSurface.kind === "timeline" &&
        workspaceSurface.timelineId === timeline.id
      ) {
        setWorkspaceSurface(
          fallback
            ? { kind: "timeline", timelineId: fallback.id }
            : { kind: "canvas", canvasId: activeCanvasId },
        );
      }
    },
    [activeCanvasId, loroSync, stopFollowingAgent, workspaceSurface],
  );

  const saveTimelineFromNavigator = useCallback(
    (timelineId: string, state: unknown, expectedReadToken: string) =>
      loroSync.applyTimelineState(timelineId, state, {
        actorClientType: "desktop",
        ifMatch: expectedReadToken,
      }),
    [loroSync.applyTimelineState],
  );

  const exportTimelineFromNavigator = useCallback(
    async (timelineId: string) => {
      const result = await loroSync.requestTimelineRender(timelineId, {
        actorUserId: timelineExportActorUserId,
      });
      if (!result.ok) throw new Error(result.error);
    },
    [loroSync.requestTimelineRender, timelineExportActorUserId],
  );

  const createDirectorStageFromNavigator = useCallback(() => {
    stopFollowingAgent();
    const name = window.prompt("Director Stage name")?.trim();
    if (!name) return;
    const stageId = `director-stage-${Date.now().toString(36)}`;
    const result = loroSync.createDirectorStageOnCanvas({
      id: stageId,
      actionNodeId: `director-stage-action-${Date.now().toString(36)}`,
      canvasId: DEFAULT_CANVAS_ID,
      name,
      state: createDefaultDirectorStageState(),
    });
    if (!result.ok) {
      window.alert(result.error);
      return;
    }

    setWorkspaceSurface({ kind: "director-stage", stageId });
  }, [loroSync, stopFollowingAgent]);

  const attachDirectorStageFromNavigator = useCallback(
    (stage: ProjectDirectorStage) => {
      stopFollowingAgent();
      const actionNodeId = `director-stage-action-${Date.now().toString(36)}`;
      const result = loroSync.attachDirectorStage({
        stageId: stage.id,
        actionNodeId,
      });
      if (!result.ok) {
        window.alert(result.error);
        return;
      }
      setWorkspaceSurface({ kind: "canvas", canvasId: activeCanvasId });
    },
    [activeCanvasId, loroSync, stopFollowingAgent],
  );

  const saveDirectorStage = useCallback(
    (stageId: string, state: unknown) =>
      loroSync.applyDirectorStageState(stageId, state),
    [loroSync.applyDirectorStageState],
  );

  const captureDirectorStageShot = useCallback(
    async (input: DirectorStageCaptureInput) => {
      const stage = loroSync.directorStages.find(
        (candidate) => candidate.id === input.stageId,
      );
      if (!stage) throw new Error(`Director Stage ${input.stageId} not found`);
      const captureRevisionId = projectDirectorStageRevisionId(
        input.stageId,
        input.state,
      );
      const file = new File(
        [input.blob],
        `${stage.name.replace(/[^a-zA-Z0-9_-]+/g, "-") || "director-stage"}-${Date.now()}.png`,
        { type: "image/png" },
      );
      const artifactId = `shot-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      const asset = await publishDirectorStageOutputFile({
        stageId: input.stageId,
        sourceStageRevisionId: captureRevisionId,
        artifactId,
        kind: "image",
        file,
      });
      const assetId = asset.id;
      const sequenceShot = input.state.shotSequence?.find(
        (shot) =>
          input.timeSeconds >= shot.startTime &&
          input.timeSeconds < shot.startTime + shot.durationSeconds,
      );

      const targetCanvasId =
        stage.owner.kind === "canvas-action"
          ? stage.owner.canvasId
          : activeCanvasId;
      const sourceNodeId =
        stage.owner.kind === "canvas-action"
          ? stage.owner.actionNodeId
          : undefined;
      const rawSourceNode = sourceNodeId
        ? (loroSync.doc?.getMap("nodes").get(sourceNodeId) as
            | {
                position?: { x?: number; y?: number };
              }
            | undefined)
        : undefined;
      const imageNodeId = `director-shot-image-${Date.now().toString(36)}`;
      const shotNodeSize = calculateDimensionsFromAspectRatio(
        input.aspectRatio,
      );
      const imageNode = {
        id: imageNodeId,
        type: "image",
        position: {
          x:
            Number(rawSourceNode?.position?.x ?? 100) +
            (sourceNodeId ? 460 : 0),
          y: Number(rawSourceNode?.position?.y ?? 100),
        },
        width: shotNodeSize.width,
        height: shotNodeSize.height,
        style: {
          width: shotNodeSize.width,
          height: shotNodeSize.height,
        },
        data: {
          label: sequenceShot
            ? `${stage.name} · ${sequenceShot.name}`
            : `${stage.name} · ${input.timeSeconds.toFixed(2)}s`,
          assetId,
          status: "completed",
          aspectRatio: input.aspectRatio,
          sourceDirectorStageId: input.stageId,
          sourceDirectorStageRevisionId: captureRevisionId,
          sourceDirectorStageTimeSeconds: input.timeSeconds,
          sourceDirectorStageCameraId: input.cameraId,
          ...(sequenceShot
            ? { sourceDirectorStageShotId: sequenceShot.id }
            : {}),
        },
      } satisfies Pick<
        AppNode,
        "id" | "type" | "position" | "width" | "height" | "style" | "data"
      >;
      if (!loroSync.addNodeToCanvas(targetCanvasId, imageNodeId, imageNode)) {
        throw new Error("Failed to send the Director Stage shot to the Canvas");
      }
      if (targetCanvasId === activeCanvasId) {
        setNodes((current) =>
          current.some((node) => node.id === imageNodeId)
            ? current
            : [...current, imageNode as AppNode],
        );
      }
      if (sourceNodeId) {
        const edgeId = `${sourceNodeId}-${imageNodeId}`;
        const edge = {
          id: edgeId,
          source: sourceNodeId,
          target: imageNodeId,
          type: "default",
          canvasId: targetCanvasId,
        };
        if (!loroSync.addEdge(edgeId, edge)) {
          throw new Error("Failed to connect the Director Stage shot lineage");
        }
        if (targetCanvasId === activeCanvasId) {
          setEdges((current) =>
            current.some((candidate) => candidate.id === edgeId)
              ? current
              : [...current, edge],
          );
        }
      }
    },
    [
      activeCanvasId,
      loroSync,
      publishDirectorStageOutputFile,
      setEdges,
      setNodes,
    ],
  );

  const exportDirectorStageVideo = useCallback(
    async (input: DirectorStageVideoExportInput) => {
      const stage = loroSync.directorStages.find(
        (candidate) => candidate.id === input.stageId,
      );
      if (!stage) throw new Error(`Director Stage ${input.stageId} not found`);
      const safeStage =
        stage.name.replace(/[^a-zA-Z0-9_-]+/g, "-") || "director-stage";
      const stageRevisionId = projectDirectorStageRevisionId(
        input.stageId,
        input.state,
      );
      const outputBatchId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      const renderedAssets: Array<{
        render: DirectorStageVideoExportInput["renders"][number];
        camera: DirectorStageVideoExportInput["state"]["cameras"][number];
        assetId: string;
        referenceStills: Array<{
          assetId: string;
          cameraId: string;
          shotId: string;
          aspectRatio: DirectorStageVideoExportInput["renders"][number]["aspectRatio"];
          stageRevisionId: string;
          timeSeconds: number;
        }>;
      }> = [];

      for (const [renderIndex, render] of input.renders.entries()) {
        const camera = input.state.cameras.find(
          (candidate) => candidate.id === render.cameraId,
        );
        if (!camera) {
          throw new Error(`Director camera ${render.cameraId} not found`);
        }
        const safeCamera =
          camera.name.replace(/[^a-zA-Z0-9_-]+/g, "-") || "camera";
        const videoFile = new File(
          [render.blob],
          `${safeStage}-${safeCamera}-${Date.now()}-${renderIndex + 1}.webm`,
          { type: render.blob.type || "video/webm" },
        );
        const asset = await publishDirectorStageOutputFile({
          stageId: input.stageId,
          sourceStageRevisionId: stageRevisionId,
          artifactId: `video-${outputBatchId}-${renderIndex + 1}`,
          kind: "video",
          file: videoFile,
        });
        const referenceStills: Array<{
          assetId: string;
          cameraId: string;
          shotId: string;
          aspectRatio: typeof render.aspectRatio;
          stageRevisionId: string;
          timeSeconds: number;
        }> = [];

        for (const [
          frameIndex,
          referenceFrame,
        ] of render.referenceFrames.entries()) {
          const referenceFile = new File(
            [referenceFrame.blob],
            `${safeStage}-${render.shotId ?? "sequence"}-reference-${String(frameIndex + 1).padStart(2, "0")}.png`,
            { type: referenceFrame.blob.type || "image/png" },
          );
          const referenceAsset = await publishDirectorStageOutputFile({
            stageId: input.stageId,
            sourceStageRevisionId: stageRevisionId,
            artifactId: `video-${outputBatchId}-${renderIndex + 1}-reference-${frameIndex + 1}`,
            kind: "image",
            file: referenceFile,
          });
          referenceStills.push({
            assetId: referenceAsset.id,
            cameraId: referenceFrame.cameraId,
            shotId: referenceFrame.shotId,
            aspectRatio: referenceFrame.aspectRatio,
            stageRevisionId,
            timeSeconds: referenceFrame.timeSeconds,
          });
        }
        renderedAssets.push({
          render,
          camera,
          assetId: asset.id,
          referenceStills,
        });
      }

      const directorShotReferencePackets = renderedAssets.map(
        ({ render, assetId, referenceStills }) =>
          createDirectorReferencePacket({
            stageId: input.stageId,
            stageRevisionId,
            state: input.state,
            exportedAt: new Date().toISOString(),
            aspectRatio: render.aspectRatio,
            durationSeconds: render.durationSeconds,
            fps: input.fps,
            ...(render.shotId
              ? {
                  selectedShotIds: [render.shotId],
                  normalizeShotTimes: true,
                }
              : {}),
            referenceVideo: {
              assetId,
              mimeType: render.blob.type || "video/webm",
            },
            referenceStills,
          }),
      );
      const directorReferencePacket = directorShotReferencePackets[0];
      if (!directorReferencePacket) {
        throw new Error("Director export returned no reference videos");
      }

      if (stage.owner.kind === "canvas-action") {
        const owner = stage.owner;
        const rawSourceNode = loroSync.doc
          ?.getMap("nodes")
          .get(owner.actionNodeId) as
          | {
              position?: { x?: number; y?: number };
            }
          | undefined;
        const downstreamGeneratorEdges = edgesRef.current.filter((edge) => {
          if (edge.source !== owner.actionNodeId) return false;
          const target = nodesRef.current.find(
            (candidate) => candidate.id === edge.target,
          );
          return (
            target?.type === "action-badge" &&
            target.data.actionType === "video-gen"
          );
        });
        const outputNodes = renderedAssets.map(
          ({ render, camera, assetId }, index) => {
            const nodeId = `director-video-output-${outputBatchId}-${index + 1}`;
            const packet = directorShotReferencePackets[index]!;
            const outputSize = calculateDimensionsFromAspectRatio(
              render.aspectRatio,
            );
            return {
              id: nodeId,
              type: "video",
              position: {
                x: Number(rawSourceNode?.position?.x ?? 100) + 460,
                y:
                  Number(rawSourceNode?.position?.y ?? 100) +
                  index * (outputSize.height + 40),
              },
              width: outputSize.width,
              height: outputSize.height,
              style: {
                width: outputSize.width,
                height: outputSize.height,
              },
              data: {
                label:
                  packet.shotSpec.shots[0]?.name ??
                  `${stage.name} · ${camera.name}`,
                assetId,
                status: "completed",
                aspectRatio: render.aspectRatio,
                durationSeconds: render.durationSeconds,
                fps: input.fps,
                sourceDirectorStageId: input.stageId,
                sourceDirectorStageRevisionId: stageRevisionId,
                sourceDirectorStageCameraId: render.cameraId,
                ...(render.shotId
                  ? { sourceDirectorStageShotId: render.shotId }
                  : {}),
                directorReferencePacket: packet,
              },
            } satisfies Pick<
              AppNode,
              "id" | "type" | "position" | "width" | "height" | "style" | "data"
            >;
          },
        );

        const lineageEdges = outputNodes.map((outputNode) => ({
          id: `${owner.actionNodeId}-${outputNode.id}`,
          source: owner.actionNodeId,
          target: outputNode.id,
          type: "default",
          canvasId: owner.canvasId,
        }));
        for (const outputNode of outputNodes) {
          if (
            !loroSync.addNodeToCanvas(owner.canvasId, outputNode.id, outputNode)
          ) {
            throw new Error("Failed to publish a Director video output node");
          }
        }
        for (const edge of lineageEdges) {
          if (!loroSync.addEdge(edge.id, edge)) {
            throw new Error("Failed to connect Director output lineage");
          }
        }

        const addedConsumerEdges: Edge[] = [];
        const primaryOutput = outputNodes[0]!;
        for (const edge of downstreamGeneratorEdges) {
          if (!loroSync.updateEdge(edge.id, { source: primaryOutput.id })) {
            throw new Error(
              `Failed to rewire downstream Video Gen edge ${edge.id}`,
            );
          }
          for (const outputNode of outputNodes.slice(1)) {
            const addedEdge = {
              ...edge,
              id: `${edge.id}-${outputNode.id}`,
              source: outputNode.id,
              canvasId: owner.canvasId,
            };
            if (!loroSync.addEdge(addedEdge.id, addedEdge)) {
              throw new Error(
                `Failed to connect Director output ${outputNode.id}`,
              );
            }
            addedConsumerEdges.push(addedEdge);
          }
        }

        if (owner.canvasId === activeCanvasId) {
          setNodes((current) => [
            ...current,
            ...outputNodes.filter(
              (outputNode) =>
                !current.some((node) => node.id === outputNode.id),
            ),
          ]);
          setEdges((current) => [
            ...current.map((edge) => {
              const rewired = downstreamGeneratorEdges.find(
                (candidate) => candidate.id === edge.id,
              );
              return rewired ? { ...edge, source: primaryOutput.id } : edge;
            }),
            ...lineageEdges.filter(
              (edge) => !current.some((candidate) => candidate.id === edge.id),
            ),
            ...addedConsumerEdges,
          ]);
        }

        if (input.mode === "selected-shots") {
          const downstreamGeneratorIds = [
            ...new Set(downstreamGeneratorEdges.map((edge) => edge.target)),
          ];
          for (const nodeId of downstreamGeneratorIds) {
            if (
              !loroSync.updateNode(nodeId, {
                data: { autoRun: true },
              })
            ) {
              throw new Error(
                `Failed to run downstream Video Gen node ${nodeId}`,
              );
            }
          }
          setNodes((current) =>
            current.map((node) =>
              downstreamGeneratorIds.includes(node.id)
                ? {
                    ...node,
                    data: {
                      ...node.data,
                      autoRun: true,
                    },
                  }
                : node,
            ),
          );
          return;
        }
      }

      const preview = renderedAssets[0]!;
      const desktop = globalThis.__CLASH_DESKTOP__;
      if (desktop?.exportDirectorVideo) {
        await desktop.exportDirectorVideo({
          stageName: stage.name,
          cameraName: preview.camera.name,
          bytes: await preview.render.blob.arrayBuffer(),
          aspectRatio: preview.render.aspectRatio,
          durationSeconds: preview.render.durationSeconds,
          fps: input.fps,
        });
        return;
      }

      const url = URL.createObjectURL(preview.render.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${safeStage}-sequence-preview.webm`;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    [
      activeCanvasId,
      loroSync,
      publishDirectorStageOutputFile,
      setEdges,
      setNodes,
    ],
  );

  const directorPanoramaOptions = useMemo(
    () =>
      projectAssets
        .filter((asset) => asset.kind === "image" && Boolean(asset.url))
        .map((asset) => ({
          assetId: asset.id,
          label: projectAssetDisplayName(asset),
          url: asset.url!,
        })),
    [projectAssets],
  );

  const uploadDirectorPanorama = useCallback(
    async (file: File) => {
      const normalizedFile = await normalizeDirectorPanorama(file, file.name);
      const asset = await importProjectAssetFile(normalizedFile);
      return {
        assetId: asset.id,
        label: projectAssetDisplayName(asset),
        url: asset.url ?? "",
      };
    },
    [importProjectAssetFile],
  );

  const generateDirectorPanorama = useCallback(
    async (input: DirectorStagePanoramaGenerationInput) => {
      const stage = selectedDirectorStage;
      if (!stage) throw new Error("Director Stage is no longer open");
      const calibrationReference = input.calibrationGrid
        ? await createDirectorPanoramaReferenceFile(input.calibration)
        : undefined;
      const calibrationReferenceAsset = calibrationReference
        ? await importProjectAssetFile(calibrationReference.file)
        : undefined;
      const referenceImageAssetIds = calibrationReferenceAsset
        ? [calibrationReferenceAsset.id]
        : input.referenceAssetId
          ? [input.referenceAssetId]
          : [];

      const targetCanvasId =
        stage.owner.kind === "canvas-action"
          ? stage.owner.canvasId
          : activeCanvasId;
      const sourceNodeId =
        stage.owner.kind === "canvas-action"
          ? stage.owner.actionNodeId
          : undefined;
      const rawSourceNode = sourceNodeId
        ? (loroSync.doc?.getMap("nodes").get(sourceNodeId) as
            | {
                position?: { x?: number; y?: number };
              }
            | undefined)
        : undefined;
      const nodeId = `director-panorama-${Date.now().toString(36)}`;
      const modelId = directorPanoramaModel?.id ?? "gpt-image-2";
      const brief =
        input.prompt
          .split(/\n/)
          .find((line) => line.trim())
          ?.trim() ?? "Director panorama";
      const imageNode = {
        id: nodeId,
        type: "image",
        position: {
          x:
            Number(rawSourceNode?.position?.x ?? 100) +
            (sourceNodeId ? 460 : 0),
          y: Number(rawSourceNode?.position?.y ?? 100) + 220,
        },
        data: {
          label: `${stage.name} · AI panorama`,
          status: "pending",
          actionType: "image-gen",
          prompt: input.prompt,
          modelId,
          model: modelId,
          modelParams: {
            ...(directorPanoramaModel?.defaultParams ?? {}),
            // A 360x180 degree equirectangular panorama is exactly 2:1, and the
            // model card declares that ratio, so the request names the ratio and a
            // resolution tier instead of hardcoding pixel dimensions. The tier
            // resolves to 2048x1024, which is what the client normalizes to.
            aspect_ratio: "2:1",
            resolution: "2K",
            quality: "high",
            output_format: "webp",
            count: 1,
            require_real_provider: true,
          },
          aspectRatio: "2:1",
          referenceImageAssetIds,
          actorType: "user",
          actorUserId: project.ownerId,
          sourceDirectorStageId: stage.id,
          sourceDirectorStageRevisionId: stage.revisionId,
          panoramaProjection: "equirectangular",
          panoramaTargetAspectRatio: "2:1",
          panoramaReferenceWidth: 2048,
          panoramaReferenceHeight: 1024,
          panoramaCalibration: input.calibration,
          panoramaOutputFormat: "image/webp",
        },
      } satisfies Pick<AppNode, "id" | "type" | "position" | "data">;

      if (!loroSync.addNodeToCanvas(targetCanvasId, nodeId, imageNode)) {
        throw new Error("Failed to create the AI panorama generation node");
      }
      if (targetCanvasId === activeCanvasId) {
        setNodes((current) =>
          current.some((node) => node.id === nodeId)
            ? current
            : [...current, imageNode as AppNode],
        );
      }
      if (sourceNodeId) {
        const edgeId = `${sourceNodeId}-${nodeId}`;
        const edge = {
          id: edgeId,
          source: sourceNodeId,
          target: nodeId,
          type: "default",
          canvasId: targetCanvasId,
        };
        if (!loroSync.addEdge(edgeId, edge)) {
          throw new Error("Failed to connect the AI panorama lineage");
        }
        if (targetCanvasId === activeCanvasId) {
          setEdges((current) =>
            current.some((candidate) => candidate.id === edgeId)
              ? current
              : [...current, edge],
          );
        }
      }

      const deadline = Date.now() + 4 * 60 * 1000;
      let generatedAssetId: string | undefined;
      while (Date.now() < deadline) {
        const rawNode = loroSync.doc?.getMap("nodes").get(nodeId) as
          | {
              data?: Record<string, unknown>;
            }
          | undefined;
        const data = rawNode?.data;
        if (data?.status === "failed") {
          const message =
            typeof data.error === "string"
              ? data.error
              : typeof data.errorMessage === "string"
                ? data.errorMessage
                : "Image provider failed to generate the panorama";
          throw new Error(message);
        }
        if (data?.status === "completed" && typeof data.assetId === "string") {
          generatedAssetId = data.assetId;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (!generatedAssetId) {
        throw new Error("AI panorama generation timed out");
      }

      const generatedAsset = await getAsset(project.id, generatedAssetId);
      if (!generatedAsset.url)
        throw new Error("Generated panorama is not locally available");
      const normalizedFile = await normalizeDirectorPanorama(
        generatedAsset.url,
        brief,
      );
      const panoramaAsset = await importProjectAssetFile(normalizedFile);
      const panoramaAssetId = panoramaAsset.id;
      const completedData = {
        assetId: panoramaAssetId,
        status: "completed",
        sourceGeneratedAssetId: generatedAssetId,
        panoramaProjection: "equirectangular",
        panoramaAspectRatio: "2:1",
        panoramaWidth: 2048,
        panoramaHeight: 1024,
        panoramaCalibration: input.calibration,
      };
      if (!loroSync.updateNode(nodeId, { data: completedData })) {
        throw new Error("Failed to register the normalized panorama output");
      }
      if (targetCanvasId === activeCanvasId) {
        setNodes((current) =>
          current.map((node) =>
            node.id === nodeId
              ? { ...node, data: { ...(node.data ?? {}), ...completedData } }
              : node,
          ),
        );
      }

      return {
        assetId: panoramaAssetId,
        label: projectAssetDisplayName(panoramaAsset),
        url: panoramaAsset.url,
        calibration: input.calibration,
      };
    },
    [
      activeCanvasId,
      importProjectAssetFile,
      loroSync,
      project.ownerId,
      selectedDirectorStage,
      setEdges,
      setNodes,
    ],
  );

  const uploadDirectorModel = useCallback(
    async (file: File) => {
      if (!/\.(?:glb|gltf)$/i.test(file.name)) {
        throw new Error("Director Stage models must be .glb or .gltf files");
      }
      const animationMetadataPromise = inspectDirectorModelFile(file).catch(
        (error) => {
          editorLog.warn("director.model_inspect_failed", { projectId: project.id, error });
          return undefined;
        },
      );
      const registered = await importProjectAssetBytes(project.id, file, {
        kind: "model",
      });
      const id = registered.id;
      if (!registered.url)
        throw new Error("Registered 3D model is not locally available");
      const sourceUrl = registered.url;
      const animationMetadata = await animationMetadataPromise;
      return {
        assetId: id,
        name: file.name,
        sourceUrl,
        animation: animationMetadata,
      };
    },
    [project.id],
  );

  const generateDirectorModel = useCallback(
    async (input: DirectorStageModelGenerationInput) => {
      type DirectorGenerationResponse = {
        status?: "queued" | "running" | "completed" | "failed";
        actionRunId?: string;
        statusUrl?: string;
        retryAfterMs?: number;
        asset?: ResolvedAsset;
        provider?: string;
        modelEndpoint?: string;
        requestId?: string;
        thumbnailUrl?: string;
        error?: string;
      };
      const parseResponse = async (
        response: Response,
      ): Promise<DirectorGenerationResponse> => {
        const text = await response.text();
        let result: DirectorGenerationResponse;
        try {
          result = JSON.parse(text) as DirectorGenerationResponse;
        } catch {
          throw new Error(text || "Failed to generate 3D model");
        }
        if (!response.ok || result.status === "failed") {
          throw new Error(
            result.error || text || "Failed to generate 3D model",
          );
        }
        return result;
      };
      const actionRunId = `director:${crypto.randomUUID()}`;
      let result = await parseResponse(
        await fetch(runtimeApiUrl("/api/v1/director-model-generations"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            actionRunId,
            projectId: project.id,
            ...input,
          }),
        }),
      );
      while (result.status === "queued" || result.status === "running") {
        if (!result.statusUrl) {
          throw new Error("Director generation returned no durable status URL");
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(250, result.retryAfterMs ?? 1_000)),
        );
        result = await parseResponse(
          await fetch(runtimeApiUrl(result.statusUrl)),
        );
      }
      if (!result.asset?.url) {
        throw new Error("Generated 3D model is not locally available");
      }
      return {
        assetId: result.asset.id,
        name: projectAssetDisplayName(result.asset),
        sourceUrl: result.asset.url,
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.modelEndpoint
          ? { modelEndpoint: result.modelEndpoint }
          : {}),
        ...(result.requestId ? { requestId: result.requestId } : {}),
        ...((result.thumbnailUrl ?? result.asset.thumbnailUrl)
          ? {
              thumbnailUrl: result.thumbnailUrl ?? result.asset.thumbnailUrl!,
            }
          : {}),
      };
    },
    [project.id],
  );

  const [directorModelAssetUrls, setDirectorModelAssetUrls] = useState<
    Record<string, string>
  >({});
  useEffect(() => {
    const models =
      selectedDirectorStage?.state.objects
        .filter((object) => object.kind === "model")
        .filter(
          (object) => !DIRECTOR_BUILTIN_MODEL_ASSET_URLS[object.model.assetId],
        ) ?? [];
    if (models.length === 0) {
      setDirectorModelAssetUrls({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      models.map(async (object) => {
        try {
          const asset = await getAsset(project.id, object.model.assetId);
          if (!asset.url)
            throw new Error("Director model is not locally available");
          const sourceUrl = asset.url;
          return [object.model.assetId, sourceUrl] as const;
        } catch (error) {
          editorLog.warn("director.model_hydration_failed", { projectId: project.id, assetId: object.model.assetId, error });
          return null;
        }
      }),
    ).then((entries) => {
      if (!cancelled) {
        setDirectorModelAssetUrls(
          Object.fromEntries(entries.filter((entry) => entry !== null)),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedDirectorStage?.revisionId]);

  const clearCanvasAssetDropTarget = useCallback(() => {
    setIsCanvasAssetDropActive(false);
  }, []);

  const handleCanvasAssetDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasProjectAssetDragData(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsCanvasAssetDropActive(true);
    },
    [],
  );

  const handleCanvasAssetDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasProjectAssetDragData(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsCanvasAssetDropActive(true);
    },
    [],
  );

  const handleCanvasAssetDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (
        event.relatedTarget instanceof Element &&
        event.currentTarget.contains(event.relatedTarget)
      )
        return;
      clearCanvasAssetDropTarget();
    },
    [clearCanvasAssetDropTarget],
  );

  const handleCanvasAssetDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const asset = readProjectAssetDrag(event.dataTransfer, projectAssets);
      const instance = reactFlowInstanceRef.current;
      clearCanvasAssetDropTarget();
      if (!asset || !instance) return;
      if (asset.kind === "model") return;

      event.preventDefault();
      stopFollowingAgent();
      const label = projectAssetDisplayName(asset);
      addNode(asset.kind, {
        assetId: asset.id,
        label,
        status: "completed",
        position: instance.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        }),
      });
    },
    [addNode, clearCanvasAssetDropTarget, projectAssets, stopFollowingAgent],
  );

  const openProjectAssetPreview = useCallback(
    async (assetId: string) => {
      stopFollowingAgent();
      let projectAsset = projectAssets.find(
        (candidate) => candidate.id === assetId,
      );
      if (!projectAsset) {
        try {
          const asset = await getAsset(project.id, assetId);
          if (
            asset.kind !== "image" &&
            asset.kind !== "video" &&
            asset.kind !== "audio"
          )
            return;
          projectAsset = asset;
          setLocallyAddedProjectAssets((current) => [
            asset,
            ...current.filter((candidate) => candidate.id !== asset.id),
          ]);
        } catch (error) {
          editorLog.warn("asset.preview_hydration_failed", { projectId: project.id, assetId: assetId, error });
          return;
        }
      }
      setWorkspaceSurface({ kind: "asset", assetId: projectAsset.id });
    },
    [project.id, projectAssets, stopFollowingAgent],
  );
  const handleCanvasNodeAnnotationTarget = useCallback(
    (node: AppNode) => {
      const activeCanvas = loroSync.canvases.find(
        (canvas) => canvas.id === activeCanvasId,
      );
      // Only visual media nodes get a preview thumbnail in the annotation
      // tray; actions and audio carry an assetId too but have nothing to show.
      const nodeAssetId =
        node.type === "image" || node.type === "video"
          ? (node.data as Record<string, unknown> | undefined)?.assetId
          : undefined;
      showAnnotationContextTarget({
        projectId: project.id,
        surface: "canvas",
        surfaceId: activeCanvasId,
        surfaceLabel: activeCanvas?.name ?? activeCanvasId,
        objectId: node.id,
        objectType: `canvas-${node.type ?? "node"}`,
        objectLabel: canvasFolderNodeLabel(node),
        parentId: node.parentId,
        objectPath: `canvases/${activeCanvasId}/nodes/${node.id}`,
        capabilities: ["read", "modify"],
        ...(typeof nodeAssetId === "string" && nodeAssetId
          ? { previewAssetId: nodeAssetId }
          : {}),
      });
    },
    [
      activeCanvasId,
      loroSync.canvases,
      project.id,
      showAnnotationContextTarget,
    ],
  );
  const handleCanvasEdgeAnnotationTarget = useCallback(
    (edge: Edge) => {
      const activeCanvas = loroSync.canvases.find(
        (canvas) => canvas.id === activeCanvasId,
      );
      showAnnotationContextTarget({
        projectId: project.id,
        surface: "canvas",
        surfaceId: activeCanvasId,
        surfaceLabel: activeCanvas?.name ?? activeCanvasId,
        objectId: edge.id,
        objectType: "canvas-edge",
        objectLabel: `${edge.source} → ${edge.target}`,
        objectPath: `canvases/${activeCanvasId}/edges/${edge.id}`,
        capabilities: ["read", "modify"],
      });
    },
    [
      activeCanvasId,
      loroSync.canvases,
      project.id,
      showAnnotationContextTarget,
    ],
  );

  useEffect(() => {
    setPendingAgentAnnotations([]);
    setActiveAnnotationId(null);
    clearAnnotationContextTarget();
  }, [clearAnnotationContextTarget, project.id]);

  return (
    <ProjectProvider projectId={project.id} catalogVersion={modelCatalogVersion} onConfigureModels={() => setModelSettingsOpen(true)}>
      {modelSettingsOpen && <Suspense fallback={null}><ProjectSettingsDialog open initialSection="models" onClose={() => { setModelSettingsOpen(false); setModelCatalogVersion(value => value + 1); }} /></Suspense>}
      <SyncRecoveryDialog rejected={loroSync.syncRejected} backup={loroSync.recoveryDraft} onRecover={loroSync.prepareSyncRecovery} loadError={loroSync.projectLoadError} onRetryLoad={loroSync.retryProjectLoad} />
      <CanvasTransientUiProvider store={transientUiStore}>
        <LoroSyncProvider loroSync={loroSync}>
          <CustomActionsProvider actions={customActions}>
            <PresenceAwarenessProvider peers={awareness.peers}>
              <PluginViewProvider onOpenView={openPluginView}>
                <ImageEditorProvider>
                  <VideoClipperProvider>
                    <DirectorStageProvider
                      onOpenDirectorStage={openDirectorStageFromCanvasAction}
                    >
                      <VideoEditorProvider
                        onOpenTimeline={openTimelineFromCanvasAction}
                      >
                        <MediaViewerProvider
                          onOpenAssetPreview={openProjectAssetPreview}
                        >
                          <LayoutActionsProvider value={layoutActions}>
                            <TextNodeEditorProvider
                              onOpenNode={openCanvasTextPreview}
                            >
                              <TextNodePreviewDialog
                                open={Boolean(previewTextNode)}
                                nodeId={previewTextNode?.id ?? ""}
                                label={
                                  typeof previewTextNode?.data?.label ===
                                  "string"
                                    ? previewTextNode.data.label
                                    : "Untitled text"
                                }
                                content={
                                  typeof previewTextNode?.data?.content ===
                                  "string"
                                    ? previewTextNode.data.content
                                    : ""
                                }
                                annotationTarget={activeSurfaceAnnotationTarget}
                                annotations={pendingAgentAnnotations}
                                portalContainer={
                                  projectWorkspaceShellRef.current
                                }
                                onCreateAnnotation={queueAgentAnnotation}
                                activeAnnotationId={activeAnnotationId}
                                onSelectAnnotation={openAgentAnnotation}
                                onLocateAnnotation={locateAgentAnnotation}
                                onRemoveAnnotation={removeAgentAnnotation}
                                onClose={() => setPreviewTextNodeId(null)}
                                onOpenEditor={() => {
                                  if (previewTextNodeId) {
                                    openCanvasTextEditor(previewTextNodeId);
                                  }
                                }}
                              />
                              {!nativeAgent && <AgentAnnotationEditor
                                annotations={pendingAgentAnnotations}
                                activeId={activeAnnotationId}
                                onClose={() => setActiveAnnotationId(null)}
                                onChange={changeAgentAnnotation}
                                onRemove={removeAgentAnnotation}
                                onLocate={locateAgentAnnotation}
                              />}
                              <div
                                data-clash-project-id={project.id}
                                data-clash-canvas-id={activeCanvasId}
                                data-clash-surface={workspaceSurface}
                                data-project-loro-connected={
                                  loroSync.connected ? "true" : "false"
                                }
                                className="flex w-full flex-col bg-warm-page overflow-hidden"
                                style={{
                                  height:
                                    "var(--clash-project-editor-height, 100vh)",
                                }}
                              >
                                {/* Hidden File Input */}
                                <Input
                                  type="file"
                                  ref={fileInputRef}
                                  className="hidden"
                                  onChange={handleFileChange}
                                />
                                <Input
                                  type="file"
                                  ref={assetFileInputRef}
                                  aria-label="Add project assets"
                                  accept="image/*,video/*"
                                  multiple
                                  className="hidden"
                                  onChange={handleProjectAssetFiles}
                                />
                                <ScopedAssetPicker
                                  open={Boolean(assetPickerTarget)}
                                  sections={assetPickerSections}
                                  busy={assetPickerBusy}
                                  onClose={() => {
                                    if (!assetPickerBusy)
                                      setAssetPickerTarget(null);
                                  }}
                                  onSelect={(option) =>
                                    assetPickerTarget
                                      ? applyScopedAssetSelection(
                                          option,
                                          assetPickerTarget,
                                        )
                                      : undefined
                                  }
                                  onUpload={uploadScopedAsset}
                                />

                                {/* Top Toolbar */}

                                {/* Main Canvas Area */}
                                <div className="flex flex-1 overflow-hidden relative">
                                  <div
                                    ref={projectWorkspaceShellRef}
                                    id="project-workspace-shell"
                                    data-copilot-layout={
                                      shouldReserveCopilotSpace
                                        ? "reserved-floating"
                                        : "overlay"
                                    }
                                    data-following-agent={
                                      followingAgent ? "true" : "false"
                                    }
                                    data-project-navigator-collapsed={
                                      isProjectNavigatorCollapsed
                                    }
                                    data-canvas-folders-open={canvasFoldersOpen}
                                    onDragEndCapture={
                                      clearCanvasAssetDropTarget
                                    }
                                    style={{
                                      right: copilotWorkspaceRight,
                                    }}
                                    className="absolute inset-0 z-0 grid min-h-0 grid-cols-[var(--clash-app-sidebar-expanded-width,16rem)_minmax(0,1fr)] overflow-hidden transition-[grid-template-columns,right] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none data-[copilot-resizing=true]:duration-0 data-[project-navigator-collapsed=true]:grid-cols-[0_minmax(0,1fr)] [--clash-project-chrome-gutter:0.5rem] [--clash-project-control-height:2rem] [--clash-project-control-rhythm:var(--clash-project-control-height)] [--clash-project-action-phase:var(--clash-project-chrome-gutter)] [--clash-project-search-row-height:calc(var(--clash-project-control-rhythm)+var(--clash-project-action-phase))] [--clash-project-sidebar-header-height:2.5rem] [--clash-project-frame-top:calc(var(--clash-project-sidebar-header-height)+var(--clash-project-chrome-gutter))] [--clash-project-header-content-offset-y:var(--clash-control-gap)] [--clash-project-control-rail-left:var(--clash-project-chrome-gutter)] data-[canvas-folders-open=true]:[--clash-project-control-rail-left:13rem] clash-auto-hide-sidebar-host"
                                  >
                                    <DesktopAutoHideSidebar
                                      collapsed={isProjectNavigatorCollapsed}
                                      onCollapsedChange={
                                        setIsProjectNavigatorCollapsed
                                      }
                                      expandedWidth="var(--clash-app-sidebar-expanded-width)"
                                      label="Project navigator"
                                      widthStorageKey="project-navigator-width"
                                    >
                                      <ProjectWorkspaceNavigator
                                        header={
                                          <div
                                            id="editor-header"
                                            className="clash-project-sidebar-header-content clash-project-chrome-header-content flex min-w-0 flex-1 items-center gap-1.5 pointer-events-auto"
                                          >
                                            <Tooltip label={nativeAgent ? "Return to conversation" : "Return to projects"}>
                                              <IconButton
                                                label={nativeAgent ? "Return to conversation" : "Return to projects"}
                                                onClick={handleReturnToProjects}
                                                icon={
                                                  <ArrowLeft
                                                    className="h-4 w-4"
                                                    weight="bold"
                                                  />
                                                }
                                                size="sm"
                                                shape="rounded"
                                                className="clash-project-return-button -ml-px shrink-0 rounded-md text-content-secondary focus-visible:ring-offset-warm-page"
                                              />
                                            </Tooltip>
                                            <form
                                              className="min-w-0 flex-1"
                                              onSubmit={handleProjectNameSubmit}
                                            >
                                              <Input
                                                ref={projectTitleInputRef}
                                                className="clash-project-name-input h-8 w-full min-w-0 bg-transparent px-1 font-display text-[var(--clash-project-title-size,0.8125rem)] font-semibold text-content-primary placeholder:text-content-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
                                                value={projectName}
                                                onChange={(event) =>
                                                  setProjectName(
                                                    event.target.value,
                                                  )
                                                }
                                                onBlur={() => {
                                                  if (
                                                    projectName !== project.name
                                                  ) {
                                                    updateProjectName(
                                                      project.id,
                                                      projectName,
                                                    );
                                                  }
                                                }}
                                                placeholder="Untitled"
                                              />
                                            </form>
                                            <DesktopSidebarCollapseButton
                                              collapsed={
                                                isProjectNavigatorCollapsed
                                              }
                                              label="Project navigator"
                                              onCollapsedChange={
                                                setIsProjectNavigatorCollapsed
                                              }
                                            />
                                          </div>
                                        }
                                        footer={<div className="flex flex-col gap-1 p-2"><Button size="sm" className="w-full justify-start" leftIcon={<Gear size={16} />} onClick={() => setModelSettingsOpen(true)}>Settings</Button>{!nativeAgent && <UserControls compact />}</div>}
                                        canvases={loroSync.canvases}
                                        timelines={loroSync.timelines}
                                        timelineError={loroSync.timelineError}
                                        directorStages={loroSync.directorStages}
                                        assets={allProjectAssets}
                                        textAssets={projectTextAssets}
                                        pluginViews={projectPluginViews}
                                        pluginViewDefinitions={
                                          executablePluginViews
                                        }
                                        globalAssets={activeGlobalProjectAssets}
                                        browsers={browserTabs}
                                        surface={workspaceSurface}
                                        onSelectCanvas={
                                          selectCanvasFromNavigator
                                        }
                                        onSelectPluginView={(view) =>
                                          openPluginView(view.nodeId)
                                        }
                                        onSelectTimeline={(timelineId) => {
                                          stopFollowingAgent();
                                          void preloadTimelineEditor();
                                          setWorkspaceSurface({
                                            kind: "timeline",
                                            timelineId,
                                          });
                                        }}
                                        onSelectDirectorStage={(stageId) => {
                                          stopFollowingAgent();
                                          setWorkspaceSurface({
                                            kind: "director-stage",
                                            stageId,
                                          });
                                        }}
                                        onSelectAsset={(assetId) => {
                                          stopFollowingAgent();
                                          setWorkspaceSurface({
                                            kind: "asset",
                                            assetId,
                                          });
                                        }}
                                        onSelectTextAsset={openProjectTextAsset}
                                        onSelectBrowser={
                                          selectBrowserFromNavigator
                                        }
                                        onCreateCanvas={
                                          createCanvasFromNavigator
                                        }
                                        onCreatePluginView={
                                          createPluginViewFromNavigator
                                        }
                                        onDeletePluginView={
                                          deletePluginViewFromNavigator
                                        }
                                        onRenameCanvas={
                                          renameCanvasFromNavigator
                                        }
                                        onDeleteCanvas={
                                          deleteCanvasFromNavigator
                                        }
                                        onCreateTimeline={
                                          createTimelineFromNavigator
                                        }
                                        onAttachTimeline={
                                          attachTimelineFromNavigator
                                        }
                                        onDeleteTimeline={
                                          deleteTimelineFromNavigator
                                        }
                                        onCreateDirectorStage={
                                          createDirectorStageFromNavigator
                                        }
                                        onAttachDirectorStage={
                                          attachDirectorStageFromNavigator
                                        }
                                        onAddAsset={openProjectAssetPicker}
                                        onCreateBrowser={
                                          globalThis.__CLASH_DESKTOP__
                                            ?.isDesktop
                                            ? createBrowserFromNavigator
                                            : undefined
                                        }
                                        onCloseBrowser={
                                          closeBrowserFromNavigator
                                        }
                                        onAddGlobalAsset={async (assetId) => {
                                          await addGlobalAssetToProject(
                                            assetId,
                                          );
                                        }}
                                        onAddAssetToLibrary={(assetId) => {
                                          void addProjectAssetToLibrary(
                                            assetId,
                                          );
                                        }}
                                        onTrashAsset={
                                          trashProjectAssetFromNavigator
                                        }
                                        onRestoreAsset={
                                          restoreProjectAssetFromNavigator
                                        }
                                        onAnnotate={nativeAgent ? undefined : (target) =>
                                          queueAgentAnnotation({
                                            ...target,
                                            projectId: project.id,
                                          })
                                        }
                                      />
                                    </DesktopAutoHideSidebar>

                                    <AgentAnnotationContextMenu
                                      target={annotationContextTarget}
                                      onAnnotate={queueAgentAnnotation}
                                    >
                                      <div
                                        id="project-workspace-inset"
                                        className="relative min-h-0 min-w-0 overflow-hidden"
                                        onContextMenuCapture={(event) => {
                                          clearAnnotationContextTarget();
                                          handleSelectionAnnotationContextMenu(
                                            event,
                                            selectionAnnotationOverlayRef,
                                          );
                                        }}
                                      >
                                        {!nativeAgent && workspaceSurface.kind !==
                                          "text-asset" &&
                                        workspaceSurface.kind !== "browser" &&
                                        workspaceSurface.kind !==
                                          "plugin-view" ? (
                                          <AgentSelectionAnnotationOverlay
                                            ref={selectionAnnotationOverlayRef}
                                            target={
                                              activeSurfaceAnnotationTarget
                                            }
                                            annotations={
                                              pendingAgentAnnotations
                                            }
                                            onCreate={queueAgentAnnotation}
                                            excludedObjectTypes={[
                                              "canvas-text",
                                            ]}
                                            activeId={activeAnnotationId}
                                            onSelect={openAgentAnnotation}
                                            onLocate={locateAgentAnnotation}
                                            onRemove={removeAgentAnnotation}
                                          />
                                        ) : null}
                                        {!nativeAgent && workspaceSurface.kind !== "canvas" &&
                                        workspaceSurface.kind !==
                                          "text-asset" &&
                                        workspaceSurface.kind !== "browser" &&
                                        workspaceSurface.kind !==
                                          "plugin-view" ? (
                                          <AgentAnnotationDomPinLayer
                                            annotations={
                                              pendingAgentAnnotations
                                            }
                                            surface={workspaceSurface.kind}
                                            surfaceId={
                                              workspaceSurface.kind ===
                                              "timeline"
                                                ? workspaceSurface.timelineId
                                                : workspaceSurface.kind ===
                                                    "director-stage"
                                                  ? workspaceSurface.stageId
                                                  : workspaceSurface.assetId
                                            }
                                            activeId={activeAnnotationId}
                                            onSelect={openAgentAnnotation}
                                            onLocate={locateAgentAnnotation}
                                            onRemove={removeAgentAnnotation}
                                          />
                                        ) : null}
                                        <ProjectBrowserSurfaces
                                          projectId={project.id}
                                          tabs={browserTabs}
                                          activeBrowserId={
                                            workspaceSurface.kind === "browser"
                                              ? workspaceSurface.browserId
                                              : null
                                          }
                                          headerEndInset={copilotHeaderInset}
                                          annotations={pendingAgentAnnotations}
                                          activeAnnotationId={
                                            activeAnnotationId
                                          }
                                          onTabChange={updateBrowserFromSurface}
                                          onCreateAnnotation={
                                            queueAgentAnnotation
                                          }
                                          onSelectAnnotation={
                                            openAgentAnnotation
                                          }
                                          onAgentContextChange={
                                            updateBrowserAgentContext
                                          }
                                        />
                                        {workspaceSurface.kind ===
                                        "text-asset" ? (
                                          selectedTextNode ? (
                                            selectedTextNode.data.documentRevision !== undefined ? <TextDocumentReadSurface
                                              projectId={project.id}
                                              reference={selectedTextNode.data.documentRevision}
                                              label={typeof selectedTextNode.data.label === "string" ? selectedTextNode.data.label : "Text result"}
                                              onClose={closeTextEditor}
                                            /> : <TextDocumentEditorSurface
                                              key={workspaceSurface.nodeId}
                                              projectId={project.id}
                                              nodeId={workspaceSurface.nodeId}
                                              label={
                                                typeof selectedTextNode.data
                                                  ?.label === "string"
                                                  ? selectedTextNode.data.label
                                                  : (selectedTextAsset?.label ??
                                                    "Untitled text")
                                              }
                                              content={
                                                typeof selectedTextNode.data
                                                  ?.content === "string"
                                                  ? selectedTextNode.data
                                                      .content
                                                  : ""
                                              }
                                              annotationTarget={
                                                activeSurfaceAnnotationTarget
                                              }
                                              annotations={
                                                pendingAgentAnnotations
                                              }
                                              onCreateAnnotation={
                                                queueAgentAnnotation
                                              }
                                              activeAnnotationId={
                                                activeAnnotationId
                                              }
                                              onSelectAnnotation={
                                                openAgentAnnotation
                                              }
                                              onLocateAnnotation={
                                                locateAgentAnnotation
                                              }
                                              onRemoveAnnotation={
                                                removeAgentAnnotation
                                              }
                                              onSave={(next) =>
                                                saveTextDocument(
                                                  workspaceSurface.nodeId,
                                                  next,
                                                )
                                              }
                                              onClose={closeTextEditor}
                                            />
                                          ) : (
                                            <div
                                              role="status"
                                              aria-label="Loading text document"
                                              className="absolute inset-0 z-10 flex items-center justify-center bg-warm-page text-sm text-content-muted"
                                            >
                                              Loading text document…
                                            </div>
                                          )
                                        ) : null}
                                        {selectedPluginView ? (
                                          <PluginStoryboardSurface
                                            key={selectedPluginView.nodeId}
                                            projectId={project.id}
                                            nodeId={selectedPluginView.nodeId}
                                            label={selectedPluginView.label}
                                            state={selectedPluginView.state}
                                            assets={projectAssets}
                                            generators={storyboardGenerators}
                                            onSave={savePluginViewState}
                                            onGenerate={
                                              generatePluginViewMaterial
                                            }
                                            onClose={() =>
                                              selectCanvas(DEFAULT_CANVAS_ID)
                                            }
                                          />
                                        ) : null}
                                        {selectedAsset && (
                                          <EditableProjectAssetSurface
                                            asset={selectedAsset}
                                            projectId={project.id}
                                            projectAssets={projectAssets}
                                            canvases={loroSync.canvases}
                                            timelines={loroSync.timelines}
                                            relationNodes={
                                              assetRelationGraph.nodes
                                            }
                                            relationEdges={
                                              assetRelationGraph.edges
                                            }
                                            relationBindings={
                                              loroSync.doc
                                                ? listActionAssetBindings(
                                                    loroSync.doc,
                                                  )
                                                : []
                                            }
                                            onOpenCanvas={
                                              openAssetRelationCanvas
                                            }
                                            onOpenTimeline={
                                              openAssetRelationTimeline
                                            }
                                            onOpenAsset={openRelatedAsset}
                                            onApplied={handleEditedAssetApplied}
                                            headerEndInset={copilotHeaderInset}
                                          />
                                        )}

                                        {selectedTimeline && (
                                          <ProjectTimelineEditorSurface
                                            key={selectedTimeline.id}
                                            projectId={project.id}
                                            timeline={selectedTimeline}
                                            mediaInputs={timelineMediaInputs}
                                            runtimeNodes={assetRelationGraph.nodes
                                              .filter(
                                                (node) =>
                                                  node.type ===
                                                  "remotion-component",
                                              )
                                              .map((node) => ({
                                                id: node.id,
                                                type: "remotion-component",
                                                data: node.data as Record<
                                                  string,
                                                  unknown
                                                >,
                                              }))}
                                            canvases={loroSync.canvases}
                                            onSave={saveTimelineFromNavigator}
                                            onExport={
                                              exportTimelineFromNavigator
                                            }
                                            exportProgress={
                                              selectedTimelineExportProgress
                                            }
                                            onOpenCanvas={
                                              selectCanvasFromNavigator
                                            }
                                            onRequestAsset={() =>
                                              setAssetPickerTarget({
                                                kind: "timeline",
                                                timelineId: selectedTimeline.id,
                                                owner: selectedTimeline.owner,
                                              })
                                            }
                                            insertAssetRequest={
                                              timelineInsertRequest?.timelineId ===
                                              selectedTimeline.id
                                                ? timelineInsertRequest
                                                : undefined
                                            }
                                            onInsertAssetRequestHandled={
                                              handleTimelineInsertAssetRequestHandled
                                            }
                                            onAdmitTimelineLibraryMedia={
                                              admitTimelineLibraryMedia
                                            }
                                            onProjectAssetDrop={
                                              handleTimelineProjectAssetDrop
                                            }
                                            onAnnotationTargetContextMenu={
                                              handleTimelineAnnotationTarget
                                            }
                                            headerEndInset={copilotHeaderInset}
                                          />
                                        )}

                                        {selectedDirectorStage && (
                                          <ProjectDirectorStageSurface
                                            key={selectedDirectorStage.id}
                                            projectId={project.id}
                                            stage={selectedDirectorStage}
                                            canvases={loroSync.canvases}
                                            headerEndInset={copilotHeaderInset}
                                            panoramaOptions={
                                              directorPanoramaOptions
                                            }
                                            modelAssetUrls={
                                              directorModelAssetUrls
                                            }
                                            onSave={saveDirectorStage}
                                            onOpenCanvas={
                                              selectCanvasFromNavigator
                                            }
                                            onOpenAsset={openRelatedAsset}
                                            onUndo={loroSync.undo}
                                            onAnnotationTargetContextMenu={
                                              handleDirectorAnnotationTarget
                                            }
                                            onCaptureShot={
                                              captureDirectorStageShot
                                            }
                                            onExportVideo={
                                              exportDirectorStageVideo
                                            }
                                            onUploadModel={uploadDirectorModel}
                                            onGenerateModel={
                                              generateDirectorModel
                                            }
                                            onUploadPanorama={
                                              uploadDirectorPanorama
                                            }
                                            onGeneratePanorama={
                                              generateDirectorPanorama
                                            }
                                          />
                                        )}

                                        <div
                                          ref={flowBoundsRef}
                                          onDragEnterCapture={
                                            handleCanvasAssetDragEnter
                                          }
                                          onDragOverCapture={
                                            handleCanvasAssetDragOver
                                          }
                                          onDragLeaveCapture={
                                            handleCanvasAssetDragLeave
                                          }
                                          onDropCapture={handleCanvasAssetDrop}
                                          onDoubleClick={
                                            openCreateMenuFromPane
                                          }
                                          className={`absolute inset-0 z-0 ${workspaceSurface.kind === "canvas" ? "" : "hidden"} ${canvasMode === "hand" ? "[&_.react-flow__pane]:cursor-grab [&_.react-flow__pane:active]:cursor-grabbing" : ""}`}
                                        >
                                          {isCanvasAssetDropActive ? (
                                            <div
                                              aria-hidden="true"
                                              data-testid="canvas-asset-drop-target"
                                              className="pointer-events-auto absolute inset-0 z-[10000] border-2 border-brand/35 bg-brand/[0.025]"
                                            />
                                          ) : null}
                                          <ReactFlow
                                            zoomOnDoubleClick={false}
                                            nodes={readableNodes}
                                            edges={edges}
                                            edgeTypes={projectCanvasEdgeTypes}
                                            onError={projectCanvasOnError}
                                            onInit={(instance) => {
                                              reactFlowInstanceRef.current =
                                                instance;
                                              if (
                                                projectSessionHydratedProjectIdRef.current ===
                                                project.id
                                              ) {
                                                restoreCanvasViewport(
                                                  activeCanvasIdRef.current,
                                                  instance,
                                                );
                                              }
                                              window.requestAnimationFrame(
                                                focusPendingAgentTarget,
                                              );
                                            }}
                                            onMoveEnd={(_event, viewport) => {
                                              if (
                                                projectSessionHydratedProjectIdRef.current !==
                                                project.id
                                              ) {
                                                return;
                                              }
                                              updateCanvasView(
                                                activeCanvasIdRef.current,
                                                (current) => ({
                                                  ...current,
                                                  viewport: {
                                                    x: viewport.x,
                                                    y: viewport.y,
                                                    zoom: viewport.zoom,
                                                  },
                                                }),
                                              );
                                            }}
                                            onMoveStart={(event) => {
                                              if (event) stopFollowingAgent();
                                            }}
                                            onNodeClick={(_event, node) => {
                                              stopFollowingAgent();
                                              if (
                                                node.type !== "action-badge"
                                              ) {
                                                transientUiStore.dismiss();
                                              }
                                            }}
                                            onNodeContextMenu={(
                                              _event,
                                              node,
                                            ) => {
                                              handleCanvasNodeAnnotationTarget(
                                                node,
                                              );
                                            }}
                                            onEdgeContextMenu={(
                                              _event,
                                              edge,
                                            ) => {
                                              handleCanvasEdgeAnnotationTarget(
                                                edge,
                                              );
                                            }}
                                            onPaneClick={() => {
                                              stopFollowingAgent();
                                              transientUiStore.dismiss();
                                            }}
                                            onNodeDragStart={() => {
                                              stopFollowingAgent();
                                              setIsNodeDragging(true);
                                            }}
                                            onNodesChange={handleNodesChange}
                                            onEdgesChange={handleEdgesChange}
                                            onBeforeDelete={onBeforeDelete}
                                            onNodesDelete={onNodesDelete}
                                            onNodeDragStop={onNodeDragStop}
                                            onConnect={onConnect}
                                            onSelectionChange={
                                              onSelectionChange
                                            }
                                            onSelectionStart={() => {
                                              stopFollowingAgent();
                                              setIsMarqueeing(true);
                                            }}
                                            onSelectionEnd={() =>
                                              setIsMarqueeing(false)
                                            }

                                            nodeTypes={nodeTypes}
                                            fitView
                                            onlyRenderVisibleElements
                                            minZoom={0.1}
                                            selectionOnDrag={
                                              canvasMode === "select"
                                            }
                                            panOnDrag={
                                              canvasMode === "select"
                                                ? [1, 2]
                                                : true
                                            }
                                            selectionMode={
                                              SelectionMode.Partial
                                            }
                                            deleteKeyCode={[
                                              "Backspace",
                                              "Delete",
                                            ]}
                                            multiSelectionKeyCode="Shift"
                                            defaultEdgeOptions={{
                                              interactionWidth: 30,
                                              focusable: true,
                                              selectable: true,
                                              deletable: true,
                                            }}
                                            proOptions={{
                                              hideAttribution: true,
                                            }}
                                          >
                                            <Background
                                              variant={BackgroundVariant.Dots}
                                              gap={12}
                                              size={1.5}
                                              color="var(--canvas-dot)"
                                              style={{
                                                backgroundColor:
                                                  "var(--canvas-bg)",
                                              }}
                                            />
                                            {!nativeAgent && workspaceSurface.kind ===
                                            "canvas" ? (
                                              <CanvasAnnotationPinLayer
                                                active={workspaceSurface.kind === "canvas"}
                                                annotations={
                                                  pendingAgentAnnotations
                                                }
                                                canvasId={
                                                  workspaceSurface.canvasId
                                                }
                                                flowBoundsRef={flowBoundsRef}
                                                activeId={activeAnnotationId}
                                                onSelect={openAgentAnnotation}
                                                onLocate={locateAgentAnnotation}
                                                onRemove={removeAgentAnnotation}
                                              />
                                            ) : null}
                                            <div className="pointer-events-none absolute bottom-[var(--clash-project-chrome-gutter)] left-[var(--clash-project-control-rail-left)] z-10 flex flex-col items-start gap-2 transition-[left] duration-200 ease-out">
                                              <motion.div
                                                data-canvas-minimap-shell
                                                className="nodrag nopan nowheel pointer-events-auto relative shrink-0 overflow-hidden rounded-lg"
                                                initial={false}
                                                animate={{
                                                  width: minimapCollapsed
                                                    ? 32
                                                    : minimapSize.width,
                                                  height: minimapCollapsed
                                                    ? 32
                                                    : minimapSize.height,
                                                }}
                                                transition={
                                                  minimapResizing
                                                    ? { duration: 0 }
                                                    : minimapCollapsed
                                                      ? {
                                                          type: "spring",
                                                          stiffness: 520,
                                                          damping: 42,
                                                          mass: 0.7,
                                                          velocity:
                                                            -minimapCollapseVelocity,
                                                          restDelta: 0.5,
                                                          restSpeed: 10,
                                                        }
                                                      : {
                                                          duration: 0.22,
                                                          ease: [
                                                            0.25, 1, 0.5, 1,
                                                          ],
                                                        }
                                                }
                                              >
                                                <AnimatePresence
                                                  initial={false}
                                                >
                                                  {minimapCollapsed ? (
                                                    <motion.div
                                                      key="collapsed-minimap"
                                                      className="absolute inset-0"
                                                      initial={{
                                                        opacity: 0,
                                                        scale: 0.82,
                                                      }}
                                                      animate={{
                                                        opacity: 1,
                                                        scale: 1,
                                                      }}
                                                      exit={{
                                                        opacity: 0,
                                                        scale: 0.9,
                                                      }}
                                                      transition={{
                                                        duration: 0.16,
                                                        ease: "easeOut",
                                                      }}
                                                    >
                                                      <IconButton
                                                        label="Expand canvas minimap"
                                                        icon={
                                                          <MapTrifold
                                                            className="h-3.5 w-3.5"
                                                            weight="regular"
                                                          />
                                                        }
                                                        onClick={expandMinimap}
                                                        size="sm"
                                                        shape="rounded"
                                                        className="clash-canvas-minimap-control clash-workspace-icon-control"
                                                      />
                                                    </motion.div>
                                                  ) : (
                                                    <motion.div
                                                      key="expanded-minimap"
                                                      className="absolute bottom-0 left-0 origin-bottom-left"
                                                      initial={{
                                                        opacity: 0,
                                                        scale: 0.94,
                                                      }}
                                                      animate={{
                                                        opacity: 1,
                                                        scale: 1,
                                                      }}
                                                      exit={{
                                                        opacity: 0,
                                                        scale: 0.94,
                                                      }}
                                                      transition={{
                                                        duration: 0.16,
                                                        ease: "easeOut",
                                                      }}
                                                      style={{
                                                        width:
                                                          minimapSize.width,
                                                        height:
                                                          minimapSize.height,
                                                      }}
                                                    >
                                                      <MiniMap
                                                        ariaLabel="Canvas minimap"
                                                        position="bottom-left"
                                                        pannable
                                                        zoomable
                                                        nodeColor={(node) =>
                                                          node.type === "group"
                                                            ? "var(--canvas-minimap-group)"
                                                            : "var(--canvas-minimap-node)"
                                                        }
                                                        nodeStrokeColor={(
                                                          node,
                                                        ) =>
                                                          node.type === "group"
                                                            ? "var(--canvas-minimap-group-stroke)"
                                                            : "var(--canvas-minimap-node-stroke)"
                                                        }
                                                        nodeStrokeWidth={2}
                                                        maskColor="var(--canvas-minimap-mask)"
                                                        maskStrokeColor="var(--canvas-minimap-viewport)"
                                                        maskStrokeWidth={1.5}
                                                        bgColor="var(--canvas-minimap-bg)"
                                                        offsetScale={8}
                                                        style={{
                                                          width:
                                                            minimapSize.width,
                                                          height:
                                                            minimapSize.height,
                                                        }}
                                                        className="clash-canvas-minimap"
                                                      />
                                                      <IconButton
                                                        label="Collapse canvas minimap"
                                                        icon={
                                                          <ArrowsInSimple
                                                            className="h-3.5 w-3.5"
                                                            weight="bold"
                                                          />
                                                        }
                                                        onClick={
                                                          collapseMinimap
                                                        }
                                                        size="sm"
                                                        shape="rounded"
                                                        className="clash-canvas-minimap-overlay-control absolute left-1.5 top-1.5 z-10 h-7 min-h-7 w-7 min-w-7 rounded-md"
                                                      />
                                                      <button
                                                        type="button"
                                                        aria-label="Resize canvas minimap"
                                                        data-canvas-minimap-resize-handle
                                                        onPointerDown={
                                                          startMinimapResize
                                                        }
                                                        onPointerMove={
                                                          resizeMinimap
                                                        }
                                                        onPointerUp={
                                                          finishMinimapResize
                                                        }
                                                        onPointerCancel={
                                                          finishMinimapResize
                                                        }
                                                        className="clash-canvas-minimap-resize-handle absolute right-0 top-0 z-10 h-7 w-7 cursor-nesw-resize touch-none rounded-tr-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                      >
                                                        <span className="clash-canvas-minimap-resize-grip" />
                                                      </button>
                                                    </motion.div>
                                                  )}
                                                </AnimatePresence>
                                              </motion.div>
                                            </div>

                                            {/* Collaboration: node-level activity indicators */}
                                            <NodeActivityIndicator
                                              highlights={highlights}
                                            />

                                            {/* Debug: show node IDs as selectable labels */}
                                            {showDebugIds && (
                                              <DebugNodeIds nodes={nodes} />
                                            )}

                                            {/* Floating "Group" pill — appears above marquee/shift selection of 2+ siblings */}
                                            <SelectionGroupButton
                                              bounds={selectionBounds}
                                              onGroup={groupSelectedNodes}
                                            />

                                            {/* Live cursor + selection awareness from other peers.
                                          Must be inside ReactFlow so it can read viewport
                                          (zoom/pan) for translating flow-coords → screen. */}
                                            <AwarenessLayer
                                              peers={awareness.peers}
                                              setLocalCursor={
                                                awareness.setLocalCursor
                                              }
                                              flowBoundsRef={flowBoundsRef}
                                            />

                                            {/* Unix-pipe cascade dispatcher: adopts drafts on run
                                          request, propagates cascadeToken across stages. */}
                                            <CascadeRunnerMount
                                              nodes={nodes}
                                              edges={edges}
                                              setNodes={setNodes}
                                              customActions={customActions}
                                            />
                                          </ReactFlow>
                                          <DropdownMenu open={canvasCreateMenu !== null} onOpenChange={(open) => { if (!open) setCanvasCreateMenu(null); }}>
                                            <DropdownMenuTrigger asChild>
                                              <button type="button" aria-label="Create node here" aria-hidden="true" tabIndex={-1} className="pointer-events-none absolute h-px w-px opacity-0" style={{ left: canvasCreateMenu?.anchor.x ?? 0, top: canvasCreateMenu?.anchor.y ?? 0 }} />
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent aria-label="Create node" side="right" align="start" sideOffset={0} onCloseAutoFocus={(event) => event.preventDefault()} className="clash-canvas-menu-surface min-w-48">
                                              <CanvasCreateMenuItems customActions={customActions} onSelect={(type) => handleToolClick(type, canvasCreateMenu?.position)} />
                                            </DropdownMenuContent>
                                          </DropdownMenu>
                                        </div>

                                        {workspaceSurface.kind === "canvas" ? (
                                          <>
                                            {!canvasFoldersOpen ? (
                                              <Tooltip
                                                label="Canvas folders"
                                                placement="right"
                                              >
                                                <IconButton
                                                  label="Canvas folders"
                                                  icon={
                                                    <FolderSimple
                                                      className="h-3.5 w-3.5"
                                                      weight="regular"
                                                    />
                                                  }
                                                  onClick={() =>
                                                    setCanvasFoldersOpen(true)
                                                  }
                                                  // Source-shape contract: keep the floating control bound directly to the minimap offset.
                                                  // prettier-ignore
                                                  style={{ bottom: minimapControlOffset }}
                                                  size="sm"
                                                  shape="rounded"
                                                  className="clash-canvas-minimap-control clash-workspace-icon-control absolute left-[var(--clash-project-control-rail-left)] z-10 transition-[bottom] duration-200 ease-out"
                                                />
                                              </Tooltip>
                                            ) : null}

                                            {canvasFoldersOpen ? (
                                              <motion.aside
                                                aria-label="Canvas folders"
                                                data-canvas-folders-panel
                                                className="clash-canvas-overlay-panel pointer-events-auto absolute bottom-[var(--clash-project-chrome-gutter)] left-[var(--clash-project-chrome-gutter)] top-[var(--clash-project-frame-top)] z-20 flex w-48 flex-col overflow-hidden"
                                                initial={{ opacity: 0, x: -8 }}
                                                animate={{ opacity: 1, x: 0 }}
                                                transition={{
                                                  duration: 0.18,
                                                  ease: [0.25, 1, 0.5, 1],
                                                }}
                                              >
                                                <div className="relative flex h-[var(--clash-project-control-rhythm)] shrink-0 items-center px-1.5 after:pointer-events-none after:absolute after:inset-x-1.5 after:bottom-0 after:h-px after:bg-warm-border/50 after:content-['']">
                                                  <span className="pointer-events-none absolute inset-y-0 left-1.5 flex w-6 items-center justify-center text-content-muted">
                                                    <MagnifyingGlass
                                                      aria-hidden="true"
                                                      className="h-3.5 w-3.5"
                                                      weight="regular"
                                                    />
                                                  </span>
                                                  <Input
                                                    aria-label="Search canvas folders"
                                                    placeholder="Search"
                                                    value={canvasFolderQuery}
                                                    onChange={(event) =>
                                                      setCanvasFolderQuery(
                                                        event.target.value,
                                                      )
                                                    }
                                                    className="h-[var(--clash-project-control-rhythm)] border-transparent bg-transparent pl-8 pr-2 text-xs text-content-primary shadow-none placeholder:text-content-muted hover:bg-warm-page/45 focus-visible:border-warm-border/70 focus-visible:bg-warm-page/60 focus-visible:ring-0"
                                                  />
                                                </div>
                                                <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-10 pt-[var(--clash-project-action-phase)]">
                                                  {activeCanvasUsesImplicitRoot ? (
                                                    <CanvasFolderEntries
                                                      entries={
                                                        filteredCanvasFolderEntries
                                                      }
                                                      projectId={project.id}
                                                      onSelect={
                                                        focusCanvasFolderNode
                                                      }
                                                    />
                                                  ) : null}
                                                  {canvasFolderCanvases.map(
                                                    (canvas) => {
                                                      const isActive =
                                                        canvas.id ===
                                                        activeCanvasId;
                                                      return (
                                                        <li key={canvas.id}>
                                                          <button
                                                            type="button"
                                                            aria-current={
                                                              isActive
                                                                ? "page"
                                                                : undefined
                                                            }
                                                            onClick={() =>
                                                              selectCanvas(
                                                                canvas.id,
                                                              )
                                                            }
                                                            className={`flex h-[var(--clash-project-control-rhythm)] w-full items-center gap-2 rounded-md px-2 text-left text-xs font-semibold transition-colors ${
                                                              isActive
                                                                ? "bg-brand/[0.08] text-content-primary"
                                                                : "text-content-secondary hover:bg-warm-hover hover:text-content-primary"
                                                            }`}
                                                          >
                                                            <FolderSimple
                                                              className={`h-4 w-4 shrink-0 ${isActive ? "text-brand" : "text-content-muted"}`}
                                                              weight={
                                                                isActive
                                                                  ? "fill"
                                                                  : "regular"
                                                              }
                                                            />
                                                            <span className="min-w-0 flex-1 truncate">
                                                              {canvas.name}
                                                            </span>
                                                          </button>

                                                          {isActive &&
                                                          filteredCanvasFolderEntries.length >
                                                            0 ? (
                                                            <ul className="ml-4 border-l border-warm-border/80 py-0.5">
                                                              <CanvasFolderEntries
                                                                entries={
                                                                  filteredCanvasFolderEntries
                                                                }
                                                                projectId={
                                                                  project.id
                                                                }
                                                                onSelect={
                                                                  focusCanvasFolderNode
                                                                }
                                                                nested
                                                              />
                                                            </ul>
                                                          ) : null}
                                                        </li>
                                                      );
                                                    },
                                                  )}
                                                </ul>
                                                <IconButton
                                                  label="Collapse canvas folders"
                                                  icon={
                                                    <X
                                                      className="h-3.5 w-3.5"
                                                      weight="bold"
                                                    />
                                                  }
                                                  size="sm"
                                                  shape="rounded"
                                                  onClick={() =>
                                                    setCanvasFoldersOpen(false)
                                                  }
                                                  className="absolute bottom-1.5 right-1.5 h-7 min-h-7 w-7 min-w-7 rounded-md bg-warm-surface text-content-muted shadow-sm hover:bg-warm-hover hover:text-content-primary"
                                                />
                                              </motion.aside>
                                            ) : null}
                                          </>
                                        ) : null}

                                        {/* Left Toolbar - Vertical Palette.
                                  z-10 keeps it above the canvas (z-0) but well below
                                  the bottom-right ChatbotCopilot popover and any modal
                                  Dialog (z-[70]). */}
                                        {workspaceSurface.kind === "canvas" && (
                                          <motion.div
                                            data-project-workspace-toolbar
                                            className="absolute left-[var(--clash-project-control-rail-left)] top-[var(--clash-project-frame-top)] z-10 flex flex-col items-start gap-2 pointer-events-none transition-[left] duration-200 ease-out"
                                            initial={{
                                              opacity: 0,
                                              x: -8,
                                              scale: 0.98,
                                            }}
                                            animate={{
                                              opacity: 1,
                                              x: 0,
                                              scale: 1,
                                            }}
                                            exit={{
                                              opacity: 0,
                                              x: -8,
                                              scale: 0.98,
                                            }}
                                            transition={{
                                              duration: 0.18,
                                              ease: [0.25, 1, 0.5, 1],
                                            }}
                                          >
                                            <Toolbar.Root
                                              aria-label="Canvas tools"
                                              orientation="vertical"
                                              loop
                                              className="clash-canvas-toolbar-surface pointer-events-auto flex flex-col items-center gap-0 py-[var(--clash-project-action-phase)] transition-colors [--clash-toolbar-section-gap:var(--clash-project-action-phase)]"
                                            >
                                              <Toolbar.ToggleGroup
                                                type="single"
                                                value={canvasMode}
                                                onValueChange={(mode) => {
                                                  if (
                                                    mode === "select" ||
                                                    mode === "hand"
                                                  ) {
                                                    transientUiStore.dismiss();
                                                    selectCanvasMode(mode);
                                                  }
                                                }}
                                                orientation="vertical"
                                                aria-label="Canvas mode"
                                                className="flex w-full flex-col items-center gap-0"
                                              >
                                                <Tooltip
                                                  label="Select mode (V)"
                                                  placement="right"
                                                >
                                                  <Toolbar.ToggleItem
                                                    value="select"
                                                    asChild
                                                  >
                                                    <IconButton
                                                      label="Select mode"
                                                      icon={
                                                        <CursorClick
                                                          className="h-[18px] w-[18px]"
                                                          weight="regular"
                                                        />
                                                      }
                                                      size="sm"
                                                      shape="rounded"
                                                      className="clash-workspace-icon-control clash-toolbar-button text-content-muted hover:text-content-primary"
                                                    />
                                                  </Toolbar.ToggleItem>
                                                </Tooltip>
                                                <Tooltip
                                                  label="Hand mode (H)"
                                                  placement="right"
                                                >
                                                  <Toolbar.ToggleItem
                                                    value="hand"
                                                    asChild
                                                  >
                                                    <IconButton
                                                      label="Hand mode"
                                                      icon={
                                                        <HandGrabbing
                                                          className="h-[18px] w-[18px]"
                                                          weight="regular"
                                                        />
                                                      }
                                                      size="sm"
                                                      shape="rounded"
                                                      className="clash-workspace-icon-control clash-toolbar-button text-content-muted hover:text-content-primary"
                                                    />
                                                  </Toolbar.ToggleItem>
                                                </Tooltip>
                                              </Toolbar.ToggleGroup>

                                              <div className="flex h-[var(--clash-toolbar-section-gap)] w-full shrink-0 items-center justify-center">
                                                <Toolbar.Separator
                                                  orientation="horizontal"
                                                  className="h-px w-8 bg-warm-border/70"
                                                />
                                              </div>

                                              <DropdownMenu onOpenChange={dismissTransientUiOnMenuOpen}>
                                                <Tooltip label="Create node" placement="right">
                                                  <DropdownMenuTrigger asChild>
                                                    <Toolbar.Button asChild>
                                                      <IconButton label="Create node" icon={<Plus className="h-[18px] w-[18px]" weight="regular" />} size="sm" shape="rounded" className="clash-workspace-icon-control clash-toolbar-button text-content-muted hover:text-content-primary" />
                                                    </Toolbar.Button>
                                                  </DropdownMenuTrigger>
                                                </Tooltip>
                                                <DropdownMenuContent aria-label="Create node" side="right" align="start" sideOffset={10} className="clash-canvas-menu-surface min-w-48">
                                                  <CanvasCreateMenuItems customActions={customActions} onSelect={handleToolClick} />
                                                </DropdownMenuContent>
                                              </DropdownMenu>

                                              <div className="flex h-[var(--clash-toolbar-section-gap)] w-full shrink-0 items-center justify-center">
                                                <Toolbar.Separator
                                                  orientation="horizontal"
                                                  className="h-px w-8 bg-warm-border/70"
                                                />
                                              </div>

                                              <div className="flex w-full flex-none flex-col items-center gap-0">
                                                <Tooltip
                                                  label="Auto Layout"
                                                  placement="right"
                                                >
                                                  <Toolbar.Button asChild>
                                                    <IconButton
                                                      label="Auto Layout"
                                                      icon={
                                                        <MagicWand
                                                          className="h-3.5 w-3.5"
                                                          weight="regular"
                                                        />
                                                      }
                                                      onClick={onLayout}
                                                      size="sm"
                                                      shape="rounded"
                                                      className="clash-workspace-icon-control clash-toolbar-button text-content-muted hover:text-content-primary"
                                                    />
                                                  </Toolbar.Button>
                                                </Tooltip>
                                                <Tooltip
                                                  label="Center view on nodes"
                                                  placement="right"
                                                >
                                                  <Toolbar.Button asChild>
                                                    <IconButton
                                                      label="Center view on nodes"
                                                      icon={
                                                        <Crosshair
                                                          className="h-3.5 w-3.5"
                                                          weight="bold"
                                                        />
                                                      }
                                                      onClick={
                                                        centerViewportOnAverageNodePosition
                                                      }
                                                      disabled={
                                                        nodes.length === 0
                                                      }
                                                      size="sm"
                                                      shape="rounded"
                                                      className="clash-workspace-icon-control clash-toolbar-button text-content-muted hover:text-content-primary"
                                                    />
                                                  </Toolbar.Button>
                                                </Tooltip>
                                                <Tooltip
                                                  label="Undo"
                                                  placement="right"
                                                >
                                                  <Toolbar.Button asChild>
                                                    <IconButton
                                                      label="Undo"
                                                      icon={
                                                        <ArrowCounterClockwise
                                                          className="h-[18px] w-[18px]"
                                                          weight="bold"
                                                        />
                                                      }
                                                      onClick={() =>
                                                        loroSync.undo()
                                                      }
                                                      disabled={
                                                        !loroSync.canUndo
                                                      }
                                                      size="sm"
                                                      shape="rounded"
                                                      className={`rounded-md ${
                                                        loroSync.canUndo
                                                          ? "clash-workspace-icon-control clash-toolbar-button text-content-muted hover:text-content-primary"
                                                          : "clash-workspace-icon-control cursor-not-allowed text-content-disabled"
                                                      }`}
                                                    />
                                                  </Toolbar.Button>
                                                </Tooltip>
                                                <Tooltip
                                                  label="Redo"
                                                  placement="right"
                                                >
                                                  <Toolbar.Button asChild>
                                                    <IconButton
                                                      label="Redo"
                                                      icon={
                                                        <ArrowClockwise
                                                          className="h-[18px] w-[18px]"
                                                          weight="bold"
                                                        />
                                                      }
                                                      onClick={() =>
                                                        loroSync.redo()
                                                      }
                                                      disabled={
                                                        !loroSync.canRedo
                                                      }
                                                      size="sm"
                                                      shape="rounded"
                                                      className={`rounded-md ${
                                                        loroSync.canRedo
                                                          ? "clash-workspace-icon-control clash-toolbar-button text-content-muted hover:text-content-primary"
                                                          : "clash-workspace-icon-control cursor-not-allowed text-content-disabled"
                                                      }`}
                                                    />
                                                  </Toolbar.Button>
                                                </Tooltip>
                                              </div>
                                            </Toolbar.Root>
                                          </motion.div>
                                        )}
                                      </div>
                                    </AgentAnnotationContextMenu>

                                    {nativeAgent ? (
                                      <McpProjectContext
                                        projectId={project.id}
                                        context={JSON.stringify({
                                          projectId: project.id,
                                          canvasId: activeCanvasId,
                                          surface: workspaceSurface,
                                          selectedNodeIds: selectedNodes.map(({ id }) => id),
                                          selectedNodes: selectedNodes.map(({ id, type, data }) => ({
                                            id, type,
                                            label: typeof data.label === "string" ? data.label : undefined,
                                          })),
                                        })}
                                      />
                                    ) : <Suspense fallback={null}><div
                                      id="copilot-container"
                                      className="fixed bottom-2 right-2 z-40 pointer-events-none"
                                      style={{
                                        top: "calc(var(--clash-desktop-chrome-height, 0px) + 0.5rem)",
                                      }}
                                    >
                                      <div className="pointer-events-auto h-full">
                                        <ChatbotCopilot
                                          key={sessionKey}
                                          projectId={project.id}
                                          threadId={threadId}
                                          initialMessages={
                                            EMPTY_COPILOT_MESSAGES
                                          }
                                          width={sidebarWidth}
                                          onWidthPreview={
                                            handleCopilotWidthPreview
                                          }
                                          onWidthChange={
                                            handleCopilotWidthChange
                                          }
                                          onResizeStateChange={
                                            handleCopilotResizeStateChange
                                          }
                                          isCollapsed={isSidebarCollapsed}
                                          onCollapseChange={
                                            setIsSidebarCollapsed
                                          }
                                          collapsedLauncherPlacement={
                                            workspaceSurface.kind === "canvas"
                                              ? "canvas"
                                              : "header"
                                          }
                                          layoutMode="floating"
                                          followingAgent={followingAgent}
                                          onFollowingAgentChange={
                                            setFollowingAgentMode
                                          }
                                          onAgentCanvasTarget={
                                            recordAgentTarget
                                          }
                                          onOpenClashEntity={
                                            openCopilotClashEntity
                                          }
                                          onAddNode={addNode}
                                          onRemoveNode={
                                            removeCanvasNodeFromCopilot
                                          }
                                          onAddEdge={addCanvasEdgeFromCopilot}
                                          onUpdateEdge={
                                            updateCanvasEdgeFromCopilot
                                          }
                                          onRemoveEdge={
                                            removeCanvasEdgeFromCopilot
                                          }
                                          onApplyTimeline={
                                            applyCanvasTimelineFromCopilot
                                          }
                                          nodes={copilotNodes}
                                          mentionSources={copilotMentionSources}
                                          workspaceContext={
                                            copilotWorkspaceContext
                                          }
                                          initialPrompt={chatInitialPrompt}
                                          sessionHistory={sessionHistory}
                                          sessionHistoryHasMore={
                                            sessionHistoryHasMore
                                          }
                                          sessionHistoryLoadingMore={
                                            sessionHistoryLoadingMore
                                          }
                                          onLoadMoreSessionHistory={
                                            loadMoreSessionHistory
                                          }
                                          onNewSession={handleNewSession}
                                          onSwitchSession={handleSwitchSession}
                                          onArchiveSession={
                                            handleArchiveSession
                                          }
                                          onRenameSession={handleRenameSession}
                                          onUpsertSession={upsertSession}
                                          onRuntimeSessionRouteChange={
                                            replaceProjectSessionRoute
                                          }
                                          onCreateSession={
                                            handleCopilotCreateSession
                                          }
                                          actorUserId={project.ownerId}
                                          annotationBlocks={
                                            pendingAgentAnnotations
                                          }
                                          onAnnotationRemove={
                                            removeAgentAnnotation
                                          }
                                          onAnnotationsSubmitted={
                                            clearSubmittedAgentAnnotations
                                          }
                                        />
                                      </div>
                                    </div></Suspense>}
                                  </div>
                                </div>
                              </div>
                            </TextNodeEditorProvider>
                          </LayoutActionsProvider>
                        </MediaViewerProvider>
                      </VideoEditorProvider>
                    </DirectorStageProvider>
                  </VideoClipperProvider>
                </ImageEditorProvider>
              </PluginViewProvider>
            </PresenceAwarenessProvider>
          </CustomActionsProvider>
        </LoroSyncProvider>
      </CanvasTransientUiProvider>
    </ProjectProvider>
  );
}
