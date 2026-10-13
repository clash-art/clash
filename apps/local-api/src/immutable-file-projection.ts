import { open } from "node:fs/promises";
import { Readable } from "node:stream";

type AssetByteRange = { start: number; end: number } | null | "unsatisfiable";

export function parseAssetByteRange(
  rangeHeader: string | undefined,
  size: number,
): AssetByteRange {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) {
    return "unsatisfiable";
  }

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return "unsatisfiable";
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "unsatisfiable";
  }

  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}

/**
 * Serves one immutable Resource file. The body is always a bounded-memory
 * stream over the requested byte window: a browser `<video>` opens with
 * `bytes=0-`, so neither that open range nor a plain GET may buffer the file.
 */
export async function serveImmutableFileProjection(options: {
  path: string;
  contentType: string;
  expectedByteLength?: number;
  rangeHeader?: string;
}): Promise<Response> {
  const handle = await open(options.path, "r");
  let streaming = false;
  try {
    // Size and bytes come from the same descriptor, so the declared
    // Content-Length cannot describe a different file than the one streamed.
    const fileInfo = await handle.stat();
    if (
      !fileInfo.isFile() ||
      (options.expectedByteLength !== undefined &&
        fileInfo.size !== options.expectedByteLength)
    ) {
      throw new Error(
        "Immutable Asset projection no longer matches its Resource facts.",
      );
    }
    const range = parseAssetByteRange(options.rangeHeader, fileInfo.size);
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes */${fileInfo.size}`,
        },
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? fileInfo.size - 1;
    const length = end - start + 1;
    const headers = {
      "accept-ranges": "bytes",
      "content-type": options.contentType,
      "content-length": String(length),
      ...(range
        ? { "content-range": `bytes ${start}-${end}/${fileInfo.size}` }
        : {}),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    };
    if (length <= 0) return new Response(null, { headers });
    // The stream owns the descriptor from here and closes it on end, error,
    // or client cancellation.
    const body = Readable.toWeb(
      handle.createReadStream({ start, end }),
    ) as ReadableStream<Uint8Array>;
    streaming = true;
    return new Response(body, { status: range ? 206 : 200, headers });
  } finally {
    if (!streaming) await handle.close();
  }
}
