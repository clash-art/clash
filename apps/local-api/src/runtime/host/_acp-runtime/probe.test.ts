import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AuthenticateRequest,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  authenticateAgent,
  disposeAllAcpSetupProcesses,
  probeAgentAuthStatus,
  probeAgentConfigOptions,
  probeAgentSessionConfig,
} from "./probe.js";
import type { ChildHandle, Spawner } from "./types.js";

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

function connectProbeAgent(
  agentFactory: (connection: AgentSideConnection) => Agent,
  diagnostics: string[] = [],
): Spawner {
  const pair = makeStreamPair();
  new AgentSideConnection(
    agentFactory,
    ndJsonStream(pair.agentOutput, pair.agentInput),
  );
  return {
    async spawn(spec) {
      for (const line of diagnostics) {
        spec.onDiagnosticLine?.(line);
      }
      return pair.child;
    },
  };
}

class AuthRequiredProbeAgent implements Agent {
  constructor(protected readonly calls: string[]) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.calls.push("initialize");
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [{ id: "login", name: "Login" }],
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.calls.push("newSession");
    throw RequestError.authRequired();
  }

  async authenticate(params: AuthenticateRequest) {
    this.calls.push(`authenticate:${params.methodId}`);
    return {};
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    return { stopReason: "end_turn" };
  }

  async cancel() {
    return undefined;
  }
}

class MultiAuthRequiredProbeAgent extends AuthRequiredProbeAgent {
  override async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.calls.push("initialize");
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [
        { id: "browser", name: "Browser Login" },
        { id: "api-key", name: "API Key" },
      ],
      agentCapabilities: { promptCapabilities: {} },
    };
  }
}

class ConfiguredProbeAgent extends AuthRequiredProbeAgent {
  override async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.calls.push("newSession");
    return { sessionId: "configured-session" };
  }
}

class ReportedAuthProbeAgent extends ConfiguredProbeAgent {
  override async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.calls.push("initialize");
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [
        { id: "api-key", name: "API Key" },
        { id: "chat-gpt", name: "ChatGPT" },
      ],
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  async extMethod(method: string): Promise<Record<string, unknown>> {
    this.calls.push(`extMethod:${method}`);
    if (method === "authentication/status") return { type: "chat-gpt" };
    return {};
  }
}

class SessionConfigProbeAgent extends AuthRequiredProbeAgent {
  override async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.calls.push("newSession");
    return {
      sessionId: "configured-session",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          options: [{ value: "auto", name: "Auto" }],
          currentValue: "auto",
        },
      ],
      modes: {
        currentModeId: "ask",
        availableModes: [
          { id: "ask", name: "Ask" },
          { id: "code", name: "Code" },
        ],
      },
    };
  }
}

class LegacyModelProbeAgent extends AuthRequiredProbeAgent {
  override async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.calls.push("newSession");
    return {
      sessionId: "legacy-model-session",
      models: {
        currentModelId: "gemini-2.5-pro",
        availableModels: [
          { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        ],
      },
    } as NewSessionResponse;
  }
}

class NoAuthMethodsProbeAgent implements Agent {
  constructor(protected readonly calls: string[]) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.calls.push("initialize");
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.calls.push("newSession");
    return { sessionId: "should-not-create" };
  }

  async authenticate(params: AuthenticateRequest) {
    this.calls.push(`authenticate:${params.methodId}`);
    return {};
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    return { stopReason: "end_turn" };
  }

  async cancel() {
    return undefined;
  }
}

class TerminalAuthProbeAgent extends AuthRequiredProbeAgent {
  constructor(
    calls: string[],
    private readonly authMethod: Record<string, unknown>,
  ) {
    super(calls);
  }

  override async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.calls.push(`initialize:terminal=${Boolean(params.clientCapabilities?.auth?.terminal)}`);
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: params.clientCapabilities?.auth?.terminal ? [this.authMethod as never] : [],
      agentCapabilities: { promptCapabilities: {} },
    };
  }
}

class EnvVarAuthProbeAgent extends AuthRequiredProbeAgent {
  override async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.calls.push("initialize");
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [{
        type: "env_var",
        id: "openai-key",
        name: "OpenAI API key",
        description: "Use an OpenAI-compatible API key",
        vars: [{ name: "OPENAI_API_KEY", label: "API key", secret: true }],
        link: "https://platform.openai.com/api-keys",
      } as never],
      agentCapabilities: { promptCapabilities: {} },
    };
  }
}

