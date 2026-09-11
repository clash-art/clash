import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { ProjectHostClient } from "@clash/shared-runtime/project-host-client";
import { z } from "zod";
import { describeClashTool } from "@clash/shared-mcp";

export const PROJECT_APP_RESOURCE_URI = "ui://clash/project";

export type ProjectAppOptions = {
  /** Origin of the existing Clash web renderer, configured for the same Host. */
  webUrl: string | (() => Promise<string>);
  bundledJavascript: string;
};

export function projectAppOrigin(webUrl: string): string {
  const url = new URL(webUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "CLASH_WEB_URL must be an HTTP(S) origin without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

export function createProjectAppHtml(
  javascript: string,
  origin: string,
): string {
  const config = JSON.stringify(origin).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clash Project</title><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
body{font:14px system-ui;color:var(--color-text-primary,#242424);background:var(--color-background-primary,#fafafa)}
main{padding:24px;min-height:180px}h1{font-size:18px;margin:0 0 12px}p{line-height:1.5}
button{font:inherit;min-height:40px;padding:8px 16px;cursor:pointer}button:focus-visible{outline:2px solid #ef4444;outline-offset:3px}
iframe{display:block;border:0;width:100%;height:100dvh}[hidden]{display:none!important}
</style></head><body>
<main id="launcher"><h1>Clash Project</h1><p id="status" role="status">Connecting to the MCP host…</p>
<button id="fullscreen" hidden>Open project fullscreen</button></main>
<iframe id="project" title="Clash project editor" hidden allow="autoplay; fullscreen; clipboard-read; clipboard-write" allowfullscreen></iframe>
<script id="project-origin" type="application/json">${config}</script>
<script type="module">${javascript.replace(/<\/script/gi, "<\\/script")}</script>
</body></html>`;
}

export function registerProjectApp(
  server: Pick<McpServer, "registerTool" | "registerResource">,
  client: Pick<ProjectHostClient, "resolveContext">,
  options: ProjectAppOptions,
): void {
  const resolveOrigin = async () =>
    projectAppOrigin(
      typeof options.webUrl === "function"
        ? await options.webUrl()
        : options.webUrl,
    );
  registerAppTool(
    server,
    "clash_project_open",
    {
      title: "Open Clash project",
      description: describeClashTool({
        useWhen:
          "a person wants to edit a Clash project in a fullscreen MCP App",
        effect:
          "opens the existing project page with its canvas, assets, timeline and editing tools; opening does not mutate the project",
        returns: "the workspace-resolved project ID and its web renderer URL",
        next: "edit in the fullscreen App; the configured Clash web renderer must use the same local Host",
      }),
      inputSchema: {
        cwd: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Absolute linked workspace directory"),
        projectId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Project to open; defaults to the workspace marker"),
      },
      annotations: { readOnlyHint: true },
      _meta: {
        ui: {
          resourceUri: PROJECT_APP_RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async (input) => {
      try {
        const { projectId } = await client.resolveContext(input);
        const origin = await resolveOrigin();
        const projectUrl = `${origin}/projects/${encodeURIComponent(projectId)}`;
        return {
          content: [
            {
              type: "text" as const,
              text: `Open Clash project ${projectId}: ${projectUrl}`,
            },
          ],
          structuredContent: { projectId, projectUrl },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );
  registerAppResource(
    server,
    "Clash Project",
    PROJECT_APP_RESOURCE_URI,
    {
      description: "The existing Clash project page in fullscreen",
    },
    async () => {
      const origin = await resolveOrigin();
      return {
        contents: [
          {
            uri: PROJECT_APP_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: createProjectAppHtml(options.bundledJavascript, origin),
            _meta: {
              ui: { prefersBorder: false, csp: { frameDomains: [origin] } },
            },
          },
        ],
      };
    },
  );
}
