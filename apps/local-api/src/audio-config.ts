import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPythonLocalAsrRuntime,
  createPythonLocalTtsRuntime,
  type LocalAsrTranscription,
  type LocalAsrRuntime as LocalAsrRuntimePort,
  type LocalModelStatus,
  type LocalSpeechCapability,
  type LocalTtsRuntime as LocalTtsRuntimePort,
  type LocalTtsSynthesis,
} from "@clash/sdk";
import { createSqliteLocalConfigStore, type SqliteLocalConfigStore } from "./local-config-store.js";
import {
  createClashUserConfigStore,
  type ClashUserConfigStore,
} from "./user-config.js";
import { clashHomeForLocalDataDir } from "./local-paths.js";
import {
  createManagedLocalModelPythonEnvironment,
  type ManagedLocalModelPythonEnvironment,
  withManagedPythonAsrRuntime,
  withManagedPythonTtsRuntime,
} from "./managed-local-model-python.js";

export type LocalAsrProvider = "builtin-funasr";
export type LocalTtsProvider = "builtin-piper";
export type LocalAsrRuntime = "builtin-rpc";
export type LocalSpeechSetupStatus = "disabled" | "needs-install" | "ready";

export interface PublicLocalAudioConfig {
  asr: {
    capability: "speech-to-text";
    enabled: boolean;
    provider: LocalAsrProvider;
    base_url: string | null;
    model: string;
    has_api_key: boolean;
    ready: boolean;
    setup: {
      provider: "funasr";
      runtime: LocalAsrRuntime;
      status: LocalSpeechSetupStatus;
      available: boolean;
      default_base_url: string | null;
      commands: string[];
      message?: string;
    };
  };
  tts: {
    capability: "text-to-speech";
    enabled: boolean;
    provider: LocalTtsProvider;
    base_url: null;
    model: string;
    has_api_key: false;
    ready: boolean;
    setup: {
      provider: "piper";
      runtime: LocalAsrRuntime;
      status: LocalSpeechSetupStatus;
      available: boolean;
      default_base_url: null;
      commands: string[];
      message?: string;
    };
  };
}

export type LocalAudioConfigReadState = PublicLocalAudioConfig & {
  updated_at: string;
};

export type PublicLocalVoiceInputConfig = Pick<PublicLocalAudioConfig, "asr">;

export interface LocalVoiceInputSelection {
  enabled: boolean;
  model: string;
}

export interface PublicLocalSpeechModelStatus {
  capability: LocalSpeechCapability;
  model: string;
  available: boolean;
  message?: string;
}

export interface BuiltinFunAsrTranscribeInput {
  file: File;
  model: string;
  language?: string | null;
}

export interface LocalAudioConfigStore {
  getPublicConfig(): Promise<PublicLocalAudioConfig>;
  getReadState?(): Promise<LocalAudioConfigReadState>;
  getVoiceInputConfig?(): Promise<PublicLocalVoiceInputConfig>;
  getVoiceInputSelection?(): Promise<LocalVoiceInputSelection>;
  getModelStatus(input: { capability?: unknown; model?: unknown }): Promise<PublicLocalSpeechModelStatus>;
  updateFromRequest(input: Record<string, unknown>): Promise<PublicLocalAudioConfig>;
  installBuiltin(input?: { capability?: unknown; model?: unknown }): Promise<PublicLocalAudioConfig>;
  removeBuiltin(input: { capability?: unknown; model?: unknown }): Promise<PublicLocalAudioConfig>;
  warmupVoiceInput?(input?: { model?: string }): Promise<LocalModelStatus>;
  transcribe(input: {
    file: File;
    language?: string | null;
    model?: string;
  }): Promise<LocalAsrTranscription>;
  synthesize(input: {
    model: string;
    text: string;
    voice?: string | null;
    speed?: number;
  }): Promise<{
    audio: Uint8Array;
    metadata: Omit<LocalTtsSynthesis, "outputPath">;
  }>;
}

export class LocalAudioConfigError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface LocalAudioConfigFile {
  version: 2;
  asrEnabled: boolean;
  asrProvider: LocalAsrProvider;
  asrBaseUrl: string | null;
  asrApiKey: string | null;
  asrModel: string;
  ttsEnabled: boolean;
  ttsProvider: LocalTtsProvider;
  ttsModel: string;
  updatedAt: string;
}

