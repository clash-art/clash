import { createLocalProjectCloudSync } from "./project-cloud-sync.js";
import { localProjectSyncMetadata } from "./app.js";
import { registerProjectRenderer } from "./project-renderer.js";
import { createStructuredLogger } from "@clash/shared-runtime/logging";
import { createLocalProjectUpgrade } from "./local-project-upgrade.js";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createLocalModelExecutionPlanner } from "./local-model-generation.js";
import {
  PluginHostClient,
  pluginHostSocketPath,
  startPluginHostIpcServer,
  type PluginHostIpcServer,
} from "./runtime/host/lib/plugin-host-ipc.js";
import { ActionsHost } from "./runtime/host/lib/actions-loader.js";
import {
  LOCAL_HOST_PROTOCOL_VERSION,
  readMetadataBody,
  type HostLaunchMode,
  type HostStartedBy,
} from "@clash/shared-runtime";
import {
  buildEffectiveModelCards,
  composeExecutablePluginModelCards,
  listConsumerModelCatalogEntries,
  modelCardVisibleToConsumer,
  ExecutablePluginBindingSchema,
  ExecutablePluginJsonValueSchema,
  parseDocumentBody,
  readDocumentAssetRevision,
  MODEL_CARDS,
  type ExecutablePluginCardRegistration,
  type ExecutablePluginBinding,
  type ExecutablePluginModelBindingRegistration,
} from "@clash/shared-types";
import { createLocalApiApp, createLocalTtsGenerationHandler } from "./app.js";
import {
  createHostDiscoveryRecord,
  removeHostDiscovery,
  writeHostDiscovery,
} from "./host-discovery.js";
import { resolveMediaBaseUrl } from "./media-base-url.js";
import { createMockExternalAigcService } from "./local-aigc.js";
import {
  createLocalMediaAnalysisService,
  type LocalMediaAnalysisService,
} from "./local-media-analysis.js";
import {
  createLocalMediaAnalysisConfigStore,
  mediaAnalysisModelOptionFromCatalogEntry,
  type MediaAnalysisSourceKind,
} from "./media-analysis-config.js";
import {
  createLocalVideoEnhanceService,
  type LocalVideoEnhanceService,
} from "./local-video-enhance.js";
import { createProviderPluginProjector } from "./provider-plugin-projector.js";
import { createProviderPluginExecutor } from "./provider-plugin-executor.js";
import { createExecutablePluginActionInvoker } from "./plugin-action-runtime.js";
import {
  createCodexImagegenMarketplace,
  createOfficialPluginsMarketplace,
} from "./bundled-plugins.js";
import { selectMarketplaceFeed } from "./marketplace-feed.js";
import {
  TRUSTED_BUNDLED_PLUGIN_MODULES,
  loadTrustedBundledPluginModule,
} from "./bundled-plugin-modules.js";
import {
  activateOrUpdateHostExecutablePluginPackage,
  listHostExecutablePluginPackages,
  readHostExecutablePluginPackage,
  removeHostExecutablePluginPackage,
  rollbackHostExecutablePluginPackage,
  validateHostExecutablePluginPackageContracts,
  type HostExecutablePluginPackage,
} from "./runtime/plugin-package.js";
import {
  preflightCodexImageGenerator,
  type CodexImageGeneratorPreflightResult,
} from "./codex-imagegen.js";
import {
  attachLocalAcpSessions,
  createLocalAcpCapabilityCacheStore,
  createLocalAcpAdapter,
  createLocalAcpRunPreferencesStore,
  createLocalHarnessConfigStore,
  type LocalAcpRuntimeAdapter,
  type SessionManagerLike,
  type SessionSender,
} from "./local-acp.js";
import { createMockFalQueueService } from "./fal-mock.js";
import { createLocalWorkflowProcessor } from "./local-processor.js";
import { localDurableRunOwnerId } from "./durable-run-coordinator.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import {
  providerAccountsForRuntime,
  publicProviderAccounts,
} from "./provider-accounts.js";
import { createLocalProviderStore } from "./local-provider-store.js";
import { fetchIntoSlot } from "./upload-slot-fetch.js";
import { openPluginStore } from "./plugin-store.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import {
  createLocalProjectAssetService,
  type LocalProjectAssetReplica,
} from "./local-project-assets.js";
import {
  createLocalAssetInspectionService,
  createLocalFfprobeAssetInspector,
  localFfprobePath,
} from "./local-asset-inspections.js";
import { createLocalAssetRepresentationService } from "./local-asset-representations.js";
import { createLocalPluginAssetStagingStore } from "./local-plugin-asset-staging.js";
import type { LocalPluginAssetStagingStore } from "./local-plugin-asset-staging.js";
import { createLocalExecutorAssetCapabilityIssuer } from "./executor-asset-capability.js";
import { FileReplicaStore } from "./loro/file-replica-store.js";
import {
  createLocalExecutablePluginBroker,
  type LocalExecutablePluginBrokerOptions,
} from "./local-plugin-broker.js";
import { createLocalSpeechTranscriptionService } from "./local-speech-transcription.js";
import type { LocalDocumentProjectAuthority } from "./local-document-product.js";
import type { LocalGeneratorProjectAuthority } from "./local-generator-product.js";
import {
  attachLocalSync,
  LocalLoroRoomHub,
  type RemoteLoroPersistenceSource,
} from "./sync.js";
import type { LocalCloudAdmissionClient } from "./project-cloud-admission.js";
import { createHttpCloudAdmissionClient } from "./project-cloud-admission.js";
import { createLocalSyncConfigStore } from "./sync-config.js";
import {
  createLocalAudioConfigStore,
  type LocalAudioConfigStore,
} from "./audio-config.js";
import {
  clashHomeForLocalDataDir,
  defaultLocalApiDataDir,
  resolveClashProfile,
} from "./local-paths.js";
import {
  createClashUserConfigStore,
  watchClashUserConfig,
} from "./user-config.js";
import {
  createPublicAssetStorageService,
  type PublicAssetStorageService,
} from "./public-asset-storage.js";
import type { LocalDirectorStageRenderer } from "./director-stage-renderer.js";
import { createNpxSkillsMarketplace } from "./marketplace-skills.js";
import { ensureAgentCwd } from "./runtime/host/lib/session-cwd.js";
import skillMarketplaceRegistry from "../../../skills/registry.json" with { type: "json" };

export { createHeadlessDirectorStageRenderer } from "./director-stage-renderer.js";
export { prepareDevelopmentBundledPlugins } from "./development-bundled-plugins.js";

export {
  clashHomeForLocalDataDir,
  defaultLocalApiDataDir,
} from "./local-paths.js";

const port = Number(process.env.PORT ?? 49321);
const dataDir = defaultLocalApiDataDir();

export interface LocalApiServerOptions {
  port: number;
  dataDir: string;
  directorStageRenderer?: LocalDirectorStageRenderer;
  localAcp?: LocalAcpRuntimeAdapter;
  /** MCP hosts own agent conversations; disabled skips ACP startup and sockets. */
  agentRuntime?: "enabled" | "disabled";
  /** Shipped SPA assets served by this same daemon. */
  projectRendererRoot?: string;
  audioConfig?: LocalAudioConfigStore;
  /** Injectable so a signed-in Desktop can provide managed Clash storage later. */
  publicAssetStorage?: PublicAssetStorageService;
  remotePersistence?: RemoteLoroPersistenceSource | null;
  /** Optional project-scoped cloud admission control-plane adapter. */
  cloudAdmission?: LocalCloudAdmissionClient;
  /** Injectable download transport for completed provider media URLs. */
  providerAssetFetch?: typeof fetch;
  /** Replay harness only: workflow scheduling cap; provider responses remain untouched. */
  providerPollDelayCapMs?: number;
  /** Host policy for the whole Provider run. Defaults to 30 minutes. */
  providerGenerationDeadlineMs?: number;
  /** Test-only process-boundary instrumentation for ordinary plugin HTTP clients. */
  providerHttpInstrumentation?: {
    mode: "record" | "replay";
    trafficPath: string;
    activeStubPath?: string;
    modulePath: string;
    loaderPath?: string;
  };
  /**
   * Development-only source roots for already-attested first-party plugin launchers.
   * Omitted by the packaged host and every normal `startLocalApiServer` caller.
   */
  developmentPluginWatchRoots?: Readonly<Record<string, readonly string[]>>;
  discovery?: {
    enabled?: boolean;
    runDir?: string;
    launchMode?: HostLaunchMode;
    ownerClientId?: string;
    startedBy?: HostStartedBy;
  };
  /** Injectable for packaged hosts and deterministic startup tests. */
  codexImagegenPreflight?: () => Promise<CodexImageGeneratorPreflightResult>;
}

/**
 * Reopen every Project with owner-private work after a Host restart.
 *
 * A room normally opens when a client connects or calls a Project endpoint. Durable Provider work
 * cannot depend on that visit: an accepted upstream task must keep polling even when Desktop stays
 * closed after the daemon restarts. Opening the room runs its normal recovery scan and installs the
 * next journal wake timer; Project Loro remains a projection rather than the scheduler index.
 */
