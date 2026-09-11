import { createHmac, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  agentReadToken,
  agentReadReceiptToken,
  validateAgentReadProof,
  getDocumentKindDefinition,
  listDocumentKindDefinitions,
  type DocumentAssetRevision,
  type DocumentAttachment,
} from "@clash/shared-types";
import {
  AdvanceLocalDocumentAttachmentBodySchema,
  AdvanceLocalDocumentBodySchema,
  AttachLocalDocumentInputSchema,
  CopyLocalDocumentBodySchema,
  CreateLocalDocumentInputSchema,
  createLocalDocumentProductService,
  LocalDocumentProductError,
  type LocalDocumentProjectAuthority,
} from "./local-document-product.js";

const receiptSecret = randomBytes(32);
function documentToken(
  projectId: string,
  documentAssetId: string,
  revisionId: string,
) {
  return agentReadToken({
    namespace: "document",
    subject: { projectId, documentAssetId, revisionId },
  });
}
function receipt(token: string) {
  return createHmac("sha256", receiptSecret).update(token).digest("base64url");
}
function signed(token: string) {
  return agentReadReceiptToken({ readToken: token, receipt: receipt(token) });
}
function assertObservation(
  c: Context,
  token: string,
  header = "x-clash-if-match",
) {
  const guard = validateAgentReadProof({
    actorClientType: c.req.header("x-clash-client-type"),
    operation: "Document mutation",
    currentReadToken: token,
    expectedReadToken: c.req.header(header),
    requireReceipt: true,
    readReceiptVerifier: (proof) =>
      proof.receipt === receipt(proof.baseReadToken),
    readCommandHint:
      "Read or pull the Document again, reconcile edits, then apply.",
  });
  if (!guard.ok)
    throw new LocalDocumentProductError(
      guard.code ?? "READ_REQUIRED",
      guard.error,
    );
}
function projection<T extends { revision: DocumentAssetRevision }>(
  projectId: string,
  value: T,
) {
  return {
    ...value,
    projection: getDocumentKindDefinition(
      value.revision.documentKind,
      value.revision.schemaVersion,
    )!.projection,
    readToken: signed(
      documentToken(
        projectId,
        value.revision.documentAssetId,
        value.revision.id,
      ),
    ),
  };
}
function attachmentToken(projectId: string, attachment: DocumentAttachment) {
  return agentReadToken({
    namespace: "document-attachment",
    subject: { projectId, attachment },
  });
}
export function createLocalDocumentRoutes(options: {
  dataDir: string;
  userId: string;
  authority?: LocalDocumentProjectAuthority;
}) {
  const app = new Hono();
  const root = "/api/v1/projects/:projectId";
  app.onError((error, c) => {
    if (!(error instanceof LocalDocumentProductError))
      return c.json({ error: error.message }, 422);
    const status = /NOT_FOUND$/.test(error.code)
      ? 404
      : /EXISTS|COLLISION|STALE|COPY_ON_WRITE|READ_REQUIRED|READ_PROOF/.test(
            error.code,
          )
        ? 409
        : 422;
    return c.json({ code: error.code, error: error.message }, status);
  });
  app.use(`${root}/documents*`, async (c, next) => {
    if (!options.authority)
      return c.json(
        { error: "Document Project authority is unavailable" },
        503,
      );
    return next();
  });
  const service = (c: Context) =>
    createLocalDocumentProductService({
      dataDir: options.dataDir,
      authority: options.authority!,
      producer:
        c.req.header("x-clash-client-type") === "agent"
          ? { kind: "actor", actor: { kind: "agent" } }
          : { kind: "actor", actor: { kind: "user", id: options.userId } },
    });
  app.get(`${root}/documents/kinds`, (c) =>
    c.json({ kinds: listDocumentKindDefinitions() }),
  );
  app.get(`${root}/documents`, async (c) => {
    const projectId = c.req.param("projectId");
    return c.json({
      documents: (await service(c).list(projectId)).map((asset) => ({
        ...asset,
        readToken: signed(
          documentToken(projectId, asset.id, asset.headRevisionId),
        ),
      })),
    });
  });
  app.post(`${root}/documents`, async (c) => {
    const parsed = CreateLocalDocumentInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: "Invalid Document creation", details: parsed.error.issues },
        400,
      );
    const result = await service(c).create(
      c.req.param("projectId"),
      parsed.data,
    );
    return c.json(
      projection(c.req.param("projectId"), {
        asset: result.asset,
        revision: result.revision,
        body: result.body,
      }),
      result.changed ? 201 : 200,
    );
  });
  app.get(`${root}/documents/:documentAssetId/revisions`, async (c) =>
    c.json({
      revisions: await service(c).listRevisions(
        c.req.param("projectId"),
        c.req.param("documentAssetId"),
      ),
    }),
  );
  app.get(
    `${root}/documents/:documentAssetId/revisions/:revisionId`,
    async (c) => {
      const result = await service(c).readRevision(c.req.param("projectId"), {
        documentAssetId: c.req.param("documentAssetId"),
        revisionId: c.req.param("revisionId"),
      });
      return result
        ? c.json(projection(c.req.param("projectId"), result))
        : c.json(
            {
              code: "DOCUMENT_REVISION_NOT_FOUND",
              error: "Document revision not found",
            },
            404,
          );
    },
  );
  app.get(`${root}/documents/:documentAssetId`, async (c) => {
    const result = await service(c).read(
      c.req.param("projectId"),
      c.req.param("documentAssetId"),
    );
    return result
      ? c.json(projection(c.req.param("projectId"), result))
      : c.json(
          {
            code: "DOCUMENT_ASSET_NOT_FOUND",
            error: "Document Asset not found",
          },
          404,
        );
  });
  app.post(`${root}/documents/:documentAssetId/revisions`, async (c) => {
    const parsed = AdvanceLocalDocumentBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: "Invalid Document revision", details: parsed.error.issues },
        400,
      );
    const projectId = c.req.param("projectId"),
      documentAssetId = c.req.param("documentAssetId");
    assertObservation(
      c,
      documentToken(
        projectId,
        documentAssetId,
        parsed.data.expectedHeadRevisionId,
      ),
    );
    const result = await service(c).advance(projectId, {
      documentAssetId,
      ...parsed.data,
    });
    return c.json(
      projection(projectId, {
        asset: result.asset,
        revision: result.revision,
        body: result.body,
      }),
      result.changed ? 201 : 200,
    );
  });
  app.post(`${root}/documents/:documentAssetId/copies`, async (c) => {
    const parsed = CopyLocalDocumentBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: "Invalid Document copy", details: parsed.error.issues },
        400,
      );
    const projectId = c.req.param("projectId"),
      sourceDocumentAssetId = c.req.param("documentAssetId");
    assertObservation(
      c,
      documentToken(
        projectId,
        sourceDocumentAssetId,
        parsed.data.sourceRevisionId,
      ),
    );
    const result = await service(c).copy(projectId, {
      sourceDocumentAssetId,
      ...parsed.data,
    });
    return c.json(
      projection(projectId, {
        asset: result.asset,
        revision: result.revision,
        body: result.body,
      }),
      result.changed ? 201 : 200,
    );
  });
  app.get(`${root}/document-attachments`, async (c) => {
    if (!options.authority)
      return c.json(
        { error: "Document Project authority is unavailable" },
        503,
      );
    const projectId = c.req.param("projectId");
    return c.json({
      attachments: (await service(c).listAttachments(projectId)).map(
        (attachment) => ({
          ...attachment,
          readToken: signed(attachmentToken(projectId, attachment)),
        }),
      ),
    });
  });
  app.get(`${root}/document-attachments/:attachmentId`, async (c) => {
    if (!options.authority)
      return c.json(
        { error: "Document Project authority is unavailable" },
        503,
      );
    const projectId = c.req.param("projectId");
    const attachment = await service(c).readAttachment(
      projectId,
      c.req.param("attachmentId"),
    );
    return attachment
      ? c.json({
          attachment,
          readToken: signed(attachmentToken(projectId, attachment)),
        })
      : c.json(
          {
            code: "DOCUMENT_ATTACHMENT_NOT_FOUND",
            error: "Document attachment not found",
          },
          404,
        );
  });
  app.post(`${root}/document-attachments`, async (c) => {
    if (!options.authority)
      return c.json(
        { error: "Document Project authority is unavailable" },
        503,
      );
    const parsed = AttachLocalDocumentInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: "Invalid Document attachment", details: parsed.error.issues },
        400,
      );
    const projectId = c.req.param("projectId");
    assertObservation(
      c,
      documentToken(
        projectId,
        parsed.data.document.documentAssetId,
        parsed.data.document.revisionId,
      ),
    );
    const result = await service(c).attach(projectId, parsed.data);
    return c.json(
      {
        attachment: result.attachment,
        readToken: signed(attachmentToken(projectId, result.attachment)),
      },
      result.changed ? 201 : 200,
    );
  });
  app.post(
    `${root}/document-attachments/:attachmentId/revisions`,
    async (c) => {
      if (!options.authority)
        return c.json(
          { error: "Document Project authority is unavailable" },
          503,
        );
      const parsed = AdvanceLocalDocumentAttachmentBodySchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        return c.json(
          {
            error: "Invalid Document attachment revision",
            details: parsed.error.issues,
          },
          400,
        );
      const projectId = c.req.param("projectId");
      assertObservation(
        c,
        documentToken(
          projectId,
          parsed.data.document.documentAssetId,
          parsed.data.document.revisionId,
        ),
        "x-clash-document-observation",
      );
      const result = await service(c).advanceAttachment(
        projectId,
        { attachmentId: c.req.param("attachmentId"), ...parsed.data },
        (current) => assertObservation(c, attachmentToken(projectId, current)),
      );
      return c.json({
        attachment: result.attachment,
        readToken: signed(attachmentToken(projectId, result.attachment)),
      });
    },
  );
  return app;
}
