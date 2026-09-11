import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  AsrTimedTranscriptSchema,
  buildTimelineTranscriptProjection,
  projectAsrTimedTranscriptWords,
} from "@clash/shared-types";

import { readAssetMetadataBody } from "./legacy-metadata-body";
import { transcriptGridHash } from "./transcript-grid";

type EditorTranscriptWord = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  speakerId?: string;
};

type EditorAssetTranscript = {
  assetId: string;
  text?: string;
  durationMs?: number;
  words: EditorTranscriptWord[];
  backendId?: string;
  modelId?: string;
  language?: string;
};

type TimelineStateRecord = {
  fps?: number;
  durationInFrames?: number;
  primaryTrackId?: string | null;
  tracks?: Array<{
    id?: string;
    role?: string;
    category?: string;
    items?: Array<Record<string, unknown>>;
  }>;
  assetTranscripts?: Record<string, EditorAssetTranscript>;
};

export type WriteTimelineTranscriptProjectionInput = {
  cwd: string;
  timelineFilePath: string;
  timelineId: string;
  timelineRevision: string;
  state: unknown;
};

export type WriteTimelineTranscriptProjectionResult = {
  filePath: string;
  wordCount: number;
  sourceCount: number;
};

function fileSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "asset";
}

function projectRelativePath(cwd: string, absolutePath: string): string {
  return relative(cwd, absolutePath).split(sep).join("/");
}

function timelineProjectionStem(timelineFilePath: string): string {
  const fileName = basename(timelineFilePath);
  return fileName.replace(/\.timeline\.ya?ml$/i, "").replace(/\.ya?ml$/i, "");
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type TimelineTrackRecord = NonNullable<TimelineStateRecord["tracks"]>[number];

function trackHasSpokenMedia(track: TimelineTrackRecord): boolean {
  return (
    Array.isArray(track.items) &&
    track.items.some((item) => item.type === "video" || item.type === "audio")
  );
}

function isSpokenTrack(
  track: TimelineTrackRecord,
  primaryTrackId?: string | null,
): boolean {
  if (!trackHasSpokenMedia(track)) return false;
  const role = track.role;
  if (
    role === "music" ||
    role === "sfx" ||
    role === "subtitle" ||
    role === "transition" ||
    role === "b-roll" ||
    role === "overlay"
  ) {
    return false;
  }
  if (role === "narration" || role === "primary-video" || role === "dialogue")
    return true;
  if (primaryTrackId && track.id === primaryTrackId) return true;
  return role === undefined || role === "mixed";
}

function selectSpokenTracks(state: TimelineStateRecord): TimelineTrackRecord[] {
  const tracks = Array.isArray(state.tracks) ? state.tracks : [];
  const primaryTrack = state.primaryTrackId
    ? tracks.find((track) => track.id === state.primaryTrackId)
    : undefined;
  if (primaryTrack && isSpokenTrack(primaryTrack, state.primaryTrackId)) {
    return [primaryTrack];
  }
  return tracks.filter((track) => isSpokenTrack(track, state.primaryTrackId));
}

function transcriptFromPersistedTextLineage(input: {
  state: TimelineStateRecord;
  trackId: string;
  assetId: string;
  fps: number;
}): EditorAssetTranscript | null {
  const byWordId = new Map<string, EditorTranscriptWord>();
  for (const track of input.state.tracks ?? []) {
    for (const item of track.items ?? []) {
      if (item.type !== "text" || !Array.isArray(item.wordRefs)) continue;
      for (const rawWord of item.wordRefs) {
        if (!rawWord || typeof rawWord !== "object" || Array.isArray(rawWord))
          continue;
        const word = rawWord as Record<string, unknown>;
        if (
          word.trackId !== input.trackId ||
          word.assetId !== input.assetId ||
          typeof word.text !== "string"
        ) {
          continue;
        }
        const rawSourceStartFrame = asFiniteNumber(word.sourceStartFrame, -1);
        const rawSourceEndFrame = asFiniteNumber(word.sourceEndFrame, -1);
        if (rawSourceStartFrame < 0 || rawSourceEndFrame <= rawSourceStartFrame)
          continue;
        const sourceStartFrame = Math.round(rawSourceStartFrame);
        const sourceEndFrame = Math.max(
          sourceStartFrame + 1,
          Math.round(rawSourceEndFrame),
        );
        const id =
          typeof word.assetWordId === "string" && word.assetWordId
            ? word.assetWordId
            : typeof word.id === "string" && word.id
              ? word.id
              : `word-${sourceStartFrame}-${sourceEndFrame}`;
        byWordId.set(id, {
          id,
          text: word.text,
          startMs: Math.round((sourceStartFrame / input.fps) * 1000),
          endMs: Math.round((sourceEndFrame / input.fps) * 1000),
          ...(typeof word.confidence === "number"
            ? { confidence: word.confidence }
            : {}),
        });
      }
    }
  }
  const words = [...byWordId.values()].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      left.id.localeCompare(right.id),
  );
  if (words.length === 0) return null;
  return {
    assetId: input.assetId,
    text: words.map((word) => word.text).join(" "),
    durationMs: words.reduce(
      (maximum, word) => Math.max(maximum, word.endMs),
      0,
    ),
    words,
    backendId: "editor-text-lineage",
    modelId: "persisted-word-alignment",
  };
}

