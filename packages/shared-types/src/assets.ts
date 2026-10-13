/**
 * Canonical product Asset contracts.
 *
 * `Resource`, `GlobalAssetEntry`, `ProjectAssetEntry`, `ActionAssetBinding`, and
 * `ResolvedAsset` are the current authority and public read shapes. The row-oriented
 * `Asset*` schemas later in this file are explicitly legacy Cloud/migration contracts;
 * they must not be used for new Local product APIs or synchronized Project identity.
 */

import { z } from "zod";
import { agentReadToken } from "./agent-read-proof.js";

export const AssetKindSchema = z.enum(["image", "video", "audio", "model"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/** Stable identity for immutable media bytes. It is never a path, URL, or object-store key. */
export const ResourceIdSchema = z.string().trim().min(1);
export type ResourceId = z.infer<typeof ResourceIdSchema>;

/** Immutable content identity and verification facts, independent from every storage adapter. */
export const ResourceSchema = z
  .object({
    id: ResourceIdSchema,
    kind: AssetKindSchema,
    digest: z
      .object({
        algorithm: z.literal("sha256"),
        value: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    byteLength: z.number().int().nonnegative(),
    contentType: z.string().trim().min(1).optional(),
  })
  .strict();
export type Resource = z.infer<typeof ResourceSchema>;

/** Descriptive product metadata safe to replicate in Project Loro. */
export const ProjectAssetMetadataSchema = z
  .object({
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
    /** Display-matrix rotation normalized into [0, 360). */
    rotationDegrees: z.number().finite().min(0).lt(360).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    bytes: z.number().int().nonnegative().optional(),
    /** @deprecated Legacy read/migration field. New Asset publication strips waveform samples. */
    waveform: z.array(z.number()).optional(),
    contentType: z.string().trim().min(1).optional(),
    frameRate: z.number().positive().optional(),
    videoCodec: z.string().trim().min(1).optional(),
    /** Byte-probed stream presence. `false` is a known silent video, not unknown. */
    hasAudio: z.boolean().optional(),
    audioCodec: z.string().trim().min(1).optional(),
    sampleRate: z.number().int().positive().optional(),
    channelCount: z.number().int().positive().optional(),
    channelLayout: z.string().trim().min(1).optional(),
    originalName: z.string().trim().min(1).optional(),
    /** Normalized rig/deform capability a `model` asset exposes, independent from any provider or
     *  rig format. `0` means static/rigid -- no rig/deform capability. `1` means rigged/deformable.
     *  This is a normalized capability, not a bone count or physical degree of freedom, and it
     *  never becomes a `rig` kind of its own -- static and rigged 3-D assets are both `model`. */
    flexibility: z.number().min(0).max(1).optional(),
  })
  .strict();
export type ProjectAssetMetadata = z.infer<typeof ProjectAssetMetadataSchema>;

/** Metadata accepted for every new Asset publication. Legacy derived caches remain read-only. */
export const ProjectAssetPublicationMetadataSchema =
  ProjectAssetMetadataSchema.omit({ waveform: true });
export type ProjectAssetPublicationMetadata = z.infer<
  typeof ProjectAssetPublicationMetadataSchema
>;

export const ProjectAssetProvenanceSchema = z
  .object({
    kind: z.enum(["import", "generation", "edit", "render", "admission"]),
    actionRunId: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    prompt: z.string().optional(),
  })
  .strict();
export type ProjectAssetProvenance = z.infer<
  typeof ProjectAssetProvenanceSchema
>;

/** Storage-free identity of the collection entry from which a Resource was admitted. */
export const ProjectAssetLinkedOriginSchema = z.discriminatedUnion("scope", [
  z
    .object({
      scope: z.literal("global"),
      libraryId: z.string().trim().min(1),
      entryId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      scope: z.literal("project"),
      projectId: z.string().trim().min(1),
      entryId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      scope: z.literal("catalog"),
      catalogId: z.string().trim().min(1),
      entryId: z.string().trim().min(1),
    })
    .strict(),
]);
export type ProjectAssetLinkedOrigin = z.infer<
  typeof ProjectAssetLinkedOriginSchema
>;

export const ProjectAssetSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("owned"),
      resourceId: ResourceIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("linked"),
      resourceId: ResourceIdSchema,
      origin: ProjectAssetLinkedOriginSchema,
    })
    .strict(),
]);
export type ProjectAssetSource = z.infer<typeof ProjectAssetSourceSchema>;

export const ProjectAssetLifecycleSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("active") }).strict(),
  z
    .object({
      state: z.literal("trashed"),
      deleteOperationId: z.string().trim().min(1),
      deletedAt: z.string().trim().min(1),
      purgeAfter: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("purged"),
      deleteOperationId: z.string().trim().min(1),
      deletedAt: z.string().trim().min(1),
      purgedAt: z.string().trim().min(1),
    })
    .strict(),
]);
export type ProjectAssetLifecycle = z.infer<typeof ProjectAssetLifecycleSchema>;

/** The only synchronized media identity inside a Project. */
export const ProjectAssetEntrySchema = z
  .object({
    id: z.string().trim().min(1),
    kind: AssetKindSchema,
    source: ProjectAssetSourceSchema,
    lifecycle: ProjectAssetLifecycleSchema,
    /** Immutable wall-clock production/admission time in Unix milliseconds. */
    createdAt: z.number().int().nonnegative().optional(),
    name: z.string().trim().min(1).optional(),
    metadata: ProjectAssetMetadataSchema,
    provenance: ProjectAssetProvenanceSchema.optional(),
  })
  .strict();
export type ProjectAssetEntry = z.infer<typeof ProjectAssetEntrySchema>;

/** Reusable library membership over an immutable Resource, independent from every Project. */
export const GlobalAssetEntrySchema = z
  .object({
    id: z.string().trim().min(1),
    kind: AssetKindSchema,
    resourceId: ResourceIdSchema,
    lifecycle: ProjectAssetLifecycleSchema,
    name: z.string().trim().min(1).optional(),
    metadata: ProjectAssetMetadataSchema,
    provenance: ProjectAssetProvenanceSchema.optional(),
  })
  .strict();
export type GlobalAssetEntry = z.infer<typeof GlobalAssetEntrySchema>;

export const ActionBindingOwnerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("draft"),
      actionId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("revision"),
      actionId: z.string().trim().min(1),
      actionRevisionId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("run"),
      actionId: z.string().trim().min(1),
      actionRevisionId: z.string().trim().min(1),
      actionRunId: z.string().trim().min(1),
    })
    .strict(),
]);
export type ActionBindingOwner = z.infer<typeof ActionBindingOwnerSchema>;

/** The only authoritative media usage reference inside a Project. */
export const ActionAssetBindingSchema = z
  .object({
    id: z.string().trim().min(1),
    owner: ActionBindingOwnerSchema,
    direction: z.enum(["input", "output"]),
    slot: z.string().trim().min(1),
    projectAssetId: z.string().trim().min(1),
    role: z.enum(["primary", "reference", "source"]).optional(),
  })
  .strict();
export type ActionAssetBinding = z.infer<typeof ActionAssetBindingSchema>;

/** One read-only Asset view resolved by the current Host. URLs are projections, never identity. */
export const ResolvedAssetSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: AssetKindSchema,
    /** Project Asset production time, or a Host Resource time for legacy entries. */
    createdAt: z.number().int().nonnegative().optional(),
    name: z.string().trim().min(1).optional(),
    metadata: ProjectAssetMetadataSchema,
    provenance: ProjectAssetProvenanceSchema.optional(),
    /** Synchronized logical lifecycle; independent from current-Host byte availability. */
    lifecycle: ProjectAssetLifecycleSchema,
    status: z.enum([
      "uploading",
      "ready",
      "downloading",
      "unavailable",
      "failed",
    ]),
    url: z.string().url().optional(),
    thumbnailUrl: z.string().url().optional(),
    /** Host-authorized projection of a bounded waveform representation. */
    waveformUrl: z.string().url().optional(),
    /**
     * Host-authorized projection of a lighter video for preview and editing
     * playback. Rendering and export always read `url`, the original.
     */
    proxyUrl: z.string().url().optional(),
    progress: z.number().min(0).max(1).optional(),
    error: z.string().trim().min(1).optional(),
  })
  .strict();
export type ResolvedAsset = z.infer<typeof ResolvedAssetSchema>;

/**
 * Legacy row metadata retained for hosted migration compatibility.
 *
 * Rationale for collapsing into one object: none of these are query predicates
 * (we never WHERE/ORDER BY on width or duration), so there's no reason to
 * spread them across columns. Keeping one JSON lets us grow the shape
 * (contentHash, hasAudio, dominantColor, codec, ...) without a D1 migration.
 *
 * `waveform` is retained only so hosted migration code can read historical
 * rows. New Asset publication and Timeline persistence strip it; the Local
 * Host stores derived peaks in its private representation registry and exposes
 * them only through an authorized `ResolvedAsset.waveformUrl` projection.
 */
