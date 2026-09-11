import type { LoroDoc } from "loro-crdt";
import {
  commitProjectMutation,
  createProjectGenerator,
  projectTimelineActionId,
  projectTimelineToGeneratorRevisionState,
  readProjectTimeline,
  replaceDraftActionAssetInputBindings,
  type GeneratorDefinition,
} from "@clash/shared-types";
import { validateLocalGeneratorRevisionContract } from "./local-generator-contract.js";

export type TimelineMigrationResult =
  | { ok: true; migratedIds: string[] }
  | { ok: false; error: { code: string; message: string; generatorId?: string } };

/** Host-only format migration. Old records are retired only after the entire import validates. */
export function migrateLegacyProjectTimelines(
  doc: LoroDoc,
  definition: GeneratorDefinition,
): TimelineMigrationResult {
  if (doc.getMap("timelines").size === 0) return { ok: true, migratedIds: [] };
  return commitProjectMutation(doc, (draft): TimelineMigrationResult => {
    const migratedIds: string[] = [];
    for (const [id] of draft.getMap("timelines").entries()) {
      try {
        const timeline = readProjectTimeline(draft, id);
        if (!timeline) throw new Error(`Legacy Timeline ${id} is malformed`);
        const projected = projectTimelineToGeneratorRevisionState(timeline, definition);
        if (!projected.ok) return { ok: false, error: { code: projected.code, message: projected.message, generatorId: id } };
        // Existing revisions are imported identities, not fresh proposals.
        // Preserve their IDs so previously pinned references retain their meaning.
        const revision = validateLocalGeneratorRevisionContract({
          doc: draft, definition,
          revision: {
            id: timeline.revisionId, generatorId: timeline.id,
            definitionRef: {
              pluginId: definition.pluginId, definitionId: definition.definitionId,
              version: definition.version, schemaHash: definition.schemaHash,
            },
            state: projected.state, persistentInputRefs: projected.persistentInputRefs,
          },
        });
        const created = createProjectGenerator(draft, {
          head: { id: timeline.id, headRevisionId: revision.id }, revision,
        });
        if (!created.ok) return { ok: false, error: created.error };
        const retired = replaceDraftActionAssetInputBindings(draft,
          projectTimelineActionId(timeline.id, timeline.owner), []);
        if (!retired.ok) throw new Error(retired.error);
        draft.getMap("timelines").delete(id);
        migratedIds.push(id);
      } catch (error) {
        return { ok: false, error: {
          code: "TIMELINE_MIGRATION_FAILED",
          message: error instanceof Error ? error.message : String(error), generatorId: id,
        } };
      }
    }
    return { ok: true, migratedIds };
  });
}
