import { describe, expect, it, vi } from "vitest";
import type { ObservedProjectTimeline } from "@clash/shared-runtime";
import {
  createBrowserTimelineRenderExecutor,
  TimelineRenderPublicationRejected,
} from "./adapter";

const observed = {
  readToken: "receipt",
  timeline: {
    id: "timeline-1",
    revisionId: "revision-1",
    name: "Cut",
    owner: { kind: "project" },
    state: {
      compositionWidth: 1280,
      compositionHeight: 720,
      fps: 30,
      tracks: [
        {
          id: "titles",
          items: [
            { id: "title", type: "text", text: "Hi", from: 0, durationInFrames: 30 },
          ],
        },
      ],
    },
  },
} as unknown as ObservedProjectTimeline;

function executor(
  overrides: Partial<
    Parameters<typeof createBrowserTimelineRenderExecutor>[0]
  >,
) {
  return createBrowserTimelineRenderExecutor({
    frameOrigin: "https://render.example",
    licenseKey: null,
    maxDurationSeconds: 600,
    browser: { isWebKit: false, hasWebCodecs: true },
    ...overrides,
  });
}

const submit = () => Promise.resolve({ actionRunId: "run", renderNodeId: "node" });

describe("browser Timeline render executor", () => {
  it("falls back to submit when the structural preflight rejects the Timeline", async () => {
    const renderFrame = vi.fn();
    const submitRender = vi.fn(submit);
    const run = executor({ renderFrame });
    const receipt = await run({
      projectId: "project-1",
      observed: {
        ...observed,
        timeline: { ...observed.timeline, state: { tracks: [] } },
      },
      signal: new AbortController().signal,
      onProgress: () => undefined,
      submit: submitRender,
    });
    expect(renderFrame).not.toHaveBeenCalled();
    expect(submitRender).toHaveBeenCalledTimes(1);
    expect(receipt).toEqual({
      actionRunId: "run",
      renderNodeId: "node",
      renderPath: "host",
      fallback: {
        reason: "no-items",
        message: "Timeline has no items.",
      },
    });
  });

  it("falls back exactly once when the frame throws", async () => {
    const submitRender = vi.fn(submit);
    const run = executor({
      renderFrame: async () => {
        throw new Error("WebCodecs decode failed");
      },
    });
    const receipt = await run({
      projectId: "project-1",
      observed,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      submit: submitRender,
    });
    expect(submitRender).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({
      renderPath: "host",
      fallback: {
        reason: "browser-render-failed",
        message: "WebCodecs decode failed",
      },
    });
  });

  it("does not fall back when the user cancels", async () => {
    const submitRender = vi.fn(submit);
    const run = executor({
      renderFrame: async ({ signal }) => {
        await new Promise((_resolve, reject) => {
          if (signal.aborted)
            return reject(new DOMException("cancelled", "AbortError"));
          signal.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        });
        return new Blob();
      },
    });
    const controller = new AbortController();
    const pending = run({
      projectId: "project-1",
      observed,
      signal: controller.signal,
      onProgress: () => undefined,
      submit: submitRender,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(submitRender).not.toHaveBeenCalled();
  });

  it("reports a failed discard when the user cancels after upload", async () => {
    const submitRender = vi.fn(submit);
    const onNotice = vi.fn();
    const controller = new AbortController();
    const publishRender = vi.fn();
    const run = executor({
      renderFrame: async () => new Blob(["mp4"], { type: "video/mp4" }),
      uploadAsset: async () => {
        controller.abort();
        return { id: "asset-orphan" } as never;
      },
      publishRender,
      discardAsset: async () => {
        throw new Error("trash unavailable");
      },
      onNotice,
    });
    await expect(
      run({
        projectId: "project-1",
        observed,
        signal: controller.signal,
        onProgress: () => undefined,
        submit: submitRender,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(publishRender).not.toHaveBeenCalled();
    expect(submitRender).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith(
      expect.stringContaining("asset-orphan"),
    );
    expect(onNotice).toHaveBeenCalledWith(
      expect.stringContaining("trash unavailable"),
    );
  });

  it("uploads through the injected chunked import and publishes the render node", async () => {
    const progress: number[] = [];
    const publishRender = vi.fn(async () => ({
      actionRunId: "timeline-render:published",
      renderNodeId: "published",
    }));
    const run = executor({
      renderFrame: async ({ onProgress }) => {
        onProgress(0.25);
        onProgress(0.75);
        return new Blob(["mp4"], { type: "video/mp4" });
      },
      uploadAsset: async ({ projectId, file }) => {
        expect(projectId).toBe("project-1");
        expect(file.type).toBe("video/mp4");
        return { id: "asset-1", kind: "video" } as never;
      },
      publishRender,
    });
    const receipt = await run({
      projectId: "project-1",
      observed,
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value),
      submit,
    });
    expect(progress).toEqual([0.25, 0.75]);
    expect(publishRender).toHaveBeenCalledWith({
      projectId: "project-1",
      timelineId: "timeline-1",
      assetId: "asset-1",
    });
    expect(receipt).toEqual({
      actionRunId: "timeline-render:published",
      renderNodeId: "published",
      renderPath: "browser",
    });
  });

  it("reports a successful publication retry on the receipt", async () => {
    const publishRender = vi
      .fn()
      .mockRejectedValueOnce(new Error("publication unavailable"))
      .mockResolvedValueOnce({
        actionRunId: "timeline-render:published",
        renderNodeId: "published",
      });
    const run = executor({
      renderFrame: async () => new Blob(["mp4"], { type: "video/mp4" }),
      uploadAsset: async () => ({ id: "asset-1" }) as never,
      publishRender,
    });
    const receipt = await run({
      projectId: "project-1",
      observed,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      submit,
    });
    expect(publishRender).toHaveBeenCalledTimes(2);
    expect(receipt).toEqual({
      actionRunId: "timeline-render:published",
      renderNodeId: "published",
      renderPath: "browser",
      publicationRetried: { firstError: "publication unavailable" },
    });
  });

  it("retries publication but never starts a second render once bytes are uploaded", async () => {
    const submitRender = vi.fn(submit);
    const publishRender = vi
      .fn()
      .mockRejectedValueOnce(new Error("publication unavailable"))
      .mockRejectedValueOnce(
        new TimelineRenderPublicationRejected("Timeline not found"),
      );
    const discardAsset = vi.fn(async () => undefined);
    const run = executor({
      renderFrame: async () => new Blob(["mp4"], { type: "video/mp4" }),
      uploadAsset: async () => ({ id: "asset-1" }) as never,
      publishRender,
      discardAsset,
    });
    const thrown = await run({
      projectId: "project-1",
      observed,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      submit: submitRender,
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(TimelineRenderPublicationRejected);
    expect((thrown as Error).message).toContain(
      "first: publication unavailable",
    );
    expect((thrown as Error).message).toContain("retry: Timeline not found");
    expect(publishRender).toHaveBeenCalledTimes(2);
    expect(discardAsset).toHaveBeenCalledWith({
      projectId: "project-1",
      assetId: "asset-1",
    });
    expect(submitRender).not.toHaveBeenCalled();
  });

  it("includes a definitive rejection's discard failure in the thrown error", async () => {
    const publishRender = vi
      .fn()
      .mockRejectedValueOnce(new Error("publication unavailable"))
      .mockRejectedValueOnce(
        new TimelineRenderPublicationRejected("Timeline not found"),
      );
    const discardAsset = vi.fn(async () => {
      throw new Error("trash unavailable");
    });
    const run = executor({
      renderFrame: async () => new Blob(["mp4"], { type: "video/mp4" }),
      uploadAsset: async () => ({ id: "asset-orphan" }) as never,
      publishRender,
      discardAsset,
    });
    const thrown = await run({
      projectId: "project-1",
      observed,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      submit,
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(TimelineRenderPublicationRejected);
    const message = (thrown as Error).message;
    expect(message).toContain("first: publication unavailable");
    expect(message).toContain("retry: Timeline not found");
    expect(message).toContain("asset-orphan");
    expect(message).toContain("trash unavailable");
  });

  it("keeps the uploaded Asset when publication failed ambiguously", async () => {
    const submitRender = vi.fn(submit);
    const discardAsset = vi.fn(async () => undefined);
    const run = executor({
      renderFrame: async () => new Blob(["mp4"], { type: "video/mp4" }),
      uploadAsset: async () => ({ id: "asset-1" }) as never,
      publishRender: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      discardAsset,
    });
    await expect(
      run({
        projectId: "project-1",
        observed,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        submit: submitRender,
      }),
    ).rejects.toThrow("Failed to fetch");
    // The node may already reference the Asset; never trash it here.
    expect(discardAsset).not.toHaveBeenCalled();
    expect(submitRender).not.toHaveBeenCalled();
  });

  it("submits the container fallback at most once when it fails", async () => {
    const submitRender = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    const renderFrame = vi.fn();
    const run = executor({ renderFrame });
    await expect(
      run({
        projectId: "project-1",
        observed: {
          ...observed,
          timeline: { ...observed.timeline, state: { tracks: [] } },
        },
        signal: new AbortController().signal,
        onProgress: () => undefined,
        submit: submitRender,
      }),
    ).rejects.toThrow("HTTP 503");
    expect(renderFrame).not.toHaveBeenCalled();
    expect(submitRender).toHaveBeenCalledTimes(1);
  });
});
