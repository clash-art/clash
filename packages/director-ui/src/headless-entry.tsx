import React, { createRef } from "react";
import { createRoot } from "react-dom/client";
import type { DirectorStageState } from "@clash/shared-types";
import { aspectRatioDimensions, evaluateDirectorStage } from "@clash/director-core";
import {
  DirectorViewport,
  type DirectorViewportHandle,
} from "./DirectorViewport";
import { directorRenderPaletteFallback } from "./tokens";

type DirectorAspectRatio = DirectorStageState["shots"][number]["aspectRatio"];

type CaptureRequest = {
  state: DirectorStageState;
  timeSeconds: number;
  aspectRatio: DirectorAspectRatio;
  longEdge: number;
  assetUrls?: Record<string, string>;
  codeSources?: Record<string, string>;
  environmentUrl?: string;
};

type CaptureResult = {
  dataUrl: string;
  width: number;
  height: number;
  activeCameraId?: string;
};

declare global {
  interface Window {
    clashDirectorCapture?: (request: CaptureRequest) => Promise<CaptureResult>;
  }
}

const mount = document.getElementById("root");
if (!mount) throw new Error("Director headless renderer root is missing");
const root = createRoot(mount);
let captureSequence = 0;

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Director PNG could not be read"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

window.clashDirectorCapture = async (request) => {
  const sequence = ++captureSequence;
  const viewport = createRef<DirectorViewportHandle>();
  const dimensions = aspectRatioDimensions(request.aspectRatio, request.longEdge);
  const evaluated = evaluateDirectorStage(request.state, request.timeSeconds);

  return await new Promise<CaptureResult>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(`Director product renderer timed out at ${request.timeSeconds}s`));
    }, 60_000);
    let settled = false;
    const finish = async () => {
      if (settled || sequence !== captureSequence) return;
      settled = true;
      try {
        const blob = await viewport.current?.capture({
          aspectRatio: request.aspectRatio,
          longEdge: request.longEdge,
          mimeType: "image/png",
        });
        if (!blob) throw new Error("Director product canvas is unavailable");
        window.clearTimeout(timeout);
        resolve({
          dataUrl: await blobDataUrl(blob),
          width: dimensions.width,
          height: dimensions.height,
          ...(evaluated.activeCameraId
            ? { activeCameraId: evaluated.activeCameraId }
            : {}),
        });
      } catch (error) {
        window.clearTimeout(timeout);
        reject(error);
      }
    };

    root.render(
      <div style={{ width: dimensions.width, height: dimensions.height }}>
        <DirectorViewport
          key={sequence}
          ref={viewport}
          state={request.state}
          selectedCameraId={evaluated.activeCameraId}
          transformMode="translate"
          viewMode="camera"
          timeSeconds={request.timeSeconds}
          environmentUrl={request.environmentUrl}
          showEnvironmentBackground={Boolean(request.environmentUrl)}
          assetUrls={request.assetUrls}
          codeSources={request.codeSources}
          onError={(error) => { settled = true; window.clearTimeout(timeout); reject(error); }}
          renderPalette={directorRenderPaletteFallback}
          onFrameRendered={() => { void finish(); }}
          className="clash-director-headless-viewport"
        />
      </div>,
    );
  });
};