interface BuiltinFunAsrStatus {
  available: boolean;
  message?: string;
}

interface LocalAudioConfigStoreOptions {
  dataDir: string;
  pythonBinary?: string;
  pythonSdkPath?: string;
  clashHome?: string;
  managedPythonEnvironment?: ManagedLocalModelPythonEnvironment;
  asrRuntime?: LocalAsrRuntimePort;
  ttsRuntime?: LocalTtsRuntimePort;
  builtinStatus?: () => Promise<BuiltinFunAsrStatus>;
  builtinInstall?: (input: { model: string; pythonBinary: string }) => Promise<void>;
  builtinTranscribe?: (input: BuiltinFunAsrTranscribeInput) => Promise<LocalAsrTranscription>;
}

const DEFAULT_ASR_PROVIDER: LocalAsrProvider = "builtin-funasr";
const DEFAULT_ASR_MODEL = "iic/SenseVoiceSmall";
const DEFAULT_TTS_PROVIDER: LocalTtsProvider = "builtin-piper";
const DEFAULT_TTS_MODEL = "zh_CN-huayan-medium";
const DEFAULT_PYTHON_BINARY = "python3";
const LOCAL_AUDIO_CONFIG_KEY = "local-audio-config";
const RUNTIME_STATUS_CACHE_TTL_MS = 30_000;

interface CachedRuntimeStatus {
  value: LocalModelStatus;
  expiresAt: number;
}

function normalizeProvider(value: unknown): LocalAsrProvider {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_ASR_PROVIDER;
  }
  if (value === "builtin-funasr" || value === "openai-compatible") {
    return DEFAULT_ASR_PROVIDER;
  }
  throw new LocalAudioConfigError("asr_provider must be builtin-funasr");
}

function normalizeModel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeTtsProvider(value: unknown): LocalTtsProvider {
  if (value === undefined || value === null || value === "" || value === DEFAULT_TTS_PROVIDER) {
    return DEFAULT_TTS_PROVIDER;
  }
  throw new LocalAudioConfigError("tts_provider must be builtin-piper");
}

function normalizeCapability(value: unknown): LocalSpeechCapability {
  if (value === undefined || value === null || value === "" || value === "asr" || value === "speech-to-text") {
    return "speech-to-text";
  }
  if (value === "tts" || value === "text-to-speech") {
    return "text-to-speech";
  }
  throw new LocalAudioConfigError("capability must be speech-to-text or text-to-speech");
}

function normalizeEnabled(value: unknown): boolean {
  return value === true;
}

function defaultConfig(): LocalAudioConfigFile {
  return {
    version: 2,
    asrEnabled: false,
    asrProvider: DEFAULT_ASR_PROVIDER,
    asrBaseUrl: null,
    asrApiKey: null,
    asrModel: DEFAULT_ASR_MODEL,
    ttsEnabled: false,
    ttsProvider: DEFAULT_TTS_PROVIDER,
    ttsModel: DEFAULT_TTS_MODEL,
    updatedAt: new Date(0).toISOString(),
  };
}

function setupStatus(enabled: boolean, builtinStatus: BuiltinFunAsrStatus): LocalSpeechSetupStatus {
  if (!enabled) return "disabled";
  return builtinStatus.available ? "ready" : "needs-install";
}

async function publicConfig(
  config: LocalAudioConfigFile,
  asrStatus: BuiltinFunAsrStatus,
  ttsStatus: BuiltinFunAsrStatus,
): Promise<PublicLocalAudioConfig> {
  const asrSetupStatus = setupStatus(config.asrEnabled, asrStatus);
  const ttsSetupStatus = setupStatus(config.ttsEnabled, ttsStatus);
  return {
    asr: {
      capability: "speech-to-text",
      enabled: config.asrEnabled,
      provider: DEFAULT_ASR_PROVIDER,
      base_url: null,
      model: config.asrModel,
      has_api_key: false,
      ready: asrSetupStatus === "ready",
      setup: {
        provider: "funasr",
        runtime: "builtin-rpc",
        status: asrSetupStatus,
        available: asrStatus.available,
        default_base_url: null,
        commands: [],
        ...(asrStatus.message ? { message: asrStatus.message } : {}),
      },
    },
    tts: {
      capability: "text-to-speech",
      enabled: config.ttsEnabled,
      provider: DEFAULT_TTS_PROVIDER,
      base_url: null,
      model: config.ttsModel,
      has_api_key: false,
      ready: ttsSetupStatus === "ready",
      setup: {
        provider: "piper",
        runtime: "builtin-rpc",
        status: ttsSetupStatus,
        available: ttsStatus.available,
        default_base_url: null,
        commands: [],
        ...(ttsStatus.message ? { message: ttsStatus.message } : {}),
      },
    },
  };
}

