import { describe, expect, it, vi } from "vitest";

import {
  AssetDeliveryError,
  createAssetDeliveryPort,
  type AssetDeliverySigner,
} from "./asset-delivery.js";

const scope = { tenantId: "tenant-1", projectId: "project-1" };

function signer(
  overrides: Partial<AssetDeliverySigner> = {},
): AssetDeliverySigner {
  return {
    sign: vi.fn(async (input) => ({
      url: `https://delivery.example.test/capability/${input.resourceId}?token=opaque`,
      expiresAt: input.expiresAt,
    })),
    ...overrides,
  };
}

describe("AssetDeliveryPort", () => {
  it("issues an opaque read URL without exposing a storage locator", async () => {
    const deliverySigner = signer();
    const port = createAssetDeliveryPort({
      signer: deliverySigner,
      authorize: vi.fn(async () => true),
      now: () => Date.parse("2026-09-04T00:00:00.000Z"),
    });

    const result = await port.issueReadUrl({
      resourceId: "sha256:asset-1",
      scope,
      purpose: "preview",
    });

    expect(result).toMatchObject({
      resourceId: "sha256:asset-1",
      operation: "read",
      purpose: "preview",
      method: "GET",
      url: "https://delivery.example.test/capability/sha256:asset-1?token=opaque",
    });
    expect(result.url).not.toContain("r2");
    expect(result.url).not.toContain("s3");
    expect(deliverySigner.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "sha256:asset-1",
        operation: "read",
        method: "GET",
        purpose: "preview",
        scope,
      }),
    );
  });

  it("issues an upload URL with immutable byte assertions", async () => {
    const deliverySigner = signer();
    const port = createAssetDeliveryPort({
      signer: deliverySigner,
      authorize: vi.fn(async () => true),
      now: () => 1_700_000_000_000,
    });

    const result = await port.issueUploadUrl({
      resourceId: "sha256:asset-2",
      scope,
      purpose: "host-staging",
      byteLength: 42,
      digest: "sha256:" + "a".repeat(64),
      contentType: "image/png",
    });

    expect(result).toMatchObject({
      operation: "upload",
      method: "PUT",
      resourceId: "sha256:asset-2",
    });
    expect(deliverySigner.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "upload",
        method: "PUT",
        byteLength: 42,
        digest: "sha256:" + "a".repeat(64),
        contentType: "image/png",
      }),
    );
  });

  it("fails closed when the scope is not authorized", async () => {
    const port = createAssetDeliveryPort({
      signer: signer(),
      authorize: vi.fn(async () => false),
    });

    await expect(
      port.issueReadUrl({
        resourceId: "resource-1",
        scope,
        purpose: "download",
      }),
    ).rejects.toMatchObject<AssetDeliveryError>({ code: "FORBIDDEN" });
  });

  it("rejects malformed upload facts before asking a signer", async () => {
    const deliverySigner = signer();
    const port = createAssetDeliveryPort({
      signer: deliverySigner,
      authorize: vi.fn(async () => true),
    });

    await expect(
      port.issueUploadUrl({
        resourceId: "resource-1",
        scope,
        purpose: "host-staging",
        byteLength: -1,
        digest: "not-a-digest",
      }),
    ).rejects.toMatchObject<AssetDeliveryError>({ code: "INVALID_INPUT" });
    expect(deliverySigner.sign).not.toHaveBeenCalled();
  });

  it("rejects a signer response that is already expired", async () => {
    const deliverySigner = signer({
      sign: vi.fn(async () => ({
        url: "https://delivery.example.test/capability/expired",
        expiresAt: "2020-01-01T00:00:00.000Z",
      })),
    });
    const port = createAssetDeliveryPort({
      signer: deliverySigner,
      authorize: vi.fn(async () => true),
      now: () => Date.parse("2026-09-04T00:00:00.000Z"),
    });

    await expect(
      port.issueReadUrl({
        resourceId: "resource-1",
        scope,
        purpose: "preview",
      }),
    ).rejects.toMatchObject<AssetDeliveryError>({ code: "SIGNING_FAILED" });
  });
});
