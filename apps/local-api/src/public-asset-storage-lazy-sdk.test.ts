import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createLocalApiApp } from "./app.js";
import { HOST_LAZY_MODULE_LOAD_FAILED } from "./host-lazy-module.js";
import { createPublicAssetStorageService } from "./public-asset-storage.js";

// A broken installation: the lazily imported S3 SDK cannot be loaded.
vi.mock("@aws-sdk/client-s3", () => {
  throw new Error("Cannot find module '@aws-sdk/client-s3'");
});

it("answers a storage test with a coded 503 when the lazily imported S3 SDK cannot load", async () => {
  // The Host (and every unrelated route) still loads: only the storage operation that needs the
  // SDK fails, visibly and with the module named, instead of a bare 502 or a hang.
  const dataDir = await mkdtemp(join(tmpdir(), "clash-public-storage-lazy-"));
  const app = createLocalApiApp({
    dataDir,
    publicAssetStorage: createPublicAssetStorageService({ dataDir }),
  });

  const updated = await app.request("/api/v1/local/public-storage", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "byos",
      provider: "aws-s3",
      bucket: "clash-assets",
      region: "us-east-1",
      access_key_id: "AWS_ACCESS_KEY",
      secret_access_key: "AWS_SECRET_KEY",
    }),
  });
  expect(updated.status).toBe(200);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tested = await app.request("/api/v1/local/public-storage/test", {
      method: "POST",
    });
    expect(tested.status).toBe(503);
    const body = (await tested.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: HOST_LAZY_MODULE_LOAD_FAILED,
      module: "@aws-sdk/client-s3",
    });
    expect(String(body.error)).toContain("@aws-sdk/client-s3");
  }
});
