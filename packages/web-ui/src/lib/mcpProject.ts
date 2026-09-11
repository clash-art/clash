import type {
  McpProjectRequest,
  McpProjectResponse,
} from "@clash/shared-types";

declare global {
  var __CLASH_MCP_APP__: boolean | undefined;
}

export function isMcpProjectApp(): boolean {
  return globalThis.__CLASH_MCP_APP__ === true;
}

/** Context and display mode go to the MCP host, never /agents or ACP. */
export function sendMcpProjectRequest(
  projectId: string,
  method: McpProjectRequest["method"],
  text: string,
): Promise<void> {
  if (!isMcpProjectApp() || window.parent === window) {
    return Promise.reject(
      new Error(
        "Open this project inside its MCP App to use the host conversation.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const id = crypto.randomUUID();
    const close = () => {
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
    };
    const timeout = setTimeout(() => {
      close();
      reject(new Error("The MCP host did not respond."));
    }, 15000);
    channel.port1.onmessage = (event: MessageEvent<McpProjectResponse>) => {
      const reply = event.data;
      if (reply?.type !== "clash:project-app-response" || reply.id !== id)
        return;
      close();
      if (reply.error) reject(new Error(reply.error));
      else resolve();
    };
    const request: McpProjectRequest = {
      type: "clash:project-app-request",
      id,
      projectId,
      method,
      text,
    };
    // The private reply port prevents other windows from spoofing completion.
    // The MCP resource validates this frame's Window, origin and project ID.
    window.parent.postMessage(request, "*", [channel.port2]);
  });
}
