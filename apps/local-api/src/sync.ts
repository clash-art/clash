import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LoroDoc } from "loro-crdt";
import { ReplicaEngine, type ReplicaLinkPort } from "@clash/replica";
import { LoroStateAdapter } from "@clash/replica/loro";
import {
  LoroProtocolServerSession,
  createLoroProtocolBatchId,
  encodeLoroProtocolUpdateFrames,
} from "@clash/replica/loro-protocol";
import {
  ACTION_ASSET_BINDINGS_CONTAINER,
  ACTION_ASSET_BINDING_SCHEMA_CONTAINER,
  ActionAssetBindingSchema,
  DEFAULT_CANVAS_ID,
  DOCUMENT_ASSET_REVISIONS_CONTAINER,
  DOCUMENT_ASSET_SCHEMA_CONTAINER,
  DOCUMENT_ATTACHMENTS_CONTAINER,
  GENERATOR_ACTION_RUNS_CONTAINER,
  GENERATOR_OUTPUT_COMMITS_CONTAINER,
  GENERATOR_REVISIONS_CONTAINER,
  GENERATOR_SCHEMA_CONTAINER,
  PROJECT_ASSETS_CONTAINER,
  PROJECT_ASSET_SCHEMA_CONTAINER,
  PROJECT_DOCUMENT_ASSETS_CONTAINER,
  PROJECT_GENERATORS_CONTAINER,
  canonicalTimelineRenderDsl,
  canvasGraphReconciliationChanged,
  reconcileCanvasGraph,
  reconcileActionAssetBindingTargets,
  reconcileProjectCoverBindings,
  reconcileProjectTimelineOwnership,
  reconcileProjectDirectorStageOwnership,
  loroSyncUpdateId,
  listActionAssetBindingsForOwner,
  projectTimelineActionId,
  projectTimelineAssetInputs,
  projectTimelineRenderActionRunId,
  readProjectAsset,
  readProjectTimeline,
  ProjectMetadataEnvelopeSchema,
  type ProjectMetadata,
  type ActionAssetBinding,
  type ActivityAction,
  type ActivityMessage,
  type ClientType,
  type PresenceClient,
} from "@clash/shared-types";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { FileReplicaStore } from "./loro/file-replica-store.js";
import { createFileReplicaPorts } from "./loro/replica-ports.js";
import { LoroCloudReplicaLink } from "./loro/cloud-replica-link.js";
import type { LocalWorkflowProcessor } from "./local-processor.js";
import { projectCanvasPreviewCacheEntryFromDoc } from "./project-canvas-preview-cache.js";

type UpgradeCapableServer = {
  on(
    event: "upgrade",
    listener: (request: any, socket: any, head: any) => void,
  ): void;
};

export interface LocalSyncOptions {
  dataDir: string;
  projectId: string;
  remotePersistence?: RemoteLoroPersistenceSource;
  workflowProcessor?: LocalWorkflowProcessor | null;
  canvasPreviewCacheEnabled?: boolean;
}

export interface RemoteLoroPersistence {
  loadSnapshot?(projectId: string): Promise<Uint8Array | null>;
  appendUpdate(projectId: string, update: Uint8Array): Promise<void>;
  /** Optional product metadata mirror; deliberately separate from Loro bytes. */
  loadProjectMetadata?(projectId: string): Promise<ProjectMetadata | null>;
  saveProjectMetadata?(
    projectId: string,
    metadata: ProjectMetadata,
  ): Promise<void>;
  createLink?(options: {
    projectId: string;
    doc(): LoroDoc;
    commit(batchId: string, updates: Uint8Array[]): Promise<void>;
  }): ReplicaLinkPort<Uint8Array>;
}

export type RemoteLoroPersistenceSource =
  | RemoteLoroPersistence
  | ((projectId?: string) =>
      | RemoteLoroPersistence
      | undefined
      | Promise<RemoteLoroPersistence | undefined>);

type PeerId = symbol;
type SendPeerUpdate = (data: Uint8Array) => void;
type SendPeerJson = (msg: Record<string, unknown>) => void;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const LOCAL_LORO_COMPACT_UPDATE_THRESHOLD = 16;
const LOCAL_LORO_COMPACT_BYTES_THRESHOLD = 1024 * 1024;
const PROJECT_CANVAS_PREVIEW_DEBOUNCE_MS = 350;
const HOST_OWNED_GENERATOR_AUTHORITY_CONTAINERS = [
  GENERATOR_SCHEMA_CONTAINER,
  PROJECT_GENERATORS_CONTAINER,
  GENERATOR_REVISIONS_CONTAINER,
  GENERATOR_ACTION_RUNS_CONTAINER,
  GENERATOR_OUTPUT_COMMITS_CONTAINER,
] as const;
const HOST_OWNED_DOCUMENT_ASSET_AUTHORITY_CONTAINERS = [
  DOCUMENT_ASSET_SCHEMA_CONTAINER,
  PROJECT_DOCUMENT_ASSETS_CONTAINER,
  DOCUMENT_ASSET_REVISIONS_CONTAINER,
  DOCUMENT_ATTACHMENTS_CONTAINER,
] as const;

interface LocalPeer {
  sendUpdate: SendPeerUpdate;
  sendJson?: SendPeerJson;
  runtimeId?: string;
  presence?: PresenceClient;
  syncProtocol?: "loro-v1";
}

export interface HttpRemoteLoroPersistenceOptions {
  baseUrl: string;
  token?: string;
  fetch?: FetchLike;
}

export interface RemoteLoroPersistenceEnv {
  CLASH_REMOTE_LORO_URL?: string;
  CLASH_REMOTE_LORO_TOKEN?: string;
}

function exactBytes(view: Uint8Array): Uint8Array {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? view
    : view.slice();
}

function assertLocalPeerHostOwnedAuthorityMutation(
  current: LoroDoc,
  candidate: LoroDoc,
  authorityName: "Generator" | "Document Asset",
  containers: readonly string[],
): void {
  for (const container of containers) {
    if (
      !isDeepStrictEqual(
        candidate.getMap(container).toJSON(),
        current.getMap(container).toJSON(),
      )
    ) {
      throw new Error(
        `Local peers cannot mutate Host-owned ${authorityName} authority.`,
      );
    }
  }
}

function isPeerEditableActionAssetBinding(
  binding: ActionAssetBinding | undefined,
): boolean {
  return (
    binding !== undefined &&
    binding.owner.kind === "draft" &&
    binding.direction === "input"
  );
}

