import { describe, expect, it } from "vitest";
import { formatNodeFailure } from "./node-failure.js";

describe("formatNodeFailure", () => {
  it("shows the failure code next to the message", () => {
    expect(
      formatNodeFailure({
        status: "failed",
        error: "Run exceeded its deadline",
        errorCode: "deadline_exceeded",
      }),
    ).toBe("Run exceeded its deadline [deadline_exceeded]");
  });

  it("shows only the message when the node has no code", () => {
    expect(formatNodeFailure({ error: "Provider rejected the prompt" })).toBe(
      "Provider rejected the prompt",
    );
    expect(
      formatNodeFailure({ error: "Provider rejected the prompt", errorCode: " " }),
    ).toBe("Provider rejected the prompt");
  });

  it("reads a legacy hosted errorMessage when error is absent", () => {
    expect(
      formatNodeFailure({
        errorMessage: "Plugin unavailable",
        errorCode: "plugin_unavailable",
      }),
    ).toBe("Plugin unavailable [plugin_unavailable]");
  });

  it("reads an older local node's failureCode when errorCode is absent", () => {
    expect(
      formatNodeFailure({ error: "Timeline render is missing its frozen Action input owner.", failureCode: "TIMELINE_RENDER_INPUT_INVALID" }),
    ).toBe("Timeline render is missing its frozen Action input owner. [TIMELINE_RENDER_INPUT_INVALID]");
    expect(formatNodeFailure({ error: "x", errorCode: "new_code", failureCode: "old_code" })).toBe("x [new_code]");
  });

  it("never renders an empty failure", () => {
    expect(formatNodeFailure({ status: "failed" })).toBe(
      "Generation failed without an error message [unknown_failure]",
    );
    expect(formatNodeFailure({ error: "  ", errorCode: "" })).toBe(
      "Generation failed without an error message [unknown_failure]",
    );
    expect(formatNodeFailure(undefined)).toBe(
      "Generation failed without an error message [unknown_failure]",
    );
    expect(formatNodeFailure({ errorCode: "contract_violation" })).toBe(
      "Generation failed without an error message [contract_violation]",
    );
  });
});
