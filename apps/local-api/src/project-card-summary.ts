import {
  ProjectAssetEntrySchema,
  ProjectCanvasPreviewSchema,
  type ProjectAssetEntry,
} from "@clash/shared-types";

import type { CachedProjectCanvasPreview } from "./loro/file-replica-store.js";

/** Additive derived-cache schema; rebuilding from Project Loro is always allowed. */
export const PROJECT_CARD_SUMMARY_SCHEMA_VERSION = 1;

export interface ProjectCardSummaryContent {
  /** False when this document still needs the one-way Project Asset migration. */
  assetAuthorityCurrent: boolean;
  assetCount: number;
  coverAssetId: string | null;
  entries: ProjectAssetEntry[];
  preview: CachedProjectCanvasPreview;
}

export interface ProjectCardSummary extends ProjectCardSummaryContent {
  schemaVersion: typeof PROJECT_CARD_SUMMARY_SCHEMA_VERSION;
  /** Cheap snapshot+update-log identity used to reject a stale derived card. */
  replicaStamp: string;
}

export interface StoredProjectCardSummary {
  projectId: string;
  replicaStamp: string;
  summary: ProjectCardSummary;
}

export function projectCardSummaryContent(input: {
  assetAuthorityCurrent: boolean;
  entries: ProjectAssetEntry[];
  coverAssetId: string | null;
  preview: CachedProjectCanvasPreview;
}): ProjectCardSummaryContent {
  return {
    assetAuthorityCurrent: input.assetAuthorityCurrent,
    assetCount: input.entries.length,
    coverAssetId: input.coverAssetId,
    entries: input.entries,
    preview: input.preview,
  };
}

export function withProjectCardReplicaStamp(
  content: ProjectCardSummaryContent,
  replicaStamp: string,
): ProjectCardSummary {
  return {
    schemaVersion: PROJECT_CARD_SUMMARY_SCHEMA_VERSION,
    replicaStamp,
    ...content,
  };
}

function parsePreview(value: unknown): CachedProjectCanvasPreview | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sourceVersion !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.sourceVersion) ||
    typeof candidate.docVersion !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.docVersion) ||
    typeof candidate.generatedAt !== "string" ||
    !candidate.generatedAt.trim()
  ) {
    return null;
  }
  const preview = ProjectCanvasPreviewSchema.safeParse(candidate.preview);
  if (!preview.success) return null;
  return {
    sourceVersion: candidate.sourceVersion,
    docVersion: candidate.docVersion,
    generatedAt: candidate.generatedAt,
    preview: preview.data,
  };
}

export function parseProjectCardSummary(
  value: unknown,
): ProjectCardSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== PROJECT_CARD_SUMMARY_SCHEMA_VERSION ||
    typeof candidate.assetAuthorityCurrent !== "boolean" ||
    typeof candidate.replicaStamp !== "string" ||
    !candidate.replicaStamp.trim() ||
    typeof candidate.assetCount !== "number" ||
    !Number.isSafeInteger(candidate.assetCount) ||
    candidate.assetCount < 0 ||
    !Array.isArray(candidate.entries) ||
    (candidate.coverAssetId !== null &&
      typeof candidate.coverAssetId !== "string")
  ) {
    return null;
  }
  const entries: ProjectAssetEntry[] = [];
  for (const entry of candidate.entries) {
    const parsed = ProjectAssetEntrySchema.safeParse(entry);
    if (!parsed.success) return null;
    entries.push(parsed.data);
  }
  if (entries.length !== candidate.assetCount) return null;
  const preview = parsePreview(candidate.preview);
  if (!preview) return null;
  return {
    schemaVersion: PROJECT_CARD_SUMMARY_SCHEMA_VERSION,
    assetAuthorityCurrent: candidate.assetAuthorityCurrent,
    replicaStamp: candidate.replicaStamp,
    assetCount: candidate.assetCount,
    coverAssetId: candidate.coverAssetId,
    entries,
    preview,
  };
}

/**
 * The Dashboard card keeps the same four newest active image/video Assets as
 * the previous resolve-all-then-slice path, but resolves only those entries.
 */
export function projectCardPreviewEntries(
  entries: readonly ProjectAssetEntry[],
): ProjectAssetEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.lifecycle.state === "active" &&
        (entry.kind === "image" || entry.kind === "video"),
    )
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    .slice(0, 4);
}
