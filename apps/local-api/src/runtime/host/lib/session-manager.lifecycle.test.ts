import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSession, SessionOptions } from "../_acp-runtime/types.js";

const mocks = vi.hoisted(() => ({
  runtimeStart: vi.fn(),
  resolveAgentMcpServers: vi.fn(),
}));

const bundledClashMcp = {
  name: "clash",
  command: process.execPath,
  args: ["/opt/clash/plugins/clash/runtime/index.js"],
  env: [{ name: "CLASH_PROJECT_ID", value: "project-lifecycle" }],
  _meta: {
    "io.modelcontextprotocol/ui": {
      host: "clash",
      mimeTypes: ["text/html;profile=mcp-app"],
    },
    "clash.plugin": "builtin",
    "clash.renderer": "product",
  },
};

vi.mock("../_acp-runtime/index.js", () => ({
  AcpRuntimeImpl: class {
    start = mocks.runtimeStart;
  },
}));

vi.mock("../_acp-runtime/spawners/node.js", () => ({
  NodeSpawner: class {},
}));

vi.mock("./session-cwd.js", () => ({
  ensureAgentCwd: vi.fn(async () => "/tmp/clash-session-lifecycle"),
  readAgentRuntime: vi.fn(async () => ({ agent_id: "fake-acp" })),
  resolveAgentMcpServers: mocks.resolveAgentMcpServers,
}));

import {
  SessionManager,
  type ManagerOut,
  type SessionStartParams,
} from "./session-manager.js";

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

function sessionParams(sessionId: string): SessionStartParams {
  return {
    session_id: sessionId,
    agent_template_id: "clash",
    agent_id: "fake-acp",
    agent_spec: { command: "fake-acp" },
    project_id: "project-lifecycle",
  };
}

