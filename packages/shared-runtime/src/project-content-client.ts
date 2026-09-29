import {
  AssetRevisionRefSchema,
  ProjectContentQuerySchema,
  ProjectContentResultSchema,
  type AssetRevisionRef,
  type ProjectContentQuery,
  type ProjectContentResult,
} from "@clash/shared-types";
import {
  createDocumentClient,
  publicDocumentValue,
  DocumentHttpError,
  type DocumentRequest,
} from "./document-client.js";
export { AssetRevisionRefSchema, ProjectContentQuerySchema };

/** Browse, find and open the same immutable references, without a separate search identity. */
export function createProjectContentClient(request: DocumentRequest) {
  const documents = createDocumentClient(request);
  const root = (projectId: string) => {
    if (!projectId.trim())
      throw new Error("Project content requires a Project identity.");
    return `/api/v1/projects/${encodeURIComponent(projectId)}`;
  };
  async function readResponse(path: string, init?: RequestInit) {
    const response = await request(path, init);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* Keep useful non-JSON HTTP errors. */
    }
    if (!response.ok) throw new DocumentHttpError(response.status, body);
    return body;
  }
  return {
    async list(
      projectId: string,
      query: Omit<ProjectContentQuery, "within"> = {},
    ): Promise<ProjectContentResult> {
      const parsed = ProjectContentQuerySchema.parse(query);
      const params = new URLSearchParams();
      if (parsed.query) params.set("query", parsed.query);
      if (parsed.kinds) params.set("kinds", parsed.kinds.join(","));
      if (parsed.limit !== undefined) params.set("limit", String(parsed.limit));
      if (parsed.cursor !== undefined) params.set("cursor", parsed.cursor);
      return ProjectContentResultSchema.parse(
        await readResponse(`${root(projectId)}/content?${params}`),
      );
    },
    async search(
      projectId: string,
      query: ProjectContentQuery,
    ): Promise<ProjectContentResult> {
      const parsed = ProjectContentQuerySchema.parse(query);
      return ProjectContentResultSchema.parse(
        await readResponse(`${root(projectId)}/content`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed),
        }),
      );
    },
    async read(
      projectId: string,
      reference: AssetRevisionRef,
    ): Promise<unknown> {
      const ref = AssetRevisionRefSchema.parse(reference);
      const path = root(projectId);
      return ref.kind === "media"
        ? readResponse(
            `${path}/assets/${encodeURIComponent(ref.projectAssetId)}`,
          )
        : publicDocumentValue(
            await documents.getRevision(
              projectId,
              ref.documentAssetId,
              ref.revisionId,
            ),
          );
    },
  };
}
