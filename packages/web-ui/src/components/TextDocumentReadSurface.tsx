import ReactMarkdown from "react-markdown";
import { useTextDocumentRevision } from "../hooks/useTextDocumentRevision";
import { Button } from "./ui/button";

export function TextDocumentReadSurface({
  projectId,
  reference,
  label,
  onClose,
}: {
  projectId: string;
  reference: unknown;
  label: string;
  onClose: () => void;
}) {
  const { body, error } = useTextDocumentRevision(projectId, reference);
  return (
    <section
      aria-label="Saved text result"
      className="absolute inset-0 z-10 flex flex-col bg-warm-page"
    >
      <header className="flex items-center gap-4 border-b border-warm-border p-4">
        <Button onClick={onClose}>Back to Canvas</Button>
        <h2 className="truncate font-display font-semibold">{label}</h2>
      </header>
      <div className="prose mx-auto w-full max-w-3xl flex-1 overflow-auto whitespace-pre-wrap p-8 text-content-primary">
        {error ? (
          <p role="alert">{error}</p>
        ) : body === undefined ? (
          <p role="status">Loading text…</p>
        ) : (
          <ReactMarkdown>{body}</ReactMarkdown>
        )}
      </div>
    </section>
  );
}
