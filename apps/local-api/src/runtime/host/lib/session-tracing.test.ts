import { describe, expect, it, vi } from "vitest";

import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { GEN_AI } from "@clash/shared-runtime/tracing";

import { createAcpSessionTracing } from "./session-tracing.js";
import type { ManagerOut } from "./session-manager.js";

function setup(enabled = true) {
  const sent: ManagerOut[] = [];
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracing = createAcpSessionTracing({
    tracer: provider.getTracer("clash.acp.test"),
    enabled,
  });
  const send = tracing.wrapSend((msg) => sent.push(msg));
  const inner = {
    setSpawnEnv: vi.fn(),
    start: vi.fn(),
    prompt: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
    setMode: vi.fn(),
  };
  const manager = tracing.wrapManager(inner);
  return {
    sent,
    get emitted(): ReadableSpan[] {
      return exporter.getFinishedSpans();
    },
    send,
    manager,
    inner,
    tracing,
  };
}

describe("createAcpSessionTracing", () => {
  it("emits create_agent → invoke_agent → execute_tool spans with GenAI attributes", async () => {
    const ctx = setup();
    const { sent, send, manager } = ctx;

    await manager.start({
      session_id: "s1",
      agent_id: "codex-acp",
      project_id: "p1",
    });
    send({
      type: "session.ready",
      session_id: "s1",
      acp_session_id: "acp-1",
      supports_session_fork: false,
    });
    await manager.prompt({ session_id: "s1", turn_id: "t1", text: "hi" });
    send({
      type: "session.event",
      session_id: "s1",
      turn_id: "t1",
      event: {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "read_file",
        kind: "read",
        status: "in_progress",
      },
    });
    send({
      type: "session.event",
      session_id: "s1",
      turn_id: "t1",
      event: {
        update: { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" },
      },
    });
    send({ type: "session.complete", session_id: "s1", turn_id: "t1" });

    // The stream is forwarded untouched.
    expect(sent).toHaveLength(4);

    const createAgent = ctx.emitted.find((s) => s.name === "create_agent");
    const invoke = ctx.emitted.find((s) => s.name === "invoke_agent");
    const tool = ctx.emitted.find((s) => s.name === "execute_tool");
    expect(createAgent?.status.code).toBe(SpanStatusCode.OK);
    expect(createAgent?.attributes[GEN_AI.operationName]).toBe("create_agent");
    expect(createAgent?.attributes[GEN_AI.agentName]).toBe("codex-acp");
    expect(createAgent?.attributes[GEN_AI.conversationId]).toBe("s1");
    expect(invoke?.status.code).toBe(SpanStatusCode.OK);
    expect(invoke?.attributes[GEN_AI.operationName]).toBe("invoke_agent");
    expect(invoke?.attributes["clash.turn_id"]).toBe("t1");
    // Tool span is a child of the turn span (same trace).
    expect(tool?.status.code).toBe(SpanStatusCode.OK);
    expect(tool?.spanContext().traceId).toBe(invoke?.spanContext().traceId);
    expect(tool?.parentSpanContext?.spanId).toBe(invoke?.spanContext().spanId);
    expect(tool?.attributes[GEN_AI.toolName]).toBe("read_file");
    expect(tool?.attributes[GEN_AI.toolCallId]).toBe("tc1");
    // Prompt text never lands on the span.
    expect(JSON.stringify(ctx.emitted.map((span) => span.attributes))).not.toContain('"hi"');
  });

  it("marks failed turns and failed tool calls as error spans", async () => {
    const ctx = setup();
    const { send, manager } = ctx;
    await manager.start({ session_id: "s1", agent_id: "claude-acp" });
    send({
      type: "session.ready",
      session_id: "s1",
      acp_session_id: "acp-1",
      supports_session_fork: false,
    });
    await manager.prompt({ session_id: "s1", turn_id: "t1", text: "x" });
    send({
      type: "session.event",
      session_id: "s1",
      turn_id: "t1",
      event: {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "apply_patch",
      },
    });
    send({
      type: "session.event",
      session_id: "s1",
      turn_id: "t1",
      event: { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "failed" },
    });
    send({
      type: "session.error",
      session_id: "s1",
      turn_id: "t1",
      message: "model exploded",
    });

    const tool = ctx.emitted.find((s) => s.name === "execute_tool");
    const turn = ctx.emitted.find((s) => s.name === "invoke_agent");
    expect(tool?.status.code).toBe(SpanStatusCode.ERROR);
    expect(turn?.status.code).toBe(SpanStatusCode.ERROR);
    expect(turn?.status.message).toBe("model exploded");
  });

  it("fails a pending create_agent span when start errors before ready", async () => {
    const ctx = setup();
    const { send, manager } = ctx;
    await manager.start({ session_id: "s1", agent_id: "codex-acp" });
    send({
      type: "session.error",
      session_id: "s1",
      message: "spawn failed",
    });
    const createAgent = ctx.emitted.find((s) => s.name === "create_agent");
    expect(createAgent?.status.code).toBe(SpanStatusCode.ERROR);
    expect(createAgent?.status.message).toBe("spawn failed");
  });

  it("emits a standalone error span for errors with no open span", () => {
    const ctx = setup();
    const { send } = ctx;
    send({ type: "session.error", session_id: "s9", message: "gone" });
    const span = ctx.emitted.find((s) => s.name === "acp.session.error");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("closes open spans when the session is disposed", async () => {
    const ctx = setup();
    const { send, manager } = ctx;
    await manager.start({ session_id: "s1", agent_id: "codex-acp" });
    await manager.prompt({ session_id: "s1", turn_id: "t1", text: "x" });
    await manager.dispose("s1");
    const turn = ctx.emitted.find((s) => s.name === "invoke_agent");
    const createAgent = ctx.emitted.find((s) => s.name === "create_agent");
    expect(turn?.status.code).toBe(SpanStatusCode.UNSET);
    expect(createAgent?.status.code).toBe(SpanStatusCode.UNSET);
  });

  // Example header from the W3C Trace Context specification.
  const W3C_TRACEPARENT =
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("parents a turn under the traceparent linked before it starts", async () => {
    const ctx = setup();
    await ctx.manager.start({ session_id: "s1", agent_id: "codex-acp" });
    // Linked while the prompt waits in the queue; the turn starts later.
    ctx.tracing.linkTurn("s1", "t1", W3C_TRACEPARENT);
    await ctx.manager.prompt({ session_id: "s1", turn_id: "t1", text: "x" });
    ctx.send({ type: "session.complete", session_id: "s1", turn_id: "t1" });
    const turn = ctx.emitted.find((s) => s.name === "invoke_agent");
    expect(turn?.spanContext().traceId).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
    expect(turn?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
  });

  it("ignores an invalid linked traceparent", async () => {
    const ctx = setup();
    await ctx.manager.start({ session_id: "s1", agent_id: "codex-acp" });
    ctx.tracing.linkTurn("s1", "t1", "not-a-traceparent");
    await ctx.manager.prompt({ session_id: "s1", turn_id: "t1", text: "x" });
    ctx.send({ type: "session.complete", session_id: "s1", turn_id: "t1" });
    const first = ctx.emitted.find((s) => s.name === "invoke_agent");
    expect(first?.parentSpanContext).toBeUndefined();
  });

  it("drops linked parents when the session ends", async () => {
    const ctx = setup();
    await ctx.manager.start({ session_id: "s1", agent_id: "codex-acp" });
    ctx.tracing.linkTurn("s1", "t1", W3C_TRACEPARENT);
    await ctx.manager.dispose("s1");
    await ctx.manager.start({ session_id: "s1", agent_id: "codex-acp" });
    await ctx.manager.prompt({ session_id: "s1", turn_id: "t1", text: "x" });
    ctx.send({ type: "session.complete", session_id: "s1", turn_id: "t1" });
    const turn = ctx.emitted.find((s) => s.name === "invoke_agent");
    expect(turn?.spanContext().traceId).not.toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
  });

  it("disabled tracing is a pass-through", async () => {
    const ctx = setup(false);
    const { sent, send, manager, inner } = ctx;
    await manager.start({ session_id: "s1", agent_id: "codex-acp" });
    await manager.prompt({ session_id: "s1", turn_id: "t1", text: "x" });
    send({ type: "session.complete", session_id: "s1", turn_id: "t1" });
    expect(ctx.emitted).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(inner.start).toHaveBeenCalled();
    expect(inner.prompt).toHaveBeenCalled();
  });
});
