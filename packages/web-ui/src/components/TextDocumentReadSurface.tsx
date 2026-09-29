import { DocumentRevisionContent } from "./DocumentRevisionContent";
import { Button } from "./ui/button";

export function TextDocumentReadSurface({
  projectId,
  reference,
  documentKind,
  status,
  label,
  onClose,
}: {
  projectId: string;
  reference: unknown;
  documentKind?: unknown;
  status?: unknown;
  label: string;
  onClose: () => void;
}) {
  const analysis =
    typeof documentKind === "string" &&
    documentKind.startsWith("media.analysis.");
  const pending = reference === undefined && status !== "failed";
  const failed = reference === undefined && status === "failed";
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
        {failed ? (
          <p role="alert">
            {analysis ? "Analysis" : "Document generation"} failed. Inspect the
            operation for details.
          </p>
        ) : pending ? (
          <p role="status">{analysis ? "Analyzing…" : "Creating document…"}</p>
        ) : (
          <DocumentRevisionContent
            projectId={projectId}
            reference={reference}
          />
        )}
      </div>
    </section>
  );
}
