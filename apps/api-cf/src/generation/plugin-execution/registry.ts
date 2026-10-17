import type { PluginModule } from "@clash/action-sdk/browser";
import type { ExecutablePluginBinding } from "@clash/shared-types/executable-plugin";

/**
 * Explicit allowlist of first-party plugin executors whose bodies are
 * Worker-safe (fetch/WebCrypto/Buffer, no node:fs or child_process at module
 * scope). Adding a plugin here is a code decision, not runtime discovery.
 */
export const CLOUD_IN_PROCESS_PLUGIN_IDS = ["clash.fal"] as const;

export interface CloudInProcessPluginRegistration {
  pluginId: string;
  version: string;
  schemaHash: `sha256:${string}`;
  module: PluginModule;
  exports: readonly string[];
}

let modules:
  | Promise<ReadonlyMap<string, CloudInProcessPluginRegistration>>
  | undefined;

async function loadModules(): Promise<
  ReadonlyMap<string, CloudInProcessPluginRegistration>
> {
  const fal = await import("@clash-plugin/fal/module");
  return new Map([
    [
      "clash.fal",
      {
        pluginId: "clash.fal",
        version: fal.manifestDocument.version,
        schemaHash: fal.schemaHash,
        module: fal.plugin,
        exports: fal.manifestDocument.contributes.functions.map(
          (entry) => entry.id,
        ),
      },
    ],
  ]);
}

/** Dynamic entry: Worker startup never evaluates plugin code or plugin JSON. */
export function loadCloudInProcessPluginModules() {
  return (modules ??= loadModules());
}

export async function resolveCloudInProcessBinding(
  pluginId: string,
  exportId: string,
): Promise<ExecutablePluginBinding | undefined> {
  const registry = await loadCloudInProcessPluginModules();
  const registration = registry.get(pluginId);
  if (!registration || !registration.exports.includes(exportId)) {
    return undefined;
  }
  return {
    pluginId: registration.pluginId,
    version: registration.version,
    exportId,
    schemaHash: registration.schemaHash,
  };
}
