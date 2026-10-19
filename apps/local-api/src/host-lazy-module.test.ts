import { describe, expect, it, vi } from "vitest";

import {
  HOST_LAZY_MODULE_LOAD_FAILED,
  HostLazyModuleLoadError,
  createHostLazyModule,
} from "./host-lazy-module.js";

describe("createHostLazyModule", () => {
  it("imports nothing until first use and shares one import between concurrent callers", async () => {
    let release!: (value: { ready: true }) => void;
    const load = vi.fn(
      () => new Promise<{ ready: true }>((resolve) => (release = resolve)),
    );
    const loadModule = createHostLazyModule("example", load);
    expect(load).not.toHaveBeenCalled();

    const first = loadModule();
    const second = loadModule();
    // The second caller joins the in-flight import instead of starting another one.
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    release({ ready: true });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    await expect(loadModule()).resolves.toBe(a);
    expect(load).toHaveBeenCalledOnce();
  });

  it("fails with one coded error naming the module and replays it without importing again", async () => {
    const cause = new Error("Cannot find module 'sharp'");
    const load = vi.fn(async () => {
      throw cause;
    });
    const loadModule = createHostLazyModule("sharp", load);

    const failure = await loadModule().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostLazyModuleLoadError);
    expect(failure).toMatchObject({
      code: HOST_LAZY_MODULE_LOAD_FAILED,
      module: "sharp",
      detail: cause,
    });
    // Routes that only forward the message still carry the code and the cause.
    expect((failure as Error).message).toContain(HOST_LAZY_MODULE_LOAD_FAILED);
    expect((failure as Error).message).toContain(cause.message);

    await expect(loadModule()).rejects.toBe(failure);
    expect(load).toHaveBeenCalledOnce();
  });

  it("turns a synchronous throw from the loader into the same coded rejection", async () => {
    const loadModule = createHostLazyModule("broken", () => {
      throw new Error("boom");
    });
    await expect(loadModule()).rejects.toMatchObject({
      code: HOST_LAZY_MODULE_LOAD_FAILED,
      module: "broken",
    });
  });
});