class UnsupportedAuthProbeAgent extends NoAuthMethodsProbeAgent {
  override async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.calls.push("initialize");
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [{
        id: "magic-card",
        name: "Magic Card",
        type: "card",
      } as never],
      agentCapabilities: { promptCapabilities: {} },
    };
  }
}

class TerminalCreateAuthProbeAgent extends AuthRequiredProbeAgent {
  constructor(
    calls: string[],
    private readonly connection: AgentSideConnection,
  ) {
    super(calls);
  }

  override async authenticate(params: AuthenticateRequest) {
    this.calls.push(`authenticate:${params.methodId}`);
    const terminal = await this.connection.createTerminal({
      sessionId: "auth-session",
      command: "devin",
      args: ["auth", "login"],
      env: [{ name: "DEVIN_AUTH", value: "1" }],
      cwd: "/tmp/devin-auth",
    });
    this.calls.push(`terminal:${terminal.id}`);
    await new Promise<never>(() => undefined);
    return {};
  }
}

class BrowserHostedAuthProbeAgent extends AuthRequiredProbeAgent {
  constructor(
    calls: string[],
    private readonly rejectAfterMs: number,
  ) {
    super(calls);
  }

  override async authenticate(params: AuthenticateRequest): Promise<Record<string, never>> {
    this.calls.push(`authenticate:${params.methodId}`);
    await new Promise((resolve) => setTimeout(resolve, this.rejectAfterMs));
    throw new Error("Login canceled");
  }
}

class FailingAuthProbeAgent extends AuthRequiredProbeAgent {
  override async authenticate(params: AuthenticateRequest): Promise<Record<string, never>> {
    this.calls.push(`authenticate:${params.methodId}`);
    throw new RequestError(-32603, "Internal error", {
      details: "Missing API key for openai auth. Set OPENAI_API_KEY.",
    });
  }
}

class ConventionAuthProbeAgent extends AuthRequiredProbeAgent {
  readonly authenticateCalls: AuthenticateRequest[] = [];

  constructor(
    calls: string[],
    private readonly method: Record<string, unknown>,
  ) {
    super(calls);
  }

  override async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.calls.push(`initialize:gateway=${Boolean(params.clientCapabilities?.auth?._meta?.gateway)}`);
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [this.method as never],
      agentCapabilities: { promptCapabilities: {} },
    };
  }

  override async authenticate(params: AuthenticateRequest) {
    this.authenticateCalls.push(params);
    return {};
  }
}

