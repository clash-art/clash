import { isAbsolute } from "node:path";

import { codedError } from "./desktop-ipc";
import {
  copyFileToTarget,
  downloadUrlToFile,
  type TransferOptions,
} from "./file-transfer";

export type DesktopDirectorVideoExportRequest = {
  stageName: string;
  cameraName: string;
  sourceUrl: string;
};

export const DIRECTOR_VIDEO_EXPORT_TIMEOUT_MS = 10 * 60 * 1000;
const LOCAL_FILE_TIMEOUT_MS = 30_000;

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
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return undefined;
  }
  if (localFileOrigin) {
    let origin: string;
    try {
      origin = new URL(localFileOrigin).origin;
    } catch {
      return undefined;
    }
    if (url.origin !== origin) return undefined;
  }
  const hostname = url.hostname;
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (!loopback || !url.pathname.endsWith("/media")) return undefined;
  url.pathname = `${url.pathname.slice(0, -"/media".length)}/local-file`;
  url.search = "";
  url.hash = "";
  return url.href;
}

async function localVideoPath(
  sourceUrl: string,
  options: DirectorVideoExportOptions,
): Promise<string | undefined> {
  const localFileUrl = directorVideoLocalFileUrl(
    sourceUrl,
    options.localFileOrigin,
  );
  if (!localFileUrl) return undefined;
  const timeoutMs = Math.min(
    options.timeoutMs ?? LOCAL_FILE_TIMEOUT_MS,
    LOCAL_FILE_TIMEOUT_MS,
  );
  try {
    const response = await (options.fetchImpl ?? fetch)(localFileUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const value = (await response.json()) as { path?: unknown };
    return typeof value.path === "string" &&
      value.path.length > 0 &&
      isAbsolute(value.path)
      ? value.path
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copies the already-published camera video from the local Host to the save
 * target. The renderer never sends video bytes over IPC. When the Host does not
 * expose a local file (for example a remote Host), the response is streamed to
 * a temp file instead, and the target only appears after success.
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
  const localPath = await localVideoPath(sourceUrl, transferOptions);
  if (localPath) {
    const bytes = await copyFileToTarget(
      localPath,
      input.targetPath,
      transferOptions,
    );
    return { outputPath: input.targetPath, bytes };
  }
  const bytes = await downloadUrlToFile(
    sourceUrl,
    input.targetPath,
    transferOptions,
  );
  return { outputPath: input.targetPath, bytes };
}
