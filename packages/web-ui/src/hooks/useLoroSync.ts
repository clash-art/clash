import { createLogger } from "../lib/logger";
import { addCanvasGraph } from "../lib/addCanvasGraph";
import { applyCanvasLayout, type NodePatch } from "../lib/loroNodeSync";
import { useHostTimelines } from "./useHostTimelines";
import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { LoroDoc, UndoManager } from "loro-crdt";
import { archiveRejectedSync, readLatestSyncRecovery, type SyncRecoveryDraft } from "../lib/syncRecovery";
import { Node, Edge } from "@xyflow/react";
import {
  refreshRuntimeConfig,
  runtimeSyncWebSocketUrl,
  runtimeApiUrl,
} from "../lib/runtimeConfig";
import type {
  PresenceClient,
  ActivityMessage,
  AwarenessBroadcastMessage,
  ProjectLoadErrorMessage,
} from "@clash/shared-types";
import {
  Canvas,
  isCanvasNodeImmutable,
  projectVisibleNodeData,
  canvasGraphReconciliationChanged,
  DEFAULT_CANVAS_ID,
  createProjectCanvas,
  createProjectPluginView,
  type CreateTimelineOnCanvasInput,
  deleteProjectCanvas,
  ensureProjectCanvas,
  attachDirectorStageToCanvas,
  createProjectDirectorStage,
  createDirectorStageOnCanvas as createDirectorStageOnCanvasMutation,
  type CreateDirectorStageOnCanvasInput,
  listProjectCanvases,
  listProjectDirectorStages,
  projectDirectorStageReadToken,
  reconcileCanvasGraph,
  reconcileProjectDirectorStageOwnership,
  renameProjectCanvas,
  updateProjectDirectorStageState,
  detachDirectorStageFromCanvas,
  canvasBatchDeleteReadToken,
  canvasEdgeReadToken,
  canvasEdgesReadToken,
  canvasNodeReadToken,
  hostMutationRejected,
  hostMutationSucceeded,
  isSidebandMessage,
  validateHostMutationEnvelope,
  validateCanvasBatchDeleteReadProof,
  validateCanvasDelete,
  validateCanvasBatchDelete,
  validateCanvasEdgeAdd,
  validateCanvasEdgeDelete,
  validateCanvasEdgePatch,
  validateCanvasEdgeReadProof,
  validateCanvasEdgesReadProof,
  validateCanvasNodePatch,
  validateCanvasReadProof,
  validateAgentObservation,
  type HostMutationEnvelope,
  type HostMutationRecord,
  type CreateLinkedNodeResult,
  type ProjectCanvas,
  type ProjectCanvasDeleteResult,
  type ProjectCanvasMutationResult,
  type ProjectPluginViewMutationResult,
  type ExecutablePluginViewReference,
  type ProjectTimeline,
  type ProjectTimelineDeleteResult,
  type ProjectTimelineMutationResult,
  type ProjectDirectorStage,
  type ProjectDirectorStageMutationResult,
} from "@clash/shared-types";
import { sanitizeNodesForReactFlow } from "../lib/canvasNodeOrder";
import { LoroProtocolClientSession } from "@clash/replica/loro-protocol";

