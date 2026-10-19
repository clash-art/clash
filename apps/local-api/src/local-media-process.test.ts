import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceDir = fileURLToPath(new URL(".", import.meta.url));

async function source(name: string): Promise<string> {
  return readFile(new URL(name, import.meta.url), "utf8");
}

function callsAfter(text: string, token: string): string[] {
  return text
    .split(token)
    .slice(1)
    .map((call) => call.slice(0, 2_000));
}

describe("media process deadlines", () => {
  it("requires a signal at the runFfmpegToFile boundary", async () => {
    const runner = await source("local-ffmpeg-run.ts");
    expect(runner).toContain("signal: AbortSignal;");
    expect(runner).not.toContain("signal?: AbortSignal");
  });

  it("passes a signal to every ffmpeg/ffprobe spawn and runFfmpegToFile call", async () => {
    const offenders: string[] = [];
    for (const file of [
      "local-ffmpeg-run.ts",
      "local-asset-representations.ts",
    ]) {
      const text = await source(file);
      for (const call of callsAfter(text, "spawn(")) {
        if (!call.includes("signal")) offenders.push(`${file}: spawn(`);
      }
    }
    for (const { file, mediaOnly } of [
      { file: "local-asset-inspections.ts", mediaOnly: false },
      { file: "app.ts", mediaOnly: true },
      { file: "fal-mock.ts", mediaOnly: true },
    ]) {
      const text = await source(file);
      for (const call of callsAfter(text, "execFileAsync(")) {
        if (mediaOnly && !/\bffmpeg\b|\bffprobe\b/.test(call)) continue;
        if (!call.includes("signal")) {
          offenders.push(`${file}: execFileAsync(`);
        }
      }
    }
    for (const file of [
      "local-ffmpeg-run.ts",
      "local-asset-representations.ts",
      "local-speech-transcription.ts",
    ]) {
      const text = await source(file);
      for (const call of callsAfter(text, "runFfmpegToFile(")) {
        if (!call.includes("signal")) {
          offenders.push(`${file}: runFfmpegToFile(`);
        }
      }
    }

    expect(offenders, `${sourceDir}: ${offenders.join(", ")}`).toEqual([]);
  });
});
