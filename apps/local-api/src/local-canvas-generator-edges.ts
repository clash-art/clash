import type { LoroDoc } from "loro-crdt";
import { resolveLocalCanvasActionCard } from "./local-canvas-action-contract.js";
import {
  Canvas,
  commitProjectMutation,
  createModelMediaInput,
  modelPromptPartsWithInputs,
  withModelPromptParts,
  removeModelPromptInput,
  readProjectGenerator,
  readGeneratorRevision,
  canvasAssetRevision,
  assetRevisionKey,
  referenceModality,
  createModelTextReferenceEdit,
  MODEL_CARDS,
  editModelKeyframes,
  appendActionCardInput,
  type AssetRevisionRef,
  type GeneratorDefinition,
  type ModelCard,
  type ExecutablePluginCardRegistration,
  type ExecutableActionCard,
} from "@clash/shared-types";
import { advanceLocalGeneratorRevision } from "./local-generator-product.js";

type InputKind = "image" | "video" | "audio" | "model" | "text";
type ConnectedAsset = {
  asset: AssetRevisionRef;
  kind: InputKind;
  edgeIds: Set<string>;
};
type Endpoint = { source: string; target: string };
type Placement = {
  type?: string;
  canvasId?: string;
  data?: { generatorId?: string; actionCardId?: string };
};

function connectedAssets(
  doc: LoroDoc,
  generatorId: string,
): Map<string, ConnectedAsset> {
  const assets = new Map<string, ConnectedAsset>();
  for (const [nodeId, raw] of doc.getMap("nodes").entries()) {
    const placement = raw as Placement;
    if (
      placement.type !== "action-badge" ||
      placement.data?.generatorId !== generatorId
    )
      continue;
    const canvas = new Canvas(doc, () => {}, placement.canvasId ?? "main");
    for (const edge of canvas.listEdges()) {
      if (edge.target !== nodeId || edge.type === "copy-on-write") continue;
      const source = canvas.readNode(edge.source);
      const kind = source && referenceModality(source);
      if (
        !kind ||
        (kind === "text" && source?.data.documentRevision === undefined)
      )
        continue;
      const asset = canvasAssetRevision(source);
      if (!asset)
        throw new Error(
          "A Generator connection requires an applied Asset revision.",
        );
      const key = assetRevisionKey(asset)!;
      const existing = assets.get(key);
      if (existing) existing.edgeIds.add(edge.id);
      else assets.set(key, { asset, kind, edgeIds: new Set([edge.id]) });
    }
  }
  return assets;
}