export async function bootstrapLocalDurableRunRecovery(options: {
  dataDir: string;
  ownerId: string;
  roomHub: Pick<LocalLoroRoomHub, "room">;
}): Promise<string[]> {
  const projectIds = await createSqliteDurableRunJournal(
    options.dataDir,
  ).listOwnedProjectIds(options.ownerId);
  await Promise.all(
    projectIds.map((projectId) => options.roomHub.room(projectId)),
  );
  return projectIds;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveClashCliEntry(env: Record<string, string | undefined>): string {
  if (env.CLASH_CLI_ENTRY_PATH) return env.CLASH_CLI_ENTRY_PATH;
  const workspaceSource = fileURLToPath(
    new URL("../../../packages/cli/src/index.ts", import.meta.url),
  );
  if (existsSync(workspaceSource)) return workspaceSource;
  throw new Error(
    "CLASH_CLI_ENTRY_PATH is required when local-api is installed without the optional agent CLI resource.",
  );
}

export function createLocalAgentToolEnv({
  dataDir,
  apiBaseUrl,
  env = process.env,
}: {
  dataDir: string;
  apiBaseUrl: string;
  env?: Record<string, string | undefined>;
}): Record<string, string> {
  const localDataDir = resolve(dataDir);
  const clashHome = clashHomeForLocalDataDir(localDataDir);
  const profile = resolveClashProfile(env);
  const binDir = join(localDataDir, "agent-bin");
  mkdirSync(binDir, { recursive: true });

  const apiUrl = apiBaseUrl;
  const cliEntry = resolveClashCliEntry(env);
  const cliLoader = cliEntry.endsWith(".ts")
    ? createRequire(import.meta.url).resolve("tsx")
    : undefined;
  const cliInvocation = [
    ...(cliLoader ? ["--import", cliLoader] : []),
    cliEntry,
  ]
    .map(shellQuote)
    .join(" ");
  const shim = join(binDir, "clash");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `export CLASH_API_URL=${shellQuote(apiUrl)}`,
      `export CLASH_HOME=${shellQuote(clashHome)}`,
      `export CLASH_PROFILE=${shellQuote(profile)}`,
      `export CLASH_LOCAL_DATA_DIR=${shellQuote(localDataDir)}`,
      "export ELECTRON_RUN_AS_NODE=1",
      ...(env.CLASH_CLI_NODE_PATH
        ? [`export CLASH_CLI_NODE_PATH=${shellQuote(env.CLASH_CLI_NODE_PATH)}`]
        : []),
      ...(env.TSX_TSCONFIG_PATH
        ? [`export TSX_TSCONFIG_PATH=${shellQuote(env.TSX_TSCONFIG_PATH)}`]
        : []),
      `if [ -n "$CLASH_CLI_NODE_PATH" ]; then`,
      `  export NODE_PATH="$CLASH_CLI_NODE_PATH${"${NODE_PATH:+:$NODE_PATH}"}"`,
      "fi",
      `if [ -n "$CLASH_NODE_EXEC_PATH" ]; then`,
      `  exec "$CLASH_NODE_EXEC_PATH" ${cliInvocation} "$@"`,
      "fi",
      "if command -v node >/dev/null 2>&1; then",
      `  exec node ${cliInvocation} "$@"`,
      "fi",
      `exec ${shellQuote(process.execPath)} ${cliInvocation} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);

  return {
    CLASH_API_URL: apiUrl,
    CLASH_HOME: clashHome,
    CLASH_PROFILE: profile,
    CLASH_LOCAL_DATA_DIR: localDataDir,
    ...(env.CLASH_NODE_EXEC_PATH
      ? { CLASH_NODE_EXEC_PATH: env.CLASH_NODE_EXEC_PATH }
      : {}),
    ...(env.CLASH_CLI_ENTRY_PATH
      ? { CLASH_CLI_ENTRY_PATH: env.CLASH_CLI_ENTRY_PATH }
      : {}),
    ...(env.CLASH_CLI_NODE_PATH
      ? { CLASH_CLI_NODE_PATH: env.CLASH_CLI_NODE_PATH }
      : {}),
    ...(env.CLASH_AGENT_BUNDLE_ROOT
      ? { CLASH_AGENT_BUNDLE_ROOT: env.CLASH_AGENT_BUNDLE_ROOT }
      : {}),
    ...(env.CLASH_BUILTIN_PLUGIN_ROOT
      ? { CLASH_BUILTIN_PLUGIN_ROOT: env.CLASH_BUILTIN_PLUGIN_ROOT }
      : {}),
    ...(env.TSX_TSCONFIG_PATH
      ? { TSX_TSCONFIG_PATH: env.TSX_TSCONFIG_PATH }
      : {}),
    PATH: [binDir, env.PATH].filter(Boolean).join(delimiter),
  };
}

function createMockCanvasPatch(turnId: string, text: string) {
  const safeTurnId = turnId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return {
    sessionUpdate: "clash.canvas.patch",
    operations: [
      {
        op: "add_node",
        node: {
          id: `mock-agent-stage-${safeTurnId}`,
          type: "group",
          data: { label: "Agent Stage" },
          position: { x: 480, y: 140 },
          width: 620,
          height: 360,
          style: { width: 620, height: 360 },
        },
      },
      {
        op: "add_node",
        node: {
          id: `mock-agent-brief-${safeTurnId}`,
          type: "action-badge",
          data: {
            label: "Agent Brief",
            actionType: "text-gen",
            content: `# Agent Brief\n${text}`,
          },
          position: { x: 530, y: 210 },
          width: 260,
          height: 48,
        },
      },
      {
        op: "add_node",
        node: {
          id: `mock-agent-action-${safeTurnId}`,
          type: "action-badge",
          data: {
            label: "Agent Image Pass",
            actionType: "image-gen",
            content: `# Prompt\n${text}`,
          },
          position: { x: 530, y: 320 },
          width: 260,
          height: 48,
        },
      },
      {
        op: "add_node",
        node: {
          id: `mock-agent-timeline-${safeTurnId}`,
          type: "video-editor",
          data: {
            label: "Agent Timeline",
            content: `# Timeline\n${text}`,
          },
          position: { x: 850, y: 210 },
          width: 360,
          height: 220,
          style: { width: 360, height: 220 },
        },
      },
      {
        op: "add_node",
        node: {
          id: `mock-agent-discard-${safeTurnId}`,
          type: "text",
          data: {
            label: "Agent Scratch",
            content: `# Scratch\n${text}`,
          },
          position: { x: 850, y: 460 },
          width: 240,
          height: 120,
          style: { width: 240, height: 120 },
        },
      },
      {
        op: "delete_node",
        node: {
          id: `mock-agent-discard-${safeTurnId}`,
        },
      },
      {
        op: "timeline_apply",
        timeline: {
          nodeId: `mock-agent-timeline-${safeTurnId}`,
          dsl: {
            fps: 30,
            durationInFrames: 90,
            tracks: [
              {
                id: "main",
                type: "video",
                items: [],
              },
            ],
          },
        },
      },
      {
        op: "add_edge",
        edge: {
          id: `mock-agent-brief-${safeTurnId}-mock-agent-action-${safeTurnId}`,
          source: `mock-agent-brief-${safeTurnId}`,
          target: `mock-agent-action-${safeTurnId}`,
          type: "default",
        },
      },
      {
        op: "update_edge",
        edge: {
          id: `mock-agent-brief-${safeTurnId}-mock-agent-action-${safeTurnId}`,
          patch: {
            label: "agent-reviewed",
            animated: true,
          },
        },
      },
      {
        op: "delete_edge",
        edge: {
          id: `mock-agent-brief-${safeTurnId}-mock-agent-action-${safeTurnId}`,
        },
      },
    ],
  };
}

function createMockMissingReadProofPatch(turnId: string) {
  const safeTurnId = turnId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return {
    sessionUpdate: "clash.canvas.patch",
    operations: [
      {
        op: "delete_node",
        node: {
          id: `mock-agent-brief-${safeTurnId}`,
        },
      },
    ],
  };
}

function createMockAcpSessionManager(send: SessionSender): SessionManagerLike {
  const delayMs = Number(process.env.CLASH_E2E_STUB_ACP_DELAY_MS ?? "0");
  const promptDelayMs = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
  const waitForPromptDelay = () =>
    promptDelayMs > 0
      ? new Promise<void>((resolve) => setTimeout(resolve, promptDelayMs))
      : Promise.resolve();

  return {
    start: ({ session_id }) => {
      send({
        type: "session.ready",
        session_id,
        acp_session_id: "mock-acp-session",
        supports_session_fork: false,
      });
    },
    prompt: async ({ session_id, turn_id, text }) => {
      if (promptDelayMs > 0) {
        send({
          type: "session.event",
          session_id,
          turn_id,
          event: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Preparing mock response." },
          },
        });
      }
      await waitForPromptDelay();
      if (text.includes("列出画布上的节点")) {
        send({
          type: "session.event",
          session_id,
          turn_id,
          event: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "先读取当前画布结构。" },
          },
        });
        send({
          type: "session.event",
          session_id,
          turn_id,
          event: {
            sessionUpdate: "tool_call",
            toolCallId: `tool-list-canvas-${turn_id}`,
            title: "List canvas nodes",
            kind: "list",
            status: "in_progress",
            rawInput: { query: "canvas.nodes", projectId: "mock-project" },
          },
        });
        send({
          type: "session.event",
          session_id,
          turn_id,
          event: {
            sessionUpdate: "tool_call_update",
            toolCallId: `tool-list-canvas-${turn_id}`,
            title: "List canvas nodes",
            kind: "list",
            status: "completed",
            rawOutput: [
              { id: "dianmwa7", type: "action-badge", label: "Image Prompt" },
              { id: "lrcleamx", type: "image", label: "生成类似的" },
              {
                id: "upload-1781414847642-oq6cbcl",
                type: "image",
                label: "258251d8857f30efff6b9b7085302bf5.JPG",
              },
            ],
          },
        });
        send({
          type: "session.event",
          session_id,
          turn_id,
          event: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: [
                "画布上当前有 3 个节点：",
                "",
                "- `dianmwa7` — action-badge，标签是 **Image Prompt**，动作 `image-gen`。",
                "- `lrcleamx` — image，状态 **completed**，标签是 **生成类似的**。",
                "- `upload-1781414847642-oq6cbcl` — image，文件名是 `258251d8857f30efff6b9b7085302bf5.JPG`。",
              ].join("\n"),
            },
          },
        });
        send({ type: "session.complete", session_id, turn_id });
        return;
      }
      send({
        type: "session.event",
        session_id,
        turn_id,
        event: { type: "text", text: `Mock ACP reply: ${text}` },
      });
      send({
        type: "session.event",
        session_id,
        turn_id,
        event: createMockCanvasPatch(turn_id, text),
      });
      send({
        type: "session.event",
        session_id,
        turn_id,
        event: createMockMissingReadProofPatch(turn_id),
      });
      send({ type: "session.complete", session_id, turn_id });
    },
    cancel: () => undefined,
    dispose: (sessionId) => {
      send({ type: "session.disposed", session_id: sessionId });
    },
  };
}

