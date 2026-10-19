import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { Readable } from "node:stream";

const IMMUTABLE_ASSET_PATTERN =
  /^\/assets\/|[-.][a-f0-9]{8,}\.(?:js|mjs|css|map|wasm|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf)$/i;
const ASSET_EXTENSION_PATTERN =
  /\.(?:js|mjs|css|map|html?|wasm|json|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|mp4|webm|mp3|wav|ogg)$/i;

export function contentTypeForPath(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json") || path.endsWith(".map")) return "application/json; charset=utf-8";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".avif")) return "image/avif";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".ttf")) return "font/ttf";
  if (path.endsWith(".otf")) return "font/otf";
  if (path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".webm")) return "video/webm";
  return "application/octet-stream";
}

export function cacheControlForPath(pathname: string): string {
  if (IMMUTABLE_ASSET_PATTERN.test(pathname)) {
    return "public, max-age=31536000, immutable";
  }
  if (pathname.endsWith(".html")) return "no-cache";
  return "public, max-age=3600";
}

export function isNavigationRequest(request: Request): boolean {
  if (request.mode === "navigate") return true;
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  const pathname = new URL(request.url).pathname;
  if (ASSET_EXTENSION_PATTERN.test(pathname)) return false;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function streamFile(
  path: string,
  size: number,
  cacheControl: string,
): Response {
  return new Response(
    Readable.toWeb(createReadStream(path)) as unknown as BodyInit,
    {
      headers: {
        "content-type": contentTypeForPath(path),
        "content-length": String(size),
        "cache-control": cacheControl,
      },
    },
  );
}

/**
 * Serves the packaged renderer from the `clash://` scheme. Files stream from
 * disk instead of being read whole, immutable build output is cached by the
 * renderer, and only real navigations receive the SPA shell; a missing chunk is
 * a 404 so the failure is not reported later as an unrelated MIME error.
 */
export async function readWebAsset(
  distDir: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const cleanPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const candidate = normalize(join(distDir, cleanPath));
  const rel = relative(distDir, candidate);
  const insideRoot = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);

  if (insideRoot) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) {
      return streamFile(
        candidate,
        info.size,
        cacheControlForPath(cleanPath),
      );
    }
  }

  if (isNavigationRequest(request)) {
    const index = join(distDir, "index.html");
    const info = await stat(index);
    return streamFile(index, info.size, "no-cache");
  }

  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
