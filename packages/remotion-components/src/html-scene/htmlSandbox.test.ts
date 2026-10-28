import { describe, expect, it } from "vitest";
import {
  HTML_MOTION_DOCUMENT_MAX_BYTES,
} from "@clash/shared-types";
import {
  HTML_SCENE_DOCUMENT_PROTOCOL,
  HTML_SCENE_SANDBOX,
  createHtmlSceneBlobUrl,
  htmlSceneBootstrapScript,
  htmlSceneElementEditBridgeScript,
  measureHtmlDocumentBytes,
  validateHtmlDocumentCapacity,
  wrapHtmlDocumentForPreview,
} from "./htmlSandbox";

describe("htmlSandbox", () => {
  it("uses allow-scripts without allow-same-origin", () => {
    expect(HTML_SCENE_SANDBOX).toBe("allow-scripts");
    expect(HTML_SCENE_SANDBOX.includes("allow-same-origin")).toBe(false);
  });

  it("fails closed when the document exceeds capacity", () => {
    const huge = "x".repeat(HTML_MOTION_DOCUMENT_MAX_BYTES + 1);
    const result = validateHtmlDocumentCapacity(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.byteLength).toBeGreaterThan(HTML_MOTION_DOCUMENT_MAX_BYTES);
      expect(result.reason).toMatch(/exceeds capacity/);
    }
  });

  it("accepts documents within capacity", () => {
    const result = validateHtmlDocumentCapacity("<html><body>hi</body></html>");
    expect(result.ok).toBe(true);
  });

  it("wraps documents with CSP meta and bootstrap listening on html-scene-doc protocol", () => {
    const wrapped = wrapHtmlDocumentForPreview(
      "<!doctype html><html><head><title>t</title></head><body>hi</body></html>",
    );
    expect(wrapped).toContain("Content-Security-Policy");
    expect(wrapped).toContain(HTML_SCENE_DOCUMENT_PROTOCOL);
    expect(htmlSceneBootstrapScript()).toContain("clash-html-scene-frame");
    expect(measureHtmlDocumentBytes(wrapped)).toBeGreaterThan(0);
  });

  it("injects element edit bridge when elementEdit is enabled", () => {
    const wrapped = wrapHtmlDocumentForPreview("<body>hi</body>", {
      elementEdit: true,
      sceneWidth: 1280,
    });
    expect(wrapped).toContain("element-edit");
    expect(wrapped).toContain("data-mg-id");
    expect(htmlSceneElementEditBridgeScript(1280)).toContain("SCENE_W");
  });

  it("creates and revokes blob URLs", () => {
    const handle = createHtmlSceneBlobUrl("<html></html>");
    expect(handle.url.startsWith("blob:")).toBe(true);
    expect(() => handle.revoke()).not.toThrow();
  });
});
