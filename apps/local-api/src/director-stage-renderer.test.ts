import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const state = {
  schemaVersion: 1 as const,
  scene: { backgroundColor: "#171816", grid: { visible: true, snap: false, size: 1 } },
  objects: [],
  cameras: [{
    id: "camera-a",
    name: "Camera A",
    position: [0, 1.6, 5] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    fov: 50,
  }],
  shots: [],
  activeCameraId: "camera-a",
};

describe("daemon-owned Director Stage renderer", () => {
  it("renders exact-time PNGs through the packaged DirectorViewport browser surface", async () => {
    const module = await import("./director-stage-renderer").catch(() => ({})) as Record<string, any>;
    expect(typeof module.createHeadlessDirectorStageRenderer).toBe("function");

    const runtimeRoot = await mkdtemp(join(tmpdir(), "clash-director-renderer-"));
    const bundleDir = join(runtimeRoot, "director-bundle");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "index.html"), "<script type=module src=./index.js></script>");
    await writeFile(join(bundleDir, "index.js"), "window.__CLASH_DIRECTOR_CAPTURE__=true");

    const evaluate = vi.fn(async (_fn: unknown, input: any): Promise<unknown> => input === undefined ? true : ({
      dataUrl: "data:image/png;base64,AQID",
      width: input.longEdge,
      height: Math.round(input.longEdge * 9 / 16),
      activeCameraId: "camera-a",
    }));
    const page = {
      goto: vi.fn(async () => null),
      evaluate,
      close: vi.fn(async () => undefined),
    };
    const browser = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    };
    const prepareBundle = vi.fn(async () => undefined);
    const renderer = module.createHeadlessDirectorStageRenderer({
      bundleDir,
      prepareBundle,
      openBrowser: vi.fn(async () => browser),
    });

    const result = await renderer.render({
      state,
      longEdge: 1280,
      frames: [
        { label: "frame-opening", timeSeconds: 0, aspectRatio: "16:9" },
        { label: "frame-action", timeSeconds: 1.25, aspectRatio: "16:9" },
      ],
    });

    expect(result.renderer).toEqual({
      id: "clash-director-viewport-webgl",
      contractVersion: 1,
    });
    expect(result.frames).toHaveLength(2);
    expect(result.frames[1]).toMatchObject({
      label: "frame-action",
      timeSeconds: 1.25,
      width: 1280,
      height: 720,
      activeCameraId: "camera-a",
      mimeType: "image/png",
      dataBase64: "AQID",
    });
    expect(result.frames[1]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    // Call 1 is the WebGL2 probe; calls 2 and 3 are the frames.
    expect(evaluate).toHaveBeenNthCalledWith(3, expect.any(Function), expect.objectContaining({
      timeSeconds: 1.25,
      state,
    }));
    expect(prepareBundle).toHaveBeenCalledOnce();

    await renderer.dispose();
    expect(browser.close).toHaveBeenCalledOnce();
  });
});

