import type { LoroDoc } from "loro-crdt";
import { z } from "zod";

import {
  DocumentAssetRevisionRefSchema,
  DocumentAttachmentSchema,
  DocumentRevisionProducerSchema,
  GeneratorInputRefSchema,
  advanceDocumentAttachment,
  advanceProjectDocumentAssetHead,
  createProjectDocumentAsset,
  ensureDocumentAttachment,
  getDocumentKindDefinition,
  listDocumentAssetRevisions,
  listDocumentAttachments,
  readDocumentAttachment,
  listProjectDocumentAssets,
  parseDocumentBody,
  readDocumentAssetRevision,
  readGeneratorRevision,
  readProjectAsset,
  readProjectDocumentAsset,
  type DocumentAssetRevision,
  type DocumentAttachment,
  type DocumentRevisionProducer,
  type GeneratorInputRef,
} from "@clash/shared-types";
import { readMetadataBody, storeMetadataBody } from "@clash/shared-runtime";

export interface LocalDocumentProjectAuthority {
  inspect<T>(
    projectId: string,
    read: (doc: LoroDoc) => T | Promise<T>,
  ): Promise<T>;
  mutate<T>(
    projectId: string,
    mutation: (doc: LoroDoc, checkpoint: () => Promise<void>) => T | Promise<T>,
  ): Promise<T>;
}

export class LocalDocumentProductError extends Error {
  override name = "LocalDocumentProductError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const idSchema = z.string().trim().min(1);
const sourceRefsSchema = z
  .array(z.unknown())
  .transform((value, context): GeneratorInputRef[] => {
    const result = GeneratorInputRefSchema.array().safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0];
      context.addIssue({
        code: "custom",
        path: issue?.path ?? [],
        message: issue?.message ?? "Invalid Document source reference.",
      });
      return z.NEVER;
    }
    return result.data;
  });

const attachmentSchema = z
  .unknown()
  .transform((value, context): DocumentAttachment => {
    const result = DocumentAttachmentSchema.safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0];
      context.addIssue({
        code: "custom",
        path: issue?.path ?? [],
        message: issue?.message ?? "Invalid Document attachment.",
      });
      return z.NEVER;
    }
    return result.data;
  });

const documentRevisionRefSchema = z.unknown().transform((value, context) => {
  const result = DocumentAssetRevisionRefSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    context.addIssue({
      code: "custom",
      path: issue?.path ?? [],
      message: issue?.message ?? "Invalid Document revision reference.",
    });
    return z.NEVER;
  }
  return result.data;
});

export const CreateLocalDocumentInputSchema = z
  .object({
    documentAssetId: idSchema,
    revisionId: idSchema,
    documentKind: idSchema,
    schemaVersion: z.number().int().positive(),
    body: z.unknown(),
    sourceRefs: sourceRefsSchema.default([]),
  })
  .strict();
export type CreateLocalDocumentInput = z.infer<
  typeof CreateLocalDocumentInputSchema
>;

export const AdvanceLocalDocumentInputSchema = z
  .object({
    documentAssetId: idSchema,
    expectedHeadRevisionId: idSchema,
    revisionId: idSchema,
    body: z.unknown(),
    sourceRefs: sourceRefsSchema.default([]),
  })
  .strict();
export type AdvanceLocalDocumentInput = z.infer<
  typeof AdvanceLocalDocumentInputSchema
>;

export const AdvanceLocalDocumentBodySchema = z
  .object({
    expectedHeadRevisionId: idSchema,
    revisionId: idSchema,
    body: z.unknown(),
    sourceRefs: sourceRefsSchema.default([]),
  })
  .strict();
export type AdvanceLocalDocumentBody = z.infer<
  typeof AdvanceLocalDocumentBodySchema
>;

export const CopyLocalDocumentBodySchema = z
  .object({
    sourceRevisionId: idSchema,
    documentAssetId: idSchema,
    revisionId: idSchema,
    body: z.unknown().optional(),
  })
  .strict();
export type CopyLocalDocumentBody = z.infer<typeof CopyLocalDocumentBodySchema>;

export const AttachLocalDocumentInputSchema = attachmentSchema;

export const AdvanceLocalDocumentAttachmentBodySchema = z
  .object({
    expectedRevisionId: idSchema,
    document: documentRevisionRefSchema,
  })
  .strict();
export type AdvanceLocalDocumentAttachmentBody = z.infer<
  typeof AdvanceLocalDocumentAttachmentBodySchema
>;

function throwMutationError(result: {
  error: { code: string; message: string };
}): never {
  throw new LocalDocumentProductError(result.error.code, result.error.message);
}

