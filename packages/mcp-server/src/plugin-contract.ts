import type { HostInstallScope } from "@clash/shared-types";
export const PLUGIN_MCP_TOOL_NAMES = [
  "clash_plugin_activate",
  "clash_plugin_checkout",
  "clash_plugin_create",
  "clash_plugin_install",
  "clash_plugin_list",
  "clash_plugin_rollback",
  "clash_plugin_uninstall",
  "clash_plugin_validate",
] as const;

export type PluginMcpToolName = (typeof PLUGIN_MCP_TOOL_NAMES)[number];

export type PluginToolInput = {
  cwd?: string;
  installation?: HostInstallScope;
  directory?: string;
  id?: string;
  name?: string;
  kind?: "action" | "provider-projector" | "provider-executor";
  language?: "ts" | "python";
};

export interface PluginMcpGateway {
  invoke(name: PluginMcpToolName, input: PluginToolInput): Promise<unknown>;
}
