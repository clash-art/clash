import { useEffect, useState } from "react";
import {
  DocumentAssetRevisionSchema,
  MediaOperationTraceSchema,
  type AssetEvidenceMatch,
  type MediaOperationTrace,
  type ResolvedAsset,
} from "@clash/shared-types";
import { createDocumentClient } from "@clash/shared-runtime/document-client";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import { runtimeApiUrl } from "../../lib/runtimeConfig";
import { evidenceTimeRange } from "./useAssetEvidence";
import { DocumentRevisionContent } from "../../components/DocumentRevisionContent";

function OperationRecord({
  projectId,
  match,
  assets,
  onOpenAsset,
}: {
  projectId: string;
  match: AssetEvidenceMatch;
  assets: ResolvedAsset[];
  onOpenAsset?: (id: string) => void;
}) {
  const { documentAssetId, revisionId } = match.document;
  const [value, setValue] = useState<{
    body?: MediaOperationTrace;
    error?: string;
  }>();
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const client = createDocumentClient((path, init) =>
      fetch(runtimeApiUrl(path), {
        ...init,
        credentials: "include",
        signal: controller.signal,
      }),
    );
    void client
      .getRevision(projectId, documentAssetId, revisionId)
      .then((raw) => {
        const result = raw as { revision: unknown; body: unknown };
        const revision = DocumentAssetRevisionSchema.parse(result.revision);
        if (
          revision.documentAssetId !== documentAssetId ||
          revision.id !== revisionId ||
          revision.documentKind !== "media.operation-trace" ||
          revision.schemaVersion !== 1
        )
          throw new Error(
            "The operation record does not match its pinned revision.",
          );
        const body = MediaOperationTraceSchema.parse(result.body);
        if (active) setValue({ body });
      })
      .catch((cause) => {
        if (active)
          setValue({
            error: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [documentAssetId, projectId, revisionId]);
  if (value?.error)
    return (
      <p role="alert" className="py-2 text-xs text-red-600">
        {value.error}
      </p>
    );
  if (!value?.body)
    return (
      <p role="status" className="py-2 text-xs text-content-muted">
        Loading operation…
      </p>
    );
  return (
    <Collapsible className="py-2">
      <CollapsibleTrigger className="w-full text-left text-xs font-semibold text-content-primary">
        {value.body.title}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <p className="text-[10px] text-content-muted">
          Recorded{" "}
          {match.producer.kind === "actor"
            ? `by ${match.producer.actor.kind}`
            : match.producer.kind === "action-run"
              ? `by run ${match.producer.actionRunId}`
              : "from migration"}
        </p>
        <pre className="my-2 whitespace-pre-wrap break-words rounded-md bg-warm-muted p-2 font-mono text-[11px] text-content-secondary">
          {value.body.detail}
        </pre>
        <ul className="space-y-1">
          {match.sourceRefs.flatMap((ref, index) => {
            if (!("kind" in ref.target) || ref.target.kind !== "media")
              return [];
            const id = ref.target.projectAssetId;
            const asset = assets.find((candidate) => candidate.id === id);
            const name = asset?.name ?? asset?.metadata.originalName ?? id;
            return (
              <li key={`${ref.slot}:${index}`} className="break-words text-xs">
                {asset && onOpenAsset ? (
                  <button
                    type="button"
                    className="text-left text-brand hover:underline"
                    aria-label={`Open ${ref.slot} ${name}`}
                    onClick={() => onOpenAsset(id)}
                  >
                    {ref.slot}: {name}
                  </button>
                ) : (
                  `${ref.slot}: ${name}`
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 break-all text-[10px] text-content-muted">
          Revision {revisionId}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AssetEvidencePanel({
  projectId,
  matches,
  truncated,
  loading,
  error,
  assets,
  onOpenAsset,
  onSeek,
}: {
  projectId: string;
  matches: AssetEvidenceMatch[];
  truncated: boolean;
  loading: boolean;
  error?: string;
  assets: ResolvedAsset[];
  onOpenAsset?: (id: string) => void;
  onSeek?: (startMs: number) => void;
}) {
  const records = new Map<string, AssetEvidenceMatch[]>();
  for (const match of matches) {
    const key = JSON.stringify([
      match.document.documentAssetId,
      match.document.revisionId,
    ]);
    records.set(key, [...(records.get(key) ?? []), match]);
  }
  if (!loading && !error && !truncated && !records.size) return null;
  return (
    <section
      aria-label="Asset evidence"
      className="border-t border-warm-border/70 px-4 py-3.5"
    >
      <h2 className="font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400">
        Analysis & operations
      </h2>
      {loading && (
        <p role="status" className="mt-2 text-xs text-content-muted">
          Loading records…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
      {truncated && (
        <p role="status" className="mt-2 text-xs text-content-secondary">
          Some evidence is omitted from this view.
        </p>
      )}
      {[...records].map(([key, entries]) =>
        entries[0]!.documentKind === "media.operation-trace" ? (
          <OperationRecord
            key={key}
            projectId={projectId}
            match={entries[0]!}
            assets={assets}
            onOpenAsset={onOpenAsset}
          />
        ) : (
          <div key={key} className="mt-3 text-xs">
            <p className="mb-1 text-[10px] text-content-muted">
              {entries[0]!.documentKind === "media.observation"
                ? "Recorded observations"
                : entries[0]!.documentKind
                    .replace("media.analysis.", "")
                    .replaceAll("-", " ")}
            </p>
            {entries.map((entry, index) => (
              <div key={index} className="mb-2">
                <p className="whitespace-pre-wrap break-words leading-relaxed text-content-secondary">
                  {entry.text}
                </p>
                {evidenceTimeRange(entry) &&
                  (onSeek ? (
                    <button
                      type="button"
                      className="mt-1 text-[11px] tabular-nums text-brand hover:underline"
                      aria-label={`Preview ${evidenceTimeRange(entry)}`}
                      onClick={() => onSeek(entry.startMs!)}
                    >
                      {evidenceTimeRange(entry)}
                    </button>
                  ) : (
                    <p className="mt-1 text-[11px] tabular-nums text-content-muted">
                      {evidenceTimeRange(entry)}
                    </p>
                  ))}
              </div>
            ))}
            <p className="break-all text-[10px] text-content-muted">
              {entries[0]!.producer.kind === "actor"
                ? `Recorded by ${entries[0]!.producer.actor.kind}`
                : "Generated analysis"}{" "}
              · Revision {entries[0]!.document.revisionId}
            </p>
            <Collapsible className="mt-2">
              <CollapsibleTrigger className="text-[11px] text-content-secondary">
                Analysis details
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <DocumentRevisionContent
                  projectId={projectId}
                  reference={entries[0]!.document}
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
        ),
      )}
    </section>
  );
}
