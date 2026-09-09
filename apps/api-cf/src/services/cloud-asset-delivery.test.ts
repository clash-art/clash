import { describe, expect, it, vi } from "vitest";

import {
  createCloudAssetDeliveryPort,
  verifyCloudAssetDeliveryCapability,
} from "./cloud-asset-delivery";

describe("Cloud Asset delivery adapter", () => {
  it("issues a standalone capability URL from resource identity", async () => {
    const now = Date.parse("2026-09-04T00:00:00.000Z");
    const port = createCloudAssetDeliveryPort(
      {
        JWT_SECRET: "cloud-secret",
        WORKER_PUBLIC_URL: "https://api.example.test",
        ENVIRONMENT: "production",
      } as never,
      {
        now: () => now,
        authorize: vi.fn(async () => true),
      },
    );

    const issued = await port.issueReadUrl({
      resourceId: "resource-1",
      scope: { tenantId: "tenant-1", projectId: "project-1" },
      purpose: "provider-input",
    });

    expect(issued.url).toMatch(
      /^https:\/\/api\.example\.test\/assets\/capability\/v1\./,
    );
    expect(issued.url).not.toContain("src_r2_key");
    expect(issued.url).not.toContain("projects/");
    const token = new URL(issued.url).pathname.split("/").at(-1)!;
    await expect(
      verifyCloudAssetDeliveryCapability(
        { JWT_SECRET: "cloud-secret", ENVIRONMENT: "production" } as never,
        token,
        () => now,
      ),
    ).resolves.toMatchObject({ resourceId: "resource-1", operation: "read" });
  });

  it("requires a standalone endpoint origin instead of falling back to object storage", () => {
    expect(() =>
      createCloudAssetDeliveryPort(
        {
          JWT_SECRET: "cloud-secret",
          R2_PUBLIC_URL: "https://bucket.r2.dev",
          ENVIRONMENT: "production",
        } as never,
        { authorize: async () => true },
      ),
    ).toThrow(/origin/i);
  });
});
