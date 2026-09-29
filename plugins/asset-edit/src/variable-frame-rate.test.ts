import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import ffprobe from "@ffprobe-installer/ffprobe";
import { expect, it } from "vitest";
import { plugin } from "./stdio.js";

const exec = promisify(execFile);

async function videoTiming(path: string) {
  const { stdout } = await exec(ffprobe.path, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=r_frame_rate,avg_frame_rate:frame=best_effort_timestamp_time",
    "-of",
    "json",
    path,
  ]);
  return JSON.parse(stdout) as {
    streams: Array<{ r_frame_rate: string; avg_frame_rate: string }>;
    frames: Array<{ best_effort_timestamp_time: string }>;
  };
}

function rate(value: string) {
  const [numerator, denominator] = value.split("/").map(Number);
  return numerator! / denominator!;
}

it("trims only source frames and preserves their variable timestamps rather than filling the nominal frame rate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clash-edit-vfr-"));
  try {
    const sourcePath = join(directory, "source.mp4");
    // Real VFR media: two frames per eight 120 Hz ticks, with fine timestamp
    // jitter. ffprobe reports nominal 120 fps but only about 30 actual fps.
    await exec(ffmpeg.path, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=32x16:r=120:d=2",
      "-vf",
      "select='eq(mod(n,8),0)+eq(mod(n,8),3)',settb=1/120000,setpts='PTS+mod(N,3)*7'",
      "-vsync",
      "passthrough",
      "-enc_time_base",
      "1/120000",
      "-c:v",
      "libx264",
      "-g",
      "240",
      "-pix_fmt",
      "yuv420p",
      sourcePath,
    ]);
    const source = await readFile(sourcePath);
    const sourceTiming = await videoTiming(sourcePath);
    expect(rate(sourceTiming.streams[0]!.r_frame_rate)).toBeGreaterThan(
      3 * rate(sourceTiming.streams[0]!.avg_frame_rate),
    );
    const startSec = 0.4;
    const endSec = 1.4;
    const expectedTimes = sourceTiming.frames
      .map((frame) => Number(frame.best_effort_timestamp_time))
      .filter((time) => time >= startSec && time < endSec)
      .map((time) => time - startSec);
    let uploaded: Uint8Array | undefined;

    await plugin.invoke(
      {
        protocol: "clash.plugin.invoke/v1",
        invocationId: "vfr-trim",
        taskId: "vfr-trim",
        projectId: "project",
        target: {
          pluginId: "clash.asset-edit",
          version: "1.0.0",
          exportId: "video-clipper",
          schemaHash: `sha256:${"a".repeat(64)}`,
          kind: "action",
        },
        operation: "submit",
        actor: { kind: "agent", id: "test" },
        assetInputs: [],
        input: {
          values: { __generatorActionId: "crop", startSec, endSec },
          references: [
            {
              slot: "source",
              index: 0,
              asset: {
                assetId: "source",
                uri: "clash-asset://source",
                kind: "video",
              },
            },
          ],
        },
      },
      {
        reference: async () => ({
          form: "bytes",
          bytes: source,
          kind: "video",
        }),
        upload: async (request) => {
          uploaded = request.bytes;
          return {
            slot: "output",
            kind: "asset",
            asset: {
              assetId: "trimmed",
              uri: "clash-asset://trimmed",
              kind: "video",
            },
          };
        },
      },
    );

    expect(uploaded).toBeDefined();
    const outputPath = join(directory, "trimmed.mp4");
    await writeFile(outputPath, uploaded!);
    const output = await videoTiming(outputPath);
    const outputTimes = output.frames.map((frame) =>
      Number(frame.best_effort_timestamp_time),
    );
    expect(outputTimes).toHaveLength(expectedTimes.length);
    for (const [index, time] of expectedTimes.entries()) {
      // ffprobe prints microsecond precision. This also catches quantization
      // to 1/nominal-fps even when duplicate frames have been disabled.
      expect(outputTimes[index]).toBeCloseTo(time, 5);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
