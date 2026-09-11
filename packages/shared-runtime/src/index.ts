export * from "./generator-client.js";
export * from "./document-client.js";
export * from "./generator-readback.js";
export { createTimelineClient, type ObservedProjectTimeline } from "./timeline-client.js";

export {
  createAssetEditPluginModule,
  invokeAssetEditPlugin,
  type AssetEditExecutionInput,
  type AssetEditExecutor,
} from "./asset-edit-plugin.js";

export {
  apiUrl,
  defaultRuntimeCapabilities,
  desktopChromeMetrics,
  desktopTrafficLightPosition,
  resolveRuntimeConfig,
  syncWebSocketUrl,
  webSocketUrl,
  type ResolvedRuntimeEndpointConfig,
  type RuntimeCapabilities,
  type RuntimeCapabilityOverrides,
  type RuntimeEndpointConfig,
  type RuntimeMode,
} from "./runtime-config.js";

export {
  METADATA_BODY_BLOB_DIRNAME,
  canonicalMetadataBody,
  metadataBodyBlobPath,
  metadataBodyContentHash,
  readMetadataBody,
  storeMetadataBody,
  type StoredMetadataBody,
} from "./metadata-body-blobs.js";

export {
  publishContentAddressedFile,
  type ContentAddressedFilePublication,
} from "./content-addressed-file.js";

export {
  DEFAULT_WORKSPACE_BUNDLE_VERIFICATION_LIMITS,
  WORKSPACE_BUNDLE_MANIFEST_FILE,
  WorkspaceBundleIntegrityError,
  createWorkspaceBundleManifest,
  materializeVerifiedWorkspaceBundleFile,
  verifyWorkspaceBundleDirectory,
  writeWorkspaceBundleManifest,
  workspaceBundleDigest,
  type MaterializedWorkspaceBundleFile,
  type MaterializeVerifiedWorkspaceBundleFileInput,
  type UnsignedWorkspaceBundleManifest,
  type WorkspaceBundleIntegrityErrorCode,
  type WorkspaceBundleVerificationLimits,
  type WorkspaceBundleVerificationOptions,
} from "./workspace-bundle.js";

export {
  DEFAULT_WORKSPACE_TREE_PACKING_LIMITS,
  WorkspaceTreePackingError,
  materializeWorkspaceTree,
  planWorkspaceTree,
  workspaceTreePathPolicy,
  type MaterializedWorkspaceTree,
  type PlanWorkspaceTreeInput,
  type WorkspaceTreeExcludedPath,
  type WorkspaceTreeExcludedReason,
  type WorkspaceTreePackingErrorCode,
  type WorkspaceTreePackingLimits,
  type WorkspaceTreePathPolicy,
  type WorkspaceTreePlan,
  type WorkspaceTreePlannedFile,
} from "./workspace-tree.js";

export {
  planCascadeTick,
  type CascadeAdoptDecision,
  type CascadeClearDecision,
  type CascadeClearReason,
  type CascadeDecision,
  type CascadeGraphEdge,
  type CascadeGraphNode,
  type CascadeTickInput,
  type CascadeTickPlan,
} from "./cascade-scheduler.js";

export {
  generateTextCompletion,
  type TextContentPart,
  type TextGenerationInput,
  type TextGenerationMessage,
  type TextGenerationResult,
  type TextProviderKind,
} from "./text-generation.js";

export { visibleUserPromptText } from "./prompt-content.js";

export { resolveWorkspaceTextInput } from "./workspace-text-input.js";

export {
  DurableRunEngine,
  createBoundedRetryPolicy,
  createDurableRunRecord,
  durableRunIdempotencyKey,
  type DurableOutputStore,
  type DurableOwnerGuard,
  type DurableProjectPublisher,
  type DurableProviderExecutor,
  type DurableProviderFailure,
  type DurableProviderStep,
  type DurableRetryPolicy,
  type DurableRetryPolicyInput,
  type DurableRunAdvanceResult,
  type DurableRunAttempt,
  type DurableRunAttemptCounts,
  type DurableRunClock,
  type DurableRunEngineOptions,
  type DurableRunFailureCounts,
  type DurableRunIdentity,
  type DurableRunJournal,
  type DurableRunOperation,
  type DurableRunOwner,
  type DurableRunPhase,
  type DurableRunRecord,
} from "./durable-run-engine.js";

