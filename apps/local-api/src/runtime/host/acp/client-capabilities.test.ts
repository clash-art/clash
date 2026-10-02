import { describe, expect, it } from "vitest";
import { withClashAcpExtensionCapabilities } from "./client-capabilities.js";

describe("withClashAcpExtensionCapabilities", () => {
  it("advertises only client features Clash can actually render", () => {
    expect(withClashAcpExtensionCapabilities({
      auth: { terminal: true },
      _meta: { existingCapability: true },
    } as any)).toEqual({
      auth: { terminal: true },
      session: {
        configOptions: {
          boolean: {},
        },
      },
      _meta: {
        existingCapability: true,
        "terminal-auth": true,
        terminal_output: true,
        parameterizedModelPicker: true,
      },
    });
  });

  it("preserves future session capabilities while advertising boolean config controls", () => {
    expect(withClashAcpExtensionCapabilities({
      session: {
        configOptions: {
          custom: { supported: true },
        },
      },
    } as any)).toMatchObject({
      session: {
        configOptions: {
          boolean: {},
          custom: { supported: true },
        },
      },
    });
  });
});
