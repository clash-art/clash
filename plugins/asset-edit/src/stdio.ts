import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import {
  ProviderExecutionError,
  servePluginStdio,
  type ResolvedReference,
} from "@clash/action-sdk";
import {
  createAssetEditPluginModule,
  type AssetEditExecutionInput,
} from "@clash/shared-runtime/browser";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

function invalidRange(providerCode: string, message: string): never {
  throw new ProviderExecutionError({
    code: "invalid_request",
    providerCode,
    message,
    retryable: false,
    requestState: "rejected",
  });
}

async function resolvedBytes(
  reference: ResolvedReference,
): Promise<Uint8Array> {
  if (reference.form === "bytes") return reference.bytes;
  if (reference.form === "executor-url" || reference.form === "provider-url") {
    const url =
      reference.form === "executor-url"
        ? reference.executorUrl
        : reference.providerUrl;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Asset source download failed (${response.status}).`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  throw new Error("Asset edit requires a binary media reference.");
}

async function renderImage(input: AssetEditExecutionInput, bytes: Uint8Array) {
  if (input.invocation.actionId !== "image-editor") {
    throw new Error("Image renderer received a video Action.");
  }
  let pipeline = sharp(bytes);
  if (input.invocation.params.crop) {
    const { x, y, width, height } = input.invocation.params.crop;
    const source = await pipeline.metadata();
    if (
      !source.width ||
      !source.height ||
      x + width > source.width ||
      y + height > source.height
    ) {
      invalidRange(
        "ASSET_EDIT_CROP_OUT_OF_BOUNDS",
        "Crop rectangle must stay within the source image dimensions.",
      );
    }
    pipeline = pipeline.extract({ left: x, top: y, width, height });
  }
  if (input.invocation.params.rotation) {
    pipeline = pipeline.rotate(input.invocation.params.rotation);
  }
  return new Uint8Array(await pipeline.png().toBuffer());
}

async function renderVideo(
  input: AssetEditExecutionInput,
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; kind: "image" | "video"; mediaType: string }> {
  if (input.invocation.actionId !== "video-clipper") {
    throw new Error("Video renderer received an image Action.");
  }
  const directory = await mkdtemp(join(tmpdir(), "clash-asset-edit-"));
  const sourcePath = join(directory, "source-media");
  const screenshot = input.invocation.params.mode === "screenshot";
  const outputPath = join(directory, screenshot ? "output.png" : "output.mp4");
  await writeFile(sourcePath, bytes);
  try {
    const params = input.invocation.params;
    const probe = JSON.parse(
      (
        await execFileAsync(ffprobeInstaller.path, [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=duration:format=duration",
          "-of",
          "json",
          sourcePath,
        ])
      ).stdout,
    ) as {
      streams?: Array<{ duration?: string }>;
      format?: { duration?: string };
    };
    const streamDuration = Number(probe.streams?.[0]?.duration);
    const duration =
      Number.isFinite(streamDuration) && streamDuration > 0
        ? streamDuration
        : Number(probe.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      invalidRange(
        "ASSET_EDIT_DURATION_UNAVAILABLE",
        "The source video duration could not be determined; use a video with a finite duration.",
      );
    }
    if (params.mode === "screenshot" && params.frameTimeSec >= duration) {
      invalidRange(
        "ASSET_EDIT_FRAME_OUT_OF_RANGE",
        "Frame time must be before the source video duration.",
      );
    }
    if (
      params.mode === "crop" &&
      (params.startSec >= duration || params.endSec > duration)
    ) {
      invalidRange(
        "ASSET_EDIT_TRIM_OUT_OF_RANGE",
        "Trim start and end must lie within the source video duration.",
      );
    }
    await execFileAsync(
      ffmpegInstaller.path,
      params.mode === "screenshot"
        ? [
            "-y",
            "-ss",
            String(params.frameTimeSec),
            "-i",
            sourcePath,
            "-frames:v",
            "1",
            outputPath,
          ]
        : [
            "-y",
            "-ss",
            String(params.startSec),
            "-i",
            sourcePath,
            "-t",
            String(params.endSec - params.startSec),
            // Decode the seek boundary: stream-copy retains keyframe preroll and
            // can publish a clip longer than the requested frame interval.
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            // Preserve VFR frames instead of filling the nominal frame rate.
            // The bundled FFmpeg 4.4 uses -vsync rather than -fps_mode.
            "-vsync",
            "passthrough",
            // Keep the source timebase so VFR timestamps are not rounded to
            // 1/nominal-fps by the encoder (FFmpeg 4.4 -enc_time_base contract).
            "-enc_time_base:v",
            "-1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            outputPath,
          ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const output = await readFile(outputPath).catch((error) => {
      if (screenshot && (error as NodeJS.ErrnoException).code === "ENOENT") {
        invalidRange(
          "ASSET_EDIT_FRAME_UNAVAILABLE",
          "No decodable frame exists at this time; choose an earlier frame time within the source video duration.",
        );
      }
      throw error;
    });
    return {
      bytes: new Uint8Array(output),
      kind: screenshot ? "image" : "video",
      mediaType: screenshot ? "image/png" : "video/mp4",
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const plugin = createAssetEditPluginModule(async (input, context) => {
  if (!input.reference) {
    throw new Error("Asset edit requires one frozen source reference.");
  }
  const source = await resolvedBytes(await context.reference(input.reference));
  if (input.invocation.actionId === "image-editor") {
    return context.upload({
      slot: "output",
      kind: "image",
      mediaType: "image/png",
      bytes: await renderImage(input, source),
    });
  }
  const output = await renderVideo(input, source);
  return context.upload({ slot: "output", ...output });
});

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  void servePluginStdio(plugin).done;
}
