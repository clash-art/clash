import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  createLocalAssetInspectionService,
  type LocalAssetInspector,
} from "./local-asset-inspections.js";
import { managedLocalApiApps } from "./local-api-app.test-fixtures.js";
import { clashHomeForLocalDataDir } from "./local-paths.js";

const ORIGIN = "http://127.0.0.1:49152";
const { createApp, close } = managedLocalApiApps();

const inspectFixtureAsset: LocalAssetInspector = async ({ resource }) => ({
  width: 1_280,
  height: 720,
  rotationDegrees: 0,
  contentType: resource.contentType ?? "image/png",
});

it("keeps readable Asset bytes while disclosing a failed inspection", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-inspection-error-"));
  const clashRoot = clashHomeForLocalDataDir(dataDir);
  const inspection = createLocalAssetInspectionService({
    dataDir,
    clashRoot,
    inspectResource: inspectFixtureAsset,
  });
  let failInspection = false;
  const app = createApp({
    dataDir,
    clashRoot,
    projectAssetProjectionOrigin: () => ORIGIN,
    assetInspection: {
      finalize: (input) => inspection.finalize(input),
      inspect: async (input) => {
        if (failInspection) throw new Error("ffprobe timed out");
        return inspection.inspect(input);
      },
    },
  });
  try {
    const created = await app.request(`${ORIGIN}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Inspection" }),
    });
    expect(created.status).toBe(201);
    const { id: projectId } = (await created.json()) as { id: string };

    const form = new FormData();
    form.set(
      "file",
      new File([randomBytes(4_096)], "frame.png", { type: "image/png" }),
    );
    form.set("kind", "image");
    form.set("projectAssetId", "asset:frame");
    const imported = await app.request(
      `${ORIGIN}/api/v1/projects/${projectId}/assets/import-file`,
      { method: "POST", body: form },
    );
    expect(imported.status, await imported.clone().text()).toBe(201);

    failInspection = true;
    const listed = await app.request(`${ORIGIN}/api/v1/projects`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      projects: {
        id: string;
        assets: Array<{
          id: string;
          status: string;
          metadata: { width?: number; height?: number };
          inspectionError?: { code: string; message: string };
        }>;
      }[];
    };
    const card = body.projects.find((project) => project.id === projectId);
    expect(card?.assets).toContainEqual(
      expect.objectContaining({
        id: "asset:frame",
        status: "ready",
        inspectionError: {
          code: "ASSET_INSPECTION_FAILED",
          message: "ffprobe timed out",
        },
      }),
    );
  } finally {
    await close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
