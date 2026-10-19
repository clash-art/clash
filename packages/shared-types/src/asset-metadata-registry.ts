import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

import { AsrTimedTranscriptSchema } from "./production-metadata.js";
import {
  MetadataAttachmentTargetSchema,
  type MetadataAttachmentTarget,
} from "./metadata-attachments.js";

export {
  ActionRevisionMetadataTargetSchema,
  MetadataAttachmentTargetSchema,
  ProjectAssetMetadataTargetSchema,
  metadataAttachmentTargetKey,
} from "./metadata-attachments.js";

/**
 * Transcription is canonical only as the identity of one word grid: which media
 * it came from, which backend produced it, and which grid downstream cuts and
 * caption cues are aligned to. The words themselves are a projection -- they can
 * always be rematerialized -- but `contentHash` has to pin the grid, because a
 * re-run renumbers every wordId that downstream artifacts reference.
 */
export let MediaTranscriptMetadataSchema = lazySchema(() => (
z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("media.transcript"),
  backendId: z.string().min(1),
  modelId: z.string().min(1),
  language: z.string().min(1).optional(),
  /** The media this grid was transcribed from. */
  sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  /**
   * The word grid itself. Downstream wordIds only mean anything against this,
   * and it survives a reflow of `text` or `segments` unchanged.
   */
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  /**
   * Where the full body is stored. Distinct from `contentHash` on purpose: this
   * addresses the whole document, so restating the same grid moves it.
   */
  bodyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  summary: z.object({
    wordCount: z.number().int().nonnegative(),
    durationMs: z.number().int().min(0),
    segmentCount: z.number().int().nonnegative().optional(),
    averageConfidence: z.number().min(0).max(1).optional(),
  }),
})
), (real) => { MediaTranscriptMetadataSchema = real; });

export type MediaTranscriptMetadata = z.infer<
  typeof MediaTranscriptMetadataSchema
>;

/**
 * What produced a rendered frame, and from which revision of it.
 *
 * A generated asset carries its provenance as canvas edges to the nodes it referenced. A frame
 * rendered off an entity has no such edge -- it is written as a file -- so without this the only
 * record of its origin is the directory it landed in, and re-rendering after an edit leaves two
 * images that cannot be told apart. The renderer already knows every fact here; they were simply
 * never attached to the asset.
 */
export let MediaRenderLineageMetadataSchema = lazySchema(() => (
z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("media.render-lineage"),
  /** The entity rendered, e.g. a Director Stage or a Timeline. */
  sourceEntityKind: z.string().min(1),
  sourceEntityId: z.string().min(1),
  /** The exact revision rendered, so a later edit cannot be mistaken for this one. */
  sourceRevisionId: z.string().min(1),
  /** Where in the entity's own time this frame was taken, when it has time. */
  timeSeconds: z.number().nonnegative().optional(),
  /** Which renderer produced it. */
  renderer: z.string().min(1).optional(),
  /** The media file this describes. */
  sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
})
), (real) => { MediaRenderLineageMetadataSchema = real; });

export type MediaRenderLineageMetadata = z.infer<
  typeof MediaRenderLineageMetadataSchema
>;

/**
 * A short producer-attributed description of what the media shows or says.
 * Small enough to live inline as its own identity: no body, no blob.
 */
export let MediaDescriptionMetadataSchema = lazySchema(() => (
z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("media.description"),
  text: z.string().min(1),
  language: z.string().min(1).optional(),
  /** Which model or person wrote it. */
  producerModelId: z.string().min(1).optional(),
  /** The media file this describes. */
  sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
})
), (real) => { MediaDescriptionMetadataSchema = real; });

export type MediaDescriptionMetadata = z.infer<
  typeof MediaDescriptionMetadataSchema
>;

type TranscriptBody = z.infer<typeof AsrTimedTranscriptSchema>;

/**
 * Only `words` feeds the content hash. The whole-transcript `text` and every
 * `segments[].text` are derivable restatements of the same words, so hashing
 * them would make a cosmetic reflow look like a different transcript.
 */
export function transcriptContentHashInput(
  body: Pick<TranscriptBody, "words">,
): string {
  return JSON.stringify(
    body.words.map((word) => [word.id, word.text, word.startMs, word.endMs]),
  );
}

export function summarizeTranscript(
  body: TranscriptBody,
): MediaTranscriptMetadata["summary"] {
  const confidences = body.words.flatMap((word) =>
    typeof word.confidence === "number" ? [word.confidence] : [],
  );
  return {
    wordCount: body.words.length,
    durationMs: body.durationMs,
    segmentCount: body.segments.length,
    ...(confidences.length > 0
      ? {
          averageConfidence:
            confidences.reduce((total, value) => total + value, 0) /
            confidences.length,
        }
      : {}),
  };
}

export type DeclaredAssetMetadataKind = {
  kind: string;
  /**
   * Structurally typed rather than pinned to one zod instance: declarers may
   * hold a different zod major, or no zod at all, and still register.
   */
  schema: AssetMetadataSchemaLike;
};

export type AssetMetadataSchemaIssue = {
  path: ReadonlyArray<PropertyKey>;
  message?: string;
};

