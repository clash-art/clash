/**
 * Canvas — cohesive interface for all canvas operations.
 *
 * All clients (web, CLI, agent) should use this class instead of
 * importing individual functions. Takes a LoroDoc + BroadcastFn
 * and exposes clean business-level methods.
 */
import type { LoroDoc } from "loro-crdt";
import { readGeneratorRevision } from "./project-generators.js";
import type { LayoutNode, LayoutEdge } from "@clash/shared-layout";
import { NEEDS_LAYOUT_POSITION, autoInsertNode, processAutoLayoutNodes } from "@clash/shared-layout";
import {
  AGENT_NODE_TYPE_MAP,
  NodeType,
  ProposalType,
  TaskStatus,
  ACTION_TYPE,
  RF_NODE_TYPE,
  buildPendingAssetNode,
  buildGenerationPayload,
  type CustomActionDefinition,
  type UpstreamRef,
} from "./canvas.js";
import { MODEL_CARDS, normalizeModelId, type ModelCard } from "./models.js";
import { ExecutablePluginBindingSchema } from "./executable-plugin.js";
import { DirectorReferencePacketSchema } from "./director-reference.js";
import {
  ensureProjectCanvas,
  freezeProjectTimelineRunAssetInputs,
  projectTimelineRenderActionRunId,
  readProjectTimeline,
} from "./project-workspace.js";
import {
  clearNodeUpstreamRefs,
  deleteNodeUpstreamRef,
  listNodeOwnedEdges,
  readNodeUpstreamRefs,
  upsertNodeUpstreamRef,
} from "./node-upstreams.js";
import {
  ACTION_ASSET_BINDING_AUTHORITY_VERSION,
  actionAssetBindingAuthorityVersion,
  replaceDraftActionAssetInputBindings,
  type DraftActionAssetInput,
} from "./action-asset-bindings.js";
import {
  canvasActionAssetInputs,
  isCanvasManagedAssetAction,
} from "./canvas-action-asset-inputs.js";
import { readProjectAsset } from "./project-assets.js";
import { ProjectTimelineEnvelopeSchema } from "./timeline-envelope.js";
import { projectCanvasModelGeneratorData, assertCanvasModelGeneratorPatch } from "./canvas-model-generator.js";

// ─── Types ───────────────────────────────────────────────

export type BroadcastFn = (data: Uint8Array) => void;

export interface NodeInfo {
  id: string;
  canvas_id: string;
  upstream: UpstreamRef[];
  type: string;
  data: Record<string, unknown>;
  parent_id: string | null;
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  style?: Record<string, unknown> | null;
}

export interface CreateNodeResult {
  node_id: string | null;
  error: string | null;
  proposal: Record<string, unknown> | null;
  asset_id: string | null;
}

export interface CreateLinkedNodeResult {
  nodeId: string;
  position: { x: number; y: number };
  pushedNodeIds: string[];
}

export interface ExecuteGenerationResult {
  assetNodeId: string;
  assetNodeType: string;
  position: { x: number; y: number };
  error: string | null;
}

export interface CanvasEdgeInfo extends LayoutEdge {
  id: string;
  type: string;
  sourceHandle?: string;
  targetHandle?: string;
}

/**
 * Unified result for `Canvas.execute`. `kind` discriminates which
 * pipeline fired so callers can phrase their UI/log message
 * appropriately (e.g. "generating asset" vs "rendering video"). On
 * failure `error` is non-null and the other fields are empty.
 *
 * `generation` — action-badge node spawned a pending asset child.
 * `render`     — video-editor node spawned a pending render-video child.
 */
export interface ExecuteResult {
  kind: "generation" | "render" | null;
  childNodeId: string;
  childNodeType: string;
  position: { x: number; y: number };
  error: string | null;
}

export interface TaskStatusResult {
  status: string;
  output?: Record<string, unknown>;
  error?: string;
}

// ─── Internal Helpers ────────────────────────────────────

export function projectVisibleNodeData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const visible = { ...data };
  delete visible.providerAccountId;
  delete visible.provider_id;
  delete visible.src;
  delete visible.url;
  delete visible.remoteUrl;
  delete visible.signedUrl;
  delete visible.signedCoverUrl;
  delete visible.storageKey;
  delete visible.srcR2Key;
  delete visible.localPath;
  delete visible.filePath;
  delete visible.thumbnail;
  delete visible.thumbnailUrl;
  delete visible.waveformUrl;
  delete visible.poster;
  delete visible.posterUrl;
  delete visible.coverUrl;
  delete visible.previewUrl;
  delete visible.sourceUrl;
  delete visible.referenceImageUrls;
  delete visible.referenceVideoUrls;
  delete visible.referenceAudioUrls;
  delete visible.referenceImageR2Keys;
  delete visible.referenceVideoR2Keys;
  delete visible.referenceAudioR2Keys;
  delete visible.startFrameUrl;
  delete visible.endFrameUrl;
  delete visible.outputVideoSrc;
  delete visible.outputVideoPreviewUrl;
  if (visible.directorReferencePacket !== undefined) {
    const packet = DirectorReferencePacketSchema.safeParse(
      visible.directorReferencePacket,
    );
    if (packet.success) visible.directorReferencePacket = packet.data;
    else delete visible.directorReferencePacket;
  }
  if (Array.isArray(visible.directorShotReferencePackets)) {
    visible.directorShotReferencePackets =
      visible.directorShotReferencePackets.flatMap((candidate) => {
        const packet = DirectorReferencePacketSchema.safeParse(candidate);
        return packet.success ? [packet.data] : [];
      });
  }
  if (
    visible.modelParams &&
    typeof visible.modelParams === "object" &&
    !Array.isArray(visible.modelParams)
  ) {
    const modelParams = {
      ...(visible.modelParams as Record<string, unknown>),
    };
    delete modelParams.provider_id;
    visible.modelParams = modelParams;
  }
  return visible;
}

function directorStageOutputField(
  data: Record<string, unknown>,
): string | undefined {
  return Object.keys(data).find(
    (field) =>
      field.startsWith("outputVideo") ||
      field === "assetId" ||
      field === "outputAssetId" ||
      field === "resultAssetId" ||
      field === "contentFile" ||
      field === "directorReferencePacket" ||
      field === "directorShotReferencePackets",
  );
}

function assertDirectorStageAuthoringPatch(input: {
  currentNodeType?: string;
  nextNodeType: string;
  patchData: Record<string, unknown>;
  nextData: Record<string, unknown>;
}): void {
  if (input.nextNodeType !== "director-stage") return;
  const outputField =
    directorStageOutputField(input.patchData) ??
    (input.currentNodeType !== undefined &&
    input.currentNodeType !== "director-stage"
      ? directorStageOutputField(input.nextData)
      : undefined);
  if (outputField) {
    throw new Error(
      `Director Stage output field ${outputField} belongs on an independent output node`,
    );
  }
}

