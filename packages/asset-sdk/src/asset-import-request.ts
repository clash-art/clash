/** Bytes handed to the transport so far, out of the file's declared size. */
export interface AssetImportProgress {
  loadedBytes: number;
  totalBytes: number;
}

export type AssetImportProgressListener = (
  progress: AssetImportProgress,
) => void;

/**
 * The bytes of one import: a browser `File`/`Blob`, or any source that knows
 * its exact length and can open a fresh stream per attempt. `size` is sent as
 * the declared `byteLength`, so it must be the true byte count. Node callers
 * must not pass `fs.openAsBlob`'s Blob: it reports `size` modulo 2^32 for a
 * file of 4 GiB or more while still streaming every byte.
 */
export interface AssetImportFile {
  readonly size: number;
  readonly type: string;
  stream(): ReadableStream<Uint8Array>;
}

/**
 * Product cap for a single `import-file` request body. Larger files go through
 * the signed import-session / multipart upload path instead. It is exported so
 * every adapter and client agrees on where the switch happens.
 */
export const PROJECT_ASSET_SINGLE_SHOT_MAX_BYTES = 64 * 1024 * 1024;

/** Largest Project Asset any Host imports, whichever path carries the bytes. */
export const PROJECT_ASSET_IMPORT_MAX_BYTES = 512 * 1024 * 1024;

/** Media facts the browser can observe before the Worker/Node Host can probe. */
export interface AssetImportMetadataHints {
  durationMs?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  hasAudio?: boolean;
}

/** Sane bounds for untrusted browser hints; anything outside is ignored. */
export const ASSET_IMPORT_METADATA_HINT_LIMITS = {
  durationMs: 24 * 60 * 60 * 1000,
  width: 16_384,
  height: 16_384,
  frameRate: 240,
} as const;

function nonNegativeInteger(
  value: unknown,
  maximum: number,
): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum
    ? parsed
    : undefined;
}

function positiveNumber(value: unknown, maximum: number): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : undefined;
}

function booleanHint(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

/**
 * Keep only the media hints a server may trust enough to display. Invalid or
 * out-of-range fields are dropped, never rejected, so an old client or a
 * browser that cannot probe still imports.
 */
export function sanitizeAssetImportMetadataHints(
  value: unknown,
): AssetImportMetadataHints {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const hints: AssetImportMetadataHints = {};
  const durationMs = nonNegativeInteger(
    record.durationMs,
    ASSET_IMPORT_METADATA_HINT_LIMITS.durationMs,
  );
  if (durationMs !== undefined) hints.durationMs = durationMs;
  const width = nonNegativeInteger(
    record.width,
    ASSET_IMPORT_METADATA_HINT_LIMITS.width,
  );
  if (width !== undefined) hints.width = width;
  const height = nonNegativeInteger(
    record.height,
    ASSET_IMPORT_METADATA_HINT_LIMITS.height,
  );
  if (height !== undefined) hints.height = height;
  const frameRate = positiveNumber(
    record.frameRate,
    ASSET_IMPORT_METADATA_HINT_LIMITS.frameRate,
  );
  if (frameRate !== undefined) hints.frameRate = frameRate;
  const hasAudio = booleanHint(record.hasAudio);
  if (hasAudio !== undefined) hints.hasAudio = hasAudio;
  return hints;
}

/** Flatten valid hints into the `import-file` query fields. */
export function assetImportMetadataHintFields(
  hints: AssetImportMetadataHints | undefined,
): Record<string, string> {
  const value = sanitizeAssetImportMetadataHints(hints);
  return {
    ...(value.durationMs === undefined
      ? {}
      : { durationMs: String(value.durationMs) }),
    ...(value.width === undefined ? {} : { width: String(value.width) }),
    ...(value.height === undefined ? {} : { height: String(value.height) }),
    ...(value.frameRate === undefined
      ? {}
      : { frameRate: String(value.frameRate) }),
    ...(value.hasAudio === undefined
      ? {}
      : { hasAudio: String(value.hasAudio) }),
  };
}

/**
 * Builds the streaming `import-file` request: the body is the file itself and
 * the command fields travel in the query, so no client holds a second copy of
 * the bytes. A Blob body is read from its backing store by the runtime as it
 * is sent, and stays replayable for a retrying `fetch`.
 *
 * A source that is not a Blob is sent as its stream (`duplex: "half"`), and so
 * is a Blob when `onProgress` needs to observe the bytes. Node supports that
 * on any connection; browsers only over HTTP/2, so browser callers of a local
 * Host pass a Blob and leave `onProgress` unset.
 */
export function assetImportRequest(input: {
  url: string;
  file: AssetImportFile;
  fileName: string;
  fields: Record<string, string>;
  headers: Record<string, string>;
  metadataHints?: AssetImportMetadataHints;
  onProgress?: AssetImportProgressListener;
}): { url: string; init: RequestInit } {
  const query = new URLSearchParams({
    ...input.fields,
    ...assetImportMetadataHintFields(input.metadataHints),
    fileName: input.fileName,
    byteLength: String(input.file.size),
  });
  const headers = {
    ...input.headers,
    "content-type": input.file.type || "application/octet-stream",
  };
  const url = `${input.url}?${query.toString()}`;
  const onProgress = input.onProgress;
  if (!onProgress && input.file instanceof Blob) {
    return { url, init: { method: "POST", headers, body: input.file } };
  }
  const totalBytes = input.file.size;
  let loadedBytes = 0;
  const body = onProgress
    ? input.file.stream().pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            loadedBytes += chunk.byteLength;
            controller.enqueue(chunk);
            onProgress({ loadedBytes, totalBytes });
          },
        }),
      )
    : input.file.stream();
  return {
    url,
    init: { method: "POST", headers, body, duplex: "half" } as RequestInit,
  };
}
