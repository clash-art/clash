import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { codedError } from "./desktop-ipc";

export type TransferFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type TransferOptions = {
  timeoutMs?: number;
  fetchImpl?: TransferFetch;
  code?: string;
  commitCode?: string;
  label?: string;
};

const DEFAULT_TRANSFER_TIMEOUT_MS = 30_000;

async function responseBody(
  sourceUrl: string,
  options: TransferOptions,
): Promise<ReadableStream> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
  const code = options.code ?? "FILE_TRANSFER_FAILED";
  const label = options.label ?? "media";
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(sourceUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw codedError(
      code,
      `Could not download ${label} within ${timeoutMs} ms.`,
      error,
    );
  }
  if (!response.ok) {
    throw codedError(
      code,
      `Could not download ${label} (${response.status}).`,
    );
  }
  if (!response.body) {
    throw codedError(
      code,
      `Could not download ${label} (empty response body).`,
    );
  }
  return response.body;
}

async function writeBody(
  body: ReadableStream,
  targetPath: string,
  flags: "wx",
): Promise<number> {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(
      body as unknown as import("node:stream/web").ReadableStream,
    ),
    counter,
    createWriteStream(targetPath, { flags }),
  );
  return bytes;
}

/**
 * Copies an existing local file to the target through a temp path and one
 * rename. The kernel performs the copy, so a large media file never passes
 * through a JavaScript buffer or IPC.
 */
export async function copyFileToTarget(
  sourcePath: string,
  targetPath: string,
  options: TransferOptions = {},
): Promise<number> {
  const code = options.code ?? "FILE_TRANSFER_FAILED";
  const commitCode = options.commitCode ?? code;
  const label = options.label ?? "media";
  const tempPath = `${targetPath}.${randomUUID()}.partial`;
  let bytes: number;
  try {
    await copyFile(sourcePath, tempPath);
    bytes = (await stat(tempPath)).size;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw codedError(code, `Could not read ${label}.`, error);
  }
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw codedError(commitCode, `Could not finalize ${label}.`, error);
  }
  return bytes;
}

/** Streams a response body to a new path. The caller owns cleanup of that path. */
export async function writeUrlToFile(
  sourceUrl: string,
  targetPath: string,
  options: TransferOptions = {},
): Promise<number> {
  const code = options.code ?? "FILE_TRANSFER_FAILED";
  const label = options.label ?? "media";
  const body = await responseBody(sourceUrl, options);
  try {
    return await writeBody(body, targetPath, "wx");
  } catch (error) {
    throw codedError(code, `Could not save ${label}.`, error);
  }
}

/** Streams a URL to a temp file and publishes it with one rename. */
export async function downloadUrlToFile(
  sourceUrl: string,
  targetPath: string,
  options: TransferOptions = {},
): Promise<number> {
  const code = options.code ?? "FILE_TRANSFER_FAILED";
  const commitCode = options.commitCode ?? code;
  const label = options.label ?? "media";
  const body = await responseBody(sourceUrl, options);
  const tempPath = `${targetPath}.${randomUUID()}.partial`;
  let bytes: number;
  try {
    bytes = await writeBody(body, tempPath, "wx");
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw codedError(code, `Could not save ${label}.`, error);
  }
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw codedError(commitCode, `Could not finalize ${label}.`, error);
  }
  return bytes;
}

/**
 * Maps a local Host Asset `media` URL to its loopback-only `local-file`
 * projection. Any other URL (a remote Host, another origin, a non-Asset route)
 * has no store file to resolve and returns `undefined`.
 */
export function hostLocalFileUrl(
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

const LOCAL_FILE_TIMEOUT_MS = 30_000;

/**
 * Resolves the store file behind a local Host Asset. Bytes that are not on
 * this Host yet (still downloading, or never fetched) fail with `notLocalCode`;
 * every other failure fails with `failedCode`. There is no fallback to
 * downloading the same bytes over loopback.
 */
export async function resolveHostLocalFile(
  localFileUrl: string,
  options: {
    fetchImpl?: TransferFetch;
    timeoutMs?: number;
    notLocalCode: string;
    failedCode: string;
    label: string;
  },
): Promise<string> {
  const timeoutMs = Math.min(
    options.timeoutMs ?? LOCAL_FILE_TIMEOUT_MS,
    LOCAL_FILE_TIMEOUT_MS,
  );
  let response: Response;
  let body: { path?: unknown; code?: unknown; error?: unknown } | null;
  try {
    response = await (options.fetchImpl ?? fetch)(localFileUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = (await response.json().catch(() => null)) as typeof body;
  } catch (error) {
    throw codedError(
      options.failedCode,
      `Could not resolve the local file for ${options.label}.`,
      error,
    );
  }
  const hostCode = typeof body?.code === "string" ? body.code : undefined;
  const hostMessage = typeof body?.error === "string" ? ` ${body.error}` : "";
  if (!response.ok) {
    if (hostCode === "LOCAL_RESOURCE_MISSING") {
      throw codedError(
        options.notLocalCode,
        `The ${options.label} is not on this computer yet. Wait for it to finish downloading, then try again.${hostMessage}`,
      );
    }
    throw codedError(
      options.failedCode,
      `Could not resolve the local file for ${options.label} (${hostCode ?? response.status}).${hostMessage}`,
    );
  }
  if (
    typeof body?.path !== "string" ||
    body.path.length === 0 ||
    !isAbsolute(body.path)
  ) {
    throw codedError(
      options.failedCode,
      `The Host returned no local file for ${options.label}.`,
    );
  }
  return body.path;
}
