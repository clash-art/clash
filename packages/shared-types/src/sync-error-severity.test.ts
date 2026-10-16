import { describe, expect, it } from "vitest";
import {
  SYNC_ERROR_SEVERITY_POLICY,
  classifyLoroUpdateRejection,
  classifySyncError,
} from "./sync-error-severity.js";

describe("sync error severity taxonomy", () => {
  it("defines retry, UI and log policy for every level", () => {
    expect(SYNC_ERROR_SEVERITY_POLICY.transient).toMatchObject({ retry: "backoff", ui: "silent" });
    expect(SYNC_ERROR_SEVERITY_POLICY.degraded).toMatchObject({ retry: "backoff", ui: "notice", log: "warn" });
    expect(SYNC_ERROR_SEVERITY_POLICY.user_action_required).toMatchObject({ retry: "none", ui: "actionable" });
    expect(SYNC_ERROR_SEVERITY_POLICY.fatal).toMatchObject({ retry: "none", ui: "blocking", log: "error", telemetry: true });
  });

  it.each([
    ["UPLOAD_FAILED", "transient"],
    ["DOWNLOAD_FAILED", "transient"],
    ["SIGNING_FAILED", "transient"],
    ["REMOTE_NOT_FOUND", "degraded"],
    ["LOCAL_RESOURCE_MISSING", "degraded"],
    ["FORBIDDEN", "user_action_required"],
    ["ENOSPC", "user_action_required"],
    ["EDQUOT", "user_action_required"],
    ["INTEGRITY_MISMATCH", "fatal"],
    ["INVALID_RESOURCE", "fatal"],
    ["INVALID_INPUT", "fatal"],
  ])("classifies existing code %s as %s", (code, severity) => {
    expect(classifySyncError({ code }).severity).toBe(severity);
  });

  it("never retries auth failures (no reconnect loops)", () => {
    for (const signal of [{ httpStatus: 401 }, { httpStatus: 403 }, { wsCloseCode: 1008 }]) {
      const c = classifySyncError(signal);
      expect(c).toMatchObject({ severity: "user_action_required", action: "reauthenticate" });
      expect(c.policy.retry).toBe("none");
    }
  });

  it.each([
    [{ wsCloseCode: 1006 }, "transient"],
    [{ wsCloseCode: 1001 }, "transient"],
    [{ wsCloseCode: 1011 }, "transient"],
    [{ wsCloseCode: 1009 }, "user_action_required"],
    [{ httpStatus: 429 }, "transient"],
    [{ httpStatus: 503 }, "transient"],
    [{ httpStatus: 409 }, "degraded"],
    [{ httpStatus: 413 }, "user_action_required"],
    [{ httpStatus: 400 }, "fatal"],
    [{}, "transient"],
  ] as const)("classifies %o as %s", (signal, severity) => {
    expect(classifySyncError(signal).severity).toBe(severity);
  });

  it.each([
    [3, "user_action_required"],
    [5, "user_action_required"],
    [1, "transient"],
    [6, "transient"],
    [7, "transient"],
    [4, "fatal"],
    [127, "fatal"],
  ])("classifies Loro update status %i as %s", (status, severity) => {
    expect(classifyLoroUpdateRejection(status).severity).toBe(severity);
  });
});
