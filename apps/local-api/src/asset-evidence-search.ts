import { Hono } from "hono";
import {
  AssetEvidenceQuerySchema,
  type AssetEvidenceQuery,
  type AssetEvidenceSearchResult,
} from "@clash/shared-types";
import { projectContentToAssetEvidence } from "@clash/shared-runtime/asset-search-client";
import type { LocalDocumentProjectAuthority } from "./local-document-product.js";
import {
  createLocalProjectContentRoutes,
  createLocalProjectContentService,
} from "./project-content.js";

export function createLocalAssetEvidenceSearch(options: {
  dataDir: string;
  authority: LocalDocumentProjectAuthority;
}) {
  const content = createLocalProjectContentService(options);
  return async (
    projectId: string,
    query: AssetEvidenceQuery,
  ): Promise<AssetEvidenceSearchResult> => {
    const parsed = AssetEvidenceQuerySchema.parse(query);
    const result = await content.search(projectId, {
      query: parsed.query ?? "",
      ...(parsed.assetId
        ? { within: { kind: "media" as const, projectAssetId: parsed.assetId } }
        : {}),
      kinds: ["video", "image", "audio", "model"],
      limit: 200,
    });
    return projectContentToAssetEvidence(result);
  };
}

export function createLocalAssetSearchRoutes(options: {
  dataDir: string;
  authority?: LocalDocumentProjectAuthority;
}) {
  const app = new Hono();
  app.route("/", createLocalProjectContentRoutes(options));
  app.get("/api/v1/projects/:projectId/asset-search", async (c) => {
    if (!options.authority)
      return c.json(
        { error: "Document Project authority is unavailable" },
        503,
      );
    const query = AssetEvidenceQuerySchema.safeParse(c.req.query());
    if (!query.success)
      return c.json(
        { error: "Invalid asset evidence query", details: query.error.issues },
        400,
      );
    return c.json(
      await createLocalAssetEvidenceSearch({
        dataDir: options.dataDir,
        authority: options.authority,
      })(c.req.param("projectId"), query.data),
    );
  });
  return app;
}
