/**
 * Voice input through a Provider route, shared by every server adapter.
 *
 * Readiness, the verbatim transcript prompt, empty-result validation and the
 * timed-transcript envelope live here so the Cloudflare adapter, the Node
 * adapter and the local Host answer one contract. Model selection, catalog
 * readiness, credentials and audio staging arrive through injected ports;
 * this module never imports a platform runtime and never branches on the
 * deployment mode.
 *
 * Local ASR (model install/status plus the builtin RPC runtime) is different:
 * it runs on the user's machine, so it stays in apps/local-api and the hosted
 * adapters answer that capability with 501.
 */
import type {
  AsrTimedTranscript,
  ModelUpstreamRoute,
} from "@clash/shared-types";
import { VoiceInputError } from "./voice-input-error.js";
import {
  transcribeWithProviderTextGeneration,
  type ProviderCredentialsPort,
  type ProviderUsageAuditPort,
} from "../voice-input-provider.js";

/** Maximum audio upload accepted by the Provider-route transcription endpoint. */
export const VOICE_INPUT_MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export const VOICE_INPUT_DISABLED_MESSAGE =
  "Voice input is not enabled. Open Settings > Voice input and enable it.";

export const VOICE_INPUT_NOT_CONFIGURED_MESSAGE =
  "The selected voice input model is not configured. Open Settings > Models and configure a provider.";

export const VOICE_INPUT_EMPTY_TRANSCRIPT_MESSAGE =
  "The selected voice input model returned an empty transcript.";

export interface VoiceInputSelection {
  enabled: boolean;
  model: string;
}

/**
 * The subset of a catalog entry readiness needs. `selectedRoute`,
 * `missingCredentials` and `tier` are the hosted catalog's readiness facts;
 * an adapter supplies them from its own user settings and model catalog.
 */
export interface VoiceInputModelEntry {
  model: {
    id: string;
    kind: string;
    input: {
      promptModalities?: readonly string[];
      inputMode: { audios?: unknown };
    };
  };
  selectedRoute: ModelUpstreamRoute | null;
  missingCredentials: readonly string[];
  tier: "available" | "configured-provider" | "all";
  routes?: readonly ModelUpstreamRoute[];
}

export interface VoiceInputAudio {
  bytes: Uint8Array;
  mediaType: string;
}

export interface VoiceInputModelResult {
  text: string;
  /** Provider that produced the text, when the adapter knows it. */
  provider?: string;
  model?: string;
}

export interface VoiceInputPorts {
  /** The user's selected voice-input model, or a default when none is stored. */
  resolveVoiceInputSelection(userId: string): Promise<VoiceInputSelection>;
  /**
   * Catalog readiness for one model. The Cloudflare adapter answers from the
   * stored provider accounts/model cards; local Host answers from its own Host
   * model catalog. Missing entries answer null.
   */
  resolveModelEntry(
    userId: string,
    modelId: string,
  ): Promise<VoiceInputModelEntry | null>;
  /** One Provider invocation. Audio staging, credentials and retries are the adapter's. */
  transcribeWithModel(input: {
    modelId: string;
    audio: VoiceInputAudio;
    prompt: string;
    language?: string;
  }): Promise<VoiceInputModelResult>;
}

/** Adapter port: every catalog entry available to the signed-in user. */
export interface VoiceInputCatalogPort {
  list(userId: string): Promise<readonly VoiceInputModelEntry[]>;
}

/**
 * The hosted adapters' complete port set. Store/catalog construction belongs
 * to each adapter; selection, readiness and the Provider call are shared.
 */
export interface VoiceInputHostedPorts {
  catalog: VoiceInputCatalogPort;
  credentials: ProviderCredentialsPort;
  usage: ProviderUsageAuditPort;
  fetch?: typeof fetch;
}

export interface VoiceInputReadinessSetup {
  provider: string;
  runtime: "provider-route" | "builtin-rpc";
  status: "disabled" | "needs-install" | "needs-config" | "ready";
  available: boolean;
  default_base_url: null;
  commands: string[];
}

export interface VoiceInputReadinessResponse {
  asr: {
    enabled: boolean;
    provider: string;
    model: string;
    ready: boolean;
    setup: VoiceInputReadinessSetup;
  };
}