function isMatchingPeerTimelineRunInput(
  candidate: LoroDoc,
  binding: ActionAssetBinding | undefined,
): boolean {
  if (binding?.direction !== "input" || binding.owner.kind !== "run") {
    return false;
  }
  for (const [nodeId, raw] of candidate.getMap("nodes").entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    if ((raw as Record<string, unknown>).type !== "video") continue;
    const data = (raw as Record<string, unknown>).data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      continue;
    }
    const fields = data as Record<string, unknown>;
    if (fields.status !== "pending" && fields.status !== "generating") continue;
    if (
      projectTimelineRenderActionRunId(nodeId) !== binding.owner.actionRunId ||
      fields.sourceTimelineActionRunId !== binding.owner.actionRunId
    ) {
      continue;
    }
    const timelineId = fields.sourceTimelineId;
    if (typeof timelineId !== "string") continue;
    const timeline = readProjectTimeline(candidate, timelineId);
    if (!timeline) continue;
    if (
      projectTimelineActionId(timeline.id, timeline.owner) !==
        binding.owner.actionId ||
      fields.sourceTimelineActionId !== binding.owner.actionId ||
      timeline.revisionId !== binding.owner.actionRevisionId ||
      fields.sourceTimelineRevisionId !== binding.owner.actionRevisionId
    ) {
      continue;
    }
    const canonicalDsl = canonicalTimelineRenderDsl(timeline.state);
    if (
      canonicalDsl === null ||
      !isDeepStrictEqual(fields.timelineDsl, canonicalDsl)
    ) {
      continue;
    }
    const expected = projectTimelineAssetInputs(timeline.state).sort(
      (left, right) => left.slot.localeCompare(right.slot),
    );
    const actual = listActionAssetBindingsForOwner(candidate, binding.owner)
      .filter((candidateBinding) => candidateBinding.direction === "input")
      .sort((left, right) => left.slot.localeCompare(right.slot));
    if (
      expected.length === actual.length &&
      expected.every((input, index) => {
        const candidateBinding = actual[index];
        return (
          candidateBinding !== undefined &&
          candidateBinding.slot === input.slot &&
          candidateBinding.projectAssetId === input.projectAssetId &&
          candidateBinding.role === input.role
        );
      })
    ) {
      return true;
    }
  }
  return false;
}

function actionAssetBindingFromPeerRaw(
  id: string,
  raw: unknown,
): ActionAssetBinding | undefined {
  if (raw === undefined) return undefined;
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).unbound === true
  ) {
    return undefined;
  }
  const parsed = ActionAssetBindingSchema.safeParse({
    id,
    ...(raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}),
  });
  if (!parsed.success) {
    throw new Error(
      `Local peer supplied invalid Action Asset binding ${id}: ${parsed.error.issues[0]?.message ?? "invalid binding"}.`,
    );
  }
  return parsed.data;
}

function assertLocalPeerActionAssetBindingMutation(
  current: LoroDoc,
  candidate: LoroDoc,
): void {
  if (
    !isDeepStrictEqual(
      candidate.getMap(ACTION_ASSET_BINDING_SCHEMA_CONTAINER).toJSON(),
      current.getMap(ACTION_ASSET_BINDING_SCHEMA_CONTAINER).toJSON(),
    )
  ) {
    throw new Error(
      "Local peers cannot mutate Host-owned Action Asset binding authority markers.",
    );
  }

  const currentRaw = current
    .getMap(ACTION_ASSET_BINDINGS_CONTAINER)
    .toJSON() as Record<string, unknown>;
  const candidateRaw = candidate
    .getMap(ACTION_ASSET_BINDINGS_CONTAINER)
    .toJSON() as Record<string, unknown>;
  for (const id of new Set([
    ...Object.keys(currentRaw),
    ...Object.keys(candidateRaw),
  ])) {
    if (isDeepStrictEqual(currentRaw[id], candidateRaw[id])) continue;
    const before = actionAssetBindingFromPeerRaw(id, currentRaw[id]);
    const after = actionAssetBindingFromPeerRaw(id, candidateRaw[id]);
    if (after?.direction === "input") {
      const target = readProjectAsset(candidate, after.projectAssetId);
      if (!target || target.lifecycle.state === "purged") {
        throw new Error(
          `Local peer Action Asset input ${id} points to Project Asset ${after.projectAssetId}, which is not active or recoverable.`,
        );
      }
    }
    const changedEditableDraftInput =
      (before === undefined || isPeerEditableActionAssetBinding(before)) &&
      (after === undefined || isPeerEditableActionAssetBinding(after)) &&
      (before !== undefined || after !== undefined);
    if (changedEditableDraftInput) continue;
    if (
      before === undefined &&
      isMatchingPeerTimelineRunInput(candidate, after)
    ) {
      continue;
    }
    if (after?.direction === "input" && after.owner.kind !== "draft") {
      throw new Error(
        "Local peers cannot create or rewrite frozen run inputs outside a matching Timeline submission.",
      );
    }
    throw new Error(
      "Local peers may mutate input bindings only; run/revision output lineage is Host-owned.",
    );
  }
}

