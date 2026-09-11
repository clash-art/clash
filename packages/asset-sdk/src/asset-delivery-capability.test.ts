import { describe, expect, it } from "vitest";

import {
  createHmacAssetDeliverySigner,
  verifyHmacAssetDeliveryCapability,
} from "./asset-delivery-capability.js";

describe("HMAC Asset delivery capability", () => {
  it("creates an opaque URL and round-trips only resource delivery claims", async () => {
    const now = Date.parse("2026-09-04T00:00:00.000Z");
    const signer = createHmacAssetDeliverySigner({
      secret: "test-secret",
      origin: "https://cloud.example.test/",
      now: () => now,
    });
    const signed = await signer.sign({
      operation: "read",
      method: "GET",
      resourceId: "sha256:resource-1",
      scope: {
        tenantId: "tenant-1",
        projectId: "project-1",
        localReplicaId: "machine-1",
      },
      purpose: "preview",
      expiresAt: new Date(now + 60_000).toISOString(),
    });

    expect(signed.url).toMatch(
      /^https:\/\/cloud\.example\.test\/assets\/capability\/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
    expect(signed.url).not.toContain("projects/");
    const token = new URL(signed.url).pathname.split("/").at(-1)!;
    await expect(
      verifyHmacAssetDeliveryCapability({
        secret: "test-secret",
        token,
        now: () => now,
      }),
    ).resolves.toMatchObject({
      version: 1,
      operation: "read",
      method: "GET",
      resourceId: "sha256:resource-1",
      scope: {
        tenantId: "tenant-1",
        projectId: "project-1",
        localReplicaId: "machine-1",
      },
      purpose: "preview",
    });
  });

  it("rejects tampered and expired capabilities", async () => {
    const now = Date.parse("2026-09-04T00:00:00.000Z");
    const signer = createHmacAssetDeliverySigner({
      secret: "test-secret",
      origin: "https://cloud.example.test",
      now: () => now,
    });
    const signed = await signer.sign({
      operation: "upload",
      method: "PUT",
      resourceId: "resource-2",
      scope: { tenantId: "tenant-1" },
      purpose: "host-staging",
      byteLength: 10,
      digest: "sha256:" + "b".repeat(64),
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const token = new URL(signed.url).pathname.split("/").at(-1)!;

    await expect(
      verifyHmacAssetDeliveryCapability({
        secret: "test-secret",
        token: `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`,
        now: () => now,
      }),
    ).resolves.toBeNull();
    await expect(
      verifyHmacAssetDeliveryCapability({
        secret: "test-secret",
        token,
        now: () => now + 61_000,
      }),
    ).resolves.toBeNull();
  });
});