export type VoiceInputReadinessStatus = "disabled" | "ready" | "not-configured";

export { VoiceInputError, type VoiceInputErrorCode } from "./voice-input-error.js";

function setup(
  provider: string,
  runtime: VoiceInputReadinessSetup["runtime"],
  status: VoiceInputReadinessSetup["status"],
): VoiceInputReadinessSetup {
  return {
    provider,
    runtime,
    status,
    available: status === "ready",
    default_base_url: null,
    commands: [],
  };
}

function providerFor(entry: VoiceInputModelEntry | null | undefined): string {
  return entry?.selectedRoute?.upstreamId ?? "global-model";
}

function acceptsAudio(entry: VoiceInputModelEntry): boolean {
  return (
    entry.model.input.promptModalities?.includes("audio") === true ||
    !!entry.model.input.inputMode.audios
  );
}

/** A text model that can take audio in and return text through a Provider route. */
export function voiceInputUsesProviderRoute(
  entry: VoiceInputModelEntry | null | undefined,
): boolean {
  return !!entry && entry.model.kind === "text" && acceptsAudio(entry);
}

export function isVoiceInputProviderReady(
  entry: VoiceInputModelEntry | null | undefined,
): boolean {
  return (
    voiceInputUsesProviderRoute(entry) &&
    !!entry?.selectedRoute &&
    entry.missingCredentials.length === 0 &&
    entry.tier === "available"
  );
}

export function voiceInputDisabledReadiness(
  selection: VoiceInputSelection,
): VoiceInputReadinessResponse {
  return {
    asr: {
      enabled: false,
      provider: "global-model",
      model: selection.model,
      ready: false,
      setup: setup("global-model", "provider-route", "disabled"),
    },
  };
}

export function voiceInputProviderReadiness(
  selection: VoiceInputSelection,
  entry: VoiceInputModelEntry | null | undefined,
): VoiceInputReadinessResponse {
  const ready = isVoiceInputProviderReady(entry);
  const provider = providerFor(entry);
  return {
    asr: {
      enabled: true,
      provider,
      model: selection.model,
      ready,
      setup: setup(
        provider,
        "provider-route",
        ready ? "ready" : "needs-config",
      ),
    },
  };
}

/**
 * Local ASR readiness. Only the local Host returns this; hosted adapters have
 * no machine-local runtime and keep the capability unavailable.
 */
export function voiceInputLocalReadiness(
  selection: VoiceInputSelection,
): VoiceInputReadinessResponse {
  return {
    asr: {
      enabled: true,
      provider: "local",
      model: selection.model,
      ready: false,
      setup: setup("local", "builtin-rpc", "needs-install"),
    },
  };
}

export function resolveVoiceInputReadiness(
  selection: VoiceInputSelection,
  entry: VoiceInputModelEntry | null | undefined,
): {
  status: VoiceInputReadinessStatus;
  response: VoiceInputReadinessResponse;
} {
  if (!selection.enabled) {
    return {
      status: "disabled",
      response: voiceInputDisabledReadiness(selection),
    };
  }
  if (isVoiceInputProviderReady(entry)) {
    return {
      status: "ready",
      response: voiceInputProviderReadiness(selection, entry),
    };
  }
  return {
    status: "not-configured",
    response: voiceInputProviderReadiness(selection, entry),
  };
}

/** The Provider-route transcript prompt; language is optional model input. */
export function voiceInputTranscriptPrompt(language?: string | null): string {
  const normalized = language?.trim();
  return normalized
    ? `Transcribe the attached audio verbatim in ${normalized}. Return only the transcript.`
    : "Transcribe the attached audio verbatim. Return only the transcript.";
}

