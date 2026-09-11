// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
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
