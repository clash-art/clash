import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { LoroDoc } from "loro-crdt";
import { z } from "zod";
import { clashHomeForLocalDataDir } from "./local-paths.js";
import {
  handleProjectCommand,
  projectCommandMutates,
} from "./project-command-host.js";
import { ProjectHostCommandSchema } from "./domain/requests.js";
import { createProviderExecutionHandoffStore } from "./provider-execution-handoff.js";
import {
  createLocalProjectAssetService,
  LocalProjectAssetMigrationError,
  type LocalProjectAssetReplica,
} from "./local-project-assets.js";
import {
  createLocalGlobalAssetService,
  LocalGlobalAssetError,
} from "./local-global-assets.js";
import {
  createLocalFfprobeAssetInspector,
  createLocalAssetInspectionService,
  type LocalAssetInspector,
  type LocalAssetInspectionService,
} from "./local-asset-inspections.js";
import {
  createLocalAssetRepresentationService,
  type LocalAssetRepresentationService,
} from "./local-asset-representations.js";
import { localFfmpegPath, localFfprobePath } from "./local-media-binaries.js";
import {
  createLocalMediaAnalysisConfigStore,
  type LocalMediaAnalysisConfig,
  type LocalMediaAnalysisConfigStore,
  type MediaAnalysisSourceKind,
} from "./media-analysis-config.js";
import {
  importLocalProviderToken,
  type LocalTokenImportAuth,
} from "./local-token-import.js";
import { openPluginStore } from "./plugin-store.js";
import {
  buildProjectRecoveryPolicy,
  buildProjectStatus,
  createBoundedRetryPolicy,
  defaultRuntimeCapabilities,
  durableRunIdempotencyKey,
  visibleUserPromptText,
  type DurableRunRecord,
  type ProjectRecoveryPolicy,
} from "@clash/shared-runtime";
import { AssetSdkContractError } from "@clash/asset-sdk";
import {
  agentReadReceiptToken,
  actionSourceModel,
  AssetEditActionInvocationSchema,
  AssetKindSchema,
  ASSET_ACTION_ID,
  Canvas,
  canvasBatchDeleteReadToken,
  canvasEdgeReadToken,
  canvasEdgesReadToken,
  canvasNodeReadToken,
  buildEffectiveModelCards,
  composeExecutablePluginModelCards,
  modelCardVisibleToConsumer,
  CustomActionDefinitionSchema,
  hostMutationRejected,
  hostMutationSucceeded,
  invalidProviderModelFilters,
  ensureCanvasGraphIdentity,
  listModelCatalogEntries,
  listDeclaredModelUpstreamRoutes,
  listNodeOwnedEdges,
  listProviderModelSupport,
  invocationModeForSurface,
  MOCK_MODEL_CARDS,
  MODEL_CARDS,
  localConfigReadToken,
  normalizeModelId,
  MetadataAttachmentTargetSchema,
  parseAssetMetadataFillAction,
  projectReadToken,
  providerAccountReadToken,
  providerAccountsReadToken,
  providerOAuthReadToken,
  ProviderOAuthIdSchema,
  readProjectDirectorStage,
  resolveAssetActionOutputKind,
  resolveGeneratorProjectionDefinition,
  sessionReadToken,
  TextAppliedRevisionSchema,
  UserModelCardConfigSchema,
  validateCanvasBatchDelete,
  validateCanvasBatchDeleteReadProof,
  validateCanvasEdgeAdd,
  validateCanvasEdgeDelete,
  validateCanvasEdgePatch,
  type ProjectCanvasPreview,
  validateCanvasEdgeReadProof,
  validateCanvasEdgesReadProof,
  validateCanvasReadProof,
  validateCanvasDelete,
  validateCanvasNodePatch,
  validateAgentReadProof as validateLegacyAgentReadProof,
  validateAgentObservation,
  validateHostMutationEnvelope,
  type AgentReadReceiptProof,
  type ActionAssetBinding,
  type AssetEditActionInvocation,
  type CanvasReadProofEdgeLike,
  type CanvasUpdateEdgeLike,
  type CanvasUpdateNodeWithIdLike,
  type ProviderAccountAvailability,
  type ProviderOAuthId,
  type ModelCard,
  type ModelUpstreamRoute,
  type ModelKind,
  type ProjectMetadata,
  ProjectCloudAdmissionRequestSchema,
  ProjectCloudAdmissionResponseSchema,
  type HostMutationRecord,
  type TextAppliedRevision,
  type UserModelCardConfig,
  type ExecutablePluginBinding,
  type ExecutablePluginJsonValue,
  type ExecutablePluginOutput,
  type ExecutablePluginCardRegistration,
  type ExecutablePluginModelBindingRegistration,
  type ExecutablePluginProviderRegistration,
  type ExecutablePluginGeneratorRegistration,
  type ExecutablePluginViewRegistration,
  type GeneratorDefinition,
  missingModelRouteCredentials,
  ExecutablePluginJsonValueSchema,
  ExecutablePluginOutputSchema,
  generatorDefinitionFromExecutablePluginRegistration,
  type ProviderCredentialRequirements,
  WorkspaceExportPlanSchema,
  WorkspaceExportRequestSchema,
  WorkspaceImportCommitRequestSchema,
  WorkspaceImportCommitResponseSchema,
  WorkspaceImportFileUploadReceiptSchema,
  WorkspaceImportSessionSchema,
  WorkspaceImportStartSchema,
  type ActionRunModelRoute,
} from "@clash/shared-types";
import type { Asset, AssetKind, ResolvedAsset } from "@clash/shared-types/assets";

const execFileAsync = promisify(execFile);

function parseAssetEditInvocation(input: {
  raw?: unknown;
  projectId: string;
  sourceAssetId: string;
  editKind: string;
  editParams: unknown;
  origin: "canvas-node" | "asset-preview";
}): AssetEditActionInvocation {
  if (typeof input.raw === "string" && input.raw.trim()) {
    return AssetEditActionInvocationSchema.parse(JSON.parse(input.raw));
  }
  const surface = input.origin === "asset-preview" ? "asset-preview" : "canvas";
  return AssetEditActionInvocationSchema.parse({
    actionId: input.editKind,
    projectId: input.projectId,
    source: {
      assetId: input.sourceAssetId,
      kind: input.editKind === ASSET_ACTION_ID.ImageEditor ? "image" : "video",
    },
    params: input.editParams,
    surface,
    mode: invocationModeForSurface(surface),
  });
}

import {
  storeTextRevisionContentBlob,
  textRevisionContentBlobPath,
  textRevisionContentHash,
  withTextRevisionContentDescriptor,
} from "./text-revision-content.js";
import {
  createMockFalQueueService,
  handleFalMockHttpRequest,
  type FalMockQueueService,
} from "./fal-mock.js";
import {
  createMockExternalAigcService,
  localExecutableModelCards,
  normalizeProviderReferenceMediaType,
  requireCompletedGeneration,
  type MockMediaGenerationCompleted,
  type MockMediaGenerationInput,
  type MockMediaGenerationResult,
  type ProviderPluginExecutionPlan,
  type ProviderPluginExecutor,
} from "./local-aigc.js";
import { createLocalPluginAssetStagingStore } from "./local-plugin-asset-staging.js";
import {
  createLocalAudioConfigStore,
  LocalAudioConfigError,
  type LocalAudioConfigReadState,
  type LocalAudioConfigStore,
} from "./audio-config.js";
import {
  createLocalSyncConfigStore,
  LocalSyncConfigError,
  type LocalSyncConfigReadState,
  type LocalSyncConfigStore,
} from "./sync-config.js";
import {
  createPublicAssetStorageService,
  PublicAssetStorageConfigError,
  type PublicAssetStorageService,
} from "./public-asset-storage.js";
import type { RemoteLoroPersistenceEnv } from "./sync.js";
import { createLocalProjectMetadataReplication } from "./project-metadata-replication.js";
import {
  createHttpCloudAdmissionClient,
  type LocalCloudAdmissionClient,
} from "./project-cloud-admission.js";
import {
  normalizeProviderAccountInput,
  providerAccountKey,
  providerAccountsForRuntime,
  publicProviderAccounts,
  type LocalProviderAccountConfig,
  type LocalProviderOAuthRecord,
  type LocalUserModelCardConfig,
} from "./provider-accounts.js";
import {
  createLocalDurableRun,
  createLocalDurableRunCoordinator,
  DEFAULT_LOCAL_PROVIDER_RUN_DEADLINE_MS,
  localDurableRunOwnerId,
  type LocalDurableRunCoordinator,
} from "./durable-run-coordinator.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { createLocalProviderStore } from "./local-provider-store.js";
import {
  createLocalMetadataStore,
  type LocalMetadataAgentMember as LocalAgentMember,
  type LocalMetadataDb,
  type LocalMutationAuditFilter,
  type LocalMutationAuditRecord,
  type LocalTextRevisionFilter,
  type LocalMetadataProject as LocalProject,
  type LocalMetadataSession as LocalSession,
} from "./local-metadata-store.js";
import { FileReplicaStore } from "./loro/file-replica-store.js";
import { readThroughProjectCanvasPreviewEntry } from "./project-canvas-preview-cache.js";
import {
  createProjectCanvasThumbnailCache,
  PROJECT_CANVAS_THUMBNAIL_HEIGHT,
  PROJECT_CANVAS_THUMBNAIL_WIDTH,
  type ProjectCanvasThumbnailInput,
} from "./project-canvas-thumbnail.js";
import {
  AdvanceLocalProjectGeneratorInputSchema,
  CreateLocalProjectGeneratorInputSchema,
  SubmitLocalGeneratorActionInputSchema,
  createLocalGeneratorProductService,
  LocalGeneratorProductError,
  type LocalGeneratorProjectAuthority,
} from "./local-generator-product.js";
import {
  AdvanceLocalDocumentAttachmentBodySchema,
  AdvanceLocalDocumentBodySchema,
  AttachLocalDocumentInputSchema,
  CreateLocalDocumentInputSchema,
  createLocalDocumentProductService,
  LocalDocumentProductError,
  type LocalDocumentProjectAuthority,
} from "./local-document-product.js";
import {
  LocalWorkspaceProjectOperationLease,
  LocalWorkspaceTransferError,
  createLocalWorkspaceTransferService,
  type LocalWorkspaceImportAuthority,
  type LocalWorkspaceProjectAuthority,
} from "./local-workspace-transfer.js";
import type {
  DirectorStageRenderRequest,
  LocalDirectorStageRenderer,
} from "./director-stage-renderer.js";

export interface ProviderOAuthDeviceFlowStart {
  verificationUri: string;
  userCode: string;
  deviceCode: string;
  expiresAt?: string;
  intervalSeconds?: number;
  oauthState?: string;
}

export interface ProviderOAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string;
  accountLabel?: string;
  availabilityError?: string;
}

export interface ProviderOAuthDriver {
  start(): Promise<ProviderOAuthDeviceFlowStart>;
  complete(input: {
    deviceCode: string;
    oauthState?: string;
  }): Promise<ProviderOAuthTokenResult>;
}

export interface LocalApiOptions {
  dataDir: string;
  /** Canonical loopback origin used in Project-scoped ResolvedAsset projections. */
  projectAssetProjectionOrigin?: string | (() => string);
  /** Host-owned live Project replica used by Project Asset routes. */
  projectAssetReplica?: LocalProjectAssetReplica;
  /** Injectable Resource probe used once per immutable Resource. */
  inspectAssetResource?: LocalAssetInspector;
  /** Process-owned registry shared by HTTP, workflow staging, and recovery. */
  assetInspection?: LocalAssetInspectionService;
  /** Process-owned L2/L3 derivation scheduler and representation registry. */
  assetRepresentations?: LocalAssetRepresentationService;
  /**
   * Receive bytes for an upload slot the broker handed out.
   *
   * Injected because the slot registry belongs to whoever issued the URL. A hosted deployment
   * issues presigned object-storage URLs and never sees this call at all.
   */
  acceptPluginUpload?: (token: string, bytes: Uint8Array) => boolean;
  clashRoot?: string;
  userId?: string;
  hostIdentity?: {
    hostId: string;
    pid: number;
    profile: "dev" | "prod";
    protocolVersion: number;
    runtimeFingerprint?: string;
  };
  localAcp?: LocalAcpAdapter;
  /** Single process-owned cold-start barrier. Runtime/config consumers wait
   * for it; diagnostic snapshot reads may opt out explicitly. */
  localAcpReady?: Promise<void>;
  falMock?: FalMockQueueService;
  audioConfig?: LocalAudioConfigStore;
  mediaAnalysisConfig?: LocalMediaAnalysisConfigStore;
  syncConfig?: LocalSyncConfigStore;
  /** Machine-level public Asset storage shared by Desktop, CLI, MCP and plugins. */
  publicAssetStorage?: PublicAssetStorageService;
  syncEnv?: RemoteLoroPersistenceEnv;
  /** Optional cloud control-plane adapter. Admission is project-scoped and does not enable global sync. */
  cloudAdmission?: LocalCloudAdmissionClient;
  /** Starts the project room after admission so the initial Loro replica can be mirrored. */
  ensureProjectSync?: (projectId: string) => Promise<void>;
  providerOAuth?: Partial<Record<ProviderOAuthId, ProviderOAuthDriver>>;
  providerPluginExecutor?: ProviderPluginExecutor;
  /** Host policy for a complete durable Provider run. Defaults to 30 minutes. */
  providerGenerationDeadlineMs?: number;
  /** Wake the shared project room after an HTTP command creates pending backend work. */
  processProjectWork?: (projectId: string) => Promise<void>;
  resolvePluginBinding?: (
    pluginId: string,
    exportId: string,
    kind: "action" | "provider-projector" | "provider-executor",
  ) => Promise<ExecutablePluginBinding>;
  listPluginCards?: () => Promise<ExecutablePluginCardRegistration[]>;
  listPluginModelBindings?: () => Promise<
    ExecutablePluginModelBindingRegistration[]
  >;
  listPluginProviders?: () => Promise<ExecutablePluginProviderRegistration[]>;
  /** Active Generator definitions are listed and resolved by the Plugin Host. */
  listPluginGenerators?: () => Promise<ExecutablePluginGeneratorRegistration[]>;
  /** Active declarative Views are listed by the Plugin Host and own no execution realm. */
  listPluginViews?: () => Promise<ExecutablePluginViewRegistration[]>;
  resolveGeneratorDefinition?: (
    pluginId: string,
    definitionId: string,
  ) => Promise<GeneratorDefinition>;
  /** Resolve a declared semantic model consumer from Host-owned Settings/catalog authority. */
  resolveGeneratorModelConsumer?: (input: {
    projectId: string;
    consumer: { pluginId: string; definitionId: string; actionId: string };
    semanticShape: string;
    sourceKind: "image" | "video" | "audio";
  }) => Promise<{ modelId: string; route: ActionRunModelRoute }>;
  /** Checkpoint-aware, serial Project authority used by Generator commands. */
  generatorProjectAuthority?: LocalGeneratorProjectAuthority;
  /** Checkpoint-aware, serial Project authority used by typed Document commands. */
  documentProjectAuthority?: LocalDocumentProjectAuthority;
  /** Serial live-room authority used for portable Workspace checkpoints. */
  workspaceProjectAuthority?: LocalWorkspaceProjectAuthority;
  /** Host-private atomic installation authority for imported Workspace Projects. */
  workspaceImportAuthority?: LocalWorkspaceImportAuthority;
  /** Test/embedding override for the OS application-support directory. */
  localTokenImportAppDataRoot?: string;
  marketplaceActions?: Array<
    Record<string, unknown> & {
      id: string;
      packageId: string;
    }
  >;
  listInstalledMarketplaceActions?: () => Promise<
    Array<Record<string, unknown>>
  >;
  installMarketplaceAction?: (
    packageId: string,
  ) => Promise<Record<string, unknown>>;
  uninstallMarketplaceAction?: (actionId: string) => Promise<void>;
  marketplaceSkills?: Array<Record<string, unknown> & { id: string }>;
  marketplaceFeed?: Array<Record<string, unknown> & { id: string }>;
  listInstalledMarketplaceSkills?: () => Promise<
    Array<Record<string, unknown>>
  >;
  installMarketplaceSkill?: (
    skillId: string,
  ) => Promise<Record<string, unknown>>;
  uninstallMarketplaceSkill?: (skillId: string) => Promise<void>;
  marketplacePlugins?: Array<
    Record<string, unknown> & {
      id: string;
      packageId: string;
    }
  >;
  installMarketplacePlugin?: (
    packageId: string,
  ) => Promise<Record<string, unknown>>;
  uninstallMarketplacePlugin?: (pluginId: string) => Promise<void>;
  pluginPackages?: {
    list(): Promise<object>;
    validate(input: unknown): Promise<object>;
    activate(input: unknown): Promise<object>;
    read(id: string): Promise<object>;
    rollback(id: string): Promise<object>;
    remove(id: string): Promise<object>;
  };
  directorStageRenderer?: LocalDirectorStageRenderer;
}

export type LocalAcpRuntimeStatus = "online" | "offline";

export function createLocalTtsGenerationHandler(
  audioConfig: LocalAudioConfigStore,
): (input: MockMediaGenerationInput) => Promise<MockMediaGenerationResult> {
  return async (input) => {
    const rawVoice =
      input.modelParams?.voice_name ?? input.modelParams?.voice_id;
    const voice =
      typeof rawVoice === "string" && rawVoice.trim() ? rawVoice.trim() : null;
    const rawSpeed = input.modelParams?.speed;
    const speed =
      typeof rawSpeed === "number" && Number.isFinite(rawSpeed)
        ? rawSpeed
        : undefined;
    const result = await audioConfig.synthesize({
      model: input.model,
      text: input.prompt,
      voice,
      speed,
    });
    return {
      bytes: result.audio,
      contentType: "audio/wav",
      durationMs: result.metadata.durationMs,
      transcript: input.prompt,
      requestId: input.taskId,
      provider: result.metadata.backendId,
      modelEndpoint: result.metadata.modelId,
    };
  };
}

export interface LocalAcpHarnessAuth {
  status: "configured" | "needs-auth" | "unknown";
  message: string;
  command?: string;
  methodId?: string;
  methodName?: string;
  methods?: Array<{
    id: string;
    name?: string;
    description?: string;
    type?: string;
    vars?: Array<{
      name: string;
      label?: string;
      secret?: boolean;
      optional?: boolean;
    }>;
    link?: string;
  }>;
}

export interface LocalAcpRuntimeAgent {
  id: string;
  label?: string;
  binary?: string;
  version?: string;
  config_options?: unknown[];
  auth?: LocalAcpHarnessAuth;
}

export interface LocalAcpRuntime {
  id: string;
  machine_id: string;
  hostname: string;
  os: string;
  agents: LocalAcpRuntimeAgent[];
  version: string;
  status: LocalAcpRuntimeStatus;
  last_heartbeat: number | null;
  created_at: number;
}

export interface LocalAcpHarness {
  id: string;
  label: string;
  binary: string;
  enabled: boolean;
  available: boolean;
  custom?: boolean;
  installed?: boolean;
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  installable?: boolean;
  installSource?: "registry" | "adapter";
  downloadUrl?: string;
  downloadKind?: "adapter";
  homepage?: string;
  auth?: LocalAcpHarnessAuth;
}

export interface LocalAcpCustomAgentServer {
  type: "custom";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type LocalAcpAgentServersConfig = Record<
  string,
  LocalAcpCustomAgentServer
>;

export interface LocalAcpResumeSession {
  id: string;
  title: string;
  cwd: string;
  modifiedAt: number;
}

export interface LocalAcpSessionEvent {
  seq: number;
  type: string;
  data: unknown;
  ts: number;
}

export interface LocalAcpSessionEventStore {
  appendEvent(
    sessionId: string,
    event: Omit<LocalAcpSessionEvent, "seq">,
  ): Promise<void> | void;
  listSessionEvents(
    sessionId: string,
  ): Promise<{ events: LocalAcpSessionEvent[] } | null>;
}

export interface LocalAcpSessionRuntimeStatus {
  session_id: string;
  harness_id: string;
  harness_label: string;
  running_version?: string;
  installed_version?: string;
  restart_required: boolean;
  busy: boolean;
  restart_pending: boolean;
}

export interface LocalAcpCreateSessionParams {
  sessionId?: string;
  runtimeId: string;
  agentTemplateId?: string;
  agentMemberId?: string;
  agentId?: string;
  configValues?: Record<string, string | boolean>;
  permissionMode?: string;
  projectId?: string;
  resumeAcpSessionId?: string;
  forkFromAcpSessionId?: string;
  onReady?: (event: {
    sessionId: string;
    acpSessionId?: string;
  }) => Promise<void> | void;
  onError?: (event: {
    sessionId: string;
    message: string;
  }) => Promise<void> | void;
}

export interface LocalAcpAttachSessionParams extends LocalAcpCreateSessionParams {
  sessionId: string;
}

export interface LocalAcpAdapter {
  warmup?(): Promise<void> | void;
  reconcileConfiguration?(): Promise<void> | void;
  disposeAll?(): Promise<void> | void;
  listRuntimes(opts?: {
    probe?: boolean | "auth" | "config" | "none";
    refresh?: boolean;
  }): Promise<{ runtimes: LocalAcpRuntime[] }>;
  updateRunPreferences?(update: {
    agent_id: string;
    config_values?: Record<string, string | boolean>;
    mode_id?: string;
  }): Promise<{
    preferences: {
      agent_id?: string;
      config_by_agent: Record<string, Record<string, string | boolean>>;
      mode_by_agent: Record<string, string>;
    };
  }>;
  createSession(
    params: LocalAcpCreateSessionParams,
  ): Promise<{ session_id: string }>;
  attachSession?(
    params: LocalAcpAttachSessionParams,
  ): Promise<{ session_id: string }>;
  listResumeSessions(
    runtimeId: string,
  ): Promise<{ sessions: LocalAcpResumeSession[] }>;
  listHarnesses?(opts?: {
    probe?: boolean | "auth" | "config" | "none";
    refresh?: boolean;
  }): Promise<{ harnesses: LocalAcpHarness[] }>;
  updateHarnesses?(
    enabledIds: string[],
  ): Promise<{ harnesses: LocalAcpHarness[] }>;
  listAgentServers?(): Promise<{ agent_servers: LocalAcpAgentServersConfig }>;
  updateAgentServers?(servers: LocalAcpAgentServersConfig): Promise<{
    agent_servers: LocalAcpAgentServersConfig;
    harnesses: LocalAcpHarness[];
  }>;
  installHarness?(id: string): Promise<{ harnesses: LocalAcpHarness[] }>;
  installHarnessAdapter?(id: string): Promise<{ harnesses: LocalAcpHarness[] }>;
  upgradeHarness?(id: string): Promise<{ harnesses: LocalAcpHarness[] }>;
  uninstallHarness?(id: string): Promise<{ harnesses: LocalAcpHarness[] }>;
  authenticateHarness?(
    id: string,
    options?: { methodId?: string; values?: Record<string, string> },
  ): Promise<{ harnesses: LocalAcpHarness[] }>;
  listSessionEvents?(
    sessionId: string,
  ): Promise<{ events: LocalAcpSessionEvent[] } | null>;
  setSessionEventStore?(store: LocalAcpSessionEventStore): void;
  getSessionRuntimeStatus?(
    sessionId: string,
  ): Promise<LocalAcpSessionRuntimeStatus | null>;
  restartSession?(
    sessionId: string,
    options: { mode: "now" | "after-turn" },
  ): Promise<{ session_id: string; status: "pending" | "restarted" }>;
  runTextTask?(params: {
    projectId: string;
    prompt: string;
    agentId?: string;
    modelId?: string;
    modelConfigId?: string;
    systemPrompt?: string;
    timeoutMs?: number;
  }): Promise<{ text: string; agentId?: string; sessionId: string }>;
}

function formatLocalAcpSessionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "No local ACP agent found on PATH") {
    return "No local agent found. Install or enable an agent in Settings > Agents, then retry.";
  }
  if (message === "No enabled local agent harness found") {
    return "No enabled local agent found. Enable an agent in Settings > Agents, or install one from Clash.";
  }
  if (
    message.startsWith("Local agent harness is not enabled or unavailable:")
  ) {
    const id = message
      .slice("Local agent harness is not enabled or unavailable:".length)
      .trim();
    return `Local agent ${id} is not enabled or available. Enable it in Settings > Agents, install it, or choose another agent.`;
  }
  return message || "Failed to create local session";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function preflightTextRevisionContentBlob(
  dataDir: string,
  revision: TextAppliedRevision,
  content: string,
): Promise<void> {
  if (textRevisionContentHash(content) !== revision.contentHash) {
    throw new Error("text revision contentHash does not match content");
  }
  const path = textRevisionContentBlobPath(dataDir, revision.contentHash);
  const existing = await readFile(path, "utf8").catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "ENOENT"
    )
      return null;
    throw error;
  });
  if (existing !== null && existing !== content) {
    throw new Error(
      "text revision content blob already exists with different content",
    );
  }
}

function localMutationEnvelope(operation: string, kind: string, id: string) {
  return {
    operation,
    entity: { kind, id },
  };
}

type LocalDb = LocalMetadataDb & {
  providerAccounts: LocalProviderAccountConfig[];
  providerOAuth: LocalProviderOAuthRecord[];
  modelCardConfigs: LocalUserModelCardConfig[];
};

const LOCAL_API_READ_RECEIPT_SECRET = randomBytes(32).toString("hex");
const PROJECT_ASSET_READ_RECEIPT_HEADER = "x-clash-read-receipt";
const PROJECT_PURGE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const ASSET_PURGE_DELAY_MS = PROJECT_PURGE_DELAY_MS;
const PERSONAL_GLOBAL_ASSET_LIBRARY_ID = "personal";

/**
 * Stable Host relation identity for a membership copied across Asset scopes.
 * The target keeps its own namespace; the hash contains only source entry
 * identities and never the underlying Resource identity.
 */
function scopedAssetRelationId(
  targetNamespace: "asset:global" | "global:project",
  sourceIdentity: readonly string[],
): string {
  const digest = createHash("sha256")
    .update("clash.asset-scope-relation.v1\0")
    .update(targetNamespace)
    .update("\0")
    .update(JSON.stringify(sourceIdentity))
    .digest("hex");
  return `${targetNamespace}:${digest}`;
}

function localApiProjectAssetReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`project-asset:${readToken}`)
    .digest("base64url");
}

function projectAssetReceiptReadToken(readToken: string): string {
  return agentReadReceiptToken({
    readToken,
    receipt: localApiProjectAssetReadReceipt(readToken),
  });
}

function verifyLocalApiProjectAssetReadReceipt(
  proof: AgentReadReceiptProof,
): boolean {
  return (
    proof.namespace === "project-asset" &&
    proof.receipt === localApiProjectAssetReadReceipt(proof.baseReadToken)
  );
}

const LOCAL_RUNTIME_ID = "desktop-local";
const DEFAULT_RUNTIME_SESSION_CONTEXT_ID = "clash";
const DEFAULT_RUNTIME_SESSION_TITLE = "New session";

const BUILTIN_AGENT_TEMPLATES: Array<{ id: string; label: string }> = [
  { id: "clash", label: "Clash" },
];

function agentTemplateTitle(agentTemplateId: string): string {
  return (
    BUILTIN_AGENT_TEMPLATES.find((template) => template.id === agentTemplateId)
      ?.label ?? agentTemplateId
  );
}

function initialRuntimeSessionTitle(agentTemplateId?: string): string {
  return agentTemplateId
    ? agentTemplateTitle(agentTemplateId)
    : DEFAULT_RUNTIME_SESSION_TITLE;
}

function truncateRuntimeSessionTitle(prompt: string): string {
  return prompt.length > 40 ? `${prompt.slice(0, 39)}…` : prompt;
}

function publicLocalSession(session: LocalSession) {
  return {
    id: session.id,
    threadId: session.id,
    projectId: session.projectId,
    title: session.title,
    type: session.type ?? "cloud",
    ...(session.runtimeId ? { runtimeId: session.runtimeId } : {}),
    ...(session.agentId ? { agentId: session.agentId } : {}),
    ...(session.agentTemplateId
      ? { agentTemplateId: session.agentTemplateId }
      : {}),
    ...(session.permissionMode
      ? { permissionMode: session.permissionMode }
      : {}),
    ...(session.acpSessionId ? { acpSessionId: session.acpSessionId } : {}),
    ...(session.status ? { status: session.status } : {}),
    ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    readToken: sessionReceiptReadToken(session),
  };
}

async function projectRecoveryPolicy(
  syncConfig: LocalSyncConfigStore,
  options: { localRestoreAllowed?: boolean } = {},
): Promise<ProjectRecoveryPolicy> {
  const sync = await syncConfig.getPublicConfig();
  return buildProjectRecoveryPolicy(
    buildProjectStatus(
      { projectId: "_project_recovery_policy", source: "explicit" },
      {
        clashRoot: "/clash",
        localApiDataDir: "/clash/local-api",
        replicationState: { mode: sync.mode, capabilities: sync.capabilities },
      },
    ),
    options,
  );
}

async function localSyncReadState(
  syncConfig: LocalSyncConfigStore,
): Promise<LocalSyncConfigReadState> {
  if (syncConfig.getReadState) return syncConfig.getReadState();
  return {
    ...(await syncConfig.getPublicConfig()),
    updated_at: "unversioned",
  };
}

function publicLocalSyncConfig(readState: LocalSyncConfigReadState) {
  return {
    mode: readState.mode,
    remote_loro: readState.remote_loro,
    capabilities: readState.capabilities,
    readToken: localConfigReceiptReadToken({
      id: "sync",
      config: localSyncConfigReadProjection(readState),
      updatedAt: readState.updated_at,
    }),
  };
}

function localSyncConfigReadProjection(readState: LocalSyncConfigReadState) {
  return {
    mode: readState.mode,
    remote_loro: readState.remote_loro,
    capabilities: readState.capabilities,
  };
}

async function localAudioReadState(
  audioConfig: LocalAudioConfigStore,
): Promise<LocalAudioConfigReadState> {
  if (audioConfig.getReadState) return audioConfig.getReadState();
  return {
    ...(await audioConfig.getPublicConfig()),
    updated_at: "unversioned",
  };
}

function publicLocalAudioConfig(readState: LocalAudioConfigReadState) {
  return {
    asr: readState.asr,
    tts: readState.tts,
    readToken: localAudioReceiptReadToken(readState),
  };
}

function localAudioReceiptReadToken(
  readState: LocalAudioConfigReadState,
): string {
  return localConfigReceiptReadToken({
    id: "audio",
    config: { asr: readState.asr, tts: readState.tts },
    updatedAt: readState.updated_at,
  });
}

async function updateRuntimeSession(
  db: ReturnType<typeof createDb>,
  sessionId: string,
  patch: Partial<Pick<LocalSession, "acpSessionId" | "status" | "title">>,
) {
  await db.update((state) => {
    const session = state.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session) return;
    Object.assign(session, patch, { updatedAt: nowIso() });
  });
}

async function precreateRuntimeSession(
  db: ReturnType<typeof createDb>,
  session: LocalSession,
): Promise<void> {
  await db.update((state) => {
    state.sessions = [
      session,
      ...state.sessions.filter((candidate) => candidate.id !== session.id),
    ];
  });
}

async function finalizeRuntimeSessionId(
  db: ReturnType<typeof createDb>,
  temporarySessionId: string,
  finalSessionId: string,
  patch?: Partial<Pick<LocalSession, "acpSessionId" | "status" | "title">>,
): Promise<void> {
  await db.update((state) => {
    const session = state.sessions.find(
      (candidate) => candidate.id === temporarySessionId,
    );
    if (!session) return;
    session.id = finalSessionId;
    Object.assign(session, patch ?? {}, { updatedAt: nowIso() });
    state.sessionMessages = state.sessionMessages.map((message) =>
      message.session_id === temporarySessionId
        ? { ...message, session_id: finalSessionId }
        : message,
    );
  });
  await db.renameSessionEvents(temporarySessionId, finalSessionId);
}

function contentTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".avif") return "image/avif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".m4v") return "video/mp4";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".flac") return "audio/flac";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".glb") return "model/gltf-binary";
  if (ext === ".gltf") return "model/gltf+json";
  if (ext === ".txt") return "text/plain";
  return "application/octet-stream";
}

type AssetByteRange = { start: number; end: number } | null | "unsatisfiable";

function parseAssetByteRange(
  rangeHeader: string | undefined,
  size: number,
): AssetByteRange {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) {
    return "unsatisfiable";
  }

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return "unsatisfiable";
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "unsatisfiable";
  }

  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}

async function serveImmutableFileProjection(options: {
  path: string;
  contentType: string;
  expectedByteLength?: number;
  rangeHeader?: string;
}): Promise<Response> {
  const fileInfo = await stat(options.path);
  if (
    !fileInfo.isFile() ||
    (options.expectedByteLength !== undefined &&
      fileInfo.size !== options.expectedByteLength)
  ) {
    throw new Error(
      "Immutable Asset projection no longer matches its Resource facts.",
    );
  }
  const range = parseAssetByteRange(options.rangeHeader, fileInfo.size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        "accept-ranges": "bytes",
        "content-range": `bytes */${fileInfo.size}`,
      },
    });
  }
  if (range) {
    const length = range.end - range.start + 1;
    const handle = await open(options.path, "r");
    try {
      const bytes = new Uint8Array(length);
      const { bytesRead } = await handle.read(bytes, 0, length, range.start);
      return new Response(bytes.subarray(0, bytesRead), {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-type": options.contentType,
          "content-length": String(bytesRead),
          "content-range": `bytes ${range.start}-${range.start + bytesRead - 1}/${fileInfo.size}`,
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      });
    } finally {
      await handle.close();
    }
  }
  const bytes = await readFile(options.path);
  return new Response(bytes, {
    headers: {
      "accept-ranges": "bytes",
      "content-type": options.contentType,
      "content-length": String(bytes.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function immutableMarketplaceActionErrorResponse(
  c: Context,
  error: unknown,
): Response {
  if (
    error instanceof Error &&
    "status" in error &&
    error.status === 409 &&
    "code" in error &&
    error.code === "BUILTIN_PLUGIN_IMMUTABLE"
  ) {
    return c.json(
      { error: error.message, code: "BUILTIN_PLUGIN_IMMUTABLE" },
      409,
    );
  }
  throw error;
}

function isoToEpochSeconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function createDb(dataDir: string) {
  const metadataStore = createLocalMetadataStore(dataDir);
  const providerStore = createLocalProviderStore(dataDir);
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<LocalDb> {
    await writeQueue.catch(() => undefined);
    const [metadata, providerAccounts, providerOAuth, modelCardConfigs] =
      await Promise.all([
        metadataStore.load(),
        providerStore.loadProviderAccounts(),
        providerStore.loadProviderOAuth(),
        providerStore.loadModelCardConfigs(),
      ]);
    return {
      ...metadata,
      providerAccounts,
      providerOAuth,
      modelCardConfigs,
    };
  }

  async function update<T>(
    mutate: (db: LocalDb) => T | Promise<T>,
  ): Promise<T> {
    const task = writeQueue
      .catch(() => undefined)
      .then(async () => {
        const [metadata, providerAccounts, providerOAuth, modelCardConfigs] =
          await Promise.all([
            metadataStore.load(),
            providerStore.loadProviderAccounts(),
            providerStore.loadProviderOAuth(),
            providerStore.loadModelCardConfigs(),
          ]);
        const normalized: LocalDb = {
          ...metadata,
          providerAccounts,
          providerOAuth,
          modelCardConfigs,
        };
        const result = await mutate(normalized);
        await metadataStore.save({
          projects: normalized.projects,
          assets: normalized.assets,
          assetRefs: normalized.assetRefs,
          libraryAssetRefs: normalized.libraryAssetRefs,
          assetNodeRefs: normalized.assetNodeRefs,
          sessions: normalized.sessions,
          agentMembers: normalized.agentMembers,
          sessionMessages: normalized.sessionMessages,
        });
        await providerStore.saveProviderAccounts(normalized.providerAccounts);
        await providerStore.saveProviderOAuth(normalized.providerOAuth);
        await providerStore.saveModelCardConfigs(normalized.modelCardConfigs);
        return result;
      });
    writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function appendMutationAudit(
    record: LocalMutationAuditRecord,
  ): Promise<void> {
    const task = writeQueue
      .catch(() => undefined)
      .then(() => metadataStore.appendMutationAudit(record));
    writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function listMutationAudit(
    filter: LocalMutationAuditFilter = {},
  ): Promise<LocalMutationAuditRecord[]> {
    await writeQueue.catch(() => undefined);
    return metadataStore.listMutationAudit(filter);
  }

  async function upsertTextRevision(
    revision: TextAppliedRevision,
  ): Promise<TextAppliedRevision> {
    const task = writeQueue
      .catch(() => undefined)
      .then(() => metadataStore.upsertTextRevision(revision));
    writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function listTextRevisions(
    filter: LocalTextRevisionFilter,
  ): Promise<TextAppliedRevision[]> {
    await writeQueue.catch(() => undefined);
    return metadataStore.listTextRevisions(filter);
  }

  async function getTextRevision(
    projectId: string,
    revisionId: string,
  ): Promise<TextAppliedRevision | null> {
    await writeQueue.catch(() => undefined);
    return metadataStore.getTextRevision(projectId, revisionId);
  }

  async function upsertMetadataAttachmentIndex(
    record: Parameters<typeof metadataStore.upsertMetadataAttachmentIndex>[0],
  ): Promise<void> {
    const task = writeQueue
      .catch(() => undefined)
      .then(() => metadataStore.upsertMetadataAttachmentIndex(record));
    writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function listMetadataAttachmentIndex(
    filter: Parameters<typeof metadataStore.listMetadataAttachmentIndex>[0],
  ) {
    await writeQueue.catch(() => undefined);
    return metadataStore.listMetadataAttachmentIndex(filter);
  }

  async function listProviderUsageEvents(userId: string, limit?: number) {
    await writeQueue.catch(() => undefined);
    return providerStore.listProviderUsageEvents(userId, limit);
  }

  async function appendSessionEvent(
    sessionId: string,
    event: Omit<LocalAcpSessionEvent, "seq">,
  ): Promise<void> {
    const task = writeQueue
      .catch(() => undefined)
      .then(() => metadataStore.appendSessionEvent(sessionId, event));
    writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function listSessionEvents(
    sessionId: string,
  ): Promise<LocalAcpSessionEvent[]> {
    await writeQueue.catch(() => undefined);
    return metadataStore.listSessionEvents(sessionId);
  }

  async function renameSessionEvents(
    previousSessionId: string,
    nextSessionId: string,
  ): Promise<void> {
    const task = writeQueue
      .catch(() => undefined)
      .then(() =>
        metadataStore.renameSessionEvents(previousSessionId, nextSessionId),
      );
    writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function deleteSessionEvents(sessionId: string): Promise<void> {
    const task = writeQueue
      .catch(() => undefined)
      .then(() => metadataStore.deleteSessionEvents(sessionId));
    writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function getProjectCloudAdmission(
    projectId: string,
    localReplicaId: string,
  ) {
    await writeQueue.catch(() => undefined);
    return metadataStore.getProjectCloudAdmission(projectId, localReplicaId);
  }

  async function getLatestProjectCloudAdmission(projectId: string) {
    await writeQueue.catch(() => undefined);
    return metadataStore.getLatestProjectCloudAdmission(projectId);
  }

  async function upsertProjectCloudAdmission(
    admission: Parameters<
      typeof metadataStore.upsertProjectCloudAdmission
    >[0],
  ): Promise<void> {
    const task = writeQueue
      .catch(() => undefined)
      .then(() => metadataStore.upsertProjectCloudAdmission(admission));
    writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  return {
    load,
    update,
    appendMutationAudit,
    listMutationAudit,
    upsertTextRevision,
    listTextRevisions,
    getTextRevision,
    upsertMetadataAttachmentIndex,
    listMetadataAttachmentIndex,
    listProviderUsageEvents,
    appendSessionEvent,
    listSessionEvents,
    renameSessionEvents,
    deleteSessionEvents,
    getProjectCloudAdmission,
    getLatestProjectCloudAdmission,
    upsertProjectCloudAdmission,
  };
}

function createLocalSessionEventStore(
  db: ReturnType<typeof createDb>,
): LocalAcpSessionEventStore {
  return {
    async appendEvent(sessionId, event) {
      await db.appendSessionEvent(sessionId, event);
      await db.update((state) => {
        const session = state.sessions.find(
          (candidate) => candidate.id === sessionId,
        );
        if (!session) return;
        const data =
          event.data &&
          typeof event.data === "object" &&
          !Array.isArray(event.data)
            ? (event.data as Record<string, unknown>)
            : {};
        if (event.type === "user_prompt" && typeof data.text === "string") {
          const text = visibleUserPromptText(data.text);
          if (
            text &&
            (!session.title ||
              session.title === DEFAULT_RUNTIME_SESSION_TITLE ||
              (!!session.agentTemplateId &&
                session.title === agentTemplateTitle(session.agentTemplateId)))
          ) {
            session.title = truncateRuntimeSessionTitle(text);
          }
        }
        if (event.type === "turn_failed") session.status = "error";
        session.updatedAt = nowIso();
      });
    },
    async listSessionEvents(sessionId) {
      const [events, state] = await Promise.all([
        db.listSessionEvents(sessionId),
        db.load(),
      ]);
      if (
        events.length === 0 &&
        !state.sessions.some((session) => session.id === sessionId)
      ) {
        return null;
      }
      return {
        events: events.map((event) => ({
          ...event,
          data: structuredClone(event.data),
        })),
      };
    },
  };
}

function sanitizeMutationForAudit(
  mutation: HostMutationRecord,
): Record<string, unknown> {
  const {
    expectedReadToken: _expectedReadToken,
    beforeReadToken: _beforeReadToken,
    afterReadToken: _afterReadToken,
    expectedHash: _expectedHash,
    beforeHash: _beforeHash,
    afterHash: _afterHash,
    ...safeMutation
  } = mutation;
  return safeMutation as Record<string, unknown>;
}

function mutationAuditRecord(options: {
  mutation: HostMutationRecord;
  actorClientType?: string;
  reason: string;
}): LocalMutationAuditRecord {
  return {
    id: randomUUID(),
    createdAt: Date.now(),
    operation: options.mutation.operation,
    entity: options.mutation.entity,
    actorClientType: options.actorClientType ?? null,
    accepted: options.mutation.accepted,
    reason: options.reason,
    resultEntityId: options.mutation.resultEntityId ?? null,
    error: options.mutation.error ?? null,
    mutation: sanitizeMutationForAudit(options.mutation),
  };
}

function optionalBodyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isSafeProjectRelativePath(value: string): boolean {
  if (
    !value ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\")
  )
    return false;
  const parts = value.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== "..",
  );
}

function parseTextRevisionForIndex(
  value: unknown,
): { ok: true; revision: TextAppliedRevision } | { ok: false; error: string } {
  const parsed = TextAppliedRevisionSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: "Invalid text revision" };
  const revision = parsed.data;
  if (
    !/^[a-f0-9]{16}$/.test(revision.contentHash) ||
    !/^[a-f0-9]{16}$/.test(revision.sourceFileHash)
  ) {
    return {
      ok: false,
      error: "Text revision hashes must be sha256-64 hex strings",
    };
  }
  if (revision.sourceFileHash !== revision.contentHash) {
    return {
      ok: false,
      error: "Text revision source file hash must match content hash",
    };
  }
  if (!isSafeProjectRelativePath(revision.sourceFilePath)) {
    return {
      ok: false,
      error: "Text revision source file path must be project-relative",
    };
  }
  return { ok: true, revision };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
        .map((item) => item.trim()),
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(data: unknown, status = 200): Response {
  const body = JSON.stringify(data).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function localProjectAssetErrorResponse(error: unknown): Response {
  if (error instanceof AssetSdkContractError) {
    const status =
      error.code === "PROJECT_ASSET_NOT_FOUND"
        ? 404
        : error.code === "INVALID_PROJECT_ASSET"
          ? 400
          : error.code === "RESOURCE_NOT_READY" ||
              error.code === "RESOURCE_UNAVAILABLE"
            ? 503
            : error.code === "ASSET_IN_USE"
              ? 409
              : error.code === "ACTION_ASSET_BINDING_AUTHORITY_REQUIRED"
                ? 409
                : error.code === "READ_REQUIRED" ||
                    error.code === "STALE_READ" ||
                    error.code === "INVALID_READ_PROOF"
                  ? 409
                  : 500;
    return json(
      {
        error: error.message,
        code: error.code,
        ...(error.projectAssetId
          ? { projectAssetId: error.projectAssetId }
          : {}),
        ...(error.references ? { references: error.references } : {}),
      },
      status,
    );
  }
  if (error instanceof LocalProjectAssetMigrationError) {
    const status =
      error.code === "PROJECT_ASSET_NOT_FOUND"
        ? 404
        : error.code === "RESOURCE_DIGEST_UNAVAILABLE"
          ? 503
          : 409;
    return json(
      {
        error:
          error.code === "PROJECT_ASSET_NOT_FOUND"
            ? "Project Asset not found"
            : error.message,
        code: error.code,
      },
      status,
    );
  }
  return json({ error: errorMessage(error) }, 500);
}

function localGlobalAssetErrorResponse(error: unknown): Response {
  if (error instanceof AssetSdkContractError) {
    const status =
      error.code === "GLOBAL_ASSET_NOT_FOUND"
        ? 404
        : error.code === "INVALID_GLOBAL_ASSET"
          ? 400
          : error.code === "RESOURCE_NOT_READY" ||
              error.code === "RESOURCE_UNAVAILABLE"
            ? 503
            : 500;
    return json({ error: error.message, code: error.code }, status);
  }
  if (error instanceof LocalGlobalAssetError) {
    const status =
      error.code === "GLOBAL_ASSET_NOT_FOUND"
        ? 404
        : error.code === "GLOBAL_ASSET_UNAVAILABLE"
          ? 409
          : 409;
    return json(
      {
        error:
          error.code === "GLOBAL_ASSET_NOT_FOUND"
            ? "Global Asset not found"
            : error.message,
        code: error.code,
      },
      status,
    );
  }
  return json({ error: errorMessage(error) }, 500);
}

function inferProjectAssetFileKind(file: File): AssetKind | undefined {
  const contentType = file.type.trim().toLowerCase();
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (
    contentType === "model/gltf-binary" ||
    contentType === "model/gltf+json"
  ) {
    return "model";
  }
  const extension = extname(file.name).toLowerCase();
  if (
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"].includes(
      extension,
    )
  ) {
    return "image";
  }
  if ([".mp4", ".webm", ".mov", ".m4v", ".mkv"].includes(extension)) {
    return "video";
  }
  if ([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"].includes(extension)) {
    return "audio";
  }
  if ([".glb", ".gltf"].includes(extension)) {
    return "model";
  }
  return undefined;
}

function validateProjectAssetImportFile(
  file: File,
  kind: AssetKind,
): string | undefined {
  if (!file.name.trim()) return "Project Asset file must have a name";
  if (file.name.length > 512) return "Project Asset file name is too long";
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return "Project Asset file must contain bytes";
  }
  const inferred = inferProjectAssetFileKind(file);
  if (!inferred) return "Project Asset file type is unsupported";
  if (inferred !== kind) {
    return `Project Asset kind ${kind} does not match the selected ${inferred} file`;
  }
  return undefined;
}

function requestOrigin(c: { req: { url: string } }): string {
  return new URL(c.req.url).origin;
}

function directorCaptureProjectAssetId(input: {
  stageId: string;
  sourceStageRevisionId: string;
  artifactId: string;
  sha256: string;
}): string {
  return `director-capture:${createHash("sha256")
    .update(
      JSON.stringify([
        input.stageId,
        input.sourceStageRevisionId,
        input.artifactId,
        input.sha256,
      ]),
    )
    .digest("hex")
    .slice(0, 32)}`;
}

function isAllowedLocalBrowserOrigin(origin: string): boolean {
  const normalized = origin.trim().replace(/\/$/, "");
  if (normalized === "clash://app") return true;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function isDeletedProject(project: LocalProject): boolean {
  return typeof project.deletedAt === "string" && project.deletedAt.length > 0;
}

function isActiveProject(project: LocalProject): boolean {
  return !isDeletedProject(project);
}

function activeProjects(state: LocalDb): LocalProject[] {
  return state.projects.filter(isActiveProject);
}

function findActiveProject(
  state: LocalDb,
  projectId: string,
  ownerId?: string,
): LocalProject | undefined {
  return state.projects.find(
    (candidate) =>
      candidate.id === projectId &&
      (!ownerId || candidate.ownerId === ownerId) &&
      isActiveProject(candidate),
  );
}

function isDeletedKnownProject(state: LocalDb, projectId: string): boolean {
  return state.projects.some(
    (candidate) => candidate.id === projectId && isDeletedProject(candidate),
  );
}

function deleteProjectFromState(
  state: LocalDb,
  projectId: string,
): LocalProject | null {
  const project = findActiveProject(state, projectId);
  if (!project) return null;
  const deletedAt = nowIso();
  project.deletedAt = deletedAt;
  project.updatedAt = deletedAt;
  return project;
}

function restoreProjectInState(
  state: LocalDb,
  projectId: string,
): LocalProject | null {
  const project = state.projects.find(
    (candidate) => candidate.id === projectId && isDeletedProject(candidate),
  );
  if (!project) return null;
  project.deletedAt = null;
  project.updatedAt = nowIso();
  return project;
}

function projectPurgeAfter(project: LocalProject): string {
  const deletedAtMs = Date.parse(project.deletedAt ?? "");
  const base = Number.isFinite(deletedAtMs) ? deletedAtMs : Date.now();
  return new Date(base + PROJECT_PURGE_DELAY_MS).toISOString();
}

function canPurgeProject(project: LocalProject, nowMs = Date.now()): boolean {
  return Date.parse(projectPurgeAfter(project)) <= nowMs;
}

function purgeProjectFromState(state: LocalDb, projectId: string) {
  const project = state.projects.find(
    (candidate) => candidate.id === projectId && isDeletedProject(candidate),
  );
  if (!project) return null;
  const sessionIds = new Set(
    state.sessions
      .filter((session) => session.projectId === projectId)
      .map((session) => session.id),
  );
  const counts = {
    projects: 1,
    projectPreviewAssets: project.assets.length,
    sessions: sessionIds.size,
    sessionMessages: state.sessionMessages.filter((message) =>
      sessionIds.has(message.session_id),
    ).length,
  };
  state.projects = state.projects.filter(
    (candidate) => candidate.id !== projectId,
  );
  state.sessions = state.sessions.filter(
    (session) => session.projectId !== projectId,
  );
  state.sessionMessages = state.sessionMessages.filter(
    (message) => !sessionIds.has(message.session_id),
  );
  // Legacy Asset rows are one-way migration/doctor input. Project purge must
  // not pretend that the ordinary metadata save path rewrites that read-only
  // source; authoritative Project Asset lifecycle is handled by Loro instead.
  return { project, counts };
}

interface V1ProjectCanvasThumbnail {
  url: string;
  revision: string;
  width: number;
  height: number;
}

function localProjectSyncMetadata(project: LocalProject): ProjectMetadata {
  // Hosted D1 project timestamps use epoch-second precision. Normalize the
  // local millisecond timestamps at this boundary so a successful mirror does
  // not turn every subsequent read into another PUT merely because the local
  // clock retained sub-second precision.
  const syncTimestamp = (value: string | null): string | null => {
    if (value === null) return null;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return value;
    return new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString();
  };
  return {
    projectId: project.id,
    name: project.name,
    description: project.description,
    createdAt: syncTimestamp(project.createdAt) ?? project.createdAt,
    updatedAt: syncTimestamp(project.updatedAt) ?? project.updatedAt,
    deletedAt: syncTimestamp(project.deletedAt ?? null),
  };
}

function toV1Project(
  project: LocalProject,
  assets: ResolvedAsset[],
  assetMode: "preview" | "all" = "preview",
  coverAssetId: string | null = null,
  canvasPreview: ProjectCanvasPreview | null = null,
  canvasThumbnail: V1ProjectCanvasThumbnail | null = null,
) {
  const projectedAssets =
    assetMode === "all"
      ? assets
      : assets
          .filter(
            (asset) =>
              asset.lifecycle.state === "active" &&
              (asset.kind === "image" || asset.kind === "video") &&
              Boolean(asset.thumbnailUrl ?? asset.url),
          )
          .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
          .slice(0, 4);
  return {
    id: project.id,
    ownerId: project.ownerId,
    name: project.name,
    description: project.description,
    coverAssetId,
    canvasPreview,
    canvasThumbnail,
    assets: assetMode === "preview" && canvasThumbnail ? [] : projectedAssets,
    assetCount: assets.length,
    created_at: isoToEpochSeconds(project.createdAt),
    updated_at: isoToEpochSeconds(project.updatedAt),
    ...(isDeletedProject(project) ? { deletedAt: project.deletedAt } : {}),
    readToken: projectReceiptReadToken(project),
  };
}

function localApiProjectReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`project:${readToken}`)
    .digest("base64url");
}

function projectReceiptReadToken(project: LocalProject): string {
  const readToken = projectReadToken(project);
  return agentReadReceiptToken({
    readToken,
    receipt: localApiProjectReadReceipt(readToken),
  });
}

function verifyLocalApiProjectReadReceipt(
  proof: AgentReadReceiptProof,
): boolean {
  return (
    proof.namespace === "project" &&
    proof.receipt === localApiProjectReadReceipt(proof.baseReadToken)
  );
}

function localApiSessionReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`session:${readToken}`)
    .digest("base64url");
}

function sessionReceiptReadToken(session: LocalSession): string {
  const readToken = sessionReadToken(session);
  return agentReadReceiptToken({
    readToken,
    receipt: localApiSessionReadReceipt(readToken),
  });
}

function verifyLocalApiSessionReadReceipt(
  proof: AgentReadReceiptProof,
): boolean {
  return (
    proof.namespace === "session" &&
    proof.receipt === localApiSessionReadReceipt(proof.baseReadToken)
  );
}

function localApiLocalConfigReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`local-config:${readToken}`)
    .digest("base64url");
}

function localConfigReceiptReadToken(config: {
  id: string;
  config: unknown;
  updatedAt: string;
}): string {
  const readToken = localConfigReadToken({
    id: config.id,
    config: config.config,
    updatedAt: config.updatedAt,
  });
  return agentReadReceiptToken({
    readToken,
    receipt: localApiLocalConfigReadReceipt(readToken),
  });
}

function verifyLocalApiLocalConfigReadReceipt(
  proof: AgentReadReceiptProof,
): boolean {
  return (
    proof.namespace === "local-config" &&
    proof.receipt === localApiLocalConfigReadReceipt(proof.baseReadToken)
  );
}

const LOCAL_RUNTIME_CONFIG_READ_VERSION = "local-runtime-config-v1";

type LocalHarnessesResponse = { harnesses: LocalAcpHarness[] };
type LocalAgentServersResponse = { agent_servers: LocalAcpAgentServersConfig };

function localHarnessReadProjection(result: LocalHarnessesResponse) {
  return {
    harnesses: result.harnesses
      .map((harness) => ({
        id: harness.id,
        label: harness.label,
        binary: harness.binary,
        enabled: harness.enabled === true,
        available: harness.available === true,
        ...(harness.custom === true ? { custom: true } : {}),
        ...(harness.installed === true ? { installed: true } : {}),
        ...(harness.installable === true ? { installable: true } : {}),
        ...(harness.updateAvailable === true ? { updateAvailable: true } : {}),
        ...(harness.installedVersion
          ? { installedVersion: harness.installedVersion }
          : {}),
        ...(harness.latestVersion
          ? { latestVersion: harness.latestVersion }
          : {}),
        ...(harness.installSource
          ? { installSource: harness.installSource }
          : {}),
        ...(harness.downloadUrl ? { downloadUrl: harness.downloadUrl } : {}),
        ...(harness.downloadKind ? { downloadKind: harness.downloadKind } : {}),
        ...(harness.homepage ? { homepage: harness.homepage } : {}),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function localHarnessesReceiptReadToken(
  result: LocalHarnessesResponse,
): string {
  return localConfigReceiptReadToken({
    id: "local-harnesses",
    config: localHarnessReadProjection(result),
    updatedAt: LOCAL_RUNTIME_CONFIG_READ_VERSION,
  });
}

function localAgentServersReceiptReadToken(
  result: LocalAgentServersResponse,
): string {
  return localConfigReceiptReadToken({
    id: "local-agent-servers",
    config: { agent_servers: result.agent_servers },
    updatedAt: LOCAL_RUNTIME_CONFIG_READ_VERSION,
  });
}

function localApiProviderAccountReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`provider-account:${readToken}`)
    .digest("base64url");
}

function providerAccountReceiptReadToken(
  account: ProviderAccountAvailability,
): string {
  const readToken = providerAccountReadToken(account);
  return agentReadReceiptToken({
    readToken,
    receipt: localApiProviderAccountReadReceipt(readToken),
  });
}

function verifyLocalApiProviderAccountReadReceipt(
  proof: AgentReadReceiptProof,
): boolean {
  return (
    proof.namespace === "provider-account" &&
    proof.receipt === localApiProviderAccountReadReceipt(proof.baseReadToken)
  );
}

function localApiProviderAccountsReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`provider-accounts:${readToken}`)
    .digest("base64url");
}

function providerAccountsReceiptReadToken(
  accounts: ProviderAccountAvailability[],
): string {
  const readToken = providerAccountsReadToken(accounts);
  return agentReadReceiptToken({
    readToken,
    receipt: localApiProviderAccountsReadReceipt(readToken),
  });
}

function verifyLocalApiProviderAccountsReadReceipt(
  proof: AgentReadReceiptProof,
): boolean {
  return (
    proof.namespace === "provider-accounts" &&
    proof.receipt === localApiProviderAccountsReadReceipt(proof.baseReadToken)
  );
}

function providerOAuthBaseReadToken(record: LocalProviderOAuthRecord): string {
  return providerOAuthReadToken({
    ...publicProviderOAuth(record),
    updatedAt: record.updatedAt,
  });
}

function localApiProviderOAuthReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`provider-oauth:${readToken}`)
    .digest("base64url");
}

function providerOAuthReceiptReadToken(
  record: LocalProviderOAuthRecord,
): string {
  const readToken = providerOAuthBaseReadToken(record);
  return agentReadReceiptToken({
    readToken,
    receipt: localApiProviderOAuthReadReceipt(readToken),
  });
}

function verifyLocalApiProviderOAuthReadReceipt(
  proof: AgentReadReceiptProof,
): boolean {
  return (
    proof.namespace === "provider-oauth" &&
    proof.receipt === localApiProviderOAuthReadReceipt(proof.baseReadToken)
  );
}

function publicProviderOAuthWithReadReceipt(record: LocalProviderOAuthRecord) {
  return {
    ...publicProviderOAuth(record),
    readToken: providerOAuthReceiptReadToken(record),
  };
}

function publicProviderAccountsWithReadReceipts(
  accounts: ProviderAccountAvailability[],
): ProviderAccountAvailability[] {
  return accounts.map((account) => ({
    ...account,
    readToken: providerAccountReceiptReadToken(account),
  }));
}

function publicModelProvidersResponse(
  accounts: ProviderAccountAvailability[],
): {
  providers: ProviderAccountAvailability[];
  readToken: string;
} {
  return {
    providers: publicProviderAccountsWithReadReceipts(accounts),
    readToken: providerAccountsReceiptReadToken(accounts),
  };
}

function localApiCanvasReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`canvas-node:${readToken}`)
    .digest("base64url");
}

function localApiCanvasEdgeReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`canvas-edge:${readToken}`)
    .digest("base64url");
}

function localApiCanvasEdgesReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`canvas-edges:${readToken}`)
    .digest("base64url");
}

function localApiCanvasBatchDeleteReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`canvas-batch-delete:${readToken}`)
    .digest("base64url");
}

function canvasNodeReceiptReadToken(
  node: Parameters<typeof canvasNodeReadToken>[0],
): string {
  const readToken = canvasNodeReadToken(node);
  return agentReadReceiptToken({
    readToken,
    receipt: localApiCanvasReadReceipt(readToken),
  });
}

function verifyLocalApiCanvasReadReceipt(
  proof: AgentReadReceiptProof,
): boolean {
  return (
    proof.namespace === "node" &&
    proof.receipt === localApiCanvasReadReceipt(proof.baseReadToken)
  );
}

function canvasEdgeReceiptReadToken(
  edge: Parameters<typeof canvasEdgeReadToken>[0],
): string {
  const readToken = canvasEdgeReadToken(edge);
  return agentReadReceiptToken({
    readToken,
    receipt: localApiCanvasEdgeReadReceipt(readToken),
  });
}

function canvasEdgesReceiptReadToken(
  edges: Iterable<CanvasReadProofEdgeLike>,
): string {
  const readToken = canvasEdgesReadToken(edges);
  return agentReadReceiptToken({
    readToken,
    receipt: localApiCanvasEdgesReadReceipt(readToken),
  });
}

function verifyLocalApiCanvasEdgeReadReceipt(
  proof: AgentReadReceiptProof,
): boolean {
  return (
    proof.namespace === "edge" &&
    proof.receipt === localApiCanvasEdgeReadReceipt(proof.baseReadToken)
  );
}

function verifyLocalApiCanvasEdgesReadReceipt(
  proof: AgentReadReceiptProof,
): boolean {
  return (
    proof.namespace === "edges" &&
    proof.receipt === localApiCanvasEdgesReadReceipt(proof.baseReadToken)
  );
}

function canvasBatchDeleteReceiptReadToken(
  options: Parameters<typeof canvasBatchDeleteReadToken>[0],
): string {
  const readToken = canvasBatchDeleteReadToken(options);
  return agentReadReceiptToken({
    readToken,
    receipt: localApiCanvasBatchDeleteReadReceipt(readToken),
  });
}

function verifyLocalApiCanvasBatchDeleteReadReceipt(
  proof: AgentReadReceiptProof,
): boolean {
  return (
    proof.namespace === "canvas-batch-delete" &&
    proof.receipt === localApiCanvasBatchDeleteReadReceipt(proof.baseReadToken)
  );
}

function listCanvasReadProofEdges(doc: LoroDoc): CanvasReadProofEdgeLike[] {
  return listNodeOwnedEdges(doc).map(
    (edge) => ({ ...edge }) as CanvasReadProofEdgeLike,
  );
}

function listCanvasEdgesWithReadReceipts(doc: LoroDoc): {
  edges: Array<CanvasReadProofEdgeLike & { readToken: string }>;
  readToken: string;
} {
  const edges = listCanvasReadProofEdges(doc);
  return {
    edges: edges.map((edge) => ({
      ...edge,
      readToken: canvasEdgeReceiptReadToken(edge),
    })),
    readToken: canvasEdgesReceiptReadToken(edges),
  };
}

function readCanvasEdge(
  doc: LoroDoc,
  edgeId: string,
): CanvasReadProofEdgeLike | null {
  return (
    listCanvasReadProofEdges(doc).find((edge) => edge.id === edgeId) ?? null
  );
}

function edgeCanvas(doc: LoroDoc, edge: CanvasReadProofEdgeLike): Canvas {
  if (typeof edge.target !== "string")
    throw new Error("Edge target is required");
  const rawTarget = doc.getMap("nodes").get(edge.target);
  if (!isRecord(rawTarget))
    throw new Error(`Target node not found: ${edge.target}`);
  const canvasId =
    typeof rawTarget.canvasId === "string" ? rawTarget.canvasId : "main";
  return new Canvas(doc, () => {}, canvasId);
}

function canvasEdgeResponse(
  edge: CanvasReadProofEdgeLike,
): CanvasReadProofEdgeLike & { readToken: string } {
  return { ...edge, readToken: canvasEdgeReceiptReadToken(edge) };
}

function normalizeCanvasBatchDeleteNodeIds(nodeIds: string[]): string[] {
  return [...new Set(nodeIds.map((nodeId) => nodeId.trim()).filter(Boolean))];
}

function readCanvasBatchDeletePlan(
  doc: LoroDoc,
  nodeIds: string[],
):
  | {
      ok: true;
      nodeIds: string[];
      nodes: NonNullable<ReturnType<Canvas["readNode"]>>[];
      edges: CanvasReadProofEdgeLike[];
      readToken: string;
    }
  | { ok: false; error: string; status: 400 | 404 } {
  const uniqueNodeIds = normalizeCanvasBatchDeleteNodeIds(nodeIds);
  if (uniqueNodeIds.length === 0)
    return {
      ok: false,
      error: "delete batch requires at least one node id",
      status: 400,
    };
  const canvas = new Canvas(doc, () => {});
  const nodes: NonNullable<ReturnType<Canvas["readNode"]>>[] = [];
  const missing: string[] = [];
  for (const nodeId of uniqueNodeIds) {
    const node = canvas.readNode(nodeId);
    if (!node) missing.push(nodeId);
    else nodes.push(node);
  }
  if (missing.length > 0)
    return {
      ok: false,
      error: `Node(s) not found: ${missing.join(", ")}`,
      status: 404,
    };
  const edges = listCanvasReadProofEdges(doc);
  return {
    ok: true,
    nodeIds: uniqueNodeIds,
    nodes,
    edges,
    readToken: canvasBatchDeleteReceiptReadToken({ nodes, edges }),
  };
}

function readCanvasGuardrailNodes(doc: LoroDoc): CanvasUpdateNodeWithIdLike[] {
  const nodesMap = doc.getMap("nodes");
  const nodes: CanvasUpdateNodeWithIdLike[] = [];
  for (const [id, rawNode] of nodesMap.entries()) {
    if (!isRecord(rawNode)) continue;
    nodes.push({
      id,
      type: typeof rawNode.type === "string" ? rawNode.type : undefined,
      data: isRecord(rawNode.data) ? rawNode.data : undefined,
    });
  }
  return nodes;
}

function canvasGuardrailEdges(
  edges: Iterable<CanvasReadProofEdgeLike>,
): CanvasUpdateEdgeLike[] {
  return [...edges]
    .map((edge) => ({
      source: typeof edge.source === "string" ? edge.source : "",
      target: typeof edge.target === "string" ? edge.target : "",
    }))
    .filter((edge) => edge.source.length > 0 && edge.target.length > 0);
}

function canvasEdgePatchFromBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (
      key === "actorClientType" ||
      key === "ifMatch" ||
      key === "id" ||
      key === "readToken"
    ) {
      continue;
    }
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}

function canvasNodeDataPatchFromBody(
  body: Record<string, unknown>,
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  const patch: Record<string, unknown> = {};
  const nestedData = body.data;
  if (nestedData !== undefined) {
    if (!isRecord(nestedData))
      return { ok: false, error: "Invalid node data patch" };
    for (const [key, value] of Object.entries(nestedData)) {
      if (value !== undefined) patch[key] = value;
    }
  }

  for (const [key, value] of Object.entries(body)) {
    if (
      key === "actorClientType" ||
      key === "ifMatch" ||
      key === "id" ||
      key === "nodeId" ||
      key === "projectId" ||
      key === "readToken" ||
      key === "data"
    ) {
      continue;
    }
    if (value !== undefined) patch[key] = value;
  }

  return { ok: true, patch };
}

type ProjectWritePreconditions = {
  actorClientType?: string;
  expectedReadToken?: string;
  observedVersion?: string;
};

type ProjectWriteBody = {
  actorClientType?: unknown;
  ifMatch?: unknown;
  observedVersion?: unknown;
};

type SnapshotWriteRouteResult = {
  status: 200 | 400 | 404 | 409;
  body: Record<string, unknown>;
  assetRef?: { assetId: string; projectId: string; importedAt: number };
};

function requestProjectWritePreconditions(
  c: { req: { header(name: string): string | undefined } },
  body: ProjectWriteBody = {},
): ProjectWritePreconditions {
  const observedVersion =
    normalizeString(body.observedVersion) ??
    normalizeString(c.req.header("x-clash-observed-version"));
  return {
    actorClientType:
      normalizeString(body.actorClientType) ??
      normalizeString(c.req.header("x-clash-client-type")) ??
      normalizeString(c.req.header("x-clash-actor-client-type")),
    expectedReadToken:
      normalizeString(body.ifMatch) ??
      normalizeIfMatchHeader(c.req.header("x-clash-if-match")) ??
      normalizeIfMatchHeader(c.req.header("if-match")),
    ...(observedVersion ? { observedVersion } : {}),
  };
}

function validateAgentReadProof(
  options: Parameters<typeof validateLegacyAgentReadProof>[0] & {
    observedVersion?: string;
  },
) {
  if (options.observedVersion !== undefined) {
    return validateAgentObservation({
      actorClientType: options.actorClientType,
      operation: options.operation,
      observedVersion: options.observedVersion,
      currentVersion: options.currentReadToken,
    });
  }
  return validateLegacyAgentReadProof(options);
}

function validateProjectReadMutation(options: {
  project: LocalProject;
  operation: "update" | "delete" | "restore" | "purge";
  preconditions: ProjectWritePreconditions;
}) {
  const currentReadToken = projectReadToken(options.project);
  const readCommand =
    options.operation === "restore" || options.operation === "purge"
      ? `clash project get --id ${options.project.id} --include-deleted --json`
      : `clash project get --id ${options.project.id} --json`;
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: `project ${options.operation}`,
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiProjectReadReceipt,
    readCommandHint: `Run \`${readCommand}\` first, then retry.`,
  });
  return validateHostMutationEnvelope({
    operation: `project_${options.operation}`,
    entity: { kind: "project", id: options.project.id },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function validateSessionReadMutation(options: {
  session: LocalSession;
  operation: "delete" | "attach" | "archive" | "restore" | "rename";
  mutationOperation?: string;
  readOperation?: string;
  preconditions: ProjectWritePreconditions;
}) {
  const currentReadToken = sessionReadToken(options.session);
  const readOperation = options.readOperation ?? `session ${options.operation}`;
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: readOperation,
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiSessionReadReceipt,
    readCommandHint: `Read /api/v1/sessions?projectId=${encodeURIComponent(options.session.projectId)} first, then retry.`,
  });
  return validateHostMutationEnvelope({
    operation: options.mutationOperation ?? `session_${options.operation}`,
    entity: { kind: "session", id: options.session.id },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function validateLocalSyncConfigMutation(options: {
  readState: LocalSyncConfigReadState;
  preconditions: ProjectWritePreconditions;
}) {
  const currentReadToken = localConfigReadToken({
    id: "sync",
    config: localSyncConfigReadProjection(options.readState),
    updatedAt: options.readState.updated_at,
  });
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: "local sync config update",
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiLocalConfigReadReceipt,
    readCommandHint: "Read /api/v1/local/sync first, then retry.",
  });
  return validateHostMutationEnvelope({
    operation: "local_sync_config_update",
    entity: { kind: "local-config", id: "sync" },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function validateLocalAudioConfigMutation(options: {
  readState: LocalAudioConfigReadState;
  preconditions: ProjectWritePreconditions;
}) {
  const currentReadToken = localConfigReadToken({
    id: "audio",
    config: {
      asr: options.readState.asr,
      tts: options.readState.tts,
    },
    updatedAt: options.readState.updated_at,
  });
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: "local audio config update",
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiLocalConfigReadReceipt,
    readCommandHint: "Read /api/v1/local/audio first, then retry.",
  });
  return validateHostMutationEnvelope({
    operation: "local_audio_config_update",
    entity: { kind: "local-config", id: "audio" },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function validateLocalAudioInstallMutation(options: {
  readState: LocalAudioConfigReadState;
  preconditions: ProjectWritePreconditions;
}) {
  const currentReadToken = localConfigReadToken({
    id: "audio",
    config: {
      asr: options.readState.asr,
      tts: options.readState.tts,
    },
    updatedAt: options.readState.updated_at,
  });
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: "local audio model install",
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiLocalConfigReadReceipt,
    readCommandHint: "Read /api/v1/local/audio first, then retry.",
  });
  return validateHostMutationEnvelope({
    operation: "local_audio_model_install",
    entity: { kind: "local-config", id: "audio" },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function validateLocalAudioRemoveMutation(options: {
  readState: LocalAudioConfigReadState;
  preconditions: ProjectWritePreconditions;
}) {
  const currentReadToken = localConfigReadToken({
    id: "audio",
    config: {
      asr: options.readState.asr,
      tts: options.readState.tts,
    },
    updatedAt: options.readState.updated_at,
  });
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: "local audio model remove",
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiLocalConfigReadReceipt,
    readCommandHint: "Read /api/v1/local/audio first, then retry.",
  });
  return validateHostMutationEnvelope({
    operation: "local_audio_model_remove",
    entity: { kind: "local-config", id: "audio" },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function validateLocalHarnessesConfigMutation(options: {
  result: LocalHarnessesResponse;
  preconditions: ProjectWritePreconditions;
}) {
  const currentReadToken = localConfigReadToken({
    id: "local-harnesses",
    config: localHarnessReadProjection(options.result),
    updatedAt: LOCAL_RUNTIME_CONFIG_READ_VERSION,
  });
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: "local harness enablement update",
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiLocalConfigReadReceipt,
    readCommandHint: "Read /api/v1/local/harnesses first, then retry.",
  });
  return validateHostMutationEnvelope({
    operation: "local_harness_enablement_update",
    entity: { kind: "local-harness-config", id: "enabled" },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function validateLocalHarnessActionMutation(options: {
  result: LocalHarnessesResponse;
  preconditions: ProjectWritePreconditions;
  operation: string;
  harnessId: string;
  action: string;
}) {
  const currentReadToken = localConfigReadToken({
    id: "local-harnesses",
    config: localHarnessReadProjection(options.result),
    updatedAt: LOCAL_RUNTIME_CONFIG_READ_VERSION,
  });
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: `local harness ${options.action}`,
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiLocalConfigReadReceipt,
    readCommandHint: "Read /api/v1/local/harnesses first, then retry.",
  });
  return validateHostMutationEnvelope({
    operation: options.operation,
    entity: { kind: "local-harness", id: options.harnessId },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function validateLocalAgentServersConfigMutation(options: {
  result: LocalAgentServersResponse;
  preconditions: ProjectWritePreconditions;
}) {
  const currentReadToken = localConfigReadToken({
    id: "local-agent-servers",
    config: { agent_servers: options.result.agent_servers },
    updatedAt: LOCAL_RUNTIME_CONFIG_READ_VERSION,
  });
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: "local agent servers update",
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiLocalConfigReadReceipt,
    readCommandHint: "Read /api/v1/local/agent-servers first, then retry.",
  });
  return validateHostMutationEnvelope({
    operation: "local_agent_servers_update",
    entity: { kind: "local-harness-config", id: "agent-servers" },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function validateProviderAccountsReadMutation(options: {
  userId: string;
  accounts: ProviderAccountAvailability[];
  preconditions: ProjectWritePreconditions;
}) {
  const currentReadToken = providerAccountsReadToken(options.accounts);
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: "provider accounts update",
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiProviderAccountsReadReceipt,
    readCommandHint: "Read /api/v1/model-providers first, then retry.",
  });
  return validateHostMutationEnvelope({
    operation: "provider_accounts_update",
    entity: { kind: "provider-accounts", id: options.userId },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function validateProviderAccountReadMutation(options: {
  account: ProviderAccountAvailability;
  operation: "delete";
  preconditions: ProjectWritePreconditions;
}) {
  const accountId =
    options.account.id ??
    providerAccountKey({
      providerId: options.account.providerId,
      upstreamId: options.account.upstreamId,
      region: options.account.region,
    });
  const currentReadToken = providerAccountReadToken(options.account);
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: `provider account ${options.operation}`,
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiProviderAccountReadReceipt,
    readCommandHint: "Read /api/v1/model-providers first, then retry.",
  });
  return validateHostMutationEnvelope({
    operation: `provider_account_${options.operation}`,
    entity: { kind: "provider-account", id: accountId },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function validateProviderOAuthReadMutation(options: {
  record: LocalProviderOAuthRecord;
  operation: "start" | "complete" | "import" | "delete";
  preconditions: ProjectWritePreconditions;
}) {
  const entityId = providerOAuthEntityId(
    options.record.providerId,
    options.record.accountId,
  );
  const currentReadToken = providerOAuthBaseReadToken(options.record);
  const guard = validateAgentReadProof({
    actorClientType: options.preconditions.actorClientType,
    operation: `provider OAuth ${options.operation}`,
    currentReadToken,
    observedVersion: options.preconditions.observedVersion,
    expectedReadToken: options.preconditions.expectedReadToken,
    requireReceipt: true,
    readReceiptVerifier: verifyLocalApiProviderOAuthReadReceipt,
    readCommandHint: "Read /api/v1/provider-oauth first, then retry.",
  });
  return validateHostMutationEnvelope({
    operation: `provider_oauth_${options.operation}`,
    entity: { kind: "provider-oauth", id: entityId },
    expectedReadToken: options.preconditions.expectedReadToken,
    currentReadToken,
    guard,
  });
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeIfMatchHeader(value: unknown): string | undefined {
  const trimmed = normalizeString(value);
  if (!trimmed) return undefined;
  const withoutWeakPrefix = trimmed.startsWith("W/")
    ? trimmed.slice(2).trim()
    : trimmed;
  if (withoutWeakPrefix.startsWith('"') && withoutWeakPrefix.endsWith('"')) {
    return withoutWeakPrefix.slice(1, -1);
  }
  return withoutWeakPrefix;
}

function parseProviderOAuthId(value: unknown): ProviderOAuthId | null {
  const parsed = ProviderOAuthIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Host-normalized browser flow frozen into a pending OAuth record.
 *
 * Plugins declare acquisition through `auth.methods[].flow`; the Host resolves that declaration
 * into this private shape so completion uses the same callback and scoped plugin-store destination
 * even if the installed package changes while the browser is open. The normalized state is never
 * part of the contribution contract and never contains the captured credential.
 */
interface BrowserProviderOAuth {
  type: "oauth";
  id: string;
  flow: "browser";
  authorizationUrl: string;
  /**
   * Loopback as well as a custom scheme.
   *
   * The previous shape allowed only `custom-scheme`, which Google cannot use: it requires loopback
   * for desktop clients, and withdrew the out-of-band flow in 2022. A Provider declaring Google's
   * flow had nowhere to put its callback.
   */
  callback:
    | { type: "scheme"; scheme: string }
    | { type: "loopback" }
    | { type: "poll-until"; url: string; intervalMs?: number };
  accessTokenField: string;
  /** Host-private destination resolved from the installed Provider declaration. */
  pluginStore?: { pluginId: string; key: string };
}

interface BrowserProviderOAuthState {
  protocol: "clash.provider-oauth.browser/v1";
  auth: BrowserProviderOAuth;
}

function parseBrowserProviderOAuthState(
  value: string | undefined,
): BrowserProviderOAuthState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<BrowserProviderOAuthState>;
    if (
      parsed.protocol !== "clash.provider-oauth.browser/v1" ||
      parsed.auth?.type !== "oauth"
    ) {
      return null;
    }
    return parsed as BrowserProviderOAuthState;
  } catch {
    return null;
  }
}

/** Resolve one Provider-declared browser flow and freeze its Host-owned storage destination. */
async function pluginBrowserOAuth(
  options: Pick<LocalApiOptions, "listPluginProviders">,
  oauthId: ProviderOAuthId,
): Promise<BrowserProviderOAuth | null> {
  const registrations = (await options.listPluginProviders?.()) ?? [];
  for (const registration of registrations) {
    const provider = registration.document.spec;
    if (provider.id !== oauthId) continue;
    const method = provider.auth?.methods.find(
      (candidate) => candidate.flow !== undefined,
    );
    const flow = method?.flow;
    if (!flow) continue;
    return {
      type: "oauth",
      id: oauthId,
      flow: "browser",
      authorizationUrl: flow.open,
      callback: flow.callback,
      accessTokenField: flow.credential?.name ?? "accessToken",
      ...(flow.credential
        ? {
            pluginStore: {
              pluginId: registration.pluginId,
              key: flow.credential.storeAs,
            },
          }
        : {}),
    };
  }
  return null;
}

/** Resolve a Provider-declared local import without letting the request choose its storage scope. */
interface DeclaredPluginLocalTokenImport {
  auth: LocalTokenImportAuth;
  pluginId: string;
  storeKey: string;
}

async function pluginLocalTokenImport(
  options: Pick<LocalApiOptions, "listPluginProviders">,
  oauthId: ProviderOAuthId,
): Promise<DeclaredPluginLocalTokenImport | null> {
  const registrations = (await options.listPluginProviders?.()) ?? [];
  for (const registration of registrations) {
    const provider = registration.document.spec;
    if (provider.id !== oauthId) continue;
    const method = provider.auth?.methods.find(
      (candidate) => candidate.import !== undefined,
    );
    const declaredImport = method?.import;
    if (!method || !declaredImport) continue;
    return {
      pluginId: registration.pluginId,
      storeKey: declaredImport.storeAs,
      auth: {
        type: "local-token-import",
        id: oauthId,
        label: method.label,
        source: {
          format: declaredImport.format,
          appDataSubdirectory: declaredImport.appDataSubdirectory,
          configFile: declaredImport.configFile,
          keyFile: declaredImport.keyFile,
          tokenPath: declaredImport.tokenPath,
        },
      },
    };
  }
  return null;
}

/**
 * How this flow gets its answer back, in a form the settings screen can show.
 *
 * A loopback flow has no scheme to name -- the port is chosen when the flow starts -- so reporting
 * one would mean inventing a value the caller could not use.
 */
function callbackDescription(auth: BrowserProviderOAuth): {
  callbackScheme?: string;
  callbackType: string;
} {
  return auth.callback.type === "scheme"
    ? { callbackType: "scheme", callbackScheme: auth.callback.scheme }
    : { callbackType: auth.callback.type };
}

function browserOAuthToken(
  callbackUrl: string,
  auth: BrowserProviderOAuth,
): string {
  // Only the custom-scheme callback carries the token in a fragment. A loopback flow is completed
  // by `runLoopbackFlow` and `exchangeAuthorizationCode` in auth-flow.ts, which return a token
  // rather than a URL, and device code never produces a callback URL at all.
  if (auth.callback.type !== "scheme") {
    throw new Error(
      `A ${auth.callback.type} flow is not completed by parsing a callback URL.`,
    );
  }
  const scheme = auth.callback.scheme;
  const callback = new URL(callbackUrl);
  if (callback.protocol !== `${scheme}:`) {
    throw new Error(`OAuth callback must use the ${scheme}: scheme.`);
  }
  const fragment = new URLSearchParams(callback.hash.replace(/^#/, ""));
  const accessToken =
    callback.searchParams.get(auth.accessTokenField) ??
    fragment.get(auth.accessTokenField);
  if (!accessToken?.trim()) {
    throw new Error(`OAuth callback is missing ${auth.accessTokenField}.`);
  }
  return accessToken.trim();
}

function publicProviderOAuth(record: LocalProviderOAuthRecord) {
  const browserState = parseBrowserProviderOAuthState(record.oauthState);
  return {
    providerId: record.providerId,
    ...(record.accountId ? { accountId: record.accountId } : {}),
    status: record.status,
    ...(record.verificationUri
      ? { verificationUri: record.verificationUri }
      : {}),
    ...(record.userCode ? { userCode: record.userCode } : {}),
    ...(record.deviceCode ? { deviceCode: record.deviceCode } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    ...(record.intervalSeconds !== undefined
      ? { intervalSeconds: record.intervalSeconds }
      : {}),
    ...(record.accountLabel ? { accountLabel: record.accountLabel } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(browserState
      ? {
          flow: "browser" as const,
          ...callbackDescription(browserState.auth),
        }
      : {}),
    hasAccessToken:
      typeof record.accessToken === "string" &&
      record.accessToken.trim().length > 0,
  };
}

function providerOAuthEntityId(providerId: string, accountId?: string): string {
  return accountId ? `${providerId}:${accountId}` : providerId;
}

function upsertProviderOAuth(
  state: LocalDb,
  userId: string,
  providerId: ProviderOAuthId,
  patch: Partial<LocalProviderOAuthRecord>,
): LocalProviderOAuthRecord {
  const now = nowIso();
  const accountId = patch.accountId;
  const existing = state.providerOAuth.find(
    (record) =>
      record.userId === userId &&
      record.providerId === providerId &&
      (record.accountId ?? "") === (accountId ?? ""),
  );
  if (existing) {
    Object.assign(existing, patch, { updatedAt: now });
    return existing;
  }
  const record: LocalProviderOAuthRecord = {
    userId,
    providerId,
    status: patch.status ?? "pending",
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
  state.providerOAuth.unshift(record);
  return record;
}

function stringBodyField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerOAuthMatches(
  record: LocalProviderOAuthRecord,
  userId: string,
  providerId: ProviderOAuthId,
  accountId?: string,
): boolean {
  return (
    record.userId === userId &&
    record.providerId === providerId &&
    (record.accountId ?? "") === (accountId ?? "")
  );
}

function builtinLocalAgentMembers(
  userId: string,
  createdAt: number,
): LocalAgentMember[] {
  return BUILTIN_AGENT_TEMPLATES.map((template) => ({
    id: `local-${template.id}`,
    user_id: userId,
    template_id: template.id,
    runtime_id: LOCAL_RUNTIME_ID,
    agent_id: null,
    display_name: template.label,
    created_at: createdAt,
  }));
}

function localAgentMembersForRead(
  state: LocalDb,
  userId: string,
): LocalAgentMember[] {
  return state.agentMembers.length > 0
    ? state.agentMembers
    : builtinLocalAgentMembers(userId, 0);
}

function seedLocalAgentMembers(
  state: LocalDb,
  userId: string,
): LocalAgentMember[] {
  if (state.agentMembers.length > 0) return state.agentMembers;
  state.agentMembers = builtinLocalAgentMembers(
    userId,
    Math.floor(Date.now() / 1000),
  );
  return state.agentMembers;
}

async function localRuntimeSummary(options: LocalApiOptions): Promise<{
  label: string;
  status: LocalAcpRuntimeStatus;
  agents: LocalAcpRuntimeAgent[];
}> {
  if (!options.localAcp) {
    return { label: "Local Desktop", status: "online", agents: [] };
  }
  try {
    const { runtimes } = await options.localAcp.listRuntimes();
    const runtime =
      runtimes.find((row) => row.id === LOCAL_RUNTIME_ID) ?? runtimes[0];
    return {
      label: runtime?.hostname ?? "Local Desktop",
      status: runtime?.status ?? "offline",
      agents: runtime?.agents ?? [],
    };
  } catch {
    return { label: "Local Desktop", status: "offline", agents: [] };
  }
}

interface ModelProviderTestResult {
  ok: boolean;
  providerId: string;
  upstreamId?: string;
  region?: string;
  modelId: string;
  actionRunId?: string;
  message: string;
  provider?: string;
  requestId?: string;
  modelEndpoint?: string;
  input?: ModelProviderTestInputSummary;
  output?: ModelProviderTestOutputSummary;
  disabled?: boolean;
  missingCredentials?: string[];
  missingOAuth?: string[];
  unsupported?: boolean;
  skipped?: boolean;
}

interface ModelProviderTestInputSummary {
  shape: ModelKind;
  model: string;
  prompt: string;
  aspectRatio?: string;
  duration?: number;
}

type ModelProviderTestOutputSummary =
  | {
      shape: "image";
      provider?: string;
      endpoint?: string;
      requestId?: string;
      url?: string;
      contentType: string;
      width?: number;
      height?: number;
    }
  | {
      shape: "video";
      provider?: string;
      endpoint?: string;
      requestId?: string;
      url?: string;
      contentType: string;
      width?: number;
      height?: number;
      durationMs?: number;
    }
  | {
      shape: "audio";
      provider?: string;
      endpoint?: string;
      requestId?: string;
      url?: string;
      contentType: string;
      durationMs?: number;
      transcript?: string;
    }
  | {
      shape: "model";
      provider?: string;
      endpoint?: string;
      requestId?: string;
      url?: string;
      contentType: string;
    }
  | {
      shape: "text";
      provider?: string;
      endpoint?: string;
      text: string;
    }
  | {
      shape: "asr";
      provider?: string;
      endpoint?: string;
      transcript?: string;
    };

function providerTestInputSummary(
  input: ModelProviderTestInputSummary,
): ModelProviderTestInputSummary {
  return {
    shape: input.shape,
    model: input.model,
    prompt: input.prompt,
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(typeof input.duration === "number" ? { duration: input.duration } : {}),
  };
}

function providerTestMediaOutput(
  shape: "image" | "video" | "audio",
  result: MockMediaGenerationCompleted,
): ModelProviderTestOutputSummary {
  return {
    shape,
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.modelEndpoint ? { endpoint: result.modelEndpoint } : {}),
    ...(result.requestId ? { requestId: result.requestId } : {}),
    ...(result.remoteUrl ? { url: result.remoteUrl } : {}),
    contentType: result.contentType,
    ...(typeof result.width === "number" ? { width: result.width } : {}),
    ...(typeof result.height === "number" ? { height: result.height } : {}),
    ...(typeof result.durationMs === "number"
      ? { durationMs: result.durationMs }
      : {}),
    ...(result.transcript ? { transcript: result.transcript } : {}),
  };
}

function providerTestExecutableOutput(
  shape: ModelKind,
  plan: ProviderPluginExecutionPlan,
  output: ExecutablePluginOutput,
): ModelProviderTestOutputSummary {
  if (shape === "text") {
    if (
      output.kind !== "value" ||
      typeof output.value !== "string" ||
      !output.value.trim()
    ) {
      throw new Error("Provider test text output must be a non-empty string.");
    }
    return {
      shape: "text",
      provider: plan.provider,
      endpoint: plan.modelEndpoint,
      text: output.value,
    };
  }
  if (output.kind !== "asset") {
    throw new Error(
      `Provider test ${shape} output must use the canonical Asset envelope.`,
    );
  }
  const media = output.asset;
  if (media.kind !== shape) {
    throw new Error(
      `Provider test ${shape} output cannot use a ${media.kind} Asset.`,
    );
  }
  const contentType =
    media.mediaType ??
    (shape === "video"
      ? "video/mp4"
      : shape === "audio"
        ? "audio/mpeg"
        : shape === "model"
          ? "model/gltf-binary"
          : "image/png");
  return {
    shape,
    provider: plan.provider,
    endpoint: plan.modelEndpoint,
    contentType,
  };
}

async function waitForDurableProviderTest(input: {
  journal: ReturnType<typeof createSqliteDurableRunJournal>;
  providerPluginExecutor: ProviderPluginExecutor;
  plan: ProviderPluginExecutionPlan;
  actionRunId: string;
  outputSlot: string;
  deadlineMs: number;
}): Promise<{ run: DurableRunRecord; output: ExecutablePluginOutput }> {
  const identity = {
    actionRunId: input.actionRunId,
    outputSlot: input.outputSlot,
  };
  const coordinator: LocalDurableRunCoordinator =
    createLocalDurableRunCoordinator({
      ownerId: "local-api-provider-test",
      journal: input.journal,
      providerPluginExecutor: input.providerPluginExecutor,
      outputStore: {
        async stage({ run, outputs }) {
          const output = outputs.find(
            (candidate) => candidate.slot === run.outputSlot,
          );
          if (!output) {
            throw new Error(
              `Provider test output slot ${run.outputSlot} is missing.`,
            );
          }
          return ExecutablePluginOutputSchema.parse(output);
        },
      },
      publisher: {
        async publish() {
          // A Provider diagnostic has no Project mutation. The staged canonical output remains in
          // the durable journal and is the idempotent result returned to this or a resumed request.
        },
        async publishFailure() {
          // The private journal is the diagnostic authority; there is no Project failure to expose.
        },
      },
      retryPolicy: createBoundedRetryPolicy({
        maxFailures: { submit: 3, poll: 3, stage: 3, publish: 3 },
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
      }),
    });
  const existing = await input.journal.load(identity);
  const values = ExecutablePluginJsonValueSchema.parse(input.plan.input.values);
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Provider test plan values must be a JSON object.");
  }
  await coordinator.coordinate({
    type: "create",
    actionRunId: input.actionRunId,
    outputSlot: input.outputSlot,
    deadlineAt: existing?.deadlineAt ?? Date.now() + input.deadlineMs,
    executor: {
      binding: input.plan.binding,
      ...(input.plan.accountId ? { accountId: input.plan.accountId } : {}),
      assetInputs: input.plan.assetInputs,
      kind: input.plan.kind,
      projectId: input.plan.projectId,
      ...(input.plan.nodeId ? { nodeId: input.plan.nodeId } : {}),
      provider: input.plan.provider,
      modelEndpoint: input.plan.modelEndpoint,
      input: {
        values: values as Record<string, ExecutablePluginJsonValue>,
        references: input.plan.input.references,
      },
    },
  });

  for (;;) {
    const result = await coordinator.coordinate({ type: "advance", identity });
    if (result.kind === "terminal") {
      if (result.run.phase === "failed") {
        const failure = result.run.failure ?? result.run.projectionFailure;
        throw new Error(
          failure
            ? `Provider generation failed (${failure.code}): ${failure.message}`
            : "Provider generation failed without a durable failure record.",
        );
      }
      return {
        run: result.run,
        output: ExecutablePluginOutputSchema.parse(result.run.stagedOutput),
      };
    }
    if (result.kind === "waiting") {
      const delayMs = Math.max(0, result.wakeAt - Date.now());
      if (delayMs > 0) {
        await new Promise<void>((resolveDelay) =>
          setTimeout(resolveDelay, delayMs),
        );
      }
      continue;
    }
    if (result.kind === "contended") {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
}

function displayModelName(modelId: string): string {
  return (
    [...MODEL_CARDS, ...MOCK_MODEL_CARDS].find((model) => model.id === modelId)
      ?.name ?? modelId
  );
}

function userModelCardConfigs(
  state: Pick<LocalDb, "modelCardConfigs">,
  userId: string,
): UserModelCardConfig[] {
  return state.modelCardConfigs
    .filter((config) => (config.userId ?? userId) === userId)
    .map(({ userId: _userId, ...config }) => config);
}

async function effectiveModelCards(
  state: Pick<
    LocalDb,
    "modelCardConfigs" | "providerAccounts" | "providerOAuth"
  >,
  userId: string,
  listPluginCards?: () => Promise<ExecutablePluginCardRegistration[]>,
  listPluginModelBindings?: () => Promise<
    ExecutablePluginModelBindingRegistration[]
  >,
): Promise<ModelCard[]> {
  const providers = publicProviderAccounts(
    state.providerAccounts,
    userId,
    state.providerOAuth,
  );
  const [pluginCards, pluginModelBindings] = await Promise.all([
    listPluginCards ? listPluginCards() : [],
    listPluginModelBindings ? listPluginModelBindings() : [],
  ]);
  return buildEffectiveModelCards({
    configs: userModelCardConfigs(state, userId),
    providers,
    baseModels: localExecutableModelCards(
      composeExecutablePluginModelCards(
        MODEL_CARDS,
        pluginCards,
        pluginModelBindings,
      ).filter((model) => modelCardVisibleToConsumer(model, undefined)),
    ),
  });
}

function executablePluginActionDefinitions(
  registrations: readonly ExecutablePluginCardRegistration[],
) {
  const definitions = new Map<
    string,
    { pluginId: string; definition: unknown }
  >();
  for (const registration of registrations) {
    if (registration.document.kind !== "action-card") continue;
    const card = registration.document.spec;
    const existing = definitions.get(card.id);
    if (existing) {
      throw new Error(
        `Plugins ${existing.pluginId} and ${registration.pluginId} both export action Card ${card.id}.`,
      );
    }
    const definition = CustomActionDefinitionSchema.parse({
      id: card.id,
      name: card.name,
      ...(card.description ? { description: card.description } : {}),
      parameters: card.parameters,
      outputType: card.outputType,
      input: card.input,
      constraints: card.constraints ?? [],
      presentation: card.presentation,
      ...(card.maxRuntimeMs ? { maxRuntimeMs: card.maxRuntimeMs } : {}),
      runtime: registration.runtime.kind === "hosted" ? "worker" : "local",
      version: registration.version,
      ...(registration.runtime.kind === "hosted"
        ? { workerUrl: registration.runtime.endpoint }
        : {}),
      pluginBinding: {
        pluginId: registration.pluginId,
        version: registration.version,
        exportId: card.functionExportId,
        schemaHash: registration.schemaHash,
      },
      promptModalities: card.input.promptModalities,
      tags: ["executable-plugin", registration.pluginId],
    });
    definitions.set(card.id, { pluginId: registration.pluginId, definition });
  }
  return [...definitions.values()]
    .map((entry) => entry.definition)
    .sort((left, right) => {
      const leftId = (left as { id: string }).id;
      const rightId = (right as { id: string }).id;
      return leftId.localeCompare(rightId);
    });
}

function normalizeModelCardConfigInput(
  modelId: string,
  value: unknown,
  accounts: LocalProviderAccountConfig[],
  builtInModelIds: ReadonlySet<string> = new Set(
    MODEL_CARDS.map((model) => model.id),
  ),
): UserModelCardConfig | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const builtIn = builtInModelIds.has(modelId);
  const parsed = UserModelCardConfigSchema.safeParse({
    ...raw,
    modelId,
    custom: raw.custom ?? !builtIn,
  });
  if (!parsed.success) return null;
  const config = parsed.data;
  if (builtIn) {
    if (config.custom || config.providerBindings.length > 0) return null;
    return config;
  }
  if (!config.custom || !config.name || config.providerBindings.length === 0)
    return null;
  const accountsById = new Map(
    accounts
      .filter(
        (account): account is LocalProviderAccountConfig & { id: string } =>
          !!account.id,
      )
      .map((account) => [account.id, account]),
  );
  const validBindings = config.providerBindings.every((binding) => {
    const account = accountsById.get(binding.providerAccountId);
    if (!account) return false;
    if (
      account.apiShape === "openai-compatible" ||
      account.apiShape === "anthropic-compatible"
    )
      return true;
    return (
      account.providerId === "official" &&
      (account.upstreamId === "openai" || account.upstreamId === "anthropic")
    );
  });
  return validBindings ? config : null;
}

function displayProviderName(
  account: Pick<
    LocalProviderAccountConfig,
    "providerId" | "upstreamId" | "region"
  >,
): string {
  if (account.providerId === "mock") return "Mock provider";
  if (account.providerId === "official" && account.upstreamId) {
    if (account.upstreamId === "openai") return "OpenAI";
    if (account.upstreamId === "anthropic") return "Anthropic";
    if (account.upstreamId === "bfl") return "Black Forest Labs";
    if (account.upstreamId === "google-ai-studio") return "Google AI Studio";
    if (account.upstreamId === "google-agent-platform")
      return "Google Cloud Agent Platform";
    return account.upstreamId;
  }
  const names: Record<string, string> = {
    fal: "fal.ai",
    pika: "Pika API Club",
    replicate: "Replicate",
    kling: "Kling",
    minimax: "MiniMax",
    volcengine: "Volcengine",
    elevenlabs: "ElevenLabs",
    suno: "Suno API",
  };
  if (names[account.providerId]) return names[account.providerId];
  return account.upstreamId && account.upstreamId !== account.providerId
    ? `${account.providerId}/${account.upstreamId}`
    : account.providerId;
}

function configuredCredentialKeys(
  account: Pick<LocalProviderAccountConfig, "credentials">,
): Set<string> {
  return new Set(
    Object.entries(account.credentials ?? {})
      .filter(
        ([, value]) => typeof value === "string" && value.trim().length > 0,
      )
      .map(([key]) => key),
  );
}

function routeProviderId(route: ModelUpstreamRoute): string {
  if (route.providerId) return route.providerId;
  if (route.upstreamId === "local") return "local";
  if (
    route.upstreamId === "openai" ||
    route.upstreamId === "google-ai-studio" ||
    route.upstreamId === "google-agent-platform" ||
    route.upstreamId === "anthropic" ||
    route.upstreamId === "bfl"
  ) {
    return "official";
  }
  if (
    route.upstreamId === "fal" ||
    route.upstreamId === "pika" ||
    route.upstreamId === "replicate" ||
    route.upstreamId === "mock"
  ) {
    return route.upstreamId;
  }
  return "custom";
}

function modelRoutesForProviderAccount(
  account: Pick<
    LocalProviderAccountConfig,
    "id" | "providerId" | "upstreamId" | "region"
  >,
  modelId: string,
  models: readonly ModelCard[] = MODEL_CARDS,
): ModelUpstreamRoute[] {
  const routes = listDeclaredModelUpstreamRoutes(models);
  return routes.filter(
    (route) =>
      route.modelCode === modelId &&
      (!route.accountId || route.accountId === account.id) &&
      routeProviderId(route) === account.providerId &&
      (!account.upstreamId || route.upstreamId === account.upstreamId) &&
      (route.region ?? "") === (account.region ?? ""),
  );
}

export function createLocalApiApp(options: LocalApiOptions): Hono {
  const userId = options.userId ?? "local-user";
  const localReplicaId = options.hostIdentity?.hostId ?? `local:${userId}`;
  const cloudAdmission =
    options.cloudAdmission ??
    (options.syncEnv?.CLASH_REMOTE_LORO_URL
      ? createHttpCloudAdmissionClient({
          baseUrl: options.syncEnv.CLASH_REMOTE_LORO_URL,
          token: options.syncEnv.CLASH_REMOTE_LORO_TOKEN,
        })
      : undefined);
  const mediaAnalysisConfig =
    options.mediaAnalysisConfig ??
    createLocalMediaAnalysisConfigStore({
      dataDir: options.dataDir,
      resolveOptions: async () => [],
    });
  const db = createDb(options.dataDir);
  const sessionEventStore = createLocalSessionEventStore(db);
  options.localAcp?.setSessionEventStore?.(sessionEventStore);
  let importedPluginStore:
    Promise<Awaited<ReturnType<typeof openPluginStore>>> | undefined;
  const pluginStoreForImport = () =>
    (importedPluginStore ??= openPluginStore({ dataDir: options.dataDir }));
  const localApiDataDir = resolve(options.dataDir);
  const clashRoot = clashHomeForLocalDataDir(
    options.dataDir,
    options.clashRoot,
  );
  const replicaStore = new FileReplicaStore(join(options.dataDir, "projects"));
  const projectCanvasThumbnailCache =
    createProjectCanvasThumbnailCache(replicaStore);
  const projectCommandReplica: LocalProjectAssetReplica =
    options.projectAssetReplica ?? {
      inspect: async (projectId, read) =>
        read(await replicaStore.recover(projectId)),
      mutate: (projectId, mutation) =>
        replicaStore.updateSnapshotAtomic(projectId, mutation),
    };
  const projectCanvasPreviewEntryFor = (projectId: string) =>
    readThroughProjectCanvasPreviewEntry({
      projectId,
      store: replicaStore,
      inspect: (read) => projectCommandReplica.inspect(projectId, read),
    });
  const recentProjectCanvasThumbnailInputs = new Map<
    string,
    Map<string, ProjectCanvasThumbnailInput>
  >();
  const rememberProjectCanvasThumbnailInput = (
    input: ProjectCanvasThumbnailInput,
  ) => {
    const remembered =
      recentProjectCanvasThumbnailInputs.get(input.projectId) ?? new Map();
    remembered.delete(input.entry.sourceVersion);
    remembered.set(input.entry.sourceVersion, input);
    while (remembered.size > 2) {
      const oldest = remembered.keys().next().value as string | undefined;
      if (!oldest) break;
      remembered.delete(oldest);
    }
    recentProjectCanvasThumbnailInputs.set(input.projectId, remembered);
    return input;
  };
  const providerExecutionHandoffs = createProviderExecutionHandoffStore(
    options.dataDir,
  );
  const durableRunJournal = createSqliteDurableRunJournal(options.dataDir);
  const providerReferenceAssets = createLocalPluginAssetStagingStore({
    dataDir: options.dataDir,
    clashRoot,
  });
  const providerGenerationDeadlineMs =
    options.providerGenerationDeadlineMs ??
    DEFAULT_LOCAL_PROVIDER_RUN_DEADLINE_MS;
  if (
    !Number.isSafeInteger(providerGenerationDeadlineMs) ||
    providerGenerationDeadlineMs <= 0
  ) {
    throw new TypeError(
      "providerGenerationDeadlineMs must be a positive safe integer",
    );
  }
  let projectAssetService:
    ReturnType<typeof createLocalProjectAssetService> | undefined;
  const projectAssetServiceAt = (requestProjectionOrigin: string) => {
    const configuredProjectionOrigin =
      typeof options.projectAssetProjectionOrigin === "function"
        ? options.projectAssetProjectionOrigin()
        : options.projectAssetProjectionOrigin;
    projectAssetService ??= createLocalProjectAssetService({
      dataDir: options.dataDir,
      clashRoot,
      projectionOrigin:
        configuredProjectionOrigin?.trim() || requestProjectionOrigin,
      replica: projectCommandReplica,
      readReceiptVerifier: verifyLocalApiProjectAssetReadReceipt,
      assetInspection,
      assetRepresentations,
    });
    return projectAssetService;
  };
  const projectCanvasThumbnailInput = (
    projectId: string,
    entry: Awaited<ReturnType<typeof projectCanvasPreviewEntryFor>>,
    service: ReturnType<typeof projectAssetServiceAt>,
  ): ProjectCanvasThumbnailInput => ({
    projectId,
    entry,
    resolveMedia: async (assetId) => {
      const projection = await service.openProjection(projectId, assetId);
      if (
        projection.resource.kind !== "image" &&
        projection.resource.kind !== "video"
      ) {
        return null;
      }
      await assetRepresentations.ensure(projection.resource.id);
      const thumbnail = await assetRepresentations.openThumbnail(
        projection.resource.id,
      );
      if (thumbnail) {
        return { kind: "image", path: thumbnail.path };
      }
      return null;
    },
  });
  const projectCanvasThumbnailState = async (
    projectId: string,
    entry: Awaited<ReturnType<typeof projectCanvasPreviewEntryFor>>,
    service: ReturnType<typeof projectAssetServiceAt>,
  ) => {
    const revision = createHash("sha256")
      .update("clash.main-canvas-thumbnail.v1\0")
      .update(entry.sourceVersion);
    const assetIds = [
      ...new Set(
        entry.preview.nodes.flatMap((node) =>
          node.assetId && (node.type === "image" || node.type === "video")
            ? [node.assetId]
            : [],
        ),
      ),
    ].sort();
    for (const assetId of assetIds) {
      revision.update("\0asset\0").update(assetId);
      try {
        const projection = await service.openProjection(projectId, assetId);
        revision.update("\0source\0").update(projection.resource.id);
        const representation = await assetRepresentations.read(
          projection.resource.id,
          "thumbnail",
        );
        if (representation?.role === "thumbnail") {
          revision
            .update("\0ready\0")
            .update(representation.recipe)
            .update("\0")
            .update(representation.resourceId);
        } else {
          revision.update("\0pending");
        }
      } catch {
        revision.update("\0unavailable");
      }
    }
    const sourceVersion = revision.digest("hex");
    const input = rememberProjectCanvasThumbnailInput(
      projectCanvasThumbnailInput(
        projectId,
        { ...entry, sourceVersion },
        service,
      ),
    );
    return {
      sourceVersion,
      input,
    };
  };
  const projectCanvasThumbnailProjection = (
    origin: string,
    projectId: string,
    entry: Awaited<ReturnType<typeof projectCanvasPreviewEntryFor>>,
    revision: string,
  ): V1ProjectCanvasThumbnail | null => {
    if (!entry.preview.bounds || entry.preview.nodes.length === 0) return null;
    const url = new URL(
      `/api/v1/projects/${encodeURIComponent(projectId)}/canvas/thumbnail`,
      origin,
    );
    url.searchParams.set("revision", revision);
    return {
      url: url.toString(),
      revision,
      width: PROJECT_CANVAS_THUMBNAIL_WIDTH,
      height: PROJECT_CANVAS_THUMBNAIL_HEIGHT,
    };
  };
  const editActionAssetBindings = (input: {
    invocation: AssetEditActionInvocation;
    actionRunId: string;
    outputAssetId: string;
  }): ActionAssetBinding[] => {
    const revisionDigest = createHash("sha256")
      .update(JSON.stringify(input.invocation))
      .digest("hex");
    const owner = {
      kind: "run" as const,
      actionId: input.invocation.actionId,
      actionRevisionId: `sha256:${revisionDigest}`,
      actionRunId: input.actionRunId,
    };
    return [
      {
        id: `action-asset:${input.actionRunId}:source:input`,
        owner,
        direction: "input",
        slot: "source",
        projectAssetId: input.invocation.source.assetId,
        role: "source",
      },
      {
        id: `action-asset:${input.actionRunId}:output`,
        owner,
        direction: "output",
        slot: "output",
        projectAssetId: input.outputAssetId,
        role: "primary",
      },
    ];
  };
  const editOutputAssetId = (actionRunId: string): string =>
    `asset:edit:${createHash("sha256")
      .update("clash.asset-edit-output.v1\0")
      .update(durableRunIdempotencyKey({ actionRunId, outputSlot: "output" }))
      .digest("hex")}`;
  let globalAssetService:
    ReturnType<typeof createLocalGlobalAssetService> | undefined;
  const globalAssetServiceAt = (requestProjectionOrigin: string) => {
    const configuredProjectionOrigin =
      typeof options.projectAssetProjectionOrigin === "function"
        ? options.projectAssetProjectionOrigin()
        : options.projectAssetProjectionOrigin;
    globalAssetService ??= createLocalGlobalAssetService({
      dataDir: options.dataDir,
      clashRoot,
      legacyUserId: userId,
      projectionOrigin:
        configuredProjectionOrigin?.trim() || requestProjectionOrigin,
      assetInspection,
      assetRepresentations,
    });
    return globalAssetService;
  };
  const ffprobePath = localFfprobePath();
  const inspectAssetResource: LocalAssetInspector =
    options.inspectAssetResource ??
    (ffprobePath
      ? createLocalFfprobeAssetInspector({ ffprobePath })
      : async () => {
          throw new Error(
            "ffprobe is required to verify media before Asset publication",
          );
        });
  const assetInspection =
    options.assetInspection ??
    createLocalAssetInspectionService({
      dataDir: options.dataDir,
      clashRoot,
      inspectResource: inspectAssetResource,
    });
  const assetRepresentations =
    options.assetRepresentations ??
    createLocalAssetRepresentationService({
      dataDir: options.dataDir,
      clashRoot,
      assetInspection,
    });
  void assetRepresentations.start().catch((error) => {
    console.error(
      "[local-api] representation startup recovery degraded:",
      error instanceof Error ? error.message : String(error),
    );
  });
  const workspaceProjectLease = new LocalWorkspaceProjectOperationLease();
  const workspaceTransfer = options.workspaceProjectAuthority
    ? createLocalWorkspaceTransferService({
        dataDir: options.dataDir,
        authority: options.workspaceProjectAuthority,
        ...(options.workspaceImportAuthority
          ? {
              importAuthority: options.workspaceImportAuthority,
              receiverOwnerId: userId,
            }
          : {}),
        assetInspection,
        projectLease: workspaceProjectLease,
      })
    : undefined;
  const falMock = options.falMock ?? createMockFalQueueService();
  const audioConfig =
    options.audioConfig ??
    createLocalAudioConfigStore({
      dataDir: options.dataDir,
    });
  const localTts = createLocalTtsGenerationHandler(audioConfig);
  const providerTestAigc = createMockExternalAigcService({
    fal: falMock,
    origin: "http://local-provider-test",
    localTts,
  });
  const voiceInputAigc = createMockExternalAigcService({
    providerAccounts: async () => {
      const state = await db.load();
      return providerAccountsForRuntime(
        state.providerAccounts,
        userId,
        state.providerOAuth,
      );
    },
    modelCards: async () => {
      const state = await db.load();
      return effectiveModelCards(
        state,
        userId,
        options.listPluginCards,
        options.listPluginModelBindings,
      );
    },
    providerPluginExecutor: options.providerPluginExecutor,
  });
  const syncConfig =
    options.syncConfig ??
    createLocalSyncConfigStore({
      dataDir: options.dataDir,
      env: options.syncEnv ?? process.env,
    });
  const projectMetadataReplication = createLocalProjectMetadataReplication({
    syncConfig,
    local: {
      async read(projectId) {
        const project = (await db.load()).projects.find(
          (candidate) => candidate.id === projectId,
        );
        return project ? localProjectSyncMetadata(project) : null;
      },
      async write(metadata) {
        await db.update((state) => {
          const project = state.projects.find(
            (candidate) => candidate.id === metadata.projectId,
          );
          if (!project) {
            throw new Error(
              `Cannot apply remote metadata for unknown Project ${metadata.projectId}`,
            );
          }
          project.name = metadata.name;
          project.description = metadata.description;
          project.createdAt = metadata.createdAt;
          project.updatedAt = metadata.updatedAt;
          project.deletedAt = metadata.deletedAt;
        });
      },
    },
  });
  const syncProjectMetadataInBackground = (projectId: string) => {
    void projectMetadataReplication.sync(projectId).catch((error) => {
      console.error(
        `[local-api] failed to mirror Project metadata for ${projectId}`,
        error,
      );
    });
  };
  const publicAssetStorage =
    options.publicAssetStorage ??
    createPublicAssetStorageService({ dataDir: options.dataDir });
  const app = new Hono();
  const generatorProduct =
    options.generatorProjectAuthority && options.resolveGeneratorDefinition
      ? createLocalGeneratorProductService({
          authority: options.generatorProjectAuthority,
          resolveDefinition: options.resolveGeneratorDefinition,
          ownerId: localDurableRunOwnerId(options.hostIdentity?.hostId),
          journal: durableRunJournal,
          actor: { kind: "user", id: userId },
          ...(options.resolveGeneratorModelConsumer
            ? { resolveModelConsumer: options.resolveGeneratorModelConsumer }
            : {}),
          deadlineMs: providerGenerationDeadlineMs,
        })
      : null;
  const documentProductForRequest = (c: Context) =>
    options.documentProjectAuthority
      ? createLocalDocumentProductService({
          dataDir: options.dataDir,
          authority: options.documentProjectAuthority,
          producer:
            normalizeString(
              c.req.header("x-clash-client-type"),
            )?.toLowerCase() === "agent"
              ? { kind: "actor", actor: { kind: "agent" } }
              : { kind: "actor", actor: { kind: "user", id: userId } },
        })
      : null;

  function localDocumentProductErrorResponse(
    c: Context,
    error: unknown,
  ): Response {
    if (!(error instanceof LocalDocumentProductError)) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        422,
      );
    }
    const body = { error: error.message, code: error.code };
    if (
      error.code === "DOCUMENT_ASSET_NOT_FOUND" ||
      error.code === "DOCUMENT_REVISION_NOT_FOUND" ||
      error.code === "DOCUMENT_ATTACHMENT_NOT_FOUND"
    ) {
      return c.json(body, 404);
    }
    if (
      error.code === "DOCUMENT_ASSET_EXISTS" ||
      error.code === "DOCUMENT_REVISION_ID_COLLISION" ||
      error.code === "DOCUMENT_ATTACHMENT_ID_COLLISION" ||
      error.code === "STALE_DOCUMENT_HEAD" ||
      error.code === "STALE_DOCUMENT_ATTACHMENT" ||
      error.code === "DOCUMENT_COPY_ON_WRITE_REQUIRED"
    ) {
      return c.json(body, 409);
    }
    return c.json(body, 422);
  }

  const workspaceTransferErrorResponse = (error: unknown): Response => {
    if (!(error instanceof LocalWorkspaceTransferError)) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
    const status =
      error.code === "WORKSPACE_PROJECT_NOT_FOUND" ||
      error.code === "WORKSPACE_EXPORT_NOT_FOUND" ||
      error.code === "WORKSPACE_EXPORT_FILE_NOT_FOUND" ||
      error.code === "WORKSPACE_IMPORT_NOT_FOUND" ||
      error.code === "WORKSPACE_IMPORT_FILE_NOT_FOUND"
        ? 404
        : error.code === "WORKSPACE_EXPORT_EXPIRED" ||
            error.code === "WORKSPACE_IMPORT_EXPIRED"
          ? 410
          : error.code === "WORKSPACE_NOT_QUIESCENT" ||
              error.code === "WORKSPACE_PROJECT_DELETED" ||
              error.code === "WORKSPACE_IMPORT_PROJECT_EXISTS"
            ? 409
            : 422;
    return Response.json(
      {
        error: error.message,
        code: error.code,
        ...(error.blockers ? { blockers: error.blockers } : {}),
      },
      { status },
    );
  };

  app.post("/api/v1/projects/:projectId/workspace-exports", async (c) => {
    if (!workspaceTransfer) {
      return c.json(
        { error: "Workspace export authority is unavailable" },
        503,
      );
    }
    const body = WorkspaceExportRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) {
      return c.json(
        {
          error: "Invalid Workspace export request",
          details: body.error.issues,
        },
        400,
      );
    }
    try {
      const plan = await workspaceTransfer.createExport({
        projectId: c.req.param("projectId"),
        sourceWorkspaceId: body.data.sourceWorkspaceId,
      });
      return c.json(WorkspaceExportPlanSchema.parse(plan), 201);
    } catch (error) {
      return workspaceTransferErrorResponse(error);
    }
  });

  const serveWorkspaceExportFile = async (c: Context, head: boolean) => {
    if (!workspaceTransfer) {
      return c.json(
        { error: "Workspace export authority is unavailable" },
        503,
      );
    }
    try {
      const exportId = c.req.param("exportId") ?? "";
      const fileId = c.req.param("fileId") ?? "";
      const file = workspaceTransfer.getExportFile(exportId, fileId);
      const digest = Buffer.from(file.sha256, "hex");
      const headers = new Headers({
        "cache-control": "private, no-store",
        "content-type": "application/octet-stream",
        "content-length": String(file.bytes),
        etag: `"sha256:${digest.toString("hex")}"`,
        "content-digest": `sha-256=:${digest.toString("base64")}:`,
        "x-content-type-options": "nosniff",
      });
      if (head) return new Response(null, { status: 200, headers });
      const opened = await workspaceTransfer.openExportFile(exportId, fileId);
      return new Response(
        Readable.toWeb(opened.stream) as ReadableStream<Uint8Array>,
        { status: 200, headers },
      );
    } catch (error) {
      return workspaceTransferErrorResponse(error);
    }
  };
  app.get("/api/v1/workspace-exports/:exportId/files/:fileId", (c) =>
    serveWorkspaceExportFile(c, false),
  );
  app.on("HEAD", "/api/v1/workspace-exports/:exportId/files/:fileId", (c) =>
    serveWorkspaceExportFile(c, true),
  );

  app.post("/api/v1/workspace-imports", async (c) => {
    if (!workspaceTransfer || !options.workspaceImportAuthority) {
      return c.json(
        { error: "Workspace import authority is unavailable" },
        503,
      );
    }
    const body = WorkspaceImportStartSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) {
      return c.json(
        {
          error: "Invalid Workspace import request",
          details: body.error.issues,
        },
        400,
      );
    }
    try {
      const session = await workspaceTransfer.createImport(body.data);
      return c.json(WorkspaceImportSessionSchema.parse(session), 201);
    } catch (error) {
      return workspaceTransferErrorResponse(error);
    }
  });

  app.get("/api/v1/workspace-imports/:importId", async (c) => {
    if (!workspaceTransfer || !options.workspaceImportAuthority) {
      return c.json(
        { error: "Workspace import authority is unavailable" },
        503,
      );
    }
    try {
      const session = await workspaceTransfer.getImport(
        c.req.param("importId") ?? "",
      );
      return c.json(WorkspaceImportSessionSchema.parse(session));
    } catch (error) {
      return workspaceTransferErrorResponse(error);
    }
  });

  app.put("/api/v1/workspace-imports/:importId/files/:fileId", async (c) => {
    if (!workspaceTransfer || !options.workspaceImportAuthority) {
      return c.json(
        { error: "Workspace import authority is unavailable" },
        503,
      );
    }
    if (
      c.req.header("content-type")?.split(";", 1)[0]?.trim() !==
      "application/octet-stream"
    ) {
      return c.json(
        { error: "Workspace import payload must be application/octet-stream" },
        415,
      );
    }
    const body = c.req.raw.body;
    if (!body) {
      return c.json(
        { error: "Workspace import payload body is required" },
        400,
      );
    }
    const source: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        const reader = body.getReader();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) return;
            yield next.value;
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
    try {
      const receipt = await workspaceTransfer.putImportFileStream(
        c.req.param("importId") ?? "",
        c.req.param("fileId") ?? "",
        source,
      );
      return c.json(WorkspaceImportFileUploadReceiptSchema.parse(receipt));
    } catch (error) {
      return workspaceTransferErrorResponse(error);
    }
  });

  app.post("/api/v1/workspace-imports/:importId/commit", async (c) => {
    if (!workspaceTransfer || !options.workspaceImportAuthority) {
      return c.json(
        { error: "Workspace import authority is unavailable" },
        503,
      );
    }
    const body = WorkspaceImportCommitRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) {
      return c.json(
        {
          error: "Invalid Workspace import commit",
          details: body.error.issues,
        },
        400,
      );
    }
    try {
      const committed = await workspaceTransfer.commitImport(
        c.req.param("importId") ?? "",
        body.data,
      );
      return c.json(WorkspaceImportCommitResponseSchema.parse(committed));
    } catch (error) {
      return workspaceTransferErrorResponse(error);
    }
  });

  const jsonRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;

  function directorRunFacts(run: DurableRunRecord): {
    projectId: string;
    modelEndpoint: string;
  } | null {
    const executor = jsonRecord(run.executorInput);
    const binding = jsonRecord(executor?.binding);
    const delivery = jsonRecord(executor?.delivery);
    if (
      binding?.pluginId !== "clash.fal" ||
      binding.exportId !== "fal-execute" ||
      delivery?.kind !== "project-asset" ||
      typeof executor?.projectId !== "string" ||
      typeof executor.modelEndpoint !== "string"
    ) {
      return null;
    }
    return {
      projectId: executor.projectId,
      modelEndpoint: executor.modelEndpoint,
    };
  }

  async function directorRunResponse(
    c: Context,
    run: DurableRunRecord,
  ): Promise<Response> {
    const facts = directorRunFacts(run);
    if (!facts) return c.json({ error: "Director generation not found" }, 404);
    const statusUrl =
      `/api/v1/director-model-generations/${encodeURIComponent(run.actionRunId)}` +
      `?projectId=${encodeURIComponent(facts.projectId)}`;
    if (run.phase === "succeeded") {
      const staged = jsonRecord(run.stagedOutput);
      const entry = jsonRecord(staged?.projectAsset);
      const projectAssetId =
        typeof entry?.id === "string" ? entry.id : undefined;
      if (!projectAssetId) {
        return c.json(
          { error: "Director generation published no Project Asset" },
          500,
        );
      }
      const asset = await projectAssetServiceAt(requestOrigin(c)).read(
        facts.projectId,
        projectAssetId,
      );
      if (!asset) {
        return c.json(
          { error: `Generated Project Asset ${projectAssetId} is unavailable` },
          500,
        );
      }
      return c.json({
        status: "completed",
        actionRunId: run.actionRunId,
        requestId: run.actionRunId,
        statusUrl,
        asset,
        provider: "fal",
        modelEndpoint: facts.modelEndpoint,
      });
    }
    if (run.phase === "failed") {
      return c.json(
        {
          status: "failed",
          actionRunId: run.actionRunId,
          requestId: run.actionRunId,
          statusUrl,
          error: run.failure?.message ?? "Director generation failed",
          ...(run.failure?.code ? { failureCode: run.failure.code } : {}),
        },
        422,
      );
    }
    const now = Date.now();
    const retryAfterMs = Math.max(
      250,
      Math.min(5_000, (run.nextAttemptAt ?? now + 1_000) - now),
    );
    c.header(
      "retry-after",
      String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
    );
    return c.json(
      {
        status: run.phase === "queued" ? "queued" : "running",
        phase: run.phase,
        actionRunId: run.actionRunId,
        requestId: run.actionRunId,
        statusUrl,
        retryAfterMs,
        deadlineAt: run.deadlineAt,
      },
      202,
    );
  }

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !isAllowedLocalBrowserOrigin(origin)) {
      return c.json({ error: "origin not allowed" }, 403);
    }
    await next();
  });

  app.use(
    "*",
    cors({
      origin: (origin) =>
        origin && isAllowedLocalBrowserOrigin(origin)
          ? origin
          : "http://127.0.0.1",
      allowHeaders: ["content-type", "x-clash-client-type", "x-clash-if-match"],
      exposeHeaders: [PROJECT_ASSET_READ_RECEIPT_HEADER],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );

  app.use("/api/v1/projects/:id/room/*", async (c) =>
    c.json({ error: "not found" }, 404),
  );

  app.get("/health", (c) =>
    c.json({
      ok: true,
      mode: "local",
      ...(options.hostIdentity ? { host: options.hostIdentity } : {}),
      runtime: {
        mode: "local",
        capabilities: defaultRuntimeCapabilities("local"),
      },
    }),
  );

  app.post("/api/v1/local/director-stage/capture", async (c) => {
    if (!options.directorStageRenderer) {
      return c.json(
        { error: "Director Stage product renderer is unavailable" },
        503,
      );
    }
    try {
      const request = (await c.req.json()) as DirectorStageRenderRequest;
      return c.json(await options.directorStageRenderer.render(request));
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        422,
      );
    }
  });

  app.get("/api/better-auth/get-session", (c) =>
    c.json({
      user: { id: userId, name: "Local User", email: "local@clash.local" },
    }),
  );
  app.get("/api/v1/me", (c) => c.json({ id: userId }));

  app.get("/api/v1/generator-definitions", async (c) => {
    if (!options.listPluginGenerators) {
      return c.json({ error: "Generator registry is unavailable" }, 503);
    }
    try {
      const definitions = (await options.listPluginGenerators()).map(
        generatorDefinitionFromExecutablePluginRegistration,
      );
      return c.json({ definitions });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        502,
      );
    }
  });

  app.get(
    "/api/v1/generator-definitions/:pluginId/:definitionId",
    async (c) => {
      if (!options.resolveGeneratorDefinition) {
        return c.json({ error: "Generator registry is unavailable" }, 503);
      }
      try {
        const definition = await options.resolveGeneratorDefinition(
          c.req.param("pluginId"),
          c.req.param("definitionId"),
        );
        return c.json({ definition });
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          404,
        );
      }
    },
  );

  app.post("/api/v1/projects/:projectId/generators", async (c) => {
    if (!generatorProduct) {
      return c.json(
        { error: "Generator Project authority is unavailable" },
        503,
      );
    }
    const body = CreateLocalProjectGeneratorInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) {
      return c.json(
        { error: "Invalid Generator creation", details: body.error.issues },
        400,
      );
    }
    try {
      const created = await generatorProduct.create(
        c.req.param("projectId"),
        body.data,
      );
      return c.json(
        { generator: created.generator, revision: created.revision },
        created.changed ? 201 : 200,
      );
    } catch (error) {
      if (error instanceof LocalGeneratorProductError) {
        return c.json({ error: error.message, code: error.code }, 409);
      }
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        422,
      );
    }
  });

  app.get("/api/v1/projects/:projectId/generators/:generatorId", async (c) => {
    if (!generatorProduct) {
      return c.json(
        { error: "Generator Project authority is unavailable" },
        503,
      );
    }
    const projection = await generatorProduct.read(
      c.req.param("projectId"),
      c.req.param("generatorId"),
    );
    return projection
      ? c.json(projection)
      : c.json({ error: "Project Generator not found" }, 404);
  });

  app.post(
    "/api/v1/projects/:projectId/generators/:generatorId/actions/:actionId/runs",
    async (c) => {
      if (!generatorProduct) {
        return c.json(
          { error: "Generator Project authority is unavailable" },
          503,
        );
      }
      const body = SubmitLocalGeneratorActionInputSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!body.success) {
        return c.json(
          {
            error: "Invalid Generator Action submission",
            details: body.error.issues,
          },
          400,
        );
      }
      try {
        const projectId = c.req.param("projectId");
        const run = await generatorProduct.submit(
          projectId,
          c.req.param("generatorId"),
          c.req.param("actionId"),
          body.data,
        );
        void options.processProjectWork?.(projectId).catch((error) => {
          console.error(
            "[local-api] failed to wake Generator Action work:",
            error,
          );
        });
        return c.json({ run }, 202);
      } catch (error) {
        if (error instanceof LocalGeneratorProductError) {
          return c.json({ error: error.message, code: error.code }, 409);
        }
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          422,
        );
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/generator-runs/:actionRunId",
    async (c) => {
      if (!generatorProduct) {
        return c.json(
          { error: "Generator Project authority is unavailable" },
          503,
        );
      }
      const run = await generatorProduct.readRun(
        c.req.param("projectId"),
        c.req.param("actionRunId"),
      );
      return run
        ? c.json({ run })
        : c.json({ error: "Generator Action Run not found" }, 404);
    },
  );

  app.get(
    "/api/v1/projects/:projectId/generator-runs/:actionRunId/outputs/:outputSlot",
    async (c) => {
      if (!generatorProduct) {
        return c.json(
          { error: "Generator Project authority is unavailable" },
          503,
        );
      }
      const commit = await generatorProduct.readOutput(
        c.req.param("projectId"),
        {
          actionRunId: c.req.param("actionRunId"),
          outputSlot: c.req.param("outputSlot"),
        },
      );
      return commit
        ? c.json({ commit })
        : c.json({ error: "Generator output is not committed" }, 404);
    },
  );

  app.get("/api/v1/projects/:projectId/documents", async (c) => {
    const documentProduct = documentProductForRequest(c);
    if (!documentProduct) {
      return c.json(
        { error: "Document Project authority is unavailable" },
        503,
      );
    }
    try {
      return c.json({
        documents: await documentProduct.list(c.req.param("projectId")),
      });
    } catch (error) {
      return localDocumentProductErrorResponse(c, error);
    }
  });

  app.post("/api/v1/projects/:projectId/documents", async (c) => {
    const documentProduct = documentProductForRequest(c);
    if (!documentProduct) {
      return c.json(
        { error: "Document Project authority is unavailable" },
        503,
      );
    }
    const body = CreateLocalDocumentInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) {
      return c.json(
        { error: "Invalid Document creation", details: body.error.issues },
        400,
      );
    }
    try {
      const created = await documentProduct.create(
        c.req.param("projectId"),
        body.data,
      );
      return c.json(
        {
          asset: created.asset,
          revision: created.revision,
          body: created.body,
        },
        created.changed ? 201 : 200,
      );
    } catch (error) {
      return localDocumentProductErrorResponse(c, error);
    }
  });

  app.get(
    "/api/v1/projects/:projectId/documents/:documentAssetId/revisions",
    async (c) => {
      const documentProduct = documentProductForRequest(c);
      if (!documentProduct) {
        return c.json(
          { error: "Document Project authority is unavailable" },
          503,
        );
      }
      try {
        return c.json({
          revisions: await documentProduct.listRevisions(
            c.req.param("projectId"),
            c.req.param("documentAssetId"),
          ),
        });
      } catch (error) {
        return localDocumentProductErrorResponse(c, error);
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/documents/:documentAssetId/revisions/:revisionId",
    async (c) => {
      const documentProduct = documentProductForRequest(c);
      if (!documentProduct) {
        return c.json(
          { error: "Document Project authority is unavailable" },
          503,
        );
      }
      try {
        const projection = await documentProduct.readRevision(
          c.req.param("projectId"),
          {
            documentAssetId: c.req.param("documentAssetId"),
            revisionId: c.req.param("revisionId"),
          },
        );
        return projection
          ? c.json(projection)
          : c.json({ error: "Document revision not found" }, 404);
      } catch (error) {
        return localDocumentProductErrorResponse(c, error);
      }
    },
  );

  app.post(
    "/api/v1/projects/:projectId/documents/:documentAssetId/revisions",
    async (c) => {
      const documentProduct = documentProductForRequest(c);
      if (!documentProduct) {
        return c.json(
          { error: "Document Project authority is unavailable" },
          503,
        );
      }
      const body = AdvanceLocalDocumentBodySchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!body.success) {
        return c.json(
          { error: "Invalid Document revision", details: body.error.issues },
          400,
        );
      }
      try {
        const advanced = await documentProduct.advance(
          c.req.param("projectId"),
          {
            documentAssetId: c.req.param("documentAssetId"),
            ...body.data,
          },
        );
        return c.json(
          {
            asset: advanced.asset,
            revision: advanced.revision,
            body: advanced.body,
          },
          advanced.changed ? 201 : 200,
        );
      } catch (error) {
        return localDocumentProductErrorResponse(c, error);
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/documents/:documentAssetId",
    async (c) => {
      const documentProduct = documentProductForRequest(c);
      if (!documentProduct) {
        return c.json(
          { error: "Document Project authority is unavailable" },
          503,
        );
      }
      try {
        const projection = await documentProduct.read(
          c.req.param("projectId"),
          c.req.param("documentAssetId"),
        );
        return projection
          ? c.json(projection)
          : c.json({ error: "Document Asset not found" }, 404);
      } catch (error) {
        return localDocumentProductErrorResponse(c, error);
      }
    },
  );

  app.post("/api/v1/projects/:projectId/document-attachments", async (c) => {
    const documentProduct = documentProductForRequest(c);
    if (!documentProduct) {
      return c.json(
        { error: "Document Project authority is unavailable" },
        503,
      );
    }
    const body = AttachLocalDocumentInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) {
      return c.json(
        { error: "Invalid Document attachment", details: body.error.issues },
        400,
      );
    }
    try {
      const attached = await documentProduct.attach(
        c.req.param("projectId"),
        body.data,
      );
      return c.json(
        { attachment: attached.attachment },
        attached.changed ? 201 : 200,
      );
    } catch (error) {
      return localDocumentProductErrorResponse(c, error);
    }
  });

  app.post(
    "/api/v1/projects/:projectId/document-attachments/:attachmentId/revisions",
    async (c) => {
      const documentProduct = documentProductForRequest(c);
      if (!documentProduct) {
        return c.json(
          { error: "Document Project authority is unavailable" },
          503,
        );
      }
      const body = AdvanceLocalDocumentAttachmentBodySchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!body.success) {
        return c.json(
          {
            error: "Invalid Document attachment revision",
            details: body.error.issues,
          },
          400,
        );
      }
      try {
        const advanced = await documentProduct.advanceAttachment(
          c.req.param("projectId"),
          {
            attachmentId: c.req.param("attachmentId"),
            ...body.data,
          },
        );
        return c.json({ attachment: advanced.attachment });
      } catch (error) {
        return localDocumentProductErrorResponse(c, error);
      }
    },
  );

  app.get("/api/v1/projects/:projectId/assets", async (c) => {
    try {
      const assets = await projectAssetServiceAt(requestOrigin(c)).list(
        c.req.param("projectId"),
      );
      return c.json({ assets });
    } catch (error) {
      return localProjectAssetErrorResponse(error);
    }
  });

  app.post("/api/v1/projects/:projectId/assets/batch", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
      const ids = new Set(
        Array.isArray(body.ids)
          ? body.ids
              .filter((id): id is string => typeof id === "string")
              .map((id) => id.trim())
              .filter(Boolean)
          : [],
      );
      const assets = (
        await projectAssetServiceAt(requestOrigin(c)).list(
          c.req.param("projectId"),
        )
      ).filter((asset) => ids.has(asset.id));
      return c.json({ assets });
    } catch (error) {
      return localProjectAssetErrorResponse(error);
    }
  });

  app.post("/api/v1/projects/:projectId/assets/import-file", async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json(
        {
          error: "Invalid multipart Project Asset import",
          code: "INVALID_PROJECT_ASSET_IMPORT",
        },
        400,
      );
    }
    const file = form.get("file");
    const kind = AssetKindSchema.safeParse(form.get("kind"));
    const projectAssetIdValue = form.get("projectAssetId");
    if (
      !file ||
      typeof file === "string" ||
      !kind.success ||
      projectAssetIdValue === null
    ) {
      return c.json(
        {
          error: "Project Asset import requires file, kind, and projectAssetId",
          code: "INVALID_PROJECT_ASSET_IMPORT",
        },
        400,
      );
    }
    if (
      typeof projectAssetIdValue !== "string" ||
      !projectAssetIdValue.trim() ||
      projectAssetIdValue.length > 512
    ) {
      return c.json(
        {
          error: "Invalid Project Asset id",
          code: "INVALID_PROJECT_ASSET_IMPORT",
        },
        400,
      );
    }
    const fileError = validateProjectAssetImportFile(file, kind.data);
    if (fileError) {
      return c.json(
        { error: fileError, code: "INVALID_PROJECT_ASSET_IMPORT" },
        400,
      );
    }

    try {
      const declaredContentType = file.type.trim().toLowerCase();
      const contentType =
        !declaredContentType ||
        declaredContentType === "application/octet-stream"
          ? contentTypeForPath(file.name)
          : declaredContentType;
      const asset = await projectAssetServiceAt(requestOrigin(c)).installOwned({
        projectId: c.req.param("projectId"),
        projectAssetId: projectAssetIdValue.trim(),
        kind: kind.data,
        bytes: new Uint8Array(await file.arrayBuffer()),
        contentType,
        name: file.name,
        metadata: {},
        provenance: { kind: "import" },
      });
      return c.json(asset, 201);
    } catch (error) {
      return localProjectAssetErrorResponse(error);
    }
  });

  app.get(
    "/api/v1/projects/:projectId/assets/:projectAssetId/references",
    async (c) => {
      try {
        const projectAssetId = c.req.param("projectAssetId");
        const observed = await projectAssetServiceAt(
          requestOrigin(c),
        ).listReferencesObserved(c.req.param("projectId"), projectAssetId);
        c.header(
          PROJECT_ASSET_READ_RECEIPT_HEADER,
          projectAssetReceiptReadToken(observed.readToken),
        );
        return c.json({ projectAssetId, references: observed.value });
      } catch (error) {
        return localProjectAssetErrorResponse(error);
      }
    },
  );

  app.delete(
    "/api/v1/projects/:projectId/assets/:projectAssetId",
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as unknown;
      const deleteOperationIdValue = isRecord(body)
        ? body.deleteOperationId
        : undefined;
      if (
        typeof deleteOperationIdValue !== "string" ||
        !deleteOperationIdValue.trim() ||
        deleteOperationIdValue.length > 512
      ) {
        return c.json(
          {
            error: "deleteOperationId is required",
            code: "INVALID_PROJECT_ASSET_TRASH",
          },
          400,
        );
      }
      try {
        const now = Date.now();
        const preconditions = requestProjectWritePreconditions(c);
        const observed = await projectAssetServiceAt(requestOrigin(c)).trash({
          projectId: c.req.param("projectId"),
          projectAssetId: c.req.param("projectAssetId"),
          deleteOperationId: deleteOperationIdValue.trim(),
          deletedAt: new Date(now).toISOString(),
          purgeAfter: new Date(now + ASSET_PURGE_DELAY_MS).toISOString(),
          observation: {
            ...(preconditions.actorClientType
              ? { actorClientType: preconditions.actorClientType }
              : {}),
            ...(preconditions.expectedReadToken
              ? { expectedReadToken: preconditions.expectedReadToken }
              : {}),
          },
        });
        c.header(
          PROJECT_ASSET_READ_RECEIPT_HEADER,
          projectAssetReceiptReadToken(observed.readToken),
        );
        return c.json(observed.value);
      } catch (error) {
        return localProjectAssetErrorResponse(error);
      }
    },
  );

  app.post(
    "/api/v1/projects/:projectId/generators/:generatorId/revisions",
    async (c) => {
      if (!generatorProduct) {
        return c.json(
          { error: "Generator Project authority is unavailable" },
          503,
        );
      }
      const body = AdvanceLocalProjectGeneratorInputSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!body.success) {
        return c.json(
          { error: "Invalid Generator revision", details: body.error.issues },
          400,
        );
      }
      const generatorId = c.req.param("generatorId");
      try {
        const advanced = await generatorProduct.advance(
          c.req.param("projectId"),
          generatorId,
          body.data,
        );
        return c.json(
          { generator: advanced.generator, revision: advanced.revision },
          advanced.changed ? 201 : 200,
        );
      } catch (error) {
        if (error instanceof LocalGeneratorProductError) {
          return c.json(
            {
              error: error.message,
              code: error.code,
              ...(error.code === "GENERATOR_FORK_REQUIRED"
                ? {
                    copyOnWrite: {
                      required: true,
                      forkedFrom: {
                        generatorId,
                        generatorRevisionId: body.data.expectedHeadRevisionId,
                      },
                    },
                  }
                : {}),
            },
            409,
          );
        }
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          422,
        );
      }
    },
  );

  app.post(
    "/api/v1/projects/:projectId/assets/:projectAssetId/restore",
    async (c) => {
      try {
        const preconditions = requestProjectWritePreconditions(c);
        const observed = await projectAssetServiceAt(requestOrigin(c)).restore({
          projectId: c.req.param("projectId"),
          projectAssetId: c.req.param("projectAssetId"),
          observation: {
            ...(preconditions.actorClientType
              ? { actorClientType: preconditions.actorClientType }
              : {}),
            ...(preconditions.expectedReadToken
              ? { expectedReadToken: preconditions.expectedReadToken }
              : {}),
          },
        });
        c.header(
          PROJECT_ASSET_READ_RECEIPT_HEADER,
          projectAssetReceiptReadToken(observed.readToken),
        );
        return c.json(observed.value);
      } catch (error) {
        return localProjectAssetErrorResponse(error);
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/assets/:projectAssetId/media",
    async (c) => {
      try {
        const projection = await projectAssetServiceAt(
          requestOrigin(c),
        ).openProjection(
          c.req.param("projectId"),
          c.req.param("projectAssetId"),
        );
        return await serveImmutableFileProjection({
          path: projection.path,
          contentType:
            projection.resource.contentType ??
            contentTypeForPath(projection.storageKey),
          expectedByteLength: projection.resource.byteLength,
          ...(c.req.header("range")
            ? { rangeHeader: c.req.header("range") }
            : {}),
        });
      } catch (error) {
        return localProjectAssetErrorResponse(error);
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/assets/:projectAssetId/thumbnail",
    async (c) => {
      try {
        const source = await projectAssetServiceAt(
          requestOrigin(c),
        ).openProjection(
          c.req.param("projectId"),
          c.req.param("projectAssetId"),
        );
        await assetRepresentations.ensure(source.resource.id);
        const projection = await assetRepresentations.openThumbnail(
          source.resource.id,
        );
        if (!projection) {
          return c.json({ error: "Asset thumbnail is not available" }, 404);
        }
        return await serveImmutableFileProjection({
          path: projection.path,
          contentType: projection.resource.contentType ?? "image/webp",
          expectedByteLength: projection.resource.byteLength,
        });
      } catch (error) {
        return localProjectAssetErrorResponse(error);
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/assets/:projectAssetId/waveform",
    async (c) => {
      try {
        const source = await projectAssetServiceAt(
          requestOrigin(c),
        ).openProjection(
          c.req.param("projectId"),
          c.req.param("projectAssetId"),
        );
        await assetRepresentations.ensure(source.resource.id);
        const representation = await assetRepresentations.read(
          source.resource.id,
          "waveform",
        );
        if (!representation || representation.role !== "waveform") {
          return c.json({ error: "Asset waveform is not available" }, 404);
        }
        c.header("cache-control", "private, max-age=31536000, immutable");
        return c.json({
          recipe: representation.recipe,
          peaks: representation.peaks,
          ...(representation.durationMs !== undefined
            ? { durationMs: representation.durationMs }
            : {}),
        });
      } catch (error) {
        return localProjectAssetErrorResponse(error);
      }
    },
  );

  app.get("/api/v1/projects/:projectId/assets/:projectAssetId", async (c) => {
    try {
      const observed = await projectAssetServiceAt(
        requestOrigin(c),
      ).readObserved(c.req.param("projectId"), c.req.param("projectAssetId"));
      if (observed) {
        c.header(
          PROJECT_ASSET_READ_RECEIPT_HEADER,
          projectAssetReceiptReadToken(observed.readToken),
        );
      }
      return observed
        ? c.json(observed.value)
        : c.json(
            {
              error: "Project Asset not found",
              code: "PROJECT_ASSET_NOT_FOUND",
            },
            404,
          );
    } catch (error) {
      return localProjectAssetErrorResponse(error);
    }
  });

  app.get("/api/v1/libraries/personal/assets", async (c) => {
    try {
      const assets = await globalAssetServiceAt(requestOrigin(c)).list(
        PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
      );
      return c.json({ assets });
    } catch (error) {
      return localGlobalAssetErrorResponse(error);
    }
  });

  app.post("/api/v1/libraries/personal/assets/import-file", async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json(
        {
          error: "Invalid multipart Global Asset import",
          code: "INVALID_GLOBAL_ASSET_IMPORT",
        },
        400,
      );
    }
    const file = form.get("file");
    const kind = AssetKindSchema.safeParse(form.get("kind"));
    const globalAssetIdValue = form.get("globalAssetId");
    if (
      !file ||
      typeof file === "string" ||
      !kind.success ||
      globalAssetIdValue === null
    ) {
      return c.json(
        {
          error: "Global Asset import requires file, kind, and globalAssetId",
          code: "INVALID_GLOBAL_ASSET_IMPORT",
        },
        400,
      );
    }
    if (
      typeof globalAssetIdValue !== "string" ||
      !globalAssetIdValue.trim() ||
      globalAssetIdValue.length > 512
    ) {
      return c.json(
        {
          error: "Invalid Global Asset id",
          code: "INVALID_GLOBAL_ASSET_IMPORT",
        },
        400,
      );
    }
    const fileError = validateProjectAssetImportFile(file, kind.data);
    if (fileError) {
      return c.json(
        { error: fileError, code: "INVALID_GLOBAL_ASSET_IMPORT" },
        400,
      );
    }

    try {
      const declaredContentType = file.type.trim().toLowerCase();
      const contentType =
        !declaredContentType ||
        declaredContentType === "application/octet-stream"
          ? contentTypeForPath(file.name)
          : declaredContentType;
      const asset = await globalAssetServiceAt(requestOrigin(c)).importBytes({
        libraryId: PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
        globalAssetId: globalAssetIdValue.trim(),
        kind: kind.data,
        bytes: new Uint8Array(await file.arrayBuffer()),
        contentType,
        originalName: file.name,
        name: file.name,
        provenance: { kind: "import" },
      });
      return c.json(asset, 201);
    } catch (error) {
      return localGlobalAssetErrorResponse(error);
    }
  });

  app.post("/api/v1/libraries/personal/assets/publish", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const projectId = isRecord(body)
      ? optionalBodyString(body.projectId)
      : undefined;
    const projectAssetId = isRecord(body)
      ? optionalBodyString(body.projectAssetId)
      : undefined;
    if (!projectId || !projectAssetId) {
      return c.json(
        {
          error: "projectId and projectAssetId are required",
          code: "INVALID_GLOBAL_ASSET_PUBLISH",
        },
        400,
      );
    }
    try {
      const source = await projectAssetServiceAt(requestOrigin(c)).readEntry(
        projectId,
        projectAssetId,
      );
      if (!source) {
        return c.json(
          {
            error: "Project Asset not found",
            code: "PROJECT_ASSET_NOT_FOUND",
          },
          404,
        );
      }
      if (source.lifecycle.state !== "active") {
        return c.json(
          {
            error: "Only an active Project Asset can be published",
            code: "PROJECT_ASSET_NOT_ACTIVE",
          },
          409,
        );
      }
      const asset = await globalAssetServiceAt(
        requestOrigin(c),
      ).publishResource({
        libraryId: PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
        globalAssetId: scopedAssetRelationId("global:project", [
          PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
          projectId,
          projectAssetId,
        ]),
        resourceId: source.source.resourceId,
        kind: source.kind,
        ...(source.name ? { name: source.name } : {}),
        metadata: source.metadata,
        ...(source.provenance ? { provenance: source.provenance } : {}),
      });
      return c.json(asset, 201);
    } catch (error) {
      if (
        error instanceof LocalProjectAssetMigrationError ||
        (error instanceof AssetSdkContractError &&
          error.code === "PROJECT_ASSET_NOT_FOUND")
      ) {
        return localProjectAssetErrorResponse(error);
      }
      return localGlobalAssetErrorResponse(error);
    }
  });

  app.post("/api/v1/projects/:projectId/assets/admit", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const globalAssetId = isRecord(body)
      ? optionalBodyString(body.globalAssetId)
      : undefined;
    if (!globalAssetId) {
      return c.json(
        {
          error: "globalAssetId is required",
          code: "INVALID_PROJECT_ASSET_ADMISSION",
        },
        400,
      );
    }
    try {
      const source = await globalAssetServiceAt(requestOrigin(c)).readEntry(
        PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
        globalAssetId,
      );
      if (!source) {
        return c.json(
          { error: "Global Asset not found", code: "GLOBAL_ASSET_NOT_FOUND" },
          404,
        );
      }
      if (source.lifecycle.state !== "active") {
        return c.json(
          {
            error: "Only an active Global Asset can be admitted",
            code: "GLOBAL_ASSET_NOT_ACTIVE",
          },
          409,
        );
      }
      const asset = await projectAssetServiceAt(requestOrigin(c)).admitLinked({
        projectId: c.req.param("projectId"),
        projectAssetId: scopedAssetRelationId("asset:global", [
          c.req.param("projectId"),
          PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
          source.id,
        ]),
        kind: source.kind,
        resourceId: source.resourceId,
        originLibraryId: PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
        originEntryId: source.id,
        ...(source.name ? { name: source.name } : {}),
        metadata: source.metadata,
        provenance: { kind: "admission" },
      });
      return c.json(asset, 201);
    } catch (error) {
      if (error instanceof LocalGlobalAssetError) {
        return localGlobalAssetErrorResponse(error);
      }
      return localProjectAssetErrorResponse(error);
    }
  });

  app.get(
    "/api/v1/libraries/personal/assets/:globalAssetId/media",
    async (c) => {
      try {
        const projection = await globalAssetServiceAt(
          requestOrigin(c),
        ).openProjection(
          PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
          c.req.param("globalAssetId"),
        );
        return await serveImmutableFileProjection({
          path: projection.path,
          contentType:
            projection.resource.contentType ??
            contentTypeForPath(projection.storageKey),
          expectedByteLength: projection.resource.byteLength,
          ...(c.req.header("range")
            ? { rangeHeader: c.req.header("range") }
            : {}),
        });
      } catch (error) {
        return localGlobalAssetErrorResponse(error);
      }
    },
  );

  app.get(
    "/api/v1/libraries/personal/assets/:globalAssetId/thumbnail",
    async (c) => {
      try {
        const source = await globalAssetServiceAt(
          requestOrigin(c),
        ).openProjection(
          PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
          c.req.param("globalAssetId"),
        );
        await assetRepresentations.ensure(source.resource.id);
        const projection = await assetRepresentations.openThumbnail(
          source.resource.id,
        );
        if (!projection) {
          return c.json({ error: "Asset thumbnail is not available" }, 404);
        }
        return await serveImmutableFileProjection({
          path: projection.path,
          contentType: projection.resource.contentType ?? "image/webp",
          expectedByteLength: projection.resource.byteLength,
        });
      } catch (error) {
        return localGlobalAssetErrorResponse(error);
      }
    },
  );

  app.get(
    "/api/v1/libraries/personal/assets/:globalAssetId/waveform",
    async (c) => {
      try {
        const source = await globalAssetServiceAt(
          requestOrigin(c),
        ).openProjection(
          PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
          c.req.param("globalAssetId"),
        );
        await assetRepresentations.ensure(source.resource.id);
        const representation = await assetRepresentations.read(
          source.resource.id,
          "waveform",
        );
        if (!representation || representation.role !== "waveform") {
          return c.json({ error: "Asset waveform is not available" }, 404);
        }
        c.header("cache-control", "private, max-age=31536000, immutable");
        return c.json({
          recipe: representation.recipe,
          peaks: representation.peaks,
          ...(representation.durationMs !== undefined
            ? { durationMs: representation.durationMs }
            : {}),
        });
      } catch (error) {
        return localGlobalAssetErrorResponse(error);
      }
    },
  );

  app.get("/api/v1/libraries/personal/assets/:globalAssetId", async (c) => {
    try {
      const asset = await globalAssetServiceAt(requestOrigin(c)).read(
        PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
        c.req.param("globalAssetId"),
      );
      return asset
        ? c.json(asset)
        : c.json(
            {
              error: "Global Asset not found",
              code: "GLOBAL_ASSET_NOT_FOUND",
            },
            404,
          );
    } catch (error) {
      return localGlobalAssetErrorResponse(error);
    }
  });

  app.delete("/api/v1/libraries/personal/assets/:globalAssetId", async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const deleteOperationIdValue = isRecord(body)
      ? body.deleteOperationId
      : undefined;
    if (
      typeof deleteOperationIdValue !== "string" ||
      !deleteOperationIdValue.trim() ||
      deleteOperationIdValue.length > 512
    ) {
      return c.json(
        {
          error: "deleteOperationId is required",
          code: "INVALID_GLOBAL_ASSET_TRASH",
        },
        400,
      );
    }
    try {
      const now = Date.now();
      const asset = await globalAssetServiceAt(requestOrigin(c)).trash({
        libraryId: PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
        globalAssetId: c.req.param("globalAssetId"),
        deleteOperationId: deleteOperationIdValue.trim(),
        deletedAt: new Date(now).toISOString(),
        purgeAfter: new Date(now + ASSET_PURGE_DELAY_MS).toISOString(),
      });
      return c.json(asset);
    } catch (error) {
      return localGlobalAssetErrorResponse(error);
    }
  });

  app.post(
    "/api/v1/libraries/personal/assets/:globalAssetId/restore",
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as unknown;
      const deleteOperationIdValue = isRecord(body)
        ? body.deleteOperationId
        : undefined;
      if (
        typeof deleteOperationIdValue !== "string" ||
        !deleteOperationIdValue.trim() ||
        deleteOperationIdValue.length > 512
      ) {
        return c.json(
          {
            error: "deleteOperationId is required",
            code: "INVALID_GLOBAL_ASSET_RESTORE",
          },
          400,
        );
      }
      try {
        const asset = await globalAssetServiceAt(requestOrigin(c)).restore({
          libraryId: PERSONAL_GLOBAL_ASSET_LIBRARY_ID,
          globalAssetId: c.req.param("globalAssetId"),
          deleteOperationId: deleteOperationIdValue.trim(),
        });
        return c.json(asset);
      } catch (error) {
        return localGlobalAssetErrorResponse(error);
      }
    },
  );

  const legacyAssetApiRetired = (c: Context) =>
    c.json(
      {
        error:
          "Legacy Asset API retired; use Project or personal-library Asset routes",
        code: "LEGACY_ASSET_API_RETIRED",
      },
      410,
    );
  app.all("/api/v1/assets", legacyAssetApiRetired);
  app.all("/api/v1/assets/*", legacyAssetApiRetired);

  app.get("/api/settings/actions", async (c) =>
    c.json(
      options.listInstalledMarketplaceActions
        ? await options.listInstalledMarketplaceActions()
        : [],
    ),
  );
  if (options.installMarketplaceAction) {
    app.post("/api/settings/actions", async (c) => {
      const body = (await c.req.json().catch(() => null)) as {
        manifest?: { id?: unknown; packageId?: unknown };
      } | null;
      const id = typeof body?.manifest?.id === "string" ? body.manifest.id : "";
      const packageId =
        typeof body?.manifest?.packageId === "string"
          ? body.manifest.packageId
          : "";
      const item = options.marketplaceActions?.find(
        (candidate) => candidate.id === id && candidate.packageId === packageId,
      );
      if (!item)
        return c.json(
          { error: "Unknown local marketplace action package" },
          404,
        );
      return c.json(await options.installMarketplaceAction!(packageId));
    });
  }
  if (options.uninstallMarketplaceAction) {
    app.delete("/api/settings/actions/:id", async (c) => {
      try {
        await options.uninstallMarketplaceAction!(c.req.param("id"));
        return new Response(null, { status: 204 });
      } catch (error) {
        return immutableMarketplaceActionErrorResponse(c, error);
      }
    });
  }
  app.get("/api/settings/skills", async (c) =>
    c.json(
      options.listInstalledMarketplaceSkills
        ? await options.listInstalledMarketplaceSkills()
        : [],
    ),
  );
  app.get("/api/settings/tokens", (c) => c.json([]));
  app.get("/api/v1/model-providers", async (c) => {
    const state = await db.load();
    return c.json(
      publicModelProvidersResponse(
        publicProviderAccounts(
          state.providerAccounts,
          userId,
          state.providerOAuth,
        ),
      ),
    );
  });
  app.patch("/api/v1/model-providers", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      providers?: unknown;
    } & ProjectWriteBody;
    const incoming = Array.isArray(body.providers)
      ? body.providers.map(normalizeProviderAccountInput)
      : [];
    if (incoming.length === 0 || incoming.some((provider) => !provider)) {
      return c.json(
        {
          error: "Invalid providers",
          mutation: hostMutationRejected(
            {
              operation: "provider_accounts_update",
              entity: { kind: "provider-accounts", id: userId },
            },
            "Invalid providers",
          ),
        },
        400,
      );
    }
    const invalidProviders = invalidProviderModelFilters(
      incoming.filter((provider) => !!provider),
    );
    if (invalidProviders.length > 0) {
      return c.json(
        {
          error: "Invalid provider model filters",
          invalidProviders,
          mutation: hostMutationRejected(
            {
              operation: "provider_accounts_update",
              entity: { kind: "provider-accounts", id: userId },
            },
            "Invalid provider model filters",
          ),
        },
        400,
      );
    }
    const envelope = {
      operation: "provider_accounts_update",
      entity: { kind: "provider-accounts", id: userId },
    };
    const preconditions = requestProjectWritePreconditions(c, body);
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const beforeState = needsReadProof ? await db.load() : null;
    const beforeProviders = beforeState
      ? publicProviderAccounts(
          beforeState.providerAccounts,
          userId,
          beforeState.providerOAuth,
        )
      : [];
    const hostMutation = needsReadProof
      ? validateProviderAccountsReadMutation({
          userId,
          accounts: beforeProviders,
          preconditions,
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    const providers = await db.update((state) => {
      const now = nowIso();
      const existing = new Map(
        state.providerAccounts
          .filter((account) => account.userId === userId)
          .map((account) => [providerAccountKey(account), account]),
      );
      for (const provider of incoming) {
        if (!provider) continue;
        const key = providerAccountKey(provider);
        const previous = existing.get(key);
        existing.set(key, {
          ...previous,
          ...provider,
          credentials: provider.credentials
            ? { ...(previous?.credentials ?? {}), ...provider.credentials }
            : previous?.credentials,
          userId,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        });
      }
      state.providerAccounts = [
        ...state.providerAccounts.filter(
          (account) => account.userId !== userId,
        ),
        ...existing.values(),
      ];
      return publicProviderAccounts(
        state.providerAccounts,
        userId,
        state.providerOAuth,
      );
    });
    const response = publicModelProvidersResponse(providers);
    const mutation = hostMutationSucceeded(hostMutation?.envelope ?? envelope, {
      resultEntityId: userId,
      ...(hostMutation ? { afterReadToken: response.readToken } : {}),
    });
    await db.appendMutationAudit(
      mutationAuditRecord({
        mutation,
        actorClientType: preconditions.actorClientType,
        reason: "provider accounts update",
      }),
    );
    return c.json({
      ...response,
      mutation,
    });
  });
  app.delete("/api/v1/model-providers/:accountId", async (c) => {
    const accountId = stringBodyField(c.req.param("accountId"));
    if (!accountId) {
      return c.json(
        {
          error: "Provider account not found",
          mutation: hostMutationRejected(
            {
              operation: "provider_account_delete",
              entity: { kind: "provider-account", id: "" },
            },
            "Provider account not found",
          ),
        },
        404,
      );
    }
    const preconditions = requestProjectWritePreconditions(c);
    const beforeState = await db.load();
    const beforeProviders = publicProviderAccounts(
      beforeState.providerAccounts,
      userId,
      beforeState.providerOAuth,
    );
    const beforeAccount = beforeProviders.find(
      (account) => account.id === accountId,
    );
    if (!beforeAccount) {
      return c.json(
        {
          error: "Provider account not found",
          mutation: hostMutationRejected(
            {
              operation: "provider_account_delete",
              entity: { kind: "provider-account", id: accountId },
            },
            "Provider account not found",
          ),
        },
        404,
      );
    }
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const hostMutation = needsReadProof
      ? validateProviderAccountReadMutation({
          account: beforeAccount,
          operation: "delete",
          preconditions,
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    const deleted = await db.update((state) => {
      const beforeAccounts = state.providerAccounts.length;
      const beforeOAuth = state.providerOAuth.length;
      state.providerAccounts = state.providerAccounts.filter(
        (account) =>
          !((account.userId ?? userId) === userId && account.id === accountId),
      );
      state.providerOAuth = state.providerOAuth.filter(
        (record) =>
          !(
            (record.userId ?? userId) === userId &&
            record.accountId === accountId
          ),
      );
      state.modelCardConfigs = state.modelCardConfigs.map((config) => ({
        ...config,
        providerBindings: config.providerBindings.filter(
          (binding) => binding.providerAccountId !== accountId,
        ),
      }));
      return (
        state.providerAccounts.length !== beforeAccounts ||
        state.providerOAuth.length !== beforeOAuth
      );
    });
    if (!deleted) {
      return c.json(
        {
          error: "Provider account not found",
          mutation: hostMutationRejected(
            {
              operation: "provider_account_delete",
              entity: { kind: "provider-account", id: accountId },
            },
            "Provider account not found",
          ),
        },
        404,
      );
    }
    const mutation = hostMutationSucceeded(
      hostMutation?.envelope ?? {
        operation: "provider_account_delete",
        entity: { kind: "provider-account", id: accountId },
      },
      {
        resultEntityId: accountId,
      },
    );
    await db.appendMutationAudit(
      mutationAuditRecord({
        mutation,
        actorClientType: preconditions.actorClientType,
        reason: "provider account delete",
      }),
    );
    return c.json({
      ok: true,
      mutation,
    });
  });
  app.post("/api/v1/model-providers/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      provider?: unknown;
      modelId?: unknown;
      live?: unknown;
      actionRunId?: unknown;
    } & ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const provider = normalizeProviderAccountInput(body.provider);
    const rawProvider =
      body.provider && typeof body.provider === "object"
        ? (body.provider as Record<string, unknown>)
        : {};
    const rawModelId =
      typeof body.modelId === "string" && body.modelId.trim()
        ? body.modelId.trim()
        : "";
    const modelId = normalizeModelId(rawModelId) ?? rawModelId;
    if (!provider || !modelId) {
      const message = "provider and modelId are required";
      const envelope = localMutationEnvelope(
        "provider_model_test",
        "provider-test",
        "unknown",
      );
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(envelope, message),
        },
        400,
      );
    }

    const state = await db.load();
    const stored = state.providerAccounts.find(
      (account) =>
        account.userId === userId &&
        providerAccountKey(account) === providerAccountKey(provider),
    );
    const enabled =
      rawProvider.enabled === false
        ? false
        : (stored?.enabled ?? provider.enabled);
    const account: LocalProviderAccountConfig = {
      ...provider,
      ...stored,
      enabled,
      credentials: {
        ...(stored?.credentials ?? {}),
        ...(provider.credentials ?? {}),
      },
      userId,
    };
    const effectiveModels = await effectiveModelCards(
      state,
      userId,
      options.listPluginCards,
      options.listPluginModelBindings,
    );
    const providerTestModels =
      account.providerId === "mock"
        ? [...effectiveModels, ...MOCK_MODEL_CARDS]
        : effectiveModels;
    const providerSupports = listProviderModelSupport({
      models: providerTestModels,
      includeMock: account.providerId === "mock",
    });
    const support = providerSupports.find(
      (row) =>
        row.providerId === account.providerId &&
        (!account.upstreamId || row.upstreamId === account.upstreamId) &&
        (row.region ?? "") === (account.region ?? ""),
    );
    const modelName =
      providerTestModels.find((model) => model.id === modelId)?.name ??
      displayModelName(modelId);
    const live = body.live === true;
    const baseResult = {
      providerId: account.providerId,
      ...(account.upstreamId ? { upstreamId: account.upstreamId } : {}),
      ...(account.region ? { region: account.region } : {}),
      modelId,
    };
    const envelope = localMutationEnvelope(
      "provider_model_test",
      "provider-test",
      `${account.providerId}:${modelId}`,
    );
    const providerTestResponse = async (result: ModelProviderTestResult) => {
      const mutation = hostMutationSucceeded(envelope, {
        resultEntityId: envelope.entity.id,
      });
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "provider model test",
        }),
      );
      return c.json({
        ...result,
        mutation,
      });
    };
    if (account.enabled === false) {
      return providerTestResponse({
        ok: false,
        ...baseResult,
        disabled: true,
        message: `${displayProviderName(account)} is disabled for ${modelName}.`,
      } satisfies ModelProviderTestResult);
    }
    const supportedModelEntries =
      support?.models.filter((model) => model.id === modelId) ?? [];
    if (!support || supportedModelEntries.length === 0) {
      return providerTestResponse({
        ok: false,
        ...baseResult,
        unsupported: true,
        message: `${displayProviderName(account)} does not support ${modelName}.`,
      } satisfies ModelProviderTestResult);
    }
    if (
      account.supportedModelIds?.length &&
      !account.supportedModelIds
        .map((id) => normalizeModelId(id) ?? id.trim())
        .includes(modelId)
    ) {
      return providerTestResponse({
        ok: false,
        ...baseResult,
        unsupported: true,
        message: `${displayProviderName(account)} is not enabled for ${modelName}.`,
      } satisfies ModelProviderTestResult);
    }

    const credentialKeys = configuredCredentialKeys(account);
    const routeRequirements = modelRoutesForProviderAccount(
      account,
      modelId,
      providerTestModels,
    );
    // One shape from both branches, so the field survives inference. `credentialRequirements` is
    // what else a route accepts: Google takes an API key or a service account JSON, and an account
    // holds one or the other, while `requiredCredentials` means all of them.
    interface RequirementCandidate {
      requiredCredentials: readonly string[];
      requiredOAuth: readonly string[];
      credentialRequirements?: ProviderCredentialRequirements;
    }
    const requirementCandidates: RequirementCandidate[] =
      routeRequirements.length > 0
        ? routeRequirements.map((route) => ({
            requiredCredentials: route.requiredCredentials ?? [],
            requiredOAuth: route.requiredOAuth ?? [],
            ...(route.credentialRequirements
              ? { credentialRequirements: route.credentialRequirements }
              : {}),
          }))
        : supportedModelEntries.map((model) => ({
            requiredCredentials:
              "requiredCredentials" in model
                ? model.requiredCredentials
                : support.requiredCredentials,
            requiredOAuth:
              "requiredOAuth" in model
                ? model.requiredOAuth
                : support.requiredOAuth,
          }));
    const credentialChecks = requirementCandidates.map((candidate) => ({
      candidate,
      // `missingModelRouteCredentials` reads both the flat list and `credentialRequirements.anyOf`,
      // and picks the nearest alternative when none is satisfied, so the message names the fewest
      // keys that would fix it. Filtering the flat list here ignored `anyOf` entirely -- the
      // implementation was in model-routing and nothing on this path called it.
      missingCredentials: missingModelRouteCredentials(
        {
          requiredCredentials: [...candidate.requiredCredentials],
          ...(candidate.credentialRequirements
            ? { credentialRequirements: candidate.credentialRequirements }
            : {}),
        },
        // Availability is stated per upstream, and `missingModelRouteCredentials` reads only the
        // credential list off it -- the id is required by the shape, not by the check, and the
        // account's own is optional here.
        {
          upstreamId: (account.upstreamId ?? support.upstreamId) as never,
          configuredCredentials: [...credentialKeys],
        },
      ),
    }));
    const credentialReadyChecks = credentialChecks.filter(
      (check) => check.missingCredentials.length === 0,
    );
    if (credentialReadyChecks.length === 0) {
      const bestCredentialCheck = [...credentialChecks].sort(
        (a, b) => a.missingCredentials.length - b.missingCredentials.length,
      )[0];
      return providerTestResponse({
        ok: false,
        ...baseResult,
        missingCredentials: bestCredentialCheck?.missingCredentials ?? [],
        message: `${displayProviderName(account)} is missing required credentials for ${modelName}.`,
      } satisfies ModelProviderTestResult);
    }

    const testedAccount = publicProviderAccounts(
      [account],
      userId,
      state.providerOAuth,
    ).find(
      (candidate) =>
        providerAccountKey(candidate) === providerAccountKey(account),
    );
    const availableOAuth = new Set(testedAccount?.availableOAuth ?? []);
    const oauthChecks = credentialReadyChecks.map((check) => ({
      ...check,
      missingOAuth: check.candidate.requiredOAuth.filter(
        (providerId) => !availableOAuth.has(providerId),
      ),
    }));
    const oauthReadyCheck = oauthChecks.find(
      (check) => check.missingOAuth.length === 0,
    );
    if (!oauthReadyCheck) {
      const bestOAuthCheck = [...oauthChecks].sort(
        (a, b) => a.missingOAuth.length - b.missingOAuth.length,
      )[0];
      return providerTestResponse({
        ok: false,
        ...baseResult,
        missingOAuth: bestOAuthCheck?.missingOAuth ?? [],
        message: `${displayProviderName(account)} needs authorization before testing ${modelName}.`,
      } satisfies ModelProviderTestResult);
    }

    if (account.providerId === "mock" || live) {
      const model = providerTestModels.find(
        (candidate) => candidate.id === modelId,
      );
      const taskId = `provider-test-${modelId}`;
      const prompt = `Provider test for ${modelName}`;
      const shape = model?.kind ?? supportedModelEntries[0]?.kind ?? "image";
      // The `asr` branch that stood here is gone with the kind. `asr` named a technique rather than
      // a thing produced -- every card carrying it produced text -- so the vocabulary is now the
      // four outputs, and this comparison had become one that can never be true.
      const testInput = providerTestInputSummary({
        shape,
        model: modelId,
        prompt,
        ...(shape === "image" || shape === "video"
          ? { aspectRatio: "16:9" }
          : {}),
        ...(shape === "video" || shape === "audio"
          ? { duration: shape === "video" ? 4 : 5 }
          : {}),
      });
      const testAigc =
        account.providerId === "mock"
          ? providerTestAigc
          : createMockExternalAigcService({
              fal: falMock,
              origin: "http://local-provider-test",
              providerAccounts: async () => [
                {
                  ...account,
                  configuredCredentials: [...credentialKeys],
                  availableOAuth: [...availableOAuth],
                  weight: account.weight ?? 10_000,
                },
              ],
              modelCards: async () => providerTestModels,
              providerPluginExecutor: options.providerPluginExecutor,
              resolveProviderPluginBinding: options.resolvePluginBinding
                ? (pluginId, exportId, kind) =>
                    options.resolvePluginBinding!(pluginId, exportId, kind)
                : undefined,
              localTts,
            });
      const providerName = displayProviderName(account);
      const explicitMockSelection =
        account.providerId === "mock"
          ? { modelParams: { provider_id: "mock" } }
          : {};
      try {
        if (account.providerId !== "mock") {
          if (!options.providerPluginExecutor || !testAigc.planProviderPlugin) {
            throw new Error(
              "The local durable Provider runtime is unavailable.",
            );
          }
          const requestedActionRunId =
            typeof body.actionRunId === "string" ? body.actionRunId.trim() : "";
          if (requestedActionRunId.length > 256) {
            return c.json(
              { error: "actionRunId must be at most 256 characters" },
              400,
            );
          }
          const actionRunId =
            requestedActionRunId || `provider-test:${randomUUID()}`;
          const commonInput: MockMediaGenerationInput = {
            taskId: actionRunId,
            projectId: "provider-test",
            prompt,
            model: modelId,
            ...(shape === "image" || shape === "video"
              ? { aspectRatio: testInput.aspectRatio }
              : {}),
            ...(shape === "video" || shape === "audio"
              ? { duration: testInput.duration }
              : {}),
          };
          const plan = await testAigc.planProviderPlugin(commonInput, shape);
          if (!plan) {
            throw new Error(
              `${providerName} has no executable Provider contract for ${modelName}.`,
            );
          }
          const durable = await waitForDurableProviderTest({
            journal: durableRunJournal,
            providerPluginExecutor: options.providerPluginExecutor,
            plan,
            actionRunId,
            outputSlot: shape === "text" ? "text" : "media",
            deadlineMs: providerGenerationDeadlineMs,
          });
          const output = providerTestExecutableOutput(
            shape,
            plan,
            durable.output,
          );
          return providerTestResponse({
            ok: true,
            ...baseResult,
            actionRunId,
            provider: plan.provider,
            modelEndpoint: plan.modelEndpoint,
            ...("requestId" in output && output.requestId
              ? { requestId: output.requestId }
              : {}),
            input: testInput,
            output,
            message: `${providerName} ran ${modelName} through ${plan.modelEndpoint}.`,
          } satisfies ModelProviderTestResult);
        }

        if (shape === "text") {
          const result = await testAigc.generateText({
            taskId,
            prompt,
            model: modelId,
            ...explicitMockSelection,
          });
          const output: ModelProviderTestOutputSummary = {
            shape: "text",
            ...(result.provider ? { provider: result.provider } : {}),
            ...(result.modelEndpoint ? { endpoint: result.modelEndpoint } : {}),
            text: result.text,
          };
          return providerTestResponse({
            ok: true,
            ...baseResult,
            ...(result.provider ? { provider: result.provider } : {}),
            ...(result.modelEndpoint
              ? { modelEndpoint: result.modelEndpoint }
              : {}),
            input: testInput,
            output,
            message: result.modelEndpoint
              ? `${providerName} ran ${modelName} through ${result.modelEndpoint}.`
              : `${providerName} ran ${modelName}.`,
          } satisfies ModelProviderTestResult);
        }

        const mediaShape =
          shape === "video" || shape === "audio" ? shape : "image";
        const generateMedia = (): Promise<MockMediaGenerationResult> => {
          const common = {
            taskId,
            prompt,
            model: modelId,
            ...explicitMockSelection,
          };
          return mediaShape === "video"
            ? testAigc.generateVideo({
                ...common,
                aspectRatio: testInput.aspectRatio,
                duration: testInput.duration,
              })
            : mediaShape === "audio"
              ? testAigc.generateAudio({
                  ...common,
                  duration: testInput.duration,
                })
              : testAigc.generateImage({
                  ...common,
                  aspectRatio: testInput.aspectRatio,
                });
        };
        const result = requireCompletedGeneration(await generateMedia());
        const output = providerTestMediaOutput(mediaShape, result);
        return providerTestResponse({
          ok: true,
          ...baseResult,
          ...(result.provider ? { provider: result.provider } : {}),
          ...("requestId" in result && result.requestId
            ? { requestId: result.requestId }
            : {}),
          ...(result.modelEndpoint
            ? { modelEndpoint: result.modelEndpoint }
            : {}),
          input: testInput,
          output,
          message: result.modelEndpoint
            ? `${providerName} ran ${modelName} through ${result.modelEndpoint}.`
            : `${providerName} ran ${modelName}.`,
        } satisfies ModelProviderTestResult);
      } catch (err) {
        return providerTestResponse({
          ok: false,
          ...baseResult,
          message: `${providerName} test failed for ${modelName}: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies ModelProviderTestResult);
      }
    }

    const providerName = displayProviderName(account);
    return providerTestResponse({
      ok: true,
      ...baseResult,
      message: `${providerName} configuration is ready for ${modelName}.`,
    } satisfies ModelProviderTestResult);
  });
  app.get("/api/v1/provider-usage", async (c) => {
    const parsedLimit = Number.parseInt(c.req.query("limit") ?? "100", 10);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 100;
    return c.json({ events: await db.listProviderUsageEvents(userId, limit) });
  });
  app.get("/api/v1/provider-oauth", async (c) => {
    const state = await db.load();
    return c.json({
      providers: state.providerOAuth
        .filter((record) => record.userId === userId)
        .sort(
          (a, b) =>
            a.providerId.localeCompare(b.providerId) ||
            (a.accountId ?? "").localeCompare(b.accountId ?? ""),
        )
        .map(publicProviderOAuthWithReadReceipt),
    });
  });
  app.post("/api/v1/provider-oauth/:providerId/import-local", async (c) => {
    const rawProviderId = c.req.param("providerId");
    const providerId = parseProviderOAuthId(rawProviderId);
    const envelope = {
      operation: "provider_oauth_import",
      entity: {
        kind: "provider-oauth",
        id: providerOAuthEntityId(rawProviderId),
      },
    };
    if (!providerId) {
      return c.json(
        {
          error: "Unsupported OAuth provider",
          mutation: hostMutationRejected(
            envelope,
            "Unsupported OAuth provider",
          ),
        },
        404,
      );
    }
    const declaredImport = await pluginLocalTokenImport(options, providerId);
    if (!declaredImport) {
      return c.json(
        {
          error: "Local token import is not configured for this provider",
          mutation: hostMutationRejected(
            envelope,
            "Local token import is not configured for this provider",
          ),
        },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      accountId?: unknown;
      accountLabel?: unknown;
    } & ProjectWriteBody;
    const accountId = stringBodyField(body.accountId);
    const accountLabel = stringBodyField(body.accountLabel);
    if (!accountId) {
      const message =
        "Local token import requires a Host-selected provider account.";
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(envelope, message),
        },
        400,
      );
    }
    const entityId = providerOAuthEntityId(providerId, accountId);
    const preconditions = requestProjectWritePreconditions(c, body);
    const beforeState = await db.load();
    const selectedAccount = beforeState.providerAccounts.find(
      (account) =>
        (account.userId ?? userId) === userId &&
        account.id === accountId &&
        account.providerId === providerId,
    );
    if (!selectedAccount) {
      const message = `Host-selected provider account ${accountId} is not available for ${providerId}.`;
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_import",
              entity: { kind: "provider-oauth", id: entityId },
            },
            message,
          ),
        },
        404,
      );
    }
    const beforeRecord = beforeState.providerOAuth.find((record) =>
      providerOAuthMatches(record, userId, providerId, accountId),
    );
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const hostMutation =
      beforeRecord && needsReadProof
        ? validateProviderOAuthReadMutation({
            record: beforeRecord,
            operation: "import",
            preconditions,
          })
        : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        { error: hostMutation.error, mutation: hostMutation.mutation },
        409,
      );
    }
    if (!beforeRecord && preconditions.expectedReadToken) {
      const message =
        "Provider OAuth record not found. Read /api/v1/provider-oauth first, then retry.";
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_import",
              entity: { kind: "provider-oauth", id: entityId },
              expectedReadToken: preconditions.expectedReadToken,
            },
            message,
          ),
        },
        409,
      );
    }
    let imported: { accessToken: string; importedFrom: string };
    try {
      imported = await importLocalProviderToken({
        auth: declaredImport.auth,
        applicationSupportRoot: options.localTokenImportAppDataRoot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_import",
              entity: { kind: "provider-oauth", id: entityId },
            },
            message,
          ),
        },
        422,
      );
    }
    const pluginStore = await pluginStoreForImport();
    await pluginStore.put({
      pluginId: declaredImport.pluginId,
      accountId,
      key: declaredImport.storeKey,
      value: imported.accessToken,
      secret: true,
    });
    const record = await db.update((state) =>
      upsertProviderOAuth(state, userId, providerId, {
        accountId,
        status: "authorized",
        accessToken: undefined,
        tokenType: "Bearer",
        accountLabel,
        refreshToken: undefined,
        verificationUri: undefined,
        userCode: undefined,
        deviceCode: undefined,
        oauthState: undefined,
        intervalSeconds: undefined,
        expiresAt: undefined,
        error: undefined,
      }),
    );
    const readToken = providerOAuthReceiptReadToken(record);
    const mutation = hostMutationSucceeded(
      hostMutation?.envelope ?? {
        operation: "provider_oauth_import",
        entity: { kind: "provider-oauth", id: entityId },
      },
      {
        resultEntityId: entityId,
        ...(hostMutation ? { afterReadToken: readToken } : {}),
      },
    );
    await db.appendMutationAudit(
      mutationAuditRecord({
        mutation,
        actorClientType: preconditions.actorClientType,
        reason: "provider OAuth local token import",
      }),
    );
    return c.json({
      ...publicProviderOAuth(record),
      importedFrom: imported.importedFrom,
      ...(hostMutation ? { readToken } : {}),
      mutation,
    });
  });
  app.post("/api/v1/provider-oauth/:providerId/start", async (c) => {
    const rawProviderId = c.req.param("providerId");
    const providerId = parseProviderOAuthId(rawProviderId);
    if (!providerId) {
      return c.json(
        {
          error: "Unsupported OAuth provider",
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_start",
              entity: {
                kind: "provider-oauth",
                id: providerOAuthEntityId(rawProviderId),
              },
            },
            "Unsupported OAuth provider",
          ),
        },
        404,
      );
    }
    const driver = options.providerOAuth?.[providerId];
    const browserAuth = driver
      ? null
      : await pluginBrowserOAuth(options, providerId);
    if (!driver && !browserAuth) {
      return c.json(
        {
          error: "Unsupported OAuth provider",
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_start",
              entity: {
                kind: "provider-oauth",
                id: providerOAuthEntityId(providerId),
              },
            },
            "Unsupported OAuth provider",
          ),
        },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      accountId?: unknown;
      accountLabel?: unknown;
    } & ProjectWriteBody;
    const accountId = stringBodyField(body.accountId);
    const accountLabel = stringBodyField(body.accountLabel);
    const preconditions = requestProjectWritePreconditions(c, body);
    const beforeState = await db.load();
    if (browserAuth?.pluginStore) {
      const selectedAccount = accountId
        ? beforeState.providerAccounts.find(
            (account) =>
              (account.userId ?? userId) === userId &&
              account.id === accountId &&
              account.providerId === providerId,
          )
        : undefined;
      if (!selectedAccount) {
        const message = accountId
          ? `Host-selected provider account ${accountId} is not available for ${providerId}.`
          : "Provider browser flow requires a Host-selected provider account.";
        return c.json(
          {
            error: message,
            mutation: hostMutationRejected(
              {
                operation: "provider_oauth_start",
                entity: {
                  kind: "provider-oauth",
                  id: providerOAuthEntityId(providerId, accountId),
                },
              },
              message,
            ),
          },
          accountId ? 404 : 400,
        );
      }
    }
    const beforeRecord = beforeState.providerOAuth.find((record) =>
      providerOAuthMatches(record, userId, providerId, accountId),
    );
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const hostMutation =
      beforeRecord && needsReadProof
        ? validateProviderOAuthReadMutation({
            record: beforeRecord,
            operation: "start",
            preconditions,
          })
        : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    if (!beforeRecord && preconditions.expectedReadToken) {
      const message =
        "Provider OAuth record not found. Read /api/v1/provider-oauth first, then retry.";
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_start",
              entity: {
                kind: "provider-oauth",
                id: providerOAuthEntityId(providerId, accountId),
              },
              expectedReadToken: preconditions.expectedReadToken,
            },
            message,
          ),
        },
        409,
      );
    }
    const started = driver
      ? await driver.start()
      : {
          verificationUri: browserAuth!.authorizationUrl,
          userCode: "",
          deviceCode: randomUUID(),
          oauthState: JSON.stringify({
            protocol: "clash.provider-oauth.browser/v1",
            auth: browserAuth!,
          } satisfies BrowserProviderOAuthState),
        };
    const record = await db.update((state) => {
      return upsertProviderOAuth(state, userId, providerId, {
        ...(accountId ? { accountId } : {}),
        status: "pending",
        verificationUri: started.verificationUri,
        userCode: started.userCode,
        deviceCode: started.deviceCode,
        oauthState: started.oauthState,
        expiresAt: started.expiresAt,
        intervalSeconds: started.intervalSeconds,
        accessToken: undefined,
        refreshToken: undefined,
        tokenType: undefined,
        accountLabel,
        error: undefined,
      });
    });
    const readToken = providerOAuthReceiptReadToken(record);
    const mutation = hostMutationSucceeded(
      hostMutation?.envelope ?? {
        operation: "provider_oauth_start",
        entity: {
          kind: "provider-oauth",
          id: providerOAuthEntityId(providerId, accountId),
        },
      },
      {
        resultEntityId: providerOAuthEntityId(providerId, accountId),
        ...(hostMutation ? { afterReadToken: readToken } : {}),
      },
    );
    await db.appendMutationAudit(
      mutationAuditRecord({
        mutation,
        actorClientType: preconditions.actorClientType,
        reason: "provider OAuth start",
      }),
    );
    return c.json({
      ...publicProviderOAuth(record),
      ...(browserAuth
        ? {
            flow: "browser",
            ...callbackDescription(browserAuth),
          }
        : {}),
      ...(hostMutation ? { readToken } : {}),
      mutation,
    });
  });
  app.post("/api/v1/provider-oauth/:providerId/complete", async (c) => {
    const rawProviderId = c.req.param("providerId");
    const providerId = parseProviderOAuthId(rawProviderId);
    if (!providerId) {
      return c.json(
        {
          error: "Unsupported OAuth provider",
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_complete",
              entity: {
                kind: "provider-oauth",
                id: providerOAuthEntityId(rawProviderId),
              },
            },
            "Unsupported OAuth provider",
          ),
        },
        404,
      );
    }
    const driver = options.providerOAuth?.[providerId];
    const browserAuth = driver
      ? null
      : await pluginBrowserOAuth(options, providerId);
    if (!driver && !browserAuth) {
      return c.json(
        {
          error: "Unsupported OAuth provider",
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_complete",
              entity: {
                kind: "provider-oauth",
                id: providerOAuthEntityId(providerId),
              },
            },
            "Unsupported OAuth provider",
          ),
        },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      accountId?: unknown;
      deviceCode?: unknown;
      callbackUrl?: unknown;
    } & ProjectWriteBody;
    const accountId = stringBodyField(body.accountId);
    const preconditions = requestProjectWritePreconditions(c, body);
    const initialState = await db.load();
    const existing = initialState.providerOAuth.find((record) =>
      providerOAuthMatches(record, userId, providerId, accountId),
    );
    const effectiveBrowserAuth = driver
      ? null
      : (parseBrowserProviderOAuthState(existing?.oauthState)?.auth ??
        browserAuth);
    if (effectiveBrowserAuth?.pluginStore) {
      const selectedAccount = accountId
        ? initialState.providerAccounts.find(
            (account) =>
              (account.userId ?? userId) === userId &&
              account.id === accountId &&
              account.providerId === providerId,
          )
        : undefined;
      if (!selectedAccount) {
        const message = accountId
          ? `Host-selected provider account ${accountId} is not available for ${providerId}.`
          : "Provider browser flow requires a Host-selected provider account.";
        return c.json(
          {
            error: message,
            mutation: hostMutationRejected(
              {
                operation: "provider_oauth_complete",
                entity: {
                  kind: "provider-oauth",
                  id: providerOAuthEntityId(providerId, accountId),
                },
              },
              message,
            ),
          },
          accountId ? 404 : 400,
        );
      }
    }
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const hostMutation =
      existing && needsReadProof
        ? validateProviderOAuthReadMutation({
            record: existing,
            operation: "complete",
            preconditions,
          })
        : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    if (!existing && needsReadProof) {
      const message =
        "Provider OAuth record not found. Read /api/v1/provider-oauth first, then retry.";
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_complete",
              entity: {
                kind: "provider-oauth",
                id: providerOAuthEntityId(providerId, accountId),
              },
              expectedReadToken: preconditions.expectedReadToken,
            },
            message,
          ),
        },
        409,
      );
    }
    const deviceCode =
      typeof body.deviceCode === "string" && body.deviceCode.trim()
        ? body.deviceCode.trim()
        : existing?.deviceCode;
    const callbackUrl = stringBodyField(body.callbackUrl);
    if (!deviceCode && !browserAuth) {
      return c.json(
        {
          error: "deviceCode is required",
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_complete",
              entity: {
                kind: "provider-oauth",
                id: providerOAuthEntityId(providerId, accountId),
              },
            },
            "deviceCode is required",
          ),
        },
        400,
      );
    }
    let completed: ProviderOAuthTokenResult;
    try {
      completed = driver
        ? await driver.complete({
            deviceCode: deviceCode!,
            ...(existing?.oauthState
              ? { oauthState: existing.oauthState }
              : {}),
          })
        : {
            accessToken: browserOAuthToken(
              callbackUrl ?? "",
              effectiveBrowserAuth!,
            ),
            tokenType: "Bearer",
            accountLabel: existing?.accountLabel,
          };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record = await db.update((state) => {
        return upsertProviderOAuth(state, userId, providerId, {
          ...(accountId ? { accountId } : {}),
          status: "error",
          accessToken: undefined,
          refreshToken: undefined,
          tokenType: undefined,
          error: message,
        });
      });
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? {
          operation: "provider_oauth_complete",
          entity: {
            kind: "provider-oauth",
            id: providerOAuthEntityId(providerId, accountId),
          },
        },
        {
          resultEntityId: providerOAuthEntityId(providerId, accountId),
          ...(hostMutation
            ? { afterReadToken: providerOAuthReceiptReadToken(record) }
            : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "provider OAuth complete",
        }),
      );
      return c.json(
        {
          error: message,
          mutation,
        },
        502,
      );
    }
    if (effectiveBrowserAuth?.pluginStore && !completed.availabilityError) {
      const pluginStore = await pluginStoreForImport();
      await pluginStore.put({
        pluginId: effectiveBrowserAuth.pluginStore.pluginId,
        accountId: accountId!,
        key: effectiveBrowserAuth.pluginStore.key,
        value: completed.accessToken,
        secret: true,
        ...(completed.expiresAt
          ? { expiresAt: Date.parse(completed.expiresAt) }
          : {}),
      });
    }
    const record = await db.update((state) => {
      return upsertProviderOAuth(state, userId, providerId, {
        ...(accountId ? { accountId } : {}),
        status: completed.availabilityError ? "error" : "authorized",
        accessToken: effectiveBrowserAuth?.pluginStore
          ? undefined
          : completed.accessToken,
        refreshToken: effectiveBrowserAuth?.pluginStore
          ? undefined
          : completed.refreshToken,
        tokenType: completed.tokenType,
        expiresAt: completed.expiresAt,
        accountLabel: completed.accountLabel,
        verificationUri: undefined,
        userCode: undefined,
        deviceCode: undefined,
        oauthState: undefined,
        intervalSeconds: undefined,
        error: completed.availabilityError,
      });
    });
    const readToken = providerOAuthReceiptReadToken(record);
    const mutation = hostMutationSucceeded(
      hostMutation?.envelope ?? {
        operation: "provider_oauth_complete",
        entity: {
          kind: "provider-oauth",
          id: providerOAuthEntityId(providerId, accountId),
        },
      },
      {
        resultEntityId: providerOAuthEntityId(providerId, accountId),
        ...(hostMutation ? { afterReadToken: readToken } : {}),
      },
    );
    await db.appendMutationAudit(
      mutationAuditRecord({
        mutation,
        actorClientType: preconditions.actorClientType,
        reason: "provider OAuth complete",
      }),
    );
    return c.json({
      ...publicProviderOAuth(record),
      ...(hostMutation ? { readToken } : {}),
      mutation,
    });
  });
  app.delete("/api/v1/provider-oauth/:providerId", async (c) => {
    const rawProviderId = c.req.param("providerId");
    const providerId = parseProviderOAuthId(rawProviderId);
    if (!providerId) {
      return c.json(
        {
          error: "Unsupported OAuth provider",
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_delete",
              entity: {
                kind: "provider-oauth",
                id: providerOAuthEntityId(rawProviderId),
              },
            },
            "Unsupported OAuth provider",
          ),
        },
        404,
      );
    }
    const accountId = stringBodyField(c.req.query("accountId"));
    const preconditions = requestProjectWritePreconditions(c);
    const beforeState = await db.load();
    const beforeRecord = beforeState.providerOAuth.find((record) =>
      providerOAuthMatches(record, userId, providerId, accountId),
    );
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const hostMutation =
      beforeRecord && needsReadProof
        ? validateProviderOAuthReadMutation({
            record: beforeRecord,
            operation: "delete",
            preconditions,
          })
        : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    if (!beforeRecord && needsReadProof) {
      const message =
        "Provider OAuth record not found. Read /api/v1/provider-oauth first, then retry.";
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            {
              operation: "provider_oauth_delete",
              entity: {
                kind: "provider-oauth",
                id: providerOAuthEntityId(providerId, accountId),
              },
              expectedReadToken: preconditions.expectedReadToken,
            },
            message,
          ),
        },
        409,
      );
    }
    await db.update((state) => {
      state.providerOAuth = state.providerOAuth.filter(
        (record) =>
          !providerOAuthMatches(record, userId, providerId, accountId),
      );
    });
    const mutation = hostMutationSucceeded(
      hostMutation?.envelope ?? {
        operation: "provider_oauth_delete",
        entity: {
          kind: "provider-oauth",
          id: providerOAuthEntityId(providerId, accountId),
        },
      },
      {
        resultEntityId: providerOAuthEntityId(providerId, accountId),
      },
    );
    await db.appendMutationAudit(
      mutationAuditRecord({
        mutation,
        actorClientType: preconditions.actorClientType,
        reason: "provider OAuth delete",
      }),
    );
    return c.json({
      ok: true,
      mutation,
    });
  });
  app.get("/api/v1/local/plugins", async (c) => {
    if (!options.pluginPackages) {
      return c.json(
        { error: "local plugin package management is unavailable" },
        503,
      );
    }
    return c.json(await options.pluginPackages.list());
  });
  app.post("/api/v1/local/plugins/validate", async (c) => {
    if (!options.pluginPackages) {
      return c.json(
        { error: "local plugin package management is unavailable" },
        503,
      );
    }
    try {
      return c.json(await options.pluginPackages.validate(await c.req.json()));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        422,
      );
    }
  });
  app.post("/api/v1/local/plugins/activate", async (c) => {
    if (!options.pluginPackages) {
      return c.json(
        { error: "local plugin package management is unavailable" },
        503,
      );
    }
    try {
      return c.json(await options.pluginPackages.activate(await c.req.json()));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        422,
      );
    }
  });
  app.get("/api/v1/local/plugins/:id/package", async (c) => {
    if (!options.pluginPackages) {
      return c.json(
        { error: "local plugin package management is unavailable" },
        503,
      );
    }
    try {
      return c.json(await options.pluginPackages.read(c.req.param("id")));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        { error: message },
        /ENOENT|not found/i.test(message) ? 404 : 409,
      );
    }
  });
  app.post("/api/v1/local/plugins/:id/rollback", async (c) => {
    if (!options.pluginPackages) {
      return c.json(
        { error: "local plugin package management is unavailable" },
        503,
      );
    }
    try {
      return c.json(await options.pluginPackages.rollback(c.req.param("id")));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        { error: message },
        /No rollback version/i.test(message) ? 404 : 409,
      );
    }
  });
  app.delete("/api/v1/local/plugins/:id", async (c) => {
    if (!options.pluginPackages) {
      return c.json(
        { error: "local plugin package management is unavailable" },
        503,
      );
    }
    try {
      return c.json(await options.pluginPackages.remove(c.req.param("id")));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        422,
      );
    }
  });
  app.get("/api/v1/plugin-actions", async (c) => {
    const registrations = options.listPluginCards
      ? await options.listPluginCards()
      : [];
    return c.json({
      actions: executablePluginActionDefinitions(registrations),
    });
  });
  app.get("/api/v1/plugin-views", async (c) => {
    const registrations = options.listPluginViews
      ? await options.listPluginViews()
      : [];
    return c.json({
      views: registrations.map((registration) => ({
        pluginId: registration.pluginId,
        version: registration.version,
        schemaHash: registration.schemaHash,
        ...registration.document.spec,
      })),
    });
  });
  app.get("/api/v1/plugin-providers", async (c) => {
    const registrations = options.listPluginProviders
      ? await options.listPluginProviders()
      : [];
    return c.json({
      providers: registrations.map((registration) => ({
        pluginId: registration.pluginId,
        pluginVersion: registration.version,
        schemaHash: registration.schemaHash,
        ...registration.document.spec,
      })),
    });
  });
  app.get("/api/v1/models/catalog", async (c) => {
    const state = await db.load();
    const configuredProviders = publicProviderAccounts(
      state.providerAccounts,
      userId,
      state.providerOAuth,
    );
    const entries = listModelCatalogEntries({
      models: await effectiveModelCards(
        state,
        userId,
        options.listPluginCards,
        options.listPluginModelBindings,
      ),
      configuredProviders,
    });
    const models = await Promise.all(
      entries.map(async (entry) => {
        const route = entry.selectedRoute;
        const localCapability =
          route?.apiShape === "local-asr"
            ? "speech-to-text"
            : route?.apiShape === "local-tts"
              ? "text-to-speech"
              : undefined;
        const runtimeStatus =
          localCapability && route
            ? await audioConfig.getModelStatus({
                capability: localCapability,
                model: route.upstreamModel,
              })
            : undefined;
        const entryWithReadiness = runtimeStatus
          ? {
              ...entry,
              runtimeReadiness: {
                capability: runtimeStatus.capability,
                model: runtimeStatus.model,
                readiness: runtimeStatus.available
                  ? ("ready" as const)
                  : ("not-installed" as const),
                executable: runtimeStatus.available,
                ...(runtimeStatus.message
                  ? { message: runtimeStatus.message }
                  : {}),
              },
            }
          : entry;
        if (!options.resolvePluginBinding) {
          return entryWithReadiness;
        }
        const routes = await Promise.all(
          entry.routes.map(async (candidate) => {
            const projectorBinding =
              candidate.projectorPluginId && candidate.projectorExportId
                ? await options.resolvePluginBinding!(
                    candidate.projectorPluginId,
                    candidate.projectorExportId,
                    "provider-projector",
                  )
                : undefined;
            const executorBinding =
              candidate.executorPluginId && candidate.executorExportId
                ? await options.resolvePluginBinding!(
                    candidate.executorPluginId,
                    candidate.executorExportId,
                    "provider-executor",
                  )
                : undefined;
            return {
              ...candidate,
              ...(projectorBinding ? { projectorBinding } : {}),
              ...(executorBinding ? { executorBinding } : {}),
            };
          }),
        );
        const selectedRouteIndex = route ? entry.routes.indexOf(route) : -1;
        return {
          ...entryWithReadiness,
          selectedRoute:
            selectedRouteIndex >= 0
              ? (routes[selectedRouteIndex] ?? null)
              : null,
          routes,
        };
      }),
    );
    return c.json({ models });
  });
  app.put("/api/v1/model-cards/:modelId", async (c) => {
    const modelId = c.req.param("modelId").trim();
    const body = await c.req.json().catch(() => null);
    const state = await db.load();
    const builtInModelIds = new Set(
      (
        await effectiveModelCards(
          state,
          userId,
          options.listPluginCards,
          options.listPluginModelBindings,
        )
      ).map((model) => model.id),
    );
    const config = normalizeModelCardConfigInput(
      modelId,
      body,
      state.providerAccounts.filter(
        (account) => (account.userId ?? userId) === userId,
      ),
      builtInModelIds,
    );
    if (!config) return c.json({ error: "Invalid model card config" }, 400);
    const now = nowIso();
    const saved = await db.update((current) => {
      const previous = current.modelCardConfigs.find(
        (candidate) =>
          (candidate.userId ?? userId) === userId &&
          candidate.modelId === modelId,
      );
      const next: LocalUserModelCardConfig = {
        ...config,
        userId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      current.modelCardConfigs = [
        ...current.modelCardConfigs.filter(
          (candidate) =>
            (candidate.userId ?? userId) !== userId ||
            candidate.modelId !== modelId,
        ),
        next,
      ];
      return next;
    });
    const { userId: _savedUserId, ...publicConfig } = saved;
    return c.json({ config: publicConfig });
  });
  app.delete("/api/v1/model-cards/:modelId", async (c) => {
    const modelId = c.req.param("modelId").trim();
    const state = await db.load();
    const existing = state.modelCardConfigs.find(
      (candidate) =>
        (candidate.userId ?? userId) === userId &&
        candidate.modelId === modelId,
    );
    if (!existing) return c.json({ error: "Model card config not found" }, 404);
    await db.update((current) => {
      current.modelCardConfigs = current.modelCardConfigs.filter(
        (candidate) =>
          (candidate.userId ?? userId) !== userId ||
          candidate.modelId !== modelId,
      );
    });
    return new Response(null, { status: 204 });
  });
  app.get("/api/marketplace/registry", (c) =>
    c.json({
      version: 1,
      actions: options.marketplaceActions ?? [],
      skills: options.marketplaceSkills ?? [],
      plugins: options.marketplacePlugins ?? [],
    }),
  );
  app.get("/api/marketplace/feed", (c) =>
    c.json({
      version: 1,
      featuredPlugins: options.marketplaceFeed ?? [],
    }),
  );
  if (options.installMarketplaceAction) {
    app.post("/api/marketplace/actions/:packageId/install", async (c) => {
      const packageId = c.req.param("packageId");
      const item = options.marketplaceActions?.find(
        (candidate) => candidate.packageId === packageId,
      );
      if (!item)
        return c.json(
          { error: "Unknown local marketplace action package" },
          404,
        );
      return c.json(await options.installMarketplaceAction!(packageId));
    });
  }
  if (options.uninstallMarketplaceAction) {
    app.delete("/api/marketplace/actions/:packageId/install", async (c) => {
      const item = options.marketplaceActions?.find(
        (candidate) => candidate.packageId === c.req.param("packageId"),
      );
      if (!item)
        return c.json(
          { error: "Unknown local marketplace action package" },
          404,
        );
      try {
        await options.uninstallMarketplaceAction!(item.id);
        return new Response(null, { status: 204 });
      } catch (error) {
        return immutableMarketplaceActionErrorResponse(c, error);
      }
    });
  }
  if (options.installMarketplaceSkill) {
    app.post("/api/marketplace/skills/:skillId/install", async (c) => {
      const skillId = c.req.param("skillId");
      const item = options.marketplaceSkills?.find(
        (candidate) => candidate.id === skillId,
      );
      if (!item)
        return c.json({ error: "Unknown local marketplace skill" }, 404);
      return c.json(await options.installMarketplaceSkill!(skillId));
    });
  }
  if (options.uninstallMarketplaceSkill) {
    app.delete("/api/marketplace/skills/:skillId/install", async (c) => {
      const skillId = c.req.param("skillId");
      const item = options.marketplaceSkills?.find(
        (candidate) => candidate.id === skillId,
      );
      if (!item)
        return c.json({ error: "Unknown local marketplace skill" }, 404);
      await options.uninstallMarketplaceSkill!(skillId);
      return new Response(null, { status: 204 });
    });
  }
  if (options.installMarketplacePlugin) {
    app.post("/api/marketplace/plugins/:packageId/install", async (c) => {
      const packageId = c.req.param("packageId");
      const item = options.marketplacePlugins?.find(
        (candidate) => candidate.packageId === packageId,
      );
      if (!item) {
        return c.json({ error: "Unknown local marketplace plugin" }, 404);
      }
      return c.json(await options.installMarketplacePlugin!(packageId));
    });
  }
  if (options.uninstallMarketplacePlugin) {
    app.delete("/api/marketplace/plugins/:packageId/install", async (c) => {
      const item = options.marketplacePlugins?.find(
        (candidate) => candidate.packageId === c.req.param("packageId"),
      );
      if (!item) {
        return c.json({ error: "Unknown local marketplace plugin" }, 404);
      }
      await options.uninstallMarketplacePlugin!(item.id);
      return new Response(null, { status: 204 });
    });
  }
  app.get("/api/v1/local/sync", async (c) =>
    c.json(publicLocalSyncConfig(await localSyncReadState(syncConfig))),
  );
  app.patch("/api/v1/local/sync", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const envelope = {
      operation: "local_sync_config_update",
      entity: { kind: "local-config", id: "sync" },
    };
    const preconditions = requestProjectWritePreconditions(c, body);
    const beforeReadState = await localSyncReadState(syncConfig);
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const hostMutation = needsReadProof
      ? validateLocalSyncConfigMutation({
          readState: beforeReadState,
          preconditions,
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    try {
      await syncConfig.updateFromRequest(body);
      const readState = await localSyncReadState(syncConfig);
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? envelope,
        {
          resultEntityId: "sync",
          ...(hostMutation
            ? {
                afterReadToken: localConfigReceiptReadToken({
                  id: "sync",
                  config: localSyncConfigReadProjection(readState),
                  updatedAt: readState.updated_at,
                }),
              }
            : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "local sync config update",
        }),
      );
      return c.json({
        ...publicLocalSyncConfig(readState),
        mutation,
      });
    } catch (error) {
      if (error instanceof LocalSyncConfigError) {
        return c.json(
          {
            error: error.message,
            mutation: hostMutationRejected(
              hostMutation?.envelope ?? envelope,
              error.message,
            ),
          },
          error.status as 400,
        );
      }
      throw error;
    }
  });
  app.get("/api/v1/local/public-storage", async (c) =>
    c.json(await publicAssetStorage.getPublicConfig()),
  );
  app.patch("/api/v1/local/public-storage", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    try {
      return c.json(await publicAssetStorage.updateFromRequest(body));
    } catch (error) {
      if (error instanceof PublicAssetStorageConfigError) {
        return c.json({ error: error.message }, error.status as 400 | 409);
      }
      throw error;
    }
  });
  app.post("/api/v1/local/public-storage/test", async (c) => {
    try {
      await publicAssetStorage.testConnection();
      return c.json({ ok: true as const });
    } catch (error) {
      const status =
        error instanceof PublicAssetStorageConfigError ? error.status : 502;
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        status as 400 | 409 | 502,
      );
    }
  });
  app.get("/api/v1/local/media-analysis", async (c) => {
    const sourceKind = c.req.query("sourceKind") ?? "image";
    if (
      sourceKind !== "image" &&
      sourceKind !== "video" &&
      sourceKind !== "audio"
    ) {
      return c.json(
        { error: "sourceKind must be image, video, or audio" },
        400,
      );
    }
    const [config, modelOptions, definitions] = await Promise.all([
      mediaAnalysisConfig.get(),
      mediaAnalysisConfig.modelOptions(sourceKind as MediaAnalysisSourceKind),
      options.listPluginGenerators?.() ?? Promise.resolve([]),
    ]);
    const action = definitions
      .flatMap((entry) => entry.document.spec.actions)
      .find(
        (candidate) =>
          candidate.modelConsumer?.semanticShape === "media_analysis",
      );
    const categoryOptions =
      action?.outputs.map((output) => ({
        id: output.slot,
        title: output.title ?? output.slot,
        sourceMediaKinds: output.sourceMediaKinds ?? [],
      })) ?? [];
    return c.json({ ...config, modelOptions, categoryOptions });
  });

  app.put("/api/v1/local/media-analysis", async (c) => {
    try {
      const input = (await c.req.json()) as Record<string, unknown>;
      const allowedCategories = input.allowedCategories;
      if (
        allowedCategories !== undefined &&
        allowedCategories !== null &&
        (!Array.isArray(allowedCategories) ||
          !allowedCategories.every((category) => typeof category === "string"))
      ) {
        throw new Error("allowedCategories must be a string list or null");
      }
      let video: LocalMediaAnalysisConfig["video"] | undefined;
      if (input.video !== undefined) {
        if (
          !isRecord(input.video) ||
          !isRecord(input.video.boundaryRefinement)
        ) {
          throw new Error("video and video.boundaryRefinement must be objects");
        }
        const refinement = input.video.boundaryRefinement;
        if (
          typeof input.video.fps !== "number" ||
          (input.video.mediaResolution !== "low" &&
            input.video.mediaResolution !== "medium" &&
            input.video.mediaResolution !== "high") ||
          typeof refinement.enabled !== "boolean" ||
          typeof refinement.fps !== "number" ||
          typeof refinement.safetyMarginSeconds !== "number"
        ) {
          throw new Error("video analysis settings have invalid field types");
        }
        video = {
          fps: input.video.fps,
          mediaResolution: input.video.mediaResolution,
          boundaryRefinement: {
            enabled: refinement.enabled,
            fps: refinement.fps,
            safetyMarginSeconds: refinement.safetyMarginSeconds,
          },
        };
      }
      const config = await mediaAnalysisConfig.update({
        ...(typeof input.videoEnabled === "boolean"
          ? { videoEnabled: input.videoEnabled }
          : {}),
        ...(input.modelId === null || typeof input.modelId === "string"
          ? { modelId: input.modelId }
          : {}),
        ...(allowedCategories === null || Array.isArray(allowedCategories)
          ? { allowedCategories: allowedCategories as string[] | null }
          : {}),
        ...(video ? { video } : {}),
      });
      return c.json(config);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  app.get("/api/v1/local/audio", async (c) =>
    c.json(publicLocalAudioConfig(await localAudioReadState(audioConfig))),
  );

  // Rebuildable query projection over typed metadata attachments. The owning
  // ProjectAsset or ActionRevision remains authoritative; this route neither
  // creates a second authority nor accepts storage topology as target identity.
  app.put("/api/v1/local/asset-metadata", async (c) => {
    let attachment: ReturnType<typeof parseAssetMetadataFillAction>;
    try {
      attachment = parseAssetMetadataFillAction(
        await c.req.json().catch(() => null),
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
    const identity = attachment.metadata;
    await db.upsertMetadataAttachmentIndex({
      target: attachment.target,
      metadataKind: attachment.metadataKind,
      ...(typeof identity.schemaVersion === "number"
        ? { schemaVersion: identity.schemaVersion }
        : {}),
      ...(typeof identity.contentHash === "string"
        ? { contentHash: identity.contentHash }
        : {}),
      ...(typeof identity.bodyHash === "string"
        ? { bodyHash: identity.bodyHash }
        : {}),
      producer: attachment.producer,
      ...(identity.summary === undefined ? {} : { summary: identity.summary }),
      identity,
    });
    return c.json({
      recorded: true,
      authority: "projection-index" as const,
      target: attachment.target,
      metadataKind: attachment.metadataKind,
    });
  });

  app.get("/api/v1/local/asset-metadata", async (c) => {
    const targetKind = c.req.query("targetKind");
    const projectId = c.req.query("projectId");
    const assetId = c.req.query("assetId");
    const actionId = c.req.query("actionId");
    const actionRevisionId = c.req.query("actionRevisionId");
    let target:
      ReturnType<typeof MetadataAttachmentTargetSchema.parse> | undefined;
    if (targetKind || assetId || actionId || actionRevisionId) {
      try {
        target = MetadataAttachmentTargetSchema.parse(
          targetKind === "project-asset"
            ? { kind: targetKind, projectId, assetId }
            : targetKind === "action-revision"
              ? { kind: targetKind, projectId, actionId, actionRevisionId }
              : null,
        );
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          400,
        );
      }
    }
    const rows = await db.listMetadataAttachmentIndex({
      ...(target ? { target } : {}),
      ...(targetKind === "project-asset" || targetKind === "action-revision"
        ? { targetKind }
        : {}),
      ...(c.req.query("kind") ? { metadataKind: c.req.query("kind") } : {}),
      ...(projectId ? { projectId } : {}),
    });
    return c.json({ metadata: rows });
  });
  const resolveVoiceInputRoute = async () => {
    const resolvedSelection = audioConfig.getVoiceInputSelection
      ? await audioConfig.getVoiceInputSelection()
      : await audioConfig.getPublicConfig().then(({ asr }) => ({
          enabled: asr.enabled,
          model: asr.model,
        }));
    if (!resolvedSelection.enabled) return { resolvedSelection };
    const state = await db.load();
    const configuredProviders = publicProviderAccounts(
      state.providerAccounts,
      userId,
      state.providerOAuth,
    );
    const entry = listModelCatalogEntries({
      models: await effectiveModelCards(
        state,
        userId,
        options.listPluginCards,
        options.listPluginModelBindings,
      ),
      configuredProviders,
    }).find((candidate) => candidate.model.id === resolvedSelection.model);
    const route =
      entry?.selectedRoute ??
      entry?.routes.find((candidate) => candidate.apiShape === "local-asr");
    const isCloudReady =
      !!entry &&
      entry.model.kind === "text" &&
      (entry.model.input.promptModalities.includes("audio") ||
        !!entry.model.input.inputMode.audios) &&
      !!entry.selectedRoute &&
      entry.missingCredentials.length === 0 &&
      entry.tier === "available";
    return { resolvedSelection, entry, route, isCloudReady };
  };
  app.get("/api/v1/local/audio/voice-input", async (c) => {
    const { resolvedSelection, route, isCloudReady } =
      await resolveVoiceInputRoute();
    if (!resolvedSelection.enabled) {
      return c.json({
        asr: {
          enabled: false,
          provider: "global-model",
          model: resolvedSelection.model,
          ready: false,
          setup: {
            provider: "global-model",
            runtime: "provider-route",
            status: "disabled",
            available: false,
            default_base_url: null,
            commands: [],
          },
        },
      });
    }
    if (isCloudReady) {
      return c.json({
        asr: {
          enabled: true,
          provider: route?.upstreamId ?? "global-model",
          model: resolvedSelection.model,
          ready: true,
          setup: {
            provider: route?.upstreamId ?? "global-model",
            runtime: "provider-route",
            status: "ready",
            available: true,
            default_base_url: null,
            commands: [],
          },
        },
      });
    }
    if (c.req.query("probe") === "false") {
      return c.json({
        asr: {
          enabled: true,
          provider: "local",
          model: resolvedSelection.model,
          ready: false,
          setup: {
            provider: "local",
            runtime: "builtin-rpc",
            status: "needs-install",
            available: false,
            default_base_url: null,
            commands: [],
          },
        },
      });
    }
    if (audioConfig.getVoiceInputConfig) {
      return c.json(await audioConfig.getVoiceInputConfig());
    }
    const { asr } = await audioConfig.getPublicConfig();
    return c.json({ asr });
  });
  app.post("/api/v1/local/audio/voice-input/warmup", async (c) => {
    const { resolvedSelection, route, isCloudReady } =
      await resolveVoiceInputRoute();
    if (!resolvedSelection.enabled) {
      return c.json({ status: "disabled", runtime: "provider-route" }, 409);
    }
    if (isCloudReady) {
      return c.json({ status: "not-needed", runtime: "provider-route" });
    }
    if (!audioConfig.warmupVoiceInput) {
      return c.json({ status: "unsupported", runtime: "builtin-rpc" }, 501);
    }
    const model =
      route?.apiShape === "local-asr" && route.upstreamModel
        ? route.upstreamModel
        : resolvedSelection.model;
    void audioConfig.warmupVoiceInput({ model }).catch((error) => {
      console.warn(
        "[local-api] Voice input warmup degraded:",
        errorMessage(error),
      );
    });
    return c.json({ status: "warming", runtime: "builtin-rpc", model }, 202);
  });
  app.get("/api/v1/local/audio/models/status", async (c) => {
    try {
      const status = await audioConfig.getModelStatus({
        capability: c.req.query("capability"),
        model: c.req.query("model"),
      });
      const readState = await localAudioReadState(audioConfig);
      return c.json({
        ...status,
        readiness: status.available ? "ready" : "not-installed",
        readToken: localAudioReceiptReadToken(readState),
      });
    } catch (error) {
      if (error instanceof LocalAudioConfigError) {
        return c.json({ error: error.message }, error.status as 400);
      }
      throw error;
    }
  });
  app.patch("/api/v1/local/audio", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const envelope = {
      operation: "local_audio_config_update",
      entity: { kind: "local-config", id: "audio" },
    };
    const preconditions = requestProjectWritePreconditions(c, body);
    const beforeReadState = await localAudioReadState(audioConfig);
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const hostMutation = needsReadProof
      ? validateLocalAudioConfigMutation({
          readState: beforeReadState,
          preconditions,
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    try {
      await audioConfig.updateFromRequest(body);
      const readState = await localAudioReadState(audioConfig);
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? envelope,
        {
          resultEntityId: "audio",
          ...(hostMutation
            ? {
                afterReadToken: localAudioReceiptReadToken(readState),
              }
            : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "local audio config update",
        }),
      );
      return c.json({
        ...publicLocalAudioConfig(readState),
        mutation,
      });
    } catch (error) {
      if (error instanceof LocalAudioConfigError) {
        return c.json(
          {
            error: error.message,
            mutation: hostMutationRejected(
              hostMutation?.envelope ?? envelope,
              error.message,
            ),
          },
          error.status as 400,
        );
      }
      throw error;
    }
  });
  app.post("/api/v1/local/audio/install", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    > &
      ProjectWriteBody;
    const envelope = {
      operation: "local_audio_model_install",
      entity: { kind: "local-config", id: "audio" },
    };
    const preconditions = requestProjectWritePreconditions(c, body);
    const beforeReadState = await localAudioReadState(audioConfig);
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const hostMutation = needsReadProof
      ? validateLocalAudioInstallMutation({
          readState: beforeReadState,
          preconditions,
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    try {
      await audioConfig.installBuiltin({
        capability: body.capability,
        model: body.model ?? body.asr_model,
      });
      const readState = await localAudioReadState(audioConfig);
      const readToken = localAudioReceiptReadToken(readState);
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? envelope,
        {
          resultEntityId: "audio",
          ...(hostMutation ? { afterReadToken: readToken } : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "local audio model install",
        }),
      );
      return c.json({
        ...publicLocalAudioConfig(readState),
        mutation,
      });
    } catch (error) {
      if (error instanceof LocalAudioConfigError) {
        return c.json(
          {
            error: error.message,
            mutation: hostMutationRejected(
              hostMutation?.envelope ?? envelope,
              error.message,
            ),
          },
          error.status as 400,
        );
      }
      throw error;
    }
  });
  app.post("/api/v1/local/audio/remove", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    > &
      ProjectWriteBody;
    const envelope = {
      operation: "local_audio_model_remove",
      entity: { kind: "local-config", id: "audio" },
    };
    const preconditions = requestProjectWritePreconditions(c, body);
    const beforeReadState = await localAudioReadState(audioConfig);
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const hostMutation = needsReadProof
      ? validateLocalAudioRemoveMutation({
          readState: beforeReadState,
          preconditions,
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    try {
      await audioConfig.removeBuiltin({
        capability: body.capability,
        model: body.model ?? body.asr_model,
      });
      const readState = await localAudioReadState(audioConfig);
      const readToken = localAudioReceiptReadToken(readState);
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? envelope,
        {
          resultEntityId: "audio",
          ...(hostMutation ? { afterReadToken: readToken } : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "local audio model remove",
        }),
      );
      return c.json({
        ...publicLocalAudioConfig(readState),
        mutation,
      });
    } catch (error) {
      if (error instanceof LocalAudioConfigError) {
        return c.json(
          {
            error: error.message,
            mutation: hostMutationRejected(
              hostMutation?.envelope ?? envelope,
              error.message,
            ),
          },
          error.status as 400,
        );
      }
      throw error;
    }
  });
  app.post("/api/v1/local/audio/transcriptions", async (c) => {
    const envelope = localMutationEnvelope(
      "local_audio_transcription",
      "local-action",
      "audio-transcription",
    );
    const form = await c.req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return c.json(
        {
          error: "Missing file",
          mutation: hostMutationRejected(envelope, "Missing file"),
        },
        400,
      );
    }
    const language = form.get("language");
    try {
      const selection = audioConfig.getVoiceInputSelection
        ? await audioConfig.getVoiceInputSelection()
        : await audioConfig.getPublicConfig().then(({ asr }) => ({
            enabled: asr.enabled,
            model: asr.model,
          }));
      if (!selection.enabled) {
        throw new LocalAudioConfigError(
          "Voice input is not enabled. Open Settings > Voice input and enable it.",
          409,
        );
      }
      const state = await db.load();
      const catalog = listModelCatalogEntries({
        models: await effectiveModelCards(
          state,
          userId,
          options.listPluginCards,
          options.listPluginModelBindings,
        ),
        configuredProviders: publicProviderAccounts(
          state.providerAccounts,
          userId,
          state.providerOAuth,
        ),
      });
      const entry = catalog.find(
        (candidate) => candidate.model.id === selection.model,
      );
      const localRoute = entry?.routes.find(
        (route) => route.apiShape === "local-asr",
      );
      const acceptsAudio =
        !!entry &&
        (entry.model.input.promptModalities.includes("audio") ||
          !!entry.model.input.inputMode.audios);

      const result =
        entry?.model.kind === "text" && acceptsAudio
          ? await (async () => {
              if (
                !entry.selectedRoute ||
                entry.missingCredentials.length > 0 ||
                entry.tier !== "available"
              ) {
                throw new LocalAudioConfigError(
                  "The selected voice input model is not configured. Open Settings > Models and configure a provider.",
                  409,
                );
              }
              const taskId = randomUUID();
              const projectId = "local";
              const mediaType = normalizeProviderReferenceMediaType(
                file.type || "application/octet-stream",
              );
              const stagedReference = await providerReferenceAssets.stage({
                projectId,
                taskId,
                slot: "input:audio:0",
                pluginId: "clash.host",
                pluginVersion: "1.0.0",
                invocationId: taskId,
                kind: "audio",
                mediaType,
                bytes: new Uint8Array(await file.arrayBuffer()),
              });
              const generated = await voiceInputAigc.generateText({
                taskId,
                projectId,
                prompt:
                  typeof language === "string" && language.trim()
                    ? `Transcribe the attached audio verbatim in ${language.trim()}. Return only the transcript.`
                    : "Transcribe the attached audio verbatim. Return only the transcript.",
                model: entry.model.id,
                modelParams: { require_real_provider: true },
                references: [
                  {
                    slot: "audio",
                    index: 0,
                    asset: {
                      assetId: stagedReference.projectAssetId,
                      uri: `clash-asset://${stagedReference.projectAssetId}`,
                      kind: "audio",
                      ...(stagedReference.mediaType
                        ? { mediaType: stagedReference.mediaType }
                        : {}),
                    },
                  },
                ],
              });
              const text = generated.text.trim();
              if (!text)
                throw new LocalAudioConfigError(
                  "The selected voice input model returned an empty transcript.",
                  502,
                );
              return {
                schemaVersion: 1 as const,
                kind: "clash.asr.timed-transcript" as const,
                timebase: "milliseconds" as const,
                alignment: "word" as const,
                text,
                backendId: generated.provider ?? entry.selectedRoute.upstreamId,
                modelId: entry.model.id,
                ...(typeof language === "string" && language.trim()
                  ? { language: language.trim() }
                  : {}),
                durationMs: 1,
                words: [{ id: "word-000001", text, startMs: 0, endMs: 1 }],
                segments: [
                  {
                    id: "segment-000001",
                    text,
                    startMs: 0,
                    endMs: 1,
                    wordIds: ["word-000001"],
                  },
                ],
              };
            })()
          : await audioConfig.transcribe({
              file,
              language: typeof language === "string" ? language : null,
              ...(localRoute?.upstreamModel
                ? { model: localRoute.upstreamModel }
                : {}),
            });
      const mutation = hostMutationSucceeded(envelope, {
        resultEntityId: "audio-transcription",
      });
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          reason: "local audio transcription",
        }),
      );
      return c.json({
        ...result,
        mutation,
      });
    } catch (error) {
      if (error instanceof LocalAudioConfigError) {
        return c.json(
          {
            error: error.message,
            mutation: hostMutationRejected(envelope, error.message),
          },
          error.status as 400,
        );
      }
      throw error;
    }
  });
  app.post("/api/v1/local/audio/speech", async (c) => {
    const envelope = localMutationEnvelope(
      "local_audio_synthesis",
      "local-action",
      "audio-synthesis",
    );
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const model = typeof body.model === "string" ? body.model : "";
    const text = typeof body.text === "string" ? body.text : "";
    const voice = typeof body.voice === "string" ? body.voice : null;
    const speed = typeof body.speed === "number" ? body.speed : undefined;
    try {
      const result = await audioConfig.synthesize({
        model,
        text,
        voice,
        speed,
      });
      const mutation = hostMutationSucceeded(envelope, {
        resultEntityId: "audio-synthesis",
      });
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          reason: "local audio synthesis",
        }),
      );
      const headers = new Headers({
        "content-type": "audio/wav",
        "content-disposition": 'inline; filename="clash-local-speech.wav"',
        "x-clash-tts-backend": result.metadata.backendId,
        "x-clash-tts-model": result.metadata.modelId,
        "x-clash-tts-duration-ms": String(result.metadata.durationMs),
        "x-clash-tts-sample-rate": String(result.metadata.sampleRate),
      });
      if (result.metadata.voiceId) {
        headers.set("x-clash-tts-voice", result.metadata.voiceId);
      }
      const wavBuffer = new ArrayBuffer(result.audio.byteLength);
      new Uint8Array(wavBuffer).set(result.audio);
      return new Response(wavBuffer, {
        status: 200,
        headers,
      });
    } catch (error) {
      if (error instanceof LocalAudioConfigError) {
        return c.json(
          {
            error: error.message,
            mutation: hostMutationRejected(envelope, error.message),
          },
          error.status as 400,
        );
      }
      throw error;
    }
  });
  app.get("/api/v1/agents", async (c) => {
    const agentMembers = localAgentMembersForRead(await db.load(), userId);

    const runtime = await localRuntimeSummary(options);
    return c.json({
      agents: agentMembers.map((member) => ({
        id: member.id,
        user_id: member.user_id,
        template_id: member.template_id,
        runtime_id: member.runtime_id,
        agent_id: member.agent_id,
        display_name: member.display_name,
        created_at: member.created_at,
        runtime_label: runtime.label,
        runtime_status: runtime.status,
        runtime_agents: runtime.agents,
        budget_credits: null,
        budget_period: "unlimited",
        budget_used: 0,
        budget_reset_at: null,
      })),
    });
  });
  app.all("/fal/*", (c) => handleFalMockHttpRequest(falMock, c.req.raw));
  app.get("/api/v1/runtimes", async (c) => {
    if (!options.localAcp) return json({ runtimes: [] });
    if (c.req.query("readiness") !== "snapshot") {
      await options.localAcpReady;
    }
    const rawProbe = c.req.query("probe");
    const probe =
      rawProbe === "1" || rawProbe === "true"
        ? true
        : rawProbe === "auth" || rawProbe === "config" || rawProbe === "none"
          ? rawProbe
          : false;
    const refresh =
      c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
    return json(await options.localAcp.listRuntimes({ probe, refresh }));
  });

  app.get("/api/v1/local/harnesses", async (c) => {
    if (!options.localAcp?.listHarnesses) {
      const result = { harnesses: [] };
      return c.json({
        ...result,
        readToken: localHarnessesReceiptReadToken(result),
      });
    }
    await options.localAcpReady;
    const rawProbe = c.req.query("probe");
    const probe =
      rawProbe === "1" || rawProbe === "true"
        ? "auth"
        : rawProbe === "auth" || rawProbe === "config" || rawProbe === "none"
          ? rawProbe
          : false;
    const refresh =
      c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
    const result = await options.localAcp.listHarnesses({ probe, refresh });
    return c.json({
      ...result,
      readToken: localHarnessesReceiptReadToken(result),
    });
  });

  app.put("/api/v1/local/harnesses", async (c) => {
    const envelope = localMutationEnvelope(
      "local_harness_enablement_update",
      "local-harness-config",
      "enabled",
    );
    if (!options.localAcp?.updateHarnesses) {
      return c.json(
        {
          error: "Local harness settings unavailable",
          mutation: hostMutationRejected(
            envelope,
            "Local harness settings unavailable",
          ),
        },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled_harness_ids?: unknown;
      enabledHarnessIds?: unknown;
    } & ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const beforeResult =
      needsReadProof && options.localAcp.listHarnesses
        ? await options.localAcp.listHarnesses()
        : { harnesses: [] };
    const hostMutation = needsReadProof
      ? validateLocalHarnessesConfigMutation({
          result: beforeResult,
          preconditions,
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    const rawIds = Array.isArray(body.enabled_harness_ids)
      ? body.enabled_harness_ids
      : Array.isArray(body.enabledHarnessIds)
        ? body.enabledHarnessIds
        : [];
    const enabledIds = rawIds.filter(
      (id): id is string => typeof id === "string",
    );
    try {
      const result = await options.localAcp.updateHarnesses(enabledIds);
      const readToken = localHarnessesReceiptReadToken(result);
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? envelope,
        {
          resultEntityId: "enabled",
          ...(hostMutation ? { afterReadToken: readToken } : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "local harness enablement update",
        }),
      );
      return c.json({
        ...result,
        readToken,
        mutation,
      });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            hostMutation?.envelope ?? envelope,
            message,
          ),
        },
        400,
      );
    }
  });

  app.get("/api/v1/local/agent-servers", async (c) => {
    if (!options.localAcp?.listAgentServers) {
      const result = { agent_servers: {} };
      return c.json({
        ...result,
        readToken: localAgentServersReceiptReadToken(result),
      });
    }
    const result = await options.localAcp.listAgentServers();
    return c.json({
      ...result,
      readToken: localAgentServersReceiptReadToken(result),
    });
  });

  app.put("/api/v1/local/agent-servers", async (c) => {
    const envelope = localMutationEnvelope(
      "local_agent_servers_update",
      "local-harness-config",
      "agent-servers",
    );
    if (!options.localAcp?.updateAgentServers) {
      return c.json(
        {
          error: "Custom agent server settings unavailable",
          mutation: hostMutationRejected(
            envelope,
            "Custom agent server settings unavailable",
          ),
        },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      agent_servers?: unknown;
      agentServers?: unknown;
    } & ProjectWriteBody;
    const rawServers = body.agent_servers ?? body.agentServers ?? {};
    const preconditions = requestProjectWritePreconditions(c, body);
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const beforeResult =
      needsReadProof && options.localAcp.listAgentServers
        ? await options.localAcp.listAgentServers()
        : { agent_servers: {} };
    const hostMutation = needsReadProof
      ? validateLocalAgentServersConfigMutation({
          result: beforeResult,
          preconditions,
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    try {
      const result = await options.localAcp.updateAgentServers(
        rawServers as LocalAcpAgentServersConfig,
      );
      const readToken = localAgentServersReceiptReadToken(result);
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? envelope,
        {
          resultEntityId: "agent-servers",
          ...(hostMutation ? { afterReadToken: readToken } : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "local agent servers update",
        }),
      );
      return c.json({
        ...result,
        readToken,
        mutation,
      });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            hostMutation?.envelope ?? envelope,
            message,
          ),
        },
        400,
      );
    }
  });

  app.post("/api/v1/local/harnesses/:harnessId/install", async (c) => {
    const harnessId = c.req.param("harnessId");
    const envelope = localMutationEnvelope(
      "local_harness_install",
      "local-harness",
      harnessId,
    );
    if (
      !options.localAcp?.installHarness &&
      !options.localAcp?.installHarnessAdapter
    ) {
      return c.json(
        {
          error: "Local agent install unavailable",
          mutation: hostMutationRejected(
            envelope,
            "Local agent install unavailable",
          ),
        },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const beforeResult =
      needsReadProof && options.localAcp.listHarnesses
        ? await options.localAcp.listHarnesses()
        : { harnesses: [] };
    const hostMutation = needsReadProof
      ? validateLocalHarnessActionMutation({
          result: beforeResult,
          preconditions,
          operation: "local_harness_install",
          harnessId,
          action: "install",
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    try {
      const result = options.localAcp.installHarness
        ? await options.localAcp.installHarness(harnessId)
        : await options.localAcp.installHarnessAdapter!(harnessId);
      const afterReadToken = localHarnessesReceiptReadToken(result);
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? envelope,
        {
          resultEntityId: harnessId,
          ...(hostMutation ? { afterReadToken } : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "local harness install",
        }),
      );
      return c.json({
        ...result,
        readToken: afterReadToken,
        mutation,
      });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            hostMutation?.envelope ?? envelope,
            message,
          ),
        },
        400,
      );
    }
  });

  app.post("/api/v1/local/harnesses/:harnessId/install-adapter", async (c) => {
    const harnessId = c.req.param("harnessId");
    const envelope = localMutationEnvelope(
      "local_harness_install",
      "local-harness",
      harnessId,
    );
    if (
      !options.localAcp?.installHarness &&
      !options.localAcp?.installHarnessAdapter
    ) {
      return c.json(
        {
          error: "Local agent install unavailable",
          mutation: hostMutationRejected(
            envelope,
            "Local agent install unavailable",
          ),
        },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const beforeResult =
      needsReadProof && options.localAcp.listHarnesses
        ? await options.localAcp.listHarnesses()
        : { harnesses: [] };
    const hostMutation = needsReadProof
      ? validateLocalHarnessActionMutation({
          result: beforeResult,
          preconditions,
          operation: "local_harness_install",
          harnessId,
          action: "install",
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    try {
      const result = options.localAcp.installHarness
        ? await options.localAcp.installHarness(harnessId)
        : await options.localAcp.installHarnessAdapter!(harnessId);
      const afterReadToken = localHarnessesReceiptReadToken(result);
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? envelope,
        {
          resultEntityId: harnessId,
          ...(hostMutation ? { afterReadToken } : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "local harness install",
        }),
      );
      return c.json({
        ...result,
        readToken: afterReadToken,
        mutation,
      });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            hostMutation?.envelope ?? envelope,
            message,
          ),
        },
        400,
      );
    }
  });

  app.post("/api/v1/local/harnesses/:harnessId/upgrade", async (c) => {
    const harnessId = c.req.param("harnessId");
    const envelope = localMutationEnvelope(
      "local_harness_upgrade",
      "local-harness",
      harnessId,
    );
    if (!options.localAcp?.upgradeHarness) {
      return c.json(
        {
          error: "Local agent upgrade unavailable",
          mutation: hostMutationRejected(
            envelope,
            "Local agent upgrade unavailable",
          ),
        },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const beforeResult =
      needsReadProof && options.localAcp.listHarnesses
        ? await options.localAcp.listHarnesses()
        : { harnesses: [] };
    const hostMutation = needsReadProof
      ? validateLocalHarnessActionMutation({
          result: beforeResult,
          preconditions,
          operation: "local_harness_upgrade",
          harnessId,
          action: "upgrade",
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    try {
      const result = await options.localAcp.upgradeHarness(harnessId);
      const afterReadToken = localHarnessesReceiptReadToken(result);
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? envelope,
        {
          resultEntityId: harnessId,
          ...(hostMutation ? { afterReadToken } : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "local harness upgrade",
        }),
      );
      return c.json({
        ...result,
        readToken: afterReadToken,
        mutation,
      });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            hostMutation?.envelope ?? envelope,
            message,
          ),
        },
        400,
      );
    }
  });

  app.delete("/api/v1/local/harnesses/:harnessId/install", async (c) => {
    const harnessId = c.req.param("harnessId");
    const envelope = localMutationEnvelope(
      "local_harness_uninstall",
      "local-harness",
      harnessId,
    );
    if (!options.localAcp?.uninstallHarness) {
      return c.json(
        {
          error: "Local agent uninstall unavailable",
          mutation: hostMutationRejected(
            envelope,
            "Local agent uninstall unavailable",
          ),
        },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const needsReadProof =
      !!preconditions.actorClientType || !!preconditions.expectedReadToken;
    const beforeResult =
      needsReadProof && options.localAcp.listHarnesses
        ? await options.localAcp.listHarnesses()
        : { harnesses: [] };
    const hostMutation = needsReadProof
      ? validateLocalHarnessActionMutation({
          result: beforeResult,
          preconditions,
          operation: "local_harness_uninstall",
          harnessId,
          action: "uninstall",
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    try {
      const result = await options.localAcp.uninstallHarness(harnessId);
      const afterReadToken = localHarnessesReceiptReadToken(result);
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? envelope,
        {
          resultEntityId: harnessId,
          ...(hostMutation ? { afterReadToken } : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "local harness uninstall",
        }),
      );
      return c.json({
        ...result,
        readToken: afterReadToken,
        mutation,
      });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(
            hostMutation?.envelope ?? envelope,
            message,
          ),
        },
        400,
      );
    }
  });

  app.post("/api/v1/local/harnesses/:harnessId/authenticate", async (c) => {
    const harnessId = c.req.param("harnessId");
    const envelope = localMutationEnvelope(
      "local_harness_authenticate",
      "local-harness",
      harnessId,
    );
    if (!options.localAcp?.authenticateHarness) {
      return c.json(
        {
          error: "Local harness auth unavailable",
          mutation: hostMutationRejected(
            envelope,
            "Local harness auth unavailable",
          ),
        },
        404,
      );
    }
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        method_id?: unknown;
        methodId?: unknown;
        values?: unknown;
      } & ProjectWriteBody;
      const preconditions = requestProjectWritePreconditions(c, body);
      const needsReadProof =
        !!preconditions.actorClientType || !!preconditions.expectedReadToken;
      const beforeResult =
        needsReadProof && options.localAcp.listHarnesses
          ? await options.localAcp.listHarnesses()
          : { harnesses: [] };
      const hostMutation = needsReadProof
        ? validateLocalHarnessActionMutation({
            result: beforeResult,
            preconditions,
            operation: "local_harness_authenticate",
            harnessId,
            action: "authenticate",
          })
        : null;
      if (hostMutation && !hostMutation.ok) {
        return c.json(
          {
            error: hostMutation.error,
            mutation: hostMutation.mutation,
          },
          409,
        );
      }
      const methodId =
        typeof body.method_id === "string" && body.method_id.length > 0
          ? body.method_id
          : typeof body.methodId === "string" && body.methodId.length > 0
            ? body.methodId
            : undefined;
      const values =
        body.values &&
        typeof body.values === "object" &&
        !Array.isArray(body.values)
          ? Object.fromEntries(
              Object.entries(body.values)
                .filter(
                  (entry): entry is [string, string] =>
                    entry[0].length > 0 &&
                    entry[0].length <= 128 &&
                    typeof entry[1] === "string" &&
                    entry[1].length <= 32_768,
                )
                .slice(0, 32),
            )
          : undefined;
      const authenticateOptions = {
        ...(methodId ? { methodId } : {}),
        ...(values && Object.keys(values).length > 0 ? { values } : {}),
      };
      const result = await options.localAcp.authenticateHarness(
        harnessId,
        Object.keys(authenticateOptions).length > 0
          ? authenticateOptions
          : undefined,
      );
      const afterReadToken = localHarnessesReceiptReadToken(result);
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? envelope,
        {
          resultEntityId: harnessId,
          ...(hostMutation ? { afterReadToken } : {}),
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "local harness authenticate",
        }),
      );
      return c.json({
        ...result,
        readToken: afterReadToken,
        mutation,
      });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(envelope, message),
        },
        500,
      );
    }
  });

  app.put("/api/v1/runtimes/:runtimeId/preferences", async (c) => {
    if (!options.localAcp?.updateRunPreferences) {
      return c.json(
        { error: "Local agent runtime preferences unavailable" },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      agent_id?: unknown;
      config_values?: unknown;
      mode_id?: unknown;
    };
    const agentId =
      typeof body.agent_id === "string" ? body.agent_id.trim() : "";
    if (!agentId) return c.json({ error: "Missing agent_id" }, 400);
    const configValues =
      body.config_values &&
      typeof body.config_values === "object" &&
      !Array.isArray(body.config_values)
        ? Object.fromEntries(
            Object.entries(body.config_values).filter(
              (entry): entry is [string, string | boolean] =>
                typeof entry[1] === "string" || typeof entry[1] === "boolean",
            ),
          )
        : undefined;
    const modeId =
      typeof body.mode_id === "string" && body.mode_id.trim()
        ? body.mode_id.trim()
        : undefined;
    return c.json(
      await options.localAcp.updateRunPreferences({
        agent_id: agentId,
        ...(configValues ? { config_values: configValues } : {}),
        ...(modeId ? { mode_id: modeId } : {}),
      }),
    );
  });

  app.post("/api/v1/runtimes/:runtimeId/sessions", async (c) => {
    if (!options.localAcp) {
      return c.json(
        {
          error: "Local agent runtime unavailable",
          mutation: hostMutationRejected(
            {
              operation: "runtime_session_create",
              entity: { kind: "session", id: "" },
            },
            "Local agent runtime unavailable",
          ),
        },
        404,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      agent_template_id?: string;
      agent_member_id?: string;
      agent_id?: string;
      config_values?: unknown;
      permission_mode?: string;
      project_id?: string;
      resume_session_id?: string;
      fork_session_id?: string;
    } & ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    let agentTemplateId = body.agent_template_id?.trim() || undefined;
    let agentMemberId = body.agent_member_id?.trim() || undefined;
    const requestedAgentId = body.agent_id?.trim() || undefined;
    const permissionMode = body.permission_mode?.trim() || undefined;
    if (body.resume_session_id && body.fork_session_id) {
      return c.json(
        {
          error: "resume_session_id and fork_session_id are mutually exclusive",
        },
        400,
      );
    }
    const configValues =
      body.config_values &&
      typeof body.config_values === "object" &&
      !Array.isArray(body.config_values)
        ? Object.fromEntries(
            Object.entries(body.config_values).filter(
              (entry): entry is [string, string | boolean] =>
                typeof entry[1] === "string" || typeof entry[1] === "boolean",
            ),
          )
        : undefined;
    let agentId: string | undefined = requestedAgentId;
    if (agentMemberId) {
      const agentMembers = await db.update((state) =>
        seedLocalAgentMembers(state, userId),
      );
      const member = agentMembers.find((row) => row.id === agentMemberId);
      if (!member) {
        return c.json(
          {
            error: "agent member not found",
            mutation: hostMutationRejected(
              {
                operation: "runtime_session_create",
                entity: { kind: "session", id: "" },
              },
              "agent member not found",
            ),
          },
          404,
        );
      }
      if (member.runtime_id !== c.req.param("runtimeId")) {
        return c.json(
          {
            error: "agent member belongs to a different runtime",
            mutation: hostMutationRejected(
              {
                operation: "runtime_session_create",
                entity: { kind: "session", id: "" },
              },
              "agent member belongs to a different runtime",
            ),
          },
          400,
        );
      }
      agentTemplateId = member.template_id;
      agentId = requestedAgentId ?? member.agent_id ?? undefined;
    }
    if (!agentTemplateId && !agentId) {
      return c.json(
        {
          error: "Missing agent_id",
          mutation: hostMutationRejected(
            {
              operation: "runtime_session_create",
              entity: { kind: "session", id: "" },
            },
            "Missing agent_id",
          ),
        },
        400,
      );
    }
    const sessionContextId =
      agentTemplateId ?? DEFAULT_RUNTIME_SESSION_CONTEXT_ID;

    const localSessionId = body.project_id ? crypto.randomUUID() : undefined;
    if (body.project_id && localSessionId) {
      const at = nowIso();
      await precreateRuntimeSession(db, {
        id: localSessionId,
        projectId: body.project_id,
        title: initialRuntimeSessionTitle(agentTemplateId),
        type: "runtime",
        runtimeId: c.req.param("runtimeId"),
        ...(agentId ? { agentId } : {}),
        ...(agentTemplateId ? { agentTemplateId } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        status: "starting",
        createdAt: at,
        updatedAt: at,
      });
    }

    try {
      const pendingSessionPatches = new Map<
        string,
        Partial<Pick<LocalSession, "acpSessionId" | "status" | "title">>
      >();
      const rememberRuntimeSessionPatch = async (
        sessionId: string,
        patch: Partial<Pick<LocalSession, "acpSessionId" | "status" | "title">>,
      ) => {
        pendingSessionPatches.set(sessionId, {
          ...pendingSessionPatches.get(sessionId),
          ...patch,
        });
        await updateRuntimeSession(db, sessionId, patch);
      };
      const created = await options.localAcp.createSession({
        ...(localSessionId ? { sessionId: localSessionId } : {}),
        runtimeId: c.req.param("runtimeId"),
        agentTemplateId: sessionContextId,
        ...(agentMemberId ? { agentMemberId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(configValues ? { configValues } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(body.project_id ? { projectId: body.project_id } : {}),
        ...(body.resume_session_id
          ? { resumeAcpSessionId: body.resume_session_id }
          : {}),
        ...(body.fork_session_id
          ? { forkFromAcpSessionId: body.fork_session_id }
          : {}),
        ...(body.project_id
          ? {
              onReady: async (event: {
                sessionId: string;
                acpSessionId?: string;
              }) => {
                await rememberRuntimeSessionPatch(event.sessionId, {
                  ...(event.acpSessionId
                    ? { acpSessionId: event.acpSessionId }
                    : {}),
                  status: "active",
                });
              },
              onError: async (event: { sessionId: string }) => {
                await rememberRuntimeSessionPatch(event.sessionId, {
                  status: "error",
                });
              },
            }
          : {}),
      });
      if (agentId && options.localAcp.updateRunPreferences) {
        await options.localAcp
          .updateRunPreferences({
            agent_id: agentId,
            ...(configValues ? { config_values: configValues } : {}),
            ...(permissionMode ? { mode_id: permissionMode } : {}),
          })
          .catch((error) => {
            console.warn(
              "[local-api] could not persist recent ACP run choices:",
              errorMessage(error),
            );
          });
      }
      if (body.project_id && localSessionId) {
        await finalizeRuntimeSessionId(db, localSessionId, created.session_id, {
          ...pendingSessionPatches.get(localSessionId),
          ...pendingSessionPatches.get(created.session_id),
        });
      }
      const mutation = hostMutationSucceeded(
        {
          operation: "runtime_session_create",
          entity: { kind: "session", id: created.session_id },
        },
        {
          resultEntityId: created.session_id,
        },
      );
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "runtime session create",
        }),
      );
      return c.json({
        ...created,
        mutation,
      });
    } catch (error) {
      const message = formatLocalAcpSessionError(error);
      if (localSessionId) {
        await sessionEventStore.appendEvent(localSessionId, {
          type: "turn_failed",
          data: { message },
          ts: Date.now(),
        });
      }
      console.error("[local-api] local ACP session create failed:", message);
      const envelope = {
        operation: "runtime_session_create",
        entity: { kind: "session", id: localSessionId ?? "" },
      };
      if (localSessionId) {
        const mutation = hostMutationSucceeded(envelope, {
          resultEntityId: localSessionId,
        });
        await db.appendMutationAudit(
          mutationAuditRecord({
            mutation,
            actorClientType: preconditions.actorClientType,
            reason: "runtime session create",
          }),
        );
        return c.json(
          {
            error: message,
            session_id: localSessionId,
            mutation,
          },
          503,
        );
      }
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(envelope, message),
        },
        503,
      );
    }
  });

  app.get("/api/v1/runtimes/:runtimeId/local-sessions/scan", async (c) => {
    if (!options.localAcp) return c.json({ sessions: [] });
    return c.json(
      await options.localAcp.listResumeSessions(c.req.param("runtimeId")),
    );
  });

  app.get("/api/v1/local-sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    const persisted = await sessionEventStore.listSessionEvents(sessionId);
    if (persisted) return c.json(persisted);
    if (!options.localAcp?.listSessionEvents) {
      return c.json({ error: "not found" }, 404);
    }
    const history = await options.localAcp.listSessionEvents(sessionId);
    return history ? c.json(history) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/v1/local-sessions/:sessionId/runtime-status", async (c) => {
    if (!options.localAcp?.getSessionRuntimeStatus) {
      return c.json(
        { error: "local ACP runtime status is not available" },
        501,
      );
    }
    const status = await options.localAcp.getSessionRuntimeStatus(
      c.req.param("sessionId"),
    );
    return status ? c.json(status) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/v1/local-sessions/:sessionId/restart", async (c) => {
    if (!options.localAcp?.restartSession) {
      return c.json(
        { error: "local ACP session restart is not available" },
        501,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { mode?: unknown };
    const mode = body.mode === "after-turn" ? "after-turn" : "now";
    try {
      return c.json(
        await options.localAcp.restartSession(c.req.param("sessionId"), {
          mode,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        { error: message },
        message === "local session not found" ? 404 : 409,
      );
    }
  });

  app.post("/api/v1/local-sessions/:sessionId/_attach", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = (await c.req.json().catch(() => ({}))) as ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    if (!options.localAcp?.attachSession) {
      return c.json(
        {
          error: "local ACP attach is not available",
          mutation: hostMutationRejected(
            {
              operation: "runtime_session_attach",
              entity: { kind: "session", id: sessionId },
            },
            "local ACP attach is not available",
          ),
        },
        501,
      );
    }
    const state = await db.load();
    const session = state.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session || (session.type ?? "cloud") !== "runtime") {
      return c.json(
        {
          error: "runtime session not found",
          mutation: hostMutationRejected(
            {
              operation: "runtime_session_attach",
              entity: { kind: "session", id: sessionId },
            },
            "runtime session not found",
          ),
        },
        404,
      );
    }
    if (!session.runtimeId) {
      return c.json(
        {
          error: "runtime session is missing runtimeId",
          mutation: hostMutationRejected(
            {
              operation: "runtime_session_attach",
              entity: { kind: "session", id: sessionId },
            },
            "runtime session is missing runtimeId",
          ),
        },
        409,
      );
    }
    if (!session.agentId && !session.agentTemplateId) {
      return c.json(
        {
          error: "runtime session is missing agent identity",
          mutation: hostMutationRejected(
            {
              operation: "runtime_session_attach",
              entity: { kind: "session", id: sessionId },
            },
            "runtime session is missing agent identity",
          ),
        },
        409,
      );
    }

    const requiresReadProofEnvelope =
      preconditions.actorClientType === "agent" ||
      Boolean(preconditions.expectedReadToken);
    const hostMutation = requiresReadProofEnvelope
      ? validateSessionReadMutation({
          session,
          operation: "attach",
          mutationOperation: "runtime_session_attach",
          readOperation: "runtime session attach",
          preconditions,
        })
      : null;
    if (hostMutation && !hostMutation.ok) {
      return c.json(
        {
          error: hostMutation.error,
          mutation: hostMutation.mutation,
        },
        409,
      );
    }
    const attachEnvelope = hostMutation?.envelope ?? {
      operation: "runtime_session_attach",
      entity: { kind: "session", id: sessionId },
    };

    const rememberRuntimeSessionPatch = async (
      patch: Partial<Pick<LocalSession, "acpSessionId" | "status" | "title">>,
    ) => {
      await updateRuntimeSession(db, sessionId, patch);
    };

    try {
      await rememberRuntimeSessionPatch({ status: "starting" });
      const attached = await options.localAcp.attachSession({
        sessionId,
        runtimeId: session.runtimeId,
        ...(session.agentTemplateId
          ? { agentTemplateId: session.agentTemplateId }
          : {}),
        ...(session.agentId ? { agentId: session.agentId } : {}),
        ...(session.permissionMode
          ? { permissionMode: session.permissionMode }
          : {}),
        projectId: session.projectId,
        ...(session.acpSessionId
          ? { resumeAcpSessionId: session.acpSessionId }
          : {}),
        onReady: async (event: { acpSessionId?: string }) => {
          await rememberRuntimeSessionPatch({
            ...(event.acpSessionId ? { acpSessionId: event.acpSessionId } : {}),
            status: "active",
          });
        },
        onError: async () => {
          await rememberRuntimeSessionPatch({ status: "error" });
        },
      });
      const afterSession = hostMutation
        ? (await db.load()).sessions.find(
            (candidate) => candidate.id === sessionId,
          )
        : undefined;
      const afterReadToken = afterSession
        ? sessionReceiptReadToken(afterSession)
        : undefined;
      const mutation = hostMutationSucceeded(attachEnvelope, {
        resultEntityId: attached.session_id,
        afterReadToken,
      });
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "runtime session attach",
        }),
      );
      return c.json({
        ...attached,
        mutation,
      });
    } catch (error) {
      const message = formatLocalAcpSessionError(error);
      console.error("[local-api] local ACP session attach failed:", message);
      await rememberRuntimeSessionPatch({ status: "error" });
      const afterSession = hostMutation
        ? (await db.load()).sessions.find(
            (candidate) => candidate.id === sessionId,
          )
        : undefined;
      const afterReadToken = afterSession
        ? sessionReceiptReadToken(afterSession)
        : undefined;
      const mutation = hostMutationSucceeded(attachEnvelope, {
        resultEntityId: sessionId,
        afterReadToken,
      });
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "runtime session attach",
        }),
      );
      return c.json(
        {
          error: message,
          session_id: sessionId,
          mutation,
        },
        503,
      );
    }
  });

  app.get("/api/v1/projects/:projectId/canvas/thumbnail", async (c) => {
    const projectId = c.req.param("projectId");
    const revision = c.req.query("revision")?.trim() ?? "";
    if (!/^[a-f0-9]{64}$/u.test(revision)) {
      return c.json({ error: "A valid canvas revision is required" }, 400);
    }
    const state = await db.load();
    if (!findActiveProject(state, projectId)) {
      return c.json({ error: "Project not found" }, 404);
    }
    try {
      const entry = await projectCanvasPreviewEntryFor(projectId);
      let bytes = await replicaStore.readCanvasThumbnail(projectId, revision);
      if (!bytes) {
        if (!entry.preview.bounds || entry.preview.nodes.length === 0) {
          return c.json({ error: "Main canvas is empty" }, 404);
        }
        let input = recentProjectCanvasThumbnailInputs
          .get(projectId)
          ?.get(revision);
        if (!input) {
          const service = projectAssetServiceAt(requestOrigin(c));
          const thumbnailState = await projectCanvasThumbnailState(
            projectId,
            entry,
            service,
          );
          if (thumbnailState.sourceVersion !== revision) {
            return c.json(
              { error: "Canvas thumbnail revision not found" },
              404,
            );
          }
          input = thumbnailState.input;
        }
        bytes = await projectCanvasThumbnailCache.get(input);
      }
      return new Response(Uint8Array.from(bytes).buffer, {
        headers: {
          "content-type": "image/webp",
          "content-length": String(bytes.byteLength),
          "cache-control": "public, max-age=31536000, immutable",
          etag: `"${revision}"`,
        },
      });
    } catch (error) {
      return localProjectAssetErrorResponse(error);
    }
  });

  app.get("/api/v1/projects", async (c) => {
    const state = await db.load();
    const archived = c.req.query("archived") ?? "active";
    if (!new Set(["active", "only", "include"]).has(archived)) {
      return c.json(
        { error: "archived must be active, only, or include" },
        400,
      );
    }
    try {
      const service = projectAssetServiceAt(requestOrigin(c));
      const visibleProjects =
        archived === "only"
          ? state.projects.filter(isDeletedProject)
          : archived === "include"
            ? state.projects
            : activeProjects(state);
      for (const project of visibleProjects) {
        syncProjectMetadataInBackground(project.id);
      }
      return c.json({
        projects: await Promise.all(
          visibleProjects.map(async (project) => {
            const [assets, coverAssetId, canvasPreviewEntry] =
              await Promise.all([
                service.list(project.id),
                service.readProjectCover(project.id),
                projectCanvasPreviewEntryFor(project.id),
              ]);
            const thumbnailState = await projectCanvasThumbnailState(
              project.id,
              canvasPreviewEntry,
              service,
            );
            const canvasThumbnail = projectCanvasThumbnailProjection(
              requestOrigin(c),
              project.id,
              canvasPreviewEntry,
              thumbnailState.sourceVersion,
            );
            if (canvasThumbnail) {
              projectCanvasThumbnailCache.schedule(thumbnailState.input);
            }
            return toV1Project(
              project,
              assets,
              "preview",
              coverAssetId,
              canvasPreviewEntry.preview,
              canvasThumbnail,
            );
          }),
        ),
      });
    } catch (error) {
      return localProjectAssetErrorResponse(error);
    }
  });

  app.post("/api/v1/projects", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
    } & ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const name = body.name?.trim();
    if (!name) return c.json({ error: "name is required" }, 400);

    const project = await db.update((state) => {
      const createdAt = nowIso();
      const next: LocalProject = {
        id: crypto.randomUUID(),
        ownerId: userId,
        name,
        description: body.description?.trim() || null,
        createdAt,
        updatedAt: createdAt,
        assets: [],
      };
      state.projects.unshift(next);
      return next;
    });
    const readToken = projectReceiptReadToken(project);
    const mutation = hostMutationSucceeded(
      {
        operation: "project_create",
        entity: { kind: "project", id: project.id },
      },
      {
        resultEntityId: project.id,
        afterReadToken: readToken,
      },
    );
    await db.appendMutationAudit(
      mutationAuditRecord({
        mutation,
        actorClientType: preconditions.actorClientType,
        reason: "v1 project create",
      }),
    );
    syncProjectMetadataInBackground(project.id);
    return c.json(
      {
        id: project.id,
        name: project.name,
        description: project.description,
        readToken,
        mutation,
      },
      201,
    );
  });

  app.get("/api/v1/projects/:id/status", async (c) => {
    const projectId = c.req.param("id");
    const state = await db.load();
    const project = findActiveProject(state, projectId, userId);
    if (!project) return c.json({ error: "not found" }, 404);
    syncProjectMetadataInBackground(project.id);
    const sync = await syncConfig.getPublicConfig();
    return c.json(
      buildProjectStatus(
        { projectId, source: "explicit" },
        {
          clashRoot,
          localApiDataDir,
          replicationState: {
            mode: sync.mode,
            capabilities: sync.capabilities,
          },
        },
      ),
    );
  });

  app.get("/api/v1/projects/:projectId/cloud-admission", async (c) => {
    const projectId = c.req.param("projectId");
    const project = findActiveProject(
      await db.load(),
      projectId,
      userId,
    );
    if (!project) return c.json({ error: "not found" }, 404);
    const admission = await db.getProjectCloudAdmission(
      projectId,
      c.req.query("localReplicaId")?.trim() || localReplicaId,
    );
    return c.json({ admission });
  });

  app.post("/api/v1/projects/:projectId/cloud-admission", async (c) => {
    if (!cloudAdmission) {
      return c.json(
        { error: "Cloud admission is not configured", code: "CLOUD_UNAVAILABLE" },
        503,
      );
    }
    const state = await db.load();
    const projectId = c.req.param("projectId");
    const project = findActiveProject(state, projectId, userId);
    if (!project) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      localReplicaId?: unknown;
      resourceIds?: unknown;
    };
    const requestedReplicaId =
      typeof body.localReplicaId === "string" && body.localReplicaId.trim()
        ? body.localReplicaId.trim()
        : localReplicaId;
    const requestedResourceIds = Array.isArray(body.resourceIds)
      ? body.resourceIds.filter((id): id is string => typeof id === "string")
      : state.assets
          .filter((asset) => asset.projectId === projectId)
          .map((asset) => {
            const candidate = asset as Asset & { resourceId?: string };
            return candidate.resourceId ?? candidate.id;
          });
    const request = ProjectCloudAdmissionRequestSchema.parse({
      schemaVersion: 1,
      projectId,
      localReplicaId: requestedReplicaId,
      metadata: localProjectSyncMetadata(project),
      resourceIds: [...new Set(requestedResourceIds)],
    });
    try {
      const response = await cloudAdmission.admit(request);
      await db.upsertProjectCloudAdmission(response.admission);
      // Admission is the only user-visible switch. Starting the room here
      // makes initial snapshot/update mirroring happen even before Desktop
      // opens a WebSocket; it still leaves the global sync setting untouched.
      const initialSync = options.ensureProjectSync?.(projectId);
      if (initialSync) {
        void initialSync.catch((error) => {
          console.error(
            `[local-api] initial cloud sync failed for ${projectId}`,
            error,
          );
        });
      }
      // Metadata is a separate product plane from the Loro byte stream. Kick
      // its idempotent mirror as part of admission so a freshly admitted
      // Project is visible remotely even before its next ordinary mutation.
      syncProjectMetadataInBackground(projectId);
      return c.json(ProjectCloudAdmissionResponseSchema.parse(response), 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = {
        schemaVersion: 1 as const,
        projectId,
        tenantId: "pending",
        userId,
        localReplicaId: requestedReplicaId,
        syncBaseUrl: "https://cloud-admission-failed.invalid",
        status: "failed" as const,
        capabilities: { canvas: false, projectMetadata: false, resources: false },
        admittedAt: null,
        updatedAt: nowIso(),
        lastError: message,
      };
      await db.upsertProjectCloudAdmission(failed);
      return c.json({ error: message, code: "CLOUD_ADMISSION_FAILED", admission: failed }, 502);
    }
  });

  app.post("/api/v1/text-revisions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      revision?: unknown;
      content?: unknown;
    };
    const parsed = parseTextRevisionForIndex(body.revision);
    const envelope = {
      operation: "text_revision_index",
      entity: {
        kind: "text",
        id: parsed.ok
          ? `${parsed.revision.projectId}:${parsed.revision.nodeId}`
          : "",
      },
    };
    const rejectTextRevision = async (
      message: string,
      status: 400 | 409 | 500,
    ) => {
      const mutation = hostMutationRejected(envelope, message);
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          reason: "text revision rejected",
        }),
      );
      return c.json({ error: message, mutation }, status);
    };
    if (!parsed.ok) {
      return rejectTextRevision(parsed.error, 400);
    }
    const content = typeof body.content === "string" ? body.content : undefined;
    if (content !== undefined) {
      try {
        await preflightTextRevisionContentBlob(
          options.dataDir,
          parsed.revision,
          content,
        );
      } catch (error) {
        const message = errorMessage(error);
        return rejectTextRevision(
          message,
          message.includes("already exists with different content") ? 409 : 400,
        );
      }
    }

    try {
      const { revision, contentRecord } = await workspaceProjectLease.run(
        parsed.revision.projectId,
        async () => {
          const revision = await db.upsertTextRevision(parsed.revision);
          const contentRecord =
            content === undefined
              ? undefined
              : await storeTextRevisionContentBlob(
                  options.dataDir,
                  parsed.revision,
                  content,
                );
          return { revision, contentRecord };
        },
      );
      const mutation = hostMutationSucceeded(envelope, {
        resultEntityId: revision.revisionId,
      });
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          reason: "text revision indexed",
        }),
      );
      return c.json({
        revision,
        ...(contentRecord ? { content: contentRecord } : {}),
        mutation,
      });
    } catch (error) {
      const message = errorMessage(error);
      return rejectTextRevision(
        message,
        message.includes("already exists with different metadata") ? 409 : 500,
      );
    }
  });

  app.get("/api/v1/projects/:projectId/text-revisions", async (c) => {
    const limit = Number(c.req.query("limit"));
    const revisions = await db.listTextRevisions({
      projectId: c.req.param("projectId"),
      nodeId: normalizeString(c.req.query("nodeId")),
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    const entries = await Promise.all(
      revisions.map((revision) =>
        withTextRevisionContentDescriptor(options.dataDir, revision),
      ),
    );
    return c.json({ revisions: entries });
  });

  app.get(
    "/api/v1/projects/:projectId/text-revisions/:revisionId/content",
    async (c) => {
      const revision = await db.getTextRevision(
        c.req.param("projectId"),
        c.req.param("revisionId"),
      );
      if (!revision) return c.json({ error: "text revision not found" }, 404);
      let content: string;
      try {
        content = await readFile(
          textRevisionContentBlobPath(options.dataDir, revision.contentHash),
          "utf8",
        );
      } catch {
        return c.json({ error: "text revision content not found" }, 404);
      }
      if (textRevisionContentHash(content) !== revision.contentHash) {
        return c.json(
          { error: "text revision content blob hash mismatch" },
          409,
        );
      }
      return new Response(content, {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
          "x-clash-content-hash": revision.contentHash,
        },
      });
    },
  );

  app.get("/api/v1/projects/:id", async (c) => {
    const state = await db.load();
    const projectId = c.req.param("id");
    const includeDeleted =
      normalizeString(c.req.query("includeDeleted")) === "true";
    const project = includeDeleted
      ? state.projects.find((candidate) => candidate.id === projectId)
      : findActiveProject(state, projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    syncProjectMetadataInBackground(project.id);
    // A deleted Project read is a recovery-control-plane operation. Do not
    // materialize legacy media or require its bytes merely to obtain the
    // current read proof for restore/purge; missing old blobs must not make a
    // tombstoned Project impossible to purge.
    if (includeDeleted && isDeletedProject(project)) {
      return c.json(toV1Project(project, [], "all"));
    }
    try {
      const service = projectAssetServiceAt(requestOrigin(c));
      const [assets, coverAssetId, canvasPreviewEntry] = await Promise.all([
        service.list(project.id),
        service.readProjectCover(project.id),
        projectCanvasPreviewEntryFor(project.id),
      ]);
      const thumbnailState = await projectCanvasThumbnailState(
        project.id,
        canvasPreviewEntry,
        service,
      );
      const canvasThumbnail = projectCanvasThumbnailProjection(
        requestOrigin(c),
        project.id,
        canvasPreviewEntry,
        thumbnailState.sourceVersion,
      );
      if (canvasThumbnail) {
        projectCanvasThumbnailCache.schedule(thumbnailState.input);
      }
      return c.json(
        toV1Project(
          project,
          assets,
          "all",
          coverAssetId,
          canvasPreviewEntry.preview,
          canvasThumbnail,
        ),
      );
    } catch (error) {
      return localProjectAssetErrorResponse(error);
    }
  });

  app.patch("/api/v1/projects/:id", async (c) => {
    const projectId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
    } & ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const name = body.name?.trim();
    if (!name) {
      return c.json(
        {
          error: "name is required",
          mutation: hostMutationRejected(
            {
              operation: "project_update",
              entity: { kind: "project", id: projectId },
              expectedReadToken: preconditions.expectedReadToken,
            },
            "name is required",
          ),
        },
        400,
      );
    }
    const result = await db.update((state) => {
      const project = findActiveProject(state, projectId);
      if (!project) {
        return {
          status: 404 as const,
          body: {
            error: "Project not found",
            mutation: hostMutationRejected(
              {
                operation: "project_update",
                entity: { kind: "project", id: projectId },
                expectedReadToken: preconditions.expectedReadToken,
              },
              "Project not found",
            ),
          },
        };
      }
      const hostMutation = validateProjectReadMutation({
        project,
        operation: "update",
        preconditions,
      });
      if (!hostMutation.ok) {
        return {
          status: 409 as const,
          body: { error: hostMutation.error, mutation: hostMutation.mutation },
        };
      }
      project.name = name;
      project.updatedAt = nowIso();
      const readToken = projectReceiptReadToken(project);
      return {
        status: 200 as const,
        body: {
          ok: true,
          id: project.id,
          name: project.name,
          readToken,
          mutation: hostMutationSucceeded(hostMutation.envelope, {
            resultEntityId: project.id,
            afterReadToken: readToken,
          }),
        },
      };
    });
    const mutation = (result.body as { mutation?: HostMutationRecord })
      .mutation;
    if (mutation?.accepted === true) {
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: "project update",
        }),
      );
      syncProjectMetadataInBackground(projectId);
    }
    return c.json(result.body, result.status);
  });

  app.put("/api/v1/projects/:id/cover", async (c) => {
    const projectId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      coverAssetId?: unknown;
    };
    const hasCoverAssetId = Object.prototype.hasOwnProperty.call(
      body,
      "coverAssetId",
    );
    const normalizedCoverAssetId = normalizeString(body.coverAssetId);
    if (
      !hasCoverAssetId ||
      (body.coverAssetId !== null && !normalizedCoverAssetId)
    ) {
      return c.json(
        {
          error: "coverAssetId must be a non-empty string or null",
          code: "INVALID_PROJECT_COVER",
        },
        400,
      );
    }
    const coverAssetId =
      body.coverAssetId === null ? null : normalizedCoverAssetId!;

    const state = await db.load();
    if (!findActiveProject(state, projectId)) {
      return c.json({ error: "Project not found" }, 404);
    }

    try {
      const service = projectAssetServiceAt(requestOrigin(c));
      if (coverAssetId) {
        const coverAsset = await service.readEntry(projectId, coverAssetId);
        if (!coverAsset) {
          return c.json(
            {
              error: "Project cover Asset not found",
              code: "PROJECT_ASSET_NOT_FOUND",
            },
            404,
          );
        }
        if (
          coverAsset.lifecycle.state !== "active" ||
          (coverAsset.kind !== "image" && coverAsset.kind !== "video")
        ) {
          return c.json(
            {
              error: "Project cover must be an active image or video Asset",
              code: "INVALID_PROJECT_COVER",
            },
            400,
          );
        }
      }
      const currentCoverAssetId = await service.setProjectCover(
        projectId,
        coverAssetId,
      );
      return c.json({
        ok: true,
        projectId,
        coverAssetId: currentCoverAssetId,
      });
    } catch (error) {
      return localProjectAssetErrorResponse(error);
    }
  });

  app.post(
    "/api/v1/projects/:projectId/director-stages/:stageId/outputs",
    async (c) => {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return c.json(
          {
            error: "Invalid multipart Director output",
            code: "INVALID_DIRECTOR_OUTPUT",
          },
          400,
        );
      }
      const file = form.get("file");
      const kind = AssetKindSchema.safeParse(form.get("kind"));
      const sourceStageRevisionId = form.get("sourceStageRevisionId");
      const artifactId = form.get("artifactId");
      if (
        !file ||
        typeof file === "string" ||
        !kind.success ||
        (kind.data !== "image" && kind.data !== "video") ||
        typeof sourceStageRevisionId !== "string" ||
        !sourceStageRevisionId.trim() ||
        typeof artifactId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(artifactId)
      ) {
        return c.json(
          {
            error:
              "Director output requires an image/video file, sourceStageRevisionId, and artifactId",
            code: "INVALID_DIRECTOR_OUTPUT",
          },
          400,
        );
      }
      const fileError = validateProjectAssetImportFile(file, kind.data);
      if (fileError) {
        return c.json(
          { error: fileError, code: "INVALID_DIRECTOR_OUTPUT" },
          400,
        );
      }

      const projectId = c.req.param("projectId");
      const stageId = c.req.param("stageId");
      const expectedRevisionId = sourceStageRevisionId.trim();
      const observedStage = await projectCommandReplica.inspect(
        projectId,
        (doc) => readProjectDirectorStage(doc, stageId),
      );
      if (!observedStage) {
        return c.json({ error: `Director Stage ${stageId} not found` }, 404);
      }
      if (observedStage.revisionId !== expectedRevisionId) {
        return c.json(
          {
            error: `Director Stage ${stageId} changed; read it again before publishing output`,
            code: "STALE_READ",
          },
          409,
        );
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const projectAssetId = directorCaptureProjectAssetId({
        stageId,
        sourceStageRevisionId: expectedRevisionId,
        artifactId,
        sha256,
      });
      const actionRunId = projectAssetId;
      const actionId =
        observedStage.owner.kind === "canvas-action"
          ? `node:${observedStage.owner.actionNodeId}`
          : `director:${stageId}`;
      const binding: ActionAssetBinding = {
        id: `action-asset:${encodeURIComponent(actionRunId)}:output:${encodeURIComponent(artifactId)}`,
        owner: {
          kind: "run",
          actionId,
          actionRevisionId: expectedRevisionId,
          actionRunId,
        },
        direction: "output",
        slot: `director:output:${artifactId}`,
        projectAssetId,
        role: "primary",
      };
      const contentType =
        file.type.trim().toLowerCase() ||
        contentTypeForPath(file.name) ||
        (kind.data === "image" ? "image/png" : "video/webm");
      try {
        const assetService = projectAssetServiceAt(requestOrigin(c));
        const staged = await assetService.stageOwned({
          kind: kind.data,
          bytes,
          contentType,
          name: file.name,
        });
        const asset = await assetService.publishStagedOwnedWithBindings({
          projectId,
          projectAssetId,
          kind: kind.data,
          resourceId: staged.resourceId,
          name: file.name,
          metadata: {
            bytes: bytes.byteLength,
            contentType,
            originalName: file.name,
          },
          provenance: { kind: "render", actionRunId },
          bindings: [binding],
          assertProjectState(doc) {
            const current = readProjectDirectorStage(doc, stageId);
            if (
              !current ||
              current.revisionId !== expectedRevisionId ||
              JSON.stringify(current.owner) !==
                JSON.stringify(observedStage.owner)
            ) {
              throw new AssetSdkContractError(
                "STALE_READ",
                `Director Stage ${stageId} changed during output publication; read it again`,
              );
            }
          },
        });
        return c.json({ asset, binding }, 201);
      } catch (error) {
        return localProjectAssetErrorResponse(error);
      }
    },
  );

  app.post("/api/v1/projects/:projectId/host-command", async (c) => {
    const projectId = c.req.param("projectId");
    const raw = await c.req.json().catch(() => undefined);
    const parsed = ProjectHostCommandSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid project host command",
          details: parsed.error.issues.map((issue) => ({
            code: issue.code,
            path: issue.path,
            message: issue.message,
          })),
        },
        400,
      );
    }
    const body = parsed.data;
    const action = body.action;
    const hostContext: Parameters<typeof handleProjectCommand>[3] = {
      actorUserId: userId,
    };
    const timelineDefinitionActions = new Set([
      "list_timelines",
      "create_timeline",
      "update_timeline_state",
      "attach_timeline",
      "detach_timeline",
      "copy_timeline_action",
      "request_timeline_render",
      "list_timeline_renders",
    ]);
    if (timelineDefinitionActions.has(action)) {
      if (!options.listPluginGenerators) {
        return c.json(
          {
            error: "Timeline Generator projection surface is not installed",
            code: "GENERATOR_PROJECTION_SURFACE_NOT_INSTALLED",
          },
          503,
        );
      }
      try {
        const definitions = (await options.listPluginGenerators()).map(
          generatorDefinitionFromExecutablePluginRegistration,
        );
        const resolved = resolveGeneratorProjectionDefinition(
          definitions,
          "clash.timeline",
        );
        if (!resolved.ok) {
          return c.json(
            {
              error: `Generator projection surface ${resolved.surfaceId} could not be resolved`,
              code: resolved.code,
            },
            resolved.code === "GENERATOR_PROJECTION_SURFACE_AMBIGUOUS"
              ? 409
              : 503,
          );
        }
        hostContext.timelineGeneratorDefinition = resolved.definition;
      } catch (error) {
        return c.json(
          {
            error: error instanceof Error ? error.message : String(error),
            code: "GENERATOR_REGISTRY_ERROR",
          },
          502,
        );
      }
    }
    const stageDefinitionActions = new Set([
      "list_director_stages",
      "create_director_stage",
      "update_director_stage_state",
      "attach_director_stage",
      "detach_director_stage",
      "capture_director_stage",
    ]);
    if (stageDefinitionActions.has(action)) {
      if (!options.listPluginGenerators) {
        return c.json(
          {
            error:
              "Director Stage Generator projection surface is not installed",
            code: "GENERATOR_PROJECTION_SURFACE_NOT_INSTALLED",
          },
          503,
        );
      }
      try {
        const definitions = (await options.listPluginGenerators()).map(
          generatorDefinitionFromExecutablePluginRegistration,
        );
        const resolved = resolveGeneratorProjectionDefinition(
          definitions,
          "clash.director-stage",
        );
        if (!resolved.ok) {
          return c.json(
            {
              error: `Generator projection surface ${resolved.surfaceId} could not be resolved`,
              code: resolved.code,
            },
            resolved.code === "GENERATOR_PROJECTION_SURFACE_AMBIGUOUS"
              ? 409
              : 503,
          );
        }
        hostContext.directorStageGeneratorDefinition = resolved.definition;
      } catch (error) {
        return c.json(
          {
            error: error instanceof Error ? error.message : String(error),
            code: "GENERATOR_REGISTRY_ERROR",
          },
          502,
        );
      }
    }
    if (action === "capture_director_stage") {
      // Capture is planned by the Project command against the exact native
      // Generator revision, then submitted below through the generic product.
    }
    if (action === "add" || action === "execute") {
      const [state, pluginCards] = await Promise.all([
        db.load(),
        options.listPluginCards ? options.listPluginCards() : [],
      ]);
      hostContext.effectiveModelCards = await effectiveModelCards(
        state,
        userId,
        async () => pluginCards,
        options.listPluginModelBindings,
      );
      hostContext.trustedCustomActions = executablePluginActionDefinitions(
        pluginCards,
      ) as Record<string, unknown>[];
    }
    const selectedAccountId =
      action === "execute" && typeof body.providerAccountId === "string"
        ? body.providerAccountId
        : undefined;
    const handoffNodeId = selectedAccountId
      ? randomUUID().replaceAll("-", "").slice(0, 8)
      : undefined;
    if (selectedAccountId && handoffNodeId) {
      // Persist the private account choice before committing the pending Project node. A crash can
      // leave an unreferenced handoff, but can never leave a pending node that silently routes to a
      // different account.
      await providerExecutionHandoffs.put({
        projectId,
        nodeId: handoffNodeId,
        accountId: selectedAccountId,
        createdAt: Date.now(),
      });
      hostContext.generationId = () => handoffNodeId;
    }
    let result: object;
    try {
      const mutatesProject = projectCommandMutates(action);
      result = mutatesProject
        ? await projectCommandReplica.mutate(projectId, async (doc) => {
            await projectAssetServiceAt(requestOrigin(c)).materializeDoc(
              projectId,
              doc,
            );
            return {
              value: handleProjectCommand(projectId, doc, body, hostContext),
              save: true,
            };
          })
        : await projectCommandReplica.inspect(projectId, (doc) =>
            handleProjectCommand(projectId, doc, body, hostContext),
          );
    } catch (error) {
      if (handoffNodeId) {
        await providerExecutionHandoffs.remove(projectId, handoffNodeId);
      }
      throw error;
    }
    if (
      handoffNodeId &&
      ((result as { error?: unknown }).error ||
        (result as { kind?: unknown }).kind !== "generation" ||
        (result as { childNodeId?: unknown }).childNodeId !== handoffNodeId)
    ) {
      await providerExecutionHandoffs.remove(projectId, handoffNodeId);
    }
    if ((result as { kind?: unknown }).kind === "director-stage-capture-plan") {
      if (!generatorProduct)
        return c.json(
          { error: "Generator Project authority is unavailable" },
          503,
        );
      const plan = result as {
        stageId: string;
        sourceStageRevisionId: string;
        runs: Array<{
          actionRunId: string;
          generatorId: string;
          generatorRevisionId: string;
          actionId: string;
          parameters: Record<string, unknown>;
        }>;
      };
      try {
        const runs = await generatorProduct.submitBatch(
          projectId,
          plan.runs.map((request) => ({
            generatorId: request.generatorId,
            actionId: request.actionId,
            input: {
              actionRunId: request.actionRunId,
              generatorRevisionId: request.generatorRevisionId,
              parameters: request.parameters as Record<
                string,
                import("@clash/shared-types").ExecutablePluginJsonValue
              >,
              invocationInputRefs: [],
            },
          })),
        );
        void options
          .processProjectWork?.(projectId)
          .catch((error) =>
            console.error(
              `[local-api] failed to wake project work for ${projectId}:`,
              error,
            ),
          );
        return c.json({
          captured: false,
          submitted: true,
          stageId: plan.stageId,
          sourceStageRevisionId: plan.sourceStageRevisionId,
          runs,
          frames: plan.runs.map((request, index) => ({
            ...request.parameters,
            actionRunId: request.actionRunId,
            status: (runs[index] as { status?: string }).status,
          })),
        });
      } catch (error) {
        if (error instanceof LocalGeneratorProductError)
          return c.json({ error: error.message, code: error.code }, 409);
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          422,
        );
      }
    }
    if (
      (result as { kind?: unknown }).kind === "timeline-generator-action-plan"
    ) {
      if (!generatorProduct) {
        return c.json(
          { error: "Generator Project authority is unavailable" },
          503,
        );
      }
      const plan = result as {
        actionRunId: string;
        generatorId: string;
        generatorRevisionId: string;
        actionId: string;
        timelineId: string;
        sourceTimelineRevisionId: string;
        target: unknown;
      };
      try {
        const run = await generatorProduct.submit(
          projectId,
          plan.generatorId,
          plan.actionId,
          {
            actionRunId: plan.actionRunId,
            generatorRevisionId: plan.generatorRevisionId,
            parameters: {},
            invocationInputRefs: [],
          },
        );
        void options.processProjectWork?.(projectId).catch((error) => {
          console.error(
            `[local-api] failed to wake project work for ${projectId}:`,
            error instanceof Error ? error.message : String(error),
          );
        });
        return c.json({
          submitted: true,
          timelineId: plan.timelineId,
          sourceTimelineRevisionId: plan.sourceTimelineRevisionId,
          renderNodeId: plan.actionRunId,
          target: plan.target,
          actionRunId: plan.actionRunId,
          run,
        });
      } catch (error) {
        if (error instanceof LocalGeneratorProductError) {
          return c.json({ error: error.message, code: error.code }, 409);
        }
        return c.json(
          { error: error instanceof Error ? error.message : String(error) },
          422,
        );
      }
    }
    if (action === "execute" && !(result as { error?: unknown }).error) {
      void options.processProjectWork?.(projectId).catch((error) => {
        console.error(
          `[local-api] failed to wake project work for ${projectId}:`,
          error instanceof Error ? error.message : String(error),
        );
      });
    }
    return c.json(result);
  });

  app.get("/api/v1/projects/:projectId/canvas/nodes/:nodeId", async (c) => {
    const projectId = c.req.param("projectId");
    const nodeId = c.req.param("nodeId");
    const doc = await replicaStore.recover(projectId);
    const canvas = new Canvas(doc, () => {});
    const node = canvas.readNode(nodeId);
    if (!node) {
      return c.json({ error: `Node not found: ${nodeId}` }, 404);
    }
    return c.json({
      projectId,
      node,
      readToken: canvasNodeReceiptReadToken(node),
    });
  });

  app.patch("/api/v1/projects/:projectId/canvas/nodes/:nodeId", async (c) => {
    const projectId = c.req.param("projectId");
    const nodeId = c.req.param("nodeId");
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    > &
      ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const envelope = {
      operation: "canvas_update",
      entity: { kind: "canvas-node", id: nodeId },
      expectedReadToken: preconditions.expectedReadToken,
    };
    const parsedPatch = canvasNodeDataPatchFromBody(body);
    if (!parsedPatch.ok) {
      return c.json(
        {
          error: parsedPatch.error,
          mutation: hostMutationRejected(envelope, parsedPatch.error),
        },
        400,
      );
    }
    const patch = parsedPatch.patch;
    if (Object.keys(patch).length === 0) {
      const message = "Provide at least one node data field to update";
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(envelope, message),
        },
        400,
      );
    }

    const result =
      await replicaStore.updateSnapshotAtomic<SnapshotWriteRouteResult>(
        projectId,
        async (doc) => {
          const canvas = new Canvas(doc, () => {});
          const node = canvas.readNode(nodeId);
          if (!node) {
            const message = `Node not found: ${nodeId}`;
            return {
              save: false,
              value: {
                status: 404 as const,
                body: {
                  error: message,
                  mutation: hostMutationRejected(envelope, message),
                },
              },
            };
          }

          const currentReadToken = canvasNodeReadToken(node);
          const readProof = validateCanvasReadProof({
            operation: "update",
            actorClientType: preconditions.actorClientType,
            node,
            expectedReadToken: preconditions.expectedReadToken,
            requireReceipt: true,
            readReceiptVerifier: verifyLocalApiCanvasReadReceipt,
          });
          const edges = canvasGuardrailEdges(listCanvasReadProofEdges(doc));
          const patchGuard = validateCanvasNodePatch({
            nodeId,
            node: {
              type: node.type,
              data: node.data as Record<string, unknown>,
            },
            nodes: readCanvasGuardrailNodes(doc),
            edges,
            patch,
          });
          const hostMutation = validateHostMutationEnvelope({
            operation: "canvas_update",
            entity: { kind: "canvas-node", id: nodeId },
            expectedReadToken: preconditions.expectedReadToken,
            currentReadToken,
            guard: readProof.ok ? patchGuard : readProof,
          });
          if (!hostMutation.ok) {
            return {
              save: false,
              value: {
                status: 409 as const,
                body: {
                  error: hostMutation.error,
                  mutation: hostMutation.mutation,
                },
              },
            };
          }

          const ok = canvas.updateNode(nodeId, patch);
          if (!ok) {
            const message = `Node not found: ${nodeId}`;
            return {
              save: false,
              value: {
                status: 404 as const,
                body: {
                  error: message,
                  mutation: hostMutationRejected(
                    hostMutation.envelope,
                    message,
                  ),
                },
              },
            };
          }
          const updatedNode = canvas.readNode(nodeId);
          const afterReadToken = updatedNode
            ? canvasNodeReceiptReadToken(updatedNode)
            : undefined;
          return {
            value: {
              status: 200 as const,
              body: {
                updated: true,
                nodeId,
                ...(updatedNode ? { node: updatedNode } : {}),
                ...(afterReadToken ? { readToken: afterReadToken } : {}),
                mutation: hostMutationSucceeded(hostMutation.envelope, {
                  resultEntityId: nodeId,
                  afterReadToken,
                }),
              },
            },
          };
        },
      );
    if (result.status === 200) {
      const mutation = result.body.mutation as HostMutationRecord | undefined;
      if (mutation?.accepted === true) {
        await db.appendMutationAudit(
          mutationAuditRecord({
            mutation,
            actorClientType: preconditions.actorClientType,
            reason: "canvas node update",
          }),
        );
      }
    }
    return c.json(result.body, result.status);
  });

  app.delete("/api/v1/projects/:projectId/canvas/nodes/:nodeId", async (c) => {
    const projectId = c.req.param("projectId");
    const nodeId = c.req.param("nodeId");
    const body = (await c.req.json().catch(() => ({}))) as ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const envelope = {
      operation: "canvas_delete",
      entity: { kind: "canvas-node", id: nodeId },
      expectedReadToken: preconditions.expectedReadToken,
    };
    const result =
      await replicaStore.updateSnapshotAtomic<SnapshotWriteRouteResult>(
        projectId,
        async (doc) => {
          const canvas = new Canvas(doc, () => {});
          const node = canvas.readNode(nodeId);
          if (!node) {
            const message = `Node not found: ${nodeId}`;
            return {
              save: false,
              value: {
                status: 404 as const,
                body: {
                  error: message,
                  mutation: hostMutationRejected(envelope, message),
                },
              },
            };
          }

          const currentReadToken = canvasNodeReadToken(node);
          const readProof = validateCanvasReadProof({
            operation: "delete",
            actorClientType: preconditions.actorClientType,
            node,
            expectedReadToken: preconditions.expectedReadToken,
            requireReceipt: true,
            readReceiptVerifier: verifyLocalApiCanvasReadReceipt,
          });
          const edges = canvasGuardrailEdges(listCanvasReadProofEdges(doc));
          const deleteGuard = validateCanvasDelete({
            nodeId,
            edges,
          });
          const hostMutation = validateHostMutationEnvelope({
            operation: "canvas_delete",
            entity: { kind: "canvas-node", id: nodeId },
            expectedReadToken: preconditions.expectedReadToken,
            currentReadToken,
            guard: readProof.ok ? deleteGuard : readProof,
          });
          if (!hostMutation.ok) {
            return {
              save: false,
              value: {
                status: 409 as const,
                body: {
                  error: hostMutation.error,
                  mutation: hostMutation.mutation,
                },
              },
            };
          }

          ensureCanvasGraphIdentity(doc);
          const ok = canvas.deleteNode(nodeId);
          if (!ok) {
            const message = `Node not found: ${nodeId}`;
            return {
              save: false,
              value: {
                status: 404 as const,
                body: {
                  error: message,
                  mutation: hostMutationRejected(
                    hostMutation.envelope,
                    message,
                  ),
                },
              },
            };
          }
          return {
            value: {
              status: 200 as const,
              body: {
                deleted: true,
                nodeId,
                mutation: hostMutationSucceeded(hostMutation.envelope, {
                  resultEntityId: nodeId,
                }),
              },
            },
          };
        },
      );
    if (result.status === 200) {
      const mutation = result.body.mutation as HostMutationRecord | undefined;
      if (mutation?.accepted === true) {
        await db.appendMutationAudit(
          mutationAuditRecord({
            mutation,
            actorClientType: preconditions.actorClientType,
            reason: "canvas node delete",
          }),
        );
      }
    }
    return c.json(result.body, result.status);
  });

  app.post("/api/v1/projects/:projectId/canvas/delete-plan", async (c) => {
    const projectId = c.req.param("projectId");
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const nodeIds = stringArray(body.nodeIds);
    const doc = await replicaStore.recover(projectId);
    const plan = readCanvasBatchDeletePlan(doc, nodeIds);
    if (!plan.ok) return c.json({ error: plan.error }, plan.status);
    return c.json({
      projectId,
      nodeIds: plan.nodeIds,
      nodes: plan.nodes,
      edges: plan.edges,
      readToken: plan.readToken,
    });
  });

  app.post("/api/v1/projects/:projectId/canvas/delete-batch", async (c) => {
    const projectId = c.req.param("projectId");
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    > &
      ProjectWriteBody;
    const nodeIds = normalizeCanvasBatchDeleteNodeIds(
      stringArray(body.nodeIds),
    );
    const batchId = nodeIds.join(",");
    const preconditions = requestProjectWritePreconditions(c, body);
    const envelope = {
      operation: "canvas_batch_delete",
      entity: { kind: "canvas-node-batch", id: batchId },
      expectedReadToken: preconditions.expectedReadToken,
    };
    if (nodeIds.length === 0) {
      const message = "delete batch requires at least one node id";
      return c.json(
        {
          error: message,
          mutation: hostMutationRejected(envelope, message),
        },
        400,
      );
    }

    const result =
      await replicaStore.updateSnapshotAtomic<SnapshotWriteRouteResult>(
        projectId,
        async (doc) => {
          const plan = readCanvasBatchDeletePlan(doc, nodeIds);
          if (!plan.ok) {
            return {
              save: false,
              value: {
                status: plan.status,
                body: {
                  error: plan.error,
                  mutation: hostMutationRejected(envelope, plan.error),
                },
              },
            };
          }
          const currentReadToken = canvasBatchDeleteReadToken({
            nodes: plan.nodes,
            edges: plan.edges,
          });
          const readProof = validateCanvasBatchDeleteReadProof({
            actorClientType: preconditions.actorClientType,
            nodes: plan.nodes,
            edges: plan.edges,
            expectedReadToken: preconditions.expectedReadToken,
            requireReceipt: true,
            readReceiptVerifier: verifyLocalApiCanvasBatchDeleteReadReceipt,
          });
          const guardrailEdges = canvasGuardrailEdges(plan.edges);
          const deleteGuard = validateCanvasBatchDelete({
            nodeIds: plan.nodeIds,
            edges: guardrailEdges,
          });
          const hostMutation = validateHostMutationEnvelope({
            operation: "canvas_batch_delete",
            entity: { kind: "canvas-node-batch", id: batchId },
            expectedReadToken: preconditions.expectedReadToken,
            currentReadToken,
            guard: readProof.ok ? deleteGuard : readProof,
          });
          if (!hostMutation.ok) {
            return {
              save: false,
              value: {
                status: 409 as const,
                body: {
                  error: hostMutation.error,
                  mutation: hostMutation.mutation,
                },
              },
            };
          }

          ensureCanvasGraphIdentity(doc);
          const canvas = new Canvas(doc, () => {});
          const deleteResult = canvas.deleteNodes(plan.nodeIds);
          if (deleteResult.deletedNodeIds.length === 0) {
            const message = `Node(s) not found: ${plan.nodeIds.join(", ")}`;
            return {
              save: false,
              value: {
                status: 404 as const,
                body: {
                  error: message,
                  mutation: hostMutationRejected(
                    hostMutation.envelope,
                    message,
                  ),
                },
              },
            };
          }
          return {
            value: {
              status: 200 as const,
              body: {
                deleted: true,
                nodeIds: plan.nodeIds,
                deletedNodeIds: [...deleteResult.deletedNodeIds].sort(),
                deletedEdgeIds: [...deleteResult.deletedEdgeIds].sort(),
                mutation: hostMutationSucceeded(hostMutation.envelope, {
                  resultEntityId: batchId,
                }),
              },
            },
          };
        },
      );
    if (result.status === 200) {
      const mutation = result.body.mutation as HostMutationRecord | undefined;
      if (mutation?.accepted === true) {
        await db.appendMutationAudit(
          mutationAuditRecord({
            mutation,
            actorClientType: preconditions.actorClientType,
            reason: "canvas batch delete",
          }),
        );
      }
    }
    return c.json(result.body, result.status);
  });

  app.get("/api/v1/projects/:projectId/canvas/edges", async (c) => {
    const projectId = c.req.param("projectId");
    const doc = await replicaStore.recover(projectId);
    return c.json({
      projectId,
      ...listCanvasEdgesWithReadReceipts(doc),
    });
  });

  app.post("/api/v1/projects/:projectId/canvas/edges/:edgeId", async (c) => {
    const projectId = c.req.param("projectId");
    const edgeId = c.req.param("edgeId");
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    > &
      ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const envelope = {
      operation: "canvas_add_edge",
      entity: { kind: "canvas-edge", id: edgeId },
      expectedReadToken: preconditions.expectedReadToken,
    };
    const patch = canvasEdgePatchFromBody(body);
    const source = normalizeString(patch.source);
    const target = normalizeString(patch.target);
    if (!source || !target) {
      return c.json(
        {
          error: "Missing edge source or target",
          mutation: hostMutationRejected(
            envelope,
            "Missing edge source or target",
          ),
        },
        400,
      );
    }

    const result =
      await replicaStore.updateSnapshotAtomic<SnapshotWriteRouteResult>(
        projectId,
        async (doc) => {
          const existing = readCanvasEdge(doc, edgeId);
          const currentEdges = listCanvasReadProofEdges(doc);
          const currentReadToken = canvasEdgesReadToken(currentEdges);
          if (existing) {
            const message = `Edge already exists: ${edgeId}`;
            return {
              save: false,
              value: {
                status: 409 as const,
                body: {
                  error: message,
                  mutation: hostMutationRejected(
                    {
                      ...envelope,
                      beforeReadToken: currentReadToken,
                    },
                    message,
                  ),
                },
              },
            };
          }

          const readProof = validateCanvasEdgesReadProof({
            operation: "add",
            actorClientType: preconditions.actorClientType,
            edges: currentEdges,
            expectedReadToken: preconditions.expectedReadToken,
            requireReceipt: true,
            readReceiptVerifier: verifyLocalApiCanvasEdgesReadReceipt,
          });
          const edgeGuard = validateCanvasEdgeAdd({
            edge: { source, target },
            nodes: readCanvasGuardrailNodes(doc),
            edges: canvasGuardrailEdges(currentEdges),
          });
          const hostMutation = validateHostMutationEnvelope({
            operation: "canvas_add_edge",
            entity: { kind: "canvas-edge", id: edgeId },
            expectedReadToken: preconditions.expectedReadToken,
            currentReadToken,
            guard: readProof.ok ? edgeGuard : readProof,
          });
          if (!hostMutation.ok) {
            return {
              save: false,
              value: {
                status: 409 as const,
                body: {
                  error: hostMutation.error,
                  mutation: hostMutation.mutation,
                },
              },
            };
          }

          const canvas = edgeCanvas(doc, { id: edgeId, source, target });
          canvas.insertEdge(
            edgeId,
            source,
            target,
            typeof patch.type === "string" ? patch.type : "default",
            typeof patch.sourceHandle === "string"
              ? patch.sourceHandle
              : undefined,
            typeof patch.targetHandle === "string"
              ? patch.targetHandle
              : undefined,
          );
          const edge = readCanvasEdge(doc, edgeId);
          const afterReadToken = canvasEdgesReceiptReadToken(
            listCanvasReadProofEdges(doc),
          );
          return {
            value: {
              status: 200 as const,
              body: {
                edge: edge ? canvasEdgeResponse(edge) : undefined,
                readToken: afterReadToken,
                mutation: hostMutationSucceeded(hostMutation.envelope, {
                  resultEntityId: edgeId,
                  afterReadToken,
                }),
              },
            },
          };
        },
      );
    if (result.status === 200) {
      const mutation = result.body.mutation as HostMutationRecord | undefined;
      if (mutation?.accepted === true) {
        await db.appendMutationAudit(
          mutationAuditRecord({
            mutation,
            actorClientType: preconditions.actorClientType,
            reason: "canvas edge add",
          }),
        );
      }
    }
    return c.json(result.body, result.status);
  });

  app.patch("/api/v1/projects/:projectId/canvas/edges/:edgeId", async (c) => {
    const projectId = c.req.param("projectId");
    const edgeId = c.req.param("edgeId");
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    > &
      ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const envelope = {
      operation: "canvas_update_edge",
      entity: { kind: "canvas-edge", id: edgeId },
      expectedReadToken: preconditions.expectedReadToken,
    };
    const patch = canvasEdgePatchFromBody(body);
    if (
      Object.prototype.hasOwnProperty.call(patch, "source") &&
      !normalizeString(patch.source)
    ) {
      return c.json(
        {
          error: "Invalid edge source",
          mutation: hostMutationRejected(envelope, "Invalid edge source"),
        },
        400,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, "target") &&
      !normalizeString(patch.target)
    ) {
      return c.json(
        {
          error: "Invalid edge target",
          mutation: hostMutationRejected(envelope, "Invalid edge target"),
        },
        400,
      );
    }

    const result =
      await replicaStore.updateSnapshotAtomic<SnapshotWriteRouteResult>(
        projectId,
        async (doc) => {
          const existing = readCanvasEdge(doc, edgeId);
          if (!existing) {
            const message = `Edge not found: ${edgeId}`;
            return {
              save: false,
              value: {
                status: 404 as const,
                body: {
                  error: message,
                  mutation: hostMutationRejected(envelope, message),
                },
              },
            };
          }
          const currentReadToken = canvasEdgeReadToken(existing);
          const currentEdges = listCanvasReadProofEdges(doc);
          const readProof = validateCanvasEdgeReadProof({
            operation: "update",
            actorClientType: preconditions.actorClientType,
            edge: existing,
            expectedReadToken: preconditions.expectedReadToken,
            requireReceipt: true,
            readReceiptVerifier: verifyLocalApiCanvasEdgeReadReceipt,
          });
          const existingEndpoint =
            typeof existing.source === "string" &&
            typeof existing.target === "string"
              ? { source: existing.source, target: existing.target }
              : null;
          const edgeGuard = validateCanvasEdgePatch({
            existingEdge: existingEndpoint,
            patch,
            nodes: readCanvasGuardrailNodes(doc),
            edges: canvasGuardrailEdges(currentEdges),
          });
          const hostMutation = validateHostMutationEnvelope({
            operation: "canvas_update_edge",
            entity: { kind: "canvas-edge", id: edgeId },
            expectedReadToken: preconditions.expectedReadToken,
            currentReadToken,
            guard: readProof.ok ? edgeGuard : readProof,
          });
          if (!hostMutation.ok) {
            return {
              save: false,
              value: {
                status: 409 as const,
                body: {
                  error: hostMutation.error,
                  mutation: hostMutation.mutation,
                },
              },
            };
          }

          ensureCanvasGraphIdentity(doc);
          const canvas = edgeCanvas(doc, existing);
          canvas.updateEdge(edgeId, {
            ...(Object.prototype.hasOwnProperty.call(patch, "source")
              ? { source: normalizeString(patch.source) }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(patch, "target")
              ? { target: normalizeString(patch.target) }
              : {}),
            ...(typeof patch.type === "string" ? { type: patch.type } : {}),
            ...(typeof patch.sourceHandle === "string"
              ? { sourceHandle: patch.sourceHandle }
              : {}),
            ...(typeof patch.targetHandle === "string"
              ? { targetHandle: patch.targetHandle }
              : {}),
          });
          const updated = readCanvasEdge(doc, edgeId);
          const afterReadToken = updated
            ? canvasEdgeReceiptReadToken(updated)
            : undefined;
          return {
            value: {
              status: 200 as const,
              body: {
                edge: updated ? canvasEdgeResponse(updated) : undefined,
                ...(afterReadToken ? { readToken: afterReadToken } : {}),
                mutation: hostMutationSucceeded(hostMutation.envelope, {
                  resultEntityId: edgeId,
                  afterReadToken,
                }),
              },
            },
          };
        },
      );
    if (result.status === 200) {
      const mutation = result.body.mutation as HostMutationRecord | undefined;
      if (mutation?.accepted === true) {
        await db.appendMutationAudit(
          mutationAuditRecord({
            mutation,
            actorClientType: preconditions.actorClientType,
            reason: "canvas edge update",
          }),
        );
      }
    }
    return c.json(result.body, result.status);
  });

  app.delete("/api/v1/projects/:projectId/canvas/edges/:edgeId", async (c) => {
    const projectId = c.req.param("projectId");
    const edgeId = c.req.param("edgeId");
    const body = (await c.req.json().catch(() => ({}))) as ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const envelope = {
      operation: "canvas_delete_edge",
      entity: { kind: "canvas-edge", id: edgeId },
      expectedReadToken: preconditions.expectedReadToken,
    };
    const result =
      await replicaStore.updateSnapshotAtomic<SnapshotWriteRouteResult>(
        projectId,
        async (doc) => {
          const existing = readCanvasEdge(doc, edgeId);
          if (!existing) {
            const message = `Edge not found: ${edgeId}`;
            return {
              save: false,
              value: {
                status: 404 as const,
                body: {
                  error: message,
                  mutation: hostMutationRejected(envelope, message),
                },
              },
            };
          }

          const currentReadToken = canvasEdgeReadToken(existing);
          const currentEdges = listCanvasReadProofEdges(doc);
          const readProof = validateCanvasEdgeReadProof({
            operation: "delete",
            actorClientType: preconditions.actorClientType,
            edge: existing,
            expectedReadToken: preconditions.expectedReadToken,
            requireReceipt: true,
            readReceiptVerifier: verifyLocalApiCanvasEdgeReadReceipt,
          });
          const existingEndpoint =
            typeof existing.source === "string" &&
            typeof existing.target === "string"
              ? { source: existing.source, target: existing.target }
              : { source: "", target: "" };
          const deleteGuard = validateCanvasEdgeDelete({
            edge: existingEndpoint,
            nodes: readCanvasGuardrailNodes(doc),
            edges: canvasGuardrailEdges(currentEdges),
          });
          const hostMutation = validateHostMutationEnvelope({
            operation: "canvas_delete_edge",
            entity: { kind: "canvas-edge", id: edgeId },
            expectedReadToken: preconditions.expectedReadToken,
            currentReadToken,
            guard: readProof.ok ? deleteGuard : readProof,
          });
          if (!hostMutation.ok) {
            return {
              save: false,
              value: {
                status: 409 as const,
                body: {
                  error: hostMutation.error,
                  mutation: hostMutation.mutation,
                },
              },
            };
          }

          ensureCanvasGraphIdentity(doc);
          const canvas = edgeCanvas(doc, existing);
          canvas.deleteEdge(edgeId);
          const afterReadToken = canvasEdgesReceiptReadToken(
            listCanvasReadProofEdges(doc),
          );
          return {
            value: {
              status: 200 as const,
              body: {
                deleted: true,
                edgeId,
                readToken: afterReadToken,
                mutation: hostMutationSucceeded(hostMutation.envelope, {
                  resultEntityId: edgeId,
                  afterReadToken,
                }),
              },
            },
          };
        },
      );
    if (result.status === 200) {
      const mutation = result.body.mutation as HostMutationRecord | undefined;
      if (mutation?.accepted === true) {
        await db.appendMutationAudit(
          mutationAuditRecord({
            mutation,
            actorClientType: preconditions.actorClientType,
            reason: "canvas edge delete",
          }),
        );
      }
    }
    return c.json(result.body, result.status);
  });

  app.delete("/api/v1/projects/:id", async (c) => {
    const projectId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const recoveryPolicy = await projectRecoveryPolicy(syncConfig);
    const result = await db.update((state) => {
      const project = findActiveProject(state, projectId);
      if (!project) {
        return {
          status: 404 as const,
          body: {
            error: "Project not found",
            mutation: hostMutationRejected(
              {
                operation: "project_delete",
                entity: { kind: "project", id: projectId },
                expectedReadToken: preconditions.expectedReadToken,
              },
              "Project not found",
            ),
          },
        };
      }
      const hostMutation = validateProjectReadMutation({
        project,
        operation: "delete",
        preconditions,
      });
      if (!hostMutation.ok) {
        return {
          status: 409 as const,
          body: { error: hostMutation.error, mutation: hostMutation.mutation },
        };
      }
      const deleted = deleteProjectFromState(state, projectId);
      if (!deleted) {
        return {
          status: 404 as const,
          body: {
            error: "Project not found",
            mutation: hostMutationRejected(
              hostMutation.envelope,
              "Project not found",
            ),
          },
        };
      }
      const readToken = projectReceiptReadToken(deleted);
      return {
        status: 200 as const,
        body: {
          deleted: true,
          recoverable: true,
          id: deleted.id,
          deletedAt: deleted.deletedAt,
          readToken,
          recoveryPolicy,
          mutation: hostMutationSucceeded(hostMutation.envelope, {
            resultEntityId: deleted.id,
            afterReadToken: readToken,
          }),
        },
      };
    });
    if (result.status === 200) {
      const mutation = result.body.mutation as HostMutationRecord | undefined;
      if (mutation?.accepted === true) {
        await db.appendMutationAudit(
          mutationAuditRecord({
            mutation,
            actorClientType: preconditions.actorClientType,
            reason: "project soft delete",
          }),
        );
        syncProjectMetadataInBackground(projectId);
      }
    }
    return c.json(result.body, result.status);
  });

  app.post("/api/v1/projects/:id/restore", async (c) => {
    const projectId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    const recoveryPolicy = await projectRecoveryPolicy(syncConfig);
    const result = await db.update((state) => {
      const project = state.projects.find(
        (candidate) =>
          candidate.id === projectId && isDeletedProject(candidate),
      );
      if (!project) {
        return {
          status: 404 as const,
          body: {
            error: "Project recovery point not found",
            mutation: hostMutationRejected(
              {
                operation: "project_restore",
                entity: { kind: "project", id: projectId },
                expectedReadToken: preconditions.expectedReadToken,
              },
              "Project recovery point not found",
            ),
          },
        };
      }
      const hostMutation = validateProjectReadMutation({
        project,
        operation: "restore",
        preconditions,
      });
      if (!hostMutation.ok) {
        return {
          status: 409 as const,
          body: { error: hostMutation.error, mutation: hostMutation.mutation },
        };
      }
      const restored = restoreProjectInState(state, projectId);
      if (!restored) {
        return {
          status: 404 as const,
          body: {
            error: "Project recovery point not found",
            mutation: hostMutationRejected(
              hostMutation.envelope,
              "Project recovery point not found",
            ),
          },
        };
      }
      const readToken = projectReceiptReadToken(restored);
      return {
        status: 200 as const,
        body: {
          restored: true,
          id: restored.id,
          readToken,
          recoveryPolicy,
          mutation: hostMutationSucceeded(hostMutation.envelope, {
            resultEntityId: restored.id,
            afterReadToken: readToken,
          }),
        },
      };
    });
    if (result.status === 200) {
      const mutation = result.body.mutation as HostMutationRecord | undefined;
      if (mutation?.accepted === true) {
        await db.appendMutationAudit(
          mutationAuditRecord({
            mutation,
            actorClientType: preconditions.actorClientType,
            reason: "project restore",
          }),
        );
        syncProjectMetadataInBackground(projectId);
      }
    }
    return c.json(result.body, result.status);
  });

  app.delete("/api/v1/projects/:id/purge", async (c) => {
    const projectId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as ProjectWriteBody & {
      confirm?: unknown;
    };
    const preconditions = requestProjectWritePreconditions(c, body);
    const recoveryPolicy = await projectRecoveryPolicy(syncConfig);
    const purgedRecoveryPolicy = {
      ...recoveryPolicy,
      localRestoreAllowed: false,
    };
    if (body.confirm !== "purge") {
      return c.json(
        {
          error: 'confirm must be "purge"',
          mutation: hostMutationRejected(
            {
              operation: "project_purge",
              entity: { kind: "project", id: projectId },
              expectedReadToken: preconditions.expectedReadToken,
            },
            'confirm must be "purge"',
          ),
        },
        400,
      );
    }

    const result = await db.update((state) => {
      const project = state.projects.find(
        (candidate) => candidate.id === projectId,
      );
      if (!project) {
        return {
          status: 404 as const,
          body: {
            error: "Project recovery point not found",
            mutation: hostMutationRejected(
              {
                operation: "project_purge",
                entity: { kind: "project", id: projectId },
                expectedReadToken: preconditions.expectedReadToken,
              },
              "Project recovery point not found",
            ),
          },
        };
      }
      if (!isDeletedProject(project)) {
        return {
          status: 409 as const,
          body: {
            error: "Project must be deleted before purge",
            mutation: hostMutationRejected(
              {
                operation: "project_purge",
                entity: { kind: "project", id: projectId },
                expectedReadToken: preconditions.expectedReadToken,
              },
              "Project must be deleted before purge",
            ),
          },
        };
      }
      const hostMutation = validateProjectReadMutation({
        project,
        operation: "purge",
        preconditions,
      });
      if (!hostMutation.ok) {
        return {
          status: 409 as const,
          body: { error: hostMutation.error, mutation: hostMutation.mutation },
        };
      }
      const purgeAfter = projectPurgeAfter(project);
      if (!canPurgeProject(project)) {
        const message = `Project purge is delayed until ${purgeAfter}.`;
        return {
          status: 409 as const,
          body: {
            error: message,
            recoverable: true,
            purgeAfter,
            recoveryPolicy,
            mutation: hostMutationRejected(hostMutation.envelope, message),
          },
        };
      }
      const purged = purgeProjectFromState(state, projectId);
      if (!purged) {
        return {
          status: 404 as const,
          body: {
            error: "Project recovery point not found",
            mutation: hostMutationRejected(
              hostMutation.envelope,
              "Project recovery point not found",
            ),
          },
        };
      }
      return {
        status: 200 as const,
        body: {
          purged: true,
          recoverable: false,
          id: purged.project.id,
          deletedAt: purged.project.deletedAt,
          purgeAfter,
          removed: purged.counts,
          recoveryPolicy: purgedRecoveryPolicy,
          mutation: hostMutationSucceeded(hostMutation.envelope, {
            resultEntityId: purged.project.id,
          }),
        },
      };
    });
    if (result.status === 200) {
      await replicaStore.deleteReplica(projectId);
      const mutation = result.body.mutation as HostMutationRecord | undefined;
      if (mutation?.accepted === true) {
        await db.appendMutationAudit(
          mutationAuditRecord({
            mutation,
            actorClientType: preconditions.actorClientType,
            reason: "project purge",
          }),
        );
      }
      return c.json({ ...result.body, replicaDeleted: true }, result.status);
    }
    return c.json(result.body, result.status);
  });

  app.get("/api/v1/mutation-audit", async (c) => {
    const limit = Number(c.req.query("limit"));
    const records = await db.listMutationAudit({
      operation: normalizeString(c.req.query("operation")),
      entityId: normalizeString(c.req.query("entityId")),
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return c.json({ records });
  });

  app.get("/api/v1/sessions", async (c) => {
    const state = await db.load();
    const projectId = c.req.query("projectId");
    const archiveFilter = c.req.query("archived") ?? "active";
    if (!["active", "only", "include"].includes(archiveFilter)) {
      return c.json({ error: "Invalid archived filter" }, 400);
    }
    const activeProjectIds = new Set(
      activeProjects(state).map((project) => project.id),
    );
    const filterArchive = (session: LocalSession) =>
      archiveFilter === "include" ||
      (archiveFilter === "only"
        ? session.archivedAt !== undefined
        : session.archivedAt === undefined);
    const matchingSessions = projectId
      ? isDeletedKnownProject(state, projectId)
        ? []
        : state.sessions.filter(
            (session) =>
              session.projectId === projectId && filterArchive(session),
          )
      : state.sessions.filter(
          (session) =>
            filterArchive(session) &&
            (!isDeletedKnownProject(state, session.projectId) ||
              activeProjectIds.has(session.projectId)),
        );
    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");
    const paginated = rawLimit !== undefined || rawOffset !== undefined;
    if (!paginated) {
      return c.json({ sessions: matchingSessions.map(publicLocalSession) });
    }
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return c.json({ error: "limit must be an integer from 1 to 100" }, 400);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return c.json({ error: "offset must be a non-negative integer" }, 400);
    }
    const page = matchingSessions.slice(offset, offset + limit);
    const hasMore = offset + page.length < matchingSessions.length;
    return c.json({
      sessions: page.map(publicLocalSession),
      hasMore,
      nextOffset: hasMore ? offset + page.length : null,
    });
  });

  app.post("/api/v1/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      title?: string;
    } & ProjectWriteBody;
    const preconditions = requestProjectWritePreconditions(c, body);
    if (!body.projectId) {
      return c.json(
        {
          error: "Missing projectId",
          mutation: hostMutationRejected(
            {
              operation: "session_create",
              entity: { kind: "session", id: "" },
            },
            "Missing projectId",
          ),
        },
        400,
      );
    }
    const created = await db.update((state) => {
      if (isDeletedKnownProject(state, body.projectId!)) {
        return {
          ok: false as const,
          error: "Project is deleted; restore it before creating sessions",
        };
      }
      const at = nowIso();
      const session: LocalSession = {
        id: crypto.randomUUID(),
        projectId: body.projectId!,
        title: body.title?.trim() || "Session",
        type: "cloud",
        createdAt: at,
        updatedAt: at,
      };
      state.sessions.unshift(session);
      return { ok: true as const, session };
    });
    if (!created.ok) {
      return c.json(
        {
          error: created.error,
          mutation: hostMutationRejected(
            {
              operation: "session_create",
              entity: { kind: "session", id: "" },
            },
            created.error,
          ),
        },
        409,
      );
    }
    const mutation = hostMutationSucceeded(
      {
        operation: "session_create",
        entity: { kind: "session", id: created.session.id },
      },
      {
        resultEntityId: created.session.id,
      },
    );
    await db.appendMutationAudit(
      mutationAuditRecord({
        mutation,
        actorClientType: preconditions.actorClientType,
        reason: "session create",
      }),
    );
    return c.json({
      threadId: created.session.id,
      title: created.session.title,
      mutation,
    });
  });

  app.patch("/api/v1/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = (await c.req.json().catch(() => ({}))) as {
      archived?: unknown;
      title?: unknown;
    } & ProjectWriteBody;
    const isRename = body.title !== undefined;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (isRename && !title) {
      return c.json({ error: "Session title cannot be empty" }, 400);
    }
    if (isRename && body.archived !== undefined) {
      return c.json(
        { error: "Rename and archive must be separate mutations" },
        400,
      );
    }
    if (!isRename && typeof body.archived !== "boolean") {
      return c.json({ error: "Missing archived boolean or title" }, 400);
    }
    const preconditions = requestProjectWritePreconditions(c, body);
    const operation = isRename
      ? "rename"
      : body.archived
        ? "archive"
        : "restore";
    const result = await db.update((state) => {
      const session = state.sessions.find(
        (candidate) => candidate.id === sessionId,
      );
      if (!session) {
        return {
          status: 404 as const,
          body: {
            error: "Not found",
            mutation: hostMutationRejected(
              {
                operation: `session_${operation}`,
                entity: { kind: "session", id: sessionId },
              },
              "Not found",
            ),
          },
        };
      }

      const requiresReadProofEnvelope =
        preconditions.actorClientType === "agent" ||
        Boolean(preconditions.expectedReadToken);
      const hostMutation = requiresReadProofEnvelope
        ? validateSessionReadMutation({
            session,
            operation,
            preconditions,
          })
        : null;
      if (hostMutation && !hostMutation.ok) {
        return {
          status: 409 as const,
          body: {
            error: hostMutation.error,
            mutation: hostMutation.mutation,
          },
        };
      }

      const at = nowIso();
      if (isRename) session.title = title;
      else if (body.archived) session.archivedAt = at;
      else delete session.archivedAt;
      session.updatedAt = at;
      const mutation = hostMutationSucceeded(
        hostMutation?.envelope ?? {
          operation: `session_${operation}`,
          entity: { kind: "session", id: sessionId },
        },
        {
          afterReadToken: sessionReadToken(session),
          resultEntityId: sessionId,
        },
      );
      return {
        status: 200 as const,
        body: {
          ok: true,
          session: publicLocalSession(session),
          mutation,
        },
      };
    });

    if (result.status === 200) {
      const mutation = result.body.mutation as HostMutationRecord;
      await db.appendMutationAudit(
        mutationAuditRecord({
          mutation,
          actorClientType: preconditions.actorClientType,
          reason: `session ${operation}`,
        }),
      );
    }
    return c.json(result.body, result.status);
  });

  app.delete("/api/v1/sessions", async (c) => {
    const threadId = c.req.query("threadId");
    if (!threadId) {
      return c.json(
        {
          error: "Missing threadId",
          mutation: hostMutationRejected(
            {
              operation: "session_delete",
              entity: { kind: "session", id: "" },
            },
            "Missing threadId",
          ),
        },
        400,
      );
    }

    const preconditions = requestProjectWritePreconditions(c);
    const result = await db.update((state) => {
      const session = state.sessions.find(
        (candidate) => candidate.id === threadId,
      );
      if (!session) {
        return {
          status: 404 as const,
          body: {
            error: "Not found",
            mutation: hostMutationRejected(
              {
                operation: "session_delete",
                entity: { kind: "session", id: threadId },
              },
              "Not found",
            ),
          },
        };
      }
      if (!preconditions.actorClientType && !preconditions.expectedReadToken) {
        state.sessions = state.sessions.filter(
          (session) => session.id !== threadId,
        );
        state.sessionMessages = state.sessionMessages.filter(
          (message) => message.session_id !== threadId,
        );
        return {
          status: 200 as const,
          body: {
            ok: true,
            mutation: hostMutationSucceeded(
              {
                operation: "session_delete",
                entity: { kind: "session", id: threadId },
              },
              {
                resultEntityId: threadId,
              },
            ),
          },
        };
      }
      const hostMutation = validateSessionReadMutation({
        session,
        operation: "delete",
        preconditions,
      });
      if (!hostMutation.ok) {
        return {
          status: 409 as const,
          body: {
            error: hostMutation.error,
            mutation: hostMutation.mutation,
          },
        };
      }
      state.sessions = state.sessions.filter(
        (session) => session.id !== threadId,
      );
      state.sessionMessages = state.sessionMessages.filter(
        (message) => message.session_id !== threadId,
      );
      return {
        status: 200 as const,
        body: {
          ok: true,
          mutation: hostMutationSucceeded(hostMutation.envelope, {
            resultEntityId: threadId,
          }),
        },
      };
    });
    if (result.status === 200) {
      const mutation = result.body.mutation as HostMutationRecord | undefined;
      if (mutation?.accepted === true) {
        await db.deleteSessionEvents(threadId);
        await db.appendMutationAudit(
          mutationAuditRecord({
            mutation,
            actorClientType: preconditions.actorClientType,
            reason: "session delete",
          }),
        );
      }
    }
    return c.json(result.body, result.status);
  });

  app.all("/api/custom-action/upload", (c) =>
    c.json(
      {
        error:
          "Legacy ClashAgent custom-action transport is retired; install a clash.plugin/v1 executable plugin.",
        code: "LEGACY_CUSTOM_ACTION_PROTOCOL_RETIRED",
      },
      410,
    ),
  );

  /**
   * Where a plugin streams bytes it was given a slot for.
   *
   * The token is the authorisation: it was minted for one upload, handed to one plugin, and is
   * forgotten once collected. There is no listing and no second PUT -- an unknown or spent token is
   * a 404, so a leaked one names nothing.
   */
  app.put("/api/v1/plugin-uploads/:token", async (c) => {
    const accepted = options.acceptPluginUpload?.(
      c.req.param("token"),
      new Uint8Array(await c.req.arrayBuffer()),
    );
    if (!accepted) return c.json({ error: "unknown upload" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/v1/director-model-generations", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      actionRunId?: string;
      projectId?: string;
      prompt?: string;
      quality?: "normal" | "low-poly" | "geometry";
      pbr?: boolean;
      faceCount?: number;
    };
    const projectId =
      typeof body.projectId === "string" ? body.projectId.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const actionRunId =
      typeof body.actionRunId === "string" ? body.actionRunId.trim() : "";
    const quality =
      body.quality === "low-poly" || body.quality === "geometry"
        ? body.quality
        : "normal";
    if (!projectId || !prompt) {
      return c.json(
        { error: "projectId and a 3D model prompt are required" },
        400,
      );
    }
    if (!actionRunId) {
      return c.json({ error: "actionRunId is required" }, 400);
    }
    if (actionRunId.length > 256) {
      return c.json(
        { error: "actionRunId must be at most 256 characters" },
        400,
      );
    }
    const state = await db.load();
    if (!state.projects.some((project) => project.id === projectId)) {
      return c.json({ error: `Project ${projectId} not found` }, 404);
    }
    const falAccount = providerAccountsForRuntime(
      state.providerAccounts,
      userId,
      state.providerOAuth,
    ).find(
      (account) => account.providerId === "fal" && account.enabled !== false,
    );
    if (!falAccount?.id) {
      return c.json(
        {
          error: "3D generation requires an enabled fal.ai provider account",
        },
        503,
      );
    }
    if (!options.resolvePluginBinding || !options.processProjectWork) {
      return c.json(
        { error: "The local durable Provider runtime is unavailable" },
        503,
      );
    }
    const identity = { actionRunId, outputSlot: "media" };
    try {
      const existing = await durableRunJournal.load(identity);
      if (existing) {
        const facts = directorRunFacts(existing);
        const executor = jsonRecord(existing.executorInput);
        const input = jsonRecord(executor?.input);
        const values = jsonRecord(input?.values);
        const params = jsonRecord(values?.modelParams);
        const sameFaceCount =
          typeof body.faceCount === "number"
            ? params?.faceCount === body.faceCount
            : params?.faceCount === undefined;
        if (
          !facts ||
          facts.projectId !== projectId ||
          values?.prompt !== prompt ||
          params?.quality !== quality ||
          params?.pbr !== (body.pbr !== false) ||
          !sameFaceCount
        ) {
          return c.json(
            {
              error: `Durable run ${actionRunId}/media already exists with different frozen input.`,
            },
            409,
          );
        }
        void options.processProjectWork(projectId).catch((error) => {
          console.error(
            `[local-api] failed to resume Director generation ${actionRunId}:`,
            errorMessage(error),
          );
        });
        return directorRunResponse(c, existing);
      }
      const binding = await options.resolvePluginBinding(
        "clash.fal",
        "fal-execute",
        "provider-executor",
      );
      const run = await createLocalDurableRun({
        ownerId: "local-api",
        journal: durableRunJournal,
        command: {
          type: "create",
          actionRunId,
          outputSlot: "media",
          deadlineAt: Date.now() + providerGenerationDeadlineMs,
          executor: {
            binding,
            accountId: falAccount.id,
            kind: "model",
            projectId,
            provider: "fal",
            modelEndpoint: "fal-ai/hunyuan3d-v3/text-to-3d",
            delivery: {
              kind: "project-asset",
              actionId: "director:model-generation",
              name: "generated-model.glb",
              prompt,
            },
            input: {
              values: {
                kind: "model",
                upstreamModel: "fal-ai/hunyuan3d-v3/text-to-3d",
                prompt,
                modelParams: {
                  quality,
                  pbr: body.pbr !== false,
                  ...(typeof body.faceCount === "number"
                    ? { faceCount: body.faceCount }
                    : {}),
                },
              },
              references: [],
            },
          },
        },
      });
      void options.processProjectWork(projectId).catch((error) => {
        console.error(
          `[local-api] failed to wake Director generation ${actionRunId}:`,
          errorMessage(error),
        );
      });
      return directorRunResponse(c, run);
    } catch (error) {
      const message = errorMessage(error);
      if (/already exists with different frozen input/i.test(message)) {
        return c.json({ error: message }, 409);
      }
      return c.json({ error: message }, 502);
    }
  });

  app.get("/api/v1/director-model-generations/:actionRunId", async (c) => {
    const actionRunId = c.req.param("actionRunId").trim();
    const projectId = c.req.query("projectId")?.trim() ?? "";
    if (!actionRunId || !projectId) {
      return c.json({ error: "actionRunId and projectId are required" }, 400);
    }
    const run = await durableRunJournal.load({
      actionRunId,
      outputSlot: "media",
    });
    const facts = run ? directorRunFacts(run) : null;
    if (!run || !facts || facts.projectId !== projectId) {
      return c.json({ error: "Director generation not found" }, 404);
    }
    if (run.phase !== "succeeded" && run.phase !== "failed") {
      void options.processProjectWork?.(projectId).catch((error) => {
        console.error(
          `[local-api] failed to resume Director generation ${actionRunId}:`,
          errorMessage(error),
        );
      });
    }
    return directorRunResponse(c, run);
  });

  app.post("/api/v1/edits", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return c.json({ error: "Missing file" }, 400);
    }
    const projectId = String(form.get("projectId") ?? "").trim();
    const sourceAssetId = String(form.get("sourceAssetId") ?? "").trim();
    const editKind = String(form.get("editKind") ?? "").trim();
    const outputKind = String(form.get("outputKind") ?? "").trim() as AssetKind;
    const originRaw = String(form.get("origin") ?? "canvas-node").trim();
    const origin: "canvas-node" | "asset-preview" =
      originRaw === "asset-preview" ? "asset-preview" : "canvas-node";
    const actionRunId = String(form.get("actionRunId") ?? "").trim();
    if (!projectId || !sourceAssetId) {
      return c.json({ error: "Missing projectId or sourceAssetId" }, 400);
    }
    if (!actionRunId || actionRunId.length > 256) {
      return c.json(
        { error: "actionRunId is required and must be at most 256 characters" },
        400,
      );
    }
    if (editKind !== "image-editor" && editKind !== "video-clipper") {
      return c.json({ error: `Invalid editKind: ${editKind}` }, 400);
    }
    if (
      outputKind !== "image" &&
      outputKind !== "video" &&
      outputKind !== "audio"
    ) {
      return c.json({ error: `Invalid outputKind: ${outputKind}` }, 400);
    }
    let editParams: unknown;
    try {
      editParams = JSON.parse(String(form.get("editParams") ?? "{}"));
    } catch {
      return c.json({ error: "editParams is not valid JSON" }, 400);
    }
    let invocation: AssetEditActionInvocation;
    try {
      invocation = parseAssetEditInvocation({
        raw: form.get("invocation"),
        projectId,
        sourceAssetId,
        editKind,
        editParams,
        origin,
      });
    } catch (error) {
      return c.json(
        { error: `Invalid action invocation: ${errorMessage(error)}` },
        400,
      );
    }
    if (
      invocation.projectId !== projectId ||
      invocation.source.assetId !== sourceAssetId ||
      invocation.actionId !== editKind
    ) {
      return c.json(
        { error: "Action invocation does not match legacy edit fields" },
        400,
      );
    }
    if (
      resolveAssetActionOutputKind(invocation.actionId, invocation.params) !==
      outputKind
    ) {
      return c.json(
        { error: "outputKind does not match the action operation" },
        400,
      );
    }
    const assetService = projectAssetServiceAt(requestOrigin(c));
    const source = await assetService.read(projectId, sourceAssetId);
    if (!source) return c.json({ error: "Source asset not found" }, 404);
    if (source.kind !== invocation.source.kind) {
      return c.json(
        { error: "Action invocation source kind does not match the asset" },
        400,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentType =
      file.type ||
      (outputKind === "image"
        ? "image/png"
        : outputKind === "video"
          ? "video/mp4"
          : "audio/mpeg");
    const outputAssetId = editOutputAssetId(actionRunId);
    try {
      const staged = await assetService.stageOwned({
        kind: outputKind,
        bytes,
        contentType,
        name: file.name || `edit-${actionRunId}`,
      });
      const asset = await assetService.publishStagedOwnedWithBindings({
        projectId,
        projectAssetId: outputAssetId,
        kind: outputKind,
        resourceId: staged.resourceId,
        name: file.name || `edit-${actionRunId}`,
        metadata: { bytes: bytes.byteLength, contentType },
        provenance: {
          kind: "edit",
          actionRunId,
          model: actionSourceModel(invocation),
        },
        bindings: editActionAssetBindings({
          invocation,
          actionRunId,
          outputAssetId,
        }),
      });
      return c.json(asset);
    } catch (error) {
      return localProjectAssetErrorResponse(error);
    }
  });

  app.post("/api/v1/edits/video-crop", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      actionRunId?: string;
      projectId?: string;
      sourceAssetId?: string;
      params?: { mode?: string; startSec?: number; endSec?: number };
      origin?: string;
      invocation?: unknown;
    };
    const { projectId, sourceAssetId, params } = body;
    const actionRunId = body.actionRunId?.trim() ?? "";
    if (
      !actionRunId ||
      actionRunId.length > 256 ||
      !projectId ||
      !sourceAssetId ||
      params?.mode !== "crop" ||
      typeof params.startSec !== "number" ||
      typeof params.endSec !== "number" ||
      params.startSec < 0 ||
      params.endSec <= params.startSec
    ) {
      return c.json({ error: "Invalid video crop request" }, 400);
    }
    const origin: "canvas-node" | "asset-preview" =
      body.origin === "asset-preview" ? "asset-preview" : "canvas-node";
    let invocation: AssetEditActionInvocation;
    try {
      invocation = parseAssetEditInvocation({
        raw:
          body.invocation === undefined
            ? undefined
            : JSON.stringify(body.invocation),
        projectId,
        sourceAssetId,
        editKind: ASSET_ACTION_ID.VideoClipper,
        editParams: params,
        origin,
      });
    } catch (error) {
      return c.json(
        { error: `Invalid action invocation: ${errorMessage(error)}` },
        400,
      );
    }
    if (
      invocation.actionId !== ASSET_ACTION_ID.VideoClipper ||
      invocation.projectId !== projectId ||
      invocation.source.assetId !== sourceAssetId ||
      invocation.params.mode !== "crop"
    ) {
      return c.json(
        { error: "Action invocation does not match video crop fields" },
        400,
      );
    }
    const assetService = projectAssetServiceAt(requestOrigin(c));
    const source = await assetService.read(projectId, sourceAssetId);
    if (!source) return c.json({ error: "Source asset not found" }, 404);
    if (source.kind !== "video")
      return c.json({ error: "Source asset is not a video" }, 400);
    const ffmpeg = localFfmpegPath();
    if (!ffmpeg)
      return c.json({ error: "ffmpeg is required for video trimming" }, 503);

    let inputPath: string;
    try {
      inputPath = (await assetService.openProjection(projectId, sourceAssetId))
        .path;
    } catch (error) {
      return localProjectAssetErrorResponse(error);
    }
    await mkdir(options.dataDir, { recursive: true });
    const tempDir = await mkdtemp(join(options.dataDir, "video-crop-"));
    const outputPath = join(tempDir, "output.mp4");
    try {
      await execFileAsync(ffmpeg, [
        "-y",
        "-ss",
        String(params.startSec),
        "-i",
        inputPath,
        "-t",
        String(params.endSec - params.startSec),
        "-map",
        "0",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outputPath,
      ]);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      return c.json(
        { error: `Video trim failed: ${errorMessage(error)}` },
        500,
      );
    }
    const bytes = new Uint8Array(await readFile(outputPath));
    await rm(tempDir, { recursive: true, force: true });
    const outputAssetId = editOutputAssetId(actionRunId);
    try {
      const staged = await assetService.stageOwned({
        kind: "video",
        bytes,
        contentType: "video/mp4",
        name: `trimmed-${source.name ?? source.id}.mp4`,
      });
      const asset = await assetService.publishStagedOwnedWithBindings({
        projectId,
        projectAssetId: outputAssetId,
        kind: "video",
        resourceId: staged.resourceId,
        name: `trimmed-${source.name ?? source.id}.mp4`,
        metadata: {
          bytes: bytes.byteLength,
          contentType: "video/mp4",
        },
        provenance: {
          kind: "edit",
          actionRunId,
          model: actionSourceModel(invocation),
        },
        bindings: editActionAssetBindings({
          invocation,
          actionRunId,
          outputAssetId,
        }),
      });
      return c.json(asset);
    } catch (error) {
      return localProjectAssetErrorResponse(error);
    }
  });

  return app;
}
