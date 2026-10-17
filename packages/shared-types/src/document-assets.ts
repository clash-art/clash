import { z } from "zod";

import {
  DocumentAssetRevisionRefSchema,
  GeneratorInputRefSchema,
} from "./generator-v2.js";

const idSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const DocumentAssetMutabilitySchema = z.enum(["immutable", "versioned"]);
export type DocumentAssetMutability = z.infer<
  typeof DocumentAssetMutabilitySchema
>;

/** Immutable, storage-free address of one typed document body. */
export const DocumentBodyRefSchema = z
  .object({
    digest: sha256Schema,
    byteLength: z.number().int().nonnegative(),
    contentType: z.string().trim().min(1),
  })
  .strict();
export type DocumentBodyRef = z.infer<typeof DocumentBodyRefSchema>;

export const DocumentRevisionProducerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("action-run"),
      actionRunId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("actor"),
      actor: z
        .object({
          kind: z.enum(["user", "agent"]),
          id: idSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("migration"),
      source: idSchema,
    })
    .strict(),
]);
export type DocumentRevisionProducer = z.infer<
  typeof DocumentRevisionProducerSchema
>;

export const DocumentRevisionSourceRefSchema = GeneratorInputRefSchema;
export type DocumentRevisionSourceRef = z.infer<
  typeof DocumentRevisionSourceRefSchema
>;

/** Every revision and body is immutable; mutability describes only how its stable head advances. */
export const DocumentAssetRevisionSchema = z
  .object({
    id: idSchema,
    documentAssetId: idSchema,
    documentKind: idSchema,
    schemaVersion: z.number().int().positive(),
    mutability: DocumentAssetMutabilitySchema,
    parentRevisionId: idSchema.optional(),
    forkedFrom: DocumentAssetRevisionRefSchema.optional(),
    body: DocumentBodyRefSchema,
    producer: DocumentRevisionProducerSchema,
    sourceRefs: z.array(DocumentRevisionSourceRefSchema),
  })
  .strict()
  .superRefine(({ documentAssetId, forkedFrom }, context) => {
    if (forkedFrom?.documentAssetId === documentAssetId) {
      context.addIssue({
        code: "custom",
        path: ["forkedFrom", "documentAssetId"],
        message:
          "Same-Document ancestry belongs in parentRevisionId, not forkedFrom.",
      });
    }
  });
export type DocumentAssetRevision = z.infer<typeof DocumentAssetRevisionSchema>;

/** Persisted mutable identity; kind and policy are derived from the immutable head revision. */
export const ProjectDocumentAssetHeadSchema = z
  .object({
    id: idSchema,
    headRevisionId: idSchema,
  })
  .strict();
export type ProjectDocumentAssetHead = z.infer<
  typeof ProjectDocumentAssetHeadSchema
>;

export const ProjectDocumentAssetSchema = ProjectDocumentAssetHeadSchema.extend(
  {
    documentKind: idSchema,
    mutability: DocumentAssetMutabilitySchema,
  },
).strict();
export type ProjectDocumentAsset = z.infer<typeof ProjectDocumentAssetSchema>;

export const DocumentAttachmentTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project-asset"),
      projectAssetId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("generator-revision"),
      generatorId: idSchema,
      generatorRevisionId: idSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("action-run"),
      actionRunId: idSchema,
    })
    .strict(),
]);
export type DocumentAttachmentTarget = z.infer<
  typeof DocumentAttachmentTargetSchema
>;

/** A relation, not the payload: it always pins one immutable Document revision. */
export const DocumentAttachmentSchema = z
  .object({
    id: idSchema,
    target: DocumentAttachmentTargetSchema,
    slot: idSchema,
    document: DocumentAssetRevisionRefSchema,
  })
  .strict();
export type DocumentAttachment = z.infer<typeof DocumentAttachmentSchema>;
