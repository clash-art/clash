import { ExecutablePluginBindingSchema, resolveExecutableActionCardGenerator, type ExecutablePluginCardRegistration, type GeneratorDefinition } from "@clash/shared-types";

/** The Host registry, not the replica's legacy customActions map, owns executable identity. */
export function resolveLocalCanvasActionCard(registrations: readonly ExecutablePluginCardRegistration[], definition: GeneratorDefinition, cardId: string, authoredBinding?: unknown) {
  const matches = registrations.filter((entry) => entry.document.kind === "action-card" && entry.document.spec.id === cardId);
  if (matches.length !== 1) throw new Error(`Action Card ${cardId} is unavailable or ambiguous.`);
  const registration = matches[0]!;
  if (registration.document.kind !== "action-card") throw new Error("Expected an Action Card.");
  const card = registration.document.spec;
  if (!card.generator || registration.pluginId !== definition.pluginId || registration.version !== definition.version || registration.schemaHash !== definition.schemaHash) {
    throw new Error("The Action Card and Generator Definition must belong to the same immutable plugin package.");
  }
  if (authoredBinding !== undefined) {
    const binding = ExecutablePluginBindingSchema.parse(authoredBinding);
    if (binding.pluginId !== registration.pluginId || binding.version !== registration.version || binding.schemaHash !== registration.schemaHash || binding.exportId !== card.functionExportId) {
      throw new Error(`Action Card ${cardId} needs its original plugin contract. Restore ${binding.pluginId} version ${binding.version} (${binding.schemaHash}) using plugin rollback or reactivation, then retry opening the project. The active package is ${registration.pluginId} version ${registration.version} (${registration.schemaHash}).`);
    }
  }
  resolveExecutableActionCardGenerator(card, definition);
  return card;
}
