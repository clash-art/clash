import { readFileSync } from "node:fs";
import { createCloudPluginCatalog } from "@clash/shared-runtime/cloud-project-host/plugin-catalog";

/** The bundled plugins this server executes: the Timeline projection, without a render executor. */
export function loadCloudPluginCatalog() {
  const root = new URL("../../../plugins/remotion/", import.meta.url);
  const read = (path: string): unknown =>
    JSON.parse(readFileSync(new URL(path, root), "utf8"));
  return createCloudPluginCatalog(
    [
      {
        manifest: read("manifest.json"),
        generators: { "generators/timeline.json": read("generators/timeline.json") },
      },
    ],
    { executableGeneratorIds: ["clash.timeline"] },
  );
}

/** Load the bundled projection contract, without advertising a render executor. */
export function loadTimelineDefinition() {
  const [definition] = loadCloudPluginCatalog().generatorDefinitions();
  if (!definition) throw new Error("The bundled Timeline plugin is missing");
  return definition;
}