function randomIdPart(): string {
  const cryptoObject = (
    globalThis as unknown as {
      crypto?: { randomUUID?: () => string };
    }
  ).crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

function parseLoroNode(
  nodeId: string,
  raw: Record<string, any>,
  upstream: UpstreamRef[],
): NodeInfo {
  const data = raw.data ?? {};
  return {
    id: nodeId,
    canvas_id: typeof raw.canvasId === "string" ? raw.canvasId : "main",
    upstream,
    type: raw.type ?? "text",
    data: typeof data === "object" ? { ...data } : {},
    parent_id: raw.parentId ?? raw.parent_id ?? null,
    position: raw.position ?? { x: 0, y: 0 },
    width: typeof raw.width === "number" ? raw.width : null,
    height: typeof raw.height === "number" ? raw.height : null,
    style: raw.style ?? null,
  };
}

function toLayoutNode(node: NodeInfo): LayoutNode {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    parentId: node.parent_id ?? undefined,
    data: node.data,
    width: node.width ?? undefined,
    height: node.height ?? undefined,
    style: node.style ?? undefined,
  };
}

// ─── Canvas Class ────────────────────────────────────────

export class Canvas {
  constructor(
    private readonly doc: LoroDoc,
    private readonly broadcast: BroadcastFn,
    private readonly canvasId = "main",
    /**
     * The effective model catalogue this Canvas judges generations against.
     *
     * A plugin may ship model cards of its own, so the usable set is only knowable where
     * those plugins are installed. `Canvas` runs in the CLI, the local host, and the web
     * UI; while it read the first-party constant directly, each process judged a request
     * against its own compiled-in copy and a stale client refused a model the host
     * served. Hosts pass their composed set; the constant remains the default so a
     * caller with no plugins keeps working.
     */
    private readonly modelCards: readonly ModelCard[] = MODEL_CARDS,
  ) {}

  // ── Read ─────────────────────────────────────────────

  listNodes(nodeType?: string | null, parentId?: string | null): NodeInfo[] {
    const nodesMap = this.doc.getMap("nodes");
    let nodes: NodeInfo[] = [];
    for (const [id, raw] of nodesMap.entries()) {
      const node = parseLoroNode(
        id,
        raw as Record<string, any>,
        readNodeUpstreamRefs(this.doc, id, raw),
      );
      if (node.canvas_id === this.canvasId) nodes.push({ ...node, data: projectCanvasModelGeneratorData(this.doc, node.type, node.data) });
    }
    if (nodeType) nodes = nodes.filter((n) => n.type === nodeType);
    if (parentId) nodes = nodes.filter((n) => n.parent_id === parentId);
    return nodes;
  }

  readNode(nodeId: string): NodeInfo | null {
    const nodesMap = this.doc.getMap("nodes");
    const raw = nodesMap.get(nodeId) as Record<string, any> | undefined;
    if (!raw) return null;
    const node = parseLoroNode(
      nodeId,
      raw,
      readNodeUpstreamRefs(this.doc, nodeId, raw),
    );
    return node.canvas_id === this.canvasId ? { ...node, data: projectCanvasModelGeneratorData(this.doc, node.type, node.data) } : null;
  }

  searchNodes(query: string, nodeTypes?: string[] | null): NodeInfo[] {
    const queryLower = query.toLowerCase();
    return this.listNodes().filter((node) => {
      if (nodeTypes?.length && !nodeTypes.includes(node.type)) return false;
      const label = ((node.data.label as string) ?? "").toLowerCase();
      const content = String(node.data.content ?? "").toLowerCase();
      return label.includes(queryLower) || content.includes(queryLower);
    });
  }

  findNode(idOrAssetId: string): NodeInfo | null {
    const byId = this.readNode(idOrAssetId);
    if (byId) return byId;
    return (
      this.listNodes().find(
        (n) => (n.data.assetId as string) === idOrAssetId,
      ) ?? null
    );
  }

  getNodeStatus(nodeIdOrAssetId: string): TaskStatusResult {
    const node = this.findNode(nodeIdOrAssetId);
    if (!node)
      return { status: TaskStatus.NodeNotFound, error: "Node not found" };
    const status = (node.data.status as string) ?? TaskStatus.Completed;
    const error = node.data.error as string | undefined;
    return error ? { status, error } : { status };
  }

  listEdges(): CanvasEdgeInfo[] {
    return listNodeOwnedEdges(this.doc, this.canvasId);
  }

  /** Lookup a marketplace custom-action definition from the Loro doc's
   *  `customActions` map. Returns `null` if no action with that id has
   *  been installed in this project. Same map NodeProcessor reads
   *  later when it dispatches the pending task — keeping the readers
   *  aligned avoids drift. */
  getCustomAction(
    actionId: string,
  ): import("./canvas.js").CustomActionDefinition | null {
    try {
      const map = this.doc.getMap("customActions");
      const raw = map.get(actionId);
      if (!raw || typeof raw !== "object") return null;
      return raw as import("./canvas.js").CustomActionDefinition;
    } catch {
      return null;
    }
  }

  // ── Write ────────────────────────────────────────────

  /** Complete legacy placement before Host publication, preserving referenced nodes. */
  layoutPendingNodes(): string[] {
    const records = this.doc.getMap("nodes");
    const nodes = this.listNodes().map(node => {
      const raw = records.get(node.id) as Record<string, unknown>;
      return { ...toLayoutNode(node), position: raw.position ? node.position : NEEDS_LAYOUT_POSITION };
    });
    const result = processAutoLayoutNodes(nodes, listNodeOwnedEdges(this.doc));
    if (result.processed.length === 0) return [];
    const previousPositions = new Map(nodes.map(node => [node.id, node.position]));
    const updates = new Map<string, { x: number; y: number }>();
    for (const node of result.nodes) {
      const before = previousPositions.get(node.id)!;
      if (before.x !== node.position.x || before.y !== node.position.y) {
        updates.set(node.id, node.position);
      }
    }
    this.batchUpdatePositions(updates);
    return result.processed;
  }

  insertNode(
    nodeId: string,
    nodeType: string,
    data: Record<string, unknown>,
    parentId: string | null,
    position: { x: number; y: number },
  ): void {
    this.insertNodeRecord(nodeId, {
      canvasId: this.canvasId,
      type: nodeType,
      data,
      parentId: parentId ?? undefined,
      position,
    });
  }