describe("probeAgentAuthStatus", () => {
  it("reports auth_required without calling authenticate", async () => {
    const calls: string[] = [];
    await expect(probeAgentAuthStatus({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-probe-test",
      spawner: connectProbeAgent(() => new AuthRequiredProbeAgent(calls)),
    })).resolves.toEqual({
      status: "needs-auth",
      methodId: "login",
      methodName: "Login",
      methods: [{ id: "login", name: "Login", type: "agent" }],
    });

    expect(calls).toEqual(["initialize", "newSession"]);
  });

  it("reports every supported auth method and selects the default method", async () => {
    const calls: string[] = [];
    await expect(probeAgentAuthStatus({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-probe-test",
      spawner: connectProbeAgent(() => new MultiAuthRequiredProbeAgent(calls)),
    })).resolves.toMatchObject({
      status: "needs-auth",
      methodId: "browser",
      methodName: "Browser Login",
      methods: [
        { id: "browser", name: "Browser Login", type: "agent" },
        { id: "api-key", name: "API Key", type: "agent" },
      ],
    });

    expect(calls).toEqual(["initialize", "newSession"]);
  });

  it("reports credential-only terminal auth methods as env var prompts", async () => {
    const calls: string[] = [];
    await expect(probeAgentAuthStatus({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-probe-test",
      spawner: connectProbeAgent(() => new TerminalAuthProbeAgent(calls, {
        id: "openai",
        name: "Use OpenAI API key",
        description: "Requires setting the OPENAI_API_KEY environment variable",
        _meta: {
          type: "terminal",
          args: ["--auth-type=openai"],
        },
      })),
    })).resolves.toMatchObject({
      status: "needs-auth",
      methodId: "openai",
      methodName: "Use OpenAI API key",
      methods: [{
        id: "openai",
        name: "Use OpenAI API key",
        description: "Requires setting the OPENAI_API_KEY environment variable",
        type: "env_var",
        vars: [{ name: "OPENAI_API_KEY", secret: true }],
      }],
    });

    expect(calls).toEqual(["initialize:terminal=true"]);
  });

  it("reports env_var auth methods without treating them as sign-in flows", async () => {
    const calls: string[] = [];
    await expect(probeAgentAuthStatus({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-probe-test",
      spawner: connectProbeAgent(() => new EnvVarAuthProbeAgent(calls)),
    })).resolves.toMatchObject({
      status: "needs-auth",
      methodId: "openai-key",
      methodName: "OpenAI API key",
      methods: [{
        id: "openai-key",
        name: "OpenAI API key",
        description: "Use an OpenAI-compatible API key",
        type: "env_var",
        vars: [{ name: "OPENAI_API_KEY", label: "API key", secret: true }],
        link: "https://platform.openai.com/api-keys",
      }],
    });

    expect(calls).toEqual(["initialize"]);
  });

  it("reports agent-owned API key metadata as an in-app authentication form", async () => {
    const calls: string[] = [];
    await expect(probeAgentAuthStatus({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-form-auth-probe-test",
      spawner: connectProbeAgent(() => new ConventionAuthProbeAgent(calls, {
        id: "provider-login",
        name: "Provider key",
        _meta: { "api-key": { provider: "anthropic" } },
      })),
    })).resolves.toMatchObject({
      status: "needs-auth",
      methods: [{
        id: "provider-login",
        name: "Provider key",
        type: "agent",
        form: "fields",
        vars: [{ name: "api-key", label: "API key", secret: true }],
      }],
    });

    expect(calls).toEqual(["initialize:gateway=true", "newSession"]);
  });

  it("reports configured auth when a session can be created", async () => {
    const calls: string[] = [];
    await expect(probeAgentAuthStatus({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-probe-test",
      spawner: connectProbeAgent(() => new ConfiguredProbeAgent(calls)),
    })).resolves.toEqual({
      status: "configured",
      methodId: "login",
      methodName: "Login",
      methods: [{ id: "login", name: "Login", type: "agent" }],
    });

    expect(calls).toEqual(["initialize", "newSession"]);
  });

  it("uses the first supported ACP auth method without a private extension probe", async () => {
    const calls: string[] = [];
    await expect(probeAgentAuthStatus({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-probe-test",
      spawner: connectProbeAgent(() => new ReportedAuthProbeAgent(calls)),
    })).resolves.toEqual({
      status: "configured",
      methodId: "api-key",
      methodName: "API Key",
      methods: [
        { id: "api-key", name: "API Key", type: "agent" },
        { id: "chat-gpt", name: "ChatGPT", type: "agent" },
      ],
    });

    expect(calls).toEqual(["initialize", "newSession"]);
  });

  it("reports needs-auth when a session succeeds with unauthenticated diagnostics", async () => {
    const calls: string[] = [];
    await expect(probeAgentAuthStatus({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-probe-test",
      spawner: connectProbeAgent(
        () => new ConfiguredProbeAgent(calls),
        ["ACP: Creating session without credentials - agent may not work"],
      ),
    })).resolves.toEqual({
      status: "needs-auth",
      methodId: "login",
      methodName: "Login",
      methods: [{ id: "login", name: "Login", type: "agent" }],
      message: "Creating session without credentials - agent may not work",
    });

    expect(calls).toEqual(["initialize", "newSession"]);
  });

  it("does not create a probe session when the agent has no auth methods", async () => {
    const calls: string[] = [];
    await expect(probeAgentAuthStatus({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-probe-test",
      spawner: connectProbeAgent(() => new NoAuthMethodsProbeAgent(calls)),
    })).resolves.toEqual({ status: "none" });

    expect(calls).toEqual(["initialize"]);
  });

  it("blocks unsupported auth methods instead of treating them as no auth", async () => {
    const calls: string[] = [];
    await expect(probeAgentAuthStatus({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-probe-test",
      spawner: connectProbeAgent(() => new UnsupportedAuthProbeAgent(calls)),
    })).resolves.toEqual({
      status: "unknown",
      message: "No supported ACP auth method is available. Unsupported methods: card.",
    });

    expect(calls).toEqual(["initialize"]);
  });
});

