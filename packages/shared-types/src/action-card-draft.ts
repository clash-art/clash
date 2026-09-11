import {
  GeneratorDefinitionSchema,
  AssetRevisionRefSchema,
  type AssetRevisionRef,
  type GeneratorInputRef,
  type GeneratorRevision,
} from "./generator-v2.js";
import {
  executableActionCardInputAcceptsType,
  type ExecutableActionCard,
} from "./executable-plugin.js";
import { referenceAssetId, referenceModality } from "./model-capabilities.js";
import {
  assetRevisionKey,
  canvasAssetRevision,
} from "./canvas-asset-reference.js";
import { parsePromptParts } from "./prompt.js";

type Link = NonNullable<ExecutableActionCard["generator"]>;
const orderKey = (index: number) => String(index).padStart(10, "0");

/** An Action form binds applied Assets to its declared native ports, never Model-specific prompt fields. */
export function appendActionCardInput(
  before: Pick<GeneratorRevision, "state" | "persistentInputRefs">,
  link: Link,
  definitionInput: unknown,
  assetInput: AssetRevisionRef,
  kind: string,
) {
  const asset = AssetRevisionRefSchema.parse(assetInput);
  if ((asset.kind === "document") !== (kind === "text"))
    throw new Error(
      "The Action input modality does not match the selected Asset.",
    );
  const definition = GeneratorDefinitionSchema.parse(definitionInput);
  if (definition.definitionId !== link.definitionId)
    throw new Error("The Action Card addresses a different Definition.");
  const slot = link.inputSlots[kind as keyof Link["inputSlots"]];
  const port = definition.persistentInputs.find((entry) => entry.slot === slot);
  if (
    !slot ||
    !port?.accepts.some((type) =>
      executableActionCardInputAcceptsType(type, kind),
    )
  )
    throw new Error(`The Action Card has no native input mapping for ${kind}.`);
  const refs = before.persistentInputRefs;
  if (
    refs.some(
      (ref) =>
        ref.slot === slot &&
        assetRevisionKey(ref.target) === assetRevisionKey(asset),
    )
  )
    return before;
  const group = refs.filter((ref) => ref.slot === slot);
  if (
    port.cardinality.maxItems !== null &&
    group.length >= port.cardinality.maxItems
  )
    throw new Error(`The ${slot} input is full.`);
  const used = new Set(group.map((ref) => ref.itemKey));
  let index = 0;
  while (used.has(orderKey(index))) index += 1;
  const ref: GeneratorInputRef = {
    slot,
    ...(port.cardinality.maxItems !== 1 ? { itemKey: orderKey(index) } : {}),
    target: asset,
  };
  const appended = [...refs, ref];
  return {
    state: before.state,
    persistentInputRefs: reorderActionCardInputs(
      appended,
      appended.flatMap((input) =>
        "kind" in input.target ? [input.target] : [],
      ),
    ),
  };
}

export function createActionCardPromptEdit(
  raw: string,
  link: Link,
  resolve: (
    nodeId: string,
  ) => Parameters<typeof referenceAssetId>[0] | undefined,
) {
  // Freeze mutable Canvas reads before waiting for the editing queue.
  const parts = parsePromptParts(raw).map((part) => {
    if (part.type === "text") return { text: part.text ?? "" };
    const node = part.nodeId ? resolve(part.nodeId) : undefined;
    if (
      node?.type === "text" &&
      node.data?.documentRevision === undefined &&
      typeof node.data?.content === "string"
    )
      return { text: node.data.content };
    const asset = canvasAssetRevision(node);
    const kind = node && referenceModality(node);
    if (!asset || !kind)
      throw new Error(
        "The mention needs an applied Asset before it can be used.",
      );
    return { text: part.label ?? "", asset, kind };
  });
  return (
    before: Pick<GeneratorRevision, "state" | "persistentInputRefs">,
    definition?: unknown,
  ) => {
    let next: Pick<GeneratorRevision, "state" | "persistentInputRefs"> = before;
    for (const part of parts)
      if (part.asset && part.kind)
        next = appendActionCardInput(
          next,
          link,
          definition,
          part.asset,
          part.kind,
        );
    return {
      state: { ...next.state, prompt: parts.map((part) => part.text).join("") },
      persistentInputRefs: next.persistentInputRefs,
    };
  };
}

/** Collection order is part of the new Revision; references remain pinned to the same Assets. */
export function reorderActionCardInputs(
  refs: GeneratorInputRef[],
  assets: readonly AssetRevisionRef[],
): GeneratorInputRef[] {
  const rank = new Map(
    assets.map((asset, index) => [assetRevisionKey(asset), index]),
  );
  const groups = new Map<string, GeneratorInputRef[]>();
  for (const ref of refs)
    groups.set(ref.slot, [...(groups.get(ref.slot) ?? []), ref]);
  return [...groups.values()].flatMap((group) =>
    group
      .sort((a, b) => {
        const order = (ref: GeneratorInputRef) =>
          rank.get(assetRevisionKey(ref.target)) ?? Number.MAX_SAFE_INTEGER;
        return order(a) - order(b);
      })
      .map((ref, index) =>
        ref.itemKey === undefined ? ref : { ...ref, itemKey: orderKey(index) },
      ),
  );
}
