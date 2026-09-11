import { z } from "zod";
import { MODEL_TEXT_DOCUMENT_KIND, MODEL_TEXT_DOCUMENT_SCHEMA_VERSION } from "./model-output-contract.js";

import {
  MediaDescriptionMetadataSchema,
  MediaRenderLineageMetadataSchema,
} from "./asset-metadata-registry.js";
import { DocumentAssetMutabilitySchema } from "./document-assets.js";
import { AsrTimedTranscriptSchema } from "./production-metadata.js";
import {
  MEDIA_ANALYSIS_DOCUMENT_KIND_BY_CATEGORY,
  MediaAnalysisCategorySchema,
  MediaAnalysisDocumentSchemas,
} from "./media-analysis-documents.js";

const idSchema = z.string().trim().min(1);

export const DocumentProjectionContractSchema = z
  .object({
    format: z.enum(["json", "text"]),
    editable: z.boolean(),
  })
  .strict();
export type DocumentProjectionContract = z.infer<
  typeof DocumentProjectionContractSchema
>;

export const DocumentKindDefinitionSchema = z
  .object({
    kind: idSchema,
    schemaVersion: z.number().int().positive(),
    mutability: DocumentAssetMutabilitySchema,
    projection: DocumentProjectionContractSchema,
    allowedAttachmentTargets: z
      .array(z.enum(["project-asset", "generator-revision", "action-run"]))
      .min(1)
      .refine((values) => new Set(values).size === values.length, {
        message: "Document attachment target declarations must be unique.",
      }),
    /** Empty means storage/projection support only; it grants no product semantics. */
    productConsumers: z
      .array(idSchema)
      .refine((values) => new Set(values).size === values.length, {
        message: "Document product consumer declarations must be unique.",
      }),
  })
  .strict();
export type DocumentKindDefinition = z.infer<
  typeof DocumentKindDefinitionSchema
>;

export interface DocumentBodySchema {
  parse(value: unknown): unknown;
}

export interface DocumentKindDeclaration {
  definition: DocumentKindDefinition;
  schema: DocumentBodySchema;
}

const declarations = new Map<string, DocumentKindDeclaration>();

function declarationKey(kind: string, schemaVersion: number): string {
  return `${kind}\0${schemaVersion}`;
}

export function registerDocumentKind(
  declarationInput: DocumentKindDeclaration,
): void {
  const definition = DocumentKindDefinitionSchema.parse(
    declarationInput.definition,
  );
  const key = declarationKey(definition.kind, definition.schemaVersion);
  if (declarations.has(key)) {
    throw new Error(
      `Document kind ${definition.kind}@${definition.schemaVersion} is already declared.`,
    );
  }
  declarations.set(key, {
    definition,
    schema: declarationInput.schema,
  });
}

export function getDocumentKindDefinition(
  kind: string,
  schemaVersion: number,
): DocumentKindDefinition | undefined {
  return declarations.get(declarationKey(kind, schemaVersion))?.definition;
}

export function listDocumentKindDefinitions(): DocumentKindDefinition[] {
  return [...declarations.values()]
    .map(({ definition }) => definition)
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.schemaVersion - right.schemaVersion,
    );
}

export function parseDocumentBody(
  kind: string,
  schemaVersion: number,
  value: unknown,
): unknown {
  const declaration = declarations.get(declarationKey(kind, schemaVersion));
  if (!declaration) {
    throw new Error(`Undeclared Document kind: ${kind}@${schemaVersion}.`);
  }
  return declaration.schema.parse(value);
}

registerDocumentKind({
  definition: {
    kind: MODEL_TEXT_DOCUMENT_KIND,
    schemaVersion: MODEL_TEXT_DOCUMENT_SCHEMA_VERSION,
    mutability: "versioned",
    projection: { format: "text", editable: true },
    allowedAttachmentTargets: ["generator-revision", "action-run"],
    productConsumers: [],
  },
  schema: z.string().refine((value) => value.trim().length > 0, "Generated text must not be empty."),
});

registerDocumentKind({
  definition: {
    kind: "media.transcript",
    schemaVersion: 1,
    mutability: "versioned",
    projection: { format: "json", editable: true },
    allowedAttachmentTargets: [
      "project-asset",
      "generator-revision",
      "action-run",
    ],
    productConsumers: ["captions", "transcript-editing", "search"],
  },
  schema: AsrTimedTranscriptSchema,
});

registerDocumentKind({
  definition: {
    kind: "media.description",
    schemaVersion: 1,
    mutability: "versioned",
    projection: { format: "json", editable: true },
    allowedAttachmentTargets: [
      "project-asset",
      "generator-revision",
      "action-run",
    ],
    productConsumers: ["search", "agent-context"],
  },
  schema: MediaDescriptionMetadataSchema,
});

registerDocumentKind({
  definition: {
    kind: "media.render-lineage",
    schemaVersion: 1,
    mutability: "immutable",
    projection: { format: "json", editable: false },
    allowedAttachmentTargets: [
      "project-asset",
      "generator-revision",
      "action-run",
    ],
    productConsumers: ["provenance"],
  },
  schema: MediaRenderLineageMetadataSchema,
});

for (const category of MediaAnalysisCategorySchema.options) {
  registerDocumentKind({
    definition: {
      kind: MEDIA_ANALYSIS_DOCUMENT_KIND_BY_CATEGORY[category],
      schemaVersion: 1,
      mutability: "versioned",
      projection: { format: "json", editable: false },
      allowedAttachmentTargets: [
        "project-asset",
        "generator-revision",
        "action-run",
      ],
      productConsumers: ["search", "agent-context"],
    },
    schema: MediaAnalysisDocumentSchemas[category],
  });
}
