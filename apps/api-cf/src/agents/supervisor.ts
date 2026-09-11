/**
 * SupervisorAgent — independent AI agent Durable Object.
 *
 * Each instance is a separate Loro replica + LLM conversation context.
 * Multiple SupervisorAgents can operate on the same project concurrently,
 * sharing the canvas through ProjectRoom (Loro sequencer).
 *
 * Architecture:
 *   Browser ──WS──► SupervisorAgent ──WS──► ProjectRoom
 *   (chat)          (Loro replica + LLM)    (Loro sequencer)
 *
 * The browser also connects directly to ProjectRoom for Loro sync.
 * This agent only handles chat + canvas tool operations.
 */

import { AIChatAgent } from "@cloudflare/ai-chat";
import type { Connection, WSMessage } from "agents";
import { LoroDoc } from "loro-crdt";

import type { Env } from "../config";
import { log } from "../logger";
import { createModel } from "../providers";
import { createCanvasTools } from "./tools/canvas";
import { createTimelineTools } from "./tools/timeline";
import { createDelegationTool } from "./tools/delegation";
import { createWorkflowTools } from "./tools/workflow";
import { SUPERVISOR_PROMPT } from "../prompts/supervisor";
import { withCacheControl, cachedSystemPrompt } from "./cache-control";
import {
  authenticateRequest,
  revalidateProjectConnection,
  type AuthResult,
} from "../loro/auth";

