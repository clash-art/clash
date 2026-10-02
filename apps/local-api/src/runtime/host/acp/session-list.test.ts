import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionInfo,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { listAgentSessions } from "./session-list";
import type { ChildHandle, Spawner } from "@openma/common/acp-runtime";

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

class ListableAgent implements Agent {
  constructor(
    private readonly connection: AgentConnection,
    private readonly sessions: SessionInfo[],
  ) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {} },
        promptCapabilities: {},
      },
    };
  }

  async listSessions(_params: ListSessionsRequest) {
    return { sessions: this.sessions };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    return { sessionId: "unused" };
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
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "" },
      },
    });
  }
}

describe("listAgentSessions", () => {
  it("uses ACP session/list when the agent advertises the capability", async () => {
    const pair = makeStreamPair();
    const spawner: Spawner = {
      async spawn() {
        return pair.child;
      },
    };
    new AgentSideConnection(
      (connection) => new ListableAgent(connection, [
        {
          sessionId: "acp-session-1",
          title: "Shot plan",
          cwd: "/tmp/project",
          updatedAt: "2026-06-18T09:00:00.000Z",
        },
      ]),
      ndJsonStream(pair.agentOutput, pair.agentInput),
    );

    await expect(listAgentSessions(spawner, {
      agent: { command: "codex-acp", cwd: "/tmp/project" },
    })).resolves.toEqual([
      {
        id: "acp-session-1",
        title: "Shot plan",
        cwd: "/tmp/project",
        modifiedAt: Math.floor(Date.parse("2026-06-18T09:00:00.000Z") / 1000),
      },
    ]);
  });
});
