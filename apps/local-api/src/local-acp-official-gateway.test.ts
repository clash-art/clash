import { describe, expect, it, vi } from "vitest";
import { createLocalAcpAdapter, type SessionSender } from "./local-acp.js";
import type { OfficialGatewaySessionHook } from "./official-gateway.js";

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, Array<(data?: unknown) => void>>();
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  on(event: string, listener: (data?: unknown) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
}

/** The OpenAI-shaped body the gateway answers with (apps/docs/guide/gateway-data-plane.md). */
function gatewayFailure(status: number, code: string) {
  return `unexpected status ${status}: ${JSON.stringify({
    error: { message: "…", type: "server_error", param: null, code },
  })}`;
}

function hook(overrides: Partial<OfficialGatewaySessionHook> = {}) {
  return {
    prepareSession: vi.fn<OfficialGatewaySessionHook["prepareSession"]>(async () => ({})),
    hasHandoff: vi.fn<OfficialGatewaySessionHook["hasHandoff"]>(() => true),
    onUnauthorized: vi.fn<OfficialGatewaySessionHook["onUnauthorized"]>(async () => null),
    ...overrides,
  };
}

async function startSession(officialGateway: OfficialGatewaySessionHook, sessionId = "gw-session") {
  const senders: SessionSender[] = [];
  const createSessionManager = vi.fn((send: SessionSender) => {
    senders.push(send);
    return { start: vi.fn(), prompt: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
  });
  const adapter = createLocalAcpAdapter({
    detectAgents: async () => [{ id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } }],
    createSessionId: () => sessionId,
    createSessionManager,
    officialGateway,
  });
  await adapter.createSession({ runtimeId: "desktop-local", agentId: "codex-acp" });
  const socket = new FakeSocket();
  adapter.bindSessionSocket(sessionId, socket as never);
  const errors = () =>
    socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg.type === "session.error");
  return { adapter, senders, createSessionManager, socket, errors };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("local ACP sessions on the Clash official provider", () => {
  it("asks the official gateway to prepare the agent before the session starts", async () => {
    const officialGateway = hook();
    await startSession(officialGateway);
    expect(officialGateway.prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "codex-acp" }),
    );
  });

  it.each(["GATEWAY_MODEL_NOT_ALLOWED", "GATEWAY_BUDGET_EXCEEDED"])(
    "surfaces %s as a coded error without re-minting",
    async (code) => {
      const officialGateway = hook();
      const session = await startSession(officialGateway);
      session.senders[0]!({
        type: "session.error",
        session_id: "gw-session",
        turn_id: "t1",
        message: gatewayFailure(code === "GATEWAY_BUDGET_EXCEEDED" ? 402 : 403, code),
      });
      await tick();
      const [error] = session.errors();
      expect(error).toMatchObject({ code, gateway_code: code, agent_id: "codex-acp", turn_id: "t1" });
      expect(String(error?.message).startsWith(`${code}: `)).toBe(true);
      expect(officialGateway.onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it("re-mints once on GATEWAY_TOKEN_EXPIRED and restarts the agent on the new token", async () => {
    const officialGateway = hook();
    const session = await startSession(officialGateway);
    const expired = {
      type: "session.error" as const,
      session_id: "gw-session",
      message: gatewayFailure(401, "GATEWAY_TOKEN_EXPIRED"),
    };
    session.senders[0]!(expired);
    session.senders[0]!(expired);
    await vi.waitFor(() => expect(session.createSessionManager).toHaveBeenCalledTimes(2));

    expect(officialGateway.onUnauthorized).toHaveBeenCalledOnce();
    expect(officialGateway.onUnauthorized).toHaveBeenCalledWith("codex-acp");
    expect(session.errors()[0]).toMatchObject({
      code: "GATEWAY_TOKEN_EXPIRED",
      gateway_code: "GATEWAY_TOKEN_EXPIRED",
    });
  });

  it("treats a bare 401 on an official handoff as an expired gateway token", async () => {
    const officialGateway = hook();
    const session = await startSession(officialGateway);
    session.senders[0]!({ type: "session.error", session_id: "gw-session", message: "401 Unauthorized" });
    await vi.waitFor(() => expect(officialGateway.onUnauthorized).toHaveBeenCalledOnce());
    expect(session.errors()[0]).toMatchObject({ gateway_code: "GATEWAY_TOKEN_EXPIRED" });
  });

  it("leaves a bare 401 alone when the agent uses its own credential", async () => {
    const officialGateway = hook({ hasHandoff: vi.fn(() => false) });
    const session = await startSession(officialGateway);
    session.senders[0]!({ type: "session.error", session_id: "gw-session", message: "401 Unauthorized" });
    await tick();
    expect(session.errors()[0]).not.toHaveProperty("gateway_code");
    expect(officialGateway.onUnauthorized).not.toHaveBeenCalled();
  });

  it("reports GATEWAY_AUTH_REQUIRED when the re-mint is impossible (signed out or offline)", async () => {
    const officialGateway = hook({ onUnauthorized: vi.fn(async () => "GATEWAY_AUTH_REQUIRED" as const) });
    const session = await startSession(officialGateway);
    session.senders[0]!({
      type: "session.error",
      session_id: "gw-session",
      message: gatewayFailure(401, "GATEWAY_TOKEN_REVOKED"),
    });
    await vi.waitFor(() => expect(session.errors()).toHaveLength(2));
    expect(session.errors()[1]).toMatchObject({
      code: "GATEWAY_AUTH_REQUIRED",
      gateway_code: "GATEWAY_AUTH_REQUIRED",
    });
    expect(session.createSessionManager).toHaveBeenCalledOnce();
    expect(officialGateway.onUnauthorized).toHaveBeenCalledOnce();
  });

  it("codes the start-up auth error when official-first has no sign-in", async () => {
    const officialGateway = hook({
      hasHandoff: vi.fn(() => false),
      prepareSession: vi.fn(async () => ({ gatewayCode: "GATEWAY_AUTH_REQUIRED" as const })),
    });
    const createSessionManager = vi.fn(() => ({
      start: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    }));
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [{ id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } }],
      probeAgentAuth: async () => ({ status: "needs-auth", message: "Sign in" }),
      createSessionId: () => "gw-needs-auth",
      createSessionManager,
      officialGateway,
    });
    await expect(
      adapter.createSession({ runtimeId: "desktop-local", agentId: "codex-acp" }),
    ).rejects.toThrow(/^GATEWAY_AUTH_REQUIRED: /);
    expect(officialGateway.prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "codex-acp" }),
    );
    expect(createSessionManager).not.toHaveBeenCalled();
  });

  it("starts the agent after the official provider hands off to an agent with no key", async () => {
    let handedOff = false;
    const officialGateway = hook({
      prepareSession: vi.fn(async () => {
        handedOff = true;
        return { handedOff: true };
      }),
    });
    const createSessionManager = vi.fn(() => ({
      start: vi.fn(),
      prompt: vi.fn(),
      cancel: vi.fn(),
      dispose: vi.fn(),
    }));
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [{ id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } }],
      probeAgentAuth: async () =>
        handedOff
          ? { status: "configured", message: "" }
          : { status: "needs-auth", message: "Sign in" },
      createSessionId: () => "gw-handed-off",
      createSessionManager,
      officialGateway,
    });
    await expect(
      adapter.createSession({ runtimeId: "desktop-local", agentId: "codex-acp" }),
    ).resolves.toMatchObject({ session_id: "gw-handed-off" });
    expect(officialGateway.prepareSession).toHaveBeenCalledOnce();
    expect(createSessionManager).toHaveBeenCalledOnce();
  });
});