export class SupervisorAgent extends AIChatAgent<Env> {
  private deliveryQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // AIChatAgent and Agent wrap these hooks in their constructors. Guard the
    // complete installed handlers, before protocol history/state/RPC effects.
    const connect = this.onConnect.bind(this);
    this.onConnect = async (connection, context) => {
      const projectId = this.extractProjectId(context.request);
      try {
        const authorization = await authenticateRequest(
          context.request,
          this.env,
          projectId,
        );
        connection.setState({ projectAuthorization: authorization });
      } catch {
        connection.close(1008, "Unauthorized");
        return;
      }
      await connect(connection, context);
    };
    const message = this.onMessage.bind(this);
    this.onMessage = async (connection, data) => {
      if (await this.authorizeConnection(connection))
        await message(connection, data);
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const room = request.headers.get("x-partykit-room");
    if (
      !room ||
      this.env.SUPERVISOR.idFromName(room).toString() !== this.ctx.id.toString()
    )
      return new Response("Unauthorized", { status: 401 });
    try {
      await authenticateRequest(
        request,
        this.env,
        this.extractProjectId(request),
      );
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
    return super.fetch(request);
  }

  private async authorizeConnection(connection: Connection): Promise<boolean> {
    const authorization = (
      connection.state as { projectAuthorization?: AuthResult } | null
    )?.projectAuthorization;
    if (
      authorization &&
      (await revalidateProjectConnection(this.env, authorization))
    )
      return true;
    connection.close(1008, "Unauthorized");
    return false;
  }

  override broadcast(
    message: string | ArrayBuffer | ArrayBufferView,
    without: string[] = [],
  ): void {
    // The upstream broadcast contract is synchronous. Keep asynchronous
    // authorization ordered and attached to the DO lifetime before each send.
    this.deliveryQueue = this.deliveryQueue
      .then(async () => {
        for (const connection of this.getConnections()) {
          if (without.includes(connection.id)) continue;
          if (await this.authorizeConnection(connection)) {
            try {
              connection.send(message);
            } catch {
              /* Connection already closed. */
            }
          }
        }
      })
      .catch((error) => log.warn("Supervisor delivery failed", error));
    this.ctx.waitUntil(this.deliveryQueue);
  }

  /** Local Loro CRDT replica — synced with ProjectRoom via internal WS. */
  private doc: LoroDoc = new LoroDoc();
  /** Internal WebSocket to ProjectRoom for Loro sync. */
  private roomWs: WebSocket | null = null;
  /** Project ID extracted from the DO name (format: "projectId:threadId"). */
  private projectId = "";
  /** Thread ID extracted from the DO name. */
  private threadId = "";
  /** Whether the initial snapshot has been received from ProjectRoom. */
  private roomInitialized = false;
  /** Promise that resolves once the room connection + snapshot are ready. */
  private roomConnection: Promise<void> | null = null;
  /** Current workspace group ID for scoping agent work. */
  private workspaceGroupId?: string;
  /** Cached model instance + provider type — avoids recreating per message. */
  private _model: ReturnType<typeof createModel> | null = null;
  /** User ID from gateway — populated on connect; included in every log line for grep. */
  private userId = "anon";
  /** Monotonic per-DO chat-turn counter; threads through logs so we can spot the 2nd-message hang. */
  private turnSeq = 0;
  /**
   * Updates that broadcastToRoom couldn't deliver (room WS not OPEN at the
   * time). Drained on next successful reconnect. Without this, supervisor
   * writes that happen during a ProjectRoom outage are lost — symptom we hit
   * was "supervisor created node X, ProjectRoom doesn't have it, workflow
   * writeback warns 'Node not found', wait_for_generation polls forever".
   */
  private pendingBroadcasts: Uint8Array[] = [];
  /** Cap so a stuck WS can't blow up DO memory. ~1000 small updates ≈ a few MB. */
  private static readonly MAX_PENDING_BROADCASTS = 1000;

  // ─── Hang-recovery knobs ──────────────────────────────────
  // Stream silence past this point is almost certainly a wedged upstream LLM.
  // Hard-abort so the client gets a real error instead of "Thinking…" forever.
  private static readonly FIRST_CHUNK_TIMEOUT_MS = 60_000;
  private static readonly TOTAL_TURN_TIMEOUT_MS = 5 * 60_000;

  /** Tag every log line so `wrangler tail` can be filtered per agent / user. */
  private tag(): string {
    return `[sup proj=${this.projectId.slice(-6)} thr=${this.threadId.slice(-6)} usr=${this.userId.slice(-6)}]`;
  }

  /**
   * Re-derive identity from `this.name` (hydrated from storage by the agents
   * runtime even after hibernation) when in-memory state was lost. Without
   * this, a hibernated DO that wakes on an incoming chat message has empty
   * projectId/threadId — and `connectToRoom("")` then routes to a wrong /
   * empty ProjectRoom, breaking every canvas tool. `onConnect` only runs on
   * the original WS upgrade, so we can't rely on it for identity recovery.
   *
   * Also rehydrates workspaceGroupId / userId from ctx.storage. These were
   * previously instance-only fields, which meant after hibernation the
   * sub-agent delegation path lost its workspace scoping and every log
   * line read `usr=anon`.
   */
  private async ensureIdentity(): Promise<void> {
    if (!this.projectId) {
      const name = (this as unknown as { name?: string }).name;
      if (name) {
        const colonIdx = name.indexOf(":");
        if (colonIdx > 0) {
          this.projectId = name.substring(0, colonIdx);
          this.threadId = name.substring(colonIdx + 1);
        } else {
          this.projectId = name;
        }
      }
    }
    if (this.userId === "anon") {
      const u = await this.ctx.storage.get<string>("sup:userId");
      if (u) this.userId = u;
    }
    if (!this.workspaceGroupId) {
      const g = await this.ctx.storage.get<string>("sup:workspaceGroupId");
      if (g) this.workspaceGroupId = g;
    }
  }

  /** Persist a single identity field to ctx.storage so it survives hibernation. */
  private async persistField(key: "sup:userId" | "sup:workspaceGroupId", value: string | undefined): Promise<void> {
    try {
      if (value) await this.ctx.storage.put(key, value);
      else await this.ctx.storage.delete(key);
    } catch (e) {
      log.warn(`${this.tag()} persistField ${key} failed (non-fatal):`, e);
    }
  }

  // ─── Connection Lifecycle ──────────────────────────────────

  async onConnect(connection: Connection, ctx: { request: Request }): Promise<void> {
    // Only extract IDs — don't connect to ProjectRoom until agent actually works
    const projectId = this.extractProjectId(ctx.request);
    if (!projectId) {
      log.error("Missing project ID");
      connection.close(4000, "Missing project ID");
      return;
    }
    this.projectId = projectId;
    const u = ctx.request.headers.get("x-user-id");
    if (u && u !== this.userId) {
      this.userId = u;
      // Fire-and-forget: persist so post-hibernation logs still know which user.
      void this.persistField("sup:userId", u);
    }
    log.info(`${this.tag()} onConnect (clients=${[...this.getConnections()].length + 1})`);
  }

  /**
   * Override the CF runtime's hibernation entry point with our own try/catch.
   *
   * partyserver's webSocketClose does `return this.onClose(...)` without
   * await, so if onClose's promise rejects later, partyserver's outer
   * try/catch can't see it — the rejection escapes and CF reports
   * outcome=exception with empty exceptions[] in tail. The wrapper chain
   * above our onClose body (agents lib's connection.id read, _emit
   * "disconnect", AIChatAgent's pendingResume cleanup) all run before our
   * code. By overriding webSocketClose here we get an awaited boundary
   * around the whole wrapper chain.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    try {
      await super.webSocketClose(ws, code, reason, wasClean);
    } catch (e) {
      log.error(`${this.tag()} webSocketClose chain THREW (was previously invisible as outcome=exception):`, e);
    }
  }

  /**
   * When last browser client disconnects, wait for any in-flight work
   * to finish, then disconnect from ProjectRoom so the DO can hibernate.
   */
  async onClose(_connection: Connection): Promise<void> {
    // CF runtime swallows sync throws here (outcome=exception, exceptions:[]
    // empty in tail). Wrap top-level so the actual stack lands in logs and
    // we stop guessing.
    try {
      const remaining = [...this.getConnections()].length;
      log.info(`${this.tag()} onClose remaining=${remaining}`);

      if (remaining > 0) return;

      log.info(`${this.tag()} waitUntilStable…`);
      const t0 = Date.now();
      await this.waitUntilStable({ timeout: 300_000 }); // 5 min max
      log.info(`${this.tag()} waitUntilStable done in ${Date.now() - t0}ms`);

      if (this.roomWs) {
        log.info(`${this.tag()} disconnecting from ProjectRoom`);
        this.roomWs.close();
        this.roomWs = null;
        this.roomInitialized = false;
        this.roomConnection = null;
      }
    } catch (e) {
      log.error(`${this.tag()} onClose THREW (was previously invisible as outcome=exception):`, e);
    }
  }

  private extractProjectId(request: Request): string {
    const parseRoom = (room: string): string => {
      const colonIdx = room.indexOf(":");
      if (colonIdx > 0) {
        this.threadId = room.substring(colonIdx + 1);
        return room.substring(0, colonIdx);
      }
      return room;
    };

    // Try x-partykit-room header first (set by router): "projectId:threadId"
    const room = request.headers.get("x-partykit-room");
    if (room) return parseRoom(room);

    // Fallback: parse URL path /agents/supervisor/:room
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts[0] === "agents" && pathParts[1] === "supervisor" && pathParts[2]) {
      return parseRoom(pathParts[2]);
    }

    return "";
  }

