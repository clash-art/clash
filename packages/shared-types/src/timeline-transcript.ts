import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";
import { TranscriptWordSchema } from "./production-metadata.js";

let SourceHashSchema = lazySchema(() => (
z.string().regex(/^sha256:[a-f0-9]{64}$/)
), (real) => { SourceHashSchema = real; });

export let TimelineTranscriptSourceSchema = lazySchema(() => (
z.object({
  assetId: z.string().min(1),
  transcriptSourcePath: z.string().min(1),
  transcriptSourceHash: SourceHashSchema,
  transcriptRevision: z.string().min(1).optional(),
})
), (real) => { TimelineTranscriptSourceSchema = real; });

export let TimelineTranscriptWordSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  assetId: z.string().min(1),
  assetWordId: z.string().min(1),
  clipId: z.string().min(1),
  trackId: z.string().min(1).optional(),
  sourceStartFrame: z.number().int().min(0),
  sourceEndFrame: z.number().int().min(0),
  timelineStartFrame: z.number().int().min(0),
  timelineEndFrame: z.number().int().min(0),
  confidence: z.number().min(0).max(1).optional(),
  speakerId: z.string().min(1).optional(),
}).superRefine((word, context) => {
  if (word.sourceEndFrame <= word.sourceStartFrame) {
    context.addIssue({
      code: "custom",
      message: "timeline transcript sourceEndFrame must be greater than sourceStartFrame",
      path: ["sourceEndFrame"],
    });
  }
  if (word.timelineEndFrame <= word.timelineStartFrame) {
    context.addIssue({
      code: "custom",
      message: "timeline transcript timelineEndFrame must be greater than timelineStartFrame",
      path: ["timelineEndFrame"],
    });
  }
})
), (real) => { TimelineTranscriptWordSchema = real; });

export let TimelineTranscriptProjectionSchema = lazySchema(() => (
z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("clash.timeline.transcript.projection"),
  timelineId: z.string().min(1),
  timelineRevision: z.string().min(1),
  fps: z.number().positive(),
  durationFrames: z.number().int().min(0),
  text: z.string(),
  sources: z.array(TimelineTranscriptSourceSchema).min(1),
  words: z.array(TimelineTranscriptWordSchema),
}).superRefine((projection, context) => {
  const sourceAssetIds = new Set(projection.sources.map((source) => source.assetId));
  const sourceIds = new Set<string>();
  projection.sources.forEach((source, index) => {
    if (sourceIds.has(source.assetId)) {
      context.addIssue({
        code: "custom",
        message: `duplicate timeline transcript source asset: ${source.assetId}`,
        path: ["sources", index, "assetId"],
      });
    }
    sourceIds.add(source.assetId);
  });

  const wordIds = new Set<string>();
  let previousTimelineStart = -1;
  projection.words.forEach((word, index) => {
    if (wordIds.has(word.id)) {
      context.addIssue({
        code: "custom",
        message: `duplicate timeline transcript word id: ${word.id}`,
        path: ["words", index, "id"],
      });
    }
    wordIds.add(word.id);
    if (!sourceAssetIds.has(word.assetId)) {
      context.addIssue({
        code: "custom",
        message: `timeline transcript word references unknown asset: ${word.assetId}`,
        path: ["words", index, "assetId"],
      });
    }
    if (word.timelineStartFrame < previousTimelineStart) {
      context.addIssue({
        code: "custom",
        message: "timeline transcript words must be ordered by timelineStartFrame",
        path: ["words", index, "timelineStartFrame"],
      });
    }
    if (word.timelineEndFrame > projection.durationFrames) {
      context.addIssue({
        code: "custom",
        message: "timeline transcript word exceeds durationFrames",
        path: ["words", index, "timelineEndFrame"],
      });
    }
    previousTimelineStart = word.timelineStartFrame;
  });
})
), (real) => { TimelineTranscriptProjectionSchema = real; });

export let TimelineTranscriptClipInputSchema = lazySchema(() => (
z.object({
  clipId: z.string().min(1),
  trackId: z.string().min(1).optional(),
  assetId: z.string().min(1),
  timelineStartFrame: z.number().int().min(0),
  sourceStartFrame: z.number().int().min(0),
  sourceEndFrame: z.number().int().min(0),
  playbackRate: z.number().positive().default(1),
  transcript: z.object({
    sourcePath: z.string().min(1),
    sourceHash: SourceHashSchema,
    revision: z.string().min(1).optional(),
    words: z.array(TranscriptWordSchema),
  }),
}).refine((clip) => clip.sourceEndFrame > clip.sourceStartFrame, {
  message: "timeline transcript clip sourceEndFrame must be greater than sourceStartFrame",
  path: ["sourceEndFrame"],
})
), (real) => { TimelineTranscriptClipInputSchema = real; });