  /**
   * Inserts one framework node without bypassing Canvas-owned binding writes.
   * GUI adapters use this form to preserve layout fields alongside node data.
   */
  insertNodeRecord(nodeId: string, input: Record<string, unknown>): void {
    const versionBefore = this.doc.version();
    const inputData =
      input.data && typeof input.data === "object" && !Array.isArray(input.data)
        ? (input.data as Record<string, unknown>)
        : {};
    const visibleData = projectVisibleNodeData(inputData);
    assertDirectorStageAuthoringPatch({
      nextNodeType: typeof input.type === "string" ? input.type : "text",
      patchData: inputData,
      nextData: visibleData,
    });
    const raw: Record<string, unknown> = {
      ...input,
      canvasId: this.canvasId,
      data: visibleData,
    };
    const nextNode: NodeInfo = {
      id: nodeId,
      canvas_id: this.canvasId,
      upstream: Array.isArray(raw.upstream)
        ? (raw.upstream as UpstreamRef[])
        : [],
      type: typeof raw.type === "string" ? raw.type : "text",
      data: visibleData,
      parent_id:
        typeof raw.parentId === "string"
          ? raw.parentId
          : typeof raw.parent_id === "string"
            ? raw.parent_id
            : null,
      position:
        raw.position && typeof raw.position === "object"
          ? (raw.position as { x: number; y: number })
          : { x: 0, y: 0 },
      width: typeof raw.width === "number" ? raw.width : null,
      height: typeof raw.height === "number" ? raw.height : null,
      style:
        raw.style && typeof raw.style === "object" && !Array.isArray(raw.style)
          ? (raw.style as Record<string, unknown>)
          : null,
    };
    const bindingPlans = this.planActionAssetBindings(
      [...this.listNodes(), nextNode],
      this.listEdges(),
    );
    this.validateActionAssetBindingPlans(bindingPlans);
    this.ensureWritableCanvas();
    const nodesMap = this.doc.getMap("nodes");
    nodesMap.set(nodeId, raw);
    this.applyActionAssetBindingPlans(bindingPlans);
    const update = this.doc.export({ mode: "update", from: versionBefore });
    this.broadcast(update);
  }

  insertEdge(
    edgeId: string,
    source: string,
    target: string,
    edgeType: string | null = "default",
    sourceHandle?: string,
    targetHandle?: string,
  ): void {
    const sourceNode = this.readNode(source);
    const targetNode = this.readNode(target);
    if (!sourceNode)
      throw new Error(
        `Source node ${source} not found in canvas ${this.canvasId}`,
      );
    if (!targetNode)
      throw new Error(
        `Target node ${target} not found in canvas ${this.canvasId}`,
      );

    const versionBefore = this.doc.version();
    const bindingPlans = this.planActionAssetBindings(this.listNodes(), [
      ...this.listEdges(),
      {
        id: edgeId,
        source,
        target,
        type: edgeType ?? "default",
        ...(sourceHandle ? { sourceHandle } : {}),
        ...(targetHandle ? { targetHandle } : {}),
      },
    ]);
    this.validateActionAssetBindingPlans(bindingPlans);
    const raw = this.doc.getMap("nodes").get(target) as Record<string, unknown>;
    upsertNodeUpstreamRef(
      this.doc,
      target,
      {
        nodeId: source,
        edgeId,
        type: edgeType ?? "default",
        ...(sourceHandle ? { sourceHandle } : {}),
        ...(targetHandle ? { targetHandle } : {}),
      },
      raw,
    );
    this.applyActionAssetBindingPlans(bindingPlans);
    const update = this.doc.export({ mode: "update", from: versionBefore });
    this.broadcast(update);
  }

  updateEdge(
    edgeId: string,
    patch: Partial<Omit<CanvasEdgeInfo, "id">>,
  ): boolean {
    const existing = this.listEdges().find((edge) => edge.id === edgeId);
    if (!existing) return false;
    const source = patch.source ?? existing.source;
    const target = patch.target ?? existing.target;
    if (!this.readNode(source))
      throw new Error(
        `Source node ${source} not found in canvas ${this.canvasId}`,
      );
    if (!this.readNode(target))
      throw new Error(
        `Target node ${target} not found in canvas ${this.canvasId}`,
      );

    const versionBefore = this.doc.version();
    const nextEdge: CanvasEdgeInfo = {
      ...existing,
      ...patch,
      id: edgeId,
      source,
      target,
      type: patch.type ?? existing.type,
    };
    const bindingPlans = this.planActionAssetBindings(
      this.listNodes(),
      this.listEdges().map((edge) => (edge.id === edgeId ? nextEdge : edge)),
    );
    this.validateActionAssetBindingPlans(bindingPlans);
    const nodesMap = this.doc.getMap("nodes");
    const previousTarget = nodesMap.get(existing.target) as Record<
      string,
      unknown
    >;
    deleteNodeUpstreamRef(this.doc, existing.target, edgeId, previousTarget);
    const nextTarget = nodesMap.get(target) as Record<string, unknown>;
    upsertNodeUpstreamRef(
      this.doc,
      target,
      {
        nodeId: source,
        edgeId,
        type: patch.type ?? existing.type,
        ...((patch.sourceHandle ?? existing.sourceHandle)
          ? { sourceHandle: patch.sourceHandle ?? existing.sourceHandle }
          : {}),
        ...((patch.targetHandle ?? existing.targetHandle)
          ? { targetHandle: patch.targetHandle ?? existing.targetHandle }
          : {}),
      },
      nextTarget,
    );
    this.applyActionAssetBindingPlans(bindingPlans);
    const update = this.doc.export({ mode: "update", from: versionBefore });
    this.broadcast(update);
    return true;
  }

  deleteEdge(edgeId: string): boolean {
    const existing = this.listEdges().find((edge) => edge.id === edgeId);
    if (!existing) return false;
    const versionBefore = this.doc.version();
    const bindingPlans = this.planActionAssetBindings(
      this.listNodes(),
      this.listEdges().filter((edge) => edge.id !== edgeId),
    );
    this.validateActionAssetBindingPlans(bindingPlans);
    const raw = this.doc.getMap("nodes").get(existing.target) as Record<
      string,
      unknown
    >;
    deleteNodeUpstreamRef(this.doc, existing.target, edgeId, raw);
    this.applyActionAssetBindingPlans(bindingPlans);
    const update = this.doc.export({ mode: "update", from: versionBefore });
    this.broadcast(update);
    return true;
  }

  updateNode(nodeId: string, updates: Record<string, unknown>): boolean {
    return this.updateNodeRecord(nodeId, { data: updates });
  }

