import { useEffect, useState } from "react";
import {
  DocumentAssetRevisionRefSchema,
  DocumentAssetRevisionSchema,
  MODEL_TEXT_DOCUMENT_KIND,
  MODEL_TEXT_DOCUMENT_SCHEMA_VERSION,
} from "@clash/shared-types";
import {
  createDocumentClient,
  type DocumentRequest,
} from "@clash/shared-runtime/document-client";
import { runtimeApiUrl } from "../lib/runtimeConfig";

const requestHost: DocumentRequest = (path, init) =>
  fetch(runtimeApiUrl(path), { credentials: "include", ...init });
type Result = { body?: string; error?: string };

/** Canvas displays the selected immutable Document body, never a cached text shadow. */
export function useTextDocumentRevision(
  projectId: string | null,
  reference: unknown,
  request: DocumentRequest = requestHost,
): Result {
  const parsed = DocumentAssetRevisionRefSchema.safeParse(reference);
  const documentAssetId = parsed.success ? parsed.data.documentAssetId : null;
  const revisionId = parsed.success ? parsed.data.revisionId : null;
  const key = JSON.stringify([projectId, documentAssetId, revisionId]);
  const [loaded, setLoaded] = useState<{ key: string; result: Result }>();
  useEffect(() => {
    if (!projectId || !documentAssetId || !revisionId) return;
    let active = true;
    const controller = new AbortController();
    const client = createDocumentClient((path, init) =>
      request(path, { ...init, signal: controller.signal }),
    );
    void client
      .getRevision(projectId, documentAssetId, revisionId)
      .then((value) => {
        const result = value as { revision?: unknown; body?: unknown } | null;
        const revision = DocumentAssetRevisionSchema.parse(result?.revision);
        if (
          revision.documentAssetId !== documentAssetId ||
          revision.id !== revisionId ||
          revision.documentKind !== MODEL_TEXT_DOCUMENT_KIND ||
          revision.schemaVersion !== MODEL_TEXT_DOCUMENT_SCHEMA_VERSION ||
          typeof result?.body !== "string"
        ) {
          throw new Error(
            "The returned Document does not match the selected text revision.",
          );
        }
        if (active) setLoaded({ key, result: { body: result.body } });
      })
      .catch((error) => {
        if (active)
          setLoaded({
            key,
            result: {
              error: error instanceof Error ? error.message : String(error),
            },
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId, documentAssetId, revisionId, key, request]);
  if (!parsed.success)
    return { error: "The text Document reference is invalid." };
  if (!projectId) return { error: "The text Document project is unavailable." };
  return loaded?.key === key ? loaded.result : {};
}
