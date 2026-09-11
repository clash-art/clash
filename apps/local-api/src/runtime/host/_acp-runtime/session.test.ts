import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type AuthenticateRequest,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { AcpRuntimeImpl } from "./runtime.js";
import { AcpSessionImpl } from "./session.js";
import type { AcpSessionEvent, ChildHandle, Spawner } from "./types.js";

function makeStreamPair(): { child: ChildHandle; agentInput: ReadableStream<Uint8Array>; agentOutput: WritableStream<Uint8Array> } {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    child: {
      stdin: clientToAgent.writable,
      stdout: agentToClient.readable,
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      kill: async () => undefined,
      exited: Promise.resolve({ code: 0, signal: null }),
    },
    agentInput: clientToAgent.readable,
    agentOutput: agentToClient.writable,
  };
}

class ResumeCapableAgent implements Agent {
  constructor(
    private readonly connection: AgentConnection,
    private readonly calls: string[],
  ) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        promptCapabilities: {},
      },
    };
  }

  async resumeSession(_params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.calls.push("resume");
    return {
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
          currentValue: "gpt-5.5",
        },
      ],
    };
  }

  async loadSession(_params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.calls.push("load");
    return {};
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    return { sessionId: "new-session" };
  }

  async authenticate() {
    return {};
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    return { stopReason: "end_turn" };
  }

  async cancel() {
    await this.connection.sessionUpdate({
      sessionId: "unused",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
    });
  }
}

class McpCapturingAgent implements Agent {
  newSessionRequest: NewSessionRequest | undefined;

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionRequest = params;
    return { sessionId: "mcp-session" };
  }

  async authenticate() {
    return {};
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    return { stopReason: "end_turn" };
  }

  async cancel() {}
}

class LoadReplayAgent implements Agent {
  constructor(
    protected readonly connection: AgentConnection,
    protected readonly calls: string[] = [],
  ) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
      },
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.calls.push("load");
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "old replay from session/load" },
      },
    });
    return {};
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.calls.push("new");
    return { sessionId: "new-session" };
  }

  async authenticate() {
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "new response after attach" },
      },
    });
    return { stopReason: "end_turn" };
  }

  async cancel() {
    return undefined;
  }
}

class AsyncLoadReplayAgent extends LoadReplayAgent {
  override async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.calls.push("load");
    setTimeout(() => {
      void this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late old replay from session/load" },
        },
      });
    }, 0);
    return {};
  }
}

class AuthRetryAgent implements Agent {
  private authenticated = false;

  constructor(private readonly calls: string[]) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.calls.push("initialize");
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [{ id: "login", name: "Login" }],
      agentCapabilities: {
        promptCapabilities: {},
      },
    };
  }

  async authenticate(params: AuthenticateRequest) {
    this.calls.push(`authenticate:${params.methodId}`);
    this.authenticated = true;
    return {};
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.calls.push("newSession");
    if (!this.authenticated) throw RequestError.authRequired();
    return { sessionId: "authed-session" };
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    return { stopReason: "end_turn" };
  }

  async cancel() {
    return undefined;
  }
}

class HangingPromptAgent implements Agent {
  constructor(private readonly calls: string[]) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: {},
      },
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    return { sessionId: "timeout-session" };
  }

  async authenticate() {
    return {};
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    this.calls.push("prompt");
    return new Promise(() => undefined);
  }

  async cancel(params: { sessionId: string }) {
    this.calls.push(`cancel:${params.sessionId}`);
  }
}

class HangingAuthAgent implements Agent {
  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [{ id: "login", name: "Login" }],
      agentCapabilities: {
        promptCapabilities: {},
      },
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    throw RequestError.authRequired();
  }

  async authenticate() {
    return new Promise<never>(() => undefined);
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    return { stopReason: "end_turn" };
  }

  async cancel() {
    return undefined;
  }
}

class ModeCapableAgent implements Agent {
  currentModeId = "codex:review";

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    return {
      sessionId: "mode-session",
      modes: {
        currentModeId: this.currentModeId,
        availableModes: [
          { id: "codex:review", name: "Review" },
          { id: "codex:full-access", name: "Full access" },
        ],
      },
    };
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    this.currentModeId = params.modeId;
    return {};
  }

  async authenticate() {
    return {};
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    return { stopReason: "end_turn" };
  }

  async cancel() {
    return undefined;
  }
}

class NewSessionCapabilityAgent implements Agent {
  constructor(private readonly connection: AgentConnection) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    setTimeout(() => {
      void this.connection.sessionUpdate({
        sessionId: "capability-session",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "skills", description: "List available skills." }],
        },
      });
    }, 10);
    return { sessionId: "capability-session" };
  }

  async authenticate() {
    return {};
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    return { stopReason: "end_turn" };
  }

  async cancel() {
    return undefined;
  }
}

