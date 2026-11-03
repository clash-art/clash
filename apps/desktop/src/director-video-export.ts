import { codedError } from "./desktop-ipc";
import {
  copyFileToTarget,
  downloadUrlToFile,
  hostLocalFileUrl,
  resolveHostLocalFile,
  type TransferOptions,
} from "./file-transfer";

export type DesktopDirectorVideoExportRequest = {
  stageName: string;
  cameraName: string;
  sourceUrl: string;
};

export const DIRECTOR_VIDEO_EXPORT_TIMEOUT_MS = 10 * 60 * 1000;

function safePart(value: string): string {
  return value.trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export function safeDirectorVideoExportName(stageName: string, cameraName: string): string {
  const stem = [safePart(stageName), safePart(cameraName)].filter(Boolean).join("-");
  return `${stem || "director-camera"}.webm`;
}

export function directorVideoSourceUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw codedError(
      "DIRECTOR_VIDEO_EXPORT_SOURCE_INVALID",
      "Director video export requires the published camera video URL.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw codedError(
      "DIRECTOR_VIDEO_EXPORT_SOURCE_INVALID",
      "Director video export source is not a valid URL.",
      error,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw codedError(
      "DIRECTOR_VIDEO_EXPORT_SOURCE_INVALID",
      "Director video export source must be an HTTP(S) URL.",
    );
  }
  return url.href;
}

export type DirectorVideoExportOptions = TransferOptions & {
  /** Only this Host origin may expose the local-file projection. */
  localFileOrigin?: string;
};

/**
 * The Host exposes a loopback-only `local-file` projection next to each Asset
 * `media` URL. Resolving it lets the main process copy the already-published
 * file inside the kernel instead of pulling half a gigabyte through Node.
 */
export function directorVideoLocalFileUrl(
  sourceUrl: string,
  localFileOrigin?: string,
): string | undefined {
  return hostLocalFileUrl(sourceUrl, localFileOrigin);
}

/**
 * Copies the already-published camera video from the local Host's store to
 * the save target. The renderer never sends video bytes over IPC. A local Host
 * that cannot name its file fails with a coded error instead of serving the
 * same bytes over loopback. Only a remote Host (whose bytes are not on this
 * machine) streams the response to a temp file; the target only appears after
 * success either way.
 */
export async function exportDirectorVideoToFile(
  input: { targetPath: string; sourceUrl: string },
  options: DirectorVideoExportOptions = {},
): Promise<{ outputPath: string; bytes: number }> {
  const sourceUrl = directorVideoSourceUrl(input.sourceUrl);
  const transferOptions: DirectorVideoExportOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? DIRECTOR_VIDEO_EXPORT_TIMEOUT_MS,
    code: "DIRECTOR_VIDEO_EXPORT_DOWNLOAD_FAILED",
    commitCode: "DIRECTOR_VIDEO_EXPORT_COMMIT_FAILED",
    label: "Director camera video",
  };
  const localFileUrl = directorVideoLocalFileUrl(
    sourceUrl,
    options.localFileOrigin,
  );
  if (localFileUrl) {
    const localPath = await resolveHostLocalFile(localFileUrl, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
      notLocalCode: "DIRECTOR_VIDEO_EXPORT_SOURCE_NOT_LOCAL",
      failedCode: "DIRECTOR_VIDEO_EXPORT_LOCAL_FILE_FAILED",
      label: "Director camera video",
    });
    const bytes = await copyFileToTarget(localPath, input.targetPath, {
      ...transferOptions,
      code: "DIRECTOR_VIDEO_EXPORT_LOCAL_FILE_FAILED",
    });
    return { outputPath: input.targetPath, bytes };
  }
  const bytes = await downloadUrlToFile(
    sourceUrl,
    input.targetPath,
    transferOptions,
  );
  return { outputPath: input.targetPath, bytes };
}
