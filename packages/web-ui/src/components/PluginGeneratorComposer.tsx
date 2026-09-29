import type { GeneratorComposerProps } from "@clash/action-sdk/ui";
import { GeneratorComposer } from "./nodes/ActionBadge";
import { useProject } from "./ProjectContext";
import { useProjectCustomActions } from "./CustomActionsContext";
import { useOptionalLoroSyncContext } from "./LoroSyncContext";
import { useNativeGeneratorDraft } from "../hooks/useNativeGeneratorDraft";

/** Host adapter: plugins pass Generator identity, not private Canvas node props. */
export function PluginGeneratorComposer(props: GeneratorComposerProps) {
  const { projectId } = useProject();
  const sync = useOptionalLoroSyncContext();
  const cards = useProjectCustomActions();
  const draft = useNativeGeneratorDraft({
    projectId,
    generatorId: props.generatorId,
    doc: sync?.doc ?? null,
  });
  if (!draft?.projection)
    return (
      <p role="status" className="p-4 text-sm text-content-secondary">
        Opening Generator…
      </p>
    );
  const definition = draft.projection.revision.definitionRef;
  const card = cards.find(
    (entry) =>
      entry.pluginBinding?.pluginId === definition.pluginId &&
      entry.generator?.definitionId === definition.definitionId &&
      (!props.actionId || entry.generator.actionId === props.actionId),
  );
  return (
    <GeneratorComposer
      id={`generator-composer:${props.generatorId}`}
      data={{
        generatorId: props.generatorId,
        ...(card ? { actionCardId: card.id } : {}),
      }}
      onComposerClose={props.onClose}
      onExecuteRevision={props.onExecuteRevision}
    />
  );
}
