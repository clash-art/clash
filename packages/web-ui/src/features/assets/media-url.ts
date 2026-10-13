import type { ResolvedAsset } from "@clash/shared-types";

/** Canonical resolver for every asset preview, thumbnail, and media player. */
export function resolveAssetMediaUrl(value?: string | null): string | null {
  const source = value?.trim();
  if (!source) return null;
  if (source.startsWith("/projects/")) return null;
  if (source.startsWith("/")) return source;
  return /^(?:https?:|blob:|data:|file:)/i.test(source) ? source : null;
}

export function firstAssetMediaUrl(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const resolved = resolveAssetMediaUrl(value);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * The Host owns URL projection. UI consumers never reconstruct object-store
 * paths or sign storage keys.
 */
export function projectAssetPlaybackUrl(asset: ResolvedAsset): string | null {
  return resolveAssetMediaUrl(asset.url);
}

/**
 * Source for preview and editing playback: the Host's lighter proxy when one
 * exists, the original otherwise. It is a runtime projection only; anything
 * rendered, exported, or sent to a provider resolves the Asset itself.
 */
export function projectAssetPreviewPlaybackUrl(
  asset: ResolvedAsset,
): string | null {
  return firstAssetMediaUrl(
    asset.kind === "video" ? asset.proxyUrl : undefined,
    asset.url,
  );
}

/**
 * Returns a still-image projection suitable for compact chips and mentions.
 * A video playback URL is deliberately not treated as an image thumbnail.
 */
export function assetThumbnailImageUrl(
  asset: Pick<ResolvedAsset, "kind" | "url" | "thumbnailUrl">,
): string | null {
  const thumbnail = resolveAssetMediaUrl(asset.thumbnailUrl);
  if (thumbnail) return thumbnail;
  return asset.kind === "image" ? resolveAssetMediaUrl(asset.url) : null;
}

export type AssetPreviewMedia = {
  kind: "image" | "video";
  source: string;
};

/**
 * Adapts the canonical Host-resolved view to the small preview contract.
 */
export function assetPreviewMedia(
  asset: ResolvedAsset,
): AssetPreviewMedia | null {
  const source = resolveAssetMediaUrl(asset.url);
  const thumbnail = assetThumbnailImageUrl(asset);
  if (asset.kind === "image") {
    const preview = thumbnail ?? source;
    return preview ? { kind: "image", source: preview } : null;
  }
  if (asset.kind !== "video") return null;
  if (thumbnail) return { kind: "image", source: thumbnail };
  return source ? { kind: "video", source } : null;
}
