/** Bytes handed to the transport so far, out of the file's declared size. */
export interface AssetImportProgress {
  loadedBytes: number;
  totalBytes: number;
}

export type AssetImportProgressListener = (
  progress: AssetImportProgress,
) => void;

/**
 * Builds the streaming `import-file` request: the body is the file itself and
 * the command fields travel in the query, so no client holds a second copy of
 * the bytes. A Blob body is read from its backing store by the runtime as it
 * is sent, and stays replayable for a retrying `fetch`.
 *
 * `onProgress` needs to observe the bytes, so it sends the Blob's stream
 * instead (`duplex: "half"`). Node supports that on any connection; browsers
 * only over HTTP/2, so browser callers of a local Host leave it unset.
 */
export function assetImportRequest(input: {
  url: string;
  file: Blob;
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
  if (!onProgress) {
    return { url, init: { method: "POST", headers, body: input.file } };
  }
  const totalBytes = input.file.size;
  let loadedBytes = 0;
  const body = input.file.stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loadedBytes += chunk.byteLength;
        controller.enqueue(chunk);
        onProgress({ loadedBytes, totalBytes });
      },
    }),
  );
  return {
    url,
    init: { method: "POST", headers, body, duplex: "half" } as RequestInit,
  };
}
