import type { App } from "@modelcontextprotocol/ext-apps";
import type {
  McpProjectRequest,
  McpProjectResponse,
} from "@clash/shared-types";

export async function relayProjectRequest(
  app: Pick<App, "updateModelContext" | "requestDisplayMode">,
  projectId: string,
  value: unknown,
): Promise<McpProjectResponse | undefined> {
  if (!value || typeof value !== "object") return;
  const request = value as Partial<McpProjectRequest>;
  if (
    request.type !== "clash:project-app-request" ||
    request.projectId !== projectId ||
    typeof request.id !== "string" ||
    typeof request.text !== "string" ||
    (request.method !== "context" && request.method !== "close")
  )
    return;
  const response: McpProjectResponse = {
    type: "clash:project-app-response",
    id: request.id,
  };
  try {
    if (request.method === "close") {
      const result = await app.requestDisplayMode({ mode: "inline" });
      if (result.mode !== "inline")
        response.error = "The MCP host did not leave fullscreen.";
      return response;
    }
    const content = [{ type: "text" as const, text: request.text }];
    const result = await app.updateModelContext({ content });
    if ("isError" in result && result.isError === true)
      response.error = "The MCP host did not accept the context update.";
  } catch (error) {
    response.error =
      error instanceof Error ? error.message : "The MCP host is unavailable.";
  }
  return response;
}
