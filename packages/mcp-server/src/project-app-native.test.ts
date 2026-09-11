import test from "node:test";
import assert from "node:assert/strict";

test("project context reaches the host without exposing a custom conversation API", async () => {
  const { relayProjectRequest } = await import("./project-app-native");
  let context: unknown;
  const host = {
    requestDisplayMode: async () => ({ mode: "inline" as const }),
    updateModelContext: async (value: unknown) => {
      context = value;
      return {};
    },
  };
  const request = {
    type: "clash:project-app-request",
    id: "context",
    projectId: "p",
    method: "context",
    text: "Selected clip n2",
  };
  await relayProjectRequest(host, "p", request);
  assert.deepEqual(context, {
    content: [{ type: "text", text: request.text }],
  });
  assert.equal(await relayProjectRequest(host, "other", request), undefined);
  assert.equal(
    await relayProjectRequest(host, "p", { ...request, method: "message" }),
    undefined,
  );
});

test("returning from the project asks the host for inline mode instead of navigating to a dashboard", async () => {
  const { relayProjectRequest } = await import("./project-app-native");
  let mode = "fullscreen";
  const result = await relayProjectRequest(
    {
      updateModelContext: async () => ({}),
      requestDisplayMode: async (request: { mode: string }) => {
        mode = request.mode;
        return { mode: "inline" as const };
      },
    },
    "p",
    {
      type: "clash:project-app-request",
      id: "back",
      projectId: "p",
      method: "close",
      text: "",
    },
  );
  assert.ok(result);
  assert.equal(mode, "inline");
});
