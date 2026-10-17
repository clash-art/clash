import { renderStillOnWeb } from "@remotion/web-renderer";
import { VideoComposition } from "../../../packages/remotion-components/src/VideoComposition.tsx";
import type { ParityTimeline } from "../fixture.ts";

type ParityInputProps = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  tracks: ParityTimeline["tracks"];
};

type ParityFrameResult =
  | { ok: true; base64: string }
  | { ok: false; error: string };

declare global {
  interface Window {
    __PARITY_INPUT_PROPS__?: ParityInputProps;
    renderParityFrame: (frame: number) => Promise<ParityFrameResult>;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma === -1 ? "" : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("blob read failed"));
    reader.readAsDataURL(blob);
  });
}

window.renderParityFrame = async (frame: number): Promise<ParityFrameResult> => {
  const inputProps = window.__PARITY_INPUT_PROPS__;
  if (!inputProps) {
    return { ok: false, error: "window.__PARITY_INPUT_PROPS__ is not set" };
  }
  try {
    const result = await renderStillOnWeb({
      composition: {
        id: "VideoComposition",
        component: VideoComposition,
        width: inputProps.width,
        height: inputProps.height,
        fps: inputProps.fps,
        durationInFrames: inputProps.durationInFrames,
        defaultProps: { tracks: [] },
      },
      inputProps: { tracks: inputProps.tracks },
      frame,
      logLevel: "error",
    });
    const blob = await result.blob({ format: "png" });
    return { ok: true, base64: await blobToBase64(blob) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
};

const status = document.getElementById("status");
if (status) status.textContent = "ready";