export type AssetMetadataSchemaLike = {
  parse(value: unknown): unknown;
  safeParse(
    value: unknown,
  ):
    | { success: true; data?: unknown }
    | {
        success: false;
        error: { issues: ReadonlyArray<AssetMetadataSchemaIssue> };
      };
};

/**
 * The sixteen workflow kinds that used to ship in a closed union are gone from
 * the product surface. Reading their old manifests still works (a cas-projection
 * stub is just JSON), but nothing accepts new writes for an undeclared kind.
 */
const declaredKinds = new Map<string, DeclaredAssetMetadataKind>();

// The built-in kinds are registered on first access rather than at module evaluation: registering
// one safely parses probe values through its schema, which would construct the metadata schemas on
// every Host start even though no request had asked for them yet.
let builtInKindsRegistered = false;

function ensureBuiltInAssetMetadataKinds(): void {
  if (builtInKindsRegistered) return;
  builtInKindsRegistered = true;
  registerAssetMetadataKind({
    kind: "media.transcript",
    schema: MediaTranscriptMetadataSchema,
  });
  registerAssetMetadataKind({
    kind: "media.description",
    schema: MediaDescriptionMetadataSchema,
  });
  registerAssetMetadataKind({
    kind: "media.render-lineage",
    schema: MediaRenderLineageMetadataSchema,
  });
}

/**
 * Declare a metadata kind as data. A declared kind needs no switch branch and
 * no CLI verb: the generic apply path validates it, writes it, and versions it
 * for CAS exactly like every other kind.
 *
 * Newly declared kinds must carry `schemaVersion`. The sixteen built-ins predate
 * this rule and stay grandfathered, but an open registry only survives if
 * everything added to it can be migrated later.
 */
export function registerAssetMetadataKind(
  declaration: DeclaredAssetMetadataKind,
): void {
  ensureBuiltInAssetMetadataKinds();
  const issuesFor = (
    probe: unknown,
  ): ReadonlyArray<AssetMetadataSchemaIssue> => {
    const result = declaration.schema.safeParse(probe);
    return result.success ? [] : result.error.issues;
  };
  const complainsAbout = (
    issues: ReadonlyArray<AssetMetadataSchemaIssue>,
    field: string,
  ): boolean =>
    issues.some((issue) => issue.path.length === 1 && issue.path[0] === field);

  if (
    complainsAbout(
      issuesFor({ schemaVersion: 1, kind: declaration.kind }),
      "kind",
    )
  ) {
    throw new Error(
      `Asset metadata kind ${declaration.kind} must declare a schema that pins its own kind`,
    );
  }
  if (!complainsAbout(issuesFor({ kind: declaration.kind }), "schemaVersion")) {
    throw new Error(
      `Asset metadata kind ${declaration.kind} must declare a schemaVersion`,
    );
  }
  declaredKinds.set(declaration.kind, declaration);
}

export function listDeclaredAssetMetadataKinds(): string[] {
  ensureBuiltInAssetMetadataKinds();
  return [...declaredKinds.keys()].sort();
}

export function getDeclaredAssetMetadataKind(
  kind: string,
): DeclaredAssetMetadataKind | undefined {
  ensureBuiltInAssetMetadataKinds();
  return declaredKinds.get(kind);
}

export type ParsedAssetMetadataFillAction = {
  actionId: string;
  target: MetadataAttachmentTarget;
  metadataKind: string;
  metadata: { kind: string } & Record<string, unknown>;
  producer: string;
  createdAt?: string;
};

let FillActionEnvelopeSchema = lazySchema(() => (
z
  .object({
    actionId: z.string().trim().min(1),
    target: MetadataAttachmentTargetSchema,
    metadataKind: z.string().trim().min(1),
    metadata: z.object({ kind: z.string().trim().min(1) }).passthrough(),
    producer: z.string().trim().min(1),
    createdAt: z.string().optional(),
  })
  .strict()
), (real) => { FillActionEnvelopeSchema = real; });

/**
 * Parse a fill action against whichever kind it declares. A kind nobody
 * declared is refused, because "open" means declarable, not unchecked.
 */
export function parseAssetMetadataFillAction(
  value: unknown,
): ParsedAssetMetadataFillAction {
  const envelope = FillActionEnvelopeSchema.parse(value);
  ensureBuiltInAssetMetadataKinds();
  if (envelope.metadata.kind !== envelope.metadataKind) {
    throw new Error(
      `metadata kind mismatch: ${envelope.metadataKind} does not match ${envelope.metadata.kind}`,
    );
  }

  const declared = declaredKinds.get(envelope.metadataKind);
  if (!declared) {
    throw new Error(
      `Undeclared asset metadata kind: ${envelope.metadataKind}. Declare it with registerAssetMetadataKind first.`,
    );
  }
  return {
    ...envelope,
    metadata: declared.schema.parse(
      envelope.metadata,
    ) as ParsedAssetMetadataFillAction["metadata"],
  };
}

export function parseDeclaredAssetMetadata(
  kind: string,
  value: unknown,
): unknown {
  ensureBuiltInAssetMetadataKinds();
  const declared = declaredKinds.get(kind);
  if (!declared) throw new Error(`Undeclared asset metadata kind: ${kind}`);
  return declared.schema.parse(value);
}
