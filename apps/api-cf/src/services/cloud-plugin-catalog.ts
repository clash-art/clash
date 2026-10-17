/**
 * The hosted Worker's plugin catalog, built on first use.
 *
 * workerd forbids Ajv's runtime compilation (`new Function`), so the build-time
 * standalone validators for every exposed Generator schema are registered
 * before any Definition can be used. Regenerate them with
 * `pnpm --dir apps/api-cf generate:cloud-plugin-validators`.
 */
import type { CloudPluginCatalog } from "@clash/shared-runtime/cloud-project-host/plugin-catalog";
import { registerPrecompiledGeneratorValidators } from "@clash/shared-runtime/generator-contract";
import { cloudPluginValidators } from "../generated/cloud-plugin-validators";
import { buildCloudPluginCatalog } from "./cloud-plugin-packages";

let catalog: CloudPluginCatalog | undefined;

export function cloudPluginCatalog(): CloudPluginCatalog {
  if (!catalog) {
    registerPrecompiledGeneratorValidators(cloudPluginValidators);
    catalog = buildCloudPluginCatalog();
  }
  return catalog;
}
