import { GenerationPublicationConflict, assertHostedGenerationAccess, generationAdmissionUpdate, generationPublicationUpdate, type GenerationNodePublication } from "../generation/publication";
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
import { authenticateRequest } from "../loro/auth";
import type {
  ClientInfo,
  ClientType,
  PresenceMessage,
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

/** Alarm intervals in milliseconds */
const TASK_POLL_INTERVAL_MS = 60_000; // 60 seconds
const TASK_POLL_URGENT_MS = 2_000; // 2 seconds (after new task submission)
/** Compact the update log into a fresh shallow snapshot every N appended updates. */
const UPDATES_PER_COMPACT = 100;
/** Hard cap — if compaction is somehow stuck, force one to keep load fast. */
const UPDATES_HARD_COMPACT_THRESHOLD = 500;

/** Awareness throttling. Cap outbound broadcasts at ~12Hz; stale entries pruned after 8s. */
const AWARENESS_BROADCAST_MIN_INTERVAL_MS = 80;
const AWARENESS_STALE_MS = 8_000;

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
};

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

    // Skip auth for internal agent connections
    const isInternal = request.headers.get("x-internal-agent") === "true";
    let clientType: ClientType = "browser";
    let userId = "unknown";
    let userName = "User";
    let userAvatar: string | undefined;
    if (!isInternal) {
      try {
        const authResult = await authenticateRequest(
          request,
          this.env,
          projectId,
        );
        userId = authResult.userId;
        userName = authResult.userName ?? "User";
        userAvatar = authResult.userAvatar;

        // Detect client type from header
        const clientTypeHeader = request.headers.get("x-client-type");
        if (clientTypeHeader === "cli") {
          clientType = "cli";
          userName = authResult.userName ?? "CLI Agent";
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

    // Create WebSocket pair and accept via Hibernation API
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    // Register client for presence — persist via serializeAttachment so it survives hibernation
    const clientInfo: ProjectClientInfo = {
      id: crypto.randomUUID(),
      userId,
      clientType,
      name: userName,
      avatar: userAvatar,
      connectedAt: Date.now(),
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
        server.send(snapshot);
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
      if (result.appended) this.updatesSinceCompact++;
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
      send: (frame) => ws.send(frame),
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
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === sender) continue;
      try {
        if (this.isProtocolClient(ws)) {
          for (const frame of encodeLoroProtocolUpdateFrames(
            this.projectId,
            batchId,
            updates,
          )) {
            ws.send(frame);
          }
        } else {
          for (const update of updates) ws.send(update);
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
        this.clients.delete(ws);
      }
    }
  }

  /**
   * Broadcast current presence to all connected clients.
   */
  private broadcastPresence(): void {
    // Sync clients map with actual live WebSockets to avoid stale entries
    this.rebuildClientsFromWebSockets();

    const clients = Array.from(this.clients.values()).map((c) => ({
      id: c.id,
      clientType: c.clientType,
      userId: c.userId,
      name: c.name,
      avatar: c.avatar,
    }));

    log.debug(`Presence: ${clients.length} clients`);

    const msg: PresenceMessage = { type: "presence", clients };
    this.broadcastText(JSON.stringify(msg));
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
        ws.send(json);
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
      // Skip non-browser clients — CLI/agent connections shouldn't appear
      // as live cursors on the canvas.
      if (info.clientType !== "browser") continue;
      const peer: AwarenessPeer = {
        userId: info.userId,
        userName: info.name,
        userAvatar: info.avatar,
        selectedNodeIds: entry.selectedNodeIds,
      };
      if (entry.cursor) peer.cursor = entry.cursor;
      peersByWs.set(ws, peer);
    }

    for (const ws of this.ctx.getWebSockets()) {
      const recipientInfo = this.clients.get(ws);
      if (!recipientInfo || recipientInfo.clientType !== "browser") continue;
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
        ws.send(JSON.stringify(msg));
      } catch {
        // Connection may have closed
      }
    }
  }

  /**
   * Broadcast a JSON text message to all connected clients.
   */
  private broadcastText(text: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
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
        ws.send("pong");
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
        sender.send(
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
      // immediately rather than waiting for the 8-second staleness sweep.
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
    const checkpointTarget = await this.ctx.storage.get<number>(
      CHECKPOINT_REQUESTED_SEQ_KEY,
    );
    if (checkpointTarget !== null) {
      await this.runCompaction(tag);
    }

    // Persistence is event-driven now — every doc commit (local via
    // subscribeLocalUpdates, or imported via processMessageQueue) appends
    // to the update log inside persistAndMaybeCompact. The alarm only
    // runs task polling; it doesn't need to coordinate snapshot saves.
    await this.taskPoll();

    // Re-schedule next alarm only if clients are connected.
    if (this.ctx.getWebSockets().length > 0) {
      await this.scheduleAlarmAtEarliest(Date.now() + TASK_POLL_INTERVAL_MS);
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
    const initError = operation === "generation-admission" && this.replica && this.projectId === projectId
      ? null
      : await this.ensureRoomInitialized(projectId, { enableTaskPolling: false });
    if (initError) return initError;

    if ((operation === "generation-publication" || operation === "generation-admission") && request.method === "POST") {
      try {
        const body = await request.json() as GenerationNodePublication;
        if (!body.taskId || !body.nodeId || !body.actorUserId || !body.updates || typeof body.updates !== "object") return Response.json({ error: "Invalid generation publication" }, { status: 400 });
        await assertHostedGenerationAccess(this.env, { projectId, actorUserId: body.actorUserId } as never);
        // NodeProcessor calls admission while processing this room's import queue.
        // Its matching pendingTask is already installed locally; persist it before
        // acknowledging, without waiting on the queue that is awaiting this request.
        const current = this.doc.getMap("nodes").get(body.nodeId) as { data?: { pendingTask?: string; generationRunId?: string } } | undefined;
        if (operation === "generation-admission" && (current?.data?.pendingTask === body.taskId || current?.data?.generationRunId === body.taskId)) {
          await this.persistAndMaybeCompact(this.doc.export({ mode: "update" }));
          return Response.json({ ok: true });
        }
        await this.enqueueLoroImport({ data: new Uint8Array(), runRealtimeEffects: false, applyGeneration: async () => {
          const update = operation === "generation-admission" ? generationAdmissionUpdate(this.doc, body) : generationPublicationUpdate(this.doc, body);
          if (update) {
            await this.persistAndMaybeCompact(update);
            this.broadcastBinary(update);
          }
        } });
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: error instanceof GenerationPublicationConflict ? error.message : "Generation publication failed" }, { status: error instanceof GenerationPublicationConflict ? 409 : 503 });
      }
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
