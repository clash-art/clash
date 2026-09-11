import { createHash } from "node:crypto";
import {
  PROJECT_CLOUD_CONTENT_PART_BYTES,
  assertContentTransferSize,
  type AssetDeliveryStore,
} from "@clash/asset-sdk/delivery";

type Multipart = NonNullable<AssetDeliveryStore["multipart"]>;
type Session = Parameters<Multipart["begin"]>[0];
type Part = { partNumber: number; etag: string; hash: string };
type State = {
  target: Session["target"];
  r2UploadId: string;
  expiresAt: number;
  phase: "open" | "completing" | "publishing" | "complete" | "aborted";
  parts: Record<string, Part>;
  owner?: string;
  leaseUntil?: number;
};
const PREFIX = "project-content-uploads/";
const TTL_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export class MultipartContentError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 410 | 501,
    message: string,
  ) {
    super(message);
  }
}
function invalid(message: string): never {
  throw new MultipartContentError(409, message);
}
function prefixFor(session: Session) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(session.uploadId))
    throw new MultipartContentError(400, "Invalid upload session ID");
  return `${PREFIX}${digest(session.target.identity)}/${session.uploadId}/`;
}
function sameTarget(a: Session["target"], b: Session["target"]) {
  return (
    a.identity === b.identity &&
    a.locator === b.locator &&
    a.digest === b.digest &&
    a.byteLength === b.byteLength &&
    a.contentType === b.contentType
  );
}
async function load(bucket: R2Bucket, key: string) {
  const object = await bucket.get(key);
  return object
    ? { state: await object.json<State>(), etag: object.etag }
    : undefined;
}
async function cas(bucket: R2Bucket, key: string, state: State, etag?: string) {
  return !!(await bucket.put(key, JSON.stringify(state), {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
  }));
}
async function removePrivate(bucket: R2Bucket, prefix: string, state: State) {
  await bucket
    .resumeMultipartUpload(`${prefix}staging`, state.r2UploadId)
    .abort()
    .catch(() => {});
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const keys = page.objects
      .map((value) => value.key)
      .filter((key) => !key.endsWith("/session.json"));
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export function createR2ProjectMultipartStore(
  bucket: R2Bucket,
  now = Date.now,
): Multipart {
  async function current(session: Session) {
    const prefix = prefixFor(session),
      key = `${prefix}session.json`;
    const value = await load(bucket, key);
    if (!value)
      throw new MultipartContentError(
        410,
        "Upload session not found; begin a new upload",
      );
    if (!sameTarget(value.state.target, session.target))
      invalid("Upload target conflicts with existing session");
    if (value.state.expiresAt <= now()) {
      await removePrivate(bucket, prefix, value.state);
      throw new MultipartContentError(
        410,
        "Upload session expired; begin a new upload",
      );
    }
    return { ...value, prefix, key };
  }
  return {
    async begin(session) {
      assertContentTransferSize(session.target.byteLength);
      if (!/^sha256:[a-f0-9]{64}$/.test(session.target.digest))
        throw new MultipartContentError(400, "Invalid immutable digest");
      const prefix = prefixFor(session),
        key = `${prefix}session.json`;
      if (await load(bucket, key)) {
        const existing = await current(session);
        if (existing.state.phase === "aborted")
          throw new MultipartContentError(
            410,
            "Upload was aborted; begin a new session",
          );
        return;
      }
      const upload = await bucket.createMultipartUpload(`${prefix}staging`);
      const state: State = {
        target: session.target,
        r2UploadId: upload.uploadId,
        expiresAt: now() + TTL_MS,
        phase: "open",
        parts: {},
      };
      if (!(await cas(bucket, key, state))) {
        await upload.abort();
        await current(session);
      }
    },
    async part(session, partNumber, bytes) {
      let value = await current(session);
      const expected = Math.min(
        PROJECT_CLOUD_CONTENT_PART_BYTES,
        session.target.byteLength -
          (partNumber - 1) * PROJECT_CLOUD_CONTENT_PART_BYTES,
      );
      if (
        !Number.isSafeInteger(partNumber) ||
        partNumber < 1 ||
        expected <= 0 ||
        bytes.length !== expected
      )
        throw new MultipartContentError(
          400,
          "Upload part length or number does not match immutable object",
        );
      if (value.state.phase === "aborted")
        throw new MultipartContentError(410, "Upload was aborted");
      const hash = digest(bytes),
        existing = value.state.parts[partNumber];
      if (existing) {
        if (existing.hash !== hash)
          invalid("Conflicting immutable upload part");
        return;
      }
      if (value.state.phase !== "open") invalid("Upload is not open for parts");
      const lockKey = `${value.prefix}part-${partNumber}.json`;
      const lock = await bucket.get(lockKey);
      const previous = lock
        ? await lock.json<{ hash: string; expiresAt: number }>()
        : undefined;
      if (previous?.hash && previous.hash !== hash)
        invalid("Conflicting immutable upload part");
      if (previous && previous.expiresAt > now())
        invalid("Upload part is already in progress; retry");
      const acquired = await bucket.put(
        lockKey,
        JSON.stringify({ hash, expiresAt: now() + LEASE_MS }),
        {
          onlyIf: lock ? { etagMatches: lock.etag } : { etagDoesNotMatch: "*" },
        },
      );
      if (!acquired) invalid("Upload part is already in progress; retry");
      value = await current(session);
      if (value.state.phase !== "open") invalid("Upload is no longer open");
      const uploaded = await bucket
        .resumeMultipartUpload(`${value.prefix}staging`, value.state.r2UploadId)
        .uploadPart(partNumber, bytes);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        value = await current(session);
        if (value.state.phase !== "open") invalid("Upload is no longer open");
        if (
          await cas(
            bucket,
            value.key,
            {
              ...value.state,
              parts: {
                ...value.state.parts,
                [partNumber]: { ...uploaded, hash },
              },
            },
            value.etag,
          )
        )
          return;
      }
      invalid("Upload session changed concurrently; retry");
    },
    async complete(session, beforePublish) {
      let value = await current(session);
      if (value.state.phase === "complete") {
        await beforePublish();
        return;
      }
      if (value.state.phase === "aborted") invalid("Upload was aborted");
      if (
        (value.state.phase === "completing" ||
          value.state.phase === "publishing") &&
        (value.state.leaseUntil ?? 0) > now()
      )
        invalid("Upload completion is already in progress; retry");
      const count = Math.ceil(
        session.target.byteLength / PROJECT_CLOUD_CONTENT_PART_BYTES,
      );
      const parts = Array.from(
        { length: count },
        (_, index) => value.state.parts[index + 1],
      );
      if (!parts.length || parts.some((part) => !part))
        invalid("Upload is missing parts");
      const owner = crypto.randomUUID();
      const state: State = {
        ...value.state,
        phase: value.state.phase === "publishing" ? "publishing" : "completing",
        owner,
        leaseUntil: now() + LEASE_MS,
      };
      if (!(await cas(bucket, value.key, state, value.etag)))
        invalid("Upload completion changed concurrently; retry");
      try {
        const staging = `${value.prefix}staging`;
        if (!(await bucket.head(staging)))
          await bucket
            .resumeMultipartUpload(staging, state.r2UploadId)
            .complete(parts);
        const object = await bucket.get(staging);
        if (!object || object.size !== session.target.byteLength)
          throw new MultipartContentError(
            400,
            "Multipart object length mismatch",
          );
        const hash = createHash("sha256");
        let length = 0;
        await object.body.pipeTo(
          new WritableStream<Uint8Array>({
            write(bytes) {
              length += bytes.length;
              if (length > session.target.byteLength)
                throw new MultipartContentError(
                  400,
                  "Multipart object length mismatch",
                );
              hash.update(bytes);
            },
          }),
        );
        if (
          length !== session.target.byteLength ||
          `sha256:${hash.digest("hex")}` !== session.target.digest
        )
          throw new MultipartContentError(
            400,
            "Multipart object digest mismatch",
          );
        await beforePublish();
        value = await current(session);
        if (
          (value.state.phase !== "completing" &&
            value.state.phase !== "publishing") ||
          value.state.owner !== owner
        )
          invalid("Upload was interrupted before publication");
        // Once publication may have started, abort can no longer truthfully claim
        // that the canonical object will never appear. Keep this phase on retry.
        if (
          !(await cas(
            bucket,
            value.key,
            { ...value.state, phase: "publishing" },
            value.etag,
          ))
        )
          invalid("Upload publication changed concurrently; retry");
        const verified = await bucket.get(staging);
        if (!verified) invalid("Verified staging object is missing");
        // R2 verifies the full checksum before atomically exposing the canonical object.
        await bucket.put(session.target.locator, verified.body, {
          sha256: session.target.digest.slice(7),
          httpMetadata: session.target.contentType
            ? { contentType: session.target.contentType }
            : {},
        });
        value = await current(session);
        if (value.state.phase !== "publishing" || value.state.owner !== owner)
          invalid("Upload completion changed concurrently");
        if (
          !(await cas(
            bucket,
            value.key,
            { ...value.state, phase: "complete" },
            value.etag,
          ))
        )
          invalid("Upload completion changed concurrently; retry");
        await removePrivate(bucket, value.prefix, value.state);
      } catch (error) {
        const latest = await load(bucket, value.key);
        if (
          latest?.state.owner === owner &&
          (latest.state.phase === "completing" ||
            latest.state.phase === "publishing")
        )
          await cas(
            bucket,
            value.key,
            {
              ...latest.state,
              phase:
                latest.state.phase === "publishing" ? "publishing" : "open",
              leaseUntil: 0,
            },
            latest.etag,
          );
        throw error;
      }
    },
    async abort(session) {
      const value = await current(session);
      if (value.state.phase === "complete") return;
      if (
        value.state.phase === "completing" ||
        value.state.phase === "publishing"
      )
        invalid(
          "Upload completion owns publication; retry completion instead of abort",
        );
      if (
        !(await cas(
          bucket,
          value.key,
          { ...value.state, phase: "aborted" },
          value.etag,
        ))
      )
        invalid("Upload changed concurrently; retry abort");
      await removePrivate(bucket, value.prefix, value.state);
    },
  };
}

/** One bounded page per existing scheduled invocation; cursor survives isolate restarts. */
export async function cleanupProjectContentUploads(
  bucket: R2Bucket,
  now = Date.now(),
) {
  const cursorKey = "project-content-upload-cleanup.json";
  const saved = await bucket.get(cursorKey);
  const cursor = saved
    ? (await saved.json<{ cursor?: string }>()).cursor
    : undefined;
  const page = await bucket.list({
    prefix: PREFIX,
    limit: 5,
    ...(cursor ? { cursor } : {}),
  });
  for (const entry of page.objects) {
    if (!entry.key.endsWith("/session.json")) continue;
    const value = await load(bucket, entry.key);
    if (!value || value.state.expiresAt > now) continue;
    const prefix = entry.key.slice(0, -"session.json".length);
    await removePrivate(bucket, prefix, value.state);
    await bucket.delete(entry.key);
  }
  await bucket.put(
    cursorKey,
    JSON.stringify({ ...(page.truncated ? { cursor: page.cursor } : {}) }),
  );
}
