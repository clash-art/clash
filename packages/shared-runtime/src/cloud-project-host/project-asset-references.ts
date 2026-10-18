/**
 * The one port that turns a pinned Project Asset reference into a short-lived
 * signed URL for the Asset's committed Resource.
 *
 * Canvas references, remote plugin references and Timeline media all name
 * Project Assets, which live in the Project document and are delivered
 * through the same signed Resource capability the Web uses for project
 * media. Each composition root binds the three ports (document read, committed
 * Resource read, signing); the state rules below are identical everywhere.
 *
 * A reference never degrades: a missing, trashed or not-yet-committed Asset is
 * an explicit `reference_unavailable` failure naming where it was referenced,
 * and nothing (no placeholder, no empty `src`) is handed onward.
 */
import { ProviderExecutionError } from "@clash/action-sdk/executable-failure";
import type {
  AssetKind,
  ProjectAssetEntry,
  Resource,
} from "@clash/shared-types";

export interface ProjectAssetReferenceTarget {
  projectId: string;
  assetId: string;
}

export interface ResolvedProjectAssetReference {
  assetId: string;
  kind: AssetKind;
  url: string;
  expiresAt: string;
  contentType?: string;
  width?: number;
  height?: number;
}

export type ProjectAssetReferenceUnavailableReason =
  | "missing"
  | "trashed"
  | "uncommitted";

export type ProjectAssetReferenceResolution =
  | { ok: true; reference: ResolvedProjectAssetReference }
  | { ok: false; reason: ProjectAssetReferenceUnavailableReason };

export interface ProjectAssetReferenceResolver {
  resolve(
    target: ProjectAssetReferenceTarget,
  ): Promise<ProjectAssetReferenceResolution>;
}

export interface ProjectAssetReferencePorts {
  readAsset(
    target: ProjectAssetReferenceTarget,
  ): Promise<ProjectAssetEntry | null | undefined>;
  /** The Resource this Project committed for `entry`, only while its bytes are stored. */
  readCommittedResource(
    target: ProjectAssetReferenceTarget,
    entry: ProjectAssetEntry,
  ): Promise<Resource | null | undefined>;
  sign(input: {
    target: ProjectAssetReferenceTarget;
    entry: ProjectAssetEntry;
    resource: Resource;
  }): Promise<{ url: string; expiresAt: string }>;
}

export function createProjectAssetReferenceResolver(
  ports: ProjectAssetReferencePorts,
): ProjectAssetReferenceResolver {
  return {
    async resolve(target) {
      const entry = await ports.readAsset(target);
      if (!entry) return { ok: false, reason: "missing" };
      if (entry.lifecycle.state !== "active")
        return { ok: false, reason: "trashed" };
      const resource = await ports.readCommittedResource(target, entry);
      if (!resource) return { ok: false, reason: "uncommitted" };
      const signed = await ports.sign({ target, entry, resource });
      const { width, height } = entry.metadata;
      return {
        ok: true,
        reference: {
          assetId: entry.id,
          kind: entry.kind,
          url: signed.url,
          expiresAt: signed.expiresAt,
          ...(resource.contentType ? { contentType: resource.contentType } : {}),
          ...(width ? { width } : {}),
          ...(height ? { height } : {}),
        },
      };
    },
  };
}

const REASON: Record<ProjectAssetReferenceUnavailableReason, string> = {
  missing: "it does not exist in this Project",
  trashed: "it is in the trash",
  uncommitted: "its media has not been committed",
};

/**
 * The non-retryable failure for an unresolvable reference. `subject` names
 * where it was referenced (slot and index, or Timeline track and item); the
 * request never left the Host, so it is `rejected`.
 */
export function referenceUnavailableFailure(
  subject: string,
  assetId: string,
  reason: ProjectAssetReferenceUnavailableReason,
): ProviderExecutionError {
  return new ProviderExecutionError({
    code: "reference_unavailable",
    message: `${subject} references Asset ${assetId}, which is unavailable: ${REASON[reason]}.`,
    retryable: false,
    requestState: "rejected",
  });
}

const TIMELINE_MEDIA_TYPES = new Set(["image", "video", "audio", "sticker"]);

type TimelineItem = Record<string, unknown>;

export interface TimelineMediaReferenceOptions {
  projectId: string;
  references: ProjectAssetReferenceResolver;
  /** The Project Asset a media item names; adapters map legacy node references here. */
  assetIdOf(item: TimelineItem): string | undefined;
  /** The item's media type; defaults to `item.type` (legacy items take it from their node). */
  typeOf?(item: TimelineItem): unknown;
  /** Adapter-owned fields for a resolved item (natural size, node type); `src` always wins. */
  decorate?(
    item: TimelineItem,
    reference: ResolvedProjectAssetReference,
  ): TimelineItem;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Give every Timeline media item the signed `src` of its Project Asset, for a
 * server renderer that has no Project access. A media item whose Asset cannot
 * be resolved fails the render with `reference_unavailable`; one with neither
 * an Asset nor an absolute `src` fails with `invalid_request`. A render never
 * proceeds with a clip "without src".
 */
export async function resolveTimelineMediaReferences(
  timelineDsl: Record<string, unknown>,
  options: TimelineMediaReferenceOptions,
): Promise<Record<string, unknown>> {
  const tracks = Array.isArray(timelineDsl.tracks) ? timelineDsl.tracks : [];
  const missing: string[] = [];
  const resolvedTracks: unknown[] = [];
  for (const track of tracks) {
    if (!isRecord(track) || !Array.isArray(track.items)) {
      resolvedTracks.push(track);
      continue;
    }
    const items: unknown[] = [];
    for (const item of track.items) {
      if (
        !isRecord(item) ||
        !TIMELINE_MEDIA_TYPES.has(String(options.typeOf?.(item) ?? item.type))
      ) {
        items.push(item);
        continue;
      }
      const where = `${String(track.id ?? "track")}:${String(item.id ?? "item")}`;
      const assetId = options.assetIdOf(item);
      if (!assetId) {
        if (typeof item.src !== "string" || !/^(https?:|data:)/u.test(item.src))
          missing.push(where);
        items.push(item);
        continue;
      }
      const resolved = await options.references.resolve({
        projectId: options.projectId,
        assetId,
      });
      if (!resolved.ok)
        throw referenceUnavailableFailure(
          `Timeline item ${where}`,
          assetId,
          resolved.reason,
        );
      items.push({
        ...item,
        ...options.decorate?.(item, resolved.reference),
        src: resolved.reference.url,
      });
    }
    resolvedTracks.push({ ...track, items });
  }
  if (missing.length)
    throw new ProviderExecutionError({
      code: "invalid_request",
      message: `Timeline render has media item(s) without an Asset reference: ${missing.slice(0, 5).join(", ")}.`,
      retryable: false,
      requestState: "rejected",
    });
  return { ...timelineDsl, tracks: resolvedTracks };
}
