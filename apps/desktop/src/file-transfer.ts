import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, rename, rm, stat } from "node:fs/promises";
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