function withMockHarnessUpdateFixture(
  adapter: LocalAcpRuntimeAdapter,
  localDataDir: string,
): LocalAcpRuntimeAdapter {
  const readyPath = join(localDataDir, ".e2e-harness-update-ready");
  const listHarnesses = adapter.listHarnesses.bind(adapter);
  const getSessionRuntimeStatus = adapter.getSessionRuntimeStatus.bind(adapter);
  const restartSession = adapter.restartSession.bind(adapter);
  let upgraded = false;
  let restarted = false;

  adapter.listHarnesses = async (options) => {
    const result = await listHarnesses(options);
    if (!existsSync(readyPath)) return result;
    const mock = result.harnesses.find((harness) => harness.id === "mock-acp");
    if (!mock) return result;
    return {
      harnesses: [
        {
          ...mock,
          installed: true,
          installedVersion: upgraded ? "2.0.0" : "1.0.0",
          latestVersion: "2.0.0",
          ...(upgraded ? {} : { updateAvailable: true }),
        },
        ...result.harnesses.filter((harness) => harness.id !== "mock-acp"),
      ],
    };
  };
  adapter.upgradeHarness = async (id) => {
    if (id !== "mock-acp") throw new Error(`Unknown mock harness: ${id}`);
    upgraded = true;
    return adapter.listHarnesses({ probe: true, refresh: true });
  };
  adapter.getSessionRuntimeStatus = async (sessionId) => {
    const status = await getSessionRuntimeStatus(sessionId);
    if (!status) return null;
    return {
      ...status,
      harness_id: "mock-acp",
      harness_label: "Mock ACP",
      running_version: restarted ? "2.0.0" : "1.0.0",
      installed_version: upgraded ? "2.0.0" : "1.0.0",
      restart_required: upgraded && !restarted,
    };
  };
  adapter.restartSession = async (sessionId, options) => {
    const result = await restartSession(sessionId, options);
    if (result.status === "restarted") restarted = true;
    return result;
  };
  return adapter;
}

export function createConfiguredLocalAcpAdapter(
  env: Record<string, string | undefined> = process.env,
  options: { apiBaseUrl?: string; dataDir?: string } = {},
) {
  const localDataDir = options.dataDir ?? defaultLocalApiDataDir(env);
  if (env.CLASH_E2E_STUB_ACP === "1") {
    const adapter = createLocalAcpAdapter({
      detectAgents: async () => [
        {
          id: "mock-acp",
          label: "Mock ACP",
          spec: { command: "mock-acp" },
        },
      ],
      listResumeSessions: async () => [],
      createSessionManager: createMockAcpSessionManager,
      runPreferences: createLocalAcpRunPreferencesStore(localDataDir),
      hostname: () => "Mock Desktop",
      osTag: () => "mock/e2e",
    });
    return env.CLASH_E2E_STUB_HARNESS_UPDATE === "1"
      ? withMockHarnessUpdateFixture(adapter, localDataDir)
      : adapter;
  }
  const harnessDownloadDir = join(localDataDir, "acp-bin");
  const acpBinDir = env.CLASH_ACP_TEST_BIN_DIR || harnessDownloadDir;
  return createLocalAcpAdapter({
    harnessConfig: createLocalHarnessConfigStore(localDataDir),
    runPreferences: createLocalAcpRunPreferencesStore(localDataDir),
    capabilityCache: createLocalAcpCapabilityCacheStore(localDataDir),
    harnessDownloadDir,
    probeCwd: join(localDataDir, "acp-probe"),
    spawnEnv: {
      ...createLocalAgentToolEnv({
        dataDir: localDataDir,
        apiBaseUrl:
          options.apiBaseUrl ?? env.CLASH_API_URL ?? `http://127.0.0.1:${port}`,
        env,
      }),
      CLASH_ACP_BIN_DIR: acpBinDir,
    },
  });
}

async function loadLocalProviderAccounts(
  dataDir: string,
  userId = "local-user",
) {
  const store = createLocalProviderStore(dataDir);
  const [providerAccounts, providerOAuth] = await Promise.all([
    store.loadProviderAccounts(),
    store.loadProviderOAuth(),
  ]);
  return providerAccountsForRuntime(providerAccounts, userId, providerOAuth);
}

async function loadLocalModelCards(
  dataDir: string,
  userId = "local-user",
  pluginCards: readonly ExecutablePluginCardRegistration[] = [],
  pluginModelBindings: readonly ExecutablePluginModelBindingRegistration[] = [],
  consumer?: { pluginId: string; definitionId?: string; actionId?: string },
) {
  const store = createLocalProviderStore(dataDir);
  const [providerAccounts, providerOAuth, modelCardConfigs] = await Promise.all(
    [
      store.loadProviderAccounts(),
      store.loadProviderOAuth(),
      store.loadModelCardConfigs(),
    ],
  );
  const providers = providerAccountsForRuntime(
    providerAccounts,
    userId,
    providerOAuth,
  );
  const composed = composeExecutablePluginModelCards(
    MODEL_CARDS,
    pluginCards,
    pluginModelBindings,
  );
  return buildEffectiveModelCards({
    configs: modelCardConfigs
      .filter((config) => (config.userId ?? userId) === userId)
      .map(({ userId: _userId, ...config }) => config),
    providers,
    baseModels: composed.filter((model) =>
      modelCardVisibleToConsumer(model, consumer),
    ),
  });
}

/**
 * Uploads a plugin has been offered a place for but not yet delivered.
 *
 * In memory and per process. A slot that survived a restart would name a URL nothing is listening
 * on, and the plugin holding it would stream into a void and report success.
 */
const pendingUploads = new Map<
  string,
  {
    assetId: string;
    slot: string;
    /** Absent when the vendor answered with a link: there is no count until the fetch finishes. */
    byteLength?: number;
    bytes: Uint8Array | undefined;
    mediaType?: string;
  }
>();

/**
 * Receive bytes for a slot that was handed out.
 *
 * The token is the authorisation: minted for one upload, given to one plugin, forgotten once
 * collected. An unknown or already-collected token is refused, so a leaked one names nothing.
 */
export function acceptPluginUpload(token: string, bytes: Uint8Array): boolean {
  const pending = pendingUploads.get(token);
  if (!pending || pending.bytes) return false;
  pending.bytes = bytes;
  return true;
}

