/**
 * Node-only filesystem `AssetDeliveryStore` with resumable multipart staging.
 *
 * This is the Node counterpart of the Cloudflare R2 store. It lives behind a
 * package subpath (`@clash/shared-runtime/fs-asset-delivery-store`) so both
 * Node hosts — api-node and local-api — share one implementation without
 * making the platform-agnostic shared modules import `node:*`.
 *
 * Objects become visible only through an atomic rename after digest
 * verification. `multipart.complete` streams the parts into the object one
 * bounded chunk at a time and hashes them on the way: that one pass checks a
 * claimed digest, and is the digest of import staging, which claims none.
 */
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
  MultipartAssemblyError,
  MultipartContentError,
} from "@clash/asset-sdk/upload-service";
import {
  PROJECT_CLOUD_CONTENT_PART_BYTES,
  type AssetDeliveryStore,
} from "@clash/asset-sdk/delivery";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The import transport reports an incomplete part set as an assembly failure. */
const MULTIPART_ASSEMBLY_FAILED = "PROJECT_ASSET_IMPORT_ASSEMBLY_FAILED";

/** An object this store assembled, with the SHA-256 computed while assembling it. */
export interface FsAssembledObject {
  /** Host-private file; a caller that moves it owns its bytes from then on. */
  path: string;
  /** Lowercase hex SHA-256. */
  digest: string;
  size: number;
}

export interface FsAssetDeliveryStore extends AssetDeliveryStore {
  /**
   * The object `multipart.complete` assembled at `locator` in this process,
   * if it is still that file. Unknown after a restart: read it instead.
   */
  assembled(locator: string): Promise<FsAssembledObject | undefined>;
  /** Remove a published object (import staging is deleted after finalize). */
  delete(locator: string): Promise<void>;
  /** Published objects with their file mtime, for abandoned staging sweeps. */
  list(): AsyncIterable<{ locator: string; createdAt: number }>;
  /**
   * Unfinished multipart uploads (`<target hash>/<uploadId>`), dated by their last write. A session
   * that uploaded parts and never completed leaves only these, never an object.
   */
  listUploads(): AsyncIterable<{ locator: string; createdAt: number }>;
  /** Remove one unfinished multipart upload directory named by `listUploads`. */
  deleteUpload(locator: string): Promise<void>;
}

