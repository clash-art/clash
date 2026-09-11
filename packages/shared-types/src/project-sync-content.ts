import type { LoroDoc } from "loro-crdt";
import { z } from "zod";
import { ResourceSchema, type AssetKind } from "./assets.js";
import type { DocumentBodyRef } from "./document-assets.js";
import { listProjectAssets } from "./project-assets.js";
import {
  listProjectDocumentAssets,
  listDocumentAssetRevisions,
} from "./project-document-assets.js";

/** References only. Project Loro remains the membership and revision authority;
 * Resource facts and byte locations belong to the Host registry. */
export function projectSyncContent(doc: LoroDoc): {
  resources: Array<{ resourceId: string; kind: AssetKind }>;
  documents: DocumentBodyRef[];
} {
  const resources = new Map<string, { resourceId: string; kind: AssetKind }>();
  for (const asset of listProjectAssets(doc)) {
    if (asset.lifecycle.state === "purged") continue;
    const previous = resources.get(asset.source.resourceId);
    if (previous && previous.kind !== asset.kind)
      throw new Error("Conflicting immutable Resource kinds");
    resources.set(asset.source.resourceId, {
      resourceId: asset.source.resourceId,
      kind: asset.kind,
    });
  }
  const documents = new Map<string, DocumentBodyRef>();
  for (const asset of listProjectDocumentAssets(doc)) {
    for (const revision of listDocumentAssetRevisions(doc, asset.id)) {
      const previous = documents.get(revision.body.digest);
      if (
        previous &&
        (previous.byteLength !== revision.body.byteLength ||
          previous.contentType !== revision.body.contentType)
      )
        throw new Error("Conflicting immutable Document body facts");
      documents.set(revision.body.digest, revision.body);
    }
  }
  return {
    resources: [...resources.values()].sort((a, b) =>
      a.resourceId.localeCompare(b.resourceId),
    ),
    documents: [...documents.values()].sort((a, b) =>
      a.digest.localeCompare(b.digest),
    ),
  };
}

export const ProjectResourceDeliveryRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        operation: z.literal("upload"),
        resource: ResourceSchema,
        localReplicaId: z.string().min(1),
      })
      .strict(),
    z
      .object({
        operation: z.literal("read"),
        localReplicaId: z.string().min(1),
      })
      .strict(),
  ],
);