export function createLocalPluginBrokerServices(options: {
  dataDir: string;
  assetStaging?: LocalPluginAssetStagingStore;
  projectAssetReplica?: LocalProjectAssetReplica;
  inspectProjectDocument?: <T>(
    projectId: string,
    read: (doc: import("loro-crdt").LoroDoc) => T | Promise<T>,
  ) => Promise<T>;
  audioConfig?: Pick<LocalAudioConfigStore, "transcribe">;
  /**
   * Where a plugin should PUT bytes it was given a slot for.
   *
   * Passed in rather than assembled here: this function does not know the port it is being served
   * on, and a hosted deployment does not have one -- there the origin is object storage.
   */
  uploadOrigin?: string | (() => string);
  assetFetch?: typeof fetch;
  publicAssetStorage?: PublicAssetStorageService;
  directorStageRenderer?: LocalDirectorStageRenderer;
  analyzeMedia?: LocalExecutablePluginBrokerOptions["analyzeMedia"];
  enhanceVideo?: LocalExecutablePluginBrokerOptions["enhanceVideo"];
  generateCodexImage?: LocalExecutablePluginBrokerOptions["generateCodexImage"];
  generateAgentText?: LocalExecutablePluginBrokerOptions["generateAgentText"];
}) {
  const providerStore = createLocalProviderStore(options.dataDir);
  const metadataStore = createLocalMetadataStore(options.dataDir);
  const clashRoot = clashHomeForLocalDataDir(options.dataDir);
  const stagedAssets =
    options.assetStaging ??
    createLocalPluginAssetStagingStore({
      dataDir: options.dataDir,
      clashRoot,
    });
  const projectAssets = createLocalProjectAssetService({
    dataDir: options.dataDir,
    clashRoot,
    ...(options.projectAssetReplica
      ? { replica: options.projectAssetReplica }
      : {}),
    projectionOrigin: () => {
      const origin =
        typeof options.uploadOrigin === "function"
          ? options.uploadOrigin()
          : options.uploadOrigin;
      return origin || "http://127.0.0.1";
    },
  });
  const executorAssets = createLocalExecutorAssetCapabilityIssuer();
  const documentReplicaStore = new FileReplicaStore(
    join(options.dataDir, "projects"),
  );
  const inspectProjectDocument = <T>(
    projectId: string,
    read: (doc: import("loro-crdt").LoroDoc) => T | Promise<T>,
  ): Promise<T> =>
    options.inspectProjectDocument
      ? options.inspectProjectDocument(projectId, read)
      : options.projectAssetReplica
        ? options.projectAssetReplica.inspect(projectId, read)
        : documentReplicaStore.recover(projectId).then(read);
  const openProjectAssetProjection = (
    projectId: string,
    projectAssetId: string,
  ) =>
    inspectProjectDocument(projectId, (doc) =>
      projectAssets.openProjectionFromDoc(doc, projectId, projectAssetId),
    );
  const transcribeSpeech: LocalExecutablePluginBrokerOptions["transcribeSpeech"] =
    options.audioConfig
      ? createLocalSpeechTranscriptionService({
          audioConfig: options.audioConfig,
          openAsset: async ({ projectId, projectAssetId }) => {
            const projection = await openProjectAssetProjection(
              projectId,
              projectAssetId,
            );
            return {
              kind: projection.resource.kind,
              path: projection.path,
              ...(projection.resource.contentType
                ? { contentType: projection.resource.contentType }
                : {}),
            };
          },
        })
      : undefined;
  async function writeAssetBytes({
    pluginId,
    pluginVersion,
    projectId,
    invocationId,
    taskId,
    slot,
    kind,
    mediaType,
    accountId,
    bytes,
  }: {
    pluginId: string;
    pluginVersion: string;
    projectId: string;
    invocationId: string;
    taskId: string;
    slot: string;
    kind: "image" | "video" | "audio" | "model";
    mediaType?: string;
    accountId?: string;
    bytes: Uint8Array;
  }) {
    const staged = await stagedAssets.stage({
      pluginId,
      pluginVersion,
      projectId,
      invocationId,
      taskId,
      slot,
      kind,
      ...(mediaType ? { mediaType } : {}),
      ...(accountId ? { accountId } : {}),
      bytes,
    });
    return {
      assetId: staged.projectAssetId,
      uri: `clash-asset://${staged.projectAssetId}`,
      kind,
      ...(staged.mediaType ? { mediaType: staged.mediaType } : {}),
    };
  }

  // Opened on first use rather than at construction: the table and the encryption key are created
  // as a side effect, and a host that never runs a plugin should not create either.
  let storePromise:
    Promise<Awaited<ReturnType<typeof openPluginStore>>> | undefined;
  const pluginStore = () =>
    (storePromise ??= openPluginStore({ dataDir: options.dataDir }));

  const broker = createLocalExecutablePluginBroker({
    loadProviderAccounts: async () => {
      const [accounts, oauthRecords] = await Promise.all([
        providerStore.loadProviderAccounts(),
        providerStore.loadProviderOAuth(),
      ]);
      return providerAccountsForRuntime(accounts, "local-user", oauthRecords);
    },
    ...(options.generateCodexImage
      ? { generateCodexImage: options.generateCodexImage }
      : {}),
    ...(options.generateAgentText ? { generateAgentText: options.generateAgentText } : {}),
    ...(options.directorStageRenderer
      ? {
          captureDirectorStageFrame: async ({
            stage,
            codeSources,
            label,
            timeSeconds,
            aspectRatio,
            longEdge,
          }) => {
            const rendered = await options.directorStageRenderer!.render({
              codeSources,
              state:
                stage.state as import("@clash/shared-types").DirectorStageState,
              longEdge,
              frames: [{ label, timeSeconds, aspectRatio }],
            });
            if (rendered.frames.length !== 1)
              throw new Error(
                "Director renderer must return exactly one frame.",
              );
            const frame = rendered.frames[0]!;
            return {
              mediaType: frame.mimeType,
              width: frame.width,
              height: frame.height,
              bytesBase64: frame.dataBase64,
            };
          },
        }
      : {}),
    ...(transcribeSpeech ? { transcribeSpeech } : {}),
    ...(options.analyzeMedia ? { analyzeMedia: options.analyzeMedia } : {}),
    ...(options.enhanceVideo ? { enhanceVideo: options.enhanceVideo } : {}),
    openExecutorAsset: async ({ projectId, invocationId, assetId, kind }) => {
      const staged = await stagedAssets.resolve({
        projectId,
        projectAssetId: assetId,
      });
      if (staged) {
        return await executorAssets.open({
          invocationId,
          path: staged.projection.path,
          byteLength: staged.projection.byteLength,
          kind: staged.kind,
          ...(staged.mediaType ? { mediaType: staged.mediaType } : {}),
        });
      }
      const projection = await openProjectAssetProjection(projectId, assetId);
      if (projection.resource.kind !== kind) {
        throw new Error(
          `Asset ${assetId} kind ${projection.resource.kind} does not match ${kind}.`,
        );
      }
      return await executorAssets.open({
        invocationId,
        path: projection.path,
        byteLength: projection.resource.byteLength,
        kind: projection.resource.kind,
        ...(projection.resource.contentType
          ? { mediaType: projection.resource.contentType }
          : {}),
      });
    },
    readAsset: async ({ assetId, projectId }) => {
      // Inputs uploaded immediately before an invocation are already immutable Resources, but do
      // not become Project Assets merely because a Provider needs to read them. Resolve that
      // Host-private staging receipt through the same broker path as ordinary Project references.
      const staged = await stagedAssets.resolve({
        projectId,
        projectAssetId: assetId,
      });
      if (staged) {
        return {
          kind: staged.kind,
          ...(staged.mediaType ? { mediaType: staged.mediaType } : {}),
          bytes: new Uint8Array(await readFile(staged.projection.path)),
        };
      }
      const projection = await openProjectAssetProjection(projectId, assetId);
      return {
        kind: projection.resource.kind,
        ...(projection.resource.contentType
          ? { mediaType: projection.resource.contentType }
          : {}),
        bytes: new Uint8Array(await readFile(projection.path)),
      };
    },
    readDocument: async ({ documentAssetId, revisionId, projectId }) =>
      inspectProjectDocument(projectId, async (doc) => {
        const revision = readDocumentAssetRevision(doc, {
          documentAssetId,
          revisionId,
        });
        if (!revision) {
          throw new Error(
            `Document revision ${documentAssetId}/${revisionId} is not found.`,
          );
        }
        if (revision.body.contentType !== "application/json") {
          throw new Error(
            `Document revision ${documentAssetId}/${revisionId} is not a JSON body.`,
          );
        }
        const body = ExecutablePluginJsonValueSchema.parse(
          parseDocumentBody(
            revision.documentKind,
            revision.schemaVersion,
            await readMetadataBody({
              dataDir: options.dataDir,
              contentHash: revision.body.digest,
            }),
          ),
        );
        return {
          documentKind: revision.documentKind,
          schemaVersion: revision.schemaVersion,
          body,
        };
      }),
    ...(options.publicAssetStorage
      ? {
          publishAsset: async ({
            pluginId,
            invocationId,
            assetId,
            mediaType,
            bytes,
          }) => {
            const publicConfig =
              await options.publicAssetStorage!.getPublicConfig();
            if (!publicConfig.available) return undefined;
            const published = await options.publicAssetStorage!.publish({
              key: `plugins/${pluginId}/${invocationId}/${assetId}`,
              bytes,
              ...(mediaType ? { contentType: mediaType } : {}),
            });
            return {
              url: published.url,
              expiresAt: published.expiresAt,
            };
          },
        }
      : {}),
    /**
     * This plugin's own stored values, for the account this invocation runs on.
     *
     * The store existed with its own tests and was referenced by nothing outside them, so a plugin
     * asking for its credential got "Local plugin store is unavailable" -- built, tested, and
     * unreachable. Both halves are lazy because opening the store creates a table and reads a key
     * off disk, and a host that never runs a plugin should not pay for either.
     */
    storeGet: async ({ pluginId, accountId, key }) => {
      const store = await pluginStore();
      return await store.get({ pluginId, accountId, key });
    },

    storePut: async ({
      pluginId,
      accountId,
      key,
      value,
      secret,
      expiresAt,
    }) => {
      const store = await pluginStore();
      await store.put({
        pluginId,
        accountId,
        key,
        value,
        ...(secret === undefined ? {} : { secret }),
        ...(expiresAt === undefined
          ? {}
          : { expiresAt: Date.parse(expiresAt) }),
      });
    },

    /**
     * Somewhere to stream bytes, and the collection afterwards.
     *
     * Both halves are the host's business, which is the point: this host answers with a loopback
     * URL and writes to the local store, a hosted one answers with presigned object storage. The
     * plugin makes the same two calls either way.
     */
    openUploadSlot: async ({
      pluginId,
      pluginVersion,
      projectId,
      invocationId,
      taskId,
      slot,
      kind,
      byteLength,
      mediaType,
      accountId,
      url,
    }) => {
      const token = randomUUID();
      const assetId = `upload-${token}`;

      // A vendor that answered with a link has already produced the bytes; there is nobody left to
      // upload them. Handing back a slot URL here would leave the plugin holding an address it was
      // told to pass through, and the asset would never arrive -- which is where a completed,
      // paid-for generation was being dropped.
      if (url) {
        const fetched = await fetchIntoSlot(url, {
          ...(options.assetFetch ? { fetchImpl: options.assetFetch } : {}),
          ...(mediaType ? { mediaType } : {}),
        });
        return writeAssetBytes({
          pluginId,
          pluginVersion,
          projectId,
          invocationId,
          taskId,
          slot,
          kind,
          ...(fetched.mediaType ? { mediaType: fetched.mediaType } : {}),
          ...(accountId ? { accountId } : {}),
          bytes: fetched.bytes,
        });
      }

      pendingUploads.set(token, {
        assetId,
        slot,
        byteLength,
        bytes: undefined,
      });
      const uploadOrigin =
        typeof options.uploadOrigin === "function"
          ? options.uploadOrigin()
          : options.uploadOrigin;
      return {
        uploadUrl: `${uploadOrigin ?? ""}/api/v1/plugin-uploads/${token}`,
        assetId,
      };
    },

    finishUpload: async (input) => {
      const token = input.assetId.replace(/^upload-/, "");
      const pending = pendingUploads.get(token);
      if (!pending?.bytes) {
        // Naming an upload that never arrived would attach an empty asset to a finished node.
        throw new Error(`No bytes were uploaded for ${input.slot}.`);
      }
      if (pending.bytes.byteLength !== pending.byteLength) {
        throw new Error(
          `${input.slot} was announced as ${pending.byteLength} bytes and arrived as ` +
            `${pending.bytes.byteLength}.`,
        );
      }
      pendingUploads.delete(token);
      return await writeAssetBytes({ ...input, bytes: pending.bytes });
    },

    writeAsset: writeAssetBytes,
    audit: (record) =>
      metadataStore.appendPluginBrokerAudit({
        id: randomUUID(),
        ...record,
      }),
  });
  broker.close = () => executorAssets.close();
  return broker;
}