async function readState(
  config: LocalAudioConfigFile,
  asrStatus: BuiltinFunAsrStatus,
  ttsStatus: BuiltinFunAsrStatus,
): Promise<LocalAudioConfigReadState> {
  return {
    ...(await publicConfig(config, asrStatus, ttsStatus)),
    updated_at: config.updatedAt,
  };
}

async function readLegacyConfig(store: SqliteLocalConfigStore): Promise<LocalAudioConfigFile | null> {
  const data = await store.getJson<Partial<LocalAudioConfigFile>>(LOCAL_AUDIO_CONFIG_KEY);
  if (!data) return null;
  return {
    version: 2,
    asrEnabled: data.asrEnabled === true,
    asrProvider: normalizeProvider(data.asrProvider),
    asrBaseUrl: null,
    asrApiKey: null,
    asrModel: normalizeModel(data.asrModel, DEFAULT_ASR_MODEL),
    ttsEnabled: data.ttsEnabled === true,
    ttsProvider: normalizeTtsProvider(data.ttsProvider),
    ttsModel: normalizeModel(data.ttsModel, DEFAULT_TTS_MODEL),
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date(0).toISOString(),
  };
}

function normalizeYamlAudioConfig(value: unknown): LocalAudioConfigFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const asr = record.asr && typeof record.asr === "object" && !Array.isArray(record.asr)
    ? record.asr as Record<string, unknown>
    : {};
  const tts = record.tts && typeof record.tts === "object" && !Array.isArray(record.tts)
    ? record.tts as Record<string, unknown>
    : {};
  return {
    version: 2,
    asrEnabled: asr.enabled === true,
    asrProvider: normalizeProvider(asr.provider),
    asrBaseUrl: null,
    asrApiKey: null,
    asrModel: normalizeModel(asr.model, DEFAULT_ASR_MODEL),
    ttsEnabled: tts.enabled === true,
    ttsProvider: normalizeTtsProvider(tts.provider),
    ttsModel: normalizeModel(tts.model, DEFAULT_TTS_MODEL),
    updatedAt: typeof record.updated_at === "string"
      ? record.updated_at
      : new Date(0).toISOString(),
  };
}

function yamlAudioConfig(config: LocalAudioConfigFile): Record<string, unknown> {
  return {
    asr: {
      enabled: config.asrEnabled,
      provider: config.asrProvider,
      model: config.asrModel,
    },
    tts: {
      enabled: config.ttsEnabled,
      provider: config.ttsProvider,
      model: config.ttsModel,
    },
    updated_at: config.updatedAt,
  };
}

async function writeConfig(store: ClashUserConfigStore, config: LocalAudioConfigFile): Promise<void> {
  await store.setSection("audio", yamlAudioConfig(config));
}

function defaultClashSdkPythonPath(): string {
  const explicit = process.env.CLASH_PYTHON_SDK_PATH?.trim();
  if (explicit) return resolve(explicit);
  const inherited = process.env.PYTHONPATH
    ?.split(delimiter)
    .find((entry) => entry && existsSync(join(entry, "clash_sdk", "local_models", "rpc.py")));
  if (inherited) return resolve(inherited);
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..", "packages", "clash-sdk", "python");
}

function displayErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRuntimeStatusCache() {
  const cached = new Map<string, CachedRuntimeStatus>();
  const inFlight = new Map<string, Promise<LocalModelStatus>>();
  let generation = 0;

  return {
    read(model: string, load: () => Promise<LocalModelStatus>): Promise<LocalModelStatus> {
      const now = Date.now();
      const existing = cached.get(model);
      if (existing && existing.expiresAt > now) return Promise.resolve(existing.value);

      const pending = inFlight.get(model);
      if (pending) return pending;

      const requestGeneration = generation;
      const request = Promise.resolve()
        .then(load)
        .catch((error: unknown): LocalModelStatus => ({
          available: false,
          message: displayErrorMessage(error),
        }))
        .then((status) => {
          if (generation === requestGeneration) {
            cached.set(model, {
              value: status,
              expiresAt: Date.now() + RUNTIME_STATUS_CACHE_TTL_MS,
            });
          }
          return status;
        })
        .finally(() => {
          if (inFlight.get(model) === request) inFlight.delete(model);
        });
      inFlight.set(model, request);
      return request;
    },

    invalidate(): void {
      generation += 1;
      cached.clear();
      inFlight.clear();
    },
  };
}

function createHookBackedRuntime(
  options: LocalAudioConfigStoreOptions,
  pythonBinary: string,
  cacheDir: string,
  pythonPath: string,
): LocalAsrRuntimePort | null {
  if (!options.builtinStatus && !options.builtinInstall && !options.builtinTranscribe) return null;
  const fallback = createPythonLocalAsrRuntime({
    pythonBinary,
    pythonPath,
    cacheDir,
  });
  return {
    async status({ model }) {
      if (options.builtinStatus) return options.builtinStatus();
      if (options.builtinTranscribe) return { available: true };
      return fallback.status({ model });
    },
    async deploy(input) {
      if (options.builtinInstall) {
        await options.builtinInstall({ model: input.model, pythonBinary });
        return;
      }
      await fallback.deploy(input);
    },
    async warmup({ model }) {
      if (options.builtinTranscribe) return { available: true };
      return fallback.warmup?.({ model }) ?? fallback.status({ model });
    },
    async transcribe(input) {
      if (!options.builtinTranscribe) return fallback.transcribe(input);
      const file = new File(
        [await readFile(input.audioPath)],
        basename(input.audioPath),
        { type: "audio/webm" },
      );
      return options.builtinTranscribe({
        file,
        model: input.model,
        language: input.language,
      });
    },
  };
}

function createDefaultAsrRuntime(
  options: LocalAudioConfigStoreOptions,
  pythonBinary: string,
  cacheDir: string,
  pythonPath: string,
): LocalAsrRuntimePort {
  return options.asrRuntime
    ?? createHookBackedRuntime(options, pythonBinary, cacheDir, pythonPath)
    ?? createPythonLocalAsrRuntime({
      pythonBinary,
      pythonPath,
      cacheDir,
    });
}

function createDefaultTtsRuntime(
  options: LocalAudioConfigStoreOptions,
  pythonBinary: string,
  cacheDir: string,
  pythonPath: string,
): LocalTtsRuntimePort {
  return options.ttsRuntime
    ?? createPythonLocalTtsRuntime({
      pythonBinary,
      pythonPath,
      cacheDir,
    });
}

