import { describe, expect, it, vi } from "vitest";

import {
  ResourceReplicationError,
  pullResource,
  pushProjectResources,
  pushResource,
  type ResourceByteStore,
} from "./resource-replication.js";
import type { AssetDeliveryPort, AssetDeliveryUrl } from "./asset-delivery.js";
import type { Resource } from "@clash/shared-types/assets";

const bytes = new TextEncoder().encode("hello");
// SHA-256("hello"), the canonical published test vector.
const digest =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const resource: Resource = {
  id: "resource-1",
  kind: "image",
  digest: { algorithm: "sha256", value: digest },
  byteLength: bytes.byteLength,
  contentType: "image/png",
};

function url(operation: "read" | "upload"): AssetDeliveryUrl {
  return {
    resourceId: resource.id,
    operation,
    purpose: operation === "read" ? "download" : "host-staging",
    method: operation === "read" ? "GET" : "PUT",
    url: `https://delivery.example.test/${operation}`,
    expiresAt: "2026-09-04T00:01:00.000Z",
  };
}

function store(
  initial?: Uint8Array,
): ResourceByteStore & { value?: Uint8Array } {
  const state: { value?: Uint8Array } = {
    ...(initial ? { value: initial.slice() } : {}),
  };
  return {
    get value() {
      return state.value;
    },
    read: vi.fn(async () => state.value?.slice()),
    write: vi.fn(async ({ bytes: next }) => {
      state.value = next.slice();
    }),
  };
}

describe("ResourceReplicator", () => {
  it("pushes local bytes through an upload URL without putting bytes in Project state", async () => {
    const local = store(bytes);
    const delivery: AssetDeliveryPort = {
      issueReadUrl: vi.fn(),
      issueUploadUrl: vi.fn(async () => url("upload")),
    };
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("PUT");
        expect(new Headers(init?.headers).has("content-length")).toBe(false);
        expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(bytes);
        return new Response(null, { status: 204 });
      },
    );

    await expect(
      pushResource({
        resource,
        local,
        delivery,
        scope: { tenantId: "tenant-1" },
        fetch,
      }),
    ).resolves.toMatchObject({ status: "uploaded", resourceId: resource.id });
    expect(delivery.issueUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: resource.id,
        byteLength: bytes.byteLength,
        digest: `sha256:${digest}`,
      }),
    );
  });

  it("pulls remote bytes, verifies digest and installs them in the local CAS", async () => {
    const local = store();
    const delivery: AssetDeliveryPort = {
      issueReadUrl: vi.fn(async () => url("read")),
      issueUploadUrl: vi.fn(),
    };
    const fetch = vi.fn(
      async () =>
        new Response(bytes.slice().buffer, {
          status: 200,
          headers: { "content-length": String(bytes.byteLength) },
        }),
    );

    await expect(
      pullResource({
        resource,
        local,
        delivery,
        scope: { tenantId: "tenant-1" },
        fetch,
      }),
    ).resolves.toMatchObject({ status: "downloaded", resourceId: resource.id });
    expect(local.value).toEqual(bytes);
    expect(local.write).toHaveBeenCalledWith({ resource, bytes });
  });

  it("does not install bytes when the remote digest is wrong", async () => {
    const local = store();
    const delivery: AssetDeliveryPort = {
      issueReadUrl: vi.fn(async () => url("read")),
      issueUploadUrl: vi.fn(),
    };
    const fetch = vi.fn(
      async () =>
        new Response(new TextEncoder().encode("tampered").buffer, {
          status: 200,
        }),
    );

    await expect(
      pullResource({
        resource,
        local,
        delivery,
        scope: { tenantId: "tenant-1" },
        fetch,
      }),
    ).rejects.toMatchObject<ResourceReplicationError>({
      code: "INTEGRITY_MISMATCH",
    });
    expect(local.write).not.toHaveBeenCalled();
  });

  it("surfaces a transient download transport failure as retryable", async () => {
    const local = store();
    const delivery: AssetDeliveryPort = {
      issueReadUrl: vi.fn(async () => url("read")),
      issueUploadUrl: vi.fn(),
    };

    await expect(
      pullResource({
        resource,
        local,
        delivery,
        scope: { tenantId: "tenant-1" },
        fetch: vi.fn(async () => {
          throw new Error("connection reset");
        }),
      }),
    ).rejects.toMatchObject<ResourceReplicationError>({
      code: "DOWNLOAD_FAILED",
    });
    expect(local.write).not.toHaveBeenCalled();
  });

  it("retries a partial Project resource admission without duplicating Resource identity", async () => {
    const second = { ...resource, id: "resource-2" };
    const local = store(bytes);
    const delivery: AssetDeliveryPort = {
      issueReadUrl: vi.fn(),
      issueUploadUrl: vi.fn(async (input) => ({
        resourceId: input.resourceId,
        operation: "upload" as const,
        purpose: "host-staging" as const,
        method: "PUT" as const,
        url: `https://delivery.example.test/${input.resourceId}`,
        expiresAt: "2026-09-04T00:01:00.000Z",
      })),
    };
    let firstUpload = true;
    const fetch = vi.fn(async () => {
      if (firstUpload) {
        firstUpload = false;
        throw new Error("temporary outage");
      }
      return new Response(null, { status: 204 });
    });
    const result = await pushProjectResources({
      resources: [resource, resource, second],
      local,
      delivery,
      scope: { tenantId: "tenant-1", projectId: "project-1" },
      fetch,
    });
    expect(result.failed).toHaveLength(1);
    expect(result.uploaded).toHaveLength(1);
    expect(new Set(result.uploaded.map((entry) => entry.resourceId))).toEqual(
      new Set(["resource-2"]),
    );
  });
});

it("rejects known oversize before opening local bytes and bounds dishonest download chunks", async () => {
  const maxBytes = bytes.byteLength;
  const local = store(bytes);
  const delivery: AssetDeliveryPort = {
    issueReadUrl: async () => url("read"),
    issueUploadUrl: async () => url("upload"),
  };
  await expect(
    pushResource({
      resource: { ...resource, byteLength: maxBytes + 1 },
      local,
      delivery,
      scope: { tenantId: "tenant" },
      maxBytes,
    }),
  ).rejects.toMatchObject({ code: "CLOUD_CONTENT_TOO_LARGE", maxBytes });
  expect(local.read).not.toHaveBeenCalled();
  const receiver = store();
  await expect(
    pullResource({
      resource,
      local: receiver,
      delivery,
      scope: { tenantId: "tenant" },
      maxBytes,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
        ),
    }),
  ).rejects.toMatchObject({ code: "CLOUD_CONTENT_TOO_LARGE", maxBytes });
  expect(receiver.write).not.toHaveBeenCalled();
});