/** Called under the Host replica lock after graph read/immutability guards. */
export async function mutateLocalCanvasGeneratorEdges(options: {
  doc: LoroDoc;
  endpoints: Endpoint[];
  resolveDefinition?: (
    pluginId: string,
    definitionId: string,
  ) => Promise<GeneratorDefinition>;
  modelCards?: () => Promise<readonly ModelCard[]>;
  listActionCards?: () => Promise<ExecutablePluginCardRegistration[]>;
  mutate(draft: LoroDoc): void;
}): Promise<void> {
  const targets = new Set<string>();
  const targetCardIds = new Map<string, string>();
  for (const endpoint of options.endpoints) {
    const raw = options.doc.getMap("nodes").get(endpoint.target) as
      Placement | undefined;
    if (
      raw?.type !== "action-badge" ||
      typeof raw.data?.generatorId !== "string"
    )
      continue;
    const source = new Canvas(
      options.doc,
      () => {},
      raw.canvasId ?? "main",
    ).readNode(endpoint.source);
    const kind = source && referenceModality(source);
    if (
      kind === "image" ||
      kind === "video" ||
      kind === "audio" ||
      kind === "model" ||
      (kind === "text" && source?.data.documentRevision !== undefined)
    ) {
      targets.add(raw.data.generatorId);
      if (raw.data.actionCardId)
        targetCardIds.set(raw.data.generatorId, raw.data.actionCardId);
    }
  }
  const definitions = new Map<string, GeneratorDefinition>();
  const actionCards = new Map<string, ExecutableActionCard>();
  const registrations = targetCardIds.size
    ? ((await options.listActionCards?.()) ?? [])
    : [];
  const before = new Map<string, Map<string, ConnectedAsset>>();
  for (const generatorId of targets) {
    const head = readProjectGenerator(options.doc, generatorId);
    const revision =
      head &&
      readGeneratorRevision(options.doc, {
        generatorId,
        generatorRevisionId: head.headRevisionId,
      });
    if (
      !revision ||
      (!targetCardIds.has(generatorId) &&
        revision.definitionRef.pluginId !== "clash.model-generation")
    )
      throw new Error("The target Generator is unavailable.");
    if (!options.resolveDefinition)
      throw new Error("Generator Definition is unavailable.");
    const definition = await options.resolveDefinition(
      revision.definitionRef.pluginId,
      revision.definitionRef.definitionId,
    );
    if (
      definition.pluginId !== revision.definitionRef.pluginId ||
      definition.definitionId !== revision.definitionRef.definitionId
    )
      throw new Error(
        "The resolved Model Definition does not match the target.",
      );
    definitions.set(generatorId, definition);
    const cardId = targetCardIds.get(generatorId);
    if (cardId)
      actionCards.set(
        generatorId,
        resolveLocalCanvasActionCard(registrations, definition, cardId),
      );
    before.set(generatorId, connectedAssets(options.doc, generatorId));
  }
  const cards =
    targets.size && options.modelCards ? await options.modelCards() : undefined;
  commitProjectMutation(options.doc, (draft) => {
    options.mutate(draft);
    for (const generatorId of targets) {
      const head = readProjectGenerator(draft, generatorId)!;
      const revision = readGeneratorRevision(draft, {
        generatorId,
        generatorRevisionId: head.headRevisionId,
      })!;
      const after = connectedAssets(draft, generatorId);
      const previous = before.get(generatorId)!;
      const replacements = new Map<string, AssetRevisionRef>();
      for (const [key, old] of previous) {
        if (after.has(key)) continue;
        const candidates = [...after.values()].filter(
          (next) =>
            next.kind === old.kind &&
            [...next.edgeIds].some((edgeId) => old.edgeIds.has(edgeId)),
        );
        // The same connection now supplies another Asset of the same kind.
        // Preserve its authored input role, occurrence and timing. A duplicate
        // connection still supplying the old Asset keeps that input independent.
        if (candidates.length === 1) replacements.set(key, candidates[0]!.asset);
      }
      let changed = false;
      let refs = revision.persistentInputRefs.map((ref) => {
        const key = assetRevisionKey(ref.target);
        const replacement = key === null ? undefined : replacements.get(key);
        if (!replacement) return ref;
        changed = true;
        return { ...ref, target: replacement };
      });
      const removed = refs.filter((ref) => {
        const key = assetRevisionKey(ref.target);
        return (
          key !== null && previous.has(key) && !after.has(key)
        );
      });
      let state = revision.state;
      const actionCard = actionCards.get(generatorId);
      const model = actionCard
        ? undefined
        : (cards ?? MODEL_CARDS).find((card) => card.id === state.modelId);
      const keyframes = model?.input.presentation?.type === "keyframes";
      for (const ref of removed) {
        if (
          keyframes &&
          ref.slot === "image" &&
          "kind" in ref.target &&
          ref.target.kind === "media"
        ) {
          const next = editModelKeyframes(
            { state, persistentInputRefs: refs },
            model!,
            {
              type: "remove",
              projectAssetId: ref.target.projectAssetId,
              input: ref,
            },
          );
          state = next.state;
          refs = next.persistentInputRefs;
        } else if (!actionCard) state = removeModelPromptInput(state, ref);
      }
      refs = refs.filter((ref) => !removed.includes(ref));
      changed = changed || removed.length > 0;
      for (const [key, { asset, kind }] of after) {
        if (refs.some((ref) => assetRevisionKey(ref.target) === key)) continue;
        if (actionCard) {
          const next = appendActionCardInput(
            { state, persistentInputRefs: refs },
            actionCard.generator!,
            definitions.get(generatorId)!,
            asset,
            kind,
          );
          state = next.state;
          refs = next.persistentInputRefs;
          changed = true;
          continue;
        }
        if (asset.kind === "document") {
          const next = createModelTextReferenceEdit(
            { type: "text", data: { documentRevision: asset } },
            "",
          )({ ...revision, state, persistentInputRefs: refs });
          state = next.state;
          refs = next.persistentInputRefs;
          changed = true;
          continue;
        }
        if (kind === "text")
          throw new Error(
            "Text connections require an applied Document revision.",
          );
        const projectAssetId = asset.projectAssetId;
        if (keyframes && kind === "image") {
          const next = editModelKeyframes(
            { state, persistentInputRefs: refs },
            model!,
            { type: "add", projectAssetId, position: "append" },
          );
          state = next.state;
          refs = next.persistentInputRefs;
          changed = true;
          continue;
        }
        const ref = createModelMediaInput({
          modelId: state.modelId,
          model: cards?.find((card) => card.id === state.modelId),
          inputs: refs,
          kind,
          projectAssetId,
        });
        state = withModelPromptParts(state, [
          ...modelPromptPartsWithInputs(state, refs),
          {
            type: "input",
            slot: ref.slot,
            ...(ref.itemKey === undefined ? {} : { itemKey: ref.itemKey }),
            label: "",
          },
        ]);
        refs.push(ref);
        changed = true;
      }
      if (changed)
        advanceLocalGeneratorRevision(
          draft,
          definitions.get(generatorId)!,
          generatorId,
          {
            expectedHeadRevisionId: revision.id,
            generatorRevisionId: crypto.randomUUID(),
            state,
            persistentInputRefs: refs,
          },
        );
    }
    return { ok: true };
  });
}
