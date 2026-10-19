import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

import {
  DocumentAssetRevisionRefSchema,
  GeneratorInputRefSchema,
} from "./generator-v2.js";

let idSchema = lazySchema(() => (
z.string().trim().min(1)
), (real) => { idSchema = real; });
let sha256Schema = lazySchema(() => (
z.string().regex(/^sha256:[a-f0-9]{64}$/)
), (real) => { sha256Schema = real; });

export let DocumentAssetMutabilitySchema = lazySchema(() => (
z.enum(["immutable", "versioned"])
), (real) => { DocumentAssetMutabilitySchema = real; });
export type DocumentAssetMutability = z.infer<
  typeof DocumentAssetMutabilitySchema
>;

/** Immutable, storage-free address of one typed document body. */
export let DocumentBodyRefSchema = lazySchema(() => (
z
  .object({
    digest: sha256Schema,
    byteLength: z.number().int().nonnegative(),
    contentType: z.string().trim().min(1),
  })
  .strict()
), (real) => { DocumentBodyRefSchema = real; });
export type DocumentBodyRef = z.infer<typeof DocumentBodyRefSchema>;

export let DocumentRevisionProducerSchema = lazySchema(() => (
z.discriminatedUnion("kind", [
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
])
), (real) => { DocumentRevisionProducerSchema = real; });
export type DocumentRevisionProducer = z.infer<
  typeof DocumentRevisionProducerSchema
>;

export const DocumentRevisionSourceRefSchema = GeneratorInputRefSchema;
export type DocumentRevisionSourceRef = z.infer<
  typeof DocumentRevisionSourceRefSchema
>;

/** Every revision and body is immutable; mutability describes only how its stable head advances. */
export let DocumentAssetRevisionSchema = lazySchema(() => (
z
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
  })
), (real) => { DocumentAssetRevisionSchema = real; });
export type DocumentAssetRevision = z.infer<typeof DocumentAssetRevisionSchema>;

/** Persisted mutable identity; kind and policy are derived from the immutable head revision. */
export let ProjectDocumentAssetHeadSchema = lazySchema(() => (
z
  .object({
    id: idSchema,
    headRevisionId: idSchema,
  })
  .strict()
), (real) => { ProjectDocumentAssetHeadSchema = real; });
export type ProjectDocumentAssetHead = z.infer<
  typeof ProjectDocumentAssetHeadSchema
>;

export let ProjectDocumentAssetSchema = lazySchema(() => (
ProjectDocumentAssetHeadSchema.extend(
  {
    documentKind: idSchema,
    mutability: DocumentAssetMutabilitySchema,
  },
).strict()
), (real) => { ProjectDocumentAssetSchema = real; });
export type ProjectDocumentAsset = z.infer<typeof ProjectDocumentAssetSchema>;

export let DocumentAttachmentTargetSchema = lazySchema(() => (
z.discriminatedUnion("kind", [
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
])
), (real) => { DocumentAttachmentTargetSchema = real; });
export type DocumentAttachmentTarget = z.infer<
  typeof DocumentAttachmentTargetSchema
>;

/** A relation, not the payload: it always pins one immutable Document revision. */
export let DocumentAttachmentSchema = lazySchema(() => (
z
  .object({
    id: idSchema,
    target: DocumentAttachmentTargetSchema,
    slot: idSchema,
    document: DocumentAssetRevisionRefSchema,
  })
  .strict()
), (real) => { DocumentAttachmentSchema = real; });
export type DocumentAttachment = z.infer<typeof DocumentAttachmentSchema>;
