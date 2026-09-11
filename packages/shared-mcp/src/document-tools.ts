import { z } from "zod/v3";
import { createDocumentClient, type DocumentRequest } from "@clash/shared-runtime/document-client";
import type { ClashMcpServer } from "./server.js";
import { describeClashTool } from "./tool-guidance.js";

/** Document bodies belong to Assets; Runs only identify their committed outputs. */
export function registerDocumentTools(server: ClashMcpServer, options: { request: DocumentRequest }): void {
  const client = createDocumentClient(options.request);
  server.registerTool("clash_assets_document_revision_get", {
    title: "Read Document Asset revision",
    description: describeClashTool({
      useWhen: "an Output Commit or pinned input names a Document Asset revision whose body is needed",
      effect: "reads the exact immutable revision through the Project Document API without changing its head",
      returns: "the revision, its producer and source references, and its verified body",
      next: "inspect the body or pass the same Document revision reference as a subsequent Generator input",
    }),
    inputSchema: { projectId: z.string().min(1), documentAssetId: z.string().min(1), revisionId: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ projectId, documentAssetId, revisionId }) => {
    const value = await client.getRevision(projectId, documentAssetId, revisionId);
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: { result: value } };
  });
}
