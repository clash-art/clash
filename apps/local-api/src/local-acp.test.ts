import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  SessionElicitationBroker,
  SessionPermissionBroker,
} from "./runtime/host/lib/session-manager.js";
import { readAgentRuntime } from "./runtime/host/lib/session-cwd.js";
import {
  createLocalAcpAdapter as createLocalAcpAdapterImpl,
  createLocalHarnessConfigStore,
  createLocalAcpRunPreferencesStore,
  type SessionManagerLike,
  type SessionPromptParamsLike,
  type SessionSender,
} from "./local-acp";

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, Array<(data?: unknown) => void>>();

  send(data: string) {
    this.sent.push(data);
  }

  on(event: string, listener: (data?: unknown) => void) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, data?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createLocalAcpAdapter(
  options: NonNullable<Parameters<typeof createLocalAcpAdapterImpl>[0]> = {},
) {
  const defaults = {
    probeAgentAuth: async () => ({
      status: "configured" as const,
      message: "Test auth configured.",
    }),
  };
  if (options.probeAgentConfigOptions || options.probeAgentSessionConfig) {
    return createLocalAcpAdapterImpl({ ...defaults, ...options });
  }
  return createLocalAcpAdapterImpl({
    ...defaults,
    probeAgentSessionConfig: async () => ({
      configOptions: [],
      modes: undefined,
    }),
    ...options,
  });
}

