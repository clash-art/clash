import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalAssetInspectionService,
  createLocalFfprobeAssetInspector,
  type LocalAssetInspectionFacts,
} from "./local-asset-inspections.js";
import {
  createLocalAssetRepresentationService,
  videoNeedsPlaybackProxy,
  videoProxyFfmpegArgs,
  type LocalAssetRepresentationRecipeRunner,
} from "./local-asset-representations.js";
import { localFfmpegPath, localFfprobePath } from "./local-media-binaries.js";
import { createLocalResourceStore } from "./local-resource-store.js";

const realFfmpeg = localFfmpegPath();
const realFfprobe = localFfprobePath();
const run = promisify(execFile);

const temporaryDirectories: string[] = [];

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-representation-run-"));
  temporaryDirectories.push(dataDir);
  const resources = createLocalResourceStore({ dataDir });
  const source = await resources.install({
    kind: "audio",
    contentType: "audio/wav",
    bytes: new TextEncoder().encode("immutable test audio"),
  });
  return {
    dataDir,
    source,
    assetInspection: createLocalAssetInspectionService({ dataDir }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Local Asset representation durable runs", () => {
  it("coalesces concurrent requests onto one immutable source recipe", async () => {
    const { dataDir, source, assetInspection } = await fixture();
    const recipeRunner = vi.fn(async () => ({
      kind: "waveform" as const,
      role: "waveform" as const,
      peaks: new Array(128).fill(0.5),
    }));
    const service = createLocalAssetRepresentationService({
      dataDir,
      assetInspection,
      recipeRunner,
    });

    const [first, second] = await Promise.all([
      service.ensure(source.resource.id),
      service.ensure(source.resource.id),
    ]);

    expect(recipeRunner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toEqual([
      expect.objectContaining({ role: "waveform", peaks: expect.any(Array) }),
    ]);
    await service.close();
  });

  it("reclaims a retryable run after Host restart without a new request", async () => {
    const { dataDir, source, assetInspection } = await fixture();
    let now = 1_000;
    const failingRunner = vi.fn(async () => {
      throw new Error("transient worker crash");
    });
    const first = createLocalAssetRepresentationService({
      dataDir,
      assetInspection,
      ownerId: "local-api:test-representations",
      now: () => now,
      recipeRunner: failingRunner,
    });

    await expect(first.ensure(source.resource.id)).resolves.toEqual([]);
    expect(failingRunner).toHaveBeenCalledTimes(1);
    await first.close();

    now = 2_001;
    const recoveredRunner = vi.fn(async () => ({
      kind: "waveform" as const,
      role: "waveform" as const,
      peaks: new Array(128).fill(0.75),
    }));
    const restarted = createLocalAssetRepresentationService({
      dataDir,
      assetInspection,
      ownerId: "local-api:test-representations",
      now: () => now,
      recipeRunner: recoveredRunner,
    });

    await restarted.start();

    expect(recoveredRunner).toHaveBeenCalledTimes(1);
    await expect(
      restarted.read(source.resource.id, "waveform"),
    ).resolves.toEqual(
      expect.objectContaining({
        role: "waveform",
        peaks: new Array(128).fill(0.75),
      }),
    );
    await restarted.close();
  });
});

describe("Video playback proxy decision", () => {
  // Codec names are ffprobe's `codec_name`; containers are IANA media types.
  it.each([
    [
      "1080p H.264 MP4",
      {
        width: 1920,
        height: 1080,
        contentType: "video/mp4",
        videoCodec: "h264",
        audioCodec: "aac",
      },
      true,
    ],
    [
      "portrait 1080p H.264 MP4",
      {
        width: 1080,
        height: 1920,
        contentType: "video/mp4",
        videoCodec: "h264",
      },
      true,
    ],
    [
      "4K VP9 WebM",
      {
        width: 3840,
        height: 2160,
        contentType: "video/webm",
        videoCodec: "vp9",
        audioCodec: "opus",
      },
      true,
    ],
    [
      "720p H.264/AAC MP4",
      {
        width: 1280,
        height: 720,
        contentType: "video/mp4",
        videoCodec: "h264",
        audioCodec: "aac",
      },
      false,
    ],
    [
      "portrait 720p H.264 MP4",
      {
        width: 720,
        height: 1280,
        contentType: "video/mp4",
        videoCodec: "h264",
      },
      false,
    ],
    [
      "silent 360p H.264 MP4",
      { width: 640, height: 360, contentType: "video/mp4", videoCodec: "h264" },
      false,
    ],
    [
      "360p VP9/Opus WebM",
      {
        width: 640,
        height: 360,
        contentType: "video/webm",
        videoCodec: "vp9",
        audioCodec: "opus",
      },
      false,
    ],
    [
      "360p HEVC MP4",
      {
        width: 640,
        height: 360,
        contentType: "video/mp4",
        videoCodec: "hevc",
        audioCodec: "aac",
      },
      true,
    ],
    [
      "360p ProRes QuickTime",
      {
        width: 640,
        height: 360,
        contentType: "video/quicktime",
        videoCodec: "prores",
      },
      true,
    ],
    [
      "360p H.264 Matroska",
      {
        width: 640,
        height: 360,
        contentType: "video/x-matroska",
        videoCodec: "h264",
      },
      true,
    ],
    [
      "360p H.264 MP4 with PCM audio",
      {
        width: 640,
        height: 360,
        contentType: "video/mp4",
        videoCodec: "h264",
        audioCodec: "pcm_s16le",
      },
      true,
    ],
  ] as const)("%s", (_name, facts, expected) => {
    expect(videoNeedsPlaybackProxy(facts)).toBe(expected);
  });
});

describe.skipIf(!realFfmpeg || !realFfprobe)("Video proxy transcode", () => {
  async function transcode(size: string): Promise<{
    format: string;
    streams: Record<string, { codec: string; width?: number; height?: number }>;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "clash-proxy-args-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.mkv");
    const outputPath = join(directory, "proxy.mp4");
    // MPEG-4 Part 2 + Vorbis in Matroska: nothing the proxy may pass through.
    await run(realFfmpeg!, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${size}:rate=10:duration=1`,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:v",
      "mpeg4",
      "-c:a",
      "libvorbis",
      "-shortest",
      sourcePath,
    ]);
    await run(realFfmpeg!, videoProxyFfmpegArgs({ sourcePath, outputPath }));
    const probed = JSON.parse(
      (
        await run(realFfprobe!, [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          outputPath,
        ])
      ).stdout,
    ) as {
      format: { format_name: string };
      streams: {
        codec_type: string;
        codec_name: string;
        width?: number;
        height?: number;
      }[];
    };
    return {
      format: probed.format.format_name,
      streams: Object.fromEntries(
        probed.streams.map((stream) => [
          stream.codec_type,
          {
            codec: stream.codec_name,
            width: stream.width,
            height: stream.height,
          },
        ]),
      ),
    };
  }

  it.each([
    ["landscape 1080p", "1920x1080", 1280, 720],
    ["portrait 1080p", "1080x1920", 720, 1280],
    ["a source already under 720p", "320x240", 320, 240],
  ])(
    "writes H.264/AAC MP4 bounded to 720p for %s",
    async (_name, size, width, height) => {
      const proxy = await transcode(size);

      expect(proxy.format).toContain("mp4");
      expect(proxy.streams.video).toEqual({ codec: "h264", width, height });
      expect(proxy.streams.audio?.codec).toBe("aac");
    },
  );
});

describe("Local Asset video proxy representation", () => {
  const largeVideo: LocalAssetInspectionFacts = {
    width: 1920,
    height: 1080,
    rotationDegrees: 0,
    durationMs: 1_000,
    frameRate: 24,
    videoCodec: "h264",
    hasAudio: false,
    contentType: "video/mp4",
  };

  async function videoFixture(facts: LocalAssetInspectionFacts) {
    const dataDir = await mkdtemp(
      join(tmpdir(), "clash-representation-proxy-"),
    );
    temporaryDirectories.push(dataDir);
    const resources = createLocalResourceStore({ dataDir });
    const source = await resources.install({
      kind: "video",
      contentType: "video/mp4",
      bytes: new TextEncoder().encode("immutable test video"),
    });
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async ({ resource }) =>
        resource.id === source.resource.id
          ? facts
          : resource.kind === "image"
            ? {
                width: 1,
                height: 1,
                rotationDegrees: 0,
                contentType: "image/webp",
              }
            : { ...facts, width: 1280, height: 720 },
    });
    const ran: string[] = [];
    const recipeRunner: LocalAssetRepresentationRecipeRunner = async ({
      recipe,
    }) => {
      ran.push(recipe.id);
      const staged = await resources.stage({
        bytes: new TextEncoder().encode(`derived ${recipe.id}`),
      });
      return recipe.role === "proxy"
        ? {
            kind: "resource",
            role: "proxy",
            stagedResourceId: staged.resourceId,
            resourceKind: "video",
            contentType: "video/mp4",
          }
        : {
            kind: "resource",
            role: "thumbnail",
            stagedResourceId: staged.resourceId,
            resourceKind: "image",
            contentType: "image/webp",
          };
    };
    return { dataDir, source, assetInspection, recipeRunner, ran };
  }

  it("derives a proxy in the background for a source larger than 720p", async () => {
    const { dataDir, source, assetInspection, recipeRunner, ran } =
      await videoFixture(largeVideo);
    const service = createLocalAssetRepresentationService({
      dataDir,
      assetInspection,
      recipeRunner,
      ffmpegPath: () => "/test/bin/ffmpeg",
    });

    service.schedule(source.resource.id);
    await vi.waitFor(async () => {
      expect(await service.read(source.resource.id, "proxy")).toEqual(
        expect.objectContaining({ role: "proxy" }),
      );
    });

    expect(ran).toEqual(["video-poster", "video-proxy"]);
    const proxy = await service.openProxy(source.resource.id);
    expect(proxy?.resource).toMatchObject({
      kind: "video",
      contentType: "video/mp4",
    });
    await expect(readFile(proxy!.path, "utf8")).resolves.toBe(
      "derived video-proxy",
    );
    // The thumbnail is still its own representation, not the proxy.
    expect(
      (await service.openThumbnail(source.resource.id))?.resource.id,
    ).not.toBe(proxy!.resource.id);
    await service.close();
  });

  it("never makes an Asset read wait for the proxy encode", async () => {
    const { dataDir, source, assetInspection, recipeRunner, ran } =
      await videoFixture(largeVideo);
    const service = createLocalAssetRepresentationService({
      dataDir,
      assetInspection,
      recipeRunner,
      ffmpegPath: () => "/test/bin/ffmpeg",
    });

    await expect(service.ensure(source.resource.id)).resolves.toEqual([
      expect.objectContaining({ role: "thumbnail" }),
    ]);

    expect(ran).toEqual(["video-poster"]);
    await expect(
      service.openProxy(source.resource.id),
    ).resolves.toBeUndefined();
    await service.close();
  });

  it.each([
    [
      "the source already plays well in a browser",
      { ...largeVideo, width: 1280, height: 720 },
      "/test/bin/ffmpeg",
    ],
    ["ffmpeg is unavailable", largeVideo, null],
  ])("skips the proxy when %s", async (_reason, facts, ffmpeg) => {
    const { dataDir, source, assetInspection, recipeRunner, ran } =
      await videoFixture(facts);
    const service = createLocalAssetRepresentationService({
      dataDir,
      assetInspection,
      recipeRunner,
      ffmpegPath: () => ffmpeg,
    });

    service.schedule(source.resource.id);
    await vi.waitFor(async () => {
      expect(await service.read(source.resource.id, "thumbnail")).toBeDefined();
    });
    await service.close();

    expect(ran).toEqual(["video-poster"]);
    await expect(
      service.openProxy(source.resource.id),
    ).resolves.toBeUndefined();
  });

  it.skipIf(!realFfmpeg || !realFfprobe)(
    "transcodes, stages and publishes a real proxy through the store",
    async () => {
      const dataDir = await mkdtemp(
        join(tmpdir(), "clash-representation-real-"),
      );
      temporaryDirectories.push(dataDir);
      const sourcePath = join(dataDir, "source.mkv");
      await run(realFfmpeg!, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=1920x1080:rate=10:duration=1",
        "-c:v",
        "mpeg4",
        sourcePath,
      ]);
      const resources = createLocalResourceStore({ dataDir });
      const source = await resources.install({
        kind: "video",
        contentType: "video/x-matroska",
        bytes: new Uint8Array(await readFile(sourcePath)),
      });
      const service = createLocalAssetRepresentationService({
        dataDir,
        assetInspection: createLocalAssetInspectionService({
          dataDir,
          inspectResource: createLocalFfprobeAssetInspector({
            ffprobePath: realFfprobe!,
          }),
        }),
      });

      service.schedule(source.resource.id);
      await vi.waitFor(
        async () => {
          expect(await service.openProxy(source.resource.id)).toBeDefined();
        },
        { timeout: 30_000, interval: 100 },
      );

      const proxy = (await service.openProxy(source.resource.id))!;
      expect(proxy.resource.contentType).toBe("video/mp4");
      const probed = JSON.parse(
        (
          await run(realFfprobe!, [
            "-v",
            "error",
            "-show_streams",
            "-of",
            "json",
            proxy.path,
          ])
        ).stdout,
      ) as { streams: { codec_name: string; height: number }[] };
      expect(probed.streams[0]).toMatchObject({
        codec_name: "h264",
        height: 720,
      });
      await service.close();
      // The encode's working file is gone once the proxy is in the store.
      await expect(
        readdir(join(dataDir, "representation-work")),
      ).resolves.toEqual([]);
    },
    60_000,
  );
});
