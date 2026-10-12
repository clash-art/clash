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
  onProgress?: AssetImportProgressListener;
}): { url: string; init: RequestInit } {
  const query = new URLSearchParams({
    ...input.fields,
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
