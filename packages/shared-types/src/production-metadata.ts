import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

import {
  MetadataAttachmentTargetSchema,
  type MetadataAttachmentTarget,
} from "./metadata-attachments.js";

let FrameRangeSchema = lazySchema(() => (
z.object({
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().min(0),
})
), (real) => { FrameRangeSchema = real; });

export let AudioBeatSchema = lazySchema(() => (
z.object({
  frame: z.number().int().min(0),
  timeSeconds: z.number().min(0),
  confidence: z.number().min(0).max(1),
  bar: z.number().int().positive().optional(),
  beatInBar: z.number().int().positive().optional(),
  downbeat: z.boolean().optional(),
})
), (real) => { AudioBeatSchema = real; });

export let AudioEnergyPointSchema = lazySchema(() => (
z.object({
  frame: z.number().int().min(0),
  timeSeconds: z.number().min(0),
  rms: z.number().min(0),
  normalized: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  impact: z.number().min(0).max(1),
})
), (real) => { AudioEnergyPointSchema = real; });

export let AudioSectionSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().min(0),
  label: z.string().min(1),
  semanticLabel: z
    .enum([
      "intro",
      "verse",
      "pre-chorus",
      "chorus",
      "bridge",
      "drop",
      "buildup",
      "breakdown",
      "outro",
      "instrumental",
      "detected-beats",
      "unknown",
    ])
    .optional(),
  semanticConfidence: z.number().min(0).max(1).optional(),
  reviewRequired: z.boolean().optional(),
  semanticSource: z.string().min(1).optional(),
  energy: z.number().min(0).max(1).optional(),
  novelty: z.number().min(0).max(1).optional(),
  impact: z.number().min(0).max(1).optional(),
  cutDensity: z.enum(["hold", "medium", "fast"]).optional(),
})
), (real) => { AudioSectionSchema = real; });

export let AudioBeatMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("audio.beat-analysis"),
  bpm: z.number().positive(),
  fps: z.number().positive(),
  beats: z.array(AudioBeatSchema),
  sections: z.array(AudioSectionSchema).default([]),
  energyCurve: z.array(AudioEnergyPointSchema).default([]),
})
), (real) => { AudioBeatMetadataSchema = real; });

export let AudioStemTypeSchema = lazySchema(() => (
z.enum([
  "vocal",
  "instrumental",
  "drums",
  "bass",
  "other",
])
), (real) => { AudioStemTypeSchema = real; });

export let AudioStemAssetSchema = lazySchema(() => (
z.object({
  stemAssetId: z.string().min(1),
  stemType: AudioStemTypeSchema,
  filePath: z.string().min(1),
  fileHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  codec: z.string().min(1).optional(),
  durationSeconds: z.number().positive().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
})
), (real) => { AudioStemAssetSchema = real; });

export let AudioStemSeparationMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("audio.stem-separation"),
  separationId: z.string().min(1),
  sourceAssetId: z.string().min(1),
  sourcePath: z.string().min(1).optional(),
  backendId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  stems: z.array(AudioStemAssetSchema).min(1),
  vocalStemAssetId: z.string().min(1).optional(),
  decisionLog: z.array(z.string().min(1)).default([]),
})
), (real) => { AudioStemSeparationMetadataSchema = real; });

export let LyricsAlignmentUnitSchema = lazySchema(() => (
z
  .object({
    lineId: z.string().min(1),
    wordId: z.string().min(1).optional(),
    text: z.string().min(1),
    startMs: z.number().min(0),
    endMs: z.number().min(0),
    startFrame: z.number().int().min(0).optional(),
    endFrame: z.number().int().min(0).optional(),
    confidence: z.number().min(0).max(1),
    source: z.string().min(1),
  })
  .refine((unit) => unit.endMs > unit.startMs, {
    message: "lyrics alignment unit endMs must be greater than startMs",
    path: ["endMs"],
  })
), (real) => { LyricsAlignmentUnitSchema = real; });

export let LyricsUnmatchedRangeSchema = lazySchema(() => (
z
  .object({
    startMs: z.number().min(0),
    endMs: z.number().min(0),
    text: z.string().optional(),
    reason: z.string().optional(),
  })
  .refine((range) => range.endMs > range.startMs, {
    message: "lyrics unmatched range endMs must be greater than startMs",
    path: ["endMs"],
  })
), (real) => { LyricsUnmatchedRangeSchema = real; });

export let LyricsAlignmentMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("audio.lyrics-alignment"),
  fps: z.number().positive(),
  lyricsSource: z.string().min(1),
  vocalStemAssetId: z.string().min(1).optional(),
  units: z.array(LyricsAlignmentUnitSchema).min(1),
  unmatchedRanges: z.array(LyricsUnmatchedRangeSchema).default([]),
})
), (real) => { LyricsAlignmentMetadataSchema = real; });

export let AsrTimedWordSchema = lazySchema(() => (
z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    confidence: z.number().min(0).max(1).optional(),
    speakerId: z.string().min(1).optional(),
  })
  .refine((word) => word.endMs > word.startMs, {
    message: "ASR word endMs must be greater than startMs",
    path: ["endMs"],
  })
), (real) => { AsrTimedWordSchema = real; });

export let AsrTimedSegmentSchema = lazySchema(() => (
z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    wordIds: z.array(z.string().min(1)),
    speakerId: z.string().min(1).optional(),
  })
  .refine((segment) => segment.endMs > segment.startMs, {
    message: "ASR segment endMs must be greater than startMs",
    path: ["endMs"],
  })
), (real) => { AsrTimedSegmentSchema = real; });

