import { Hono } from "hono";

import {
  ContentTransferLimitError,
  assertContentTransferSize,
  readBoundedContent,
  type AssetDeliveryCapabilityClaims,
  type AssetDeliveryByteRange,
  type AssetDeliveryStore,
} from "@clash/asset-sdk/delivery";

import type { Env } from "../config";
import { verifyCloudAssetDeliveryCapability } from "../services/cloud-asset-delivery";

export interface AssetCapabilityResource {
  /** Private storage locator. It never appears in the capability or Project state. */
  storageKey: string;
  contentType?: string;
  byteLength?: number;
}

export interface AssetCapabilityRoutesOptions {
  resolve(
    claims: AssetDeliveryCapabilityClaims,
    env: Env,
  ):
    | AssetCapabilityResource
    | undefined
    | Promise<AssetCapabilityResource | undefined>;
  now?: () => number;
  maxBytes?: number;
  /** Optional storage adapter. Omit it only for the default Cloudflare R2 adapter. */
  store?: AssetDeliveryStore;
}

interface ByteRange {
  start: number;
  end: number;
}

function safeStorageKey(value: string): string | undefined {
  const key = value.trim();
  if (!key || key.startsWith("/") || key.includes("..")) return undefined;
  return key;
}

function parseRange(
  value: string | undefined,
  total: number,
): ByteRange | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start >= total) return null;
  const requestedEnd = match[2] ? Number(match[2]) : total - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, total - 1) };
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", bytes)
    .then((value) =>
      [...new Uint8Array(value)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    );
}

export function createR2AssetDeliveryStore(
  bucket: R2Bucket,
): AssetDeliveryStore {
  return {
    async head(locator) {
      const object = await bucket.head(locator);
      if (!object) return undefined;
      return {
        size: object.size,
        ...(object.httpMetadata?.contentType
          ? { contentType: object.httpMetadata.contentType }
          : {}),
      };
    },
    async get(locator, range) {
      const object = await bucket.get(
        locator,
        range
          ? { range: { offset: range.offset, length: range.length } }
          : undefined,
      );
      if (!object) return undefined;
      return {
        body: object.body,
        size: object.size,
        ...(object.httpMetadata?.contentType
          ? { contentType: object.httpMetadata.contentType }
          : {}),
      };
    },
    async put(locator, bytes, options) {
      await bucket.put(
        locator,
        bytes,
        options?.contentType
          ? { httpMetadata: { contentType: options.contentType } }
          : undefined,
      );
    },
  };
}

function corsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Content-Length, Range",
    "Access-Control-Expose-Headers":
      "Accept-Ranges, Content-Length, Content-Range, Content-Type",
    "Cache-Control": "private, no-store",
  });
}