/** Filesystem AssetDeliveryStore with resumable multipart staging. */
export function createFsAssetDeliveryStore(root: string): FsAssetDeliveryStore {
  const objectsRoot = join(root, "objects");
  const uploadsRoot = join(root, "staging");
  const safe = (locator: string) => {
    if (!locator || locator.startsWith("/") || locator.includes("..")) throw new Error("Invalid locator");
    return join(objectsRoot, locator);
  };
  type Session = Parameters<NonNullable<AssetDeliveryStore["multipart"]>["begin"]>[0];
  const dirOf = (s: Session) => {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(s.uploadId))
      throw new MultipartContentError(400, "Invalid upload session ID");
    return join(uploadsRoot, sha256(new TextEncoder().encode(s.target.identity)), s.uploadId);
  };
  const readState = async (dir: string) =>
    JSON.parse(await readFile(join(dir, "state.json"), "utf8").catch(() => "null")) as
      | { target: Session["target"]; aborted?: boolean }
      | null;
  const live = async (s: Session) => {
    const dir = dirOf(s);
    const state = await readState(dir);
    if (state?.aborted) throw new MultipartContentError(410, "Upload session was aborted");
    if (state && JSON.stringify(state.target) !== JSON.stringify(s.target))
      throw new MultipartContentError(409, "Upload session target changed");
    return { dir, state };
  };
  const parts = async (dir: string) =>
    (await readdir(dir).catch(() => [] as string[]))
      .filter((n) => /^part-\d+$/.test(n))
      .map((n) => Number(n.slice(5)))
      .sort((a, b) => a - b);
  type Identity = { dev: number; ino: number; size: number; mtimeMs: number };
  const sameFile = (a: Identity, b: Identity) =>
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
  const assembledObjects = new Map<string, Identity & { digest: string }>();
  /**
   * The digest of an assembled object lives beside it, so a finalize after a
   * Host restart still adopts the object instead of hashing it again.
   */
  const digestPath = (path: string) => `${path}.sha256`;
  const readAssembledDigest = async (
    path: string,
  ): Promise<{ digest: string; size: number } | undefined> => {
    const text = await readFile(digestPath(path), "utf8").catch(() => undefined);
    if (!text) return undefined;
    try {
      const value = JSON.parse(text) as {
        digest?: unknown;
        size?: unknown;
      };
      if (
        typeof value.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.digest) ||
        !Number.isSafeInteger(value.size) ||
        (value.size as number) < 0
      )
        return undefined;
      return { digest: value.digest, size: value.size as number };
    } catch {
      return undefined;
    }
  };
  /**
   * Streams the parts, in order, into `target` while hashing them, so memory
   * stays one read chunk whatever the object size. Any failure removes the
   * partial file.
   */
  async function assemble(sources: string[], target: string, byteLength: number) {
    try {
      const hash = createHash("sha256");
      const out = await open(target, "w");
      try {
        let written = 0;
        for (const source of sources) {
          for await (const chunk of createReadStream(source) as AsyncIterable<Buffer>) {
            hash.update(chunk);
            for (let offset = 0; offset < chunk.length; ) {
              const { bytesWritten } = await out.write(chunk, offset, chunk.length - offset);
              if (bytesWritten <= 0) throw new Error("Multipart object write made no progress");
              offset += bytesWritten;
            }
            written += chunk.length;
          }
        }
        if (written !== byteLength)
          throw new Error(`Multipart parts changed during assembly (${written} of ${byteLength} bytes)`);
        await out.sync();
        const info = await out.stat();
        return { digest: hash.digest("hex"), dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
      } finally {
        await out.close();
      }
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      const errno = (error as NodeJS.ErrnoException).code;
      throw new MultipartAssemblyError(
        `Multipart object assembly failed${errno ? ` (${errno})` : ""}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  async function* listObjects(
    dir: string,
    prefix: string,
  ): AsyncGenerator<{ locator: string; createdAt: number }> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const locator = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        yield* listObjects(join(dir, entry.name), locator);
        continue;
      }
      if (!entry.isFile()) continue;
      // Digest sidecars are part of their object, not objects of their own.
      if (entry.name.endsWith(".sha256")) continue;
      const info = await stat(join(dir, entry.name));
      yield { locator, createdAt: info.mtimeMs };
    }
  }
  return {
    async head(locator) {
      const s = await stat(safe(locator)).catch(() => undefined);
      return s?.isFile() ? { size: s.size } : undefined;
    },
    async get(locator, range) {
      const path = safe(locator);
      const s = await stat(path).catch(() => undefined);
      if (!s?.isFile()) return undefined;
      const stream = createReadStream(path, range ? { start: range.offset, end: range.offset + range.length - 1 } : {});
      return { body: Readable.toWeb(stream) as ReadableStream<Uint8Array>, size: s.size };
    },
    async put(locator, bytes) {
      const path = safe(locator);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, path);
      await rm(digestPath(path), { force: true });
      assembledObjects.delete(locator);
    },
    async assembled(locator) {
      const path = safe(locator);
      const known = assembledObjects.get(locator);
      if (known) {
        const info = await stat(path).catch(() => undefined);
        if (info?.isFile() && sameFile(info, known)) {
          return { path, digest: known.digest, size: known.size };
        }
        assembledObjects.delete(locator);
      }
      const persisted = await readAssembledDigest(path);
      if (!persisted) return undefined;
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile() || info.size !== persisted.size) return undefined;
      assembledObjects.set(locator, {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        digest: persisted.digest,
      });
      return { path, digest: persisted.digest, size: persisted.size };
    },
    async delete(locator) {
      const path = safe(locator);
      await Promise.all([
        rm(path, { force: true }),
        rm(digestPath(path), { force: true }),
      ]);
      assembledObjects.delete(locator);
    },
    list() {
      return listObjects(objectsRoot, "");
    },
    async *listUploads() {
      let targets;
      try {
        targets = await readdir(uploadsRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const target of targets) {
        if (!target.isDirectory()) continue;
        for (const upload of await readdir(join(uploadsRoot, target.name), { withFileTypes: true })) {
          if (!upload.isDirectory()) continue;
          const dir = join(uploadsRoot, target.name, upload.name);
          // The newest write in the session is its age: a part upload refreshes it.
          let createdAt = (await stat(dir)).mtimeMs;
          for (const name of await readdir(dir))
            createdAt = Math.max(createdAt, (await stat(join(dir, name))).mtimeMs);
          yield { locator: `${target.name}/${upload.name}`, createdAt };
        }
      }
    },
    async deleteUpload(locator) {
      if (!/^[a-f0-9]{64}\/[a-zA-Z0-9_-]{16,128}$/.test(locator)) throw new Error("Invalid upload locator");
      await rm(join(uploadsRoot, locator), { recursive: true, force: true });
    },
    multipart: {
      async begin(s) {
        const { dir, state } = await live(s);
        if (!state) {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, "state.json"), JSON.stringify({ target: s.target }));
        }
        return {
          parts: await Promise.all(
            (await parts(dir)).map(async (partNumber) => ({
              partNumber,
              sha256: sha256(await readFile(join(dir, `part-${partNumber}`))),
            })),
          ),
        };
      },
      async part(s, partNumber, bytes) {
        const { dir, state } = await live(s);
        if (!state) throw new MultipartContentError(409, "Upload session not begun");
        const count = Math.max(1, Math.ceil(s.target.byteLength / PROJECT_CLOUD_CONTENT_PART_BYTES));
        const expected = partNumber === count ? s.target.byteLength - (count - 1) * PROJECT_CLOUD_CONTENT_PART_BYTES : PROJECT_CLOUD_CONTENT_PART_BYTES;
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count || bytes.length !== expected)
          throw new MultipartContentError(400, "Multipart part length or number does not match");
        const tmp = join(dir, `.part-${partNumber}.${Date.now()}`);
        await writeFile(tmp, bytes);
        await rename(tmp, join(dir, `part-${partNumber}`));
      },
      async complete(s, beforePublish) {
        const { dir, state } = await live(s);
        if (!state) throw new MultipartContentError(409, "Upload session not begun");
        const numbers = await parts(dir);
        const count = Math.max(
          1,
          Math.ceil(s.target.byteLength / PROJECT_CLOUD_CONTENT_PART_BYTES),
        );
        if (
          numbers.length !== count ||
          numbers.some((partNumber, index) => partNumber !== index + 1)
        ) {
          const missing = new Error(
            `Multipart object is missing a part (${numbers.length} of ${count} present)`,
          ) as NodeJS.ErrnoException;
          missing.code = "ENOENT";
          throw new MultipartContentError(
            409,
            "Multipart upload is incomplete",
            { code: MULTIPART_ASSEMBLY_FAILED, cause: missing },
          );
        }
        const sources = numbers.map((n) => join(dir, `part-${n}`));
        const tmp = join(dir, "assembled");
        const assembled = await assemble(sources, tmp, s.target.byteLength);
        const path = safe(s.target.locator);
        const sidecar = digestPath(path);
        const sidecarTmp = `${sidecar}.${process.pid}.${Date.now()}.tmp`;
        let published = false;
        try {
          // Import staging carries no digest until finalize (the same
          // convention as the R2 store); a claimed digest is always verified.
          if (s.target.digest !== "" && `sha256:${assembled.digest}` !== s.target.digest)
            throw new MultipartContentError(400, "Multipart object digest mismatch");
          await beforePublish();
          await mkdir(dirname(path), { recursive: true });
          await writeFile(
            sidecarTmp,
            JSON.stringify({ digest: assembled.digest, size: assembled.size }),
            { mode: 0o600 },
          );
          await rename(tmp, path);
          published = true;
          await rename(sidecarTmp, sidecar);
        } catch (error) {
          await rm(tmp, { force: true }).catch(() => undefined);
          await rm(sidecarTmp, { force: true }).catch(() => undefined);
          if (published) await rm(path, { force: true }).catch(() => undefined);
          throw error;
        }
        assembledObjects.set(s.target.locator, assembled);
        await rm(dir, { recursive: true, force: true });
      },
      async abort(s) {
        const dir = dirOf(s);
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "state.json"), JSON.stringify({ target: s.target, aborted: true }));
      },
    },
  };
}
