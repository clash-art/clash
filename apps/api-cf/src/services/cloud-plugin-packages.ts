/**
 * Plugin packages bundled into the hosted Worker, statically imported so the
 * build carries them. Only the Timeline projection is executable here: the
 * Remotion `render-timeline` Action runs in a local stdio runtime.
 *
 * Load this module lazily (REST routes, ProjectRoom operations): it brings the
 * plugin JSON and shared-types schemas, which stay out of Worker startup.
 */
import {
  createCloudPluginCatalog,
  type CloudPluginPackage,
} from "@clash/shared-runtime/cloud-project-host/plugin-catalog";
import remotionManifest from "../../../../plugins/remotion/manifest.json";
import remotionTimeline from "../../../../plugins/remotion/generators/timeline.json";

export const CLOUD_PLUGIN_PACKAGES: readonly CloudPluginPackage[] = [
  {
    manifest: remotionManifest,
    generators: { "generators/timeline.json": remotionTimeline },
  },
];

/** Projection surfaces with a cloud command handler. */
export const CLOUD_EXECUTABLE_GENERATOR_IDS = ["clash.timeline"] as const;

export function buildCloudPluginCatalog() {
  return createCloudPluginCatalog(CLOUD_PLUGIN_PACKAGES, {
    executableGeneratorIds: CLOUD_EXECUTABLE_GENERATOR_IDS,
  });
}