  // ─── ProjectRoom Connection ────────────────────────────────

  /**
   * Connect to ProjectRoom DO (same worker, shared bindings).
   * Receives the initial snapshot and subscribes to incremental updates.
   */
  private async connectToRoom(projectId: string): Promise<void> {
    const roomId = this.env.ROOM.idFromName(projectId);
    const stub = this.env.ROOM.get(roomId);

    const resp = await stub.fetch(
      new Request(`https://internal/sync/${projectId}`, {
        headers: {
          "Upgrade": "websocket",
          "x-partykit-room": projectId,
          "x-partykit-namespace": "ROOM",
          "x-internal-agent": "true",
          "x-agent-name": this.threadId?.slice(-6) || "Agent",
        },
      })
    );

    const ws = resp.webSocket;
    if (!ws) {
      throw new Error("ProjectRoom did not return a WebSocket");
    }
    ws.binaryType = "arraybuffer";
    ws.accept();
    this.roomWs = ws;

    // Wait for the initial snapshot before resolving
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for ProjectRoom snapshot"));
      }, 30_000);

      ws.addEventListener("message", (event) => {
        // Only handle binary messages (Loro updates)
        if (typeof event.data === "string") return;

        const data = new Uint8Array(event.data as ArrayBuffer);

        if (!this.roomInitialized) {
          // First binary message = ProjectRoom's current snapshot.
          //
          // CRITICAL: this.doc may already hold local writes that we
          // couldn't get to ProjectRoom (queued in pendingBroadcasts, OR
          // sent via ws.send() that succeeded locally but ProjectRoom never
          // committed because it crashed mid-flight). doc.import() merges
          // the snapshot INTO our existing doc — Loro CRDT handles dedup —
          // so we don't lose those local writes the way fromSnapshot would.
          try {
            this.doc.import(data);
          } catch (e) {
            log.error(`${this.tag()} room snapshot import failed; falling back to fromSnapshot (loses local writes):`, e);
            try {
              this.doc = LoroDoc.fromSnapshot(data);
            } catch (e2) {
              log.error(`${this.tag()} fromSnapshot also failed; starting empty doc:`, e2);
              this.doc = new LoroDoc();
            }
          }
          this.roomInitialized = true;
          clearTimeout(timeout);

          // Push our full state back to ProjectRoom so any local writes that
          // never made it (queued OR appeared-to-send-but-lost) get a second
          // chance. CRDT merge is idempotent, so re-sending what ProjectRoom
          // already has is harmless. Then drain the explicit queue too.
          try {
            const ourState = this.doc.export({ mode: "update" });
            if (ourState.byteLength > 0 && this.roomWs?.readyState === WebSocket.OPEN) {
              this.roomWs.send(ourState);
              log.info(`${this.tag()} pushed full state (${ourState.byteLength}B) to room on connect`);
            }
          } catch (e) {
            log.warn(`${this.tag()} full-state push to room failed:`, e);
          }
          this.flushPendingBroadcasts();

          resolve();
        } else {
          // Subsequent messages = incremental updates
          try {
            this.doc.import(data);
          } catch (e) {
            log.error("Failed to import room update:", e);
          }
        }
      });

      ws.addEventListener("close", (ev) => {
        log.warn(`${this.tag()} room WS closed (code=${(ev as CloseEvent).code} reason=${(ev as CloseEvent).reason || "—"} initialized=${this.roomInitialized} pending=${this.pendingBroadcasts.length})`);
        this.roomWs = null;
        this.roomInitialized = false;
        this.roomConnection = null;
        // KEEP this.doc — wiping it would lose any local writes that
        // haven't propagated yet (the broadcast queue only has writes that
        // never even attempted send; ws.send() that returned successfully
        // but ProjectRoom was tearing down concurrently is invisible to us).
        // On reconnect we push the full doc state to ProjectRoom; CRDT
        // merge dedups what was already there.
      });

      ws.addEventListener("error", (e) => {
        log.error(`${this.tag()} room WS error:`, e);
        clearTimeout(timeout);
        reject(new Error("ProjectRoom WebSocket error"));
      });
    });
  }

  /**
   * Send a Loro update to ProjectRoom for broadcast.
   *
   * If the room WS isn't OPEN we queue the update instead of dropping it —
   * a re-connect will flush. WebSockets give no delivery ack, so a
   * fire-and-forget broadcast that "succeeded" by ws.send() returning can
   * still be lost if ProjectRoom was tearing down at the same moment. The
   * full-state push in connectToRoom (after snapshot) covers that case via
   * Loro's CRDT merge — duplicate updates are idempotent.
   */
  private broadcastToRoom = (update: Uint8Array): void => {
    if (this.roomWs?.readyState === WebSocket.OPEN) {
      try {
        this.roomWs.send(update);
        return;
      } catch (e) {
        log.warn(`${this.tag()} broadcastToRoom send threw, queueing:`, e);
        // fall through to queue
      }
    }
    if (this.pendingBroadcasts.length < SupervisorAgent.MAX_PENDING_BROADCASTS) {
      this.pendingBroadcasts.push(update);
    } else {
      log.error(`${this.tag()} broadcastToRoom queue full (${this.pendingBroadcasts.length}); dropping update — room sync will diverge`);
    }
  };

  /**
   * Drain pendingBroadcasts to a now-OPEN room WS. Idempotent — failed sends
   * go back on the queue, so a partial drain is safe.
   */
  private flushPendingBroadcasts(): void {
    if (this.pendingBroadcasts.length === 0) return;
    if (this.roomWs?.readyState !== WebSocket.OPEN) return;
    const queue = this.pendingBroadcasts;
    this.pendingBroadcasts = [];
    log.info(`${this.tag()} flushing ${queue.length} buffered broadcasts to room`);
    for (const u of queue) {
      try {
        this.roomWs.send(u);
      } catch (e) {
        log.warn(`${this.tag()} flush send threw, requeueing:`, e);
        this.pendingBroadcasts.push(u);
      }
    }
  }

  // ─── Message Handling ──────────────────────────────────────

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message);

        // Handle context messages from frontend
        if (parsed.type === "context_update") {
          return; // No-op: agent has the Loro doc
        }

        if (parsed.type === "context" && parsed.workspaceGroupId) {
          if (parsed.workspaceGroupId !== this.workspaceGroupId) {
            this.workspaceGroupId = parsed.workspaceGroupId;
            void this.persistField("sup:workspaceGroupId", parsed.workspaceGroupId);
          }
          return;
        }

        if (parsed.type === "cancel") {
          return;
        }

        // Legacy "chat" type — extract workspaceGroupId if present
        if (parsed.type === "chat" && parsed.workspaceGroupId) {
          if (parsed.workspaceGroupId !== this.workspaceGroupId) {
            this.workspaceGroupId = parsed.workspaceGroupId;
            void this.persistField("sup:workspaceGroupId", parsed.workspaceGroupId);
          }
        }
      } catch {
        // Not JSON — fall through to AIChatAgent
      }
    }

    // Delegate to AIChatAgent protocol (handles cf_agent_use_chat_request, etc.)
    await super.onMessage(connection, message);
  }

  // ─── AI Chat ────────────────────────────────────────────────

  /**
   * Stream AI response via the standard AIChatAgent flow.
   *
   * Uses createUIMessageStream + createUIMessageStreamResponse so the base
   * class handles SSE→WS conversion, resumable streaming, and persistence.
   */
  async onChatMessage(
    onFinish?: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
    options?: Parameters<AIChatAgent<Env>["onChatMessage"]>[1],
  ) {
    // Recover identity if hibernation wiped it. Must run before tag() / room
    // connect / anything else that reads this.projectId.
    await this.ensureIdentity();

    const turn = ++this.turnSeq;
    const turnStart = Date.now();
    const reqId = (options as any)?.requestId?.toString().slice(-6) ?? "?";
    log.info(`${this.tag()} turn=${turn} req=${reqId} start (msgs=${this.messages.length} roomInit=${this.roomInitialized} aborted=${options?.abortSignal?.aborted ?? "n/a"})`);

    // Sweep stale resumable streams. Upstream's ResumableStream.restore() only
    // runs at DO construction — if the DO stays warm for >5min after a stream
    // wedges (LLM hang, eviction mid-stream, etc.), `hasActiveStream()` stays
    // true forever and every new WS connection gets a `_notifyStreamResuming`
    // for a stream that will never produce another chunk. Force-resolve here.
    this.sweepStaleStream(turn);

    // Repair half-finished tool calls in persisted history. If a previous turn
    // crashed / was evicted between recording the assistant's tool-call and
    // persisting its output, the message log has a tool part stuck in
    // input-available / input-streaming / approval-requested. OpenAI rejects
    // any chat completion request whose assistant message contains a tool
    // call without a matching tool_result ("Tool result is missing for tool
    // call call_xxx"), so the *next* turn fails before even reaching the
    // model. Force a synthetic output-error onto every dangling tool part
    // so convertToModelMessages can produce a well-formed transcript.
    await this.repairDanglingToolCalls(turn);

    // Lazily connect to ProjectRoom on first chat message
    if (!this.roomConnection) {
      log.info(`${this.tag()} turn=${turn} connecting to room…`);
      this.roomConnection = this.connectToRoom(this.projectId);
    }
    if (!this.roomInitialized) {
      const t = Date.now();
      try {
        await this.roomConnection;
        log.info(`${this.tag()} turn=${turn} room ready in ${Date.now() - t}ms`);
      } catch (e) {
        log.error(`${this.tag()} turn=${turn} room connect FAILED in ${Date.now() - t}ms:`, e);
        // Reset so subsequent turns retry instead of awaiting a rejected promise.
        this.roomConnection = null;
        this.roomInitialized = false;
        throw e;
      }
    }

    if (!this._model) this._model = createModel(this.env);
    const { model, provider } = this._model;

    // Send custom events to all connected browser clients
    const sendMsg = (msg: Record<string, unknown>) => {
      this.broadcast(JSON.stringify(msg));
    };

    const generateId = () => crypto.randomUUID().slice(0, 8);
    const getWorkspaceGroupId = () => this.workspaceGroupId;

    // ensureRoomFresh: re-establish the room WS if it died mid-turn so a
    // long-polling tool (wait_for_generation) doesn't read a stale local doc.
    const ensureRoomFresh = async (): Promise<void> => {
      if (this.roomWs?.readyState === WebSocket.OPEN && this.roomInitialized) return;
      if (!this.roomConnection) {
        this.roomConnection = this.connectToRoom(this.projectId);
      }
      try {
        await this.roomConnection;
      } catch {
        this.roomConnection = null;
        this.roomInitialized = false;
        // Caller logs and continues — staleness self-heals on next poll.
      }
    };
    // The in-API supervisor is the user's own chat — every canvas node
    // it creates inherits the user's identity (NOT a agent_member).
    // ACP agent supervisors (Director / Generator / …) live outside this
    // file; when they wire createCanvasTools they pass actorType='agent'.
    const canvasTools = createCanvasTools(
      this.doc,
      this.broadcastToRoom,
      sendMsg,
      generateId,
      getWorkspaceGroupId,
      this.env,
      this.projectId,
      ensureRoomFresh,
      { actorType: "user", actorUserId: this.userId },
    );
    const workflowTools = createWorkflowTools(this.doc, this.broadcastToRoom, generateId);
    const timelineTools = createTimelineTools(sendMsg);
    const allTools = { ...canvasTools, ...workflowTools, ...timelineTools };
    const delegationTool = createDelegationTool(model as any, allTools, provider);
    const tools = { ...allTools, task_delegation: delegationTool };

    const { streamText, convertToModelMessages, stepCountIs, createUIMessageStream, createUIMessageStreamResponse } = await import("ai");

    const cT = Date.now();
    const modelMessages = await convertToModelMessages(this.messages, { tools });
    log.info(`${this.tag()} turn=${turn} convertToModelMessages done in ${Date.now() - cT}ms (model-msgs=${modelMessages.length})`);
    const MAX_STEPS = 100;
    let prepareStepCount = 0;
    let firstChunkAt: number | null = null;

    // Compose three abort sources into one signal:
    //   1. caller's abortSignal (user clicked stop, request canceled)
    //   2. firstChunk timeout — model never started streaming
    //   3. total-turn timeout  — turn exceeded budget
    // When any fires, streamText sees the abort and tears down cleanly.
    const turnAbort = new AbortController();
    const upstreamAbort = options?.abortSignal;
    if (upstreamAbort) {
      if (upstreamAbort.aborted) turnAbort.abort();
      else upstreamAbort.addEventListener("abort", () => turnAbort.abort(), { once: true });
    }
    let abortReason: string | null = null;
    const firstChunkTimer = setTimeout(() => {
      if (firstChunkAt === null) {
        abortReason = `no firstChunk within ${SupervisorAgent.FIRST_CHUNK_TIMEOUT_MS}ms`;
        log.error(`${this.tag()} turn=${turn} ABORT: ${abortReason}`);
        turnAbort.abort();
      }
    }, SupervisorAgent.FIRST_CHUNK_TIMEOUT_MS);
    const totalTimer = setTimeout(() => {
      abortReason = `turn exceeded ${SupervisorAgent.TOTAL_TURN_TIMEOUT_MS}ms`;
      log.error(`${this.tag()} turn=${turn} ABORT: ${abortReason}`);
      turnAbort.abort();
    }, SupervisorAgent.TOTAL_TURN_TIMEOUT_MS);

    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        const result = streamText({
          model,
          system: cachedSystemPrompt(SUPERVISOR_PROMPT, provider),
          messages: withCacheControl(modelMessages, provider),
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          abortSignal: turnAbort.signal,
          onError: (e) => {
            log.error(`${this.tag()} turn=${turn} streamText.onError after ${Date.now() - turnStart}ms (firstChunkAt=${firstChunkAt}):`, e);
          },
          onChunk: () => {
            if (firstChunkAt === null) {
              firstChunkAt = Date.now() - turnStart;
              log.info(`${this.tag()} turn=${turn} firstChunk @ ${firstChunkAt}ms`);
            }
          },
          onAbort: () => {
            log.warn(`${this.tag()} turn=${turn} streamText.onAbort after ${Date.now() - turnStart}ms (reason=${abortReason ?? "client"})`);
          },
          // OpenAI Chat Completions tool messages only accept text content.
          // Tools that want to surface an image embed a [[CANVAS_IMAGE:mime:b64]] marker
          // in their text output. prepareStep strips the marker and injects a follow-up
          // user message with the image as image_url so the model can actually see it.
          prepareStep: ({ messages }) => {
            const stepNo = ++prepareStepCount;
            const out: any[] = [];
            const pendingImages: Array<{ mime: string; b64: string; toolCallId?: string }> = [];
            for (const msg of messages) {
              if (msg.role === "tool" && Array.isArray(msg.content)) {
                const cleanedContent = msg.content.map((part: any) => {
                  if (part.type !== "tool-result") return part;
                  const output = part.output;
                  // output can be { type: 'text', value: string } or { type: 'json', value: ... }
                  let text: string | null = null;
                  if (output?.type === "text" && typeof output.value === "string") text = output.value;
                  else if (output?.type === "json" && typeof output.value === "string") text = output.value;
                  if (!text) return part;
                  const MARKER = /\[\[CANVAS_IMAGE:([^:]+):([A-Za-z0-9+/=]+)\]\]/g;
                  let match: RegExpExecArray | null;
                  const localImages: Array<{ mime: string; b64: string }> = [];
                  while ((match = MARKER.exec(text)) !== null) {
                    localImages.push({ mime: match[1], b64: match[2] });
                  }
                  if (localImages.length === 0) return part;
                  const stripped = text.replace(MARKER, "").trim();
                  for (const img of localImages) pendingImages.push({ ...img, toolCallId: part.toolCallId });
                  return { ...part, output: { type: "text", value: stripped || "Image attached in the following user message." } };
                });
                out.push({ ...msg, content: cleanedContent });
                // Inject a follow-up user message with the images so the model can see them
                if (pendingImages.length > 0) {
                  const userContent: any[] = [
                    { type: "text", text: "Image(s) returned by the previous tool call:" },
                  ];
                  for (const img of pendingImages) {
                    // AI SDK 'image' part accepts base64 string (no data: prefix) or Uint8Array.
                    // See: ImagePart in @ai-sdk/provider
                    userContent.push({
                      type: "image",
                      image: img.b64,
                      mediaType: img.mime,
                    });
                  }
                  out.push({ role: "user", content: userContent });
                  pendingImages.length = 0;
                }
              } else {
                out.push(msg);
              }
            }
            log.info(`${this.tag()} turn=${turn} prepareStep #${stepNo} (in=${messages.length} out=${out.length})`);
            return { messages: out };
          },
          onFinish: async ({ steps, finishReason, usage }) => {
            log.info(`${this.tag()} turn=${turn} streamText.onFinish steps=${steps.length} reason=${finishReason} tokens=${(usage as any)?.totalTokens ?? "?"} elapsed=${Date.now() - turnStart}ms`);
            if (steps.length >= MAX_STEPS) {
              log.warn(`${this.tag()} turn=${turn} step limit reached (${MAX_STEPS})`);
              sendMsg({
                type: "suggestions",
                suggestions: [
                  { label: "Continue", message: "continue" },
                ],
              });
            }
          },
        });

        writer.merge(result.toUIMessageStream());
      },
      onError: (e) => {
        clearTimeout(firstChunkTimer);
        clearTimeout(totalTimer);
        log.error(`${this.tag()} turn=${turn} UIMessageStream.onError after ${Date.now() - turnStart}ms (abortReason=${abortReason}):`, e);
        // Surface a structured, human-readable reason — beats "no response was generated".
        if (abortReason) return `Agent timed out: ${abortReason}. Please retry.`;
        return e instanceof Error ? e.message : String(e);
      },
      onFinish: () => {
        clearTimeout(firstChunkTimer);
        clearTimeout(totalTimer);
        log.info(`${this.tag()} turn=${turn} UIMessageStream finish elapsed=${Date.now() - turnStart}ms prepareSteps=${prepareStepCount} firstChunkAt=${firstChunkAt}${abortReason ? ` ABORTED: ${abortReason}` : ""}`);
      },
    });

    return createUIMessageStreamResponse({ stream });
  }

  /**
   * Force-finalize any resumable stream that's been "streaming" longer than
   * the upstream stale threshold (5min). The base class only sweeps in its
   * constructor, which never re-runs while the DO stays warm. Called at the
   * top of every onChatMessage so a wedged stream from a prior turn can't
   * keep new connections stuck on `_notifyStreamResuming`.
   */
  private sweepStaleStream(turn: number): void {
    try {
      const rs = (this as any)._resumableStream;
      if (!rs?.hasActiveStream?.()) return;
      const rows = (this as any).sql`
        select id, request_id, created_at from cf_ai_chat_stream_metadata
        where status = 'streaming'
        order by created_at desc limit 1
      ` as Array<{ id: string; request_id: string; created_at: number }> | undefined;
      const row = rows?.[0];
      if (!row) return;
      const age = Date.now() - row.created_at;
      // Mirror upstream STREAM_STALE_THRESHOLD_MS (5min). Anything older is
      // definitionally orphaned — no live producer is going to write more chunks.
      if (age < 5 * 60_000) return;
      log.warn(`${this.tag()} turn=${turn} sweeping stale stream id=${row.id} age=${Math.round(age / 1000)}s req=${row.request_id.slice(-6)}`);
      // markError keeps the chunk history but flips status so hasActiveStream()
      // returns false, releasing every subsequent reconnect from resume-limbo.
      rs.markError?.(row.id);
    } catch (e) {
      log.warn(`${this.tag()} turn=${turn} sweepStaleStream error (non-fatal):`, e);
    }
  }

  /**
   * Mark every dangling tool-call part in this.messages as output-error.
   *
   * "Dangling" = state in {input-streaming, input-available, approval-requested}.
   * These states mean the model issued a tool call (and we possibly even
   * approved/started it) but no result was ever recorded — almost always
   * because the previous turn was killed mid-tool-execution by a DO
   * eviction, network drop, or upstream LLM stream error. OpenAI's chat
   * completions API rejects any subsequent request whose history contains
   * an assistant tool_use without a matching tool_result, so this
   * supervisor would 400 on every retry until manually rescued.
   *
   * The repaired part gets a synthetic errorText. The model sees "this
   * tool failed; figure out what to do next" and the conversation
   * unblocks. We persist the repair via persistMessages so the fix
   * survives the next hibernation.
   */
  private async repairDanglingToolCalls(turn: number): Promise<void> {
    const DANGLING = new Set(["input-streaming", "input-available", "approval-requested"]);
    let repaired = 0;
    let touched = false;
    const repairedMessages = this.messages.map((msg: any) => {
      if (msg.role !== "assistant" || !Array.isArray(msg.parts)) return msg;
      let msgChanged = false;
      const newParts = msg.parts.map((part: any) => {
        const isToolPart =
          typeof part?.type === "string" &&
          (part.type.startsWith("tool-") || part.type === "dynamic-tool");
        if (!isToolPart) return part;
        if (!DANGLING.has(part.state)) return part;
        repaired++;
        msgChanged = true;
        return {
          ...part,
          state: "output-error",
          errorText:
            "Tool call did not complete in the previous turn (likely worker eviction or stream interruption). Treat as failed and proceed.",
        };
      });
      if (!msgChanged) return msg;
      touched = true;
      return { ...msg, parts: newParts };
    });
    if (!touched) return;
    log.warn(`${this.tag()} turn=${turn} repaired ${repaired} dangling tool call(s) in history`);
    try {
      await (this as any).persistMessages(repairedMessages);
    } catch (e) {
      // Non-fatal: even without persistence, this turn proceeds correctly
      // because we updated the in-memory this.messages via persistMessages's
      // own assignment. If persist itself fails (storage hiccup), the next
      // turn will repair again.
      log.warn(`${this.tag()} turn=${turn} repaired-history persistMessages failed (non-fatal):`, e);
    }
  }
}
