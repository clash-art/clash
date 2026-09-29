import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createLocalApiApp } from "./app.js";
import {
  createLocalAssetInspectionService,
  createLocalFfprobeAssetInspector,
} from "./local-asset-inspections.js";
import { createLocalAssetRepresentationService } from "./local-asset-representations.js";
import { localFfmpegPath, localFfprobePath } from "./local-media-binaries.js";

const execFileAsync = promisify(execFile);

describe("imported file formats are decoded instead of asserted from names", () => {
  for (const scope of ["project", "global"] as const) {
    it(`${scope} imports preserve QuickTime bytes named MP4 and serve their decoded media type`, async () => {
      const root = await mkdtemp(join(tmpdir(), "clash-import-format-"));
      const dataDir = join(root, "local-api");
      const assetInspection = createLocalAssetInspectionService({
        dataDir,
        clashRoot: root,
        inspectResource: createLocalFfprobeAssetInspector({
          ffprobePath: localFfprobePath()!,
        }),
      });
      const assetRepresentations = createLocalAssetRepresentationService({
        dataDir,
        clashRoot: root,
        assetInspection,
      });
      try {
        const app = createLocalApiApp({
          dataDir,
          clashRoot: root,
          userId: "local-user",
          assetInspection,
          assetRepresentations,
        });
        const filePath = join(root, "actual.mov");
        await execFileAsync(localFfmpegPath()!, [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=32x24:d=0.2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-f",
          "mov",
          filePath,
        ]);
        const bytes = await readFile(filePath);
        const collection =
          scope === "project"
            ? "/api/v1/projects/format-project/assets"
            : "/api/v1/libraries/personal/assets";
        const form = new FormData();
        form.set(
          "file",
          new File([bytes], "3377_raw.MP4", { type: "video/mp4" }),
        );
        form.set("kind", "video");
        form.set(
          scope === "project" ? "projectAssetId" : "globalAssetId",
          "imported-video",
        );
        const response = await app.request(`${collection}/import-file`, {
          method: "POST",
          body: form,
        });
        expect(response.status, await response.clone().text()).toBe(201);
        const asset = await response.json();
        expect(asset.metadata).toMatchObject({
          contentType: "video/quicktime",
          originalName: "3377_raw.MP4",
          width: 32,
          height: 24,
        });
        const media = await app.request(`${collection}/${asset.id}/media`);
        expect(media.status).toBe(200);
        expect(media.headers.get("content-type")).toBe("video/quicktime");
        expect(Buffer.from(await media.arrayBuffer())).toEqual(bytes);

        // A declared video MIME still cannot make non-video bytes publishable.
        const invalid = new FormData();
        invalid.set(
          "file",
          new File(["not media"], "broken.mp4", { type: "video/mp4" }),
        );
        invalid.set("kind", "video");
        invalid.set(
          scope === "project" ? "projectAssetId" : "globalAssetId",
          "broken-video",
        );
        const rejected = await app.request(`${collection}/import-file`, {
          method: "POST",
          body: invalid,
        });
        expect(rejected.ok).toBe(false);
        const listed = await (await app.request(collection)).json();
        expect(listed.assets.map((entry: { id: string }) => entry.id)).toEqual([
          asset.id,
        ]);
      } finally {
        await assetRepresentations.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
