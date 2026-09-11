import type { LoroDoc } from "loro-crdt";
import { generatorDefinitionFromExecutablePluginRegistration, resolveGeneratorProjectionDefinition, type ExecutablePluginGeneratorRegistration, type ExecutablePluginCardRegistration, type GeneratorDefinition, type ModelCard, type ProjectLoadErrorMessage } from "@clash/shared-types";
import { hasLegacyCanvasGeneratorDrafts, migrateLegacyCanvasGeneratorDrafts } from "./local-canvas-generator-migration.js";
import { migrateLegacyProjectTimelines } from "./local-timeline-migration.js";
import { LocalProjectAssetMigrationError } from "./local-project-assets.js";

export type LocalProjectUpgrade = (input: { projectId: string; doc: LoroDoc }) => Promise<boolean>;

/** Only expected domain migration failures are disclosed over the sync connection. */
export class LocalProjectUpgradeError extends Error {
  readonly detail: ProjectLoadErrorMessage;
  constructor(projectId: string, message: string, nodeId?: string) {
    super(message);
    this.name = "LocalProjectUpgradeError";
    this.detail = { type: "project.load-error", projectId, code: "PROJECT_UPGRADE_FAILED", message, ...(nodeId === undefined ? {} : { nodeId }) };
  }
}

/** Runs against the detached load document, before the replica publishes any state. */
export function createLocalProjectUpgrade(options: {
  materializeDoc(projectId: string, doc: LoroDoc): Promise<boolean>;
  listDefinitions(): Promise<ExecutablePluginGeneratorRegistration[]>;
  modelCards(): Promise<readonly ModelCard[]>;
  listActionCards?(): Promise<ExecutablePluginCardRegistration[]>;
  rememberDefinition?(definition: GeneratorDefinition): Promise<void>;
}): LocalProjectUpgrade {
  return async ({ projectId, doc }) => {
    let changed: boolean;
    try {
      changed = await options.materializeDoc(projectId, doc);
    } catch (error) {
      if (error instanceof LocalProjectAssetMigrationError) {
        throw new LocalProjectUpgradeError(projectId, `Project ${projectId} Asset upgrade failed: ${error.message}`);
      }
      throw error;
    }
    const actionCards = await options.listActionCards?.() ?? [];
    const hasModels = hasLegacyCanvasGeneratorDrafts(doc, actionCards);
    const hasTimelines = doc.getMap("timelines").size > 0;
    if (!hasModels && !hasTimelines) return changed;
    const [registrations, cards] = await Promise.all([
      options.listDefinitions(), hasModels ? options.modelCards() : Promise.resolve([]),
    ]);
    const definitions = registrations.map(generatorDefinitionFromExecutablePluginRegistration);
    // Archive contracts before any native facts are persisted or broadcast.
    for (const definition of definitions) await options.rememberDefinition?.(definition);
    if (hasTimelines) {
      const resolved = resolveGeneratorProjectionDefinition(definitions, "clash.timeline");
      if (!resolved.ok) throw new LocalProjectUpgradeError(projectId, `Project ${projectId} Timeline upgrade failed: ${resolved.code}. Restore the Timeline plugin, then retry opening the project.`);
      const migrated = migrateLegacyProjectTimelines(doc, resolved.definition);
      if (!migrated.ok) throw new LocalProjectUpgradeError(projectId, `Project ${projectId} Timeline upgrade failed: ${migrated.error.message}`);
      changed = migrated.migratedIds.length > 0 || changed;
    }
    if (hasModels) {
      const migrated = migrateLegacyCanvasGeneratorDrafts(doc, definitions, cards, actionCards);
      if (!migrated.ok) throw new LocalProjectUpgradeError(projectId, `Project ${projectId} draft upgrade failed at ${migrated.error.nodeId}: ${migrated.error.message}`, migrated.error.nodeId);
      changed = migrated.migratedNodeIds.length > 0 || changed;
    }
    return changed;
  };
}
