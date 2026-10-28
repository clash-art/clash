import { readFileSync } from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { consolePlugins } from "./registry";
import {
  configureConsolePlugins,
  consolePluginNavItems,
  hasConsolePlugin,
  isBillingPluginEnabled,
  listConsolePlugins,
  resetConsolePlugins,
} from "@clash/web-ui/lib/consolePlugins";

describe("console plugin registry (OSS)", () => {
  beforeEach(() => {
    resetConsolePlugins();
  });

  afterEach(() => {
    resetConsolePlugins();
  });

  it("exports an empty consolePlugins array by default", () => {
    expect(consolePlugins).toEqual([]);
    expect(consolePlugins).toHaveLength(0);
  });

  it("configures no billing chrome when the registry is empty", () => {
    configureConsolePlugins(consolePlugins);
    expect(listConsolePlugins()).toEqual([]);
    expect(hasConsolePlugin("billing")).toBe(false);
    expect(isBillingPluginEnabled()).toBe(false);
    expect(consolePluginNavItems()).toEqual([]);
  });

  it("does not hard-code a billing route in the OSS router", () => {
    const source = readFileSync(new URL("../router.tsx", import.meta.url), "utf8");
    expect(source).toContain("consolePlugins");
    expect(source).toContain("pluginChildRoutes");
    // Hard-coded OSS billing route must be gone (hosted overlay supplies it).
    expect(source).not.toMatch(/path:\s*["']billing["']/);
    expect(source).not.toContain('import("./routes/billing")');
  });

  it("does not leave an always-on OSS billing route module", () => {
    let missing = false;
    try {
      readFileSync(new URL("../routes/billing.tsx", import.meta.url), "utf8");
    } catch {
      missing = true;
    }
    expect(missing).toBe(true);
  });
});
