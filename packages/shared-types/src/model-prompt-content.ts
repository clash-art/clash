import type { GeneratorRevision } from "./generator-v2.js";

type State = GeneratorRevision["state"];
export type ModelPromptPart = { type: "text"; text: string } | { type: "input"; slot: string; itemKey?: string; label?: string };

/** Projection of the Model Generator Definition's ordered content contract. */
export function modelPromptParts(state: State): ModelPromptPart[] {
  if (!Array.isArray(state.contentParts)) throw new Error("Ordered prompt content is unavailable.");
  return state.contentParts.map((part) => {
    if (part && typeof part === "object" && !Array.isArray(part)) {
      if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
      if (part.type === "input" && typeof part.slot === "string" && (part.itemKey === undefined || typeof part.itemKey === "string") && (part.label === undefined || typeof part.label === "string")) {
        return { type: "input", slot: part.slot, ...(part.itemKey === undefined ? {} : { itemKey: part.itemKey }), ...(part.label === undefined ? {} : { label: part.label }) };
      }
    }
    throw new Error("Ordered prompt content is invalid. Read the draft again.");
  });
}

export function withModelPromptParts(state: State, parts: ModelPromptPart[]): State {
  return { ...state, contentParts: parts, prompt: parts.map((part) => part.type === "text" ? part.text : part.label ?? "").join("") };
}

export function editModelPromptText(state: State, index: number, text: string): State {
  const parts = modelPromptParts(state);
  if (parts[index]?.type !== "text") throw new Error("This prompt section changed. Read the draft again.");
  return withModelPromptParts(state, parts.map((part, at) => at === index ? { type: "text", text } : part));
}

export function removeModelPromptInput(state: State, input: { slot: string; itemKey?: string }): State {
  if (state.contentParts === undefined) return state;
  return withModelPromptParts(state, modelPromptParts(state).filter((part) => part.type !== "input" || part.slot !== input.slot || part.itemKey !== input.itemKey));
}

type Inputs = GeneratorRevision["persistentInputRefs"];
const inputIdentity = (input: { slot: string; itemKey?: string }) => JSON.stringify([input.slot, input.itemKey ?? null]);

/** Materialize the current fallback order before adding or replacing inputs. */
export function modelPromptPartsWithInputs(state: State, refs: Inputs): ModelPromptPart[] {
  const parts: ModelPromptPart[] = state.contentParts === undefined
    ? [{ type: "text", text: typeof state.prompt === "string" ? state.prompt : "" }]
    : modelPromptParts(state);
  const present = new Set(parts.filter(part => part.type === "input").map(inputIdentity));
  return [...parts, ...refs.filter(ref => !present.has(inputIdentity(ref))).map(ref => ({
    type: "input" as const, slot: ref.slot, ...(ref.itemKey === undefined ? {} : { itemKey: ref.itemKey }), label: "",
  }))];
}

/** Input arrays are identity-normalized; authored order belongs to contentParts. */
export function modelInputRefsInPromptOrder(state: State, refs: Inputs): Inputs {
  if (state.contentParts === undefined) return [...refs];
  const byIdentity = new Map(refs.map(ref => [inputIdentity(ref), ref]));
  const seen = new Set<string>();
  const ordered: Inputs = [];
  for (const part of modelPromptParts(state)) {
    if (part.type !== "input") continue;
    const key = inputIdentity(part);
    const ref = byIdentity.get(key);
    if (!ref) throw new Error("Ordered prompt references a missing input. Read the draft again.");
    if (!seen.has(key)) { seen.add(key); ordered.push(ref); }
  }
  return [...ordered, ...refs.filter(ref => !seen.has(inputIdentity(ref)))];
}

/** Reorder selected media occurrences while retaining text positions and other inputs. */
export function reorderModelMediaInputs(state: State, refs: Inputs, assetIds: readonly string[]): State {
  const rank = new Map([...new Set(assetIds)].map((id, index) => [id, index]));
  const byIdentity = new Map(refs.map(ref => [inputIdentity(ref), ref]));
  const parts: ModelPromptPart[] = state.contentParts === undefined
    ? [{ type: "text", text: typeof state.prompt === "string" ? state.prompt : "" }, ...refs.map(ref => ({ type: "input" as const, slot: ref.slot, ...(ref.itemKey === undefined ? {} : { itemKey: ref.itemKey }), label: "" }))]
    : modelPromptParts(state);
  const rankOf = (part: ModelPromptPart) => {
    if (part.type !== "input") return undefined;
    const ref = byIdentity.get(inputIdentity(part));
    return ref && "kind" in ref.target && ref.target.kind === "media" ? rank.get(ref.target.projectAssetId) : undefined;
  };
  const sorted = parts.filter(part => rankOf(part) !== undefined).sort((a, b) => rankOf(a)! - rankOf(b)!);
  let cursor = 0;
  return withModelPromptParts(state, parts.map(part => rankOf(part) === undefined ? part : sorted[cursor++]!));
}
