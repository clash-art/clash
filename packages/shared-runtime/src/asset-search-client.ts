import {
  AssetEvidenceQuerySchema,
  type AssetEvidenceQuery,
  type AssetEvidenceMatch,
  type ProjectContentResult,
} from "@clash/shared-types";
import type { DocumentRequest } from "./document-client.js";
import { createProjectContentClient } from "./project-content-client.js";

/** Preserve exact evidence refs; source times apply only to the displayed Asset. */
export function projectContentToAssetEvidence(result: ProjectContentResult) {
  const matches: AssetEvidenceMatch[] = result.items.flatMap((item) => {
    if (item.ref.kind !== "media") return [];
    const projectAssetId = item.ref.projectAssetId;
    return item.matches.flatMap((match) => {
      if (match.field !== "content" || !match.attachmentId) return [];
      return [
        {
          projectAssetId,
          attachmentId: match.attachmentId,
          document: match.document,
          documentKind: match.documentKind,
          producer: match.producer,
          sourceRefs: match.sourceRefs,
          text: match.text,
          ...(match.location?.asset.projectAssetId === projectAssetId
            ? { startMs: match.location.startMs, endMs: match.location.endMs }
            : {}),
        },
      ];
    });
  });
  return { matches, truncated: result.truncated };
}

/** Compatibility projection for media pickers; shared content search remains the authority. */
export function createAssetSearchClient(request: DocumentRequest) {
  const content = createProjectContentClient(request);
  return {
    async search(projectId: string, query: AssetEvidenceQuery = {}) {
      const parsed = AssetEvidenceQuerySchema.parse(query);
      const result = await content.search(projectId, {
        query: parsed.query ?? "",
        ...(parsed.assetId
          ? {
              within: {
                kind: "media" as const,
                projectAssetId: parsed.assetId,
              },
            }
          : {}),
        kinds: ["video", "image", "audio", "model"],
        limit: 200,
      });
      return projectContentToAssetEvidence(result);
    },
  };
}
