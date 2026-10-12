import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { GEN_AI, GEN_AI_OPERATIONS } from "@clash/shared-runtime/tracing";

/**
 * Span bookkeeping for one ACP session: the `create_agent` span while the
 * agent starts, one `invoke_agent` span per turn, and one `execute_tool`
 * child span per tool call. Every span this session opens is closed here.
 *
 * Attributes are metadata only: ids, names, counts and durations.
 */

export type TurnOutcome =
  | { status: "ok" }
  | { status: "error"; message: string }
  /** Ended without success or failure, e.g. cancelled or disposed. */
  | { status: "unset"; reason: string };

export type ToolOutcome = "completed" | "failed";

export interface SessionIdentity {
  agentName: string;
  projectId?: string;
}

export interface ToolCallInfo {
  toolCallId: string;
  title?: string;
  kind?: string;
}

export interface ContextUsage {
  used?: number;
  size?: number;
  costAmount?: number;
}

function childContext(parent: Span | undefined): Context | undefined {
  return parent
    ? trace.setSpanContext(otelContext.active(), parent.spanContext())
    : undefined;
}

function finish(span: Span, outcome: TurnOutcome): void {
  if (outcome.status === "ok") span.setStatus({ code: SpanStatusCode.OK });
  else if (outcome.status === "error")
    span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.message });
  else span.setAttribute("clash.end_reason", outcome.reason);
  span.end();
}

export class SessionSpans {
  private createAgent: Span | undefined;
  private acpSessionId: string | undefined;
  private readonly turns = new Map<string, Span>();
  private readonly tools = new Map<string, Span>();

  constructor(
    private readonly tracer: Tracer,
    readonly sessionId: string,
    private readonly identity: SessionIdentity,
  ) {}

  /** Attributes shared by every span of this session. */
  attributes(): Attributes {
    return {
      [GEN_AI.conversationId]: this.sessionId,
      [GEN_AI.agentName]: this.identity.agentName,
      ...(this.identity.projectId
        ? { "clash.project_id": this.identity.projectId }
        : {}),
      ...(this.acpSessionId
        ? { "clash.acp_session_id": this.acpSessionId }
        : {}),
    };
  }

  beginCreateAgent(extra: Attributes): void {
    this.createAgent = this.tracer.startSpan("create_agent", {
      kind: SpanKind.INTERNAL,
      attributes: {
        [GEN_AI.operationName]: GEN_AI_OPERATIONS.createAgent,
        ...this.attributes(),
        ...extra,
      },
    });
  }

  ready(acpSessionId: string): void {
    this.acpSessionId = acpSessionId;
    if (!this.createAgent) return;
    this.createAgent.setAttributes(this.attributes());
    finish(this.createAgent, { status: "ok" });
    this.createAgent = undefined;
  }

  /** Fail a pending start; returns false when no start was pending. */
  failStart(message: string): boolean {
    if (!this.createAgent) return false;
    finish(this.createAgent, { status: "error", message });
    this.createAgent = undefined;
    return true;
  }

  /**
   * Open a turn. With a remote parent (a forwarded W3C traceparent) the turn
   * joins the caller's trace; otherwise it starts its own trace, grouped
   * with the session by `gen_ai.conversation.id`.
   */
  beginTurn(turnId: string, promptChars: number, remoteParent?: Context): void {
    const options = {
      kind: SpanKind.INTERNAL,
      attributes: {
        [GEN_AI.operationName]: GEN_AI_OPERATIONS.invokeAgent,
        ...this.attributes(),
        "clash.turn_id": turnId,
        "clash.prompt_chars": promptChars,
      },
    };
    this.turns.set(
      turnId,
      remoteParent
        ? this.tracer.startSpan("invoke_agent", options, remoteParent)
        : this.tracer.startSpan("invoke_agent", options),
    );
  }

  hasTurn(turnId: string): boolean {
    return this.turns.has(turnId);
  }

  /** End one turn, or every open turn when `turnId` is undefined. */
  endTurn(turnId: string | undefined, outcome: TurnOutcome): void {
    for (const id of turnId ? [turnId] : [...this.turns.keys()]) {
      const span = this.turns.get(id);
      if (!span) continue;
      this.turns.delete(id);
      finish(span, outcome);
    }
  }

  /** Add an event to a turn, or to the oldest open turn when unspecified. */
  addTurnEvent(
    turnId: string | undefined,
    name: string,
    attributes?: Attributes,
  ): void {
    const span = turnId
      ? this.turns.get(turnId)
      : this.turns.values().next().value;
    span?.addEvent(name, attributes);
  }

  recordUsage(turnId: string, usage: ContextUsage): void {
    const attributes: Attributes = {
      ...(usage.used !== undefined ? { "clash.acp.context_used": usage.used } : {}),
      ...(usage.size !== undefined ? { "clash.acp.context_size": usage.size } : {}),
      ...(usage.costAmount !== undefined
        ? { "clash.acp.cost_amount": usage.costAmount }
        : {}),
    };
    if (Object.keys(attributes).length > 0)
      this.turns.get(turnId)?.setAttributes(attributes);
  }

  beginTool(turnId: string, tool: ToolCallInfo): void {
    if (this.tools.has(tool.toolCallId)) return;
    this.tools.set(
      tool.toolCallId,
      this.tracer.startSpan(
        "execute_tool",
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            [GEN_AI.operationName]: GEN_AI_OPERATIONS.executeTool,
            ...this.attributes(),
            "clash.turn_id": turnId,
            [GEN_AI.toolCallId]: tool.toolCallId,
            ...(tool.title ? { [GEN_AI.toolName]: tool.title } : {}),
            ...(tool.kind ? { "clash.acp.tool_kind": tool.kind } : {}),
          },
        },
        childContext(this.turns.get(turnId)),
      ),
    );
  }

  endTool(toolCallId: string, outcome: ToolOutcome): void {
    const span = this.tools.get(toolCallId);
    if (!span) return;
    this.tools.delete(toolCallId);
    finish(
      span,
      outcome === "completed"
        ? { status: "ok" }
        : { status: "error", message: "tool call failed" },
    );
  }

  /** Close every open span, innermost first. */
  closeAll(reason: string): void {
    for (const span of this.tools.values()) finish(span, { status: "unset", reason });
    this.tools.clear();
    this.endTurn(undefined, { status: "unset", reason });
    if (this.createAgent) {
      finish(this.createAgent, { status: "unset", reason });
      this.createAgent = undefined;
    }
  }
}
