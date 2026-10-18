import { open, type FileHandle } from "node:fs/promises";

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
 *
 * The response holds no file descriptor until the body is first read. A
 * client that disconnects before the response is written (a `<video>` seek,
 * leaving a project while media loads) never reads or cancels the body, and a
 * descriptor opened eagerly stayed open until garbage collection
 * ("Closing file descriptor N on garbage collection", DEP0137).
 */
export async function serveImmutableFileProjection(options: {
  path: string;
  contentType: string;
  expectedByteLength?: number;
  rangeHeader?: string;
}): Promise<Response> {
  const fileInfo = await statImmutableFile(options.path);
  if (
    options.expectedByteLength !== undefined &&
    fileInfo.size !== options.expectedByteLength
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
  return new Response(
    lazyFileRangeStream(options.path, fileInfo, start, end),
    { status: range ? 206 : 200, headers },
  );
}

const STREAM_CHUNK_BYTES = 256 * 1024;

type ImmutableFileFacts = { dev: number; ino: number; size: number };

async function statImmutableFile(path: string): Promise<ImmutableFileFacts> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(
        "Immutable Asset projection no longer matches its Resource facts.",
      );
    }
    return { dev: info.dev, ino: info.ino, size: info.size };
  } finally {
    await handle.close();
  }
}

/**
 * Streams bytes [start, end] of the file. The descriptor is opened on the
 * first read and closed on end, error, or cancel. The reopened file must be
 * the same file (device, inode, size) the response headers describe.
 */
function lazyFileRangeStream(
  path: string,
  facts: ImmutableFileFacts,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  let handle: FileHandle | undefined;
  let position = start;
  const release = async () => {
    const current = handle;
    handle = undefined;
    await current?.close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (!handle) {
            handle = await open(path, "r");
            const info = await handle.stat();
            if (
              info.dev !== facts.dev ||
              info.ino !== facts.ino ||
              info.size !== facts.size
            ) {
              throw new Error(
                "Immutable Asset projection changed while it was being served.",
              );
            }
          }
          const want = Math.min(STREAM_CHUNK_BYTES, end - position + 1);
          const buffer = new Uint8Array(want);
          const { bytesRead } = await handle.read(buffer, 0, want, position);
          if (bytesRead === 0) {
            throw new Error(
              "Immutable Asset projection ended before its declared length.",
            );
          }
          position += bytesRead;
          controller.enqueue(
            bytesRead === want ? buffer : buffer.subarray(0, bytesRead),
          );
          if (position > end) {
            await release();
            controller.close();
          }
        } catch (error) {
          await release();
          controller.error(error);
        }
      },
      async cancel() {
        await release();
      },
    },
    // No eager pull: nothing is opened until the server reads the body.
    { highWaterMark: 0 },
  );
}
