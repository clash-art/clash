/**
 * @clash/action-sdk — Executable-plugin ABI and authoring helpers.
 *
 * Plugins contribute actions, projectors, and Provider executors. The Host
 * supplies invocation-scoped SDK implementations for account state, Asset
 * references, uploads, and Host tools.
 *
 * @example
 * ```typescript
 * import { assemblePlugin, defineExecutor } from '@clash/action-sdk';
 * const executor = defineExecutor({ async submit(invocation, context) { ... } });
 * await assemblePlugin({ manifestDir, contributes: { execute: executor } }).start();
 * ```
 */

export {
  ProviderExecutionError,
  executableFailureFromThrown,
  providerHttpError,
  providerHttpFailure,
  type ProviderHttpFailureInput,
} from "./executable-failure.js";

export {
  PluginViewResourceSchema,
  ExecutablePluginViewStateSchema,
  listPluginViewAssetReferences,
  type PluginViewResource,
  type ExecutablePluginViewState,
  type PluginViewAssetReference,
} from "./browser.js";

export type {
  AssetKind,
  ExecutablePluginAssetHandle,
  ExecutablePluginBinding,
  ExecutablePluginInvocation,
  ExecutablePluginOutput,
  ExecutablePluginReference,
  ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";

export {
  defineStdioExecutablePlugin,
  type StdioExecutablePlugin,
  type StdioExecutablePluginHandler,
  type StdioExecutablePluginOptions,
} from "./stdio-plugin.js";

export {
  createExecutorContext,
  definePlugin,
  type DefinedPlugin,
  type Executor,
  type ExecutorContext,
  type ExecutorContextOverrides,
  type ExecutorStep,
  type HostDependencyRequest,
  type ResolvedReference,
  type AssetUploadRequest,
  type AssetWriteRequest,
  type DocumentOutputRequest,
  type CodexImageGenerateRequest,
  type DirectorStageCaptureRequest,
  type DirectorStageCaptureResult,
  type MediaAnalyzeRequest,
  type MediaAnalyzeResult,
  type SpeechTranscribeRequest,
  type SpeechTranscribeResult,
  type PluginDefinition,
  type PluginHostTools,
  type PluginStoreHandle,
} from "./define-plugin.js";

export {
  assemblePlugin,
  assemblePluginModule,
  defineAction,
  defineActionExecutor,
  defineExecutor,
  defineProjector,
  servePluginStdio,
  type AssembleOptions,
  type AssembledPlugin,
  type ManifestFunction,
  type PluginExecutionRealm,
  type PluginModule,
  type ProjectorFn,
} from "./assemble.js";