describe("Director capture browser GL backend", () => {
  const frames = [{ label: "frame", timeSeconds: 0, aspectRatio: "16:9" as const }];

  /** A browser whose pages answer the WebGL2 probe with `webgl2` and captures with a PNG. */
  function fakeBrowser(webgl2: boolean | Error) {
    const pages: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    // Runs the renderer's own probe against the one DOM call it makes.
    const probe = vi.fn(async (inPage: () => unknown) => {
      if (webgl2 instanceof Error) throw webgl2;
      vi.stubGlobal("document", {
        createElement: (tag: string) => ({
          getContext: (kind: string) =>
            tag === "canvas" && kind === "webgl2" && webgl2 ? {} : null,
        }),
      });
      try {
        return inPage();
      } finally {
        vi.unstubAllGlobals();
      }
    });
    const browser = {
      newPage: vi.fn(async (options: { context: () => null; onLog: () => void }) => {
        // Remotion calls both for every page it opens.
        expect(options.context()).toBeNull();
        options.onLog();
        const page = {
          goto: vi.fn(async () => null),
          evaluate: vi.fn(async (fn: unknown, input: unknown): Promise<any> =>
            input === undefined
              ? await probe(fn as () => unknown)
              : { dataUrl: "data:image/png;base64,AQID", width: 1280, height: 720 }),
          close: vi.fn(async () => undefined),
        };
        pages.push(page);
        return page;
      }),
      close: vi.fn(async () => undefined),
    };
    return { browser, probe, pages };
  }

  async function harness<Gl extends string = never>(
    webgl2ByBackend: Record<string, boolean | Error>,
    glOverride?: Gl,
  ) {
    const { createHeadlessDirectorStageRenderer } = await import("./director-stage-renderer");
    const bundleDir = await mkdtemp(join(tmpdir(), "clash-director-gl-"));
    await writeFile(join(bundleDir, "index.html"), "");
    const opened = new Map<string, ReturnType<typeof fakeBrowser>>();
    const openBrowser = vi.fn(async (gl: string) => {
      const fake = fakeBrowser(webgl2ByBackend[gl] ?? false);
      opened.set(gl, fake);
      return fake.browser;
    });
    const onGlSelected = vi.fn();
    const renderer = createHeadlessDirectorStageRenderer<Gl>({
      bundleDir,
      openBrowser,
      onGlSelected,
      ...(glOverride === undefined ? {} : { glOverride }),
    });
    const render = () => renderer.render({ state, longEdge: 1280, frames });
    return { renderer, render, openBrowser, onGlSelected, opened };
  }

  it("keeps the preferred backend when it can create a WebGL2 context", async () => {
    const { renderer, render, openBrowser, onGlSelected, opened } = await harness({ angle: true });

    await expect(render()).resolves.toMatchObject({ frames: [{ label: "frame" }] });

    expect(openBrowser.mock.calls).toEqual([["angle"]]);
    expect(onGlSelected.mock.calls).toEqual([[{ gl: "angle", reason: "preferred" }]]);
    // The probe page is closed; the browser stays open for captures.
    expect(opened.get("angle")!.pages[0]!.close).toHaveBeenCalledOnce();
    expect(opened.get("angle")!.browser.close).not.toHaveBeenCalled();
    await renderer.dispose();
    expect(opened.get("angle")!.browser.close).toHaveBeenCalledOnce();
  });

  it("reopens with software rendering when the preferred backend has no WebGL2", async () => {
    const { renderer, render, openBrowser, onGlSelected, opened } = await harness({
      angle: false,
      swangle: true,
    });

    await expect(render()).resolves.toMatchObject({ frames: [{ label: "frame" }] });

    expect(openBrowser.mock.calls).toEqual([["angle"], ["swangle"]]);
    expect(opened.get("angle")!.browser.close).toHaveBeenCalledOnce();
    expect(onGlSelected.mock.calls).toEqual([
      [{ gl: "swangle", reason: "software-fallback" }],
    ]);
    await renderer.dispose();
    expect(opened.get("swangle")!.browser.close).toHaveBeenCalledOnce();
  });

  it("probes once per Host: later captures reuse the browser", async () => {
    const { renderer, render, openBrowser, onGlSelected, opened } = await harness({
      angle: false,
      swangle: true,
    });

    await render();
    await render();
    await Promise.all([render(), render()]);

    expect(openBrowser).toHaveBeenCalledTimes(2);
    expect(opened.get("angle")!.probe).toHaveBeenCalledOnce();
    expect(opened.get("swangle")!.probe).toHaveBeenCalledOnce();
    expect(onGlSelected).toHaveBeenCalledOnce();
    await renderer.dispose();
  });

  it("opens with an explicit override and nothing else", async () => {
    const { renderer, render, openBrowser, onGlSelected } = await harness(
      { "angle-egl": true, angle: true },
      "angle-egl",
    );

    await expect(render()).resolves.toMatchObject({ frames: [{ label: "frame" }] });

    expect(openBrowser.mock.calls).toEqual([["angle-egl"]]);
    expect(onGlSelected.mock.calls).toEqual([[{ gl: "angle-egl", reason: "override" }]]);
    await renderer.dispose();
  });

  it("fails, without falling back, when the override has no WebGL2", async () => {
    const { renderer, render, openBrowser, onGlSelected, opened } = await harness(
      { vulkan: false, angle: true, swangle: true },
      "vulkan",
    );

    const failure = await render().catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("CLASH_BROWSER_GL=vulkan");
    expect((failure as Error).message).toContain("WebGL2");

    expect(openBrowser.mock.calls).toEqual([["vulkan"]]);
    expect(opened.get("vulkan")!.browser.close).toHaveBeenCalledOnce();
    expect(onGlSelected).not.toHaveBeenCalled();
    // The Host does not relaunch a browser for every capture of a misconfigured backend.
    await expect(render()).rejects.toThrow(/CLASH_BROWSER_GL=vulkan/);
    expect(openBrowser).toHaveBeenCalledOnce();
    await renderer.dispose();
  });

  it("says so when neither hardware nor software rendering has WebGL2", async () => {
    const { renderer, render, openBrowser, opened } = await harness({});

    await expect(render()).rejects.toThrow(/WebGL2.*CLASH_BROWSER_GL/);

    expect(openBrowser.mock.calls).toEqual([["angle"], ["swangle"]]);
    expect(opened.get("angle")!.browser.close).toHaveBeenCalledOnce();
    expect(opened.get("swangle")!.browser.close).toHaveBeenCalledOnce();
    await renderer.dispose();
  });

  it("closes the browser and reports the failure when the probe itself breaks", async () => {
    const { renderer, render, openBrowser, opened } = await harness({
      angle: new Error("Target closed"),
      swangle: true,
    });

    await expect(render()).rejects.toThrow("Target closed");

    // A crashed probe is not evidence about WebGL, so it does not trigger the fallback.
    expect(openBrowser.mock.calls).toEqual([["angle"]]);
    expect(opened.get("angle")!.pages[0]!.close).toHaveBeenCalledOnce();
    expect(opened.get("angle")!.browser.close).toHaveBeenCalledOnce();
    await renderer.dispose();
  });
});
