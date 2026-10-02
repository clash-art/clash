import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { AcpSessionImpl, type ChildHandle } from "@openma/common/acp-runtime";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createHarness(
  toAgent: (connection: AgentSideConnection) => Agent,
  kill: ChildHandle["kill"],
): ChildHandle {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  new AgentSideConnection(
    toAgent,
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  );
  return {
    stdin: clientToAgent.writable,
    stdout: agentToClient.readable,
    stderr: new ReadableStream({ start(controller) { controller.close(); } }),
    exited: Promise.resolve({ code: 0, signal: null }),
    kill,
  };
}

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    async initialize() {
      return { protocolVersion: PROTOCOL_VERSION };
    },
    async newSession() {
      return { sessionId: "acp-lifecycle-session" };
    },
    async authenticate() {
      return {};
    },
    async prompt() {
      return { stopReason: "end_turn" };
    },
    async cancel() {
      return undefined;
    },
    ...overrides,
  } as Agent;
}

describe("AcpSession lifecycle", () => {
  it("gracefully closes an advertised ACP session before killing its transport", async () => {
    const order: string[] = [];
    const child = createHarness(
      () => baseAgent({
        async initialize() {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { sessionCapabilities: { close: {} } },
          };
        },
        async closeSession(params) {
          order.push(`close:${params.sessionId}`);
          return {};
        },
      }),
      async () => {
        order.push("kill");
      },
    );
    const session = new AcpSessionImpl({
      child,
      id: "local-lifecycle-session",
      options: { agent: { command: "fake-agent", cwd: "/tmp/clash" } },
    });

    await session.init();
    await session.dispose();

    expect(order).toEqual(["close:acp-lifecycle-session", "kill"]);
  });

  it("makes concurrent dispose calls wait for the same child cleanup", async () => {
    const killStarted = deferred<void>();
    const releaseKill = deferred<void>();
    const kill = vi.fn(async () => {
      killStarted.resolve();
      await releaseKill.promise;
    });
    const child = createHarness(() => baseAgent(), kill);
    const session = new AcpSessionImpl({
      child,
      id: "local-idempotent-dispose",
      options: { agent: { command: "fake-agent", cwd: "/tmp/clash" } },
    });
    await session.init();

    const first = session.dispose();
    await killStarted.promise;
    let secondSettled = false;
    const second = session.dispose().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    const settledBeforeCleanup = secondSettled;
    releaseKill.resolve();
    await Promise.all([first, second]);

    expect(settledBeforeCleanup).toBe(true);
    expect(kill).toHaveBeenCalledOnce();
  });
});