function exactArrayBuffer(view: Uint8Array): ArrayBuffer {
  const bytes = exactBytes(view);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function remoteProjectUrl(
  baseUrl: string,
  projectId: string,
  suffix: string,
): string {
  return `${baseUrl.replace(/\/+$/, "")}/loro/${encodeURIComponent(projectId)}/${suffix}`;
}

function remoteHeaders(
  token: string | undefined,
  extra?: Record<string, string>,
) {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function assertRemoteOk(
  response: Response,
  operation: string,
): Promise<void> {
  if (response.ok) return;
  throw new Error(
    `Remote Loro ${operation} failed with HTTP ${response.status}`,
  );
}

async function resolveRemotePersistence(
  source: RemoteLoroPersistenceSource | undefined,
  projectId?: string,
): Promise<RemoteLoroPersistence | undefined> {
  if (!source) return undefined;
  if (typeof source === "function") return source(projectId);
  return source;
}

export function createHttpRemoteLoroPersistence(
  options: HttpRemoteLoroPersistenceOptions,
): RemoteLoroPersistence {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async loadSnapshot(projectId) {
      const response = await fetchImpl(
        remoteProjectUrl(options.baseUrl, projectId, "snapshot"),
        {
          method: "GET",
          headers: remoteHeaders(options.token),
        },
      );
      if (response.status === 404 || response.status === 204) return null;
      await assertRemoteOk(response, "snapshot load");
      return new Uint8Array(await response.arrayBuffer());
    },
    async appendUpdate(projectId, update) {
      const response = await fetchImpl(
        remoteProjectUrl(options.baseUrl, projectId, "updates"),
        {
          method: "POST",
          headers: remoteHeaders(options.token, {
            "content-type": "application/octet-stream",
          }),
          body: exactArrayBuffer(update),
        },
      );
      await assertRemoteOk(response, "update append");
    },
    async loadProjectMetadata(projectId) {
      const response = await fetchImpl(
        remoteProjectUrl(options.baseUrl, projectId, "metadata"),
        {
          method: "GET",
          headers: remoteHeaders(options.token),
        },
      );
      if (response.status === 404 || response.status === 204) return null;
      await assertRemoteOk(response, "metadata load");
      const payload = ProjectMetadataEnvelopeSchema.parse(
        await response.json(),
      );
      return payload.metadata;
    },
    async saveProjectMetadata(projectId, metadata) {
      const response = await fetchImpl(
        remoteProjectUrl(options.baseUrl, projectId, "metadata"),
        {
          method: "PUT",
          headers: remoteHeaders(options.token, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({ schemaVersion: 1, metadata }),
        },
      );
      await assertRemoteOk(response, "metadata save");
    },
    createLink({ projectId, doc, commit }) {
      return new LoroCloudReplicaLink({
        baseUrl: options.baseUrl,
        projectId,
        token: options.token,
        doc,
        commit,
      });
    },
  };
}

export function createRemoteLoroPersistenceFromEnv(
  env: RemoteLoroPersistenceEnv,
  fetchImpl?: FetchLike,
): RemoteLoroPersistence | undefined {
  const baseUrl = env.CLASH_REMOTE_LORO_URL?.trim();
  if (!baseUrl) return undefined;
  return createHttpRemoteLoroPersistence({
    baseUrl,
    token: env.CLASH_REMOTE_LORO_TOKEN?.trim() || undefined,
    fetch: fetchImpl,
  });
}

async function loadDoc(options: LocalSyncOptions): Promise<{
  doc: LoroDoc;
  replica: ReplicaEngine<LoroDoc, Uint8Array, Uint8Array>;
  store: FileReplicaStore;
  importedRemoteSnapshot: boolean;
  workspaceRepaired: boolean;
  remotePersistence?: RemoteLoroPersistence;
}> {
  const store = new FileReplicaStore(join(options.dataDir, "projects"));
  let replica: ReplicaEngine<LoroDoc, Uint8Array, Uint8Array>;
  try {
    replica = await ReplicaEngine.open({
      adapter: new LoroStateAdapter(),
      ...(await createFileReplicaPorts(store, options.projectId)),
    });
  } catch (error) {
    console.error("[local-sync] failed to recover local replica", error);
    throw error;
  }
  const durableDoc = replica.read((state) => state);
  const doc = LoroDoc.fromSnapshot(durableDoc.export({ mode: "snapshot" }));
  const durableVersion = durableDoc.version();

  let importedRemoteSnapshot = false;
  const remotePersistence = await resolveRemotePersistence(
    options.remotePersistence,
    options.projectId,
  );
  if (remotePersistence?.loadSnapshot) {
    try {
      const remoteSnapshot = await remotePersistence.loadSnapshot(
        options.projectId,
      );
      if (remoteSnapshot?.byteLength) {
        doc.import(remoteSnapshot);
        importedRemoteSnapshot = true;
      }
    } catch (error) {
      console.error("[local-sync] failed to import remote snapshot", error);
    }
  }

  const graphRepair = reconcileCanvasGraph(doc);
  const timelineRepair = reconcileProjectTimelineOwnership(doc);
  const directorRepair = reconcileProjectDirectorStageOwnership(doc);
  const projectCoverRepair = reconcileProjectCoverBindings(doc);
  const assetBindingRepair = reconcileActionAssetBindingTargets(doc);
  const workspaceRepaired =
    canvasGraphReconciliationChanged(graphRepair) ||
    timelineRepair.removedActionNodeIds.length > 0 ||
    timelineRepair.detachedTimelineIds.length > 0 ||
    directorRepair.removedActionNodeIds.length > 0 ||
    directorRepair.detachedStageIds.length > 0 ||
    projectCoverRepair.changed ||
    assetBindingRepair.restoredProjectAssetIds.length > 0;

  const recoveredDelta = exactBytes(
    doc.export({ mode: "update", from: durableVersion }),
  );
  durableVersion.free();
  if (recoveredDelta.byteLength > 0) {
    await replica.submit({
      id: `bootstrap:${loroSyncUpdateId(recoveredDelta)}`,
      update: recoveredDelta,
    });
  }

  return {
    doc,
    replica,
    store,
    importedRemoteSnapshot,
    workspaceRepaired,
    remotePersistence,
  };
}

export class LocalLoroRoom {
  private peers = new Map<PeerId, LocalPeer>();
  private projectOperations: Promise<void> = Promise.resolve();
  private checkpointedDoc: LoroDoc;
  private updatesSinceSnapshot = 0;
  private updateBytesSinceSnapshot = 0;
  private activityThrottle = new Map<string, number>();
  private pendingWorkQueue: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollScheduleVersion = 0;
  private canvasPreviewTimer: ReturnType<typeof setTimeout> | undefined;
  private canvasPreviewWrites: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private remoteLink: ReplicaLinkPort<Uint8Array> | undefined;

  private constructor(
    private readonly projectId: string,
    private doc: LoroDoc,
    private readonly replica: ReplicaEngine<LoroDoc, Uint8Array, Uint8Array>,
    private readonly store: FileReplicaStore,
    private readonly remotePersistence?: RemoteLoroPersistenceSource,
    private readonly workflowProcessor?: LocalWorkflowProcessor,
    private readonly canvasPreviewCacheEnabled = false,
  ) {
    this.checkpointedDoc = this.replica.read((state) => state);
  }

  static async open(
    options: LocalSyncOptions,
    onCheckpointReadable?: (room: LocalLoroRoom) => void | Promise<void>,
  ): Promise<LocalLoroRoom> {
    const loaded = await loadDoc(options);
    const room = new LocalLoroRoom(
      options.projectId,
      loaded.doc,
      loaded.replica,
      loaded.store,
      options.remotePersistence,
      options.workflowProcessor ?? undefined,
      options.canvasPreviewCacheEnabled ?? false,
    );
    if (loaded.importedRemoteSnapshot || loaded.workspaceRepaired)
      await room.saveSnapshot();
    room.attachRemoteLink(loaded.remotePersistence);
    await onCheckpointReadable?.(room);
    await room.processPendingWork();
    return room;
  }

  snapshot(): Uint8Array {
    return this.doc.export({ mode: "snapshot" });
  }

  /** Read-only protocol adapter access; mutations still go through receive(). */
  protocolDocument(): LoroDoc {
    return this.doc;
  }

  private async enqueueProjectOperation<T>(
    task: () => Promise<T> | T,
  ): Promise<T> {
    const run = this.projectOperations.then(task);
    this.projectOperations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  inspectProject<T>(read: (doc: LoroDoc) => T | Promise<T>): Promise<T> {
    return this.enqueueProjectOperation(() =>
      read(LoroDoc.fromSnapshot(this.doc.export({ mode: "snapshot" }))),
    );
  }

  /**
   * Reads the last durability-acknowledged Project state without joining the room queue.
   *
   * A Provider invocation runs while its workflow owns that queue, so an ordinary inspect would
   * wait behind the invocation that is waiting for the inspect. The callback receives a clone so
   * it can neither observe later uncheckpointed work nor mutate the room's committed read view.
   */
  async inspectCheckpointedProject<T>(
    read: (doc: LoroDoc) => T | Promise<T>,
  ): Promise<T> {
    return await read(
      LoroDoc.fromSnapshot(this.checkpointedDoc.export({ mode: "snapshot" })),
    );
  }

  mutateProject<T>(
    mutation: (
      doc: LoroDoc,
    ) => { value: T; save?: boolean } | Promise<{ value: T; save?: boolean }>,
  ): Promise<T> {
    return this.enqueueProjectOperation(async () => {
      try {
        const versionBefore = this.doc.version();
        const result = await mutation(this.doc);
        const update = exactBytes(
          this.doc.export({ mode: "update", from: versionBefore }),
        );
        // `save` is an optimization hint for the file-backed adapter. The live room trusts the
        // actual CRDT delta: if a callback changed the Project, leaving it only in memory would make
        // the next compaction erase the HTTP mutation.
        if (update.byteLength > 0) {
          await this.persistUpdate(update);
          for (const peer of this.peers.values()) peer.sendUpdate(update);
          this.mirrorRemoteUpdate(update);
        }
        return result.value;
      } catch (error) {
        this.restoreLiveProjectFromCheckpoint();
        throw error;
      }
    });
  }

  /**
   * Serial Host mutation with an explicit durability acknowledgement.
   *
   * Generator submission uses the acknowledgement to persist its public Run
   * request before creating the owner-private durable task. The callback and
   * all checkpoints stay on the same live Project document and operation
   * queue, so no file snapshot can race an open room.
   */
  mutateProjectWithCheckpoint<T>(
    mutation: (doc: LoroDoc, checkpoint: () => Promise<void>) => T | Promise<T>,
  ): Promise<T> {
    return this.enqueueProjectOperation(async () => {
      try {
        let versionBefore = this.doc.version();
        const checkpoint = async (): Promise<void> => {
          const update = exactBytes(
            this.doc.export({ mode: "update", from: versionBefore }),
          );
          if (update.byteLength === 0) return;
          await this.persistUpdate(update);
          versionBefore = this.doc.version();
          for (const peer of this.peers.values()) peer.sendUpdate(update);
          this.mirrorRemoteUpdate(update);
        };
        const value = await mutation(this.doc, checkpoint);
        await checkpoint();
        return value;
      } catch (error) {
        this.restoreLiveProjectFromCheckpoint();
        throw error;
      }
    });
  }

  /**
   * Imports a mutation committed through the local HTTP project-command surface, then runs the
   * same pending-work queue used by WebSocket peers. GUI, CLI, and MCP therefore share one room
   * authority even when the command did not originate on the room socket.
   */
  async refreshFromStore(): Promise<void> {
    await this.enqueueProjectOperation(() => this.refreshFromStoreUnsafe());
    await this.processPendingWork();
  }

  private async refreshFromStoreUnsafe(): Promise<void> {
    const persisted = await this.store.recover(this.projectId);
    const durableVersion = this.checkpointedDoc.version();
    const missingDurableUpdate = exactBytes(
      persisted.export({ mode: "update", from: durableVersion }),
    );
    durableVersion.free();
    if (missingDurableUpdate.byteLength > 0) {
      await this.persistUpdate(missingDurableUpdate);
    }
    const versionBefore = this.doc.version();
    this.doc.import(persisted.export({ mode: "snapshot" }));
    const repairVersion = this.doc.version();
    const projectCoverRepair = reconcileProjectCoverBindings(this.doc);
    const assetBindingRepair = reconcileActionAssetBindingTargets(this.doc);
    const repairUpdate =
      projectCoverRepair.changed ||
      assetBindingRepair.restoredProjectAssetIds.length > 0
        ? exactBytes(this.doc.export({ mode: "update", from: repairVersion }))
        : null;
    const update = exactBytes(
      this.doc.export({ mode: "update", from: versionBefore }),
    );
    if (update.byteLength > 0) {
      for (const peer of this.peers.values()) peer.sendUpdate(update);
      this.scheduleCanvasPreviewRefresh();
    }
    if (repairUpdate?.byteLength) {
      await this.persistUpdate(repairUpdate);
      this.mirrorRemoteUpdate(repairUpdate);
    }
  }

  addPeer(
    send: SendPeerUpdate,
    options?: {
      sendJson?: SendPeerJson;
      runtimeId?: string;
      presence?: PresenceClient;
      syncProtocol?: "loro-v1";
      sendInitialSnapshot?: boolean;
    },
  ): PeerId {
    const id = Symbol("peer");
    this.peers.set(id, {
      sendUpdate: send,
      sendJson: options?.sendJson,
      runtimeId: options?.runtimeId,
      presence: options?.presence,
      syncProtocol: options?.syncProtocol,
    });
    if (options?.sendInitialSnapshot !== false) send(this.snapshot());
    this.broadcastPresence();
    return id;
  }

  removePeer(id: PeerId): void {
    this.peers.delete(id);
    this.broadcastPresence();
  }

  async receive(sender: PeerId, update: Uint8Array): Promise<void> {
    await this.enqueueProjectOperation(() =>
      this.receiveUnsafe(sender, update),
    );
    await this.processPendingWork();
  }

  private async receiveCloudUpdates(
    _batchId: string,
    updates: Uint8Array[],
  ): Promise<void> {
    await this.enqueueProjectOperation(async () => {
      for (const raw of updates) {
        const update = exactBytes(raw);
        await this.persistUpdate(update);
        this.doc.import(update);
        for (const peer of this.peers.values()) peer.sendUpdate(update);
      }

      const repairVersion = this.doc.version();
      const graphRepair = reconcileCanvasGraph(this.doc);
      const timelineRepair = reconcileProjectTimelineOwnership(this.doc);
      const directorRepair = reconcileProjectDirectorStageOwnership(this.doc);
      const projectCoverRepair = reconcileProjectCoverBindings(this.doc);
      const assetBindingRepair = reconcileActionAssetBindingTargets(this.doc);
      const repaired =
        canvasGraphReconciliationChanged(graphRepair) ||
        timelineRepair.removedActionNodeIds.length > 0 ||
        timelineRepair.detachedTimelineIds.length > 0 ||
        directorRepair.removedActionNodeIds.length > 0 ||
        directorRepair.detachedStageIds.length > 0 ||
        projectCoverRepair.changed ||
        assetBindingRepair.restoredProjectAssetIds.length > 0;
      const repairUpdate = repaired
        ? exactBytes(this.doc.export({ mode: "update", from: repairVersion }))
        : undefined;
      repairVersion.free();
      if (repairUpdate?.byteLength) {
        await this.persistUpdate(repairUpdate);
        for (const peer of this.peers.values()) peer.sendUpdate(repairUpdate);
        this.remoteLink?.publish(repairUpdate);
      }
    });
    await this.processPendingWork();
  }

  private async receiveUnsafe(
    sender: PeerId,
    update: Uint8Array,
  ): Promise<void> {
    const updateBytes = exactBytes(update);
    const nodesMap = this.doc.getMap("nodes");
    const nodesBefore = new Map<string, Record<string, any>>();
    for (const [id, raw] of nodesMap.entries()) {
      nodesBefore.set(id, raw as Record<string, any>);
    }
    const candidate = this.doc.fork();
    candidate.import(updateBytes);
    assertLocalPeerHostOwnedAuthorityMutation(
      this.doc,
      candidate,
      "Generator",
      HOST_OWNED_GENERATOR_AUTHORITY_CONTAINERS,
    );
    assertLocalPeerHostOwnedAuthorityMutation(
      this.doc,
      candidate,
      "Document Asset",
      HOST_OWNED_DOCUMENT_ASSET_AUTHORITY_CONTAINERS,
    );
    if (
      !isDeepStrictEqual(
        candidate.getMap(PROJECT_ASSETS_CONTAINER).toJSON(),
        this.doc.getMap(PROJECT_ASSETS_CONTAINER).toJSON(),
      ) ||
      !isDeepStrictEqual(
        candidate.getMap(PROJECT_ASSET_SCHEMA_CONTAINER).toJSON(),
        this.doc.getMap(PROJECT_ASSET_SCHEMA_CONTAINER).toJSON(),
      )
    ) {
      throw new Error(
        "Local peer updates cannot mutate Host-owned Project Asset authority; use the Asset SDK/Host publication boundary.",
      );
    }
    assertLocalPeerActionAssetBindingMutation(this.doc, candidate);
    // Persist before mutating the live replica. The candidate import above
    // guarantees the durable record can be replayed successfully.
    await this.persistUpdate(updateBytes);
    this.doc.import(updateBytes);
    const repairVersion = this.doc.version();
    const graphRepair = reconcileCanvasGraph(this.doc);
    const timelineRepair = reconcileProjectTimelineOwnership(this.doc);
    const directorRepair = reconcileProjectDirectorStageOwnership(this.doc);
    const projectCoverRepair = reconcileProjectCoverBindings(this.doc);
    const assetBindingRepair = reconcileActionAssetBindingTargets(this.doc);
    const workspaceRepaired =
      canvasGraphReconciliationChanged(graphRepair) ||
      timelineRepair.removedActionNodeIds.length > 0 ||
      timelineRepair.detachedTimelineIds.length > 0 ||
      directorRepair.removedActionNodeIds.length > 0 ||
      directorRepair.detachedStageIds.length > 0 ||
      projectCoverRepair.changed ||
      assetBindingRepair.restoredProjectAssetIds.length > 0;
    const repairUpdate = workspaceRepaired
      ? exactBytes(this.doc.export({ mode: "update", from: repairVersion }))
      : null;
    if (this.peers.get(sender)?.syncProtocol !== "loro-v1") {
      this.peers.get(sender)?.sendJson?.({
        type: "sync_ack",
        updateId: loroSyncUpdateId(updateBytes),
      });
    }
    for (const [peerId, peer] of this.peers.entries()) {
      if (peerId !== sender) peer.sendUpdate(updateBytes);
    }
    this.mirrorRemoteUpdate(updateBytes);
    if (repairUpdate?.byteLength) {
      await this.persistUpdate(repairUpdate);
      for (const peer of this.peers.values()) peer.sendUpdate(repairUpdate);
      this.mirrorRemoteUpdate(repairUpdate);
    }
    this.broadcastNodeActivity(sender, nodesBefore);
  }

  private broadcastNodeActivity(
    sender: PeerId,
    nodesBefore: Map<string, Record<string, any>>,
  ): void {
    const nodesAfter = this.doc.getMap("nodes").entries();
    const seenIds = new Set<string>();
    for (const [id, raw] of nodesAfter) {
      seenIds.add(id);
      const after = raw as Record<string, any>;
      const before = nodesBefore.get(id);
      if (!before) {
        this.broadcastActivity(sender, "added", id, after);
      } else if (JSON.stringify(before) !== JSON.stringify(after)) {
        this.broadcastActivity(sender, "updated", id, after);
      }
    }
    for (const [id, before] of nodesBefore) {
      if (!seenIds.has(id))
        this.broadcastActivity(sender, "deleted", id, before);
    }
  }

  private broadcastActivity(
    sender: PeerId,
    action: ActivityAction,
    nodeId: string,
    node: Record<string, any>,
  ): void {
    const now = Date.now();
    const throttleKey = `${nodeId}:${action}`;
    const last = this.activityThrottle.get(throttleKey) ?? 0;
    if (now - last < 500) return;
    this.activityThrottle.set(throttleKey, now);

    const actor = this.peers.get(sender)?.presence;
    const message: ActivityMessage = {
      type: "activity",
      actor: {
        clientType: actor?.clientType ?? "browser",
        name: actor?.name ?? "Unknown",
      },
      action,
      nodeId,
      nodeType: typeof node.type === "string" ? node.type : "text",
      label:
        typeof node.data?.label === "string"
          ? node.data.label
          : typeof node.data?.name === "string"
            ? node.data.name
            : "",
      canvasId:
        typeof node.canvasId === "string" && node.canvasId.trim()
          ? node.canvasId
          : DEFAULT_CANVAS_ID,
      timestamp: now,
    };
    for (const [peerId, peer] of this.peers) {
      if (peerId !== sender) peer.sendJson?.({ ...message });
    }
  }

  async receiveJson(sender: PeerId, msg: Record<string, any>): Promise<void> {
    return this.enqueueProjectOperation(() =>
      this.receiveJsonUnsafe(sender, msg),
    );
  }

  private async receiveJsonUnsafe(
    sender: PeerId,
    msg: Record<string, any>,
  ): Promise<void> {
    if (
      msg.type === "register_custom_actions" ||
      msg.type === "unregister_custom_actions" ||
      msg.type === "complete_custom_task"
    ) {
      this.peers.get(sender)?.sendJson?.({
        type: `${msg.type}.rejected`,
        code: "LEGACY_CUSTOM_ACTION_PROTOCOL_RETIRED",
        error:
          "Legacy ClashAgent custom-action transport is retired; install a clash.plugin/v1 executable plugin.",
        ...(typeof msg.taskId === "string" ? { taskId: msg.taskId } : {}),
        ...(typeof msg.nodeId === "string" ? { nodeId: msg.nodeId } : {}),
      });
    }
  }

  private async saveSnapshot(): Promise<void> {
    await this.replica.checkpoint();
    this.updatesSinceSnapshot = 0;
    this.updateBytesSinceSnapshot = 0;
  }

  private async persistUpdate(update: Uint8Array): Promise<void> {
    const result = await this.replica.submit({
      id: loroSyncUpdateId(update),
      update,
    });
    this.checkpointedDoc = this.replica.read((state) => state);
    if (result.appended) {
      this.updatesSinceSnapshot += 1;
      this.updateBytesSinceSnapshot += update.byteLength;
    }
    if (
      this.updatesSinceSnapshot >= LOCAL_LORO_COMPACT_UPDATE_THRESHOLD ||
      this.updateBytesSinceSnapshot >= LOCAL_LORO_COMPACT_BYTES_THRESHOLD
    ) {
      try {
        await this.saveSnapshot();
      } catch (error) {
        console.error(
          "[local-sync] failed to compact committed Project checkpoint",
          error,
        );
      }
    }
    this.scheduleCanvasPreviewRefresh();
  }

  private scheduleCanvasPreviewRefresh(
    delayMs = PROJECT_CANVAS_PREVIEW_DEBOUNCE_MS,
  ): void {
    if (this.closed || !this.canvasPreviewCacheEnabled) return;
    if (this.canvasPreviewTimer) clearTimeout(this.canvasPreviewTimer);
    this.canvasPreviewTimer = setTimeout(() => {
      this.canvasPreviewTimer = undefined;
      this.enqueueCanvasPreviewRefresh();
    }, delayMs);
    this.canvasPreviewTimer.unref?.();
  }

  private enqueueCanvasPreviewRefresh(): void {
    const run = this.canvasPreviewWrites
      .catch(() => undefined)
      .then(async () => {
        const entry = await this.enqueueProjectOperation(() =>
          projectCanvasPreviewCacheEntryFromDoc(this.doc),
        );
        const cached = await this.store.readCanvasPreview(this.projectId);
        if (cached?.sourceVersion === entry.sourceVersion) return;
        await this.store.writeCanvasPreview(this.projectId, entry);
      })
      .catch((error) => {
        console.error(
          "[local-sync] failed to refresh Main canvas preview",
          error,
        );
      });
    this.canvasPreviewWrites = run;
  }

  private restoreLiveProjectFromCheckpoint(): void {
    this.doc = LoroDoc.fromSnapshot(
      this.checkpointedDoc.export({ mode: "snapshot" }),
    );
  }

  private processPendingWork(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const run = this.pendingWorkQueue.then(() =>
      this.enqueueProjectOperation(() => this.processPendingWorkOnce()),
    );
    this.pendingWorkQueue = run.catch(() => undefined);
    void run.then(() => this.scheduleNextPoll()).catch(() => undefined);
    return run;
  }

  /**
   * Comes back for journaled work a Provider is still holding.
   *
   * Pending work otherwise runs only when the document changes or a room loads, which was enough
   * while a generation was one long await -- the call that started it also finished it. Once submit
   * and poll became separate, nothing returned: a node sat at `generating` with its due time ten
   * minutes past and nobody looking, while the result waited upstream, paid for.
   *
   * The owner-private journal supplies the next wake for this project. Project Loro contains only
   * coarse generating/completed/failed state and is never a scheduler index.
   */
  private async scheduleNextPoll(): Promise<void> {
    const scheduleVersion = ++this.pollScheduleVersion;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.closed || !this.workflowProcessor?.nextWakeAt) return;
    const earliest = await this.workflowProcessor.nextWakeAt(this.projectId);
    if (
      this.closed ||
      scheduleVersion !== this.pollScheduleVersion ||
      earliest === undefined
    )
      return;
    // A floor, so a provider that asks for no delay cannot turn this into a busy loop.
    const delay = Math.max(
      this.workflowProcessor.minimumPollDelayMs ?? 1_000,
      earliest - Date.now(),
    );
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.processPendingWork();
    }, delay);
    this.pollTimer.unref?.();
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.pollScheduleVersion += 1;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.canvasPreviewTimer) {
      clearTimeout(this.canvasPreviewTimer);
      this.canvasPreviewTimer = undefined;
      this.enqueueCanvasPreviewRefresh();
    }
    await this.pendingWorkQueue.catch(() => undefined);
    await this.projectOperations.catch(() => undefined);
    await this.canvasPreviewWrites.catch(() => undefined);
    await this.remoteLink?.close();
    this.remoteLink = undefined;
    this.peers.clear();
  }

  private async processPendingWorkOnce(): Promise<void> {
    if (!this.workflowProcessor) return;
    try {
      let versionBefore = this.doc.version();
      const sideband: Record<string, unknown>[] = [];
      const checkpoint = async (): Promise<void> => {
        const update = exactBytes(
          this.doc.export({ mode: "update", from: versionBefore }),
        );
        if (update.byteLength === 0) return;
        await this.persistUpdate(update);
        versionBefore = this.doc.version();
        for (const peer of this.peers.values()) peer.sendUpdate(update);
        this.mirrorRemoteUpdate(update);
      };
      let changed = await this.workflowProcessor.process({
        doc: this.doc,
        projectId: this.projectId,
        broadcastJson: (msg) => sideband.push(msg),
        checkpoint,
      });
      const projectCoverRepair = reconcileProjectCoverBindings(this.doc);
      changed = projectCoverRepair.changed || changed;
      if (!changed) return;
      await checkpoint();
      for (const msg of sideband) this.broadcastJson(msg);
    } catch (error) {
      this.restoreLiveProjectFromCheckpoint();
      throw error;
    }
  }

  private broadcastJson(msg: Record<string, unknown>): void {
    for (const peer of this.peers.values()) {
      peer.sendJson?.(msg);
    }
  }

  private mirrorRemoteUpdate(update: Uint8Array): void {
    if (this.remoteLink) {
      void this.remoteLink.publish(update);
      return;
    }
    if (!this.remotePersistence) return;
    void resolveRemotePersistence(this.remotePersistence, this.projectId)
      .then((remotePersistence) => {
        const link = this.attachRemoteLink(remotePersistence);
        return link
          ? link.publish(update)
          : remotePersistence?.appendUpdate(this.projectId, update);
      })
      .catch((error) => {
        console.error(
          "[local-sync] failed to mirror update to remote persistence",
          error,
        );
      });
  }

  private attachRemoteLink(
    remotePersistence: RemoteLoroPersistence | undefined,
  ): ReplicaLinkPort<Uint8Array> | undefined {
    if (this.remoteLink || !remotePersistence?.createLink) {
      return this.remoteLink;
    }
    const link = remotePersistence.createLink({
      projectId: this.projectId,
      doc: () => this.doc,
      commit: (batchId, updates) => this.receiveCloudUpdates(batchId, updates),
    });
    this.remoteLink = link;
    void Promise.resolve(link.start()).catch((error) => {
      if (this.remoteLink === link) this.remoteLink = undefined;
      console.error("[local-sync] failed to start cloud replica link", error);
    });
    return link;
  }

  private broadcastPresence(): void {
    const clients = Array.from(this.peers.values())
      .map((peer) => peer.presence)
      .filter((client): client is PresenceClient => !!client);
    for (const peer of this.peers.values()) {
      peer.sendJson?.({ type: "presence", clients });
    }
  }
}

