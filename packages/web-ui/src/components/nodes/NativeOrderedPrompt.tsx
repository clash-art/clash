import { useEffect, useRef, useState } from "react";
import type { GeneratorRevision } from "@clash/shared-types";
import type { GeneratorStateEdit } from "../../lib/generatorDraftEditor";
import { editModelPromptText, modelPromptParts, withModelPromptParts } from "../../lib/modelPromptContent";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";

function OrderedTextSection({ text, index, disabled, edit, onError }: {
  text: string; index: number; disabled: boolean; edit: (patch: GeneratorStateEdit) => Promise<unknown>; onError: (error: string) => void;
}) {
  const [value, setValue] = useState(text);
  const pending = useRef(0);
  useEffect(() => { if (!pending.current) setValue(text); }, [text]);
  return <Textarea aria-label={`Prompt text ${index + 1}`} value={value} disabled={disabled}
    onChange={(event) => {
      const next = event.target.value;
      setValue(next);
      pending.current += 1;
      void edit((before) => editModelPromptText(before, index, next))
        .catch((error) => onError(error instanceof Error ? error.message : String(error)))
        .finally(() => { pending.current -= 1; });
    }} />;
}

export function NativeOrderedPrompt({ state, disabled, edit }: {
  state: GeneratorRevision["state"];
  disabled: boolean;
  edit: (patch: GeneratorStateEdit) => Promise<unknown>;
}) {
  const [error, setError] = useState<string | null>(null);
  const save = (patch: GeneratorStateEdit) => { void edit(patch).catch((error) => setError(error instanceof Error ? error.message : String(error))); };
  const parts = modelPromptParts(state);
  return <div aria-label="Ordered prompt" className="nodrag nopan flex flex-col gap-2">
    {parts.map((part, index) => part.type === "text"
      ? <OrderedTextSection key={index} text={part.text} index={index} disabled={disabled} edit={edit} onError={setError} />
      : <span key={index} className="rounded border border-warm-border bg-warm-muted px-2 py-1 text-xs">{part.label || `${part.slot} reference`}</span>)}
    {!disabled && <Button size="sm" onClick={() => save((before) => withModelPromptParts(before, [...modelPromptParts(before), { type: "text", text: "" }]))}>Add text section</Button>}
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
  </div>;
}
