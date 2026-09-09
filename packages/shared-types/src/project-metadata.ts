import { z } from "zod";

/**
 * Product metadata that may be mirrored between a local Project replica and
 * its hosted counterpart. Identity, ownership, credentials, local paths and
 * sync configuration deliberately live outside this contract.
 */
export const ProjectMetadataSchema = z
  .object({
    projectId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    deletedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

export const PROJECT_METADATA_SCHEMA_VERSION = 1 as const;

export const ProjectMetadataEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_METADATA_SCHEMA_VERSION),
    metadata: ProjectMetadataSchema,
  })
  .strict();

export type ProjectMetadataEnvelope = z.infer<
  typeof ProjectMetadataEnvelopeSchema
>;