function createAcpSession(
  options: {
    prompt?: AcpSession["prompt"];
    dispose?: AcpSession["dispose"];
    supportsSessionFork?: boolean;
  } = {},
): AcpSession {
  return {
    id: "runtime-session",
    acpSessionId: "acp-session",
    options: { agent: { command: "fake-acp" } } satisfies SessionOptions,
    authMethods: [],
    agentInfo: null,
    configOptions: [],
    modes: undefined,
    promptCapabilities: {},
    supportsSessionFork: options.supportsSessionFork ?? false,
    loadedReplayEvents: [],
    drainPendingEvents() {
      return [];
    },
    prompt: options.prompt ?? async function* () {},
    async setConfigOption() {
      return [];
    },
    async setMode() {
      return undefined;
    },
    async provideToolResult() {
      return undefined;
    },
    async authenticate() {
      return undefined;
    },
    isAlive() {
      return true;
    },
    dispose: options.dispose ?? (async () => undefined),
  };
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("SessionManager lifecycle", () => {
  beforeEach(() => {
    mocks.runtimeStart.mockReset();
    mocks.resolveAgentMcpServers.mockReset();
    mocks.resolveAgentMcpServers.mockResolvedValue([bundledClashMcp]);
  });

  it("sends only the authored prompt, including after compaction and host resume", async () => {
    const prompts: unknown[] = [];
    mocks.runtimeStart.mockResolvedValue(
      createAcpSession({
        async *prompt(content) {
          prompts.push(content);
        },
      }),
    );
    const manager = new SessionManager(() => {});
    const params = sessionParams("context-lifecycle");
    await manager.start(params);
    try {
      for (const text of [
        "/help",
        "first",
        "second",
        "/compact preserve the edit",
        "after compact",
        "last",
      ]) {
        await manager.prompt({
          session_id: params.session_id,
          turn_id: text,
          text,
        });
      }
      expect(prompts[0]).toEqual([{ type: "text", text: "/help" }]);
      expect(prompts[1]).toEqual([{ type: "text", text: "first" }]);
      expect(prompts[2]).toEqual([{ type: "text", text: "second" }]);
      expect(prompts[3]).toEqual([
        { type: "text", text: "/compact preserve the edit" },
      ]);
      expect(prompts[4]).toEqual([{ type: "text", text: "after compact" }]);
      expect(prompts[5]).toEqual([{ type: "text", text: "last" }]);
    } finally {
      await manager.dispose(params.session_id);
    }
    const resumedManager = new SessionManager(() => {});
    await resumedManager.start({
      ...params,
      resume: { acp_session_id: "acp-session" },
    });
    try {
      await resumedManager.prompt({
        session_id: params.session_id,
        turn_id: "resumed",
        text: "continue",
      });
      expect(prompts.at(-1)).toEqual([{ type: "text", text: "continue" }]);
    } finally {
      await resumedManager.dispose(params.session_id);
    }
  });

  it("preserves authored text on a failed prompt and its retry", async () => {
    const prompts: unknown[] = [];
    mocks.runtimeStart.mockResolvedValue(
      createAcpSession({
        async *prompt(content) {
          prompts.push(content);
          if (prompts.length === 1) throw new Error("transport failed");
        },
      }),
    );
    const manager = new SessionManager(() => {});
    const params = sessionParams("context-retry");
    await manager.start(params);
    try {
      await manager.prompt({
        session_id: params.session_id,
        turn_id: "failed",
        text: "first",
      });
      await manager.prompt({
        session_id: params.session_id,
        turn_id: "retry",
        text: "retry",
      });
      expect(prompts).toEqual([
        [{ type: "text", text: "first" }],
        [{ type: "text", text: "retry" }],
      ]);
    } finally {
      await manager.dispose(params.session_id);
    }
  });

  it("announces ACP session fork support when the harness provides it", async () => {
    mocks.runtimeStart.mockResolvedValue(
      createAcpSession({ supportsSessionFork: true }),
    );
    const sent: ManagerOut[] = [];
    const manager = new SessionManager((message) => sent.push(message));
    const params = sessionParams("session-fork-capability");

    await manager.start(params);

    try {
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: "session.ready",
          session_id: params.session_id,
          supports_session_fork: true,
        }),
      );
    } finally {
      await manager.dispose(params.session_id);
    }
  });

  it("mounts the bundled Clash MCP in ACP session/new during cold start", async () => {
    mocks.runtimeStart.mockResolvedValue(createAcpSession());
    const manager = new SessionManager(() => undefined);
    const params = sessionParams("session-bundled-clash-mcp");

    await manager.start(params);

    try {
      expect(mocks.resolveAgentMcpServers).toHaveBeenCalledWith(
        "clash",
        expect.objectContaining({
          CLASH_PROJECT_ID: "project-lifecycle",
          CLASH_WORKSPACE_ROOT: "/tmp/clash-session-lifecycle",
          CLASH_SESSION_SCRATCHPAD: expect.stringContaining(params.session_id),
        }),
      );
      expect(mocks.runtimeStart).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [bundledClashMcp],
        }),
      );
    } finally {
      await manager.dispose(params.session_id);
    }
  });

  it("fails closed instead of starting a self-host session without the bundled Clash MCP", async () => {
    mocks.resolveAgentMcpServers.mockResolvedValue([]);
    const sent: ManagerOut[] = [];
    const manager = new SessionManager((message) => sent.push(message));
    const params = sessionParams("session-missing-bundled-clash-mcp");

    await manager.start(params);

    expect(mocks.runtimeStart).not.toHaveBeenCalled();
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "session.error",
        session_id: params.session_id,
        message: expect.stringMatching(/bundled Clash MCP/i),
      }),
    );
    expect(sent.some((message) => message.type === "session.ready")).toBe(
      false,
    );
  });

  it("host-marks product rendering only for the bundled MCP injected into this session", async () => {
    mocks.resolveAgentMcpServers.mockResolvedValue([
      {
        name: "clash",
        command: process.execPath,
        args: ["/opt/clash/plugins/clash/runtime/index.js"],
        env: [],
        _meta: {
          "clash.plugin": "builtin",
          "clash.renderer": "product",
        },
      },
    ]);
    mocks.runtimeStart.mockResolvedValue(
      createAcpSession({
        prompt() {
          return (async function* () {
            yield {
              sessionUpdate: "tool_call",
              toolCallId: "bundled-clash",
              rawInput: { server: "clash", tool: "clash_canvas_list" },
              _meta: { is_mcp_tool_call: true },
            };
            yield {
              sessionUpdate: "tool_call",
              toolCallId: "other-mcp",
              rawInput: { server: "charts", tool: "show_sales" },
              _meta: { is_mcp_tool_call: true },
            };
          })();
        },
      }),
    );
    const sent: ManagerOut[] = [];
    const manager = new SessionManager((message) => sent.push(message));
    const params = sessionParams("session-trusted-mcp-renderer");

    await manager.start(params);
    await manager.prompt({
      session_id: params.session_id,
      turn_id: "turn-mcp",
      text: "inspect canvas",
    });

    try {
      const events = sent
        .filter(
          (
            message,
          ): message is Extract<ManagerOut, { type: "session.event" }> =>
            message.type === "session.event",
        )
        .map((message) => message.event);
      expect(events).toEqual([
        expect.objectContaining({
          toolCallId: "bundled-clash",
          _meta: expect.objectContaining({
            "clash.host_trusted_mcp": true,
            "clash.renderer": "product",
          }),
        }),
        expect.objectContaining({
          toolCallId: "other-mcp",
          _meta: { is_mcp_tool_call: true },
        }),
      ]);
    } finally {
      await manager.dispose(params.session_id);
    }
  });

  it("coalesces concurrent starts for one session into one ACP child", async () => {
    const started = deferred<AcpSession>();
    const session = createAcpSession();
    mocks.runtimeStart.mockReturnValue(started.promise);
    const sent: ManagerOut[] = [];
    const manager = new SessionManager((message) => sent.push(message));
    const params = sessionParams("session-coalesced-start");

    const first = manager.start(params);
    const second = manager.start(params);
    await vi.waitFor(() => expect(mocks.runtimeStart).toHaveBeenCalled());
    await nextTask();
    const startCount = mocks.runtimeStart.mock.calls.length;
    started.resolve(session);
    await Promise.all([first, second]);

    try {
      expect(startCount).toBe(1);
      expect(
        sent.filter((message) => message.type === "session.ready"),
      ).toHaveLength(1);
      expect(sent.some((message) => message.type === "session.error")).toBe(
        false,
      );
    } finally {
      await manager.dispose(params.session_id);
    }
  });

  it("lets dispose dominate an in-flight start and reaps the late ACP child", async () => {
    const started = deferred<AcpSession>();
    const dispose = vi.fn(async () => undefined);
    mocks.runtimeStart.mockReturnValue(started.promise);
    const sent: ManagerOut[] = [];
    const manager = new SessionManager((message) => sent.push(message));
    const params = sessionParams("session-disposed-during-start");

    const starting = manager.start(params);
    await vi.waitFor(() => expect(mocks.runtimeStart).toHaveBeenCalledOnce());
    const disposing = manager.dispose(params.session_id);
    started.resolve(createAcpSession({ dispose }));
    await Promise.all([starting, disposing]);

    try {
      expect(dispose).toHaveBeenCalledOnce();
      expect(manager.has(params.session_id)).toBe(false);
      expect(sent.some((message) => message.type === "session.ready")).toBe(
        false,
      );
      expect(
        sent.filter((message) => message.type === "session.disposed"),
      ).toHaveLength(1);
    } finally {
      await manager.dispose(params.session_id);
    }
  });

  it("serializes prompts within one ACP session", async () => {
    const promptReleases: Array<Deferred<void>> = [];
    const promptInputs: unknown[] = [];
    const session = createAcpSession({
      prompt(input) {
        promptInputs.push(input);
        const release = deferred<void>();
        promptReleases.push(release);
        return (async function* () {
          await release.promise;
        })();
      },
    });
    mocks.runtimeStart.mockResolvedValue(session);
    const manager = new SessionManager(() => undefined);
    const params = sessionParams("session-serialized-prompts");
    await manager.start(params);

    const first = manager.prompt({
      session_id: params.session_id,
      turn_id: "turn-1",
      text: "first",
    });
    await vi.waitFor(() => expect(promptInputs).toHaveLength(1));
    const second = manager.prompt({
      session_id: params.session_id,
      turn_id: "turn-2",
      text: "second",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    const concurrentPromptCount = promptInputs.length;
    promptReleases[0]!.resolve();
    await vi.waitFor(() => expect(promptInputs).toHaveLength(2));
    promptReleases[1]!.resolve();
    await Promise.all([first, second]);

    try {
      expect(concurrentPromptCount).toBe(1);
    } finally {
      await manager.dispose(params.session_id);
    }
  });

  it("emits no late turn completion after disposal", async () => {
    const promptDone = deferred<void>();
    const session = createAcpSession({
      prompt() {
        return (async function* () {
          await promptDone.promise;
        })();
      },
    });
    mocks.runtimeStart.mockResolvedValue(session);
    const sent: ManagerOut[] = [];
    const manager = new SessionManager((message) => sent.push(message));
    const params = sessionParams("session-dispose-dominates-turn");
    await manager.start(params);

    const prompting = manager.prompt({
      session_id: params.session_id,
      turn_id: "turn-disposed",
      text: "keep working",
    });
    await nextTask();
    await manager.dispose(params.session_id);
    promptDone.resolve();
    await prompting;

    const disposedAt = sent.findIndex(
      (message) => message.type === "session.disposed",
    );
    expect(disposedAt).toBeGreaterThanOrEqual(0);
    expect(sent.slice(disposedAt + 1)).not.toContainEqual(
      expect.objectContaining({
        type: expect.stringMatching(/^session\.(complete|error)$/),
        turn_id: "turn-disposed",
      }),
    );
  });

  it("keeps disposeAll pending until in-flight starts are reaped", async () => {
    const started = deferred<AcpSession>();
    const dispose = vi.fn(async () => undefined);
    mocks.runtimeStart.mockReturnValue(started.promise);
    const sent: ManagerOut[] = [];
    const manager = new SessionManager((message) => sent.push(message));
    const params = sessionParams("session-shutdown-during-start");

    const starting = manager.start(params);
    await vi.waitFor(() => expect(mocks.runtimeStart).toHaveBeenCalledOnce());
    let shutdownSettled = false;
    const shutdown = manager.disposeAll().then(() => {
      shutdownSettled = true;
    });
    await nextTask();
    const settledBeforeStartResolved = shutdownSettled;
    started.resolve(createAcpSession({ dispose }));
    await Promise.all([starting, shutdown]);

    expect(settledBeforeStartResolved).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.has(params.session_id)).toBe(false);
    expect(sent.some((message) => message.type === "session.ready")).toBe(
      false,
    );
  });
});
