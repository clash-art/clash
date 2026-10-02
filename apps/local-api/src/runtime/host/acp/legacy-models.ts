import type { SessionConfigOption } from "@agentclientprotocol/sdk";

const LEGACY_MODEL_META_KEY = "openma.dev/legacy-model-state";

interface LegacyModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

interface LegacyModelState {
  currentModelId: string;
  availableModels: LegacyModelInfo[];
}

function legacyModelStateFromResponse(value: unknown): LegacyModelState | null {
  if (!value || typeof value !== "object") return null;
  const models = (value as { models?: unknown }).models;
  if (!models || typeof models !== "object") return null;
  const currentModelId = (models as { currentModelId?: unknown }).currentModelId;
  const availableModels = (models as { availableModels?: unknown }).availableModels;
  if (typeof currentModelId !== "string" || !Array.isArray(availableModels)) return null;

  const normalized = availableModels.flatMap((model): LegacyModelInfo[] => {
    if (!model || typeof model !== "object") return [];
    const candidate = model as {
      modelId?: unknown;
      name?: unknown;
      description?: unknown;
    };
    if (typeof candidate.modelId !== "string" || typeof candidate.name !== "string") return [];
    return [{
      modelId: candidate.modelId,
      name: candidate.name,
      ...(typeof candidate.description === "string"
        ? { description: candidate.description }
        : {}),
    }];
  });
  if (normalized.length === 0) return null;
  return { currentModelId, availableModels: normalized };
}

function isModelConfigOption(option: SessionConfigOption): boolean {
  return option.category === "model" || option.id === "model";
}

function legacyModelConfigOption(state: LegacyModelState): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: state.currentModelId,
    options: state.availableModels.map((model) => ({
      value: model.modelId,
      name: model.name,
      ...(model.description ? { description: model.description } : {}),
    })),
    _meta: { [LEGACY_MODEL_META_KEY]: true },
  };
}

/** v0.6.0 dropped this helper. Gemini-style ACP responses still return the
 * retired `models` catalog and no model `configOptions` entry. */
export function sessionConfigOptionsFromResponse(value: unknown): SessionConfigOption[] {
  const responseConfigOptions = value && typeof value === "object"
    ? (value as { configOptions?: unknown }).configOptions
    : undefined;
  const configOptions = Array.isArray(responseConfigOptions)
    ? responseConfigOptions.map((option) => structuredClone(option as SessionConfigOption))
    : [];
  const legacyModels = legacyModelStateFromResponse(value);
  if (legacyModels && !configOptions.some(isModelConfigOption)) {
    configOptions.push(legacyModelConfigOption(legacyModels));
  }
  return configOptions;
}