async function transcribeWithRuntime(
  runtime: LocalAsrRuntimePort,
  input: { file: File; language?: string | null },
  model: string,
): Promise<LocalAsrTranscription> {
  const dir = await mkdtemp(join(tmpdir(), "clash-asr-"));
  const extension = extname(input.file.name || "") || ".webm";
  const audioPath = join(dir, basename(input.file.name || `input${extension}`));
  try {
    // Streamed: a file-backed source never materializes in Host memory.
    await pipeline(
      Readable.fromWeb(input.file.stream() as NodeReadableStream<Uint8Array>),
      createWriteStream(audioPath),
    );
    return await runtime.transcribe({
      model,
      audioPath,
      language: input.language,
    });
  } catch (error) {
    if (error instanceof LocalAudioConfigError) throw error;
    throw new LocalAudioConfigError(`Local ASR transcription failed: ${displayErrorMessage(error)}`, 502);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createLocalAudioConfigStore(
  options: LocalAudioConfigStoreOptions,
): LocalAudioConfigStore & {
  getVoiceInputConfig(): Promise<PublicLocalVoiceInputConfig>;
  getVoiceInputSelection(): Promise<LocalVoiceInputSelection>;
  warmupVoiceInput(input?: { model?: string }): Promise<LocalModelStatus>;
} {
  const configStore = createClashUserConfigStore(options.dataDir);
  const legacyStore = createSqliteLocalConfigStore(options.dataDir);
  const explicitPythonBinary = options.pythonBinary?.trim()
    || process.env.CLASH_LOCAL_MODELS_PYTHON?.trim();
  const pythonSdkPath = options.pythonSdkPath ?? defaultClashSdkPythonPath();
  const usesManagedPython = !explicitPythonBinary;
  const managedPythonEnvironment = usesManagedPython
    ? options.managedPythonEnvironment ?? createManagedLocalModelPythonEnvironment({
      clashHome: options.clashHome ?? clashHomeForLocalDataDir(options.dataDir),
      sdkPythonPath: pythonSdkPath,
    })
    : null;
  const pythonBinary = explicitPythonBinary
    ?? managedPythonEnvironment?.pythonBinary
    ?? DEFAULT_PYTHON_BINARY;
  const asrCacheDir = join(options.dataDir, "models", "speech", "asr");
  const defaultAsrRuntime = createDefaultAsrRuntime(options, pythonBinary, asrCacheDir, pythonSdkPath);
  const asrRuntime = managedPythonEnvironment
    && !options.asrRuntime
    && !options.builtinStatus
    && !options.builtinInstall
    && !options.builtinTranscribe
    ? withManagedPythonAsrRuntime(defaultAsrRuntime, managedPythonEnvironment)
    : defaultAsrRuntime;
  const ttsCacheDir = join(options.dataDir, "models", "speech", "tts");
  const defaultTtsRuntime = createDefaultTtsRuntime(options, pythonBinary, ttsCacheDir, pythonSdkPath);
  const ttsRuntime = managedPythonEnvironment && !options.ttsRuntime
    ? withManagedPythonTtsRuntime(defaultTtsRuntime, managedPythonEnvironment)
    : defaultTtsRuntime;
  const asrStatusCache = createRuntimeStatusCache();
  const ttsStatusCache = createRuntimeStatusCache();
  const asrWarmups = new Map<string, Promise<LocalModelStatus>>();

  let migration: Promise<void> | null = null;
  async function ensureMigrated(): Promise<void> {
    migration ??= (async () => {
      if (normalizeYamlAudioConfig(await configStore.getSection("audio"))) return;
      const legacy = await readLegacyConfig(legacyStore);
      if (!legacy) return;
      await writeConfig(configStore, legacy);
      await legacyStore.delete(LOCAL_AUDIO_CONFIG_KEY);
    })();
    return migration;
  }

  async function current(): Promise<LocalAudioConfigFile> {
    await ensureMigrated();
    return normalizeYamlAudioConfig(await configStore.getSection("audio")) ?? defaultConfig();
  }

  async function currentAsrStatus(model: string): Promise<LocalModelStatus> {
    return asrStatusCache.read(model, () => asrRuntime.status({ model, cacheDir: asrCacheDir }));
  }

  async function currentTtsStatus(model: string): Promise<LocalModelStatus> {
    return ttsStatusCache.read(model, () => ttsRuntime.status({ model, cacheDir: ttsCacheDir }));
  }

  function invalidateRuntimeStatus(capability?: LocalSpeechCapability): void {
    if (!capability || capability === "speech-to-text") asrStatusCache.invalidate();
    if (!capability || capability === "text-to-speech") ttsStatusCache.invalidate();
  }

  async function currentPublicConfig(config: LocalAudioConfigFile): Promise<PublicLocalAudioConfig> {
    const [asrStatus, ttsStatus] = await Promise.all([
      currentAsrStatus(config.asrModel),
      currentTtsStatus(config.ttsModel),
    ]);
    return publicConfig(config, asrStatus, ttsStatus);
  }

  async function currentReadState(config: LocalAudioConfigFile): Promise<LocalAudioConfigReadState> {
    const [asrStatus, ttsStatus] = await Promise.all([
      currentAsrStatus(config.asrModel),
      currentTtsStatus(config.ttsModel),
    ]);
    return readState(config, asrStatus, ttsStatus);
  }

  return {
    async getPublicConfig() {
      const config = await current();
      return currentPublicConfig(config);
    },

    async getReadState() {
      const config = await current();
      return currentReadState(config);
    },

    async getVoiceInputConfig() {
      const config = await current();
      const asrStatus = config.asrEnabled
        ? await currentAsrStatus(config.asrModel)
        : { available: false };
      const { asr } = await publicConfig(config, asrStatus, { available: false });
      return { asr };
    },

    async getVoiceInputSelection() {
      const config = await current();
      return {
        enabled: config.asrEnabled,
        model: config.asrModel,
      };
    },

    async getModelStatus(input) {
      const capability = normalizeCapability(input.capability);
      const config = await current();
      const defaultModel = capability === "text-to-speech" ? config.ttsModel : config.asrModel;
      const model = normalizeModel(input.model, defaultModel);
      const status = capability === "text-to-speech"
        ? await currentTtsStatus(model)
        : await currentAsrStatus(model);
      return {
        capability,
        model,
        available: status.available,
        ...(status.message ? { message: status.message } : {}),
      };
    },

    async warmupVoiceInput(input = {}) {
      const config = await current();
      if (!config.asrEnabled) {
        throw new LocalAudioConfigError(
          "Voice input is not enabled. Open Settings > Voice input and enable it.",
          409,
        );
      }
      const model = normalizeModel(input.model, config.asrModel);
      const existing = asrWarmups.get(model);
      if (existing) return existing;
      const warming = (
        asrRuntime.warmup?.({ model, cacheDir: asrCacheDir })
        ?? currentAsrStatus(model)
      ).finally(() => {
        if (asrWarmups.get(model) === warming) asrWarmups.delete(model);
      });
      asrWarmups.set(model, warming);
      return warming;
    },

    async updateFromRequest(input) {
      const existing = await current();
      const enabled = Object.prototype.hasOwnProperty.call(input, "asr_enabled")
        ? normalizeEnabled(input.asr_enabled)
        : existing.asrEnabled;
      const provider = Object.prototype.hasOwnProperty.call(input, "asr_provider")
        ? normalizeProvider(input.asr_provider)
        : DEFAULT_ASR_PROVIDER;
      const model = Object.prototype.hasOwnProperty.call(input, "asr_model")
        ? normalizeModel(input.asr_model, DEFAULT_ASR_MODEL)
        : existing.asrModel;
      const ttsEnabled = Object.prototype.hasOwnProperty.call(input, "tts_enabled")
        ? normalizeEnabled(input.tts_enabled)
        : existing.ttsEnabled;
      const ttsProvider = Object.prototype.hasOwnProperty.call(input, "tts_provider")
        ? normalizeTtsProvider(input.tts_provider)
        : DEFAULT_TTS_PROVIDER;
      const ttsModel = Object.prototype.hasOwnProperty.call(input, "tts_model")
        ? normalizeModel(input.tts_model, DEFAULT_TTS_MODEL)
        : existing.ttsModel;

      const next: LocalAudioConfigFile = {
        version: 2,
        asrEnabled: enabled,
        asrProvider: provider,
        asrBaseUrl: null,
        asrApiKey: null,
        asrModel: model,
        ttsEnabled,
        ttsProvider,
        ttsModel,
        updatedAt: new Date().toISOString(),
      };
      await writeConfig(configStore, next);
      invalidateRuntimeStatus();
      return currentPublicConfig(next);
    },

    async installBuiltin(input = {}) {
      const config = await current();
      const capability = normalizeCapability(input.capability);
      const defaultModel = capability === "text-to-speech" ? config.ttsModel : config.asrModel;
      const model = Object.prototype.hasOwnProperty.call(input, "model")
        ? normalizeModel(input.model, defaultModel)
        : defaultModel;
      try {
        if (capability === "text-to-speech") {
          await ttsRuntime.deploy({ model, kind: "tts", cacheDir: ttsCacheDir });
        } else {
          await asrRuntime.deploy({ model, kind: "asr", cacheDir: asrCacheDir });
        }
        invalidateRuntimeStatus(capability);
        const deployedStatus = capability === "text-to-speech"
          ? await currentTtsStatus(model)
          : await currentAsrStatus(model);
        if (!deployedStatus.available) {
          throw new LocalAudioConfigError(
            `Local ${capability === "text-to-speech" ? "TTS" : "ASR"} model did not become ready after install.${deployedStatus.message ? ` ${deployedStatus.message}` : ""}`,
            502,
          );
        }
      } catch (error) {
        if (error instanceof LocalAudioConfigError) throw error;
        const label = capability === "text-to-speech" ? "TTS" : "ASR";
        throw new LocalAudioConfigError(`Local ${label} deploy failed: ${displayErrorMessage(error)}`, 502);
      }
      const next: LocalAudioConfigFile = {
        ...config,
        ...(capability === "text-to-speech"
          ? {
              ttsProvider: DEFAULT_TTS_PROVIDER,
              ttsModel: model,
            }
          : {
              asrProvider: DEFAULT_ASR_PROVIDER,
              asrBaseUrl: null,
              asrApiKey: null,
              asrModel: model,
            }),
        updatedAt: new Date().toISOString(),
      };
      await writeConfig(configStore, next);
      return currentPublicConfig(next);
    },

    async removeBuiltin(input) {
      const config = await current();
      const capability = normalizeCapability(input.capability);
      const defaultModel = capability === "text-to-speech" ? config.ttsModel : config.asrModel;
      const model = Object.prototype.hasOwnProperty.call(input, "model")
        ? normalizeModel(input.model, defaultModel)
        : defaultModel;
      try {
        if (capability === "text-to-speech") {
          await ttsRuntime.remove({ model, cacheDir: ttsCacheDir });
        } else if (asrRuntime.remove) {
          await asrRuntime.remove({ model, cacheDir: asrCacheDir });
        } else {
          throw new Error("Selected ASR runtime does not support removing cached models");
        }
        invalidateRuntimeStatus(capability);
      } catch (error) {
        if (error instanceof LocalAudioConfigError) throw error;
        const label = capability === "text-to-speech" ? "TTS" : "ASR";
        throw new LocalAudioConfigError(`Local ${label} removal failed: ${displayErrorMessage(error)}`, 502);
      }
      const next = {
        ...config,
        updatedAt: new Date().toISOString(),
      };
      await writeConfig(configStore, next);
      return currentPublicConfig(next);
    },

    async transcribe(input) {
      const config = await current();
      if (!config.asrEnabled) {
        throw new LocalAudioConfigError(
          "Local ASR is not enabled. Open Settings > Audio and enable voice input.",
          409,
        );
      }

      const model = normalizeModel(input.model, config.asrModel);
      const status = await currentAsrStatus(model);
      if (!status.available) {
        throw new LocalAudioConfigError(
          `Selected ASR model is not deployed. Open Settings > Models and deploy it.${status.message ? ` ${status.message}.` : ""}`,
          409,
        );
      }
      return transcribeWithRuntime(asrRuntime, input, model);
    },

    async synthesize(input) {
      if (!input.text.trim()) {
        throw new LocalAudioConfigError("Local TTS text is required");
      }
      const model = normalizeModel(input.model, DEFAULT_TTS_MODEL);
      const status = await currentTtsStatus(model);
      if (!status.available) {
        throw new LocalAudioConfigError(
          `Selected TTS model is not downloaded. Open Settings > Models and download it.${status.message ? ` ${status.message}.` : ""}`,
          409,
        );
      }

      const dir = await mkdtemp(join(tmpdir(), "clash-tts-"));
      const outputPath = join(dir, "speech.wav");
      try {
        const synthesis = await ttsRuntime.synthesize({
          model,
          text: input.text.trim(),
          outputPath,
          cacheDir: ttsCacheDir,
          voice: input.voice,
          speed: input.speed,
        });
        const { outputPath: _outputPath, ...metadata } = synthesis;
        return {
          audio: new Uint8Array(await readFile(outputPath)),
          metadata,
        };
      } catch (error) {
        if (error instanceof LocalAudioConfigError) throw error;
        throw new LocalAudioConfigError(`Local TTS synthesis failed: ${displayErrorMessage(error)}`, 502);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
