import type { PluginModule } from "@clash/action-sdk/browser";
import type {
  ExecutablePluginBinding,
  ExecutablePluginModelBindingRegistration,
} from "@clash/shared-types/executable-plugin";

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
  /** Model-provider bindings this plugin contributes to the hosted model catalog. */
  modelBindings: readonly ExecutablePluginModelBindingRegistration[];
  /** Exports that declare upstream deduplication of a repeated submit. */
  idempotentSubmitExports: readonly string[];
}

let modules:
  Promise<ReadonlyMap<string, CloudInProcessPluginRegistration>> | undefined;

async function loadModules(): Promise<
  ReadonlyMap<string, CloudInProcessPluginRegistration>
> {
  const fal = await import("@clash-plugin/fal/module");
  const functions = fal.manifestDocument.contributes.functions;
  return new Map([
    [
      "clash.fal",
      {
        pluginId: "clash.fal",
        version: fal.manifestDocument.version,
        schemaHash: fal.schemaHash,
        module: fal.plugin,
        exports: functions.map((entry) => entry.id),
        idempotentSubmitExports: functions
          .filter((entry) => entry.idempotentSubmit === true)
          .map((entry) => entry.id),
        modelBindings: Object.values(fal.modelBindingDocuments).map(
          (document) => ({
            pluginId: "clash.fal",
            version: fal.manifestDocument.version,
            schemaHash: fal.schemaHash,
            // Package provenance only; the Cloudflare adapter runs it in-process.
            runtime: fal.manifestDocument.runtime,
            document,
          }),
        ),
      },
    ],
  ]);
}

/** Dynamic entry: Worker startup never evaluates plugin code or plugin JSON. */
export function loadCloudInProcessPluginModules() {
  return (modules ??= loadModules());
}

async function resolveCloudInProcessPlugin(
  pluginId: string,
): Promise<CloudInProcessPluginRegistration | undefined> {
  return (await loadCloudInProcessPluginModules()).get(pluginId);
}

export async function resolveCloudInProcessBinding(
  pluginId: string,
  exportId: string,
): Promise<ExecutablePluginBinding | undefined> {
  const registration = await resolveCloudInProcessPlugin(pluginId);
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

/** Model-provider bindings of every in-process first-party plugin. */
export async function listCloudInProcessModelBindings(): Promise<
  ExecutablePluginModelBindingRegistration[]
> {
  const registry = await loadCloudInProcessPluginModules();
  return [...registry.values()].flatMap((entry) => [...entry.modelBindings]);
}

export async function cloudInProcessExportIdempotentSubmit(
  pluginId: string,
  exportId: string,
): Promise<boolean> {
  const registration = await resolveCloudInProcessPlugin(pluginId);
  return registration?.idempotentSubmitExports.includes(exportId) ?? false;
}
