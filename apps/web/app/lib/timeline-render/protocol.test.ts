import { describe, expect, it, vi } from "vitest";
import {
  TIMELINE_RENDER_PROTOCOL,
  isTimelineRenderFrameCommand,
  isTimelineRenderFrameMessage,
  isTrustedFrameMessage,
} from "./protocol";

describe("Timeline render frame protocol", () => {
  it("rejects messages from another origin or another window", () => {
    const frame = {} as Window;
    const message = { protocol: TIMELINE_RENDER_PROTOCOL, type: "ready" };
    expect(
      isTrustedFrameMessage(
        { origin: "https://render.example", source: frame, data: message },
        "https://render.example",
        frame,
      ),
    ).toBe(true);
    expect(
      isTrustedFrameMessage(
        { origin: "https://evil.example", source: frame, data: message },
        "https://render.example",
        frame,
      ),
    ).toBe(false);
    expect(
      isTrustedFrameMessage(
        { origin: "https://render.example", source: {} as Window, data: message },
        "https://render.example",
        frame,
      ),
    ).toBe(false);
  });

  it("validates progress bounds and render commands", () => {
    expect(
      isTimelineRenderFrameMessage({
        protocol: TIMELINE_RENDER_PROTOCOL,
        type: "progress",
        progress: 0.5,
      }),
    ).toBe(true);
    expect(
      isTimelineRenderFrameMessage({
        protocol: TIMELINE_RENDER_PROTOCOL,
        type: "progress",
        progress: 1.5,
      }),
    ).toBe(false);
    expect(
      isTimelineRenderFrameCommand({
        protocol: TIMELINE_RENDER_PROTOCOL,
        type: "render",
        parentOrigin: "https://app.example",
        request: {
          tracks: [],
          width: 1920,
          height: 1080,
          fps: 30,
          durationInFrames: 1,
          licenseKey: null,
          allowHtmlInCanvas: false,
        },
      }),
    ).toBe(true);
    expect(
      isTimelineRenderFrameCommand({
        protocol: TIMELINE_RENDER_PROTOCOL,
        type: "render",
        parentOrigin: "https://app.example",
        request: { tracks: [] },
      }),
    ).toBe(false);
  });

  it("forwards progress and cancels an in-flight frame through postMessage", async () => {
    vi.resetModules();
    const { renderTimelineInIframe } = await import("./adapter");
    const posted: unknown[] = [];
    const contentWindow = {
      postMessage: (message: unknown) => posted.push(message),
    };
    const win = new EventTarget();
    const iframe = {
      contentWindow,
      style: { cssText: "" },
      title: "",
      tabIndex: 0,
      setAttribute: () => undefined,
      remove: vi.fn(),
    };
    const document = {
      location: { origin: "https://app.example" },
      defaultView: win as unknown as Window,
      createElement: () => iframe,
      body: { appendChild: () => undefined },
    } as unknown as Document;
    const progress: number[] = [];
    const controller = new AbortController();
    const promise = renderTimelineInIframe({
      frameUrl: "https://render.example/render-frame.html",
      tracks: [],
      width: 1280,
      height: 720,
      fps: 30,
      durationInFrames: 30,
      licenseKey: null,
      allowHtmlInCanvas: false,
      signal: controller.signal,
      onProgress: (value) => progress.push(value),
      document,
    });
    const dispatch = (data: unknown, origin = "https://render.example") => {
      const event = new Event("message");
      Object.assign(event, { data, origin, source: contentWindow });
      win.dispatchEvent(event);
    };
    dispatch({ protocol: TIMELINE_RENDER_PROTOCOL, type: "ready" }, "https://evil.example");
    expect(posted).toEqual([]);
    dispatch({ protocol: TIMELINE_RENDER_PROTOCOL, type: "ready" });
    expect(posted[0]).toMatchObject({
      protocol: TIMELINE_RENDER_PROTOCOL,
      type: "render",
      parentOrigin: "https://app.example",
    });
    dispatch({
      protocol: TIMELINE_RENDER_PROTOCOL,
      type: "progress",
      progress: 0.4,
    });
    expect(progress).toEqual([0.4]);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(posted[1]).toMatchObject({
      protocol: TIMELINE_RENDER_PROTOCOL,
      type: "cancel",
    });
    expect(iframe.remove).toHaveBeenCalledTimes(1);
  });

  it("resolves the rendered file from a done message", async () => {
    vi.resetModules();
    const { renderTimelineInIframe } = await import("./adapter");
    const contentWindow = { postMessage: vi.fn() };
    const win = new EventTarget();
    const iframe = {
      contentWindow,
      style: { cssText: "" },
      title: "",
      tabIndex: 0,
      setAttribute: () => undefined,
      remove: vi.fn(),
    };
    const document = {
      location: { origin: "https://app.example" },
      defaultView: win as unknown as Window,
      createElement: () => iframe,
      body: { appendChild: () => undefined },
    } as unknown as Document;
    const promise = renderTimelineInIframe({
      frameUrl: "https://render.example/render-frame.html",
      tracks: [],
      width: 16,
      height: 16,
      fps: 1,
      durationInFrames: 1,
      licenseKey: null,
      allowHtmlInCanvas: false,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      document,
    });
    const file = new Blob(["mp4"], { type: "video/mp4" });
    const event = new Event("message");
    Object.assign(event, {
      data: { protocol: TIMELINE_RENDER_PROTOCOL, type: "done", file },
      origin: "https://render.example",
      source: contentWindow,
    });
    win.dispatchEvent(event);
    await expect(promise).resolves.toBe(file);
  });
});
