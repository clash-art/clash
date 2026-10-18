import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

import {
  DurableRunEngine,
  createDurableRunRecord,
  type DurableProviderFailure,
  type DurableRunOperation,
  type DurableRunRecord,
} from "@clash/shared-runtime";
import type {
  AssetKind,
  ExecutablePluginJsonValue,
  ExecutablePluginOutput,
} from "@clash/shared-types";
import sharp from "sharp";

import type {
  LocalAssetInspectionFacts,
  LocalAssetInspectionService,
} from "./local-asset-inspections.js";
import { runFfmpegToFile } from "./local-ffmpeg-run.js";
import { localFfmpegPath } from "./local-media-binaries.js";
import {
  createSqliteDurableRunJournal,
  type SqliteDurableRunJournal,
} from "./durable-run-journal.js";
import {
  createLocalResourceStore,
  type LocalResourceProjection,
  type LocalResourceStore,
} from "./local-resource-store.js";
import { createLocalSqliteConnection } from "./local-sqlite-connection.js";

export type LocalAssetRepresentationRole = "thumbnail" | "waveform" | "proxy";
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
  /** Drives current recipes until they are ready or waiting for a durable retry. */
  ensure(sourceResourceId: string): Promise<LocalAssetRepresentation[]>;
  read(
    sourceResourceId: string,
    role: LocalAssetRepresentationRole,
  ): Promise<LocalAssetRepresentation | undefined>;
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

