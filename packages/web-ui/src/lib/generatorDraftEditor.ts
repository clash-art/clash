import {
  GeneratorRevisionSchema,
  GeneratorDefinitionRefSchema,
  GeneratorInputRefSchema,
  ProjectGeneratorSchema,
  type AdvanceProjectGeneratorRequest,
  type GeneratorRevision,
  type ProjectGenerator,
} from "@clash/shared-types";

export interface GeneratorDraftProjection {
  generator: ProjectGenerator;
  revision: GeneratorRevision;
}
export type GeneratorStateEdit = GeneratorRevision["state"] | ((state: GeneratorRevision["state"]) => GeneratorRevision["state"]);
export type GeneratorInputConnections = AdvanceProjectGeneratorRequest["canvasInputConnections"];
export type GeneratorDraftEdit = (revision: GeneratorRevision, definition?: unknown) => Pick<GeneratorRevision, "state" | "persistentInputRefs"> & { canvasInputConnections?: GeneratorInputConnections };

export function parseGeneratorDraftProjection(value: unknown): GeneratorDraftProjection {
  if (!value || typeof value !== "object") throw new Error("Missing Generator acknowledgement.");
  const raw = value as Record<string, unknown>;
  const generator = ProjectGeneratorSchema.parse(raw.generator);
  const revision = GeneratorRevisionSchema.parse(raw.revision);
  if (generator.id !== revision.generatorId || generator.headRevisionId !== revision.id) {
    throw new Error("Generator acknowledgement does not identify its head revision.");
  }
  return { generator, revision };
}

// Local equality only; this value is never used as a revision or CAS token.
function stateKey(state: GeneratorRevision["state"]): string {
  return JSON.stringify(state, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value);
}

/**
 * Serializes local draft edits using only Host-acknowledged revisions. A failed
 * write stops this editing session; the caller must explicitly read again and
 * establish a new editor instead of silently rebasing queued changes.
 */
export function createGeneratorDraftEditor(options: {
  projectId: string;
  initial: GeneratorDraftProjection;
  client: {
    getDefinition?(pluginId: string, definitionId: string): Promise<unknown>;
    advanceGenerator(projectId: string, generatorId: string, input: AdvanceProjectGeneratorRequest): Promise<unknown>;
  };
}) {
  let pending = Promise.resolve(parseGeneratorDraftProjection(options.initial));
  const editDraft = (update: GeneratorDraftEdit, refreshDefinition = false): Promise<GeneratorDraftProjection> => {
      pending = pending.then(async (before) => {
        let installed = before.revision.definitionRef;
        let disclosedDefinition: unknown;
        if (refreshDefinition) {
          if (!options.client.getDefinition) throw new Error("Generator registry is unavailable.");
          const response = await options.client.getDefinition(installed.pluginId, installed.definitionId);
          const definition = (response as { definition?: Record<string, unknown> } | null)?.definition;
          disclosedDefinition = definition;
          installed = GeneratorDefinitionRefSchema.parse({ pluginId: definition?.pluginId, definitionId: definition?.definitionId, version: definition?.version, schemaHash: definition?.schemaHash });
          if (installed.pluginId !== before.revision.definitionRef.pluginId || installed.definitionId !== before.revision.definitionRef.definitionId) {
            throw new Error("Generator registry returned a different Definition.");
          }
        }
        const next = update(structuredClone(before.revision), disclosedDefinition);
        const state = next.state;
        const persistentInputRefs = GeneratorInputRefSchema.array().parse(next.persistentInputRefs);
        if (stateKey(installed) === stateKey(before.revision.definitionRef) && !next.canvasInputConnections?.length && stateKey({ state, persistentInputRefs }) === stateKey({ state: before.revision.state, persistentInputRefs: before.revision.persistentInputRefs })) return before;
        const generatorRevisionId = crypto.randomUUID();
        const accepted = parseGeneratorDraftProjection(await options.client.advanceGenerator(options.projectId, before.generator.id, {
          expectedHeadRevisionId: before.revision.id,
          generatorRevisionId,
          state,
          persistentInputRefs,
          ...(next.canvasInputConnections ? { canvasInputConnections: next.canvasInputConnections } : {}),
        }));
        if (accepted.generator.id !== before.generator.id || accepted.revision.id !== generatorRevisionId || accepted.revision.parentRevisionId !== before.revision.id) {
          throw new Error("Generator acknowledgement does not match the submitted edit.");
        }
        if (refreshDefinition && stateKey(accepted.revision.definitionRef) !== stateKey(installed)) {
          throw new Error("Generator Definition changed while preparing the run. Read the draft again.");
        }
        return accepted;
      });
      // Keep the rejection visible to edit/flush callers without an unhandled
      // rejection when a caller waits only on the final flush of several edits.
      void pending.catch(() => {});
      return pending;
  };
  return {
    editDraft,
    // Resolve inside the same queue as edits so Run pins the acknowledged head.
    prepare(update: GeneratorDraftEdit): Promise<GeneratorDraftProjection> {
      return editDraft(update, true);
    },
    edit(statePatch: GeneratorStateEdit, updateInputs?: (inputs: GeneratorRevision["persistentInputRefs"]) => GeneratorRevision["persistentInputRefs"], connections?: GeneratorInputConnections): Promise<GeneratorDraftProjection> {
      const updateState = typeof statePatch === "function" ? statePatch : null;
      const patch = updateState ? null : structuredClone(statePatch as GeneratorRevision["state"]);
      const canvasInputConnections = connections && structuredClone(connections);
      return editDraft((before) => ({
        state: { ...before.state, ...(updateState ? updateState(before.state) : patch) },
        persistentInputRefs: updateInputs ? updateInputs(before.persistentInputRefs) : before.persistentInputRefs,
        ...(canvasInputConnections ? { canvasInputConnections } : {}),
      }));
    },
    flush(): Promise<GeneratorDraftProjection> { return pending; },
  };
}
