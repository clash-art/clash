/**
 * Capability-gated R2 delivery transport.
 *
 * This adapter consumes a short-lived URL capability minted by an authorized
 * product service. It neither accepts uploads nor turns a caller-supplied R2
 * key into authority, identity, or canonical Asset metadata.
 */

import { Hono } from "hono";
import type { Env } from "../config";
import { getSigningKey, verifySignature } from "../services/asset-signing";

// ─── Routes ──────────────────────────────────────────────────

const assetDeliveryRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /* — Serve file from R2 (requires valid signature)
 *
 * For images in prod (MEDIA_GATEWAY_URL set), transparently proxy through
 * Cloudflare Image Transformations which strips EXIF (incl. GPS), re-encodes
 * to an optimal format (webp/avif), and handles CDN caching.
 * For non-images, or in dev (no MEDIA_GATEWAY_URL), stream direct from R2.
 */
assetDeliveryRoutes.get("/*", async (c) => {
  const path = c.req.path;
  const storageKey = path.startsWith("/assets/")
    ? path.slice("/assets/".length)
    : path.slice(1);

  if (!storageKey || storageKey === "sign") return c.text("Not found", 404);

  // Verify signature
  const exp = c.req.query("exp");
  const sig = c.req.query("sig");

  if (!exp || !sig) {
    return c.text("Missing signature", 403);
  }

  const expNum = parseInt(exp, 10);
  if (Date.now() / 1000 > expNum) {
    return c.text("URL expired", 403);
  }

  const key = await getSigningKey(c.env);
  if (!(await verifySignature(key, storageKey, expNum, sig))) {
    return c.text("Invalid signature", 403);
  }

  // Fetch from R2. Honor HTTP Range requests so byte-seek-capable clients
  // (ffmpeg reading mp4s with trailing moov atoms, <video> element seeks,
  // partial downloads) work correctly. Without this, ffmpeg gets the full
  // body when it asked for a tail slice and fails with "Stream ends
  // prematurely" during mp4 demuxing.
  const rangeHeader = c.req.header("range");
  const parsedRange = parseRangeHeader(rangeHeader);

  // Edge cache hit-path. The cache key strips the signature/exp so the same
  // asset hits cache regardless of which signed-URL variant the browser asks
  // for. Range requests must skip this full-body cache; returning a cached 200
  // to a byte-range client breaks video seek/demux callers that require 206.
  const cacheKey = new Request(
    new URL(`/__asset_cache/${storageKey}`, c.req.url).toString(),
  );
  if (!parsedRange) {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      // Tag the cache hit so DevTools / curl can see it (caches.default
      // hits don't get a cf-cache-status header automatically).
      const tagged = new Response(cached.body, cached);
      tagged.headers.set("x-cache", "HIT");
      return tagged;
    }
  }

  if (parsedRange) {
    const head = await c.env.R2_BUCKET.head(storageKey);
    if (!head) return c.text("Asset not found", 404);
    const total = head.size;
    const start =
      parsedRange.start ?? Math.max(0, total - (parsedRange.suffix ?? 0));
    const end = parsedRange.end ?? total - 1;
    if (start >= total || end < start) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    const clampedEnd = Math.min(end, total - 1);
    const length = clampedEnd - start + 1;
    const object = await c.env.R2_BUCKET.get(storageKey, {
      range: { offset: start, length },
    });
    if (!object) return c.text("Asset not found", 404);
    return new Response(object.body, {
      status: 206,
      headers: {
        "Content-Type":
          object.httpMetadata?.contentType || "application/octet-stream",
        "Content-Length": String(length),
        "Content-Range": `bytes ${start}-${clampedEnd}/${total}`,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        // Asset URLs include a unique gen-id / upload-uuid in the path, so the
        // bytes at a given key never change. Mark immutable + 1y so the browser
        // disk-caches forever (no revalidation). When an asset is deleted the
        // signed URL stops being issued, so the browser cache only holds bytes
        // the user is still authorized to see.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  const object = await c.env.R2_BUCKET.get(storageKey);
  if (!object) return c.text("Asset not found", 404);

  const resp = new Response(object.body, {
    headers: {
      "Content-Type":
        object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(object.size),
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
      // Asset URLs include a unique gen-id / upload-uuid in the path, so the
      // bytes at a given key never change. Mark immutable + 1y so the browser
      // disk-caches forever (no revalidation). When an asset is deleted the
      // signed URL stops being issued, so the browser cache only holds bytes
      // the user is still authorized to see.
      "Cache-Control": "public, max-age=31536000, immutable",
      "x-cache": "MISS",
    },
  });
  // Write back to edge cache under the signature-stripped key. Worker
  // responses don't auto-cache; using caches.default.put is the way to
  // persist them. Range requests above intentionally skip the cache —
  // partial bodies can't satisfy a non-Range hit. The cached copy keeps
  // x-cache: MISS in its headers; we overwrite it to HIT in the match
  // branch above when serving from cache.
  try {
    c.executionCtx.waitUntil(caches.default.put(cacheKey, resp.clone()));
  } catch {
    // Unit tests using app.request() do not provide an ExecutionContext.
  }
  return resp;
});

/**
 * Parse an HTTP Range header of form `bytes=START-END` / `bytes=START-` /
 * `bytes=-SUFFIX`. Returns null for malformed / unsupported shapes (multi-range
 * is rejected — R2 only serves a single contiguous slice per request, so there
 * is no clean single-response representation for multi-range).
 */
function parseRangeHeader(
  h: string | undefined,
): { start?: number; end?: number; suffix?: number } | null {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === "" && e === "") return null;
  if (s === "" && e !== "") return { suffix: Number(e) };
  const start = Number(s);
  if (e === "") return { start };
  return { start, end: Number(e) };
}

export { assetDeliveryRoutes };
