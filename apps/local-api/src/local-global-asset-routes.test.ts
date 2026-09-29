import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

import {
  createProjectAsset,
  markActionAssetBindingAuthority,
  markProjectAssetAuthority,
  type ResolvedAsset,
} from "@clash/shared-types";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalApiApp } from "./app.js";
import {
  createLocalAssetInspectionService,
  createLocalFfprobeAssetInspector,
  type LocalAssetInspector,
} from "./local-asset-inspections.js";
import {
  createLocalAssetRepresentationService,
  type LocalAssetRepresentationService,
} from "./local-asset-representations.js";
import { createLocalGlobalAssetService } from "./local-global-assets.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import { createLocalProjectAssetService } from "./local-project-assets.js";
import { FileReplicaStore } from "./loro/file-replica-store.js";
import { localFfmpegPath, localFfprobePath } from "./local-media-binaries.js";

const temporaryDirectories: string[] = [];
const representationServices: LocalAssetRepresentationService[] = [];
const origin = "http://127.0.0.1:49152";

async function fixture(
  options: {
    inspectAssetResource?: LocalAssetInspector;
  } = {},
) {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-global-routes-"));
  temporaryDirectories.push(clashRoot);
  const dataDir = join(clashRoot, "local-api");
  const inspectAssetResource: LocalAssetInspector =
    options.inspectAssetResource ??
    (async ({ resource }) =>
      resource.kind === "image"
        ? {
            width: 1,
            height: 1,
            rotationDegrees: 0,
            contentType: resource.contentType ?? "image/png",
          }
        : resource.kind === "video"
          ? {
              width: 1,
              height: 1,
              rotationDegrees: 0,
              durationMs: 1_000,
              frameRate: 24,
              videoCodec: "h264",
              hasAudio: false,
              contentType: resource.contentType ?? "video/mp4",
            }
          : resource.kind === "audio"
            ? {
                durationMs: 1_000,
                hasAudio: true,
                audioCodec: "aac",
                sampleRate: 48_000,
                channelCount: 2,
                channelLayout: "stereo",
                contentType: resource.contentType ?? "audio/mpeg",
              }
            : resource.contentType
              ? { contentType: resource.contentType }
              : {});
  const assetInspection = createLocalAssetInspectionService({
    dataDir,
    clashRoot,
    inspectResource: inspectAssetResource,
  });
  const assetRepresentations = createLocalAssetRepresentationService({
    dataDir,
    clashRoot,
    assetInspection,
  });
  representationServices.push(assetRepresentations);
  const app = createLocalApiApp({
    dataDir,
    clashRoot,
    userId: "local-user",
    projectAssetProjectionOrigin: origin,
    assetInspection,
    assetRepresentations,
  });
  return { app, clashRoot, dataDir };
}

const execFileAsync = promisify(execFile);

function mediaForm(name: string, type: string, kind: string, value: BlobPart) {
  const form = new FormData();
  form.set("file", new File([value], name, { type }));
  form.set("kind", kind);
  return form;
}

function projectMediaForm(
  projectAssetId: string,
  name: string,
  type: string,
  kind: string,
  value: BlobPart,
) {
  const form = mediaForm(name, type, kind, value);
  form.set("projectAssetId", projectAssetId);
  return form;
}

function globalMediaForm(
  globalAssetId: string,
  name: string,
  type: string,
  kind: string,
  value: BlobPart,
) {
  const form = mediaForm(name, type, kind, value);
  form.set("globalAssetId", globalAssetId);
  return form;
}

function expectStorageNeutralHttpShape(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(
    /"(?:resourceId|storageKey|path|signedUrl|srcR2Key|localBlobKey)"\s*:/,
  );
}

