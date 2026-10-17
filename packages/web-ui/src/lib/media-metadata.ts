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

async function probeImage(url: string): Promise<AssetImportMetadataHints> {
  return withTimeout((finish) => {
    const image = new Image();
    image.addEventListener(
      "load",
      () =>
        finish({
          ...(image.naturalWidth > 0 ? { width: image.naturalWidth } : {}),
          ...(image.naturalHeight > 0
            ? { height: image.naturalHeight }
            : {}),
        }),
      { once: true },
    );
    image.addEventListener("error", () => finish({}), { once: true });
    image.src = url;
  });
}

/**
 * Best-effort `durationMs/width/height/hasAudio` for one selected file. Always
 * resolves; callers pass the result straight to `importFile`.
 */
export async function probeProjectAssetMetadata(
  file: File,
  kind: AssetKind,
): Promise<AssetImportMetadataHints> {
  if (
    typeof document === "undefined" ||
    typeof URL.createObjectURL !== "function"
  )
    return {};
  const url = URL.createObjectURL(file);
  try {
    if (kind === "image") return await probeImage(url);
    if (kind === "video") return await probeMedia(url, "video");
    if (kind === "audio")
      return { ...(await probeMedia(url, "audio")), hasAudio: true };
    return {};
  } catch {
    return {};
  } finally {
    URL.revokeObjectURL(url);
  }
}
