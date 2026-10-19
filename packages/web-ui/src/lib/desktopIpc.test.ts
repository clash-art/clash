import { describe, expect, it } from "vitest";

import { DesktopIpcError, unwrapDesktopIpcResult } from "./desktopIpc";

describe("desktop IPC result contract", () => {
  it("unwraps a successful result", () => {
    expect(
      unwrapDesktopIpcResult({ ok: true, value: { documentPath: "/tmp/a.otio" } }),
    ).toEqual({ documentPath: "/tmp/a.otio" });
  });

  it("throws an error that keeps the coded failure visible", () => {
    expect(() =>
      unwrapDesktopIpcResult({
        ok: false,
        error: {
          code: "NLE_HANDOFF_DOWNLOAD_FAILED",
          message: "Could not download handoff media within 30000 ms.",
        },
      }),
    ).toThrowError(
      new DesktopIpcError(
        "NLE_HANDOFF_DOWNLOAD_FAILED",
        "Could not download handoff media within 30000 ms.",
      ),
    );
  });

  it("rejects a response that does not use the coded envelope", () => {
    expect(() => unwrapDesktopIpcResult({ documentPath: "/tmp/a.otio" })).toThrow(
      "DESKTOP_IPC_MALFORMED_RESULT",
    );
  });
});
