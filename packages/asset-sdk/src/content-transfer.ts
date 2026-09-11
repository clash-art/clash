/** Product policy for Project cloud object transfers. Local publication
 * has no corresponding restriction. Adapters/tests may choose a smaller cap. */
export const PROJECT_CLOUD_CONTENT_MAX_BYTES = 512 * 1024 * 1024;

/** Keep individual cloud requests and buffered parts below Worker limits. */
export const PROJECT_CLOUD_CONTENT_PART_BYTES = 8 * 1024 * 1024;

export interface ContentTransferLimits {
  maxBytes?: number;
}

export class ContentTransferLimitError extends Error {
  readonly code = "CLOUD_CONTENT_TOO_LARGE";
  constructor(readonly maxBytes = PROJECT_CLOUD_CONTENT_MAX_BYTES) {
    super(
      `Cloud content exceeds the transfer limit (maxBytes=${maxBytes}). Local assets remain available.`,
    );
    this.name = "ContentTransferLimitError";
  }
}

export function contentTransferMaxBytes(
  maxBytes = PROJECT_CLOUD_CONTENT_MAX_BYTES,
): number {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > PROJECT_CLOUD_CONTENT_MAX_BYTES
  ) {
    throw new RangeError(
      `Cloud content maxBytes must be between 1 and ${PROJECT_CLOUD_CONTENT_MAX_BYTES}`,
    );
  }
  return maxBytes;
}

export function assertContentTransferSize(
  byteLength: number,
  configuredMaxBytes?: number,
): void {
  const maxBytes = contentTransferMaxBytes(configuredMaxBytes);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0)
    throw new Error("Invalid content byte length");
  if (byteLength > maxBytes) throw new ContentTransferLimitError(maxBytes);
}

/** Bounds actual received bytes; a caller-supplied length is never sufficient.
 * The reader cancels on overflow before retaining/concatenating that chunk. */
export async function readBoundedContent(
  body: ReadableStream<Uint8Array> | null,
  options: ContentTransferLimits = {},
): Promise<Uint8Array> {
  const maxBytes = contentTransferMaxBytes(options.maxBytes);
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      assertContentTransferSize(size + next.value.byteLength, maxBytes);
      size += next.value.byteLength;
      chunks.push(next.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Read only the small structured error envelope, never an unbounded error
 * document. Unknown/nonconforming errors retain their HTTP status upstream. */
export async function readContentTransferLimitError(
  response: Response,
): Promise<ContentTransferLimitError | null> {
  if (response.status !== 413) return null;
  try {
    const bytes = await readBoundedContent(response.body, {
      maxBytes: 8 * 1024,
    });
    const value = JSON.parse(new TextDecoder().decode(bytes)) as {
      code?: unknown;
      maxBytes?: unknown;
    };
    if (
      value.code !== "CLOUD_CONTENT_TOO_LARGE" ||
      typeof value.maxBytes !== "number"
    )
      return null;
    return new ContentTransferLimitError(
      contentTransferMaxBytes(value.maxBytes),
    );
  } catch {
    return null;
  }
}