function declaration(kind: string, schemaVersion: number) {
  const definition = getDocumentKindDefinition(kind, schemaVersion);
  if (!definition) {
    throw new LocalDocumentProductError(
      "DOCUMENT_KIND_NOT_DECLARED",
      `Document kind ${kind}@${schemaVersion} is not declared.`,
    );
  }
  return definition;
}

function assertSourceRefs(
  doc: LoroDoc,
  refs: readonly GeneratorInputRef[],
): void {
  for (const ref of refs) {
    const target = ref.target;
    if ("kind" in target && target.kind === "media") {
      const asset = readProjectAsset(doc, target.projectAssetId);
      if (asset && asset.lifecycle.state !== "purged") continue;
    } else if ("kind" in target && target.kind === "document") {
      if (readDocumentAssetRevision(doc, target)) continue;
    } else if (readGeneratorRevision(doc, target)) {
      continue;
    }
    throw new LocalDocumentProductError(
      "DOCUMENT_SOURCE_NOT_FOUND",
      `Document source ${ref.slot}/${JSON.stringify(target)} is not available.`,
    );
  }
}

async function storeBody(input: {
  dataDir: string;
  documentKind: string;
  schemaVersion: number;
  body: unknown;
}) {
  declaration(input.documentKind, input.schemaVersion);
  const parsedBody = parseDocumentBody(
    input.documentKind,
    input.schemaVersion,
    input.body,
  );
  const stored = await storeMetadataBody({
    dataDir: input.dataDir,
    body: parsedBody,
  });
  return {
    body: parsedBody,
    ref: {
      digest: stored.contentHash,
      byteLength: stored.bytes,
      contentType: "application/json" as const,
    },
  };
}

async function readRevisionBody(input: {
  dataDir: string;
  revision: DocumentAssetRevision;
}) {
  const body = await readMetadataBody({
    dataDir: input.dataDir,
    contentHash: input.revision.body.digest,
  });
  return parseDocumentBody(
    input.revision.documentKind,
    input.revision.schemaVersion,
    body,
  );
}

