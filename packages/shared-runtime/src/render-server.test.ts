import { describe, expect, it } from "vitest";
import {
  createHttpRenderServerPort,
  getRenderMetadataFromHeaders,
  renderTimelineVideo,
  type RenderServerPort,
} from "./render-server";

describe("getRenderMetadataFromHeaders", () => {
  it("prefers explicit render headers", () => {
    const headers = new Headers({
      "X-Render-Width": "1280",
      "X-Render-Height": "720",
      "X-Render-Duration-Ms": "4500",
    });

    expect(
      getRenderMetadataFromHeaders(headers, {
        compositionWidth: 1920,
        compositionHeight: 1080,
        fps: 30,
        durationInFrames: 300,
      }),
    ).toEqual({
      width: 1280,
      height: 720,
      durationMs: 4500,
    });
  });

  it("falls back to timeline dsl when headers are missing", () => {
    expect(
      getRenderMetadataFromHeaders(new Headers(), {
        compositionWidth: 1920,
        compositionHeight: 1080,
        fps: 24,
        durationInFrames: 96,
      }),
    ).toEqual({
      width: 1920,
      height: 1080,
      durationMs: 4000,
    });
  });

  it("ignores invalid header values and keeps valid fallbacks", () => {
    const headers = new Headers({
      "X-Render-Width": "oops",
      "X-Render-Duration-Ms": "5000",
    });

    expect(
      getRenderMetadataFromHeaders(headers, {
        compositionWidth: 1440,
        compositionHeight: 810,
        fps: 25,
        durationInFrames: 100,
      }),
    ).toEqual({
      width: 1440,
      height: 810,
      durationMs: 5000,
    });
  });
});

describe("renderTimelineVideo", () => {
  const timelineDsl = {
    compositionWidth: 1920,
    compositionHeight: 1080,
    fps: 30,
    durationInFrames: 60,
    tracks: [],
  };

  it("posts the Timeline to /render and returns its bytes and header metadata", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const headers = { "X-Render-Width": "1280", "X-Render-Height": "720" };
    const port: RenderServerPort = {
      fetch: async (path, init) => {
        calls.push({ path, init });
        return new Response(new Uint8Array([1, 2, 3]), { headers });
      },
    };
    const rendered = await renderTimelineVideo(port, {
      timelineDsl,
      projectId: "project",
      taskId: "task",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/render");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      timelineDsl,
      projectId: "project",
      taskId: "task",
    });
    expect([...new Uint8Array(rendered.bytes)]).toEqual([1, 2, 3]);
    expect(rendered.metadata).toEqual(
      getRenderMetadataFromHeaders(new Headers(headers), timelineDsl),
    );
  });

  it("fails with the render-server status and body", async () => {
    const port: RenderServerPort = {
      fetch: async () => new Response("bad timeline", { status: 422 }),
    };
    await expect(
      renderTimelineVideo(port, { timelineDsl, projectId: "p", taskId: "t" }),
    ).rejects.toThrow("Render server error 422: bad timeline");
  });

  it("joins the HTTP origin and route without a doubled slash", async () => {
    const urls: string[] = [];
    const port = createHttpRenderServerPort(
      "http://render.test/",
      async (input) => {
        urls.push(String(input));
        return new Response(null, { status: 204 });
      },
    );
    await port.fetch("/render", { method: "POST" });
    expect(urls).toEqual(["http://render.test/render"]);
  });
});
