// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoPoster } from "./VideoPoster";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("waits for a completed first-frame seek before drawing the poster", () => {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["frame"])),
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:poster");
      static revokeObjectURL = vi.fn();
    },
  );
  const { container, getByAltText } = render(
    <VideoPoster videoSrc="/video.mp4" status="ready" alt="Cover" />,
  );
  const video = container.querySelector("video")!;
  Object.defineProperties(video, {
    videoWidth: { value: 1620 },
    videoHeight: { value: 1080 },
  });
  // Chromium can emit loadeddata before drawImage has a usable video frame.
  fireEvent.loadedData(video);
  expect(drawImage).not.toHaveBeenCalled();
  fireEvent.seeked(video);
  expect(drawImage).toHaveBeenCalledWith(
    video,
    0,
    0,
    expect.any(Number),
    expect.any(Number),
  );
  expect(getByAltText("Cover").getAttribute("src")).toBe("blob:poster");
  expect(container.querySelector("video")).toBeNull();
});

it("shows an already decoded first frame when loading at zero produces no seeked event", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["decoded first frame"])),
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:decoded-poster");
      static revokeObjectURL = vi.fn();
    },
  );
  const { container, getByAltText, queryByText } = render(
    <VideoPoster
      videoSrc="/trimmed.mp4"
      status="ready"
      alt="Trimmed cover"
      fallback={<span>Preparing preview</span>}
    />,
  );
  const video = container.querySelector("video")!;
  // Captured browser state for the real 2–8s trim: decoded at zero, no seek.
  Object.defineProperties(video, {
    videoWidth: { value: 1080 },
    videoHeight: { value: 1920 },
    readyState: { value: HTMLMediaElement.HAVE_ENOUGH_DATA },
    seeking: { value: false },
  });
  fireEvent.loadedData(video);

  expect(getByAltText("Trimmed cover").getAttribute("src")).toBe(
    "blob:decoded-poster",
  );
  expect(queryByText("Preparing preview")).toBeNull();
  expect(container.querySelector("video")).toBeNull();
});

it("waits for the presented frame when the browser supports frame callbacks", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["presented frame"])),
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:presented-poster");
      static revokeObjectURL = vi.fn();
    },
  );
  const { container, queryByAltText, getByAltText } = render(
    <VideoPoster
      videoSrc="/trimmed.mp4"
      status="ready"
      alt="Presented cover"
    />,
  );
  const video = container.querySelector("video")!;
  let presentFrame: (() => void) | undefined;
  Object.defineProperties(video, {
    videoWidth: { value: 1080 },
    videoHeight: { value: 1920 },
    readyState: { value: HTMLMediaElement.HAVE_ENOUGH_DATA },
    requestVideoFrameCallback: {
      value: (callback: () => void) => {
        presentFrame = callback;
        return 1;
      },
    },
    cancelVideoFrameCallback: { value: vi.fn() },
  });
  fireEvent.loadedMetadata(video);
  fireEvent.loadedData(video);
  fireEvent.seeked(video);
  // In Chromium, drawing before frame presentation produced a black poster.
  expect(queryByAltText("Presented cover")).toBeNull();
  act(() => presentFrame?.());
  expect(getByAltText("Presented cover").getAttribute("src")).toBe(
    "blob:presented-poster",
  );
});
