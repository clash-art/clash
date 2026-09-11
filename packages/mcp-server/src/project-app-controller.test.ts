import test from "node:test";
import assert from "node:assert/strict";
import type { App } from "@modelcontextprotocol/ext-apps";

test("project view waits for host fullscreen, preserves the editor on exit and can reopen", async () => {
  const module = await import("./project-app-controller").catch(() => ({}));
  assert.ok("connectProjectApp" in module, "project App controller is missing");
  const { connectProjectApp } =
    module as typeof import("./project-app-controller");
  let resolveMode!: (value: { mode: "fullscreen" }) => void;
  const host = {
    connect: async () => {},
    getHostContext: () => ({
      availableDisplayModes: ["inline", "fullscreen"],
      displayMode: "inline",
    }),
    requestDisplayMode: () =>
      new Promise<{ mode: "fullscreen" }>((resolve) => {
        resolveMode = resolve;
      }),
  };
  let state: any;
  const controller = await connectProjectApp(
    host as unknown as App,
    "http://localhost:3456",
    (next) => {
      state = next;
    },
  );
  (host as unknown as App).ontoolresult!({
    structuredContent: {
      projectId: "demo",
      projectUrl: "http://localhost:3456/projects/demo",
    },
    content: [],
  });
  assert.equal(state.fullscreen, false);
  resolveMode({ mode: "fullscreen" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.fullscreen, true);
  assert.equal(state.projectUrl, "http://localhost:3456/projects/demo");
  (host as unknown as App).onhostcontextchanged!({ displayMode: "inline" });
  assert.equal(state.fullscreen, false);
  assert.equal(state.projectUrl, "http://localhost:3456/projects/demo");
  const reopening = controller.openFullscreen();
  resolveMode({ mode: "fullscreen" });
  await reopening;
  assert.equal(state.fullscreen, true);
});

test("fullscreen refusal and unexpected project URLs stay in the launcher", async () => {
  const { connectProjectApp } = await import("./project-app-controller");
  const host = {
    connect: async () => {},
    getHostContext: () => ({
      availableDisplayModes: ["inline"],
      displayMode: "inline",
    }),
    requestDisplayMode: async () => {
      throw new Error("must not request unsupported mode");
    },
  };
  let state: any;
  await connectProjectApp(
    host as unknown as App,
    "https://clash.example",
    (next) => {
      state = next;
    },
  );
  (host as unknown as App).ontoolresult!({
    structuredContent: {
      projectId: "demo",
      projectUrl: "https://attacker.example/projects/demo",
    },
    content: [],
  });
  assert.equal(state.projectUrl, undefined);
  assert.equal(state.fullscreen, false);
  (host as unknown as App).ontoolresult!({
    structuredContent: {
      projectId: "demo",
      projectUrl: "https://clash.example/projects/demo",
    },
    content: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.canFullscreen, false);
  assert.equal(state.fullscreen, false);
  assert.match(state.status, /fullscreen/i);
});
