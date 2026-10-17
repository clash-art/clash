/**
 * Node-only filesystem `AssetDeliveryStore` with resumable multipart staging.
 *
 * This is the Node counterpart of the Cloudflare R2 store. It lives behind a
 * package subpath (`@clash/shared-runtime/fs-asset-delivery-store`) so both
 * Node hosts — api-node and local-api — share one implementation without
 * making the platform-agnostic shared modules import `node:*`.
 *
 * Objects become visible only through an atomic rename after digest
 * verification. Import staging has no digest until finalization, so
 * `multipart.complete` skips that check when the target digest is `""`.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { MultipartContentError } from "@clash/asset-sdk/upload-service";
import {
  PROJECT_CLOUD_CONTENT_PART_BYTES,
  type AssetDeliveryStore,
} from "@clash/asset-sdk/delivery";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export interface FsAssetDeliveryStore extends AssetDeliveryStore {
  /** Remove a published object (import staging is deleted after finalize). */
  delete(locator: string): Promise<void>;
}

/** Filesystem AssetDeliveryStore with resumable multipart staging. */
export function createFsAssetDeliveryStore(root: string): FsAssetDeliveryStore {
  const safe = (locator: string) => {
    if (!locator || locator.startsWith("/") || locator.includes("..")) throw new Error("Invalid locator");
    return join(root, "objects", locator);
  };
  type Session = Parameters<NonNullable<AssetDeliveryStore["multipart"]>["begin"]>[0];
  const dirOf = (s: Session) => {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(s.uploadId))
      throw new MultipartContentError(400, "Invalid upload session ID");
    return join(root, "staging", sha256(new TextEncoder().encode(s.target.identity)), s.uploadId);
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
    },
    async delete(locator) {
      await rm(safe(locator), { force: true });
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
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        let total = 0;
        for (const n of await parts(dir)) {
          const b = await readFile(join(dir, `part-${n}`));
          hash.update(b);
          chunks.push(b);
          total += b.length;
        }
        if (total !== s.target.byteLength) throw new MultipartContentError(409, "Multipart upload is incomplete");
        // Import staging carries no digest until finalize; the same convention
        // as the R2 store. A claimed digest is always verified.
        if (s.target.digest !== "" && `sha256:${hash.digest("hex")}` !== s.target.digest)
          throw new MultipartContentError(400, "Multipart object digest mismatch");
        await beforePublish();
        const path = safe(s.target.locator);
        await mkdir(dirname(path), { recursive: true });
        const tmp = join(dir, "assembled");
        await writeFile(tmp, Buffer.concat(chunks));
        await rename(tmp, path);
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
