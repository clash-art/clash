import { describe, expect, it, vi } from "vitest";
import { reconcileCodexModel } from "./codex-model-fallback.js";

// Codex ACP 1.7.0 createModelState emits model[effort] IDs from model/list;
// createModelConfigOption additionally inserts the current (possibly unknown) ID.
function session(current: string, available: string[]) {
  return {
    models: {
      currentModelId: `${current}[medium]`,
      availableModels: available.map((modelId) => ({ modelId, name: modelId })),
    },
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        name: "Model",
        currentValue: current,
        options: [current, ...available.map((id) => id.split("[")[0])].map(
          (value) => ({ value, name: value }),
        ),
      },
    ],
    setConfigOption: vi.fn(async () => []),
  };
}
describe("Codex model compatibility", () => {
  it("replaces an injected unknown model with an advertised model", async () => {
    const runtime = session("future-model", ["known[low]", "known[medium]"]);
    expect(await reconcileCodexModel(runtime)).toEqual({
      from: "future-model",
      to: "known",
    });
    expect(runtime.setConfigOption).toHaveBeenCalledWith("model", "known");
  });
  it("does not confuse an unsupported effort with an unsupported model", async () => {
    const runtime = session("known", ["known[low]"]);
    expect(await reconcileCodexModel(runtime)).toBeUndefined();
    expect(runtime.setConfigOption).not.toHaveBeenCalled();
  });
  it("does not invent a replacement when the catalog is missing or empty", async () => {
    const runtime = session("future", []);
    expect(await reconcileCodexModel(runtime)).toBeUndefined();
    expect(runtime.setConfigOption).not.toHaveBeenCalled();
  });
  it("propagates rejected selection instead of claiming a successful fallback", async () => {
    const runtime = session("future", ["known[medium]"]);
    runtime.setConfigOption.mockRejectedValue(new Error("Model unavailable"));
    await expect(reconcileCodexModel(runtime)).rejects.toThrow(
      "Model unavailable",
    );
  });
  it("checks a stale saved model before sending it to the adapter", async () => {
    const runtime = session("known", ["known[medium]"]);
    expect(await reconcileCodexModel(runtime, "retired")).toEqual({
      from: "retired",
      to: "known",
    });
    expect(runtime.setConfigOption).toHaveBeenCalledWith("model", "known");
  });
});
