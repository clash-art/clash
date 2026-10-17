import { describe, expect, it } from "vitest";
import { assetUploadLabel } from "./assetUploadLabel";

describe("assetUploadLabel", () => {
  it("labels cloud uploads as a browser file picker", () => {
    expect(assetUploadLabel("cloud")).toBe("Upload from device");
  });

  it("labels local Host uploads as computer uploads", () => {
    expect(assetUploadLabel("local")).toBe("Upload from computer");
  });

  it("renders no upload entry when uploads are disabled", () => {
    expect(assetUploadLabel("disabled")).toBeNull();
  });
});