export function createWorkflowPluginBindingResolver(options: {
  ensurePluginRuntime(): Promise<void>;
  resolveBinding(
    pluginId: string,
    exportId: string,
    kind: "action",
  ): Promise<ExecutablePluginBinding>;
}): (pluginId: string, exportId: string) => Promise<ExecutablePluginBinding> {
  return async (pluginId, exportId) => {
    await options.ensurePluginRuntime();
    return ExecutablePluginBindingSchema.parse(
      await options.resolveBinding(pluginId, exportId, "action"),
    );
  };
}

const hostLog = createStructuredLogger({ component: "local-api", module: "server" });

export async function startLocalApiServer(options: LocalApiServerOptions) {
  // The recorder/replayer is intentionally imported only for the explicit test harness option.
  // Its module also supports child-process `--import` startup, so a production Host must not load
  // it (and therefore must not install a process-wide HTTP interceptor) by default.
  const processProviderHttpInstrumentationReady =
    options.providerHttpInstrumentation === undefined
      ? Promise.resolve(undefined)
      : import("./provider-http-instrumentation.js").then(
          ({ startProviderHttpInstrumentation }) =>
            startProviderHttpInstrumentation({
              mode: options.providerHttpInstrumentation!.mode,
              trafficPath: options.providerHttpInstrumentation!.trafficPath,
              ...(options.providerHttpInstrumentation!.activeStubPath
                ? {
                    activeStubPath:
                      options.providerHttpInstrumentation!.activeStubPath,
                  }
                : {}),
            }),
        );
  const clashHome = clashHomeForLocalDataDir(options.dataDir);
  const actionsRoot = join(clashHome, "actions");
  const codexImagegen = await (
    options.codexImagegenPreflight ?? preflightCodexImageGenerator
  )().catch(
    (): CodexImageGeneratorPreflightResult => ({
      available: false,
      reason: "login-check-failed",
    }),
  );
  if (!codexImagegen.available) {
    hostLog.info("host.optional_provider_unavailable", { provider: "codex-imagegen", reason: codexImagegen.reason });
  }
  const discoveryEnabled = options.discovery?.enabled !== false;
  const pendingDiscoveryHostId = discoveryEnabled ? randomUUID() : undefined;
  const discoveryProfile = resolveClashProfile(process.env);
  // `tsx watch` replaces this server process; its stable parent owns the lease.
  const sourceWatchLifecyclePid =
    process.env.CLASH_DAEMON_SOURCE_WATCH === "1" ? process.ppid : undefined;
  const codexImagegenMarketplace = createCodexImagegenMarketplace({
    actionsRoot,
  });
  const officialPluginsMarketplace = createOfficialPluginsMarketplace({
    actionsRoot,
  });
  const npxSkillsMarketplace = createNpxSkillsMarketplace({
    registry: skillMarketplaceRegistry,
    configStore: createClashUserConfigStore(options.dataDir),
  });
  const marketplaceSkills = [...npxSkillsMarketplace.skills];
  const marketplacePlugins = [
    ...(codexImagegen.available ? codexImagegenMarketplace.plugins : []),
    ...officialPluginsMarketplace.plugins,
  ];
  const codexImagegenPluginId = codexImagegenMarketplace.plugins[0]!.id;
  const marketplaceFeed = selectMarketplaceFeed({
    plugins: marketplacePlugins,
    skills: marketplaceSkills,
  });
  const projectAssetFileReplica = new FileReplicaStore(
    join(options.dataDir, "projects"),
  );
  let roomHub: LocalLoroRoomHub | undefined;
  let projectCloudSync: ReturnType<typeof createLocalProjectCloudSync> | undefined;
  const projectAssetReplica: LocalProjectAssetReplica = {
    async inspect(projectId, read) {
      if (roomHub) return roomHub.inspectProject(projectId, read);
      return read(await projectAssetFileReplica.recover(projectId));
    },
    async mutate(projectId, mutation) {
      if (roomHub) return roomHub.mutateProject(projectId, mutation);
      return projectAssetFileReplica.updateSnapshotAtomic(projectId, mutation);
    },
  };
  const checkpointedProjectAuthority: LocalDocumentProjectAuthority &
    LocalGeneratorProjectAuthority = {
    inspect: (projectId, read) => projectAssetReplica.inspect(projectId, read),
    mutate: async (projectId, mutation) => {
      if (!roomHub) {
        throw new Error("Local project room hub is not ready.");
      }
      return roomHub.mutateProjectWithCheckpoint(projectId, mutation);
    },
  };
  let boundPort: number | undefined = options.port || undefined;
  const localOrigin = () => (boundPort ? `http://127.0.0.1:${boundPort}` : "");
  const pluginAssetStaging = createLocalPluginAssetStagingStore({
    dataDir: options.dataDir,
    clashRoot: clashHome,
  });
  const publicAssetStorage =
    options.publicAssetStorage ??
    createPublicAssetStorageService({ dataDir: options.dataDir });
  const audioConfig =
    options.audioConfig ??
    createLocalAudioConfigStore({
      dataDir: options.dataDir,
    });
  void audioConfig.getVoiceInputConfig?.().catch((error) => {
    hostLog.warn("host.voice_probe_degraded", { error });
  });
  let mediaAnalysisService: LocalMediaAnalysisService | undefined;
  let videoEnhanceService: LocalVideoEnhanceService | undefined;
  const pluginBroker = createLocalPluginBrokerServices({
    dataDir: options.dataDir,
    assetStaging: pluginAssetStaging,
    audioConfig,
    generateAgentText: async (input) => {
      if (!localAcp?.runTextTask) throw new Error("The local ACP text executor is unavailable.");
      const result = await localAcp.runTextTask(input);
      return { text: result.text };
    },
    // Provider execution runs while the Project room owns its serial mutation queue. Resolving a
    // reference through that same live-room adapter would enqueue a read behind the invocation
    // that is waiting for it. Provider inputs are immutable committed facts, so this broker reads
    // the last acknowledged room checkpoint and Resource CAS instead of uncommitted in-memory
    // room state or an independently recovered file view.
    inspectProjectDocument: async (projectId, read) => {
      if (roomHub) {
        return roomHub.inspectCheckpointedProject(projectId, read);
      }
      return read(await projectAssetFileReplica.recover(projectId));
    },
    uploadOrigin: localOrigin,
    publicAssetStorage,
    ...(codexImagegen.available
      ? { generateCodexImage: codexImagegen.generate }
      : {}),
    directorStageRenderer: options.directorStageRenderer,
    analyzeMedia: async (input) => {
      if (!mediaAnalysisService) {
        throw new Error("Media analysis runtime is not ready.");
      }
      return mediaAnalysisService.analyze(input);
    },
    enhanceVideo: async (input) => {
      if (!videoEnhanceService) {
        throw new Error("Video enhancement runtime is not ready.");
      }
      return videoEnhanceService.enhance(input);
    },
    ...(options.providerAssetFetch
      ? { assetFetch: options.providerAssetFetch }
      : {}),
  });
  const pluginHostClient = new PluginHostClient({
    socketPath: pluginHostSocketPath(process.env, clashHome),
  });
  let directPluginHost: ActionsHost | null = null;
  const pluginExecutionClient = {
    async listCards() {
      return directPluginHost
        ? directPluginHost.listCards()
        : pluginHostClient.listCards();
    },
    async listProviders() {
      return directPluginHost
        ? directPluginHost.listProviders()
        : pluginHostClient.listProviders();
    },
    async listModelBindings() {
      return directPluginHost
        ? directPluginHost.listModelBindings()
        : pluginHostClient.listModelBindings();
    },
    async listGenerators() {
      return directPluginHost
        ? directPluginHost.listGenerators()
        : pluginHostClient.listGenerators();
    },
    async listViews() {
      return directPluginHost
        ? directPluginHost.listViews()
        : pluginHostClient.listViews();
    },
    async resolveGeneratorDefinition(pluginId: string, definitionId: string) {
      return directPluginHost
        ? directPluginHost.resolveGeneratorDefinition(pluginId, definitionId)
        : pluginHostClient.resolveGeneratorDefinition(pluginId, definitionId);
    },
    async listFunctionExports(pluginId: string) {
      return directPluginHost
        ? directPluginHost.listFunctionExports(pluginId)
        : pluginHostClient.listFunctionExports(pluginId);
    },
    async resolveBinding(
      pluginId: string,
      exportId: string,
      kind: "action" | "provider-projector" | "provider-executor",
    ) {
      return directPluginHost
        ? directPluginHost.resolveBinding(pluginId, exportId, kind)
        : pluginHostClient.resolveBinding(pluginId, exportId, kind);
    },
    async invoke(
      pluginId: string,
      invocation: Parameters<PluginHostClient["invoke"]>[1],
      invocationOptions?: Parameters<PluginHostClient["invoke"]>[2],
    ) {
      return directPluginHost
        ? directPluginHost.invoke(pluginId, invocation, invocationOptions)
        : pluginHostClient.invoke(pluginId, invocation, invocationOptions);
    },
  };
  const pluginHostProjector = createProviderPluginProjector({
    client: pluginExecutionClient,
  });
  const pluginHostProviderExecutor = createProviderPluginExecutor({
    client: pluginExecutionClient,
  });
  const pluginHostExecutableAction = createExecutablePluginActionInvoker({
    client: pluginExecutionClient,
  });
  let embeddedPluginHost: ActionsHost | null = null;
  let embeddedPluginIpc: PluginHostIpcServer | null = null;
  let pluginRuntimeReady: Promise<void> | null = null;
  const ensurePluginRuntime = () =>
    (pluginRuntimeReady ??= (async () => {
      // First-party payloads are loaded only from the Host's closed immutable registry. The
      // actions directory remains the activation authority for third-party process/stdio plugins;
      // a directory with a reserved first-party id is an untrusted shadow and is skipped.
      const host = new ActionsHost({
        actionsRoot,
        pluginBroker,
        trustedBundledPluginModules: codexImagegen.available
          ? TRUSTED_BUNDLED_PLUGIN_MODULES
          : TRUSTED_BUNDLED_PLUGIN_MODULES.filter(
              ({ id }) => id !== codexImagegenPluginId,
            ),
        loadTrustedBundledPluginModule,
        ...(options.providerHttpInstrumentation
          ? { providerHttpInstrumentation: options.providerHttpInstrumentation }
          : {}),
        ...(options.developmentPluginWatchRoots
          ? { developmentPluginWatchRoots: options.developmentPluginWatchRoots }
          : {}),
      });
      await host.start();
      // The test-only process interceptor patches Node's low-level net.connect in addition to
      // HTTP. Going out and back through the Host's Unix socket would therefore make its liveness
      // probe look like a mocked connection. Replay runs against this already-embedded ActionsHost
      // directly; third-party process/stdio endpoints inside it remain unchanged and keep their
      // own child-process preload.
      if (options.providerHttpInstrumentation) {
        directPluginHost = host;
        embeddedPluginHost = host;
        return;
      }
      try {
        embeddedPluginIpc = await startPluginHostIpcServer({
          host,
          socketPath: pluginHostSocketPath(process.env, clashHome),
        });
        embeddedPluginHost = host;
      } catch (error) {
        await host.stopAll();
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "EADDRINUSE"
        )) {
          throw error;
        }
        // Another local-api host already owns the socket.
      }
    })());
  const providerPluginProjector = (async (request) => {
    await ensurePluginRuntime();
    return pluginHostProjector(request);
  }) satisfies import("./local-aigc.js").ProviderPluginProjector;
  const providerPluginExecutor = (async (request) => {
    await ensurePluginRuntime();
    return pluginHostProviderExecutor(request);
  }) satisfies import("./local-aigc.js").ProviderPluginExecutor;
  videoEnhanceService = createLocalVideoEnhanceService({
    providerPluginExecutor,
  });
  const resolveProviderPluginBinding = async (
    pluginId: string,
    exportId: string,
    kind: "provider-executor",
  ) => {
    await ensurePluginRuntime();
    return pluginExecutionClient.resolveBinding(pluginId, exportId, kind);
  };
  const executablePluginAction = (async (request) => {
    await ensurePluginRuntime();
    return pluginHostExecutableAction(request);
  }) satisfies import("./plugin-action-runtime.js").ExecutablePluginActionInvoker;
  const workflowPluginBindingResolver = createWorkflowPluginBindingResolver({
    ensurePluginRuntime,
    resolveBinding: (pluginId, exportId, kind) =>
      pluginExecutionClient.resolveBinding(pluginId, exportId, kind),
  });
  const listPluginCards = async () => {
    await ensurePluginRuntime();
    return pluginExecutionClient.listCards();
  };
  const listPluginProviders = async () => {
    await ensurePluginRuntime();
    return pluginExecutionClient.listProviders();
  };
  const listPluginModelBindings = async () => {
    await ensurePluginRuntime();
    return pluginExecutionClient.listModelBindings();
  };
  const listPluginGenerators = async () => {
    await ensurePluginRuntime();
    return pluginExecutionClient.listGenerators();
  };
  const listPluginViews = async () => {
    await ensurePluginRuntime();
    return pluginExecutionClient.listViews();
  };
  const resolvePluginGeneratorDefinition = async (
    pluginId: string,
    definitionId: string,
  ) => {
    await ensurePluginRuntime();
    return pluginExecutionClient.resolveGeneratorDefinition(
      pluginId,
      definitionId,
    );
  };
  const resolveGeneratorConsumerForShape = async (semanticShape: string) => {
    const registrations = await listPluginGenerators();
    for (const registration of registrations) {
      for (const action of registration.document.spec.actions) {
        if (action.modelConsumer?.semanticShape === semanticShape) {
          return {
            pluginId: registration.pluginId,
            definitionId: registration.document.spec.definitionId,
            actionId: action.id,
          };
        }
      }
    }
    return undefined;
  };
  const discoveryRunDir = options.discovery?.runDir ?? join(clashHome, "run");
  const localAcp = (options.agentRuntime ?? process.env.CLASH_AGENT_RUNTIME) === "disabled"
    ? undefined
    : options.localAcp ?? createConfiguredLocalAcpAdapter(process.env, {
        apiBaseUrl: `http://127.0.0.1:${options.port}`,
        dataDir: options.dataDir,
      });
  let configWatcherClosed = false;
  let localAcpReady!: Promise<void>;
  let configReloadQueue = Promise.resolve();
  const stopConfigWatcher = localAcp ? watchClashUserConfig(options.dataDir, {
    onChange(config, previousConfig) {
      const apply = configReloadQueue.then(async () => {
        await localAcpReady;
        if (configWatcherClosed) return;
        const nextSignature = JSON.stringify(config.harnesses ?? null);
        const previousSignature = JSON.stringify(
          previousConfig?.harnesses ?? null,
        );
        if (nextSignature === previousSignature) return;
        await localAcp.reconcileConfiguration?.();
      });
      configReloadQueue = apply.catch(() => undefined);
      return apply;
    },
    onError(error) {
      hostLog.warn("host.config_reload_rejected", { error });
    },
  }) : () => {};
  localAcpReady = Promise.resolve(localAcp?.warmup?.()).catch((error) => {
    hostLog.warn("host.acp_warmup_degraded", { error });
  });
  const falMock = createMockFalQueueService();
  const syncConfig = createLocalSyncConfigStore({
    dataDir: options.dataDir,
    env: process.env,
  });
  const localTts = createLocalTtsGenerationHandler(audioConfig);
  const ffprobePath = localFfprobePath();
  const inspectAssetResource = ffprobePath
    ? createLocalFfprobeAssetInspector({ ffprobePath })
    : undefined;
  const assetInspection = createLocalAssetInspectionService({
    dataDir: options.dataDir,
    clashRoot: clashHome,
    ...(inspectAssetResource ? { inspectResource: inspectAssetResource } : {}),
  });
  const assetRepresentations = createLocalAssetRepresentationService({
    dataDir: options.dataDir,
    clashRoot: clashHome,
    assetInspection,
  });
  const externalAigcOptions = {
    fal: falMock,
    origin: `http://127.0.0.1:${options.port}`,
    providerAccounts: () => loadLocalProviderAccounts(options.dataDir),
    providerPluginProjector,
    providerPluginExecutor,
    resolveProviderPluginStagedAsset: async ({
      projectId,
      projectAssetId,
    }: {
      projectId: string;
      projectAssetId: string;
    }) => {
      const staged = await pluginAssetStaging.resolve({
        projectId,
        projectAssetId,
      });
      if (!staged) return undefined;
      return {
        bytes: new Uint8Array(await readFile(staged.projection.path)),
        kind: staged.kind,
        ...(staged.mediaType ? { contentType: staged.mediaType } : {}),
      };
    },
    resolveProviderPluginBinding,
    localTts,
  };
  const externalAigc = createMockExternalAigcService({
    ...externalAigcOptions,
    modelCards: async (consumer) =>
      loadLocalModelCards(
        options.dataDir,
        "local-user",
        await listPluginCards(),
        await listPluginModelBindings(),
        consumer,
      ),
  });
  /**
   * Shared, semantic-shape-generic runnable-model discovery for every Settings-driven Generator
   * model consumer (media_analysis, video_enhancement, ...). Each executable candidate route is
   * proven executable and its exact resolved Provider executor binding (version/schemaHash) is
   * frozen into the returned option's `implementation`, alongside the route's own declared
   * `assetInputs` -- the same Run authority a durable poll later checks for drift.
   */
  const resolveExecutableModelOptions = async (input: {
    semanticShape: string;
    outputKind: import("@clash/shared-types").ModelKind;
    sourceKind: MediaAnalysisSourceKind;
  }) => {
    const consumer = await resolveGeneratorConsumerForShape(
      input.semanticShape,
    );
    if (!consumer) return [];
    const [registrations, bindings, configuredProviders] = await Promise.all([
      listPluginCards(),
      listPluginModelBindings(),
      loadLocalProviderAccounts(options.dataDir),
    ]);
    const cards = await loadLocalModelCards(
      options.dataDir,
      "local-user",
      registrations,
      bindings,
      consumer,
    );
    const executableBindings = new Map<
      string,
      import("@clash/shared-types").ExecutablePluginBinding
    >();
    await Promise.all(
      cards.flatMap((card) =>
        (card.providerImplementations ?? []).map(async (route) => {
          if (!route.executorPluginId || !route.executorExportId) return;
          try {
            const resolved = await resolveProviderPluginBinding(
              route.executorPluginId,
              route.executorExportId,
              "provider-executor",
            );
            executableBindings.set(
              `${route.executorPluginId}:${route.executorExportId}`,
              resolved,
            );
          } catch {
            // Inactive/untrusted executors make only this exact route unavailable.
          }
        }),
      ),
    );
    return listConsumerModelCatalogEntries({
      consumer,
      semanticShape: input.semanticShape,
      outputKind: input.outputKind,
      sourceKind: input.sourceKind,
      referenceCounts: { [input.sourceKind]: 1 },
      models: cards,
      configuredProviders,
      isRouteExecutable: (route) =>
        !!route.executorPluginId &&
        !!route.executorExportId &&
        executableBindings.has(
          `${route.executorPluginId}:${route.executorExportId}`,
        ),
    }).flatMap((entry) =>
      entry.selectedRoute
        ? [
            mediaAnalysisModelOptionFromCatalogEntry(
              { ...entry, selectedRoute: entry.selectedRoute },
              consumer,
              input.sourceKind,
              entry.selectedRoute.executorPluginId &&
                entry.selectedRoute.executorExportId
                ? executableBindings.get(
                    `${entry.selectedRoute.executorPluginId}:${entry.selectedRoute.executorExportId}`,
                  )
                : undefined,
            ),
          ]
        : [],
    );
  };
  const clashUserConfigStore = createClashUserConfigStore(options.dataDir);
  const resolveCloudAdmission = async () => {
    if (options.cloudAdmission) return options.cloudAdmission;
    const config = await syncConfig.getPublicConfig();
    const baseUrl = config.remote_loro.url;
    return baseUrl ? createHttpCloudAdmissionClient({
      baseUrl,
      token: async () => {
        const credentials = await clashUserConfigStore.getCredentials();
        const value = process.env.CLASH_REMOTE_LORO_TOKEN ?? credentials.syncRemoteLoroToken ?? credentials.cliApiKey;
        return typeof value === "string" ? value : undefined;
      },
    }) : undefined;
  };
  const mediaAnalysisConfig = createLocalMediaAnalysisConfigStore({
    dataDir: options.dataDir,
    resolveOptions: (sourceKind) =>
      resolveExecutableModelOptions({
        semanticShape: "media_analysis",
        outputKind: "text",
        sourceKind,
      }),
  });
  mediaAnalysisService = createLocalMediaAnalysisService({
    config: mediaAnalysisConfig,
    aigc: externalAigc,
  });
  const app = createLocalApiApp({
    dataDir: options.dataDir,
    prepareProjectWorkspace: async (projectId) => {
      await ensureAgentCwd("clash", projectId, { harnessId: "codex-acp" }, {
        ...process.env,
        CLASH_LOCAL_DATA_DIR: options.dataDir,
      });
    },
    projectAssetProjectionOrigin: localOrigin,
    projectAssetReplica,
    acceptPluginUpload,
    hostIdentity: pendingDiscoveryHostId
      ? {
          hostId: pendingDiscoveryHostId,
          pid: sourceWatchLifecyclePid ?? process.pid,
          profile: discoveryProfile,
          protocolVersion: LOCAL_HOST_PROTOCOL_VERSION,
          ...(process.env.CLASH_DAEMON_RUNTIME_FINGERPRINT
            ? {
                runtimeFingerprint:
                  process.env.CLASH_DAEMON_RUNTIME_FINGERPRINT,
              }
            : {}),
        }
      : undefined,
    localAcp,
    localAcpReady,
    falMock,
    syncConfig,
    publicAssetStorage,
    resolveCloudAdmission,
    ensureProjectSync: async (projectId) => {
      await projectCloudSync?.schedule(projectId);
    },
    onProjectChanged: async projectId => { await projectCloudSync?.invalidate(projectId); },
    audioConfig,
    mediaAnalysisConfig,
    resolveGeneratorModelExecution: createLocalModelExecutionPlanner({
      dataDir: options.dataDir,
      aigc: externalAigc,
      modelCards: async () => loadLocalModelCards(options.dataDir, "local-user",
        await listPluginCards(), await listPluginModelBindings()),
    }),
    resolveGeneratorModelConsumer: async ({ semanticShape, sourceKind }) => {
      const consumer = await resolveGeneratorConsumerForShape(semanticShape);
      if (!consumer) {
        throw new Error(
          `No active Generator consumer is registered for semantic shape ${semanticShape}.`,
        );
      }
      if (semanticShape === "video_enhancement") {
        const stored = await clashUserConfigStore.getSection<{
          model_id?: string | null;
        }>("video_enhancement");
        const settingsModelId =
          typeof stored?.model_id === "string" && stored.model_id.trim()
            ? stored.model_id.trim()
            : null;
        const videoEnhanceOptions = await resolveExecutableModelOptions({
          semanticShape,
          outputKind: "video",
          sourceKind,
        });
        const selected = settingsModelId
          ? videoEnhanceOptions.find((option) => option.id === settingsModelId)
          : videoEnhanceOptions.length === 1
            ? videoEnhanceOptions[0]
            : undefined;
        if (!selected) {
          throw new Error(
            settingsModelId
              ? `Video enhancement model ${settingsModelId} has no configured and executable Provider route for ${sourceKind}.`
              : `Select a ${semanticShape} model in Settings before running.`,
          );
        }
        return { modelId: selected.id, route: selected.implementation };
      }
      if (semanticShape !== "media_analysis") {
        throw new Error(
          `No Settings resolver is registered for semantic shape ${semanticShape}.`,
        );
      }
      const config = await mediaAnalysisConfig.get();
      if (!config.modelId) {
        throw new Error(
          `Select a ${semanticShape} model in Settings before running.`,
        );
      }
      const selected = await mediaAnalysisConfig.assertRunnable({
        sourceKind,
        modelId: config.modelId,
      });
      return { modelId: config.modelId, route: selected.implementation };
    },
    providerPluginExecutor,
    assetInspection,
    assetRepresentations,
    ...(options.providerGenerationDeadlineMs === undefined
      ? {}
      : {
          providerGenerationDeadlineMs: options.providerGenerationDeadlineMs,
        }),
    processProjectWork: async (projectId) => {
      if (!roomHub) {
        throw new Error("Local project room hub is not ready.");
      }
      await roomHub.refresh(projectId);
    },
    generatorProjectAuthority: checkpointedProjectAuthority,
    documentProjectAuthority: checkpointedProjectAuthority,
    workspaceProjectAuthority: checkpointedProjectAuthority,
    workspaceImportAuthority: {
      reconcileCommittedImport: (projectId, reservationId, snapshotSha256) => {
        if (!roomHub) {
          throw new Error("Local project room hub is not ready.");
        }
        return roomHub.reconcileCommittedImport(
          projectId,
          reservationId,
          snapshotSha256,
        );
      },
      install: (
        projectId,
        reservationId,
        snapshot,
        commitReceiverAuthority,
      ) => {
        if (!roomHub) {
          throw new Error("Local project room hub is not ready.");
        }
        return roomHub.installImportedProject(
          projectId,
          reservationId,
          snapshot,
          commitReceiverAuthority,
        );
      },
    },
    listInstalledMarketplaceActions: () =>
      codexImagegen.available
        ? codexImagegenMarketplace.listInstalled()
        : Promise.resolve([]),
    marketplaceSkills,
    marketplaceFeed,
    listInstalledMarketplaceSkills: () => npxSkillsMarketplace.listInstalled(),
    installMarketplaceSkill: (skillId, installation) => npxSkillsMarketplace.install(skillId, installation),
    uninstallMarketplaceSkill: (skillId) =>
      npxSkillsMarketplace.uninstall(skillId),
    marketplacePlugins,
    installMarketplacePlugin: (packageId) =>
      codexImagegen.available && packageId === codexImagegenPluginId
        ? codexImagegenMarketplace.install(packageId)
        : officialPluginsMarketplace.install(packageId),
    uninstallMarketplacePlugin: (pluginId) =>
      codexImagegen.available && pluginId === codexImagegenPluginId
        ? codexImagegenMarketplace.uninstall(pluginId)
        : officialPluginsMarketplace.uninstall(pluginId),
    pluginPackages: {
      list: () => listHostExecutablePluginPackages(actionsRoot),
      validate: (input) =>
        validateHostExecutablePluginPackageContracts(
          input as HostExecutablePluginPackage,
          actionsRoot,
        ),
      activate: (input) =>
        activateOrUpdateHostExecutablePluginPackage(
          input as HostExecutablePluginPackage,
          actionsRoot,
        ),
      read: (id) => readHostExecutablePluginPackage(actionsRoot, id),
      rollback: (id) => rollbackHostExecutablePluginPackage(actionsRoot, id),
      remove: (id) => removeHostExecutablePluginPackage(actionsRoot, id),
    },
    resolvePluginBinding: async (pluginId, exportId, kind) => {
      await ensurePluginRuntime();
      return pluginExecutionClient.resolveBinding(pluginId, exportId, kind);
    },
    listPluginCards,
    listPluginGenerators,
    listPluginViews,
    resolveGeneratorDefinition: resolvePluginGeneratorDefinition,
    directorStageRenderer: options.directorStageRenderer,
    listPluginModelBindings,
    listPluginProviders,
  });
  // Set once the socket is bound. `options.port` is normally 0, so anything that captured
  // it produced an unroutable `http://127.0.0.1:0` -- reads of a generated asset then
  // failed with a bare `fetch failed`.
  const workflowProcessor = createLocalWorkflowProcessor({
    resolveGeneratorDefinition: resolvePluginGeneratorDefinition,
    listPluginCards,
    dataDir: options.dataDir,
    assetInspection,
    assetRepresentations,
    mediaBaseUrl: resolveMediaBaseUrl(() => boundPort),
    ...(options.providerGenerationDeadlineMs === undefined
      ? {}
      : {
          providerGenerationDeadlineMs: options.providerGenerationDeadlineMs,
        }),
    ...(options.providerPollDelayCapMs === undefined
      ? {}
      : { providerPollDelayCapMs: options.providerPollDelayCapMs }),
    modelCards: async () =>
      loadLocalModelCards(
        options.dataDir,
        "local-user",
        await listPluginCards(),
        await listPluginModelBindings(),
      ),
    executablePluginAction,
    resolvePluginBinding: workflowPluginBindingResolver,
    durableProviderRuns: {
      ownerId: localDurableRunOwnerId(pendingDiscoveryHostId),
      providerPluginExecutor,
    },
    textAgent: localAcp?.runTextTask
      ? {
          generate: async (input) => {
            const result = await localAcp.runTextTask!({
              projectId: input.projectId,
              prompt: input.prompt,
              ...(input.actorAgentId ? { agentId: input.actorAgentId } : {}),
              modelId:
                typeof input.modelParams?.acp_model === "string" &&
                input.modelParams.acp_model.trim()
                  ? input.modelParams.acp_model.trim()
                  : undefined,
              systemPrompt:
                typeof input.modelParams?.system_prompt === "string"
                  ? input.modelParams.system_prompt
                  : undefined,
            });
            return {
              text: result.text,
              provider: "local-acp",
              modelEndpoint: result.agentId ?? "default-agent",
            };
          },
        }
      : undefined,
    aigc: externalAigc,
  });
  const remotePersistence =
    options.remotePersistence === undefined
      ? (projectId?: string) => syncConfig.resolveRemotePersistence(projectId)
      : (options.remotePersistence ?? undefined);
  const projectUpgradeAssets = createLocalProjectAssetService({
    dataDir: options.dataDir, projectionOrigin: localOrigin, assetInspection, assetRepresentations,
  });
  const projectUpgradeJournal = createSqliteDurableRunJournal(options.dataDir);
  roomHub = new LocalLoroRoomHub(
    options.dataDir,
    remotePersistence,
    workflowProcessor,
    createLocalProjectUpgrade({
      materializeDoc: projectUpgradeAssets.materializeDoc,
      listDefinitions: listPluginGenerators,
      listActionCards: listPluginCards,
      rememberDefinition: projectUpgradeJournal.rememberGeneratorDefinition,
      modelCards: async () => loadLocalModelCards(options.dataDir, "local-user", await listPluginCards(), await listPluginModelBindings()),
    }),
    async projectId => { await projectCloudSync?.invalidate(projectId); },
  );
  const cloudSyncMetadata = createLocalMetadataStore(options.dataDir);
  projectCloudSync = createLocalProjectCloudSync({
    dataDir: options.dataDir, rooms: roomHub, inspection: assetInspection,
    remote: async projectId => typeof remotePersistence === "function" ? remotePersistence(projectId) : remotePersistence,
    metadata: {
      list: async () => (await cloudSyncMetadata.load()).projects.filter(project => !project.deletedAt).map(project => project.id),
      read: async projectId => {
        const project = (await cloudSyncMetadata.load()).projects.find(project => project.id === projectId);
        return project ? localProjectSyncMetadata(project) : null;
      },
      write: metadata => cloudSyncMetadata.applyProjectSyncMetadata(metadata),
    },
    token: async () => {
      const credentials = await clashUserConfigStore.getCredentials();
      const value = process.env.CLASH_REMOTE_LORO_TOKEN ?? credentials.syncRemoteLoroToken ?? credentials.cliApiKey;
      return typeof value === "string" ? value : undefined;
    },
  });
  await projectCloudSync.start();
  let resolveListening!: (server: ReturnType<typeof serve>) => void;
  let rejectListening!: (error: unknown) => void;
  let settled = false;
  const listening = new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    resolveListening = resolve;
    rejectListening = reject;
  });
  let publishedDiscoveryHostId: string | undefined;
  let startupRecovery: Promise<unknown> = Promise.resolve();
  const rendererRoot = options.projectRendererRoot ?? process.env.CLASH_PROJECT_RENDERER_ROOT ??
    fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../web/dist/client" : "./project-ui", import.meta.url));
  registerProjectRenderer(app, rendererRoot);
  const server = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port: options.port },
    (info) => {
      settled = true;
      boundPort = info.port;
      localAcp?.updateSpawnEnv(
        createLocalAgentToolEnv({
          dataDir: options.dataDir,
          apiBaseUrl: `http://127.0.0.1:${info.port}`,
          env: process.env,
        }),
      );
      hostLog.info("host.listening", { port: info.port, profile: discoveryProfile, hostId: pendingDiscoveryHostId });
      void syncConfig.getPublicConfig().then((config) => {
        if (config.remote_loro.enabled) {
          hostLog.info("host.remote_sync_enabled", { source: config.remote_loro.source });
        }
      });
      void (async () => {
        // Module-realm Providers use ordinary HTTP in this process. Install the same cassette
        // boundary used by child stdio plugins before exposing the listening Host to the harness.
        await processProviderHttpInstrumentationReady;
        if (pendingDiscoveryHostId) {
          publishedDiscoveryHostId = await writeServerDiscoveryRecord(
            info.port,
            options,
            discoveryRunDir,
            pendingDiscoveryHostId,
            discoveryProfile,
            sourceWatchLifecyclePid,
          );
        }
        // Recovery is owner-driven, not client-driven. Do not await Project processing here: a
        // Provider call may consume the remaining attempt budget, while the HTTP Host must become
        // reachable immediately so plugins can use its injected Asset endpoints.
        startupRecovery = bootstrapLocalDurableRunRecovery({
          dataDir: options.dataDir,
          ownerId: "local-api",
          roomHub: roomHub!,
        }).catch((error) => {
          hostLog.error("host.run_recovery_degraded", { error });
        });
        resolveListening(server);
      })().catch((error) => {
        server.close();
        rejectListening(error);
      });
    },
  );
  wrapServerCloseWithLifecycleCleanup(
    server,
    async () => {
      configWatcherClosed = true;
      stopConfigWatcher();
      await projectCloudSync?.close();
      await Promise.all([
        assetRepresentations.close(),
        localAcp?.disposeAll(),
        options.directorStageRenderer?.dispose(),
        Promise.resolve(pluginBroker.close?.()),
        startupRecovery.catch(() => undefined).then(() => roomHub?.close()),
        processProviderHttpInstrumentationReady.then((instrumentation) =>
          instrumentation?.dispose(),
        ),
        (pluginRuntimeReady ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            await embeddedPluginIpc?.close().catch(() => undefined);
            await embeddedPluginHost?.stopAll().catch(() => undefined);
          }),
      ]);
    },
    () =>
      sourceWatchLifecyclePid === undefined
        ? publishedDiscoveryHostId
        : undefined,
    discoveryRunDir,
  );
  server.once("error", (error) => {
    if (settled) {
      hostLog.error("host.server_failed", { error });
      return;
    }
    rejectListening(error);
  });
  attachLocalSync(server, {
    dataDir: options.dataDir,
    remotePersistence,
    workflowProcessor,
    hub: roomHub,
  });
  if (localAcp) attachLocalAcpSessions(server, localAcp);
  return listening;
}