export let BuildTimelineTranscriptProjectionInputSchema = lazySchema(() => (
z.object({
  timelineId: z.string().min(1),
  timelineRevision: z.string().min(1),
  fps: z.number().positive(),
  durationFrames: z.number().int().min(0),
  clips: z.array(TimelineTranscriptClipInputSchema).min(1),
})
), (real) => { BuildTimelineTranscriptProjectionInputSchema = real; });

export type TimelineTranscriptSource = z.infer<typeof TimelineTranscriptSourceSchema>;
export type TimelineTranscriptWord = z.infer<typeof TimelineTranscriptWordSchema>;
export type TimelineTranscriptProjection = z.infer<typeof TimelineTranscriptProjectionSchema>;
export type TimelineTranscriptClipInput = z.input<typeof TimelineTranscriptClipInputSchema>;
export type BuildTimelineTranscriptProjectionInput = z.input<typeof BuildTimelineTranscriptProjectionInputSchema>;

export function buildTimelineTranscriptProjection(
  input: BuildTimelineTranscriptProjectionInput,
): TimelineTranscriptProjection {
  const parsed = BuildTimelineTranscriptProjectionInputSchema.parse(input);
  const sourcesByAssetId = new Map<string, TimelineTranscriptSource>();
  const words: TimelineTranscriptWord[] = [];
  const clips = parsed.clips
    .map((clip, inputIndex) => ({ clip, inputIndex }))
    .sort((left, right) => (
      left.clip.timelineStartFrame - right.clip.timelineStartFrame
      || left.inputIndex - right.inputIndex
    ));

  for (const { clip } of clips) {
    const source: TimelineTranscriptSource = {
      assetId: clip.assetId,
      transcriptSourcePath: clip.transcript.sourcePath,
      transcriptSourceHash: clip.transcript.sourceHash,
      ...(clip.transcript.revision ? { transcriptRevision: clip.transcript.revision } : {}),
    };
    const existingSource = sourcesByAssetId.get(clip.assetId);
    if (existingSource && (
      existingSource.transcriptSourcePath !== source.transcriptSourcePath
      || existingSource.transcriptSourceHash !== source.transcriptSourceHash
      || existingSource.transcriptRevision !== source.transcriptRevision
    )) {
      throw new Error(`Timeline clips for asset ${clip.assetId} use conflicting transcript revisions`);
    }
    sourcesByAssetId.set(clip.assetId, source);

    for (const sourceWord of clip.transcript.words) {
      const sourceStartFrame = Math.max(sourceWord.startFrame, clip.sourceStartFrame);
      const sourceEndFrame = Math.min(sourceWord.endFrame, clip.sourceEndFrame);
      if (sourceEndFrame <= sourceStartFrame) continue;
      const timelineStartFrame = clip.timelineStartFrame
        + Math.floor((sourceStartFrame - clip.sourceStartFrame) / clip.playbackRate);
      if (timelineStartFrame >= parsed.durationFrames) continue;
      const projectedEndFrame = clip.timelineStartFrame
        + Math.ceil((sourceEndFrame - clip.sourceStartFrame) / clip.playbackRate);
      const timelineEndFrame = Math.min(
        parsed.durationFrames,
        Math.max(timelineStartFrame + 1, projectedEndFrame),
      );
      if (timelineEndFrame <= timelineStartFrame) continue;
      words.push({
        id: `${clip.clipId}:${sourceWord.id}`,
        text: sourceWord.text,
        assetId: clip.assetId,
        assetWordId: sourceWord.id,
        clipId: clip.clipId,
        ...(clip.trackId ? { trackId: clip.trackId } : {}),
        sourceStartFrame,
        sourceEndFrame,
        timelineStartFrame,
        timelineEndFrame,
        ...(sourceWord.confidence === undefined ? {} : { confidence: sourceWord.confidence }),
        ...(sourceWord.speakerId === undefined ? {} : { speakerId: sourceWord.speakerId }),
      });
    }
  }

  words.sort((left, right) => (
    left.timelineStartFrame - right.timelineStartFrame
    || left.timelineEndFrame - right.timelineEndFrame
    || left.id.localeCompare(right.id)
  ));

  return TimelineTranscriptProjectionSchema.parse({
    schemaVersion: 1,
    kind: "clash.timeline.transcript.projection",
    timelineId: parsed.timelineId,
    timelineRevision: parsed.timelineRevision,
    fps: parsed.fps,
    durationFrames: parsed.durationFrames,
    text: joinTimelineTranscriptTokens(words.map((word) => word.text)),
    sources: [...sourcesByAssetId.values()],
    words,
  });
}

function joinTimelineTranscriptTokens(tokens: string[]): string {
  let text = "";
  for (const token of tokens) {
    if (!text) {
      text = token;
      continue;
    }
    const previous = text.slice(-1);
    const next = token.slice(0, 1);
    const noLeadingSpace = /^[,.;:!?，。！？、；：）》】」』…]/u.test(token)
      || /[(（《【「『]/u.test(previous)
      || (isCjk(previous) && isCjk(next));
    text += `${noLeadingSpace ? "" : " "}${token}`;
  }
  return text;
}

function isCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}