interface SqliteRunResult {
  changes: number | bigint;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
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
const nodeRequire = createRequire(import.meta.url);

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

function openDatabase(path: string): SqliteDatabase {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
  `);
  const existing = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_asset_representations'",
    )
    .get();
  if (
    existing &&
    typeof existing.sql === "string" &&
    !/\bresult_json\b/i.test(existing.sql)
  ) {
    const rows = database
      .prepare(
        "SELECT source_resource_id, recipe, representation_resource_id, created_at FROM local_asset_representations",
      )
      .all();
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE local_asset_representations RENAME TO local_asset_representations_legacy;
      CREATE TABLE local_asset_representations (
        source_resource_id TEXT NOT NULL,
        recipe TEXT NOT NULL,
        role TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_resource_id, recipe)
      );
      COMMIT;
    `);
    const insert = database.prepare(`
      INSERT INTO local_asset_representations (
        source_resource_id, recipe, role, result_json, created_at
      ) VALUES (?, ?, 'thumbnail', ?, ?)
    `);
    for (const row of rows) {
      if (
        typeof row.source_resource_id === "string" &&
        typeof row.recipe === "string" &&
        typeof row.representation_resource_id === "string" &&
        typeof row.created_at === "number"
      ) {
        insert.run(
          row.source_resource_id,
          row.recipe,
          JSON.stringify({
            role: "thumbnail",
            recipe: row.recipe,
            resourceId: row.representation_resource_id,
          }),
          row.created_at,
        );
      }
    }
    database.exec("DROP TABLE local_asset_representations_legacy");
  } else {
    database.exec(`
      CREATE TABLE IF NOT EXISTS local_asset_representations (
        source_resource_id TEXT NOT NULL,
        recipe TEXT NOT NULL,
        role TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_resource_id, recipe)
      );
    `);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS local_asset_representations_role
      ON local_asset_representations (source_resource_id, role, created_at);
  `);
  return database;
}

function changes(result: SqliteRunResult): number {
  return typeof result.changes === "bigint"
    ? Number(result.changes)
    : result.changes;
}

function retryableFailure(
  error: unknown,
  operation: DurableRunOperation,
): DurableProviderFailure {
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

async function firstVideoFrame(path: string): Promise<Buffer> {
  const ffmpeg = localFfmpegPath();
  if (!ffmpeg) {
    throw new Error("ffmpeg is required to derive a video poster.");
  }
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpeg, [
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
    ]);
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
      if (!settled) reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
        return;
      }
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
  bars: number,
  analysisHeight: number,
): Promise<number[]> {
  const ffmpeg = localFfmpegPath();
  if (!ffmpeg) {
    throw new Error("ffmpeg is required to derive an audio waveform.");
  }
  const image = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpeg, [
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
    ]);
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
      if (!settled) reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
        return;
      }
      reject(
        new Error(
          `ffmpeg could not analyze ${basename(path)}: ${Buffer.concat(errors).toString("utf8").trim() || `exit ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
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
  ffmpegPath: () => string | null;
  signal: AbortSignal;
}): Promise<LocalAssetRepresentationCandidate> {
  const ffmpeg = input.ffmpegPath();
  if (!ffmpeg) {
    throw new Error("ffmpeg is required to derive a video proxy.");
  }
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
      ffmpeg,
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
    if (source.resource.kind === "video" && recipe.id === "video-proxy") {
      return videoProxy({
        resources,
        sourcePath: source.path,
        workRoot,
        ffmpegPath,
        signal,
      });
    }
    if (source.resource.kind === "audio" && recipe.id === "audio-waveform") {
      return {
        kind: "waveform",
        role: "waveform",
        peaks: await waveformPeaks(source.path, AUDIO_WAVEFORM_BARS, 64),
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
        ? await firstVideoFrame(source.path)
        : source.path;
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
  now?: () => number;
}): LocalAssetRepresentationService {
  const databasePath = `${options.dataDir}/local.sqlite`;
  const ownerId = options.ownerId ?? DEFAULT_OWNER_ID;
  const now = options.now ?? Date.now;
  const journal: SqliteDurableRunJournal = createSqliteDurableRunJournal(
    options.dataDir,
  );
  const resources = createLocalResourceStore({
    dataDir: options.dataDir,
    ...(options.clashRoot ? { clashRoot: options.clashRoot } : {}),
  });
  const ffmpegPath = options.ffmpegPath ?? localFfmpegPath;
  const workRoot = join(options.dataDir, "representation-work");
  const runRecipe =
    options.recipeRunner ??
    defaultRecipeRunner(resources, workRoot, ffmpegPath);
  const inFlight = new Map<string, Promise<LocalAssetRepresentation[]>>();
  // Proxies transcode one at a time, behind every read-blocking recipe.
  const backgroundPending = new Set<string>();
  const backgroundSettled = new Set<string>();
  let backgroundQueue: Promise<void> = Promise.resolve();
  const closing = new AbortController();
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const connection = createLocalSqliteConnection({
    dataDir: options.dataDir,
    path: databasePath,
    open: openDatabase,
  });

  async function withDatabase<T>(
    task: (database: SqliteDatabase) => T,
  ): Promise<T> {
    return connection.use(task);
  }

  async function readRecipe(
    sourceResourceId: string,
    recipe: LocalAssetRepresentationRecipe,
  ): Promise<LocalAssetRepresentation | undefined> {
    return withDatabase((database) => {
      const row = database
        .prepare(
          `
          SELECT result_json
          FROM local_asset_representations
          WHERE source_resource_id = ? AND recipe = ?
        `,
        )
        .get(sourceResourceId, recipeKey(recipe));
      if (!row) return undefined;
      if (typeof row.result_json !== "string") {
        throw new Error("Local Asset representation row is corrupt.");
      }
      return parseRepresentation(JSON.parse(row.result_json));
    });
  }

  async function publishRepresentation(input: {
    sourceResourceId: string;
    recipe: LocalAssetRepresentationRecipe;
    result: LocalAssetRepresentation;
  }): Promise<void> {
    const recipe = recipeKey(input.recipe);
    const result = parseRepresentation(input.result);
    const resultJson = JSON.stringify(result);
    await withDatabase((database) => {
      const inserted = database
        .prepare(
          `
          INSERT OR IGNORE INTO local_asset_representations (
            source_resource_id, recipe, role, result_json, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
        )
        .run(input.sourceResourceId, recipe, result.role, resultJson, now());
      const winner = database
        .prepare(
          `
          SELECT role, result_json
          FROM local_asset_representations
          WHERE source_resource_id = ? AND recipe = ?
        `,
        )
        .get(input.sourceResourceId, recipe);
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
          const candidate = await runRecipe({
            source,
            recipe: input.recipe,
            signal: closing.signal,
          });
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
      await drive(run, parseFrozenInput(run.executorInput).recipe.role);
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

  async function ensureRecipes(
    sourceResourceId: string,
    recipesOf: (kind: AssetKind) => readonly LocalAssetRepresentationRecipe[],
  ): Promise<LocalAssetRepresentation[]> {
    const source = await resources.resolve(sourceResourceId);
    if (!source) return [];
    const results: LocalAssetRepresentation[] = [];
    for (const recipe of recipesOf(source.resource.kind)) {
      const ready = await readRecipe(sourceResourceId, recipe);
      if (ready) {
        results.push(ready);
        continue;
      }
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
        if (!(await recipeApplies(source, recipe))) continue;
        const createdAt = now();
        await journal.create(
          createDurableRunRecord({
            ...identity,
            owner: { realm: "local", id: ownerId },
            executorInput:
              executorInput as unknown as ExecutablePluginJsonValue,
            createdAt,
            deadlineAt: createdAt + RUN_LIFETIME_MS,
          }),
        );
      }
      await drive(identity, recipe.role);
      const derived = await readRecipe(sourceResourceId, recipe);
      if (derived) results.push(derived);
    }
    await scheduleNextWake();
    return results;
  }

  function scheduleBackground(sourceResourceId: string): void {
    if (
      backgroundPending.has(sourceResourceId) ||
      backgroundSettled.has(sourceResourceId)
    ) {
      return;
    }
    backgroundPending.add(sourceResourceId);
    backgroundQueue = backgroundQueue
      .then(async () => {
        if (closed) return;
        const derived = await ensureRecipes(
          sourceResourceId,
          backgroundRecipesFor,
        );
        const source = await resources.resolve(sourceResourceId);
        // Nothing to derive, or all of it derived: later reads of this
        // immutable source need not queue another check.
        if (
          source &&
          derived.length === backgroundRecipesFor(source.resource.kind).length
        ) {
          backgroundSettled.add(sourceResourceId);
        }
      })
      .catch((error) => {
        console.warn(
          `[local-api] failed to derive a proxy for ${sourceResourceId}`,
          error,
        );
      })
      .finally(() => {
        backgroundPending.delete(sourceResourceId);
      });
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
        .finally(() => scheduleBackground(normalized));
    },
    ensure(sourceResourceId) {
      const normalized = sourceResourceId.trim();
      if (closed || !normalized) return Promise.resolve([]);
      const active = inFlight.get(normalized);
      if (active) return active;
      const task = ensureRecipes(normalized, recipesFor).finally(() => {
        if (inFlight.get(normalized) === task) inFlight.delete(normalized);
      });
      inFlight.set(normalized, task);
      return task;
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
      closed = true;
      closing.abort();
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = undefined;
      await Promise.allSettled([...inFlight.values(), backgroundQueue]);
    },
  };

  return service;
}
