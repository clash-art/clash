import {
  PROJECT_CLOUD_CONTENT_PART_BYTES,
  assertContentTransferSize,
  readBoundedContent,
  readContentTransferLimitError,
  type ContentTransferLimits,
} from "./content-transfer.js";

/** Host-private random access; no file path or storage locator crosses HTTP. */
export interface CloudContentUploadSource {
  byteLength: number;
  readPart(offset: number, length: number): Promise<Uint8Array>;
}

export interface CloudContentUploadOptions extends ContentTransferLimits {
  url: string;
  source: CloudContentUploadSource;
  headers?: ConstructorParameters<typeof Headers>[0];
  fetch?: typeof globalThis.fetch;
}

/** The owner retries the immutable object on failure. Only completion publishes
 * it; parts and their receipts remain transport-private staging state. */
export async function uploadCloudContent(
  options: CloudContentUploadOptions,
): Promise<void> {
  assertContentTransferSize(options.source.byteLength, options.maxBytes);
  const uploadId = crypto.randomUUID();
  const fetcher = options.fetch ?? globalThis.fetch;
  const request = async (
    action: string,
    bytes?: Uint8Array,
    partNumber?: number,
  ) => {
    const url = new URL(options.url);
    url.searchParams.set("upload", action);
    url.searchParams.set("uploadId", uploadId);
    if (partNumber !== undefined)
      url.searchParams.set("partNumber", String(partNumber));
    else url.searchParams.delete("partNumber");
    const headers = new Headers(options.headers);
    headers.delete("content-length");
    return fetcher(url.href, {
      method: "PUT",
      headers,
      ...(bytes ? { body: Uint8Array.from(bytes) } : {}),
    });
  };
  const assertSuccess = async (response: Response) => {
    if (response.ok) return;
    const limit = await readContentTransferLimitError(response);
    if (limit) throw limit;
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Project multipart transfer failed (${response.status}); retry is safe.`,
    );
  };
  try {
    const begin = await request("begin");
    await assertSuccess(begin);
    const response: unknown = JSON.parse(
      new TextDecoder().decode(
        await readBoundedContent(begin.body, { maxBytes: 4096 }),
      ),
    );
    if (
      !response ||
      typeof response !== "object" ||
      !("uploadId" in response) ||
      response.uploadId !== uploadId ||
      !("partSize" in response) ||
      response.partSize !== PROJECT_CLOUD_CONTENT_PART_BYTES
    ) {
      throw new Error("Unsupported Project multipart transfer protocol");
    }
    let partNumber = 1;
    for (let offset = 0; offset < options.source.byteLength; partNumber += 1) {
      const length = Math.min(
        PROJECT_CLOUD_CONTENT_PART_BYTES,
        options.source.byteLength - offset,
      );
      const bytes = await options.source.readPart(offset, length);
      if (bytes.byteLength !== length)
        throw new Error("Local cloud content changed during transfer");
      const part = await request("part", bytes, partNumber);
      await assertSuccess(part);
      await part.body?.cancel();
      offset += length;
    }
    const complete = await request("complete");
    await assertSuccess(complete);
    await complete.body?.cancel();
  } catch (error) {
    // Shutdown/revocation can prevent this best-effort cleanup. Server-side
    // expiry owns abandoned sessions, while canonical objects remain immutable.
    await request("abort")
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
    throw error;
  }
}
