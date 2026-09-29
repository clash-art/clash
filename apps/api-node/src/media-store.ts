import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, link, unlink, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  AssetKindSchema,
  ResourceSchema,
  type Resource,
} from "@clash/shared-types";
const fail = (status: 400 | 404, message: string): never => {
  throw new HTTPException(status, { message });
};
export const storedMediaPath = (directory: string, resource: Resource) =>
  join(directory, ResourceSchema.parse(resource).digest.value);
const types: Record<string, string> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "image/avif": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/ogg": "audio",
  "audio/webm": "audio",
  "audio/flac": "audio",
  "model/gltf-binary": "model",
  "model/gltf+json": "model",
};
const extensions: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
};

export async function storeMediaUpload(directory: string, form: FormData) {
  const kind = AssetKindSchema.safeParse(form.get("kind"));
  const file = form.get("file");
  if (
    !kind.success ||
    !(file instanceof File) ||
    !file.size ||
    !file.name.trim() ||
    file.name.length > 512
  )
    return fail(400, "A named, non-empty media file and kind are required");
  const contentType =
    file.type && file.type !== "application/octet-stream"
      ? file.type
      : extensions[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!contentType || types[contentType] !== kind.data)
    return fail(400, "Unsupported media type or mismatched asset kind");
  const bytes = Buffer.from(await file.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  const resource = ResourceSchema.parse({
    id: randomUUID(),
    kind: kind.data,
    digest: { algorithm: "sha256", value: digest },
    byteLength: bytes.length,
    contentType,
  });
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.upload-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    await link(temporary, storedMediaPath(directory, resource)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  } finally {
    await unlink(temporary).catch(() => {});
  }

  return {
    resource,
    name: file.name,
    metadata: { bytes: bytes.length, contentType, originalName: file.name },
  };
}
export async function serveStoredMedia(
  c: Context,
  directory: string,
  resource: Resource,
) {
  const path = storedMediaPath(directory, resource);
  const info = await stat(path).catch(() => fail(404, "Media unavailable"));
  let start = 0,
    end = info.size - 1;
  const range = c.req.header("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1]
        ? Number(match[1])
        : Math.max(0, info.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    } else start = info.size;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= info.size
    )
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${info.size}` },
      });
    c.header("Content-Range", `bytes ${start}-${end}/${info.size}`);
  }
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", resource.contentType ?? "application/octet-stream");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Security-Policy", "sandbox; default-src 'none'");
  c.header("Content-Length", String(end - start + 1));
  return new Response(
    Readable.toWeb(
      createReadStream(path, { start, end }),
    ) as ReadableStream<Uint8Array>,
    { status: range ? 206 : 200, headers: c.res.headers },
  );
}
