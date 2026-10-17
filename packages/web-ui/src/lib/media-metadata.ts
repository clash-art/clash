/**
 * Browser-side media hints for a Project Asset import.
 *
 * The hosted Worker cannot decode the file, so the editor observes the few
 * facts a media element exposes and sends them as optional hints. Failure,
 * timeout, or an unsupported environment simply means "no hints": an import
 * must never depend on probing succeeding.
 */
import type { AssetImportMetadataHints } from "@clash/asset-sdk";
import type { AssetKind } from "@clash/shared-types";

const PROBE_TIMEOUT_MS = 1_500;

function mediaHints(element: HTMLMediaElement): AssetImportMetadataHints {
  const durationMs =
    Number.isFinite(element.duration) && element.duration >= 0
      ? Math.round(element.duration * 1000)
      : undefined;
  const video = element as HTMLVideoElement & {
    videoWidth?: number;
    videoHeight?: number;
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
    audioTracks?: { length: number };
  };
  const width =
    typeof video.videoWidth === "number" && video.videoWidth > 0
      ? video.videoWidth
      : undefined;
  const height =
    typeof video.videoHeight === "number" && video.videoHeight > 0
      ? video.videoHeight
      : undefined;
  let hasAudio: boolean | undefined;
  if (typeof video.mozHasAudio === "boolean") hasAudio = video.mozHasAudio;
  else if (typeof video.webkitAudioDecodedByteCount === "number")
    hasAudio =
      video.webkitAudioDecodedByteCount > 0 ? true : undefined;
  else if (video.audioTracks)
    hasAudio = video.audioTracks.length > 0 ? true : undefined;
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(hasAudio === undefined ? {} : { hasAudio }),
  };
}

function withTimeout(
  run: (finish: (hints: AssetImportMetadataHints) => void) => void,
): Promise<AssetImportMetadataHints> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (hints: AssetImportMetadataHints) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(hints);
    };
    const timer = setTimeout(() => finish({}), PROBE_TIMEOUT_MS);
    try {
      run(finish);
    } catch {
      finish({});
    }
  });
}

async function probeMedia(
  url: string,
  kind: "video" | "audio",
): Promise<AssetImportMetadataHints> {
  return withTimeout((finish) => {
    const element = document.createElement(kind);
    element.preload = "metadata";
    element.addEventListener("loadedmetadata", () => finish(mediaHints(element)), {
      once: true,
    });
    element.addEventListener("error", () => finish({}), { once: true });
    element.src = url;
  });
}

async function probeImage(file: File): Promise<AssetImportMetadataHints> {
  // Decoding without a DOM element; a browser that cannot decode yields no hints.
  if (typeof createImageBitmap !== "function") return {};
  return withTimeout((finish) => {
    createImageBitmap(file).then(
      (bitmap) => {
        const hints = {
          ...(bitmap.width > 0 ? { width: bitmap.width } : {}),
          ...(bitmap.height > 0 ? { height: bitmap.height } : {}),
        };
        bitmap.close();
        finish(hints);
      },
      () => finish({}),
    );
  });
}

/** Only a type the browser says it can play will ever report metadata. */
function canPlay(kind: "video" | "audio", type: string): boolean {
  if (!type) return false;
  try {
    return document.createElement(kind).canPlayType(type) !== "";
  } catch {
    return false;
  }
}

/**
 * Best-effort `durationMs/width/height/hasAudio` for one selected file. Always
 * resolves; callers pass the result straight to `importFile`.
 */
export async function probeProjectAssetMetadata(
  file: File,
  kind: AssetKind,
): Promise<AssetImportMetadataHints> {
  const known: AssetImportMetadataHints = kind === "audio" ? { hasAudio: true } : {};
  try {
    if (kind === "image") return await probeImage(file);
    if (kind !== "video" && kind !== "audio") return known;
    if (
      typeof document === "undefined" ||
      typeof URL.createObjectURL !== "function" ||
      !canPlay(kind, file.type)
    )
      return known;
    const url = URL.createObjectURL(file);
    try {
      return { ...(await probeMedia(url, kind)), ...known };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return known;
  }
}
