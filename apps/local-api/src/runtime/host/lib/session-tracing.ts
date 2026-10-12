import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Tracer,
} from "@opentelemetry/api";
import { GEN_AI, parseTraceparent } from "@clash/shared-runtime/tracing";

import type {
  ManagerOut,
  Sender,
  SessionPromptParams,
  SessionStartParams,
} from "./session-manager.js";
import { SessionSpans } from "./session-spans.js";

/**
 * ACP session tracing on the OpenTelemetry API.
 *
 * Three parts, one responsibility each:
 * - `SessionSpans` (session-spans.ts) opens and closes the spans of one
 *   session;
 * - `AcpTraceObserver` maps manager commands and the manager's outbound
 *   protocol stream onto `SessionSpans`;
 * - `createAcpSessionTracing` decorates a SessionManager and its Sender so
 *   the observer sees both, without touching SessionManager internals.
 *
 * Spans are no-ops until the Host registers a TracerProvider.
 */

export interface SessionManagerTraceSurface {
  setSpawnEnv?(env: Record<string, string | undefined>): void;
  start(params: SessionStartParams): Promise<void> | void;
  prompt(params: SessionPromptParams): Promise<void> | void;
  setConfigOption?(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<void> | void;
  setMode?(sessionId: string, modeId: string): Promise<void> | void;
  cancel(sessionId: string, turnId: string): void;
  dispose(sessionId: string): Promise<void> | void;
}

export interface AcpSessionTracing {
  /** Wrap the manager's outbound Sender; hand the result to the manager. */
  wrapSend(send: Sender): Sender;
  /** Wrap a manager so session commands open spans. */
  wrapManager(manager: SessionManagerTraceSurface): SessionManagerTraceSurface;
  /**
   * Record the caller's W3C traceparent for a turn that may start later
   * (prompts can queue). The turn span adopts it as remote parent when the
   * manager starts that turn. Invalid headers are ignored.
   */
  linkTurn(sessionId: string, turnId: string, traceparent: string): void;
}

/** Pending remote parents kept for turns that have not started yet. */
const MAX_PENDING_TURN_PARENTS = 256;

type SessionUpdate = Record<string, unknown> & { sessionUpdate: string };

/** ACP session/update payloads arrive bare or wrapped in `{ update }`. */
function sessionUpdateOf(event: unknown): SessionUpdate | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event))
    return undefined;
  const record = event as Record<string, unknown>;
  const nested = record.update;
  const update =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : record;
  return typeof update.sessionUpdate === "string"
    ? (update as SessionUpdate)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Remote parent from a forwarded W3C traceparent, when valid. */
function remoteParent(header: string | undefined): Context | undefined {
  const parsed = header ? parseTraceparent(header) : undefined;
  if (!parsed) return undefined;
  return trace.setSpanContext(otelContext.active(), {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: parsed.sampled ? 1 : 0,
    isRemote: true,
  });
}

function pendingKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

type OutputHandlers = {
  [K in ManagerOut["type"]]?: (
    message: Extract<ManagerOut, { type: K }>,
  ) => void;
};

type UpdateHandler = (
  spans: SessionSpans,
  turnId: string,
  update: SessionUpdate,
) => void;

/** ACP `session/update` kinds that carry trace-relevant facts. */
const UPDATE_HANDLERS: Readonly<Record<string, UpdateHandler>> = {
  tool_call(spans, turnId, update) {
    const toolCallId = optionalString(update.toolCallId);
    if (!toolCallId) return;
    spans.beginTool(turnId, {
      toolCallId,
      title: optionalString(update.title),
      kind: optionalString(update.kind),
    });
  },
  tool_call_update(spans, _turnId, update) {
    const toolCallId = optionalString(update.toolCallId);
    if (!toolCallId) return;
    if (update.status === "completed" || update.status === "failed")
      spans.endTool(toolCallId, update.status);
  },
  usage_update(spans, turnId, update) {
    // Context-window facts only, never content.
    const cost = update.cost as { amount?: unknown } | undefined;
    spans.recordUsage(turnId, {
      used: optionalNumber(update.used),
      size: optionalNumber(update.size),
      costAmount: optionalNumber(cost?.amount),
    });
  },
  plan(spans, turnId, update) {
    spans.addTurnEvent(turnId, "acp.plan", {
      entries: Array.isArray(update.entries) ? update.entries.length : 0,
    });
  },
};

export class AcpTraceObserver {
  private readonly sessions = new Map<string, SessionSpans>();
  private readonly pendingParents = new Map<string, Context>();

  constructor(private readonly tracer: Tracer) {}

  // ── Caller trace context ───────────────────────────────────────────────

  linkTurn(sessionId: string, turnId: string, traceparent: string): void {
    const parent = remoteParent(traceparent);
    if (!parent) return;
    const key = pendingKey(sessionId, turnId);
    this.pendingParents.delete(key);
    this.pendingParents.set(key, parent);
    // A turn that never starts must not pin memory; drop the oldest.
    while (this.pendingParents.size > MAX_PENDING_TURN_PARENTS) {
      const oldest = this.pendingParents.keys().next().value;
      if (oldest === undefined) break;
      this.pendingParents.delete(oldest);
    }
  }

  private takeParent(sessionId: string, turnId: string): Context | undefined {
    const key = pendingKey(sessionId, turnId);
    const parent = this.pendingParents.get(key);
    this.pendingParents.delete(key);
    return parent;
  }

  // ── Commands into the manager ──────────────────────────────────────────

