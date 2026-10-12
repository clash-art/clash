/**
 * Video thumbnail extraction via ffmpeg-static.
 *
 * Co-located with Remotion rendering because both operations need the same
 * video toolchain; keeping Chromium + ffmpeg in one container avoids a second
 * image build.
 *
 * In production this runs inside the Remotion Container; in local dev it's
 * served at :8080 directly. api-cf's services/thumbnail.ts is the only caller
 * and chooses this path when `env.RENDER_SERVER_URL` is set, otherwise it
 * falls back to Cloudflare Media Transformations at the edge.
 */

import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { sourceTag } from "./observability.js";

export interface ExtractFrameParams {
  /** Absolute URL the ffmpeg process will fetch the source video from.
   *  Expected to be a signed `/assets/<key>` URL served by api-cf. */
  sourceUrl: string;
  /** Seconds into the video. Default 1. */
  timeSec?: number;
  /** Output format. Default jpg. */
  format?: "jpg" | "png" | "webp";
  /** Optional max width; if set, ffmpeg scales with aspect preserved. */
  width?: number;
}

export interface ExtractFrameResult {
  bytes: Uint8Array;
  contentType: string;
  /** Source video dimensions parsed from ffmpeg stderr. */
  sourceWidth?: number;
  sourceHeight?: number;
  /** Source video duration in milliseconds. */
  durationMs?: number;
}

const codecForFormat = (f: ExtractFrameParams["format"]) =>
  f === "png" ? "png" : f === "webp" ? "libwebp" : "mjpeg";

const contentTypeForFormat = (f: ExtractFrameParams["format"]) =>
  f === "png" ? "image/png" : f === "webp" ? "image/webp" : "image/jpeg";

/**
 * Parse ffmpeg stderr for source video metadata. We pull this as a side effect
 * of the frame extraction because ffmpeg has already opened the container —
 * the info is free, a separate `ffprobe` call would double the work.
 *
 * Stderr format (stable across ffmpeg versions):
 *   Duration: 00:00:04.05, start: 0.000000, bitrate: 1234 kb/s
 *   Stream #0:0(...): Video: h264 ... 1920x1080 [SAR 1:1 DAR 16:9], ...
 *
 * Matches:
 *   Duration — colon-separated HMS with centisecond fraction
 *   Video dimensions — first "WIDTHxHEIGHT" inside a "Video:" line (skip
 *     the "SAR/DAR" aspect-ratio tokens that follow)
 */
function parseStderrMetadata(stderr: string): {
  width?: number;
  height?: number;
  durationMs?: number;
} {
  const out: { width?: number; height?: number; durationMs?: number } = {};

  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (durMatch) {
    const [h, m, s, frac] = durMatch.slice(1).map(Number);
    const fracMs = Math.round((frac / 10 ** durMatch[4].length) * 1000);
    out.durationMs = h * 3_600_000 + m * 60_000 + s * 1000 + fracMs;
  }

  const videoLine = stderr.split("\n").find((l) => /Stream #\d+:\d+.*Video:/.test(l));
  if (videoLine) {
    // First WxH that isn't prefixed by SAR/DAR.
    const dims = videoLine.match(/(?<![A-Z]\s)(\d{2,5})x(\d{2,5})/);
    if (dims) {
      out.width = Number(dims[1]);
      out.height = Number(dims[2]);
    }
  }

  return out;
}

export async function extractFrame(params: ExtractFrameParams): Promise<ExtractFrameResult> {
  const { sourceUrl } = params;
  const timeSec = params.timeSec ?? 1;
  const format = params.format ?? "jpg";

  if (!Number.isFinite(timeSec) || timeSec < 0) {
    throw new Error(`invalid timeSec: ${timeSec}`);
  }
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static binary not found");
  }

  // Output-level seek (-ss AFTER -i): ffmpeg decodes from the first frame
  // up to timeSec, then emits the frame. Slower than input-seek but robust
  // for every edge case we hit in practice — short videos where input-seek
  // overshoots EOF, HTTP sources that don't honor Range (ffmpeg reads the
  // whole body once to pick up the trailing moov), containers without
  // accurate keyframe indexes. /thumbnail isn't on a hot path, so paying
  // the decode cost once is cheaper than maintaining JS-side retry logic.
  const args = [
    "-hide_banner",
    "-i", sourceUrl,
    "-ss", String(timeSec),
    "-frames:v", "1",
    "-f", "image2",
    "-c:v", codecForFormat(format),
    ...(params.width && Number.isFinite(params.width)
      ? ["-vf", `scale=${Math.floor(params.width)}:-2`]
      : []),
    "-",
  ];

  return new Promise<ExtractFrameResult>((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpegPath as string, args);
    } catch (e) {
      reject(new Error(`ffmpeg spawn failed: ${(e as Error).message}`));
      return;
    }

    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg process error: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `ffmpeg exited ${code} (source=${sourceTag(sourceUrl)}, time=${timeSec}s): ${stderr.slice(-400)}`,
          ),
        );
        return;
      }
      const bytes = new Uint8Array(Buffer.concat(chunks));
      if (bytes.byteLength === 0) {
        reject(
          new Error(
            `ffmpeg produced empty output (source=${sourceTag(sourceUrl)}, time=${timeSec}s): ${stderr.slice(-400)}`,
          ),
        );
        return;
      }
      const meta = parseStderrMetadata(stderr);
      resolve({
        bytes,
        contentType: contentTypeForFormat(format),
        sourceWidth: meta.width,
        sourceHeight: meta.height,
        durationMs: meta.durationMs,
      });
    });
  });
}
