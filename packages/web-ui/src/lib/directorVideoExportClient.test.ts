import { describe, expect, it, vi } from "vitest";

import { DesktopIpcError, type DesktopIpcResult } from "./desktopIpc";
import { requestDirectorVideoExport } from "./directorVideoExportClient";

function bridge(
  result: DesktopIpcResult<{ canceled: boolean; outputPath?: string }>,
) {
  return {
    exportDirectorVideo: vi.fn(async () => result),
  };
}

describe("desktop Director video export client", () => {
  it("passes the published Host URL instead of video bytes", async () => {
    const desktop = bridge({
      ok: true,
      value: { canceled: false, outputPath: "/tmp/camera.webm" },
    });

    await expect(
      requestDirectorVideoExport(desktop, {
        stageName: "Lobby",
        cameraName: "Camera 2",
        sourceUrl: "http://127.0.0.1:1234/api/v1/projects/p/assets/a/media",
      }),
    ).resolves.toEqual({ canceled: false, outputPath: "/tmp/camera.webm" });
    expect(desktop.exportDirectorVideo).toHaveBeenCalledWith({
      stageName: "Lobby",
      cameraName: "Camera 2",
      sourceUrl: "http://127.0.0.1:1234/api/v1/projects/p/assets/a/media",
    });
  });

  it("propagates a coded main-process failure to the card", async () => {
    const desktop = bridge({
      ok: false,
      error: {
        code: "DIRECTOR_VIDEO_EXPORT_DOWNLOAD_FAILED",
        message: "Could not download Director camera video (404).",
      },
    });

    await expect(
      requestDirectorVideoExport(desktop, {
        stageName: "Lobby",
        cameraName: "Camera 2",
        sourceUrl: "http://127.0.0.1:1234/media",
      }),
    ).rejects.toBeInstanceOf(DesktopIpcError);
    await expect(
      requestDirectorVideoExport(desktop, {
        stageName: "Lobby",
        cameraName: "Camera 2",
        sourceUrl: "http://127.0.0.1:1234/media",
      }),
    ).rejects.toMatchObject({
      code: "DIRECTOR_VIDEO_EXPORT_DOWNLOAD_FAILED",
      message:
        "DIRECTOR_VIDEO_EXPORT_DOWNLOAD_FAILED: Could not download Director camera video (404).",
    });
  });
});
