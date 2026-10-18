import { presenceDevice } from "../loro/presence-device";
import { GenerationPublicationConflict, assertHostedGenerationAccess, generationAdmissionUpdate, generationPublicationUpdate, type GenerationNodePublication } from "../generation/publication";
import type { TimelineRenderNodePublication } from "../generation/timeline-render-publication";
/**
 * ProjectRoom — pure Loro CRDT sequencer Durable Object.
 *
 * Handles:
 * - Loro CRDT sync (binary WebSocket messages)
 * - Task submission (NodeProcessor) and polling (TaskPolling)
 * - Periodic snapshot persistence to D1
 * - Collaboration visibility (presence + activity sideband messages)
 *
 * Does NOT handle AI chat — that responsibility lives in SupervisorAgent.
 *
 * Two connection types:
 * - Browser clients via /sync/:projectId (authenticated)
 * - SupervisorAgent DOs via internal WS (x-internal-agent header)
 */

import { DurableObject } from "cloudflare:workers";
import { LoroDoc } from "loro-crdt";
import { ReplicaEngine } from "@clash/replica";
import {
  createContentReferenceIndexer,
  type ContentReferenceIndexer,
} from "@clash/replica/content-index";
import { projectSyncContent } from "@clash/shared-types/project-sync-content";
import { createD1ContentReferenceIndex } from "../services/project-content-cloud";
import { createD1ProjectAuthorizationStore } from "../loro/authorization-store";
import { LoroStateAdapter } from "@clash/replica/loro";
import {
  LoroProtocolServerSession,
  createLoroProtocolBatchId,
  encodeLoroProtocolUpdateFrames,
} from "@clash/replica/loro-protocol";

import { log } from "../logger";
import type { Env } from "../config";
import { CHECKPOINT_REQUESTED_SEQ_KEY, wipeDocState } from "../loro/storage";
import { createDurableObjectReplicaPorts } from "../loro/replica-ports";
import {
  processPendingNodes,
  recoverOrphanedTasks,
} from "../loro/NodeProcessor";
import { pollNodeTasks } from "../loro/TaskPolling";
import { updateNodeData, appendNodeLog } from "../loro/NodeUpdater";
import {
  authenticateRequest,
  revalidateProjectConnection,
  type AuthResult,
} from "../loro/auth";
import type {
  ClientInfo,
  ClientType,
  PresenceKind,
  ActivityMessage,
  ActivityAction,
  AwarenessBroadcastMessage,
  AwarenessPeer,
} from "@clash/shared-types";
import {
  DEFAULT_CANVAS_ID,
  canvasGraphReconciliationChanged,
  listNodeOwnedEdges,
  reconcileCanvasGraph,
  reconcileProjectTimelineOwnership,
  reconcileProjectDirectorStageOwnership,
} from "@clash/shared-types";

/**
 * How long one successful authorization check covers a socket (#240): the
 * first frame after this window lapses is re-checked. Idle sockets are
 * re-checked only on the room's existing 60 s alarm tick (no dedicated wakes),
 * so an idle revoked socket closes on the next tick while the room is
 * alarming, else on its next frame or reconnect.
 */
const SOCKET_AUTHORIZATION_TTL_MS = 5_000;
/** WebSocket close reasons are capped at 123 bytes; both stay well below. */
const AUTHORIZATION_REVOKED_CLOSE_REASON =
  "PROJECT_AUTHORIZATION_REVOKED: Your session expired or your access to this project was revoked.";
const AUTHORIZATION_UNAVAILABLE_CLOSE_REASON =
  "PROJECT_AUTHORIZATION_CHECK_UNAVAILABLE: Could not verify project access; reconnect.";
/** DO storage key: when the 60 s task poll is next due (the alarm is shared). */
const TASK_POLL_DUE_KEY = "taskPollDueAt";

/** A credential is never valid past its own expiry, whatever a check said. */
function credentialExpired(auth: AuthResult): boolean {
  const proof = auth.authorization;
  return (
    (proof?.kind === "jwt" || proof?.kind === "session") &&
    !(Date.now() < proof.expiresAt)
  );
}
/**
 * Largest single CRDT update a client may commit. Every accepted update stays
 * in the doc history forever (deletes leave tombstones) and is re-exported in
 * every snapshot, so one oversized write permanently slows joins, compaction
 * and the upload content resolver for the whole project. Binary content
 * belongs in R2 via the content upload path, not in the doc. Real project
 * docs are far below this (largest staging/prod rooms are tens of KiB).
 */
export const PROJECT_ROOM_MAX_UPDATE_BYTES = 4 * 1024 * 1024;

/** Alarm intervals in milliseconds */
const TASK_POLL_INTERVAL_MS = 60_000; // 60 seconds
const TASK_POLL_URGENT_MS = 2_000; // 2 seconds (after new task submission)
/** Compact the update log into a fresh shallow snapshot every N appended updates. */
const UPDATES_PER_COMPACT = 100;
/** Hard cap — if compaction is somehow stuck, force one to keep load fast. */
const UPDATES_HARD_COMPACT_THRESHOLD = 500;

/** Awareness throttling. Cap outbound broadcasts at ~12Hz; stale entries pruned after 45s. */
const AWARENESS_BROADCAST_MIN_INTERVAL_MS = 80;
// Must equal the client's PEER_STALE_MS and stay above its 20s HEARTBEAT_MS so
// a still-but-active cursor is refreshed before either side prunes it.
const AWARENESS_STALE_MS = 45_000;

type LoroImportQueueItem = {
  applyGeneration?: () => Promise<void>;
  sender?: WebSocket;
  data: Uint8Array;
  eventId?: string;
  broadcast?: boolean;
  runRealtimeEffects: boolean;
  resolve?: () => void;
  reject?: (error: unknown) => void;
};

type ProjectReplicaEngine = ReplicaEngine<LoroDoc, Uint8Array, Uint8Array>;

type ProjectClientInfo = ClientInfo & {
  syncProtocol?: "loro-v1";
  projectAuthorization?: AuthResult;
  /** Only direct service-binding callers can supply the internal header. */
  internal?: true;
};

/**
 * A person is behind a connection only when a browser session admitted it.
 * API tokens, JWTs and internal service bindings are agents acting for the
 * user. Development admits sockets without a credential, so only there the
 * declared client type decides.
 */
function connectionKind(
  info: Pick<
    ProjectClientInfo,
    "clientType" | "internal" | "projectAuthorization"
  >,
): PresenceKind {
  const proof = info.projectAuthorization?.authorization.kind;
  if (info.internal || !proof) return "agent";
  if (proof === "session") return "human";
  if (proof === "development")
    return info.clientType === "browser" ? "human" : "agent";
  return "agent";
}

export class ProjectRoom extends DurableObject<Env> {
  private doc: LoroDoc = new LoroDoc();
  private replica: ProjectReplicaEngine | null = null;
  private projectId = "";
  private initPromise: Promise<void> | null = null;
  private messageQueue: LoroImportQueueItem[] = [];
  private isProcessingQueue = false;
  private isProcessingNodes = false;

  /** Next sequence number for an appended update (loaded from storage on init). */
  private nextSeq = 0;
  /** Updates appended since last compaction. Triggers compactToSnapshot when it crosses UPDATES_PER_COMPACT. */
  private updatesSinceCompact = 0;
  /** Guard so we don't fire two compactions concurrently. */
  private compactionInFlight = false;
  /** Unsubscribe handle for the local-updates listener; cleared on destroy. */
  private unsubscribeLocalUpdates: (() => void) | null = null;

  /** Connected client identity map for presence tracking. */
  private clients: Map<WebSocket, ProjectClientInfo> = new Map();
  private protocolSessions = new Map<WebSocket, LoroProtocolServerSession>();
  /**
   * Revalidation results shared by every socket presenting the same identity
   * proof (one user's windows, Hosts and agents). Without this each socket
   * queried D1 every TTL, so D1 load grew linearly with room size and became
   * the first fan-out bottleneck (~130-150 sockets on staging).
   */
  private sharedAuthorization = new Map<
    string,
    { validUntil: number; result: Promise<boolean> }
  >();
  private socketAuthorization = new WeakMap<
    WebSocket,
    {
      expiresAt: number;
      inFlight?: Promise<boolean>;
    }
  >();
  /** Sockets closed or revoked; a pending check must not authorize them. */
  private closedSockets = new WeakSet<WebSocket>();
  private outbound = new Map<WebSocket, Promise<void>>();

