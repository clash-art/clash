import {
  DocumentAssetRevisionRefSchema,
  type AssetRevisionRef,
  type GeneratorInputTarget,
} from "./generator-v2.js";
import { referenceAssetId } from "./model-capabilities.js";

/** Resolve a Canvas projection to the immutable product identity it displays. */
export function canvasAssetRevision(
  node: Parameters<typeof referenceAssetId>[0] | null | undefined,
): AssetRevisionRef | null {
  if (!node) return null;
  if (node.type === "text") {
    if (node.data?.documentRevision === undefined) return null;
    const parsed = DocumentAssetRevisionRefSchema.safeParse(
      node.data.documentRevision,
    );
    if (!parsed.success)
      throw new Error(
        "The Canvas Document revision is invalid. Read the source again.",
      );
    return parsed.data;
  }
  const projectAssetId = referenceAssetId(node);
  return projectAssetId ? { kind: "media", projectAssetId } : null;
}

/** Exact identity for input matching; a Document head is never an input identity. */
export function assetRevisionKey(
  ref: GeneratorInputTarget | null | undefined,
): string | null {
  if (!ref || !("kind" in ref)) return null;
  return ref.kind === "media"
    ? JSON.stringify(["media", ref.projectAssetId])
    : JSON.stringify(["document", ref.documentAssetId, ref.revisionId]);
}
