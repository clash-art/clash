import { execFile } from "node:child_process";
import { mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { MODEL_CARDS } from "@clash/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalAudioConfigStore } from "./audio-config.js";
import { localFfmpegPath } from "./local-media-binaries.js";
import { createLocalSpeechTranscriptionService } from "./local-speech-transcription.js";

const realFfmpeg = localFfmpegPath();

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function transcript(modelId: string) {
  return {
    schemaVersion: 1 as const,
    kind: "clash.asr.timed-transcript" as const,
    timebase: "milliseconds" as const,
    alignment: "word" as const,
    text: "hello world",
    backendId: "funasr",
    modelId,
    language: "en",
    durationMs: 920,
    words: [
      { id: "word-1", text: "hello", startMs: 80, endMs: 410 },
      { id: "word-2", text: "world", startMs: 500, endMs: 920 },
    ],
    segments: [
      {
        id: "segment-1",
        text: "hello world",
        startMs: 80,
        endMs: 920,
        wordIds: ["word-1", "word-2"],
      },
    ],
  };
}

describe("Local speech transcription Host capability", () => {
  it("maps a canonical ASR card to its runtime model and preserves real word timing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-asr-generator-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.wav");
    await writeFile(sourcePath, Buffer.from("RIFF-real-audio"));
    const card = MODEL_CARDS.find(
      (candidate) => candidate.id === "sensevoice-small-asr",
    );
    expect(card).toBeDefined();
    const runtimeModel = card?.defaultParams.asr_model;
    expect(typeof runtimeModel).toBe("string");
    if (typeof runtimeModel !== "string") return;

    const transcribe = vi.fn<LocalAudioConfigStore["transcribe"]>(
      async ({ model }) => transcript(model ?? "missing"),
    );
    const service = createLocalSpeechTranscriptionService({
      audioConfig: { transcribe },
      openAsset: async () => ({
        kind: "audio",
        path: sourcePath,
        contentType: "audio/wav",
      }),
    });

    await expect(
      service({
        projectId: "project-1",
        invocationId: "invocation-1",
        taskId: "run-1",
        reference: {
          slot: "source",
          index: 0,
          asset: {
            assetId: "audio-1",
            uri: "clash-asset://audio-1",
            kind: "audio",
            mediaType: "audio/wav",
          },
        },
        modelId: "sensevoice-small-asr",
        language: "en",
      }),
    ).resolves.toEqual({
      status: "completed",
      transcript: transcript("sensevoice-small-asr"),
    });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledWith({
      file: expect.objectContaining({ name: "source.wav", type: "audio/wav" }),
      language: "en",
      model: runtimeModel,
    });
  });

  it("fails closed for an undeclared ASR model, a non-media source, or foreign poll state", async () => {
    const transcribe = vi.fn<LocalAudioConfigStore["transcribe"]>();
    const openAsset = vi.fn(async () => ({
      kind: "image" as const,
      path: "/private/source.png",
      contentType: "image/png",
    }));
    const service = createLocalSpeechTranscriptionService({
      audioConfig: { transcribe },
      openAsset,
    });
    const request = {
      projectId: "project-1",
      invocationId: "invocation-1",
      taskId: "run-1",
      reference: {
        slot: "source" as const,
        index: 0,
        asset: {
          assetId: "audio-1",
          uri: "clash-asset://audio-1",
          kind: "audio" as const,
          mediaType: "audio/wav",
        },
      },
      modelId: "not-a-declared-asr-card",
    };

    await expect(service(request)).rejects.toThrow(
      "not a declared local ASR model",
    );
    await expect(
      service({
        ...request,
        modelId: "sensevoice-small-asr",
      }),
    ).rejects.toThrow("is not an audio or video Asset");
    await expect(
      service({
        ...request,
        modelId: "sensevoice-small-asr",
        poll: { token: "foreign" },
      }),
    ).rejects.toThrow("does not issue poll state");
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("Local speech transcription source bytes", () => {
  function videoRequest() {
    return {
      projectId: "project-1",
      invocationId: "invocation-1",
      taskId: "run-1",
      reference: {
        slot: "source" as const,
        index: 0,
        asset: {
          assetId: "video-1",
          uri: "clash-asset://video-1",
          kind: "video" as const,
          mediaType: "video/mp4",
        },
      },
      modelId: "sensevoice-small-asr",
    };
  }

  /** Captures what the runtime would receive, read while the File is live. */
  function capturingTranscribe() {
    const seen: { name: string; type: string; size: number; head: Buffer }[] =
      [];
    const transcribe = vi.fn<LocalAudioConfigStore["transcribe"]>(
      async ({ file, model }) => {
        seen.push({
          name: file.name,
          type: file.type,
          size: file.size,
          head: Buffer.from(await file.slice(0, 16).arrayBuffer()),
        });
        return transcript(model ?? "missing");
      },
    );
    return { transcribe, seen };
  }

  async function sourceFile(name: string, bytes: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "clash-asr-source-"));
    directories.push(directory);
    const sourcePath = join(directory, name);
    await writeFile(sourcePath, bytes);
    return sourcePath;
  }

  it.skipIf(!realFfmpeg)(
    "transcribes a video from its extracted audio track and removes the temporary file",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "clash-asr-video-"));
      directories.push(directory);
      const sourcePath = join(directory, "clip.mp4");
      await promisify(execFile)(realFfmpeg!, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x64:rate=5:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-shortest",
        sourcePath,
      ]);
      const sourceSize = (await stat(sourcePath)).size;
      const { transcribe, seen } = capturingTranscribe();
      const service = createLocalSpeechTranscriptionService({
        audioConfig: { transcribe },
        openAsset: async () => ({
          kind: "video",
          path: sourcePath,
          contentType: "video/mp4",
        }),
        ffmpegPath: () => realFfmpeg,
      });
      const before = new Set(await readdir(tmpdir()));

      await expect(service(videoRequest())).resolves.toMatchObject({
        status: "completed",
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.name).toBe("clip.flac");
      expect(seen[0]!.type).toBe("audio/flac");
      // "fLaC" is the FLAC stream marker: the runtime got audio, not the mp4.
      expect(seen[0]!.head.subarray(0, 4).toString("latin1")).toBe("fLaC");
      expect(seen[0]!.size).not.toBe(sourceSize);
      expect(
        (await readdir(tmpdir())).filter(
          (entry) =>
            entry.startsWith("clash-asr-audio-") && !before.has(entry),
        ),
      ).toEqual([]);
    },
  );

  it("transcribes the original video when ffmpeg is unavailable", async () => {
    const sourcePath = await sourceFile("clip.mp4", "original-video-bytes");
    const { transcribe, seen } = capturingTranscribe();
    const service = createLocalSpeechTranscriptionService({
      audioConfig: { transcribe },
      openAsset: async () => ({
        kind: "video",
        path: sourcePath,
        contentType: "video/mp4",
      }),
      ffmpegPath: () => null,
    });

    await service(videoRequest());

    expect(seen).toEqual([
      {
        name: "clip.mp4",
        type: "video/mp4",
        size: 20,
        head: Buffer.from("original-video-b"),
      },
    ]);
  });

  it("transcribes the original video when audio extraction fails", async () => {
    const sourcePath = await sourceFile("clip.mp4", "original-video-bytes");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { transcribe, seen } = capturingTranscribe();
    const service = createLocalSpeechTranscriptionService({
      audioConfig: { transcribe },
      openAsset: async () => ({
        kind: "video",
        path: sourcePath,
        contentType: "video/mp4",
      }),
      ffmpegPath: () => join(dirname(sourcePath), "missing-ffmpeg"),
    });

    try {
      await service(videoRequest());
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: "clip.mp4", type: "video/mp4" });
  });

  it("hands over a multi-gigabyte source without reading it into memory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-asr-large-"));
    directories.push(directory);
    const sourcePath = join(directory, "long.mp4");
    // Sparse: 3 GiB is more than one fs.readFile call can return.
    const byteLength = 3 * 1024 ** 3;
    const handle = await open(sourcePath, "w");
    try {
      await handle.truncate(byteLength);
    } finally {
      await handle.close();
    }
    const { transcribe, seen } = capturingTranscribe();
    const service = createLocalSpeechTranscriptionService({
      audioConfig: { transcribe },
      openAsset: async () => ({
        kind: "video",
        path: sourcePath,
        contentType: "video/mp4",
      }),
      ffmpegPath: () => null,
    });

    await service(videoRequest());

    expect(seen[0]).toMatchObject({ name: "long.mp4", size: byteLength });
  });
});
