import { z } from "zod";
import {
  DocumentRevisionProducerSchema,
  DocumentRevisionSourceRefSchema,
} from "./document-assets.js";
import { DocumentAssetRevisionRefSchema } from "./generator-v2.js";

const text = z.string().trim().min(1);

/** A record of work already done. Detail is inert text, never executable input. */
export const MediaOperationTraceSchema = z
  .object({ title: text, detail: text })
  .strict();
export type MediaOperationTrace = z.infer<typeof MediaOperationTraceSchema>;

const observation = z
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
        code: z.ZodIssueCode.custom,
        path: ["endMs"],
        message:
          "An observation range requires both source times and endMs greater than startMs.",
      });
    }
  });

/** Actor attribution is held by the Document revision; optional tools describe external work honestly. */
export const MediaObservationSchema = z
  .object({
    summary: text,
    tool: text.optional(),
    model: text.optional(),
    observations: z.array(observation).optional(),
  })
  .strict();
export type MediaObservation = z.infer<typeof MediaObservationSchema>;

export const AssetEvidenceQuerySchema = z
  .object({
    query: z.string().trim().max(2000).optional(),
    assetId: text.optional(),
  })
  .strict();
export type AssetEvidenceQuery = z.infer<typeof AssetEvidenceQuerySchema>;

export const AssetEvidenceMatchSchema = z
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
  .strict();
export type AssetEvidenceMatch = z.infer<typeof AssetEvidenceMatchSchema>;
export const AssetEvidenceSearchResultSchema = z
  .object({
    matches: z.array(AssetEvidenceMatchSchema),
    truncated: z.boolean().optional(),
  })
  .strict();
export type AssetEvidenceSearchResult = z.infer<
  typeof AssetEvidenceSearchResultSchema
>;
