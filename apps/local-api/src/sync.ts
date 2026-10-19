import { ProjectMetadataStaleError } from "@clash/shared-runtime";
export { ProjectMetadataStaleError } from "@clash/shared-runtime";
import { hasLegacyCanvasGeneratorDrafts } from "./local-canvas-generator-migration.js";
import { assertLocalPeerModelProjectionMutation } from "./local-model-peer-guard.js";
import { LocalProjectUpgradeError, type LocalProjectUpgrade } from "./local-project-upgrade.js";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LoroDoc, type LoroEventBatch } from "loro-crdt";
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
  CANVAS_NODE_LAYOUTS,
  ActionAssetBindingSchema,
  Canvas,
  DEFAULT_CANVAS_ID,
  DOCUMENT_ASSET_REVISIONS_CONTAINER,
  DOCUMENT_ASSET_SCHEMA_CONTAINER,
  DOCUMENT_ATTACHMENTS_CONTAINER,
  EDGE_IDENTITY_CONTAINER,
  GENERATOR_ACTION_RUNS_CONTAINER,
  GENERATOR_OUTPUT_COMMITS_CONTAINER,
  GENERATOR_REVISIONS_CONTAINER,
  GENERATOR_SCHEMA_CONTAINER,
  PROJECT_ASSETS_CONTAINER,
  PROJECT_ASSET_SCHEMA_CONTAINER,
  PROJECT_DOCUMENT_ASSETS_CONTAINER,
  PROJECT_GENERATORS_CONTAINER,
  NODE_UPSTREAMS_CONTAINER,
  PROJECT_PRESENTATION_CONTAINER,
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
  type ProjectRemoteStateMessage,
  type PresenceClient,
} from "@clash/shared-types";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { FileReplicaStore } from "./loro/file-replica-store.js";
import { createFileReplicaPorts } from "./loro/replica-ports.js";
import {
  LoroCloudReplicaLink,
  type CloudReplicaLinkState,
} from "./loro/cloud-replica-link.js";
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
  upgradeProject?: LocalProjectUpgrade;
  onProjectCommitted?: (projectId: string) => Promise<void>;
  /** Persist a failed direct replica-link publish; never leave it log-only. */
  onRemoteMirrorFailure?: (
    projectId: string,
    error: unknown,
  ) => void | Promise<void>;
  /**
   * Bound for the background remote-snapshot fetch. Open never waits on it; the
   * room serves the local replica and reports a coded remote state on failure.
   */
  remoteSnapshotTimeoutMs?: number;
  /** First retry delay after a failed background remote fetch/import. */
  remoteSnapshotRetryBaseMs?: number;
  /** Cap for the exponential background retry delay. */
  remoteSnapshotRetryMaxMs?: number;
}