function officialLoroProtocolUrl(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}protocol=loro-v1`;
}

const syncLog = createLogger("sync");

function reconcileImportedWorkspace(doc: LoroDoc): void {
  const graph = reconcileCanvasGraph(doc);
  const directorStages = reconcileProjectDirectorStageOwnership(doc);
  if (
    canvasGraphReconciliationChanged(graph) ||
    directorStages.removedActionNodeIds.length > 0 ||
    directorStages.detachedStageIds.length > 0
  ) {
    doc.commit({ origin: "sys:workspace-reconcile" });
  }
}

interface LoroSyncOptions {
  projectId: string;
  canvasId?: string;
  syncServerUrl?: string;
  onNodesChange?: (nodes: Node[]) => void;
  onEdgesChange?: (edges: Edge[]) => void;
  onTaskUpdate?: (taskId: string, taskData: any) => void;
  onPresenceChange?: (clients: PresenceClient[]) => void;
  onActivity?: (activity: ActivityMessage) => void;
  onMutation?: (mutation: HostMutationRecord) => void;
  /**
   * Live cursor + selection awareness from peers.
   *
   * Server fans out the latest snapshot of every connected browser client
   * except the recipient. This callback is called every time that snapshot
   * changes (throttled server-side to ~12Hz).
   */
  onAwareness?: (msg: AwarenessBroadcastMessage) => void;
}

type LoroHostWriteOptions = {
  actorClientType?: string;
  ifMatch?: string;
};

export interface UseLoroSyncReturn {
  /** The project ID this sync is connected to */
  projectId: string;
  doc: LoroDoc | null;
  connected: boolean;
  syncRejected: boolean;
  projectLoadError: ProjectLoadErrorMessage | undefined;
  retryProjectLoad: () => void;
  recoveryDraft: SyncRecoveryDraft | undefined;
  prepareSyncRecovery: () => Promise<void>;
  /** Whether initial load from IndexedDB is complete */
  isInitialized: boolean;
  canvases: ProjectCanvas[];
  createCanvas: (input: {
    id: string;
    name: string;
  }) => ProjectCanvasMutationResult;
  createPluginView: (input: {
    nodeId: string;
    label: string;
    view: ExecutablePluginViewReference;
    state: unknown;
    canvasId?: string;
  }) => ProjectPluginViewMutationResult;
  renameCanvas: (canvasId: string, name: string) => ProjectCanvasMutationResult;
  deleteCanvas: (canvasId: string) => ProjectCanvasDeleteResult;
  timelines: ProjectTimeline[];
  timelineError: string | null;
  standaloneTimelines: ProjectTimeline[];
  createTimelineOnCanvas: (input: Omit<CreateTimelineOnCanvasInput, "canvasId"> & { canvasId?: string }) => Promise<ProjectTimelineMutationResult>;
  createTimeline: (input: {
    id: string;
    name: string;
    state: unknown;
  }) => Promise<ProjectTimelineMutationResult>;
  deleteTimeline: (
    timelineId: string,
    expectedReadToken?: string,
  ) => Promise<ProjectTimelineDeleteResult>;
  attachTimeline: (input: {
    timelineId: string;
    canvasId?: string;
    actionNodeId: string;
    position?: { x: number; y: number };
  }) => Promise<ProjectTimelineMutationResult>;
  detachTimeline: (timelineId: string) => Promise<ProjectTimelineMutationResult>;
  directorStages: ProjectDirectorStage[];
  standaloneDirectorStages: ProjectDirectorStage[];
  createDirectorStageOnCanvas: (input: Omit<CreateDirectorStageOnCanvasInput, "canvasId"> & { canvasId?: string }) => ProjectDirectorStageMutationResult;
  createDirectorStage: (input: {
    id: string;
    name: string;
    state: unknown;
  }) => ProjectDirectorStageMutationResult;
  attachDirectorStage: (input: {
    stageId: string;
    canvasId?: string;
    actionNodeId: string;
    position?: { x: number; y: number };
  }) => ProjectDirectorStageMutationResult;
  detachDirectorStage: (stageId: string) => ProjectDirectorStageMutationResult;
  applyDirectorStageState: (
    stageId: string,
    state: unknown,
    options?: LoroHostWriteOptions,
  ) => boolean;
  addNodeToCanvas: (canvasId: string, nodeId: string, nodeData: any) => boolean;
  addNode: (nodeId: string, nodeData: any) => boolean;
  addGraph: (nodes: Node[], edges: Edge[]) => boolean;
  createLinkedNode: (input: {
    nodeId: string;
    nodeType: string;
    data: Record<string, unknown>;
    parentId: string | null;
    sourceNodeId: string;
    edgeId?: string;
    edgeType?: string;
    canvasId?: string;
  }) => CreateLinkedNodeResult | null;
  updateNode: (
    nodeId: string,
    nodeData: any,
    options?: LoroHostWriteOptions,
  ) => boolean;
  applyLayout: (patches: NodePatch[]) => boolean;
  applyTimelineState: (
    timelineId: string,
    timelineDsl: unknown,
    options?: LoroHostWriteOptions,
  ) => Promise<ProjectTimeline | false>;
  applyTimelineDsl: (
    nodeId: string,
    timelineDsl: unknown,
    options?: LoroHostWriteOptions,
  ) => Promise<boolean>;
  requestTimelineRender: (
    timelineId: string,
    options: { actorUserId: string; actorAgentId?: string },
  ) => ReturnType<ReturnType<typeof useHostTimelines>["requestTimelineRender"]>;
  removeNode: (nodeId: string, options?: LoroHostWriteOptions) => boolean;
  removeNodes: (nodeIds: string[], options?: LoroHostWriteOptions) => boolean;
  addEdge: (
    edgeId: string,
    edgeData: any,
    options?: LoroHostWriteOptions,
  ) => boolean;
  updateEdge: (
    edgeId: string,
    edgeData: any,
    options?: LoroHostWriteOptions,
  ) => boolean;
  removeEdge: (edgeId: string, options?: LoroHostWriteOptions) => boolean;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Send a JSON sideband message over the same WS used for binary CRDT sync.
   * Best-effort: silently dropped if the socket isn't OPEN (the server side
   * tolerates missing presence updates — disconnect releases any held lock
   * automatically). Currently used for the timeline soft edit-lock.
   */
  sendSideband: (msg: object) => void;
}

// IndexedDB helpers
const DB_NAME = "loro-sync-db";
const STORE_NAME = "snapshots";

// Schema version for migration - increment when data format changes
// v1-reference-only: Timeline DSL uses assetId references only, no redundant src/type
// v2-sanitize-parentid: Force clear IndexedDB to fix invalid parentId references
const LORO_SCHEMA_VERSION = "v2-sanitize-parentid";

const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
};

// Returns true if the IndexedDB appears corrupted (NotReadableError). Caller should wipe and continue.
const isCorruptionError = (err: unknown): boolean => {
  const name = (err as { name?: string })?.name;
  return name === "NotReadableError" || name === "InvalidStateError";
};

const wipeDB = async (): Promise<void> => {
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onerror = () => resolve();
      req.onsuccess = () => resolve();
      req.onblocked = () => resolve();
    });
  } catch {
    // best-effort
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readProofEdges(
  rawEdges: Iterable<[unknown, unknown]>,
): Array<Record<string, unknown> & { id: string }> {
  const edges: Array<Record<string, unknown> & { id: string }> = [];
  for (const [edgeId, rawEdge] of rawEdges) {
    if (typeof edgeId !== "string" || !isRecord(rawEdge)) continue;
    edges.push({ id: edgeId, ...rawEdge });
  }
  return edges;
}

function readGuardrailNodes(
  rawNodes: Iterable<[unknown, unknown]>,
  canvasId?: string,
): Array<{ id: string; type?: string; data?: Record<string, unknown> }> {
  const nodes: Array<{
    id: string;
    type?: string;
    data?: Record<string, unknown>;
  }> = [];
  for (const [id, rawNode] of rawNodes) {
    if (typeof id !== "string" || !isRecord(rawNode)) continue;
    const nodeCanvasId =
      typeof rawNode.canvasId === "string"
        ? rawNode.canvasId
        : DEFAULT_CANVAS_ID;
    if (canvasId && nodeCanvasId !== canvasId) continue;
    nodes.push({
      id,
      type: typeof rawNode.type === "string" ? rawNode.type : undefined,
      data: isRecord(rawNode.data) ? rawNode.data : undefined,
    });
  }
  return nodes;
}

function readNodeToken(nodeId: string, rawNode: unknown): string | undefined {
  if (!isRecord(rawNode)) return undefined;
  return canvasNodeReadToken({
    id: nodeId,
    type: typeof rawNode.type === "string" ? rawNode.type : undefined,
    data: isRecord(rawNode.data) ? rawNode.data : undefined,
    parentId: typeof rawNode.parentId === "string" ? rawNode.parentId : null,
    parent_id: typeof rawNode.parent_id === "string" ? rawNode.parent_id : null,
    position: rawNode.position,
  });
}

function readProofNode(nodeId: string, rawNode: unknown) {
  if (!isRecord(rawNode)) return null;
  return {
    id: nodeId,
    type: typeof rawNode.type === "string" ? rawNode.type : undefined,
    data: isRecord(rawNode.data) ? rawNode.data : undefined,
    parentId: typeof rawNode.parentId === "string" ? rawNode.parentId : null,
    parent_id: typeof rawNode.parent_id === "string" ? rawNode.parent_id : null,
    position: rawNode.position,
  };
}

function readEdgeToken(edgeId: string, rawEdge: unknown): string | undefined {
  if (!isRecord(rawEdge)) return undefined;
  return canvasEdgeReadToken({ id: edgeId, ...rawEdge });
}

function readEdgesToken(rawEdges: Iterable<[unknown, unknown]>): string {
  return canvasEdgesReadToken(readProofEdges(rawEdges));
}

function readBatchDeleteToken(
  nodeIds: string[],
  rawNodes: Iterable<[unknown, unknown]>,
  rawEdges: Iterable<[unknown, unknown]>,
): string {
  const nodeIdSet = new Set(nodeIds);
  const nodes = [...rawNodes]
    .map(([nodeId, rawNode]) =>
      typeof nodeId === "string" && nodeIdSet.has(nodeId)
        ? readProofNode(nodeId, rawNode)
        : null,
    )
    .filter((node): node is NonNullable<ReturnType<typeof readProofNode>> =>
      Boolean(node),
    );
  return canvasBatchDeleteReadToken({
    nodes,
    edges: readProofEdges(rawEdges),
  });
}

function readProofEdge(edgeId: string, rawEdge: unknown) {
  if (!isRecord(rawEdge)) return null;
  return { id: edgeId, ...rawEdge };
}

const saveToDB = async (
  projectId: string,
  snapshot: Uint8Array,
): Promise<void> => {
  try {
    const db = await initDB();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error("Snapshot save aborted"));
        transaction.onerror = () => reject(transaction.error);
        transaction.objectStore(STORE_NAME).put(snapshot, projectId);
      });
    } finally { db.close(); }
  } catch (err) {
    syncLog.error("sync.snapshot_save_failed", { projectId, error: err });
    if (isCorruptionError(err)) await wipeDB();
  }
};

const loadFromDB = async (
  projectId: string,
): Promise<Uint8Array | undefined> => {
  try {
    const db = await initDB();
    try {
      return await new Promise<Uint8Array | undefined>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).get(projectId);
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error ?? new Error("Snapshot load aborted"));
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  } catch (err) {
    syncLog.error("sync.snapshot_load_failed", { projectId, error: err });
    if (isCorruptionError(err)) await wipeDB();
    return undefined;
  }
};

/**
 * Custom hook for Loro CRDT sync with the sync server
 * Manages WebSocket connection and document synchronization
 *
 * Architecture:
 * - Loro doc is the source of truth for persistence/sync
 * - React state is derived from Loro for UI
 * - Local changes: update Loro doc -> subscribeLocalUpdate sends to server
 * - Remote changes: import into Loro doc -> subscribe updates React state
 */
export function useLoroSync(options: LoroSyncOptions): UseLoroSyncReturn {
  const {
    projectId,
    canvasId = DEFAULT_CANVAS_ID,
    syncServerUrl,
    onNodesChange,
    onEdgesChange,
    onTaskUpdate,
    onPresenceChange,
    onActivity,
    onMutation,
    onAwareness,
  } = options;

  const [replica] = useState(() => {
    const doc = new LoroDoc();
    try {
      return {
        doc,
        // Group batched commits; keep internal repairs out of user history.
        undoManager: new UndoManager(doc, {
          mergeInterval: 300,
          maxUndoSteps: 200,
          excludeOriginPrefixes: ["sys:"],
        }),
        active: false,
        disposed: false,
      };
    } catch (error) { doc.free(); throw error; }
  });
  const { doc, undoManager } = replica;
  useEffect(() => {
    replica.active = true;
    return () => {
      replica.active = false;
      // Let all subscriptions detach and capture the final snapshot first.
      // StrictMode replays effects synchronously using the same replica, so a
      // reacquired owner cancels disposal. A final unmount frees native memory.
      queueMicrotask(() => {
        if (replica.active || replica.disposed) return;
        replica.disposed = true;
        try { undoManager.free(); } finally { doc.free(); }
      });
    };
  }, [replica, doc, undoManager]);

  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const protocolSessionRef = useRef<LoroProtocolClientSession | null>(null);
  const [connected, setConnected] = useState(false);
  const [syncRejected, setSyncRejected] = useState(false);
  const [projectLoadError, setProjectLoadError] = useState<ProjectLoadErrorMessage>();
  const projectLoadFailedRef = useRef(false);
  const [recoveryDraft, setRecoveryDraft] = useState<SyncRecoveryDraft>();
  const recoveryPreparedRef = useRef(false);
  const pendingSnapshotSaveRef = useRef(Promise.resolve());
  const [isInitialized, setIsInitialized] = useState(false);

  // Stash callbacks in a ref so init / subscribe effects don't re-run when the caller
  // passes inline closures (which get a new reference on every parent render).
  const [canvases, setCanvases] = useState<ProjectCanvas[]>([]);
  const {
    timelines, timelineError, createTimeline, createTimelineOnCanvas,
    deleteTimeline, attachTimeline, detachTimeline, applyTimelineState, requestTimelineRender,
  } = useHostTimelines({ projectId, doc, canvasId, connected, onMutation });
  const [directorStages, setDirectorStages] = useState<ProjectDirectorStage[]>(
    [],
  );

  useEffect(() => {
    if (doc.getMap("canvases").size === 0) {
      ensureProjectCanvas(doc, DEFAULT_CANVAS_ID);
      doc.commit({ origin: "sys:canvas-registry" });
    }
    setCanvases(listProjectCanvases(doc));
    setDirectorStages(listProjectDirectorStages(doc));
  }, [doc]);

  // Stash callbacks in a ref so init / subscribe effects don't re-run when the caller
  // passes inline closures (which get a new reference on every parent render).
  const callbacksRef = useRef({
    onNodesChange,
    onEdgesChange,
    onTaskUpdate,
    onPresenceChange,
    onActivity,
    onMutation,
    onAwareness,
  });
  useEffect(() => {
    callbacksRef.current = {
      onNodesChange,
      onEdgesChange,
      onTaskUpdate,
      onPresenceChange,
      onActivity,
      onMutation,
      onAwareness,
    };
  }, [
    onNodesChange,
    onEdgesChange,
    onTaskUpdate,
    onPresenceChange,
    onActivity,
    onMutation,
    onAwareness,
  ]);

  // Track pending local updates that haven't been acknowledged by server

  // Update undo/redo state.
  //
  // Loro's `doc.subscribe` fires synchronously during commit, and our listener
  // may run BEFORE the UndoManager's own internal subscription has pushed the
  // new op onto its stack. Reading `canUndo()` at that moment returns stale
  // `false`. Defer one microtask so every subscriber has drained.
  const updateUndoRedoState = useCallback(() => {
    queueMicrotask(() => {
      if (!replica.active) return;
      setCanUndo(undoManager.canUndo());
      setCanRedo(undoManager.canRedo());
    });
  }, [replica, undoManager]);

  // Helper to read current state from Loro doc
  const readStateFromLoro = useCallback(() => {
    const nodesMap = doc.getMap("nodes");
    const tasksMap = doc.getMap("tasks");

    const nodeIds = new Set<string>();
    for (const [key, value] of nodesMap.entries()) {
      if (!isRecord(value)) continue;
      const nodeCanvasId =
        typeof value.canvasId === "string" ? value.canvasId : DEFAULT_CANVAS_ID;
      if (nodeCanvasId === canvasIdRef.current) nodeIds.add(key);
    }

    const nodes: Node[] = [];

    for (const [key, value] of nodesMap.entries()) {
      const nodeData = value as any;
      // Validate parentId - remove if parent doesn't exist to prevent ReactFlow errors
      if (!nodeIds.has(key)) continue;
      // Validate parentId - remove if parent doesn't exist to prevent ReactFlow errors
      if (nodeData.parentId && !nodeIds.has(nodeData.parentId)) {
        const { parentId: _parentId, extent: _extent, ...rest } = nodeData;
        const cleanedData = { ...rest, parentId: undefined, extent: undefined };
        nodes.push({ id: key, ...cleanedData });
      } else {
        nodes.push({ id: key, ...nodeData });
      }
    }

    const sortedNodes = sanitizeNodesForReactFlow(nodes);

    const edges: Edge[] = new Canvas(doc, () => {}, canvasIdRef.current)
      .listEdges()
      .map((edge) => ({
        ...edge,
        interactionWidth: 30,
        focusable: true,
        selectable: true,
        deletable: true,
      }));

    const tasks: Array<{ id: string; data: any }> = [];
    for (const [key, value] of tasksMap.entries()) {
      tasks.push({ id: key, data: value });
    }

    return { nodes: sortedNodes, edges, tasks };
  }, [doc]);

  // Load from local storage on mount - MUST complete before WebSocket connects
  useEffect(() => {
    if (!isInitialized) return;
    const { nodes, edges, tasks } = readStateFromLoro();
    const cb = callbacksRef.current;
    cb.onNodesChange?.(nodes);
    cb.onEdgesChange?.(edges);
    if (cb.onTaskUpdate)
      tasks.forEach((task) => cb.onTaskUpdate?.(task.id, task.data));
  }, [canvasId, isInitialized, readStateFromLoro]);

  // Load from local storage on mount - MUST complete before WebSocket connects
  useEffect(() => {
    let mounted = true;
    const initialize = async () => {
      // Step 0: Record the schema marker without deleting the snapshot.
      // Imported documents are migrated by reconcileImportedWorkspace below;
      // deleting first would discard offline changes that the server cannot restore.
      const versionKey = `loro-schema-version-${projectId}`;
      const currentVersion = localStorage.getItem(versionKey);

      if (currentVersion !== LORO_SCHEMA_VERSION) {
        syncLog.info("sync.snapshot_migrating", { projectId, currentVersion, expected: LORO_SCHEMA_VERSION });
        localStorage.setItem(versionKey, LORO_SCHEMA_VERSION);
      }

      // Step 1: Load from IndexedDB
      const snapshot = await loadFromDB(projectId);
      if (!mounted) return;
      try {
        const db = await initDB();
        try { const backup = await readLatestSyncRecovery(db, projectId); if (mounted) setRecoveryDraft(backup); }
        finally { db.close(); }
      } catch (error) { syncLog.error("sync.recovery_read_failed", { projectId, error }); }
      if (!mounted) return;

      if (snapshot) {
        try {
          doc.import(snapshot);
          reconcileImportedWorkspace(doc);
        } catch (err) {
          syncLog.error("sync.snapshot_import_failed", { projectId, error: err });
        }
      }

      // Step 2: Update React state from Loro
      const { nodes, edges, tasks } = readStateFromLoro();
      const cb = callbacksRef.current;
      if (cb.onNodesChange && nodes.length > 0) {
        cb.onNodesChange(nodes);
      }
      if (cb.onEdgesChange && edges.length > 0) {
        cb.onEdgesChange(edges);
      }
      if (cb.onTaskUpdate) {
        tasks.forEach((t) => cb.onTaskUpdate!(t.id, t.data));
      }

      updateUndoRedoState();
      setCanvases(listProjectCanvases(doc));
        setDirectorStages(listProjectDirectorStages(doc));
      setIsInitialized(true);
    };

    initialize();
    return () => {
      mounted = false;
    };
  }, [projectId, doc, readStateFromLoro, updateUndoRedoState]);

  // Subscribe to document changes - only for remote updates
  useEffect(() => {
    if (!isInitialized) return;

    // Each document owns its save timer. Coalesce serialization as well as I/O;
    // a different project must never cancel this document's pending save.
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const flushSnapshot = () => {
      if (saveTimer === undefined) return;
      clearTimeout(saveTimer);
      saveTimer = undefined;
      if (recoveryPreparedRef.current) return;
      const snapshot = doc.export({ mode: "snapshot" });
      pendingSnapshotSaveRef.current = pendingSnapshotSaveRef.current.then(() => saveToDB(projectId, snapshot));
    };
    const unsubscribe = doc.subscribe((event: any) => {
      // event.by: "local" | "import" | "checkout"
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = setTimeout(flushSnapshot, 1000);

      // Update undo/redo state
      updateUndoRedoState();
      setCanvases(listProjectCanvases(doc));
        setDirectorStages(listProjectDirectorStages(doc));

      // CRITICAL: Only update React state for REMOTE changes
      // Local changes are already in React state - updating would cause loops/overwrites
      if (event.by === "local") {
        return;
      }

      // Read fresh state from Loro and update React
      const { nodes, edges, tasks } = readStateFromLoro();

      const cb = callbacksRef.current;
      if (cb.onNodesChange) {
        cb.onNodesChange(nodes);
      }
      if (cb.onEdgesChange) {
        cb.onEdgesChange(edges);
      }
      if (cb.onTaskUpdate) {
        tasks.forEach((t) => cb.onTaskUpdate!(t.id, t.data));
      }
    });

    return () => {
      unsubscribe();
      // Capture pending edits before switching project/canvas or unmounting.
      flushSnapshot();
    };
  }, [doc, isInitialized, projectId, readStateFromLoro, updateUndoRedoState]);

  // WebSocket connection state
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryCountRef = useRef(0);
  const isUnmountingRef = useRef(false);
  const rejectedSyncRef = useRef(false);
  const prepareSyncRecovery = useCallback(async () => {
    if (!rejectedSyncRef.current) throw new Error("Sync has not been rejected.");
    if (recoveryPreparedRef.current) throw new Error("Recovery is already prepared. Reload the project.");
    recoveryPreparedRef.current = true;
    try {
      // Capture while the editor still owns the document. Queued writes must
      // finish before archiving, but navigation need not retain native memory.
      const snapshot = doc.export({ mode: "snapshot" });
      await pendingSnapshotSaveRef.current;
      const db = await initDB();
      try {
        const draft = await archiveRejectedSync(db, projectId, snapshot);
        if (replica.active) setRecoveryDraft(draft);
      }
      finally { db.close(); }
    } catch (error) { recoveryPreparedRef.current = false; throw error; }
  }, [replica, doc, projectId]);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    protocolSessionRef.current?.destroy();
    protocolSessionRef.current = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }, []);

  // Send a JSON sideband message (presence-style) on the same WS. Best-effort:
  // if the socket isn't open we silently drop. The server treats absence of
  // presence updates as "no lock held", which is the right semantic for a
  // soft-lock. A disconnected client may keep editing its local replica, but
  // it cannot advertise or hold a remote presence lock until reconnect.
  const sendSideband = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // Send failure is recoverable: next openEditor / closeEditor will retry.
      }
    }
  }, []);

  // Forward declaration for recursion
  const connectRef = useRef<() => void>(() => {});

  const retryProjectLoad = useCallback(() => {
    if (!projectLoadFailedRef.current || rejectedSyncRef.current) return;
    projectLoadFailedRef.current = false;
    setProjectLoadError(undefined);
    retryCountRef.current = 0;
    connectRef.current();
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (rejectedSyncRef.current || projectLoadFailedRef.current) return;
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    const delay = Math.min(500 * Math.pow(1.5, retryCountRef.current), 5000);
    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectTimeoutRef.current = null;
      retryCountRef.current++;
      void (async () => {
        if (!syncServerUrl) {
          try {
            await refreshRuntimeConfig();
          } catch (error) {
            syncLog.warn("sync.host_refresh_failed", { projectId, error });
          }
        }
        // Recompute the runtime WebSocket URL after Host discovery refresh.
        // onopen sends the full local snapshot, so offline local commits are
        // merged into the replacement Host instead of remaining UI-only.
        connectRef.current();
      })();
    }, delay);
  }, [projectId, syncServerUrl]);

  // Connect function - only called after initialization
  const connect = useCallback(() => {
    if (isUnmountingRef.current || rejectedSyncRef.current || projectLoadFailedRef.current) return;

    disconnect();

    const baseWsUrl = syncServerUrl
      ? `${syncServerUrl.replace(/\/+$/, "")}/sync/${encodeURIComponent(projectId)}`
      : runtimeSyncWebSocketUrl(projectId);
    const wsUrl = officialLoroProtocolUrl(baseWsUrl);
    syncLog.debug("sync.connecting", () => ({ projectId, attempt: retryCountRef.current }));

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    const protocolSession = new LoroProtocolClientSession({
      roomId: projectId,
      doc,
      send: (frame) => {
        if (ws.readyState !== WebSocket.OPEN) {
          throw new Error("Loro WebSocket is not open");
        }
        ws.send(frame);
      },
      onError: (error) => {
        syncLog.error("sync.protocol_failed", { projectId, error });
      },
      onUpdateRejected: (batchId, status) => {
        syncLog.error("sync.update_rejected", { projectId, batchId, status });
        rejectedSyncRef.current = true;
        setSyncRejected(true);
        setConnected(false);
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        callbacksRef.current.onMutation?.(hostMutationRejected({
          operation: "project_sync", entity: { kind: "project", id: projectId },
        }, "The Host rejected this update. These local changes were not saved to the project. Sync is paused and the local draft is retained for recovery."));
        ws.close();
      },
    });
    protocolSessionRef.current?.destroy();
    protocolSessionRef.current = protocolSession;

    ws.onopen = () => {
      if (isUnmountingRef.current || wsRef.current !== ws) {
        ws.close();
        return;
      }
      syncLog.info("sync.connected", { projectId, retryCount: retryCountRef.current });
      setConnected(true);
      retryCountRef.current = 0;

      // Version-vector handshake catches up both sides and uploads offline work.
      protocolSession.join();
    };

    ws.onmessage = async (event) => {
      if (isUnmountingRef.current || wsRef.current !== ws) return;
      // Text messages = JSON sideband (presence/activity)
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (isSidebandMessage(msg)) {
            if (msg.type === "project.load-error" && msg.projectId === projectId) {
              projectLoadFailedRef.current = true;
              setProjectLoadError(msg);
              setConnected(false);
              if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
              ws.close();
            } else if (
              msg.type === "presence" &&
              callbacksRef.current.onPresenceChange
            ) {
              callbacksRef.current.onPresenceChange(msg.clients);
            } else if (
              msg.type === "activity" &&
              callbacksRef.current.onActivity
            ) {
              callbacksRef.current.onActivity(msg);
            } else if (
              msg.type === "awareness.broadcast" &&
              callbacksRef.current.onAwareness
            ) {
              callbacksRef.current.onAwareness(msg);
            }
          }
        } catch {
          // Ignore unparseable text messages
        }
        return;
      }

      // Binary messages = Loro CRDT updates
      try {
        const frame = new Uint8Array(event.data);
        await protocolSession.receive(frame);
      } catch (error: any) {
        syncLog.error("sync.frame_failed", { projectId, error });
      }
    };

    ws.onerror = () => {
      syncLog.debug("sync.transport_error", () => ({ projectId, readyState: ws.readyState }));
    };

    ws.onclose = (event) => {
      protocolSession.destroy();
      if (wsRef.current !== ws) return;
      syncLog[isUnmountingRef.current || event.code === 1000 || rejectedSyncRef.current ? "debug" : "warn"]("sync.disconnected", {
        projectId,
        retryCount: retryCountRef.current,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      setConnected(false);
      disconnect();
      if (!isUnmountingRef.current) {
        scheduleReconnect();
      }
    };
  }, [projectId, syncServerUrl, doc, scheduleReconnect, disconnect]);

  // Keep ref updated
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Only connect WebSocket AFTER initialization is complete
  useEffect(() => {
    if (!isInitialized) return;

    isUnmountingRef.current = false;

    connect();

    return () => {
      isUnmountingRef.current = true;
      disconnect();
      if (reconnectTimeoutRef.current)
        clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    };
  }, [isInitialized, connect, disconnect]);

  // Helper methods for modifying the document
  // Note: subscribeLocalUpdate automatically sends changes to server
  // So we just need to modify the Loro doc - no manual export needed
  const addNodeToCanvas = useCallback(
    (targetCanvasId: string, nodeId: string, nodeData: any) => {
      const nodesMap = doc.getMap("nodes");
      if (!doc.getMap("canvases").get(targetCanvasId)) {
        callbacksRef.current.onMutation?.(
          hostMutationRejected(
            {
              operation: "canvas_add_node",
              entity: { kind: "canvas-node", id: nodeId },
            },
            `Canvas ${targetCanvasId} not found`,
          ),
        );
        return false;
      }
      const existing = nodesMap.get(nodeId);
      if (existing !== undefined) {
        syncLog.warn("canvas.node_add_rejected", { nodeId: nodeId, reason: "node_exists" });
        callbacksRef.current.onMutation?.(
          hostMutationRejected(
            {
              operation: "canvas_add_node",
              entity: { kind: "canvas-node", id: nodeId },
              beforeReadToken: readNodeToken(nodeId, existing),
            },
            `Node already exists: ${nodeId}`,
          ),
        );
        return false;
      }
      try {
        new Canvas(doc, () => {}, targetCanvasId).insertNodeRecord(nodeId, {
          ...nodeData,
          canvasId: targetCanvasId,
          data: projectVisibleNodeData(
            isRecord(nodeData?.data) ? nodeData.data : {},
          ),
          upstream: Array.isArray(nodeData?.upstream) ? nodeData.upstream : [],
        });
      } catch (error) {
        callbacksRef.current.onMutation?.(
          hostMutationRejected(
            {
              operation: "canvas_add_node",
              entity: { kind: "canvas-node", id: nodeId },
            },
            error instanceof Error ? error.message : String(error),
          ),
        );
        return false;
      }
      doc.commit(); // Commit to trigger subscribeLocalUpdate
      const projection = readStateFromLoro();
      callbacksRef.current.onNodesChange?.(projection.nodes);
      callbacksRef.current.onEdgesChange?.(projection.edges);
      updateUndoRedoState();
      callbacksRef.current.onMutation?.(
        hostMutationSucceeded(
          {
            operation: "canvas_add_node",
            entity: { kind: "canvas-node", id: nodeId },
          },
          {
            resultEntityId: nodeId,
            afterReadToken: readNodeToken(nodeId, nodesMap.get(nodeId)),
          },
        ),
      );
      return true;
    },
    [doc, readStateFromLoro, updateUndoRedoState],
  );

  const addNode = useCallback(
    (nodeId: string, nodeData: any) =>
      addNodeToCanvas(canvasId, nodeId, nodeData),
    [addNodeToCanvas, canvasId],
  );

  const addGraph = useCallback(
    (nodes: Node[], edges: Edge[]) => {
      let success = true;
      try {
        addCanvasGraph(doc, canvasId, nodes, edges);
      } catch (error) {
        success = false;
        callbacksRef.current.onMutation?.(hostMutationRejected(
          { operation: "canvas_add_graph", entity: { kind: "canvas-node", id: nodes[0]?.id ?? canvasId } },
          error instanceof Error ? error.message : String(error),
        ));
      }
      const projection = readStateFromLoro();
      callbacksRef.current.onNodesChange?.(projection.nodes);
      callbacksRef.current.onEdgesChange?.(projection.edges);
      updateUndoRedoState();
      return success;
    },
    [doc, canvasId, readStateFromLoro, updateUndoRedoState],
  );

  const createLinkedNode = useCallback(
    (input: {
      nodeId: string;
      nodeType: string;
      data: Record<string, unknown>;
      parentId: string | null;
      sourceNodeId: string;
      edgeId?: string;
      edgeType?: string;
      canvasId?: string;
    }): CreateLinkedNodeResult | null => {
      const targetCanvasId = input.canvasId ?? canvasIdRef.current;
      try {
        const result = new Canvas(
          doc,
          () => {},
          targetCanvasId,
        ).createLinkedNode({
          nodeId: input.nodeId,
          nodeType: input.nodeType,
          data: projectVisibleNodeData(input.data),
          parentId: input.parentId,
          sourceNodeId: input.sourceNodeId,
          ...(input.edgeId ? { edgeId: input.edgeId } : {}),
          ...(input.edgeType ? { edgeType: input.edgeType } : {}),
        });
        doc.commit();
        const projection = readStateFromLoro();
        callbacksRef.current.onNodesChange?.(projection.nodes);
        callbacksRef.current.onEdgesChange?.(projection.edges);
        updateUndoRedoState();
        return result;
      } catch (error) {
        syncLog.warn("canvas.linked_node_rejected", { nodeId: input.nodeId, error });
        return null;
      }
    },
    [doc, readStateFromLoro, updateUndoRedoState],
  );

  const createCanvas = useCallback(
    (input: { id: string; name: string }) => {
      const result = createProjectCanvas(doc, input);
      if (result.ok) {
        doc.commit();
        setCanvases(listProjectCanvases(doc));
        const state = readStateFromLoro();
        callbacksRef.current.onNodesChange?.(state.nodes);
        callbacksRef.current.onEdgesChange?.(state.edges);
      }
      return result;
    },
    [doc, readStateFromLoro],
  );

  const createPluginView = useCallback(
    (input: {
      nodeId: string;
      label: string;
      view: ExecutablePluginViewReference;
      state: unknown;
      canvasId?: string;
    }) => {
      const result = createProjectPluginView(doc, input);
      if (result.ok) {
        doc.commit();
        const state = readStateFromLoro();
        callbacksRef.current.onNodesChange?.(state.nodes);
        callbacksRef.current.onEdgesChange?.(state.edges);
      }
      return result;
    },
    [doc, readStateFromLoro],
  );

  const renameCanvas = useCallback(
    (targetCanvasId: string, name: string) => {
      const result = renameProjectCanvas(doc, targetCanvasId, name);
      if (result.ok) {
        doc.commit();
        setCanvases(listProjectCanvases(doc));
        const state = readStateFromLoro();
        callbacksRef.current.onNodesChange?.(state.nodes);
        callbacksRef.current.onEdgesChange?.(state.edges);
      }
      return result;
    },
    [doc, readStateFromLoro],
  );

  const deleteCanvas = useCallback(
    (targetCanvasId: string) => {
      const result = deleteProjectCanvas(doc, targetCanvasId);
      if (result.ok) {
        doc.commit();
        setCanvases(listProjectCanvases(doc));
        const state = readStateFromLoro();
        callbacksRef.current.onNodesChange?.(state.nodes);
        callbacksRef.current.onEdgesChange?.(state.edges);
      }
      return result;
    },
    [doc, readStateFromLoro],
  );

  const createDirectorStageOnCanvas = useCallback(
    (input: Omit<CreateDirectorStageOnCanvasInput, "canvasId"> & { canvasId?: string }) => {
      const result = createDirectorStageOnCanvasMutation(doc, {
        ...input,
        canvasId: input.canvasId?.trim() || canvasIdRef.current,
      });
      if (result.ok) {
        setCanvases(listProjectCanvases(doc));
        setDirectorStages(listProjectDirectorStages(doc));
        const state = readStateFromLoro();
        callbacksRef.current.onNodesChange?.(state.nodes);
        callbacksRef.current.onEdgesChange?.(state.edges);
      }
      return result;
    },
    [doc, readStateFromLoro],
  );

  const createDirectorStage = useCallback(
    (input: { id: string; name: string; state: unknown }) => {
      const result = createProjectDirectorStage(doc, input);
      if (result.ok) {
        doc.commit();
        setDirectorStages(listProjectDirectorStages(doc));
      }
      return result;
    },
    [doc],
  );

  const attachDirectorStage = useCallback(
    (input: {
      stageId: string;
      canvasId?: string;
      actionNodeId: string;
      position?: { x: number; y: number };
    }) => {
      const result = attachDirectorStageToCanvas(doc, {
        ...input,
        canvasId: input.canvasId?.trim() || canvasIdRef.current,
      });
      if (result.ok) {
        doc.commit();
        setDirectorStages(listProjectDirectorStages(doc));
        const state = readStateFromLoro();
        callbacksRef.current.onNodesChange?.(state.nodes);
        callbacksRef.current.onEdgesChange?.(state.edges);
      }
      return result;
    },
    [doc, readStateFromLoro],
  );

  const detachDirectorStage = useCallback(
    (stageId: string) => {
      const result = detachDirectorStageFromCanvas(doc, stageId);
      if (result.ok) {
        doc.commit();
        setDirectorStages(listProjectDirectorStages(doc));
        const state = readStateFromLoro();
        callbacksRef.current.onNodesChange?.(state.nodes);
        callbacksRef.current.onEdgesChange?.(state.edges);
      }
      return result;
    },
    [doc, readStateFromLoro],
  );

  const applyDirectorStageState = useCallback(
    (stageId: string, nextState: unknown, options?: LoroHostWriteOptions) => {
      const stage = listProjectDirectorStages(doc).find(
        (candidate) => candidate.id === stageId,
      );
      if (!stage) {
        callbacksRef.current.onMutation?.(
          hostMutationRejected(
            {
              operation: "director_stage_apply",
              entity: { kind: "director-stage", id: stageId },
            },
            `Director Stage ${stageId} not found`,
          ),
        );
        return false;
      }
      const beforeReadToken = projectDirectorStageReadToken(stage);
      const guard = validateAgentObservation({
        actorClientType: options?.actorClientType,
        operation: "applying Director Stage state",
        observedVersion: options?.ifMatch,
        currentVersion: beforeReadToken,
      });
      const hostMutation = validateHostMutationEnvelope({
        operation: "director_stage_apply",
        entity: { kind: "director-stage", id: stageId },
        expectedReadToken: options?.ifMatch,
        currentReadToken: beforeReadToken,
        guard,
      });
      if (!guard.ok) {
        if (!hostMutation.ok)
          callbacksRef.current.onMutation?.(hostMutation.mutation);
        return false;
      }
      const updated = updateProjectDirectorStageState(doc, stageId, nextState);
      if (!updated.ok) return false;
      doc.commit();
      setDirectorStages(listProjectDirectorStages(doc));
      updateUndoRedoState();
      callbacksRef.current.onMutation?.(
        hostMutationSucceeded(
          hostMutation.ok
            ? hostMutation.envelope
            : {
                operation: "director_stage_apply",
                entity: { kind: "director-stage", id: stageId },
              },
          {
            resultEntityId: stageId,
            afterReadToken: projectDirectorStageReadToken(updated.stage),
          },
        ),
      );
      return true;
    },
    [doc, updateUndoRedoState],
  );

  const updateNode = useCallback(
    (nodeId: string, nodeData: any, options?: LoroHostWriteOptions) => {
      const nodesMap = doc.getMap("nodes");
      const existing = nodesMap.get(nodeId) as any;
      let mutationEnvelope: HostMutationEnvelope | undefined;
      if (!existing) {
        callbacksRef.current.onMutation?.(
          hostMutationRejected(
            {
              operation: "canvas_update",
              entity: { kind: "canvas-node", id: nodeId },
            },
            `Node not found: ${nodeId}`,
          ),
        );
        return false;
      } else {
        const beforeReadToken = readNodeToken(nodeId, existing);
        const currentEdges = new Canvas(
          doc,
          () => {},
          canvasIdRef.current,
        ).listEdges();
        const nodesForGuard = readGuardrailNodes(
          nodesMap.entries(),
          canvasIdRef.current,
        );
        const proofNode = readProofNode(nodeId, existing);
        const readProof = proofNode
          ? validateCanvasReadProof({
              operation: "update",
              actorClientType: options?.actorClientType,
              node: proofNode,
              expectedReadToken: options?.ifMatch,
            })
          : { ok: true as const };
        const patchGuard = validateCanvasNodePatch({
          nodeId,
          node: {
            type: typeof existing.type === "string" ? existing.type : undefined,
            data: isRecord(existing.data) ? existing.data : undefined,
          },
          nodes: nodesForGuard,
          edges: currentEdges,
          patch: isRecord(nodeData) ? nodeData : {},
        });
        const guard = !readProof.ok ? readProof : !patchGuard.ok ? patchGuard
          : isCanvasNodeImmutable({ nodeId, edges: currentEdges })
            ? { ok: false as const, error: `IMMUTABLE_NODE: Copy referenced node ${nodeId} before editing it.` }
            : patchGuard;
        const hostMutation = validateHostMutationEnvelope({
          operation: "canvas_update",
          entity: { kind: "canvas-node", id: nodeId },
          expectedReadToken: options?.ifMatch,
          currentReadToken: beforeReadToken,
          guard,
        });
        if (!guard.ok) {
          syncLog.warn("canvas.node_update_rejected", { nodeId: nodeId, reason: guard.error });
          if (!hostMutation.ok)
            callbacksRef.current.onMutation?.(hostMutation.mutation);
          const { nodes, edges, tasks } = readStateFromLoro();
          const cb = callbacksRef.current;
          if (cb.onNodesChange) cb.onNodesChange(nodes);
          if (cb.onEdgesChange) cb.onEdgesChange(edges);
          if (cb.onTaskUpdate)
            tasks.forEach((t) => cb.onTaskUpdate!(t.id, t.data));
          return false;
        }
        if (hostMutation.ok) mutationEnvelope = hostMutation.envelope;
        const targetCanvasId =
          typeof existing.canvasId === "string"
            ? existing.canvasId
            : canvasIdRef.current;
        try {
          if (
            !new Canvas(doc, () => {}, targetCanvasId).updateNodeRecord(
              nodeId,
              isRecord(nodeData) ? nodeData : {},
            )
          )
            return false;
        } catch (error) {
          callbacksRef.current.onMutation?.(
            hostMutationRejected(
              mutationEnvelope ?? {
                operation: "canvas_update",
                entity: { kind: "canvas-node", id: nodeId },
              },
              error instanceof Error ? error.message : String(error),
            ),
          );
          return false;
        }
      }
      doc.commit(); // Commit to trigger subscribeLocalUpdate
      const projection = readStateFromLoro();
      callbacksRef.current.onNodesChange?.(projection.nodes);
      callbacksRef.current.onEdgesChange?.(projection.edges);
      updateUndoRedoState();
      const updatedNode = nodesMap.get(nodeId);
      callbacksRef.current.onMutation?.(
        hostMutationSucceeded(
          mutationEnvelope ?? {
            operation: "canvas_update",
            entity: { kind: "canvas-node", id: nodeId },
          },
          {
            resultEntityId: nodeId,
            afterReadToken: readNodeToken(nodeId, updatedNode),
          },
        ),
      );
      return true;
    },
    [doc, readStateFromLoro, updateUndoRedoState],
  );

  const applyLayout = useCallback((patches: NodePatch[]) => {
    try {
      applyCanvasLayout(doc, canvasIdRef.current, patches);
      updateUndoRedoState();
      return true;
    } catch (error) {
      callbacksRef.current.onMutation?.(hostMutationRejected({
        operation: "canvas_update",
        entity: { kind: "project", id: projectId },
      }, error instanceof Error ? error.message : String(error)));
      return false;
    } finally {
      const projection = readStateFromLoro();
      callbacksRef.current.onNodesChange?.(projection.nodes);
      callbacksRef.current.onEdgesChange?.(projection.edges);
    }
  }, [doc, projectId, readStateFromLoro, updateUndoRedoState]);

  const applyTimelineDsl = useCallback(
    async (nodeId: string, timelineDsl: unknown, options?: LoroHostWriteOptions) => {
      const existing = doc.getMap("nodes").get(nodeId) as any;
      if (!existing) {
        syncLog.warn("timeline.apply_rejected", { nodeId: nodeId, reason: "node_not_found" });
        callbacksRef.current.onMutation?.(
          hostMutationRejected(
            {
              operation: "timeline_apply",
              entity: { kind: "timeline", id: nodeId },
            },
            `Node not found: ${nodeId}`,
          ),
        );
        return false;
      }

      const timelineId =
        typeof existing.data?.timelineId === "string"
          ? existing.data.timelineId
          : undefined;
      if (!timelineId) {
        const error = `Timeline Action ${nodeId} must reference a Project Timeline`;
        syncLog.warn("timeline.apply_rejected", { nodeId: nodeId, error });
        callbacksRef.current.onMutation?.(
          hostMutationRejected(
            {
              operation: "timeline_apply",
              entity: { kind: "timeline", id: nodeId },
            },
            error,
          ),
        );
        return false;
      }

      return Boolean(await applyTimelineState(timelineId, timelineDsl, options));
    },
    [applyTimelineState, doc],
  );

  const removeNode = useCallback(
    (nodeId: string, options?: LoroHostWriteOptions) => {
      const nodesMap = doc.getMap("nodes");
      const existing = nodesMap.get(nodeId);
      if (!isRecord(existing)) {
        const error = `Node not found: ${nodeId}`;
        syncLog.warn("canvas.node_delete_rejected", { nodeId: nodeId, error });
        callbacksRef.current.onMutation?.(
          hostMutationRejected(
            {
              operation: "canvas_delete",
              entity: { kind: "canvas-node", id: nodeId },
              expectedReadToken: options?.ifMatch,
            },
            error,
          ),
        );
        return false;
      }
      const beforeReadToken = readNodeToken(nodeId, existing);
      const canvas = new Canvas(doc, () => {}, canvasIdRef.current);
      const edges = canvas.listEdges();
      const proofNode = readProofNode(nodeId, existing);
      const readProof = proofNode
        ? validateCanvasReadProof({
            operation: "delete",
            actorClientType: options?.actorClientType,
            node: proofNode,
            expectedReadToken: options?.ifMatch,
          })
        : { ok: true as const };
      const deleteGuard = validateCanvasDelete({
        nodeId,
        edges,
      });
      const guard = readProof.ok ? deleteGuard : readProof;
      const hostMutation = validateHostMutationEnvelope({
        operation: "canvas_delete",
        entity: { kind: "canvas-node", id: nodeId },
        expectedReadToken: options?.ifMatch,
        currentReadToken: beforeReadToken,
        guard,
      });
      if (!guard.ok) {
        syncLog.warn("canvas.node_delete_rejected", { nodeId: nodeId, reason: guard.error });
        if (!hostMutation.ok)
          callbacksRef.current.onMutation?.(hostMutation.mutation);
        const { nodes, edges: currentEdges, tasks } = readStateFromLoro();
        const cb = callbacksRef.current;
        if (cb.onNodesChange) cb.onNodesChange(nodes);
        if (cb.onEdgesChange) cb.onEdgesChange(currentEdges);
        if (cb.onTaskUpdate)
          tasks.forEach((t) => cb.onTaskUpdate!(t.id, t.data));
        return false;
      }

      if (!canvas.deleteNode(nodeId)) return false;
      doc.commit(); // Commit to trigger subscribeLocalUpdate
      updateUndoRedoState();
      callbacksRef.current.onMutation?.(
        hostMutationSucceeded(
          hostMutation.ok
            ? hostMutation.envelope
            : {
                operation: "canvas_delete",
                entity: { kind: "canvas-node", id: nodeId },
              },
          { resultEntityId: nodeId },
        ),
      );
      return true;
    },
    [doc, readStateFromLoro, updateUndoRedoState],
  );

  const removeNodes = useCallback(
    (nodeIds: string[], options?: LoroHostWriteOptions) => {
      const uniqueNodeIds = [
        ...new Set(nodeIds.map((nodeId) => nodeId.trim()).filter(Boolean)),
      ];
      if (uniqueNodeIds.length === 0) return true;
      if (uniqueNodeIds.length === 1)
        return removeNode(uniqueNodeIds[0], options);

      const nodesMap = doc.getMap("nodes");
      const canvas = new Canvas(doc, () => {}, canvasIdRef.current);
      const existingIds = uniqueNodeIds.filter((nodeId) =>
        Boolean(canvas.readNode(nodeId)),
      );
      const batchId = existingIds.join(",");
      if (existingIds.length === 0) {
        callbacksRef.current.onMutation?.(
          hostMutationRejected(
            {
              operation: "canvas_batch_delete",
              entity: {
                kind: "canvas-node-batch",
                id: batchId || uniqueNodeIds.join(","),
              },
            },
            `Node(s) not found: ${uniqueNodeIds.join(", ")}`,
          ),
        );
        return false;
      }

      const currentEdges = canvas.listEdges();
      const edgeEntries: Array<[string, (typeof currentEdges)[number]]> =
        currentEdges.map((edge) => [edge.id, edge]);
      const beforeReadToken = readBatchDeleteToken(
        existingIds,
        nodesMap.entries(),
        edgeEntries,
      );
      const readProof = validateCanvasBatchDeleteReadProof({
        actorClientType: options?.actorClientType,
        nodes: existingIds
          .map((nodeId) => readProofNode(nodeId, nodesMap.get(nodeId)))
          .filter(
            (node): node is NonNullable<ReturnType<typeof readProofNode>> =>
              Boolean(node),
          ),
        edges: readProofEdges(edgeEntries),
        expectedReadToken: options?.ifMatch,
      });
      const edges = currentEdges;
      const deleteGuard = validateCanvasBatchDelete({
        nodeIds: existingIds,
        edges,
      });
      const guard = readProof.ok ? deleteGuard : readProof;
      const hostMutation = validateHostMutationEnvelope({
        operation: "canvas_batch_delete",
        entity: { kind: "canvas-node-batch", id: batchId },
        expectedReadToken: options?.ifMatch,
        currentReadToken: beforeReadToken,
        guard,
      });
      if (!guard.ok) {
        syncLog.warn("canvas.batch_delete_rejected", { batchId, reason: guard.error });
        if (!hostMutation.ok)
          callbacksRef.current.onMutation?.(hostMutation.mutation);
        const { nodes, edges: currentEdges, tasks } = readStateFromLoro();
        const cb = callbacksRef.current;
        if (cb.onNodesChange) cb.onNodesChange(nodes);
        if (cb.onEdgesChange) cb.onEdgesChange(currentEdges);
        if (cb.onTaskUpdate)
          tasks.forEach((t) => cb.onTaskUpdate!(t.id, t.data));
        return false;
      }

      canvas.deleteNodes(existingIds);
      doc.commit();
      updateUndoRedoState();
      callbacksRef.current.onMutation?.(
        hostMutationSucceeded(
          hostMutation.ok
            ? hostMutation.envelope
            : {
                operation: "canvas_batch_delete",
                entity: { kind: "canvas-node-batch", id: batchId },
                ...(options?.ifMatch
                  ? { expectedReadToken: options.ifMatch }
                  : {}),
                beforeReadToken,
              },
          { resultEntityId: batchId },
        ),
      );
      return true;
    },
    [doc, readStateFromLoro, removeNode, updateUndoRedoState],
  );

  const addEdge = useCallback(
    (edgeId: string, edgeData: any, options?: LoroHostWriteOptions) => {
      const targetCanvasId =
        isRecord(edgeData) && typeof edgeData.canvasId === "string"
          ? edgeData.canvasId
          : canvasIdRef.current;
      const canvas = new Canvas(doc, () => {}, targetCanvasId);
      const currentEdges = canvas.listEdges();
      const edgeEntries: Array<[string, (typeof currentEdges)[number]]> =
        currentEdges.map((edge) => [edge.id, edge]);
      const needsReadProof =
        options?.actorClientType === "agent" ||
        typeof options?.ifMatch === "string";
      const beforeReadToken = needsReadProof
        ? readEdgesToken(edgeEntries)
        : undefined;
      if (isRecord(edgeData)) {
        const source =
          typeof edgeData.source === "string" ? edgeData.source : "";
        const target =
          typeof edgeData.target === "string" ? edgeData.target : "";
        if (source && target) {
          const readProof = needsReadProof
            ? validateCanvasEdgesReadProof({
                operation: "add",
                actorClientType: options?.actorClientType,
                edges: readProofEdges(edgeEntries),
                expectedReadToken: options?.ifMatch,
              })
            : { ok: true as const };
          const edgeGuard = validateCanvasEdgeAdd({
            edge: { source, target },
            nodes: readGuardrailNodes(doc.getMap("nodes").entries()),
            edges: currentEdges,
          });
          const guard = readProof.ok ? edgeGuard : readProof;
          const hostMutation = validateHostMutationEnvelope({
            operation: "canvas_add_edge",
            entity: { kind: "canvas-edge", id: edgeId },
            expectedReadToken: options?.ifMatch,
            currentReadToken: beforeReadToken,
            guard,
          });
          if (!guard.ok) {
            syncLog.warn("canvas.edge_add_rejected", { edgeId: edgeId, reason: guard.error });
            if (!hostMutation.ok)
              callbacksRef.current.onMutation?.(hostMutation.mutation);
            const { nodes, edges, tasks } = readStateFromLoro();
            const cb = callbacksRef.current;
            if (cb.onNodesChange) cb.onNodesChange(nodes);
            if (cb.onEdgesChange) cb.onEdgesChange(edges);
            if (cb.onTaskUpdate)
              tasks.forEach((t) => cb.onTaskUpdate!(t.id, t.data));
            return false;
          }
          canvas.insertEdge(
            edgeId,
            source,
            target,
            typeof edgeData.type === "string" ? edgeData.type : "default",
          );
          if (
            typeof edgeData.sourceHandle === "string" ||
            typeof edgeData.targetHandle === "string"
          ) {
            canvas.updateEdge(edgeId, {
              ...(typeof edgeData.sourceHandle === "string"
                ? { sourceHandle: edgeData.sourceHandle }
                : {}),
              ...(typeof edgeData.targetHandle === "string"
                ? { targetHandle: edgeData.targetHandle }
                : {}),
            });
          }
        } else {
          return false;
        }
      } else {
        return false;
      }
      doc.commit(); // Commit to trigger subscribeLocalUpdate
      const projection = readStateFromLoro();
      callbacksRef.current.onNodesChange?.(projection.nodes);
      callbacksRef.current.onEdgesChange?.(projection.edges);
      callbacksRef.current.onMutation?.(
        hostMutationSucceeded(
          {
            operation: "canvas_add_edge",
            entity: { kind: "canvas-edge", id: edgeId },
            ...(options?.ifMatch ? { expectedReadToken: options.ifMatch } : {}),
            ...(beforeReadToken ? { beforeReadToken } : {}),
          },
          {
            resultEntityId: edgeId,
            afterReadToken: needsReadProof
              ? readEdgesToken(
                  canvas.listEdges().map((edge) => [edge.id, edge] as const),
                )
              : undefined,
          },
        ),
      );
      return true;
    },
    [doc, readStateFromLoro],
  );

  const updateEdge = useCallback(
    (edgeId: string, edgeData: any, options?: LoroHostWriteOptions) => {
      const canvas = new Canvas(doc, () => {}, canvasIdRef.current);
      const currentEdges = canvas.listEdges();
      const existing = currentEdges.find((edge) => edge.id === edgeId);
      const beforeReadToken = readEdgeToken(edgeId, existing);
      const existingEdge =
        isRecord(existing) &&
        typeof existing.source === "string" &&
        typeof existing.target === "string"
          ? { source: existing.source, target: existing.target }
          : null;
      const proofEdge = readProofEdge(edgeId, existing);
      const readProof = proofEdge
        ? validateCanvasEdgeReadProof({
            operation: "update",
            actorClientType: options?.actorClientType,
            edge: proofEdge,
            expectedReadToken: options?.ifMatch,
          })
        : { ok: true as const };
      const patchGuard = validateCanvasEdgePatch({
        existingEdge,
        patch: isRecord(edgeData) ? edgeData : {},
        nodes: readGuardrailNodes(doc.getMap("nodes").entries()),
        edges: currentEdges,
      });
      const guard = readProof.ok ? patchGuard : readProof;
      const hostMutation = validateHostMutationEnvelope({
        operation: "canvas_update_edge",
        entity: { kind: "canvas-edge", id: edgeId },
        expectedReadToken: options?.ifMatch,
        currentReadToken: beforeReadToken,
        guard,
      });
      if (!guard.ok) {
        syncLog.warn("canvas.edge_update_rejected", { edgeId: edgeId, reason: guard.error });
        if (!hostMutation.ok)
          callbacksRef.current.onMutation?.(hostMutation.mutation);
        const { nodes, edges, tasks } = readStateFromLoro();
        const cb = callbacksRef.current;
        if (cb.onNodesChange) cb.onNodesChange(nodes);
        if (cb.onEdgesChange) cb.onEdgesChange(edges);
        if (cb.onTaskUpdate)
          tasks.forEach((t) => cb.onTaskUpdate!(t.id, t.data));
        return false;
      }
      if (!canvas.updateEdge(edgeId, isRecord(edgeData) ? edgeData : {}))
        return false;
      doc.commit(); // Commit to trigger subscribeLocalUpdate
      const updated = canvas.listEdges().find((edge) => edge.id === edgeId);
      callbacksRef.current.onMutation?.(
        hostMutationSucceeded(
          hostMutation.ok
            ? hostMutation.envelope
            : {
                operation: "canvas_update_edge",
                entity: { kind: "canvas-edge", id: edgeId },
              },
          {
            resultEntityId: edgeId,
            afterReadToken: readEdgeToken(edgeId, updated),
          },
        ),
      );
      return true;
    },
    [doc, readStateFromLoro],
  );

  const removeEdge = useCallback(
    (edgeId: string, options?: LoroHostWriteOptions) => {
      const canvas = new Canvas(doc, () => {}, canvasIdRef.current);
      const currentEdges = canvas.listEdges();
      const existing = currentEdges.find((edge) => edge.id === edgeId);
      let hostMutation: ReturnType<typeof validateHostMutationEnvelope> | null =
        null;
      if (isRecord(existing)) {
        const beforeReadToken = readEdgeToken(edgeId, existing);
        const nodesMap = doc.getMap("nodes");
        const edges = currentEdges;
        const nodes: Array<{
          id: string;
          type?: string;
          data?: Record<string, unknown>;
        }> = [];
        for (const [id, rawNode] of nodesMap.entries()) {
          if (typeof id !== "string" || !isRecord(rawNode)) continue;
          nodes.push({
            id,
            type: typeof rawNode.type === "string" ? rawNode.type : undefined,
            data: isRecord(rawNode.data) ? rawNode.data : undefined,
          });
        }
        const proofEdge = readProofEdge(edgeId, existing);
        const readProof = proofEdge
          ? validateCanvasEdgeReadProof({
              operation: "delete",
              actorClientType: options?.actorClientType,
              edge: proofEdge,
              expectedReadToken: options?.ifMatch,
            })
          : { ok: true as const };
        const deleteGuard = validateCanvasEdgeDelete({
          edge: {
            source: typeof existing.source === "string" ? existing.source : "",
            target: typeof existing.target === "string" ? existing.target : "",
          },
          nodes,
          edges,
        });
        const guard = readProof.ok ? deleteGuard : readProof;
        hostMutation = validateHostMutationEnvelope({
          operation: "canvas_delete_edge",
          entity: { kind: "canvas-edge", id: edgeId },
          expectedReadToken: options?.ifMatch,
          currentReadToken: beforeReadToken,
          guard,
        });
        if (!guard.ok) {
          syncLog.warn("canvas.edge_delete_rejected", { edgeId: edgeId, reason: guard.error });
          if (!hostMutation.ok)
            callbacksRef.current.onMutation?.(hostMutation.mutation);
          const {
            nodes: currentNodes,
            edges: currentEdges,
            tasks,
          } = readStateFromLoro();
          const cb = callbacksRef.current;
          if (cb.onNodesChange) cb.onNodesChange(currentNodes);
          if (cb.onEdgesChange) cb.onEdgesChange(currentEdges);
          if (cb.onTaskUpdate)
            tasks.forEach((t) => cb.onTaskUpdate!(t.id, t.data));
          return false;
        }
      }
      if (existing) {
        const target = canvas.readNode(existing.target);
        if (target?.type === "action-badge" && typeof target.data.generatorId === "string") {
          const envelope = { operation: "canvas_delete_edge" as const, entity: { kind: "canvas-edge" as const, id: edgeId } };
          // The Host removes this edge, retaining the native input while another
          // placement still references it. Sync publishes the accepted graph.
          void (async () => {
            const response = await fetch(runtimeApiUrl(`/api/v1/projects/${encodeURIComponent(projectId)}/canvas/edges/${encodeURIComponent(edgeId)}`), {
              method: "DELETE", credentials: "include", headers: { "content-type": "application/json" },
              body: JSON.stringify({ actorClientType: options?.actorClientType, ifMatch: options?.ifMatch }),
            });
            const body = await response.json() as { deleted?: boolean; edgeId?: string; error?: string };
            if (!response.ok) throw new Error(body.error ?? `Could not remove the connection (${response.status}).`);
            if (body.deleted !== true || body.edgeId !== edgeId) throw new Error("The connection deletion acknowledgement does not match this edit.");
          })().then(() => {
            if (replica.active) callbacksRef.current.onMutation?.(hostMutationSucceeded(envelope, { resultEntityId: edgeId }));
          })
            .catch((error) => {
              if (!replica.active) return;
              callbacksRef.current.onMutation?.(hostMutationRejected(envelope, error instanceof Error ? error.message : String(error)));
              const projection = readStateFromLoro();
              callbacksRef.current.onNodesChange?.(projection.nodes);
              callbacksRef.current.onEdgesChange?.(projection.edges);
            });
          return false;
        }
      }
      if (!canvas.deleteEdge(edgeId)) return false;
      doc.commit(); // Commit to trigger subscribeLocalUpdate
      callbacksRef.current.onMutation?.(
        hostMutationSucceeded(
          hostMutation?.ok
            ? hostMutation.envelope
            : {
                operation: "canvas_delete_edge",
                entity: { kind: "canvas-edge", id: edgeId },
              },
          {
            resultEntityId: edgeId,
          },
        ),
      );
      return true;
    },
    [replica, doc, readStateFromLoro, projectId],
  );

  // Replay the doc's current state into React. Used by undo/redo, because the
  // subscribe handler skips `event.by === 'local'` to avoid echo-loops with
  // the caller-state path used by addNode/updateNode/... — but undo/redo DO
  // need React to re-read, since their "caller" never held the new state.
  const pushStateToReact = useCallback(() => {
    const { nodes, edges, tasks } = readStateFromLoro();
    const cb = callbacksRef.current;
    if (cb.onNodesChange) cb.onNodesChange(nodes);
    if (cb.onEdgesChange) cb.onEdgesChange(edges);
    if (cb.onTaskUpdate) tasks.forEach((t) => cb.onTaskUpdate!(t.id, t.data));
  }, [readStateFromLoro]);

  const undo = useCallback(() => {
    if (undoManager.canUndo()) {
      undoManager.undo();
      doc.commit(); // Commit to trigger subscribeLocalUpdate
      pushStateToReact();
      updateUndoRedoState();
    }
  }, [doc, undoManager, updateUndoRedoState, pushStateToReact]);

  const redo = useCallback(() => {
    if (undoManager.canRedo()) {
      undoManager.redo();
      doc.commit(); // Commit to trigger subscribeLocalUpdate
      pushStateToReact();
      updateUndoRedoState();
    }
  }, [doc, undoManager, updateUndoRedoState, pushStateToReact]);

  const standaloneTimelines = useMemo(
    () => timelines.filter((timeline) => timeline.owner.kind === "project"),
    [timelines],
  );
  const standaloneDirectorStages = useMemo(
    () => directorStages.filter((stage) => stage.owner.kind === "project"),
    [directorStages],
  );

  return useMemo(
    () => ({
      projectId,
      doc,
      connected,
      syncRejected,
      projectLoadError,
      retryProjectLoad,
      recoveryDraft,
      prepareSyncRecovery,
      isInitialized,
      canvases,
      createCanvas,
      createPluginView,
      renameCanvas,
      deleteCanvas,
      timelines,
      timelineError,
      standaloneTimelines,
      createTimeline,
      createTimelineOnCanvas,
      deleteTimeline,
      attachTimeline,
      detachTimeline,
      directorStages,
      standaloneDirectorStages,
      createDirectorStage,
      createDirectorStageOnCanvas,
      attachDirectorStage,
      detachDirectorStage,
      applyDirectorStageState,
      addNodeToCanvas,
      addNode,
      addGraph,
      createLinkedNode,
      updateNode,
      applyLayout,
      applyTimelineState,
      applyTimelineDsl,
      requestTimelineRender,
      removeNode,
      removeNodes,
      addEdge,
      updateEdge,
      removeEdge,
      undo,
      redo,
      canUndo,
      canRedo,
      sendSideband,
    }),
    [
      addEdge,
      addNode,
      addGraph,
      addNodeToCanvas,
      createLinkedNode,
      applyTimelineDsl,
      applyTimelineState,
      requestTimelineRender,
      applyDirectorStageState,
      attachTimeline,
      attachDirectorStage,
      canRedo,
      canUndo,
      canvases,
      connected,
      syncRejected,
      projectLoadError,
      retryProjectLoad,
      recoveryDraft,
      prepareSyncRecovery,
      createCanvas,
      createPluginView,
      createTimeline,
      createTimelineOnCanvas,
      deleteTimeline,
      createDirectorStage,
      createDirectorStageOnCanvas,
      deleteCanvas,
      detachTimeline,
      detachDirectorStage,
      directorStages,
      doc,
      isInitialized,
      projectId,
      redo,
      removeEdge,
      removeNode,
      removeNodes,
      renameCanvas,
      sendSideband,
      standaloneTimelines,
      standaloneDirectorStages,
      timelines,
      timelineError,
      undo,
      updateEdge,
      updateNode,
      applyLayout,
    ],
  );
}
