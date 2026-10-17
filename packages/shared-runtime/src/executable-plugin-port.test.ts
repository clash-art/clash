import { describe, expect, it } from "vitest";

import type { PluginExecutionBinding } from "./executable-plugin-port.js";

describe("plugin execution port contract", () => {
  it("keeps remote as an explicit binding instead of a hidden fallback", () => {
    const remote: PluginExecutionBinding = {
      kind: "remote",
      pluginId: "example.third-party",
      version: "1.0.0",
      schemaHash: `sha256:${"a".repeat(64)}`,
      exportId: "execute",
      endpoint: "https://plugins.example.com/invoke",
      secretId: "plugin-secret",
    };
    expect(remote.kind).toBe("remote");
  });
});
