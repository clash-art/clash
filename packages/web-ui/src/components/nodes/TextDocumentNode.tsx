import { useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import { useOptionalLoroSyncContext } from "../LoroSyncContext";
import { useTextDocumentRevision } from "../../hooks/useTextDocumentRevision";
import { Dialog } from "../ui/dialog";
import { Button } from "../ui/button";

/** A result placement reads one Document Revision; it owns no editable text body. */
export function TextDocumentNode({
  data,
  selected,
}: NodeProps<Node<Record<string, any>>>) {
  const project = useOptionalLoroSyncContext();
  const { body, error } = useTextDocumentRevision(
    project?.projectId ?? null,
    data.documentRevision,
  );
  const [open, setOpen] = useState(false);
  const title = typeof data.label === "string" ? data.label : "Text result";
  const content = error ? (
    <p role="alert">{error}</p>
  ) : body === undefined ? (
    <p role="status">Loading text…</p>
  ) : (
    <ReactMarkdown>{body}</ReactMarkdown>
  );
  return (
    <>
      <div
        className={`relative flex h-[400px] w-[300px] cursor-grab flex-col rounded-matrix bg-warm-muted p-6 ${selected ? "ring-4 ring-brand" : "ring-1 ring-warm-border"}`}
        onDoubleClick={() => setOpen(true)}
      >
        <div className="mb-4 truncate font-display font-bold">{title}</div>
        <div className="prose pointer-events-none flex-1 overflow-hidden text-content-primary">
          {content}
        </div>
        <Button className="nodrag nopan mt-4" onClick={() => setOpen(true)}>
          Read text
        </Button>
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
      </div>
      <Dialog
        open={open}
        title={title}
        description="Saved text for this result."
        onClose={() => setOpen(false)}
      >
        <div className="prose max-h-[70vh] overflow-auto whitespace-pre-wrap p-6 text-content-primary">
          {content}
        </div>
      </Dialog>
    </>
  );
}
