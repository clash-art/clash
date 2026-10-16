import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  assertContentTransferSize,
  uploadCloudContent,
  type CloudContentUploadSession,
  type ContentTransferLimits,
} from "@clash/asset-sdk/delivery";

interface CloudContentFile extends ContentTransferLimits {
  path: string;
  byteLength: number;
  digest: string;
  signal?: AbortSignal;
}

class CloudContentIntegrityError extends Error {
  constructor() {
    super("Cloud content integrity mismatch");
  }
}

export async function validateCloudContentResponse(
  response: Response,
  byteLength: number,
  maxBytes?: number,
): Promise<void> {
  const declared = response.headers.get("content-length");
  if (declared === null) return;
  try {
    assertContentTransferSize(Number(declared), maxBytes);
    if (Number(declared) !== byteLength) throw new CloudContentIntegrityError();
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
}

export async function* cloudContentChunks(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function verifyStream(
  input: CloudContentFile,
  body: AsyncIterable<Uint8Array>,
): Promise<void> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of body) {
    input.signal?.throwIfAborted();
    size += chunk.byteLength;
    assertContentTransferSize(size, input.maxBytes);
    if (size > input.byteLength) throw new CloudContentIntegrityError();
    hash.update(chunk);
  }
  if (
    size !== input.byteLength ||
    `sha256:${hash.digest("hex")}` !== input.digest
  ) {
    throw new CloudContentIntegrityError();
  }
}

export async function verifyCloudContentFile(
  input: CloudContentFile,
): Promise<boolean> {
  assertContentTransferSize(input.byteLength, input.maxBytes);
  const info = await stat(input.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return false;
  if (info.size !== input.byteLength) throw new CloudContentIntegrityError();
  await verifyStream(input, createReadStream(input.path));
  return true;
}

export async function uploadCloudContentFile(
  input: CloudContentFile & {
    url: string;
    headers?: HeadersInit;
    fetch?: typeof globalThis.fetch;
    session?: CloudContentUploadSession;
  },
): Promise<void> {
  assertContentTransferSize(input.byteLength, input.maxBytes);
  const handle = await open(input.path, "r");
  try {
    if ((await handle.stat()).size !== input.byteLength)
      throw new CloudContentIntegrityError();
    await verifyStream(input, handle.createReadStream({ autoClose: false }));
    await uploadCloudContent({
      url: input.url,
      headers: input.headers,
      fetch: input.fetch,
      maxBytes: input.maxBytes,
      session: input.session,
      source: {
        byteLength: input.byteLength,
        async readPart(offset, length) {
          input.signal?.throwIfAborted();
          const bytes = new Uint8Array(length);
          let read = 0;
          while (read < length) {
            const next = await handle.read(
              bytes,
              read,
              length - read,
              offset + read,
            );
            if (next.bytesRead === 0)
              throw new Error("Local cloud content changed during transfer");
            read += next.bytesRead;
          }
          return bytes;
        },
      },
    });
  } finally {
    await handle.close();
  }
}

/** A Host killed mid-download (SIGKILL, crash, power loss) never reaches the
 * finally that unlinks its temporary file. Remove such orphans for this path
 * once they are clearly abandoned (no write for 15 minutes). */
const ABANDONED_PARTIAL_MS = 15 * 60_000;
export async function sweepAbandonedPartials(
  path: string,
  now = Date.now(),
): Promise<number> {
  const prefix = `${basename(path)}.`;
  let removed = 0;
  const names = await readdir(dirname(path)).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".partial")) continue;
    const candidate = join(dirname(path), name);
    const info = await stat(candidate).catch(() => undefined);
    if (!info || now - info.mtimeMs < ABANDONED_PARTIAL_MS) continue;
    await unlink(candidate).then(
      () => removed++,
      () => undefined,
    );
  }
  return removed;
}

/** Replica transport preserves exact revision bytes, without parsing/reencoding
 * Document bodies or creating a second semantic revision authority. */
export async function installCloudContentFile(
  input: CloudContentFile & {
    body: ReadableStream<Uint8Array>;
  },
): Promise<void> {
  const reader = input.body.getReader();
  let handle: FileHandle | undefined;
  const temporary = `${input.path}.${randomUUID()}.partial`;
  try {
    assertContentTransferSize(input.byteLength, input.maxBytes);
    input.signal?.throwIfAborted();
    await mkdir(dirname(input.path), { recursive: true });
    await sweepAbandonedPartials(input.path);
    handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    for (;;) {
      input.signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      assertContentTransferSize(size, input.maxBytes);
      if (size > input.byteLength) throw new CloudContentIntegrityError();
      hash.update(next.value);
      await handle.writeFile(next.value);
    }
    if (
      size !== input.byteLength ||
      `sha256:${hash.digest("hex")}` !== input.digest
    ) {
      throw new CloudContentIntegrityError();
    }
    input.signal?.throwIfAborted();
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o444);
    await link(temporary, input.path).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        const valid = await verifyCloudContentFile(input).catch(
          (error: unknown) => {
            if (error instanceof CloudContentIntegrityError) return false;
            throw error;
          },
        );
        input.signal?.throwIfAborted();
        if (!valid) await rename(temporary, input.path);
      },
    );
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    await handle?.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