/**
 * The asset's own `media.transcript` is the canonical word grid: real backend
 * and model provenance, body in the content-addressed store. Editor caches and
 * persisted text lineage are only fallbacks for assets nothing transcribed.
 */
async function transcriptFromAssetMetadata(input: {
  cwd: string;
  assetId: string;
  dataDir?: string;
}): Promise<EditorAssetTranscript | null> {
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(
      join(input.cwd, "assets", "manifest.json"),
      "utf8",
    );
  } catch {
    return null;
  }
  let identity:
    | {
        bodyHash?: unknown;
        contentHash?: unknown;
        backendId?: unknown;
        modelId?: unknown;
        language?: unknown;
      }
    | undefined;
  try {
    const manifest = JSON.parse(manifestRaw) as {
      assets?: Array<{ id?: unknown; metadata?: Record<string, unknown> }>;
    };
    const asset = manifest.assets?.find(
      (candidate) => candidate.id === input.assetId,
    );
    const attached = asset?.metadata?.["media.transcript"];
    identity =
      attached && typeof attached === "object" && !Array.isArray(attached)
        ? (attached as typeof identity)
        : undefined;
  } catch {
    return null;
  }
  if (!identity || typeof identity.bodyHash !== "string") return null;

  const body = AsrTimedTranscriptSchema.parse(
    await readAssetMetadataBody({
      contentHash: identity.bodyHash,
      ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    }),
  );
  if (
    typeof identity.contentHash === "string" &&
    transcriptGridHash(body) !== identity.contentHash
  ) {
    throw new Error(
      `media.transcript on ${input.assetId} pins a different word grid than its stored body; ` +
        "re-attach the transcript before projecting it into a timeline.",
    );
  }
  return {
    assetId: input.assetId,
    text: body.text,
    durationMs: body.durationMs,
    words: body.words,
    backendId: body.backendId,
    modelId: body.modelId,
    ...(body.language ? { language: body.language } : {}),
  };
}

