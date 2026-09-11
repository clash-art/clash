import { useEffect, useState } from "react";
import {
  directorCodeDocumentBody,
  type DirectorStageState,
} from "@clash/shared-types";
import { createDocumentClient } from "@clash/shared-runtime/document-client";
import { runtimeApiUrl } from "./runtimeConfig";

const documents = createDocumentClient((path, init) =>
  fetch(runtimeApiUrl(path), { ...init, credentials: "include" }),
);

/** Runtime hydration, deliberately absent from the Stage authoring document. */
export function useDirectorCodeSources(
  projectId: string | undefined,
  components: DirectorStageState["codeComponents"],
) {
  const key = JSON.stringify([projectId, components ?? []]);
  const [result, setResult] = useState<{
    key: string;
    sources?: Record<string, string>;
    error?: string;
  }>();
  useEffect(() => {
    const [projectId, components] = JSON.parse(key) as [
      string | undefined,
      DirectorStageState["codeComponents"],
    ];
    if (!components?.length) return;
    let cancelled = false;
    const load = async () => {
      if (!projectId)
        throw new Error(
          "A Project is required to resolve Director source Documents",
        );
      const entries = await Promise.all(
        components.map(async (component) => {
          const body = await documents.getRevision(
            projectId,
            component.source.documentAssetId,
            component.source.revisionId,
          );
          return [
            component.id,
            directorCodeDocumentBody(component.source, body),
          ] as const;
        }),
      );
      if (!cancelled) setResult({ key, sources: Object.fromEntries(entries) });
    };
    void load().catch((error) => {
      if (!cancelled)
        setResult({
          key,
          error: error instanceof Error ? error.message : String(error),
        });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  if (!components?.length)
    return { ready: true, sources: undefined, error: undefined };
  return {
    ready: result?.key === key && Boolean(result.sources),
    sources: result?.key === key ? result.sources : undefined,
    error: result?.key === key ? result.error : undefined,
  };
}