export {
  createProjectMetadataReplicator,
  type ProjectMetadataReplicatorOptions,
  type ProjectMetadataStore,
  type ProjectMetadataSyncRemote,
  type ProjectMetadataSyncResult,
} from "./project-metadata-sync.js";

export * from "./project-cloud-sync.js";

export {
  buildMiniMaxH3Content,
  type MiniMaxH3ContentInput,
  type MiniMaxH3OrderedContentPart,
} from "./minimax-h3.js";

export {
  buildBflFlux3VideoRequest,
  submitBflFlux3Video,
  pollBflFlux3VideoOnce,
  resolveFlux3KeyframeIndices,
  type BflFlux3VideoInput,
  type BflFlux3VideoRequestOptions,
  type BflFlux3VideoResult,
} from "./bfl-video.js";

export {
  createGeminiOmniInteraction,
  downloadGeminiOmniVideo,
  extractGeminiOmniVideo,
  geminiOmniInteractionId,
  geminiOmniInteractionStatus,
  getGeminiOmniInteraction,
  type CreateGeminiOmniInteractionInput,
  type GeminiOmniInputPart,
  type GeminiOmniInteraction,
  type GeminiOmniVideoOutput,
  type GetGeminiOmniInteractionInput,
} from "./gemini-omni.js";

export {
  createPikaMediaJob,
  getPikaMediaJob,
  getPikaMediaContent,
  PIKA_MEDIA_BASE_URL,
  uploadPikaMedia,
  type PikaMediaJob,
  type PikaMediaStatus,
} from "./pika-media.js";

export {
  buildPikaMediaRequest,
  type PikaMediaRequest,
  type PikaMediaRequestInput,
} from "./pika-request.js";

export { generatePikaChat, type PikaChatResult } from "./pika-chat.js";

export {
  fetchPikaCatalogQuote,
  pikaBillingBasis,
  quotePikaCatalogRequest,
  type PikaCatalogEntry,
  type PikaCatalogPriceTier,
  type PikaCatalogPricingComponent,
  type PikaCatalogQuote,
  type PikaQuoteComponent,
} from "./pika-pricing.js";

export {
  buildProjectRecoveryPolicy,
  buildProjectStatus,
  PROJECT_TIMELINE_APPLY_COMMAND,
  PROJECT_TIMELINE_FILE_PATTERN,
  PROJECT_TIMELINE_PUBLIC_COMMANDS,
  PROJECT_TIMELINE_PULL_COMMAND,
  projectIdPathSegment,
  projectWorkspaceId,
  type ProjectRecoveryPolicy,
  type ProjectRecoveryPolicyReason,
  type ProjectStatusActionGate,
  type ProjectStatusActionGateReason,
  type ProjectStatusActionGates,
  type ProjectStatus,
  type ProjectReplicationState,
  type ProjectStatusContext,
  type ProjectStatusCurrentWorkspace,
  type ProjectStatusMarker,
  type ProjectStatusStorage,
  type ProjectStatusSource,
  type ProjectWorkspaceIdKind,
} from "./project-status.js";

export {
  initializeClashWorkspace,
  type ClashWorkspaceInitialization,
} from "./workspace-init.js";

export {
  CLASH_MCP_COMMANDS,
  CLASH_MCP_COMMAND_IDS,
  buildClashMcpCommandMenu,
  classifyClashMcpTool,
  getClashMcpCommand,
  type ClashMcpCommand,
  type ClashMcpCommandId,
  type ClashMcpCommandMenu,
  type ClashMcpToolFamily,
} from "./mcp-command-menu.js";

export {
  PROJECT_ASSET_READ_RECEIPT_HEADER,
  createPersonalGlobalAssetHostClient,
  createProjectAssetHostClient,
  resolveAssetImportFileType,
  type AssetImportFileType,
  type PersonalGlobalAssetHostClient,
  type ProjectAssetHostClient,
  type ProjectAssetHostObservation,
  type ProjectAssetHostResult,
  type ProjectAssetHostScope,
} from "./project-asset-client.js";