describe("ACP setup lifecycle", () => {
  it("lets shutdown dispose externally pending auth children", async () => {
    const calls: string[] = [];
    const delegate = connectProbeAgent(() => new BrowserHostedAuthProbeAgent(calls, 60_000));
    const kill = vi.fn(async () => undefined);
    const spawner: Spawner = {
      async spawn(spec) {
        return {
          ...await delegate.spawn(spec),
          kill,
        };
      },
    };

    await expect(authenticateAgent({
      agent: { command: "browser-auth-agent" },
      cwd: "/tmp/clash-acp-background-auth-test",
      spawner,
      agentAuthLaunchGraceMs: 1,
      backgroundAuthTimeoutMs: 60_000,
    })).resolves.toEqual({ status: "started" });

    await disposeAllAcpSetupProcesses();
    expect(kill).toHaveBeenCalledOnce();
  });
});

describe("probeAgentConfigOptions", () => {
  it("does not launch authentication when config probing hits auth_required", async () => {
    const calls: string[] = [];

    await expect(probeAgentConfigOptions({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-config-probe-test",
      spawner: connectProbeAgent(() => new AuthRequiredProbeAgent(calls)),
    })).resolves.toEqual([]);

    expect(calls).toEqual(["initialize", "newSession"]);
  });

  it("returns auth and capabilities from the same disposable ACP process", async () => {
    const calls: string[] = [];

    await expect(probeAgentSessionConfig({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-full-probe-test",
      spawner: connectProbeAgent(() => new AuthRequiredProbeAgent(calls)),
    })).resolves.toEqual({
      availableCommands: [],
      configOptions: [],
      auth: {
        status: "needs-auth",
        methodId: "login",
        methodName: "Login",
        methods: [{ id: "login", name: "Login", type: "agent" }],
      },
    });

    expect(calls).toEqual(["initialize", "newSession"]);
  });

  it("returns ACP session modes alongside config options", async () => {
    const calls: string[] = [];

    await expect(probeAgentSessionConfig({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-session-config-probe-test",
      spawner: connectProbeAgent(() => new SessionConfigProbeAgent(calls)),
    })).resolves.toEqual({
      availableCommands: [],
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          options: [{ value: "auto", name: "Auto" }],
          currentValue: "auto",
        },
      ],
      modes: {
        currentModeId: "ask",
        availableModes: [
          { id: "ask", name: "Ask" },
          { id: "code", name: "Code" },
        ],
      },
      auth: {
        status: "configured",
        methodId: "login",
        methodName: "Login",
        methods: [{ id: "login", name: "Login", type: "agent" }],
      },
    });

    expect(calls).toEqual(["initialize", "newSession"]);
  });

  it("normalizes legacy ACP models during the cold-start probe", async () => {
    const calls: string[] = [];

    await expect(probeAgentSessionConfig({
      agent: { command: "gemini" },
      cwd: "/tmp/clash-acp-legacy-model-probe-test",
      spawner: connectProbeAgent(() => new LegacyModelProbeAgent(calls)),
    })).resolves.toMatchObject({
      configOptions: [{
        id: "model",
        category: "model",
        type: "select",
        currentValue: "gemini-2.5-pro",
        options: [
          { value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { value: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        ],
      }],
    });

    expect(calls).toEqual(["initialize", "newSession"]);
  });

  it("captures available commands published just after session creation", async () => {
    const spawner = connectProbeAgent((connection) => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { promptCapabilities: {} },
        };
      },
      async newSession() {
        setTimeout(() => {
          void connection.sessionUpdate({
            sessionId: "probe-session",
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: [
                {
                  name: "review",
                  description: "Review the current project",
                },
              ],
            },
          });
        }, 0);
        return {
          sessionId: "probe-session",
          configOptions: [],
        };
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
    }));

    await expect(probeAgentSessionConfig({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-available-commands-probe-test",
      spawner,
    })).resolves.toMatchObject({
      availableCommands: [
        {
          name: "review",
          description: "Review the current project",
        },
      ],
    });
  });
});