describe("AcpSessionImpl resume", () => {
  it("passes the host-owned MCP descriptor through ACP session/new", async () => {
    const pair = makeStreamPair();
    const agent = new McpCapturingAgent();
    new AgentSideConnection(
      () => agent,
      ndJsonStream(pair.agentOutput, pair.agentInput),
    );
    const mcpServer = {
      name: "clash",
      command: "/opt/clash/node",
      args: ["/opt/clash/runtime/dispatcher.js", "mcp"],
      env: [{ name: "CLASH_PROJECT_ID", value: "project-mcp" }],
    };
    const session = new AcpSessionImpl({
      id: "local-session",
      child: pair.child,
      options: {
        agent: { command: "codex-acp", cwd: "/tmp/project" },
        mcpServers: [mcpServer],
      },
    });

    await session.init();

    expect(agent.newSessionRequest).toMatchObject({
      cwd: "/tmp/project",
      mcpServers: [mcpServer],
    });
    await session.dispose();
  });

  it("surfaces capability updates emitted while creating a new session before the first prompt", async () => {
    const pair = makeStreamPair();
    new AgentSideConnection(
      (connection) => new NewSessionCapabilityAgent(connection),
      ndJsonStream(pair.agentOutput, pair.agentInput),
    );

    const session = new AcpSessionImpl({
      id: "local-session",
      child: pair.child,
      options: { agent: { command: "codex-acp", cwd: "/tmp/project" } },
    });

    await session.init();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(session.drainPendingEvents()).toEqual([
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "skills", description: "List available skills." }],
      },
    ]);
    await session.dispose();
  });

  it("authenticates and retries when session creation reports ACP auth required", async () => {
    const pair = makeStreamPair();
    const calls: string[] = [];
    new AgentSideConnection(
      () => new AuthRetryAgent(calls),
      ndJsonStream(pair.agentOutput, pair.agentInput),
    );

    const session = new AcpSessionImpl({
      id: "local-session",
      child: pair.child,
      options: {
        agent: { command: "gemini", cwd: "/tmp/project" },
      },
    });

    await session.init();

    expect(calls).toEqual(["initialize", "newSession", "authenticate:login", "newSession"]);
    expect(session.acpSessionId).toBe("authed-session");
  });

  it("ends the prompt stream when a per-turn timeout fires even if the agent ignores cancel", async () => {
    const pair = makeStreamPair();
    const calls: string[] = [];
    new AgentSideConnection(
      () => new HangingPromptAgent(calls),
      ndJsonStream(pair.agentOutput, pair.agentInput),
    );

    const session = new AcpSessionImpl({
      id: "local-session",
      child: pair.child,
      options: {
        agent: { command: "gemini", cwd: "/tmp/project" },
        perTurnTimeoutMs: 10,
      },
    });

    await session.init();
    const events: AcpSessionEvent[] = [];
    try {
      for await (const event of session.prompt("hang")) {
        events.push(event);
      }
    } finally {
      await session.dispose();
    }

    expect(calls).toEqual(["prompt", "cancel:timeout-session"]);
    expect(events).toContainEqual({
      type: "promptError",
      error: "Error: ACP prompt timed out after 10ms",
    });
  });

  it("times out session init and kills the child when ACP auth hangs", async () => {
    const pair = makeStreamPair();
    let killed = false;
    pair.child.kill = async () => {
      killed = true;
    };
    const spawner: Spawner = {
      async spawn() {
        return pair.child;
      },
    };
    new AgentSideConnection(
      () => new HangingAuthAgent(),
      ndJsonStream(pair.agentOutput, pair.agentInput),
    );

    const runtime = new AcpRuntimeImpl(spawner);

    await expect(runtime.start({
      agent: { command: "gemini", cwd: "/tmp/project" },
      initTimeoutMs: 10,
    })).rejects.toThrow("ACP session init timed out after 10ms");
    expect(killed).toBe(true);
  });

  it("uses ACP session/resume instead of session/load when the agent advertises resume", async () => {
    const pair = makeStreamPair();
    const calls: string[] = [];
    new AgentSideConnection(
      (connection) => new ResumeCapableAgent(connection, calls),
      ndJsonStream(pair.agentOutput, pair.agentInput),
    );

    const session = new AcpSessionImpl({
      id: "local-session",
      child: pair.child,
      options: {
        agent: { command: "codex-acp", cwd: "/tmp/project" },
        resumeAcpSessionId: "acp-existing",
      },
    });

    await session.init();

    expect(calls).toEqual(["resume"]);
    expect(session.acpSessionId).toBe("acp-existing");
    expect(session.configOptions).toHaveLength(1);
  });

  it("suppresses session/load replay events before the next prompt when resume is unavailable", async () => {
    const pair = makeStreamPair();
    const calls: string[] = [];
    new AgentSideConnection(
      (connection) => new LoadReplayAgent(connection, calls),
      ndJsonStream(pair.agentOutput, pair.agentInput),
    );

    const session = new AcpSessionImpl({
      id: "local-session",
      child: pair.child,
      options: {
        agent: { command: "codex-acp", cwd: "/tmp/project" },
        resumeAcpSessionId: "acp-existing",
      },
    });

    await session.init();
    expect(calls).toEqual(["load"]);
    expect(session.acpSessionId).toBe("acp-existing");

    const events: AcpSessionEvent[] = [];
    for await (const event of session.prompt("continue")) {
      events.push(event);
    }

    expect(JSON.stringify(events)).not.toContain("old replay from session/load");
    expect(JSON.stringify(events)).toContain("new response after attach");
  });

  it("waits for async session/load replay before allowing the next prompt", async () => {
    const pair = makeStreamPair();
    const calls: string[] = [];
    new AgentSideConnection(
      (connection) => new AsyncLoadReplayAgent(connection, calls),
      ndJsonStream(pair.agentOutput, pair.agentInput),
    );

    const session = new AcpSessionImpl({
      id: "local-session",
      child: pair.child,
      options: {
        agent: { command: "codex-acp", cwd: "/tmp/project" },
        resumeAcpSessionId: "acp-existing",
      },
    });

    await session.init();
    expect(calls).toEqual(["load"]);
    expect(session.acpSessionId).toBe("acp-existing");

    const events: AcpSessionEvent[] = [];
    for await (const event of session.prompt("continue")) {
      events.push(event);
    }

    expect(JSON.stringify(events)).not.toContain("late old replay from session/load");
    expect(JSON.stringify(events)).toContain("new response after attach");
  });

  it("stores and switches ACP session modes", async () => {
    const pair = makeStreamPair();
    new AgentSideConnection(
      () => new ModeCapableAgent(),
      ndJsonStream(pair.agentOutput, pair.agentInput),
    );

    const session = new AcpSessionImpl({
      id: "local-session",
      child: pair.child,
      options: {
        agent: { command: "codex", cwd: "/tmp/project" },
      },
    });

    await session.init();
    expect(session.modes).toEqual({
      currentModeId: "codex:review",
      availableModes: [
        { id: "codex:review", name: "Review" },
        { id: "codex:full-access", name: "Full access" },
      ],
    });

    await expect(session.setMode("codex:full-access")).resolves.toEqual({
      currentModeId: "codex:full-access",
      availableModes: [
        { id: "codex:review", name: "Review" },
        { id: "codex:full-access", name: "Full access" },
      ],
    });
  });
});

