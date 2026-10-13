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

/** Durable owner memory of one immutable object's in-flight upload ID. The
 * cloud session stays the only authority for which parts it holds. */
export interface CloudContentUploadSession {
  load(): Promise<string | undefined>;
  save(uploadId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface CloudContentUploadOptions extends ContentTransferLimits {
  url: string;
  source: CloudContentUploadSource;
  /** Opt in to resuming an interrupted upload instead of restarting at part 1. */
  session?: CloudContentUploadSession;
  headers?: ConstructorParameters<typeof Headers>[0];
  fetch?: typeof globalThis.fetch;
}

/** Statuses where the cloud session can never finish; anything else (network
 * loss, shutdown, expired capability, contention) leaves it resumable. */
const UNRESUMABLE = new Set([400, 410, 413, 501]);

async function partHash(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** The owner retries the immutable object on failure. Only completion publishes
 * it; parts and their receipts remain transport-private staging state. */
export async function uploadCloudContent(
  options: CloudContentUploadOptions,
): Promise<void> {
  assertContentTransferSize(options.source.byteLength, options.maxBytes);
  const resumed = await options.session?.load();
  let uploadId = resumed ?? crypto.randomUUID();
  let unresumable = false;
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
    unresumable = UNRESUMABLE.has(response.status);
    const limit = await readContentTransferLimitError(response);
    if (limit) throw limit;
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Project multipart transfer failed (${response.status}); retry is safe.`,
    );
  };
  try {
    let begin = await request("begin");
    if (resumed && [400, 409, 410].includes(begin.status)) {
      // The remembered session expired or was aborted; start over.
      await begin.body?.cancel().catch(() => undefined);
      uploadId = crypto.randomUUID();
      await options.session?.save(uploadId);
      begin = await request("begin");
    } else if (!resumed) await options.session?.save(uploadId);
    await assertSuccess(begin);
    const response: unknown = JSON.parse(
      new TextDecoder().decode(
        await readBoundedContent(begin.body, { maxBytes: 65536 }),
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
      unresumable = true;
      throw new Error("Unsupported Project multipart transfer protocol");
    }
    const held = new Map<number, unknown>();
    if ("parts" in response && Array.isArray(response.parts))
      for (const part of response.parts as unknown[])
        if (part && typeof part === "object" && "partNumber" in part)
          held.set(
            Number(part.partNumber),
            "sha256" in part ? part.sha256 : undefined,
          );
    let partNumber = 1;
    for (let offset = 0; offset < options.source.byteLength; partNumber += 1) {
      const length = Math.min(
        PROJECT_CLOUD_CONTENT_PART_BYTES,
        options.source.byteLength - offset,
      );
      const bytes = await options.source.readPart(offset, length);
      if (bytes.byteLength !== length)
        throw new Error("Local cloud content changed during transfer");
      offset += length;
      if (held.has(partNumber)) {
        if (held.get(partNumber) === (await partHash(bytes))) continue;
        unresumable = true;
        throw new Error("Cloud upload session holds a conflicting part");
      }
      const part = await request("part", bytes, partNumber);
      await assertSuccess(part);
      await part.body?.cancel();
    }
    const complete = await request("complete");
    await assertSuccess(complete);
    await complete.body?.cancel();
    await options.session?.clear().catch(() => undefined);
  } catch (error) {
    // A resumable owner keeps the cloud session so its retry sends only the rest.
    if (options.session && !unresumable) throw error;
    await options.session?.clear().catch(() => undefined);
    // Shutdown/revocation can prevent this best-effort cleanup. Server-side
    // expiry owns abandoned sessions, while canonical objects remain immutable.
    await request("abort")
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
    throw error;
  }
}