  sessionStarting(params: SessionStartParams): void {
    const spans = new SessionSpans(this.tracer, params.session_id, {
      agentName: params.agent_id ?? params.agent_template_id ?? "unknown",
      ...(params.project_id ? { projectId: params.project_id } : {}),
    });
    this.sessions.set(params.session_id, spans);
    spans.beginCreateAgent({
      ...(params.agent_member_id
        ? { "clash.agent_member_id": params.agent_member_id }
        : {}),
      ...(params.permission_mode
        ? { "clash.permission_mode": params.permission_mode }
        : {}),
      ...(params.resume ? { "clash.acp.resumed": true } : {}),
      ...(params.fork ? { "clash.acp.forked": true } : {}),
    });
  }

  turnStarting(params: SessionPromptParams): void {
    this.ensure(params.session_id).beginTurn(
      params.turn_id,
      params.text.length,
      this.takeParent(params.session_id, params.turn_id),
    );
  }

  cancelRequested(sessionId: string, turnId: string): void {
    this.sessions.get(sessionId)?.addTurnEvent(turnId, "acp.cancel_requested");
  }

  disposing(sessionId: string): void {
    this.close(sessionId, "session disposed");
  }

  // ── Output from the manager ────────────────────────────────────────────

  observe(message: ManagerOut): void {
    try {
      const handler = this.outputHandlers[message.type] as
        | ((message: ManagerOut) => void)
        | undefined;
      handler?.(message);
    } catch {
      // Tracing observes the stream; it must never break it.
    }
  }

  private readonly outputHandlers: OutputHandlers = {
    "session.ready": (message) => {
      this.ensure(message.session_id).ready(message.acp_session_id);
    },
    "session.event": (message) => {
      const spans = this.sessions.get(message.session_id);
      const update = sessionUpdateOf(message.event);
      if (spans && update)
        UPDATE_HANDLERS[update.sessionUpdate]?.(spans, message.turn_id, update);
    },
    "session.complete": (message) => {
      this.sessions.get(message.session_id)?.endTurn(message.turn_id, {
        status: "ok",
      });
    },
    "session.cancelled": (message) => {
      this.sessions.get(message.session_id)?.endTurn(message.turn_id, {
        status: "unset",
        reason: "turn cancelled",
      });
    },
    "session.error": (message) => {
      const spans = this.sessions.get(message.session_id);
      if (message.turn_id && spans?.hasTurn(message.turn_id)) {
        spans.endTurn(message.turn_id, {
          status: "error",
          message: message.message,
        });
      } else if (!spans?.failStart(message.message)) {
        this.recordOrphanError(message.session_id, message.message, spans);
      }
    },
    "session.diagnostic": (message) => {
      // Severity and transient status only; the raw stderr line stays in
      // local logs and never lands on a span.
      this.sessions.get(message.session_id)?.addTurnEvent(
        message.turn_id,
        "acp.diagnostic",
        {
          severity: message.diagnostic.severity,
          ...(message.diagnostic.transientStatus
            ? { status: message.diagnostic.transientStatus.status }
            : {}),
        },
      );
    },
    "session.disposed": (message) => {
      this.close(message.session_id, "session ended");
    },
  };

  private ensure(sessionId: string): SessionSpans {
    let spans = this.sessions.get(sessionId);
    if (!spans) {
      spans = new SessionSpans(this.tracer, sessionId, { agentName: "unknown" });
      this.sessions.set(sessionId, spans);
    }
    return spans;
  }

  private close(sessionId: string, reason: string): void {
    this.sessions.get(sessionId)?.closeAll(reason);
    this.sessions.delete(sessionId);
    const prefix = pendingKey(sessionId, "");
    for (const key of this.pendingParents.keys())
      if (key.startsWith(prefix)) this.pendingParents.delete(key);
  }

  /** An error outside any open span still needs a trace anchor. */
  private recordOrphanError(
    sessionId: string,
    message: string,
    spans: SessionSpans | undefined,
  ): void {
    const span = this.tracer.startSpan("acp.session.error", {
      kind: SpanKind.INTERNAL,
      attributes: spans?.attributes() ?? { [GEN_AI.conversationId]: sessionId },
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message });
    span.end();
  }
}

export function createAcpSessionTracing(options: {
  /** OTel tracer, e.g. `trace.getTracer("clash.acp")`. */
  tracer: Tracer;
  enabled?: boolean;
}): AcpSessionTracing {
  if (options.enabled === false) {
    return {
      wrapSend: (send) => send,
      wrapManager: (manager) => manager,
      linkTurn: () => {},
    };
  }
  const observer = new AcpTraceObserver(options.tracer);
  return {
    linkTurn: (sessionId, turnId, traceparent) =>
      observer.linkTurn(sessionId, turnId, traceparent),
    wrapSend: (send) => (message) => {
      observer.observe(message);
      send(message);
    },
    wrapManager: (manager) => ({
      start(params) {
        observer.sessionStarting(params);
        return manager.start(params);
      },
      prompt(params) {
        observer.turnStarting(params);
        return manager.prompt(params);
      },
      cancel(sessionId, turnId) {
        observer.cancelRequested(sessionId, turnId);
        return manager.cancel(sessionId, turnId);
      },
      dispose(sessionId) {
        observer.disposing(sessionId);
        return manager.dispose(sessionId);
      },
      ...(manager.setSpawnEnv
        ? { setSpawnEnv: (env) => manager.setSpawnEnv!(env) }
        : {}),
      ...(manager.setConfigOption
        ? {
            setConfigOption: (sessionId, configId, value) =>
              manager.setConfigOption!(sessionId, configId, value),
          }
        : {}),
      ...(manager.setMode
        ? { setMode: (sessionId, modeId) => manager.setMode!(sessionId, modeId) }
        : {}),
    }),
  };
}
