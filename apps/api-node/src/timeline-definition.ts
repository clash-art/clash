import { readFileSync } from "node:fs";
import {
  generatorDefinitionFromExecutablePluginRegistration,
  validateExecutablePluginPackage,
} from "@clash/shared-types";
import { executablePluginSchemaHash } from "@clash/shared-runtime/executable-plugin-schema-hash";

/** Load the bundled projection contract, without advertising a render executor. */
export function loadTimelineDefinition() {
  const root = new URL("../../../plugins/remotion/", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL("manifest.json", root), "utf8"),
  );
  const document = JSON.parse(
    readFileSync(new URL("generators/timeline.json", root), "utf8"),
  );
  const pkg = validateExecutablePluginPackage(
    manifest,
    {},
    {},
    { generators: { "generators/timeline.json": document } },
  );
  return generatorDefinitionFromExecutablePluginRegistration({
    pluginId: pkg.manifest.id,
    version: pkg.manifest.version,
    schemaHash: executablePluginSchemaHash(
      pkg.manifest,
      pkg.cards,
      pkg.providers,
      pkg.modelBindings,
      pkg.generators,
      pkg.views,
    ),
    document: pkg.generators["generators/timeline.json"]!,
  });
}
