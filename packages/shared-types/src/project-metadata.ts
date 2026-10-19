import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

/**
 * Product metadata that may be mirrored between a local Project replica and
 * its hosted counterpart. Identity, ownership, credentials, local paths and
 * sync configuration deliberately live outside this contract.
 */
export let ProjectMetadataSchema = lazySchema(() => (
z
  .object({
    projectId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    deletedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
), (real) => { ProjectMetadataSchema = real; });

export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

export const PROJECT_METADATA_SCHEMA_VERSION = 1 as const;

export let ProjectMetadataEnvelopeSchema = lazySchema(() => (
z
  .object({
    schemaVersion: z.literal(PROJECT_METADATA_SCHEMA_VERSION),
    metadata: ProjectMetadataSchema,
  })
  .strict()
), (real) => { ProjectMetadataEnvelopeSchema = real; });

export type ProjectMetadataEnvelope = z.infer<
  typeof ProjectMetadataEnvelopeSchema
>;