describe("local ACP adapter", () => {
  it("writes local harness configuration to owner-only config.yaml", async () => {
    const removedHarnessSidecar = String.fromCharCode(
      104,
      97,
      114,
      110,
      101,
      115,
      115,
      101,
      115,
      46,
      106,
      115,
      111,
      110,
    );
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-acp-config-"));
    try {
      const store = createLocalHarnessConfigStore(dataDir);
      if (!store.saveAgentServers) throw new Error("saveAgentServers missing");

      await store.saveAgentServers({
        local: {
          type: "custom",
          command: "node",
          args: ["server.js"],
          env: { LOCAL_TOKEN: "redacted" },
        },
      });

      await expect(
        stat(join(dataDir, removedHarnessSidecar)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const mode = (await stat(join(dataDir, "config.yaml"))).mode & 0o777;
      expect(mode).toBe(0o600);
      await expect(stat(join(dataDir, "local.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        createLocalHarnessConfigStore(dataDir).loadAgentServers?.(),
      ).resolves.toEqual({
        local: {
          type: "custom",
          command: "node",
          args: ["server.js"],
          env: { LOCAL_TOKEN: "redacted" },
        },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("migrates the legacy harness sidecar into config.yaml before warmup reads enablement", async () => {
    const retiredHarnessSidecar = String.fromCharCode(
      104,
      97,
      114,
      110,
      101,
      115,
      115,
      101,
      115,
      46,
      106,
      115,
      111,
      110,
    );
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-acp-migrate-"));
    try {
      const sidecarPath = join(dataDir, retiredHarnessSidecar);
      await writeFile(
        sidecarPath,
        JSON.stringify({
          enabled_harness_ids: ["codex-acp", "claude-acp"],
        }),
      );

      const store = createLocalHarnessConfigStore(dataDir);

      await expect(store.loadEnabledHarnessIds()).resolves.toEqual([
        "codex-acp",
        "claude-acp",
      ]);
      await expect(stat(sidecarPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(dataDir, "config.yaml"), "utf8"),
      ).resolves.toContain("codex-acp");
      await expect(
        createLocalHarnessConfigStore(dataDir).loadEnabledHarnessIds(),
      ).resolves.toEqual(["codex-acp", "claude-acp"]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("stores recent ACP run choices in self-hosted SQLite without touching config.yaml", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-local-acp-recent-"));
    try {
      const store = createLocalAcpRunPreferencesStore(dataDir);
      await store.save({
        agent_id: "codex-acp",
        config_by_agent: {
          "codex-acp": {
            model: "gpt-5.6-sol",
            effort: "high",
          },
        },
        mode_by_agent: {
          "codex-acp": "agent",
        },
      });

      await expect(stat(join(dataDir, "config.yaml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await stat(join(dataDir, "local.sqlite"))).mode & 0o777).toBe(
        0o600,
      );
      await expect(
        createLocalAcpRunPreferencesStore(dataDir).load(),
      ).resolves.toEqual({
        agent_id: "codex-acp",
        config_by_agent: {
          "codex-acp": {
            model: "gpt-5.6-sol",
            effort: "high",
          },
        },
        mode_by_agent: {
          "codex-acp": "agent",
        },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reports the desktop local runtime from detected ACP agents", async () => {
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      hostname: () => "This Mac",
      osTag: () => "darwin/arm64",
      nowSeconds: () => 1_700_000_000,
    });

    await expect(adapter.listRuntimes()).resolves.toEqual({
      runtimes: [
        {
          id: "desktop-local",
          machine_id: "desktop-local",
          hostname: "This Mac",
          os: "darwin/arm64",
          agents: [{ id: "codex-acp", label: "Codex", binary: "codex-acp" }],
          version: "desktop",
          status: "online",
          last_heartbeat: 1_700_000_000,
          created_at: 1_700_000_000,
        },
      ],
    });
  });

  it("publishes self-hosted recent run preferences with the runtime snapshot", async () => {
    const loadRunPreferences = vi.fn(async () => ({
      agent_id: "codex-acp",
      config_by_agent: {
        "codex-acp": {
          model: "gpt-5.6-sol",
          effort: "high",
        },
      },
      mode_by_agent: {
        "codex-acp": "agent",
      },
    }));
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      harnessConfig: {
        loadEnabledHarnessIds: async () => ["codex-acp"],
        saveEnabledHarnessIds: vi.fn(),
      },
      runPreferences: {
        load: loadRunPreferences,
        save: vi.fn(),
      },
    } as Parameters<typeof createLocalAcpAdapter>[0]);

    await expect(adapter.listRuntimes()).resolves.toMatchObject({
      runtimes: [
        {
          id: "desktop-local",
          preferences: {
            agent_id: "codex-acp",
            config_by_agent: {
              "codex-acp": {
                model: "gpt-5.6-sol",
                effort: "high",
              },
            },
            mode_by_agent: {
              "codex-acp": "agent",
            },
          },
        },
      ],
    });
    expect(loadRunPreferences).toHaveBeenCalledOnce();
  });

  it("records the latest actual run while preserving other agents' recent values", async () => {
    const saveRunPreferences = vi.fn(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [],
      runPreferences: {
        load: async () => ({
          agent_id: "claude-acp",
          config_by_agent: {
            "claude-acp": { model: "claude-opus-4" },
          },
          mode_by_agent: {
            "claude-acp": "acceptEdits",
          },
        }),
        save: saveRunPreferences,
      },
    } as Parameters<typeof createLocalAcpAdapter>[0]);

    await expect(
      adapter.updateRunPreferences({
        agent_id: "codex-acp",
        config_values: {
          model: "gpt-5.6-sol",
          effort: "high",
        },
        mode_id: "agent",
      }),
    ).resolves.toEqual({
      preferences: {
        agent_id: "codex-acp",
        config_by_agent: {
          "claude-acp": { model: "claude-opus-4" },
          "codex-acp": {
            model: "gpt-5.6-sol",
            effort: "high",
          },
        },
        mode_by_agent: {
          "claude-acp": "acceptEdits",
          "codex-acp": "agent",
        },
      },
    });
    expect(saveRunPreferences).toHaveBeenCalledWith({
      agent_id: "codex-acp",
      config_by_agent: {
        "claude-acp": { model: "claude-opus-4" },
        "codex-acp": {
          model: "gpt-5.6-sol",
          effort: "high",
        },
      },
      mode_by_agent: {
        "claude-acp": "acceptEdits",
        "codex-acp": "agent",
      },
    });
  });

  it("warms every enabled harness in parallel and skips disabled harnesses", async () => {
    const modelConfig = {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "gpt-5.5",
      options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
    };
    const probeAgentAuth = vi.fn(async (agent: { id: string }) => ({
      status: "configured" as const,
      message: `${agent.id} auth configured.`,
    }));
    const probesStarted = deferred();
    const releaseProbes = deferred<void>();
    const startedAgentIds: string[] = [];
    const probeAgentSessionConfig = vi.fn(async (agent: { id: string }) => {
      startedAgentIds.push(agent.id);
      if (startedAgentIds.length === 2) probesStarted.resolve();
      await releaseProbes.promise;
      return {
        configOptions: [modelConfig],
        availableCommands: [],
        auth: {
          status: "configured" as const,
        },
      };
    });
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
        {
          id: "claude-acp",
          label: "Claude",
          spec: { command: "claude-agent-acp" },
        },
        {
          id: "gemini",
          label: "Gemini",
          spec: { command: "gemini" },
        },
      ],
      harnessConfig: {
        loadEnabledHarnessIds: async () => ["codex-acp", "claude-acp"],
        saveEnabledHarnessIds: vi.fn(),
      },
      probeAgentAuth,
      probeAgentSessionConfig,
    } as Parameters<typeof createLocalAcpAdapter>[0] & {
      probeAgentAuth: (agent: {
        id: string;
      }) => Promise<{ status: "configured"; message: string }>;
      probeAgentSessionConfig: (agent: { id: string }) => Promise<{
        configOptions: unknown[];
        availableCommands: unknown[];
        auth: { status: "configured" };
      }>;
    });

    const warmup = (adapter as { warmup(): Promise<void> }).warmup();
    await probesStarted.promise;
    expect(startedAgentIds.sort()).toEqual(["claude-acp", "codex-acp"]);
    expect(probeAgentAuth).not.toHaveBeenCalled();
    releaseProbes.resolve();
    await warmup;

    await expect(adapter.listRuntimes()).resolves.toMatchObject({
      runtimes: [
        {
          agents: [
            {
              id: "codex-acp",
            },
            {
              id: "claude-acp",
            },
          ],
        },
      ],
    });
    expect(
      probeAgentSessionConfig.mock.calls.map(([agent]) => agent.id).sort(),
    ).toEqual(["claude-acp", "codex-acp"]);
  });

  it("does not block lightweight runtime listing behind a slow metadata probe", async () => {
    const authProbeStarted = deferred();
    const releaseAuthProbe = deferred<{
      status: "configured";
      message: string;
    }>();
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      probeAgentAuth: vi.fn(async () => {
        authProbeStarted.resolve();
        return releaseAuthProbe.promise;
      }),
      hostname: () => "This Mac",
      osTag: () => "darwin/arm64",
      nowSeconds: () => 1_700_000_000,
    });

    const probed = adapter.listRuntimes({ probe: "config" });
    await authProbeStarted.promise;

    const lightweight = adapter.listRuntimes({ probe: "none" });
    await expect(
      Promise.race([
        lightweight.then((result) => result.runtimes[0]?.agents[0]?.id),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 0)),
      ]),
    ).resolves.toBe("codex-acp");

    releaseAuthProbe.resolve({
      status: "configured",
      message: "Codex auth configured.",
    });
    await probed;
  });

  it("lists resumable sessions through ACP session/list before falling back to local file scans", async () => {
    const listAgentSessions = vi.fn(async (agent: { id: string }) =>
      agent.id === "codex-acp"
        ? [
            {
              id: "codex-history-1",
              title: "Codex story pass",
              cwd: "/tmp/codex-project",
              modifiedAt: 1_781_500_000,
            },
          ]
        : [],
    );
    const listResumeSessions = vi.fn(async () => [
      {
        id: "claude-file-history",
        title: "Old Claude file",
        cwd: "clash/project",
        modifiedAt: 1,
      },
    ]);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      listAgentSessions,
      listResumeSessions,
    });

    await expect(adapter.listResumeSessions("desktop-local")).resolves.toEqual({
      sessions: [
        {
          id: "codex-history-1",
          title: "Codex story pass",
          cwd: "/tmp/codex-project",
          modifiedAt: 1_781_500_000,
        },
      ],
    });
    expect(listAgentSessions).toHaveBeenCalledWith(
      expect.objectContaining({ id: "codex-acp" }),
    );
    expect(listResumeSessions).not.toHaveBeenCalled();
  });

  it("filters runtime agents through the enabled harness set", async () => {
    let enabledHarnessIds = ["claude-acp"];
    const start = vi.fn<SessionManagerLike["start"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
        {
          id: "claude-acp",
          label: "Claude",
          spec: { command: "claude-agent-acp" },
        },
      ],
      probeAgentAuth: async () => undefined,
      harnessConfig: {
        loadEnabledHarnessIds: async () => enabledHarnessIds,
        saveEnabledHarnessIds: async (ids) => {
          enabledHarnessIds = ids;
        },
      },
      createSessionManager: () => ({
        start,
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      createSessionId: () => "local-acp-session-harness",
    });

    await expect(adapter.listRuntimes()).resolves.toMatchObject({
      runtimes: [
        {
          agents: [{ id: "claude-acp", binary: "claude-agent-acp" }],
        },
      ],
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "claude-acp",
      }),
    );

    const updated = await adapter.updateHarnesses(["codex-acp"]);
    expect(updated.harnesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "codex-acp",
          enabled: true,
          available: true,
        }),
        expect.objectContaining({
          id: "claude-acp",
          enabled: false,
          available: true,
        }),
      ]),
    );
    expect(enabledHarnessIds).toEqual(["codex-acp"]);
  });

  it("uses the most recently selected runnable harness when session creation omits agent_id", async () => {
    const start = vi.fn<SessionManagerLike["start"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
        {
          id: "claude-acp",
          label: "Claude",
          spec: { command: "claude-agent-acp" },
        },
      ],
      probeAgentAuth: async () => undefined,
      harnessConfig: {
        loadEnabledHarnessIds: async () => ["codex-acp", "claude-acp"],
        saveEnabledHarnessIds: vi.fn(),
      },
      runPreferences: {
        load: async () => ({
          agent_id: "claude-acp",
          config_by_agent: {},
          mode_by_agent: {},
        }),
        save: vi.fn(),
      },
      createSessionManager: () => ({
        start,
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      createSessionId: () => "local-acp-session-recent-agent",
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "claude-acp",
      }),
    );
  });

  it("surfaces Gemini auth preflight status in harness settings", async () => {
    const probeAgentAuth = vi.fn(async () => ({
      status: "needs-auth" as const,
      message: "Gemini has old accounts but no active auth method for ACP.",
      command: "gemini",
    }));
    const probeAgentConfigOptions = vi.fn(async () => [
      { id: "model", name: "Model" },
    ]);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "gemini",
          label: "Gemini",
          spec: { command: "gemini", args: ["--experimental-acp"] },
        },
      ],
      probeAgentAuth,
      probeAgentConfigOptions,
      agentCatalog: [
        {
          id: "gemini",
          label: "Gemini",
          spec: { command: "gemini", args: ["--experimental-acp"] },
        },
      ],
    });

    await expect(adapter.listHarnesses({ probe: true })).resolves.toEqual({
      harnesses: [
        expect.objectContaining({
          id: "gemini",
          auth: {
            status: "needs-auth",
            message:
              "Gemini has old accounts but no active auth method for ACP.",
            command: "gemini",
          },
        }),
      ],
    });
    expect(probeAgentAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gemini" }),
    );
    expect(probeAgentConfigOptions).not.toHaveBeenCalled();
  });

  it("probes auth for installed harness settings even when the harness is not enabled", async () => {
    const probeAgentAuth = vi.fn(async () => ({
      status: "needs-auth" as const,
      message: "Qwen Code requires ACP authentication (Use OpenAI API key).",
      command: "clash-acp-qwen-code",
      methodId: "openai-api-key",
      methodName: "Use OpenAI API key",
      methods: [
        {
          id: "openai-api-key",
          name: "Use OpenAI API key",
          description:
            "Requires setting the OPENAI_API_KEY environment variable",
          type: "terminal",
        },
      ],
    }));
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "qwen-code",
          label: "Qwen Code",
          spec: { command: "clash-acp-qwen-code", args: ["--acp"] },
        },
      ],
      probeAgentAuth,
      harnessConfig: {
        loadEnabledHarnessIds: async () => [],
        saveEnabledHarnessIds: vi.fn(),
      },
      agentCatalog: [
        {
          id: "qwen-code",
          label: "Qwen Code",
          spec: { command: "clash-acp-qwen-code", args: ["--acp"] },
        },
      ],
    });

    await expect(adapter.listHarnesses({ probe: true })).resolves.toMatchObject(
      {
        harnesses: [
          {
            id: "qwen-code",
            enabled: false,
            available: true,
            auth: {
              status: "needs-auth",
              methodId: "openai-api-key",
              methodName: "Use OpenAI API key",
            },
          },
        ],
      },
    );
    expect(probeAgentAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "qwen-code" }),
    );
  });

  it("preserves env_var auth metadata in public harness responses", async () => {
    const probeAgentAuth = vi.fn(async () => ({
      status: "needs-auth" as const,
      message: "Qwen Code requires ACP authentication (OpenAI API key).",
      command: "clash-acp-qwen-code",
      methodId: "openai-key",
      methodName: "OpenAI API key",
      methods: [
        {
          id: "openai-key",
          name: "OpenAI API key",
          description: "Use an OpenAI-compatible API key",
          type: "env_var",
          vars: [{ name: "OPENAI_API_KEY", label: "API key", secret: true }],
          link: "https://platform.openai.com/api-keys",
          terminalLaunch: {
            label: "should not leak",
            command: "qwen",
            args: [],
          },
        },
      ],
    }));
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "qwen-code",
          label: "Qwen Code",
          spec: { command: "clash-acp-qwen-code", args: ["--acp"] },
        },
      ],
      probeAgentAuth,
      agentCatalog: [
        {
          id: "qwen-code",
          label: "Qwen Code",
          spec: { command: "clash-acp-qwen-code", args: ["--acp"] },
        },
      ],
    });

    const result = await adapter.listHarnesses({
      probe: "auth",
      refresh: true,
    });
    const qwen = result.harnesses.find((harness) => harness.id === "qwen-code");
    expect(qwen?.auth?.methods?.[0]).toEqual({
      id: "openai-key",
      name: "OpenAI API key",
      description: "Use an OpenAI-compatible API key",
      type: "env_var",
      vars: [{ name: "OPENAI_API_KEY", label: "API key", secret: true }],
      link: "https://platform.openai.com/api-keys",
    });
  });

  it("reconciles an edited enable list by probing only newly enabled harnesses", async () => {
    let enabled = ["codex-acp"];
    const probeAgentAuth = vi.fn(async (_agent: { id: string }) => ({
      status: "configured" as const,
      message: "configured",
    }));
    const probeAgentConfigOptions = vi.fn(async (agent: { id: string }) => [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: `${agent.id}-model`,
        options: [],
      },
    ]);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        { id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } },
        {
          id: "claude-acp",
          label: "Claude",
          spec: { command: "claude-agent-acp" },
        },
      ],
      harnessConfig: {
        loadEnabledHarnessIds: async () => enabled,
        saveEnabledHarnessIds: vi.fn(),
      },
      probeAgentAuth,
      probeAgentConfigOptions,
    } as Parameters<typeof createLocalAcpAdapter>[0] & {
      probeAgentAuth: (agent: {
        id: string;
      }) => Promise<{ status: "configured"; message: string }>;
      probeAgentConfigOptions: (agent: { id: string }) => Promise<unknown[]>;
    });

    await adapter.warmup();
    probeAgentAuth.mockClear();
    probeAgentConfigOptions.mockClear();
    enabled = ["codex-acp", "claude-acp"];

    await adapter.reconcileConfiguration();

    expect(probeAgentAuth.mock.calls.map(([agent]) => agent.id)).toEqual([
      "claude-acp",
    ]);
    expect(
      probeAgentConfigOptions.mock.calls.map(([agent]) => agent.id),
    ).toEqual(["claude-acp"]);
  });

  it("probes auth before enabling harnesses", async () => {
    let enabledHarnessIds: string[] | null = null;
    const probeAgentAuth = vi.fn(async () => ({
      status: "configured" as const,
      message: "Claude auth configured.",
    }));
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "claude-acp",
          label: "Claude",
          spec: { command: "claude-agent-acp" },
        },
      ],
      probeAgentAuth,
      harnessConfig: {
        async loadEnabledHarnessIds() {
          return enabledHarnessIds;
        },
        async saveEnabledHarnessIds(ids) {
          enabledHarnessIds = ids;
        },
      },
      agentCatalog: [
        {
          id: "claude-acp",
          label: "Claude",
          spec: { command: "claude-agent-acp" },
        },
      ],
    });

    await expect(adapter.updateHarnesses(["claude-acp"])).resolves.toEqual({
      harnesses: [
        expect.objectContaining({
          id: "claude-acp",
          enabled: true,
          available: true,
        }),
      ],
    });
    expect(enabledHarnessIds).toEqual(["claude-acp"]);
    expect(probeAgentAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude-acp" }),
    );
  });

  it("rejects enabling a harness while ACP auth is still needed", async () => {
    const saveEnabledHarnessIds = vi.fn();
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "devin",
          label: "Devin",
          spec: { command: "clash-acp-devin" },
        },
      ],
      probeAgentAuth: async () => ({
        status: "needs-auth",
        message:
          "Devin requires ACP authentication (API Key). Creating session without credentials - agent may not work",
        command: "clash-acp-devin",
      }),
      harnessConfig: {
        async loadEnabledHarnessIds() {
          return [];
        },
        saveEnabledHarnessIds,
      },
      agentCatalog: [
        {
          id: "devin",
          label: "Devin",
          spec: { command: "clash-acp-devin" },
        },
      ],
    });

    await expect(adapter.updateHarnesses(["devin"])).rejects.toThrow(
      /Authenticate Devin before enabling/,
    );
    expect(saveEnabledHarnessIds).not.toHaveBeenCalled();
  });

  it("surfaces auth-blocked enabled harnesses in runtime agents so the UI can explain the failure", async () => {
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "devin",
          label: "Devin",
          spec: { command: "clash-acp-devin" },
        },
      ],
      harnessConfig: {
        loadEnabledHarnessIds: async () => ["devin"],
        saveEnabledHarnessIds: vi.fn(),
      },
      probeAgentAuth: async () => ({
        status: "needs-auth",
        message:
          "Devin requires ACP authentication (API Key). Creating session without credentials - agent may not work",
        command: "clash-acp-devin",
      }),
      agentCatalog: [
        {
          id: "devin",
          label: "Devin",
          spec: { command: "clash-acp-devin" },
        },
      ],
    });

    await expect(
      adapter.listRuntimes({ probe: "auth", refresh: true }),
    ).resolves.toMatchObject({
      runtimes: [
        {
          agents: [
            {
              id: "devin",
              label: "Devin",
              binary: "clash-acp-devin",
              auth: {
                status: "needs-auth",
                message:
                  "Devin requires ACP authentication (API Key). Creating session without credentials - agent may not work",
                command: "clash-acp-devin",
              },
            },
          ],
        },
      ],
    });
  });

  it("surfaces auth-blocked default harnesses in runtime agents so the picker does not silently fall back", async () => {
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "devin",
          label: "Devin",
          spec: { command: "clash-acp-devin" },
        },
      ],
      harnessConfig: {
        loadEnabledHarnessIds: async () => null,
        saveEnabledHarnessIds: vi.fn(),
      },
      probeAgentAuth: async () => ({
        status: "needs-auth",
        message: "Devin requires ACP authentication (API Key).",
        command: "clash-acp-devin",
      }),
      agentCatalog: [
        {
          id: "devin",
          label: "Devin",
          spec: { command: "clash-acp-devin" },
        },
      ],
    });

    await expect(
      adapter.listRuntimes({ probe: "auth", refresh: true }),
    ).resolves.toMatchObject({
      runtimes: [
        {
          agents: [
            {
              id: "devin",
              label: "Devin",
              binary: "clash-acp-devin",
              auth: {
                status: "needs-auth",
                message: "Devin requires ACP authentication (API Key).",
                command: "clash-acp-devin",
              },
            },
          ],
        },
      ],
    });
  });

  it("includes ACP config options in probed runtimes after auth is configured and warms disabled installed agents", async () => {
    const modelConfig = {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "cursor-large",
      options: [{ value: "cursor-large", name: "Cursor Large" }],
    };
    const probeAgentAuth = vi.fn(async (_agent: { id: string }) => ({
      status: "configured" as const,
      message: "Cursor ACP auth is configured.",
      command: "cursor-agent",
    }));
    const probeAgentConfigOptions = vi.fn(async (_agent: { id: string }) => [
      modelConfig,
    ]);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "cursor",
          label: "Cursor",
          spec: { command: "clash-acp-cursor" },
        },
        {
          id: "devin",
          label: "Devin",
          spec: { command: "clash-acp-devin" },
        },
      ],
      harnessConfig: {
        loadEnabledHarnessIds: async () => ["cursor"],
        saveEnabledHarnessIds: vi.fn(),
      },
      probeAgentAuth,
      probeAgentConfigOptions,
    });

    await expect(
      adapter.listRuntimes({ probe: "config", refresh: true }),
    ).resolves.toMatchObject({
      runtimes: [
        {
          agents: [
            expect.objectContaining({
              id: "cursor",
              auth: expect.objectContaining({ status: "configured" }),
              config_options: [modelConfig],
            }),
          ],
        },
      ],
    });
    expect(
      probeAgentConfigOptions.mock.calls.map(([agent]) => agent.id).sort(),
    ).toEqual(["cursor", "devin"]);
  });

  it("includes ACP session modes in probed runtimes", async () => {
    const sessionModes = {
      currentModeId: "ask",
      availableModes: [
        { id: "ask", name: "Ask" },
        { id: "code", name: "Code" },
      ],
    };
    const probeAgentSessionConfig = vi.fn(async (_agent: { id: string }) => ({
      configOptions: [],
      modes: sessionModes,
    }));
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      harnessConfig: {
        loadEnabledHarnessIds: async () => ["codex-acp"],
        saveEnabledHarnessIds: vi.fn(),
      },
      probeAgentAuth: vi.fn(async () => ({
        status: "configured" as const,
        message: "Codex ACP auth is configured.",
        command: "codex-acp",
      })),
      probeAgentSessionConfig,
    });

    await expect(
      adapter.listRuntimes({ probe: "config", refresh: true }),
    ).resolves.toMatchObject({
      runtimes: [
        {
          agents: [
            expect.objectContaining({
              id: "codex-acp",
              session_modes: sessionModes,
            }),
          ],
        },
      ],
    });
    expect(probeAgentSessionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: "codex-acp" }),
    );
  });

  it("keeps the last confirmed capabilities and marks a transient refresh failure as degraded", async () => {
    const modelConfig = {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "gpt-5.6-sol",
      options: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
    };
    let probeFails = false;
    const probeAgentSessionConfig = vi.fn(async () => {
      if (probeFails) throw new Error("probe transport closed");
      return {
        configOptions: [modelConfig],
        availableCommands: [
          { name: "review", description: "Review the project" },
        ],
        modes: {
          currentModeId: "agent",
          availableModes: [{ id: "agent", name: "Agent" }],
        },
      };
    });
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      harnessConfig: {
        loadEnabledHarnessIds: async () => ["codex-acp"],
        saveEnabledHarnessIds: vi.fn(),
      },
      nowSeconds: () => 1_700_000_000,
      probeAgentSessionConfig,
    });

    await adapter.warmup();
    probeFails = true;

    await expect(
      adapter.listRuntimes({ probe: "config", refresh: true }),
    ).resolves.toMatchObject({
      runtimes: [
        {
          agents: [
            {
              id: "codex-acp",
              config_options: [modelConfig],
              available_commands: [
                { name: "review", description: "Review the project" },
              ],
              session_modes: {
                currentModeId: "agent",
              },
              capability_inspection: {
                status: "degraded",
                inspected_at: "2023-11-14T22:13:20.000Z",
                error: "probe transport closed",
              },
            },
          ],
        },
      ],
    });
  });

  it("restores the last confirmed capabilities when the next cold-start probe is degraded", async () => {
    const modelConfig = {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "gpt-5.6-sol",
      options: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
    };
    let persisted: Record<string, unknown> = {};
    const capabilityCache = {
      async load() {
        return structuredClone(persisted);
      },
      async save(value: Record<string, unknown>) {
        persisted = structuredClone(value);
      },
    };
    const commonOptions = {
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      harnessConfig: {
        loadEnabledHarnessIds: async () => ["codex-acp"],
        saveEnabledHarnessIds: vi.fn(),
      },
      capabilityCache,
    };
    const firstAdapter = createLocalAcpAdapter({
      ...commonOptions,
      probeAgentSessionConfig: async () => ({
        configOptions: [modelConfig],
        availableCommands: [{ name: "review" }],
      }),
    } as Parameters<typeof createLocalAcpAdapter>[0]);
    await firstAdapter.warmup();

    const restartedAdapter = createLocalAcpAdapter({
      ...commonOptions,
      probeAgentSessionConfig: async () => {
        throw new Error("startup probe failed");
      },
    } as Parameters<typeof createLocalAcpAdapter>[0]);
    await restartedAdapter.warmup();

    await expect(restartedAdapter.listRuntimes()).resolves.toMatchObject({
      runtimes: [
        {
          agents: [
            {
              id: "codex-acp",
              config_options: [modelConfig],
              available_commands: [{ name: "review" }],
              capability_inspection: {
                status: "degraded",
                error: "startup probe failed",
              },
            },
          ],
        },
      ],
    });
  });

  it("does not let an auth-only harness refresh erase the warmup capability snapshot", async () => {
    const modelConfig = {
      id: "model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "gpt-5.6-sol",
      options: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
    };
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      harnessConfig: {
        loadEnabledHarnessIds: async () => ["codex-acp"],
        saveEnabledHarnessIds: vi.fn(),
      },
      probeAgentSessionConfig: async () => ({
        configOptions: [modelConfig],
        availableCommands: [{ name: "review" }],
      }),
    });
    await adapter.warmup();

    await adapter.listHarnesses({ probe: "auth", refresh: true });

    await expect(adapter.listRuntimes()).resolves.toMatchObject({
      runtimes: [
        {
          agents: [
            {
              id: "codex-acp",
              config_options: [modelConfig],
              available_commands: [{ name: "review" }],
            },
          ],
        },
      ],
    });
  });

  it("serializes configuration reconciles so an older snapshot cannot overwrite a newer one", async () => {
    const firstReconcileStarted = deferred();
    const releaseFirstReconcile = deferred<void>();
    let detectCount = 0;
    let activeDetects = 0;
    let maxActiveDetects = 0;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => {
        detectCount += 1;
        activeDetects += 1;
        maxActiveDetects = Math.max(maxActiveDetects, activeDetects);
        if (detectCount === 2) {
          firstReconcileStarted.resolve();
          await releaseFirstReconcile.promise;
        }
        activeDetects -= 1;
        return [
          {
            id: "codex-acp",
            label: "Codex",
            spec: { command: "codex-acp" },
          },
        ];
      },
      harnessConfig: {
        loadEnabledHarnessIds: async () => ["codex-acp"],
        saveEnabledHarnessIds: vi.fn(),
      },
    });
    await adapter.warmup();

    const first = adapter.reconcileConfiguration();
    await firstReconcileStarted.promise;
    const second = adapter.reconcileConfiguration();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxActiveDetects).toBe(1);
    releaseFirstReconcile.resolve();
    await Promise.all([first, second]);
    expect(detectCount).toBe(3);
  });

  it("refreshes only auth after authentication without replacing the capability snapshot", async () => {
    const probeAgentAuth = vi.fn(async () => ({
      status: "configured" as const,
      message: "Codex auth configured.",
    }));
    const probeAgentSessionConfig = vi.fn(async () => ({
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "gpt-5.6-sol",
          options: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
        },
      ],
      availableCommands: [{ name: "review" }],
    }));
    const authenticateAgent = vi.fn(async () => ({
      status: "completed" as const,
    }));
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      harnessConfig: {
        loadEnabledHarnessIds: async () => ["codex-acp"],
        saveEnabledHarnessIds: vi.fn(),
      },
      probeAgentAuth,
      probeAgentSessionConfig,
      authenticateAgent,
    });
    await adapter.warmup();

    await adapter.authenticateHarness("codex-acp");

    expect(authenticateAgent).toHaveBeenCalledOnce();
    expect(probeAgentSessionConfig).toHaveBeenCalledOnce();
    await expect(adapter.listRuntimes()).resolves.toMatchObject({
      runtimes: [
        {
          agents: [
            {
              id: "codex-acp",
              config_options: [
                expect.objectContaining({ currentValue: "gpt-5.6-sol" }),
              ],
              available_commands: [{ name: "review" }],
            },
          ],
        },
      ],
    });
  });

  it("refreshes harness probes when requested", async () => {
    let authConfigured = false;
    const detectAgents = vi.fn(async () => [
      {
        id: "gemini",
        label: "Gemini",
        spec: { command: "gemini", args: ["--experimental-acp"] },
      },
    ]);
    const probeAgentAuth = vi.fn(async () =>
      authConfigured
        ? {
            status: "configured" as const,
            message: "Gemini authentication is configured for ACP.",
            command: "gemini",
          }
        : {
            status: "needs-auth" as const,
            message: "Gemini has no active auth method for ACP.",
            command: "gemini",
          },
    );
    const probeAgentConfigOptions = vi.fn(async () => []);
    const adapter = createLocalAcpAdapter({
      detectAgents,
      probeAgentAuth,
      probeAgentConfigOptions,
      agentCatalog: [
        {
          id: "gemini",
          label: "Gemini",
          spec: { command: "gemini", args: ["--experimental-acp"] },
        },
      ],
    });

    await expect(adapter.listHarnesses({ probe: true })).resolves.toMatchObject(
      {
        harnesses: [
          expect.objectContaining({
            auth: expect.objectContaining({ status: "needs-auth" }),
          }),
        ],
      },
    );
    authConfigured = true;
    await expect(adapter.listHarnesses({ probe: true })).resolves.toMatchObject(
      {
        harnesses: [
          expect.objectContaining({
            auth: expect.objectContaining({ status: "needs-auth" }),
          }),
        ],
      },
    );
    await expect(
      adapter.listHarnesses({ probe: true, refresh: true }),
    ).resolves.toMatchObject({
      harnesses: [
        expect.objectContaining({
          auth: expect.objectContaining({ status: "configured" }),
        }),
      ],
    });
    expect(detectAgents).toHaveBeenCalledTimes(2);
    expect(probeAgentAuth).toHaveBeenCalledTimes(2);
    expect(probeAgentConfigOptions).toHaveBeenCalledOnce();
  });

  it("authenticates a harness and refreshes probed metadata", async () => {
    let authenticated = false;
    const authenticateAgent = vi.fn(async () => {
      authenticated = true;
    });
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "gemini",
          label: "Gemini",
          spec: { command: "gemini", args: ["--experimental-acp"] },
        },
      ],
      probeAgentAuth: async () =>
        authenticated
          ? {
              status: "configured",
              message: "Gemini authentication is configured for ACP.",
              command: "gemini",
            }
          : {
              status: "needs-auth",
              message: "Gemini has no active auth method for ACP.",
              command: "gemini",
            },
      authenticateAgent,
      probeAgentConfigOptions: async () => [],
      agentCatalog: [
        {
          id: "gemini",
          label: "Gemini",
          spec: { command: "gemini", args: ["--experimental-acp"] },
        },
      ],
    });

    await expect(
      adapter.authenticateHarness("gemini", { methodId: "api-key" }),
    ).resolves.toMatchObject({
      harnesses: [
        expect.objectContaining({
          auth: expect.objectContaining({ status: "configured" }),
        }),
      ],
    });
    expect(authenticateAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gemini" }),
      { methodId: "api-key" },
    );
  });

  it("preserves in-app authentication form metadata in public harness responses", async () => {
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        { id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } },
      ],
      probeAgentAuth: async () => ({
        status: "needs-auth" as const,
        message: "Codex needs an API key.",
        methods: [
          {
            id: "api-key",
            name: "API key",
            type: "agent",
            form: "fields" as const,
            vars: [{ name: "api-key", label: "API key", secret: true }],
          },
        ],
      }),
    });

    const result = await adapter.listHarnesses({ probe: true });
    expect(
      result.harnesses.find((harness) => harness.id === "codex-acp"),
    ).toMatchObject({
      id: "codex-acp",
      auth: {
        methods: [
          {
            id: "api-key",
            form: "fields",
            vars: [{ name: "api-key", secret: true }],
          },
        ],
      },
    });
  });

  it("does not re-probe immediately after external auth setup is opened", async () => {
    const probeAgentAuth = vi.fn(async () => ({
      status: "needs-auth" as const,
      message: "Qwen Code requires ACP authentication (Use OpenAI API key).",
      command: "clash-acp-qwen-code",
      methodId: "openai",
      methodName: "Use OpenAI API key",
      methods: [
        {
          id: "openai",
          name: "Use OpenAI API key",
          type: "terminal",
          terminalLaunch: {
            label: "Use OpenAI API key",
            command: "qwen",
            args: ["--auth-type=openai"],
            cwd: "/tmp/qwen-auth",
          },
        },
      ],
    }));
    const launchInteractiveAuth = vi.fn(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "qwen-code",
          label: "Qwen Code",
          spec: { command: "clash-acp-qwen-code" },
        },
      ],
      probeAgentAuth,
      probeAgentConfigOptions: async () => [],
      launchInteractiveAuth,
    });

    await adapter.listHarnesses({ probe: "auth", refresh: true });
    probeAgentAuth.mockClear();

    const result = await adapter.authenticateHarness("qwen-code", {
      methodId: "openai",
    });

    expect(result).toMatchObject({
      harnesses: expect.arrayContaining([
        expect.objectContaining({
          id: "qwen-code",
          auth: expect.objectContaining({
            status: "needs-auth",
            methodId: "openai",
          }),
        }),
      ]),
    });
    const qwen = result.harnesses.find((harness) => harness.id === "qwen-code");
    expect(qwen?.auth?.methods?.[0]).not.toHaveProperty("terminalLaunch");
    expect(launchInteractiveAuth).toHaveBeenCalledWith({
      label: "Use OpenAI API key",
      command: "qwen",
      args: ["--auth-type=openai"],
      cwd: "/tmp/qwen-auth",
    });
    expect(probeAgentAuth).not.toHaveBeenCalled();
  });

  it("rejects env_var auth methods before starting ACP authenticate", async () => {
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "qwen-code",
          label: "Qwen Code",
          spec: { command: "clash-acp-qwen-code" },
          auth: {
            status: "needs-auth",
            message: "Qwen Code requires ACP authentication (OpenAI API key).",
            command: "clash-acp-qwen-code",
            methodId: "openai-key",
            methodName: "OpenAI API key",
            methods: [
              {
                id: "openai-key",
                name: "OpenAI API key",
                type: "env_var",
                vars: [
                  { name: "OPENAI_API_KEY", label: "API key", secret: true },
                ],
              },
            ],
          },
        },
      ],
      probeAgentAuth: async () => undefined,
      probeAgentConfigOptions: async () => [],
    });

    await expect(
      adapter.authenticateHarness("qwen-code", { methodId: "openai-key" }),
    ).rejects.toThrow("Set OPENAI_API_KEY and check again");
  });

  it("rejects terminal auth methods that only describe required env vars", async () => {
    const launchInteractiveAuth = vi.fn(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "qwen-code",
          label: "Qwen Code",
          spec: { command: "clash-acp-qwen-code" },
          auth: {
            status: "needs-auth",
            message:
              "Qwen Code requires ACP authentication (Use OpenAI API key).",
            command: "clash-acp-qwen-code",
            methodId: "openai",
            methodName: "Use OpenAI API key",
            methods: [
              {
                id: "openai",
                name: "Use OpenAI API key",
                description:
                  "Requires setting the OPENAI_API_KEY environment variable",
                type: "terminal",
                terminalLaunch: {
                  label: "Use OpenAI API key",
                  command: "qwen",
                  args: ["--auth-type=openai"],
                },
              },
            ],
          },
        },
      ],
      probeAgentAuth: async () => undefined,
      probeAgentConfigOptions: async () => [],
      launchInteractiveAuth,
    });

    await expect(
      adapter.authenticateHarness("qwen-code", { methodId: "openai" }),
    ).rejects.toThrow("Set OPENAI_API_KEY and check again");
    expect(launchInteractiveAuth).not.toHaveBeenCalled();
  });

  it("uses ACP probe status for Devin instead of hardcoded CLI auth status", async () => {
    const probeAgentAuth = vi.fn(
      async (agent: { spec: { command: string } }) => ({
        status: "needs-auth" as const,
        message: "Devin requires ACP authentication (Login).",
        command: agent.spec.command,
      }),
    );
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "devin",
          label: "Devin",
          spec: { command: "clash-acp-devin" },
        },
      ],
      probeAgentAuth,
      probeAgentConfigOptions: async () => [],
    });

    await expect(
      adapter.listHarnesses({ probe: true, refresh: true }),
    ).resolves.toMatchObject({
      harnesses: expect.arrayContaining([
        expect.objectContaining({
          id: "devin",
          auth: expect.objectContaining({
            status: "needs-auth",
            command: "clash-acp-devin",
          }),
        }),
      ]),
    });
    expect(probeAgentAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "devin" }),
    );
  });

  it("routes Devin auth through the ACP authenticate pipeline", async () => {
    const authenticateAgent = vi.fn(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "devin",
          label: "Devin",
          spec: { command: "clash-acp-devin" },
        },
      ],
      probeAgentAuth: async () => undefined,
      probeAgentConfigOptions: async () => [],
      authenticateAgent,
    });

    await expect(adapter.authenticateHarness("devin")).resolves.toMatchObject({
      harnesses: expect.arrayContaining([
        expect.objectContaining({ id: "devin" }),
      ]),
    });
    expect(authenticateAgent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "devin" }),
      undefined,
    );
  });

  it("rejects auth-blocked ACP sessions before spawning", async () => {
    const start = vi.fn<SessionManagerLike["start"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "gemini",
          label: "Gemini",
          spec: { command: "gemini", args: ["--experimental-acp"] },
        },
      ],
      probeAgentAuth: async () => ({
        status: "needs-auth",
        message: "Gemini has old accounts but no active auth method for ACP.",
        command: "gemini",
      }),
      createSessionManager: () => ({
        start,
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      createSessionId: () => "local-acp-gemini-auth-needed",
    });

    await expect(
      adapter.createSession({
        runtimeId: "desktop-local",
        agentId: "gemini",
      }),
    ).rejects.toThrow(/Gemini needs authentication before ACP can start/);
    expect(start).not.toHaveBeenCalled();
  });

  it("defaults missing catalog harnesses to disabled until they are detected or enabled", async () => {
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      agentCatalog: [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
        {
          id: "claude-acp",
          label: "Claude",
          spec: { command: "claude-agent-acp" },
        },
      ],
    });

    await expect(adapter.listHarnesses()).resolves.toEqual({
      harnesses: [
        {
          id: "codex-acp",
          label: "Codex",
          binary: "codex-acp",
          enabled: true,
          available: true,
        },
        {
          id: "claude-acp",
          label: "Claude",
          binary: "claude-agent-acp",
          enabled: false,
          available: false,
        },
      ],
    });
  });

  it("installs ACP registry agents into the managed bin directory", async () => {
    const harnessDir = await mkdtemp(join(tmpdir(), "clash-harness-registry-"));
    const shimPath = join(harnessDir, "clash-acp-test-agent");
    try {
      let registryVersion = "1.0.0";
      let archiveUrl = "https://example.com/test-agent-bin";
      const probeAgentConfigOptions = vi.fn(async () => []);
      const probeAgentAuth = vi.fn(async () => undefined);
      const adapter = createLocalAcpAdapter({
        detectAgents: async () => {
          try {
            await access(shimPath);
            return [
              {
                id: "test-agent",
                label: "Test Agent",
                spec: { command: shimPath, args: ["acp"] },
              },
            ];
          } catch {
            return [];
          }
        },
        agentCatalog: [
          {
            id: "test-agent",
            label: "Test Agent",
            spec: { command: "clash-acp-test-agent", args: ["acp"] },
            registryId: "test-agent",
            installSource: "registry",
          },
        ],
        harnessDownloadDir: harnessDir,
        probeAgentAuth,
        probeAgentConfigOptions,
        fetch: async (url) => {
          if (String(url).includes("registry.json")) {
            return new Response(
              JSON.stringify({
                agents: [
                  {
                    id: "test-agent",
                    name: "Test Agent",
                    version: registryVersion,
                    distribution: {
                      binary: {
                        "darwin-aarch64": {
                          archive: archiveUrl,
                          cmd: "./test-agent-bin",
                        },
                        "darwin-x64": {
                          archive: archiveUrl,
                          cmd: "./test-agent-bin",
                        },
                        "linux-aarch64": {
                          archive: archiveUrl,
                          cmd: "./test-agent-bin",
                        },
                        "linux-x64": {
                          archive: archiveUrl,
                          cmd: "./test-agent-bin",
                        },
                        "linux-x86_64": {
                          archive: archiveUrl,
                          cmd: "./test-agent-bin",
                        },
                        "windows-aarch64": {
                          archive: archiveUrl,
                          cmd: "./test-agent-bin",
                        },
                        "windows-x64": {
                          archive: archiveUrl,
                          cmd: "./test-agent-bin",
                        },
                        "windows-x86_64": {
                          archive: archiveUrl,
                          cmd: "./test-agent-bin",
                        },
                      },
                    },
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          expect(String(url)).toBe(archiveUrl);
          return new Response("fake-registry-agent", { status: 200 });
        },
      });

      await expect(adapter.listHarnesses()).resolves.toEqual({
        harnesses: [
          expect.objectContaining({
            id: "test-agent",
            available: false,
            installable: true,
            installSource: "registry",
          }),
        ],
      });

      const installed = await adapter.installHarness("test-agent");

      await expect(readFile(shimPath, "utf8")).resolves.toContain(
        "test-agent-bin",
      );
      await expect(readFile(shimPath, "utf8")).resolves.toContain(
        "test-agent-bin' 'acp' \"$@\"",
      );
      expect(installed.harnesses).toEqual([
        expect.objectContaining({
          id: "test-agent",
          binary: shimPath,
          available: true,
          installed: true,
          installedVersion: "1.0.0",
          latestVersion: "1.0.0",
        }),
      ]);
      expect(installed.harnesses[0]).not.toHaveProperty("updateAvailable");
      expect(probeAgentConfigOptions).toHaveBeenCalledOnce();

      registryVersion = "1.1.0";
      archiveUrl = "https://example.com/test-agent-bin?version=1.1.0";
      const outdated = await adapter.listHarnesses({ probe: "auth" });
      expect(outdated.harnesses).toEqual([
        expect.objectContaining({
          id: "test-agent",
          installed: true,
          installedVersion: "1.0.0",
          latestVersion: "1.1.0",
          updateAvailable: true,
        }),
      ]);
      expect(probeAgentAuth).toHaveBeenCalled();

      const upgraded = await adapter.upgradeHarness("test-agent");
      expect(upgraded.harnesses).toEqual([
        expect.objectContaining({
          id: "test-agent",
          installed: true,
          installedVersion: "1.1.0",
          latestVersion: "1.1.0",
        }),
      ]);
      expect(upgraded.harnesses[0]).not.toHaveProperty("updateAvailable");

      const uninstalled = await adapter.uninstallHarness("test-agent");

      await expect(access(shimPath)).rejects.toThrow();
      expect(uninstalled.harnesses).toEqual([
        expect.objectContaining({
          id: "test-agent",
          available: false,
          installable: true,
          installSource: "registry",
        }),
      ]);
      expect(uninstalled.harnesses[0]).not.toHaveProperty("installed");
    } finally {
      await rm(harnessDir, { recursive: true, force: true });
    }
  });

  it("checks an npx-backed ACP package independently from an unchanged registry agent version", async () => {
    const harnessDir = await mkdtemp(
      join(tmpdir(), "clash-harness-npx-update-"),
    );
    const shimPath = join(harnessDir, "clash-acp-codex-acp");
    try {
      await writeFile(shimPath, "#!/bin/sh\nexit 0\n", "utf8");
      await mkdir(
        join(
          harnessDir,
          "registry",
          "codex-acp",
          "npx",
          "node_modules",
          "@test",
          "codex-acp",
        ),
        {
          recursive: true,
        },
      );
      await writeFile(
        join(
          harnessDir,
          "registry",
          "codex-acp",
          "npx",
          "node_modules",
          "@test",
          "codex-acp",
          "package.json",
        ),
        JSON.stringify({ name: "@test/codex-acp", version: "1.0.1" }),
        "utf8",
      );
      await mkdir(join(harnessDir, "registry", "codex-acp"), {
        recursive: true,
      });
      await writeFile(
        join(harnessDir, "registry", "codex-acp", "install.json"),
        JSON.stringify({
          source: "registry",
          registryId: "codex-acp",
          shimName: "clash-acp-codex-acp",
          version: "registry-static",
          installedAt: new Date().toISOString(),
        }),
        "utf8",
      );

      let latestVersion = "1.0.2";
      const probeAuth = vi.fn(async () => undefined);
      const adapter = createLocalAcpAdapter({
        detectAgents: async () => [
          {
            id: "codex-acp",
            label: "Codex",
            spec: { command: shimPath },
          },
        ],
        agentCatalog: [
          {
            id: "codex-acp",
            label: "Codex",
            spec: { command: "clash-acp-codex-acp" },
            registryId: "codex-acp",
            installSource: "registry",
          },
        ],
        harnessDownloadDir: harnessDir,
        probeAgentAuth: probeAuth,
        fetch: async (url) => {
          if (String(url).includes("registry.json")) {
            return new Response(
              JSON.stringify({
                agents: [
                  {
                    id: "codex-acp",
                    name: "Codex",
                    version: "registry-static",
                    distribution: { npx: { package: "@test/codex-acp" } },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          expect(String(url)).toBe(
            "https://registry.npmjs.org/%40test%2Fcodex-acp/latest",
          );
          return new Response(JSON.stringify({ version: latestVersion }), {
            status: 200,
          });
        },
      });

      await expect(
        adapter.listHarnesses({ probe: "auth", refresh: true }),
      ).resolves.toEqual({
        harnesses: [
          expect.objectContaining({
            id: "codex-acp",
            installed: true,
            installedVersion: "1.0.1",
            latestVersion: "1.0.2",
            updateAvailable: true,
          }),
        ],
      });
      probeAuth.mockClear();
      latestVersion = "1.0.3";
      const checked = await adapter.listHarnesses({ checkUpdates: true });
      expect(checked.harnesses[0]?.latestVersion).toBe(latestVersion);
      expect(probeAuth).not.toHaveBeenCalled();
    } finally {
      await rm(harnessDir, { recursive: true, force: true });
    }
  });

  it("loads additional installable agents from the public ACP registry catalog", async () => {
    const harnessDir = await mkdtemp(
      join(tmpdir(), "clash-harness-dynamic-registry-"),
    );
    const shimPath = join(harnessDir, "clash-acp-dynamic-agent");
    try {
      const registryResponse = {
        agents: [
          {
            id: "dynamic-agent",
            name: "Dynamic Agent",
            version: "1.0.0",
            website: "https://example.com/dynamic-agent",
            distribution: {
              binary: {
                "darwin-aarch64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
                "darwin-x86_64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
                "linux-aarch64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
                "linux-x86_64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
                "windows-aarch64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
                "windows-x86_64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
              },
            },
          },
        ],
      };
      const adapter = createLocalAcpAdapter({
        detectAgents: async () => [],
        harnessDownloadDir: harnessDir,
        spawnEnv: {
          PATH: "",
          CLASH_ACP_BIN_DIR: harnessDir,
        },
        fetch: async (url) => {
          if (String(url).includes("registry.json")) {
            return new Response(JSON.stringify(registryResponse), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          expect(String(url)).toBe("https://example.com/dynamic-agent-bin");
          return new Response("fake-dynamic-agent", { status: 200 });
        },
      });

      await expect(adapter.listHarnesses()).resolves.toMatchObject({
        harnesses: expect.arrayContaining([
          expect.objectContaining({
            id: "dynamic-agent",
            label: "Dynamic Agent",
            binary: "clash-acp-dynamic-agent",
            available: false,
            installable: true,
            installSource: "registry",
            homepage: "https://example.com/dynamic-agent",
          }),
        ]),
      });

      await expect(
        adapter.installHarness("dynamic-agent"),
      ).resolves.toMatchObject({
        harnesses: expect.arrayContaining([
          expect.objectContaining({
            id: "dynamic-agent",
            binary: shimPath,
            available: true,
            installed: true,
          }),
        ]),
      });
      await expect(readFile(shimPath, "utf8")).resolves.toContain(
        "dynamic-agent-bin",
      );
      await expect(readFile(shimPath, "utf8")).resolves.toContain(
        "dynamic-agent-bin' 'acp' \"$@\"",
      );
    } finally {
      await rm(harnessDir, { recursive: true, force: true });
    }
  });

  it("starts registry Devin installs in ACP mode even when the registry omits args", async () => {
    const harnessDir = await mkdtemp(
      join(tmpdir(), "clash-harness-devin-registry-"),
    );
    const shimPath = join(harnessDir, "clash-acp-devin");
    try {
      const registryResponse = {
        agents: [
          {
            id: "devin",
            name: "Devin",
            version: "2026.8.18",
            distribution: {
              binary: {
                "darwin-aarch64": {
                  archive: "https://example.com/devin-bin",
                  cmd: "./devin-bin",
                },
                "darwin-x86_64": {
                  archive: "https://example.com/devin-bin",
                  cmd: "./devin-bin",
                },
                "linux-aarch64": {
                  archive: "https://example.com/devin-bin",
                  cmd: "./devin-bin",
                },
                "linux-x86_64": {
                  archive: "https://example.com/devin-bin",
                  cmd: "./devin-bin",
                },
                "windows-aarch64": {
                  archive: "https://example.com/devin-bin",
                  cmd: "./devin-bin",
                },
                "windows-x86_64": {
                  archive: "https://example.com/devin-bin",
                  cmd: "./devin-bin",
                },
              },
            },
          },
        ],
      };
      const adapter = createLocalAcpAdapter({
        detectAgents: async () => [],
        harnessDownloadDir: harnessDir,
        spawnEnv: {
          PATH: "",
          CLASH_ACP_BIN_DIR: harnessDir,
        },
        fetch: async (url) => {
          if (String(url).includes("registry.json")) {
            return new Response(JSON.stringify(registryResponse), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          expect(String(url)).toBe("https://example.com/devin-bin");
          return new Response("fake-devin", { status: 200 });
        },
      });

      await expect(adapter.installHarness("devin")).resolves.toMatchObject({
        harnesses: expect.arrayContaining([
          expect.objectContaining({
            id: "devin",
            installed: true,
          }),
        ]),
      });
      await expect(readFile(shimPath, "utf8")).resolves.toContain(
        "devin-bin' 'acp' \"$@\"",
      );
    } finally {
      await rm(harnessDir, { recursive: true, force: true });
    }
  });

  it("keeps auth probe results when a registry install refreshes the harness list", async () => {
    const harnessDir = await mkdtemp(
      join(tmpdir(), "clash-harness-install-probe-"),
    );
    const dynamicShim = join(harnessDir, "clash-acp-dynamic-agent");
    const cursorShim = join(harnessDir, "clash-acp-cursor");
    try {
      await writeFile(cursorShim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const registryResponse = {
        agents: [
          {
            id: "dynamic-agent",
            name: "Dynamic Agent",
            version: "1.0.0",
            distribution: {
              binary: {
                "darwin-aarch64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
                "darwin-x86_64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
                "linux-aarch64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
                "linux-x86_64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
                "windows-aarch64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
                "windows-x86_64": {
                  archive: "https://example.com/dynamic-agent-bin",
                  cmd: "./dynamic-agent-bin",
                  args: ["acp"],
                },
              },
            },
          },
        ],
      };
      const probeAgentAuth = vi.fn(async (agent: { id: string }) =>
        agent.id === "cursor"
          ? {
              status: "needs-auth" as const,
              message: "Cursor requires ACP authentication.",
              command: cursorShim,
            }
          : undefined,
      );
      const adapter = createLocalAcpAdapter({
        detectAgents: async () => [
          {
            id: "cursor",
            label: "Cursor",
            spec: { command: cursorShim, args: ["acp"] },
          },
        ],
        harnessDownloadDir: harnessDir,
        spawnEnv: {
          PATH: "",
          CLASH_ACP_BIN_DIR: harnessDir,
        },
        probeAgentAuth,
        fetch: async (url) => {
          if (String(url).includes("registry.json")) {
            return new Response(JSON.stringify(registryResponse), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          expect(String(url)).toBe("https://example.com/dynamic-agent-bin");
          return new Response("fake-dynamic-agent", { status: 200 });
        },
      });

      const installed = await adapter.installHarness("dynamic-agent");

      await expect(readFile(dynamicShim, "utf8")).resolves.toContain(
        "dynamic-agent-bin",
      );
      expect(installed.harnesses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "cursor",
            auth: expect.objectContaining({
              status: "needs-auth",
              message: "Cursor requires ACP authentication.",
            }),
          }),
          expect.objectContaining({
            id: "dynamic-agent",
            binary: dynamicShim,
            available: true,
            installed: true,
          }),
        ]),
      );
      expect(probeAgentAuth).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cursor" }),
      );
    } finally {
      await rm(harnessDir, { recursive: true, force: true });
    }
  });

  it("detects Zed-style custom agent server settings through the same probe path", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "clash-custom-agent-bin-"));
    const openclaw = join(binDir, "openclaw");
    try {
      await writeFile(openclaw, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const adapter = createLocalAcpAdapter({
        detectAgents: async () => [],
        agentCatalog: [],
        spawnEnv: {
          PATH: binDir,
          CLASH_ACP_BIN_DIR: "",
        },
        harnessConfig: {
          loadEnabledHarnessIds: async () => null,
          saveEnabledHarnessIds: vi.fn(),
          loadAgentServers: async () => ({
            "OpenClaw ACP": {
              type: "custom",
              command: "openclaw",
              args: ["acp", "--session", "agent:design:main"],
              env: {},
            },
          }),
          saveAgentServers: vi.fn(),
        },
      });

      await expect(adapter.listHarnesses({ probe: true })).resolves.toEqual({
        harnesses: [
          expect.objectContaining({
            id: "custom-openclaw-acp",
            label: "OpenClaw ACP",
            binary: openclaw,
            available: true,
            enabled: true,
            custom: true,
          }),
        ],
      });
      await expect(adapter.listRuntimes()).resolves.toMatchObject({
        runtimes: [
          {
            agents: [
              {
                id: "custom-openclaw-acp",
                label: "OpenClaw ACP",
                binary: openclaw,
              },
            ],
          },
        ],
      });
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });

  it("refuses to install non-installable harnesses", async () => {
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [],
      agentCatalog: [
        {
          id: "opencode",
          label: "OpenCode",
          spec: { command: "opencode", args: ["acp"] },
          homepage: "https://opencode.ai/",
        },
      ],
      harnessDownloadDir: "/tmp/clash-harness-download-disabled",
    });

    await expect(adapter.installHarness("opencode")).rejects.toThrow(
      "OpenCode is not installable from Clash",
    );
  });

  it("starts ACP sessions with the first detected local agent", async () => {
    const start = vi.fn<SessionManagerLike["start"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      probeAgentAuth: async () => undefined,
      createSessionManager: () => ({
        start,
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      createSessionId: () => "local-acp-session-1",
    });

    await expect(
      adapter.createSession({
        runtimeId: "desktop-local",
        agentTemplateId: "clash",
        projectId: "project-1",
        resumeAcpSessionId: "acp-existing",
        permissionMode: "codex:full-access",
      }),
    ).resolves.toEqual({ session_id: "local-acp-session-1" });

    expect(start).toHaveBeenCalledWith({
      session_id: "local-acp-session-1",
      agent_template_id: "clash",
      agent_id: "codex-acp",
      agent_spec: { command: "codex-acp" },
      permission_mode: "codex:full-access",
      project_id: "project-1",
      resume: { acp_session_id: "acp-existing" },
    });
  });

  it("forwards an ACP fork source without treating it as resume", async () => {
    const start = vi.fn<SessionManagerLike["start"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        { id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } },
      ],
      probeAgentAuth: async () => undefined,
      createSessionManager: () => ({
        start,
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      createSessionId: () => "local-acp-fork",
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentId: "codex-acp",
      projectId: "project-fork",
      forkFromAcpSessionId: "acp-source",
    });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "local-acp-fork",
        project_id: "project-fork",
        fork: { acp_session_id: "acp-source" },
      }),
    );
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty("resume");
  });

  it("detaches browser sockets without disposing the background ACP session", async () => {
    const dispose = vi.fn<SessionManagerLike["dispose"]>(async () => undefined);
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-background",
      createSessionManager: () => ({
        start: vi.fn(),
        prompt,
        cancel: vi.fn(),
        dispose,
      }),
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    const firstSocket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-background", firstSocket as never);
    firstSocket.emit("close");

    expect(dispose).not.toHaveBeenCalled();

    const secondSocket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-background", secondSocket as never);
    secondSocket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-after-detach",
        text: "hi",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledWith({
        session_id: "local-acp-background",
        turn_id: "turn-after-detach",
        text: "hi",
      });
    });
    expect(
      secondSocket.sent.map((raw) => JSON.parse(raw) as { type: string }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "attached" })]),
    );
  });

  it("broadcasts session.disposed after explicit dispose even when the manager is quiet", async () => {
    const dispose = vi.fn<SessionManagerLike["dispose"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-explicit-dispose",
      createSessionManager: () => ({
        start: vi.fn(),
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose,
      }),
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-explicit-dispose", socket as never);
    socket.emit("message", JSON.stringify({ type: "dispose" }));

    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledWith("local-acp-explicit-dispose");
      expect(
        socket.sent.map((raw) => JSON.parse(raw) as { type: string }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "session.disposed",
            session_id: "local-acp-explicit-dispose",
          }),
        ]),
      );
    });
  });

  it("disposes every background ACP session as one shutdown barrier", async () => {
    const sessionIds = ["local-acp-shutdown-1", "local-acp-shutdown-2"];
    const releases = [deferred(), deferred()];
    const disposers = releases.map((release) =>
      vi.fn(async () => release.promise),
    );
    let managerIndex = 0;
    let sessionIndex = 0;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => sessionIds[sessionIndex++]!,
      createSessionManager: () => {
        const dispose = disposers[managerIndex++]!;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose,
        };
      },
    });
    await adapter.createSession({ runtimeId: "desktop-local" });
    await adapter.createSession({ runtimeId: "desktop-local" });

    let shutdownSettled = false;
    const shutdown = adapter.disposeAll().then(() => {
      shutdownSettled = true;
    });
    await vi.waitFor(() => {
      expect(disposers[0]).toHaveBeenCalledWith(sessionIds[0]);
      expect(disposers[1]).toHaveBeenCalledWith(sessionIds[1]);
    });
    expect(shutdownSettled).toBe(false);
    releases[0]!.resolve();
    releases[1]!.resolve();
    await shutdown;

    expect(shutdownSettled).toBe(true);
  });

  it("broadcasts the first agent event immediately", async () => {
    let sendFromManager!: SessionSender;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-fast-first-agent-event",
      createSessionManager: (send) => {
        sendFromManager = send;
        return {
          start: vi.fn(),
          prompt: vi.fn(async () => undefined),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      agentMemberId: "local-clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket(
      "local-acp-fast-first-agent-event",
      socket as never,
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-first",
        text: "hello",
      }),
    );

    sendFromManager({
      type: "session.event",
      session_id: "local-acp-fast-first-agent-event",
      turn_id: "turn-first",
      event: {
        type: "agent_message_chunk",
        content: { type: "text", text: "hi immediately" },
      },
    });

    expect(socket.sent.map((frame) => JSON.parse(frame))).toContainEqual({
      type: "session.event",
      session_id: "local-acp-fast-first-agent-event",
      turn_id: "turn-first",
      event: {
        type: "agent_message_chunk",
        content: { type: "text", text: "hi immediately" },
      },
    });
  });

  it("drops transport diagnostics instead of emitting assistant messages", async () => {
    let sendFromManager!: SessionSender;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      probeAgentAuth: async () => undefined,
      createSessionId: () => "local-acp-diagnostics",
      createSessionManager: (send) => {
        sendFromManager = send;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentId: "codex-acp",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-diagnostics", socket as never);
    const before = socket.sent.length;

    sendFromManager({
      type: "session.event",
      session_id: "local-acp-diagnostics",
      turn_id: "turn-diagnostic",
      event: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Falling back from WebSockets to HTTPS transport. request timed out",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.sent).toHaveLength(before);
  });

  it("keeps ACP transcript replay out while forwarding setup events", async () => {
    let sendFromManager!: SessionSender;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-load-replay",
      nowSeconds: () => 1_700_000_010,
      createSessionManager: (send) => {
        sendFromManager = send;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentId: "codex-acp",
      agentMemberId: "local-clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-load-replay", socket as never);
    const before = socket.sent.length;

    sendFromManager({
      type: "session.ready",
      session_id: "local-acp-load-replay",
      acp_session_id: "acp-loaded",
      supports_session_fork: true,
      replay_events: [
        {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "review", description: "Review current project" },
          ],
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "restored from ACP load" },
        },
      ],
    });

    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(before + 2);
    });
    const ready = JSON.parse(socket.sent[before] ?? "{}");
    expect(ready).toEqual({
      type: "session.ready",
      session_id: "local-acp-load-replay",
      acp_session_id: "acp-loaded",
      supports_session_fork: true,
    });
    expect(ready).not.toHaveProperty("replay_events");
    expect(JSON.parse(socket.sent[before + 1] ?? "{}")).toEqual({
      type: "session.event",
      session_id: "local-acp-load-replay",
      event: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "review", description: "Review current project" },
        ],
      },
    });
  });

  it("forwards available commands as live setup state", async () => {
    let sendFromManager!: SessionSender;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-commands",
      createSessionManager: (send) => {
        sendFromManager = send;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentId: "codex-acp",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-commands", socket as never);
    const before = socket.sent.length;

    sendFromManager({
      type: "session.event",
      session_id: "local-acp-commands",
      turn_id: "turn-commands",
      event: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "review", description: "Review current project" },
        ],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.sent).toHaveLength(before + 1);
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "session.event",
      turn_id: "turn-commands",
      event: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "review", description: "Review current project" },
        ],
      },
    });
  });

  it("forwards transient session status", async () => {
    let sendFromManager!: SessionSender;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-status",
      createSessionManager: (send) => {
        sendFromManager = send;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentId: "codex-acp",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-status", socket as never);
    const before = socket.sent.length;

    sendFromManager({
      type: "session.status",
      session_id: "local-acp-status",
      turn_id: "turn-status",
      status: "reconnecting",
      message: "Reconnecting... 2/5",
      detail: "request timed out",
      attempt: 2,
      maxAttempts: 5,
    });

    expect(socket.sent).toHaveLength(before + 1);
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "session.status",
      session_id: "local-acp-status",
      turn_id: "turn-status",
      status: "reconnecting",
      message: "Reconnecting... 2/5",
      detail: "request timed out",
      attempt: 2,
      maxAttempts: 5,
    });
  });

  it("forwards generic stderr diagnostics", async () => {
    let sendFromManager!: SessionSender;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      probeAgentAuth: async () => undefined,
      createSessionId: () => "local-acp-generic-diagnostic",
      createSessionManager: (send) => {
        sendFromManager = send;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentId: "codex-acp",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-generic-diagnostic", socket as never);
    const before = socket.sent.length;

    sendFromManager({
      type: "session.diagnostic",
      session_id: "local-acp-generic-diagnostic",
      turn_id: "turn-diagnostic",
      diagnostic: {
        stream: "stderr",
        severity: "warning",
        message: "provider cache warmup took 3020ms",
        raw: "WARN provider cache warmup took 3020ms",
      },
    });

    expect(socket.sent).toHaveLength(before + 1);
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "session.diagnostic",
      session_id: "local-acp-generic-diagnostic",
      turn_id: "turn-diagnostic",
      diagnostic: {
        stream: "stderr",
        severity: "warning",
        message: "provider cache warmup took 3020ms",
      },
    });
  });

  it("emits prompt errors instead of leaving the turn spinning", async () => {
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-error",
      createSessionManager: () => ({
        start: vi.fn(),
        prompt: vi.fn(async () => {
          throw new Error("agent exited");
        }),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-error", socket as never);
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-error",
        text: "hi",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      socket.sent.map(
        (raw) => JSON.parse(raw) as { type: string; message?: string },
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session.error",
          message: "agent exited",
        }),
      ]),
    );
  });

  it("classifies and redacts ACP authentication failures before delivery", async () => {
    let sendFromManager!: SessionSender;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-auth-error",
      createSessionManager: (send) => {
        sendFromManager = send;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentId: "codex-acp",
    });
    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-auth-error", socket as never);

    sendFromManager({
      type: "session.error",
      session_id: "local-acp-auth-error",
      turn_id: "turn-auth",
      message:
        "Authentication required: token=topsecret Bearer sk-secretvalue123",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual(
      expect.objectContaining({
        type: "session.error",
        code: "auth_required",
        agent_id: "codex-acp",
        message: "Authentication required: token=[redacted] Bearer [redacted]",
      }),
    );
    expect(socket.sent.join("\n")).not.toContain("topsecret");
    expect(socket.sent.join("\n")).not.toContain("secretvalue123");
  });

  it("serializes prompt calls for a local ACP session", async () => {
    const firstRelease = deferred();
    const secondRelease = deferred();
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async (params) => {
      if (params.turn_id === "turn-1") {
        await firstRelease.promise;
        return;
      }
      if (params.turn_id === "turn-2") {
        await secondRelease.promise;
        return;
      }
    });
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-serialized-prompts",
      createSessionManager: () => ({
        start: vi.fn(),
        prompt,
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-serialized-prompts", socket as never);
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-1",
        text: "first",
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-2",
        text: "second",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenNthCalledWith(1, {
        session_id: "local-acp-serialized-prompts",
        turn_id: "turn-1",
        text: "first",
      });
    });

    firstRelease.resolve();
    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(prompt).toHaveBeenNthCalledWith(2, {
        session_id: "local-acp-serialized-prompts",
        turn_id: "turn-2",
        text: "second",
      });
    });
    secondRelease.resolve();
  });

  it("queues one follow-up prompt per agent loop in single mode", async () => {
    const firstRelease = deferred();
    const secondRelease = deferred();
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async (params) => {
      if (params.turn_id === "turn-1") await firstRelease.promise;
      if (params.turn_id === "turn-2") await secondRelease.promise;
    });
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-single-queue",
      nowSeconds: () => 1_700_000_100,
      createSessionManager: () => ({
        start: vi.fn(),
        prompt,
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-single-queue", socket as never);
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-1",
        text: "first",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-2",
        text: "second",
        queue_mode: "single",
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-3",
        text: "third",
        queue_mode: "single",
      }),
    );

    await vi.waitFor(() => {
      const queueUpdates = socket.sent
        .map((raw) => JSON.parse(raw) as any)
        .filter((msg) => msg.type === "session.queue_update");
      expect(queueUpdates.at(-1)).toMatchObject({
        mode: "single",
        active_turn_id: "turn-1",
        queued: [
          { turn_id: "turn-2", text: "second" },
          { turn_id: "turn-3", text: "third" },
        ],
      });
    });
    expect(prompt).toHaveBeenCalledTimes(1);

    firstRelease.resolve();
    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(prompt).toHaveBeenNthCalledWith(2, {
        session_id: "local-acp-single-queue",
        turn_id: "turn-2",
        text: "second",
      });
    });
    expect(prompt).toHaveBeenCalledTimes(2);

    secondRelease.resolve();
    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(3);
      expect(prompt).toHaveBeenNthCalledWith(3, {
        session_id: "local-acp-single-queue",
        turn_id: "turn-3",
        text: "third",
      });
    });
  });

  it("flushes all queued follow-up prompts after the current loop when requested", async () => {
    const firstRelease = deferred();
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async (params) => {
      if (params.turn_id === "turn-1") await firstRelease.promise;
    });
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-flush-queue",
      createSessionManager: () => ({
        start: vi.fn(),
        prompt,
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-flush-queue", socket as never);
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-1",
        text: "first",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "set_prompt_queue_mode",
        queue_mode: "flush",
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-2",
        text: "second",
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-3",
        text: "third",
      }),
    );

    firstRelease.resolve();
    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(3);
      expect(prompt).toHaveBeenNthCalledWith(2, {
        session_id: "local-acp-flush-queue",
        turn_id: "turn-2",
        text: "second",
      });
      expect(prompt).toHaveBeenNthCalledWith(3, {
        session_id: "local-acp-flush-queue",
        turn_id: "turn-3",
        text: "third",
      });
    });
  });

  it("clears queued follow-up prompts on request", async () => {
    const firstRelease = deferred();
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async (params) => {
      if (params.turn_id === "turn-1") await firstRelease.promise;
    });
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-clear-queue",
      createSessionManager: () => ({
        start: vi.fn(),
        prompt,
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-clear-queue", socket as never);
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-1",
        text: "first",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-2",
        text: "second",
      }),
    );
    await vi.waitFor(() => {
      const queueUpdates = socket.sent
        .map((raw) => JSON.parse(raw) as any)
        .filter((msg) => msg.type === "session.queue_update");
      expect(queueUpdates.at(-1)).toMatchObject({
        queued: [{ turn_id: "turn-2", text: "second" }],
      });
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "clear_prompt_queue",
      }),
    );

    await vi.waitFor(() => {
      const queueUpdates = socket.sent
        .map((raw) => JSON.parse(raw) as any)
        .filter((msg) => msg.type === "session.queue_update");
      expect(queueUpdates.at(-1)).toMatchObject({
        queued: [],
      });
    });

    firstRelease.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("steers an already queued prompt through prompt immediately", async () => {
    const firstRelease = deferred();
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async (params) => {
      if (params.turn_id === "turn-1") await firstRelease.promise;
    });
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-steer-existing-queue",
      createSessionManager: () => ({
        start: vi.fn(),
        prompt,
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      nowSeconds: () => 1_700_000_000,
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket(
      "local-acp-steer-existing-queue",
      socket as never,
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-1",
        text: "first",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-2",
        text: "second",
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "steer_queued_prompt",
        turn_id: "turn-2",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(prompt).toHaveBeenNthCalledWith(2, {
        session_id: "local-acp-steer-existing-queue",
        turn_id: "turn-2",
        text: "second",
      });
    });
    const queueUpdates = socket.sent
      .map((raw) => JSON.parse(raw) as any)
      .filter((msg) => msg.type === "session.queue_update");
    expect(queueUpdates.at(-1)).toMatchObject({ queued: [] });
  });

  it("dispatches a queued steer immediately without waiting for another tool call", async () => {
    let sendFromManager!: SessionSender;
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-steer-tool-boundary",
      createSessionManager: (send) => {
        sendFromManager = send;
        return {
          start: vi.fn(),
          prompt,
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-steer-tool-boundary", socket as never);
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-1",
        text: "run tools",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    sendFromManager({
      type: "session.event",
      session_id: "local-acp-steer-tool-boundary",
      turn_id: "turn-1",
      event: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "tool-call-01",
      },
    });
    sendFromManager({
      type: "session.event",
      session_id: "local-acp-steer-tool-boundary",
      turn_id: "turn-1",
      event: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-2",
        title: "tool-call-02",
      },
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-hi",
        text: "hi",
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "steer_queued_prompt",
        turn_id: "turn-hi",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(prompt).toHaveBeenNthCalledWith(2, {
        session_id: "local-acp-steer-tool-boundary",
        turn_id: "turn-hi",
        text: "hi",
      });
    });
  });

  it("forwards steered queued prompts to the agent immediately while a turn is running", async () => {
    const firstRelease = deferred();
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async (params) => {
      if (params.turn_id === "turn-1") await firstRelease.promise;
    });
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-steer-queue",
      createSessionManager: () => ({
        start: vi.fn(),
        prompt,
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-steer-queue", socket as never);
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-1",
        text: "first",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-steer",
        text: "use that output next",
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "steer_queued_prompt",
        turn_id: "turn-steer",
      }),
    );
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenNthCalledWith(2, {
      session_id: "local-acp-steer-queue",
      turn_id: "turn-steer",
      text: "use that output next",
    });

    firstRelease.resolve();
  });

  it("does not keep a cancelled turn busy for the next prompt", async () => {
    const firstRelease = deferred();
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async (params) => {
      if (params.turn_id === "turn-1") await firstRelease.promise;
    });
    const cancel = vi.fn<SessionManagerLike["cancel"]>();
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-cancel-next",
      createSessionManager: () => ({
        start: vi.fn(),
        prompt,
        cancel,
        dispose: vi.fn(),
      }),
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentId: "codex-acp",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-cancel-next", socket as never);
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-1",
        text: "first",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    socket.emit(
      "message",
      JSON.stringify({ type: "cancel", turn_id: "turn-1" }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-2",
        text: "after stop",
      }),
    );

    const queueUpdates = socket.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === "session.queue_update");
    expect(queueUpdates.at(-1)).toMatchObject({
      active_turn_id: null,
      queued: [],
    });
    expect(cancel).toHaveBeenCalledWith("local-acp-cancel-next", "turn-1");

    firstRelease.resolve();
    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(prompt).toHaveBeenNthCalledWith(2, {
        session_id: "local-acp-cancel-next",
        turn_id: "turn-2",
        text: "after stop",
      });
    });
  });

  it("does not drain after-turn queued prompts while a direct steer prompt is still in flight", async () => {
    const firstRelease = deferred();
    const steerRelease = deferred();
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async (params) => {
      if (params.turn_id === "turn-1") await firstRelease.promise;
      if (params.turn_id === "turn-steer") await steerRelease.promise;
    });
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-steer-before-after-turn",
      createSessionManager: () => ({
        start: vi.fn(),
        prompt,
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket(
      "local-acp-steer-before-after-turn",
      socket as never,
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-1",
        text: "first",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-steer",
        text: "insert this after the next model call",
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "steer_queued_prompt",
        turn_id: "turn-steer",
      }),
    );

    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(prompt).toHaveBeenNthCalledWith(2, {
        session_id: "local-acp-steer-before-after-turn",
        turn_id: "turn-steer",
        text: "insert this after the next model call",
      });
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "prompt",
        turn_id: "turn-after",
        text: "after turn follow-up",
        queue_mode: "single",
      }),
    );

    firstRelease.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompt).toHaveBeenCalledTimes(2);

    steerRelease.resolve();
    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(3);
      expect(prompt).toHaveBeenNthCalledWith(3, {
        session_id: "local-acp-steer-before-after-turn",
        turn_id: "turn-after",
        text: "after turn follow-up",
      });
    });
  });

  it("uses the official Zed Codex harness by default", async () => {
    const start = vi.fn<SessionManagerLike["start"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
        {
          id: "claude-acp",
          label: "Claude",
          spec: { command: "claude-agent-acp" },
        },
      ],
      createSessionManager: () => ({
        start,
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      createSessionId: () => "local-acp-session-preferred",
    });

    await expect(adapter.listRuntimes()).resolves.toMatchObject({
      runtimes: [
        {
          agents: expect.arrayContaining([
            expect.objectContaining({ id: "codex-acp", binary: "codex-acp" }),
          ]),
        },
      ],
    });

    await expect(adapter.listHarnesses()).resolves.toMatchObject({
      harnesses: expect.arrayContaining([
        expect.objectContaining({
          id: "codex-acp",
          enabled: true,
          available: true,
        }),
        expect.objectContaining({
          id: "claude-acp",
          enabled: true,
          available: true,
        }),
      ]),
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      projectId: "project-1",
    });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "codex-acp",
      }),
    );
  });

  it("starts ACP sessions with the requested local agent override", async () => {
    const start = vi.fn<SessionManagerLike["start"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
        {
          id: "claude-acp",
          label: "Claude",
          spec: { command: "claude-agent-acp" },
        },
      ],
      createSessionManager: () => ({
        start,
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      createSessionId: () => "local-acp-session-agent",
    });

    await expect(
      adapter.createSession({
        runtimeId: "desktop-local",
        agentTemplateId: "generator",
        agentMemberId: "local-generator",
        agentId: "claude-acp",
        projectId: "project-1",
      }),
    ).resolves.toEqual({ session_id: "local-acp-session-agent" });

    expect(start).toHaveBeenCalledWith({
      session_id: "local-acp-session-agent",
      agent_template_id: "generator",
      agent_id: "claude-acp",
      agent_spec: { command: "claude-agent-acp" },
      agent_member_id: "local-generator",
      project_id: "project-1",
    });
  });

  it("passes dynamically detected agent specs to the session manager", async () => {
    const start = vi.fn<SessionManagerLike["start"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "devin",
          label: "Devin",
          spec: {
            command: "/tmp/clash-acp-devin",
            args: ["acp"],
            env: { DEVIN_PROJECT: "clash" },
          },
        },
      ],
      probeAgentAuth: async () => undefined,
      createSessionManager: () => ({
        start,
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      createSessionId: () => "local-acp-session-devin",
    });

    await expect(
      adapter.createSession({
        runtimeId: "desktop-local",
        agentId: "devin",
        projectId: "project-1",
      }),
    ).resolves.toEqual({ session_id: "local-acp-session-devin" });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "local-acp-session-devin",
        agent_id: "devin",
        agent_spec: {
          command: "/tmp/clash-acp-devin",
          args: ["acp"],
          env: { DEVIN_PROJECT: "clash" },
        },
      }),
    );
  });

  it("injects desktop local API env into spawned agent sessions", async () => {
    const setSpawnEnv = vi.fn<NonNullable<SessionManagerLike["setSpawnEnv"]>>();
    const start = vi.fn<SessionManagerLike["start"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      spawnEnv: {
        CLASH_API_URL: "http://127.0.0.1:49396",
      },
      createSessionManager: () => ({
        setSpawnEnv,
        start,
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      createSessionId: () => "local-acp-session-env",
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      agentMemberId: "local-clash",
      projectId: "project-env",
    });

    expect(setSpawnEnv).toHaveBeenCalledWith({
      CLASH_API_URL: "http://127.0.0.1:49396",
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "codex-acp",
        agent_member_id: "local-clash",
        project_id: "project-env",
      }),
    );
  });

  it("keeps the held ACP child session after the last browser socket disconnects", async () => {
    const dispose = vi.fn<SessionManagerLike["dispose"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionManager: () => ({
        start: vi.fn(),
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose,
      }),
      createSessionId: () => "local-acp-session-owned-child",
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      agentMemberId: "local-clash",
      projectId: "project-owned-child",
    });

    const ws = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    } as any;
    adapter.bindSessionSocket("local-acp-session-owned-child", ws);
    const closeHandler = ws.on.mock.calls.find(
      ([event]: [string]) => event === "close",
    )?.[1];
    expect(closeHandler).toBeTypeOf("function");

    closeHandler();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dispose).not.toHaveBeenCalled();
  });

  it("keeps the active child running after disconnect without retaining its transcript", async () => {
    let sendToBrowser!: SessionSender;
    const promptStarted = deferred<SessionPromptParamsLike>();
    const releasePrompt = deferred();
    const dispose = vi.fn<SessionManagerLike["dispose"]>(async () => undefined);
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async (params) => {
      promptStarted.resolve(params);
      await releasePrompt.promise;
      sendToBrowser({
        type: "session.event",
        session_id: params.session_id,
        turn_id: params.turn_id,
        event: { type: "text", text: "background reply" },
      });
      sendToBrowser({
        type: "session.complete",
        session_id: params.session_id,
        turn_id: params.turn_id,
      });
    });
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionManager: (send) => {
        sendToBrowser = send;
        return {
          start: vi.fn(),
          prompt,
          cancel: vi.fn(),
          dispose,
        };
      },
      createSessionId: () => "local-acp-session-background-turn",
      nowSeconds: (() => {
        let now = 1_700_000_100;
        return () => now++;
      })(),
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      agentMemberId: "local-clash",
      projectId: "project-background-turn",
    });

    const firstSocket = new FakeSocket();
    adapter.bindSessionSocket(
      "local-acp-session-background-turn",
      firstSocket as any,
    );
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "prompt",
          turn_id: "turn-bg",
          text: "keep running",
        }),
      ),
    );
    await expect(promptStarted.promise).resolves.toEqual({
      session_id: "local-acp-session-background-turn",
      turn_id: "turn-bg",
      text: "keep running",
    });

    firstSocket.emit("close");
    releasePrompt.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dispose).not.toHaveBeenCalled();

    const secondSocket = new FakeSocket();
    adapter.bindSessionSocket(
      "local-acp-session-background-turn",
      secondSocket as any,
    );
    expect(secondSocket.sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        type: "attached",
        session_id: "local-acp-session-background-turn",
        daemon_online: true,
      },
    ]);
  });

  it("attaches with current setup state and never replays transcript backlog", async () => {
    let sendToBrowser!: SessionSender;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionManager: (send) => {
        sendToBrowser = send;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
      createSessionId: () => "local-acp-session-no-replay",
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      projectId: "project-no-replay",
    });

    sendToBrowser({
      type: "session.ready",
      session_id: "local-acp-session-no-replay",
      acp_session_id: "acp-no-replay",
      supports_session_fork: false,
      config_options: [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "gpt-5.5",
          options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
        },
      ],
    });
    sendToBrowser({
      type: "session.event",
      session_id: "local-acp-session-no-replay",
      turn_id: "turn-replay",
      event: { type: "text", text: "already loaded from db" },
    });
    sendToBrowser({
      type: "session.complete",
      session_id: "local-acp-session-no-replay",
      turn_id: "turn-replay",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-session-no-replay", socket as any);

    expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        type: "attached",
        session_id: "local-acp-session-no-replay",
        daemon_online: true,
      },
      {
        type: "session.ready",
        session_id: "local-acp-session-no-replay",
        acp_session_id: "acp-no-replay",
        supports_session_fork: false,
        config_options: [
          {
            id: "model",
            name: "Model",
            type: "select",
            category: "model",
            currentValue: "gpt-5.5",
            options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
          },
        ],
      },
      {
        type: "session.config_options",
        session_id: "local-acp-session-no-replay",
        config_options: [
          {
            id: "model",
            name: "Model",
            type: "select",
            category: "model",
            currentValue: "gpt-5.5",
            options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
          },
        ],
      },
    ]);
  });

  it("relays ACP config option updates between session manager and browser clients", async () => {
    let sendToBrowser!: SessionSender;
    const setConfigOption = vi.fn<
      NonNullable<SessionManagerLike["setConfigOption"]>
    >(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionManager: (send) => {
        sendToBrowser = send;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
          setConfigOption,
        };
      },
      createSessionId: () => "local-acp-session-config",
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      projectId: "project-config",
    });

    const ws = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    } as any;
    adapter.bindSessionSocket("local-acp-session-config", ws);
    const messageHandler = ws.on.mock.calls.find(
      ([event]: [string]) => event === "message",
    )?.[1];
    expect(messageHandler).toBeTypeOf("function");

    sendToBrowser({
      type: "session.config_options",
      session_id: "local-acp-session-config",
      config_options: [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "gpt-5.5",
          options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
        },
      ],
    });

    expect(ws.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: "session.config_options",
        session_id: "local-acp-session-config",
        config_options: [
          {
            id: "model",
            name: "Model",
            type: "select",
            category: "model",
            currentValue: "gpt-5.5",
            options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
          },
        ],
      }),
    );

    messageHandler(
      Buffer.from(
        JSON.stringify({
          type: "set_config_option",
          config_id: "model",
          value: "gpt-5.4",
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setConfigOption).toHaveBeenCalledWith(
      "local-acp-session-config",
      "model",
      "gpt-5.4",
    );
  });

  it("forwards initial ACP config before the session manager starts", async () => {
    const start = vi.fn<SessionManagerLike["start"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionManager: () => ({
        start,
        prompt: vi.fn(),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      createSessionId: () => "local-acp-session-initial-config",
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      projectId: "project-initial-config",
      configValues: {
        mode: "agent",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "local-acp-session-initial-config",
        config_options: {
          mode: "agent",
          model: "gpt-5.6-sol",
          effort: "high",
        },
      }),
    );
  });

  it("relays ACP session mode updates between session manager and browser clients", async () => {
    let sendToBrowser!: SessionSender;
    const setMode = vi.fn<NonNullable<SessionManagerLike["setMode"]>>(
      async () => undefined,
    );
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionManager: (send) => {
        sendToBrowser = send;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
          setMode,
        };
      },
      createSessionId: () => "local-acp-session-mode",
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      projectId: "project-mode",
    });

    const ws = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    } as any;
    adapter.bindSessionSocket("local-acp-session-mode", ws);
    const messageHandler = ws.on.mock.calls.find(
      ([event]: [string]) => event === "message",
    )?.[1];
    expect(messageHandler).toBeTypeOf("function");

    sendToBrowser({
      type: "session.mode",
      session_id: "local-acp-session-mode",
      modes: {
        currentModeId: "code",
        availableModes: [
          { id: "ask", name: "Ask" },
          { id: "code", name: "Code" },
        ],
      },
    });

    expect(ws.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: "session.mode",
        session_id: "local-acp-session-mode",
        modes: {
          currentModeId: "code",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "code", name: "Code" },
          ],
        },
      }),
    );

    messageHandler(
      Buffer.from(
        JSON.stringify({
          type: "set_session_mode",
          mode_id: "ask",
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setMode).toHaveBeenCalledWith("local-acp-session-mode", "ask");
  });

  it("brokers ACP permission requests out of band and waits for the browser decision", async () => {
    let requestPermission!: SessionPermissionBroker;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionManager: (_send, broker) => {
        requestPermission = broker!;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
      createSessionId: () => "local-acp-session-permission",
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      projectId: "project-permission",
    });

    const ws = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    } as any;
    adapter.bindSessionSocket("local-acp-session-permission", ws);
    const messageHandler = ws.on.mock.calls.find(
      ([event]: [string]) => event === "message",
    )?.[1];
    const decision = requestPermission("local-acp-session-permission", {
      sessionId: "acp-session-permission",
      toolCall: { toolCallId: "tool-1", title: "Edit file" },
      options: [
        { optionId: "reject", name: "Reject", kind: "reject_once" },
        { optionId: "allow", name: "Allow", kind: "allow_once" },
      ],
    });

    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalledTimes(2);
    });
    const request = JSON.parse(ws.send.mock.calls.at(-1)?.[0] ?? "{}");
    expect(request).toMatchObject({
      type: "session.permission_request",
      session_id: "local-acp-session-permission",
      tool_call: { toolCallId: "tool-1", title: "Edit file" },
      options: [
        { optionId: "reject", name: "Reject", kind: "reject_once" },
        { optionId: "allow", name: "Allow", kind: "allow_once" },
      ],
    });
    expect(request.request_id).toEqual(expect.any(String));

    messageHandler(
      Buffer.from(
        JSON.stringify({
          type: "permission_response",
          request_id: request.request_id,
          option_id: "allow",
        }),
      ),
    );

    await expect(decision).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("brokers ACP form elicitation and returns the browser's structured answer", async () => {
    let requestElicitation!: SessionElicitationBroker;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        { id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } },
      ],
      createSessionManager: (_send, _permissionBroker, elicitationBroker) => {
        requestElicitation = elicitationBroker!;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
      createSessionId: () => "local-acp-session-elicitation",
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      projectId: "project-elicitation",
    });

    const ws = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    } as any;
    adapter.bindSessionSocket("local-acp-session-elicitation", ws);
    const messageHandler = ws.on.mock.calls.find(
      ([event]: [string]) => event === "message",
    )?.[1];
    const decision = requestElicitation("local-acp-session-elicitation", {
      mode: "form",
      sessionId: "acp-session-elicitation",
      toolCallId: "tool-ask",
      message: "Choose the release settings",
      requestedSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            title: "Channel",
            enum: ["stable", "preview"],
          },
          notes: { type: "string", title: "Notes" },
        },
        required: ["channel"],
      },
    });

    await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2));
    const request = JSON.parse(ws.send.mock.calls.at(-1)?.[0] ?? "{}");
    expect(request).toMatchObject({
      type: "session.elicitation_request",
      session_id: "local-acp-session-elicitation",
      mode: "form",
      message: "Choose the release settings",
      tool_call_id: "tool-ask",
      requested_schema: {
        properties: {
          channel: { type: "string", enum: ["stable", "preview"] },
          notes: { type: "string" },
        },
      },
    });
    expect(request.request_id).toEqual(expect.any(String));

    messageHandler(
      Buffer.from(
        JSON.stringify({
          type: "elicitation_response",
          request_id: request.request_id,
          action: "accept",
          content: { channel: "stable", notes: "Ship it" },
        }),
      ),
    );

    await expect(decision).resolves.toEqual({
      action: "accept",
      content: { channel: "stable", notes: "Ship it" },
    });
    expect(JSON.parse(ws.send.mock.calls.at(-1)?.[0] ?? "{}")).toMatchObject({
      type: "session.elicitation_resolved",
      request_id: request.request_id,
      mode: "form",
      message: "Choose the release settings",
      action: "accept",
      content: { channel: "stable", notes: "Ship it" },
    });
  });

  it("brokers safe ACP URL elicitation and returns the browser decision", async () => {
    let requestElicitation!: SessionElicitationBroker;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        { id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } },
      ],
      createSessionManager: (_send, _permissionBroker, elicitationBroker) => {
        requestElicitation = elicitationBroker!;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
      createSessionId: () => "local-acp-session-url-elicitation",
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      projectId: "project-url-elicitation",
    });

    const ws = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    } as any;
    adapter.bindSessionSocket("local-acp-session-url-elicitation", ws);
    const messageHandler = ws.on.mock.calls.find(
      ([event]: [string]) => event === "message",
    )?.[1];
    const decision = requestElicitation("local-acp-session-url-elicitation", {
      mode: "url",
      sessionId: "acp-session-url-elicitation",
      message: "Sign in with GitHub",
      elicitationId: "github-oauth-1",
      url: "https://github.com/login/oauth/authorize?client_id=clash",
    });

    await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2));
    const request = JSON.parse(ws.send.mock.calls.at(-1)?.[0] ?? "{}");
    expect(request).toMatchObject({
      type: "session.elicitation_request",
      session_id: "local-acp-session-url-elicitation",
      mode: "url",
      message: "Sign in with GitHub",
      elicitation_id: "github-oauth-1",
      url: "https://github.com/login/oauth/authorize?client_id=clash",
    });

    messageHandler(
      Buffer.from(
        JSON.stringify({
          type: "elicitation_response",
          request_id: request.request_id,
          action: "accept",
        }),
      ),
    );

    await expect(decision).resolves.toEqual({ action: "accept" });
    expect(JSON.parse(ws.send.mock.calls.at(-1)?.[0] ?? "{}")).toMatchObject({
      type: "session.elicitation_resolved",
      mode: "url",
      elicitation_id: "github-oauth-1",
      action: "accept",
    });
  });

  it("declines unsafe ACP URL elicitation before it reaches the browser", async () => {
    let requestElicitation!: SessionElicitationBroker;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        { id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } },
      ],
      createSessionManager: (_send, _permissionBroker, elicitationBroker) => {
        requestElicitation = elicitationBroker!;
        return {
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
      createSessionId: () => "local-acp-session-unsafe-url",
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
    });
    const ws = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    } as any;
    adapter.bindSessionSocket("local-acp-session-unsafe-url", ws);

    await expect(
      requestElicitation("local-acp-session-unsafe-url", {
        mode: "url",
        sessionId: "acp-session-unsafe-url",
        message: "Open this page",
        elicitationId: "unsafe-url-1",
        url: "javascript:alert(document.cookie)",
      }),
    ).resolves.toEqual({ action: "decline" });

    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it.each(["synchronous", "asynchronous", "rejected"])("preserves a text task's %s startup error and disposes without sending a prompt", async (failure) => {
    let sendToBrowser!: SessionSender;
    const prompt = vi.fn<SessionManagerLike["prompt"]>(async ({ session_id, turn_id }) => {
      sendToBrowser({ type: "session.error", session_id, turn_id, message: "no such session" });
    });
    const dispose = vi.fn<SessionManagerLike["dispose"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [{ id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } }],
      createSessionManager: (send) => {
        sendToBrowser = send;
        return {
          start: vi.fn(async ({ session_id }) => {
            if (failure !== "synchronous") await new Promise((resolve) => setTimeout(resolve, 0));
            if (failure === "rejected") throw new Error("Agent executable could not start");
            send({ type: "session.error", session_id, message: "Agent executable could not start" });
          }),
          prompt, cancel: vi.fn(), dispose,
        };
      },
      createSessionId: () => "text-startup-error",
    });
    await expect(adapter.runTextTask({ projectId: "text-project", prompt: "Write a caption" })).rejects.toThrow("Agent executable could not start");
    expect(prompt).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledWith("text-startup-error");
  });

  it.each([false, true])("publishes the structured final answer without warning or commentary chunks (wrapped=%s)", async (wrapped) => {
    let sendToBrowser!: SessionSender;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [{ id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } }],
      createSessionManager: (send) => {
        sendToBrowser = send;
        return {
          start: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
          prompt: async ({ session_id, turn_id }) => {
            // The shipped codex-acp adapter emits _meta.codex.phase on model
            // messages; its compatibility warning chunks have no phase.
            for (const [text, phase] of [["Warning: adapter notice.\n", undefined], ["I am writing.\n", "commentary"], ["Warning: a legitimate opening.\n", "final_answer"], ["The cat sleeps.", "final_answer"]]) {
              const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(phase ? { _meta: { codex: { phase } } } : {}) };
              sendToBrowser({ type: "session.event", session_id, turn_id, event: wrapped ? { update } : update });
            }
            sendToBrowser({ type: "session.complete", session_id, turn_id });
          },
        };
      },
    });
    const result = await adapter.runTextTask({ projectId: "text-project", prompt: "Write a caption" });
    expect(result.text).toBe("Warning: a legitimate opening.\nThe cat sleeps.");
  });

  it("times out a starting text task without sending a late prompt", async () => {
    const startup = deferred();
    const prompt = vi.fn<SessionManagerLike["prompt"]>();
    const dispose = vi.fn<SessionManagerLike["dispose"]>(async () => undefined);
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [{ id: "codex-acp", label: "Codex", spec: { command: "codex-acp" } }],
      createSessionManager: () => ({ start: () => startup.promise, prompt, cancel: vi.fn(), dispose }),
      createSessionId: () => "text-startup-timeout",
    });
    await expect(adapter.runTextTask({ projectId: "text-project", prompt: "Write a caption", timeoutMs: 10 })).rejects.toThrow("timed out");
    startup.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompt).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledWith("text-startup-timeout");
  });

  it("passes the selected ACP model before running a one-shot text task", async () => {
    let sendToBrowser!: SessionSender;
    const setConfigOption = vi.fn<
      NonNullable<SessionManagerLike["setConfigOption"]>
    >(async () => undefined);
    const prompt = vi.fn<NonNullable<SessionManagerLike["prompt"]>>(
      async ({ session_id, turn_id, text }) => {
        sendToBrowser({
          type: "session.event",
          session_id,
          turn_id,
          event: { type: "text", text: `agent result: ${text}` },
        });
        sendToBrowser({
          type: "session.complete",
          session_id,
          turn_id,
        });
      },
    );
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionManager: (send) => {
        sendToBrowser = send;
        return {
          start: vi.fn(async ({ session_id, agent_template_id }) => {
            if (agent_template_id && !await readAgentRuntime(agent_template_id)) {
              throw new Error(`unknown agent template: ${agent_template_id}`);
            }
            send({
              type: "session.ready",
              session_id,
              acp_session_id: "acp-text-model",
              supports_session_fork: false,
              config_options: [
                {
                  id: "model",
                  name: "Model",
                  type: "select",
                  category: "model",
                  currentValue: "auto",
                  options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
                },
              ],
            });
          }),
          prompt,
          cancel: vi.fn(),
          dispose: vi.fn(),
          setConfigOption,
        };
      },
      createSessionId: () => "local-acp-session-text-model",
    });

    const result = await adapter.runTextTask({
      projectId: "project-text-model",
      prompt: "write a caption",
      modelId: "gpt-5.4",
    });

    expect(result.text).toContain("write a caption");
    expect(setConfigOption).toHaveBeenCalledWith(
      "local-acp-session-text-model",
      "model",
      "gpt-5.4",
    );
    expect(prompt).toHaveBeenCalled();
    expect(setConfigOption.mock.invocationCallOrder[0]).toBeLessThan(
      prompt.mock.invocationCallOrder[0],
    );
  });

  it("restarts an idle ACP child with the latest shim and resumes the existing ACP session", async () => {
    const starts: Array<ReturnType<typeof vi.fn<SessionManagerLike["start"]>>> =
      [];
    const disposes: Array<
      ReturnType<typeof vi.fn<SessionManagerLike["dispose"]>>
    > = [];
    let managerIndex = 0;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "/managed/bin/clash-acp-codex-acp" },
        },
      ],
      createSessionManager: (send) => {
        const index = managerIndex++;
        const start = vi.fn<SessionManagerLike["start"]>(async (params) => {
          send({
            type: "session.ready",
            session_id: params.session_id,
            acp_session_id:
              index === 0 ? "codex-thread-existing" : "codex-thread-resumed",
            supports_session_fork: false,
          });
        });
        const dispose = vi.fn<SessionManagerLike["dispose"]>(
          async () => undefined,
        );
        starts.push(start);
        disposes.push(dispose);
        return { start, prompt: vi.fn(), cancel: vi.fn(), dispose };
      },
      createSessionId: () => "local-acp-session-restart",
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentTemplateId: "clash",
      agentMemberId: "local-clash",
      agentId: "codex-acp",
      projectId: "project-restart",
    });

    await expect(
      adapter.restartSession("local-acp-session-restart", { mode: "now" }),
    ).resolves.toEqual({
      session_id: "local-acp-session-restart",
      status: "restarted",
    });

    expect(disposes[0]).toHaveBeenCalledWith("local-acp-session-restart");
    expect(starts).toHaveLength(2);
    expect(starts[1]).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "local-acp-session-restart",
        agent_id: "codex-acp",
        resume: { acp_session_id: "codex-thread-existing" },
      }),
    );
  });

  it("reports when a held session is still running an older installed harness package", async () => {
    const harnessDir = await mkdtemp(
      join(tmpdir(), "clash-held-harness-version-"),
    );
    const shimPath = join(harnessDir, "clash-acp-codex-acp");
    const packageDir = join(
      harnessDir,
      "registry",
      "codex-acp",
      "npx",
      "node_modules",
      "@test",
      "codex-acp",
    );
    const packagePath = join(packageDir, "package.json");
    try {
      await writeFile(shimPath, "#!/bin/sh\nexit 0\n", "utf8");
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        packagePath,
        JSON.stringify({ name: "@test/codex-acp", version: "1.0.1" }),
        "utf8",
      );
      const adapter = createLocalAcpAdapter({
        detectAgents: async () => [
          { id: "codex-acp", label: "Codex", spec: { command: shimPath } },
        ],
        agentCatalog: [
          {
            id: "codex-acp",
            label: "Codex",
            spec: { command: "clash-acp-codex-acp" },
            registryId: "codex-acp",
            registryNpmPackage: "@test/codex-acp",
            installSource: "registry",
          },
        ],
        harnessDownloadDir: harnessDir,
        fetch: async (url) => {
          if (String(url).includes("registry.json")) {
            return new Response(JSON.stringify({ agents: [] }), {
              status: 200,
            });
          }
          return new Response(JSON.stringify({ version: "1.0.2" }), {
            status: 200,
          });
        },
        probeAgentAuth: async () => undefined,
        createSessionManager: () => ({
          start: vi.fn(),
          prompt: vi.fn(),
          cancel: vi.fn(),
          dispose: vi.fn(),
        }),
        createSessionId: () => "local-acp-session-old-package",
      });

      await adapter.createSession({
        runtimeId: "desktop-local",
        agentId: "codex-acp",
      });
      await writeFile(
        packagePath,
        JSON.stringify({ name: "@test/codex-acp", version: "1.0.2" }),
        "utf8",
      );

      await expect(
        adapter.getSessionRuntimeStatus("local-acp-session-old-package"),
      ).resolves.toEqual({
        session_id: "local-acp-session-old-package",
        harness_id: "codex-acp",
        harness_label: "Codex",
        running_version: "1.0.1",
        installed_version: "1.0.2",
        restart_required: true,
        busy: false,
        restart_pending: false,
      });
    } finally {
      await rm(harnessDir, { recursive: true, force: true });
    }
  });

  it("records the Backchat event stream for prompt, agent output, and terminal state", async () => {
    let sendFromManager!: SessionSender;
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      createSessionId: () => "local-acp-session-history",
      createSessionManager: (send) => {
        sendFromManager = send;
        return {
          start: vi.fn(),
          prompt: vi.fn(async ({ session_id, turn_id }) => {
            sendFromManager({
              type: "session.event",
              session_id,
              turn_id,
              event: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "restored" },
              },
            });
            sendFromManager({ type: "session.complete", session_id, turn_id });
          }),
          cancel: vi.fn(),
          dispose: vi.fn(),
        };
      },
    });
    await adapter.createSession({
      runtimeId: "desktop-local",
      agentId: "codex-acp",
      projectId: "project-history",
    });

    const socket = new FakeSocket();
    adapter.bindSessionSocket("local-acp-session-history", socket as never);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "prompt",
          turn_id: "turn-history",
          text: "restore me",
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const history = await adapter.listSessionEvents(
      "local-acp-session-history",
    );
    expect(
      history?.events.map(({ seq, type, data }) => ({ seq, type, data })),
    ).toEqual([
      {
        seq: 1,
        type: "user_prompt",
        data: { turn_id: "turn-history", text: "restore me" },
      },
      {
        seq: 2,
        type: "session.event",
        data: {
          turn_id: "turn-history",
          event: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "restored" },
          },
        },
      },
      {
        seq: 3,
        type: "turn_completed",
        data: { turn_id: "turn-history" },
      },
    ]);
  });

  it("defers an ACP restart until the active turn completes", async () => {
    const promptStarted = deferred();
    const releasePrompt = deferred();
    const firstSocket = new FakeSocket();
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "codex-acp",
          label: "Codex",
          spec: { command: "codex-acp" },
        },
      ],
      probeAgentAuth: async () => undefined,
      createSessionManager: (send) => ({
        start: vi.fn(async ({ session_id }) => {
          send({
            type: "session.ready",
            session_id,
            acp_session_id: "codex-thread-busy",
            supports_session_fork: false,
          });
        }),
        prompt: vi.fn(async () => {
          promptStarted.resolve();
          await releasePrompt.promise;
        }),
        cancel: vi.fn(),
        dispose: vi.fn(),
      }),
      createSessionId: () => "local-acp-session-busy-restart",
    });

    await adapter.createSession({
      runtimeId: "desktop-local",
      agentId: "codex-acp",
    });
    adapter.bindSessionSocket(
      "local-acp-session-busy-restart",
      firstSocket as any,
    );
    firstSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "prompt",
          turn_id: "turn-busy",
          text: "finish this first",
        }),
      ),
    );
    await promptStarted.promise;

    await expect(
      adapter.restartSession("local-acp-session-busy-restart", {
        mode: "after-turn",
      }),
    ).resolves.toEqual({
      session_id: "local-acp-session-busy-restart",
      status: "pending",
    });
    expect(
      firstSocket.sent.map((message) => JSON.parse(message)),
    ).not.toContainEqual(
      expect.objectContaining({
        type: "session.restart_ready",
      }),
    );

    releasePrompt.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      firstSocket.sent.map((message) => JSON.parse(message)),
    ).toContainEqual({
      type: "session.restart_ready",
      session_id: "local-acp-session-busy-restart",
    });
  });
});
