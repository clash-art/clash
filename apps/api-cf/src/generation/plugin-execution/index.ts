import type { PluginExecutionPort } from "@clash/shared-runtime/executable-plugin-port";
import type { ExecutablePluginBinding } from "@clash/shared-types/executable-plugin";

import type { Env } from "../../config";
import {
  createCloudExecutorContext,
  type CloudPluginExecutionOptions,
} from "./context";
import { createInProcessPluginExecution } from "./in-process";
import {
  CLOUD_IN_PROCESS_PLUGIN_IDS,
  loadCloudInProcessPluginModules,
  resolveCloudInProcessBinding,
} from "./registry";

export { CLOUD_IN_PROCESS_PLUGIN_IDS };

export async function resolveCloudPluginBinding(
  pluginId: string,
  exportId: string,
): Promise<ExecutablePluginBinding | undefined> {
  return resolveCloudInProcessBinding(pluginId, exportId);
}

/** Composition root for the Cloudflare adapter's in-process plugin binding. */
export async function createCloudPluginExecution(
  env: Env,
  options: CloudPluginExecutionOptions = {},
): Promise<PluginExecutionPort> {
  const registrations = await loadCloudInProcessPluginModules();
  return createInProcessPluginExecution({
    modules: new Map(
      [...registrations].map(([pluginId, registration]) => [
        pluginId,
        registration.module,
      ]),
    ),
    context: (request) =>
      createCloudExecutorContext(env, options.run ?? (request.run as never), options),
  });
}
