export type DocumentRequest = (path: string, init?: RequestInit) => Promise<Response>;

export class DocumentHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Document API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "DocumentHttpError";
  }
}

function segment(value: string): string {
  if (!value.trim()) throw new Error("Document reads require project, Asset, and Revision identities.");
  return encodeURIComponent(value.trim());
}

/** Read immutable Document bodies through the existing Project authority. */
export function createDocumentClient(request: DocumentRequest) {
  return {
    async getRevision(projectId: string, documentAssetId: string, revisionId: string): Promise<unknown> {
      const response = await request(`/api/v1/projects/${segment(projectId)}/documents/${segment(documentAssetId)}/revisions/${segment(revisionId)}`);
      const raw = await response.text();
      let body: unknown = raw;
      try { body = JSON.parse(raw); } catch { /* Retain non-JSON error responses. */ }
      if (!response.ok) throw new DocumentHttpError(response.status, body);
      return body;
    },
  };
}
