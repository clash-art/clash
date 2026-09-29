import ReactMarkdown from "react-markdown";
import { useDocumentRevision } from "../hooks/useDocumentRevision";
import { evidenceTimeRange } from "../features/assets/useAssetEvidence";

function DocumentValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object")
    return <p className="whitespace-pre-wrap break-words">{String(value)}</p>;
  if (Array.isArray(value))
    return (
      <ul className="space-y-2">
        {value.map((item, index) => (
          <li key={index}>
            <DocumentValue value={item} />
          </li>
        ))}
      </ul>
    );
  const object = value as Record<string, unknown>;
  const time =
    typeof object.startMs === "number" && typeof object.endMs === "number"
      ? evidenceTimeRange({ startMs: object.startMs, endMs: object.endMs })
      : undefined;
  return (
    <div className="space-y-2">
      {time && (
        <p className="text-xs tabular-nums text-content-muted">{time}</p>
      )}
      {Object.entries(object)
        .filter(([key]) => key !== "startMs" && key !== "endMs")
        .map(([key, item]) => (
          <div key={key}>
            {![
              "text",
              "items",
              "summary",
              "description",
              "observations",
            ].includes(key) && (
              <p className="text-xs capitalize text-content-muted">
                {key.replaceAll("-", " ").replace(/([a-z])([A-Z])/g, "$1 $2")}
              </p>
            )}
            <DocumentValue value={item} />
          </div>
        ))}
    </div>
  );
}

export function DocumentRevisionContent({
  projectId,
  reference,
}: {
  projectId: string | null;
  reference: unknown;
}) {
  const { body, revision, error } = useDocumentRevision(projectId, reference);
  if (error) return <p role="alert">{error}</p>;
  if (!revision) return <p role="status">Loading document…</p>;
  if (revision.documentKind === "text.plain" && typeof body === "string")
    return <ReactMarkdown>{body}</ReactMarkdown>;
  const object =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const value =
    revision.documentKind.startsWith("media.analysis.") && object
      ? object.result
      : body;
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      <DocumentValue value={value} />
      <p className="break-all text-[10px] text-content-muted">
        {revision.documentKind} · Revision {revision.id}
        {object && typeof object.modelId === "string"
          ? ` · ${object.modelId}`
          : ""}
      </p>
    </div>
  );
}
