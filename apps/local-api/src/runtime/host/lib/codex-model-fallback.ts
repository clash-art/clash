export interface ModelFallback {
  from: string;
  to: string;
}

interface ModelSession {
  models?: {
    currentModelId: string;
    availableModels: readonly { modelId: string }[];
  } | null;
  configOptions: readonly unknown[];
  setConfigOption(id: string, value: string): Promise<unknown>;
}

/** Codex ACP's model catalog uses model[effort]; its config menu may inject
 * unknown current models, so only the original catalog is compatibility evidence.
 * The catalog has no default marker: use its first advertised model. */
export async function reconcileCodexModel(
  session: ModelSession,
  requestedModel?: string,
): Promise<ModelFallback | undefined> {
  const options = session.configOptions as Array<{
    id?: string;
    category?: string;
    type?: string;
    currentValue?: unknown;
  }>;
  const model = options.find(
    (option) => option.category === "model" && option.type === "select",
  );
  if (!model?.id || typeof model.currentValue !== "string") return;
  const from = requestedModel ?? model.currentValue;
  const supported =
    session.models?.availableModels.flatMap(({ modelId }) => {
      const match = /^(.+)\[([^\]]+)\]$/.exec(modelId);
      return match ? [match[1]!] : [];
    }) ?? [];
  if (!supported.length || supported.includes(from)) return;
  const to = supported[0]!;
  await session.setConfigOption(model.id, to);
  return { from, to };
}