export let AsrTimedTranscriptSchema = lazySchema(() => (
z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.asr.timed-transcript"),
    timebase: z.literal("milliseconds"),
    alignment: z.literal("word"),
    text: z.string().min(1),
    backendId: z.string().min(1),
    modelId: z.string().min(1),
    language: z.string().min(1).optional(),
    durationMs: z.number().int().min(0),
    words: z.array(AsrTimedWordSchema).min(1),
    segments: z.array(AsrTimedSegmentSchema),
  })
  .superRefine((transcript, context) => {
    const wordIds = new Set<string>();
    let previousStartMs = -1;
    let maxEndMs = 0;
    transcript.words.forEach((word, index) => {
      if (wordIds.has(word.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate ASR word id: ${word.id}`,
          path: ["words", index, "id"],
        });
      }
      wordIds.add(word.id);
      if (word.startMs < previousStartMs) {
        context.addIssue({
          code: "custom",
          message: "ASR words must be ordered by startMs",
          path: ["words", index, "startMs"],
        });
      }
      previousStartMs = word.startMs;
      maxEndMs = Math.max(maxEndMs, word.endMs);
    });
    if (transcript.durationMs < maxEndMs) {
      context.addIssue({
        code: "custom",
        message: "ASR durationMs must cover every word",
        path: ["durationMs"],
      });
    }
    transcript.segments.forEach((segment, segmentIndex) => {
      segment.wordIds.forEach((wordId, wordIndex) => {
        if (!wordIds.has(wordId)) {
          context.addIssue({
            code: "custom",
            message: `ASR segment references unknown word id: ${wordId}`,
            path: ["segments", segmentIndex, "wordIds", wordIndex],
          });
        }
      });
    });
  })
), (real) => { AsrTimedTranscriptSchema = real; });

export let TranscriptWordSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  text: z.string(),
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().min(0),
  confidence: z.number().min(0).max(1).optional(),
  speakerId: z.string().min(1).optional(),
})
), (real) => { TranscriptWordSchema = real; });

export let AsrTranscriptMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("asr-transcript"),
  sourcePath: z.string().min(1),
  sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  backendId: z.string().min(1),
  modelId: z.string().min(1),
  language: z.string().min(1).optional(),
  durationFrames: z.number().int().min(0).optional(),
  wordCount: z.number().int().nonnegative(),
  averageConfidence: z.number().min(0).max(1).optional(),
})
), (real) => { AsrTranscriptMetadataSchema = real; });

export let TextCutSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  sourceStartFrame: z.number().int().min(0),
  sourceEndFrame: z.number().int().min(0),
  outputStartFrame: z.number().int().min(0),
  outputEndFrame: z.number().int().min(0),
  action: z.enum(["keep", "delete", "review"]),
  reason: z.string().optional(),
  requiresReview: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  detectionSource: z.string().min(1).optional(),
})
), (real) => { TextCutSchema = real; });

export let CaptionCueSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  startFrame: z.number().int().min(0),
  durationInFrames: z.number().int().positive(),
  text: z.string().min(1),
  wordIds: z.array(z.string()).optional(),
  sourceStartFrame: z.number().int().min(0).optional(),
  sourceEndFrame: z.number().int().min(0).optional(),
})
), (real) => { CaptionCueSchema = real; });

export let TalkingHeadMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("talking-head.analysis"),
  fps: z.number().positive(),
  asr: AsrTranscriptMetadataSchema.optional(),
  words: z.array(TranscriptWordSchema),
  cuts: z.array(TextCutSchema).default([]),
  captionCues: z.array(CaptionCueSchema).default([]),
  disfluencies: z
    .array(
      z.object({
        id: z.string().optional(),
        wordId: z.string().optional(),
        startFrame: z.number().int().min(0).optional(),
        endFrame: z.number().int().min(0).optional(),
        text: z.string().optional(),
        type: z.enum(["filler", "silence", "tone-particle", "repeat"]),
        requiresReview: z.boolean().default(false),
        confidence: z.number().min(0).max(1).optional(),
        detectionSource: z.string().min(1).optional(),
      }),
    )
    .default([]),
})
), (real) => { TalkingHeadMetadataSchema = real; });

export let RightsMetadataSchema = lazySchema(() => (
z.object({
  license: z.string().min(1),
  attribution: z.string().min(1),
  redistributionAllowed: z.boolean(),
  derivativeAllowed: z.boolean(),
})
), (real) => { RightsMetadataSchema = real; });

export let ReferenceShotSchema = lazySchema(() => (
FrameRangeSchema.extend({
  id: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
})
), (real) => { ReferenceShotSchema = real; });

export let ReferenceVideoMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("reference-video.analysis"),
  sourceUrl: z.string().min(1),
  rights: RightsMetadataSchema,
  shots: z.array(ReferenceShotSchema).default([]),
  nonCopyingQa: z
    .object({
      status: z.enum(["passed", "requires-review", "failed"]),
      similarityScore: z.number().min(0).max(1).optional(),
    })
    .optional(),
})
), (real) => { ReferenceVideoMetadataSchema = real; });

export let ReferenceDownloadSourceLedgerSchema = lazySchema(() => (
z.object({
  sourceUrl: z.string().min(1),
  license: z.string().min(1),
  attribution: z.string().min(1),
  allowedUses: z.array(z.string().min(1)).default(["analysis-only"]),
  redistributionAllowed: z.boolean(),
  derivativeAllowed: z.boolean(),
})
), (real) => { ReferenceDownloadSourceLedgerSchema = real; });

export let ReferenceDownloadFileSchema = lazySchema(() => (
z.object({
  path: z.string().min(1),
  mediaType: z.enum(["video", "audio", "image", "metadata", "unknown"]),
  sizeBytes: z.number().int().nonnegative().optional(),
})
), (real) => { ReferenceDownloadFileSchema = real; });

export let ReferenceDownloadMetadataBaseSchema = lazySchema(() => (
z.object({
  kind: z.literal("reference.download"),
  sourceUrl: z.string().min(1),
  tool: z.literal("yt-dlp"),
  outputDir: z.string().min(1),
  downloadedFiles: z.array(ReferenceDownloadFileSchema).min(1),
  rawReferenceQuarantine: z.literal(true),
  finalExportAllowed: z.boolean(),
  sourceLedger: ReferenceDownloadSourceLedgerSchema,
  decisionLog: z.array(z.string().min(1)).default([]),
})
), (real) => { ReferenceDownloadMetadataBaseSchema = real; });

function hasReferenceDownloadFinalExportRights(
  metadata: z.infer<typeof ReferenceDownloadMetadataBaseSchema>,
): boolean {
  return (
    !metadata.finalExportAllowed ||
    (metadata.sourceLedger.redistributionAllowed &&
      metadata.sourceLedger.derivativeAllowed)
  );
}

export let ReferenceDownloadMetadataSchema =
  lazySchema(() => (
ReferenceDownloadMetadataBaseSchema.refine(
    hasReferenceDownloadFinalExportRights,
    {
      message: "final export requires derivative and redistribution rights",
      path: ["finalExportAllowed"],
    },
  )
), (real) => { ReferenceDownloadMetadataSchema = real; });

export let VisualMomentCandidateSchema = lazySchema(() => (
z
  .object({
    id: z.string().min(1),
    startMs: z.number().min(0),
    endMs: z.number().min(0),
    peakMs: z.number().min(0),
    startFrame: z.number().int().min(0).optional(),
    endFrame: z.number().int().min(0).optional(),
    peakFrame: z.number().int().min(0).optional(),
    sceneIndex: z.number().int().min(0),
    motion: z.number().min(0).max(1),
    quality: z.number().min(0).max(1),
    action: z.number().min(0).max(1).optional(),
    emotion: z.number().min(0).max(1).optional(),
    semantic: z.string().min(1).optional(),
    tags: z.array(z.string()).default([]),
  })
  .refine((candidate) => candidate.endMs > candidate.startMs, {
    message: "visual moment endMs must be greater than startMs",
    path: ["endMs"],
  })
), (real) => { VisualMomentCandidateSchema = real; });

export let VideoVisualMomentMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("video.visual-moments"),
  sourceVideoAssetId: z.string().min(1),
  fps: z.number().positive(),
  sourcePath: z.string().min(1).optional(),
  sceneChanges: z.array(z.number().int().min(0)).default([]),
  candidates: z.array(VisualMomentCandidateSchema).min(1),
})
), (real) => { VideoVisualMomentMetadataSchema = real; });

export let CharacterReferenceViewKindSchema = lazySchema(() => (
z.enum([
  "front",
  "side",
  "back",
  "three-quarter",
  "expression",
])
), (real) => { CharacterReferenceViewKindSchema = real; });

export let CharacterReferenceViewSchema = lazySchema(() => (
z.object({
  view: CharacterReferenceViewKindSchema,
  assetId: z.string().min(1),
  path: z.string().min(1),
  locked: z.boolean().default(true),
  copyOnWriteRequired: z.boolean().default(true),
})
), (real) => { CharacterReferenceViewSchema = real; });

export let ImageStoryboardMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("image.storyboard-consistency"),
  characters: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        referenceAssetIds: z.array(z.string()).min(1),
        requiredViews: z.array(CharacterReferenceViewKindSchema).default([]),
        referenceViews: z.array(CharacterReferenceViewSchema).default([]),
      }),
    )
    .default([]),
  scenes: z
    .array(
      z.object({
        id: z.string().min(1),
        referenceAssetIds: z.array(z.string()).default([]),
        prompt: z.string().min(1),
      }),
    )
    .default([]),
  panels: z
    .array(
      z.object({
        id: z.string().min(1),
        sceneId: z.string().min(1),
        characterIds: z.array(z.string()).default([]),
        assetId: z.string().min(1),
        path: z.string().min(1).optional(),
        consistencyScore: z.number().min(0).max(1).optional(),
      }),
    )
    .default([]),
})
), (real) => { ImageStoryboardMetadataSchema = real; });

export let SemanticReferenceRoleKindSchema = lazySchema(() => (
z.enum([
  "identity-front",
  "identity-side",
  "identity-back",
  "identity-three-quarter",
  "identity-expression",
  "scene-plate",
  "style-frame",
  "logo-lock",
  "product-packshot",
])
), (real) => { SemanticReferenceRoleKindSchema = real; });

export let SemanticReferenceDownstreamUsageSchema = lazySchema(() => (
z.enum([
  "identity-reference",
  "scene-reference",
  "style-reference",
  "brand-lock",
  "product-reference",
])
), (real) => { SemanticReferenceDownstreamUsageSchema = real; });

export let SemanticReferenceRoleSchema = lazySchema(() => (
z.object({
  roleId: z.string().min(1),
  assetId: z.string().min(1),
  role: SemanticReferenceRoleKindSchema,
  subjectId: z.string().min(1).optional(),
  path: z.string().min(1),
  locked: z.boolean(),
  copyOnWriteRequired: z.boolean(),
  downstreamUsage: SemanticReferenceDownstreamUsageSchema,
  constraints: z.array(z.string().min(1)).default([]),
})
), (real) => { SemanticReferenceRoleSchema = real; });

export let SemanticReferenceRolesMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("image.semantic-reference-roles"),
  roles: z.array(SemanticReferenceRoleSchema).min(1),
})
), (real) => { SemanticReferenceRolesMetadataSchema = real; });

export let ProductLogoQaReferenceSchema = lazySchema(() => (
z.object({
  roleId: z.string().min(1),
  assetId: z.string().min(1),
  role: z.enum(["logo-lock", "product-packshot"]),
  subjectId: z.string().min(1).optional(),
  path: z.string().min(1),
  locked: z.boolean(),
  copyOnWriteRequired: z.boolean(),
  constraints: z.array(z.string().min(1)).default([]),
})
), (real) => { ProductLogoQaReferenceSchema = real; });

export let ProductLogoQaCheckKindSchema = lazySchema(() => (
z.enum([
  "logo-presence",
  "glyph-lock",
  "brand-color",
  "packshot-presence",
  "claim-text",
  "material-finish",
  "packaging-layout",
])
), (real) => { ProductLogoQaCheckKindSchema = real; });

export let ProductLogoQaCheckSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  roleId: z.string().min(1),
  referenceAssetId: z.string().min(1),
  check: ProductLogoQaCheckKindSchema,
  status: z.enum(["pass", "requires-review", "fail"]),
  required: z.boolean().default(true),
  expected: z.string().min(1),
  actual: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  deltaE: z.number().min(0).optional(),
  evidence: z.string().min(1).optional(),
})
), (real) => { ProductLogoQaCheckSchema = real; });

export let ProductLogoQaMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("image.product-logo-qa"),
  targetAssetId: z.string().min(1),
  referencePackAssetId: z.string().min(1).optional(),
  requiredReferenceAssetIds: z.array(z.string().min(1)).min(1),
  references: z.array(ProductLogoQaReferenceSchema).min(1),
  checks: z.array(ProductLogoQaCheckSchema).min(1),
  verdict: z.enum(["pass", "requires-review", "fail"]),
  blockedReasons: z.array(z.string().min(1)).default([]),
  copyOnWriteRequired: z.boolean(),
})
), (real) => { ProductLogoQaMetadataSchema = real; });

export let AnalysisBackendBenchmarkMetricSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  score: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1),
  weight: z.number().positive().default(1),
  higherIsBetter: z.boolean().default(true),
  status: z.enum(["pass", "fail"]),
})
), (real) => { AnalysisBackendBenchmarkMetricSchema = real; });

export let AnalysisBackendBenchmarkCandidateSchema = lazySchema(() => (
z.object({
  backendId: z.string().min(1),
  capability: z.string().min(1),
  resultPath: z.string().min(1),
  metrics: z.array(AnalysisBackendBenchmarkMetricSchema).min(1),
  weightedScore: z.number().min(0).max(1),
  status: z.enum(["pass", "fail"]),
})
), (real) => { AnalysisBackendBenchmarkCandidateSchema = real; });

export let AnalysisBackendBenchmarkMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("analysis.backend-benchmark"),
  benchmarkId: z.string().min(1),
  targetCapability: z.string().min(1),
  fixtureSetPath: z.string().min(1),
  candidates: z.array(AnalysisBackendBenchmarkCandidateSchema).min(1),
  selectedBackendId: z.string().min(1).optional(),
  verdict: z.enum(["pass", "requires-review", "fail"]),
  blockedReasons: z.array(z.string().min(1)).default([]),
  decisionLog: z.array(z.string().min(1)).default([]),
})
), (real) => { AnalysisBackendBenchmarkMetadataSchema = real; });

export let ImageEmbeddingDistanceMetricSchema = lazySchema(() => (
z.enum([
  "cosine",
  "dot",
  "euclidean",
])
), (real) => { ImageEmbeddingDistanceMetricSchema = real; });

export let ImageEmbeddingBaselineForSchema = lazySchema(() => (
z.enum([
  "identity",
  "product",
  "scene",
  "style",
  "logo",
])
), (real) => { ImageEmbeddingBaselineForSchema = real; });

export let ImageEmbeddingStoreItemSchema = lazySchema(() => (
z.object({
  assetId: z.string().min(1),
  roleId: z.string().min(1).optional(),
  subjectId: z.string().min(1).optional(),
  path: z.string().min(1),
  vectorPath: z.string().min(1),
  vectorHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  dimension: z.number().int().positive(),
  baselineFor: z.array(ImageEmbeddingBaselineForSchema).min(1),
  locked: z.boolean(),
  copyOnWriteRequired: z.boolean(),
  tags: z.array(z.string().min(1)).default([]),
})
), (real) => { ImageEmbeddingStoreItemSchema = real; });

export let ImageEmbeddingStoreMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("image.embedding-store"),
  embeddingSetId: z.string().min(1),
  modelId: z.string().min(1),
  dimension: z.number().int().positive(),
  distanceMetric: ImageEmbeddingDistanceMetricSchema,
  items: z.array(ImageEmbeddingStoreItemSchema).min(1),
  copyOnWriteRequired: z.boolean(),
})
), (real) => { ImageEmbeddingStoreMetadataSchema = real; });

export let ImageComfyuiApiFormatSchema = lazySchema(() => (
z.enum([
  "comfyui-api-json",
  "comfyui-ui-json",
])
), (real) => { ImageComfyuiApiFormatSchema = real; });

export let ImageComfyuiModelTypeSchema = lazySchema(() => (
z.enum([
  "checkpoint",
  "vae",
  "lora",
  "controlnet",
  "upscaler",
  "embedding",
  "other",
])
), (real) => { ImageComfyuiModelTypeSchema = real; });

export let ImageComfyuiModelReferenceSchema = lazySchema(() => (
z.object({
  name: z.string().min(1),
  type: ImageComfyuiModelTypeSchema,
  path: z.string().min(1).optional(),
  hash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  license: z.string().min(1).optional(),
})
), (real) => { ImageComfyuiModelReferenceSchema = real; });

export let ImageComfyuiCustomNodeSchema = lazySchema(() => (
z.object({
  name: z.string().min(1),
  source: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
  hash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
})
), (real) => { ImageComfyuiCustomNodeSchema = real; });

export let ImageComfyuiInputKindSchema = lazySchema(() => (
z.enum([
  "text",
  "image",
  "mask",
  "latent",
  "seed",
  "number",
  "model",
  "lora",
  "controlnet",
  "other",
])
), (real) => { ImageComfyuiInputKindSchema = real; });

export let ImageComfyuiInputSlotSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  nodeId: z.string().min(1),
  inputName: z.string().min(1),
  kind: ImageComfyuiInputKindSchema,
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  assetId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
})
), (real) => { ImageComfyuiInputSlotSchema = real; });

export let ImageComfyuiOutputStatusSchema = lazySchema(() => (
z.enum([
  "planned",
  "materialized",
])
), (real) => { ImageComfyuiOutputStatusSchema = real; });

export let ImageComfyuiOutputMediaTypeSchema = lazySchema(() => (
z.enum([
  "image",
  "image-sequence",
  "mask",
  "metadata",
])
), (real) => { ImageComfyuiOutputMediaTypeSchema = real; });

export let ImageComfyuiOutputSchema = lazySchema(() => (
z.object({
  outputAssetId: z.string().min(1),
  nodeId: z.string().min(1),
  outputName: z.string().min(1).optional(),
  mediaType: ImageComfyuiOutputMediaTypeSchema,
  path: z.string().min(1),
  fileHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  status: ImageComfyuiOutputStatusSchema,
})
), (real) => { ImageComfyuiOutputSchema = real; });

export let ImageComfyuiExecutionSchema = lazySchema(() => (
z.object({
  mode: z.enum(["planned", "completed", "failed"]),
  runnerId: z.string().min(1).optional(),
  promptId: z.string().min(1).optional(),
  executedAt: z.string().min(1).optional(),
})
), (real) => { ImageComfyuiExecutionSchema = real; });

export let ImageComfyuiRunnerMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("image.comfyui-runner"),
  workflowId: z.string().min(1),
  workflowPath: z.string().min(1),
  workflowHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  apiFormat: ImageComfyuiApiFormatSchema,
  backendId: z.string().min(1).optional(),
  models: z.array(ImageComfyuiModelReferenceSchema).default([]),
  customNodes: z.array(ImageComfyuiCustomNodeSchema).default([]),
  inputs: z.array(ImageComfyuiInputSlotSchema).default([]),
  outputs: z.array(ImageComfyuiOutputSchema).min(1),
  execution: ImageComfyuiExecutionSchema.prefault({ mode: "planned" }),
  decisionLog: z.array(z.string().min(1)).default([]),
})
), (real) => { ImageComfyuiRunnerMetadataSchema = real; });

export let StoryboardPromptSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  panelId: z.string().min(1),
  sceneId: z.string().min(1),
  characterIds: z.array(z.string()).default([]),
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  outputAssetId: z.string().min(1),
  outputPath: z.string().min(1),
  modelHint: z.string().optional(),
})
), (real) => { StoryboardPromptSchema = real; });

export let StoryboardPromptPackSchema = lazySchema(() => (
z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("clash.storyboard.prompt-pack"),
  storyboardAssetId: z.string().min(1),
  prompts: z.array(StoryboardPromptSchema).min(1),
})
), (real) => { StoryboardPromptPackSchema = real; });

export let SafeZonesSchema = lazySchema(() => (
z.object({
  top: z.number().int().min(0),
  right: z.number().int().min(0),
  bottom: z.number().int().min(0),
  left: z.number().int().min(0),
})
), (real) => { SafeZonesSchema = real; });

export let AdDeliveryVariantSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  platform: z.string().min(1),
  durationSeconds: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspectRatio: z.string().min(1),
  safeZones: SafeZonesSchema,
  subtitlesRequired: z.boolean().default(true),
  loudnessTarget: z.string().min(1).default("platform-default"),
})
), (real) => { AdDeliveryVariantSchema = real; });

export let AdPackshotSpecSchema = lazySchema(() => (
z.object({
  required: z.boolean().default(true),
  assetId: z.string().min(1),
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().min(0),
})
), (real) => { AdPackshotSpecSchema = real; });

export let AdEndCardSpecSchema = lazySchema(() => (
z.object({
  required: z.boolean().default(true),
  durationFrames: z.number().int().positive(),
  cta: z.string().min(1),
  disclaimer: z.string().min(1).optional(),
  qrRequired: z.boolean().default(false),
})
), (real) => { AdEndCardSpecSchema = real; });

export let AdDeliveryMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("ad.delivery-spec"),
  brand: z.string().min(1),
  fps: z.number().positive(),
  platforms: z.array(z.string().min(1)).min(1),
  variants: z.array(AdDeliveryVariantSchema).min(1),
  packshot: AdPackshotSpecSchema,
  endCard: AdEndCardSpecSchema,
  rightsLedgerAssetId: z.string().min(1).optional(),
})
), (real) => { AdDeliveryMetadataSchema = real; });

let AdDeliveryChecklistItemSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean(),
})
), (real) => { AdDeliveryChecklistItemSchema = real; });

export let AdDeliverySpecProjectionSchema = lazySchema(() => (
z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("clash.ad.delivery-spec.projection"),
  targetAssetId: z.string().min(1),
  brand: z.string().min(1),
  fps: z.number().positive(),
  platforms: z.array(z.string().min(1)).min(1),
  variants: z.array(AdDeliveryVariantSchema).min(1),
  packshot: AdPackshotSpecSchema,
  endCard: AdEndCardSpecSchema,
  rightsLedgerAssetId: z.string().min(1).optional(),
  checklist: z.array(AdDeliveryChecklistItemSchema).default([]),
})
), (real) => { AdDeliverySpecProjectionSchema = real; });

export let AdDeliveryExportProbeSchema = lazySchema(() => (
z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  durationSeconds: z.number().positive(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  videoCodec: z.string().min(1).optional(),
  audioCodec: z.string().min(1).optional(),
})
), (real) => { AdDeliveryExportProbeSchema = real; });

export let AdDeliverySafeZoneViolationSchema = lazySchema(() => (
z.object({
  frame: z.number().int().min(0).optional(),
  description: z.string().min(1),
  severity: z.enum(["warning", "error"]).default("error"),
})
), (real) => { AdDeliverySafeZoneViolationSchema = real; });

export let AdDeliveryVisualQaReportSchema = lazySchema(() => (
z.object({
  captionsPresent: z.boolean(),
  safeZoneViolations: z.array(AdDeliverySafeZoneViolationSchema).default([]),
  packshotVisible: z.boolean(),
  endCardVisible: z.boolean(),
  disclaimerVisible: z.boolean().optional(),
  ctaVisible: z.boolean().optional(),
  logoLockupVisible: z.boolean().optional(),
  finalFrameHolds: z.boolean().optional(),
})
), (real) => { AdDeliveryVisualQaReportSchema = real; });

export let AdDeliveryExportValidationCheckSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  status: z.enum(["pass", "fail"]),
  required: z.boolean(),
  severity: z.enum(["error", "warning"]).default("error"),
  expected: z.string().min(1),
  actual: z.string().min(1),
})
), (real) => { AdDeliveryExportValidationCheckSchema = real; });

export let AdDeliveryExportValidationReceiptSchema = lazySchema(() => (
z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("clash.ad.delivery-export-validation"),
  targetAssetId: z.string().min(1),
  brand: z.string().min(1),
  variant: AdDeliveryVariantSchema,
  renderedPath: z.string().min(1),
  probe: AdDeliveryExportProbeSchema,
  visualQa: AdDeliveryVisualQaReportSchema.optional(),
  checks: z.array(AdDeliveryExportValidationCheckSchema).min(1),
  verdict: z.enum(["pass", "fail"]),
})
), (real) => { AdDeliveryExportValidationReceiptSchema = real; });

export let AdVisualQaCheckKindSchema = lazySchema(() => (
z.enum([
  "captions-present",
  "safe-zone",
  "packshot-visible",
  "end-card-visible",
  "disclaimer-visible",
  "disclaimer-ocr",
  "cta-visible",
  "logo-lockup-visible",
  "final-frame-hold",
])
), (real) => { AdVisualQaCheckKindSchema = real; });

export let AdVisualQaCheckSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  check: AdVisualQaCheckKindSchema,
  status: z.enum(["pass", "fail", "requires-review"]),
  required: z.boolean().default(true),
  expected: z.string().min(1),
  actual: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  frame: z.number().int().min(0).optional(),
  evidencePath: z.string().min(1).optional(),
})
), (real) => { AdVisualQaCheckSchema = real; });

export let AdVisualQaMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("ad.visual-qa"),
  targetAssetId: z.string().min(1),
  variantId: z.string().min(1),
  renderedPath: z.string().min(1),
  evidencePath: z.string().min(1),
  checks: z.array(AdVisualQaCheckSchema).min(1),
  verdict: z.enum(["pass", "requires-review", "fail"]),
  blockedReasons: z.array(z.string().min(1)).default([]),
  visualQa: AdDeliveryVisualQaReportSchema,
  decisionLog: z.array(z.string().min(1)).default([]),
})
), (real) => { AdVisualQaMetadataSchema = real; });

export let ContentCredentialModeSchema = lazySchema(() => (
z.enum([
  "unsigned-manifest",
  "signed-c2pa",
  "external",
])
), (real) => { ContentCredentialModeSchema = real; });

export let ContentCredentialSignatureStatusSchema = lazySchema(() => (
z.enum([
  "unsigned",
  "signed",
  "external",
  "failed",
])
), (real) => { ContentCredentialSignatureStatusSchema = real; });

export let ContentCredentialIngredientRelationshipSchema = lazySchema(() => (
z.enum([
  "source",
  "reference",
  "generated-input",
  "model",
  "metadata",
])
), (real) => { ContentCredentialIngredientRelationshipSchema = real; });

export let ContentCredentialIngredientSchema = lazySchema(() => (
z.object({
  assetId: z.string().min(1).optional(),
  path: z.string().min(1),
  relationship: ContentCredentialIngredientRelationshipSchema,
  hash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  title: z.string().min(1).optional(),
  rights: z.string().min(1).optional(),
})
), (real) => { ContentCredentialIngredientSchema = real; });

export let ContentCredentialActionSchema = lazySchema(() => (
z.object({
  actionId: z.string().min(1).optional(),
  action: z.string().min(1),
  softwareAgent: z.string().min(1).optional(),
  when: z.string().min(1).optional(),
})
), (real) => { ContentCredentialActionSchema = real; });

export let ContentCredentialAssertionSchema = lazySchema(() => (
z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  path: z.string().min(1).optional(),
  hash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
})
), (real) => { ContentCredentialAssertionSchema = real; });

export let ContentCredentialsMetadataSchema = lazySchema(() => (
z.object({
  kind: z.literal("provenance.content-credentials"),
  credentialId: z.string().min(1),
  targetAssetId: z.string().min(1),
  targetPath: z.string().min(1).optional(),
  targetHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  mode: ContentCredentialModeSchema,
  signatureStatus: ContentCredentialSignatureStatusSchema,
  c2paManifestPath: z.string().min(1).optional(),
  c2paManifestHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  issuer: z.string().min(1).optional(),
  ingredients: z.array(ContentCredentialIngredientSchema).default([]),
  actions: z.array(ContentCredentialActionSchema).default([]),
  assertions: z.array(ContentCredentialAssertionSchema).default([]),
  decisionLog: z.array(z.string().min(1)).default([]),
})
), (real) => { ContentCredentialsMetadataSchema = real; });

let ProductionMetadataBaseSchema = lazySchema(() => (
z.discriminatedUnion("kind", [
  AudioBeatMetadataSchema,
  AudioStemSeparationMetadataSchema,
  LyricsAlignmentMetadataSchema,
  TalkingHeadMetadataSchema,
  ReferenceVideoMetadataSchema,
  ReferenceDownloadMetadataBaseSchema,
  VideoVisualMomentMetadataSchema,
  ImageStoryboardMetadataSchema,
  SemanticReferenceRolesMetadataSchema,
  ProductLogoQaMetadataSchema,
  AnalysisBackendBenchmarkMetadataSchema,
  ImageEmbeddingStoreMetadataSchema,
  ImageComfyuiRunnerMetadataSchema,
  AdDeliveryMetadataSchema,
  AdVisualQaMetadataSchema,
  ContentCredentialsMetadataSchema,
])
), (real) => { ProductionMetadataBaseSchema = real; });

export let ProductionMetadataSchema =
  lazySchema(() => (
ProductionMetadataBaseSchema.superRefine((metadata, context) => {
    if (
      metadata.kind === "reference.download" &&
      !hasReferenceDownloadFinalExportRights(metadata)
    ) {
      context.addIssue({
        code: "custom",
        message: "final export requires derivative and redistribution rights",
        path: ["finalExportAllowed"],
      });
    }
  })
), (real) => { ProductionMetadataSchema = real; });

export let AssetMetadataFillActionSchema = lazySchema(() => (
z
  .object({
    actionId: z.string().min(1),
    target: MetadataAttachmentTargetSchema,
    metadataKind: z.string().min(1),
    metadata: ProductionMetadataSchema,
    producer: z.string().min(1),
    createdAt: z.string().optional(),
  })
  .strict()
), (real) => { AssetMetadataFillActionSchema = real; });

export type AudioBeatMetadata = z.infer<typeof AudioBeatMetadataSchema>;
export type AudioStemType = z.infer<typeof AudioStemTypeSchema>;
export type AudioStemAsset = z.infer<typeof AudioStemAssetSchema>;
export type AudioStemSeparationMetadata = z.infer<
  typeof AudioStemSeparationMetadataSchema
>;
export type LyricsAlignmentMetadata = z.infer<
  typeof LyricsAlignmentMetadataSchema
>;
export type AsrTimedWord = z.infer<typeof AsrTimedWordSchema>;
export type AsrTimedSegment = z.infer<typeof AsrTimedSegmentSchema>;
export type AsrTimedTranscript = z.infer<typeof AsrTimedTranscriptSchema>;
export type AsrTranscriptMetadata = z.infer<typeof AsrTranscriptMetadataSchema>;
export type TalkingHeadMetadata = z.infer<typeof TalkingHeadMetadataSchema>;

export function projectAsrTimedTranscriptWords(
  input: AsrTimedTranscript,
  fps: number,
): z.infer<typeof TranscriptWordSchema>[] {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error("fps must be a positive number");
  }
  const transcript = AsrTimedTranscriptSchema.parse(input);
  return transcript.words.map((word) =>
    TranscriptWordSchema.parse({
      id: word.id,
      text: word.text,
      startFrame: Math.floor((word.startMs / 1000) * fps),
      endFrame: Math.max(
        Math.floor((word.startMs / 1000) * fps) + 1,
        Math.ceil((word.endMs / 1000) * fps),
      ),
      ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
      ...(word.speakerId === undefined ? {} : { speakerId: word.speakerId }),
    }),
  );
}
export type ReferenceVideoMetadata = z.infer<
  typeof ReferenceVideoMetadataSchema
>;
export type ReferenceDownloadSourceLedger = z.infer<
  typeof ReferenceDownloadSourceLedgerSchema
>;
export type ReferenceDownloadFile = z.infer<typeof ReferenceDownloadFileSchema>;
export type ReferenceDownloadMetadata = z.infer<
  typeof ReferenceDownloadMetadataSchema
>;
export type VideoVisualMomentMetadata = z.infer<
  typeof VideoVisualMomentMetadataSchema
>;
export type CharacterReferenceViewKind = z.infer<
  typeof CharacterReferenceViewKindSchema
>;
export type CharacterReferenceView = z.infer<
  typeof CharacterReferenceViewSchema
>;
export type ImageStoryboardMetadata = z.infer<
  typeof ImageStoryboardMetadataSchema
>;
export type SemanticReferenceRole = z.infer<typeof SemanticReferenceRoleSchema>;
export type SemanticReferenceRolesMetadata = z.infer<
  typeof SemanticReferenceRolesMetadataSchema
>;
export type ProductLogoQaReference = z.infer<
  typeof ProductLogoQaReferenceSchema
>;
export type ProductLogoQaCheck = z.infer<typeof ProductLogoQaCheckSchema>;
export type ProductLogoQaMetadata = z.infer<typeof ProductLogoQaMetadataSchema>;
export type AnalysisBackendBenchmarkMetric = z.infer<
  typeof AnalysisBackendBenchmarkMetricSchema
>;
export type AnalysisBackendBenchmarkCandidate = z.infer<
  typeof AnalysisBackendBenchmarkCandidateSchema
>;
export type AnalysisBackendBenchmarkMetadata = z.infer<
  typeof AnalysisBackendBenchmarkMetadataSchema
>;
export type ImageEmbeddingDistanceMetric = z.infer<
  typeof ImageEmbeddingDistanceMetricSchema
>;
export type ImageEmbeddingBaselineFor = z.infer<
  typeof ImageEmbeddingBaselineForSchema
>;
export type ImageEmbeddingStoreItem = z.infer<
  typeof ImageEmbeddingStoreItemSchema
>;
export type ImageEmbeddingStoreMetadata = z.infer<
  typeof ImageEmbeddingStoreMetadataSchema
>;
export type ImageComfyuiApiFormat = z.infer<typeof ImageComfyuiApiFormatSchema>;
export type ImageComfyuiModelType = z.infer<typeof ImageComfyuiModelTypeSchema>;
export type ImageComfyuiModelReference = z.infer<
  typeof ImageComfyuiModelReferenceSchema
>;
export type ImageComfyuiCustomNode = z.infer<
  typeof ImageComfyuiCustomNodeSchema
>;
export type ImageComfyuiInputKind = z.infer<typeof ImageComfyuiInputKindSchema>;
export type ImageComfyuiInputSlot = z.infer<typeof ImageComfyuiInputSlotSchema>;
export type ImageComfyuiOutput = z.infer<typeof ImageComfyuiOutputSchema>;
export type ImageComfyuiRunnerMetadata = z.infer<
  typeof ImageComfyuiRunnerMetadataSchema
>;
export type StoryboardPromptPack = z.infer<typeof StoryboardPromptPackSchema>;
export type AdDeliveryMetadata = z.infer<typeof AdDeliveryMetadataSchema>;
export type AdDeliverySpecProjection = z.infer<
  typeof AdDeliverySpecProjectionSchema
>;
export type AdDeliveryExportProbe = z.infer<typeof AdDeliveryExportProbeSchema>;
export type AdDeliveryVisualQaReport = z.infer<
  typeof AdDeliveryVisualQaReportSchema
>;
export type AdDeliveryExportValidationReceipt = z.infer<
  typeof AdDeliveryExportValidationReceiptSchema
>;
export type AdVisualQaCheckKind = z.infer<typeof AdVisualQaCheckKindSchema>;
export type AdVisualQaCheck = z.infer<typeof AdVisualQaCheckSchema>;
export type AdVisualQaMetadata = z.infer<typeof AdVisualQaMetadataSchema>;
export type ContentCredentialMode = z.infer<typeof ContentCredentialModeSchema>;
export type ContentCredentialSignatureStatus = z.infer<
  typeof ContentCredentialSignatureStatusSchema
>;
export type ContentCredentialIngredientRelationship = z.infer<
  typeof ContentCredentialIngredientRelationshipSchema
>;
export type ContentCredentialIngredient = z.infer<
  typeof ContentCredentialIngredientSchema
>;
export type ContentCredentialAction = z.infer<
  typeof ContentCredentialActionSchema
>;
export type ContentCredentialAssertion = z.infer<
  typeof ContentCredentialAssertionSchema
>;
export type ContentCredentialsMetadata = z.infer<
  typeof ContentCredentialsMetadataSchema
>;
export type ProductionMetadata = z.infer<typeof ProductionMetadataSchema>;
export type AssetMetadataFillAction = z.infer<
  typeof AssetMetadataFillActionSchema
>;

export type ProductionAsset = {
  id: string;
  type: "video" | "audio" | "image" | "text" | "reference" | string;
  metadata?: Record<string, unknown>;
};

/** The generic fill trunk only needs the envelope, never a specific kind's shape. */
export type AssetMetadataFillEnvelope = {
  actionId: string;
  target: MetadataAttachmentTarget;
  metadataKind: string;
  metadata: { kind: string };
  producer: string;
  createdAt?: string;
};

export function applyAssetMetadataFill<TAsset extends ProductionAsset>(
  asset: TAsset,
  action: AssetMetadataFillEnvelope,
): TAsset & { metadata: Record<string, unknown> } {
  if (action.target.kind !== "project-asset") {
    throw new Error(
      `metadata fill target ${action.target.kind} cannot be applied to a Project Asset manifest`,
    );
  }
  if (asset.id !== action.target.assetId) {
    throw new Error(
      `metadata fill target mismatch: ${action.target.assetId} does not match ${asset.id}`,
    );
  }
  if (action.metadata.kind !== action.metadataKind) {
    throw new Error(
      `metadata kind mismatch: ${action.metadataKind} does not match ${action.metadata.kind}`,
    );
  }
  const fills = Array.isArray(asset.metadata?.metadataFills)
    ? asset.metadata.metadataFills
    : [];
  return {
    ...asset,
    metadata: {
      ...(asset.metadata ?? {}),
      [action.metadataKind]: action.metadata,
      metadataFills: [
        ...fills,
        {
          actionId: action.actionId,
          metadataKind: action.metadataKind,
          producer: action.producer,
          createdAt: action.createdAt,
        },
      ],
    },
  };
}

export function buildBeatEditHints(metadata: AudioBeatMetadata): Array<{
  frame: number;
  reason: "downbeat" | "beat";
  strength: number;
}> {
  return metadata.beats.map((beat) => ({
    frame: beat.frame,
    reason: beat.downbeat ? "downbeat" : "beat",
    strength: beat.confidence,
  }));
}

export function buildBeatSectionCutPlan(metadata: AudioBeatMetadata): Array<{
  id: string;
  sectionId: string;
  label: string;
  sourceStartFrame: number;
  sourceEndFrame: number;
  outputStartFrame: number;
  outputEndFrame: number;
  anchorFrames: number[];
  energy?: number;
  novelty?: number;
  impact?: number;
  semanticLabel?:
    | "intro"
    | "verse"
    | "pre-chorus"
    | "chorus"
    | "bridge"
    | "drop"
    | "buildup"
    | "breakdown"
    | "outro"
    | "instrumental"
    | "detected-beats"
    | "unknown";
  semanticConfidence?: number;
  reviewRequired?: boolean;
  semanticSource?: string;
  cutDensity?: "hold" | "medium" | "fast";
  recommendedCutEveryFrames?: number;
}> {
  let outputCursor = 0;
  return metadata.sections.map((section) => {
    const duration = Math.max(0, section.endFrame - section.startFrame);
    const cut = {
      id: `section-${section.id}`,
      sectionId: section.id,
      label: section.label,
      sourceStartFrame: section.startFrame,
      sourceEndFrame: section.endFrame,
      outputStartFrame: outputCursor,
      outputEndFrame: outputCursor + duration,
      anchorFrames: metadata.beats
        .filter(
          (beat) =>
            beat.downbeat === true &&
            beat.frame >= section.startFrame &&
            beat.frame < section.endFrame,
        )
        .map((beat) => beat.frame),
      ...(section.energy === undefined ? {} : { energy: section.energy }),
      ...(section.novelty === undefined ? {} : { novelty: section.novelty }),
      ...(section.impact === undefined ? {} : { impact: section.impact }),
      ...(section.semanticLabel === undefined
        ? {}
        : { semanticLabel: section.semanticLabel }),
      ...(section.semanticConfidence === undefined
        ? {}
        : { semanticConfidence: section.semanticConfidence }),
      ...(section.reviewRequired === undefined
        ? {}
        : { reviewRequired: section.reviewRequired }),
      ...(section.semanticSource === undefined
        ? {}
        : { semanticSource: section.semanticSource }),
      ...(section.cutDensity === undefined
        ? {}
        : {
            cutDensity: section.cutDensity,
            recommendedCutEveryFrames: recommendedCutEveryFrames(
              section.cutDensity,
              metadata.fps,
              duration,
            ),
          }),
    };
    outputCursor += duration;
    return cut;
  });
}

export function buildProductLogoQaVerdict(checks: ProductLogoQaCheck[]): {
  verdict: "pass" | "requires-review" | "fail";
  blockedReasons: string[];
} {
  const requiredChecks = checks.filter((check) => check.required);
  const failed = requiredChecks.filter((check) => check.status === "fail");
  if (failed.length > 0) {
    return {
      verdict: "fail",
      blockedReasons: failed.map(
        (check) => `${check.check} failed for role ${check.roleId}`,
      ),
    };
  }
  const review = requiredChecks.filter(
    (check) => check.status === "requires-review",
  );
  if (review.length > 0) {
    return {
      verdict: "requires-review",
      blockedReasons: review.map(
        (check) => `${check.check} requires review for role ${check.roleId}`,
      ),
    };
  }
  return { verdict: "pass", blockedReasons: [] };
}

export function buildAnalysisBackendBenchmarkVerdict(
  candidates: AnalysisBackendBenchmarkCandidate[],
): {
  verdict: "pass" | "fail";
  selectedBackendId?: string;
  blockedReasons: string[];
} {
  const passing = candidates
    .filter((candidate) => candidate.status === "pass")
    .sort(
      (a, b) =>
        b.weightedScore - a.weightedScore ||
        a.backendId.localeCompare(b.backendId),
    );
  if (passing.length > 0) {
    return {
      verdict: "pass",
      selectedBackendId: passing[0].backendId,
      blockedReasons: [],
    };
  }
  return {
    verdict: "fail",
    blockedReasons: candidates.map(
      (candidate) =>
        `${candidate.backendId} failed ${candidate.capability} benchmark`,
    ),
  };
}

function recommendedCutEveryFrames(
  density: "hold" | "medium" | "fast",
  fps: number,
  durationInFrames: number,
): number {
  if (density === "fast") return Math.max(1, Math.round(fps));
  if (density === "medium") return Math.max(1, Math.round(fps * 2));
  return Math.max(1, durationInFrames);
}

export function buildCaptionItemFromTalkingHeadMetadata(
  id: string,
  metadata: TalkingHeadMetadata,
  from: number,
) {
  const wordById = new Map(metadata.words.map((word) => [word.id, word]));
  const cues = metadata.captionCues.map((cue) => {
    const cueWords = (cue.wordIds ?? [])
      .map((wordId) => wordById.get(wordId))
      .filter((word): word is NonNullable<typeof word> => Boolean(word));
    const sourceStartFrame =
      cue.sourceStartFrame ??
      (cueWords.length > 0
        ? Math.min(...cueWords.map((word) => word.startFrame))
        : undefined);
    const sourceEndFrame =
      cue.sourceEndFrame ??
      (cueWords.length > 0
        ? Math.max(...cueWords.map((word) => word.endFrame))
        : undefined);
    return {
      ...cue,
      ...(sourceStartFrame === undefined ? {} : { sourceStartFrame }),
      ...(sourceEndFrame === undefined ? {} : { sourceEndFrame }),
    };
  });
  const durationInFrames = cues.reduce(
    (end, cue) => Math.max(end, cue.startFrame + cue.durationInFrames),
    0,
  );
  return {
    id,
    type: "text" as const,
    text: cues.map((cue) => cue.text).join("\n"),
    color: "#ffffff",
    from,
    durationInFrames,
    cues,
    wordRefs: metadata.words.map((word) => ({
      id: word.id,
      text: word.text,
      sourceStartFrame: word.startFrame,
      sourceEndFrame: word.endFrame,
    })),
    sourceToOutputMap: metadata.cuts
      .filter((cut) => cut.action === "keep")
      .map((cut) => ({
        sourceStartFrame: cut.sourceStartFrame,
        sourceEndFrame: cut.sourceEndFrame,
        outputStartFrame: cut.outputStartFrame,
        outputEndFrame: cut.outputEndFrame,
      })),
  };
}

export function buildCaptionItemFromLyricsAlignmentMetadata(
  id: string,
  metadata: LyricsAlignmentMetadata,
  from: number,
) {
  const units = metadata.units.map((unit) => {
    const startFrame = unit.startFrame ?? msToFrame(unit.startMs, metadata.fps);
    const endFrame = unit.endFrame ?? msToFrame(unit.endMs, metadata.fps);
    return {
      ...unit,
      startFrame,
      endFrame: Math.max(startFrame + 1, endFrame),
    };
  });
  const cues = units.map((unit) => ({
    id: unit.lineId,
    startFrame: unit.startFrame,
    durationInFrames: Math.max(1, unit.endFrame - unit.startFrame),
    text: unit.text,
    wordIds: [unit.lineId],
    sourceStartFrame: unit.startFrame,
    sourceEndFrame: unit.endFrame,
  }));
  const durationInFrames = cues.reduce(
    (end, cue) => Math.max(end, cue.startFrame + cue.durationInFrames),
    0,
  );
  return {
    id,
    type: "text" as const,
    text: cues.map((cue) => cue.text).join("\n"),
    color: "#ffffff",
    from,
    durationInFrames,
    cues,
    wordRefs: units.map((unit) => ({
      id: unit.lineId,
      text: unit.text,
      sourceStartFrame: unit.startFrame,
      sourceEndFrame: unit.endFrame,
    })),
    sourceToOutputMap: units.map((unit) => ({
      sourceStartFrame: unit.startFrame,
      sourceEndFrame: unit.endFrame,
      outputStartFrame: unit.startFrame,
      outputEndFrame: unit.endFrame,
    })),
  };
}

export function buildStoryboardPromptPackFromMetadata(
  storyboardAssetId: string,
  metadata: ImageStoryboardMetadata,
  options?: {
    stylePrompt?: string;
    negativePrompt?: string;
    modelHint?: string;
  },
): StoryboardPromptPack {
  const sceneById = new Map(metadata.scenes.map((scene) => [scene.id, scene]));
  const characterNameById = new Map(
    metadata.characters.map((character) => [character.id, character.name]),
  );
  const promptPack = {
    schemaVersion: 1 as const,
    kind: "clash.storyboard.prompt-pack" as const,
    storyboardAssetId,
    prompts: metadata.panels.map((panel) => {
      const scene = sceneById.get(panel.sceneId);
      const characterNames = panel.characterIds
        .map((characterId) => characterNameById.get(characterId) ?? characterId)
        .filter(Boolean);
      const promptParts = [
        scene?.prompt ?? `storyboard panel ${panel.id}`,
        ...(characterNames.length > 0
          ? [`characters: ${characterNames.join(", ")}`]
          : []),
        ...(options?.stylePrompt ? [`style: ${options.stylePrompt}`] : []),
      ];
      return {
        id: `prompt-${safeSlug(panel.id)}`,
        panelId: panel.id,
        sceneId: panel.sceneId,
        characterIds: panel.characterIds,
        prompt: promptParts.join("; "),
        ...(options?.negativePrompt
          ? { negativePrompt: options.negativePrompt }
          : {}),
        outputAssetId: panel.assetId,
        outputPath:
          panel.path ??
          `assets/generated/storyboards/${safeSlug(panel.id)}.png`,
        ...(options?.modelHint ? { modelHint: options.modelHint } : {}),
      };
    }),
  };
  return StoryboardPromptPackSchema.parse(promptPack);
}

export function buildVisualMomentClipLibrary(
  metadata: VideoVisualMomentMetadata,
): Array<{
  id: string;
  assetId: string;
  type: "video";
  path?: string;
  sourceStartFrame: number;
  sourceEndFrame: number;
  peakFrame: number;
  score: number;
  sceneIndex: number;
  semantic?: string;
  tags: string[];
}> {
  return metadata.candidates
    .map((candidate) => {
      const startFrame =
        candidate.startFrame ?? msToFrame(candidate.startMs, metadata.fps);
      const endFrame = Math.max(
        startFrame + 1,
        candidate.endFrame ?? msToFrame(candidate.endMs, metadata.fps),
      );
      const peakFrame = Math.min(
        endFrame,
        Math.max(
          startFrame,
          candidate.peakFrame ?? msToFrame(candidate.peakMs, metadata.fps),
        ),
      );
      return {
        id: candidate.id,
        assetId: metadata.sourceVideoAssetId,
        type: "video" as const,
        ...(metadata.sourcePath ? { path: metadata.sourcePath } : {}),
        sourceStartFrame: startFrame,
        sourceEndFrame: endFrame,
        peakFrame,
        score: visualMomentScore(candidate),
        sceneIndex: candidate.sceneIndex,
        ...(candidate.semantic ? { semantic: candidate.semantic } : {}),
        tags: candidate.tags,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.sourceStartFrame - b.sourceStartFrame ||
        a.id.localeCompare(b.id),
    );
}

export function assertReferenceCanBeRemixed(
  metadata: ReferenceVideoMetadata,
): void {
  if (!metadata.rights.derivativeAllowed) {
    throw new Error(
      `reference ${metadata.sourceUrl} derivative use is not allowed`,
    );
  }
  if (!metadata.rights.redistributionAllowed) {
    throw new Error(
      `reference ${metadata.sourceUrl} redistribution is not allowed`,
    );
  }
}

export function buildReferenceRightsLedger(
  assetId: string,
  metadata: ReferenceVideoMetadata,
): {
  assetId: string;
  sourceUrl: string;
  rights: ReferenceVideoMetadata["rights"];
  remixAllowed: boolean;
  blockedReasons: string[];
  allowedUses: string[];
  prohibitedUses: string[];
  shots: ReferenceVideoMetadata["shots"];
  nonCopyingQa: ReferenceVideoMetadata["nonCopyingQa"];
} {
  const blockedReasons = [
    ...(metadata.rights.derivativeAllowed
      ? []
      : ["derivative use is not allowed"]),
    ...(metadata.rights.redistributionAllowed
      ? []
      : ["redistribution is not allowed"]),
  ];
  const remixAllowed = blockedReasons.length === 0;
  return {
    assetId,
    sourceUrl: metadata.sourceUrl,
    rights: metadata.rights,
    remixAllowed,
    blockedReasons,
    allowedUses: remixAllowed
      ? [
          "metadata-analysis",
          "shot-analysis",
          "non-copying-reference",
          "transformative-remix",
        ]
      : ["metadata-analysis", "shot-analysis", "non-copying-reference"],
    prohibitedUses: remixAllowed
      ? []
      : ["download-source", "copy-frames", "export-derivative"],
    shots: metadata.shots,
    nonCopyingQa: metadata.nonCopyingQa,
  };
}

export function buildAdDeliveryChecklist(metadata: AdDeliveryMetadata): Array<{
  id: string;
  label: string;
  required: boolean;
}> {
  const variantChecks = metadata.variants.flatMap((variant) => {
    const safeZones = variant.safeZones;
    return [
      {
        id: `duration:${variant.id}`,
        label: `${variant.platform} duration ${formatSeconds(variant.durationSeconds)}s`,
        required: true,
      },
      {
        id: `safe-zone:${variant.id}`,
        label:
          `${variant.platform} safe zones top/right/bottom/left ` +
          `${safeZones.top}/${safeZones.right}/${safeZones.bottom}/${safeZones.left}`,
        required: true,
      },
      {
        id: `subtitles:${variant.id}`,
        label: `${variant.platform} subtitles ${variant.subtitlesRequired ? "required" : "optional"}`,
        required: variant.subtitlesRequired,
      },
    ];
  });
  return [
    ...variantChecks,
    {
      id: "packshot",
      label: `packshot asset ${metadata.packshot.assetId} frames ${metadata.packshot.startFrame}-${metadata.packshot.endFrame}`,
      required: metadata.packshot.required,
    },
    {
      id: "end-card",
      label: `end card ${metadata.endCard.durationFrames} frames with CTA ${metadata.endCard.cta}`,
      required: metadata.endCard.required,
    },
    {
      id: "disclaimer",
      label: metadata.endCard.disclaimer
        ? "disclaimer text present"
        : "disclaimer text missing",
      required: Boolean(metadata.endCard.disclaimer),
    },
    ...(metadata.rightsLedgerAssetId
      ? [
          {
            id: "rights-ledger",
            label: `rights ledger linked to ${metadata.rightsLedgerAssetId}`,
            required: true,
          },
        ]
      : []),
  ];
}

export function buildAdDeliveryExportValidationReceipt(options: {
  deliverySpec: AdDeliverySpecProjection;
  variantId: string;
  renderedPath: string;
  probe: AdDeliveryExportProbe;
  visualQa?: AdDeliveryVisualQaReport;
  durationToleranceSeconds?: number;
  fpsTolerance?: number;
}): AdDeliveryExportValidationReceipt {
  const deliverySpec = AdDeliverySpecProjectionSchema.parse(
    options.deliverySpec,
  );
  const probe = AdDeliveryExportProbeSchema.parse(options.probe);
  const visualQa = options.visualQa
    ? AdDeliveryVisualQaReportSchema.parse(options.visualQa)
    : undefined;
  const durationToleranceSeconds = options.durationToleranceSeconds ?? 0.25;
  const fpsTolerance = options.fpsTolerance ?? 0.01;
  const variant = deliverySpec.variants.find(
    (candidate) => candidate.id === options.variantId,
  );
  if (!variant) {
    throw new Error(`delivery variant ${options.variantId} not found`);
  }

  const checks = [
    passCheck("variant", `variant ${options.variantId}`, variant.id),
    booleanCheck(
      "video-track",
      probe.hasVideo,
      "video track present",
      probe.hasVideo ? "present" : "missing",
    ),
    booleanCheck(
      "audio-track",
      probe.hasAudio,
      "audio track present",
      probe.hasAudio ? "present" : "missing",
    ),
    booleanCheck(
      "resolution",
      probe.width === variant.width && probe.height === variant.height,
      `${variant.width}x${variant.height}`,
      `${probe.width}x${probe.height}`,
    ),
    booleanCheck(
      "aspect-ratio",
      normalizedAspectRatio(probe.width, probe.height) === variant.aspectRatio,
      variant.aspectRatio,
      normalizedAspectRatio(probe.width, probe.height),
    ),
    booleanCheck(
      "fps",
      Math.abs(probe.fps - deliverySpec.fps) <= fpsTolerance,
      `${deliverySpec.fps}fps +/- ${fpsTolerance}`,
      `${formatSeconds(probe.fps)}fps`,
    ),
    booleanCheck(
      "duration",
      Math.abs(probe.durationSeconds - variant.durationSeconds) <=
        durationToleranceSeconds,
      `${formatSeconds(variant.durationSeconds)}s +/- ${durationToleranceSeconds}s`,
      `${formatSeconds(probe.durationSeconds)}s`,
    ),
    booleanCheck(
      "safe-zone",
      visualQa?.safeZoneViolations.length === 0,
      "no safe-zone violations",
      visualQa
        ? `${visualQa.safeZoneViolations.length} violation(s)`
        : "missing visual QA report",
    ),
    booleanCheck(
      "subtitles",
      !variant.subtitlesRequired || visualQa?.captionsPresent === true,
      variant.subtitlesRequired ? "captions present" : "captions optional",
      visualQa
        ? visualQa.captionsPresent
          ? "present"
          : "missing"
        : "missing visual QA report",
      variant.subtitlesRequired,
    ),
    booleanCheck(
      "packshot",
      !deliverySpec.packshot.required || visualQa?.packshotVisible === true,
      deliverySpec.packshot.required
        ? `packshot ${deliverySpec.packshot.assetId} visible`
        : "packshot optional",
      visualQa
        ? visualQa.packshotVisible
          ? "visible"
          : "missing"
        : "missing visual QA report",
      deliverySpec.packshot.required,
    ),
    booleanCheck(
      "end-card",
      !deliverySpec.endCard.required || visualQa?.endCardVisible === true,
      deliverySpec.endCard.required
        ? `end card with CTA ${deliverySpec.endCard.cta}`
        : "end card optional",
      visualQa
        ? visualQa.endCardVisible
          ? "visible"
          : "missing"
        : "missing visual QA report",
      deliverySpec.endCard.required,
    ),
    booleanCheck(
      "disclaimer",
      !deliverySpec.endCard.disclaimer || visualQa?.disclaimerVisible === true,
      deliverySpec.endCard.disclaimer
        ? `disclaimer ${deliverySpec.endCard.disclaimer}`
        : "disclaimer optional",
      visualQa
        ? visualQa.disclaimerVisible
          ? "visible"
          : "missing"
        : "missing visual QA report",
      Boolean(deliverySpec.endCard.disclaimer),
    ),
    ...(deliverySpec.rightsLedgerAssetId
      ? [
          booleanCheck(
            "rights-ledger",
            true,
            `rights ledger ${deliverySpec.rightsLedgerAssetId}`,
            deliverySpec.rightsLedgerAssetId,
          ),
        ]
      : []),
  ];
  const receipt = {
    schemaVersion: 1 as const,
    kind: "clash.ad.delivery-export-validation" as const,
    targetAssetId: deliverySpec.targetAssetId,
    brand: deliverySpec.brand,
    variant,
    renderedPath: options.renderedPath,
    probe,
    ...(visualQa ? { visualQa } : {}),
    checks,
    verdict: checks.some((check) => check.required && check.status === "fail")
      ? ("fail" as const)
      : ("pass" as const),
  };
  return AdDeliveryExportValidationReceiptSchema.parse(receipt);
}

function formatSeconds(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(value).replace(/0+$/, "").replace(/\.$/, "");
}

function passCheck(
  id: string,
  expected: string,
  actual: string,
): z.infer<typeof AdDeliveryExportValidationCheckSchema> {
  return {
    id,
    status: "pass",
    required: true,
    severity: "error",
    expected,
    actual,
  };
}

function booleanCheck(
  id: string,
  passed: boolean,
  expected: string,
  actual: string,
  required = true,
): z.infer<typeof AdDeliveryExportValidationCheckSchema> {
  return {
    id,
    status: passed ? "pass" : "fail",
    required,
    severity: "error",
    expected,
    actual,
  };
}

function normalizedAspectRatio(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "item";
}

function visualMomentScore(
  candidate: z.infer<typeof VisualMomentCandidateSchema>,
): number {
  const score =
    candidate.quality * 0.45 +
    candidate.motion * 0.25 +
    (candidate.action ?? 0) * 0.2 +
    (candidate.emotion ?? 0) * 0.1;
  return Math.round(score * 1000) / 1000;
}