export function createAssetCapabilityRoutes(
  options: AssetCapabilityRoutesOptions,
): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();
  const now = options.now ?? Date.now;
  routes.onError((error, c) =>
    error instanceof ContentTransferLimitError
      ? c.json(
          { error: error.message, code: error.code, maxBytes: error.maxBytes },
          413,
        )
      : c.json({ error: "Cloud content transport unavailable" }, 503),
  );

  routes.options(
    "/:token",
    (c) => new Response(null, { status: 204, headers: corsHeaders() }),
  );

  routes.all("/:token", async (c) => {
    const token = c.req.param("token");
    const claims = await verifyCloudAssetDeliveryCapability(c.env, token, now);
    if (!claims) return c.text("Invalid or expired capability", 403);
    const boundedTransfer =
      !!claims.scope.localReplicaId || options.maxBytes !== undefined;

    const expectedMethod = claims.operation === "read" ? "GET" : "PUT";
    if (
      c.req.method !== expectedMethod &&
      !(claims.operation === "read" && c.req.method === "HEAD")
    ) {
      return new Response("Method not allowed", {
        status: 405,
        headers: {
          ...Object.fromEntries(corsHeaders()),
          Allow: expectedMethod,
        },
      });
    }

    const resource = await options.resolve(claims, c.env);
    const storageKey = resource && safeStorageKey(resource.storageKey);
    if (!storageKey) return c.text("Resource not found", 404);
    if (boundedTransfer && resource.byteLength !== undefined)
      assertContentTransferSize(resource.byteLength, options.maxBytes);
    const store = options.store ?? createR2AssetDeliveryStore(c.env.R2_BUCKET);

    if (claims.operation === "upload") {
      if (claims.byteLength === undefined) {
        return c.text("Upload capability has no byte length", 400);
      }
      if (boundedTransfer)
        assertContentTransferSize(claims.byteLength, options.maxBytes);
      const declaredLength = c.req.header("content-length");
      if (boundedTransfer && declaredLength !== undefined)
        assertContentTransferSize(Number(declaredLength), options.maxBytes);
      const bytes = boundedTransfer
        ? await readBoundedContent(c.req.raw.body, options)
        : new Uint8Array(await c.req.arrayBuffer());
      if (
        (declaredLength !== undefined &&
          Number(declaredLength) !== bytes.byteLength) ||
        bytes.byteLength !== claims.byteLength
      ) {
        return c.text("Upload byte length does not match capability", 400);
      }
      if (claims.digest) {
        const actualDigest = await sha256Hex(bytes);
        if (actualDigest !== claims.digest.slice("sha256:".length)) {
          return c.text("Upload digest does not match capability", 400);
        }
      }
      const current = await options.resolve(claims, c.env);
      if (!current || current.storageKey !== storageKey)
        return c.text("Resource no longer admitted", 403);
      const contentType = resource.contentType ?? claims.contentType;
      await store.put(
        storageKey,
        bytes,
        contentType ? { contentType } : undefined,
      );
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const head = await store.head(storageKey);
    if (!head) return c.text("Resource not found", 404);
    if (boundedTransfer) assertContentTransferSize(head.size, options.maxBytes);
    if (resource.byteLength !== undefined && head.size !== resource.byteLength)
      return c.text("Resource integrity mismatch", 502);
    const responseHeaders = corsHeaders();
    responseHeaders.set("Accept-Ranges", "bytes");
    responseHeaders.set("Content-Length", String(head.size));
    const contentType = resource.contentType ?? head.contentType;
    if (contentType) responseHeaders.set("Content-Type", contentType);

    if (c.req.method === "HEAD") {
      return new Response(null, { status: 200, headers: responseHeaders });
    }

    const requestedRange = c.req.header("range");
    if (requestedRange) {
      const range = parseRange(requestedRange, head.size);
      if (!range) {
        responseHeaders.set("Content-Range", `bytes */${head.size}`);
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: responseHeaders,
        });
      }
      const length = range.end - range.start + 1;
      const object = await store.get(storageKey, {
        offset: range.start,
        length,
      } satisfies AssetDeliveryByteRange);
      if (!object) return c.text("Resource not found", 404);
      responseHeaders.set("Content-Length", String(length));
      responseHeaders.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${head.size}`,
      );
      if (!boundedTransfer)
        return new Response(object.body, {
          status: 206,
          headers: responseHeaders,
        });
      const bytes = await readBoundedContent(object.body, options);
      if (bytes.byteLength !== length)
        return c.text("Resource integrity mismatch", 502);
      return new Response(bytes, {
        status: 206,
        headers: responseHeaders,
      });
    }

    const object = await store.get(storageKey);
    if (!object) return c.text("Resource not found", 404);
    if (!boundedTransfer)
      return new Response(object.body, {
        status: 200,
        headers: responseHeaders,
      });
    const bytes = await readBoundedContent(object.body, options);
    if (bytes.byteLength !== head.size)
      return c.text("Resource integrity mismatch", 502);
    return new Response(bytes, { status: 200, headers: responseHeaders });
  });

  return routes;
}
