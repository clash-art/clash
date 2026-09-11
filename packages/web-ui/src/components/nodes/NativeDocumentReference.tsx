import type { GeneratorInputRef } from "@clash/shared-types";
import { useTextDocumentRevision } from "../../hooks/useTextDocumentRevision";
import { IconButton } from "../ui/icon-button";

/** Read exactly the input revision; an Asset needs no Canvas placement to be used. */
export function NativeDocumentReference({ projectId, input, label, onRemove }: {
  projectId: string;
  input: GeneratorInputRef;
  label: string;
  onRemove?: (input: GeneratorInputRef) => void;
}) {
  const { body, error } = useTextDocumentRevision(projectId, input.target);
  return <li className="flex min-w-0 items-center gap-2 rounded-lg border border-warm-border bg-warm-surface px-3 py-2 text-xs">
    <div className="min-w-0 flex-1">
      <div className="truncate font-medium">{label}</div>
      {error ? <p role="alert">{error}</p> : body === undefined ? <p role="status">Loading text…</p>
        : <p className="line-clamp-2 whitespace-pre-wrap text-content-secondary">{body}</p>}
    </div>
    {onRemove && <IconButton className="nodrag nopan" label={`Remove ${label} text reference`} icon="×" size="sm" shape="circle" onClick={() => onRemove(input)} />}
  </li>;
}
