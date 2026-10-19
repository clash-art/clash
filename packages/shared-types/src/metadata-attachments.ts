import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

let ScopedIdSchema = lazySchema(() => (
z.string().trim().min(1)
), (real) => { ScopedIdSchema = real; });

/**
 * A metadata target names product state only. Runtime locators, storage keys,
 * paths, and URLs are deliberately not part of this identity.
 */
export let ProjectAssetMetadataTargetSchema = lazySchema(() => (
z
  .object({
    kind: z.literal("project-asset"),
    projectId: ScopedIdSchema,
    assetId: ScopedIdSchema,
  })
  .strict()
), (real) => { ProjectAssetMetadataTargetSchema = real; });

export let ActionRevisionMetadataTargetSchema = lazySchema(() => (
z
  .object({
    kind: z.literal("action-revision"),
    projectId: ScopedIdSchema,
    actionId: ScopedIdSchema,
    actionRevisionId: ScopedIdSchema,
  })
  .strict()
), (real) => { ActionRevisionMetadataTargetSchema = real; });

export let MetadataAttachmentTargetSchema = lazySchema(() => (
z.discriminatedUnion("kind", [
  ProjectAssetMetadataTargetSchema,
  ActionRevisionMetadataTargetSchema,
])
), (real) => { MetadataAttachmentTargetSchema = real; });

export type ProjectAssetMetadataTarget = z.infer<
  typeof ProjectAssetMetadataTargetSchema
>;
export type ActionRevisionMetadataTarget = z.infer<
  typeof ActionRevisionMetadataTargetSchema
>;
export type MetadataAttachmentTarget = z.infer<
  typeof MetadataAttachmentTargetSchema
>;

/**
 * Canonical, collision-free identity for projection indexes and idempotency.
 * Parsing first also prevents a caller from smuggling storage topology into
 * the key through unrecognized fields.
 */
export function metadataAttachmentTargetKey(
  value: MetadataAttachmentTarget,
): string {
  return JSON.stringify(MetadataAttachmentTargetSchema.parse(value));
}
