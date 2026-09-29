import { resolve } from "node:path";

import {
  activateExecutablePluginDraft,
  assertDraftOutsideManagedStorage,
  checkoutExecutablePluginDraft,
  createLocalPluginHostRequest,
  rollbackDownloadedActionPackage,
  scaffoldExecutablePluginDraft,
  tryInstallLocalMarketplacePlugin,
  validateExecutablePluginDraft,
} from "@clash/cli/plugin";
import type {
  PluginMcpGateway,
  PluginMcpToolName,
  PluginToolInput,
} from "@clash/mcp-server";
import { pluginIdSchema } from "@clash/shared-types";
import { resolveProjectHostContext, type ProjectHostConnection } from "@clash/shared-runtime/project-host-client";

type PluginConnectionClient = {
  resolveConnection?(): Promise<ProjectHostConnection>;
};

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function draftPath(input: PluginToolInput): string {
  const directory = requiredString(input.directory, "Plugin draft directory");
  const cwd =
    input.cwd?.trim() || process.env.CLASH_WORKSPACE_ROOT || process.cwd();
  return resolve(cwd, directory);
}

export function createPluginMcpGateway(options: {
  client: PluginConnectionClient;
  request?: typeof fetch;
}): PluginMcpGateway {
  const request = options.request ?? fetch;
  const connection = async () => {
    if (!options.client.resolveConnection) {
      throw new Error(
        "The Clash plugin lifecycle requires a resolvable local Host connection.",
      );
    }
    const resolved = await options.client.resolveConnection();
    return {
      resolved,
      hostRequest: createLocalPluginHostRequest({
        serverUrl: resolved.endpoint,
        ...(resolved.token ? { apiKey: resolved.token } : {}),
        request,
      }),
    };
  };

  return {
    async invoke(
      name: PluginMcpToolName,
      input: PluginToolInput,
    ): Promise<unknown> {
      const { resolved, hostRequest } = await connection();
      switch (name) {
        case "clash_plugin_create": {
          const pluginDir = draftPath(input);
          assertDraftOutsideManagedStorage(pluginDir);
          const created = await scaffoldExecutablePluginDraft({
            pluginDir,
            id: requiredString(input.id, "Plugin id"),
            ...(input.name ? { name: input.name } : {}),
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.language ? { language: input.language } : {}),
            hostRequest,
          });
          return {
            created: true,
            path: created.pluginDir,
            manifest: created.manifestPath,
            card: created.cardPath,
            contract: created.contractTestPath,
            contractTests: created.contractTests,
          };
        }
        case "clash_plugin_checkout": {
          const pluginDir = draftPath(input);
          assertDraftOutsideManagedStorage(pluginDir);
          const checkedOut = await checkoutExecutablePluginDraft({
            id: requiredString(input.id, "Plugin id"),
            pluginDir,
            hostRequest,
          });
          return { checkedOut: true, ...checkedOut };
        }
        case "clash_plugin_validate": {
          const pluginDir = draftPath(input);
          assertDraftOutsideManagedStorage(pluginDir);
          const validated = await validateExecutablePluginDraft(
            pluginDir,
            hostRequest,
          );
          return {
            valid: true,
            id: validated.package.id,
            version: validated.package.manifest.version ?? "0.0.0",
            path: pluginDir,
            contractTests: validated.contractTests,
          };
        }
        case "clash_plugin_activate": {
          const pluginDir = draftPath(input);
          assertDraftOutsideManagedStorage(pluginDir);
          const activated = await activateExecutablePluginDraft({
            pluginDir,
            hostRequest,
          });
          return {
            activated: true,
            id: activated.id,
            version: activated.version,
            path: activated.targetDir,
            rollbackPath: activated.rollbackDir,
            contractTests: activated.contractTests,
          };
        }
        case "clash_plugin_install": {
          const packageId = requiredString(input.id, "Marketplace plugin id");
          const installed = await tryInstallLocalMarketplacePlugin({
            packageId,
            installation: input.installation ?? { scope: "projects", projectIds: [(await resolveProjectHostContext({ cwd: input.cwd })).projectId] },
            serverUrl: resolved.endpoint,
            ...(resolved.token ? { apiKey: resolved.token } : {}),
            request,
          });
          if (!installed)
            throw new Error(`Unknown marketplace plugin: ${packageId}`);
          return installed;
        }
        case "clash_plugin_list":
          return hostRequest("/api/v1/local/plugins");
        case "clash_plugin_rollback": {
          const id = pluginIdSchema.parse(
            requiredString(input.id, "Plugin id"),
          );
          const restored = await rollbackDownloadedActionPackage(
            id,
            hostRequest,
          );
          return { rolledBack: true, id, ...restored };
        }
        case "clash_plugin_uninstall": {
          const id = pluginIdSchema.parse(
            requiredString(input.id, "Plugin id"),
          );
          const removed = await hostRequest<{
            id: string;
            removed: boolean;
            trashDir?: string;
          }>(`/api/v1/local/plugins/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          return { uninstalled: removed.removed, ...removed };
        }
      }
    },
  };
}
