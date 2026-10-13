export type ProjectTimelinePersistenceResult =
  { ok: true; state: unknown } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function storageFreeMediaRecord(
  input: Record<string, unknown>,
  label: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const source = nonEmptyString(input.src);
  const projectAssetId = nonEmptyString(input.assetId);
  const itemType = nonEmptyString(input.type);
  const requiresProjectAsset =
    itemType === "video" ||
    itemType === "audio" ||
    itemType === "image" ||
    itemType === "sticker";
  if (Object.prototype.hasOwnProperty.call(input, "backingAssetId")) {
    return {
      ok: false,
      error: `${label} contains the removed backingAssetId field; use assetId`,
    };
  }
  if (!projectAssetId && source) {
    return {
      ok: false,
      error: `${label} must reference a Project Asset before it can be persisted`,
    };
  }
  if (requiresProjectAsset && !projectAssetId) {
    return {
      ok: false,
      error: `${label} must reference a Project Asset before it can be persisted`,
    };
  }
  if (!projectAssetId && !source) {
    return { ok: true, value: { ...input } };
  }
  if (!projectAssetId) return { ok: true, value: { ...input } };

  const {
    src: _src,
    previewUrl: _previewUrl,
    thumbnailUrl: _thumbnailUrl,
    waveformUrl: _waveformUrl,
    proxyUrl: _proxyUrl,
    url: _url,
    localPath: _localPath,
    storageKey: _storageKey,
    srcR2Key: _srcR2Key,
    waveform: _legacyWaveform,
    ...persisted
  } = input;
  return { ok: true, value: { ...persisted, assetId: projectAssetId } };
}

/**
 * Converts runtime Timeline state into the Project-Loro persistence shape.
 * Runtime editors/renderers may carry replaceable Host projections in `src`,
 * but synchronized state carries only Project Asset identity.
 */
export function normalizeProjectTimelinePersistenceState(
  input: unknown,
): ProjectTimelinePersistenceResult {
  if (!isRecord(input)) return { ok: true, state: input };
  if (Object.prototype.hasOwnProperty.call(input, "mediaAssetRefs")) {
    return {
      ok: false,
      error:
        "Timeline state contains the removed mediaAssetRefs collection; use item assetId bindings",
    };
  }
  const tracks = Array.isArray(input.tracks) ? input.tracks : undefined;
  if (!tracks) return { ok: true, state: structuredClone(input) };

  const nextTracks: unknown[] = [];
  for (const track of tracks) {
    if (!isRecord(track) || !Array.isArray(track.items)) {
      nextTracks.push(structuredClone(track));
      continue;
    }
    const items: unknown[] = [];
    for (const candidate of track.items) {
      if (!isRecord(candidate)) {
        items.push(structuredClone(candidate));
        continue;
      }
      const itemId = nonEmptyString(candidate.id) ?? "<unknown>";
      const normalized = storageFreeMediaRecord(
        candidate,
        `Timeline item ${itemId}`,
      );
      if (!normalized.ok) return normalized;
      items.push(normalized.value);
    }
    nextTracks.push({ ...structuredClone(track), items });
  }

  const cloned = structuredClone(input);
  const { assets: _assets, ...root } = cloned;
  const next: Record<string, unknown> = {
    ...root,
    tracks: nextTracks,
  };
  return { ok: true, state: next };
}
