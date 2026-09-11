// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useExecutablePluginActions } from "./useExecutablePluginActions";
import { useExecutablePluginViews } from "./useExecutablePluginViews";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("plugin catalog polling", () => {
  it.each(["actions", "views"] as const)(
    "does not rerender the workspace for unchanged %s, but publishes edits",
    async (kind) => {
      vi.useFakeTimers();
      let name = "Before";
      vi.stubGlobal("fetch", async () =>
        Response.json(
          kind === "actions"
            ? {
                actions: [
                  {
                    id: "caption",
                    name,
                    outputType: "text",
                    runtime: "local",
                    parameters: [],
                    pluginBinding: {
                      pluginId: "acme.captions",
                      version: "1.0.0",
                      exportId: "caption",
                      schemaHash: `sha256:${"a".repeat(64)}`,
                    },
                  },
                ],
              }
            : {
                views: [
                  {
                    pluginId: "community.storyboard",
                    version: "1.0.0",
                    schemaHash: `sha256:${"a".repeat(64)}`,
                    definitionId: "storyboard",
                    name,
                    presentation: { type: "storyboard" },
                    initialState: {
                      keyElements: [],
                      shots: [],
                      audioLayers: [],
                      uncategorized: [],
                    },
                  },
                ],
              },
        ),
      );
      const useCatalog =
        kind === "actions"
          ? useExecutablePluginActions
          : useExecutablePluginViews;
      let renders = 0;
      const { result } = renderHook(() => {
        renders += 1;
        return useCatalog(100);
      });
      await act(async () => {});
      expect(result.current[0]?.name).toBe("Before");
      const previous = result.current;
      const before = renders;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(result.current).toBe(previous);
      expect(renders).toBe(before);
      name = "After";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(result.current[0]?.name).toBe("After");
    },
  );
});
