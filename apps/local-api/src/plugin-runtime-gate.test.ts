import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimeGate } from "./plugin-runtime-gate.js";

describe("plugin runtime gate", () => {
  it("shares one start between the post-listen warm-up and a lazy route", async () => {
    let resolveStart!: () => void;
    const start = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const onReady = vi.fn();
    const gate = createPluginRuntimeGate({ start, onReady, onUnavailable: vi.fn() });

    gate.warm();
    const lazy = gate.ensure();
    expect(start).toHaveBeenCalledOnce();

    resolveStart();
    await lazy;
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    await expect(gate.ensure()).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledOnce();
  });

  it("reports one coded 503 error and replays it instead of retrying", async () => {
    const cause = new Error("bundled plugin payload is corrupt");
    const start = vi.fn(async () => {
      throw cause;
    });
    const onUnavailable = vi.fn();
    const gate = createPluginRuntimeGate({ start, onUnavailable });

    gate.warm();
    const first = gate.ensure();
    await expect(first).rejects.toMatchObject({
      name: "PluginRuntimeUnavailableError",
      code: "PLUGIN_RUNTIME_UNAVAILABLE",
      message: expect.stringContaining("bundled plugin payload is corrupt"),
    });
    await expect(gate.ensure()).rejects.toMatchObject({
      code: "PLUGIN_RUNTIME_UNAVAILABLE",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PLUGIN_RUNTIME_UNAVAILABLE" }),
      cause,
    );
  });
});
