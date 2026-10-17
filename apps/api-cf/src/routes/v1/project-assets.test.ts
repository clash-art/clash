import { describe, expect, it } from "vitest";
import {
  ContentTransferLimitError,
  PROJECT_ASSET_SINGLE_SHOT_MAX_BYTES,
} from "@clash/asset-sdk";
import { normalizeProjectAssetContentType } from "@clash/shared-runtime/cloud-project-host/project-assets";
import {
  parseProjectAssetImportRequest,
  projectAssetImportMetadata,
} from "./project-assets";

const query = (overrides: Record<string, string> = {}) =>
  new URL(
    `https://clash.test/api/v1/projects/p/assets/import-file?${new URLSearchParams(
      {
        kind: "video",
        projectAssetId: "asset:one",
        fileName: "clip.mp4",
        byteLength: "4",
        ...overrides,
      },
    ).toString()}`,
  );

describe("Project Asset MIME normalization", () => {
  it("lower-cases, strips parameters, and recovers an extension fallback", () => {
    expect(
      normalizeProjectAssetContentType({
        contentType: " Video/MP4; codecs=avc1 ",
        fileName: "clip.mp4",
        kind: "video",
      }),
    ).toBe("video/mp4");
    expect(
      normalizeProjectAssetContentType({
        contentType: "application/octet-stream",
        fileName: "CLIP.MOV",
        kind: "video",
      }),
    ).toBe("video/quicktime");
    expect(
      normalizeProjectAssetContentType({
        contentType: undefined,
        fileName: "clip.webm",
        kind: "video",
      }),
    ).toBe("video/webm");
  });

  it("falls back by Asset kind when the browser gives no format hint", () => {
    expect(
      normalizeProjectAssetContentType({
        contentType: "",
        fileName: "clip",
        kind: "video",
      }),
    ).toBe("video/mp4");
    expect(
      normalizeProjectAssetContentType({
        contentType: "application/octet-stream",
        fileName: "unknown.bin",
        kind: "audio",
      }),
    ).toBe("audio/mpeg");
  });
});

describe("Project Asset import metadata hints", () => {
  it("keeps bounded hints and ignores invalid or out-of-range ones", () => {
    const parsed = parseProjectAssetImportRequest(
      query({
        durationMs: "1500",
        width: "-1",
        height: "999999",
        frameRate: "29.97",
        hasAudio: "true",
      }),
      "video/mp4",
    );
    expect(parsed.metadataHints).toEqual({
      durationMs: 1500,
      frameRate: 29.97,
      hasAudio: true,
    });
    expect(parsed.metadata).toEqual({
      bytes: 4,
      contentType: "video/mp4",
      originalName: "clip.mp4",
      durationMs: 1500,
      frameRate: 29.97,
      hasAudio: true,
    });
  });

  it("ignores non-finite and unbounded values without failing the import", () => {
    expect(
      projectAssetImportMetadata({
        byteLength: 4,
        fileName: "clip.mp4",
        contentType: "video/mp4",
        metadataHints: {
          durationMs: Number.POSITIVE_INFINITY,
          width: 20_000,
          height: 10,
          frameRate: 1_000,
          hasAudio: "yes" as never,
        },
      }),
    ).toEqual({
      bytes: 4,
      contentType: "video/mp4",
      originalName: "clip.mp4",
      height: 10,
    });
  });

  it("answers 413 when byteLength is missing or above the single-shot cap", () => {
    expect(() =>
      parseProjectAssetImportRequest(
        new URL(
          "https://clash.test/api/v1/projects/p/assets/import-file?kind=video&projectAssetId=a&fileName=a.mp4",
        ),
        "video/mp4",
      ),
    ).toThrow(ContentTransferLimitError);
    expect(() =>
      parseProjectAssetImportRequest(
        query({ byteLength: String(PROJECT_ASSET_SINGLE_SHOT_MAX_BYTES + 1) }),
        "video/mp4",
      ),
    ).toThrow(ContentTransferLimitError);
  });
});
