import type {
  DocumentAttachment,
  DocumentAssetRevision,
  DocumentKindDefinition,
  DocumentProjectionContract,
  DocumentRevisionSourceRef,
} from "@clash/shared-types";

export type DocumentRequest = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;
export interface DocumentRead {
  asset?: { id: string; headRevisionId: string };
  revision: DocumentAssetRevision;
  body: unknown;
  projection: DocumentProjectionContract;
  /** Internal observation evidence; clients must omit this from public output. */
  readToken: string;
}
export interface DocumentAttachmentRead {
  attachment: DocumentAttachment;
  readToken: string;
}
export interface DocumentCreate {
  documentAssetId: string;
  revisionId: string;
  documentKind: string;
  schemaVersion: number;
  body: unknown;
  sourceRefs?: DocumentRevisionSourceRef[];
}
export class DocumentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(
      `Document API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
    this.name = "DocumentHttpError";
  }
}
function segment(value: string): string {
  if (!value.trim())
    throw new Error("Document operations require nonempty identities.");
  return encodeURIComponent(value.trim());
}
/** Platform-neutral transport to the single Project Document authority. */
export function createDocumentClient(request: DocumentRequest) {
  const root = (project: string) =>
    `/api/v1/projects/${segment(project)}/documents`;
  const target = (project: string, asset: string) =>
    `${root(project)}/${segment(asset)}`;
  async function send<T>(
    path: string,
    body?: unknown,
    observation?: string,
    documentObservation?: string,
  ): Promise<T> {
    const response = await request(
      path,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(observation ? { "x-clash-if-match": observation } : {}),
              ...(documentObservation
                ? { "x-clash-document-observation": documentObservation }
                : {}),
            },
            body: JSON.stringify(body),
          },
    );
    const raw = await response.text();
    let result: unknown = raw;
    try {
      result = JSON.parse(raw);
    } catch {
      /* Preserve non-JSON errors. */
    }
    if (!response.ok) throw new DocumentHttpError(response.status, result);
    return result as T;
  }
  return {
    attachments: (project: string) =>
      send<{ attachments: Array<DocumentAttachment & { readToken: string }> }>(
        `/api/v1/projects/${segment(project)}/document-attachments`,
      ),
    attachment: (project: string, id: string) =>
      send<DocumentAttachmentRead>(
        `/api/v1/projects/${segment(project)}/document-attachments/${segment(id)}`,
      ),
    attach: (project: string, body: DocumentAttachment, observation: string) =>
      send<DocumentAttachmentRead>(
        `/api/v1/projects/${segment(project)}/document-attachments`,
        body,
        observation,
      ),
    advanceAttachment: (
      project: string,
      id: string,
      body: {
        expectedRevisionId: string;
        document: DocumentAttachment["document"];
      },
      observation: string,
      documentObservation: string,
    ) =>
      send<DocumentAttachmentRead>(
        `/api/v1/projects/${segment(project)}/document-attachments/${segment(id)}/revisions`,
        body,
        observation,
        documentObservation,
      ),
    kinds: (project: string) =>
      send<{ kinds: DocumentKindDefinition[] }>(`${root(project)}/kinds`),
    list: (project: string) =>
      send<{
        documents: Array<{
          id: string;
          headRevisionId: string;
          readToken: string;
        }>;
      }>(root(project)),
    get: (project: string, asset: string) =>
      send<DocumentRead>(target(project, asset)),
    getRevision: (project: string, asset: string, revision: string) =>
      send<DocumentRead>(
        `${target(project, asset)}/revisions/${segment(revision)}`,
      ),
    history: (project: string, asset: string) =>
      send<{ revisions: DocumentAssetRevision[] }>(
        `${target(project, asset)}/revisions`,
      ),
    create: (project: string, body: DocumentCreate) =>
      send<DocumentRead>(root(project), body),
    advance: (
      project: string,
      asset: string,
      body: {
        expectedHeadRevisionId: string;
        revisionId: string;
        body: unknown;
        sourceRefs?: DocumentRevisionSourceRef[];
      },
      observation: string,
    ) =>
      send<DocumentRead>(
        `${target(project, asset)}/revisions`,
        body,
        observation,
      ),
    copy: (
      project: string,
      asset: string,
      body: {
        sourceRevisionId: string;
        documentAssetId: string;
        revisionId: string;
        body?: unknown;
      },
      observation: string,
    ) =>
      send<DocumentRead>(`${target(project, asset)}/copies`, body, observation),
  };
}

/** Internal receipts never belong in CLI output, including JSON mode. */
export function publicDocumentValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { readToken: _internal, ...envelope } = value as Record<
    string,
    unknown
  >;
  for (const key of ["documents", "attachments"]) {
    if (Array.isArray(envelope[key]))
      envelope[key] = envelope[key].map(publicDocumentValue);
  }
  return envelope;
}