export const AssetMetadataSchema = z.object({
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  rotationDegrees: z.number().finite().min(0).lt(360).optional(),
  durationMs: z.number().int().optional(),
  bytes: z.number().int().optional(),
  /** @deprecated Historical row payload; never emit from new publication. */
  waveform: z.array(z.number()).optional(),
  contentType: z.string().optional(),
  frameRate: z.number().positive().optional(),
  videoCodec: z.string().optional(),
  hasAudio: z.boolean().optional(),
  audioCodec: z.string().optional(),
  sampleRate: z.number().int().positive().optional(),
  channelCount: z.number().int().positive().optional(),
  channelLayout: z.string().optional(),
  contentHash: z.string().optional(),
  localBlobKey: z.string().optional(),
  originalName: z.string().optional(),
  mockText: z.string().optional(),
  transcript: z.string().optional(),
  provider: z.string().optional(),
  requestId: z.string().optional(),
  modelEndpoint: z.string().optional(),
  remoteUrl: z.string().optional(),
  /** Parameters used by a copy-on-write image/video edit. */
  editParams: z.unknown().optional(),
  /** Whether the edit was represented by a visible canvas node or an implicit asset-preview action. */
  editOrigin: z.enum(["canvas-node", "asset-preview"]).optional(),
  /** Validated ActionInvocation envelope that produced this immutable output. */
  actionInvocation: z.unknown().optional(),
});
export type AssetMetadata = z.infer<typeof AssetMetadataSchema>;

/**
 * One upstream asset that contributed to producing this asset.
 *
 * Roles:
 * - `edit-source` : the single input asset for image-editor / video-clipper
 *                   (always exactly one entry with this role).
 * - `reference`   : a reference image / video / audio fed into a generation
 *                   model (image-gen, video-gen).
 * - `primary`     : the primary input image for image-to-video generation —
 *                   distinguished from secondary refs because most i2v models
 *                   treat it as the first frame.
 *
 * Stored as JSON on `assets.sources`. NULL = lineage not recorded
 * (uploads, pre-existing rows). Not a query predicate.
 */
export const AssetSourceSchema = z.object({
  assetId: z.string(),
  role: z.enum(["edit-source", "reference", "primary"]),
});
export type AssetSource = z.infer<typeof AssetSourceSchema>;

/** Legacy hosted/storage row. New product readers return `ResolvedAsset` instead. */
export const AssetSchema = z.object({
  id: z.string(),
  userId: z.string(),
  kind: AssetKindSchema,
  srcR2Key: z.string(),
  coverR2Key: z.string().nullable().optional(),
  metadata: AssetMetadataSchema.nullable().optional(),
  sourceModel: z.string().nullable().optional(),
  sourcePrompt: z.string().nullable().optional(),
  sourceTaskId: z.string().nullable().optional(),
  sources: z.array(AssetSourceSchema).nullable().optional(),
  signedUrl: z.string().optional(),
  signedUrlExp: z.number().optional(),
  signedCoverUrl: z.string().optional(),
  signedCoverUrlExp: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Asset = z.infer<typeof AssetSchema>;

export type AssetReadProofLike = Pick<
  Asset,
  | "id"
  | "kind"
  | "srcR2Key"
  | "coverR2Key"
  | "metadata"
  | "sourceModel"
  | "sourcePrompt"
  | "sourceTaskId"
  | "sources"
  | "createdAt"
  | "updatedAt"
>;

export function assetReadToken(asset: AssetReadProofLike): string {
  return agentReadToken({
    namespace: "asset",
    subject: {
      id: asset.id,
      kind: asset.kind,
      srcR2Key: asset.srcR2Key,
      coverR2Key: asset.coverR2Key ?? null,
      metadata: asset.metadata ?? null,
      sourceModel: asset.sourceModel ?? null,
      sourcePrompt: asset.sourcePrompt ?? null,
      sourceTaskId: asset.sourceTaskId ?? null,
      sources: asset.sources ?? null,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    },
  });
}

export const AssetRefRowSchema = z.object({
  assetId: z.string(),
  projectId: z.string(),
  importedAt: z.number(),
});
export type AssetRefRow = z.infer<typeof AssetRefRowSchema>;

export type AssetRefReadProofLike = Pick<
  AssetRefRow,
  "assetId" | "projectId" | "importedAt"
>;

export function assetRefReadToken(ref: AssetRefReadProofLike): string {
  return agentReadToken({
    namespace: "asset-ref",
    subject: {
      assetId: ref.assetId,
      projectId: ref.projectId,
      importedAt: ref.importedAt,
    },
  });
}