export const LOCAL_HOST_RECORD_SCHEMA_VERSION = 1;
export const LOCAL_HOST_PROTOCOL_VERSION = 1;
export const LOCAL_HOST_DATA_SCHEMA_VERSION = 1;

export type HostLaunchMode =
  "desktop" | "plugin" | "cli-once" | "user-service" | "launchd";

export type HostStartedBy =
  "desktop" | "plugin" | "cli" | "user-service" | "launchd";

export interface LocalHostDiscoveryRecord {
  schemaVersion: typeof LOCAL_HOST_RECORD_SCHEMA_VERSION;
  protocolVersion: number;
  dataSchemaVersion: number;
  hostId: string;
  endpoint: string;
  pid: number;
  launchMode: HostLaunchMode;
  startedBy: HostStartedBy;
  /** Runtime channel that owns this host. Missing legacy records are production. */
  profile?: "dev" | "prod";
  /** Content identity of the executable host artifact. */
  runtimeFingerprint?: string;
  agentCliPath?: string;
  ownerClientId?: string;
  startedAt: string;
  updatedAt: string;
}

export interface LocalHostShutdownClient {
  clientKind: "desktop" | "plugin" | "cli" | "user-service" | "launchd";
  clientId?: string;
}

export function isLocalHostDiscoveryRecord(
  value: unknown,
): value is LocalHostDiscoveryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LocalHostDiscoveryRecord>;
  return (
    record.schemaVersion === LOCAL_HOST_RECORD_SCHEMA_VERSION &&
    typeof record.protocolVersion === "number" &&
    Number.isInteger(record.protocolVersion) &&
    typeof record.dataSchemaVersion === "number" &&
    Number.isInteger(record.dataSchemaVersion) &&
    typeof record.hostId === "string" &&
    record.hostId.length > 0 &&
    typeof record.endpoint === "string" &&
    record.endpoint.length > 0 &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    isHostLaunchMode(record.launchMode) &&
    isHostStartedBy(record.startedBy) &&
    (record.profile === undefined ||
      record.profile === "dev" ||
      record.profile === "prod") &&
    (record.runtimeFingerprint === undefined ||
      (typeof record.runtimeFingerprint === "string" &&
        record.runtimeFingerprint.length > 0)) &&
    (record.agentCliPath === undefined ||
      (typeof record.agentCliPath === "string" &&
        record.agentCliPath.length > 0)) &&
    (record.ownerClientId === undefined ||
      typeof record.ownerClientId === "string") &&
    typeof record.startedAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

export function isCompatibleHost(
  record: LocalHostDiscoveryRecord,
  clientProtocolVersion: number,
): boolean {
  return (
    record.schemaVersion === LOCAL_HOST_RECORD_SCHEMA_VERSION &&
    record.protocolVersion <= clientProtocolVersion
  );
}

export function shouldClientOwnShutdown(
  record: LocalHostDiscoveryRecord,
  client: LocalHostShutdownClient,
): boolean {
  if (
    !record.ownerClientId ||
    !client.clientId ||
    record.ownerClientId !== client.clientId
  ) {
    return false;
  }
  if (record.launchMode === "desktop") {
    return record.startedBy === "desktop" && client.clientKind === "desktop";
  }
  if (record.launchMode === "plugin") {
    return record.startedBy === "plugin" && client.clientKind === "plugin";
  }
  return false;
}

function isHostLaunchMode(value: unknown): value is HostLaunchMode {
  return (
    value === "desktop" ||
    value === "plugin" ||
    value === "cli-once" ||
    value === "user-service" ||
    value === "launchd"
  );
}

function isHostStartedBy(value: unknown): value is HostStartedBy {
  return (
    value === "desktop" ||
    value === "plugin" ||
    value === "cli" ||
    value === "user-service" ||
    value === "launchd"
  );
}

export {
  resolveDaemonNodeRuntime,
  defaultDaemonNodeCandidates,
  type DaemonNodeRuntime,
  type DaemonNodeRuntimeSource,
} from "./local-daemon-runtime.js";
