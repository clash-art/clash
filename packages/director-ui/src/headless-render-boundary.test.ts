import { describe, expect, it, vi } from "vitest";

describe("Director headless render boundary", () => {
  it("publishes a frame only after the product WebGL renderer draws it", async () => {
    const module = await import("./headless-render-boundary").catch(() => ({})) as Record<string, unknown>;
    expect(typeof module.renderDirectorFrameNow).toBe("function");

    const order: string[] = [];
    const render = vi.fn(() => order.push("render"));
    const publish = vi.fn(() => order.push("publish"));
    (module.renderDirectorFrameNow as (input: Record<string, unknown>) => void)({
      renderer: { render },
      scene: { id: "scene" },
      camera: { id: "camera" },
      timeSeconds: 1.25,
      canvas: { width: 1080, height: 1920 },
      publish,
    });

    expect(render).toHaveBeenCalledWith({ id: "scene" }, { id: "camera" });
    expect(publish).toHaveBeenCalledWith({
      timeSeconds: 1.25,
      canvas: { width: 1080, height: 1920 },
    });
    expect(order).toEqual(["render", "publish"]);
  });

  it("holds first publication until resources and scene effects stay settled", async () => {
    const module = await import("./headless-render-boundary") as Record<string, any>;
    expect(typeof module.createDirectorFramePublicationGate).toBe("function");
    const gate = module.createDirectorFramePublicationGate(8);

    expect(Array.from({ length: 7 }, () => gate.tick(false))).toEqual([
      false, false, false, false, false, false, false,
    ]);
    expect(gate.tick(false)).toBe(true);
    expect(gate.tick(false)).toBe(false);

    gate.reset();
    expect(gate.tick(false)).toBe(false);
    expect(gate.tick(true)).toBe(false);
    expect(Array.from({ length: 7 }, () => gate.tick(false))).toEqual([
      false, false, false, false, false, false, false,
    ]);
    expect(gate.tick(false)).toBe(true);
  });

  it("stops drawing once the frame is published, and resumes after a reset", async () => {
    const {
      createDirectorFramePublicationGate,
      renderDirectorPublicationFrame,
    } = await import("./headless-render-boundary");
    const gate = createDirectorFramePublicationGate(3);
    const render = vi.fn();
    const publish = vi.fn();
    const canvas = { width: 4096, height: 2304 } as HTMLCanvasElement;
    const tick = (resourcesActive = false) =>
      renderDirectorPublicationFrame({
        gate,
        resourcesActive,
        renderer: { render },
        scene: "scene",
        camera: "camera",
        timeSeconds: 2,
        canvas,
        publish,
      });

    // Loading resources keep the loop drawing without counting towards the settle frames.
    tick(true);
    tick();
    tick();
    expect(render).toHaveBeenCalledTimes(3);
    expect(publish).not.toHaveBeenCalled();
    expect(gate.published()).toBe(false);

    // The third settled frame is drawn, then drawn once more for publication.
    tick();
    expect(render).toHaveBeenCalledTimes(5);
    expect(render).toHaveBeenLastCalledWith("scene", "camera");
    expect(publish.mock.calls).toEqual([[{ timeSeconds: 2, canvas }]]);
    expect(gate.published()).toBe(true);

    // However long the animation loop keeps ticking, nothing more reaches the GPU.
    for (let frame = 0; frame < 50; frame += 1) tick();
    expect(render).toHaveBeenCalledTimes(5);
    expect(publish).toHaveBeenCalledOnce();

    gate.reset();
    expect(gate.published()).toBe(false);
    tick();
    expect(render).toHaveBeenCalledTimes(6);
  });

  it("allows a capture one minute up to 1920x1080 and proportionally longer above it", async () => {
    const { directorCaptureTimeoutMs } = await import("./headless-render-boundary");
    const base = directorCaptureTimeoutMs(1920, 1080);

    expect(directorCaptureTimeoutMs(256, 144)).toBe(base);
    expect(directorCaptureTimeoutMs(1080, 1920)).toBe(base);
    expect(directorCaptureTimeoutMs(3840, 2160)).toBe(base * 4);
    expect(directorCaptureTimeoutMs(1920, 2160)).toBe(base * 2);
    // The largest supported frame gets more than four times the base, not the base.
    expect(directorCaptureTimeoutMs(4096, 2304)).toBeGreaterThan(base * 4);
  });
});