describe("authenticateAgent", () => {
  it("uses the explicitly selected ACP auth method", async () => {
    const calls: string[] = [];

    await expect(authenticateAgent({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-selected-auth-test",
      methodId: "api-key",
      spawner: connectProbeAgent(() => new MultiAuthRequiredProbeAgent(calls)),
    })).resolves.toEqual({ status: "completed" });

    expect(calls).toEqual(["initialize", "authenticate:api-key"]);
  });

  it("submits authentication form values through the method metadata convention", async () => {
    const calls: string[] = [];
    const agent = new ConventionAuthProbeAgent(calls, {
      id: "provider-login",
      name: "Provider key",
      _meta: { "api-key": { provider: "anthropic" } },
    });

    await expect(authenticateAgent({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-form-auth-submit-test",
      methodId: "provider-login",
      values: { "api-key": "sk-ant-test" },
      spawner: connectProbeAgent(() => agent),
    })).resolves.toEqual({ status: "completed" });

    expect(agent.authenticateCalls).toEqual([{
      methodId: "provider-login",
      _meta: { "api-key": { apiKey: "sk-ant-test" } },
    }]);
  });

  it("submits gateway authentication fields without persisting the API key in the host", async () => {
    const calls: string[] = [];
    const agent = new ConventionAuthProbeAgent(calls, {
      id: "custom-endpoint",
      name: "Custom endpoint",
      _meta: { gateway: { protocol: "openai" } },
    });

    await expect(authenticateAgent({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-gateway-auth-submit-test",
      methodId: "custom-endpoint",
      values: {
        baseUrl: " https://api.example.com/v1 ",
        "api-key": "TOKEN",
        providerName: "custom",
      },
      spawner: connectProbeAgent(() => agent),
    })).resolves.toEqual({ status: "completed" });

    expect(agent.authenticateCalls).toEqual([{
      methodId: "custom-endpoint",
      _meta: {
        gateway: {
          baseUrl: "https://api.example.com/v1",
          headers: { Authorization: "Bearer TOKEN" },
          providerName: "custom",
        },
      },
    }]);
  });

  it("launches ACP terminal auth methods through the host terminal", async () => {
    const calls: string[] = [];
    const launchInteractiveAuth = vi.fn(async () => undefined);

    await expect(authenticateAgent({
      agent: {
        command: "devin",
        args: ["acp"],
        env: { BASE: "1" },
      },
      cwd: "/tmp/clash-acp-terminal-auth-test",
      env: { EXTRA: "2" },
      spawner: connectProbeAgent(() => new TerminalAuthProbeAgent(calls, {
        type: "terminal",
        id: "login",
        name: "Login",
        args: ["auth", "login"],
        env: { AUTH: "1" },
      })),
      launchInteractiveAuth,
    })).resolves.toEqual({ status: "started" });

    expect(calls).toEqual(["initialize:terminal=true"]);
    expect(launchInteractiveAuth).toHaveBeenCalledWith({
      label: "Login",
      command: "devin",
      args: ["auth", "login"],
      env: { BASE: "1", EXTRA: "2", AUTH: "1" },
      cwd: "/tmp/clash-acp-terminal-auth-test",
    });
  });

  it("launches legacy terminal-auth metadata instead of calling agent authenticate", async () => {
    const calls: string[] = [];
    const launchInteractiveAuth = vi.fn(async () => undefined);

    await expect(authenticateAgent({
      agent: { command: "gemini", args: ["--experimental-acp"] },
      cwd: "/tmp/clash-acp-meta-auth-test",
      spawner: connectProbeAgent(() => new TerminalAuthProbeAgent(calls, {
        id: "login",
        name: "Login",
        _meta: {
          "terminal-auth": {
            label: "gemini /auth",
            command: "gemini",
            args: ["/auth"],
            env: { SURFACE: "zed" },
          },
        },
      })),
      launchInteractiveAuth,
    })).resolves.toEqual({ status: "started" });

    expect(calls).toEqual(["initialize:terminal=true"]);
    expect(launchInteractiveAuth).toHaveBeenCalledWith({
      label: "gemini /auth",
      command: "gemini",
      args: ["/auth"],
      env: { SURFACE: "zed" },
      cwd: "/tmp/clash-acp-meta-auth-test",
    });
  });

  it("launches meta terminal auth against the registry shim target command", async () => {
    const calls: string[] = [];
    const launchInteractiveAuth = vi.fn(async () => undefined);
    const dir = await mkdtemp(join(tmpdir(), "clash-acp-shim-test-"));
    const shimPath = join(dir, "clash-acp-qwen-code");
    await writeFile(
      shimPath,
      [
        "#!/bin/sh",
        "set -eu",
        `exec '/registry/qwen' '--acp' '--experimental-skills' "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      await expect(authenticateAgent({
        agent: {
          command: shimPath,
          args: ["--acp", "--experimental-skills"],
        },
        cwd: "/tmp/clash-acp-meta-terminal-auth-test",
        spawner: connectProbeAgent(() => new TerminalAuthProbeAgent(calls, {
          id: "openai",
          name: "Use OpenAI API key",
          _meta: {
            type: "terminal",
            args: ["--auth-type=openai"],
          },
        })),
        launchInteractiveAuth,
      })).resolves.toEqual({ status: "started" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(calls).toEqual(["initialize:terminal=true"]);
    expect(launchInteractiveAuth).toHaveBeenCalledWith({
      label: "Use OpenAI API key",
      command: "/registry/qwen",
      args: ["--auth-type=openai"],
      env: {},
      cwd: "/tmp/clash-acp-meta-terminal-auth-test",
    });
  });

  it("does not launch terminal auth when the terminal method only describes required env vars", async () => {
    const calls: string[] = [];
    const launchInteractiveAuth = vi.fn(async () => undefined);

    await expect(authenticateAgent({
      agent: { command: "qwen", args: ["--acp"] },
      cwd: "/tmp/clash-acp-credential-terminal-auth-test",
      spawner: connectProbeAgent(() => new TerminalAuthProbeAgent(calls, {
        id: "openai",
        name: "Use OpenAI API key",
        description: "Requires setting the OPENAI_API_KEY environment variable",
        _meta: {
          type: "terminal",
          args: ["--auth-type=openai"],
        },
      })),
      launchInteractiveAuth,
    })).rejects.toThrow("requires credential variables (OPENAI_API_KEY)");

    expect(calls).toEqual(["initialize:terminal=true"]);
    expect(launchInteractiveAuth).not.toHaveBeenCalled();
  });

  it("launches terminal/create requests from agent auth without waiting for login completion", async () => {
    const calls: string[] = [];
    const launchInteractiveAuth = vi.fn(async () => undefined);

    await expect(authenticateAgent({
      agent: { command: "devin", args: ["acp"] },
      cwd: "/tmp/clash-acp-agent-auth-test",
      spawner: connectProbeAgent((connection) => new TerminalCreateAuthProbeAgent(calls, connection)),
      launchInteractiveAuth,
    })).resolves.toEqual({ status: "started" });

    expect(calls).toContain("initialize");
    expect(calls).toContain("authenticate:login");
    expect(launchInteractiveAuth).toHaveBeenCalledWith({
      label: "Login auth",
      command: "devin",
      args: ["auth", "login"],
      env: { DEVIN_AUTH: "1" },
      cwd: "/tmp/devin-auth",
    });
  });

  it("treats browser-hosted agent auth as launched after it stays pending past the startup grace", async () => {
    const calls: string[] = [];

    await expect(authenticateAgent({
      agent: { command: "devin", args: ["acp"] },
      cwd: "/tmp/clash-acp-browser-auth-test",
      spawner: connectProbeAgent(() => new BrowserHostedAuthProbeAgent(calls, 30)),
      agentAuthLaunchGraceMs: 5,
      backgroundAuthTimeoutMs: 100,
    })).resolves.toEqual({ status: "started" });

    expect(calls).toContain("initialize");
    expect(calls).toContain("authenticate:login");
  });

  it("surfaces ACP authenticate error details instead of generic internal errors", async () => {
    const calls: string[] = [];

    await expect(authenticateAgent({
      agent: { command: "qwen", args: ["--acp"] },
      cwd: "/tmp/clash-acp-auth-error-details-test",
      spawner: connectProbeAgent(() => new FailingAuthProbeAgent(calls)),
    })).rejects.toThrow("Missing API key for openai auth. Set OPENAI_API_KEY.");

    expect(calls).toEqual(["initialize", "authenticate:login"]);
  });

  it("does not invoke agent authenticate for env_var auth methods", async () => {
    const calls: string[] = [];

    await expect(authenticateAgent({
      agent: { command: "fake-agent" },
      cwd: "/tmp/clash-acp-env-auth-test",
      spawner: connectProbeAgent(() => new EnvVarAuthProbeAgent(calls)),
    })).rejects.toThrow("requires credential variables (OPENAI_API_KEY)");

    expect(calls).toEqual(["initialize"]);
  });
});