  /** Updates one complete framework node through the Canvas authority. */
  updateNodeRecord(nodeId: string, patch: Record<string, unknown>): boolean {
    const nodesMap = this.doc.getMap("nodes");
    const raw = nodesMap.get(nodeId) as Record<string, any> | undefined;
    if (!raw) return false;
    const currentNode = this.readNode(nodeId);
    if (!currentNode) return false;
    const versionBefore = this.doc.version();
    const patchData =
      patch.data && typeof patch.data === "object" && !Array.isArray(patch.data)
        ? (patch.data as Record<string, unknown>)
        : {};
    assertCanvasModelGeneratorPatch(currentNode.type, raw.data ?? {}, patchData);
    const nextData = projectVisibleNodeData({
      ...(raw.data ?? {}),
      ...patchData,
    });
    const nextNodeType =
      typeof patch.type === "string" ? patch.type : currentNode.type;
    assertDirectorStageAuthoringPatch({
      currentNodeType: currentNode.type,
      nextNodeType,
      patchData,
      nextData,
    });
    const nextNode: NodeInfo = {
      ...currentNode,
      type: nextNodeType,
      data: nextData,
      parent_id:
        typeof patch.parentId === "string"
          ? patch.parentId
          : patch.parentId === null
            ? null
            : currentNode.parent_id,
      position:
        patch.position && typeof patch.position === "object"
          ? (patch.position as { x: number; y: number })
          : currentNode.position,
      width: typeof patch.width === "number" ? patch.width : currentNode.width,
      height:
        typeof patch.height === "number" ? patch.height : currentNode.height,
      style:
        patch.style &&
        typeof patch.style === "object" &&
        !Array.isArray(patch.style)
          ? (patch.style as Record<string, unknown>)
          : currentNode.style,
    };
    const bindingPlans = this.planActionAssetBindings(
      this.listNodes().map((node) => (node.id === nodeId ? nextNode : node)),
      this.listEdges(),
      isCanvasManagedAssetAction(currentNode) &&
        !isCanvasManagedAssetAction(nextNode)
        ? [`node:${nodeId}`]
        : [],
    );
    this.validateActionAssetBindingPlans(bindingPlans);
    nodesMap.set(nodeId, {
      ...raw,
      ...patch,
      data: nextData,
    });
    this.applyActionAssetBindingPlans(bindingPlans);
    const update = this.doc.export({ mode: "update", from: versionBefore });
    this.broadcast(update);
    return true;
  }

  moveNode(nodeId: string, position: { x: number; y: number }): boolean {
    const node = this.readNode(nodeId);
    if (!node) return false;
    const nodesMap = this.doc.getMap("nodes");
    const raw = nodesMap.get(nodeId) as Record<string, unknown> | undefined;
    if (!raw) return false;
    const versionBefore = this.doc.version();
    nodesMap.set(nodeId, { ...raw, position });
    const update = this.doc.export({ mode: "update", from: versionBefore });
    this.broadcast(update);
    return true;
  }

  deleteNode(nodeId: string): boolean {
    if (!this.readNode(nodeId)) return false;
    return this.deleteNodes([nodeId]).deletedNodeIds.length === 1;
  }

  deleteNodes(nodeIds: string[]): {
    deletedNodeIds: string[];
    deletedEdgeIds: string[];
  } {
    const uniqueNodeIds = [
      ...new Set(nodeIds.map((nodeId) => nodeId.trim()).filter(Boolean)),
    ];
    if (uniqueNodeIds.length === 0)
      return { deletedNodeIds: [], deletedEdgeIds: [] };

    const nodesMap = this.doc.getMap("nodes");
    const deletedNodeIds = uniqueNodeIds.filter((nodeId) =>
      Boolean(this.readNode(nodeId)),
    );
    if (deletedNodeIds.length === 0)
      return { deletedNodeIds: [], deletedEdgeIds: [] };

    const deletedSet = new Set(deletedNodeIds);
    const versionBefore = this.doc.version();
    const bindingPlans = this.planActionAssetBindings(
      this.listNodes().filter((node) => !deletedSet.has(node.id)),
      this.listEdges().filter(
        (edge) => !deletedSet.has(edge.source) && !deletedSet.has(edge.target),
      ),
      this.listNodes()
        .filter(
          (node) => deletedSet.has(node.id) && isCanvasManagedAssetAction(node),
        )
        .map((node) => `node:${node.id}`),
    );
    this.validateActionAssetBindingPlans(bindingPlans);
    for (const [key, value] of nodesMap.entries()) {
      const raw = value as Record<string, any> | undefined;
      if (!raw || typeof raw !== "object") continue;
      const nodeCanvasId =
        typeof raw.canvasId === "string" ? raw.canvasId : "main";
      if (nodeCanvasId !== this.canvasId) continue;
      if (
        typeof raw.parentId === "string" &&
        deletedSet.has(raw.parentId) &&
        !deletedSet.has(key)
      ) {
        const { parentId: _parentId, extent: _extent, ...rest } = raw;
        nodesMap.set(key, rest);
      }
    }

    const deletedEdgeIds: string[] = [];
    for (const [targetId, value] of nodesMap.entries()) {
      const raw = value as Record<string, any> | undefined;
      if (!raw || typeof raw !== "object") continue;
      const nodeCanvasId =
        typeof raw.canvasId === "string" ? raw.canvasId : "main";
      if (nodeCanvasId !== this.canvasId) continue;
      const upstream = readNodeUpstreamRefs(this.doc, targetId, raw);
      for (const ref of upstream) {
        const remove = deletedSet.has(targetId) || deletedSet.has(ref.nodeId);
        if (remove) deletedEdgeIds.push(ref.edgeId);
        if (remove) deleteNodeUpstreamRef(this.doc, targetId, ref.edgeId, raw);
      }
      if (deletedSet.has(targetId))
        clearNodeUpstreamRefs(this.doc, targetId, raw);
    }
    for (const nodeId of deletedNodeIds) nodesMap.delete(nodeId);
    this.applyActionAssetBindingPlans(bindingPlans);

    const update = this.doc.export({ mode: "update", from: versionBefore });
    this.broadcast(update);
    return { deletedNodeIds, deletedEdgeIds };
  }

  // ── Create with auto-layout ──────────────────────────