it("preserves the legacy model catalog before SDK decoding strips unknown response fields", async () => {
  const pair = makeStreamPair();
  const wire = ndJsonStream(pair.agentOutput, pair.agentInput);
  const reader = wire.readable.getReader();
  const writer = wire.writable.getWriter();
  const models = { currentModelId: "future[medium]", availableModels: [{ modelId: "known[medium]", name: "Known" }] };
  void (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const request = value as { id?: number; method?: string };
      if (request.id === undefined) continue;
      await writer.write({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
        ? { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }
        : { sessionId: "test-session", models, configOptions: [] } });
    }
  })();
  const runtime = new AcpRuntimeImpl({ spawn: async () => pair.child });
  const session = await runtime.start({ agent: { command: "test", args: [] } });
  expect(session.models).toEqual(models);
  await reader.cancel();
  await session.dispose();
});

it("sends the inclusive message boundary on the fork request", async () => {
  const pair = makeStreamPair();
  const wire = ndJsonStream(pair.agentOutput, pair.agentInput);
  const reader = wire.readable.getReader();
  const writer = wire.writable.getWriter();
  let forkParams: unknown;
  void (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const request = value as { id?: number; method?: string; params?: unknown };
      if (request.id === undefined) continue;
      if (request.method === "session/fork") forkParams = request.params;
      await writer.write({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
        ? { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { fork: {} } } }
        : { sessionId: "forked-session", configOptions: [] } });
    }
  })();
  const runtime = new AcpRuntimeImpl({ spawn: async () => pair.child });
  const session = await runtime.start({ agent: { command: "test", args: [] }, forkFromAcpSessionId: "source",
    forkPoint: { messageId: "answer-old", messageText: "abc", messageOccurrence: 2 } });
  expect(forkParams).toMatchObject({ sessionId: "source", _meta: { jetbrains: { air: { fork: {
    version: 1, messageId: "answer-old", messageOccurrence: 2,
    // SHA-256 standard test vector for UTF-8 "abc".
    messageFingerprint: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  } } } } });
  expect(session.acpSessionId).toBe("forked-session");
  await reader.cancel();
  await session.dispose();
});
