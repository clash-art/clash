/**
 * Plugin catalog routes, same response shapes as the local Host
 * (apps/local-api). They list only what this deployment can execute; the
 * catalog module loads on the first catalog request, not with the REST chunk.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../../config";
import type { CloudPluginCatalog } from "@clash/shared-runtime/cloud-project-host/plugin-catalog";

export const pluginCatalogRoutes = new Hono<{ Bindings: Env }>();

async function withCatalog(
  c: Context<{ Bindings: Env }>,
  respond: (catalog: CloudPluginCatalog) => Response,
): Promise<Response> {
  if (!c.req.header("x-user-id"))
    return c.json({ error: "unauthorized" }, 401);
  try {
    const { cloudPluginCatalog } = await import(
      "../../services/cloud-plugin-catalog"
    );
    return respond(cloudPluginCatalog());
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      502,
    );
  }
}

pluginCatalogRoutes.get("/generator-definitions", (c) =>
  withCatalog(c, (catalog) =>
    c.json({ definitions: catalog.generatorDefinitions() }),
  ),
);

pluginCatalogRoutes.get("/generator-definitions/:pluginId/:definitionId", (c) =>
  withCatalog(c, (catalog) => {
    const definition = catalog.resolveGeneratorDefinition(
      c.req.param("pluginId"),
      c.req.param("definitionId"),
    );
    return definition
      ? c.json({ definition })
      : c.json({ error: "Generator Definition not found" }, 404);
  }),
);

pluginCatalogRoutes.get("/plugin-views", (c) =>
  withCatalog(c, (catalog) => c.json({ views: catalog.views() })),
);

pluginCatalogRoutes.get("/plugin-actions", (c) =>
  withCatalog(c, (catalog) => c.json({ actions: catalog.actions() })),
);
