/** Private iframe transport. Public agent interactions use the MCP Apps SDK. */
export type McpProjectRequest = {
  type: "clash:project-app-request";
  id: string;
  projectId: string;
  method: "context" | "close";
  text: string;
};
export type McpProjectResponse = {
  type: "clash:project-app-response";
  id: string;
  error?: string;
};