export class LocalProjectRoomBusyError extends Error {
  override name = "LocalProjectRoomBusyError";
  readonly code = "PROJECT_BUSY" as const;

  constructor(readonly projectId: string) {
    super(`Project ${projectId} is reserved by an authority operation.`);
  }
}

export class LocalLoroRoomHub {
  private rooms = new Map<string, Promise<LocalLoroRoom>>();
  private checkpointReadableRooms = new Map<string, LocalLoroRoom>();
  private readonly importReservations = new Set<string>();
  private readonly activeImports = new Set<Promise<unknown>>();
  private readonly replicaStore: FileReplicaStore;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly remotePersistence?: RemoteLoroPersistenceSource,
    private readonly workflowProcessor?: LocalWorkflowProcessor | null,
  ) {
    this.replicaStore = new FileReplicaStore(join(dataDir, "projects"));
  }

  room(projectId: string): Promise<LocalLoroRoom> {
    if (this.closed) {
      return Promise.reject(new Error("Local Project room hub is closed."));
    }
    if (this.importReservations.has(projectId)) {
      return Promise.reject(new LocalProjectRoomBusyError(projectId));
    }
    let room = this.rooms.get(projectId);
    if (!room) {
      room = (async () => {
        let durableReservation = false;
        try {
          durableReservation =
            (await this.replicaStore.readImportReservation(projectId)) !== null;
        } catch {
          // A corrupt or unreadable reservation is still an authority barrier.
          durableReservation = true;
        }
        if (this.importReservations.has(projectId) || durableReservation) {
          throw new LocalProjectRoomBusyError(projectId);
        }
        return LocalLoroRoom.open(
          {
            dataDir: this.dataDir,
            projectId,
            remotePersistence: this.remotePersistence,
            workflowProcessor: this.workflowProcessor,
            canvasPreviewCacheEnabled: true,
          },
          (opened) => {
            this.checkpointReadableRooms.set(projectId, opened);
          },
        );
      })();
      this.rooms.set(projectId, room);
      void room.catch(() => {
        if (this.rooms.get(projectId) === room) {
          this.rooms.delete(projectId);
          this.checkpointReadableRooms.delete(projectId);
        }
      });
    }
    return room;
  }

  /**
   * Publishes an imported Project snapshot while keeping every ordinary room
   * access outside the installation/receiver-metadata visibility gap.
   *
   * The callback is the receiver-local commit (Project display row, imported
   * indexes and receipt). The reservation is released only after that commit
   * resolves, so no workflow processor or peer can open the imported replica
   * while its receiver authority is still incomplete.
   */
  installImportedProject<T>(
    projectId: string,
    reservationId: string,
    snapshot: Uint8Array,
    commitReceiverAuthority: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Local Project room hub is closed."));
    }
    if (this.importReservations.has(projectId) || this.rooms.has(projectId)) {
      return Promise.reject(new LocalProjectRoomBusyError(projectId));
    }
    const snapshotDoc = new LoroDoc();
    snapshotDoc.import(snapshot);
    const reservation = {
      schemaVersion: 1 as const,
      kind: "clash.workspace.import-reservation" as const,
      reservationId,
      snapshotSha256: createHash("sha256").update(snapshot).digest("hex"),
    };
    this.importReservations.add(projectId);
    const operation = (async () => {
      try {
        await this.replicaStore.reserveImportedProject(projectId, reservation);
        await this.replicaStore.installSnapshotIfAbsent(projectId, snapshot);
        const committed = await commitReceiverAuthority();
        await this.replicaStore.clearImportedProjectReservation(
          projectId,
          reservation,
        );
        return committed;
      } finally {
        this.importReservations.delete(projectId);
      }
    })();
    this.activeImports.add(operation);
    void operation
      .finally(() => this.activeImports.delete(operation))
      .catch(() => undefined);
    return operation;
  }

  async reconcileCommittedImport(
    projectId: string,
    reservationId: string,
    snapshotSha256: string,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("Local Project room hub is closed.");
    }
    if (
      !projectId.trim() ||
      !reservationId.trim() ||
      !/^[a-f0-9]{64}$/u.test(snapshotSha256)
    ) {
      throw new Error("Committed Workspace import identity is invalid.");
    }
    if (this.importReservations.has(projectId) || this.rooms.has(projectId)) {
      throw new LocalProjectRoomBusyError(projectId);
    }
    const snapshot = await this.replicaStore.loadSnapshot(projectId);
    if (
      !snapshot ||
      createHash("sha256").update(snapshot).digest("hex") !== snapshotSha256
    ) {
      throw new Error(
        `Project ${projectId} installed snapshot does not match its committed Workspace import.`,
      );
    }
    const expected = {
      schemaVersion: 1 as const,
      kind: "clash.workspace.import-reservation" as const,
      reservationId,
      snapshotSha256,
    };
    const existing = await this.replicaStore.readImportReservation(projectId);
    if (!existing) return;
    if (JSON.stringify(existing) !== JSON.stringify(expected)) {
      throw new Error(
        `Project ${projectId} is reserved by another Workspace import.`,
      );
    }
    await this.replicaStore.clearImportedProjectReservation(
      projectId,
      expected,
    );
  }

  async inspectProject<T>(
    projectId: string,
    read: (doc: LoroDoc) => T | Promise<T>,
  ): Promise<T> {
    return (await this.room(projectId)).inspectProject(read);
  }

  async inspectCheckpointedProject<T>(
    projectId: string,
    read: (doc: LoroDoc) => T | Promise<T>,
  ): Promise<T> {
    const initialized = this.checkpointReadableRooms.get(projectId);
    return initialized
      ? initialized.inspectCheckpointedProject(read)
      : (await this.room(projectId)).inspectCheckpointedProject(read);
  }

  async mutateProject<T>(
    projectId: string,
    mutation: (
      doc: LoroDoc,
    ) => { value: T; save?: boolean } | Promise<{ value: T; save?: boolean }>,
  ): Promise<T> {
    return (await this.room(projectId)).mutateProject(mutation);
  }

  async mutateProjectWithCheckpoint<T>(
    projectId: string,
    mutation: (doc: LoroDoc, checkpoint: () => Promise<void>) => T | Promise<T>,
  ): Promise<T> {
    return (await this.room(projectId)).mutateProjectWithCheckpoint(mutation);
  }

  async refresh(projectId: string): Promise<void> {
    const existing = this.rooms.get(projectId);
    if (!existing) {
      await this.room(projectId);
      return;
    }
    await (await existing).refreshFromStore();
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.activeImports);
    const rooms = await Promise.allSettled(this.rooms.values());
    await Promise.all(
      rooms.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.close()] : [],
      ),
    );
    this.rooms.clear();
    this.checkpointReadableRooms.clear();
  }
}

