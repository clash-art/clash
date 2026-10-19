import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";

import {
  DurableRunEngine,
  createDurableRunRecord,
  type DurableProviderFailure,
  type DurableRunOperation,
  type DurableRunRecord,
} from "@clash/shared-runtime";
import { PROJECT_ASSET_IMPORT_STAGING_CLEANUP_FAILED } from "@clash/shared-runtime/cloud-project-host/project-asset-import-sessions";
import type {
  AssetKind,
  ExecutablePluginJsonValue,
  ExecutablePluginOutput,
} from "@clash/shared-types";

import type {
  LocalAssetInspectionFacts,
  LocalAssetInspectionService,
} from "./local-asset-inspections.js";
import { runFfmpegToFile } from "./local-ffmpeg-run.js";
import { loadSharp } from "./local-image-codec.js";
import { localFfmpegPath } from "./local-media-binaries.js";
import {
  LocalMediaProcessTimeoutError,
  MEDIA_PROCESS_TIMEOUTS_MS,
  withMediaProcessDeadline,
} from "./local-media-process.js";
import {
  createSqliteDurableRunJournal,
  type SqliteDurableRunJournal,
} from "./durable-run-journal.js";
import {
  createLocalResourceStore,
  type LocalResourceProjection,
  type LocalResourceStore,
  type LocalResourceStoreEvent,
} from "./local-resource-store.js";
import {
  createLocalSqliteConnection,
  type LocalSqliteRunResult,
} from "./local-sqlite-connection.js";
import {
  createBoundedWorkQueue,
  WorkQueueClosedError,
} from "./bounded-work-queue.js";

export type LocalAssetRepresentationRole = "thumbnail" | "waveform" | "proxy";

export type LocalAssetRepresentationFailureCode =
  "REPRESENTATION_FAILED" | "REPRESENTATION_INTERRUPTED";

/** A coded, user-visible reason a representation is not available yet. */
export interface LocalAssetRepresentationFailure {
  role: LocalAssetRepresentationRole;
  code: LocalAssetRepresentationFailureCode;
  message: string;
  /** When the next bounded retry is due; absent after retries are exhausted. */
  retryAt?: number;
  attempts: number;
}

const AUDIO_WAVEFORM_BARS = 128;

export type LocalAssetRepresentation =
  | {
      role: "thumbnail";
      recipe: string;
      resourceId: string;
    }
  | {
      /** A lighter video for preview and editing; never a render source. */
      role: "proxy";
      recipe: string;
      resourceId: string;
    }
  | {
      role: "waveform";
      recipe: string;
      peaks: number[];
      durationMs?: number;
    };

export interface LocalAssetRepresentationRecipe {
  id: string;
  version: number;
  role: LocalAssetRepresentationRole;
  outputSlot: string;
  parameters: Record<string, string | number | boolean>;
}

interface FrozenRepresentationInput {
  schemaVersion: 1;
  targetKind: "representation";
  sourceResourceId: string;
  sourceKind: AssetKind;
  recipe: LocalAssetRepresentationRecipe;
}

export type LocalAssetRepresentationCandidate =
  | {
      kind: "resource";
      role: "thumbnail";
      stagedResourceId: string;
      resourceKind: "image";
      contentType: "image/webp";
    }
  | {
      kind: "resource";
      role: "proxy";
      stagedResourceId: string;
      resourceKind: "video";
      contentType: "video/mp4";
    }
  | {
      kind: "waveform";
      role: "waveform";
      peaks: number[];
      durationMs?: number;
    };

export type LocalAssetRepresentationRecipeRunner = (input: {
  source: LocalResourceProjection;
  recipe: LocalAssetRepresentationRecipe;
  /** Aborted when the Host closes, so a long derivation does not outlive it. */
  signal: AbortSignal;
}) => Promise<LocalAssetRepresentationCandidate>;

export interface LocalAssetRepresentationService {
  /** Enqueues every current recipe for one immutable source without blocking its Asset read. */
  schedule(sourceResourceId: string): void;
  /**
   * Queues a low-priority backstop for a source whose representation is missing
   * but not failing. Deduped, retry-aware, and never awaited by a request; the
   * queue runs at most one background derivation at a time.
   */
  scheduleBackground?(sourceResourceId: string): void;
  /** Drives current recipes until they are ready or waiting for a durable retry. */
  ensure(sourceResourceId: string): Promise<LocalAssetRepresentation[]>;
  read(
    sourceResourceId: string,
    role: LocalAssetRepresentationRole,
  ): Promise<LocalAssetRepresentation | undefined>;
  /**
   * Reads a representation when the caller already knows the immutable source
   * kind, avoiding a redundant Resource lookup. The recipe table is keyed by
   * kind, not by the row this Host would resolve.
   */
  readForKind?(
    sourceResourceId: string,
    sourceKind: AssetKind,
    role: LocalAssetRepresentationRole,
  ): Promise<LocalAssetRepresentation | undefined>;
  /** Coded state of the last failed or interrupted derivation for one role. */
  failure?(
    sourceResourceId: string,
    role: LocalAssetRepresentationRole,
  ): Promise<LocalAssetRepresentationFailure | undefined>;
  openThumbnail(
    sourceResourceId: string,
  ): Promise<LocalResourceProjection | undefined>;
  /** The playback proxy of a video source, once one exists. */
  openProxy(
    sourceResourceId: string,
  ): Promise<LocalResourceProjection | undefined>;
  /** Reclaims owner-private work after a Host restart. */
  start(): Promise<void>;
  /** Stops wake scheduling and waits for already-started derivations to settle. */
  close(): Promise<void>;
}

const IMAGE_THUMBNAIL_RECIPE: LocalAssetRepresentationRecipe = {
  id: "image-thumbnail",
  version: 1,
  role: "thumbnail",
  outputSlot: "thumbnail",
  parameters: {
    format: "webp",
    maxWidth: 512,
    maxHeight: 512,
    fit: "inside",
    quality: 78,
  },
};

const VIDEO_POSTER_RECIPE: LocalAssetRepresentationRecipe = {
  id: "video-poster",
  version: 1,
  role: "thumbnail",
  outputSlot: "thumbnail",
  parameters: {
    frame: "first",
    format: "webp",
    maxWidth: 512,
    maxHeight: 512,
    fit: "inside",
    quality: 78,
  },
};

