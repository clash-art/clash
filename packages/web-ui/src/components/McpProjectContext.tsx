import { useEffect } from "react";
import { sendMcpProjectRequest } from "../lib/mcpProject";

/** Supplies selection context to the native host without any agent GUI. */
export function McpProjectContext({
  projectId,
  context,
}: {
  projectId: string;
  context: string;
}) {
  useEffect(() => {
    const timer = setTimeout(() => {
      void sendMcpProjectRequest(projectId, "context", context).catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  }, [projectId, context]);
  return null;
}
