import { App } from "@modelcontextprotocol/ext-apps";
import { relayProjectRequest } from "./project-app-native";
import { connectProjectApp } from "./project-app-controller";

const launcher = document.getElementById("launcher")!;
const status = document.getElementById("status")!;
const button = document.getElementById("fullscreen") as HTMLButtonElement;
const frame = document.getElementById("project") as HTMLIFrameElement;
const origin = JSON.parse(
  document.getElementById("project-origin")!.textContent!,
) as string;
const app = new App(
  { name: "Clash Project", version: "0.1.0" },
  { availableDisplayModes: ["inline", "fullscreen"] },
  { autoResize: false },
);
let activeProjectId: string | undefined;
const controller = await connectProjectApp(app, origin, (state) => {
  if (state.projectUrl)
    activeProjectId = decodeURIComponent(
      new URL(state.projectUrl).pathname.slice("/projects/".length),
    );
  const showEditor = state.fullscreen && !!state.projectUrl;
  // Never remount or reset src when the host exits fullscreen: unsaved editor
  // state and the existing Loro connection belong to the project page.
  if (showEditor && frame.getAttribute("src") !== state.projectUrl)
    frame.src = state.projectUrl!;
  frame.hidden = !showEditor;
  launcher.hidden = showEditor;
  status.textContent = state.status;
  button.hidden = !state.projectUrl || !state.canFullscreen;
});
button.addEventListener("click", () => void controller.openFullscreen());

// A transferred port carries the response only to the requesting project
// frame. Neither arbitrary parent windows nor other projects can invoke this.
window.addEventListener("message", (event: MessageEvent) => {
  if (
    event.source !== frame.contentWindow ||
    event.origin !== origin ||
    !activeProjectId
  )
    return;
  const port = event.ports[0];
  if (!port) return;
  void relayProjectRequest(app, activeProjectId, event.data).then(
    (response) => {
      if (response) port.postMessage(response);
      port.close();
    },
  );
});
