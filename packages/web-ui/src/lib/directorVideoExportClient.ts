import {
  unwrapDesktopIpcResult,
  type DesktopIpcResult,
} from "./desktopIpc";

export type DesktopDirectorVideoExportBridge = {
  exportDirectorVideo: (request: {
    stageName: string;
    cameraName: string;
    sourceUrl: string;
  }) => Promise<
    DesktopIpcResult<{ canceled: boolean; outputPath?: string }>
  >;
};

/**
 * Asks the desktop main process to stream the already-published camera video
 * from its Host URL to the save target. No video bytes cross the IPC boundary.
 */
export async function requestDirectorVideoExport(
  bridge: DesktopDirectorVideoExportBridge,
  request: {
    stageName: string;
    cameraName: string;
    sourceUrl: string;
  },
): Promise<{ canceled: boolean; outputPath?: string }> {
  return unwrapDesktopIpcResult(
    await bridge.exportDirectorVideo(request),
  );
}