  createNode(
    nodeId: string,
    nodeType: string,
    data: Record<string, unknown>,
    position?: { x: number; y: number } | null,
    parentId?: string | null,
    assetId?: string | null,
  ): CreateNodeResult {
    const canvases = this.doc.getMap("canvases");
    if (
      !canvases.get(this.canvasId) &&
      !(this.canvasId === "main" && canvases.size === 0)
    ) {
      return {
        node_id: null,
        error: `Canvas ${this.canvasId} not found`,
        proposal: null,
        asset_id: null,
      };
    }
    const existingRaw = this.doc.getMap("nodes").get(nodeId) as
      Record<string, unknown> | undefined;
    if (existingRaw) {
      const existingCanvasId =
        typeof existingRaw.canvasId === "string"
          ? existingRaw.canvasId
          : "main";
      return {
        node_id: null,
        error:
          existingCanvasId === this.canvasId
            ? `Node ${nodeId} already exists`
            : `Node ${nodeId} already exists in canvas ${existingCanvasId}`,
        proposal: null,
        asset_id: null,
      };
    }

    const mapping =
      AGENT_NODE_TYPE_MAP[nodeType as keyof typeof AGENT_NODE_TYPE_MAP];
    const rfType = mapping?.rfType ?? nodeType;
    const isGenerationNode =
      nodeType === NodeType.ImageGen ||
      nodeType === NodeType.VideoGen ||
      nodeType === NodeType.AudioGen ||
      nodeType === NodeType.TextGen;
    let proposalType: string = ProposalType.Simple;
    const resolvedAssetId = isGenerationNode ? null : (assetId ?? null);

    if (isGenerationNode) {
      proposalType = ProposalType.Generative;
    } else if (nodeType === NodeType.Group) {
      proposalType = ProposalType.Group;
    }

    const nodeData: Record<string, unknown> = { ...data };
    if (isGenerationNode) {
      delete nodeData.assetId;
    } else if (resolvedAssetId) {
      nodeData.assetId = resolvedAssetId;
    }
    // Honor a caller-provided `custom:*` actionType — that's a custom
    // marketplace action and the type-map's built-in actionType would
    // overwrite our routing hint. Built-in types still get the
    // canonical actionType from the map so renames don't leak into
    // CLI / agent callers.
    const callerActionType =
      typeof nodeData.actionType === "string" ? nodeData.actionType : undefined;
    if (mapping && "actionType" in mapping) {
      if (!callerActionType?.startsWith("custom:")) {
        nodeData.actionType = mapping.actionType;
      }
    }

    let finalPos = position ?? null;

    if (!finalPos) {
      const existingNodes = this.listNodes().map(toLayoutNode);
      const virtualNode: LayoutNode = {
        id: nodeId,
        type: rfType,
        position: NEEDS_LAYOUT_POSITION,
        parentId: parentId ?? undefined,
        data: nodeData,
      };
      const result = autoInsertNode(
        nodeId,
        [...existingNodes, virtualNode],
        listNodeOwnedEdges(this.doc),
      );
      finalPos = result.position;

      this.insertNode(nodeId, rfType, nodeData, parentId ?? null, finalPos);

      if (result.pushedNodes.size > 0) {
        this.batchUpdatePositions(result.pushedNodes);
      }
    } else {
      this.insertNode(nodeId, rfType, nodeData, parentId ?? null, finalPos);
    }

    const upstreamNodeIds = (data.upstreamNodeIds ?? data.upstreamIds) as
      string[] | undefined;
    const proposalNodeData: Record<string, unknown> = { id: nodeId, ...data };
    if (isGenerationNode) delete proposalNodeData.assetId;
    const proposal: Record<string, unknown> = {
      id: `proposal-${randomIdPart()}`,
      type: proposalType,
      nodeType: rfType,
      nodeData: proposalNodeData,
      groupId: parentId ?? null,
      message: `Proposed ${nodeType} node: ${(data.label as string) || "Untitled"}`,
    };

    if (resolvedAssetId) {
      proposal.assetId = resolvedAssetId;
      proposalNodeData.assetId = resolvedAssetId;
    }

    if (upstreamNodeIds && Array.isArray(upstreamNodeIds)) {
      const deduped = [...new Set(upstreamNodeIds.filter(Boolean))];
      if (deduped.length) proposal.upstreamNodeIds = deduped;
    }

    return {
      node_id: nodeId,
      error: null,
      proposal,
      asset_id: resolvedAssetId,
    };
  }

  createLinkedNode(opts: {
    nodeId: string;
    nodeType: string;
    data: Record<string, unknown>;
    parentId: string | null;
    sourceNodeId: string;
    edgeId?: string;
    edgeType?: string;
  }): CreateLinkedNodeResult {
    const { nodeId, nodeType, data, parentId, sourceNodeId } = opts;
    if (this.readNode(nodeId)) {
      throw new Error(`Node ${nodeId} already exists`);
    }

    const edgeId = opts.edgeId ?? `${sourceNodeId}-${nodeId}`;
    const edgeType = opts.edgeType ?? "default";

    // Calculate position
    const existingNodes = this.listNodes().map(toLayoutNode);
    const virtualNode: LayoutNode = {
      id: nodeId,
      type: nodeType,
      position: NEEDS_LAYOUT_POSITION,
      parentId: parentId ?? undefined,
      data,
    };
    const result = autoInsertNode(
      nodeId,
      [...existingNodes, virtualNode],
      [...listNodeOwnedEdges(this.doc), { source: sourceNodeId, target: nodeId }],
    );

    // The downstream node owns the relationship, so it must exist before
    // insertEdge can append its canonical upstream reference.
    this.insertNode(nodeId, nodeType, data, parentId, result.position);
    this.insertEdge(edgeId, sourceNodeId, nodeId, edgeType);
    if (result.pushedNodes.size > 0) {
      this.batchUpdatePositions(result.pushedNodes);
    }

    return {
      nodeId,
      position: result.position,
      pushedNodeIds: Array.from(result.pushedNodes.keys()),
    };
  }

  /**
   * Execute a node — the single "do this node's thing" entry point.
   * Branches on node type so callers (CLI, daemon, agent tools) don't
   * re-implement the same readNode + dispatch logic.
   *
   *   action-badge  → spawn a pending asset child (image/video/audio
   *                   gen). Same flow as the legacy executeGeneration.
   *   video-editor  → spawn a pending render-video child carrying the
   *                   editor's timelineDsl. Server's NodeProcessor
   *                   sweeps `type:'video' + status:'pending' +
   *                   timelineDsl` and dispatches the render task.
   *
   * Returns the discriminated `ExecuteResult` so the caller can
   * phrase its log line ("created pending asset" vs "created pending
   * render-video") without re-reading the node.
   */
  execute(
    nodeId: string,
    generateId: () => string,
    /** Answer with this account and no other. */
    providerAccountId?: string,
    /** Host-global plugin definition; never copied into Project state. */
    customActionDefinition?: CustomActionDefinition,
  ): ExecuteResult {
    const node = this.readNode(nodeId);
    if (!node) {
      return {
        kind: null,
        childNodeId: "",
        childNodeType: "",
        position: { x: 0, y: 0 },
        error: `Node ${nodeId} not found`,
      };
    }
    if (node.type === "video-editor") {
      const r = this.executeRender(nodeId, generateId);
      if (r.error) {
        return {
          kind: null,
          childNodeId: "",
          childNodeType: "",
          position: { x: 0, y: 0 },
          error: r.error,
        };
      }
      return {
        kind: "render",
        childNodeId: r.renderNodeId,
        childNodeType: "video",
        position: r.position,
        error: null,
      };
    }
    const r = this.executeGeneration(
      nodeId,
      generateId,
      providerAccountId,
      customActionDefinition,
    );
    if (r.error) {
      return {
        kind: null,
        childNodeId: "",
        childNodeType: "",
        position: { x: 0, y: 0 },
        error: r.error,
      };
    }
    return {
      kind: "generation",
      childNodeId: r.assetNodeId,
      childNodeType: r.assetNodeType,
      position: r.position,
      error: null,
    };
  }

