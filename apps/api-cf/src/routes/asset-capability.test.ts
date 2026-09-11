import { describe, expect, it, vi } from "vitest";

import {
  createHmacAssetDeliverySigner,
  PROJECT_CLOUD_CONTENT_MAX_BYTES,
  type AssetDeliveryCapabilityClaims,
} from "@clash/asset-sdk/delivery";

import { createAssetCapabilityRoutes } from "./asset-capability";

function env() {
  const bytes = new TextEncoder().encode("hello");
  return {
    ENVIRONMENT: "production",
    JWT_SECRET: "cloud-secret",
    R2_BUCKET: {
      head: vi.fn(async () => ({
        size: bytes.byteLength,
        httpMetadata: { contentType: "text/plain" },
      })),
      get: vi.fn(async () => ({
        body: new Response(bytes).body,
        size: bytes.byteLength,
        httpMetadata: { contentType: "text/plain" },
      })),
      put: vi.fn(async () => undefined),
    },
  } as any;
}

async function signedToken(
  operation: "read" | "upload",
  now = Date.parse("2026-09-04T00:00:00.000Z"),
): Promise<string> {
  const signer = createHmacAssetDeliverySigner({
    secret: "cloud-secret",
    origin: "https://api.example.test",
    now: () => now,
  });
  const signed = await signer.sign({
    operation,
    method: operation === "read" ? "GET" : "PUT",
    resourceId: "resource-1",
    scope: { tenantId: "tenant-1", projectId: "project-1" },
    purpose: operation === "read" ? "download" : "host-staging",
    expiresAt: new Date(now + 60_000).toISOString(),
    ...(operation === "upload"
      ? {
          byteLength: 5,
          digest:
            "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        }
      : {}),
  });
  return new URL(signed.url).pathname.split("/").at(-1)!;
}

describe("standalone Asset capability route", () => {
  it("resolves an opaque resource capability to R2 bytes", async () => {
    const now = Date.parse("2026-09-04T00:00:00.000Z");
    const routes = createAssetCapabilityRoutes({
      now: () => now,
      resolve: vi.fn(async (claims: AssetDeliveryCapabilityClaims) => ({
        storageKey:
          claims.resourceId === "resource-1" ? "private/hello.txt" : "",
        contentType: "text/plain",
      })),
    });
    const request = new Request(
      `https://api.example.test/${await signedToken("read", now)}`,
    );
    const response = await routes.request(request, {}, env());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("content-type")).toBe("text/plain");
  });

  it("validates upload size and digest before writing to R2", async () => {
    const now = Date.parse("2026-09-04T00:00:00.000Z");
    const requestEnv = env();
    const bucket = requestEnv.R2_BUCKET;
    const routes = createAssetCapabilityRoutes({
      now: () => now,
      resolve: vi.fn(async () => ({ storageKey: "private/upload.bin" })),
    });
    const token = await signedToken("upload", now);
    const response = await routes.request(
      new Request(`https://api.example.test/${token}`, {
        method: "PUT",
        headers: { "content-length": "5" },
        body: "hello",
      }),
      {},
      requestEnv,
    );

    expect(response.status).toBe(204);
    expect(bucket.put).toHaveBeenCalledWith(
      "private/upload.bin",
      expect.any(Uint8Array),
      undefined,
    );
  });

  it("rejects a tampered or expired capability without touching R2", async () => {
    const now = Date.parse("2026-09-04T00:00:00.000Z");
    const requestEnv = env();
    const bucket = requestEnv.R2_BUCKET;
    const routes = createAssetCapabilityRoutes({
      now: () => now,
      resolve: vi.fn(),
    });
    const token = await signedToken("read", now);
    const response = await routes.request(
      `https://api.example.test/${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`,
      {},
      requestEnv,
    );

    expect(response.status).toBe(403);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("can serve through a host-neutral byte store without an R2 binding", async () => {
    const now = Date.parse("2026-09-04T00:00:00.000Z");
    const routes = createAssetCapabilityRoutes({
      now: () => now,
      resolve: vi.fn(async () => ({ storageKey: "objects/hello" })),
      store: {
        head: vi.fn(async () => ({
          size: 5,
          contentType: "text/plain",
        })),
        get: vi.fn(async () => ({
          body: new Response("hello").body!,
          size: 5,
          contentType: "text/plain",
        })),
        put: vi.fn(async () => undefined),
      },
    });

    const response = await routes.request(
      `https://api.example.test/${await signedToken("read", now)}`,
      {},
      { JWT_SECRET: "cloud-secret", ENVIRONMENT: "production" } as any,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
  });
});

it("bounds actual download bytes even when stored object metadata understates the stream", async () => {
  const now = Date.parse("2026-09-04T00:00:00.000Z"),
    maxBytes = 8;
  const routes = createAssetCapabilityRoutes({
    now: () => now,
    maxBytes,
    resolve: () => ({ storageKey: "private/media" }),
    store: {
      head: () => ({ size: maxBytes }),
      get: () => ({
        size: maxBytes,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(maxBytes));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
      }),
      put: async () => undefined,
    },
  });
  const response = await routes.request(
    `https://api.example.test/${await signedToken("read", now)}`,
    {},
    env(),
  );
  expect(response.status).toBe(200);
  await expect(response.arrayBuffer()).rejects.toThrow("length mismatch");
});

it("keeps generic large-Resource range previews streaming outside Project replica transfer policy", async () => {
  const now = Date.parse("2026-09-04T00:00:00.000Z");
  const routes = createAssetCapabilityRoutes({
    now: () => now,
    resolve: () => ({ storageKey: "private/large-preview" }),
    store: {
      head: () => ({ size: PROJECT_CLOUD_CONTENT_MAX_BYTES + 1 }),
      get: () => ({
        size: PROJECT_CLOUD_CONTENT_MAX_BYTES + 1,
        body: new Response("hello").body!,
      }),
      put: async () => undefined,
    },
  });
  const response = await routes.request(
    `https://api.example.test/${await signedToken("read", now)}`,
    { headers: { range: "bytes=0-4" } },
    env(),
  );
  expect(response.status).toBe(206);
  expect(await response.text()).toBe("hello");
});
