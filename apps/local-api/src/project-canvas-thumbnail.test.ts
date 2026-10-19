import type { CachedProjectCanvasPreview } from "./loro/file-replica-store";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
  ProjectCanvasThumbnailCache,
  ProjectCanvasThumbnailError,
  renderProjectCanvasThumbnail,
} from "./project-canvas-thumbnail";

function previewEntry(sourceVersion: string): CachedProjectCanvasPreview {
  return {
    sourceVersion,
    docVersion: "d".repeat(64),
    generatedAt: "2026-08-27T00:00:00.000Z",
    preview: {
      canvasId: "main",
      bounds: { x: 0, y: 0, width: 640, height: 360 },
      nodes: [
        {
          id: "hero",
          type: "image",
          x: 0,
          y: 0,
          width: 640,
          height: 360,
          assetId: "asset-hero",
        },
      ],
    },
  };
}

describe("ProjectCanvasThumbnailCache", () => {
  it("coalesces concurrent renders and reuses the persisted revision", async () => {
    const persisted = new Map<string, Uint8Array>();
    const store = {
      readCanvasThumbnail: vi.fn(
        async (projectId: string, sourceVersion: string) =>
          persisted.get(`${projectId}:${sourceVersion}`) ?? null,
      ),
      writeCanvasThumbnail: vi.fn(
        async (projectId: string, sourceVersion: string, bytes: Uint8Array) => {
          persisted.set(`${projectId}:${sourceVersion}`, bytes);
        },
      ),
    };
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const render = vi.fn(async () => {
      await renderGate;
      return new Uint8Array([82, 73, 70, 70]);
    });
    const cache = new ProjectCanvasThumbnailCache({ store, render });
    const entry = previewEntry("a".repeat(64));
    const input = {
      projectId: "project-1",
      entry,
      resolveMedia: vi.fn(async () => null),
    };

    const first = cache.get(input);
    const second = cache.get(input);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    releaseRender();

    await expect(first).resolves.toEqual(new Uint8Array([82, 73, 70, 70]));
    await expect(second).resolves.toEqual(new Uint8Array([82, 73, 70, 70]));
    expect(store.writeCanvasThumbnail).toHaveBeenCalledOnce();

    await expect(cache.get(input)).resolves.toEqual(
      new Uint8Array([82, 73, 70, 70]),
    );
    expect(render).toHaveBeenCalledOnce();
  });

  it("renders a new immutable artifact for a new Project revision", async () => {
    const store = {
      readCanvasThumbnail: vi.fn(async () => null),
      writeCanvasThumbnail: vi.fn(async () => undefined),
    };
    const render = vi.fn(
      async ({ entry }: { entry: CachedProjectCanvasPreview }) =>
        new TextEncoder().encode(entry.sourceVersion),
    );
    const cache = new ProjectCanvasThumbnailCache({ store, render });

    await cache.get({
      projectId: "project-1",
      entry: previewEntry("a".repeat(64)),
      resolveMedia: async () => null,
    });
    await cache.get({
      projectId: "project-1",
      entry: previewEntry("b".repeat(64)),
      resolveMedia: async () => null,
    });

    expect(render).toHaveBeenCalledTimes(2);
    expect(store.writeCanvasThumbnail).toHaveBeenNthCalledWith(
      2,
      "project-1",
      "b".repeat(64),
      expect.any(Uint8Array),
    );
  });

  it("rasterizes the real image bytes into their Main canvas node", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clash-canvas-thumbnail-"));
    const sourcePath = join(directory, "hero.svg");
    try {
      await writeFile(
        sourcePath,
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#f00000"/></svg>',
      );
      const bytes = await renderProjectCanvasThumbnail({
        projectId: "project-1",
        entry: previewEntry("c".repeat(64)),
        resolveMedia: async () => ({ kind: "image", path: sourcePath }),
      });
      const { data, info } = await sharp(bytes)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const center =
        (Math.floor(info.height / 2) * info.width +
          Math.floor(info.width / 2)) *
        info.channels;

      expect(data[center]).toBeGreaterThan(220);
      expect(data[center + 1]).toBeLessThan(30);
      expect(data[center + 2]).toBeLessThan(30);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs at most two renders at a time", async () => {
    const store = {
      readCanvasThumbnail: vi.fn(async () => null),
      writeCanvasThumbnail: vi.fn(async () => undefined),
    };
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const render = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return new Uint8Array([82, 73, 70, 70]);
    });
    const cache = new ProjectCanvasThumbnailCache({ store, render });
    const inputs = ["a", "b", "c"].map((value) => ({
      projectId: `project-${value}`,
      entry: previewEntry(value.repeat(64)),
      resolveMedia: vi.fn(async () => null),
    }));

    const pending = inputs.map((input) => cache.get(input));
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(maximum).toBe(2);

    releases.shift()?.();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    releases.shift()?.();
    await Promise.all(pending);
    expect(maximum).toBe(2);
  });

  it("records a coded failure and backs off before retrying", async () => {
    let now = 1_000;
    const store = {
      readCanvasThumbnail: vi.fn(async () => null),
      writeCanvasThumbnail: vi.fn(async () => undefined),
    };
    const render = vi.fn(async () => {
      throw new Error("sharp pipeline failed");
    });
    const cache = new ProjectCanvasThumbnailCache({
      store,
      render,
      now: () => now,
    });
    const entry = previewEntry("a".repeat(64));
    const input = {
      projectId: "project-1",
      entry,
      resolveMedia: vi.fn(async () => null),
    };

    await expect(cache.get(input)).rejects.toBeInstanceOf(
      ProjectCanvasThumbnailError,
    );
    expect(render).toHaveBeenCalledOnce();
    expect(cache.failureFor("project-1", entry.sourceVersion)).toMatchObject({
      code: "REPRESENTATION_FAILED",
      attempts: 1,
      retryAt: 2_000,
    });

    await expect(cache.get(input)).rejects.toMatchObject({
      code: "REPRESENTATION_FAILED",
    });
    expect(render).toHaveBeenCalledOnce();

    now = 2_000;
    await expect(cache.get(input)).rejects.toMatchObject({
      code: "REPRESENTATION_FAILED",
    });
    expect(render).toHaveBeenCalledTimes(2);
  });
});
