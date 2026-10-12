import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type {
  ArtifactEvidence,
  ArtifactKind,
  QualityReviewArtifactBinding,
  QualityReviewRequest,
} from "./types";

export type VerifiedQualityEvidenceFile = {
  binding: QualityReviewArtifactBinding;
  path: string;
  bytes: Buffer;
};

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

export function qualityRequestEvidenceKinds(
  request: QualityReviewRequest,
): Set<ArtifactKind | undefined> {
  const artifactsById = new Map(
    request.artifacts.map((artifact) => [artifact.id, artifact]),
  );
  return new Set(
    request.criteria.flatMap((criterion) =>
      criterion.evidenceArtifactIds.map(
        (artifactId) => artifactsById.get(artifactId)?.kind,
      ),
    ),
  );
}

/**
 * Reads every bound artifact of the given kinds from the evaluated workspace and proves its bytes
 * are exactly the evidence the request names. The returned bytes are the ones that were hashed, so
 * a judge that sends them cannot be handed a file swapped after verification.
 */
export async function verifiedQualityEvidenceFiles(input: {
  request: QualityReviewRequest;
  evidence: ArtifactEvidence[];
  workspace: string;
  kinds: ReadonlySet<ArtifactKind>;
}): Promise<VerifiedQualityEvidenceFile[]> {
  const canonicalWorkspace = await realpath(input.workspace);
  const evidenceById = new Map(
    input.evidence.map((artifact) => [artifact.id, artifact]),
  );
  const files: VerifiedQualityEvidenceFile[] = [];
  for (const binding of input.request.artifacts) {
    if (!input.kinds.has(binding.kind)) continue;
    const evidence = evidenceById.get(binding.id);
    if (
      !evidence ||
      evidence.kind !== binding.kind ||
      evidence.bytes !== binding.bytes ||
      evidence.sha256 !== binding.sha256
    ) {
      throw new Error(
        `Quality judge ${binding.kind} '${binding.id}' does not match evaluated artifact evidence`,
      );
    }
    const path = join(canonicalWorkspace, evidence.path);
    const pathInfo = await lstat(path);
    const canonicalPath = await realpath(path);
    const canonicalInfo = await stat(canonicalPath);
    if (
      !isInside(canonicalWorkspace, canonicalPath) ||
      pathInfo.isSymbolicLink() ||
      !pathInfo.isFile() ||
      !canonicalInfo.isFile() ||
      pathInfo.nlink !== 1 ||
      canonicalInfo.size !== binding.bytes
    ) {
      throw new Error(
        `Quality judge ${binding.kind} '${binding.id}' failed exact SHA-256 readback`,
      );
    }
    const bytes = await readFile(canonicalPath);
    if (
      bytes.byteLength !== binding.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== binding.sha256
    ) {
      throw new Error(
        `Quality judge ${binding.kind} '${binding.id}' failed exact SHA-256 readback`,
      );
    }
    files.push({ binding, path: canonicalPath, bytes });
  }
  return files;
}
