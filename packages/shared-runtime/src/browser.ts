// Browser-safe public surface. Keep Node filesystem, process, and daemon
// helpers behind the root or explicit Node subpath exports.
//
// Worker/browser bundlers resolve @clash/shared-runtime here via the "browser"
// condition, so every Worker-safe API the root entry publishes must be listed
// below with the same explicit export blocks as index.ts.
export { createTimelineClient, type ObservedProjectTimeline } from "./timeline-client.js";

export {
  sendProjectHostCommand,
  projectHostCommandUrl,
  ProjectHostHttpError,
  type ProjectHostResponse,
  type ProjectHostHttpRequest,
} from "./project-host-http.js";

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

export { visibleUserPromptText } from "./prompt-content.js";

export {
  createAssetEditPluginModule,
  invokeAssetEditPlugin,
  type AssetEditExecutionInput,
  type AssetEditExecutor,
} from "./asset-edit-plugin.js";

export {
  generateTextCompletion,
  type TextContentPart,
  type TextGenerationInput,
  type TextGenerationMessage,
  type TextGenerationResult,
  type TextProviderKind,
} from "./text-generation.js";

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
