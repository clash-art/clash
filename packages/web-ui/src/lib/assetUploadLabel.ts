import type { RuntimeCapabilities } from "@clash/shared-runtime";

export type AssetUploadCapability = RuntimeCapabilities["assets"]["upload"];

/**
 * The single source of truth for the asset upload entry. `null` means the
 * runtime cannot accept uploads, so callers render no entry at all.
 */
export function assetUploadLabel(upload: AssetUploadCapability): string | null {
  switch (upload) {
    case "cloud":
      return "Upload from device";
    case "local":
      return "Upload from computer";
    case "disabled":
      return null;
  }
}