async function writeServerDiscoveryRecord(
  actualPort: number,
  options: LocalApiServerOptions,
  runDir: string,
  hostId: string,
  profile: "dev" | "prod",
  lifecyclePid?: number,
): Promise<string> {
  const record = createHostDiscoveryRecord({
    hostId,
    endpoint: `http://127.0.0.1:${actualPort}`,
    agentCliPath: join(options.dataDir, "agent-bin", "clash"),
    launchMode: options.discovery?.launchMode ?? "cli-once",
    startedBy: options.discovery?.startedBy ?? "cli",
    ownerClientId: options.discovery?.ownerClientId,
    profile,
    pid: lifecyclePid,
  });
  await writeHostDiscovery(record, { runDir });
  return record.hostId;
}

function wrapServerCloseWithLifecycleCleanup(
  server: ReturnType<typeof serve>,
  disposeLocalAcp: () => Promise<void> | void,
  getHostId: () => string | undefined,
  runDir: string | undefined,
): void {
  const originalClose = server.close.bind(server);
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = Promise.all([
      Promise.resolve(disposeLocalAcp()).catch(() => undefined),
      Promise.resolve()
        .then(async () => {
          const hostId = getHostId();
          if (hostId) await removeHostDiscovery(hostId, { runDir });
        })
        .catch(() => undefined),
    ]).then(() => undefined);
    return cleanupPromise;
  };
  server.close = ((callback?: (error?: Error) => void) => {
    const lifecycleCleanup = cleanup();
    return originalClose((error?: Error) => {
      void lifecycleCleanup.finally(() => callback?.(error));
    });
  }) as typeof server.close;
}

const directRunUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (
  import.meta.url === directRunUrl &&
  !process.env.CLASH_LOCAL_API_WRAPPER_ENTRY
) {
  void startLocalApiServer({ port, dataDir });
}