const AUDIO_WAVEFORM_RECIPE: LocalAssetRepresentationRecipe = {
  id: "audio-waveform",
  version: 1,
  role: "waveform",
  outputSlot: "waveform",
  parameters: {
    bars: 128,
    analysisHeight: 64,
    channelMode: "mono-max",
    normalization: "peak",
  },
};

const VIDEO_PROXY_SHORT_SIDE = 720;

const VIDEO_PROXY_RECIPE: LocalAssetRepresentationRecipe = {
  id: "video-proxy",
  version: 1,
  role: "proxy",
  outputSlot: "proxy",
  parameters: {
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    maxShortSide: VIDEO_PROXY_SHORT_SIDE,
    preset: "veryfast",
    crf: 23,
    keyframeInterval: 30,
    audioBitrateKbps: 128,
  },
};

const DEFAULT_OWNER_ID = "local-api:representations";
const RUN_LIFETIME_MS = 24 * 60 * 60_000;
/**
 * A transcode of hours of footage is one submit attempt. Its lease must
 * outlast the encode, or recovery would start a second ffmpeg beside it.
 */
const PROXY_SUBMIT_TIMEOUT_MS = 6 * 60 * 60_000;
/**
 * A Host stop interrupts an encode; retrying every restart would re-read whole
 * media files forever. Retry deliberately, with a bounded exponential backoff.
 */
const INTERRUPTED_RETRY_BASE_MS = 30_000;
const REPRESENTATION_RETRY_MAX_MS = 5 * 60_000;

function interruptedRetryDelayMs(attempts: number): number {
  return Math.min(
    REPRESENTATION_RETRY_MAX_MS,
    INTERRUPTED_RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 10),
  );
}

/** Cheap recipes an Asset read may wait for. */
function recipesFor(
  kind: AssetKind,
): readonly LocalAssetRepresentationRecipe[] {
  if (kind === "image") return [IMAGE_THUMBNAIL_RECIPE];
  if (kind === "video") return [VIDEO_POSTER_RECIPE];
  if (kind === "audio") return [AUDIO_WAVEFORM_RECIPE];
  return [];
}

/** Long derivations that only ever run in the background. */
function backgroundRecipesFor(
  kind: AssetKind,
): readonly LocalAssetRepresentationRecipe[] {
  return kind === "video" ? [VIDEO_PROXY_RECIPE] : [];
}

/**
 * What a background backstop derives: the visible representation when a card
 * request has not already produced it, plus any long encode. `ensureRecipes`
 * skips recipes that are already ready or still inside their retry backoff.
 */
function backgroundRecipeSetFor(
  kind: AssetKind,
): readonly LocalAssetRepresentationRecipe[] {
  return kind === "video"
    ? [VIDEO_POSTER_RECIPE, VIDEO_PROXY_RECIPE]
    : recipesFor(kind);
}

const BROWSER_VIDEO_CODECS: Record<string, readonly string[]> = {
  "video/mp4": ["h264"],
  "video/webm": ["vp8", "vp9", "av1"],
};
const BROWSER_AUDIO_CODECS: Record<string, readonly string[]> = {
  "video/mp4": ["aac", "mp3"],
  "video/webm": ["opus", "vorbis"],
};

/**
 * A proxy is worth its encode only when the original is a poor playback
 * source: more pixels than 720p, or a container/codec pairing a browser
 * `<video>` cannot be relied on to decode.
 */
export function videoNeedsPlaybackProxy(
  facts: Pick<
    LocalAssetInspectionFacts,
    "width" | "height" | "contentType" | "videoCodec" | "audioCodec"
  >,
): boolean {
  if (
    facts.width !== undefined &&
    facts.height !== undefined &&
    Math.min(facts.width, facts.height) > VIDEO_PROXY_SHORT_SIDE
  ) {
    return true;
  }
  const container = facts.contentType?.toLowerCase() ?? "";
  const videoCodecs = BROWSER_VIDEO_CODECS[container];
  if (!videoCodecs || !videoCodecs.includes(facts.videoCodec ?? "")) {
    return true;
  }
  return (
    facts.audioCodec !== undefined &&
    !BROWSER_AUDIO_CODECS[container]!.includes(facts.audioCodec)
  );
}