  /**
   * Execute a generation node: validate, build pending asset, insert with edge.
   *
   * Public for back-compat (api-cf agent tool + tests call this directly);
   * new code should prefer `execute()` which dispatches by node type.
   */
  executeGeneration(
    nodeId: string,
    generateId: () => string,
    /**
     * Compatibility argument for host surfaces that accept an account override. Account identity
     * is owner-private execution state and must be handed to the host separately, never projected
     * into the pending Project node.
     */
    _providerAccountId?: string,
    /** Host-global plugin definition; never copied into Project state. */
    customActionDefinition?: CustomActionDefinition,
  ): ExecuteGenerationResult {
    const node = this.readNode(nodeId);
    if (!node) {
      return {
        assetNodeId: "",
        assetNodeType: "",
        position: { x: 0, y: 0 },
        error: `Node ${nodeId} not found`,
      };
    }

    const nodeData = node.data || {};
    const nodeType = node.type;
    const actionType = (nodeData.actionType as string) || "";

    // Validate node is a generation type. Both built-in actionTypes
    // (image-gen / video-gen / audio-gen / text-gen / model-gen) and
    // custom-action actionTypes (`custom:<id>`) are accepted — they
    // unify through buildGenerationPayload below. model-gen covers
    // 3D/model providers (e.g. Tripo text/image-to-model, Tripo
    // auto-rig) — omitting it here made every model-gen action-badge
    // fail before ever reaching the provider.
    const isActionBadge = nodeType === RF_NODE_TYPE.ActionBadge;
    const isBuiltInGen =
      actionType === ACTION_TYPE.ImageGen ||
      actionType === ACTION_TYPE.VideoGen ||
      actionType === ACTION_TYPE.AudioGen ||
      actionType === ACTION_TYPE.TextGen ||
      actionType === ACTION_TYPE.ModelGen;
    const isCustomGen =
      typeof actionType === "string" && actionType.startsWith("custom:");
    if (!isActionBadge || (!isBuiltInGen && !isCustomGen)) {
      return {
        assetNodeId: "",
        assetNodeType: "",
        position: { x: 0, y: 0 },
        error: `Node ${nodeId} is not a generation node`,
      };
    }

    // Native placements pin one immutable draft. Host admission validates its
    // Model Card and inputs; Canvas never recompiles the draft from view fields.
    if (typeof nodeData.generatorId === "string" && typeof nodeData.generatorRevisionId === "string") {
      const assetNodeId = generateId();
      if (this.readNode(assetNodeId)) return { assetNodeId: "", assetNodeType: "", position: { x: 0, y: 0 }, error: `Node ${assetNodeId} already exists` };
      const nativeAction = isCustomGen ? customActionDefinition?.generator : undefined;
      if (isCustomGen && (!nativeAction || customActionDefinition?.id !== nodeData.actionCardId)) {
        return { assetNodeId: "", assetNodeType: "", position: { x: 0, y: 0 }, error: "Read the Action Card's native Generator contract before executing it." };
      }
      if (nativeAction) {
        const revision = readGeneratorRevision(this.doc, { generatorId: nodeData.generatorId, generatorRevisionId: nodeData.generatorRevisionId });
        const binding = customActionDefinition?.pluginBinding;
        const ref = revision?.definitionRef;
        if (!binding || ref?.pluginId !== binding.pluginId || ref.definitionId !== nativeAction.definitionId || ref.version !== binding.version || ref.schemaHash !== binding.schemaHash) {
          return { assetNodeId: "", assetNodeType: "", position: { x: 0, y: 0 }, error: "The Action Card changed. Prepare the native Generator draft before executing it." };
        }
      }
      const assetNodeType = isCustomGen ? customActionDefinition!.outputType : actionType.replace(/-gen$/, "");
      const linked = this.createLinkedNode({
        nodeId: assetNodeId, nodeType: assetNodeType, parentId: node.parent_id, sourceNodeId: nodeId,
        data: { status: "pending", label: nodeData.label ?? "Generated media",
          generatorRevision: { generatorId: nodeData.generatorId, generatorRevisionId: nodeData.generatorRevisionId },
          ...(nativeAction ? { generatorActionId: nativeAction.actionId } : {}),
          ...Object.fromEntries(["actorType", "actorUserId", "actorAgentId"].flatMap((key) => nodeData[key] === undefined ? [] : [[key, nodeData[key]]])),
        },
      });
      return { assetNodeId, assetNodeType, position: linked.position, error: null };
    }

    // Extract prompt
    const prompt =
      (nodeData.content as string) || (nodeData.prompt as string) || "";
    // Some built-in cards declare `requiresPrompt: false` (Tripo
    // auto-rig is model-to-model with no configurable knobs at all;
    // ASR text-gen cards take audio, not a typed prompt). Resolve the
    // requested model card up front so the gate reflects the card's
    // own declaration instead of blanket-requiring a prompt for every
    // built-in actionType.
    const requestedModelIdForPromptCheck =
      (nodeData.modelId as string) || (nodeData.model as string) || "";
    const promptCheckModelCard = isBuiltInGen
      ? this.modelCards.find(
          (c: ModelCard) =>
            c.id ===
            (normalizeModelId(requestedModelIdForPromptCheck) ??
              requestedModelIdForPromptCheck),
        )
      : undefined;
    const cardRequiresPrompt = promptCheckModelCard?.input?.requiresPrompt ?? true;
    if (isBuiltInGen && cardRequiresPrompt && !prompt.trim()) {
      return {
        assetNodeId: "",
        assetNodeType: "",
        position: { x: 0, y: 0 },
        error: "No prompt provided",
      };
    }

    // Resolve the generation config — built-in model or custom action.
    // Both surface as `GenerationConfig` so the same payload builder
    // handles them (partitionRefs / validateRefs work off the unified
    // Capability shape under the hood).
    let config: import("./canvas.js").GenerationConfig;
    if (isCustomGen) {
      const customActionId =
        (nodeData.customActionId as string) ||
        actionType.replace("custom:", "");
      const customDef =
        this.getCustomAction(customActionId) ??
        (customActionDefinition?.id === customActionId
          ? customActionDefinition
          : null);
      if (!customDef) {
        return {
          assetNodeId: "",
          assetNodeType: "",
          position: { x: 0, y: 0 },
          error: `Custom action not installed: ${customActionId}`,
        };
      }
      const customActionParams =
        (nodeData.customActionParams as Record<
          string,
          string | number | boolean
        >) || {};
      config = { kind: "custom", customDef, customActionParams };
    } else {
      const requestedModelId =
        (nodeData.modelId as string) || (nodeData.model as string) || "";
      const modelId = normalizeModelId(requestedModelId) ?? requestedModelId;
      const modelCard = this.modelCards.find(
        (c: ModelCard) => c.id === modelId,
      );
      if (!modelCard) {
        return {
          assetNodeId: "",
          assetNodeType: "",
          position: { x: 0, y: 0 },
          error: `Unknown model: ${requestedModelId || "(missing)"}`,
        };
      }
      const modelParams =
        (nodeData.modelParams as Record<string, string | number | boolean>) ||
        {};
      config = { kind: "model", modelCard, modelParams };
    }

    // Resolve incoming refs from canvas edges. ActionBadge in the web
    // UI uses the same shape (`refNodeIds = edges.filter(target === id).map(source)`)
    // and additionally orders them by `data.referenceImageOrder` so
    // the user's drag-reorder choice survives into "this ref is the
    // start frame, this one is the end frame" semantics. Mirror that
    // ordering here so server-side execute produces an identical
    // sequence; otherwise models like Kling i2v that interpret refs
    // positionally would pick different frames depending on whether
    // the user hit Run via the UI or via the CLI.
    const attachedSourceIds = this.listEdges()
      .filter((e) => e.target === nodeId)
      .map((e) => e.source);
    const orderHint = Array.isArray(nodeData.referenceImageOrder)
      ? (nodeData.referenceImageOrder as string[])
      : [];
    const attachedSet = new Set(attachedSourceIds);
    const ordered = orderHint.filter((nid) => attachedSet.has(nid));
    const seenOrdered = new Set(ordered);
    const extras = attachedSourceIds.filter((nid) => !seenOrdered.has(nid));
    const sortedSourceIds = [...ordered, ...extras];
    const resolvedRefNodes = sortedSourceIds
      .map((sid) => this.readNode(sid))
      .filter((n): n is NonNullable<typeof n> => !!n);

    // Backward-compat: action-badges created before the edge-based
    // ref model (or by agents that wrote the asset-id array
    // directly) carry their refs as bare `referenceImageAssetIds` on
    // the action-badge data. Synthesize stand-in ref nodes so the
    // unified payload builder can partition them too.
    if (
      resolvedRefNodes.length === 0 &&
      Array.isArray(nodeData.referenceImageAssetIds)
    ) {
      for (const aid of nodeData.referenceImageAssetIds as string[]) {
        resolvedRefNodes.push({
          id: aid,
          type: RF_NODE_TYPE.Image,
          parent_id: null,
          position: { x: 0, y: 0 },
          data: { assetId: aid },
        } as any);
      }
    }

    const configId =
      config.kind === "model"
        ? (config.modelCard?.id ??
          ((nodeData.modelId as string) || (nodeData.model as string) || ""))
        : config.customDef.id;
    const { pendingInput, validationError } = buildGenerationPayload({
      prompt,
      lyrics: typeof nodeData.lyrics === "string" ? nodeData.lyrics : undefined,
      refNodes: resolvedRefNodes,
      configId,
      config,
      actionType: actionType as
        | typeof ACTION_TYPE.ImageGen
        | typeof ACTION_TYPE.VideoGen
        | typeof ACTION_TYPE.AudioGen
        | typeof ACTION_TYPE.TextGen
        | typeof ACTION_TYPE.ModelGen
        | `custom:${string}`,
      label: nodeData.label as string | undefined,
      referenceMode: nodeData.referenceMode as string | undefined,
      pluginBinding: ExecutablePluginBindingSchema.safeParse(
        nodeData.pluginBinding,
      ).success
        ? ExecutablePluginBindingSchema.parse(nodeData.pluginBinding)
        : undefined,
    });

    if (validationError) {
      return {
        assetNodeId: "",
        assetNodeType: "",
        position: { x: 0, y: 0 },
        error: validationError,
      };
    }

    // Build pending asset node
    const assetNodeId = generateId();
    if (this.readNode(assetNodeId)) {
      return {
        assetNodeId: "",
        assetNodeType: "",
        position: { x: 0, y: 0 },
        error: `Node ${assetNodeId} already exists`,
      };
    }

    const pendingNode = buildPendingAssetNode({
      ...pendingInput,
      nodeId: assetNodeId,
    });
    const pendingData: Record<string, unknown> = { ...pendingNode.data };
    if (nodeData.actorType === "user" || nodeData.actorType === "agent") {
      pendingData.actorType = nodeData.actorType;
    }
    if (typeof nodeData.actorUserId === "string") {
      pendingData.actorUserId = nodeData.actorUserId;
    }
    if (typeof nodeData.actorAgentId === "string") {
      pendingData.actorAgentId = nodeData.actorAgentId;
    }

    // Create linked node with edge + auto-layout
    const linked = this.createLinkedNode({
      nodeId: pendingNode.id,
      nodeType: pendingNode.type,
      data: pendingData,
      parentId: node.parent_id,
      sourceNodeId: nodeId,
    });

    return {
      assetNodeId: pendingNode.id,
      assetNodeType: pendingNode.type,
      position: linked.position,
      error: null,
    };
  }

