import { useEffect, useState } from "react";
import {
  DocumentAssetRevisionRefSchema,
  DocumentAssetRevisionSchema,
  type DocumentAssetRevision,
} from "@clash/shared-types";
import { createDocumentClient } from "@clash/shared-runtime/document-client";
import { runtimeApiUrl } from "../lib/runtimeConfig";

/** Reads one pinned typed body; the current mutable Document head is not consulted. */
export function useDocumentRevision(
  projectId: string | null,
  reference: unknown,
): { revision?: DocumentAssetRevision; body?: unknown; error?: string } {
  const parsed = DocumentAssetRevisionRefSchema.safeParse(reference);
  const documentAssetId = parsed.success ? parsed.data.documentAssetId : null;
  const revisionId = parsed.success ? parsed.data.revisionId : null;
  const key = JSON.stringify([projectId, documentAssetId, revisionId]);
  const [loaded, setLoaded] = useState<{
    key: string;
    revision?: DocumentAssetRevision;
    body?: unknown;
    error?: string;
  }>();
  useEffect(() => {
    if (!projectId || !documentAssetId || !revisionId) return;
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
      .then((value) => {
        const result = value as { revision?: unknown; body?: unknown };
        const revision = DocumentAssetRevisionSchema.parse(result.revision);
        if (
          revision.documentAssetId !== documentAssetId ||
          revision.id !== revisionId
        )
          throw new Error(
            "The returned Document does not match the selected revision.",
          );
        if (active) setLoaded({ key, revision, body: result.body });
      })
      .catch((cause) => {
        if (active)
          setLoaded({
            key,
            error: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId, documentAssetId, revisionId, key]);
  if (!parsed.success) return { error: "The Document reference is invalid." };
  if (!projectId) return { error: "The Document project is unavailable." };
  return loaded?.key === key ? loaded : {};
}