export function createLocalDocumentProductService(options: {
  dataDir: string;
  authority: LocalDocumentProjectAuthority;
  producer: DocumentRevisionProducer;
}) {
  const producer = DocumentRevisionProducerSchema.parse(options.producer);
  return {
    async create(projectId: string, inputRaw: CreateLocalDocumentInput) {
      const input = CreateLocalDocumentInputSchema.parse(inputRaw);
      const kind = declaration(input.documentKind, input.schemaVersion);
      const stored = await storeBody({
        dataDir: options.dataDir,
        documentKind: input.documentKind,
        schemaVersion: input.schemaVersion,
        body: input.body,
      });
      return options.authority.mutate(projectId, async (doc, checkpoint) => {
        assertSourceRefs(doc, input.sourceRefs);
        const result = createProjectDocumentAsset(doc, {
          id: input.revisionId,
          documentAssetId: input.documentAssetId,
          documentKind: input.documentKind,
          schemaVersion: input.schemaVersion,
          mutability: kind.mutability,
          body: stored.ref,
          producer,
          sourceRefs: input.sourceRefs,
        });
        if (!result.ok) return throwMutationError(result);
        if (result.changed) await checkpoint();
        return { ...result, body: stored.body };
      });
    },

    async copy(
      projectId: string,
      input: CopyLocalDocumentBody & { sourceDocumentAssetId: string },
    ) {
      const parsed = CopyLocalDocumentBodySchema.parse({
        sourceRevisionId: input.sourceRevisionId,
        documentAssetId: input.documentAssetId,
        revisionId: input.revisionId,
        ...(input.body === undefined ? {} : { body: input.body }),
      });
      const source = await options.authority.inspect(projectId, (doc) =>
        readDocumentAssetRevision(doc, {
          documentAssetId: input.sourceDocumentAssetId,
          revisionId: parsed.sourceRevisionId,
        }),
      );
      if (!source)
        throw new LocalDocumentProductError(
          "DOCUMENT_REVISION_NOT_FOUND",
          "Document copy source revision not found.",
        );
      const body =
        parsed.body === undefined
          ? await readRevisionBody({
              dataDir: options.dataDir,
              revision: source,
            })
          : parsed.body;
      const stored = await storeBody({
        dataDir: options.dataDir,
        documentKind: source.documentKind,
        schemaVersion: source.schemaVersion,
        body,
      });
      return options.authority.mutate(projectId, async (doc, checkpoint) => {
        assertSourceRefs(doc, source.sourceRefs);
        const result = createProjectDocumentAsset(doc, {
          id: parsed.revisionId,
          documentAssetId: parsed.documentAssetId,
          documentKind: source.documentKind,
          schemaVersion: source.schemaVersion,
          mutability: source.mutability,
          forkedFrom: {
            kind: "document",
            documentAssetId: source.documentAssetId,
            revisionId: source.id,
          },
          body: stored.ref,
          producer,
          sourceRefs: source.sourceRefs,
        });
        if (!result.ok) return throwMutationError(result);
        if (result.changed) await checkpoint();
        return { ...result, body: stored.body };
      });
    },

    async advance(projectId: string, inputRaw: AdvanceLocalDocumentInput) {
      const input = AdvanceLocalDocumentInputSchema.parse(inputRaw);
      const current = await options.authority.inspect(projectId, (doc) => {
        const asset = readProjectDocumentAsset(doc, input.documentAssetId);
        if (!asset) return null;
        const revision = readDocumentAssetRevision(doc, {
          documentAssetId: asset.id,
          revisionId: asset.headRevisionId,
        });
        return revision ? { asset, revision } : null;
      });
      if (!current) {
        throw new LocalDocumentProductError(
          "DOCUMENT_ASSET_NOT_FOUND",
          `Document Asset ${input.documentAssetId} not found.`,
        );
      }
      const stored = await storeBody({
        dataDir: options.dataDir,
        documentKind: current.revision.documentKind,
        schemaVersion: current.revision.schemaVersion,
        body: input.body,
      });
      return options.authority.mutate(projectId, async (doc, checkpoint) => {
        assertSourceRefs(doc, input.sourceRefs);
        const result = advanceProjectDocumentAssetHead(doc, {
          documentAssetId: input.documentAssetId,
          expectedHeadRevisionId: input.expectedHeadRevisionId,
          revision: {
            id: input.revisionId,
            documentAssetId: input.documentAssetId,
            documentKind: current.revision.documentKind,
            schemaVersion: current.revision.schemaVersion,
            mutability: current.revision.mutability,
            parentRevisionId: input.expectedHeadRevisionId,
            body: stored.ref,
            producer,
            sourceRefs: input.sourceRefs,
          },
        });
        if (!result.ok) return throwMutationError(result);
        if (result.changed) await checkpoint();
        return { ...result, body: stored.body };
      });
    },

    async read(projectId: string, documentAssetId: string) {
      const value = await options.authority.inspect(projectId, (doc) => {
        const asset = readProjectDocumentAsset(doc, documentAssetId);
        if (!asset) return null;
        const revision = readDocumentAssetRevision(doc, {
          documentAssetId: asset.id,
          revisionId: asset.headRevisionId,
        });
        return revision ? { asset, revision } : null;
      });
      if (!value) return null;
      return {
        ...value,
        body: await readRevisionBody({
          dataDir: options.dataDir,
          revision: value.revision,
        }),
      };
    },

    async list(projectId: string) {
      return options.authority.inspect(projectId, (doc) =>
        listProjectDocumentAssets(doc),
      );
    },

    async listRevisions(projectId: string, documentAssetId: string) {
      return options.authority.inspect(projectId, (doc) =>
        listDocumentAssetRevisions(doc, documentAssetId),
      );
    },

    async readRevision(
      projectId: string,
      input: { documentAssetId: string; revisionId: string },
    ) {
      const revision = await options.authority.inspect(projectId, (doc) =>
        readDocumentAssetRevision(doc, input),
      );
      if (!revision) return null;
      return {
        revision,
        body: await readRevisionBody({ dataDir: options.dataDir, revision }),
      };
    },

    async listAttachments(projectId: string) {
      return options.authority.inspect(projectId, (doc) =>
        listDocumentAttachments(doc),
      );
    },
    async readAttachment(projectId: string, attachmentId: string) {
      return options.authority.inspect(projectId, (doc) =>
        readDocumentAttachment(doc, attachmentId),
      );
    },

    async attach(projectId: string, inputRaw: DocumentAttachment) {
      const input = AttachLocalDocumentInputSchema.parse(inputRaw);
      return options.authority.mutate(projectId, async (doc, checkpoint) => {
        const result = ensureDocumentAttachment(doc, input);
        if (!result.ok) return throwMutationError(result);
        if (result.changed) await checkpoint();
        return result;
      });
    },

    async advanceAttachment(
      projectId: string,
      input: {
        attachmentId: string;
        expectedRevisionId: string;
        document: unknown;
      },
      assertCurrent?: (attachment: DocumentAttachment) => void,
    ) {
      return options.authority.mutate(projectId, async (doc, checkpoint) => {
        const current = readDocumentAttachment(doc, input.attachmentId);
        if (!current)
          throw new LocalDocumentProductError(
            "DOCUMENT_ATTACHMENT_NOT_FOUND",
            "Document attachment not found.",
          );
        assertCurrent?.(current);
        const result = advanceDocumentAttachment(doc, input);
        if (!result.ok) return throwMutationError(result);
        if (result.changed) await checkpoint();
        return result;
      });
    },
  };
}

export type LocalDocumentProductService = ReturnType<
  typeof createLocalDocumentProductService
>;