  /**
   * Execute a video-editor node: spawn a pending render-video child
   * carrying the editor's `timelineDsl`. Mirrors the web UI's "Render"
   * button (see `pendingRenderVideo.buildPendingRenderVideoNodePayload`
   * + `VideoEditorNode.handleRender`) so an agent driving the canvas
   * via CLI can trigger the same pipeline without a browser.
   *
   * Server-side `NodeProcessor.poll` then sees a `video` node with
   * `data.status === "pending"` AND `data.timelineDsl != null` and
   * dispatches the render task to the render-server.
   */
  executeRender(
    editorNodeId: string,
    generateId: () => string,
  ): {
    renderNodeId: string;
    position: { x: number; y: number };
    error: string | null;
  } {
    const node = this.readNode(editorNodeId);
    if (!node) {
      return {
        renderNodeId: "",
        position: { x: 0, y: 0 },
        error: `Node ${editorNodeId} not found`,
      };
    }
    const timelineId =
      typeof node.data?.timelineId === "string"
        ? node.data.timelineId
        : undefined;
    if (!timelineId) {
      return {
        renderNodeId: "",
        position: { x: 0, y: 0 },
        error: `Timeline Action ${editorNodeId} must reference a Project Timeline`,
      };
    }
    const timeline = readProjectTimeline(this.doc, timelineId);
    if (
      !timeline ||
      timeline.owner.kind !== "canvas-action" ||
      timeline.owner.canvasId !== this.canvasId ||
      timeline.owner.actionNodeId !== editorNodeId
    ) {
      return {
        renderNodeId: "",
        position: { x: 0, y: 0 },
        error: `Timeline ${timelineId} is not owned by action ${editorNodeId} in canvas ${this.canvasId}`,
      };
    }
    const timelineDsl = timeline.state as
      | {
          tracks?: Array<{
            items?: Array<{ from?: number; durationInFrames?: number }>;
          }>;
          compositionWidth?: number;
          compositionHeight?: number;
          fps?: number;
          durationInFrames?: number;
        }
      | undefined;
    if (!timelineDsl || typeof timelineDsl !== "object") {
      return {
        renderNodeId: "",
        position: { x: 0, y: 0 },
        error: `Node ${editorNodeId} has no timelineDsl — pull / edit / push one first.`,
      };
    }
    const tracks = Array.isArray(timelineDsl.tracks) ? timelineDsl.tracks : [];
    const totalItems = tracks.reduce(
      (n, t) => n + (Array.isArray(t.items) ? t.items.length : 0),
      0,
    );
    if (totalItems === 0) {
      return {
        renderNodeId: "",
        position: { x: 0, y: 0 },
        error: `Node ${editorNodeId} timelineDsl has no items — nothing to render.`,
      };
    }

    // Compute the actual playable length (max item end). Falls back to
    // the timeline's declared durationInFrames so the render always
    // covers every item even if the agent forgot to update the top-level
    // value after appending a clip.
    let maxEnd = 0;
    for (const track of tracks) {
      for (const item of track.items ?? []) {
        const from = typeof item.from === "number" ? item.from : 0;
        const dur =
          typeof item.durationInFrames === "number" ? item.durationInFrames : 0;
        if (from + dur > maxEnd) maxEnd = from + dur;
      }
    }
    const declaredDuration =
      typeof timelineDsl.durationInFrames === "number"
        ? timelineDsl.durationInFrames
        : 0;
    const renderDurationInFrames = Math.max(maxEnd, declaredDuration, 1);

    const naturalWidth =
      typeof timelineDsl.compositionWidth === "number" &&
      timelineDsl.compositionWidth > 0
        ? timelineDsl.compositionWidth
        : 1920;
    const naturalHeight =
      typeof timelineDsl.compositionHeight === "number" &&
      timelineDsl.compositionHeight > 0
        ? timelineDsl.compositionHeight
        : 1080;

    const renderNodeId = generateId();
    if (this.readNode(renderNodeId)) {
      return {
        renderNodeId: "",
        position: { x: 0, y: 0 },
        error: `Node ${renderNodeId} already exists`,
      };
    }

    const actionRunId = projectTimelineRenderActionRunId(renderNodeId);
    const frozenPreflight = freezeProjectTimelineRunAssetInputs(
      this.doc.fork(),
      timeline,
      actionRunId,
    );
    if (!frozenPreflight.ok) {
      return {
        renderNodeId: "",
        position: { x: 0, y: 0 },
        error: frozenPreflight.error,
      };
    }

    const data: Record<string, unknown> = {
      label: "Rendered Video",
      status: TaskStatus.Pending,
      timeline: ProjectTimelineEnvelopeSchema.parse({
        name: timeline.name,
        owner: timeline.owner,
        state: { ...timelineDsl, durationInFrames: renderDurationInFrames },
      }),
      timelineDsl: { ...timelineDsl, durationInFrames: renderDurationInFrames },
      ...(timelineId ? { sourceTimelineId: timelineId } : {}),
      sourceTimelineActionId: frozenPreflight.owner.actionId,
      sourceTimelineRevisionId: timeline.revisionId,
      sourceTimelineActionRunId: actionRunId,
      pendingTask: null,
      naturalWidth,
      naturalHeight,
      aspectRatio: `${naturalWidth}:${naturalHeight}`,
    };

    const linked = this.createLinkedNode({
      nodeId: renderNodeId,
      nodeType: RF_NODE_TYPE.Video ?? "video",
      data,
      parentId: node.parent_id,
      sourceNodeId: editorNodeId,
    });
    const frozen = freezeProjectTimelineRunAssetInputs(
      this.doc,
      timeline,
      actionRunId,
    );
    if (!frozen.ok) {
      throw new Error(
        `Timeline ${timeline.id} input freeze changed after preflight: ${frozen.error}`,
      );
    }

    return { renderNodeId, position: linked.position, error: null };
  }

