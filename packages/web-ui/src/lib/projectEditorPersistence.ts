import type { ProjectWorkspaceSurface } from "../components/ProjectWorkspaceNavigator";
import {
  DEFAULT_MINIMAP_SIZE,
  MAX_MINIMAP_SIZE,
  MIN_EXPANDED_MINIMAP_SIZE,
  type MinimapSize,
} from "./canvasViewport";

export type CanvasMode = "select" | "hand";

export interface CanvasPreferences {
  mode: CanvasMode;
  minimapCollapsed: boolean;
  minimapSize: MinimapSize;
}

export interface PersistedCanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface PersistedCanvasView {
  viewport: PersistedCanvasViewport | null;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
}

export interface ProjectEditorSession {
  activeCanvasId: string;
  workspaceSurface: ProjectWorkspaceSurface;
  threadId: string | null;
  canvasViews: Record<string, PersistedCanvasView>;
}

const CANVAS_PREFERENCES_VERSION = 1;
const PROJECT_EDITOR_SESSION_VERSION = 1;
const CANVAS_PREFERENCES_STORAGE_KEY = "clash:canvas-preferences:v1";

const DEFAULT_CANVAS_PREFERENCES: CanvasPreferences = {
  mode: "hand",
  minimapCollapsed: false,
  minimapSize: DEFAULT_MINIMAP_SIZE,
};

function projectEditorSessionStorageKey(projectId: string): string {
  return `clash:project:${encodeURIComponent(projectId)}:editor-session:v1`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    return null;
  }
  return [...new Set(value)];
}

function storedMinimapSize(value: unknown): MinimapSize | null {
  if (!isRecord(value)) return null;
  const { width, height } = value;
  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width < MIN_EXPANDED_MINIMAP_SIZE.width ||
    width > MAX_MINIMAP_SIZE.width ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height < MIN_EXPANDED_MINIMAP_SIZE.height ||
    height > MAX_MINIMAP_SIZE.height
  ) {
    return null;
  }
  return { width, height };
}

function storedViewport(value: unknown): PersistedCanvasViewport | null {
  if (!isRecord(value)) return null;
  const { x, y, zoom } = value;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof zoom !== "number" ||
    !Number.isFinite(zoom) ||
    zoom <= 0
  ) {
    return null;
  }
  return { x, y, zoom };
}

function storedWorkspaceSurface(
  value: unknown,
): ProjectWorkspaceSurface | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "canvas":
      return isNonEmptyString(value.canvasId)
        ? { kind: "canvas", canvasId: value.canvasId }
        : null;
    case "plugin-view":
      return isNonEmptyString(value.nodeId) && isNonEmptyString(value.canvasId)
        ? {
            kind: "plugin-view",
            nodeId: value.nodeId,
            canvasId: value.canvasId,
          }
        : null;
    case "timeline":
      return isNonEmptyString(value.timelineId)
        ? { kind: "timeline", timelineId: value.timelineId }
        : null;
    case "director-stage":
      return isNonEmptyString(value.stageId)
        ? { kind: "director-stage", stageId: value.stageId }
        : null;
    case "text-asset":
      return isNonEmptyString(value.nodeId) && isNonEmptyString(value.canvasId)
        ? {
            kind: "text-asset",
            nodeId: value.nodeId,
            canvasId: value.canvasId,
          }
        : null;
    case "asset":
      return isNonEmptyString(value.assetId)
        ? { kind: "asset", assetId: value.assetId }
        : null;
    case "browser":
      return isNonEmptyString(value.browserId)
        ? { kind: "browser", browserId: value.browserId }
        : null;
    default:
      return null;
  }
}

export function loadCanvasPreferences(
  storage: Pick<Storage, "getItem">,
): CanvasPreferences {
  try {
    const raw = storage.getItem(CANVAS_PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CANVAS_PREFERENCES };
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== CANVAS_PREFERENCES_VERSION ||
      (parsed.mode !== "select" && parsed.mode !== "hand") ||
      typeof parsed.minimapCollapsed !== "boolean"
    ) {
      return { ...DEFAULT_CANVAS_PREFERENCES };
    }
    const minimapSize = storedMinimapSize(parsed.minimapSize);
    if (!minimapSize) return { ...DEFAULT_CANVAS_PREFERENCES };
    return {
      mode: parsed.mode,
      minimapCollapsed: parsed.minimapCollapsed,
      minimapSize,
    };
  } catch {
    return { ...DEFAULT_CANVAS_PREFERENCES };
  }
}

export function saveCanvasPreferences(
  storage: Pick<Storage, "setItem">,
  preferences: CanvasPreferences,
): void {
  try {
    storage.setItem(
      CANVAS_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: CANVAS_PREFERENCES_VERSION,
        mode: preferences.mode,
        minimapCollapsed: preferences.minimapCollapsed,
        minimapSize: preferences.minimapSize,
      }),
    );
  } catch {
    // Workspace chrome persistence is best-effort and must not block editing.
  }
}

export function loadProjectEditorSession(
  storage: Pick<Storage, "getItem">,
  projectId: string,
): ProjectEditorSession | null {
  try {
    const raw = storage.getItem(projectEditorSessionStorageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.version !== PROJECT_EDITOR_SESSION_VERSION ||
      !isNonEmptyString(parsed.activeCanvasId)
    ) {
      return null;
    }
    const workspaceSurface = storedWorkspaceSurface(parsed.workspaceSurface);
    if (!workspaceSurface || !isRecord(parsed.canvasViews)) return null;
    const threadId =
      parsed.threadId === undefined || parsed.threadId === null
        ? null
        : isNonEmptyString(parsed.threadId)
          ? parsed.threadId
          : undefined;
    if (threadId === undefined) return null;
    const canvasViews: Record<string, PersistedCanvasView> = {};
    for (const [canvasId, value] of Object.entries(parsed.canvasViews)) {
      if (!canvasId || !isRecord(value)) return null;
      const selectedNodeIds = stringList(value.selectedNodeIds);
      const selectedEdgeIds = stringList(value.selectedEdgeIds);
      const viewport =
        value.viewport === null ? null : storedViewport(value.viewport);
      if (
        !selectedNodeIds ||
        !selectedEdgeIds ||
        (value.viewport !== null && !viewport)
      ) {
        return null;
      }
      canvasViews[canvasId] = {
        viewport,
        selectedNodeIds,
        selectedEdgeIds,
      };
    }
    return {
      activeCanvasId: parsed.activeCanvasId,
      workspaceSurface,
      threadId,
      canvasViews,
    };
  } catch {
    return null;
  }
}

export function saveProjectEditorSession(
  storage: Pick<Storage, "setItem">,
  projectId: string,
  session: ProjectEditorSession,
): void {
  try {
    storage.setItem(
      projectEditorSessionStorageKey(projectId),
      JSON.stringify({
        version: PROJECT_EDITOR_SESSION_VERSION,
        activeCanvasId: session.activeCanvasId,
        workspaceSurface: session.workspaceSurface,
        threadId: session.threadId,
        canvasViews: session.canvasViews,
      }),
    );
  } catch {
    // Project view persistence is best-effort and must not block editing.
  }
}
