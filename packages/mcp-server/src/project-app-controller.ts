import type { App } from "@modelcontextprotocol/ext-apps";

export type ProjectAppState = {
  projectUrl?: string;
  fullscreen: boolean;
  canFullscreen: boolean;
  status: string;
};

type ProjectAppHost = Pick<
  App,
  | "connect"
  | "getHostContext"
  | "requestDisplayMode"
  | "ontoolresult"
  | "onhostcontextchanged"
  | "onerror"
>;

export async function connectProjectApp(
  app: ProjectAppHost,
  origin: string,
  render: (state: ProjectAppState) => void,
): Promise<{ openFullscreen(): Promise<void> }> {
  let connected = false;
  let autoOpened = false;
  let requesting = false;
  let state: ProjectAppState = {
    fullscreen: false,
    canFullscreen: false,
    status: "Waiting for the project…",
  };
  const update = (next: Partial<ProjectAppState>) => {
    state = { ...state, ...next };
    render(state);
  };
  const openFullscreen = async () => {
    if (!connected || !state.projectUrl || requesting) return;
    if (!state.canFullscreen) {
      update({
        status:
          "This MCP host does not support fullscreen. Open the project using the link in the tool result.",
      });
      return;
    }
    requesting = true;
    try {
      const result = await app.requestDisplayMode({ mode: "fullscreen" });
      update({
        fullscreen: result.mode === "fullscreen",
        status:
          result.mode === "fullscreen"
            ? ""
            : "Fullscreen was not granted. Try opening the project again.",
      });
    } catch {
      update({
        fullscreen: false,
        status:
          "Could not open fullscreen. Try again or use the project link in the tool result.",
      });
    } finally {
      requesting = false;
    }
  };
  const autoOpen = () => {
    if (connected && state.projectUrl && !autoOpened) {
      autoOpened = true;
      if (!state.fullscreen) void openFullscreen();
    }
  };
  app.ontoolresult = (result) => {
    if (result.isError) {
      update({
        status:
          "Could not resolve the project. Check the tool result and open it again.",
      });
      return;
    }
    const payload = result.structuredContent;
    if (
      !payload ||
      typeof payload.projectId !== "string" ||
      typeof payload.projectUrl !== "string"
    )
      return;
    // Only the server-configured renderer and the resolved project route may
    // load here. A tool result cannot broaden the resource's frame policy.
    const expected = `${origin}/projects/${encodeURIComponent(payload.projectId)}`;
    if (payload.projectUrl !== expected) {
      update({
        status: "The project URL does not match the configured Clash renderer.",
      });
      return;
    }
    update({
      projectUrl: expected,
      status: "Open this project fullscreen to edit.",
    });
    autoOpen();
  };
  app.onhostcontextchanged = (context) => {
    update({
      ...(context.displayMode
        ? {
            fullscreen: context.displayMode === "fullscreen",
            status: "Open this project fullscreen to continue editing.",
          }
        : {}),
      ...(context.availableDisplayModes
        ? {
            canFullscreen: context.availableDisplayModes.includes("fullscreen"),
          }
        : {}),
    });
  };
  app.onerror = () =>
    update({
      status:
        "The MCP connection failed. Reopen the project from the conversation.",
    });
  try {
    await app.connect();
    connected = true;
    const context = app.getHostContext();
    update({
      fullscreen: context?.displayMode === "fullscreen",
      canFullscreen:
        context?.availableDisplayModes?.includes("fullscreen") ?? false,
    });
    autoOpen();
  } catch {
    update({
      status:
        "Could not connect to the MCP host. Reopen the project from the conversation.",
    });
  }
  return { openFullscreen };
}
