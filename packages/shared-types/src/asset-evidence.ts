import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";
import {
  DocumentRevisionProducerSchema,
  DocumentRevisionSourceRefSchema,
} from "./document-assets.js";
import { DocumentAssetRevisionRefSchema } from "./generator-v2.js";

let text = lazySchema(() => (
z.string().trim().min(1)
), (real) => { text = real; });

/** A record of work already done. Detail is inert text, never executable input. */
export let MediaOperationTraceSchema = lazySchema(() => (
z
  .object({ title: text, detail: text })
  .strict()
), (real) => { MediaOperationTraceSchema = real; });
export type MediaOperationTrace = z.infer<typeof MediaOperationTraceSchema>;

let observation = lazySchema(() => (
z
  .object({
    text,
    startMs: z.number().int().nonnegative().optional(),
    endMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.startMs === undefined) !== (value.endMs === undefined) ||
      (value.startMs !== undefined && value.endMs! <= value.startMs)
    ) {
      context.addIssue({
        code: "custom",
        path: ["endMs"],
        message:
          "An observation range requires both source times and endMs greater than startMs.",
      });
    }
  })
), (real) => { observation = real; });

/** Actor attribution is held by the Document revision; optional tools describe external work honestly. */
export let MediaObservationSchema = lazySchema(() => (
z
  .object({
    summary: text,
    tool: text.optional(),
    model: text.optional(),
    observations: z.array(observation).optional(),
  })
  .strict()
), (real) => { MediaObservationSchema = real; });
export type MediaObservation = z.infer<typeof MediaObservationSchema>;

export let AssetEvidenceQuerySchema = lazySchema(() => (
z
  .object({
    query: z.string().trim().max(2000).optional(),
    assetId: text.optional(),
  })
  .strict()
), (real) => { AssetEvidenceQuerySchema = real; });
export type AssetEvidenceQuery = z.infer<typeof AssetEvidenceQuerySchema>;

export let AssetEvidenceMatchSchema = lazySchema(() => (
z
  .object({
    projectAssetId: text,
    attachmentId: text,
    document: DocumentAssetRevisionRefSchema,
    documentKind: text,
    producer: DocumentRevisionProducerSchema,
    sourceRefs: z.array(DocumentRevisionSourceRefSchema),
    text,
    startMs: z.number().int().nonnegative().optional(),
    endMs: z.number().int().positive().optional(),
  })
  .strict()
), (real) => { AssetEvidenceMatchSchema = real; });
export type AssetEvidenceMatch = z.infer<typeof AssetEvidenceMatchSchema>;
export let AssetEvidenceSearchResultSchema = lazySchema(() => (
z
  .object({
    matches: z.array(AssetEvidenceMatchSchema),
    truncated: z.boolean().optional(),
  })
  .strict()
), (real) => { AssetEvidenceSearchResultSchema = real; });
export type AssetEvidenceSearchResult = z.infer<
  typeof AssetEvidenceSearchResultSchema
>;
