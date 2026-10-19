import { openAsBlob } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import {
  AsrTimedTranscriptSchema,
  ExecutableSpeechTranscriptionResultSchema,
  MODEL_CARDS,
  type AssetKind,
  type ExecutablePluginJsonValue,
  type ExecutableSpeechTranscriptionReference,
  type ExecutableSpeechTranscriptionResult,
} from "@clash/shared-types";

import type { LocalAudioConfigStore } from "./audio-config.js";
import { runFfmpegToFile } from "./local-ffmpeg-run.js";
import {
  LocalMediaProcessTimeoutError,
  MEDIA_PROCESS_TIMEOUTS_MS,
  withMediaProcessDeadline,
} from "./local-media-process.js";
import { localFfmpegPath } from "./local-media-binaries.js";

export interface LocalSpeechTranscriptionRequest {
  projectId: string;
  invocationId: string;
  taskId: string;
  reference: ExecutableSpeechTranscriptionReference;
  modelId: string;
  language?: string;
  poll?: ExecutablePluginJsonValue;
}

export interface LocalSpeechTranscriptionSource {
  kind: AssetKind;
  path: string;
  contentType?: string;
}

function runtimeModelForCanonicalAsrCard(modelId: string): string {
  const card = MODEL_CARDS.find((candidate) => candidate.id === modelId);
  const runtimeModel = card?.defaultParams.asr_model;
  if (
    !card?.input.inputMode.audios ||
    typeof runtimeModel !== "string" ||
    !runtimeModel.trim()
  ) {
    throw new Error(`${modelId} is not a declared local ASR model.`);
  }
  return runtimeModel.trim();
}

/**
 * Speech models resample to 16 kHz mono, so the extracted track is stored at
 * that shape. FLAC keeps it lossless: an hour of speech is tens of megabytes
 * where the video it came from can be tens of gigabytes.
 */
export function speechAudioExtractionArgs(input: {
  sourcePath: string;
  outputPath: string;
}): string[] {
  return [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-i",
    input.sourcePath,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "flac",
    input.outputPath,
  ];
}

/** A disk-backed File: its bytes are read only when the consumer streams it. */
async function fileBackedFile(
  path: string,
  name: string,
  type: string,
): Promise<File> {
  return new File([await openAsBlob(path, { type })], name, { type });
}

/**
 * Host implementation of the narrow `speech.transcribe` capability reserved
 * for the trusted first-party ASR plugin. The plugin sees neither local paths
 * nor runtime model identifiers; its semantic request keeps the canonical
 * model-card id while this adapter maps it at the execution boundary.
 */
export function createLocalSpeechTranscriptionService(options: {
  audioConfig: Pick<LocalAudioConfigStore, "transcribe">;
  openAsset: (input: {
    projectId: string;
    projectAssetId: string;
  }) => Promise<LocalSpeechTranscriptionSource>;
  /** Resolves the ffmpeg used to extract a video's audio track. */
  ffmpegPath?: () => string | null;
  /** Deadline for extracting a video's audio track; tests inject a short one. */
  audioExtractionTimeoutMs?: number;
}): (
  input: LocalSpeechTranscriptionRequest,
) => Promise<ExecutableSpeechTranscriptionResult> {
  return async (input) => {
    if (input.poll !== undefined) {
      throw new Error(
        "The Local ASR runtime completes synchronously and does not issue poll state.",
      );
    }
    const runtimeModel = runtimeModelForCanonicalAsrCard(input.modelId);
    const source = await options.openAsset({
      projectId: input.projectId,
      projectAssetId: input.reference.asset.assetId,
    });
    if (
      (source.kind !== "audio" && source.kind !== "video") ||
      source.kind !== input.reference.asset.kind
    ) {
      throw new Error(
        `Project Asset ${input.reference.asset.assetId} is not an audio or video Asset matching the frozen reference.`,
      );
    }
    const sourceType =
      source.contentType ??
      input.reference.asset.mediaType ??
      "application/octet-stream";
    const ffmpeg =
      source.kind === "video"
        ? (options.ffmpegPath ?? localFfmpegPath)()
        : null;
    const workDir = ffmpeg
      ? await mkdtemp(join(tmpdir(), "clash-asr-audio-"))
      : undefined;
    try {
      let file: File | undefined;
      if (ffmpeg && workDir) {
        const name = `${basename(source.path, extname(source.path))}.flac`;
        const audioPath = join(workDir, name);
        try {
          await withMediaProcessDeadline(
            {
              code: "SPEECH_AUDIO_EXTRACTION_TIMEOUT",
              timeoutMs:
                options.audioExtractionTimeoutMs ??
                MEDIA_PROCESS_TIMEOUTS_MS.speechAudioExtraction,
              task: `extract audio from ${basename(source.path)}`,
            },
            (signal) =>
              runFfmpegToFile({
                ffmpeg,
                args: speechAudioExtractionArgs({
                  sourcePath: source.path,
                  outputPath: audioPath,
                }),
                task: `extract audio from ${basename(source.path)}`,
                signal,
              }),
          );
          file = await fileBackedFile(audioPath, name, "audio/flac");
        } catch (error) {
          // A deadline is a coded failure of the operation, not a format the
          // runtime can fall back to.
          if (error instanceof LocalMediaProcessTimeoutError) throw error;
          // The runtime decodes containers itself; extraction only bounds
          // memory, so a source ffmpeg cannot split is transcribed as it is.
          console.warn(
            "[local-api] speech audio extraction failed; transcribing the original file",
            error,
          );
        }
      }
      file ??= await fileBackedFile(
        source.path,
        basename(source.path),
        sourceType,
      );
      const transcript = await options.audioConfig.transcribe({
        file,
        ...(input.language === undefined ? {} : { language: input.language }),
        model: runtimeModel,
      });
      return ExecutableSpeechTranscriptionResultSchema.parse({
        status: "completed",
        transcript: AsrTimedTranscriptSchema.parse({
          ...transcript,
          modelId: input.modelId,
        }),
      });
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  };
}