afterEach(async () => {
  await Promise.all(
    representationServices.splice(0).map((service) => service.close()),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("personal Global Asset routes", () => {
  it("derives and serves an authorized image thumbnail without changing the source Asset", async () => {
    const { app } = await fixture();
    const projectCollection = `${origin}/api/v1/projects/project-thumbnail/assets`;
    const sourceBytes = await sharp({
      create: {
        width: 12,
        height: 8,
        channels: 3,
        background: { r: 220, g: 40, b: 60 },
      },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(sourceBytes)], "source.png", {
        type: "image/png",
      }),
    );
    form.set("kind", "image");
    form.set("projectAssetId", "asset:thumbnail-source");

    const imported = await app.request(`${projectCollection}/import-file`, {
      method: "POST",
      body: form,
    });
    expect(imported.status, await imported.clone().text()).toBe(201);

    let asset = (await imported.json()) as ResolvedAsset;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (asset.thumbnailUrl?.endsWith("/thumbnail")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const read = await app.request(
        `${projectCollection}/${encodeURIComponent(asset.id)}`,
      );
      expect(read.status, await read.clone().text()).toBe(200);
      asset = (await read.json()) as ResolvedAsset;
    }

    expect(asset.thumbnailUrl).toBe(
      `${projectCollection}/${encodeURIComponent(asset.id)}/thumbnail`,
    );
    expect(asset.url).toBe(
      `${projectCollection}/${encodeURIComponent(asset.id)}/media`,
    );
    const thumbnail = await app.request(asset.thumbnailUrl!);
    expect(thumbnail.status, await thumbnail.clone().text()).toBe(200);
    expect(thumbnail.headers.get("content-type")).toBe("image/webp");
    const metadata = await sharp(await thumbnail.arrayBuffer()).metadata();
    expect(metadata).toMatchObject({ width: 12, height: 8, format: "webp" });
  });

  it("rejects a multipart import without a stable Global Asset id before publishing an Asset", async () => {
    const { app } = await fixture();
    const collection = `${origin}/api/v1/libraries/personal/assets`;
    const response = await app.request(`${collection}/import-file`, {
      method: "POST",
      body: mediaForm("voice.mp3", "audio/mpeg", "audio", "0123456789"),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Global Asset import requires file, kind, and globalAssetId",
      code: "INVALID_GLOBAL_ASSET_IMPORT",
    });
    const listed = await app.request(collection);
    await expect(listed.json()).resolves.toEqual({ assets: [] });
  });

  it("derives canonical media types from bytes for empty-MIME browser uploads", async () => {
    const { app, clashRoot } = await fixture({
      inspectAssetResource: createLocalFfprobeAssetInspector({ ffprobePath: localFfprobePath()! }),
    });
    const collection = `${origin}/api/v1/libraries/personal/assets`;
    const videoPath = join(clashRoot, "clip.m4v");
    const audioPath = join(clashRoot, "voice.ogg");
    await execFileAsync(localFfmpegPath()!, ["-v", "error", "-f", "lavfi", "-i", "color=s=32x24:d=0.2", "-pix_fmt", "yuv420p", "-f", "mp4", videoPath]);
    await execFileAsync(localFfmpegPath()!, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "libvorbis", audioPath]);
    const video = await app.request(`${collection}/import-file`, {
      method: "POST",
      body: globalMediaForm(
        "global:empty-mime-video",
        "clip.m4v",
        "",
        "video",
        await readFile(videoPath),
      ),
    });
    const audio = await app.request(`${collection}/import-file`, {
      method: "POST",
      body: globalMediaForm(
        "global:empty-mime-audio",
        "voice.ogg",
        "",
        "audio",
        await readFile(audioPath),
      ),
    });

    expect(video.status, await video.clone().text()).toBe(201);
    expect(audio.status, await audio.clone().text()).toBe(201);
    expect((await video.json()).metadata.contentType).toBe("video/mp4");
    expect((await audio.json()).metadata.contentType).toBe("audio/ogg");
  });

  it("enriches Project and Global entries from one Resource inspection without synchronizing storage facts", async () => {
    let probes = 0;
    const { app } = await fixture({
      inspectAssetResource: async () => {
        probes += 1;
        return {
          contentType: "video/mp4",
          width: 1280,
          height: 720,
          rotationDegrees: 0,
          durationMs: 3_000,
          frameRate: 30,
          videoCodec: "h264",
          hasAudio: true,
          audioCodec: "aac",
          sampleRate: 48_000,
          channelCount: 2,
          channelLayout: "stereo",
        };
      },
    });
    const projectCollection = `${origin}/api/v1/projects/project-inspection/assets`;
    const globalCollection = `${origin}/api/v1/libraries/personal/assets`;
    const imported = await app.request(`${projectCollection}/import-file`, {
      method: "POST",
      body: projectMediaForm(
        "asset:inspection-source",
        "inspected.mp4",
        "video/mp4",
        "video",
        "one inspected Resource",
      ),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const projectAsset = (await imported.json()) as ResolvedAsset;
    expect(projectAsset.metadata).toMatchObject({
      width: 1280,
      height: 720,
      durationMs: 3_000,
      frameRate: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      contentType: "video/mp4",
    });
    expectStorageNeutralHttpShape(projectAsset);

    const published = await app.request(`${globalCollection}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "project-inspection",
        projectAssetId: projectAsset.id,
      }),
    });
    expect(published.status, await published.clone().text()).toBe(201);
    const globalAsset = (await published.json()) as ResolvedAsset;
    expect(globalAsset.metadata).toMatchObject(projectAsset.metadata);
    expectStorageNeutralHttpShape(globalAsset);
    expect(probes).toBe(1);
  });

  it("leaves staged bytes retryable without publishing an Asset when the required probe fails", async () => {
    let probes = 0;
    const { app } = await fixture({
      inspectAssetResource: async () => {
        probes += 1;
        if (probes === 1) throw new Error("temporary decoder failure");
        return {
          contentType: "video/mp4",
          width: 1_280,
          height: 720,
          rotationDegrees: 0,
          durationMs: 3_000,
          frameRate: 30,
          videoCodec: "h264",
          hasAudio: false,
        };
      },
    });
    const collection = `${origin}/api/v1/projects/project-probe-failure/assets`;
    const projectAssetId = "asset:probe-retry";
    const importBody = () => {
      const form = mediaForm(
        "still-readable.mp4",
        "video/mp4",
        "video",
        "temporarily unprobeable bytes",
      );
      form.set("projectAssetId", projectAssetId);
      return form;
    };
    const imported = await app.request(`${collection}/import-file`, {
      method: "POST",
      body: importBody(),
    });
    expect(imported.status).toBe(500);

    const absent = await app.request(
      `${collection}/${encodeURIComponent(projectAssetId)}`,
    );
    expect(absent.status).toBe(404);

    const retried = await app.request(`${collection}/import-file`, {
      method: "POST",
      body: importBody(),
    });
    expect(retried.status, await retried.clone().text()).toBe(201);
    await expect(retried.json()).resolves.toMatchObject({
      status: "ready",
      kind: "video",
      id: projectAssetId,
      metadata: {
        width: 1_280,
        height: 720,
        durationMs: 3_000,
        frameRate: 30,
        videoCodec: "h264",
      },
    });
    expect(probes).toBe(2);
  });

  it("derives one video poster representation for Project and Global authorized reads", async () => {
    const { app, clashRoot, dataDir } = await fixture();
    const projectCollection = `${origin}/api/v1/projects/project-poster/assets`;
    const globalCollection = `${origin}/api/v1/libraries/personal/assets`;
    const videoPath = join(clashRoot, "poster-source.mp4");
    const ffmpeg = localFfmpegPath();
    expect(ffmpeg).not.toBeNull();
    await execFileAsync(ffmpeg!, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x3b82f6:s=20x12:d=0.25",
      "-pix_fmt",
      "yuv420p",
      "-y",
      videoPath,
    ]);
    const videoBytes = await readFile(videoPath);
    const imported = await app.request(`${projectCollection}/import-file`, {
      method: "POST",
      body: projectMediaForm(
        "asset:poster-source",
        "source.mp4",
        "video/mp4",
        "video",
        videoBytes,
      ),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const projectAsset = (await imported.json()) as ResolvedAsset;
    expectStorageNeutralHttpShape(projectAsset);

    const projectPoster = await app.request(
      `${projectCollection}/${encodeURIComponent(projectAsset.id)}/thumbnail`,
    );
    expect(projectPoster.status, await projectPoster.clone().text()).toBe(200);
    expect(projectPoster.headers.get("content-type")).toBe("image/webp");
    await expect(
      sharp(await projectPoster.clone().arrayBuffer()).metadata(),
    ).resolves.toMatchObject({ width: 20, height: 12, format: "webp" });

    const published = await app.request(`${globalCollection}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "project-poster",
        projectAssetId: projectAsset.id,
      }),
    });
    expect(published.status, await published.clone().text()).toBe(201);
    const globalAsset = (await published.json()) as ResolvedAsset;
    expect(globalAsset.thumbnailUrl).toBe(
      `${globalCollection}/${encodeURIComponent(globalAsset.id)}/thumbnail`,
    );
    expectStorageNeutralHttpShape(globalAsset);

    const globalPoster = await app.request(
      `${globalCollection}/${encodeURIComponent(globalAsset.id)}/thumbnail`,
    );
    expect(globalPoster.status, await globalPoster.clone().text()).toBe(200);
    expect(
      createHash("sha256")
        .update(new Uint8Array(await projectPoster.arrayBuffer()))
        .digest("hex"),
    ).toBe(
      createHash("sha256")
        .update(new Uint8Array(await globalPoster.arrayBuffer()))
        .digest("hex"),
    );

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(dataDir, "local.sqlite"));
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM local_asset_representations WHERE source_resource_id = (SELECT resource_id FROM local_resources WHERE kind = 'video' LIMIT 1)",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("derives a bounded audio waveform behind an authorized Asset URL", async () => {
    const { app, clashRoot } = await fixture();
    const projectCollection = `${origin}/api/v1/projects/project-waveform/assets`;
    const globalCollection = `${origin}/api/v1/libraries/personal/assets`;
    const audioPath = join(clashRoot, "waveform-source.wav");
    const ffmpeg = localFfmpegPath();
    expect(ffmpeg).not.toBeNull();
    await execFileAsync(ffmpeg!, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.25",
      "-c:a",
      "pcm_s16le",
      "-y",
      audioPath,
    ]);
    const imported = await app.request(`${projectCollection}/import-file`, {
      method: "POST",
      body: projectMediaForm(
        "asset:waveform-source",
        "source.wav",
        "audio/wav",
        "audio",
        await readFile(audioPath),
      ),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const asset = (await imported.json()) as ResolvedAsset & {
      waveformUrl?: string;
    };

    const waveformUrl = `${projectCollection}/${encodeURIComponent(asset.id)}/waveform`;
    const waveform = await app.request(waveformUrl);
    expect(waveform.status, await waveform.clone().text()).toBe(200);
    const payload = (await waveform.json()) as {
      recipe: string;
      peaks: number[];
    };
    expect(payload.recipe).toMatch(/^audio-waveform\/v1:/);
    expect(payload.peaks).toHaveLength(128);
    expect(Math.max(...payload.peaks)).toBe(1);
    expect(payload.peaks.some((peak) => peak > 0.25)).toBe(true);

    const read = await app.request(
      `${projectCollection}/${encodeURIComponent(asset.id)}`,
    );
    expect(read.status, await read.clone().text()).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ waveformUrl });

    const published = await app.request(`${globalCollection}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "project-waveform",
        projectAssetId: asset.id,
      }),
    });
    expect(published.status, await published.clone().text()).toBe(201);
    const globalAsset = (await published.json()) as ResolvedAsset & {
      waveformUrl?: string;
    };
    const globalWaveformUrl = `${globalCollection}/${encodeURIComponent(
      globalAsset.id,
    )}/waveform`;
    expect(globalAsset.waveformUrl).toBe(globalWaveformUrl);
    const globalWaveform = await app.request(globalWaveformUrl);
    expect(globalWaveform.status, await globalWaveform.clone().text()).toBe(
      200,
    );
    await expect(globalWaveform.json()).resolves.toEqual(payload);
  });

  it("keeps Project cover identity independent from this device's byte availability", async () => {
    const { app, clashRoot, dataDir } = await fixture();
    const created = await app.request(`${origin}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Unavailable cover" }),
    });
    const { id: projectId } = (await created.json()) as { id: string };
    await new FileReplicaStore(join(dataDir, "projects")).updateSnapshotAtomic(
      projectId,
      (doc) => {
        expect(
          createProjectAsset(doc, {
            id: "cover-on-another-device",
            kind: "image",
            source: {
              kind: "linked",
              resourceId: `sha256:${"a".repeat(64)}`,
              origin: {
                scope: "global",
                libraryId: "personal",
                entryId: "global-on-another-device",
              },
            },
            lifecycle: { state: "active" },
            metadata: { contentType: "image/png" },
          }),
        ).toMatchObject({ ok: true });
        expect(markProjectAssetAuthority(doc)).toMatchObject({ ok: true });
        expect(markActionAssetBindingAuthority(doc)).toMatchObject({
          ok: true,
        });
        return { value: undefined };
      },
    );
    const unavailable = await createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: origin,
    }).read(projectId, "cover-on-another-device");
    expect(unavailable).not.toBeNull();
    expect(unavailable?.status).toBe("unavailable");
    if (!unavailable) throw new Error("Expected unavailable Project Asset");

    const response = await app.request(
      `${origin}/api/v1/projects/${encodeURIComponent(projectId)}/cover`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ coverAssetId: unavailable.id }),
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      coverAssetId: unavailable.id,
    });
  });

  it("uses Project-scoped ResolvedAsset previews for project list and detail reads", async () => {
    const { app } = await fixture();
    const created = await app.request(`${origin}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Resolved previews" }),
    });
    const { id: projectId } = (await created.json()) as { id: string };
    const projectCollection = `${origin}/api/v1/projects/${encodeURIComponent(projectId)}/assets`;
    const imported = await app.request(`${projectCollection}/import-file`, {
      method: "POST",
      body: projectMediaForm(
        "asset:project-cover",
        "cover.png",
        "image/png",
        "image",
        "project-cover",
      ),
    });
    const asset = (await imported.json()) as ResolvedAsset;
    const cover = await app.request(
      `${origin}/api/v1/projects/${encodeURIComponent(projectId)}/cover`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ coverAssetId: asset.id }),
      },
    );
    expect(cover.status, await cover.clone().text()).toBe(200);

    const list = await app.request(`${origin}/api/v1/projects`);
    expect(list.status, await list.clone().text()).toBe(200);
    const listBody = (await list.json()) as {
      projects: Array<{ id: string; assets: ResolvedAsset[] }>;
    };
    expect(
      listBody.projects.find((project) => project.id === projectId)?.assets,
    ).toEqual([asset]);

    const detail = await app.request(
      `${origin}/api/v1/projects/${encodeURIComponent(projectId)}`,
    );
    const detailBody = (await detail.json()) as { assets: ResolvedAsset[] };
    expect(detailBody.assets).toEqual([asset]);
    expect(JSON.stringify(detailBody.assets)).not.toMatch(
      /srcR2Key|storageKey|signedUrl|localBlobKey|path/,
    );
  });

  it("imports, lists, reads, serves, trashes, and restores one storage-neutral shape", async () => {
    const { app } = await fixture();
    const collection = `${origin}/api/v1/libraries/personal/assets`;
    const imported = await app.request(`${collection}/import-file`, {
      method: "POST",
      body: globalMediaForm(
        "global:voice",
        "voice.mp3",
        "audio/mpeg",
        "audio",
        "0123456789",
      ),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const asset = (await imported.json()) as ResolvedAsset;
    expect(asset).toMatchObject({
      kind: "audio",
      name: "voice.mp3",
      metadata: {
        bytes: 10,
        contentType: "audio/mpeg",
        originalName: "voice.mp3",
      },
      provenance: { kind: "import" },
      status: "ready",
    });
    expect(asset.url).toBe(
      `${collection}/${encodeURIComponent(asset.id)}/media`,
    );
    expect(asset).not.toHaveProperty("thumbnailUrl");
    expect(JSON.stringify(asset)).not.toMatch(
      /resourceId|storageKey|srcR2Key|signedUrl|localBlobKey|path/,
    );

    const listed = await app.request(collection);
    await expect(listed.json()).resolves.toEqual({ assets: [asset] });
    const read = await app.request(
      `${collection}/${encodeURIComponent(asset.id)}`,
    );
    await expect(read.json()).resolves.toEqual(asset);

    const media = await app.request(asset.url!, {
      headers: { range: "bytes=2-5" },
    });
    expect(media.status).toBe(206);
    expect(media.headers.get("content-type")).toBe("audio/mpeg");
    expect(media.headers.get("content-range")).toBe("bytes 2-5/10");
    await expect(media.text()).resolves.toBe("2345");

    const trashed = await app.request(
      `${collection}/${encodeURIComponent(asset.id)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOperationId: "delete:voice-test" }),
      },
    );
    expect(trashed.status).toBe(200);
    await expect(trashed.json()).resolves.toMatchObject({
      id: asset.id,
      status: "unavailable",
    });

    const restored = await app.request(
      `${collection}/${encodeURIComponent(asset.id)}/restore`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOperationId: "delete:voice-test" }),
      },
    );
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      id: asset.id,
      status: "ready",
      url: asset.url,
    });
  });

  it("uses the observed delete operation as the restore CAS boundary", async () => {
    const { app } = await fixture();
    const collection = `${origin}/api/v1/libraries/personal/assets`;
    const imported = await app.request(`${collection}/import-file`, {
      method: "POST",
      body: globalMediaForm(
        "global:restore-cas-route",
        "restore.png",
        "image/png",
        "image",
        "restore route bytes",
      ),
    });
    const asset = (await imported.json()) as ResolvedAsset;
    const assetUrl = `${collection}/${encodeURIComponent(asset.id)}`;
    const trash = (deleteOperationId: string) =>
      app.request(assetUrl, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOperationId }),
      });
    const restore = (deleteOperationId: string) =>
      app.request(`${assetUrl}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOperationId }),
      });

    expect((await trash("delete:route-1")).status).toBe(200);
    const observed = (await (
      await app.request(assetUrl)
    ).json()) as ResolvedAsset;
    expect(observed.lifecycle).toMatchObject({
      state: "trashed",
      deleteOperationId: "delete:route-1",
    });
    expect((await restore("delete:route-1")).status).toBe(200);
    expect((await trash("delete:route-2")).status).toBe(200);

    const stale = await restore("delete:route-1");
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: "GLOBAL_ASSET_FACT_MISMATCH",
    });
    const current = (await (
      await app.request(assetUrl)
    ).json()) as ResolvedAsset;
    expect(current.lifecycle).toMatchObject({
      state: "trashed",
      deleteOperationId: "delete:route-2",
    });
  });

  it("returns the canonical not-found code for unknown Global Asset lifecycle mutations", async () => {
    const { app } = await fixture();
    const restored = await app.request(
      `${origin}/api/v1/libraries/personal/assets/global%3Amissing/restore`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOperationId: "delete:observed" }),
      },
    );
    const trashed = await app.request(
      `${origin}/api/v1/libraries/personal/assets/global%3Amissing`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOperationId: "delete:observed" }),
      },
    );

    for (const response of [restored, trashed]) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "Global Asset not found",
        code: "GLOBAL_ASSET_NOT_FOUND",
      });
    }
  });

  it("uses a client Global Asset id to make import retries idempotent and rejects different facts", async () => {
    const { app } = await fixture();
    const collection = `${origin}/api/v1/libraries/personal/assets`;
    const globalAssetId = "global:client-import-retry";
    const importAsset = (value: string) =>
      app.request(`${collection}/import-file`, {
        method: "POST",
        body: globalMediaForm(
          globalAssetId,
          "retry.png",
          "image/png",
          "image",
          value,
        ),
      });

    const first = await importAsset("stable import bytes");
    const second = await importAsset("stable import bytes");
    expect(first.status, await first.clone().text()).toBe(201);
    expect(second.status, await second.clone().text()).toBe(201);
    const firstAsset = (await first.json()) as ResolvedAsset;
    const secondAsset = (await second.json()) as ResolvedAsset;
    expect(firstAsset.id).toBe(globalAssetId);
    expect(secondAsset).toEqual(firstAsset);

    const listed = await app.request(collection);
    await expect(listed.json()).resolves.toEqual({ assets: [firstAsset] });

    const conflicting = await importAsset("different immutable bytes");
    expect(conflicting.status, await conflicting.clone().text()).toBe(409);
    await expect(conflicting.json()).resolves.toMatchObject({
      code: "GLOBAL_ASSET_FACT_MISMATCH",
    });
  });

  it("requires one stable delete operation and returns the first trash result on retry", async () => {
    const { app } = await fixture();
    const collection = `${origin}/api/v1/libraries/personal/assets`;
    const imported = await app.request(`${collection}/import-file`, {
      method: "POST",
      body: globalMediaForm(
        "global:client-delete-retry",
        "delete-retry.png",
        "image/png",
        "image",
        "delete retry bytes",
      ),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const asset = (await imported.json()) as ResolvedAsset;
    const assetUrl = `${collection}/${encodeURIComponent(asset.id)}`;

    const missingOperation = await app.request(assetUrl, { method: "DELETE" });
    expect(missingOperation.status, await missingOperation.clone().text()).toBe(
      400,
    );
    await expect(missingOperation.json()).resolves.toEqual({
      error: "deleteOperationId is required",
      code: "INVALID_GLOBAL_ASSET_TRASH",
    });

    const trash = (deleteOperationId: string) =>
      app.request(assetUrl, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOperationId }),
      });
    const first = await trash("delete:client-retry");
    const second = await trash("delete:client-retry");
    expect(first.status, await first.clone().text()).toBe(200);
    expect(second.status, await second.clone().text()).toBe(200);
    const firstResult = (await first.json()) as ResolvedAsset;
    const secondResult = (await second.json()) as ResolvedAsset;
    expect(firstResult.lifecycle).toMatchObject({
      state: "trashed",
      deleteOperationId: "delete:client-retry",
    });
    expect(secondResult).toEqual(firstResult);

    const conflicting = await trash("delete:another-operation");
    expect(conflicting.status, await conflicting.clone().text()).toBe(409);
    await expect(conflicting.json()).resolves.toMatchObject({
      code: "GLOBAL_ASSET_FACT_MISMATCH",
    });
  });

  it("publishes and admits independent entry identities over one immutable Resource", async () => {
    const { app, clashRoot, dataDir } = await fixture();
    const projectCollection = `${origin}/api/v1/projects/project-a/assets`;
    const globalCollection = `${origin}/api/v1/libraries/personal/assets`;
    const imported = await app.request(`${projectCollection}/import-file`, {
      method: "POST",
      body: projectMediaForm(
        "asset:publish-source",
        "hero.png",
        "image/png",
        "image",
        "same-image-bytes",
      ),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const projectSource = (await imported.json()) as ResolvedAsset;

    const published = await app.request(`${globalCollection}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "project-a",
        projectAssetId: projectSource.id,
      }),
    });
    expect(published.status, await published.clone().text()).toBe(201);
    const globalAsset = (await published.json()) as ResolvedAsset;
    expect(globalAsset.id).not.toBe(projectSource.id);

    const admitted = await app.request(`${projectCollection}/admit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalAssetId: globalAsset.id }),
    });
    expect(admitted.status, await admitted.clone().text()).toBe(201);
    const projectLink = (await admitted.json()) as ResolvedAsset;
    expect(
      new Set([projectSource.id, globalAsset.id, projectLink.id]).size,
    ).toBe(3);

    const projects = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: origin,
    });
    const globals = createLocalGlobalAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: origin,
    });
    const sourceEntry = await projects.readEntry("project-a", projectSource.id);
    const globalEntry = await globals.readEntry("personal", globalAsset.id);
    const linkedEntry = await projects.readEntry("project-a", projectLink.id);
    expect(sourceEntry?.source.kind).toBe("owned");
    expect(globalEntry?.resourceId).toBe(sourceEntry?.source.resourceId);
    expect(linkedEntry?.source).toEqual({
      kind: "linked",
      resourceId: sourceEntry?.source.resourceId,
      origin: {
        scope: "global",
        libraryId: "personal",
        entryId: globalAsset.id,
      },
    });

    const sourceProjection = await projects.openProjection(
      "project-a",
      projectSource.id,
    );
    const globalProjection = await globals.openProjection(
      "personal",
      globalAsset.id,
    );
    const linkedProjection = await projects.openProjection(
      "project-a",
      projectLink.id,
    );
    expect(globalProjection.path).toBe(sourceProjection.path);
    expect(linkedProjection.path).toBe(sourceProjection.path);

    await app.request(
      `${globalCollection}/${encodeURIComponent(globalAsset.id)}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOperationId: "delete:shared-link-test" }),
      },
    );
    const linkedMedia = await app.request(projectLink.url!);
    expect(linkedMedia.status).toBe(200);
    await expect(linkedMedia.text()).resolves.toBe("same-image-bytes");
  });

  it("returns one independent Global entry when Project publication is retried", async () => {
    const { app } = await fixture();
    const projectCollection = `${origin}/api/v1/projects/project-publish-retry/assets`;
    const globalCollection = `${origin}/api/v1/libraries/personal/assets`;
    const imported = await app.request(`${projectCollection}/import-file`, {
      method: "POST",
      body: projectMediaForm(
        "asset:publish-retry-source",
        "publish-once.png",
        "image/png",
        "image",
        "publish retry bytes",
      ),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const projectAsset = (await imported.json()) as ResolvedAsset;
    const publish = () =>
      app.request(`${globalCollection}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "project-publish-retry",
          projectAssetId: projectAsset.id,
        }),
      });

    const first = await publish();
    const second = await publish();
    expect(first.status, await first.clone().text()).toBe(201);
    expect(second.status, await second.clone().text()).toBe(201);
    const firstAsset = (await first.json()) as ResolvedAsset;
    const secondAsset = (await second.json()) as ResolvedAsset;
    expect(secondAsset.id).toBe(firstAsset.id);
    expect(firstAsset.id).not.toBe(projectAsset.id);

    const listed = await app.request(globalCollection);
    const body = (await listed.json()) as { assets: ResolvedAsset[] };
    expect(body.assets.map((asset) => asset.id)).toEqual([firstAsset.id]);
  });

  it("returns one Project-local linked entry when Global admission is retried", async () => {
    const { app } = await fixture();
    const globalCollection = `${origin}/api/v1/libraries/personal/assets`;
    const projectCollection = `${origin}/api/v1/projects/project-admit-retry/assets`;
    const imported = await app.request(`${globalCollection}/import-file`, {
      method: "POST",
      body: globalMediaForm(
        "global:admit-retry-source",
        "admit-once.png",
        "image/png",
        "image",
        "admit retry bytes",
      ),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const globalAsset = (await imported.json()) as ResolvedAsset;
    const admit = () =>
      app.request(`${projectCollection}/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ globalAssetId: globalAsset.id }),
      });

    const first = await admit();
    const second = await admit();
    expect(first.status, await first.clone().text()).toBe(201);
    expect(second.status, await second.clone().text()).toBe(201);
    const firstAsset = (await first.json()) as ResolvedAsset;
    const secondAsset = (await second.json()) as ResolvedAsset;
    expect(secondAsset.id).toBe(firstAsset.id);
    expect(firstAsset.id).not.toBe(globalAsset.id);

    const listed = await app.request(projectCollection);
    const body = (await listed.json()) as { assets: ResolvedAsset[] };
    expect(body.assets.map((asset) => asset.id)).toEqual([firstAsset.id]);
  });

  it("edits an admitted link into a new owned Project Asset without changing the link", async () => {
    const { app, clashRoot, dataDir } = await fixture();
    const projectId = "project-linked-edit";
    const globalCollection = `${origin}/api/v1/libraries/personal/assets`;
    const projectCollection = `${origin}/api/v1/projects/${projectId}/assets`;
    const imported = await app.request(`${globalCollection}/import-file`, {
      method: "POST",
      body: globalMediaForm(
        "global:linked-edit-source",
        "linked-source.png",
        "image/png",
        "image",
        "linked source bytes",
      ),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const globalAsset = (await imported.json()) as ResolvedAsset;
    const admitted = await app.request(`${projectCollection}/admit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalAssetId: globalAsset.id }),
    });
    expect(admitted.status, await admitted.clone().text()).toBe(201);
    const linked = (await admitted.json()) as ResolvedAsset;
    const projects = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: origin,
    });
    const before = await projects.readEntry(projectId, linked.id);
    expect(before?.source).toMatchObject({
      kind: "linked",
      origin: {
        scope: "global",
        libraryId: "personal",
        entryId: globalAsset.id,
      },
    });

    const invocation = {
      actionId: "image-editor",
      projectId,
      source: { assetId: linked.id, kind: "image" },
      params: { rotation: 90 },
      surface: "asset-preview",
      mode: "implicit",
    };
    const editForm = new FormData();
    editForm.set(
      "file",
      new File(["edited linked bytes"], "edited-linked.png", {
        type: "image/png",
      }),
    );
    editForm.set("projectId", projectId);
    editForm.set("sourceAssetId", linked.id);
    editForm.set("editKind", "image-editor");
    editForm.set("outputKind", "image");
    editForm.set("editParams", JSON.stringify(invocation.params));
    editForm.set("origin", "asset-preview");
    editForm.set("invocation", JSON.stringify(invocation));
    editForm.set("actionRunId", "edit:global-linked-source-1");
    const edited = await app.request("/api/v1/edits", {
      method: "POST",
      body: editForm,
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const output = (await edited.json()) as ResolvedAsset;

    expect(output.id).not.toBe(linked.id);
    expect(await projects.readEntry(projectId, linked.id)).toEqual(before);
    await expect(
      projects.readEntry(projectId, output.id),
    ).resolves.toMatchObject({
      source: { kind: "owned" },
      provenance: { kind: "edit" },
    });
  });

  it("preserves admitted media across the referenced delete, unbind, trash, and restore journey", async () => {
    const { app, clashRoot, dataDir } = await fixture();
    const projectId = "project-journey";
    const globalCollection = `${origin}/api/v1/libraries/personal/assets`;
    const projectCollection = `${origin}/api/v1/projects/${projectId}/assets`;

    const imported = await app.request(`${globalCollection}/import-file`, {
      method: "POST",
      body: globalMediaForm(
        "global:journey-source",
        "journey.mp3",
        "audio/mpeg",
        "audio",
        "immutable-journey-audio",
      ),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const globalAsset = (await imported.json()) as ResolvedAsset;
    expectStorageNeutralHttpShape(globalAsset);

    const admitted = await app.request(`${projectCollection}/admit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalAssetId: globalAsset.id }),
    });
    expect(admitted.status, await admitted.clone().text()).toBe(201);
    const projectAsset = (await admitted.json()) as ResolvedAsset;
    expectStorageNeutralHttpShape(projectAsset);

    const projectAssets = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: origin,
    });
    const binding = {
      id: "binding:journey:source",
      owner: {
        kind: "run" as const,
        actionId: "journey:consume",
        actionRevisionId: "journey:consume:revision-1",
        actionRunId: "journey:consume:run-1",
      },
      direction: "input" as const,
      slot: "source",
      projectAssetId: projectAsset.id,
      role: "source" as const,
    };
    await expect(projectAssets.bind(projectId, binding)).resolves.toEqual(
      binding,
    );

    const assetUrl = `${projectCollection}/${encodeURIComponent(projectAsset.id)}`;
    const deleteRequest = {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deleteOperationId: "delete:journey" }),
    } as const;
    const rejectedDelete = await app.request(assetUrl, deleteRequest);
    expect(rejectedDelete.status, await rejectedDelete.clone().text()).toBe(
      409,
    );
    const rejectedBody = await rejectedDelete.json();
    expect(rejectedBody).toEqual({
      error: `Project Asset ${projectAsset.id} is still referenced.`,
      code: "ASSET_IN_USE",
      projectAssetId: projectAsset.id,
      references: [binding],
    });
    expectStorageNeutralHttpShape(rejectedBody);

    await expect(projectAssets.unbind(projectId, binding.id)).resolves.toEqual(
      binding,
    );

    const removed = await app.request(assetUrl, deleteRequest);
    expect(removed.status, await removed.clone().text()).toBe(200);
    const removedBody = (await removed.json()) as ResolvedAsset;
    expect(removedBody).toMatchObject({
      id: projectAsset.id,
      status: "unavailable",
    });
    expectStorageNeutralHttpShape(removedBody);

    const restored = await app.request(`${assetUrl}/restore`, {
      method: "POST",
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    const restoredBody = (await restored.json()) as ResolvedAsset;
    expect(restoredBody).toMatchObject({
      id: projectAsset.id,
      status: "ready",
      url: `${assetUrl}/media`,
    });
    expectStorageNeutralHttpShape(restoredBody);

    const media = await app.request(`${assetUrl}/media`);
    expect(media.status, await media.clone().text()).toBe(200);
    expect(media.headers.get("content-type")).toBe("audio/mpeg");
    await expect(media.text()).resolves.toBe("immutable-journey-audio");
  });

  it("retires the legacy Global/read/reference routes without writing legacy membership", async () => {
    const { app, dataDir } = await fixture();
    const retiredRequests: Array<[string, RequestInit | undefined]> = [
      [`${origin}/api/v1/assets`, undefined],
      [
        `${origin}/api/v1/assets`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            addToLibrary: true,
            kind: "image",
            srcR2Key: "uploads/legacy.png",
          }),
        },
      ],
      [`${origin}/api/v1/assets/legacy`, undefined],
      [`${origin}/api/v1/assets/legacy/library`, { method: "POST" }],
      [
        `${origin}/api/v1/assets/legacy/ref`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "project-a" }),
        },
      ],
      [`${origin}/api/v1/assets/import`, { method: "POST" }],
      [`${origin}/api/v1/assets/replace`, { method: "POST" }],
      [`${origin}/api/v1/assets/gc`, { method: "POST" }],
      [`${origin}/api/v1/assets/legacy/references/refresh`, { method: "POST" }],
      [`${origin}/api/v1/assets/legacy/cover`, { method: "PATCH" }],
    ];

    for (const [url, init] of retiredRequests) {
      const response = await app.request(url, init);
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({
        code: "LEGACY_ASSET_API_RETIRED",
      });
    }

    const state = await createLocalMetadataStore(dataDir).load();
    expect(state.assetRefs).toEqual([]);
    expect(state.libraryAssetRefs).toEqual([]);
  });
});