export async function writeTimelineTranscriptProjection(
  input: WriteTimelineTranscriptProjectionInput,
): Promise<WriteTimelineTranscriptProjectionResult | null> {
  if (
    !input.state ||
    typeof input.state !== "object" ||
    Array.isArray(input.state)
  )
    return null;
  const state = input.state as TimelineStateRecord;
  const spokenTracks = selectSpokenTracks(state);
  if (spokenTracks.length === 0) return null;

  const fps = asFiniteNumber(state.fps, 30);
  const durationFrames = Math.max(
    0,
    Math.round(asFiniteNumber(state.durationInFrames, 0)),
  );
  const transcripts = state.assetTranscripts ?? {};
  const sourceDirectory = join(
    dirname(input.timelineFilePath),
    `${timelineProjectionStem(input.timelineFilePath)}.transcripts`,
  );
  const transcriptFiles = new Map<
    string,
    {
      sourcePath: string;
      sourceHash: string;
      words: ReturnType<typeof projectAsrTimedTranscriptWords>;
    }
  >();
  const clips: Parameters<
    typeof buildTimelineTranscriptProjection
  >[0]["clips"] = [];

  for (const spokenTrack of spokenTracks) {
    if (!spokenTrack.id || !Array.isArray(spokenTrack.items)) continue;
    for (const item of spokenTrack.items) {
      if (
        (item.type !== "video" && item.type !== "audio") ||
        typeof item.assetId !== "string"
      )
        continue;
      const clipId =
        typeof item.id === "string" && item.id
          ? item.id
          : `${spokenTrack.id}-clip-${clips.length}`;
      const transcript =
        (await transcriptFromAssetMetadata({
          cwd: input.cwd,
          assetId: item.assetId,
        })) ??
        transcripts[item.assetId] ??
        transcriptFromPersistedTextLineage({
          state,
          trackId: spokenTrack.id,
          assetId: item.assetId,
          fps,
        });
      if (
        !transcript ||
        !Array.isArray(transcript.words) ||
        transcript.words.length === 0
      )
        continue;

      let source = transcriptFiles.get(item.assetId);
      if (!source) {
        const maxEndMs = transcript.words.reduce(
          (maximum, word) => Math.max(maximum, asFiniteNumber(word.endMs, 0)),
          0,
        );
        const timedTranscript = AsrTimedTranscriptSchema.parse({
          schemaVersion: 1,
          kind: "clash.asr.timed-transcript",
          timebase: "milliseconds",
          alignment: "word",
          text:
            transcript.text?.trim() ||
            transcript.words.map((word) => word.text).join(" "),
          backendId: transcript.backendId?.trim() || "editor-cache",
          modelId: transcript.modelId?.trim() || "word-aligned",
          ...(transcript.language?.trim()
            ? { language: transcript.language.trim() }
            : {}),
          durationMs: Math.max(
            Math.round(asFiniteNumber(transcript.durationMs, 0)),
            maxEndMs,
          ),
          words: transcript.words,
          segments: [],
        });
        const assetHash = createHash("sha256")
          .update(item.assetId)
          .digest("hex")
          .slice(0, 8);
        const sourceFilePath = join(
          sourceDirectory,
          `${fileSlug(item.assetId)}-${assetHash}.json`,
        );
        const sourceContents = `${JSON.stringify(timedTranscript, null, 2)}\n`;
        mkdirSync(sourceDirectory, { recursive: true });
        writeFileSync(sourceFilePath, sourceContents, "utf8");
        source = {
          sourcePath: projectRelativePath(input.cwd, sourceFilePath),
          sourceHash: `sha256:${createHash("sha256").update(sourceContents).digest("hex")}`,
          words: projectAsrTimedTranscriptWords(timedTranscript, fps),
        };
        transcriptFiles.set(item.assetId, source);
      }

      const playbackRate = Math.max(
        0.0001,
        asFiniteNumber(item.playbackRate, 1),
      );
      const timelineDuration = Math.max(
        0,
        Math.round(asFiniteNumber(item.durationInFrames, 0)),
      );
      const sourceStartFrame = Math.max(
        0,
        Math.round(asFiniteNumber(item.sourceStartInFrames, 0)),
      );
      if (timelineDuration === 0) continue;
      clips.push({
        clipId,
        trackId: spokenTrack.id,
        assetId: item.assetId,
        timelineStartFrame: Math.max(
          0,
          Math.round(asFiniteNumber(item.from, 0)),
        ),
        sourceStartFrame,
        sourceEndFrame:
          sourceStartFrame +
          Math.max(1, Math.ceil(timelineDuration * playbackRate)),
        playbackRate,
        transcript: {
          sourcePath: source.sourcePath,
          sourceHash: source.sourceHash,
          words: source.words,
        },
      });
    }
  }

  if (clips.length === 0 || durationFrames === 0) return null;
  const projection = buildTimelineTranscriptProjection({
    timelineId: input.timelineId,
    timelineRevision: input.timelineRevision,
    fps,
    durationFrames,
    clips,
  });
  const filePath = join(
    dirname(input.timelineFilePath),
    `${timelineProjectionStem(input.timelineFilePath)}.transcript.json`,
  );
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
  return {
    filePath,
    wordCount: projection.words.length,
    sourceCount: projection.sources.length,
  };
}
