import { afterEach, describe, expect, it } from "vitest";
import {
  configureConsolePlugins,
  consolePluginNavItems,
  hasConsolePlugin,
  isBillingPluginEnabled,
  listConsolePlugins,
  resetConsolePlugins,
} from "./consolePlugins";

describe("consolePlugins runtime bridge", () => {
  afterEach(() => {
    resetConsolePlugins();
  });

  it("starts empty so OSS self-host has no billing chrome", () => {
    expect(listConsolePlugins()).toEqual([]);
    expect(isBillingPluginEnabled()).toBe(false);
    expect(consolePluginNavItems()).toEqual([]);
  });

  it("exposes billing nav after configureConsolePlugins registers the plugin", () => {
    configureConsolePlugins([
      {
        id: "billing",
        navGroups: [
          {
            label: "Account",
            items: [{ to: "/billing", label: "Billing" }],
          },
        ],
      },
    ]);
    expect(hasConsolePlugin("billing")).toBe(true);
    expect(isBillingPluginEnabled()).toBe(true);
    expect(consolePluginNavItems()).toEqual([
      { to: "/billing", label: "Billing", end: undefined },
    ]);
  });
});
