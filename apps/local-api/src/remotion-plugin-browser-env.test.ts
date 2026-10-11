import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { credentialFreePluginEnv } from "./runtime/host/lib/actions-loader.js";

describe("Remotion plugin browser environment", () => {
  it("gives the renderer the Host's browser cache without handing it CLASH_HOME", () => {
    const env = credentialFreePluginEnv(
      { id: "clash.remotion", version: "0.1.0" },
      { PATH: "/bin", CLASH_HOME: "/tmp/clash-home" },
    );

    expect(env.CLASH_BROWSER_CACHE_DIR).toBe(
      resolve("/tmp/clash-home", "cache", "browser"),
    );
    expect(env).not.toHaveProperty("CLASH_HOME");
    expect(env).not.toHaveProperty("CLASH_BROWSER_EXECUTABLE");
  });

  it("forwards explicit browser overrides", () => {
    const env = credentialFreePluginEnv(
      { id: "clash.remotion", version: "0.1.0" },
      {
        CLASH_BROWSER_CACHE_DIR: "/var/cache/clash-browser",
        CLASH_BROWSER_EXECUTABLE: "/usr/bin/chromium",
      },
    );

    expect(env.CLASH_BROWSER_CACHE_DIR).toBe(resolve("/var/cache/clash-browser"));
    expect(env.CLASH_BROWSER_EXECUTABLE).toBe(resolve("/usr/bin/chromium"));
  });

  it("does not expose browser configuration to another plugin", () => {
    const env = credentialFreePluginEnv(
      { id: "third.party", version: "1.0.0" },
      { CLASH_HOME: "/tmp/clash-home", CLASH_BROWSER_EXECUTABLE: "/usr/bin/chromium" },
    );

    expect(env).not.toHaveProperty("CLASH_BROWSER_CACHE_DIR");
    expect(env).not.toHaveProperty("CLASH_BROWSER_EXECUTABLE");
  });
});
