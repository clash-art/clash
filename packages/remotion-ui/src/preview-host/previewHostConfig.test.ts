import { describe, expect, it } from "vitest";
import {
  previewHostIsolationWarning,
  resolvePreviewHostConfig,
} from "./previewHostConfig";

describe("resolvePreviewHostConfig", () => {
  it("defaults to main-thread", () => {
    expect(resolvePreviewHostConfig({})).toEqual({
      mode: "main-thread",
      frameUrl: null,
      frameOrigin: null,
    });
  });

  it("falls back when iframe is requested without an origin", () => {
    expect(
      resolvePreviewHostConfig({ VITE_PREVIEW_HOST_MODE: "iframe" }),
    ).toMatchObject({ mode: "main-thread" });
  });

  it("builds a preview-frame URL for iframe mode", () => {
    expect(
      resolvePreviewHostConfig({
        VITE_PREVIEW_HOST_MODE: "iframe",
        VITE_PREVIEW_FRAME_ORIGIN: "http://127.0.0.1:5182/",
      }),
    ).toEqual({
      mode: "iframe",
      frameOrigin: "http://127.0.0.1:5182",
      frameUrl: "http://127.0.0.1:5182/preview-frame.html",
    });
  });

  it("warns when the frame is same-origin", () => {
    const config = resolvePreviewHostConfig({
      VITE_PREVIEW_HOST_MODE: "iframe",
      VITE_PREVIEW_FRAME_ORIGIN: "http://localhost:5173",
    });
    expect(
      previewHostIsolationWarning(config, "http://localhost:5173"),
    ).toMatch(/not process-isolated/);
  });
});
