import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { LoroDoc } from "loro-crdt";
import { readProjectGenerator, readGeneratorRevision, PROJECT_GENERATORS_CONTAINER, type GeneratorRevision } from "@clash/shared-types";
import { createGeneratorClient, type GeneratorRequest } from "@clash/shared-runtime/generator-client";
import { createGeneratorDraftEditor, parseGeneratorDraftProjection, type GeneratorDraftProjection, type GeneratorStateEdit, type GeneratorDraftEdit, type GeneratorInputConnections } from "../lib/generatorDraftEditor";
import { runtimeApiUrl } from "../lib/runtimeConfig";

const requestHost: GeneratorRequest = (path, init) => fetch(runtimeApiUrl(path), { credentials: "include", ...init });

export function useNativeGeneratorDraft({ projectId, generatorId, doc, request = requestHost }: {
  projectId: string; generatorId: string | null; doc: LoroDoc | null; request?: GeneratorRequest;
}) {
  const subscribe = useCallback((notify: () => void) => {
    if (!doc || !generatorId) return () => {};
    return doc.getMap(PROJECT_GENERATORS_CONTAINER).subscribe(() => notify());
  }, [doc, generatorId]);
  const getSnapshot = useCallback(() => doc && generatorId ? readProjectGenerator(doc, generatorId)?.headRevisionId ?? "missing" : "missing", [doc, generatorId]);
  const headRevisionId = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const available = headRevisionId !== "missing";
  const session = useMemo(() => {
    let initial: GeneratorDraftProjection | null = null;
    if (doc && generatorId && available) {
      const generator = readProjectGenerator(doc, generatorId);
      const revision = generator && readGeneratorRevision(doc, { generatorId, generatorRevisionId: generator.headRevisionId });
      if (generator && revision) initial = { generator, revision };
    }
    return { initial, pending: 0, acknowledged: new Set(initial ? [initial.revision.id] : []),
      editor: initial ? createGeneratorDraftEditor({ projectId, initial, client: createGeneratorClient(request) }) : null };
  }, [doc, generatorId, available, projectId, request]);
  const [acknowledged, setAcknowledged] = useState<{ owner: typeof session; projection: GeneratorDraftProjection } | null>(null);
  const runEdit = useCallback(async (run: (editor: ReturnType<typeof createGeneratorDraftEditor>) => Promise<GeneratorDraftProjection>) => {
    if (!session.editor) throw new Error("Generator is unavailable. Read the project again.");
    const head = doc && generatorId ? readProjectGenerator(doc, generatorId) : null;
    if (!head) throw new Error("Generator is unavailable. Read the project again.");
    if (!session.acknowledged.has(head.headRevisionId)) {
      if (session.pending) throw new Error("This draft changed while saving. Wait for the save and read it again.");
      const revision = readGeneratorRevision(doc!, { generatorId: head.id, generatorRevisionId: head.headRevisionId });
      if (!revision) throw new Error("Generator revision is unavailable. Read the project again.");
      // Freshly observed external head: start a new editing session only when
      // no submitted edits remain. Never rebase work already in the queue.
      session.editor = createGeneratorDraftEditor({ projectId, initial: { generator: head, revision }, client: createGeneratorClient(request) });
      session.acknowledged.add(revision.id);
      setAcknowledged({ owner: session, projection: { generator: head, revision } });
    }
    session.pending += 1;
    try {
      const result = await run(session.editor);
      session.acknowledged.add(result.revision.id);
      setAcknowledged({ owner: session, projection: result });
      return result;
    } finally { session.pending -= 1; }
  }, [session, doc, generatorId, projectId, request]);
  const edit = useCallback((patch: GeneratorStateEdit, updateInputs?: (inputs: GeneratorRevision["persistentInputRefs"]) => GeneratorRevision["persistentInputRefs"], connections?: GeneratorInputConnections) => runEdit((editor) => editor.edit(patch, updateInputs, connections)), [runEdit]);
  const editDraft = useCallback((update: GeneratorDraftEdit) => runEdit((editor) => editor.editDraft(update)), [runEdit]);
  const prepare = useCallback((update: GeneratorDraftEdit) => runEdit((editor) => editor.prepare(update)), [runEdit]);
  // A no-change edit also refreshes an idle editor from the currently observed
  // head. Copy therefore uses the visible revision after an external change.
  const flush = useCallback(() => edit({}), [edit]);
  const copy = useCallback(async (input: {
    sourceNodeId: string; nodeId: string; label: string; statePatch: GeneratorRevision["state"]; draftEdit?: GeneratorDraftEdit;
  }) => {
    const patch = structuredClone(input.statePatch);
    const before = await flush();
    const source = doc?.getMap("nodes").get(input.sourceNodeId) as {
      type?: string; canvasId?: string; parentId?: string; data?: { generatorId?: string; actionCardId?: string };
    } | undefined;
    if (source?.type !== "action-badge" || source.data?.generatorId !== before.generator.id) {
      throw new Error("The source placement changed. Read the project again before copying.");
    }
    const definition = source.data.actionCardId && input.draftEdit
      ? (await createGeneratorClient(request).getDefinition(before.revision.definitionRef.pluginId, before.revision.definitionRef.definitionId) as { definition?: unknown }).definition
      : undefined;
    const copied = input.draftEdit ? input.draftEdit(structuredClone(before.revision), definition) : before.revision;
    const generatorId = crypto.randomUUID();
    const generatorRevisionId = crypto.randomUUID();
    const accepted = parseGeneratorDraftProjection(await createGeneratorClient(request).createGenerator(projectId, {
      generatorId, generatorRevisionId,
      pluginId: before.revision.definitionRef.pluginId,
      definitionId: before.revision.definitionRef.definitionId,
      forkedFrom: { generatorId: before.generator.id, generatorRevisionId: before.revision.id },
      state: { ...copied.state, ...patch },
      persistentInputRefs: copied.persistentInputRefs,
      placement: { canvasId: source.canvasId ?? "main", nodeId: input.nodeId, label: input.label, sourceNodeId: input.sourceNodeId,
        ...(source.data?.actionCardId ? { actionCardId: source.data.actionCardId } : {}),
        ...(source.parentId ? { parentId: source.parentId } : {}) },
    }));
    if (accepted.generator.id !== generatorId || accepted.revision.id !== generatorRevisionId) {
      throw new Error("Generator acknowledgement does not match the submitted copy.");
    }
    return accepted;
  }, [doc, flush, projectId, request]);
  if (!generatorId) return null;
  let projection = session.initial;
  if (doc && available) {
    const generator = readProjectGenerator(doc, generatorId);
    const revision = generator && readGeneratorRevision(doc, { generatorId, generatorRevisionId: generator.headRevisionId });
    projection = generator && revision ? { generator, revision } : null;
  }
  if (acknowledged?.owner === session && session.acknowledged.has(headRevisionId)) projection = acknowledged.projection;
  const error = !projection ? "Generator is unavailable. Read the project again." : null;
  return { projection, error, edit, editDraft, prepare, flush, copy };
}
