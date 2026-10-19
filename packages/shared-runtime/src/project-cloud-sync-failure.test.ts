import { describe, expect, it } from "vitest";
import {
  isActionRequiredSyncFailure,
  PROJECT_CLOUD_MIRROR_FAILED,
  projectCloudSyncFailureMessage,
} from "./project-cloud-sync";

describe("project cloud sync failure severity", () => {
  it("asks the user to free disk space on ENOSPC and stops auto-retry", () => {
    const error = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    const lastError = projectCloudSyncFailureMessage(error);
    expect(lastError).toMatch(/^Action required: this computer is out of disk space/);
    expect(isActionRequiredSyncFailure({ status: "failed", lastError })).toBe(true);
  });

  it("asks to sign in again on 401/403", () => {
    const error = Object.assign(new Error("Project content transport failed (401)"), { status: 401 });
    expect(projectCloudSyncFailureMessage(error)).toMatch(/sign in again/i);
  });

  it("labels an uncoded failure with the plane that fell behind", () => {
    const lastError = projectCloudSyncFailureMessage(
      new Error("fetch failed"),
      PROJECT_CLOUD_MIRROR_FAILED,
    );
    expect(lastError).toBe("PROJECT_CLOUD_MIRROR_FAILED: fetch failed");
    expect(isActionRequiredSyncFailure({ status: "failed", lastError })).toBe(
      false,
    );
  });

  it("keeps transient failures as-is when the caller names no plane", () => {
    const error = Object.assign(new Error("Project content transport failed (503)"), { status: 503 });
    const lastError = projectCloudSyncFailureMessage(error);
    expect(lastError).toBe("Project content transport failed (503)");
    expect(isActionRequiredSyncFailure({ status: "failed", lastError })).toBe(false);
  });
});