/** 720p H.264/AAC MP4 with the index up front, so playback can seek at once. */
export function videoProxyFfmpegArgs(input: {
  sourcePath: string;
  outputPath: string;
}): string[] {
  const side = VIDEO_PROXY_SHORT_SIDE;
  return [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-i",
    input.sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-dn",
    // Bound the short side, never upscale, and keep both dimensions even.
    "-vf",
    `scale='if(gt(iw,ih),-2,min(${side},iw))':'if(gt(iw,ih),min(${side},ih),-2)',scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    // Short GOPs keep scrubbing responsive in the editor.
    "-g",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    input.outputPath,
  ];
}

function recipeKey(recipe: LocalAssetRepresentationRecipe): string {
  return `${recipe.id}/v${recipe.version}:${createHash("sha256")
    .update(JSON.stringify(recipe.parameters))
    .digest("hex")}`;
}

function runIdentity(input: FrozenRepresentationInput): {
  actionRunId: string;
  outputSlot: string;
} {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        sourceResourceId: input.sourceResourceId,
        sourceKind: input.sourceKind,
        recipe: recipeKey(input.recipe),
      }),
    )
    .digest("hex");
  return {
    actionRunId: `representation:${digest}`,
    outputSlot: input.recipe.outputSlot,
  };
}

function parseFrozenInput(value: unknown): FrozenRepresentationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Frozen representation input must be an object.");
  }
  const input = value as Record<string, unknown>;
  const recipe = input.recipe;
  if (
    input.schemaVersion !== 1 ||
    input.targetKind !== "representation" ||
    typeof input.sourceResourceId !== "string" ||
    !input.sourceResourceId ||
    (input.sourceKind !== "image" &&
      input.sourceKind !== "video" &&
      input.sourceKind !== "audio" &&
      input.sourceKind !== "model") ||
    !recipe ||
    typeof recipe !== "object" ||
    Array.isArray(recipe)
  ) {
    throw new Error("Frozen representation input is invalid.");
  }
  const parsedRecipe = recipe as Record<string, unknown>;
  if (
    typeof parsedRecipe.id !== "string" ||
    !parsedRecipe.id ||
    !Number.isSafeInteger(parsedRecipe.version) ||
    (parsedRecipe.version as number) <= 0 ||
    (parsedRecipe.role !== "thumbnail" &&
      parsedRecipe.role !== "waveform" &&
      parsedRecipe.role !== "proxy") ||
    typeof parsedRecipe.outputSlot !== "string" ||
    !parsedRecipe.outputSlot ||
    !parsedRecipe.parameters ||
    typeof parsedRecipe.parameters !== "object" ||
    Array.isArray(parsedRecipe.parameters)
  ) {
    throw new Error("Frozen representation recipe is invalid.");
  }
  return input as unknown as FrozenRepresentationInput;
}

function parseCandidate(value: unknown): LocalAssetRepresentationCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Representation candidate must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind === "resource" &&
    candidate.role === "thumbnail" &&
    typeof candidate.stagedResourceId === "string" &&
    candidate.stagedResourceId &&
    candidate.resourceKind === "image" &&
    candidate.contentType === "image/webp"
  ) {
    return candidate as unknown as LocalAssetRepresentationCandidate;
  }
  if (
    candidate.kind === "resource" &&
    candidate.role === "proxy" &&
    typeof candidate.stagedResourceId === "string" &&
    candidate.stagedResourceId &&
    candidate.resourceKind === "video" &&
    candidate.contentType === "video/mp4"
  ) {
    return candidate as unknown as LocalAssetRepresentationCandidate;
  }
  if (
    candidate.kind === "waveform" &&
    candidate.role === "waveform" &&
    Array.isArray(candidate.peaks) &&
    candidate.peaks.length === AUDIO_WAVEFORM_BARS &&
    candidate.peaks.every(
      (peak) => typeof peak === "number" && peak >= 0 && peak <= 1,
    ) &&
    (candidate.durationMs === undefined ||
      (Number.isSafeInteger(candidate.durationMs) &&
        (candidate.durationMs as number) >= 0))
  ) {
    return candidate as unknown as LocalAssetRepresentationCandidate;
  }
  throw new Error("Representation candidate is invalid.");
}

function parseRepresentation(value: unknown): LocalAssetRepresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local Asset representation row is corrupt.");
  }
  const result = value as Record<string, unknown>;
  if (
    (result.role === "thumbnail" || result.role === "proxy") &&
    typeof result.recipe === "string" &&
    result.recipe &&
    typeof result.resourceId === "string" &&
    result.resourceId
  ) {
    return result as unknown as LocalAssetRepresentation;
  }
  if (
    result.role === "waveform" &&
    typeof result.recipe === "string" &&
    result.recipe &&
    Array.isArray(result.peaks) &&
    result.peaks.length === AUDIO_WAVEFORM_BARS &&
    result.peaks.every(
      (peak) => typeof peak === "number" && peak >= 0 && peak <= 1,
    ) &&
    (result.durationMs === undefined ||
      (Number.isSafeInteger(result.durationMs) &&
        (result.durationMs as number) >= 0))
  ) {
    return result as unknown as LocalAssetRepresentation;
  }
  throw new Error("Local Asset representation row is corrupt.");
}

function parseRepresentationFailure(
  value: unknown,
): LocalAssetRepresentationFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local Asset representation failure row is corrupt.");
  }
  const failure = value as Record<string, unknown>;
  if (
    (failure.role !== "thumbnail" &&
      failure.role !== "waveform" &&
      failure.role !== "proxy") ||
    (failure.code !== "REPRESENTATION_FAILED" &&
      failure.code !== "REPRESENTATION_INTERRUPTED") ||
    typeof failure.message !== "string" ||
    !failure.message.trim() ||
    !Number.isSafeInteger(failure.attempts) ||
    (failure.attempts as number) < 1 ||
    (failure.retryAt !== undefined &&
      (!Number.isSafeInteger(failure.retryAt) ||
        (failure.retryAt as number) < 0))
  ) {
    throw new Error("Local Asset representation failure row is corrupt.");
  }
  return {
    role: failure.role,
    code: failure.code,
    message: failure.message,
    attempts: failure.attempts as number,
    ...(failure.retryAt === undefined
      ? {}
      : { retryAt: failure.retryAt as number }),
  };
}

function changes(result: LocalSqliteRunResult): number {
  return typeof result.changes === "bigint"
    ? Number(result.changes)
    : result.changes;
}

function retryableFailure(
  error: unknown,
  operation: DurableRunOperation,
): DurableProviderFailure {
  if (error instanceof LocalMediaProcessTimeoutError) {
    // A decoder that exceeded its deadline will not recover by repeating the
    // same recipe; keep the coded failure on the run instead of retrying it.
    return {
      code: "deadline_exceeded",
      message: error.message,
      retryable: false,
      requestState: operation === "submit" ? "unknown" : "accepted",
      providerCode: error.code,
    };
  }
  return {
    code:
      operation === "stage"
        ? "output_persistence_failed"
        : operation === "publish"
          ? "publication_failed"
          : "execution_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    requestState: operation === "submit" ? "unknown" : "accepted",
  };
}

async function firstVideoFrame(
  path: string,
  ffmpeg: string,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        "-v",
        "error",
        "-ss",
        "0",
        "-i",
        path,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
      ],
      { signal, killSignal: "SIGKILL" },
    );
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > 32 * 1024 * 1024) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Video poster frame exceeded 32 MiB."));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code === 0 && chunks.length > 0) {
        settled = true;
        resolve(Buffer.concat(chunks));
        return;
      }
      settled = true;
      reject(
        new Error(
          `ffmpeg could not decode ${basename(path)}: ${Buffer.concat(errors).toString("utf8").trim() || `exit ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}

async function waveformPeaks(
  path: string,
  ffmpeg: string,
  bars: number,
  analysisHeight: number,
  signal: AbortSignal,
): Promise<number[]> {
  const image = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        path,
        "-filter_complex",
        `aformat=channel_layouts=mono,showwavespic=s=${bars}x${analysisHeight}:colors=white`,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
      ],
      { signal, killSignal: "SIGKILL" },
    );
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > 8 * 1024 * 1024) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Audio waveform analysis image exceeded 8 MiB."));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code === 0 && chunks.length > 0) {
        settled = true;
        resolve(Buffer.concat(chunks));
        return;
      }
      settled = true;
      reject(
        new Error(
          `ffmpeg could not analyze ${basename(path)}: ${Buffer.concat(errors).toString("utf8").trim() || `exit ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
  const sharp = await loadSharp();
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== bars || info.height !== analysisHeight) {
    throw new Error("Audio waveform analysis returned unexpected dimensions.");
  }
  const peaks = new Array<number>(bars).fill(0);
  let maximum = 0;
  for (let x = 0; x < bars; x += 1) {
    let lit = 0;
    for (let y = 0; y < analysisHeight; y += 1) {
      const offset = (y * info.width + x) * info.channels;
      let brightness = 0;
      for (let channel = 0; channel < info.channels; channel += 1) {
        brightness = Math.max(brightness, data[offset + channel] ?? 0);
      }
      if (brightness > 16) lit += 1;
    }
    const peak = lit / analysisHeight;
    peaks[x] = peak;
    maximum = Math.max(maximum, peak);
  }
  if (maximum <= 0) {
    throw new Error("Audio waveform analysis returned no samples.");
  }
  return peaks.map((peak) => peak / maximum);
}

async function videoProxy(input: {
  resources: LocalResourceStore;
  sourcePath: string;
  workRoot: string;
  ffmpeg: string;
  signal: AbortSignal;
}): Promise<LocalAssetRepresentationCandidate> {
  // Encodes run one at a time, so anything already here is debris from an
  // encode that a Host exit interrupted.
  await rm(input.workRoot, { recursive: true, force: true });
  await mkdir(input.workRoot, { recursive: true });
  // Beside the Resource store rather than the system temp directory: a proxy
  // of long footage is gigabytes and must not land on a memory-backed tmpfs.
  const workDir = await mkdtemp(join(input.workRoot, "proxy-"));
  try {
    const outputPath = join(workDir, "proxy.mp4");
    await runFfmpegToFile({
      ffmpeg: input.ffmpeg,
      args: videoProxyFfmpegArgs({
        sourcePath: input.sourcePath,
        outputPath,
      }),
      task: `transcode a proxy of ${basename(input.sourcePath)}`,
      signal: input.signal,
    });
    const { size } = await stat(outputPath);
    const staged = await input.resources.stageStream({
      source: createReadStream(outputPath),
      declaredByteLength: size,
      maxByteLength: size,
      originalName: "proxy.mp4",
    });
    return {
      kind: "resource",
      role: "proxy",
      stagedResourceId: staged.resourceId,
      resourceKind: "video",
      contentType: "video/mp4",
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function defaultRecipeRunner(
  resources: LocalResourceStore,
  workRoot: string,
  ffmpegPath: () => string | null,
): LocalAssetRepresentationRecipeRunner {
  return async ({ source, recipe, signal }) => {
    const ffmpeg = ffmpegPath();
    const requireFfmpeg = (task: string): string => {
      if (!ffmpeg) throw new Error(`ffmpeg is required to ${task}.`);
      return ffmpeg;
    };
    if (source.resource.kind === "video" && recipe.id === "video-proxy") {
      return videoProxy({
        resources,
        sourcePath: source.path,
        workRoot,
        ffmpeg: requireFfmpeg("derive a video proxy"),
        signal,
      });
    }
    if (source.resource.kind === "audio" && recipe.id === "audio-waveform") {
      return {
        kind: "waveform",
        role: "waveform",
        peaks: await waveformPeaks(
          source.path,
          requireFfmpeg("derive an audio waveform"),
          AUDIO_WAVEFORM_BARS,
          64,
          signal,
        ),
      };
    }
    if (
      (source.resource.kind !== "image" || recipe.id !== "image-thumbnail") &&
      (source.resource.kind !== "video" || recipe.id !== "video-poster")
    ) {
      throw new Error(
        `No Local representation recipe ${recipe.id} exists for ${source.resource.kind}.`,
      );
    }
    const input =
      source.resource.kind === "video"
        ? await firstVideoFrame(
            source.path,
            requireFfmpeg("derive a video poster"),
            signal,
          )
        : source.path;
    const sharp = await loadSharp();
    const bytes = await sharp(input, {
      failOn: "error",
      limitInputPixels: 100_000_000,
    })
      .rotate()
      .resize({
        width: 512,
        height: 512,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();
    const staged = await resources.stage({
      bytes: new Uint8Array(bytes),
      originalName: "thumbnail.webp",
    });
    return {
      kind: "resource",
      role: "thumbnail",
      stagedResourceId: staged.resourceId,
      resourceKind: "image",
      contentType: "image/webp",
    };
  };
}

export function createLocalAssetRepresentationService(options: {
  dataDir: string;
  clashRoot?: string;
  assetInspection: LocalAssetInspectionService;
  ownerId?: string;
  recipeRunner?: LocalAssetRepresentationRecipeRunner;
  /** Resolves the ffmpeg that transcodes proxies; none means no proxies. */
  ffmpegPath?: () => string | null;
  /** Deadlines for one recipe; tests inject short ones. */
  mediaProcessTimeoutsMs?: Partial<{
    poster: number;
    waveform: number;
    proxy: number;
  }>;
  now?: () => number;
  /** Hard bound on concurrent derivations; defaults to a core-derived 2–4. */
  maxConcurrent?: number;
  /** Structured events for Host-private maintenance failures. */
  onResourceEvent?: (event: LocalResourceStoreEvent) => void;
}): LocalAssetRepresentationService {
  const ownerId = options.ownerId ?? DEFAULT_OWNER_ID;
  const now = options.now ?? Date.now;
  const configuredTimeouts = options.mediaProcessTimeoutsMs ?? {};
  const journal: SqliteDurableRunJournal = createSqliteDurableRunJournal(
    options.dataDir,
  );
  const resources = createLocalResourceStore({
    dataDir: options.dataDir,
    ...(options.clashRoot ? { clashRoot: options.clashRoot } : {}),
  });
  const ffmpegPath = options.ffmpegPath ?? localFfmpegPath;
  const workRoot = join(options.dataDir, "representation-work");
  const recipeTimeoutMs = (recipe: LocalAssetRepresentationRecipe): number =>
    recipe.role === "proxy"
      ? (configuredTimeouts.proxy ?? MEDIA_PROCESS_TIMEOUTS_MS.proxyMaximum)
      : recipe.role === "waveform"
        ? (configuredTimeouts.waveform ?? MEDIA_PROCESS_TIMEOUTS_MS.waveform)
        : (configuredTimeouts.poster ?? MEDIA_PROCESS_TIMEOUTS_MS.poster);
  const runRecipe =
    options.recipeRunner ??
    defaultRecipeRunner(resources, workRoot, ffmpegPath);
  const inFlight = new Map<string, Promise<LocalAssetRepresentation[]>>();
  const maxConcurrent =
    options.maxConcurrent ??
    Math.max(2, Math.min(4, availableParallelism() - 1));
  const workQueue = createBoundedWorkQueue({ concurrency: maxConcurrent });
  // A drive in progress, so a Host stop can be recorded as an interruption.
  const activeRuns = new Map<
    string,
    {
      sourceResourceId: string;
      sourceKind: AssetKind;
      recipe: LocalAssetRepresentationRecipe;
    }
  >();
  // Proxies transcode behind every read-blocking recipe, never beside them.
  const backgroundPending = new Set<string>();
  const backgroundSettled = new Set<string>();
  const backgroundRuns = new Set<Promise<void>>();
  const closing = new AbortController();
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const connection = createLocalSqliteConnection({ dataDir: options.dataDir });

  async function readRecipe(
    sourceResourceId: string,
    recipe: LocalAssetRepresentationRecipe,
  ): Promise<LocalAssetRepresentation | undefined> {
    const row = await connection.db
      .prepare(
        `
        SELECT result_json
        FROM local_asset_representations
        WHERE source_resource_id = ? AND recipe = ? AND role <> 'failure'
      `,
      )
      .get(sourceResourceId, recipeKey(recipe));
    if (!row) return undefined;
    if (typeof row.result_json !== "string") {
      throw new Error("Local Asset representation row is corrupt.");
    }
    return parseRepresentation(JSON.parse(row.result_json));
  }

  /**
   * Failure state is Host-private, like the derivation itself, and is stored
   * in the existing representation table (role `failure`) so no schema change
   * is required. It carries a retry time so a read never restarts a failing
   * ffmpeg/sharp attempt on every list.
   */
  async function readFailure(
    sourceResourceId: string,
    recipe: LocalAssetRepresentationRecipe,
  ): Promise<LocalAssetRepresentationFailure | undefined> {
    const row = await connection.db
      .prepare(
        `
        SELECT result_json
        FROM local_asset_representations
        WHERE source_resource_id = ? AND recipe = ? AND role = 'failure'
      `,
      )
      .get(sourceResourceId, recipeKey(recipe));
    if (!row) return undefined;
    if (typeof row.result_json !== "string") {
      throw new Error("Local Asset representation failure row is corrupt.");
    }
    return parseRepresentationFailure(JSON.parse(row.result_json));
  }

  async function recordFailure(input: {
    sourceResourceId: string;
    recipe: LocalAssetRepresentationRecipe;
    failure: LocalAssetRepresentationFailure;
  }): Promise<void> {
    const failure = parseRepresentationFailure(input.failure);
    await connection.db
      .prepare(
        `
        INSERT INTO local_asset_representations (
          source_resource_id, recipe, role, result_json, created_at
        ) VALUES (?, ?, 'failure', ?, ?)
        ON CONFLICT(source_resource_id, recipe) DO UPDATE SET
          result_json = excluded.result_json,
          created_at = excluded.created_at
        WHERE local_asset_representations.role = 'failure'
      `,
      )
      .run(
        input.sourceResourceId,
        recipeKey(input.recipe),
        JSON.stringify(failure),
        now(),
      );
  }

  async function clearFailure(
    sourceResourceId: string,
    recipe: LocalAssetRepresentationRecipe,
  ): Promise<void> {
    await connection.db
      .prepare(
        `
        DELETE FROM local_asset_representations
        WHERE source_resource_id = ? AND recipe = ? AND role = 'failure'
      `,
      )
      .run(sourceResourceId, recipeKey(recipe));
  }

  /**
   * A sealed representation Resource makes its staging name redundant. Release
   * is cleanup, not part of the derivation result: a failure is logged with the
   * import cleanup code and the periodic staging sweep retries it.
   */
  async function releaseStagedQuietly(resourceId: string): Promise<void> {
    try {
      await resources.releaseStaged(resourceId);
    } catch (error) {
      options.onResourceEvent?.({
        level: "error",
        event: "local_resource_staging.release_failed",
        fields: {
          resourceId,
          code: PROJECT_ASSET_IMPORT_STAGING_CLEANUP_FAILED,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async function publishRepresentation(input: {
    sourceResourceId: string;
    recipe: LocalAssetRepresentationRecipe;
    result: LocalAssetRepresentation;
  }): Promise<void> {
    const recipe = recipeKey(input.recipe);
    const result = parseRepresentation(input.result);
    const resultJson = JSON.stringify(result);
    await connection.use(async (database) => {
      // A successful retry replaces the coded failure row for the same recipe;
      // the delete and the insert commit together.
      await database.exec("BEGIN IMMEDIATE");
      let inserted: LocalSqliteRunResult;
      let winner: Record<string, unknown> | undefined;
      try {
        await database
          .prepare(
            `
            DELETE FROM local_asset_representations
            WHERE source_resource_id = ? AND recipe = ? AND role = 'failure'
          `,
          )
          .run(input.sourceResourceId, recipe);
        inserted = await database
          .prepare(
            `
            INSERT OR IGNORE INTO local_asset_representations (
              source_resource_id, recipe, role, result_json, created_at
            ) VALUES (?, ?, ?, ?, ?)
          `,
          )
          .run(input.sourceResourceId, recipe, result.role, resultJson, now());
        winner = await database
          .prepare(
            `
            SELECT role, result_json
            FROM local_asset_representations
            WHERE source_resource_id = ? AND recipe = ?
          `,
          )
          .get(input.sourceResourceId, recipe);
        await database.exec("COMMIT");
      } catch (error) {
        await database.exec("ROLLBACK");
        throw error;
      }
      if (
        !winner ||
        winner.role !== result.role ||
        winner.result_json !== resultJson
      ) {
        throw new Error(
          `Representation ${input.sourceResourceId}/${recipe} conflicts with its CAS winner.`,
        );
      }
      void changes(inserted);
    });
  }

  const createEngine = (
    attemptTimeoutMs?: Partial<Record<DurableRunOperation, number>>,
  ) =>
    new DurableRunEngine({
      journal,
      provider: {
        async submit({ run }) {
          const input = parseFrozenInput(run.executorInput);
          const source = await resources.resolve(input.sourceResourceId);
          if (!source) {
            throw new Error(
              `Source Resource ${input.sourceResourceId} is not installed.`,
            );
          }
          if (source.resource.kind !== input.sourceKind) {
            throw new Error(
              `Source Resource ${input.sourceResourceId} changed kind.`,
            );
          }
          const candidate = await withMediaProcessDeadline(
            {
              code: "REPRESENTATION_TIMEOUT",
              timeoutMs: recipeTimeoutMs(input.recipe),
              task: `derive ${input.recipe.id} from ${basename(source.path)}`,
              signal: closing.signal,
            },
            (signal) =>
              runRecipe({
                source,
                recipe: input.recipe,
                signal,
              }),
          );
          return {
            status: "completed" as const,
            outputs: [
              {
                slot: input.recipe.outputSlot,
                kind: "value" as const,
                value: candidate as unknown as ExecutablePluginJsonValue,
              },
            ],
          };
        },
        async poll() {
          return {
            status: "failed" as const,
            error: {
              code: "contract_violation" as const,
              message: "Local representation recipes never enter polling.",
              retryable: false,
              requestState: "accepted" as const,
            },
          };
        },
      },
      outputStore: {
        async stage({ run, outputs }) {
          const input = parseFrozenInput(run.executorInput);
          const output = outputs.find(
            (
              candidate,
            ): candidate is Extract<
              ExecutablePluginOutput,
              { kind: "value" }
            > =>
              candidate.slot === input.recipe.outputSlot &&
              candidate.kind === "value",
          );
          if (!output) {
            throw new Error("Representation run completed without its output.");
          }
          const candidate = parseCandidate(output.value);
          if (candidate.role !== input.recipe.role) {
            throw new Error(
              "Representation output role does not match its recipe.",
            );
          }
          if (candidate.kind === "waveform") {
            return candidate as unknown as ExecutablePluginJsonValue;
          }
          const finalized = await options.assetInspection.finalize({
            resourceId: candidate.stagedResourceId,
            kind: candidate.resourceKind,
            contentType: candidate.contentType,
          });
          await releaseStagedQuietly(finalized.source.resource.id);
          return {
            kind: "resource",
            role: candidate.role,
            resourceId: finalized.source.resource.id,
          } as unknown as ExecutablePluginJsonValue;
        },
      },
      publisher: {
        async publish({ run, stagedOutput }) {
          const input = parseFrozenInput(run.executorInput);
          const recipe = recipeKey(input.recipe);
          const value = stagedOutput as Record<string, unknown>;
          const result =
            value.kind === "resource" &&
            (value.role === "thumbnail" || value.role === "proxy") &&
            typeof value.resourceId === "string"
              ? ({
                  role: value.role,
                  recipe,
                  resourceId: value.resourceId,
                } as const)
              : value.kind === "waveform" &&
                  value.role === "waveform" &&
                  Array.isArray(value.peaks)
                ? ({
                    role: "waveform",
                    recipe,
                    peaks: value.peaks,
                    ...(typeof value.durationMs === "number"
                      ? { durationMs: value.durationMs }
                      : {}),
                  } as LocalAssetRepresentation)
                : undefined;
          if (!result) {
            throw new Error("Staged representation output is invalid.");
          }
          await publishRepresentation({
            sourceResourceId: input.sourceResourceId,
            recipe: input.recipe,
            result,
          });
        },
        async publishFailure() {
          // Representation failure is Host-private. The journal is the diagnostic
          // projection; Project/Global Asset state must remain unchanged.
        },
      },
      ownerGuard: {
        async assertOwner(run) {
          if (run.owner.realm !== "local" || run.owner.id !== ownerId) {
            throw new Error(
              "Representation run belongs to another Host owner.",
            );
          }
        },
      },
      retryPolicy: {
        delayMs({ consecutiveFailures, failure }) {
          if (!failure.retryable) return null;
          return Math.min(
            5 * 60_000,
            1_000 * 2 ** Math.min(8, consecutiveFailures - 1),
          );
        },
      },
      clock: { now },
      classifyThrownError: retryableFailure,
      ...(attemptTimeoutMs ? { attemptTimeoutMs } : {}),
    });
  const engine = createEngine();
  const proxyEngine = createEngine({ submit: PROXY_SUBMIT_TIMEOUT_MS });

  async function scheduleNextWake(): Promise<void> {
    if (closed) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = undefined;
    const wakeAt = await journal.nextWakeAt(ownerId);
    if (wakeAt === undefined) return;
    wakeTimer = setTimeout(
      () => {
        wakeTimer = undefined;
        void recover().catch((error) => {
          console.error("[local-api] representation recovery failed", error);
        });
      },
      Math.max(0, wakeAt - now()),
    );
    wakeTimer.unref?.();
  }

  async function drive(
    run: Pick<DurableRunRecord, "actionRunId" | "outputSlot">,
    role: LocalAssetRepresentationRole,
  ): Promise<void> {
    const runEngine = role === "proxy" ? proxyEngine : engine;
    for (let step = 0; step < 12; step += 1) {
      const result = await runEngine.advance(run);
      if (
        result.kind === "waiting" ||
        result.kind === "terminal" ||
        result.kind === "contended"
      ) {
        return;
      }
    }
  }

  async function recover(): Promise<void> {
    if (closed) return;
    const recoverable = await journal.listRecoverable(ownerId, now());
    for (const run of recoverable) {
      const input = parseFrozenInput(run.executorInput);
      const activeKey = `${input.sourceResourceId}\0${recipeKey(input.recipe)}`;
      activeRuns.set(activeKey, {
        sourceResourceId: input.sourceResourceId,
        sourceKind: input.sourceKind,
        recipe: input.recipe,
      });
      try {
        await drive(run, input.recipe.role);
      } catch (error) {
        await recordFailure({
          sourceResourceId: input.sourceResourceId,
          recipe: input.recipe,
          failure: failedRepresentation(input.recipe, error, now()),
        });
      } finally {
        activeRuns.delete(activeKey);
      }
      await recordRunFailure(
        input.sourceResourceId,
        input.recipe,
        await journal.load(run),
      );
    }
    await scheduleNextWake();
  }

  /** Whether a not-yet-started recipe should run for this source at all. */
  async function recipeApplies(
    source: LocalResourceProjection,
    recipe: LocalAssetRepresentationRecipe,
  ): Promise<boolean> {
    if (recipe.role !== "proxy") return true;
    if (backgroundSettled.has(source.resource.id)) return false;
    let facts: LocalAssetInspectionFacts;
    try {
      ({ facts } = await options.assetInspection.inspect({ source }));
    } catch {
      // Without verified facts there is no basis for an encode.
      return false;
    }
    if (!videoNeedsPlaybackProxy(facts)) {
      // Resources are immutable, so this answer holds for the process.
      backgroundSettled.add(source.resource.id);
      return false;
    }
    return ffmpegPath() !== null;
  }

  function failedRepresentation(
    recipe: LocalAssetRepresentationRecipe,
    error: unknown,
    retryAt: number,
  ): LocalAssetRepresentationFailure {
    return {
      role: recipe.role,
      code: "REPRESENTATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
      attempts: 1,
      retryAt,
    };
  }

  async function recordRunFailure(
    sourceResourceId: string,
    recipe: LocalAssetRepresentationRecipe,
    run: DurableRunRecord | undefined,
  ): Promise<void> {
    if (!run) return;
    const failure = run.failure ?? run.projectionFailure;
    if (!failure || run.projectedAt !== undefined) return;
    const attempts = Math.max(
      1,
      run.failureCounts.submit,
      run.failureCounts.poll,
      run.failureCounts.stage,
      run.failureCounts.publish,
      run.projectionFailureCount ?? 0,
    );
    await recordFailure({
      sourceResourceId,
      recipe,
      failure: {
        role: recipe.role,
        code: "REPRESENTATION_FAILED",
        message: failure.message,
        attempts,
        ...(run.phase === "failed" && run.nextAttemptAt === undefined
          ? {}
          : {
              retryAt:
                run.nextAttemptAt ?? now() + interruptedRetryDelayMs(attempts),
            }),
      },
    });
  }

  const recipeRuns = new Map<
    string,
    Promise<LocalAssetRepresentation | undefined>
  >();

  async function deriveRecipe(
    source: LocalResourceProjection,
    sourceResourceId: string,
    recipe: LocalAssetRepresentationRecipe,
  ): Promise<LocalAssetRepresentation | undefined> {
    const failed = await readFailure(sourceResourceId, recipe);
    if (failed) {
      if (failed.retryAt !== undefined && failed.retryAt > now())
        return undefined;
      await clearFailure(sourceResourceId, recipe);
    }
    const ready = await readRecipe(sourceResourceId, recipe);
    if (ready) return ready;
    const executorInput: FrozenRepresentationInput = {
      schemaVersion: 1,
      targetKind: "representation",
      sourceResourceId,
      sourceKind: source.resource.kind,
      recipe,
    };
    const identity = runIdentity(executorInput);
    const existing = await journal.load(identity);
    if (!existing) {
      if (!(await recipeApplies(source, recipe))) return undefined;
      const createdAt = now();
      await journal.create(
        createDurableRunRecord({
          ...identity,
          owner: { realm: "local", id: ownerId },
          executorInput: executorInput as unknown as ExecutablePluginJsonValue,
          createdAt,
          deadlineAt: createdAt + RUN_LIFETIME_MS,
        }),
      );
    }
    const activeKey = `${sourceResourceId}\0${recipeKey(recipe)}`;
    activeRuns.set(activeKey, {
      sourceResourceId,
      sourceKind: source.resource.kind,
      recipe,
    });
    try {
      await drive(identity, recipe.role);
    } catch (error) {
      await recordFailure({
        sourceResourceId,
        recipe,
        failure: failedRepresentation(
          recipe,
          error,
          now() + interruptedRetryDelayMs(1),
        ),
      });
      throw error;
    } finally {
      activeRuns.delete(activeKey);
    }
    const derived = await readRecipe(sourceResourceId, recipe);
    if (derived) return derived;
    await recordRunFailure(
      sourceResourceId,
      recipe,
      await journal.load(identity),
    );
    return undefined;
  }

  /**
   * A visible card request (foreground) and the resolve backstop (background)
   * can name the same recipe at the same time. Share one derivation promise so
   * the request waits for the in-flight poster instead of contending on the
   * durable run and answering 404.
   */
  function deriveRecipeOnce(
    source: LocalResourceProjection,
    sourceResourceId: string,
    recipe: LocalAssetRepresentationRecipe,
  ): Promise<LocalAssetRepresentation | undefined> {
    const key = `${sourceResourceId}\0${recipeKey(recipe)}`;
    const active = recipeRuns.get(key);
    if (active) return active;
    const task = deriveRecipe(source, sourceResourceId, recipe).finally(() => {
      if (recipeRuns.get(key) === task) recipeRuns.delete(key);
    });
    recipeRuns.set(key, task);
    return task;
  }

  async function ensureRecipes(
    sourceResourceId: string,
    recipesOf: (kind: AssetKind) => readonly LocalAssetRepresentationRecipe[],
  ): Promise<LocalAssetRepresentation[]> {
    const source = await resources.resolve(sourceResourceId);
    if (!source) return [];
    const results: LocalAssetRepresentation[] = [];
    for (const recipe of recipesOf(source.resource.kind)) {
      const derived = await deriveRecipeOnce(source, sourceResourceId, recipe);
      if (derived) results.push(derived);
    }
    await scheduleNextWake();
    return results;
  }

  function queueBackgroundPass(sourceResourceId: string): void {
    if (
      backgroundPending.has(sourceResourceId) ||
      backgroundSettled.has(sourceResourceId)
    ) {
      return;
    }
    backgroundPending.add(sourceResourceId);
    const run = workQueue.enqueue("background", async () => {
      if (closed) return;
      await ensureRecipes(sourceResourceId, backgroundRecipeSetFor);
      const source = await resources.resolve(sourceResourceId);
      if (!source) return;
      // Once every recipe is ready or has a coded failure (in backoff or
      // exhausted), later reads of this immutable source need not queue
      // another background check: the durable journal owns the retry.
      for (const recipe of backgroundRecipeSetFor(source.resource.kind)) {
        if (await readRecipe(sourceResourceId, recipe)) continue;
        if (await readFailure(sourceResourceId, recipe)) continue;
        return;
      }
      backgroundSettled.add(sourceResourceId);
    });
    backgroundRuns.add(run);
    void run
      .catch((error: unknown) => {
        if (error instanceof WorkQueueClosedError) return;
        console.warn(
          `[local-api] failed to derive representations for ${sourceResourceId}`,
          error,
        );
      })
      .finally(() => {
        backgroundPending.delete(sourceResourceId);
        backgroundRuns.delete(run);
      });
  }

  /**
   * A graceful Host stop aborts the in-flight encode. Record it as a coded
   * interruption with a bounded exponential retry instead of letting the next
   * Host silently re-run the full transcode immediately.
   */
  async function markInterrupted(
    interrupted: Array<{
      sourceResourceId: string;
      sourceKind: AssetKind;
      recipe: LocalAssetRepresentationRecipe;
    }>,
  ): Promise<void> {
    for (const input of interrupted) {
      if (await readRecipe(input.sourceResourceId, input.recipe)) continue;
      const executorInput: FrozenRepresentationInput = {
        schemaVersion: 1,
        targetKind: "representation",
        sourceResourceId: input.sourceResourceId,
        sourceKind: input.sourceKind,
        recipe: input.recipe,
      };
      const identity = runIdentity(executorInput);
      const run = await journal.load(identity);
      if (
        !run ||
        run.phase === "succeeded" ||
        run.projectedAt !== undefined ||
        (run.phase === "failed" &&
          run.failure !== undefined &&
          !run.failure.retryable)
      ) {
        continue;
      }
      const attempts = Math.max(1, run.failureCounts.submit + 1);
      const retryAt = now() + interruptedRetryDelayMs(attempts);
      const next: DurableRunRecord = {
        ...run,
        revision: run.revision + 1,
        updatedAt: now(),
        nextAttemptAt: retryAt,
        failure: {
          code: "cancelled",
          message:
            "The Host stopped while deriving this representation. The retry is scheduled with backoff.",
          retryable: true,
          requestState: run.activeAttempt ? "unknown" : "accepted",
        },
        failureCounts: { ...run.failureCounts, submit: attempts },
      };
      const recorded = await journal
        .compareAndSet(identity, run.revision, next)
        .catch(() => false);
      if (!recorded) continue;
      await recordFailure({
        sourceResourceId: input.sourceResourceId,
        recipe: input.recipe,
        failure: {
          role: input.recipe.role,
          code: "REPRESENTATION_INTERRUPTED",
          message:
            "The Host stopped while deriving this representation. It will retry automatically.",
          attempts,
          retryAt,
        },
      });
    }
  }

  const service: LocalAssetRepresentationService = {
    schedule(sourceResourceId) {
      const normalized = sourceResourceId.trim();
      if (closed || !normalized) return;
      void service
        .ensure(normalized)
        .catch((error) => {
          console.warn(
            `[local-api] failed to derive representations for ${normalized}`,
            error,
          );
        })
        .finally(() => queueBackgroundPass(normalized));
    },
    scheduleBackground(sourceResourceId) {
      const normalized = sourceResourceId.trim();
      if (closed || !normalized) return;
      queueBackgroundPass(normalized);
    },
    ensure(sourceResourceId) {
      const normalized = sourceResourceId.trim();
      if (closed || !normalized) return Promise.resolve([]);
      const active = inFlight.get(normalized);
      if (active) return active;
      const task = workQueue
        .enqueue("foreground", () => ensureRecipes(normalized, recipesFor))
        .finally(() => {
          if (inFlight.get(normalized) === task) inFlight.delete(normalized);
        });
      inFlight.set(normalized, task);
      return task;
    },
    async failure(sourceResourceId, role) {
      const normalized = sourceResourceId.trim();
      if (!normalized) return undefined;
      const source = await resources.resolve(normalized);
      if (!source) return undefined;
      const recipe = [
        ...recipesFor(source.resource.kind),
        ...backgroundRecipesFor(source.resource.kind),
      ].find((candidate) => candidate.role === role);
      return recipe ? readFailure(normalized, recipe) : undefined;
    },
    async read(sourceResourceId, role) {
      const source = await resources.resolve(sourceResourceId);
      const recipe = source
        ? [
            ...recipesFor(source.resource.kind),
            ...backgroundRecipesFor(source.resource.kind),
          ].find((candidate) => candidate.role === role)
        : undefined;
      return recipe ? readRecipe(sourceResourceId, recipe) : undefined;
    },
    async readForKind(sourceResourceId, sourceKind, role) {
      const recipe = [
        ...recipesFor(sourceKind),
        ...backgroundRecipesFor(sourceKind),
      ].find((candidate) => candidate.role === role);
      return recipe ? readRecipe(sourceResourceId, recipe) : undefined;
    },
    async openThumbnail(sourceResourceId) {
      const representation = await service.read(sourceResourceId, "thumbnail");
      if (!representation || representation.role !== "thumbnail") {
        return undefined;
      }
      return resources.resolve(representation.resourceId);
    },
    async openProxy(sourceResourceId) {
      const representation = await service.read(sourceResourceId, "proxy");
      if (!representation || representation.role !== "proxy") {
        return undefined;
      }
      return resources.resolve(representation.resourceId);
    },
    start: recover,
    async close() {
      // Capture in-flight derivations before aborting: the abort settles their
      // durable runs, so the interruption must be recorded for the ones that
      // had actually started.
      const interrupted = [...activeRuns.values()];
      closed = true;
      workQueue.close();
      closing.abort();
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = undefined;
      await Promise.allSettled([...inFlight.values(), ...backgroundRuns]);
      await markInterrupted(interrupted);
    },
  };

  return service;
}
