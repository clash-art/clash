import { z } from "zod";
import {
  AssetRevisionRefSchema,
  DocumentAssetRevisionRefSchema,
} from "./generator-v2.js";
import {
  DocumentRevisionProducerSchema,
  DocumentRevisionSourceRefSchema,
} from "./document-assets.js";

const projectContentKinds = [
  "image",
  "video",
  "audio",
  "model",
  "document",
] as const;

/** Suggestions only: accepted values and the machine-readable enum stay exact. */
function kindCandidates(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 10) return [];
  const input = value.normalize("NFKC").trim().toLowerCase();
  if (!input) return [];
  const bound = input.length < 4 ? 1 : 2;
  let nearest: string[] = [];
  let distance = bound + 1;
  for (const kind of projectContentKinds) {
    if (Math.abs(input.length - kind.length) > bound) continue;
    let previous = Array.from({ length: kind.length + 1 }, (_, index) => index);
    for (let i = 1; i <= input.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= kind.length; j += 1) {
        current[j] = Math.min(
          current[j - 1]! + 1,
          previous[j]! + 1,
          previous[j - 1]! + (input[i - 1] === kind[j - 1] ? 0 : 1),
        );
      }
      previous = current;
    }
    const score = previous[kind.length]!;
    if (score < distance) {
      nearest = [kind];
      distance = score;
    } else if (score === distance) nearest.push(kind);
  }
  return distance <= bound ? nearest : [];
}

export const ProjectContentKindSchema = z.enum(projectContentKinds, {
  errorMap: (_issue, context) => {
    const candidates = kindCandidates(context.data);
    const suggestion = candidates.map((kind) => `"${kind}"`).join(" or ");
    const received =
      typeof context.data === "string"
        ? ` ${JSON.stringify(context.data.slice(0, 60))}`
        : "";
    return {
      message: `Invalid content kind${received}.${suggestion ? ` Did you mean ${suggestion}?` : ""} Valid kinds: ${projectContentKinds.join(", ")}.`,
    };
  },
});
export const ProjectContentQuerySchema = z
  .object({
    query: z.string().trim().max(2000).optional(),
    kinds: z.array(ProjectContentKindSchema).min(1).optional(),
    within: AssetRevisionRefSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const ProjectContentMatchSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("name"), text: z.string() }).strict(),
  z
    .object({
      field: z.literal("content"),
      text: z.string(),
      document: DocumentAssetRevisionRefSchema,
      documentKind: z.string(),
      producer: DocumentRevisionProducerSchema,
      sourceRefs: z.array(DocumentRevisionSourceRefSchema),
      attachmentId: z.string().optional(),
      location: z
        .object({
          asset: z
            .object({
              kind: z.literal("media"),
              projectAssetId: z.string().min(1),
            })
            .strict(),
          startMs: z.number().int().nonnegative(),
          endMs: z.number().int().positive(),
        })
        .strict()
        .refine((value) => value.endMs > value.startMs)
        .optional(),
    })
    .strict(),
]);

/** A browsable object reference, not a second filesystem or storage identity. */
export const ProjectContentItemSchema = z
  .object({
    ref: AssetRevisionRefSchema,
    name: z.string(),
    kind: ProjectContentKindSchema,
    info: z
      .object({
        width: z.number().optional(),
        height: z.number().optional(),
        durationMs: z.number().optional(),
        documentKind: z.string().optional(),
        hasEvidence: z.boolean().optional(),
      })
      .strict(),
    matches: z.array(ProjectContentMatchSchema),
  })
  .strict();

export const ProjectContentResultSchema = z
  .object({
    items: z.array(ProjectContentItemSchema),
    /** Matching object counts before kind filtering and result truncation. */
    countsByKind: z
      .object({
        image: z.number().int().nonnegative(),
        video: z.number().int().nonnegative(),
        audio: z.number().int().nonnegative(),
        model: z.number().int().nonnegative(),
        document: z.number().int().nonnegative(),
      })
      .strict(),
    truncated: z.boolean(),
    /** Pass back unchanged with the same query; absent/null means the last page. */
    nextCursor: z.string().nullable().optional(),
    matchMode: z.literal("literal-text").nullable(),
  })
  .strict();

export type ProjectContentQuery = z.infer<typeof ProjectContentQuerySchema>;
export type ProjectContentItem = z.infer<typeof ProjectContentItemSchema>;
export type ProjectContentMatch = z.infer<typeof ProjectContentMatchSchema>;
export type ProjectContentResult = z.infer<typeof ProjectContentResultSchema>;
