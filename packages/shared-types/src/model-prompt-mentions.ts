import { parsePromptParts } from "./prompt.js";
import { referenceAssetId, referenceModality } from "./model-capabilities.js";
import { DocumentAssetRevisionRefSchema, type DocumentAssetRevisionRef, type GeneratorInputRef, type GeneratorRevision } from "./generator-v2.js";
type GeneratorDraftEdit = (revision: GeneratorRevision) => Pick<GeneratorRevision, "state" | "persistentInputRefs">;
import { modelPromptPartsWithInputs, withModelPromptParts, type ModelPromptPart } from "./model-prompt-content.js";
import { createModelMediaInput } from "./model-media-input.js";

type CanvasSource = Parameters<typeof referenceAssetId>[0];

function freezeTextReference(node: CanvasSource) {
  if (node.data?.documentRevision !== undefined) {
    const parsed = DocumentAssetRevisionRefSchema.safeParse(node.data.documentRevision);
    if (!parsed.success) throw new Error("The referenced Document identity is invalid. Read it again.");
    return { type: "document" as const, target: parsed.data };
  }
  const text = node.data?.content;
  if (typeof text !== "string") throw new Error("The referenced text is unavailable. Read it again.");
  return { type: "text" as const, text };
}

function appendDocumentInput(inputs: GeneratorInputRef[], target: DocumentAssetRevisionRef): GeneratorInputRef {
  const existing = inputs.find(ref => ref.slot === "text" && "kind" in ref.target && ref.target.kind === "document" &&
    ref.target.documentAssetId === target.documentAssetId && ref.target.revisionId === target.revisionId);
  if (existing) return existing;
  const added: GeneratorInputRef = { slot: "text", itemKey: crypto.randomUUID(), target: { ...target } };
  inputs.push(added);
  return added;
}

/** Picker authoring uses the same frozen text/Document semantics as inline mentions. */
export function createModelTextReferenceEdit(node: CanvasSource, label: string): GeneratorDraftEdit {
  const source = freezeTextReference(node);
  return (before) => {
    const parts = modelPromptPartsWithInputs(before.state, before.persistentInputRefs);
    if (source.type === "text") return { state: withModelPromptParts(before.state, [...parts, { type: "text", text: `\n\n${source.text}` }]), persistentInputRefs: before.persistentInputRefs };
    const inputs = [...before.persistentInputRefs];
    const ref = appendDocumentInput(inputs, source.target);
    if (inputs.length === before.persistentInputRefs.length) return before;
    return { state: withModelPromptParts(before.state, [...parts,
      { type: "text", text: "\n\n" }, { type: "input", slot: ref.slot, ...(ref.itemKey === undefined ? {} : { itemKey: ref.itemKey }), label },
    ]), persistentInputRefs: inputs };
  };
}

/** Resolve Canvas mentions once, at the editing boundary, into immutable inputs. */
export function createModelPromptEdit(raw: string, resolve: (nodeId: string) => Parameters<typeof referenceAssetId>[0] | undefined): GeneratorDraftEdit {
  const parsed = parsePromptParts(raw);
  const parts = parsed.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text ?? "" };
    if (!part.nodeId) throw new Error("The mention does not identify a source.");
    const node = resolve(part.nodeId);
    if (node?.type === "text") {
      return { ...freezeTextReference(node), label: part.label ?? "" };
    }
    const assetId = node && referenceAssetId(node);
    const kind = node && referenceModality(node);
    if (!assetId || !kind || kind === "text") throw new Error("The mentioned media needs an applied Asset before it can be used.");
    return { type: "media" as const, assetId, kind, label: part.label ?? "" };
  });
  const hasMentions = parsed.some((part) => part.type === "asset_ref");
  return (before) => {
    if (!hasMentions && before.state.contentParts === undefined) return { state: { ...before.state, prompt: raw }, persistentInputRefs: before.persistentInputRefs };
    const inputs: GeneratorInputRef[] = [...before.persistentInputRefs];
    const placed = new Set<string>();
    const identity = (ref: { slot: string; itemKey?: string }) => JSON.stringify([ref.slot, ref.itemKey ?? null]);
    const contentParts: ModelPromptPart[] = parts.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      let ref = part.type === "document" ? appendDocumentInput(inputs, part.target)
        : inputs.find((input) => "kind" in input.target && input.target.kind === "media" && input.target.projectAssetId === part.assetId);
      if (!ref) {
        if (part.type !== "media") throw new Error("The Document input is unavailable.");
        ref = createModelMediaInput({ modelId: before.state.modelId, inputs, kind: part.kind, projectAssetId: part.assetId });
        inputs.push(ref);
      }
      placed.add(identity(ref));
      return { type: "input", slot: ref.slot, ...(ref.itemKey ? { itemKey: ref.itemKey } : {}), label: part.label };
    });
    for (const ref of inputs) {
      if (placed.has(identity(ref))) continue;
      contentParts.push({ type: "input", slot: ref.slot, ...(ref.itemKey ? { itemKey: ref.itemKey } : {}), label: "" });
    }
    return { state: withModelPromptParts(before.state, contentParts), persistentInputRefs: inputs };
  };
}