  /** Throttle activity broadcasts: nodeId → last broadcast timestamp */
  private activityThrottle: Map<string, number> = new Map();

  /**
   * Ephemeral awareness state: per-WS cursor + selection.
   *
   * Never persisted — if the DO hibernates, this map drops and is rebuilt
   * organically as clients send their next awareness.update. Browser clients
   * resend cursor on every mousemove (throttled), so the rebuild window is
   * effectively zero seconds for active users; idle users blink once.
   */
  private awareness: Map<
    WebSocket,
    {
      cursor?: { x: number; y: number };
      selectedNodeIds: string[];
      updatedAt: number;
    }
  > = new Map();

  /** Coalesce outbound awareness broadcasts (timestamp of the last fan-out). */
  private lastAwarenessBroadcastAt = 0;
  /** If an update arrives while throttled, schedule one trailing-edge flush. */
  private awarenessFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Fetch: entry point for all requests ─────────────────────

  async fetch(request: Request): Promise<Response> {
    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    // HTTP endpoints
    return this.handleHttpRequest(request);
  }

  // ─── WebSocket Upgrade (replaces onConnect) ──────────────────

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const syncProtocol =
      url.searchParams.get("protocol") === "loro-v1"
        ? ("loro-v1" as const)
        : undefined;

    // Extract projectId from path: /sync/:projectId
    const pathParts = url.pathname.split("/").filter(Boolean);
    let projectId = "";
    if (pathParts[0] === "sync" && pathParts[1]) {
      projectId = pathParts[1];
    }
    if (!projectId) {
      projectId = url.searchParams.get("projectId") ?? "";
    }
    if (!projectId) {
      return new Response("Missing project ID", { status: 400 });
    }

    if (!this.env.ROOM.idFromName(projectId).equals(this.ctx.id)) {
      return new Response("Project ID mismatch", { status: 401 });
    }

    // Public routing strips this header; direct service bindings are trusted.
    const isInternal = request.headers.get("x-internal-agent") === "true";
    let clientType: ClientType = "browser";
    let userId = "unknown";
    let userName = "User";
    let userAvatar: string | undefined;
    let projectAuthorization: AuthResult | undefined;
    if (!isInternal) {
      try {
        const authResult = await authenticateRequest(
          request,
          this.env,
          projectId,
        );
        projectAuthorization = authResult;
        userId = authResult.userId;
        userName = authResult.userName ?? "User";
        userAvatar = authResult.userAvatar;

        // Detect client type from header
        const clientTypeHeader = request.headers.get("x-client-type");
        if (clientTypeHeader === "cli") {
          clientType = "cli";
        }
      } catch (error) {
        log.error("Auth failed:", error);
        return new Response("Unauthorized", { status: 401 });
      }
    } else {
      clientType = "agent";
      userName = request.headers.get("x-agent-name") || "Agent";
    }

    // Initialize on first connection
    if (!this.initPromise) {
      this.initPromise = this.initRoom(projectId);
    }
    await this.initPromise;

    // Verify project ID matches
    if (this.projectId !== projectId) {
      log.error(
        `Project ID mismatch: expected ${this.projectId}, got ${projectId}`,
      );
      return new Response("Project ID mismatch", { status: 400 });
    }

    if (
      projectAuthorization &&
      !(await revalidateProjectConnection(this.env, projectAuthorization))
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Create WebSocket pair and accept via Hibernation API
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    // Register client for presence — persist via serializeAttachment so it survives hibernation
    const admission = isInternal
      ? { internal: true as const }
      : { projectAuthorization };
    const clientInfo: ProjectClientInfo = {
      id: crypto.randomUUID(),
      userId,
      clientType,
      kind: connectionKind({ clientType, ...admission }),
      name: userName,
      avatar: userAvatar,
      device: presenceDevice(request.headers, clientType),
      connectedAt: Date.now(),
      ...admission,
      ...(syncProtocol ? { syncProtocol } : {}),
    };
    server.serializeAttachment(clientInfo);
    this.clients.set(server, clientInfo);

    if (syncProtocol) {
      this.protocolSessions.set(
        server,
        this.createProtocolSession(server, false),
      );
    } else {
      // Legacy clients receive an eager raw snapshot. Protocol clients first
      // send JoinRequest with their VersionVector and receive only the delta.
      try {
        const snapshot = this.doc.export({ mode: "snapshot" });
        this.sendAuthorized(server, snapshot);
      } catch (error) {
        log.error("Failed to send initial state:", error);
      }
    }

    // Broadcast updated presence to all clients
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── Room Initialization ─────────────────────────────────────

  private async initRoom(
    projectId: string,
    options: { enableTaskPolling?: boolean } = {},
  ): Promise<void> {
    const enableTaskPolling = options.enableTaskPolling ?? true;
    this.projectId = projectId;

    // Persist projectId so alarm() can recover after hibernation.
    await this.ctx.storage.put("projectId", projectId);

    const ports = createDurableObjectReplicaPorts(this.ctx.storage, {
      schedule: (scheduledTime) => this.scheduleAlarmAtEarliest(scheduledTime),
    });
    const persistedCheckpoint = await ports.checkpoints.load();
    this.replica = await ReplicaEngine.open({
      adapter: new LoroStateAdapter(),
      eventLog: ports.eventLog,
      checkpoints: ports.checkpoints,
      scheduler: ports.scheduler,
      checkpointPolicy: ({ eventsSinceCheckpoint }) =>
        eventsSinceCheckpoint >= UPDATES_PER_COMPACT,
    });
    this.doc = this.replica.read((doc) => doc);
    this.nextSeq = this.replica.cursor;
    this.updatesSinceCompact =
      this.replica.cursor - (persistedCheckpoint?.cursor ?? 0);

    const repairVersion = this.doc.version();
    const graphRepair = reconcileCanvasGraph(this.doc);
    const timelineRepair = reconcileProjectTimelineOwnership(this.doc);
    const directorRepair = reconcileProjectDirectorStageOwnership(this.doc);
    const workspaceRepaired =
      canvasGraphReconciliationChanged(graphRepair) ||
      timelineRepair.removedActionNodeIds.length > 0 ||
      timelineRepair.detachedTimelineIds.length > 0 ||
      directorRepair.removedActionNodeIds.length > 0 ||
      directorRepair.detachedStageIds.length > 0;
    const repairUpdate = workspaceRepaired
      ? this.doc.export({ mode: "update", from: repairVersion })
      : null;

    // Subscribe to LOCAL commits (taskPoll / orphan recovery / HTTP /update-node).
    // Imports from client WebSockets are persisted explicitly in
    // processMessageQueue — Loro's subscribeLocalUpdates does NOT fire for
    // imported updates, by design.
    this.installLocalUpdatePersistence();
    if (repairUpdate?.byteLength) {
      await this.persistAndMaybeCompact(repairUpdate);
    }

    if (enableTaskPolling) {
      // Schedule first alarm for task polling. Persistence is event-driven now,
      // not alarm-driven — the alarm is only for polling external task state.
      await this.scheduleAlarmAtEarliest(Date.now() + TASK_POLL_INTERVAL_MS);

      // Process any pending nodes and trigger polling.
      await this.taskPoll();
    }
  }

  /**
   * Append one update to the persisted log and trigger compaction if
   * the log has grown past the threshold. Single funnel for both local
   * commits (via subscribeLocalUpdates) and remote imports (called
   * from processMessageQueue after doc.import).
   */
  private installLocalUpdatePersistence(): void {
    this.unsubscribeLocalUpdates?.();
    this.unsubscribeLocalUpdates = this.doc.subscribeLocalUpdates((update) => {
      void this.persistAndMaybeCompact(update).catch(() => {
        // persistAndMaybeCompact already logs with room + sequence context.
        // Keep the rejected promise observed for locally-created commits.
      });
    });
  }

  private contentIndexer?: ContentReferenceIndexer<
    ReturnType<typeof projectSyncContent>
  >;
  private contentIndexerProject?: string;

  /** Issue #130: keeps D1 project_content_ref in step with the doc so uploads
   * never need this room's snapshot. */
  private contentIndex() {
    if (!this.contentIndexer || this.contentIndexerProject !== this.projectId) {
      const projectId = this.projectId;
      const index = createD1ContentReferenceIndex(this.env.DB as never);
      this.contentIndexerProject = projectId;
      this.contentIndexer = createContentReferenceIndexer({
        compute: () => projectSyncContent(this.doc),
        writer: { replace: (refs) => index.replace(projectId, refs) },
        onError: (error) =>
          log.warn(
            `[room proj=${projectId.slice(-6)}] content index write failed:`,
            error,
          ),
      });
    }
    return this.contentIndexer;
  }

  private async persistAndMaybeCompact(
    update: Uint8Array,
    eventId = crypto.randomUUID(),
  ): Promise<void> {
    const tag = `[room proj=${this.projectId.slice(-6)}]`;
    const seq = this.nextSeq;
    try {
      if (!this.replica) throw new Error("Project replica is not initialized");
      const result = await this.replica.submit({ id: eventId, update });
      this.nextSeq = this.replica.cursor;
      if (result.appended) {
        this.updatesSinceCompact++;
        this.contentIndex().changed();
      }
      if (
        this.compactionInFlight &&
        this.updatesSinceCompact >= UPDATES_HARD_COMPACT_THRESHOLD
      ) {
        log.warn(
          `${tag} update log past hard threshold (${this.updatesSinceCompact}); compaction stuck?`,
        );
      }
    } catch (e) {
      log.error(`${tag} appendUpdate seq=${seq} failed:`, e);
      throw e;
    }
  }

  private async runCompaction(tag: string): Promise<void> {
    if (this.compactionInFlight) return;
    this.compactionInFlight = true;
    try {
      if (!this.replica) throw new Error("Project replica is not initialized");
      const t0 = Date.now();
      const checkpoint = await this.replica.checkpoint();
      this.nextSeq = this.replica.cursor;
      this.updatesSinceCompact = this.nextSeq - checkpoint.cursor;
      const requestedCursor = await this.ctx.storage.get<number>(
        CHECKPOINT_REQUESTED_SEQ_KEY,
      );
      if (requestedCursor != null && requestedCursor <= checkpoint.cursor) {
        await this.ctx.storage.delete(CHECKPOINT_REQUESTED_SEQ_KEY);
      } else if (requestedCursor != null) {
        await this.scheduleAlarmAtEarliest(Date.now());
      }
      log.info(
        `${tag} compacted at seq ${checkpoint.cursor} in ${Date.now() - t0}ms`,
      );
    } catch (e) {
      log.error(`${tag} compaction failed:`, e);
      throw e;
    } finally {
      this.compactionInFlight = false;
    }
  }

  private async scheduleAlarmAtEarliest(scheduledTime: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || scheduledTime < current) {
      await this.ctx.storage.setAlarm(scheduledTime);
    }
  }

