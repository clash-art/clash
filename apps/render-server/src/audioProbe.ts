/**
 * Audio metadata probe via ffmpeg-static.
 *
 * Decodes the source audio into mono 8kHz signed-16 PCM on stdout and reads
 * Duration off stderr, then downsamples the PCM stream into 128 peak values
 * normalized to 0..1 for waveform visualization.
 *
 * Why 128 peaks at 8kHz mono?
 *   - Compactness: 128 floats (each rounded to 3 decimals) fit in ~1KB of
 *     JSON — cheap to persist on the asset row and ship to the client.
 *   - UI resolution: the AssetPanel/Timeline waveform renders a small bar
 *     strip; 128 buckets is plenty of horizontal resolution without moiré.
 *   - One pass: mono downmix + 8kHz rate = ~16KB/s, so even a 10-minute clip
 *     streams ~9.6MB through stdout — still one quick ffmpeg invocation,
 *     no need for a separate ffprobe call to read Duration.
 *
 * Cloudflare has no Media-Transformations audio equivalent, so this endpoint
 * is the only backend; api-cf's services/audio-metadata.ts always dispatches
 * here (no edge fallback).
 */

import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { sourceTag } from "./observability.js";

export interface ProbeAudioParams {
  /** Absolute URL ffmpeg will fetch the audio from.
   *  Expected to be a signed `/assets/<key>` URL served by api-cf. */
  sourceUrl: string;
}

export interface ProbeAudioResult {
  durationMs: number;
  waveform: number[];
}

const PEAK_COUNT = 128;

/** Parse `Duration: HH:MM:SS.ff` off ffmpeg stderr — same regex approach as
 *  thumbnail.ts. Returns 0 if the line is missing. */
function parseDurationMs(stderr: string): number {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return 0;
  const [h, min, s, frac] = m.slice(1).map(Number);
  const fracMs = Math.round((frac / 10 ** m[4].length) * 1000);
  return h * 3_600_000 + min * 60_000 + s * 1000 + fracMs;
}

/** Bucket PCM samples into PEAK_COUNT max-abs peaks normalized to 0..1. */
function downsampleToPeaks(pcm: Buffer): number[] {
  const totalSamples = Math.floor(pcm.length / 2);
  const peaks = new Array<number>(PEAK_COUNT).fill(0);
  if (totalSamples === 0) return peaks;

  const bucketSize = Math.max(1, Math.floor(totalSamples / PEAK_COUNT));
  for (let b = 0; b < PEAK_COUNT; b++) {
    const start = b * bucketSize;
    // Last bucket sweeps to end so trailing samples aren't lost.
    const end = b === PEAK_COUNT - 1 ? totalSamples : Math.min(totalSamples, start + bucketSize);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const sample = pcm.readInt16LE(i * 2);
      const abs = sample < 0 ? -sample : sample;
      if (abs > peak) peak = abs;
    }
    // 32768 == |INT16_MIN|; safe normalization bound even if sample hits -32768.
    peaks[b] = Math.round((peak / 32768) * 1000) / 1000;
  }
  return peaks;
}

export async function probeAudio(params: ProbeAudioParams): Promise<ProbeAudioResult> {
  const { sourceUrl } = params;
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static binary not found");
  }

  // Mono 8kHz s16 PCM on stdout; Duration prints to stderr as a side effect.
  const args = [
    "-hide_banner",
    "-i", sourceUrl,
    "-ac", "1",
    "-ar", "8000",
    "-f", "s16le",
    "-",
  ];

  return new Promise<ProbeAudioResult>((resolve, reject) => {
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
            `ffmpeg exited ${code} (source=${sourceTag(sourceUrl)}): ${stderr.slice(-400)}`,
          ),
        );
        return;
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.byteLength === 0) {
        reject(new Error("ffmpeg produced empty PCM output"));
        return;
      }
      const durationMs = parseDurationMs(stderr);
      const waveform = downsampleToPeaks(pcm);
      resolve({ durationMs, waveform });
    });
  });
}