export interface RemoteLoroPersistence {
  loadSnapshot?(projectId: string, signal?: AbortSignal): Promise<Uint8Array | null>;
  appendUpdate(projectId: string, update: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** Optional product metadata mirror; deliberately separate from Loro bytes. */
  loadProjectMetadata?(projectId: string, signal?: AbortSignal): Promise<ProjectMetadata | null>;
  saveProjectMetadata?(
    projectId: string,
    metadata: ProjectMetadata,
    signal?: AbortSignal,
  ): Promise<void>;
  createLink?(options: {
    projectId: string;
    doc(): LoroDoc;
    commit(batchId: string, updates: Uint8Array[]): Promise<void>;
    /** Optional transport-state observer implemented by the WebSocket link. */
    onState?(state: CloudReplicaLinkState): void;
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
const LOCAL_LORO_COMPACT_MIN_INTERVAL_MS = 5_000;
const LOCAL_LORO_UPDATE_LOG_HARD_CAP_BYTES = 64 * 1024 * 1024;
const LOCAL_LORO_CHECKPOINT_RETRY_BASE_MS = 250;
const LOCAL_LORO_CHECKPOINT_RETRY_MAX_MS = 30_000;
const PROJECT_CANVAS_PREVIEW_DEBOUNCE_MS = 350;
/**
 * Socket edits coalesce their post-commit workflow pass. A 60 Hz drag otherwise
 * queues one pass per update, and any slow provider/plugin discovery inside the
 * pass would delay the next edit's acknowledgement.
 */
const PROJECT_PENDING_WORK_DEBOUNCE_MS = 100;
/**
 * A cloud snapshot may never arrive. Open serves the local replica immediately
 * and bounds the background catch-up so a blackholed host cannot stall it.
 */
const PROJECT_REMOTE_SNAPSHOT_TIMEOUT_MS = 5_000;
const PROJECT_REMOTE_SNAPSHOT_RETRY_BASE_MS = 30_000;
const PROJECT_REMOTE_SNAPSHOT_RETRY_MAX_MS = 5 * 60_000;
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

export type LocalProjectHealthCode =
  | "PROJECT_CHECKPOINT_FAILED"
  | "PROJECT_WORK_FAILED";

export interface LocalProjectHealth {
  ok: boolean;
  projectId: string;
  code?: LocalProjectHealthCode;
  message?: string;
  cause?: string;
  logBytes?: number;
  attempts?: number;
  retryAt?: number;
}

export interface LocalProjectHealthSummary {
  ok: boolean;
  code?: LocalProjectHealthCode;
  failures: LocalProjectHealth[];
}

export class LocalProjectCheckpointError extends Error {
  override name = "LocalProjectCheckpointError";
  readonly code = "PROJECT_CHECKPOINT_FAILED" as const;

  constructor(
    readonly projectId: string,
    readonly logBytes: number,
    cause: unknown,
  ) {
    super(
      `Project ${projectId} cannot append another update: its checkpoint is failing and updates.log is ${logBytes} bytes.`,
      { cause },
    );
  }
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

/**
 * Settle with the first of a promise or an abort. A transport that ignores the
 * signal still leaves this bounded; its late result is dropped here so callers
 * cannot attach a link or merge a snapshot after the attempt expired.
 */
function raceRemoteAttempt<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createHttpRemoteLoroPersistence(
  options: HttpRemoteLoroPersistenceOptions,
): RemoteLoroPersistence {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async loadSnapshot(projectId, signal) {
      const response = await fetchImpl(
        remoteProjectUrl(options.baseUrl, projectId, "snapshot"),
        {
          signal,
          method: "GET",
          headers: remoteHeaders(options.token),
        },
      );
      if (response.status === 404 || response.status === 204) return null;
      await assertRemoteOk(response, "snapshot load");
      return new Uint8Array(await response.arrayBuffer());
    },
    async appendUpdate(projectId, update, signal) {
      const response = await fetchImpl(
        remoteProjectUrl(options.baseUrl, projectId, "updates"),
        {
          signal,
          method: "POST",
          headers: remoteHeaders(options.token, {
            "content-type": "application/octet-stream",
          }),
          body: exactArrayBuffer(update),
        },
      );
      await assertRemoteOk(response, "update append");
    },
    async loadProjectMetadata(projectId, signal) {
      const response = await fetchImpl(
        remoteProjectUrl(options.baseUrl, projectId, "metadata"),
        {
          signal,
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
    async saveProjectMetadata(projectId, metadata, signal) {
      const response = await fetchImpl(
        remoteProjectUrl(options.baseUrl, projectId, "metadata"),
        {
          signal,
          method: "PUT",
          headers: remoteHeaders(options.token, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({ schemaVersion: 1, metadata }),
        },
      );
      if (response.status === 409) {
        const { schemaVersion, metadata } = (await response.json()) as {
          schemaVersion: unknown;
          metadata: unknown;
        };
        const payload = ProjectMetadataEnvelopeSchema.parse({
          schemaVersion,
          metadata,
        });
        throw new ProjectMetadataStaleError(payload.metadata);
      }
      await assertRemoteOk(response, "metadata save");
    },
    createLink({ projectId, doc, commit, onState }) {
      return new LoroCloudReplicaLink({
        baseUrl: options.baseUrl,
        projectId,
        token: options.token,
        doc,
        commit,
        onState,
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

/** Canvas owns geometry; the Host completes pending placement before publication. */
function completePendingCanvasLayout(
  doc: LoroDoc,
  canvasIds?: ReadonlySet<string>,
): boolean {
  const ids = new Set<string>(canvasIds ?? []);
  if (!canvasIds) {
    for (const [, raw] of doc.getMap("nodes").entries()) {
      const node = raw as Record<string, unknown>;
      ids.add(typeof node.canvasId === "string" ? node.canvasId : DEFAULT_CANVAS_ID);
    }
  }
  let changed = false;
  for (const canvasId of ids) {
    if (new Canvas(doc, () => {}, canvasId).layoutPendingNodes().length > 0) changed = true;
  }
  return changed;
}

interface TouchedContainers {
  names: Set<string>;
  nodeIds: Set<string>;
  layoutIds: Set<string>;
}

/** Collect only the containers the imported update actually touched. */
function collectTouchedContainers(
  batch: LoroEventBatch,
  touched: TouchedContainers,
): void {
  for (const event of batch.events) {
    const root = event.path?.[0];
    if (typeof root !== "string") continue;
    touched.names.add(root);
    const nestedId =
      typeof event.path[1] === "string" ? event.path[1] : undefined;
    if (root === "nodes" && nestedId) touched.nodeIds.add(nestedId);
    if (root === CANVAS_NODE_LAYOUTS && nestedId)
      touched.layoutIds.add(nestedId);
    if (event.diff.type !== "map") continue;
    // Only the root map event lists node/layout ids as keys. A nested event
    // lists the fields of one node/layout (already captured above).
    if ((event.path?.length ?? 0) > 1) continue;
    // A deleted map entry has no reachable child container; its key is the id.
    for (const id of Object.keys(event.diff.updated)) {
      if (root === "nodes") touched.nodeIds.add(id);
      if (root === CANVAS_NODE_LAYOUTS) touched.layoutIds.add(id);
    }
  }
}

function intersects(
  touched: ReadonlySet<string>,
  containers: readonly string[],
): boolean {
  return containers.some((container) => touched.has(container));
}

/** No pending/generating Canvas node means no workflow or Model discovery is due. */
function hasRunnableProjectWork(
  doc: LoroDoc,
  nodeIds?: ReadonlySet<string>,
): boolean {
  // Materializing every node value is O(document); a small peer update can only
  // change the runnable state of the nodes it touched, so callers that know the
  // touched ids pass them instead of forcing a whole-map read.
  const values = nodeIds
    ? [...nodeIds].map((id) => doc.getMap("nodes").get(id))
    : [...doc.getMap("nodes").values()];
  for (const raw of values) {
    const data = (raw as { data?: unknown } | null | undefined)?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const status = (data as Record<string, unknown>).status;
    if (status === "pending" || status === "generating") return true;
  }
  return false;
}

async function loadDoc(options: LocalSyncOptions): Promise<{
  doc: LoroDoc;
  replica: ReplicaEngine<LoroDoc, Uint8Array, Uint8Array>;
  store: FileReplicaStore;
  workspaceRepaired: boolean;
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

  // Cloud state is fetched after the room opens (see startRemoteSnapshotSync).
  // Opening must never wait on config/admission/token work or the network, and
  // an unavailable remote must not turn into a silently stale local view.

  const graphRepair = reconcileCanvasGraph(doc);
  const timelineRepair = reconcileProjectTimelineOwnership(doc);
  const directorRepair = reconcileProjectDirectorStageOwnership(doc);
  const projectCoverRepair = reconcileProjectCoverBindings(doc);
  const assetBindingRepair = reconcileActionAssetBindingTargets(doc);
  let projectUpgraded: boolean;
  try {
    projectUpgraded = await options.upgradeProject?.({ projectId: options.projectId, doc }) ?? false;
    projectUpgraded = completePendingCanvasLayout(doc) || projectUpgraded;
  } catch (error) {
    // The unpublished clone may contain partial migration work. Its checkpoint
    // remains untouched and the next open starts from that checkpoint again.
    durableVersion.free();
    doc.free();
    throw error;
  }
  const workspaceRepaired =
    projectUpgraded ||
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
    workspaceRepaired,
  };
}

export class LocalLoroRoom {
  private peers = new Map<PeerId, LocalPeer>();
  private projectOperations: Promise<void> = Promise.resolve();
  private checkpointedDoc: LoroDoc;
  private updatesSinceSnapshot = 0;
  private updateBytesSinceSnapshot = 0;
  private updateLogBytes = 0;
  private lastCheckpointAt = 0;
  private checkpointFailure:
    | (LocalProjectHealth & {
        ok: false;
        code: "PROJECT_CHECKPOINT_FAILED";
      })
    | undefined;
  private workFailure:
    | (LocalProjectHealth & { ok: false; code: "PROJECT_WORK_FAILED" })
    | undefined;
  private checkpointRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private activityThrottle = new Map<string, number>();
  private pendingWorkQueue: Promise<void> = Promise.resolve();
  private pendingWorkTimer: ReturnType<typeof setTimeout> | undefined;
  /** Absolute due time of the armed pending-work pass. */
  private pendingWorkDueAt: number | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** Absolute due time of the armed poll, restored if eviction is cancelled. */
  private pollDueAt: number | undefined;
  /** Schedule captured by an idle-eviction flush, restored on cancellation. */
  private suspendedEvictionSchedule:
    | {
        remote: boolean;
        remoteDueAt?: number;
        pollDueAt?: number;
        pendingWorkDueAt?: number;
      }
    | undefined;
  private pollScheduleVersion = 0;
  private canvasPreviewTimer: ReturnType<typeof setTimeout> | undefined;
  private canvasPreviewWrites: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private lastActiveAt = Date.now();
  private evicting = false;
  /** Operations in flight through the hub; an eviction must not start under them. */
  private activeOperations = 0;
  private evictionCancellation: Promise<void> | undefined;
  private resolveEvictionCancellation: (() => void) | undefined;
  private documentsReleased = false;
  private remoteLink: ReplicaLinkPort<Uint8Array> | undefined;
  /** Snapshot catch-up state, independent of the transport link. */
  private snapshotState: ProjectRemoteStateMessage | undefined;
  /** Last transport state reported by the cloud replica link. */
  private cloudLinkState: CloudReplicaLinkState | undefined;
  /** Combined state published to peers: the worse of snapshot and link. */
  private remoteState: ProjectRemoteStateMessage | undefined;
  private remoteSyncTimer: ReturnType<typeof setTimeout> | undefined;
  /** Absolute due time of the armed remote catch-up. */
  private remoteSyncDueAt: number | undefined;
  private remoteSyncAbort: AbortController | undefined;
  private remoteSyncInFlight = false;
  private remoteSyncRetryMs: number;
  private openBackgroundImmediate: ReturnType<typeof setImmediate> | undefined;

  private constructor(
    private readonly projectId: string,
    private doc: LoroDoc,
    private readonly replica: ReplicaEngine<LoroDoc, Uint8Array, Uint8Array>,
    private readonly store: FileReplicaStore,
    private readonly remotePersistence?: RemoteLoroPersistenceSource,
    private readonly workflowProcessor?: LocalWorkflowProcessor,
    private readonly canvasPreviewCacheEnabled = false,
    private readonly upgradeProject?: LocalProjectUpgrade,
    private readonly onProjectCommitted?: (projectId: string) => Promise<void>,
    private readonly onRemoteMirrorFailure?: (
      projectId: string,
      error: unknown,
    ) => void | Promise<void>,
    private readonly remoteSnapshotTimeoutMs = PROJECT_REMOTE_SNAPSHOT_TIMEOUT_MS,
    private readonly remoteSnapshotRetryBaseMs = PROJECT_REMOTE_SNAPSHOT_RETRY_BASE_MS,
    private readonly remoteSnapshotRetryMaxMs = PROJECT_REMOTE_SNAPSHOT_RETRY_MAX_MS,
  ) {
    this.checkpointedDoc = this.replica.read((state) => state);
    this.remoteSyncRetryMs = this.remoteSnapshotRetryBaseMs;
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
      options.upgradeProject,
      options.onProjectCommitted,
      options.onRemoteMirrorFailure,
      options.remoteSnapshotTimeoutMs,
      options.remoteSnapshotRetryBaseMs,
      options.remoteSnapshotRetryMaxMs,
    );
    room.updateLogBytes = await loaded.store.updateLogSize(options.projectId);
    if (loaded.workspaceRepaired) await room.saveSnapshot();
    await onCheckpointReadable?.(room);
    room.startOpenBackgroundWork();
    return room;
  }

  /**
   * Catch the local room up after it is already serving peers.
   *
   * A due Provider run and a cloud snapshot are both remote work. Deferring
   * both keeps project open independent of a stalled provider or a blackholed
   * cloud, while the existing room events still publish the results.
   */
  private startOpenBackgroundWork(): void {
    this.openBackgroundImmediate = setImmediate(() => {
      this.openBackgroundImmediate = undefined;
      if (this.closed) return;
      this.startRemoteSnapshotSync(0);
      // Same pass the room used to await, including Project Asset
      // materialization; only its latency moved off the open path.
      void this.processPendingWork().catch((error) =>
        this.recordWorkFailure(error),
      );
    });
    this.openBackgroundImmediate.unref?.();
  }

  private startRemoteSnapshotSync(delayMs: number): void {
    if (this.closed || !this.remotePersistence) return;
    if (this.remoteSyncTimer) clearTimeout(this.remoteSyncTimer);
    const delay = Math.max(0, delayMs);
    this.remoteSyncDueAt = Date.now() + delay;
    this.remoteSyncTimer = setTimeout(() => {
      this.remoteSyncTimer = undefined;
      this.remoteSyncDueAt = undefined;
      // The current attempt may outlive a cancelled eviction's abort. Keep the
      // catch-up schedule alive instead of letting a one-shot timer vanish.
      if (this.remoteSyncInFlight) {
        this.startRemoteSnapshotSync(this.remoteSyncRetryMs);
        return;
      }
      void this.syncRemoteSnapshotOnce();
    }, delay);
    this.remoteSyncTimer.unref?.();
  }

  private async syncRemoteSnapshotOnce(): Promise<void> {
    if (this.closed || this.remoteSyncInFlight) return;
    this.remoteSyncInFlight = true;
    // One bound covers the whole background attempt: resolving admission and
    // credentials can itself block on a token refresh, and the snapshot fetch
    // must share the same budget rather than starting a fresh one.
    const timeoutSignal = AbortSignal.timeout(this.remoteSnapshotTimeoutMs);
    const closeController = new AbortController();
    this.remoteSyncAbort = closeController;
    const signal = AbortSignal.any([timeoutSignal, closeController.signal]);
    const timeoutError = () =>
      new Error(
        `Cloud state request timed out after ${this.remoteSnapshotTimeoutMs} ms`,
      );
    const attemptError = (error: unknown) =>
      timeoutSignal.aborted
        ? timeoutError()
        : error instanceof Error
          ? error
          : new Error(String(error));
    try {
      let remote: RemoteLoroPersistence | undefined;
      try {
        remote = await raceRemoteAttempt(
          resolveRemotePersistence(this.remotePersistence, this.projectId),
          signal,
        );
      } catch (error) {
        this.reportRemoteState(
          "unavailable",
          "PROJECT_REMOTE_UNAVAILABLE",
          attemptError(error),
        );
        return;
      }
      if (this.closed) return;
      if (signal.aborted) {
        this.reportRemoteState(
          "unavailable",
          "PROJECT_REMOTE_UNAVAILABLE",
          timeoutError(),
        );
        return;
      }
      // Local-only projects resolve to no persistence: nothing to fetch and no
      // state for the client to show.
      if (!remote) {
        this.clearRemoteState();
        return;
      }
      this.attachRemoteLink(remote);
      if (!remote.loadSnapshot) {
        this.clearRemoteState();
        return;
      }
      let snapshot: Uint8Array | null;
      try {
        snapshot = await raceRemoteAttempt(
          remote.loadSnapshot(this.projectId, signal),
          signal,
        );
      } catch (error) {
        this.reportRemoteState(
          "unavailable",
          "PROJECT_REMOTE_UNAVAILABLE",
          attemptError(error),
        );
        return;
      }
      if (this.closed) return;
      if (signal.aborted) {
        this.reportRemoteState(
          "unavailable",
          "PROJECT_REMOTE_UNAVAILABLE",
          timeoutError(),
        );
        return;
      }
      if (!snapshot?.byteLength) {
        this.clearRemoteState();
        return;
      }
      try {
        await this.mergeRemoteSnapshot(snapshot, { awaitPendingWork: false });
      } catch (error) {
        this.reportRemoteState(
          "import-failed",
          "PROJECT_REMOTE_SNAPSHOT_IMPORT_FAILED",
          error,
        );
        return;
      }
      this.clearRemoteState();
    } finally {
      if (this.remoteSyncAbort === closeController) {
        this.remoteSyncAbort = undefined;
      }
      this.remoteSyncInFlight = false;
    }
  }

  private reportRemoteState(
    state: "unavailable" | "import-failed",
    code:
      | "PROJECT_REMOTE_UNAVAILABLE"
      | "PROJECT_REMOTE_SNAPSHOT_IMPORT_FAILED",
    error: unknown,
  ): void {
    if (this.closed) return;
    const reason = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 500);
    const retryDelay = Math.max(1_000, this.remoteSyncRetryMs);
    this.remoteSyncRetryMs = Math.min(
      this.remoteSnapshotRetryMaxMs,
      Math.max(retryDelay + 1, retryDelay * 2),
    );
    this.snapshotState = {
      type: "project.remote-state",
      projectId: this.projectId,
      state,
      code,
      message:
        state === "unavailable"
          ? `Cloud state is unavailable; showing the local revision. Edits are saved locally.${reason ? ` ${reason}` : ""}`
          : `Cloud state could not be imported; showing the local revision. Edits are saved locally.${reason ? ` ${reason}` : ""}`,
      retryAt: new Date(Date.now() + retryDelay).toISOString(),
    };
    console.warn(`[local-sync] ${code}`, error);
    this.publishRemoteState();
    this.startRemoteSnapshotSync(retryDelay);
  }

  private clearRemoteState(): void {
    this.remoteSyncRetryMs = this.remoteSnapshotRetryBaseMs;
    if (this.remoteSyncTimer) {
      clearTimeout(this.remoteSyncTimer);
      this.remoteSyncTimer = undefined;
      this.remoteSyncDueAt = undefined;
    }
    this.snapshotState = undefined;
    this.publishRemoteState();
  }

  /**
   * Combine snapshot catch-up and transport health into one remote state.
   *
   * `import-failed` outranks `unavailable`: a connected link must never hide
   * unreadable cloud bytes. Between two `unavailable` states the link wins
   * because it carries the current transport code and next attempt time.
   */
  private combinedRemoteState(): ProjectRemoteStateMessage | undefined {
    const snapshot = this.snapshotState;
    const link = this.cloudLinkState;
    const transport: ProjectRemoteStateMessage | undefined =
      link && (link.state === "retrying" || link.state === "stopped")
        ? {
            type: "project.remote-state",
            projectId: this.projectId,
            state: "unavailable",
            code: link.code ?? "CLOUD_LINK_UNREACHABLE",
            message: `Cloud sync is unavailable; showing the local revision. Edits are saved locally.${link.message ? ` ${link.message.replace(/\s+/gu, " ").trim().slice(0, 500)}` : ""}`,
            retryAt: link.retryAt,
          }
        : undefined;
    if (!snapshot) return transport;
    if (!transport) return snapshot;
    return snapshot.state === "import-failed" ? snapshot : transport;
  }

  private publishRemoteState(): void {
    if (this.closed) return;
    const next = this.combinedRemoteState();
    const previous = this.remoteState;
    if (
      next === previous ||
      (next &&
        previous &&
        next.state === previous.state &&
        next.code === previous.code &&
        next.message === previous.message &&
        next.retryAt === previous.retryAt)
    ) {
      return;
    }
    this.remoteState = next;
    if (next) {
      this.broadcastJson({ ...next });
    } else {
      this.broadcastJson({
        type: "project.remote-state",
        projectId: this.projectId,
        state: "synced",
      });
    }
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

  private touch(): void {
    this.lastActiveAt = Date.now();
  }

  private assertAcceptsOperations(): void {
    if (this.closed) throw new LocalProjectRoomClosedError(this.projectId);
    if (this.evicting) {
      throw new LocalProjectRoomEvictingError(this.projectId);
    }
  }

  /** Reads stay valid after an ordinary close while the documents still exist. */
  private assertAcceptsReads(): void {
    if (this.documentsReleased) {
      throw new LocalProjectRoomClosedError(this.projectId);
    }
    if (this.evicting) {
      throw new LocalProjectRoomEvictingError(this.projectId);
    }
  }

  hasConnectedClients(): boolean {
    return this.peers.size > 0;
  }

  lastActivityAt(): number {
    return this.lastActiveAt;
  }

  /** Reserves this room for idle eviction; a peer attach cancels the attempt. */
  beginIdleEviction(): boolean {
    if (
      this.closed ||
      this.evicting ||
      this.peers.size > 0 ||
      this.activeOperations > 0
    )
      return false;
    this.evicting = true;
    this.evictionCancellation = new Promise<void>((resolve) => {
      this.resolveEvictionCancellation = resolve;
    });
    return true;
  }

  /** Pins an in-flight operation so an idle sweep cannot close the room under it. */
  pinOperation(): () => void {
    this.activeOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeOperations -= 1;
    };
  }

  isIdleEvictionActive(): boolean {
    return this.evicting;
  }

  /**
   * Cancels an eviction attempt and restores the schedule its flush suspended.
   *
   * A failed checkpoint, a peer that wins the attach race, or a replaced map
   * entry leaves the room serving traffic; it must keep pulling remote changes
   * and running journaled Provider work instead of going quiet until reopen.
   */
  cancelIdleEviction(): void {
    if (!this.evicting) return;
    this.evicting = false;
    this.resolveEvictionCancellation?.();
    this.resolveEvictionCancellation = undefined;
    this.evictionCancellation = undefined;
    const suspended = this.suspendedEvictionSchedule;
    this.suspendedEvictionSchedule = undefined;
    if (!suspended || this.closed) return;
    if (suspended.remote && !this.remoteSyncTimer) {
      this.startRemoteSnapshotSync(
        suspended.remoteDueAt === undefined
          ? this.remoteSyncRetryMs
          : suspended.remoteDueAt - Date.now(),
      );
    }
    if (suspended.pollDueAt !== undefined && !this.pollTimer) {
      this.armPollTimer(suspended.pollDueAt - Date.now());
    }
    if (suspended.pendingWorkDueAt !== undefined && !this.pendingWorkTimer) {
      this.armPendingWorkTimer(suspended.pendingWorkDueAt - Date.now());
    }
  }

  /**
   * Settles every background pass and checkpoints the durable update log before
   * the hub is allowed to drop the room. A failed checkpoint keeps the room
   * open and reports its existing coded health failure.
   */
  async flushForIdleEviction(): Promise<LocalProjectHealth> {
    if (this.closed) {
      return {
        ok: false,
        projectId: this.projectId,
        code: "PROJECT_WORK_FAILED",
        message: `Project ${this.projectId} room is already closed.`,
      };
    }
    const remoteDueAt = this.remoteSyncDueAt;
    const remoteInFlight = this.remoteSyncInFlight;
    if (this.remoteSyncTimer) {
      clearTimeout(this.remoteSyncTimer);
      this.remoteSyncTimer = undefined;
      this.remoteSyncDueAt = undefined;
    }
    const pollDueAt = this.pollDueAt;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
      this.pollDueAt = undefined;
    }
    const pendingWorkDueAt = this.pendingWorkTimer
      ? (this.pendingWorkDueAt ?? Date.now())
      : undefined;
    this.suspendedEvictionSchedule =
      remoteDueAt !== undefined ||
      remoteInFlight ||
      pollDueAt !== undefined ||
      pendingWorkDueAt !== undefined
        ? {
            remote: remoteDueAt !== undefined || remoteInFlight,
            remoteDueAt,
            pollDueAt,
            pendingWorkDueAt,
          }
        : undefined;
    // A remote catch-up may still be applying an update. Abort it and let its
    // settlement clear before deciding the room has no unflushed work. A peer
    // attach (or another cancellation) ends this wait immediately.
    this.remoteSyncAbort?.abort(new Error("Project room idle eviction"));
    this.remoteSyncAbort = undefined;
    const remoteDeadline = Date.now() + 5_000;
    const cancellation = this.evictionCancellation;
    while (this.remoteSyncInFlight && Date.now() < remoteDeadline) {
      if (!this.evicting || this.closed)
        return { ok: true, projectId: this.projectId };
      const remaining = remoteDeadline - Date.now();
      await Promise.race([
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(10, remaining));
          timer.unref?.();
        }),
        ...(cancellation ? [cancellation] : []),
      ]);
    }
    if (!this.evicting || this.closed)
      return { ok: true, projectId: this.projectId };
    if (this.remoteSyncInFlight) {
      return {
        ok: false,
        projectId: this.projectId,
        code: "PROJECT_WORK_FAILED",
        message: `Project ${this.projectId} remote sync did not settle before idle eviction.`,
      };
    }
    const openWorkDue = this.openBackgroundImmediate !== undefined;
    if (this.openBackgroundImmediate) {
      clearImmediate(this.openBackgroundImmediate);
      this.openBackgroundImmediate = undefined;
    }
    const pendingWorkPassDue = this.pendingWorkTimer !== undefined;
    if (this.pendingWorkTimer) {
      clearTimeout(this.pendingWorkTimer);
      this.pendingWorkTimer = undefined;
      this.pendingWorkDueAt = undefined;
      // This flush runs the pass now, so cancellation must not arm it again.
      if (this.suspendedEvictionSchedule)
        this.suspendedEvictionSchedule.pendingWorkDueAt = undefined;
    }
    if (openWorkDue || pendingWorkPassDue) {
      try {
        await this.enqueuePendingWorkPass(
          { onlyIfRunnable: true },
          true,
        );
      } catch (error) {
        this.recordWorkFailure(error);
      }
    }
    await this.pendingWorkQueue.catch(() => undefined);
    await this.projectOperations.catch(() => undefined);
    if (this.canvasPreviewTimer) {
      clearTimeout(this.canvasPreviewTimer);
      this.canvasPreviewTimer = undefined;
      this.enqueueCanvasPreviewRefresh();
    }
    await this.canvasPreviewWrites.catch(() => undefined);
    if (this.checkpointFailure) {
      return { ...this.checkpointFailure, logBytes: this.updateLogBytes };
    }
    if (this.updatesSinceSnapshot > 0 || this.updateLogBytes > 0) {
      try {
        await this.saveSnapshot();
      } catch (error) {
        this.recordCheckpointFailure(error);
        return this.projectHealth().failures[0] ?? {
          ok: false,
          projectId: this.projectId,
          code: "PROJECT_CHECKPOINT_FAILED",
          message: error instanceof Error ? error.message : String(error),
          logBytes: this.updateLogBytes,
        };
      }
    }
    return { ok: true, projectId: this.projectId };
  }

  inspectProject<T>(read: (doc: LoroDoc) => T | Promise<T>): Promise<T> {
    this.assertAcceptsReads();
    this.touch();
    return this.enqueueProjectOperation(async () => {
      const snapshot = LoroDoc.fromSnapshot(this.doc.export({ mode: "snapshot" }));
      try { return await read(snapshot); }
      finally { snapshot.free(); }
    });
  }

  /**
   * Reads the last durability-acknowledged Project state without joining the room queue.
   *
   * A Provider invocation runs while its workflow owns that queue, so an ordinary inspect would
   * wait behind the invocation that is waiting for the inspect. The callback receives a clone so
   * it can neither observe later uncheckpointed work nor mutate the room's committed read view.
   * Both inspection callbacks borrow their clone until settlement; return plain values or bytes.
   */
  async inspectCheckpointedProject<T>(
    read: (doc: LoroDoc) => T | Promise<T>,
  ): Promise<T> {
    this.assertAcceptsReads();
    this.touch();
    const snapshot = LoroDoc.fromSnapshot(this.checkpointedDoc.export({ mode: "snapshot" }));
    try { return await read(snapshot); }
    finally { snapshot.free(); }
  }

  mutateProject<T>(
    mutation: (
      doc: LoroDoc,
    ) => { value: T; save?: boolean } | Promise<{ value: T; save?: boolean }>,
  ): Promise<T> {
    this.assertAcceptsOperations();
    this.touch();
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
    this.assertAcceptsOperations();
    this.touch();
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
    await this.processPendingWork({ onlyIfRunnable: true });
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
    if (this.closed) throw new LocalProjectRoomClosedError(this.projectId);
    // A client that arrives while an idle flush is still settling wins: the
    // attach cancels eviction and the room keeps serving instead of making the
    // socket retry against a room that is about to disappear.
    if (this.evicting) this.cancelIdleEviction();
    this.touch();
    const id = Symbol("peer");
    this.peers.set(id, {
      sendUpdate: send,
      sendJson: options?.sendJson,
      runtimeId: options?.runtimeId,
      presence: options?.presence,
      syncProtocol: options?.syncProtocol,
    });
    if (options?.sendInitialSnapshot !== false) send(this.snapshot());
    // A client that connects while the cloud is unreachable must see the same
    // combined stale-remote state as peers that were already attached.
    if (this.remoteState)
      options?.sendJson?.({ ...this.remoteState });
    this.broadcastPresence();
    return id;
  }

  removePeer(id: PeerId): void {
    this.peers.delete(id);
    this.touch();
    this.broadcastPresence();
  }

  /**
   * Imports one peer update and, when required, runs the workflow pass.
   *
   * A live-sync acknowledgement must cover durability, not provider/plugin
   * discovery: `awaitPendingWork: false` lets the socket ack as soon as the
   * update is persisted, coalescing the pass until the edits stop. The pass
   * still runs, and reports any coded failure on the affected node.
   */
  async receive(
    sender: PeerId,
    update: Uint8Array,
    options?: { awaitPendingWork?: boolean },
  ): Promise<void> {
    this.touch();
    const runnableNodeIds = await this.enqueueProjectOperation(() =>
      this.receiveUnsafe(sender, update),
    );
    if (options?.awaitPendingWork === false) {
      this.schedulePendingWork();
      return;
    }
    await this.processPendingWork({
      onlyIfRunnable: true,
      runnableNodeIds,
    });
  }

  private schedulePendingWork(): void {
    this.armPendingWorkTimer(PROJECT_PENDING_WORK_DEBOUNCE_MS);
  }

  private armPendingWorkTimer(delayMs: number): void {
    if (this.closed) return;
    if (this.pendingWorkTimer) clearTimeout(this.pendingWorkTimer);
    const delay = Math.max(0, delayMs);
    this.pendingWorkDueAt = Date.now() + delay;
    this.pendingWorkTimer = setTimeout(() => {
      this.pendingWorkTimer = undefined;
      this.pendingWorkDueAt = undefined;
      // The debounce window may have covered many updates; one full scan at
      // the end of the burst is cheap and cannot use a stale touched set.
      void this.processPendingWork({ onlyIfRunnable: true }).catch((error) =>
        this.recordWorkFailure(error),
      );
    }, delay);
    this.pendingWorkTimer.unref?.();
  }

  /** Import remote state through the same durable Project mutation queue. */
  async mergeRemoteSnapshot(
    snapshot: Uint8Array,
    options?: { awaitPendingWork?: boolean },
  ): Promise<void> {
    const missing = await this.inspectProject(doc => {
      const before = doc.version();
      try {
        doc.import(snapshot);
        const after = doc.version();
        try { return before.compare(after) === 0 ? null : doc.export({ mode: "update", from: before }); }
        finally { after.free(); }
      } finally { before.free(); }
    });
    if (missing)
      await this.receiveCloudUpdates(loroSyncUpdateId(missing), [missing], options);
  }

  private async receiveCloudUpdates(
    _batchId: string,
    updates: Uint8Array[],
    options?: { awaitPendingWork?: boolean },
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
    if (options?.awaitPendingWork === false) {
      this.schedulePendingWork();
      return;
    }
    await this.processPendingWork({ onlyIfRunnable: true });
  }

  private async receiveUnsafe(
    sender: PeerId,
    update: Uint8Array,
  ): Promise<ReadonlySet<string> | "all"> {
    const updateBytes = exactBytes(update);
    const current = this.checkpointedDoc;
    const liveVersion = this.doc.version();
    const beforeNodes = current.getMap("nodes");
    let admittedUpdate = updateBytes;
    let upgraded = false;
    let nodeStructureChanged = false;
    let timelineNodeTouched = false;
    let directorNodeTouched = false;
    let changedNodeIds: string[] = [];
    const nodesBefore = new Map<string, Record<string, any>>();
    const touched: TouchedContainers = {
      names: new Set(),
      nodeIds: new Set(),
      layoutIds: new Set(),
    };
    const unsubscribe = this.doc.subscribe((batch) =>
      collectTouchedContainers(batch, touched),
    );
    try {
      this.doc.import(updateBytes);
      const nodeTouched = touched.names.has("nodes");
      const layoutTouched = touched.names.has(CANVAS_NODE_LAYOUTS);

      const generatorContainers = HOST_OWNED_GENERATOR_AUTHORITY_CONTAINERS.filter(
        (container) => touched.names.has(container),
      );
      if (generatorContainers.length > 0) {
        assertLocalPeerHostOwnedAuthorityMutation(
          current,
          this.doc,
          "Generator",
          generatorContainers,
        );
      }
      const documentAssetContainers = HOST_OWNED_DOCUMENT_ASSET_AUTHORITY_CONTAINERS.filter(
        (container) => touched.names.has(container),
      );
      if (documentAssetContainers.length > 0) {
        assertLocalPeerHostOwnedAuthorityMutation(
          current,
          this.doc,
          "Document Asset",
          documentAssetContainers,
        );
      }
      const projectAssetContainers = [
        PROJECT_ASSETS_CONTAINER,
        PROJECT_ASSET_SCHEMA_CONTAINER,
      ].filter((container) => touched.names.has(container));
      if (
        projectAssetContainers.some(
          (container) =>
            !isDeepStrictEqual(
              this.doc.getMap(container).toJSON(),
              current.getMap(container).toJSON(),
            ),
        )
      ) {
        throw new Error(
          "Local peer updates cannot mutate Host-owned Project Asset authority; use the Asset SDK/Host publication boundary.",
        );
      }
      if (
        touched.names.has(ACTION_ASSET_BINDINGS_CONTAINER) ||
        touched.names.has(ACTION_ASSET_BINDING_SCHEMA_CONTAINER)
      ) {
        assertLocalPeerActionAssetBindingMutation(current, this.doc);
      }
      const graphTouched = intersects(touched.names, [
        NODE_UPSTREAMS_CONTAINER,
        "edges",
        EDGE_IDENTITY_CONTAINER,
      ]);
      if (nodeTouched || layoutTouched || graphTouched) {
        let fullNodeGuard = graphTouched;
        if (nodeTouched && !fullNodeGuard) {
          const afterNodes = this.doc.getMap("nodes");
          for (const nodeId of touched.nodeIds) {
            const before = beforeNodes.get(nodeId) as
              | Record<string, any>
              | undefined;
            const after = afterNodes.get(nodeId) as
              | Record<string, any>
              | undefined;
            if (
              !before !== !after ||
              before?.type !== after?.type ||
              before?.canvasId !== after?.canvasId ||
              before?.data?.assetId !== after?.data?.assetId ||
              before?.data?.generatorId !== after?.data?.generatorId ||
              before?.data?.documentRevision !== after?.data?.documentRevision
            ) {
              fullNodeGuard = true;
              break;
            }
          }
        }
        assertLocalPeerModelProjectionMutation(current, this.doc, {
          ...(fullNodeGuard ? {} : { nodeIds: touched.nodeIds }),
          ...(layoutTouched ? { layoutIds: touched.layoutIds } : {}),
          checkLayouts: layoutTouched,
        });
      }
      if (
        nodeTouched &&
        this.upgradeProject &&
        hasLegacyCanvasGeneratorDrafts(this.doc)
      ) {
        upgraded = await this.upgradeProject({
          projectId: this.projectId,
          doc: this.doc,
        });
      }
      if (nodeTouched) {
        const addedCanvasIds = new Set<string>();
        const afterNodes = this.doc.getMap("nodes");
        for (const nodeId of touched.nodeIds) {
          if (
            beforeNodes.get(nodeId) !== undefined ||
            afterNodes.get(nodeId) === undefined
          ) {
            continue;
          }
          const raw = afterNodes.get(nodeId) as
            | Record<string, unknown>
            | undefined;
          addedCanvasIds.add(
            typeof raw?.canvasId === "string"
              ? raw.canvasId
              : DEFAULT_CANVAS_ID,
          );
        }
        if (addedCanvasIds.size > 0) {
          upgraded =
            completePendingCanvasLayout(this.doc, addedCanvasIds) || upgraded;
        }
      }
      if (upgraded) {
        this.doc.commit();
        admittedUpdate = exactBytes(
          this.doc.export({ mode: "update", from: liveVersion }),
        );
      }
      if (touched.nodeIds.size > 0) {
        const afterNodes = this.doc.getMap("nodes");
        for (const nodeId of touched.nodeIds) {
          const before = beforeNodes.get(nodeId) as
            | Record<string, unknown>
            | undefined;
          const after = afterNodes.get(nodeId) as
            | Record<string, unknown>
            | undefined;
          if (!before !== !after) nodeStructureChanged = true;
          const type = after?.type ?? before?.type;
          if (type === "video-editor") timelineNodeTouched = true;
          if (type === "director-stage") directorNodeTouched = true;
        }
      }
      changedNodeIds = [...touched.nodeIds];
      if (changedNodeIds.length > 0 && this.hasActivityAudience(sender)) {
        for (const nodeId of changedNodeIds) {
          const raw = beforeNodes.get(nodeId);
          if (raw !== undefined) {
            nodesBefore.set(nodeId, raw as Record<string, any>);
          }
        }
      }
      // The durability append happens only after every authority guard
      // accepted the already-imported live state, so the replica does not need
      // to fork the whole document to validate the same bytes again.
      await this.persistUpdate(admittedUpdate, { prevalidated: true });
    } catch (error) {
      unsubscribe();
      liveVersion.free();
      this.restoreLiveProjectFromCheckpoint(this.doc);
      throw error;
    }
    unsubscribe();
    liveVersion.free();
    const graphRepairNeeded =
      nodeStructureChanged ||
      intersects(touched.names, [
        "edges",
        EDGE_IDENTITY_CONTAINER,
        NODE_UPSTREAMS_CONTAINER,
        "graphSchema",
      ]);
    const timelineRepairNeeded =
      timelineNodeTouched || touched.names.has("timelines");
    const directorRepairNeeded =
      directorNodeTouched || touched.names.has("directorStages");
    const coverRepairNeeded = intersects(touched.names, [
      PROJECT_PRESENTATION_CONTAINER,
      ACTION_ASSET_BINDINGS_CONTAINER,
      PROJECT_ASSETS_CONTAINER,
    ]);
    const bindingRepairNeeded = intersects(touched.names, [
      ACTION_ASSET_BINDINGS_CONTAINER,
      ACTION_ASSET_BINDING_SCHEMA_CONTAINER,
      PROJECT_ASSETS_CONTAINER,
    ]);
    // Ordinary layout/node-data edits reconcile nothing; do not allocate a
    // version or run a repair scan unless a repair is actually due.
    const repairNeeded =
      graphRepairNeeded ||
      timelineRepairNeeded ||
      directorRepairNeeded ||
      coverRepairNeeded ||
      bindingRepairNeeded;
    const repairVersion = repairNeeded ? this.doc.version() : null;
    let workspaceRepaired = false;
    if (graphRepairNeeded) {
      workspaceRepaired =
        canvasGraphReconciliationChanged(reconcileCanvasGraph(this.doc)) ||
        workspaceRepaired;
    }
    if (timelineRepairNeeded) {
      const timelineRepair = reconcileProjectTimelineOwnership(this.doc);
      workspaceRepaired =
        timelineRepair.removedActionNodeIds.length > 0 ||
        timelineRepair.detachedTimelineIds.length > 0 ||
        workspaceRepaired;
    }
    if (directorRepairNeeded) {
      const directorRepair = reconcileProjectDirectorStageOwnership(this.doc);
      workspaceRepaired =
        directorRepair.removedActionNodeIds.length > 0 ||
        directorRepair.detachedStageIds.length > 0 ||
        workspaceRepaired;
    }
    if (coverRepairNeeded) {
      workspaceRepaired =
        reconcileProjectCoverBindings(this.doc).changed || workspaceRepaired;
    }
    if (bindingRepairNeeded) {
      workspaceRepaired =
        reconcileActionAssetBindingTargets(this.doc).restoredProjectAssetIds
          .length > 0 || workspaceRepaired;
    }
    const repairUpdate =
      workspaceRepaired && repairVersion
        ? exactBytes(this.doc.export({ mode: "update", from: repairVersion }))
        : null;
    repairVersion?.free();
    if (this.peers.get(sender)?.syncProtocol !== "loro-v1") {
      this.peers.get(sender)?.sendJson?.({
        type: "sync_ack",
        updateId: loroSyncUpdateId(updateBytes),
      });
    }
    for (const [peerId, peer] of this.peers.entries()) {
      if (peerId !== sender || upgraded) peer.sendUpdate(admittedUpdate);
    }
    this.mirrorRemoteUpdate(admittedUpdate);
    if (repairUpdate?.byteLength) {
      await this.persistUpdate(repairUpdate);
      for (const peer of this.peers.values()) peer.sendUpdate(repairUpdate);
      this.mirrorRemoteUpdate(repairUpdate);
    }
    if (changedNodeIds.length > 0) {
      this.broadcastNodeActivity(sender, changedNodeIds, nodesBefore);
    }
    // A small update can only make one of the nodes it touched runnable. Repair
    // and upgrade passes may synthesize nodes, so those require the full scan.
    return workspaceRepaired || upgraded ? "all" : touched.nodeIds;
  }

  private hasActivityAudience(sender: PeerId): boolean {
    for (const [peerId, peer] of this.peers) {
      if (peerId !== sender && peer.sendJson) return true;
    }
    return false;
  }

  private broadcastNodeActivity(
    sender: PeerId,
    changedNodeIds: readonly string[],
    nodesBefore: Map<string, Record<string, any>>,
  ): void {
    if (!this.hasActivityAudience(sender)) return;
    const nodes = this.doc.getMap("nodes");
    for (const id of changedNodeIds) {
      const after = nodes.get(id) as Record<string, any> | undefined;
      const before = nodesBefore.get(id);
      if (!before && after) {
        this.broadcastActivity(sender, "added", id, after);
      } else if (before && !after) {
        this.broadcastActivity(sender, "deleted", id, before);
      } else if (before && after) {
        this.broadcastActivity(sender, "updated", id, after);
      }
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

  projectHealth(): LocalProjectHealthSummary {
    const failures: LocalProjectHealth[] = [];
    if (this.checkpointFailure) {
      failures.push({
        ...this.checkpointFailure,
        logBytes: this.updateLogBytes,
      });
    }
    if (this.workFailure) {
      failures.push({ ...this.workFailure, logBytes: this.updateLogBytes });
    }
    return {
      ok: failures.length === 0,
      ...(failures[0]?.code ? { code: failures[0].code } : {}),
      failures,
    };
  }

  private async saveSnapshot(): Promise<void> {
    await this.replica.checkpoint();
    this.updatesSinceSnapshot = 0;
    this.updateBytesSinceSnapshot = 0;
    this.updateLogBytes = 0;
    this.lastCheckpointAt = Date.now();
    this.clearCheckpointFailure();
  }

  private shouldCheckpoint(): boolean {
    if (
      this.updatesSinceSnapshot < LOCAL_LORO_COMPACT_UPDATE_THRESHOLD &&
      this.updateBytesSinceSnapshot < LOCAL_LORO_COMPACT_BYTES_THRESHOLD
    ) {
      return false;
    }
    return (
      Date.now() - this.lastCheckpointAt >= LOCAL_LORO_COMPACT_MIN_INTERVAL_MS
    );
  }

  private async ensureUpdateLogCapacity(): Promise<void> {
    if (this.updateLogBytes < LOCAL_LORO_UPDATE_LOG_HARD_CAP_BYTES) return;
    try {
      await this.saveSnapshot();
    } catch (error) {
      this.recordCheckpointFailure(error);
      throw new LocalProjectCheckpointError(
        this.projectId,
        this.updateLogBytes,
        error,
      );
    }
  }

  private recordCheckpointFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = (this.checkpointFailure?.attempts ?? 0) + 1;
    const retryDelay = Math.min(
      LOCAL_LORO_CHECKPOINT_RETRY_MAX_MS,
      LOCAL_LORO_CHECKPOINT_RETRY_BASE_MS *
        2 ** Math.min(attempts - 1, 10),
    );
    const failure = {
      ok: false as const,
      code: "PROJECT_CHECKPOINT_FAILED" as const,
      projectId: this.projectId,
      message: `Project ${this.projectId} checkpoint failed: ${message}`,
      cause: message,
      logBytes: this.updateLogBytes,
      attempts,
      retryAt: Date.now() + retryDelay,
    };
    this.checkpointFailure = failure;
    console.error(
      "[local-sync] failed to compact committed Project checkpoint",
      error,
    );
    this.broadcastJson({ type: "project_health", ...failure });
    this.scheduleCheckpointRetry(retryDelay);
  }

  private scheduleCheckpointRetry(delayMs: number): void {
    if (this.closed) return;
    if (this.checkpointRetryTimer) clearTimeout(this.checkpointRetryTimer);
    this.checkpointRetryTimer = setTimeout(() => {
      this.checkpointRetryTimer = undefined;
      void this.enqueueProjectOperation(async () => {
        if (this.closed) return;
        try {
          await this.saveSnapshot();
        } catch (error) {
          this.recordCheckpointFailure(error);
        }
      }).catch(() => undefined);
    }, delayMs);
    this.checkpointRetryTimer.unref?.();
  }

  private clearCheckpointFailure(): void {
    if (!this.checkpointFailure) return;
    this.checkpointFailure = undefined;
    if (this.checkpointRetryTimer) {
      clearTimeout(this.checkpointRetryTimer);
      this.checkpointRetryTimer = undefined;
    }
    this.broadcastJson({
      type: "project_health",
      ok: true,
      projectId: this.projectId,
      logBytes: this.updateLogBytes,
    });
  }

  private recordWorkFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const failure = {
      ok: false as const,
      code: "PROJECT_WORK_FAILED" as const,
      projectId: this.projectId,
      message: `Project ${this.projectId} pending work failed: ${message}`,
      cause: message,
    };
    this.workFailure = failure;
    console.error(
      "[local-sync] failed to process pending Project work",
      error,
    );
    this.broadcastJson({
      type: "project_health",
      ok: false,
      code: failure.code,
      projectId: failure.projectId,
      message: failure.message,
    });
  }

  private clearWorkFailure(): void {
    if (!this.workFailure) return;
    this.workFailure = undefined;
    this.broadcastJson({
      type: "project_health",
      ok: true,
      projectId: this.projectId,
      logBytes: this.updateLogBytes,
    });
  }

  private async persistUpdate(
    update: Uint8Array,
    options?: { prevalidated?: boolean },
  ): Promise<void> {
    await this.ensureUpdateLogCapacity();
    const result = await this.replica.submit(
      {
        id: loroSyncUpdateId(update),
        update,
      },
      options,
    );
    this.checkpointedDoc = this.replica.read((state) => state);
    if (result.appended) {
      await this.onProjectCommitted?.(this.projectId);
      this.updatesSinceSnapshot += 1;
      this.updateBytesSinceSnapshot += update.byteLength;
      this.updateLogBytes += update.byteLength + 4;
    }
    if (this.shouldCheckpoint()) {
      try {
        await this.saveSnapshot();
      } catch (error) {
        this.recordCheckpointFailure(error);
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
        if (cached?.docVersion === entry.docVersion) return;
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

  private restoreLiveProjectFromCheckpoint(preserveRootsOf?: LoroDoc): void {
    const emptyRoots: Array<{ name: string; list: boolean }> = [];
    if (preserveRootsOf) {
      for (const [name, value] of Object.entries(preserveRootsOf.toJSON())) {
        if (Array.isArray(value)) {
          if (value.length === 0) emptyRoots.push({ name, list: true });
        } else if (
          value !== null &&
          typeof value === "object" &&
          Object.keys(value).length === 0
        ) {
          emptyRoots.push({ name, list: false });
        }
      }
    }
    this.doc = LoroDoc.fromSnapshot(
      this.checkpointedDoc.export({ mode: "snapshot" }),
    );
    // Loro snapshots omit empty roots, but a rejected peer update must leave
    // the live document byte-for-byte equivalent to what the peer observed.
    for (const root of emptyRoots) {
      if (root.list) this.doc.getList(root.name);
      else this.doc.getMap(root.name);
    }
  }

  private processPendingWork(options?: {
    onlyIfRunnable?: boolean;
    /** Touched node ids for a small peer update; `"all"` forces a full scan. */
    runnableNodeIds?: ReadonlySet<string> | "all";
  }): Promise<void> {
    return this.enqueuePendingWorkPass(options, false);
  }

  private enqueuePendingWorkPass(
    options: {
      onlyIfRunnable?: boolean;
      /** Touched node ids for a small peer update; `"all"` forces a full scan. */
      runnableNodeIds?: ReadonlySet<string> | "all";
    } | undefined,
    duringClose: boolean,
  ): Promise<void> {
    if (this.closed && !duringClose) return Promise.resolve();
    const onlyIfRunnable = options?.onlyIfRunnable ?? false;
    const runnableNodeIds =
      options?.runnableNodeIds === "all" ? undefined : options?.runnableNodeIds;
    const run = this.pendingWorkQueue
      .then(() =>
        this.enqueueProjectOperation(() => {
          if (
            onlyIfRunnable &&
            !hasRunnableProjectWork(this.doc, runnableNodeIds)
          )
            return;
          return this.processPendingWorkOnce();
        }),
      )
      .then(() => this.clearWorkFailure());
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
      this.pollDueAt = undefined;
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
    this.armPollTimer(
      Math.max(
        this.workflowProcessor.minimumPollDelayMs ?? 1_000,
        earliest - Date.now(),
      ),
    );
  }

  private armPollTimer(delayMs: number): void {
    if (this.closed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const delay = Math.max(0, delayMs);
    this.pollDueAt = Date.now() + delay;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.pollDueAt = undefined;
      void this.processPendingWork();
    }, delay);
    this.pollTimer.unref?.();
  }

  close(options: { releaseDocuments?: boolean } = {}): Promise<void> {
    return (this.closePromise ??= this.closeOnce(
      options.releaseDocuments ?? false,
    ));
  }

  private async closeOnce(releaseDocuments: boolean): Promise<void> {
    const pendingWorkPassDue = this.pendingWorkTimer !== undefined;
    const openWorkDue = this.openBackgroundImmediate !== undefined;
    this.closed = true;
    this.pollScheduleVersion += 1;
    this.suspendedEvictionSchedule = undefined;
    this.resolveEvictionCancellation?.();
    this.resolveEvictionCancellation = undefined;
    this.evictionCancellation = undefined;
    if (this.openBackgroundImmediate) {
      clearImmediate(this.openBackgroundImmediate);
      this.openBackgroundImmediate = undefined;
    }
    if (this.remoteSyncTimer) {
      clearTimeout(this.remoteSyncTimer);
      this.remoteSyncTimer = undefined;
    }
    this.remoteSyncDueAt = undefined;
    // A background resolve may still be inside a token/admission read. Abort it
    // so a late result cannot attach a link or broadcast after close.
    this.remoteSyncAbort?.abort(new Error("Project room closed"));
    this.remoteSyncAbort = undefined;
    if (this.pendingWorkTimer) {
      clearTimeout(this.pendingWorkTimer);
      this.pendingWorkTimer = undefined;
    }
    this.pendingWorkDueAt = undefined;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.pollDueAt = undefined;
    if (this.checkpointRetryTimer) {
      clearTimeout(this.checkpointRetryTimer);
      this.checkpointRetryTimer = undefined;
    }
    // A close inside the debounce window (or before the deferred open pass
    // starts) would otherwise drop work an already acknowledged edit made
    // runnable. Finish that pass before tearing down.
    if (pendingWorkPassDue || openWorkDue) {
      try {
        await this.enqueuePendingWorkPass(
          { onlyIfRunnable: true },
          true,
        );
      } catch (error) {
        this.recordWorkFailure(error);
      }
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
    // The room owns the working document and the replica's checkpointed
    // document; both are distinct native Loro documents. Ordinary close keeps
    // them readable (existing callers inspect the checkpoint after close);
    // idle eviction removes the room, so it releases them explicitly.
    if (releaseDocuments) {
      this.documentsReleased = true;
      this.doc.free();
      this.checkpointedDoc.free();
    }
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

  private reportRemoteMirrorFailure(error: unknown): void {
    console.error(
      "[local-sync] failed to mirror update to remote persistence",
      error,
    );
    void Promise.resolve(
      this.onRemoteMirrorFailure?.(this.projectId, error),
    ).catch((hookError) => {
      console.error(
        "[local-sync] failed to record remote Project mirror failure",
        hookError,
      );
    });
  }

  private mirrorRemoteUpdate(update: Uint8Array): void {
    if (this.remoteLink) {
      void Promise.resolve(this.remoteLink.publish(update)).catch((error) =>
        this.reportRemoteMirrorFailure(error),
      );
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
      .catch((error) => this.reportRemoteMirrorFailure(error));
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
      onState: (state) => this.reportCloudLinkState(state),
    });
    this.remoteLink = link;
    void Promise.resolve(link.start()).catch((error) => {
      if (this.remoteLink === link) this.remoteLink = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.reportCloudLinkState({
        state: "stopped",
        code: "CLOUD_LINK_START_FAILED",
        message,
      });
      console.error("[local-sync] failed to start cloud replica link", error);
      this.reportRemoteMirrorFailure(error);
    });
    return link;
  }

  private reportCloudLinkState(state: CloudReplicaLinkState): void {
    if (this.closed) return;
    this.cloudLinkState = state;
    this.publishRemoteState();
  }

  private broadcastPresence(): void {
    const clients = Array.from(this.peers.values())
      .map((peer) => peer.presence)
      .filter((client): client is PresenceClient => !!client);
    for (const peer of this.peers.values()) {
      peer.sendJson?.({
        type: "presence",
        clients,
        ...(peer.presence ? { selfClientId: peer.presence.id } : {}),
      });
    }
  }
}

/** The hub is flushing/evicting an idle room; the caller should reopen it. */
export class LocalProjectRoomEvictingError extends Error {
  override name = "LocalProjectRoomEvictingError";
  readonly code = "PROJECT_ROOM_EVICTING" as const;

  constructor(readonly projectId: string) {
    super(`Project ${projectId} room is being evicted after idle.`);
  }
}

export class LocalProjectRoomClosedError extends Error {
  override name = "LocalProjectRoomClosedError";
  readonly code = "PROJECT_ROOM_CLOSED" as const;

  constructor(readonly projectId: string) {
    super(`Project ${projectId} room is closed.`);
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
  private readonly attachedPeers = new Map<string, number>();
  private readonly importReservations = new Set<string>();
  private readonly activeImports = new Set<Promise<unknown>>();
  private readonly replicaStore: FileReplicaStore;
  private readonly evictions = new Map<string, Promise<void>>();
  private readonly idleTimeoutMs: number;
  private readonly maxRooms: number;
  private readonly idleSweepTimer: ReturnType<typeof setInterval>;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly remotePersistence?: RemoteLoroPersistenceSource,
    private readonly workflowProcessor?: LocalWorkflowProcessor | null,
    private readonly upgradeProject?: LocalProjectUpgrade,
    private readonly onProjectCommitted?: (projectId: string) => Promise<void>,
    private readonly onRemoteMirrorFailure?: (
      projectId: string,
      error: unknown,
    ) => void | Promise<void>,
    options: {
      idleTimeoutMs?: number;
      maxRooms?: number;
      sweepIntervalMs?: number;
    } = {},
  ) {
    this.replicaStore = new FileReplicaStore(join(dataDir, "projects"));
    this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? 60_000);
    this.maxRooms = Math.max(1, options.maxRooms ?? 8);
    const sweepIntervalMs = Math.max(
      25,
      options.sweepIntervalMs ??
        Math.min(5_000, Math.max(250, this.idleTimeoutMs / 4)),
    );
    this.idleSweepTimer = setInterval(() => {
      void this.evictIdleRooms().catch((error) => {
        console.error("[local-sync] idle room sweep failed", error);
      });
    }, sweepIntervalMs);
    this.idleSweepTimer.unref?.();
  }

  async room(projectId: string): Promise<LocalLoroRoom> {
    const eviction = this.evictions.get(projectId);
    if (eviction) await eviction.catch(() => undefined);
    if (this.closed) {
      throw new Error("Local Project room hub is closed.");
    }
    if (this.importReservations.has(projectId)) {
      throw new LocalProjectRoomBusyError(projectId);
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
            upgradeProject: this.upgradeProject,
            onProjectCommitted: this.onProjectCommitted,
            onRemoteMirrorFailure: this.onRemoteMirrorFailure,
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
    try { snapshotDoc.import(snapshot); }
    finally { snapshotDoc.free(); }
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

  /**
   * Runs an operation against the current room, retrying if an idle eviction
   * races the acquisition. Callers that must await between taking a room and
   * using it should route through this method instead of holding `room()`.
   */
  async withRoom<T>(
    projectId: string,
    operation: (room: LocalLoroRoom) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Take the pin before the room can be considered idle: beginIdleEviction
      // refuses a room with an active operation, so an awaited operation cannot
      // be closed underneath by a concurrent sweep.
      const room = await this.room(projectId);
      const release = room.pinOperation();
      try {
        return await operation(room);
      } catch (error) {
        if (
          error instanceof LocalProjectRoomEvictingError ||
          error instanceof LocalProjectRoomClosedError
        ) {
          continue;
        }
        throw error;
      } finally {
        release();
      }
    }
    throw new Error(
      `Project ${projectId} room could not be acquired after idle eviction.`,
    );
  }

  async inspectProject<T>(
    projectId: string,
    read: (doc: LoroDoc) => T | Promise<T>,
  ): Promise<T> {
    return this.withRoom(projectId, (room) => room.inspectProject(read));
  }

  async inspectCheckpointedProject<T>(
    projectId: string,
    read: (doc: LoroDoc) => T | Promise<T>,
  ): Promise<T> {
    return this.withRoom(projectId, (room) => {
      const initialized = this.checkpointReadableRooms.get(projectId) ?? room;
      return initialized.inspectCheckpointedProject(read);
    });
  }

  async mutateProject<T>(
    projectId: string,
    mutation: (
      doc: LoroDoc,
    ) => { value: T; save?: boolean } | Promise<{ value: T; save?: boolean }>,
  ): Promise<T> {
    return this.withRoom(projectId, (room) =>
      room.mutateProject(mutation),
    );
  }

  async mutateProjectWithCheckpoint<T>(
    projectId: string,
    mutation: (doc: LoroDoc, checkpoint: () => Promise<void>) => T | Promise<T>,
  ): Promise<T> {
    return this.withRoom(projectId, (room) =>
      room.mutateProjectWithCheckpoint(mutation),
    );
  }

  async mergeRemoteSnapshot(
    projectId: string,
    snapshot: Uint8Array,
    options?: { awaitPendingWork?: boolean },
  ): Promise<void> {
    return this.withRoom(projectId, (room) =>
      room.mergeRemoteSnapshot(snapshot, options),
    );
  }

  async refresh(projectId: string): Promise<void> {
    const existing = this.rooms.get(projectId);
    await this.withRoom(projectId, (room) =>
      existing ? room.refreshFromStore() : Promise.resolve(),
    );
  }

  roomCount(): number {
    return this.rooms.size;
  }

  /**
   * Evicts rooms that have had no clients for `idleTimeoutMs`, plus
   * least-recently-used idle rooms while the open count exceeds `maxRooms`.
   * Connected rooms and rooms whose flush/checkpoint fails stay open.
   */
  async evictIdleRooms(
    options: {
      now?: number;
      idleTimeoutMs?: number;
      maxRooms?: number;
    } = {},
  ): Promise<{
    evicted: string[];
    failures: LocalProjectHealth[];
  }> {
    const now = options.now ?? Date.now();
    const idleTimeoutMs = options.idleTimeoutMs ?? this.idleTimeoutMs;
    const maxRooms = options.maxRooms ?? this.maxRooms;
    const candidates: Array<{
      projectId: string;
      roomPromise: Promise<LocalLoroRoom>;
      room: LocalLoroRoom;
      idleFor: number;
    }> = [];
    for (const [projectId, promise] of this.rooms) {
      if (this.evictions.has(projectId)) continue;
      const room = await promise.catch(() => undefined);
      if (!room || room.hasConnectedClients()) continue;
      candidates.push({
        projectId,
        roomPromise: promise,
        room,
        idleFor: now - room.lastActivityAt(),
      });
    }
    candidates.sort((left, right) => right.idleFor - left.idleFor);
    const evicted: string[] = [];
    const failures: LocalProjectHealth[] = [];
    for (const candidate of candidates) {
      const timedOut = candidate.idleFor >= idleTimeoutMs;
      if (!timedOut && this.rooms.size <= maxRooms) continue;
      const result = await this.evictRoom(
        candidate.projectId,
        candidate.roomPromise,
        candidate.room,
      );
      if (result.evicted) evicted.push(candidate.projectId);
      else if (result.failure) failures.push(result.failure);
    }
    return { evicted, failures };
  }

  private async evictRoom(
    projectId: string,
    roomPromise: Promise<LocalLoroRoom>,
    room: LocalLoroRoom,
  ): Promise<{ evicted: boolean; failure?: LocalProjectHealth }> {
    if (!room.beginIdleEviction()) return { evicted: false };
    const run = (async () => {
      const flushed = await room.flushForIdleEviction();
      // A peer attach (or another cancellation) may have won while the flush
      // was waiting. The room is serving again; restore nothing twice and
      // report no failure for the abandoned eviction.
      if (!room.isIdleEvictionActive()) return { evicted: false };
      if (!flushed.ok) {
        room.cancelIdleEviction();
        return { evicted: false, failure: flushed };
      }
      if (room.hasConnectedClients()) {
        room.cancelIdleEviction();
        return { evicted: false };
      }
      // No await between this final check and removing the room, so a new peer
      // cannot attach to a room that is already leaving the map.
      if (this.rooms.get(projectId) !== roomPromise) {
        room.cancelIdleEviction();
        return { evicted: false };
      }
      this.rooms.delete(projectId);
      this.checkpointReadableRooms.delete(projectId);
      await room.close({ releaseDocuments: true });
      return { evicted: true };
    })();
    const tracked = run.then(
      () => undefined,
      () => undefined,
    );
    this.evictions.set(projectId, tracked);
    try {
      return await run;
    } finally {
      if (this.evictions.get(projectId) === tracked) {
        this.evictions.delete(projectId);
      }
    }
  }

  projectHealth(): LocalProjectHealthSummary {
    const failures = [...this.checkpointReadableRooms.values()].flatMap(
      (room) => room.projectHealth().failures,
    );
    return {
      ok: failures.length === 0,
      ...(failures[0]?.code ? { code: failures[0].code } : {}),
      failures,
    };
  }

  /** Live Project socket clients, across every open room. */
  attachedClientCount(): number {
    let total = 0;
    for (const count of this.attachedPeers.values()) total += count;
    return total;
  }

  notePeerAttached(projectId: string): void {
    this.attachedPeers.set(
      projectId,
      (this.attachedPeers.get(projectId) ?? 0) + 1,
    );
  }

  notePeerDetached(projectId: string): void {
    const remaining = (this.attachedPeers.get(projectId) ?? 0) - 1;
    if (remaining > 0) this.attachedPeers.set(projectId, remaining);
    else this.attachedPeers.delete(projectId);
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    clearInterval(this.idleSweepTimer);
    await Promise.allSettled(this.activeImports);
    await Promise.allSettled(this.evictions.values());
    const rooms = await Promise.allSettled(this.rooms.values());
    await Promise.all(
      rooms.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.close()] : [],
      ),
    );
    this.rooms.clear();
    this.checkpointReadableRooms.clear();
    this.evictions.clear();
  }
}

export function attachLocalSync(
  server: UpgradeCapableServer,
  options: {
    dataDir: string;
    remotePersistence?: RemoteLoroPersistenceSource;
    workflowProcessor?: LocalWorkflowProcessor | null;
    hub?: LocalLoroRoomHub;
    upgradeProject?: LocalProjectUpgrade;
    onProjectCommitted?: (projectId: string) => Promise<void>;
    onRemoteMirrorFailure?: (
      projectId: string,
      error: unknown,
    ) => void | Promise<void>;
  },
): LocalLoroRoomHub {
  const hub =
    options.hub ??
    new LocalLoroRoomHub(
      options.dataDir,
      options.remotePersistence,
      options.workflowProcessor,
      options.upgradeProject,
      options.onProjectCommitted,
      options.onRemoteMirrorFailure,
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
      ).catch((error) => {
        console.error("[local-sync] failed to open Project socket", error);
        if (error instanceof LocalProjectUpgradeError && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(error.detail));
        }
        ws.close(1011, "Unable to open Project");
      });
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
    // The loopback Host has no session/token split; a local browser surface
    // is the person and every other local client is an agent.
    kind: clientType === "browser" ? "human" : "agent",
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
  let room = await hub.room(projectId);
  const sendProtocolUpdate = (update: Uint8Array) => {
    for (const frame of encodeLoroProtocolUpdateFrames(
      projectId,
      createLoroProtocolBatchId(),
      [update],
    )) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  };
  const attachPeer = () =>
    room.addPeer(
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
  let peerId: PeerId;
  try {
    peerId = attachPeer();
  } catch (error) {
    // An idle eviction can start between the hub lookup and peer attach. Wait
    // for it to finish, then attach to the fresh room instead of failing open.
    if (!(error instanceof LocalProjectRoomEvictingError)) throw error;
    room = await hub.room(projectId);
    peerId = attachPeer();
  }
  hub.notePeerAttached(projectId);
  const protocolSession = syncProtocol
    ? new LoroProtocolServerSession({
        roomId: projectId,
        doc: () => room.protocolDocument(),
        send: (frame) => {
          if (ws.readyState === ws.OPEN) ws.send(frame);
        },
        commit: async (_batchId, updates) => {
          // Ack after the durable append. Workflow/plugin discovery may be slow
          // or hung and must not hold the sync acknowledgement.
          for (const update of updates)
            await room.receive(peerId, update, { awaitPendingWork: false });
        },
      })
    : undefined;

  const sendSyncError = (error: unknown) => {
    if (ws.readyState !== ws.OPEN) return;
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "SYNC_UPDATE_FAILED";
    ws.send(
      JSON.stringify({
        type: "sync_error",
        code,
        error: error instanceof Error ? error.message : String(error),
        projectId,
      }),
    );
  };
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
          sendSyncError(error);
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
      : room.receive(peerId, bytes, { awaitPendingWork: false });
    void receive.catch((error) => {
      console.error("[local-sync] failed to import update", error);
      sendSyncError(error);
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
    hub.notePeerDetached(projectId);
  });
}
