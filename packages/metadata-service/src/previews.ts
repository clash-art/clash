/** Project card asset previews: placed image/video nodes first (deduped by
 * Asset), then imported Asset refs not already shown (deduped by preview
 * object). Same selection api-cf has used since the D1 port. */
export interface PreviewAssetRow {
  id: string;
  srcR2Key: string;
  coverR2Key: string | null;
}
export interface PreviewRefRow extends PreviewAssetRow {
  kind: string;
  createdAt: Date | null;
  importedAt: Date | null;
}
export interface ProjectPreview {
  id: string;
  assetId: string;
  url: string;
  type: "image" | "video";
  createdAt: Date | null;
}
export interface ProjectPreviewPorts {
  /** Canvas nodes of the Project (authoritative room); [] when unavailable. */
  nodes(projectId: string): Promise<unknown[]>;
  assetsByIds(ids: string[]): Promise<PreviewAssetRow[]>;
  /** Imported Asset refs of the Project owned by userId, newest first (≤1000). */
  importedAssets(projectId: string, userId: string): Promise<PreviewRefRow[]>;
  /** Signed, short-lived delivery URL for a stored object. */
  sign(storageKey: string): Promise<string>;
}

interface MediaNode {
  id: string;
  type: "image" | "video";
  createdAt?: unknown;
  data: { assetId: string; createdAt?: unknown };
}

export async function resolveProjectPreviews(
  ports: ProjectPreviewPorts,
  userId: string,
  project: { id: string; createdAt: Date | null; updatedAt: Date | null },
): Promise<ProjectPreview[]> {
  const nodes = (await ports.nodes(project.id)) as any[];
  const mediaNodes = nodes.filter(
    (node) =>
      (node?.type === "image" || node?.type === "video") &&
      typeof node.data?.assetId === "string",
  ) as MediaNode[];
  const assetIds = Array.from(new Set(mediaNodes.map((n) => n.data.assetId)));
  const assetRows = assetIds.length ? await ports.assetsByIds(assetIds) : [];
  const assetById = new Map(assetRows.map((r) => [r.id, r]));

  const placed = (
    await Promise.all(
      mediaNodes.map(async (node) => {
        const row = assetById.get(node.data.assetId);
        if (!row) return null;
        if (node.type === "video" && !row.coverR2Key) return null;
        const key = node.type === "video" ? row.coverR2Key! : row.srcR2Key;
        return {
          id: node.id,
          assetId: node.data.assetId,
          url: await ports.sign(key),
          type: node.type,
          createdAt: node.data?.createdAt
            ? new Date(node.data.createdAt as string)
            : node.createdAt
              ? new Date(node.createdAt as string)
              : project.updatedAt || project.createdAt,
        } satisfies ProjectPreview;
      }),
    )
  ).filter((a): a is ProjectPreview => a !== null);

  const placedIds = new Set<string>();
  const projectAssets = placed.filter((a) => {
    if (placedIds.has(a.assetId)) return false;
    placedIds.add(a.assetId);
    return true;
  });

  const seenAssetIds = new Set(mediaNodes.map((n) => n.data.assetId));
  const seenKeys = new Set(
    mediaNodes
      .map((n) => {
        const row = assetById.get(n.data.assetId);
        if (!row) return undefined;
        return n.type === "video" ? row.coverR2Key : row.srcR2Key;
      })
      .filter((k): k is string => typeof k === "string"),
  );
  const refs = await ports.importedAssets(project.id, userId);
  const fallback = (
    await Promise.all(
      refs.map(async (row) => {
        if (seenAssetIds.has(row.id)) return null;
        if (row.kind !== "image" && row.kind !== "video") return null;
        if (row.kind === "video" && !row.coverR2Key) return null;
        const key = row.kind === "video" ? row.coverR2Key! : row.srcR2Key;
        if (seenKeys.has(key)) return null;
        seenAssetIds.add(row.id);
        seenKeys.add(key);
        return {
          id: row.id,
          assetId: row.id,
          url: await ports.sign(key),
          type: row.kind,
          createdAt:
            row.createdAt || row.importedAt || project.updatedAt || project.createdAt,
        } satisfies ProjectPreview;
      }),
    )
  ).filter((a): a is ProjectPreview => a !== null);
  return [...projectAssets, ...fallback];
}