export function buildVoiceInputTimedTranscript(input: {
  text: string;
  backendId: string;
  modelId: string;
  language?: string | null;
}): AsrTimedTranscript {
  const text = input.text.trim();
  if (!text) {
    throw new VoiceInputError(
      VOICE_INPUT_EMPTY_TRANSCRIPT_MESSAGE,
      502,
      "VOICE_INPUT_EMPTY_TRANSCRIPT",
    );
  }
  const language = input.language?.trim();
  return {
    schemaVersion: 1,
    kind: "clash.asr.timed-transcript",
    timebase: "milliseconds",
    alignment: "word",
    text,
    backendId: input.backendId,
    modelId: input.modelId,
    ...(language ? { language } : {}),
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
}

/**
 * Provider-route transcription shared by every adapter. Selection and entry
 * may be supplied when the caller already resolved them for branching.
 */
export async function transcribeVoiceInputWithProvider(input: {
  userId: string;
  ports: VoiceInputPorts;
  audio: VoiceInputAudio;
  language?: string | null;
  selection?: VoiceInputSelection;
}): Promise<AsrTimedTranscript> {
  const selection =
    input.selection ??
    (await input.ports.resolveVoiceInputSelection(input.userId));
  if (!selection.enabled) {
    throw new VoiceInputError(
      VOICE_INPUT_DISABLED_MESSAGE,
      409,
      "VOICE_INPUT_DISABLED",
    );
  }
  const entry = await input.ports.resolveModelEntry(
    input.userId,
    selection.model,
  );
  if (
    !entry ||
    !voiceInputUsesProviderRoute(entry) ||
    !isVoiceInputProviderReady(entry)
  ) {
    throw new VoiceInputError(VOICE_INPUT_NOT_CONFIGURED_MESSAGE, 409);
  }
  const language = input.language?.trim() || undefined;
  const prompt = voiceInputTranscriptPrompt(language);
  const result = await input.ports.transcribeWithModel({
    modelId: entry.model.id,
    audio: {
      bytes: input.audio.bytes,
      // Browsers record e.g. "audio/webm;codecs=opus"; providers want the bare type.
      mediaType:
        input.audio.mediaType.split(";")[0]?.trim().toLowerCase() ||
        "application/octet-stream",
    },
    prompt,
    ...(language ? { language } : {}),
  });
  const backendId =
    result.provider?.trim() || entry.selectedRoute?.upstreamId || "provider";
  return buildVoiceInputTimedTranscript({
    text: result.text,
    backendId,
    modelId: entry.model.id,
    language,
  });
}

/**
 * Catalog-to-selection rule for hosted adapters: the first ready Provider
 * route when one exists, otherwise the first audio-capable text model so
 * readiness can say "not configured" instead of disappearing.
 */
export function chooseVoiceInputSelection(
  entries: readonly VoiceInputModelEntry[],
): VoiceInputSelection {
  const candidates = entries.filter(
    (entry) =>
      voiceInputUsesProviderRoute(entry) &&
      entry.selectedRoute?.apiShape !== "local-asr",
  );
  const chosen = candidates.find(isVoiceInputProviderReady) ?? candidates[0];
  return chosen
    ? { enabled: true, model: chosen.model.id }
    : { enabled: false, model: "" };
}

/**
 * Build the high-level ports from the hosted adapter's catalog, credential
 * resolver, audit sink and fetch. Both hosted adapters mount the same route
 * factory over these ports.
 */
export function createHostedVoiceInputPorts(
  userId: string,
  ports: VoiceInputHostedPorts,
): VoiceInputPorts {
  let catalogPromise: Promise<readonly VoiceInputModelEntry[]> | undefined;
  const catalog = () => (catalogPromise ??= ports.catalog.list(userId));
  const entryFor = async (modelId: string) =>
    (await catalog()).find((entry) => entry.model.id === modelId) ?? null;
  const transcriptionPorts = {
    credentials: ports.credentials,
    usage: ports.usage,
    ...(ports.fetch ? { fetch: ports.fetch } : {}),
  };

  return {
    async resolveVoiceInputSelection() {
      return chooseVoiceInputSelection(await catalog());
    },
    async resolveModelEntry(_userId, modelId) {
      return entryFor(modelId);
    },
    async transcribeWithModel({ modelId, audio, prompt, language }) {
      const entry = await entryFor(modelId);
      const route = entry?.selectedRoute;
      if (!route) {
        throw new VoiceInputError(VOICE_INPUT_NOT_CONFIGURED_MESSAGE, 409);
      }
      const result = await transcribeWithProviderTextGeneration({
        userId,
        route,
        audio,
        prompt,
        ...(language ? { language } : {}),
        ports: transcriptionPorts,
      });
      return {
        text: result.text,
        provider: result.provider,
        model: result.model,
      };
    },
  };
}