export function attachLocalSync(
  server: UpgradeCapableServer,
  options: {
    dataDir: string;
    remotePersistence?: RemoteLoroPersistenceSource;
    workflowProcessor?: LocalWorkflowProcessor | null;
    hub?: LocalLoroRoomHub;
  },
): LocalLoroRoomHub {
  const hub =
    options.hub ??
    new LocalLoroRoomHub(
      options.dataDir,
      options.remotePersistence,
      options.workflowProcessor,
    );
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = /^\/sync\/(.+)$/.exec(url.pathname);
    if (!match) return;

    const projectId = decodeURIComponent(match[1]);
    const runtimeHeader = request.headers?.["x-runtime-id"];
    const runtimeId = Array.isArray(runtimeHeader)
      ? runtimeHeader[0]
      : runtimeHeader;
    const presence = presenceFromHeaders(request.headers);
    const syncProtocol =
      url.searchParams.get("protocol") === "loro-v1"
        ? ("loro-v1" as const)
        : undefined;
    wss.handleUpgrade(request, socket, head, (ws) => {
      void bindSocket(
        hub,
        projectId,
        ws,
        typeof runtimeId === "string" ? runtimeId : undefined,
        presence,
        syncProtocol,
      );
    });
  });
  return hub;
}

function headerString(
  value: string | string[] | undefined,
): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

function presenceFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): PresenceClient {
  const rawClientType = headerString(headers["x-client-type"]);
  const clientType: ClientType =
    rawClientType === "agent" ||
    rawClientType === "cli" ||
    rawClientType === "browser"
      ? rawClientType
      : "browser";
  const userId = headerString(headers["x-user-id"]) ?? "local-user";
  const userName = headerString(headers["x-user-name"]);
  const name =
    clientType === "agent"
      ? (headerString(headers["x-agent-name"]) ?? userName ?? "Local Agent")
      : clientType === "cli"
        ? (userName ?? "Local CLI")
        : (userName ?? "Local User");

  return {
    id: randomUUID(),
    clientType,
    userId,
    name,
  };
}

async function bindSocket(
  hub: LocalLoroRoomHub,
  projectId: string,
  ws: WebSocket,
  runtimeId?: string,
  presence?: PresenceClient,
  syncProtocol?: "loro-v1",
): Promise<void> {
  // The browser can emit JoinRequest as soon as its `open` event fires, while
  // loading the file-backed room is still asynchronous. Buffer that small
  // startup window so the first protocol frame cannot disappear.
  const pendingMessages: Array<[RawData, boolean]> = [];
  const bufferMessage = (data: RawData, isBinary: boolean) => {
    pendingMessages.push([data, isBinary]);
  };
  ws.on("message", bufferMessage);
  const room = await hub.room(projectId);
  const sendProtocolUpdate = (update: Uint8Array) => {
    for (const frame of encodeLoroProtocolUpdateFrames(
      projectId,
      createLoroProtocolBatchId(),
      [update],
    )) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  };
  const peerId = room.addPeer(
    (update) => {
      if (syncProtocol) sendProtocolUpdate(update);
      else if (ws.readyState === ws.OPEN) ws.send(update);
    },
    {
      runtimeId,
      presence,
      syncProtocol,
      sendInitialSnapshot: !syncProtocol,
      sendJson: (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    },
  );
  const protocolSession = syncProtocol
    ? new LoroProtocolServerSession({
        roomId: projectId,
        doc: () => room.protocolDocument(),
        send: (frame) => {
          if (ws.readyState === ws.OPEN) ws.send(frame);
        },
        commit: async (_batchId, updates) => {
          for (const update of updates) await room.receive(peerId, update);
        },
      })
    : undefined;

  const handleMessage = (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      try {
        const text =
          typeof data === "string"
            ? data
            : data instanceof Buffer
              ? data.toString("utf8")
              : Array.isArray(data)
                ? Buffer.concat(data).toString("utf8")
                : Buffer.from(data as ArrayBuffer).toString("utf8");
        if (text === "ping") {
          if (ws.readyState === ws.OPEN) ws.send("pong");
          return;
        }
        if (text === "pong") return;
        const msg = JSON.parse(text) as Record<string, any>;
        void room.receiveJson(peerId, msg).catch((error) => {
          console.error(
            "[local-sync] failed to handle sideband message",
            error,
          );
        });
      } catch {
        // Ignore non-JSON sideband chatter.
      }
      return;
    }
    const bytes =
      data instanceof Buffer
        ? new Uint8Array(data)
        : Array.isArray(data)
          ? new Uint8Array(Buffer.concat(data))
          : new Uint8Array(data as ArrayBuffer);
    const receive = protocolSession
      ? protocolSession.receive(bytes)
      : room.receive(peerId, bytes);
    void receive.catch((error) => {
      console.error("[local-sync] failed to import update", error);
    });
  };
  ws.off("message", bufferMessage);
  ws.on("message", handleMessage);
  for (const [data, isBinary] of pendingMessages) {
    handleMessage(data, isBinary);
  }

  ws.on("close", () => {
    protocolSession?.destroy();
    room.removePeer(peerId);
  });
}
