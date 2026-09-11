// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useClashRuntime } from "./useClashRuntime";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("useClashRuntime", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
    FakeWebSocket.instances = [];
    window.localStorage.clear();
  });

  it("surfaces an installed harness update and restarts a busy session after its turn", async () => {
    const restartModes: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-update" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (
          url.endsWith(
            "/api/v1/local-sessions/local-session-update/runtime-status",
          )
        ) {
          return new Response(
            JSON.stringify({
              session_id: "local-session-update",
              harness_id: "codex-acp",
              harness_label: "Codex",
              running_version: "1.0.1",
              installed_version: "1.0.2",
              restart_required: true,
              busy: true,
              restart_pending: restartModes.includes("after-turn"),
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-update/restart") &&
          init?.method === "POST"
        ) {
          const mode = (JSON.parse(String(init.body)) as { mode: string }).mode;
          restartModes.push(mode);
          return new Response(
            JSON.stringify({
              session_id: "local-session-update",
              status: mode === "after-turn" ? "pending" : "restarted",
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });
    await waitFor(() =>
      expect(result.current.sessionRuntimeStatus).toMatchObject({
        installed_version: "1.0.2",
        restart_required: true,
        busy: true,
      }),
    );

    await act(async () => {
      await result.current.restartSession("after-turn");
    });
    expect(result.current.sessionRestartPhase).toBe("pending");
    expect(restartModes).toEqual(["after-turn"]);

    const firstSocket = FakeWebSocket.instances.at(-1)!;
    act(() => {
      firstSocket.onmessage?.({
        data: JSON.stringify({
          type: "session.restart_ready",
          session_id: "local-session-update",
        }),
      });
    });

    await waitFor(() => {
      expect(restartModes).toEqual(["after-turn", "now"]);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(result.current.sessionRestartPhase).toBe("complete");
    });
  });

  it("uses the server-owned startup readiness barrier when loading runtimes", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ runtimes: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    renderHook(() => useClashRuntime());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          !init?.method && String(input).endsWith("/api/v1/runtimes"),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => !init?.method && String(input).includes("probe="),
      ),
    ).toBe(false);
  });

  it("keeps the startup snapshot pending until the server readiness barrier settles", async () => {
    let resolveSnapshot!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.startupStatus).toBe("loading");

    await act(async () => {
      resolveSnapshot(
        new Response(JSON.stringify({ runtimes: [] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    });

    await waitFor(() => expect(result.current.startupStatus).toBe("ready"));
  });

  it("restores only valid recent choices from the startup snapshot and records the effective run", async () => {
    let createBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(
            JSON.stringify({
              runtimes: [
                {
                  id: "desktop-local",
                  machine_id: "desktop-local",
                  hostname: "local",
                  os: "darwin",
                  version: "desktop",
                  status: "online",
                  last_heartbeat: 1,
                  created_at: 1,
                  preferences: {
                    agent_id: "codex-acp",
                    config_by_agent: {
                      "codex-acp": {
                        model: "gpt-5.6-terra",
                        effort: "removed",
                        "fast-mode": true,
                      },
                    },
                    mode_by_agent: {
                      "codex-acp": "plan",
                    },
                  },
                  agents: [
                    {
                      id: "claude-acp",
                      config_options: [],
                    },
                    {
                      id: "codex-acp",
                      config_options: [
                        {
                          id: "model",
                          name: "Model",
                          type: "select",
                          category: "model",
                          currentValue: "gpt-5.6-sol",
                          options: [
                            { value: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
                            { value: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
                          ],
                        },
                        {
                          id: "effort",
                          name: "Effort",
                          type: "select",
                          category: "thought_level",
                          currentValue: "medium",
                          options: [
                            { value: "medium", name: "Medium" },
                            { value: "high", name: "High" },
                          ],
                        },
                        {
                          id: "fast-mode",
                          name: "Fast mode",
                          type: "boolean",
                          currentValue: false,
                        },
                      ],
                      session_modes: {
                        currentModeId: "default",
                        availableModes: [
                          { id: "default", name: "Default" },
                          { id: "plan", name: "Plan" },
                        ],
                      },
                    },
                  ],
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({ session_id: "recent-session" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await waitFor(() => expect(result.current.runtimes).toHaveLength(1));

    act(() => {
      result.current.startDraft("desktop-local", undefined, {
        projectId: "project-one",
      });
    });

    expect(result.current.selectedAgentId).toBe("codex-acp");
    expect(result.current.sessionConfigOptions).toEqual([
      expect.objectContaining({ id: "model", currentValue: "gpt-5.6-terra" }),
      expect.objectContaining({ id: "effort", currentValue: "medium" }),
      expect.objectContaining({ id: "fast-mode", currentValue: true }),
    ]);
    expect(result.current.sessionModes?.currentModeId).toBe("plan");

    act(() => {
      result.current.sendMessage("hello");
    });
    await waitFor(() => expect(createBody).not.toBeNull());
    expect(createBody).toMatchObject({
      agent_id: "codex-acp",
      permission_mode: "plan",
      config_values: {
        model: "gpt-5.6-terra",
        effort: "medium",
        "fast-mode": true,
      },
    });
  });

  it("rejects an explicit refresh when the runtime snapshot cannot be loaded", async () => {
    let requestCount = 0;
    const fetchMock = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ runtimes: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("startup snapshot unavailable", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await waitFor(() => expect(requestCount).toBe(1));

    await expect(result.current.refresh()).rejects.toThrow(
      "Runtime snapshot request failed: HTTP 503",
    );
  });

  it("keeps ACP permission requests out of the transcript and sends the selected option", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-permission" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.permission_request",
          session_id: "local-session-permission",
          request_id: "permission-1",
          tool_call: { toolCallId: "tool-1", title: "Edit file" },
          options: [
            { optionId: "reject", name: "Reject", kind: "reject_once" },
            { optionId: "allow", name: "Allow", kind: "allow_once" },
          ],
        }),
      });
    });

    expect(result.current.permissionRequests).toEqual([
      {
        requestId: "permission-1",
        sessionId: "local-session-permission",
        toolCall: { toolCallId: "tool-1", title: "Edit file" },
        options: [
          { optionId: "reject", name: "Reject", kind: "reject_once" },
          { optionId: "allow", name: "Allow", kind: "allow_once" },
        ],
      },
    ]);
    expect(result.current.messages).toEqual([]);

    act(() => {
      result.current.respondPermission("permission-1", "allow");
    });

    expect(ws.sent.map((frame) => JSON.parse(frame))).toContainEqual({
      type: "permission_response",
      request_id: "permission-1",
      option_id: "allow",
    });
    expect(result.current.permissionRequests).toHaveLength(1);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.permission_resolved",
          session_id: "local-session-permission",
          request_id: "permission-1",
        }),
      });
    });
    expect(result.current.permissionRequests).toEqual([]);
  });

  it("keeps ACP elicitation out of the transcript and sends a structured response", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-elicitation" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.elicitation_request",
          session_id: "local-session-elicitation",
          request_id: "elicitation-1",
          mode: "form",
          message: "Choose release settings",
          requested_schema: {
            type: "object",
            properties: {
              channel: { type: "string", enum: ["stable", "preview"] },
            },
            required: ["channel"],
          },
        }),
      });
    });

    expect(result.current.elicitationRequests).toHaveLength(1);
    expect(result.current.messages).toEqual([]);
    act(() => {
      result.current.respondElicitation("elicitation-1", {
        action: "accept",
        content: { channel: "stable" },
      });
    });
    expect(ws.sent.map((frame) => JSON.parse(frame))).toContainEqual({
      type: "elicitation_response",
      request_id: "elicitation-1",
      action: "accept",
      content: { channel: "stable" },
    });
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.elicitation_resolved",
          session_id: "local-session-elicitation",
          request_id: "elicitation-1",
          mode: "form",
          message: "Choose release settings",
          requested_schema: {
            type: "object",
            properties: {
              channel: { type: "string", enum: ["stable", "preview"] },
            },
            required: ["channel"],
          },
          action: "accept",
          content: { channel: "stable" },
        }),
      });
    });
    expect(result.current.elicitationRequests).toEqual([]);
    expect(result.current).not.toHaveProperty("elicitationReceipts");
  });

  it("keeps ACP URL elicitation out of the transcript and sends the user's decision", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-url-elicitation" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });
    const ws = FakeWebSocket.instances.at(-1)!;

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.elicitation_request",
          session_id: "local-session-url-elicitation",
          request_id: "url-elicitation-1",
          mode: "url",
          message: "Sign in with GitHub",
          elicitation_id: "github-oauth-1",
          url: "https://github.com/login/oauth/authorize?client_id=clash",
        }),
      });
    });

    expect(result.current.elicitationRequests).toEqual([
      {
        requestId: "url-elicitation-1",
        sessionId: "local-session-url-elicitation",
        mode: "url",
        message: "Sign in with GitHub",
        elicitationId: "github-oauth-1",
        url: "https://github.com/login/oauth/authorize?client_id=clash",
      },
    ]);
    expect(result.current.messages).toEqual([]);

    act(() =>
      result.current.respondElicitation("url-elicitation-1", {
        action: "accept",
      }),
    );
    expect(ws.sent.map((frame) => JSON.parse(frame))).toContainEqual({
      type: "elicitation_response",
      request_id: "url-elicitation-1",
      action: "accept",
    });
  });

  it("replaces stale draft config when a fresh startup probe completes", async () => {
    let runtimeRead = 0;
    const runtimeWithModel = (value: string, name: string) => ({
      runtimes: [
        {
          id: "desktop-local",
          machine_id: "desktop-local",
          hostname: "local",
          os: "darwin",
          version: "desktop",
          status: "online",
          last_heartbeat: 1,
          created_at: 1,
          agents: [
            {
              id: "codex-acp",
              label: "Codex",
              config_options: [
                {
                  id: "model",
                  name: "Model",
                  type: "select",
                  category: "model",
                  currentValue: value,
                  options: [{ value, name }],
                },
                {
                  id: "fast-mode",
                  name: "Fast mode",
                  type: "boolean",
                  currentValue: true,
                },
              ],
            },
          ],
        },
      ],
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!init?.method && String(input).includes("/api/v1/runtimes")) {
          runtimeRead += 1;
          const payload =
            runtimeRead === 1
              ? runtimeWithModel("gpt-5.5", "GPT-5.5")
              : runtimeWithModel("gpt-5.6-sol", "GPT-5.6-Sol");
          return new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await waitFor(() => {
      expect(
        result.current.runtimes[0]?.agents[0]?.config_options?.[0]
          ?.currentValue,
      ).toBe("gpt-5.5");
    });

    act(() => {
      result.current.startDraft("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-one",
      });
    });
    expect(result.current.sessionConfigOptions[0]?.currentValue).toBe(
      "gpt-5.5",
    );
    act(() => {
      result.current.setConfigOption("fast-mode", false);
    });

    await act(async () => {
      await result.current.refresh({ probe: "config", refresh: true });
    });

    expect(
      result.current.runtimes[0]?.agents[0]?.config_options?.[0]?.currentValue,
    ).toBe("gpt-5.6-sol");
    expect(result.current.sessionConfigOptions[0]?.currentValue).toBe(
      "gpt-5.6-sol",
    );
    expect(
      result.current.sessionConfigOptions.find(
        (option) => option.id === "fast-mode",
      )?.currentValue,
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
  });

  it("prepares a runtime draft without creating a local session", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    act(() => {
      result.current.startDraft("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-one",
        permissionModeId: "codex:full-access",
      });
    });

    expect(result.current.status).toBe("draft");
    expect(result.current.ready).toBe(false);
    expect(result.current.selectedRuntimeId).toBe("desktop-local");
    expect(result.current.selectedAgentId).toBe("codex-acp");
    expect(result.current.sessionId).toBeNull();
    expect(result.current.currentSession).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("seeds slash commands from the cold-start runtime snapshot without creating a session", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(
            JSON.stringify({
              runtimes: [
                {
                  id: "desktop-local",
                  machine_id: "desktop-local",
                  hostname: "This Mac",
                  os: "darwin/arm64",
                  version: "desktop",
                  status: "online",
                  created_at: 1,
                  last_heartbeat: 1,
                  agents: [
                    {
                      id: "codex-acp",
                      label: "Codex",
                      available_commands: [
                        {
                          name: "review",
                          description: "Review the current project",
                          _meta: {
                            commandAction: {
                              kind: "prefixPrompt",
                              presentation: "state",
                            },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await waitFor(() => expect(result.current.runtimes).toHaveLength(1));
    act(() => {
      result.current.startDraft("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    expect(result.current.availableCommands).toEqual([
      {
        name: "review",
        description: "Review the current project",
        _meta: {
          commandAction: {
            kind: "prefixPrompt",
            presentation: "state",
          },
        },
      },
    ]);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
  });

  it("creates a local session from a draft only after the first prompt and sends after ready", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-draft" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    act(() => {
      result.current.startDraft("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-one",
      });
      result.current.sendMessage("hi");
    });

    await waitFor(() => {
      expect(result.current.sessionId).toBe("local-session-draft");
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      agent_id: "codex-acp",
      project_id: "project-one",
    });
    await waitFor(() => {
      expect(result.current.messages).toEqual([
        {
          id: expect.stringMatching(/^user-t-/),
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
      ]);
    });
    expect(result.current.status).toBe("connecting");

    const ws = FakeWebSocket.instances.at(-1)!;
    expect(ws.sent).toEqual([]);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-draft",
          acp_session_id: "acp-draft-one",
          model_fallback: { from: "future", to: "supported" },
          supports_session_fork: true,
        }),
      });
    });

    expect(result.current.modelFallback).toEqual({ from: "future", to: "supported" });
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: "prompt",
      turn_id: expect.stringMatching(/^t-/),
      text: "hi",
    });
    expect(result.current.messages).toEqual([
      {
        id: expect.stringMatching(/^user-t-/),
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      },
    ]);
    expect(result.current.status).toBe("sending");
    expect(result.current.currentSession).toMatchObject({
      id: "local-session-draft",
      threadId: "local-session-draft",
      runtimeId: "desktop-local",
      agentId: "codex-acp",
      projectId: "project-one",
      acpSessionId: "acp-draft-one",
      supportsSessionFork: true,
    });
  });

  it("reconnects a draft-created session for a follow-up instead of creating a second session", async () => {
    let createCalls = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return Response.json({ runtimes: [] });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          createCalls += 1;
          return Response.json({ session_id: `local-session-${createCalls}` });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    act(() => {
      result.current.startDraft("desktop-local", undefined, {
        agentId: "codex-acp",
      });
      result.current.sendMessage("first");
    });

    await waitFor(() =>
      expect(result.current.sessionId).toBe("local-session-1"),
    );
    const firstSocket = FakeWebSocket.instances.at(-1)!;
    act(() => {
      firstSocket.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-1",
          acp_session_id: "acp-session-1",
        }),
      });
    });
    const firstPrompt = JSON.parse(firstSocket.sent.at(-1)!);
    act(() => {
      firstSocket.onmessage?.({
        data: JSON.stringify({
          type: "session.complete",
          session_id: "local-session-1",
          turn_id: firstPrompt.turn_id,
        }),
      });
      firstSocket.close();
      result.current.sendMessage("follow up");
    });

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(createCalls).toBe(1);
    expect(result.current.sessionId).toBe("local-session-1");
    const reconnect = FakeWebSocket.instances.at(-1)!;
    expect(reconnect.url).toContain("/local-session-1/_stream");

    act(() => {
      reconnect.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-1",
          acp_session_id: "acp-session-1",
        }),
      });
    });
    expect(
      reconnect.sent.map((frame) => JSON.parse(frame).text).filter(Boolean),
    ).toEqual(["follow up"]);
    expect(
      result.current.messages
        .filter((message) => message.role === "user")
        .map((message) => message.parts[0]),
    ).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "follow up" },
    ]);
  });

  it("restores the in-memory transcript when switching back to an attached session", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return Response.json({ runtimes: [] });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return Response.json({ session_id: "session-one" });
        }
        if (url.endsWith("/_attach") && init?.method === "POST") {
          return Response.json({ attached: true });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });
    const firstSocket = FakeWebSocket.instances.at(-1)!;
    act(() => {
      firstSocket.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "session-one",
          acp_session_id: "acp-one",
        }),
      });
      result.current.sendMessage("remember this");
    });
    const prompt = JSON.parse(firstSocket.sent.at(-1)!);
    act(() => {
      firstSocket.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "session-one",
          turn_id: prompt.turn_id,
          event: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "remembered" },
          },
        }),
      });
      firstSocket.onmessage?.({
        data: JSON.stringify({
          type: "session.complete",
          session_id: "session-one",
          turn_id: prompt.turn_id,
        }),
      });
    });

    const firstSession = result.current.currentSession!;
    await act(async () => {
      await result.current.attachSession({
        id: "session-two",
        threadId: "session-two",
        type: "runtime",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
        status: "active",
      });
    });
    expect(result.current.messages).toEqual([]);

    await act(async () => {
      await result.current.attachSession(firstSession);
    });
    expect(
      result.current.messages.map((message) => ({
        role: message.role,
        text: message.parts.map((part: any) => part.text ?? "").join(""),
      })),
    ).toEqual([
      { role: "user", text: "remember this" },
      { role: "assistant", text: "remembered" },
    ]);
  });

  it("keeps an attached session visibly running while session.ready is pending", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return Response.json({ runtimes: [] });
        }
        if (url.endsWith("/_attach") && init?.method === "POST") {
          return Response.json({ attached: true });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.attachSession({
        id: "session-pending-ready",
        threadId: "session-pending-ready",
        type: "runtime",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
        status: "active",
      });
    });

    act(() => {
      result.current.sendMessage("do not look stuck");
    });

    const activeTurnId = result.current.agentUIState.activeTurnId;
    expect(activeTurnId).toBeTruthy();
    expect(result.current.agentUIState.turns[activeTurnId!]?.status).toBe(
      "running",
    );
    expect(FakeWebSocket.instances.at(-1)?.sent).toEqual([]);
  });

  it("shows the runtime create error field from structured local API failures", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({
              error:
                "No local agent found. Install or enable an agent in Settings > Runtimes, then retry.",
              mutation: {
                operation: "runtime_session_create",
                entity: { kind: "session", id: "" },
                accepted: false,
              },
            }),
            {
              status: 503,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe(
      "session create failed: No local agent found. Install or enable an agent in Settings > Runtimes, then retry.",
    );
  });

  it("keeps streamed Cursor assistant chunks as live authority through completion", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-cursor" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    act(() => {
      result.current.startDraft("desktop-local", undefined, {
        agentId: "cursor",
        projectId: "project-one",
      });
      result.current.sendMessage("Reply exactly: pong");
    });

    await waitFor(() => {
      expect(result.current.sessionId).toBe("local-session-cursor");
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-cursor",
          acp_session_id: "cursor-acp-session",
        }),
      });
    });

    const prompt = JSON.parse(
      ws.sent.find((frame) => JSON.parse(frame).type === "prompt")!,
    );
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-cursor",
          turn_id: prompt.turn_id,
          event: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "p" },
          },
        }),
      });
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-cursor",
          turn_id: prompt.turn_id,
          event: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ong" },
          },
        }),
      });
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.complete",
          session_id: "local-session-cursor",
          turn_id: prompt.turn_id,
        }),
      });
    });

    expect(result.current.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(result.current.messages.at(1)?.parts).toEqual([
      { type: "text", text: "pong" },
    ]);
  });

  it("keeps streamed assistant text when persisted history is still lagging at session complete", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-lagging-history" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    act(() => {
      result.current.startDraft("desktop-local", undefined, {
        agentId: "mock-acp",
        projectId: "project-one",
      });
      result.current.sendMessage("hello");
    });

    await waitFor(() =>
      expect(result.current.sessionId).toBe("local-session-lagging-history"),
    );
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-lagging-history",
          acp_session_id: "mock-acp-session",
        }),
      });
    });
    const prompt = JSON.parse(
      ws.sent.find((frame) => JSON.parse(frame).type === "prompt")!,
    );

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-lagging-history",
          turn_id: prompt.turn_id,
          event: { type: "text", text: "Mock ACP reply: hello" },
        }),
      });
    });
    expect(result.current.messages.at(-1)?.parts).toEqual([
      { type: "text", text: "Mock ACP reply: hello" },
    ]);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.complete",
          session_id: "local-session-lagging-history",
          turn_id: prompt.turn_id,
        }),
      });
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith(
          "/api/v1/local-sessions/local-session-lagging-history/events",
        ),
      ),
    ).toBe(false);
    expect(result.current.messages.at(-1)?.parts).toEqual([
      { type: "text", text: "Mock ACP reply: hello" },
    ]);
  });

  it("sends an explicit local ACP agent override when selecting a runtime", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-agent" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-agent",
      });
    });

    await waitFor(() => {
      const sessionCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "POST",
      );
      expect(sessionCall).toBeTruthy();
      expect(JSON.parse(String(sessionCall?.[1]?.body))).toEqual({
        agent_id: "codex-acp",
        project_id: "project-agent",
      });
      expect(result.current.selectedAgentId).toBe("codex-acp");
    });
  });

  it("keeps public agent authentication fields in the runtime snapshot", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            runtimes: [
              {
                id: "desktop-local",
                machine_id: "desktop-local",
                hostname: "This Mac",
                os: "darwin/arm64",
                version: "desktop",
                status: "online",
                created_at: 1,
                agents: [
                  {
                    id: "codex-acp",
                    auth: {
                      status: "needs-auth",
                      message: "Enter an API key.",
                      methods: [
                        {
                          id: "api-key",
                          name: "API key",
                          type: "agent",
                          form: "fields",
                          vars: [
                            { name: "api-key", label: "API key", secret: true },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useClashRuntime());

    await waitFor(() =>
      expect(result.current.runtimes[0]?.agents[0]?.auth?.methods).toEqual([
        {
          id: "api-key",
          name: "API key",
          type: "agent",
          form: "fields",
          vars: [{ name: "api-key", label: "API key", secret: true }],
        },
      ]),
    );
  });

  it("recovers without a transcript error when a session reports an ACP authentication failure", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/runtimes?") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-auth-needed" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "cursor",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.error",
          session_id: "local-session-auth-needed",
          agent_id: "cursor",
          message:
            "Authentication required: token=topsecret Bearer sk-secretvalue123",
          auth: {
            status: "needs-auth",
            message: "Cursor requires ACP authentication.",
            command: "clash-acp-cursor",
          },
        }),
      });
    });

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/v1/runtimes?probe=config&refresh=1"),
        ),
      ).toBe(true),
    );
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.status).toBe("connected");
  });

  it("refreshes runtime probes when session creation is blocked by auth", async () => {
    const runtimePayload = {
      runtimes: [
        {
          id: "desktop-local",
          machine_id: "desktop-local",
          hostname: "This Mac",
          os: "darwin/arm64",
          agents: [{ id: "devin", label: "Devin", binary: "clash-acp-devin" }],
          version: "desktop",
          status: "online",
          last_heartbeat: 1,
          created_at: 1,
        },
      ],
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/runtimes?") && !init?.method) {
          return new Response(JSON.stringify(runtimePayload), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify(runtimePayload), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            "Devin needs authentication before ACP can start.",
            { status: 503 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "devin",
      });
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toContain(
      "Devin needs authentication before ACP can start.",
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/v1/runtimes?probe=config&refresh=1"),
        ),
      ).toBe(true),
    );
  });

  it("tracks ACP session config options and sends native config updates", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-config" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-config",
          config_options: [
            {
              id: "model",
              name: "Model",
              type: "select",
              category: "model",
              currentValue: "gpt-5.5",
              options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
            },
            {
              id: "fast-mode",
              name: "Fast mode",
              type: "boolean",
              currentValue: true,
            },
            {
              id: "collaboration_mode",
              name: "Collaboration mode",
              type: "select",
              currentValue: "plan",
              options: [
                { value: "default", name: "Default" },
                { value: "plan", name: "Plan" },
              ],
            },
          ],
        }),
      });
    });

    expect(result.current.sessionConfigOptions).toHaveLength(3);
    expect(result.current.sessionConfigOptions[0]?.category).toBe("model");
    expect(result.current.sessionConfigOptions[1]?.currentValue).toBe(true);

    act(() => {
      result.current.setConfigOption("model", "gpt-5.4");
    });

    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: "set_config_option",
      config_id: "model",
      value: "gpt-5.4",
    });

    act(() => {
      result.current.setConfigOption("fast-mode", false);
    });

    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: "set_config_option",
      config_id: "fast-mode",
      value: false,
    });

    act(() => {
      result.current.setConfigOption("collaboration_mode", "default");
    });
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: "set_config_option",
      config_id: "collaboration_mode",
      value: "default",
    });
    expect(
      result.current.sessionConfigOptions.find(
        (option) => option.id === "collaboration_mode",
      )?.currentValue,
    ).toBe("plan");

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.config_options",
          session_id: "local-session-config",
          config_options: [
            {
              id: "collaboration_mode",
              name: "Collaboration mode",
              type: "select",
              currentValue: "default",
              options: [
                { value: "default", name: "Default" },
                { value: "plan", name: "Plan" },
              ],
            },
          ],
        }),
      });
    });
    expect(
      result.current.sessionConfigOptions.find(
        (option) => option.id === "collaboration_mode",
      )?.currentValue,
    ).toBe("default");
  });

  it("tracks ACP session modes and sends native mode updates", async () => {
    const modes = {
      currentModeId: "ask",
      availableModes: [
        { id: "ask", name: "Ask" },
        { id: "code", name: "Code" },
      ],
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/runtimes") && !init?.method) {
          return new Response(
            JSON.stringify({
              runtimes: [
                {
                  id: "desktop-local",
                  machine_id: "desktop-local",
                  hostname: "local",
                  os: "darwin",
                  version: "desktop",
                  status: "online",
                  last_heartbeat: 1,
                  created_at: 1,
                  agents: [
                    { id: "codex-acp", label: "Codex", session_modes: modes },
                  ],
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-mode" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await waitFor(() => {
      expect(result.current.runtimes[0]?.agents[0]?.session_modes).toEqual(
        modes,
      );
    });

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-mode",
          modes,
        }),
      });
    });
    expect(result.current.sessionModes).toEqual(modes);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.mode",
          session_id: "local-session-mode",
          modes: { ...modes, currentModeId: "code" },
        }),
      });
    });
    expect(result.current.sessionModes?.currentModeId).toBe("code");

    act(() => {
      result.current.setSessionMode("ask");
    });
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: "set_session_mode",
      mode_id: "ask",
    });
  });

  it("can cancel a prompt before the agent emits the first event", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-cancel" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-cancel",
        }),
      });
    });
    act(() => {
      result.current.sendMessage("hi");
      result.current.cancel();
    });

    const prompt = JSON.parse(
      ws.sent.find((frame) => JSON.parse(frame).type === "prompt")!,
    );
    const cancel = JSON.parse(
      ws.sent.find((frame) => JSON.parse(frame).type === "cancel")!,
    );
    expect(cancel).toEqual({ type: "cancel", turn_id: prompt.turn_id });
  });

  it("submits queued runtime prompts to the backend and reflects backend queue updates", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-queue" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-queue",
        }),
      });
      result.current.sendMessage("first");
      result.current.sendMessage("second");
      result.current.sendMessage("third");
    });

    const promptFrames = () =>
      ws.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "prompt");
    expect(promptFrames().map((frame) => frame.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(promptFrames().map((frame) => frame.queue_mode ?? null)).toEqual([
      null,
      "single",
      "single",
    ]);
    expect(
      result.current.messages
        .filter((message) => message.role === "user")
        .map((message) => message.parts.map((part: any) => part.text).join("")),
    ).toEqual(["first"]);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.queue_update",
          session_id: "local-session-queue",
          mode: "single",
          active_turn_id: promptFrames()[0].turn_id,
          queued: [
            {
              turn_id: promptFrames()[1].turn_id,
              text: "second",
              created_at: 1,
            },
            {
              turn_id: promptFrames()[2].turn_id,
              text: "third",
              created_at: 2,
            },
          ],
        }),
      });
    });

    expect(
      (result.current as any).promptQueue.map(
        (item: { text: string }) => item.text,
      ),
    ).toEqual(["second", "third"]);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.complete",
          session_id: "local-session-queue",
          turn_id: promptFrames()[0].turn_id,
        }),
      });
    });

    expect(promptFrames().map((frame) => frame.text)).toEqual([
      "first",
      "second",
      "third",
    ]);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.queue_update",
          session_id: "local-session-queue",
          mode: "single",
          active_turn_id: null,
          queued: [
            {
              turn_id: promptFrames()[2].turn_id,
              text: "third",
              created_at: 2,
            },
          ],
        }),
      });
    });

    expect(
      (result.current as any).promptQueue.map(
        (item: { text: string }) => item.text,
      ),
    ).toEqual(["third"]);
    expect(
      result.current.messages
        .filter((message) => message.role === "user")
        .map((message) => message.parts.map((part: any) => part.text).join("")),
    ).toEqual(["first"]);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.queue_update",
          session_id: "local-session-queue",
          mode: "single",
          active_turn_id: promptFrames()[1].turn_id,
          queued: [
            {
              turn_id: promptFrames()[2].turn_id,
              text: "third",
              created_at: 2,
            },
          ],
        }),
      });
    });

    expect(
      (result.current as any).promptQueue.map(
        (item: { text: string }) => item.text,
      ),
    ).toEqual(["third"]);
    expect(
      result.current.messages
        .filter((message) => message.role === "user")
        .map((message) => message.parts.map((part: any) => part.text).join("")),
    ).toEqual(["first", "second"]);
  });

  it("keeps a queued prompt before its response when the response event wins the activation race", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-order-race" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-order-race",
        }),
      });
      result.current.sendMessage("first");
      result.current.sendMessage("second");
    });
    const prompts = ws.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "prompt");

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-order-race",
          turn_id: prompts[1].turn_id,
          event: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "second response" },
          },
        }),
      });
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.queue_update",
          session_id: "local-session-order-race",
          mode: "single",
          active_turn_id: prompts[1].turn_id,
          queued: [],
        }),
      });
    });

    expect(
      result.current.messages.map((message) => ({
        role: message.role,
        text: message.parts
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(""),
      })),
    ).toEqual([
      { role: "user", text: "first" },
      { role: "user", text: "second" },
      { role: "assistant", text: "second response" },
    ]);
  });

  it("keeps skill-warning plumbing out of same-chunk assistant prose", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-notice" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-notice",
        }),
      });
      result.current.sendMessage("啥都不想做");
    });
    const prompt = ws.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "prompt");
    const warning =
      "Warning: Skill descriptions were shortened to fit the skills context budget. " +
      "Codex can still see every skill, but some descriptions are shorter.";

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-notice",
          turn_id: prompt.turn_id,
          event: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `${warning}\n\n那就先喝两口水。` },
          },
        }),
      });
    });

    expect(result.current.messages.at(-1)?.parts).toEqual([
      { type: "text", text: "那就先喝两口水。" },
    ]);
  });

  it("clears the active turn when the backend reports no active queued prompt", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-active-clear" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-active-clear",
        }),
      });
      result.current.sendMessage("first");
    });
    const firstPrompt = JSON.parse(
      ws.sent.find((frame) => JSON.parse(frame).type === "prompt")!,
    );

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.queue_update",
          session_id: "local-session-active-clear",
          mode: "single",
          active_turn_id: firstPrompt.turn_id,
          queued: [],
        }),
      });
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.queue_update",
          session_id: "local-session-active-clear",
          mode: "single",
          active_turn_id: null,
          queued: [],
        }),
      });
      result.current.sendMessage("after stop");
    });

    const promptFrames = ws.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "prompt");
    expect(promptFrames.map((frame) => frame.text)).toEqual([
      "first",
      "after stop",
    ]);
    expect(promptFrames.map((frame) => frame.queue_mode ?? null)).toEqual([
      null,
      null,
    ]);
    expect(result.current.promptQueue).toEqual([]);
  });

  it("sends follow-up prompts immediately when the runtime prompt queue is disabled", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-no-queue" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-no-queue",
        }),
      });
      result.current.setPromptQueueEnabled(false);
      result.current.sendMessage("first");
      result.current.sendMessage("second");
    });

    const promptFrames = ws.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "prompt");
    expect(promptFrames.map((frame) => frame.text)).toEqual([
      "first",
      "second",
    ]);
    expect(promptFrames.map((frame) => frame.queue_mode ?? null)).toEqual([
      null,
      null,
    ]);
    expect(result.current.promptQueue).toEqual([]);
    expect(
      result.current.messages
        .filter((message) => message.role === "user")
        .map((message) => message.parts.map((part: any) => part.text).join("")),
    ).toEqual(["first", "second"]);
  });

  it("flushes all queued runtime prompts after the current agent loop when queue mode is flush", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-flush" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-flush",
        }),
      });
      (result.current as any).setPromptQueueMode("flush");
      result.current.sendMessage("first");
      result.current.sendMessage("second");
      result.current.sendMessage("third");
    });

    const promptFrames = () =>
      ws.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "prompt");
    const queueModeFrames = ws.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "set_prompt_queue_mode");
    expect(queueModeFrames).toEqual([
      { type: "set_prompt_queue_mode", queue_mode: "flush" },
    ]);
    expect(promptFrames().map((frame) => frame.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(promptFrames().map((frame) => frame.queue_mode ?? null)).toEqual([
      null,
      "flush",
      "flush",
    ]);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.complete",
          session_id: "local-session-flush",
          turn_id: promptFrames()[0].turn_id,
        }),
      });
    });

    expect(promptFrames().map((frame) => frame.text)).toEqual([
      "first",
      "second",
      "third",
    ]);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.queue_update",
          session_id: "local-session-flush",
          mode: "flush",
          active_turn_id: promptFrames()[1].turn_id,
          queued: [],
        }),
      });
    });

    expect((result.current as any).promptQueue).toEqual([]);
  });

  it("clears queued runtime prompts through the backend queue protocol", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-clear-queue" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-clear-queue",
        }),
      });
      result.current.sendMessage("first");
      result.current.sendMessage("second");
    });

    const promptFrames = () =>
      ws.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "prompt");
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.queue_update",
          session_id: "local-session-clear-queue",
          mode: "single",
          active_turn_id: promptFrames()[0].turn_id,
          queued: [
            {
              turn_id: promptFrames()[1].turn_id,
              text: "second",
              created_at: 1,
            },
          ],
        }),
      });
    });
    expect(
      (result.current as any).promptQueue.map(
        (item: { text: string }) => item.text,
      ),
    ).toEqual(["second"]);

    act(() => {
      result.current.clearPromptQueue();
    });

    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ type: "clear_prompt_queue" });
    expect((result.current as any).promptQueue).toEqual([]);
  });

  it("keeps the ACP transcript in chronological blocks when a queued prompt is steered", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-steer" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-steer",
        }),
      });
      result.current.sendMessage("first");
      result.current.sendMessage("steer after tool");
    });

    const promptFrames = () =>
      ws.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "prompt");
    expect(promptFrames().map((frame) => frame.text)).toEqual([
      "first",
      "steer after tool",
    ]);
    expect(promptFrames().map((frame) => frame.queue_mode ?? null)).toEqual([
      null,
      "single",
    ]);
    expect(
      result.current.messages
        .filter((message) => message.role === "user")
        .map((message) => message.parts.map((part: any) => part.text).join("")),
    ).toEqual(["first"]);

    const firstTurnId = promptFrames()[0].turn_id;
    const steerTurnId = promptFrames()[1].turn_id;
    const sendSessionEvent = (event: unknown, turnId = firstTurnId) => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-steer",
          turn_id: turnId,
          event,
        }),
      });
    };

    act(() => {
      sendSessionEvent({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-1",
        content: { type: "text", text: "before steer" },
      });
      sendSessionEvent({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "pwd",
        kind: "execute",
        status: "in_progress",
      });
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.queue_update",
          session_id: "local-session-steer",
          mode: "single",
          active_turn_id: promptFrames()[0].turn_id,
          queued: [
            { turn_id: steerTurnId, text: "steer after tool", created_at: 1 },
          ],
        }),
      });
      result.current.steerQueuedPrompt(steerTurnId);
    });

    expect(promptFrames().map((frame) => frame.text)).toEqual([
      "first",
      "steer after tool",
    ]);
    expect(
      ws.sent
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "steer_queued_prompt"),
    ).toEqual([
      {
        type: "steer_queued_prompt",
        turn_id: steerTurnId,
      },
    ]);
    expect(result.current.promptQueue).toEqual([]);
    expect(
      result.current.messages
        .filter((message) => message.role === "user")
        .map((message) => message.parts.map((part: any) => part.text).join("")),
    ).toEqual(["first", "steer after tool"]);

    act(() => {
      sendSessionEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: "/tmp/project\n",
      });
      sendSessionEvent(
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg-1",
          content: { type: "text", text: "same message after steer" },
        },
        steerTurnId,
      );
      sendSessionEvent(
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg-1",
          content: { type: "text", text: " still contiguous" },
        },
        steerTurnId,
      );
      sendSessionEvent(
        {
          sessionUpdate: "tool_call",
          toolCallId: "tool-2",
          title: "ls",
          kind: "execute",
        },
        steerTurnId,
      );
    });

    expect(promptFrames().map((frame) => frame.text)).toEqual([
      "first",
      "steer after tool",
    ]);
    expect(
      result.current.messages.map((message) => ({
        role: message.role,
        text: message.parts
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join(""),
        tools: message.parts
          .filter((part: any) => part.type === "tool_call")
          .map((part: any) => ({
            id: part.toolCallId,
            status: part.status,
            output: part.rawOutput,
          })),
      })),
    ).toEqual([
      { role: "user", text: "first", tools: [] },
      {
        role: "assistant",
        text: "before steer",
        tools: [
          { id: "tool-1", status: "completed", output: "/tmp/project\n" },
        ],
      },
      { role: "user", text: "steer after tool", tools: [] },
      {
        role: "assistant",
        text: "same message after steer still contiguous",
        tools: [{ id: "tool-2", status: "in_progress", output: undefined }],
      },
    ]);
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.complete",
          session_id: "local-session-steer",
          turn_id: firstTurnId,
        }),
      });
    });
    expect(result.current.status).toBe("connected");
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.queue_update",
          session_id: "local-session-steer",
          mode: "single",
          active_turn_id: null,
          queued: [],
        }),
      });
    });
    expect((result.current as any).promptQueue).toEqual([]);
    expect(
      result.current.messages
        .filter((message) => message.role === "user")
        .map((message) => message.parts.map((part: any) => part.text).join("")),
    ).toEqual(["first", "steer after tool"]);
  });

  it("exposes transient agent retry status and clears it when the turn completes", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-retry" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    let turnId = "";
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-retry",
        }),
      });
      result.current.sendMessage("hi");
      turnId = JSON.parse(
        ws.sent.find((frame) => JSON.parse(frame).type === "prompt")!,
      ).turn_id;
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.status",
          session_id: "local-session-retry",
          turn_id: turnId,
          status: "reconnecting",
          message: "Reconnecting... 2/5",
          attempt: 2,
          maxAttempts: 5,
        }),
      });
    });

    expect(result.current.transientStatus).toEqual({
      kind: "reconnecting",
      message: "Reconnecting... 2/5",
      attempt: 2,
      maxAttempts: 5,
    });
    expect(result.current.status).toBe("sending");

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.complete",
          session_id: "local-session-retry",
          turn_id: turnId,
        }),
      });
    });

    expect(result.current.transientStatus).toBeNull();
    expect(result.current.status).toBe("connected");
  });

  it("stores stderr diagnostics and derives transient status from them", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-diagnostic" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-diagnostic",
        }),
      });
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.diagnostic",
          session_id: "local-session-diagnostic",
          turn_id: "turn-diagnostic",
          diagnostic: {
            stream: "stderr",
            severity: "warning",
            raw: "WARN stream disconnected - retrying sampling request (2/5 in 1.0s)...",
            message: "Reconnecting... 2/5",
            transientStatus: {
              status: "reconnecting",
              message: "Reconnecting... 2/5",
              detail: "stream disconnected",
              attempt: 2,
              maxAttempts: 5,
            },
          },
        }),
      });
    });

    expect(result.current.diagnostics).toHaveLength(1);
    expect(result.current.diagnostics[0]).toMatchObject({
      stream: "stderr",
      severity: "warning",
      message: "Reconnecting... 2/5",
      raw: "WARN stream disconnected - retrying sampling request (2/5 in 1.0s)...",
    });
    expect(result.current.transientStatus).toEqual({
      kind: "reconnecting",
      message: "Reconnecting... 2/5",
      detail: "stream disconnected",
      attempt: 2,
      maxAttempts: 5,
    });
  });

  it("renames a cold runtime session from the first user prompt", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-title" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-title",
        freshSession: true,
      });
    });
    expect(result.current.currentSession?.title).toBe("New session");

    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-title",
        }),
      });
      result.current.sendMessage(
        [
          '<!-- clash-workspace-context {"version":1,"projectId":"project-title"} -->',
          "Run `pwd` with your shell tool, then answer with only the path.",
        ].join("\n"),
      );
    });

    expect(result.current.currentSession?.title).toBe(
      "Run `pwd` with your shell tool, then answer with onl...",
    );
  });

  it("uses an explicit ACP resume id without restoring project-scoped transcript cache", async () => {
    let sessionSeq = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          sessionSeq += 1;
          return new Response(
            JSON.stringify({ session_id: `local-session-${sessionSeq}` }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const first = renderHook(() => useClashRuntime());
    await act(async () => {
      await first.result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-one",
      });
    });

    const firstWs = FakeWebSocket.instances.at(-1)!;
    act(() => {
      firstWs.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-1",
          acp_session_id: "acp-thread-one",
        }),
      });
      first.result.current.sendMessage("where am i?");
    });
    const prompt = JSON.parse(
      firstWs.sent.find((frame) => JSON.parse(frame).type === "prompt")!,
    );
    act(() => {
      firstWs.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-1",
          turn_id: prompt.turn_id,
          event: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "/Users/xiaoyang/.clash/projects/_default",
            },
          },
        }),
      });
      firstWs.onmessage?.({
        data: JSON.stringify({
          type: "session.complete",
          session_id: "local-session-1",
          turn_id: prompt.turn_id,
        }),
      });
    });

    await waitFor(() => {
      expect(
        first.result.current.messages.map((message) => message.role),
      ).toEqual(["user", "assistant"]);
    });
    first.unmount();

    const second = renderHook(() => useClashRuntime());
    await act(async () => {
      await second.result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-one",
        resumeAcpSessionId: "acp-thread-one",
      });
    });

    const postCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(postCalls.at(-1)?.[1]?.body))).toMatchObject({
      agent_id: "codex-acp",
      project_id: "project-one",
      resume_session_id: "acp-thread-one",
    });
    expect(second.result.current.messages).toEqual([]);

    const secondWs = FakeWebSocket.instances.at(-1)!;
    act(() => {
      secondWs.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-2",
          acp_session_id: "acp-thread-two",
        }),
      });
    });
    second.unmount();

    const third = renderHook(() => useClashRuntime());
    await act(async () => {
      await third.result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-one",
        resumeAcpSessionId: "acp-thread-two",
      });
    });

    const allPostCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(allPostCalls.at(-1)?.[1]?.body))).toMatchObject({
      agent_id: "codex-acp",
      project_id: "project-one",
      resume_session_id: "acp-thread-two",
    });
    expect(third.result.current.messages).toEqual([]);
  });

  it("cold-creates a local runtime session without resuming cached ACP state", async () => {
    let sessionSeq = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          sessionSeq += 1;
          return new Response(
            JSON.stringify({ session_id: `local-session-${sessionSeq}` }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const first = renderHook(() => useClashRuntime());
    await act(async () => {
      await first.result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-one",
      });
    });

    const firstWs = FakeWebSocket.instances.at(-1)!;
    act(() => {
      firstWs.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-1",
          acp_session_id: "acp-thread-old",
        }),
      });
      first.result.current.sendMessage("where am i?");
    });

    await waitFor(() => {
      expect(
        first.result.current.messages.map((message) => message.role),
      ).toEqual(["user"]);
    });

    await act(async () => {
      await first.result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-one",
        freshSession: true,
      });
    });

    const postCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(postCalls.at(-1)?.[1]?.body))).toEqual({
      agent_id: "codex-acp",
      project_id: "project-one",
    });
    expect(first.result.current.messages).toEqual([]);

    const second = renderHook(() => useClashRuntime());
    await act(async () => {
      await second.result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-one",
      });
    });

    const allPostCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(allPostCalls.at(-1)?.[1]?.body))).toEqual({
      agent_id: "codex-acp",
      project_id: "project-one",
    });
    expect(second.result.current.messages).toEqual([]);
  });

  it.each([undefined, { messageId: "previous-answer", messageText: "Earlier answer", messageOccurrence: 1 }])("creates an ACP fork with boundary %j on the first prompt and keeps that prompt visible", async (forkPoint) => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "forked-local-session" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useClashRuntime());

    act(() => {
      result.current.startDraft("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-one",
        permissionModeId: "codex:full-access",
        forkFromAcpSessionId: "acp-source",
        forkPoint,
      });
      result.current.sendMessage("Continue from the source session");
    });

    await waitFor(() =>
      expect(result.current.sessionId).toBe("forked-local-session"),
    );
    const post = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    )!;
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({
      agent_id: "codex-acp",
      project_id: "project-one",
      permission_mode: "codex:full-access",
      fork_session_id: "acp-source",
    });
    expect(JSON.parse(String(post[1]?.body)).fork_point).toEqual(forkPoint);
    await waitFor(() => {
      expect(result.current.messages).toEqual([
        expect.objectContaining({
          role: "user",
          parts: [{ type: "text", text: "Continue from the source session" }],
        }),
      ]);
    });
  });

  it("does not treat project-scoped runtime cache as Clash session history", async () => {
    window.localStorage.setItem(
      "clash:runtimeSession:project-one:desktop-local:clash:codex-acp",
      JSON.stringify({
        acpSessionId: "acp-thread-stale",
        messages: [
          {
            id: "stale-user",
            role: "user",
            parts: [{ type: "text", text: "old prompt" }],
          },
        ],
        updatedAt: Date.now(),
      }),
    );
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-fresh" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-one",
      });
    });

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      agent_id: "codex-acp",
      project_id: "project-one",
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.currentSession?.acpSessionId).toBeUndefined();
  });

  it("reattaches a historical session and restores its persisted transcript", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-old/events") &&
          !init?.method
        ) {
          return new Response(
            JSON.stringify({
              events: [
                {
                  seq: 1,
                  type: "user_prompt",
                  data: { turn_id: "turn-old", text: "Run pwd" },
                  ts: 1_000,
                },
                {
                  seq: 2,
                  type: "session.event",
                  data: {
                    turn_id: "turn-old",
                    event: {
                      sessionUpdate: "agent_message_chunk",
                      content: {
                        type: "text",
                        text: "/Users/xiaoyang/project",
                      },
                    },
                  },
                  ts: 2_000,
                },
                {
                  seq: 3,
                  type: "turn_completed",
                  data: { turn_id: "turn-old" },
                  ts: 3_000,
                },
              ],
            }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-old/_attach") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-old" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.attachSession({
        id: "local-session-old",
        threadId: "local-session-old",
        title: "New session",
        type: "runtime",
        projectId: "project-one",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
        status: "active",
      });
    });

    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST",
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith(
            "/api/v1/local-sessions/local-session-old/_attach",
          ) && init?.method === "POST",
      ),
    ).toBe(true);
    expect(result.current.sessionId).toBe("local-session-old");
    expect(result.current.status).toBe("connecting");
    expect(result.current.selectedRuntimeId).toBe("desktop-local");
    expect(result.current.selectedAgentId).toBe("codex-acp");
    expect(result.current.currentSession?.threadId).toBe("local-session-old");
    expect(result.current.currentSession?.title).toBe("Run pwd");
    expect(result.current.messages).toEqual([
      {
        id: "user-turn-old",
        role: "user",
        parts: [{ type: "text", text: "Run pwd" }],
      },
      {
        id: "asst-turn-old",
        role: "assistant",
        parts: [{ type: "text", text: "/Users/xiaoyang/project" }],
      },
    ]);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith(
          "/api/v1/local-sessions/local-session-old/events",
        ),
      ),
    ).toBe(true);
    const stream = FakeWebSocket.instances.at(-1)!;
    expect(stream.url).toContain(
      "/api/v1/local-sessions/local-session-old/_stream",
    );
    expect(stream.url).not.toContain("replay=");

    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-old",
        }),
      });
    });
    expect(result.current.status).toBe("connected");

    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-old",
          turn_id: "turn-old",
          event: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "/Users/xiaoyang/project" },
          },
        }),
      });
    });

    expect(result.current.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(result.current.messages.at(1)?.parts).toEqual([
      { type: "text", text: "/Users/xiaoyang/project" },
    ]);
  });

  it("shows the runtime attach error field from structured local API failures", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-old/events") &&
          !init?.method
        ) {
          return new Response("not found", { status: 404 });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-old/_attach") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({
              error: "ACP session init timed out after 10ms",
              session_id: "local-session-old",
              mutation: {
                operation: "runtime_session_attach",
                entity: { kind: "session", id: "local-session-old" },
                accepted: true,
              },
            }),
            {
              status: 503,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.attachSession({
        id: "local-session-old",
        threadId: "local-session-old",
        type: "runtime",
        projectId: "project-one",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
        status: "active",
      });
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe(
      "session attach failed: ACP session init timed out after 10ms",
    );
  });

  it("shows restored transcript while ACP process restore is still pending", async () => {
    let resolveAttach: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-slow/events") &&
          !init?.method
        ) {
          return new Response(
            JSON.stringify({
              events: [
                {
                  seq: 1,
                  type: "user_prompt",
                  data: { turn_id: "turn-slow", text: "Reply exactly: pong" },
                  ts: 1_000,
                },
                {
                  seq: 2,
                  type: "session.event",
                  data: {
                    turn_id: "turn-slow",
                    event: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "p" },
                    },
                  },
                  ts: 2_000,
                },
                {
                  seq: 3,
                  type: "session.event",
                  data: {
                    turn_id: "turn-slow",
                    event: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "ong" },
                    },
                  },
                  ts: 3_000,
                },
                {
                  seq: 4,
                  type: "turn_completed",
                  data: { turn_id: "turn-slow" },
                  ts: 4_000,
                },
              ],
            }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-slow/_attach") &&
          init?.method === "POST"
        ) {
          return new Promise<Response>((resolve) => {
            resolveAttach = resolve;
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    act(() => {
      void result.current.attachSession({
        id: "local-session-slow",
        threadId: "local-session-slow",
        type: "runtime",
        projectId: "project-one",
        runtimeId: "desktop-local",
        agentId: "cursor",
        status: "starting",
      });
    });

    await waitFor(() => {
      expect(result.current.sessionId).toBe("local-session-slow");
    });
    expect(result.current.status).toBe("connecting");
    expect(result.current.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(result.current.messages.at(1)?.parts).toEqual([
      { type: "text", text: "pong" },
    ]);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith(
          "/api/v1/local-sessions/local-session-slow/events",
        ),
      ),
    ).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(0);

    await act(async () => {
      resolveAttach?.(
        new Response(JSON.stringify({ session_id: "local-session-slow" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    });

    await waitFor(() => {
      expect(FakeWebSocket.instances.at(-1)?.url).toContain(
        "/api/v1/local-sessions/local-session-slow/_stream",
      );
      expect(FakeWebSocket.instances.at(-1)?.url).not.toContain("replay=");
    });
  });

  it("continues live attach when persisted history is unavailable", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-live/events") &&
          !init?.method
        ) {
          return new Response("local transcript unavailable", { status: 500 });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-live/_attach") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-live" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.attachSession({
        id: "local-session-live",
        threadId: "local-session-live",
        type: "runtime",
        projectId: "project-one",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
        status: "active",
      });
    });

    const stream = FakeWebSocket.instances.at(-1)!;
    expect(stream.url).toContain(
      "/api/v1/local-sessions/local-session-live/_stream",
    );
    expect(stream.url).not.toContain("replay=");
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith(
          "/api/v1/local-sessions/local-session-live/events",
        ),
      ),
    ).toBe(true);

    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-live",
          turn_id: "turn-live",
          event: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "replayed from local-api backlog" },
          },
        }),
      });
    });

    expect(result.current.messages.map((message) => message.role)).toEqual([
      "assistant",
    ]);
    expect(result.current.messages.at(0)?.parts).toEqual([
      { type: "text", text: "replayed from local-api backlog" },
    ]);
  });

  it("hydrates the Backchat event log by seq without inventing a terminal state", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith(
            "/api/v1/local-sessions/local-session-event-log/events",
          ) &&
          !init?.method
        ) {
          return new Response(
            JSON.stringify({
              events: [
                {
                  seq: 3,
                  type: "session.event",
                  data: {
                    turn_id: "turn-1",
                    event: {
                      sessionUpdate: "tool_call",
                      toolCallId: "tool-1",
                      title: "Read project",
                      status: "in_progress",
                    },
                  },
                  ts: 1_500,
                },
                {
                  seq: 1,
                  type: "user_prompt",
                  data: { turn_id: "turn-1", text: "Inspect" },
                  ts: 1_000,
                },
                {
                  seq: 2,
                  type: "session.event",
                  data: {
                    turn_id: "turn-1",
                    event: {
                      sessionUpdate: "agent_thought_chunk",
                      content: { type: "text", text: "Planning" },
                    },
                  },
                  ts: 1_250,
                },
              ],
            }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (
          url.endsWith(
            "/api/v1/local-sessions/local-session-event-log/_attach",
          ) &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-event-log" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.attachSession({
        id: "local-session-event-log",
        threadId: "local-session-event-log",
        type: "runtime",
        projectId: "project-one",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
        status: "active",
      });
    });

    expect(result.current.agentUIState.turnOrder).toEqual(["turn-1"]);
    expect(result.current.agentUIState.turns["turn-1"]).toMatchObject({
      status: "running",
      items: [
        { kind: "message", role: "user", text: "Inspect" },
        { kind: "thinking", role: "assistant", text: "Planning" },
        { kind: "tool", id: "tool-1", title: "Read project" },
      ],
    });

    const stream = FakeWebSocket.instances.at(-1)!;
    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.cancelled",
          session_id: "local-session-event-log",
          turn_id: "turn-1",
        }),
      });
    });
    expect(result.current.agentUIState.turns["turn-1"]?.status).toBe(
      "cancelled",
    );
  });

  it("keeps every streamed event in one stable assistant turn container", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-stable/events") &&
          !init?.method
        ) {
          return new Response(JSON.stringify({ events: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-stable/_attach") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-stable" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.attachSession({
        id: "local-session-stable",
        threadId: "local-session-stable",
        type: "runtime",
        projectId: "project-one",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
        status: "active",
      });
    });

    const stream = FakeWebSocket.instances.at(-1)!;
    const sendEvent = (event: unknown) => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-stable",
          turn_id: "turn-stable",
          event,
        }),
      });
    };

    act(() => {
      sendEvent({
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-one",
        content: { type: "text", text: "**Planning**" },
      });
      sendEvent({
        sessionUpdate: "agent_message_chunk",
        messageId: "commentary-one",
        content: { type: "text", text: "我先读取当前画布。" },
        _meta: { codex: { phase: "commentary" } },
      });
      sendEvent({
        sessionUpdate: "tool_call",
        toolCallId: "canvas-list",
        title: "List Canvas",
        status: "in_progress",
      });
      sendEvent({
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-two",
        content: { type: "text", text: "**Summarizing**" },
      });
      sendEvent({
        sessionUpdate: "agent_message_chunk",
        messageId: "answer-one",
        content: { type: "text", text: "画布里有 1 个节点。" },
        _meta: { codex: { phase: "final_answer" } },
      });
    });

    const assistantMessages = result.current.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.id).toBe("asst-turn-stable");
    expect(assistantMessages[0]?.parts.map((part) => part.type)).toEqual([
      "thought",
      "text",
      "tool_call",
      "thought",
      "text",
    ]);
  });

  it("keeps the live thought as the turn tail until visible answer text arrives", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-handoff/events") &&
          !init?.method
        ) {
          return new Response(JSON.stringify({ events: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith(
            "/api/v1/local-sessions/local-session-handoff/_attach",
          ) &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-handoff" }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.attachSession({
        id: "local-session-handoff",
        threadId: "local-session-handoff",
        type: "runtime",
        projectId: "project-one",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
        status: "active",
      });
    });

    const stream = FakeWebSocket.instances.at(-1)!;
    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-handoff",
        }),
      });
      result.current.sendMessage("是不是");
    });
    const prompt = stream.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "prompt");

    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-handoff",
          turn_id: prompt.turn_id,
          event: {
            sessionUpdate: "agent_thought_chunk",
            messageId: "thought-handoff",
            content: { type: "text", text: "正在判断" },
          },
        }),
      });
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-handoff",
          turn_id: prompt.turn_id,
          event: {
            sessionUpdate: "agent_message_chunk",
            messageId: "answer-handoff",
            content: { type: "text", text: "" },
          },
        }),
      });
    });

    expect(
      result.current.agentUIState.turns[prompt.turn_id]?.items.at(-1),
    ).toMatchObject({ kind: "thinking", text: "正在判断" });
  });

  it("keeps a pure-answer turn free of invisible process events", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-answer/events") &&
          !init?.method
        ) {
          return new Response(JSON.stringify({ events: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-answer/_attach") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-answer" }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.attachSession({
        id: "local-session-answer",
        threadId: "local-session-answer",
        type: "runtime",
        projectId: "project-one",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
        status: "active",
      });
    });

    const stream = FakeWebSocket.instances.at(-1)!;
    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "local-session-answer",
        }),
      });
      result.current.sendMessage("是吗");
    });
    const prompt = stream.sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "prompt");
    const sendEvent = (event: unknown) => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-answer",
          turn_id: prompt.turn_id,
          event,
        }),
      });
    };

    act(() => {
      sendEvent({ type: "agent.thinking_stream_start" });
      sendEvent({
        sessionUpdate: "agent_thought_chunk",
        messageId: "empty-thought",
        content: { type: "text", text: "" },
      });
      sendEvent({ type: "agent.thinking_stream_end" });
      sendEvent({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text:
            "Warning: Skill descriptions were shortened to fit the skills context budget. " +
            "Codex can still see every skill.",
        },
      });
      sendEvent({
        sessionUpdate: "agent_message_chunk",
        messageId: "answer-only",
        content: { type: "text", text: "是呀" },
      });
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.complete",
          session_id: "local-session-answer",
          turn_id: prompt.turn_id,
        }),
      });
    });

    expect(result.current.agentUIState.turns[prompt.turn_id]?.items).toEqual([
      expect.objectContaining({ kind: "message", role: "user", text: "是吗" }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        text: "是呀",
      }),
    ]);
  });

  it("tracks Goal and usage state from turnless ACP updates without transcript noise", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-goal/events") &&
          !init?.method
        ) {
          return new Response(JSON.stringify({ events: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/local-sessions/local-session-goal/_attach") &&
          init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({ session_id: "local-session-goal" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { result } = renderHook(() => useClashRuntime());
    await act(async () => {
      await result.current.attachSession({
        id: "local-session-goal",
        threadId: "local-session-goal",
        type: "runtime",
        projectId: "project-one",
        runtimeId: "desktop-local",
        agentId: "codex-acp",
        status: "active",
      });
    });

    const stream = FakeWebSocket.instances.at(-1)!;
    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-goal",
          turn_id: "",
          event: {
            sessionUpdate: "session_info_update",
            _meta: {
              codex: {
                goal: {
                  objective: "Ship the Goal bar",
                  status: "active",
                  tokenBudget: 24_000,
                  timeUsedSeconds: 90,
                  controlMethod: "_codex/session/goal_control",
                },
              },
            },
          },
        }),
      });
    });

    expect(result.current.goal).toEqual(
      expect.objectContaining({
        objective: "Ship the Goal bar",
        status: "active",
        timeUsedSeconds: 90,
      }),
    );
    expect(result.current.sessionInfoMeta).toEqual({
      codex: {
        goal: expect.objectContaining({
          objective: "Ship the Goal bar",
          status: "active",
        }),
      },
    });
    expect(result.current.messages).toEqual([]);

    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-goal",
          turn_id: "",
          event: {
            sessionUpdate: "usage_update",
            used: 12_500,
            size: 200_000,
            cost: { amount: 0.42, currency: "USD" },
            _meta: { "_claude/origin": "first_party" },
          },
        }),
      });
    });

    expect(result.current.sessionUsage).toEqual({
      used: 12_500,
      size: 200_000,
      cost: { amount: 0.42, currency: "USD" },
      metadata: { "_claude/origin": "first_party" },
    });
    expect(result.current.messages).toEqual([]);

    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-goal",
          turn_id: "",
          event: {
            sessionUpdate: "session_info_update",
            title: "Goal session",
            _meta: {
              codex: {
                threadStatus: { type: "idle" },
              },
              claude: {
                branch: "preserved-for-a-future-adapter",
              },
            },
          },
        }),
      });
    });

    expect(result.current.goal).toEqual(
      expect.objectContaining({
        objective: "Ship the Goal bar",
        status: "active",
      }),
    );
    expect(result.current.sessionInfoMeta).toEqual({
      codex: {
        goal: expect.objectContaining({
          objective: "Ship the Goal bar",
          status: "active",
        }),
        threadStatus: { type: "idle" },
      },
      claude: {
        branch: "preserved-for-a-future-adapter",
      },
    });
    expect(result.current.currentSession?.title).toBe("Goal session");

    act(() => {
      stream.onmessage?.({
        data: JSON.stringify({
          type: "session.event",
          session_id: "local-session-goal",
          turn_id: "",
          event: {
            sessionUpdate: "session_info_update",
            _meta: { codex: { goal: null } },
          },
        }),
      });
    });

    expect(result.current.goal).toBeNull();
  });

  it("ignores late lifecycle events from a detached session socket", async () => {
    let sessionSeq = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          sessionSeq += 1;
          return new Response(
            JSON.stringify({ session_id: `session-${sessionSeq}` }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useClashRuntime());

    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });
    const oldSocket = FakeWebSocket.instances.at(-1)!;
    const lateHandler = oldSocket.onmessage;
    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
      });
    });
    const currentSocket = FakeWebSocket.instances.at(-1)!;
    act(() => {
      currentSocket.onmessage?.({
        data: JSON.stringify({
          type: "session.ready",
          session_id: "session-2",
        }),
      });
      lateHandler?.({
        data: JSON.stringify({
          type: "session.disposed",
          session_id: "session-1",
        }),
      });
    });

    expect(result.current.sessionId).toBe("session-2");
    expect(result.current.status).toBe("connected");
  });

  it("lets the newest session selection win an out-of-order create response", async () => {
    let releaseFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    let postCount = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/runtimes") && !init?.method) {
          return new Response(JSON.stringify({ runtimes: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (
          url.endsWith("/api/v1/runtimes/desktop-local/sessions") &&
          init?.method === "POST"
        ) {
          postCount += 1;
          if (postCount === 1) return firstResponse;
          return new Response(
            JSON.stringify({ session_id: "session-newest" }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useClashRuntime());

    let first!: Promise<void>;
    act(() => {
      first = result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-old",
      });
    });
    await waitFor(() => expect(postCount).toBe(1));
    await act(async () => {
      await result.current.select("desktop-local", undefined, {
        agentId: "codex-acp",
        projectId: "project-new",
      });
    });
    await act(async () => {
      releaseFirst(
        new Response(JSON.stringify({ session_id: "session-stale" }), {
          headers: { "content-type": "application/json" },
        }),
      );
      await first;
    });

    expect(result.current.sessionId).toBe("session-newest");
    expect(result.current.currentSession?.projectId).toBe("project-new");
    expect(FakeWebSocket.instances.at(-1)?.url).toContain("session-newest");
  });
});
