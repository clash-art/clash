import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClashMcpServer } from "@clash/mcp-server/server";
import { registerProjectApp, type PluginMcpGateway } from "@clash/mcp-server";
import { createTimelineAdapter } from "@clash/timeline-plugin/adapter";
import { registerTimelinePluginMcp } from "@clash/timeline-plugin/server";
import { createDirectorAdapter } from "@clash/director-plugin/adapter";
import { registerDirectorPluginMcp } from "@clash/director-plugin/server";
import type { ProjectHostClient } from "@clash/shared-runtime/project-host-client";
import { createMcpProjectHostClient } from "./host-runner.js";
import {
  createPluginHostManager,
  type PluginHostManager,
} from "./plugin-host.js";
import { createPluginMcpGateway } from "./plugin-mcp-gateway.js";

export type ClashPluginAppBundles = {
  project: string;
  studio: string;
  canvas: string;
  timeline: string;
  director: string;
};

function bundledApp(name: keyof ClashPluginAppBundles): string {
  return readFileSync(
    new URL(`./${name}-app-client.js`, import.meta.url),
    "utf8",
  );
}

export type ClashPluginServerOptions = {
  client?: ProjectHostClient;
  hostManager?: PluginHostManager;
  appBundles?: ClashPluginAppBundles;
  pluginGateway?: PluginMcpGateway;
};

// Legacy miniature Apps remain quarantined. The project App below reuses
// the complete existing editor as the single interactive surface.
const MCP_APP_SURFACES_ENABLED = false;

function composeClashPluginServer(
  client: ProjectHostClient,
  bundles: ClashPluginAppBundles,
  pluginGateway: PluginMcpGateway,
): McpServer {
  const server = createClashMcpServer({
    client,
    bundledAppJavascript: bundles.canvas,
    bundledStudioAppJavascript: bundles.studio,
    appSurfaces: MCP_APP_SURFACES_ENABLED,
    pluginGateway,
  });
  registerProjectApp(server, client, {
    webUrl: async () => {
      const explicit = process.env.CLASH_WEB_URL?.trim();
      if (explicit) return explicit;
      if (!client.resolveConnection)
        throw new Error(
          "The project App requires a discoverable local daemon.",
        );
      return (await client.resolveConnection()).endpoint;
    },
    bundledJavascript: bundles.project,
  });
  registerTimelinePluginMcp(
    server,
    createTimelineAdapter({ client }),
    bundles.timeline,
    { appSurfaces: MCP_APP_SURFACES_ENABLED },
  );
  registerDirectorPluginMcp(
    server,
    createDirectorAdapter({ client }),
    bundles.director,
    { appSurfaces: MCP_APP_SURFACES_ENABLED },
  );
  return server;
}

export function createClashPluginRuntime(
  options: ClashPluginServerOptions = {},
): {
  server: McpServer;
  hostManager?: PluginHostManager;
  close(): Promise<void>;
  closeHost(): Promise<void>;
} {
  const hostManager =
    options.hostManager ??
    (options.client ? undefined : createPluginHostManager());
  const client = options.client ?? createMcpProjectHostClient({ hostManager });
  const bundles = options.appBundles ?? {
    project: bundledApp("project"),
    studio: bundledApp("studio"),
    canvas: bundledApp("canvas"),
    timeline: bundledApp("timeline"),
    director: bundledApp("director"),
  };
  const server = composeClashPluginServer(
    client,
    bundles,
    options.pluginGateway ?? createPluginMcpGateway({ client }),
  );
  const originalClose = server.close.bind(server);
  let closingHost: Promise<void> | undefined;
  let closingRuntime: Promise<void> | undefined;
  const closeHost = () => {
    closingHost ??= hostManager?.close() ?? Promise.resolve();
    return closingHost;
  };
  const close = () => {
    closingRuntime ??= (async () => {
      try {
        await originalClose();
      } finally {
        await closeHost();
      }
    })();
    return closingRuntime;
  };
  server.close = close;
  return { server, hostManager, close, closeHost };
}

export function createClashPluginServer(
  options: ClashPluginServerOptions = {},
): McpServer {
  return createClashPluginRuntime(options).server;
}

export async function serveClashPluginStdio(
  options: ClashPluginServerOptions = {},
): Promise<void> {
  const runtime = createClashPluginRuntime(options);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void runtime.closeHost();
  };
  const shutdown = () => {
    void runtime.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await runtime.server.connect(transport);
}