  // ── Private ──────────────────────────────────────────

  private planActionAssetBindings(
    nodes: readonly NodeInfo[],
    edges: readonly CanvasEdgeInfo[],
    clearedActionIds: readonly string[] = [],
  ): Array<{ actionId: string; inputs: DraftActionAssetInput[] }> {
    const plans = new Map<string, DraftActionAssetInput[]>();
    for (const actionId of clearedActionIds) plans.set(actionId, []);
    for (const node of nodes) {
      const inputs = canvasActionAssetInputs({ node, nodes, edges });
      if (inputs === null) continue;
      plans.set(`node:${node.id}`, inputs);
    }
    return [...plans.entries()].map(([actionId, inputs]) => ({
      actionId,
      inputs,
    }));
  }

  private validateActionAssetBindingPlans(
    plans: readonly {
      actionId: string;
      inputs: readonly DraftActionAssetInput[];
    }[],
  ): void {
    const authority = actionAssetBindingAuthorityVersion(this.doc);
    if (authority === undefined) return;
    if (authority !== ACTION_ASSET_BINDING_AUTHORITY_VERSION) {
      throw new Error(
        `Unsupported Action Asset binding authority version: ${String(authority)}`,
      );
    }
    for (const plan of plans) {
      for (const input of plan.inputs) {
        const asset = readProjectAsset(this.doc, input.projectAssetId);
        if (!asset || asset.lifecycle.state !== "active") {
          throw new Error(
            `Project Asset ${input.projectAssetId} is not active`,
          );
        }
      }
    }
  }

  private applyActionAssetBindingPlans(
    plans: readonly {
      actionId: string;
      inputs: readonly DraftActionAssetInput[];
    }[],
  ): void {
    for (const plan of plans) {
      const result = replaceDraftActionAssetInputBindings(
        this.doc,
        plan.actionId,
        plan.inputs,
      );
      if (!result.ok) throw new Error(result.error);
    }
  }

  private batchUpdatePositions(
    updates: Map<string, { x: number; y: number }>,
  ): void {
    if (updates.size === 0) return;
    const versionBefore = this.doc.version();
    const nodesMap = this.doc.getMap("nodes");
    for (const [nodeId, pos] of updates) {
      const raw = nodesMap.get(nodeId) as Record<string, any> | undefined;
      if (raw) nodesMap.set(nodeId, { ...raw, position: pos });
    }
    const update = this.doc.export({ mode: "update", from: versionBefore });
    this.broadcast(update);
  }

  private ensureWritableCanvas(): void {
    const canvases = this.doc.getMap("canvases");
    if (canvases.get(this.canvasId)) return;
    if (this.canvasId === "main" && canvases.size === 0) {
      ensureProjectCanvas(this.doc, this.canvasId);
      return;
    }
    throw new Error(`Canvas ${this.canvasId} not found`);
  }
}