  private clientInfoFor(ws: WebSocket): ProjectClientInfo | undefined {
    const known = this.clients.get(ws);
    if (known) return known;
    try {
      const attachment = ws.deserializeAttachment() as ProjectClientInfo | null;
      if (attachment) this.clients.set(ws, attachment);
      return attachment ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A hibernated connection carries identity evidence, never raw credentials.
   * This ephemeral cache is rebuilt on wake. Inbound commits share it, so
   * the first frame after a check's SOCKET_AUTHORIZATION_TTL_MS window lapses
   * is re-checked. Idle sockets are re-checked only by recheckIdleSockets() on
   * the room's existing 60 s alarm tick (no dedicated wakes), so an idle
   * revoked socket closes on the next tick while the room is alarming, else on
   * its next frame or reconnect. An expired credential is refused
   * immediately, without D1.
   */
  private authorizeSocket(ws: WebSocket): boolean | Promise<boolean> {
    if (this.closedSockets.has(ws)) return false;
    const cached = this.socketAuthorization.get(ws);
    if (cached?.inFlight) return cached.inFlight;

    const info = this.clientInfoFor(ws);
    if (info?.internal === true) return true;
    if (info?.projectAuthorization && credentialExpired(info.projectAuthorization)) {
      this.closeSocket(ws, 1008, AUTHORIZATION_REVOKED_CLOSE_REASON);
      return false;
    }
    if (cached && Date.now() < cached.expiresAt) return true;
    const entry = {
      expiresAt: 0,
      inFlight: undefined as Promise<boolean> | undefined,
    };
    this.socketAuthorization.set(ws, entry);
    let validUntil = Date.now() + SOCKET_AUTHORIZATION_TTL_MS;
    entry.inFlight = (async () => {
      let authorized: boolean;
      try {
        authorized = !!(
          info?.projectAuthorization &&
          (!this.projectId ||
            info.projectAuthorization.projectId === this.projectId) &&
          (await this.revalidateShared(info.projectAuthorization, (until) => {
            validUntil = until;
          }))
        );
      } catch (error) {
        // The check itself failed (D1 unavailable), so authorization is
        // unknown. Dropping the frame silently would leave this peer missing
        // CRDT updates with no signal. Close with 1013 (try again later)
        // instead: the client treats it as transient, reconnects and
        // re-syncs from its version vector, and resends unacked writes.
        log.warn("Socket revalidation unavailable; closing for retry:", error);
        if (this.socketAuthorization.get(ws) === entry) {
          this.closeSocket(ws, 1013, AUTHORIZATION_UNAVAILABLE_CLOSE_REASON);
        }
        return false;
      }
      // A close/error during D1 must not restore authorization or send a frame.
      if (this.socketAuthorization.get(ws) !== entry || this.closedSockets.has(ws))
        return false;
      if (authorized) {
        // Never trust a shared result longer than TTL after it was checked.
        entry.expiresAt = Math.min(
          validUntil,
          Date.now() + SOCKET_AUTHORIZATION_TTL_MS,
        );
        return true;
      }
      this.closeSocket(ws, 1008, AUTHORIZATION_REVOKED_CLOSE_REASON);
      return false;
    })().finally(() => {
      entry.inFlight = undefined;
      if (!entry.expiresAt && this.socketAuthorization.get(ws) === entry) {
        this.socketAuthorization.delete(ws);
      }
    });
    return entry.inFlight;
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    if (this.closedSockets.has(ws)) return;
    this.closedSockets.add(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    this.socketAuthorization.delete(ws);
    this.clients.delete(ws);
    this.protocolSessions.delete(ws);
  }

  /**
   * Alarm stage: re-check every socket. Runs only on the room's existing 60 s
   * alarm tick and never schedules a wake of its own, so an idle revoked
   * socket closes on the next tick while the room is alarming, else on its
   * next frame or reconnect. Sockets still inside their
   * SOCKET_AUTHORIZATION_TTL_MS window cost no D1; lapsed ones share one check
   * per identity.
   */
  private async recheckIdleSockets(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    await Promise.all(sockets.map((ws) => this.authorizeSocket(ws)));
  }

  /** Serialize sends so asynchronous D1 checks cannot reorder protocol frames. */
  private revalidateShared(
    auth: AuthResult,
    onValidUntil: (validUntil: number) => void,
  ): Promise<boolean> {
    const key = JSON.stringify(auth);
    const now = Date.now();
    let hit = this.sharedAuthorization.get(key);
    if (!hit || now >= hit.validUntil) {
      if (this.sharedAuthorization.size > 1024) {
        for (const [k, v] of this.sharedAuthorization)
          if (now >= v.validUntil) this.sharedAuthorization.delete(k);
      }
      const created = {
        validUntil: now + SOCKET_AUTHORIZATION_TTL_MS,
        result: revalidateProjectConnection(this.env, auth),
      };
      // A failed check is not cached: the next socket retries it.
      created.result.catch(() => {
        if (this.sharedAuthorization.get(key) === created)
          this.sharedAuthorization.delete(key);
      });
      this.sharedAuthorization.set(key, created);
      hit = created;
    }
    onValidUntil(hit.validUntil);
    return hit.result;
  }

  private sendAuthorized(ws: WebSocket, data: string | Uint8Array): void {
    const pending = (this.outbound.get(ws) ?? Promise.resolve())
      .then(async () => {
        const authorization = this.authorizeSocket(ws);
        if (
          (authorization === true ||
            (authorization !== false && (await authorization))) &&
          // A socket can close while authorization or earlier sends were in
          // flight. That is a normal disconnect, not a delivery error.
          !(ws.readyState >= 2) // 2 CLOSING, 3 CLOSED
        )
          ws.send(data);
      })
      .catch((error) => {
        log.error("Authorized delivery failed:", error);
      });
    this.outbound.set(ws, pending);
    this.ctx.waitUntil(
      pending.finally(() => {
        if (this.outbound.get(ws) === pending) this.outbound.delete(ws);
      }),
    );
  }

  private isProtocolClient(ws: WebSocket): boolean {
    return this.clientInfoFor(ws)?.syncProtocol === "loro-v1";
  }

  private createProtocolSession(
    ws: WebSocket,
    assumeJoined: boolean,
  ): LoroProtocolServerSession {
    return new LoroProtocolServerSession({
      roomId: this.projectId,
      doc: () => this.doc,
      assumeJoined,
      maxUpdateBytes: PROJECT_ROOM_MAX_UPDATE_BYTES,
      send: (frame) => this.sendAuthorized(ws, frame),
      commit: async (batchId, updates) => {
        for (const [index, update] of updates.entries()) {
          await this.enqueueLoroImport({
            sender: ws,
            data: update,
            eventId: `protocol:${batchId}:${index}`,
            broadcast: false,
            runRealtimeEffects: true,
          });
        }
      },
      broadcast: (batchId, updates) => {
        this.broadcastCommittedBatch(batchId, updates, ws);
      },
    });
  }

  private broadcastCommittedBatch(
    batchId: `0x${string}`,
    updates: Uint8Array[],
    sender?: WebSocket,
  ): void {
    // Encode once per batch, not once per recipient.
    let frames: Uint8Array[] | undefined;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === sender) continue;
      try {
        if (this.isProtocolClient(ws)) {
          frames ??= encodeLoroProtocolUpdateFrames(
            this.projectId,
            batchId,
            updates,
          );
          for (const frame of frames) {
            this.sendAuthorized(ws, frame);
          }
        } else {
          for (const update of updates) this.sendAuthorized(ws, update);
        }
      } catch (error) {
        log.error("Failed to broadcast committed replica event:", error);
      }
    }
  }

  // ─── Presence & Activity Broadcasts ─────────────────────────

  /**
   * Rebuild this.clients from live WebSockets after hibernation wake-up.
   * Uses serializeAttachment/deserializeAttachment to recover ClientInfo.
   */
  private rebuildClientsFromWebSockets(): void {
    const liveWs = this.ctx.getWebSockets();
    const knownWs = new Set(this.clients.keys());

    for (const ws of liveWs) {
      if (!knownWs.has(ws)) {
        const attachment =
          ws.deserializeAttachment() as ProjectClientInfo | null;
        if (attachment) {
          this.clients.set(ws, attachment);
        }
      }
    }

    // Remove entries whose WebSocket is no longer in the live set
    const liveSet = new Set(liveWs);
    for (const ws of this.clients.keys()) {
      if (!liveSet.has(ws)) {
        this.socketAuthorization.delete(ws);
        this.clients.delete(ws);
      }
    }
  }

  /**
   * Broadcast current presence to all connected clients. Every socket gets
   * the full list plus its own client id: the same user's other devices and
   * windows are peers, so a client can only hide itself by connection.
   */
  private broadcastPresence(): void {
    // Sync clients map with actual live WebSockets to avoid stale entries
    this.rebuildClientsFromWebSockets();

    const clients = Array.from(this.clients.values()).map((c) => ({
      id: c.id,
      clientType: c.clientType,
      // Sockets admitted before `kind` existed recover it from their proof.
      kind: c.kind ?? connectionKind(c),
      userId: c.userId,
      name: c.name,
      avatar: c.avatar,
      device: c.device,
    }));

    log.debug(`Presence: ${clients.length} clients`);

    // Serialize the shared list once; only selfClientId differs per socket.
    // Same JSON as JSON.stringify({ type, clients, selfClientId? }).
    const head = `{"type":"presence","clients":${JSON.stringify(clients)}`;
    for (const ws of this.ctx.getWebSockets()) {
      const selfClientId = this.clients.get(ws)?.id;
      const msg = selfClientId
        ? `${head},"selfClientId":${JSON.stringify(selfClientId)}}`
        : `${head}}`;
      try {
        this.sendAuthorized(ws, msg);
      } catch {
        // Connection may have closed
      }
    }
  }

  /**
   * Broadcast an activity event to all clients except the actor.
   * Throttled: max 1 message per node per 500ms.
   */
  private broadcastActivity(
    sender: WebSocket,
    action: ActivityAction,
    nodeId: string,
    nodeType: string,
    label: string,
    canvasId: string,
  ): void {
    const now = Date.now();
    const throttleKey = `${nodeId}:${action}`;
    const last = this.activityThrottle.get(throttleKey) ?? 0;
    if (now - last < 500) return;
    this.activityThrottle.set(throttleKey, now);

    const client = this.clients.get(sender);
    const msg: ActivityMessage = {
      type: "activity",
      actor: {
        clientType: client?.clientType ?? "browser",
        name: client?.name ?? "Unknown",
      },
      action,
      nodeId,
      nodeType,
      label,
      canvasId,
      timestamp: now,
    };

    const json = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === sender) continue;
      try {
        this.sendAuthorized(ws, json);
      } catch {
        // Connection may have closed
      }
    }
  }

  /**
   * Coalesce outbound awareness broadcasts to ~12Hz. Internal state is kept
   * always-fresh — only the *broadcast* is throttled. If an update arrives
   * inside the cool-down window, we schedule one trailing-edge flush so the
   * last position before the user stopped moving still reaches peers.
   */
  private scheduleAwarenessBroadcast(): void {
    const now = Date.now();
    const sinceLast = now - this.lastAwarenessBroadcastAt;
    if (sinceLast >= AWARENESS_BROADCAST_MIN_INTERVAL_MS) {
      this.flushAwarenessBroadcast();
      return;
    }
    // Already-scheduled trailing flush will pick this up.
    if (this.awarenessFlushTimer) return;
    const delay = AWARENESS_BROADCAST_MIN_INTERVAL_MS - sinceLast;
    this.awarenessFlushTimer = setTimeout(() => {
      this.awarenessFlushTimer = null;
      this.flushAwarenessBroadcast();
    }, delay);
  }

  /**
   * Fan the current awareness map out to all clients except the sender of
   * each frame. We send PER-RECIPIENT payloads so each WS sees everyone
   * else (a peer never sees themselves) — same shape Liveblocks/yjs use.
   *
   * Stale entries (no update in AWARENESS_STALE_MS) are pruned defensively
   * here too — webSocketClose normally removes entries, but a half-open
   * socket might miss the close event.
   */
  private flushAwarenessBroadcast(): void {
    this.lastAwarenessBroadcastAt = Date.now();

    // Rebuild clients map first — hibernation can drop in-memory state.
    this.rebuildClientsFromWebSockets();

    const now = Date.now();
    // Prune stale entries from the in-memory map.
    for (const [ws, entry] of this.awareness.entries()) {
      if (now - entry.updatedAt > AWARENESS_STALE_MS) {
        this.awareness.delete(ws);
      }
    }

    // Build the canonical peer list once; recipients filter themselves out.
    const peersByWs = new Map<WebSocket, AwarenessPeer>();
    for (const [ws, entry] of this.awareness.entries()) {
      const info = this.clients.get(ws);
      if (!info) continue;
      // Any connection that reports a cursor or selection is a peer: an
      // agent acting for a user is drawn next to that user's own windows.
      const peer: AwarenessPeer = {
        clientId: info.id,
        userId: info.userId,
        userName: info.name,
        userAvatar: info.avatar,
        kind: info.kind ?? connectionKind(info),
        selectedNodeIds: entry.selectedNodeIds,
      };
      if (entry.cursor) peer.cursor = entry.cursor;
      peersByWs.set(ws, peer);
    }

    for (const ws of this.ctx.getWebSockets()) {
      const recipientInfo = this.clients.get(ws);
      if (!recipientInfo || recipientInfo.clientType !== "browser") continue;
      // Only canvases render awareness, so only browser clients receive it.
      // Exclude self by WebSocket identity, not by userId — same user with
      // two tabs open should see their own other-tab cursor.
      const users: AwarenessPeer[] = [];
      for (const [peerWs, peer] of peersByWs.entries()) {
        if (peerWs === ws) continue;
        users.push(peer);
      }
      const msg: AwarenessBroadcastMessage = {
        type: "awareness.broadcast",
        users,
      };
      try {
        this.sendAuthorized(ws, JSON.stringify(msg));
      } catch {
        // Connection may have closed
      }
    }
  }

  // ─── Hibernation WebSocket Handlers ──────────────────────────

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (!(await this.authorizeSocket(ws))) return;
    // After hibernation, in-memory state is lost — re-initialize if needed
    if (!this.projectId) {
      const storedId = await this.ctx.storage.get<string>("projectId");
      if (storedId && !this.initPromise) {
        this.initPromise = this.initRoom(storedId);
      }
      if (this.initPromise) await this.initPromise;
    }

    // Handle binary messages (Loro CRDT updates)
    if (message instanceof ArrayBuffer) {
      const updates = new Uint8Array(message);
      if (this.isProtocolClient(ws)) {
        const session =
          this.protocolSessions.get(ws) ?? this.createProtocolSession(ws, true);
        this.protocolSessions.set(ws, session);
        await session.receive(updates);
        return;
      }
      if (updates.byteLength > PROJECT_ROOM_MAX_UPDATE_BYTES) {
        // Legacy raw clients have no ack channel: 1009 = message too big.
        log.warn(
          `[room proj=${this.projectId.slice(-6)}] rejected ${updates.byteLength} B update (cap ${PROJECT_ROOM_MAX_UPDATE_BYTES})`,
        );
        ws.close(1009, "Update exceeds project room size limit");
        return;
      }
      void this.enqueueLoroImport({
        sender: ws,
        data: updates,
        runRealtimeEffects: true,
      }).catch((err) => {
        log.error("processMessageQueue rejected:", err);
      });
      return;
    }

    // Handle collaboration sideband messages.
    if (typeof message === "string") {
      if (message === "ping") {
        this.sendAuthorized(ws, "pong");
        return;
      }
      if (message === "pong") return;
      try {
        const parsed = JSON.parse(message);
        await this.handleTextMessage(ws, parsed);
      } catch (error) {
        // Not valid JSON or handler error — ignore
        log.error("Failed to handle text message:", error);
      }
    }
  }

  /** Handle JSON collaboration sideband messages from clients. */
  private async handleTextMessage(
    sender: WebSocket,
    msg: Record<string, any>,
  ): Promise<void> {
    if (this.initPromise) await this.initPromise;

    if (msg.type === "awareness.update") {
      // Ephemeral cursor + selection sideband. Never enters the Loro doc.
      // Per-WS state is always kept fresh on receive; broadcast end is
      // coalesced (see scheduleAwarenessBroadcast) to keep outbound load
      // bounded regardless of how many clients are moving their mouse.
      const incomingCursor = msg.cursor;
      const cursor =
        incomingCursor &&
        typeof incomingCursor === "object" &&
        typeof incomingCursor.x === "number" &&
        typeof incomingCursor.y === "number"
          ? { x: incomingCursor.x, y: incomingCursor.y }
          : undefined;

      const selectedNodeIds = Array.isArray(msg.selectedNodeIds)
        ? msg.selectedNodeIds.filter(
            (id: unknown): id is string => typeof id === "string",
          )
        : [];

      this.awareness.set(sender, {
        cursor,
        selectedNodeIds,
        updatedAt: Date.now(),
      });
      this.scheduleAwarenessBroadcast();
      return;
    }

    if (
      msg.type === "register_custom_actions" ||
      msg.type === "unregister_custom_actions" ||
      msg.type === "complete_custom_task"
    ) {
      try {
        this.sendAuthorized(
          sender,
          JSON.stringify({
            type: `${msg.type}.rejected`,
            code: "LEGACY_CUSTOM_ACTION_PROTOCOL_RETIRED",
            error:
              "Legacy ClashAgent custom-action transport is retired; use a clash.plugin/v1 executable plugin through local-api.",
            ...(typeof msg.taskId === "string" ? { taskId: msg.taskId } : {}),
            ...(typeof msg.nodeId === "string" ? { nodeId: msg.nodeId } : {}),
          }),
        );
      } catch {
        // The peer may have closed between receive and rejection.
      }
      return;
    }

    if (msg.type === "write_understanding") {
      // Local agent writing understanding results to a node.
      // Each key in `understanding` is overwritten independently (no merge).
      const { nodeId, understanding } = msg;
      if (!nodeId || !understanding || typeof understanding !== "object")
        return;

      const nodesMap = this.doc.getMap("nodes");
      const existingNode = nodesMap.get(nodeId) as
        Record<string, any> | undefined;
      if (!existingNode) return;

      const existingData = existingNode.data || {};
      const existingUnderstanding = existingData.understanding || {};

      // Key-level overwrite: new keys replace old keys, unmentioned keys are preserved
      const merged = { ...existingUnderstanding };
      for (const [key, value] of Object.entries(understanding)) {
        merged[key] = value;
      }

      const versionBefore = this.doc.version();
      nodesMap.set(nodeId, {
        ...existingNode,
        data: { ...existingData, understanding: merged },
      });
      const update = this.doc.export({ mode: "update", from: versionBefore });
      this.broadcastBinary(update);

      log.info("Understanding written", {
        nodeId,
        keys: Object.keys(understanding),
      });
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    // Wrap top-level: previously a sync throw here surfaced as
    // outcome=exception with empty exceptions[] in wrangler tail (CF runtime
    // swallows the details), so we couldn't tell what was failing. Catch +
    // log so the next occurrence names the failing line.
    try {
      // A check still in flight must not authorize a frame for this socket.
      this.closedSockets.add(ws);
      this.socketAuthorization.delete(ws);
      this.clients.delete(ws);
      this.awareness.delete(ws);
      this.protocolSessions.get(ws)?.destroy();
      this.protocolSessions.delete(ws);
    } catch (e) {
      log.error(
        `[room proj=${this.projectId.slice(-6)}] webSocketClose: clients.delete threw:`,
        e,
      );
    }
    try {
      this.broadcastPresence();
    } catch (e) {
      log.error(
        `[room proj=${this.projectId.slice(-6)}] webSocketClose: broadcastPresence threw:`,
        e,
      );
    }
    try {
      // Fan out one extra awareness frame so peers see the cursor disappear
      // immediately rather than waiting for the 45-second staleness sweep.
      this.flushAwarenessBroadcast();
    } catch (e) {
      log.error(
        `[room proj=${this.projectId.slice(-6)}] webSocketClose: awareness flush threw:`,
        e,
      );
    }
    try {
      ws.close(code, reason);
    } catch {
      // Already closed
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    log.error("WebSocket error:", error);
    try {
      // A check still in flight must not authorize a frame for this socket.
      this.closedSockets.add(ws);
      this.socketAuthorization.delete(ws);
      this.clients.delete(ws);
      this.awareness.delete(ws);
      this.protocolSessions.get(ws)?.destroy();
      this.protocolSessions.delete(ws);
    } catch (e) {
      log.error(
        `[room proj=${this.projectId.slice(-6)}] webSocketError: clients.delete threw:`,
        e,
      );
    }
    try {
      this.broadcastPresence();
    } catch (e) {
      log.error(
        `[room proj=${this.projectId.slice(-6)}] webSocketError: broadcastPresence threw:`,
        e,
      );
    }
    try {
      this.flushAwarenessBroadcast();
    } catch (e) {
      log.error(
        `[room proj=${this.projectId.slice(-6)}] webSocketError: awareness flush threw:`,
        e,
      );
    }
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      // Already closed
    }
  }

  // ─── Message Queue Processing ────────────────────────────────

  private enqueueLoroImport(
    entry: Omit<LoroImportQueueItem, "resolve" | "reject">,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.messageQueue.push({ ...entry, resolve, reject });
      if (!this.isProcessingQueue) {
        this.processMessageQueue().catch((err) => {
          log.error("processMessageQueue rejected:", err);
          this.isProcessingQueue = false;
        });
      }
    });
  }

  /**
   * Process Loro update queue serially.
   * CRITICAL: doc.import() must be serialized to prevent state corruption.
   */
  private async processMessageQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    try {
      while (this.messageQueue.length > 0) {
        const msg = this.messageQueue.shift();
        if (!msg) continue;

        if (this.initPromise) await this.initPromise;

        try {
          if (msg.applyGeneration) {
            await msg.applyGeneration();
            msg.resolve?.();
            continue;
          }
          if (msg.sender && !(await this.authorizeSocket(msg.sender))) {
            throw new Error("Project authorization revoked before commit");
          }
          const nodesMap = this.doc.getMap("nodes");
          const shouldRunRealtimeEffects =
            msg.runRealtimeEffects && !!msg.sender;
          let nodesBefore: Map<string, Record<string, any>> | null = null;

          if (shouldRunRealtimeEffects) {
            // Snapshot node keys before import for activity diff
            nodesBefore = new Map<string, Record<string, any>>();
            for (const [id, raw] of nodesMap.entries()) {
              nodesBefore.set(id, raw as Record<string, any>);
            }
          }

          this.unsubscribeLocalUpdates?.();
          this.unsubscribeLocalUpdates = null;
          let repairUpdate: Uint8Array | null = null;
          try {
            // ReplicaEngine validates on a fork, durably appends, and only then
            // applies to the live Loro document.
            await this.persistAndMaybeCompact(msg.data, msg.eventId);
            const repairVersion = this.doc.version();
            const graphRepair = reconcileCanvasGraph(this.doc);
            const timelineRepair = reconcileProjectTimelineOwnership(this.doc);
            const directorRepair = reconcileProjectDirectorStageOwnership(
              this.doc,
            );
            const workspaceRepaired =
              canvasGraphReconciliationChanged(graphRepair) ||
              timelineRepair.removedActionNodeIds.length > 0 ||
              timelineRepair.detachedTimelineIds.length > 0 ||
              directorRepair.removedActionNodeIds.length > 0 ||
              directorRepair.detachedStageIds.length > 0;
            if (workspaceRepaired) {
              this.doc.commit({ origin: "sys:workspace-reconcile" });
              repairUpdate = this.doc.export({
                mode: "update",
                from: repairVersion,
              });
            }
            // Broadcast to all other clients FIRST so they have the base state
            // before receiving any derived updates from processPendingNodes.
            if (msg.broadcast !== false) {
              this.broadcastBinary(msg.data, msg.sender);
            }
            if (repairUpdate?.byteLength) {
              await this.persistAndMaybeCompact(repairUpdate);
              this.broadcastBinary(repairUpdate);
            }
          } finally {
            this.installLocalUpdatePersistence();
          }

          if (!shouldRunRealtimeEffects || !msg.sender || !nodesBefore) {
            msg.resolve?.();
            continue;
          }

          // Detect activity: diff nodes before/after
          const nodesAfter = nodesMap.entries();
          const seenIds = new Set<string>();
          for (const [id, raw] of nodesAfter) {
            seenIds.add(id);
            const after = raw as Record<string, any>;
            const before = nodesBefore.get(id);
            if (!before) {
              // New node added
              const label =
                (after.data?.label as string) ??
                (after.data?.name as string) ??
                "";
              this.broadcastActivity(
                msg.sender,
                "added",
                id,
                after.type ?? "text",
                label,
                typeof after.canvasId === "string"
                  ? after.canvasId
                  : DEFAULT_CANVAS_ID,
              );
            } else if (JSON.stringify(before) !== JSON.stringify(after)) {
              // Node updated
              const label =
                (after.data?.label as string) ??
                (after.data?.name as string) ??
                "";
              this.broadcastActivity(
                msg.sender,
                "updated",
                id,
                after.type ?? "text",
                label,
                typeof after.canvasId === "string"
                  ? after.canvasId
                  : DEFAULT_CANVAS_ID,
              );
            }
          }
          // Check for deleted nodes
          for (const [id, before] of nodesBefore) {
            if (!seenIds.has(id)) {
              const label =
                (before.data?.label as string) ??
                (before.data?.name as string) ??
                "";
              this.broadcastActivity(
                msg.sender,
                "deleted",
                id,
                before.type ?? "text",
                label,
                typeof before.canvasId === "string"
                  ? before.canvasId
                  : DEFAULT_CANVAS_ID,
              );
            }
          }

          // Check for pending nodes (may emit additional broadcasts)
          await this.guardedProcessPendingNodes();
          msg.resolve?.();
        } catch (error) {
          log.error("Failed to process Loro update:", error);
          msg.reject?.(error);
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  // ─── Broadcast ──────────────────────────────────────────────

  /**
   * Broadcast binary Loro update to all connected clients except sender.
   */
  private broadcastBinary(data: Uint8Array, sender?: WebSocket): void {
    this.broadcastCommittedBatch(createLoroProtocolBatchId(), [data], sender);
  }

  // ─── Guarded Node Processing ─────────────────────────────────

  /**
   * Run processPendingNodes with a guard to prevent concurrent execution
   * (alarm + processMessageQueue can race).
   */
  /** Port shared by the Host command and the render publication operation. */
  private hostCommandPort(projectId: string) {
    return {
      projectId,
      doc: () => this.doc,
      readProject: () =>
        createD1ProjectAuthorizationStore(this.env as never).readProject(
          projectId,
        ),
      serialize: <T,>(work: () => Promise<T>) => {
        let result: T;
        return this.enqueueLoroImport({
          data: new Uint8Array(),
          runRealtimeEffects: false,
          applyGeneration: async () => {
            result = await work();
          },
        }).then(() => result!);
      },
      persist: (update: Uint8Array) => this.persistAndMaybeCompact(update),
      broadcast: (update: Uint8Array) => this.broadcastBinary(update),
      env: this.env as never,
    };
  }

  private async guardedProcessPendingNodes(): Promise<void> {
    if (this.isProcessingNodes) return;
    this.isProcessingNodes = true;
    try {
      await processPendingNodes(
        this.doc,
        this.env,
        this.projectId,
        (data: Uint8Array) => this.broadcastBinary(data),
        async () => this.triggerTaskPolling(),
      );
    } finally {
      this.isProcessingNodes = false;
    }
  }

  // ─── Alarm (replaces schedule/cancelSchedule) ────────────────

  async alarm(): Promise<void> {
    // The alarm is shared: it fires for the 60 s task poll and for requested
    // checkpoints. Idle sockets are re-checked here, on whichever tick runs
    // anyway (#240); authorization never schedules a wake of its own. The
    // recheck needs no room state, so a wake before the task poll is due (e.g.
    // a checkpoint request already served) does not load the doc.
    await this.recheckIdleSockets();
    const checkpointTarget = await this.ctx.storage.get<number>(
      CHECKPOINT_REQUESTED_SEQ_KEY,
    );
    let taskPollDueAt = await this.ctx.storage.get<number>(TASK_POLL_DUE_KEY);
    const taskPollDue =
      taskPollDueAt === undefined || Date.now() >= taskPollDueAt;

    if (taskPollDue || checkpointTarget != null) {
      // After hibernation, in-memory state is lost — re-initialize if needed.
      if (!this.projectId) {
        const storedId = await this.ctx.storage.get<string>("projectId");
        if (!storedId) return; // No project ever connected, nothing to do
        if (!this.initPromise) {
          this.initPromise = this.initRoom(storedId, {
            enableTaskPolling: false,
          });
        }
        await this.initPromise;
      }

      const tag = `[room proj=${this.projectId.slice(-6)}]`;
      // Compact on every 60 s slot, or sooner when a checkpoint was requested.
      await this.runCompaction(tag);

      // Persistence is event-driven now — every doc commit (local via
      // subscribeLocalUpdates, or imported via processMessageQueue) appends
      // to the update log inside persistAndMaybeCompact. The alarm only
      // runs task polling; it doesn't need to coordinate snapshot saves.
      if (taskPollDue) {
        await this.taskPoll();
        taskPollDueAt = Date.now() + TASK_POLL_INTERVAL_MS;
        await this.ctx.storage.put(TASK_POLL_DUE_KEY, taskPollDueAt);
      }
    }

    // Re-schedule next alarm only if clients are connected.
    if (this.ctx.getWebSockets().length > 0) {
      if (taskPollDueAt !== undefined)
        await this.scheduleAlarmAtEarliest(taskPollDueAt);
    }
  }

  // ─── Task Polling ───────────────────────────────────────────

  private async taskPoll(): Promise<void> {
    if (!this.projectId) return;
    const tag = `[room proj=${this.projectId.slice(-6)}]`;

    try {
      await this.guardedProcessPendingNodes();
    } catch (e) {
      // Don't let a single broken stage take down the whole alarm — log loud
      // so we can see WHICH project is corrupt, then continue to the next stage.
      this.handleTaskPollFailure(tag, "guardedProcessPendingNodes", e);
    }

    try {
      await recoverOrphanedTasks(this.doc, this.env, (data: Uint8Array) =>
        this.broadcastBinary(data),
      );
    } catch (e) {
      this.handleTaskPollFailure(tag, "recoverOrphanedTasks", e);
    }

    try {
      await pollNodeTasks(
        this.doc,
        this.env,
        this.projectId,
        (data: Uint8Array) => this.broadcastBinary(data),
      );
    } catch (e) {
      this.handleTaskPollFailure(tag, "pollNodeTasks", e);
    }
  }

  /**
   * Centralised failure handler for taskPoll stages. The repeating
   * `RangeError: Invalid array buffer length` we saw was unattributed —
   * we couldn't tell which project's doc was corrupt. Now we log the
   * project ID, the offending stage, and (if it looks like doc corruption)
   * a hint that the snapshot is bad.
   */
  private handleTaskPollFailure(
    tag: string,
    stage: string,
    error: unknown,
  ): void {
    const msg = error instanceof Error ? error.message : String(error);
    const isCorruption =
      msg.includes("Invalid array buffer length") ||
      msg.includes("not a snapshot") ||
      msg.includes("UnknownVersion");
    if (isCorruption) {
      log.error(
        `${tag} ${stage} CORRUPT_DOC: ${msg} — snapshot likely poisoned, project will not sync until reset`,
      );
    } else {
      log.error(`${tag} ${stage} failed:`, error);
    }
  }

  private triggerTaskPolling(): void {
    void this.scheduleAlarmAtEarliest(Date.now() + TASK_POLL_URGENT_MS).catch(
      (error) => {
        log.error("Failed to schedule urgent task poll:", error);
      },
    );
  }

  // ─── HTTP Endpoints (replaces onRequest) ─────────────────────

  private extractLoroProjectId(request: Request, url: URL): string {
    const headerProjectId = request.headers.get("x-loro-project-id");
    if (headerProjectId) return headerProjectId;

    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts[0] !== "loro" || pathParts.length < 3) return "";
    const encodedProjectId = pathParts.slice(1, -1).join("/");
    try {
      return decodeURIComponent(encodedProjectId);
    } catch {
      return encodedProjectId;
    }
  }

  private async ensureRoomInitialized(
    projectId: string,
    options: { enableTaskPolling?: boolean } = {},
  ): Promise<Response | null> {
    if (!projectId) return new Response("Missing project ID", { status: 400 });

    if (!this.initPromise) {
      this.initPromise = this.initRoom(projectId, options);
    }
    await this.initPromise;

    if (this.projectId !== projectId) {
      log.error(
        `Project ID mismatch: expected ${this.projectId}, got ${projectId}`,
      );
      return new Response("Project ID mismatch", { status: 400 });
    }

    return null;
  }

  private async handleLoroRemotePersistenceRequest(
    request: Request,
    url: URL,
  ): Promise<Response | null> {
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts[0] !== "loro" || pathParts.length < 3) return null;

    if (request.headers.get("x-internal-loro") !== "true") {
      return new Response("forbidden", { status: 403 });
    }

    const operation = pathParts[pathParts.length - 1];
    const projectId = this.extractLoroProjectId(request, url);
    const initError = operation === "content-published" ||
      (operation === "generation-admission" && this.replica && this.projectId === projectId)
      ? null
      : await this.ensureRoomInitialized(projectId, { enableTaskPolling: false });
    if (initError) return initError;

    // Project Asset reads and commits. The adapter (and the shared Asset
    // module it imports) loads here on first use, never at DO startup.
    if (
      (operation === "assets-list" ||
        operation === "assets-get" ||
        operation === "assets-commit" ||
        operation === "assets-lifecycle") &&
      (request.method === "GET" || request.method === "POST")
    ) {
      const assets = await import("../services/project-asset-room");
      return assets.handleProjectAssetRoomOperation({
        operation: operation.slice("assets-".length) as
          | "list"
          | "get"
          | "commit"
          | "lifecycle",
        request,
        env: this.env,
        projectId,
        doc: this.doc,
        enqueue: (run) =>
          this.enqueueLoroImport({
            data: new Uint8Array(),
            runRealtimeEffects: false,
            applyGeneration: run,
          }),
        persist: (update) => this.persistAndMaybeCompact(update),
        broadcast: (update) => this.broadcastBinary(update),
      });
    }

    if ((operation === "generation-publication" || operation === "generation-admission" || operation === "timeline-render-publication") && request.method === "POST") {
      try {
        const body = await request.json() as GenerationNodePublication & TimelineRenderNodePublication;
        const render = operation === "timeline-render-publication";
        if (!body.taskId || !body.nodeId || !body.actorUserId || (render ? !body.render === !body.failure : !body.updates || typeof body.updates !== "object")) return Response.json({ error: "Invalid generation publication", code: "GENERATION_PUBLICATION_INVALID" }, { status: 400 });
        await assertHostedGenerationAccess(this.env, { projectId, actorUserId: body.actorUserId } as never);
        // NodeProcessor calls admission while processing this room's import queue.
        // Its matching pendingTask is already installed locally; persist it before
        // acknowledging, without waiting on the queue that is awaiting this request.
        const current = this.doc.getMap("nodes").get(body.nodeId) as { data?: { pendingTask?: string; generationRunId?: string } } | undefined;
        if (operation === "generation-admission" && (current?.data?.pendingTask === body.taskId || current?.data?.generationRunId === body.taskId)) {
          await this.persistAndMaybeCompact(this.doc.export({ mode: "update" }));
          return Response.json({ ok: true });
        }
        // Timeline renders and remote plugin outputs publish a Project Asset; the shared Asset module loads on first use.
        const renderPublication = render ? await import("../generation/timeline-render-publication") : null;
        const assets = render || (operation === "generation-publication" && body.projectAsset) ? await import("../services/project-asset-room") : null;
        await this.enqueueLoroImport({ data: new Uint8Array(), runRealtimeEffects: false, applyGeneration: async () => {
          const importAsset = assets ? (fork: LoroDoc, command: Parameters<typeof assets.importProjectAsset>[3]) => assets.importProjectAsset(this.env, projectId, fork, command) : undefined;
          const update = renderPublication && importAsset
            ? await renderPublication.timelineRenderPublicationUpdate(this.doc, projectId, body, importAsset)
            : operation === "generation-admission" ? generationAdmissionUpdate(this.doc, body) : await generationPublicationUpdate(this.doc, body, importAsset ? { projectId, importAsset } : undefined);
          if (update) {
            await this.persistAndMaybeCompact(update);
            this.broadcastBinary(update);
          }
        } });
        return Response.json({ ok: true });
      } catch (error) {
        if (error instanceof GenerationPublicationConflict)
          return Response.json({ error: error.message, code: "GENERATION_PUBLICATION_CONFLICT" }, { status: 409 });
        const message = error instanceof Error && error.message ? error.message : String(error);
        log.error(`${operation} failed:`, error);
        return Response.json({ error: `${operation} failed in the Project room: ${message}`, code: "GENERATION_PUBLICATION_FAILED" }, { status: 503 });
      }
    }

    // Browser render adapter publication: the bytes were uploaded through the
    // Project Asset import sessions, and this records the render node the same
    // way the container pipeline's TaskPolling does. Adapter-only route.
    if (operation === "timeline-render-complete" && request.method === "POST") {
      try {
        const { runProjectRoomTimelineRenderCompletion } = await import(
          "./project-room-host-command"
        );
        const input = await request.json().catch(() => null);
        const { status, body } = await runProjectRoomTimelineRenderCompletion(
          this.hostCommandPort(projectId),
          input,
        );
        return Response.json(body, { status });
      } catch (error) {
        log.error("timeline-render-complete error:", error);
        return Response.json(
          { code: "TIMELINE_RENDER_FAILED", error: "Render publication failed" },
          { status: 503 },
        );
      }
    }

    // Issue #180: Timeline Host commands (same contract as local-api/api-node).
    // The adapter loads on first use so Timeline code stays out of startup.
    if (operation === "host-command" && request.method === "POST") {
      try {
        const { runProjectRoomHostCommand } = await import(
          "./project-room-host-command"
        );
        const input = await request.json().catch(() => null);
        const roomCommandPort = this.hostCommandPort(projectId);
        const { status, body } = await runProjectRoomHostCommand(
          roomCommandPort,
          input,
        );
        // A submitted render is a pending node. The room normally runs
        // processPendingNodes after a queued CRDT import, but host commands
        // take the direct applyGeneration path; hand the node to the existing
        // RENDER_CONTAINER pipeline here.
        if (
          status === 200 &&
          body &&
          typeof body === "object" &&
          (body as { submitted?: unknown }).submitted === true
        )
          await this.guardedProcessPendingNodes();
        return Response.json(body, { status });
      } catch (error) {
        log.error("host-command error:", error);
        return Response.json(
          { code: "HOST_COMMAND_FAILED", error: "Project command failed" },
          { status: 503 },
        );
      }
    }

    // Issue #130: upload-service index-miss fallback. Computes references in
    // the room (no snapshot leaves the DO) and refreshes the D1 index.
    if (operation === "content-refs" && request.method === "GET") {
      try {
        return Response.json(await this.contentIndex().refresh(), {
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        log.error("content-refs error:", error);
        return Response.json(
          { error: "Project content references unavailable" },
          { status: 503 },
        );
      }
    }

    // Issue #130: small completion notice from the stateless upload service.
    // Recorded only; peers learn about bodies from the CRDT revision itself.
    if (operation === "content-published" && request.method === "POST") {
      const event = (await request.json().catch(() => null)) as {
        digest?: string;
        byteLength?: number;
        kind?: string;
      } | null;
      log.info(
        `[room proj=${projectId.slice(-6)}] content.published ${event?.kind ?? "?"} ${event?.digest?.slice(0, 19) ?? "?"} ${event?.byteLength ?? "?"}B`,
      );
      return new Response(null, { status: 204 });
    }

    if (operation === "snapshot" && request.method === "GET") {
      try {
        const snapshot = this.doc.export({ mode: "snapshot" });
        return new Response(snapshot, {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
          },
        });
      } catch (error) {
        log.error("Remote Loro snapshot error:", error);
        return Response.json(
          { error: "Failed to export snapshot" },
          { status: 500 },
        );
      }
    }

    if (operation === "updates" && request.method === "POST") {
      try {
        const update = new Uint8Array(await request.arrayBuffer());
        if (update.byteLength === 0) {
          return new Response("empty update", { status: 400 });
        }
        await this.enqueueLoroImport({
          data: update,
          runRealtimeEffects: false,
        });
        return new Response(null, { status: 204 });
      } catch (error) {
        log.error("Remote Loro update error:", error);
        return Response.json(
          { error: "Failed to import update" },
          { status: 500 },
        );
      }
    }

    return new Response("not found", { status: 404 });
  }

  private async handleHttpRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const loroRemoteResponse = await this.handleLoroRemotePersistenceRequest(
      request,
      url,
    );
    if (loroRemoteResponse) return loroRemoteResponse;

    // Handle /update-node internal request
    if (url.pathname.endsWith("/update-node") && request.method === "POST") {
      try {
        const body = (await request.json()) as {
          nodeId: string;
          updates: Record<string, any>;
          /** Optional log line to append to node.data._log (kept visible in UI). */
          log?: string;
        };

        if (this.initPromise) await this.initPromise;

        updateNodeData(this.doc, body.nodeId, body.updates, (data) =>
          this.broadcastBinary(data),
        );

        if (body.log) {
          appendNodeLog(this.doc, body.nodeId, body.log, (data) =>
            this.broadcastBinary(data),
          );
        }

        await this.guardedProcessPendingNodes();

        return Response.json({ ok: true });
      } catch (error) {
        log.error("Update node error:", error);
        return Response.json({ error: "Update failed" }, { status: 500 });
      }
    }

    // Handle /nodes GET request
    if (url.pathname.endsWith("/nodes") && request.method === "GET") {
      try {
        if (this.initPromise) await this.initPromise;

        const nodesMap = this.doc.getMap("nodes");
        const nodesObj = nodesMap.toJSON() as Record<string, any>;
        const nodesArray = Object.values(nodesObj);

        return Response.json(nodesArray);
      } catch (error) {
        log.error("Get nodes error:", error);
        return Response.json({ error: "Failed to get nodes" }, { status: 500 });
      }
    }

    // Debug endpoint: full Loro snapshot (nodes + edges + projectMeta).
    // Curl it to see exactly what the source of truth has — way faster than
    // hunting down race conditions through frontend console.log.
    if (url.pathname.endsWith("/loro-dump") && request.method === "GET") {
      try {
        if (this.initPromise) await this.initPromise;

        const nodes = this.doc.getMap("nodes").toJSON() as Record<string, any>;
        const edges = Object.fromEntries(
          listNodeOwnedEdges(this.doc).map(({ id, ...edge }) => [id, edge]),
        );
        const projectMeta = (() => {
          try {
            return this.doc.getMap("projectMeta").toJSON();
          } catch {
            return null;
          }
        })();

        return Response.json(
          {
            nodes,
            edges,
            projectMeta,
            counts: {
              nodes: Object.keys(nodes).length,
              edges: Object.keys(edges).length,
            },
          },
          {
            headers: { "cache-control": "no-store" },
          },
        );
      } catch (error) {
        log.error("Loro dump error:", error);
        return Response.json(
          { error: "Failed to dump loro state", detail: String(error) },
          { status: 500 },
        );
      }
    }

    // Admin recovery endpoint: nuke this room's persisted snapshot + in-memory
    // doc so a corrupt CRDT state stops poisoning every subsequent alarm.
    // Requires the same internal-agent header used for cross-DO calls so it
    // can't be triggered from the public internet. The next browser connect
    // will rebuild from whatever D1 has (or start empty).
    if (url.pathname.endsWith("/reset-doc") && request.method === "POST") {
      const isInternal = request.headers.get("x-internal-agent") === "true";
      if (!isInternal) return new Response("forbidden", { status: 403 });
      try {
        log.warn(
          `[room proj=${this.projectId.slice(-6)}] /reset-doc invoked — wiping snapshot + update log + closing live WS`,
        );
        await wipeDocState(this.ctx.storage);
        // Drop in-memory doc + reset seq counters so any subsequent
        // connection initialises fresh from an empty store.
        if (this.unsubscribeLocalUpdates) {
          this.unsubscribeLocalUpdates();
          this.unsubscribeLocalUpdates = null;
        }
        this.doc = new LoroDoc();
        this.nextSeq = 0;
        this.updatesSinceCompact = 0;
        // Close all live WS so clients reconnect cleanly against the new doc.
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.close(1012, "doc reset");
          } catch {
            /* already closing */
          }
        }
        return Response.json({ ok: true, projectId: this.projectId });
      } catch (error) {
        log.error("Reset error:", error);
        return Response.json(
          { error: "Reset failed", detail: String(error) },
          { status: 500 },
        );
      }
    }

    return new Response("ProjectRoom", { status: 200 });
  }
}
