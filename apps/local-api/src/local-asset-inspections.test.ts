import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalFfprobeAssetInspector,
  createLocalAssetInspectionService,
} from "./local-asset-inspections.js";
import { createLocalResourceStore } from "./local-resource-store.js";

const temporaryDirectories: string[] = [];
const nodeRequire = createRequire(import.meta.url);

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-asset-representations-"));
  temporaryDirectories.push(dataDir);
  return {
    dataDir,
    resources: createLocalResourceStore({ dataDir }),
  };
}

function waveBytes(options: {
  formatTag: 1 | 3;
  channels: number;
}): Uint8Array {
  const bytesPerSample = options.formatTag === 1 ? 2 : 4;
  const sampleRate = 8_000;
  const dataLength = options.channels * bytesPerSample;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const text = new TextEncoder();
  bytes.set(text.encode("RIFF"), 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  bytes.set(text.encode("WAVE"), 8);
  bytes.set(text.encode("fmt "), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, options.formatTag, true);
  view.setUint16(22, options.channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * options.channels * bytesPerSample, true);
  view.setUint16(32, options.channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  bytes.set(text.encode("data"), 36);
  view.setUint32(40, dataLength, true);
  return bytes;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;
const GLB_BIN_CHUNK_TYPE = 0x004e4942;

function glbHeaderAndJson(options: {
  json: string;
  byteLength: number;
  containerVersion?: number;
}): Buffer {
  const json = Buffer.from(options.json, "utf8");
  const head = Buffer.alloc(20);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(options.containerVersion ?? 2, 4);
  // A length past uint32 cannot be declared; the header keeps its low 32 bits.
  head.writeUInt32LE(options.byteLength >>> 0, 8);
  head.writeUInt32LE(json.byteLength, 12);
  head.writeUInt32LE(GLB_JSON_CHUNK_TYPE, 16);
  return Buffer.concat([head, json]);
}

function modelResource(byteLength: number, contentType: string) {
  return {
    id: `sha256:${"f".repeat(64)}`,
    kind: "model" as const,
    digest: { algorithm: "sha256" as const, value: "f".repeat(64) },
    byteLength,
    contentType,
  };
}

function modelInspector() {
  return createLocalFfprobeAssetInspector({
    ffprobePath: "/test/bin/ffprobe",
    run: async () => {
      throw new Error("glTF validation must not use ffprobe");
    },
  });
}

/**
 * Writes `head` at offset 0 of a file extended to `byteLength` without
 * writing the rest. Returns undefined when the filesystem materialized the
 * hole, so callers can skip instead of filling the disk.
 */
async function sparseFile(
  name: string,
  head: Buffer,
  byteLength: number,
): Promise<string | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "clash-sparse-model-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, name);
  const file = await open(sourcePath, "w");
  try {
    await file.write(head, 0, head.byteLength, 0);
    await file.truncate(byteLength);
    const stats = await file.stat();
    if (stats.size !== byteLength || stats.blocks * 512 >= byteLength) {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
  return sourcePath;
}

/** Counts what an inspection pulls through any FileHandle. */
async function spyOnFileHandleReads(anyPath: string) {
  const probe = await open(anyPath, "r");
  const prototype = Object.getPrototypeOf(probe) as typeof probe;
  await probe.close();
  const read = vi.spyOn(prototype, "read");
  const readWholeFile = vi.spyOn(prototype, "readFile");
  return {
    readWholeFile,
    // The inspector uses the positional read(buffer, offset, length, position)
    // overload, which the overloaded spy type does not select.
    requestedBytes: () =>
      (read.mock.calls as unknown as [unknown, number, number][]).reduce(
        (total, [, , length]) => total + length,
        0,
      ),
  };
}

describe("Local Asset inspection", () => {
  it("normalizes ffprobe output into Resource inspection facts", async () => {
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async (file, args) => {
        expect(file).toBe("/test/bin/ffprobe");
        expect(args).toEqual([
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_streams",
          "-show_format",
          "/private/source.mp4",
        ]);
        return {
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "video",
                codec_name: "h264",
                width: 1920,
                height: 1080,
                avg_frame_rate: "30000/1001",
                side_data_list: [
                  { side_data_type: "Display Matrix", rotation: 90 },
                ],
              },
              {
                codec_type: "audio",
                codec_name: "aac",
                sample_rate: "48000",
                channels: 2,
                channel_layout: "stereo",
              },
            ],
            format: {
              format_name: "mov,mp4,m4a,3gp,3g2,mj2",
              duration: "2.501",
            },
          }),
        };
      },
    });

    await expect(
      inspector({
        sourcePath: "/private/source.mp4",
        resource: {
          id: `sha256:${"a".repeat(64)}`,
          kind: "video",
          digest: { algorithm: "sha256", value: "a".repeat(64) },
          byteLength: 42,
          contentType: "video/mp4",
        },
      }),
    ).resolves.toEqual({
      width: 1080,
      height: 1920,
      rotationDegrees: 90,
      durationMs: 2_501,
      contentType: "video/mp4",
      frameRate: 30000 / 1001,
      videoCodec: "h264",
      hasAudio: true,
      audioCodec: "aac",
      sampleRate: 48_000,
      channelCount: 2,
      channelLayout: "stereo",
    });
  });

  it("uses first-frame image orientation when ffprobe does not project EXIF rotation onto the stream", async () => {
    let observedArgs: string[] = [];
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async (_file, args) => {
        observedArgs = args;
        return {
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "video",
                codec_name: "mjpeg",
                width: 4_032,
                height: 3_024,
              },
            ],
            frames: [
              {
                media_type: "video",
                side_data_list: [
                  { side_data_type: "Display Matrix", rotation: 90 },
                ],
              },
            ],
            format: { format_name: "image2" },
          }),
        };
      },
    });

    await expect(
      inspector({
        sourcePath: "/private/portrait.jpg",
        resource: {
          id: `sha256:${"3".repeat(64)}`,
          kind: "image",
          digest: { algorithm: "sha256", value: "3".repeat(64) },
          byteLength: 42,
          contentType: "image/jpeg",
        },
      }),
    ).resolves.toMatchObject({
      width: 3_024,
      height: 4_032,
      rotationDegrees: 90,
    });
    expect(observedArgs).toEqual(
      expect.arrayContaining(["-show_frames", "-read_intervals", "%+#1"]),
    );
  });

  it("normalizes a negative Display Matrix angle into the canonical rotation domain", async () => {
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 320,
              height: 180,
              avg_frame_rate: "24/1",
              side_data_list: [
                { side_data_type: "Display Matrix", rotation: -90 },
              ],
            },
          ],
          format: {
            format_name: "mov,mp4,m4a,3gp,3g2,mj2",
            duration: "1.0",
          },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath: "/private/rotated.mp4",
        resource: {
          id: `sha256:${"9".repeat(64)}`,
          kind: "video",
          digest: { algorithm: "sha256", value: "9".repeat(64) },
          byteLength: 42,
          contentType: "video/mp4",
        },
      }),
    ).resolves.toMatchObject({
      width: 180,
      height: 320,
      rotationDegrees: 270,
    });
  });

  it("rejects a malformed Display Matrix angle instead of inventing orientation", async () => {
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 320,
              height: 180,
              avg_frame_rate: "24/1",
              side_data_list: [
                { side_data_type: "Display Matrix", rotation: "NaN" },
              ],
            },
          ],
          format: {
            format_name: "mov,mp4,m4a,3gp,3g2,mj2",
            duration: "1.0",
          },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath: "/private/malformed-rotation.mp4",
        resource: {
          id: `sha256:${"8".repeat(64)}`,
          kind: "video",
          digest: { algorithm: "sha256", value: "8".repeat(64) },
          byteLength: 42,
          contentType: "video/mp4",
        },
      }),
    ).rejects.toThrow(/rotation/i);
  });

  it("rejects a non-quarter-turn Display Matrix instead of mislabeling coded dimensions as display dimensions", async () => {
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 320,
              height: 180,
              avg_frame_rate: "24/1",
              side_data_list: [
                { side_data_type: "Display Matrix", rotation: 45 },
              ],
            },
          ],
          format: {
            format_name: "mov,mp4,m4a,3gp,3g2,mj2",
            duration: "1.0",
          },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath: "/private/non-quarter-turn.mp4",
        resource: {
          id: `sha256:${"7".repeat(64)}`,
          kind: "video",
          digest: { algorithm: "sha256", value: "7".repeat(64) },
          byteLength: 42,
          contentType: "video/mp4",
        },
      }),
    ).rejects.toThrow(/rotation/i);
  });

  it("publishes canonical audio layout without leaking an attached picture stream", async () => {
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "mjpeg",
              width: 600,
              height: 600,
              disposition: { attached_pic: 1 },
            },
            {
              codec_type: "audio",
              codec_name: "mp3",
              sample_rate: "44100",
              channels: 2,
              channel_layout: "stereo",
            },
          ],
          format: { format_name: "mp3", duration: "3.25" },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath: "/private/song.mp3",
        resource: {
          id: `sha256:${"7".repeat(64)}`,
          kind: "audio",
          digest: { algorithm: "sha256", value: "7".repeat(64) },
          byteLength: 42,
          contentType: "audio/mpeg",
        },
      }),
    ).resolves.toEqual({
      durationMs: 3_250,
      contentType: "audio/mpeg",
      hasAudio: true,
      audioCodec: "mp3",
      sampleRate: 44_100,
      channelCount: 2,
      channelLayout: "stereo",
    });
  });

  it("canonicalizes a compatible WAV media-type alias from decoded bytes", async () => {
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "audio",
              codec_name: "pcm_s16le",
              sample_rate: "48000",
              channels: 1,
              channel_layout: "mono",
            },
          ],
          format: { format_name: "wav", duration: "1.0" },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath: "/private/source.wav",
        resource: {
          id: `sha256:${"6".repeat(64)}`,
          kind: "audio",
          digest: { algorithm: "sha256", value: "6".repeat(64) },
          byteLength: 96_000,
          contentType: "audio/x-wav",
        },
      }),
    ).resolves.toMatchObject({ contentType: "audio/wav" });
  });

  it.each([
    {
      label: "mono integer PCM",
      formatTag: 1 as const,
      channels: 1,
      codec: "pcm_s16le",
      channelLayout: "mono",
    },
    {
      label: "stereo IEEE float PCM",
      formatTag: 3 as const,
      channels: 2,
      codec: "pcm_f32le",
      channelLayout: "stereo",
    },
  ])(
    "derives $label layout from the standard RIFF fmt chunk when ffprobe omits it",
    async ({ formatTag, channels, codec, channelLayout }) => {
      const directory = await mkdtemp(join(tmpdir(), "clash-wave-layout-"));
      temporaryDirectories.push(directory);
      const bytes = waveBytes({ formatTag, channels });
      const sourcePath = join(directory, "source.wav");
      await writeFile(sourcePath, bytes);
      const inspector = createLocalFfprobeAssetInspector({
        ffprobePath: "/test/bin/ffprobe",
        run: async () => ({
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: "audio",
                codec_name: codec,
                sample_rate: "8000",
                channels,
              },
            ],
            format: { format_name: "wav", duration: "0.001" },
          }),
        }),
      });

      await expect(
        inspector({
          sourcePath,
          resource: {
            id: `sha256:${"a".repeat(64)}`,
            kind: "audio",
            digest: { algorithm: "sha256", value: "a".repeat(64) },
            byteLength: bytes.byteLength,
            contentType: "audio/wav",
          },
        }),
      ).resolves.toMatchObject({ channelCount: channels, channelLayout });
    },
  );

  it("does not invent a layout from a non-WAV stream's channel count", async () => {
    const sourcePath = fileURLToPath(
      new URL("./fixtures/minimax-h3-reference.mp3", import.meta.url),
    );
    const bytes = await readFile(sourcePath);
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "audio",
              codec_name: "mp3",
              sample_rate: "44100",
              channels: 1,
            },
          ],
          format: { format_name: "mp3", duration: "1.0" },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath,
        resource: {
          id: `sha256:${"b".repeat(64)}`,
          kind: "audio",
          digest: { algorithm: "sha256", value: "b".repeat(64) },
          byteLength: bytes.byteLength,
          contentType: "audio/mpeg",
        },
      }),
    ).rejects.toThrow(/channel layout/i);
  });

  it("does not invent a layout for a three-channel PCM WAV without a speaker mask", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-wave-layout-"));
    temporaryDirectories.push(directory);
    const bytes = waveBytes({ formatTag: 1, channels: 3 });
    const sourcePath = join(directory, "three-channel.wav");
    await writeFile(sourcePath, bytes);
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "audio",
              codec_name: "pcm_s16le",
              sample_rate: "8000",
              channels: 3,
            },
          ],
          format: { format_name: "wav", duration: "0.001" },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath,
        resource: {
          id: `sha256:${"c".repeat(64)}`,
          kind: "audio",
          digest: { algorithm: "sha256", value: "c".repeat(64) },
          byteLength: bytes.byteLength,
          contentType: "audio/wav",
        },
      }),
    ).rejects.toThrow(/channel layout/i);
  });

  it("keeps a registered Matroska family assertion when ffprobe reports its shared WebM demuxer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-matroska-probe-"));
    temporaryDirectories.push(directory);
    const bytes = Uint8Array.from([
      0x1a,
      0x45,
      0xdf,
      0xa3,
      0x8b,
      0x42,
      0x82,
      0x88,
      ...new TextEncoder().encode("matroska"),
    ]);
    const sourcePath = join(directory, "source.mkv");
    await writeFile(sourcePath, bytes);
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 1_920,
              height: 1_080,
              avg_frame_rate: "24/1",
              side_data_list: [],
            },
          ],
          format: { format_name: "matroska,webm", duration: "1.0" },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath,
        resource: {
          id: `sha256:${"5".repeat(64)}`,
          kind: "video",
          digest: { algorithm: "sha256", value: "5".repeat(64) },
          byteLength: bytes.byteLength,
          contentType: "video/x-matroska",
        },
      }),
    ).resolves.toMatchObject({ contentType: "video/x-matroska" });
  });

  it("reads only the EBML header of a multi-gigabyte Matroska file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-matroska-large-"));
    temporaryDirectories.push(directory);
    const header = Uint8Array.from([
      0x1a,
      0x45,
      0xdf,
      0xa3,
      0x8b,
      0x42,
      0x82,
      0x88,
      ...new TextEncoder().encode("matroska"),
    ]);
    // Sparse: 3 GiB is more than one fs.readFile call can return, so the
    // inspection only resolves if it stops at the header.
    const byteLength = 3 * 1024 ** 3;
    const sourcePath = join(directory, "source.mkv");
    const handle = await open(sourcePath, "w");
    try {
      await handle.write(header, 0, header.byteLength, 0);
      await handle.truncate(byteLength);
    } finally {
      await handle.close();
    }
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 1_920,
              height: 1_080,
              avg_frame_rate: "24/1",
              side_data_list: [],
            },
          ],
          format: { format_name: "matroska,webm", duration: "1.0" },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath,
        resource: {
          id: `sha256:${"6".repeat(64)}`,
          kind: "video",
          digest: { algorithm: "sha256", value: "6".repeat(64) },
          byteLength,
          contentType: "video/x-matroska",
        },
      }),
    ).resolves.toMatchObject({ contentType: "video/x-matroska" });
  });

  it("rejects a Matroska assertion when the EBML bytes declare WebM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-webm-probe-"));
    temporaryDirectories.push(directory);
    const bytes = Uint8Array.from([
      0x1a,
      0x45,
      0xdf,
      0xa3,
      0x87,
      0x42,
      0x82,
      0x84,
      ...new TextEncoder().encode("webm"),
    ]);
    const sourcePath = join(directory, "mislabeled.mkv");
    await writeFile(sourcePath, bytes);
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "vp9",
              width: 640,
              height: 360,
              avg_frame_rate: "24/1",
              side_data_list: [],
            },
          ],
          format: { format_name: "matroska,webm", duration: "1.0" },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath,
        resource: {
          id: `sha256:${"4".repeat(64)}`,
          kind: "video",
          digest: { algorithm: "sha256", value: "4".repeat(64) },
          byteLength: bytes.byteLength,
          contentType: "video/x-matroska",
        },
      }),
    ).rejects.toThrow(/video\/webm/i);
  });

  it("rejects an unknown ffprobe channel layout instead of publishing an unknown sentinel", async () => {
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "audio",
              codec_name: "aac",
              sample_rate: "48000",
              channels: 2,
              channel_layout: "unknown",
            },
          ],
          format: {
            format_name: "mov,mp4,m4a,3gp,3g2,mj2",
            duration: "1.0",
          },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath: "/private/unknown-layout.m4a",
        resource: {
          id: `sha256:${"6".repeat(64)}`,
          kind: "audio",
          digest: { algorithm: "sha256", value: "6".repeat(64) },
          byteLength: 42,
          contentType: "audio/mp4",
        },
      }),
    ).rejects.toThrow(/channel layout/i);
  });

  it("derives a silent-video fact instead of leaving audio presence unknown", async () => {
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 1280,
              height: 720,
              avg_frame_rate: "24/1",
            },
          ],
          format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1.5" },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath: "/private/silent.mp4",
        resource: {
          id: `sha256:${"b".repeat(64)}`,
          kind: "video",
          digest: { algorithm: "sha256", value: "b".repeat(64) },
          byteLength: 42,
          contentType: "video/mp4",
        },
      }),
    ).resolves.toMatchObject({ hasAudio: false, videoCodec: "h264" });
  });

  it("rejects competing caller interpretations of the same headerless PCM bytes", async () => {
    let ffprobeCalls = 0;
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => {
        ffprobeCalls += 1;
        throw new Error("headerless PCM must fail before ffprobe");
      },
    });
    const resourceId = `sha256:${"c".repeat(64)}`;

    const results = await Promise.allSettled([
      inspector({
        sourcePath: "/private/generated.bin",
        resource: {
          id: resourceId,
          kind: "audio",
          digest: { algorithm: "sha256", value: "c".repeat(64) },
          byteLength: 96_000,
          contentType: "audio/L16;codec=pcm;rate=24000;channels=1",
        },
      }),
      inspector({
        sourcePath: "/private/generated.bin",
        resource: {
          id: resourceId,
          kind: "audio",
          digest: { algorithm: "sha256", value: "c".repeat(64) },
          byteLength: 96_000,
          contentType: "audio/pcm;rate=48000;channels=2",
        },
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(ffprobeCalls).toBe(0);
  });

  it("rejects decoded streams that do not match the registered Asset kind", async () => {
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [{ codec_type: "audio", codec_name: "aac" }],
          format: { duration: "1.0" },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath: "/private/not-a-video.mp4",
        resource: {
          id: `sha256:${"d".repeat(64)}`,
          kind: "video",
          digest: { algorithm: "sha256", value: "d".repeat(64) },
          byteLength: 42,
          contentType: "video/mp4",
        },
      }),
    ).rejects.toThrow(/video stream/i);
  });

  it("rejects a registered MIME that disagrees with the decoded image codec", async () => {
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "png",
              width: 64,
              height: 64,
            },
          ],
          format: { format_name: "png_pipe" },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath: "/private/png-declared-as-jpeg",
        resource: {
          id: `sha256:${"1".repeat(64)}`,
          kind: "image",
          digest: { algorithm: "sha256", value: "1".repeat(64) },
          byteLength: 42,
          contentType: "image/jpeg",
        },
      }),
    ).rejects.toThrow(/image\/png/i);
  });

  it("rejects incomplete decoded facts instead of publishing ambiguous video metadata", async () => {
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => ({
        stdout: JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 1920,
              avg_frame_rate: "24/1",
            },
          ],
          format: { duration: "1.0" },
        }),
      }),
    });

    await expect(
      inspector({
        sourcePath: "/private/incomplete.mp4",
        resource: {
          id: `sha256:${"e".repeat(64)}`,
          kind: "video",
          digest: { algorithm: "sha256", value: "e".repeat(64) },
          byteLength: 42,
          contentType: "video/mp4",
        },
      }),
    ).rejects.toThrow(/height/i);
  });

  it("validates GLB bytes as a model without invoking ffprobe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-model-probe-"));
    temporaryDirectories.push(directory);
    const json = new TextEncoder().encode('{"asset":{"version":"2.0"}} ');
    const bytes = new Uint8Array(20 + json.byteLength);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("glTF"), 0);
    view.setUint32(4, 2, true);
    view.setUint32(8, bytes.byteLength, true);
    view.setUint32(12, json.byteLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    bytes.set(json, 20);
    const sourcePath = join(directory, "model.glb");
    await writeFile(sourcePath, bytes);
    let ffprobeCalls = 0;
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => {
        ffprobeCalls += 1;
        throw new Error("glTF validation must not use ffprobe");
      },
    });

    await expect(
      inspector({
        sourcePath,
        resource: {
          id: `sha256:${"f".repeat(64)}`,
          kind: "model",
          digest: { algorithm: "sha256", value: "f".repeat(64) },
          byteLength: bytes.byteLength,
          contentType: "model/gltf-binary",
        },
      }),
    ).resolves.toEqual({ contentType: "model/gltf-binary" });
    expect(ffprobeCalls).toBe(0);
  });

  it("inspects a multi-gigabyte GLB from its header and JSON chunk without reading the BIN chunk", async (ctx) => {
    const byteLength = 3 * 1024 ** 3 + 4;
    const binByteLength = 3 * 1024 ** 3 - 64;
    const json = JSON.stringify({
      asset: { version: "2.0" },
      extensionsUsed: ["KHR_draco_mesh_compression"],
      extensionsRequired: ["KHR_draco_mesh_compression"],
      buffers: [{ byteLength: binByteLength }],
      bufferViews: [
        { buffer: 0, byteLength: binByteLength - 1024 },
        { buffer: 0, byteOffset: binByteLength - 1024, byteLength: 1024 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 250_000_000,
          type: "VEC3",
        },
      ],
      images: [{ bufferView: 1, mimeType: "image/png" }],
      textures: [{ source: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    });
    const paddedJson = json.padEnd(byteLength - 20 - 8 - binByteLength, " ");
    const binChunkHeader = Buffer.alloc(8);
    binChunkHeader.writeUInt32LE(binByteLength, 0);
    binChunkHeader.writeUInt32LE(GLB_BIN_CHUNK_TYPE, 4);
    const head = Buffer.concat([
      glbHeaderAndJson({ json: paddedJson, byteLength }),
      binChunkHeader,
    ]);
    const sourcePath = await sparseFile("large.glb", head, byteLength);
    if (!sourcePath) {
      ctx.skip("filesystem does not support sparse files");
      return;
    }
    const reads = await spyOnFileHandleReads(sourcePath);

    await expect(
      modelInspector()({
        sourcePath,
        resource: modelResource(byteLength, "model/gltf-binary"),
      }),
    ).resolves.toEqual({ contentType: "model/gltf-binary" });
    expect(reads.readWholeFile).not.toHaveBeenCalled();
    expect(reads.requestedBytes()).toBeGreaterThan(0);
    expect(reads.requestedBytes()).toBeLessThanOrEqual(head.byteLength + 4);
  });

  it("rejects a file past the 4 GiB GLB container limit without reading it", async (ctx) => {
    const byteLength = 4 * 1024 ** 3 + 4096;
    const head = glbHeaderAndJson({
      json: '{"asset":{"version":"2.0"}}',
      byteLength,
    });
    const sourcePath = await sparseFile("oversized.glb", head, byteLength);
    if (!sourcePath) {
      ctx.skip("filesystem does not support sparse files");
      return;
    }
    const reads = await spyOnFileHandleReads(sourcePath);

    await expect(
      modelInspector()({
        sourcePath,
        resource: modelResource(byteLength, "model/gltf-binary"),
      }),
    ).rejects.toThrow(/cannot exceed 4294967295 bytes \(4 GiB\)/);
    expect(reads.readWholeFile).not.toHaveBeenCalled();
    expect(reads.requestedBytes()).toBeLessThanOrEqual(head.byteLength);
  });

  it("rejects a GLB whose JSON chunk is not a readable glTF 2 document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-model-probe-"));
    temporaryDirectories.push(directory);
    const inspect = async (options: {
      json: string;
      containerVersion?: number;
    }) => {
      const byteLength = 20 + Buffer.byteLength(options.json);
      const sourcePath = join(directory, "model.glb");
      await writeFile(sourcePath, glbHeaderAndJson({ ...options, byteLength }));
      return modelInspector()({
        sourcePath,
        resource: modelResource(byteLength, "model/gltf-binary"),
      });
    };

    await expect(
      inspect({ json: '{"asset":{"version":"2.0"}' }),
    ).rejects.toThrow("GLB Asset JSON chunk is invalid.");
    await expect(
      inspect({ json: '{"asset":{"version":"1.0"}}' }),
    ).rejects.toThrow("GLB Asset JSON chunk is invalid.");
    await expect(
      inspect({ json: '{"asset":{"version":"2.0"}}', containerVersion: 1 }),
    ).rejects.toThrow(
      "GLB Asset bytes do not contain a valid glTF 2 JSON chunk.",
    );
    // Well-formed JSON with the right version that the glTF reader cannot build.
    await expect(
      inspect({ json: '{"asset":{"version":"2.0"},"nodes":"none"}' }),
    ).rejects.toThrow("GLB Asset JSON chunk is invalid.");
  });

  it("validates glTF JSON without resolving its external buffers or images", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-model-probe-"));
    temporaryDirectories.push(directory);
    const inspect = async (document: unknown) => {
      const bytes = Buffer.from(JSON.stringify(document), "utf8");
      const sourcePath = join(directory, "model.gltf");
      await writeFile(sourcePath, bytes);
      return modelInspector()({
        sourcePath,
        resource: modelResource(bytes.byteLength, "model/gltf+json"),
      });
    };

    await expect(
      inspect({
        asset: { version: "2.0" },
        buffers: [{ uri: "missing.bin", byteLength: 36 }],
        bufferViews: [{ buffer: 0, byteLength: 36 }],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        ],
        images: [{ uri: "missing.png" }],
        textures: [{ source: 0 }],
        materials: [
          { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
        ],
        meshes: [
          { primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
        ],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
      }),
    ).resolves.toEqual({ contentType: "model/gltf+json" });
    await expect(inspect({ asset: { version: "1.0" } })).rejects.toThrow(
      "glTF JSON Asset bytes are invalid.",
    );
    await expect(
      inspect({ asset: { version: "2.0" }, nodes: "none" }),
    ).rejects.toThrow("glTF JSON Asset bytes are invalid.");
  });

  it("reads SVG display geometry from verified bytes without invoking ffprobe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-svg-probe-"));
    temporaryDirectories.push(directory);
    const bytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180"/></svg>',
    );
    const sourcePath = join(directory, "graphic.svg");
    await writeFile(sourcePath, bytes);
    let ffprobeCalls = 0;
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => {
        ffprobeCalls += 1;
        throw new Error("SVG byte verification must not use ffprobe");
      },
    });

    await expect(
      inspector({
        sourcePath,
        resource: {
          id: `sha256:${"e".repeat(64)}`,
          kind: "image",
          digest: { algorithm: "sha256", value: "e".repeat(64) },
          byteLength: bytes.byteLength,
          contentType: "image/svg+xml",
        },
      }),
    ).resolves.toEqual({
      contentType: "image/svg+xml",
      width: 320,
      height: 180,
      rotationDegrees: 0,
    });
    expect(ffprobeCalls).toBe(0);
  });

  it("does not treat custom data attributes as SVG display dimensions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-svg-data-size-"));
    temporaryDirectories.push(directory);
    const bytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" data-width="640" data-height="480"></svg>',
    );
    const sourcePath = join(directory, "custom-data-size.svg");
    await writeFile(sourcePath, bytes);
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => {
        throw new Error("SVG byte verification must not use ffprobe");
      },
    });

    await expect(
      inspector({
        sourcePath,
        resource: {
          id: `sha256:${"b".repeat(64)}`,
          kind: "image",
          digest: { algorithm: "sha256", value: "b".repeat(64) },
          byteLength: bytes.byteLength,
          contentType: "image/svg+xml",
        },
      }),
    ).rejects.toThrow(/positive pixel dimensions|positive viewBox/i);
  });

  it("rejects an HTML document that merely embeds an SVG element", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-fake-svg-probe-"));
    temporaryDirectories.push(directory);
    const bytes = new TextEncoder().encode(
      '<html><body><svg viewBox="0 0 320 180"></svg></body></html>',
    );
    const sourcePath = join(directory, "not-an-svg.svg");
    await writeFile(sourcePath, bytes);
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => {
        throw new Error("invalid SVG must fail before ffprobe");
      },
    });

    await expect(
      inspector({
        sourcePath,
        resource: {
          id: `sha256:${"d".repeat(64)}`,
          kind: "image",
          digest: { algorithm: "sha256", value: "d".repeat(64) },
          byteLength: bytes.byteLength,
          contentType: "image/svg+xml",
        },
      }),
    ).rejects.toThrow(/SVG root/i);
  });

  it("rejects a truncated SVG document instead of sealing root attributes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-truncated-svg-"));
    temporaryDirectories.push(directory);
    const bytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">',
    );
    const sourcePath = join(directory, "truncated.svg");
    await writeFile(sourcePath, bytes);
    const inspector = createLocalFfprobeAssetInspector({
      ffprobePath: "/test/bin/ffprobe",
      run: async () => {
        throw new Error("invalid SVG must fail before ffprobe");
      },
    });

    await expect(
      inspector({
        sourcePath,
        resource: {
          id: `sha256:${"c".repeat(64)}`,
          kind: "image",
          digest: { algorithm: "sha256", value: "c".repeat(64) },
          byteLength: bytes.byteLength,
          contentType: "image/svg+xml",
        },
      }),
    ).rejects.toThrow(/well-formed SVG/i);
  });

  it("keeps staged bytes private when finalization has no Host probe adapter", async () => {
    const { dataDir, resources } = await fixture();
    const bytes = new TextEncoder().encode("unverified staged image");
    const staged = await resources.stage({ bytes });
    const service = createLocalAssetInspectionService({ dataDir });

    await expect(
      service.finalize({
        resourceId: staged.resourceId,
        kind: "image",
        contentType: "image/png",
      }),
    ).rejects.toThrow(/byte-probe adapter/i);

    await expect(resources.resolve(staged.resourceId)).resolves.toBeUndefined();
    await expect(
      resources.resolveStaged(staged.resourceId),
    ).resolves.toMatchObject({
      resourceId: staged.resourceId,
      digest: staged.digest,
      byteLength: bytes.byteLength,
    });
    await expect(readFile(staged.path)).resolves.toEqual(Buffer.from(bytes));
  });

  it("refuses to treat a sealed Resource assertion as verified L1 facts without a Host probe adapter", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "image",
      bytes: new TextEncoder().encode("sealed but not byte-probed"),
      contentType: "image/png",
    });
    const service = createLocalAssetInspectionService({ dataDir });

    await expect(service.inspect({ source })).rejects.toThrow(
      /byte-probe adapter/i,
    );
  });

  it("finalizes staged bytes into one sealed Resource and reuses cached v4 facts after restart", async () => {
    const { dataDir, resources } = await fixture();
    const staged = await resources.stage({
      bytes: new TextEncoder().encode("verified staged video"),
    });
    let probes = 0;
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async ({ resource }) => {
        probes += 1;
        return {
          contentType: resource.contentType,
          width: 1_920,
          height: 1_080,
          rotationDegrees: 0,
          durationMs: 2_500,
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: true,
          audioCodec: "aac",
          sampleRate: 48_000,
          channelCount: 2,
          channelLayout: "stereo",
        };
      },
    });

    const finalized = await service.finalize({
      resourceId: staged.resourceId,
      kind: "video",
      contentType: "video/mp4",
    });

    expect(probes).toBe(1);
    expect(finalized.source.resource).toMatchObject({
      id: staged.resourceId,
      kind: "video",
      byteLength: staged.byteLength,
      contentType: "video/mp4",
    });
    expect(finalized.facts).toEqual({
      width: 1_920,
      height: 1_080,
      rotationDegrees: 0,
      durationMs: 2_500,
      contentType: "video/mp4",
      frameRate: 24,
      videoCodec: "h264",
      hasAudio: true,
      audioCodec: "aac",
      sampleRate: 48_000,
      channelCount: 2,
      channelLayout: "stereo",
    });
    await expect(resources.resolve(staged.resourceId)).resolves.toEqual(
      finalized.source,
    );

    const restarted = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        throw new Error("the persisted v4 inspection must be reused");
      },
    });
    await expect(
      restarted.inspect({ source: finalized.source }),
    ).resolves.toEqual({ facts: finalized.facts });
    expect(probes).toBe(1);
  });

  it("seals the canonical media type derived by the Host when staging has no caller MIME", async () => {
    const { dataDir, resources } = await fixture();
    const staged = await resources.stage({
      bytes: new TextEncoder().encode("media with no caller MIME"),
    });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => ({
        contentType: "image/png",
        width: 1,
        height: 1,
        rotationDegrees: 0,
      }),
    });

    const finalized = await service.finalize({
      resourceId: staged.resourceId,
      kind: "image",
    });

    expect(finalized.source.resource.contentType).toBe("image/png");
    await expect(resources.resolve(staged.resourceId)).resolves.toMatchObject({
      resource: { contentType: "image/png" },
    });
  });

  it("canonicalizes a compatible caller media-type alias before sealing L0", async () => {
    const { dataDir, resources } = await fixture();
    const staged = await resources.stage({
      bytes: new TextEncoder().encode("verified WAV bytes"),
    });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => ({
        contentType: "audio/wav",
        durationMs: 1_000,
        hasAudio: true,
        audioCodec: "pcm_s16le",
        sampleRate: 48_000,
        channelCount: 1,
        channelLayout: "mono",
      }),
    });

    const finalized = await service.finalize({
      resourceId: staged.resourceId,
      kind: "audio",
      contentType: "audio/x-wav",
    });

    expect(finalized.source.resource.contentType).toBe("audio/wav");
    expect(finalized.facts.contentType).toBe("audio/wav");
  });

  it("does not let a probe adapter publish caller-declared raw PCM parameters as canonical facts", async () => {
    const { dataDir, resources } = await fixture();
    const staged = await resources.stage({ bytes: new Uint8Array(96_000) });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async ({ resource }) => {
        const stereo = resource.contentType?.startsWith("audio/pcm");
        return {
          contentType: resource.contentType,
          durationMs: stereo ? 500 : 2_000,
          hasAudio: true,
          audioCodec: "pcm_s16le",
          sampleRate: stereo ? 48_000 : 24_000,
          channelCount: stereo ? 2 : 1,
          channelLayout: stereo ? "stereo" : "mono",
        };
      },
    });

    const results: PromiseSettledResult<unknown>[] = [];
    for (const contentType of [
      "audio/L16;codec=pcm;rate=24000;channels=1",
      "audio/pcm;rate=48000;channels=2",
    ]) {
      results.push(
        ...(await Promise.allSettled([
          service.finalize({
            resourceId: staged.resourceId,
            kind: "audio",
            contentType,
          }),
        ])),
      );
    }

    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    await expect(resources.resolve(staged.resourceId)).resolves.toBeUndefined();
  });

  it("reopens a sealed legacy JPEG alias with canonical v4 inspection facts", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "image",
      bytes: new TextEncoder().encode("sealed legacy JPEG alias"),
      contentType: "image/jpg",
    });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => ({
        contentType: "image/jpeg",
        width: 640,
        height: 360,
        rotationDegrees: 0,
      }),
    });

    await expect(service.inspect({ source })).resolves.toEqual({
      facts: {
        contentType: "image/jpeg",
        width: 640,
        height: 360,
        rotationDegrees: 0,
      },
    });
  });

  it("reopens a sealed legacy WAV alias with canonical v4 inspection facts", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "audio",
      bytes: new TextEncoder().encode("sealed legacy WAV alias"),
      contentType: "audio/x-wav",
    });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => ({
        contentType: "audio/wav",
        durationMs: 1_000,
        hasAudio: true,
        audioCodec: "pcm_s16le",
        sampleRate: 48_000,
        channelCount: 1,
        channelLayout: "mono",
      }),
    });

    await expect(service.inspect({ source })).resolves.toMatchObject({
      facts: { contentType: "audio/wav" },
    });
  });

  it("still rejects a decoded media type that is not an alias of the sealed Resource assertion", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "image",
      bytes: new TextEncoder().encode("sealed bytes with a wrong type"),
      contentType: "image/png",
    });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => ({
        contentType: "image/jpeg",
        width: 640,
        height: 360,
        rotationDegrees: 0,
      }),
    });

    await expect(service.inspect({ source })).rejects.toThrow(
      /contentType.*conflicts with the persisted Resource facts/i,
    );
  });

  it("retains staged bytes after a failed assertion so corrected finalization can succeed", async () => {
    const { dataDir, resources } = await fixture();
    const staged = await resources.stage({
      bytes: new TextEncoder().encode("one staged PNG byte sequence"),
    });
    let probes = 0;
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async ({ resource }) => {
        probes += 1;
        if (resource.contentType !== "image/png") {
          throw new Error("decoded bytes are PNG, not JPEG");
        }
        return {
          contentType: "image/png",
          width: 640,
          height: 360,
          rotationDegrees: 0,
        };
      },
    });

    await expect(
      service.finalize({
        resourceId: staged.resourceId,
        kind: "image",
        contentType: "image/jpeg",
      }),
    ).rejects.toThrow("decoded bytes are PNG, not JPEG");
    await expect(resources.resolve(staged.resourceId)).resolves.toBeUndefined();
    await expect(
      resources.resolveStaged(staged.resourceId),
    ).resolves.toBeDefined();

    await expect(
      service.finalize({
        resourceId: staged.resourceId,
        kind: "image",
        contentType: "image/png",
      }),
    ).resolves.toMatchObject({
      source: {
        resource: {
          id: staged.resourceId,
          kind: "image",
          contentType: "image/png",
        },
      },
      facts: {
        contentType: "image/png",
        width: 640,
        height: 360,
        rotationDegrees: 0,
      },
    });
    expect(probes).toBe(2);
  });

  it("lets the first complete v4 probe repair a pre-v4 sealed Resource with the wrong kind and media type", async () => {
    const { dataDir, resources } = await fixture();
    const bytes = new TextEncoder().encode("legacy bytes declared as video");
    const legacy = await resources.install({
      kind: "video",
      bytes,
      contentType: "video/mp4",
    });
    await resources.stage({ bytes });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async ({ resource }) => {
        if (resource.kind !== "image" || resource.contentType !== "image/png") {
          throw new Error("the decoded bytes are PNG");
        }
        return {
          contentType: "image/png",
          width: 640,
          height: 360,
          rotationDegrees: 0,
        };
      },
    });

    await expect(
      service.finalize({
        resourceId: legacy.resource.id,
        kind: "image",
        contentType: "image/png",
      }),
    ).resolves.toMatchObject({
      source: {
        resource: {
          id: legacy.resource.id,
          kind: "image",
          contentType: "image/png",
        },
      },
      facts: { contentType: "image/png", width: 640, height: 360 },
    });
    await expect(resources.resolve(legacy.resource.id)).resolves.toMatchObject({
      resource: { kind: "image", contentType: "image/png" },
    });
  });

  it("keeps a current v4 inspection receipt as the immutable winner across corrected assertions", async () => {
    const { dataDir, resources } = await fixture();
    const staged = await resources.stage({
      bytes: new TextEncoder().encode("one verified PNG Resource"),
    });
    const first = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => ({
        contentType: "image/png",
        width: 640,
        height: 360,
        rotationDegrees: 0,
      }),
    });
    await first.finalize({
      resourceId: staged.resourceId,
      kind: "image",
      contentType: "image/png",
    });
    const restarted = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => ({
        contentType: "video/mp4",
        width: 1920,
        height: 1080,
        rotationDegrees: 0,
        durationMs: 1_000,
        frameRate: 24,
        videoCodec: "h264",
        hasAudio: false,
      }),
    });

    await expect(
      restarted.finalize({
        resourceId: staged.resourceId,
        kind: "video",
        contentType: "video/mp4",
      }),
    ).rejects.toThrow();
    await expect(resources.resolve(staged.resourceId)).resolves.toMatchObject({
      resource: { kind: "image", contentType: "image/png" },
    });
  });

  it("lets exactly one concurrent v4 interpretation win the pre-v4 Resource CAS", async () => {
    const { dataDir, resources } = await fixture();
    const bytes = new TextEncoder().encode("ambiguous legacy Resource bytes");
    const legacy = await resources.install({
      kind: "model",
      bytes,
      contentType: "model/gltf-binary",
    });
    await resources.stage({ bytes });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async ({ resource }) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        return resource.kind === "image"
          ? {
              contentType: "image/png",
              width: 640,
              height: 360,
              rotationDegrees: 0,
            }
          : {
              contentType: "video/mp4",
              width: 640,
              height: 360,
              rotationDegrees: 0,
              durationMs: 1_000,
              frameRate: 24,
              videoCodec: "h264",
              hasAudio: false,
            };
      },
    });

    const settled = await Promise.allSettled([
      service.finalize({
        resourceId: legacy.resource.id,
        kind: "image",
        contentType: "image/png",
      }),
      service.finalize({
        resourceId: legacy.resource.id,
        kind: "video",
        contentType: "video/mp4",
      }),
    ]);
    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const winner = await resources.resolve(legacy.resource.id);
    expect(
      winner?.resource.kind === "image" || winner?.resource.kind === "video",
    ).toBe(true);
    expect(
      winner?.resource.contentType === "image/png" ||
        winner?.resource.contentType === "video/mp4",
    ).toBe(true);
  });

  it("persists verified inspection facts once per Resource across entry identities and restarts", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "video",
      bytes: new TextEncoder().encode("metadata source video"),
      contentType: "video/mp4",
    });
    let probes = 0;
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        probes += 1;
        return {
          width: 1920,
          height: 1080,
          rotationDegrees: 0,
          durationMs: 2_500,
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: true,
          audioCodec: "aac",
          sampleRate: 48_000,
          channelCount: 2,
          channelLayout: "stereo",
        };
      },
    });

    const firstEntry = await service.inspect({
      source,
      knownFacts: { contentType: "video/mp4", originalName: "first.mp4" },
    });
    const restarted = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        throw new Error("persisted Resource inspection must not rerun");
      },
    });
    const secondEntry = await restarted.inspect({
      source,
      knownFacts: { contentType: "video/mp4", originalName: "second.mp4" },
    });

    expect(probes).toBe(1);
    expect(firstEntry.facts).toEqual({
      width: 1920,
      height: 1080,
      rotationDegrees: 0,
      durationMs: 2_500,
      contentType: "video/mp4",
      frameRate: 24,
      videoCodec: "h264",
      hasAudio: true,
      audioCodec: "aac",
      sampleRate: 48_000,
      channelCount: 2,
      channelLayout: "stereo",
    });
    expect(secondEntry.facts).toEqual(firstEntry.facts);
    expect(JSON.stringify(secondEntry)).not.toMatch(
      /first\.mp4|second\.mp4|path|url/i,
    );
  });

  it("keeps the backend representation registry intact when inspection opens", async () => {
    const { dataDir, resources } = await fixture();
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): {
          get(...params: unknown[]): Record<string, unknown> | undefined;
        };
        close(): void;
      };
    };
    const legacy = new DatabaseSync(join(dataDir, "local.sqlite"));
    legacy.exec(`
      CREATE TABLE local_asset_representations (
        source_resource_id TEXT NOT NULL,
        recipe TEXT NOT NULL,
        representation_resource_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_resource_id, recipe)
      );
    `);
    legacy.close();

    const source = await resources.install({
      kind: "image",
      bytes: new TextEncoder().encode("inspection-only image"),
      contentType: "image/png",
    });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async ({ resource }) => ({
        contentType: resource.contentType,
        width: 1,
        height: 1,
        rotationDegrees: 0,
      }),
    });
    await service.inspect({
      source,
      knownFacts: { width: 1, height: 1, contentType: "image/png" },
    });

    const inspected = new DatabaseSync(join(dataDir, "local.sqlite"));
    try {
      expect(
        inspected
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get("local_asset_representations"),
      ).toEqual({ name: "local_asset_representations" });
    } finally {
      inspected.close();
    }
  });

  it("reprobes a legacy unversioned inspection once before reusing the current recipe", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "video",
      bytes: new TextEncoder().encode("legacy inspection source"),
      contentType: "video/mp4",
    });
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): {
          run(...params: unknown[]): void;
        };
        close(): void;
      };
    };
    const legacyDatabase = new DatabaseSync(join(dataDir, "local.sqlite"));
    legacyDatabase.exec(`
      CREATE TABLE local_asset_inspections (
        source_resource_id TEXT PRIMARY KEY,
        facts_json TEXT NOT NULL,
        inspected_at INTEGER NOT NULL
      );
    `);
    legacyDatabase
      .prepare(
        `
        INSERT INTO local_asset_inspections (
          source_resource_id, facts_json, inspected_at
        ) VALUES (?, ?, ?)
      `,
      )
      .run(
        source.resource.id,
        JSON.stringify({ width: 320, height: 180 }),
        Date.now(),
      );
    legacyDatabase.close();

    let probes = 0;
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        probes += 1;
        return {
          width: 1_920,
          height: 1_080,
          rotationDegrees: 0,
          durationMs: 1_000,
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: false,
        };
      },
    });
    const first = await service.inspect({ source });

    const restarted = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        throw new Error("the current inspection recipe must be reusable");
      },
    });
    const second = await restarted.inspect({ source });

    expect(probes).toBe(1);
    expect(first.facts).toMatchObject({
      width: 1_920,
      height: 1_080,
      videoCodec: "h264",
    });
    expect(second.facts).toEqual(first.facts);
  });

  it("reprobes the v3 recipe after canonical completeness changes", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "video",
      bytes: new TextEncoder().encode("v2 inspection source"),
      contentType: "video/mp4",
    });
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): void };
        close(): void;
      };
    };
    const database = new DatabaseSync(join(dataDir, "local.sqlite"));
    database.exec(`
      CREATE TABLE IF NOT EXISTS local_asset_inspections (
        source_resource_id TEXT NOT NULL,
        recipe TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        inspected_at INTEGER NOT NULL,
        PRIMARY KEY (source_resource_id, recipe)
      );
    `);
    database
      .prepare(
        `INSERT INTO local_asset_inspections
          (source_resource_id, recipe, facts_json, inspected_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        source.resource.id,
        "asset-inspection/v3:canonical-media-facts",
        JSON.stringify({
          width: 320,
          height: 180,
          durationMs: 1_000,
          contentType: "video/mp4",
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: false,
        }),
        Date.now(),
      );
    database.close();

    let probes = 0;
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        probes += 1;
        return {
          width: 1_920,
          height: 1_080,
          rotationDegrees: 0,
          durationMs: 1_000,
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: false,
        };
      },
    });

    await expect(service.inspect({ source })).resolves.toMatchObject({
      facts: { width: 1_920, durationMs: 1_000, hasAudio: false },
    });
    expect(probes).toBe(1);
  });

  it("does not persist caller metadata as a verified Resource inspection", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "image",
      bytes: new TextEncoder().encode("progressively inspected image"),
      contentType: "image/png",
    });
    const first = createLocalAssetInspectionService({
      dataDir,
    });
    await expect(
      first.inspect({
        source,
        knownFacts: { contentType: "image/png", width: 800, height: 600 },
      }),
    ).rejects.toThrow(/byte-probe adapter/i);

    let probes = 0;
    const restarted = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        probes += 1;
        return { width: 1_920, height: 1_080, rotationDegrees: 0 };
      },
    });
    await expect(restarted.inspect({ source })).resolves.toMatchObject({
      facts: { contentType: "image/png", width: 1_920, height: 1_080 },
    });
    expect(probes).toBe(1);
  });

  it("rejects a probed audio stream without canonical sample and channel layout facts", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "audio",
      bytes: new TextEncoder().encode("incomplete audio layout probe"),
      contentType: "audio/mpeg",
    });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => ({
        durationMs: 1_000,
        hasAudio: true,
        audioCodec: "mp3",
      }),
    });

    await expect(service.inspect({ source })).rejects.toThrow(/sample rate/i);
  });

  it("rejects incomplete injected video facts before they can become a CAS winner", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "video",
      bytes: new TextEncoder().encode("incomplete injected probe"),
      contentType: "video/mp4",
    });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => ({
        width: 1_920,
        height: 1_080,
        rotationDegrees: 0,
        videoCodec: "h264",
      }),
    });

    await expect(service.inspect({ source })).rejects.toThrow(/duration/i);
  });

  it("rejects a v4 candidate without a canonical media type", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "image",
      bytes: new TextEncoder().encode("legacy image without a media type"),
    });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => ({
        width: 640,
        height: 360,
        rotationDegrees: 0,
      }),
    });

    await expect(service.inspect({ source })).rejects.toThrow(/content type/i);
  });

  it("coalesces concurrent inspection of the same immutable Resource", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "video",
      bytes: new TextEncoder().encode("concurrent inspection source"),
      contentType: "video/mp4",
    });
    let probes = 0;
    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        probes += 1;
        await probeGate;
        return {
          width: 1_920,
          height: 1_080,
          rotationDegrees: 0,
          durationMs: 2_500,
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: false,
        };
      },
    });

    const first = service.inspect({ source });
    const second = service.inspect({ source });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseProbe!();
    const [firstInspection, secondInspection] = await Promise.all([
      first,
      second,
    ]);

    expect(probes).toBe(1);
    expect(secondInspection.facts).toEqual(firstInspection.facts);
  });

  it("publishes one inspection winner when at-least-once consumers race", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "video",
      bytes: new TextEncoder().encode("multiply inspected source"),
      contentType: "video/mp4",
    });
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    let markSecondStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const firstConsumer = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        markFirstStarted!();
        await firstGate;
        return {
          width: 1_920,
          height: 1_080,
          rotationDegrees: 0,
          durationMs: 2_500,
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: false,
        };
      },
    });
    const secondConsumer = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        markSecondStarted!();
        await secondGate;
        return {
          width: 1_280,
          height: 720,
          rotationDegrees: 0,
          durationMs: 2_500,
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: false,
        };
      },
    });

    const first = firstConsumer.inspect({ source });
    const second = secondConsumer.inspect({ source });
    await Promise.all([firstStarted, secondStarted]);
    releaseFirst!();
    const winner = await first;
    releaseSecond!();

    expect(winner.facts).toMatchObject({ width: 1_920, height: 1_080 });
    await expect(second).rejects.toThrow(
      /conflicts with the inspection CAS winner/i,
    );
    const restarted = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        throw new Error("the CAS winner must be reused");
      },
    });
    await expect(restarted.inspect({ source })).resolves.toEqual(winner);
  });

  it("coalesces a failed inspection without caching ready and permits retry", async () => {
    const { dataDir, resources } = await fixture();
    const source = await resources.install({
      kind: "audio",
      bytes: new TextEncoder().encode("retryable inspection source"),
      contentType: "audio/mpeg",
    });
    let probes = 0;
    let failing = true;
    let releaseFailure: (() => void) | undefined;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const service = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        probes += 1;
        if (failing) {
          await failureGate;
          throw new Error("probe failed");
        }
        return {
          durationMs: 4_000,
          hasAudio: true,
          audioCodec: "mp3",
          sampleRate: 44_100,
          channelCount: 2,
          channelLayout: "stereo",
        };
      },
    });

    const first = service.inspect({ source });
    const second = service.inspect({ source });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFailure!();
    const failed = await Promise.allSettled([first, second]);

    expect(failed.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(probes).toBe(1);

    failing = false;
    await expect(service.inspect({ source })).resolves.toMatchObject({
      facts: { durationMs: 4_000, audioCodec: "mp3" },
    });
    expect(probes).toBe(2);
  });
});

describe("Local Asset inspection deadlines", () => {
  it.runIf(process.platform !== "win32")(
    "fails a hung ffprobe with ASSET_INSPECTION_TIMEOUT and leaves no child",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "clash-ffprobe-hang-"));
      temporaryDirectories.push(directory);
      const script = join(directory, "ffprobe-hang.mjs");
      await writeFile(
        script,
        `#!${process.execPath}\nsetTimeout(() => {}, 30_000);\n`,
      );
      await chmod(script, 0o755);
      const inspector = createLocalFfprobeAssetInspector({
        ffprobePath: script,
        timeoutMs: 100,
      });

      const started = Date.now();
      await expect(
        inspector({
          sourcePath: "/private/hang.mp4",
          resource: {
            id: `sha256:${"9".repeat(64)}`,
            kind: "video",
            digest: { algorithm: "sha256", value: "9".repeat(64) },
            byteLength: 42,
            contentType: "video/mp4",
          },
        }),
      ).rejects.toMatchObject({ code: "ASSET_INSPECTION_TIMEOUT" });
      expect(Date.now() - started).toBeLessThan(10_000);

      await vi.waitFor(
        () => {
          const children = execFileSync(
            "ps",
            ["-o", "pid=,args=", "--ppid", String(process.pid)],
            { encoding: "utf8" },
          );
          expect(children).not.toContain(script);
        },
        { timeout: 5_000, interval: 25 },
      );
    },
  );
});
