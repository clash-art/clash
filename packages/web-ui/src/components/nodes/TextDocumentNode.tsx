import { useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import { useOptionalLoroSyncContext } from "../LoroSyncContext";
import { useTextDocumentRevision } from "../../hooks/useTextDocumentRevision";
import { Dialog } from "../ui/dialog";
import { Button } from "../ui/button";
import { DocumentRevisionContent } from "../DocumentRevisionContent";

/** A result placement reads one Document Revision; it owns no editable text body. */
function PlainTextDocumentNode({
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

function TypedDocumentNode({ data, selected }: NodeProps<Node<Record<string, any>>>) {
  const project = useOptionalLoroSyncContext();
  const [open, setOpen] = useState(false);
  const title = typeof data.label === "string" ? data.label : "Analysis result";
  const analysis = typeof data.documentKind === "string" && data.documentKind.startsWith("media.analysis.");
  const pending = !data.documentRevision && data.status !== "failed";
  const failed = !data.documentRevision && data.status === "failed";
  const content = failed ? <p role="alert">{analysis ? "Analysis" : "Document generation"} failed. Inspect the operation for details.</p>
    : pending ? <p role="status">{analysis ? "Analyzing…" : "Creating document…"}</p>
    : <DocumentRevisionContent projectId={project?.projectId ?? null} reference={data.documentRevision} />;
  return <>
    <div className={`relative flex h-[400px] w-[300px] cursor-grab flex-col rounded-matrix bg-warm-muted p-6 ${selected ? "ring-4 ring-brand" : "ring-1 ring-warm-border"}`} onDoubleClick={() => { if (!pending && !failed) setOpen(true); }}>
      <div className="mb-4 truncate font-display font-bold">{title}</div>
      <div className="pointer-events-none flex-1 overflow-hidden text-content-primary">{content}</div>
      {!pending && !failed && <Button className="nodrag nopan mt-4" onClick={() => setOpen(true)}>Read analysis</Button>}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
    <Dialog open={open} title={title} description="Saved document for this result." onClose={() => setOpen(false)}>
      <div className="max-h-[70vh] overflow-auto p-6 text-content-primary">{content}</div>
    </Dialog>
  </>;
}

export function TextDocumentNode(props: NodeProps<Node<Record<string, any>>>) {
  return (typeof props.data.documentKind === "string" && props.data.documentKind !== "text.plain") || (props.data.actionRunId && !props.data.documentRevision)
    ? <TypedDocumentNode {...props} /> : <PlainTextDocumentNode {...props} />;
}
