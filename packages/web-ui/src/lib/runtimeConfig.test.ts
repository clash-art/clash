import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeConfig,
  readRuntimeModeAtCompositionRoot,
  getRuntimeCapabilities,
  runtimeApiUrl,
  runtimeFetch,
  setRuntimeConfigOverride,
  runtimeSyncWebSocketUrl,
  runtimeWebSocketUrl,
} from "./runtimeConfig";

describe("web-ui runtimeConfig", () => {
  beforeEach(() => {
    setRuntimeConfigOverride(undefined);
    globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
    delete (
      globalThis as typeof globalThis & { __CLASH_DESKTOP__?: unknown }
    ).__CLASH_DESKTOP__;
  });

  it("defaults to hosted same-origin HTTP paths", () => {
    expect(readRuntimeModeAtCompositionRoot()).toBe("hosted");
    expect(getRuntimeConfig()).toMatchObject({
      apiBaseUrl: "",
      wsBaseUrl: "",
    });
    expect(getRuntimeConfig()).not.toHaveProperty("mode");
    expect(getRuntimeCapabilities().assets.storage).toBe("cloud");
    expect(runtimeApiUrl("/api/v1/projects")).toBe("/api/v1/projects");
  });

  it("uses the injected local backend origin for HTTP paths", () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:49152",
    };

    expect(runtimeApiUrl("/api/v1/projects")).toBe(
      "http://127.0.0.1:49152/api/v1/projects",
    );
    expect(runtimeApiUrl("/upload")).toBe("http://127.0.0.1:49152/upload");
    expect(getRuntimeCapabilities().assets.storage).toBe("local");
    expect(getRuntimeCapabilities().loro.persistence).toBe("local");
  });

  it("builds sync WebSocket URLs from either injected config or browser location", () => {
    expect(
      runtimeSyncWebSocketUrl("p1", {
        protocol: "https:",
        host: "app.example.test",
      }),
    ).toBe("wss://app.example.test/sync/p1");

    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      apiBaseUrl: "http://127.0.0.1:49152",
      wsBaseUrl: "ws://127.0.0.1:49153",
    };

    expect(
      runtimeSyncWebSocketUrl("project/one", {
        protocol: "https:",
        host: "ignored.test",
      }),
    ).toBe("ws://127.0.0.1:49153/sync/project%2Fone");
    expect(
      runtimeWebSocketUrl("/api/v1/local-sessions/s1/_stream", {
        protocol: "https:",
        host: "ignored.test",
      }),
    ).toBe("ws://127.0.0.1:49153/api/v1/local-sessions/s1/_stream");
  });

  it("refreshes a stale Desktop Host endpoint and retries the failed request once", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:50138",
      wsBaseUrl: "ws://127.0.0.1:50138",
    };
    const refreshRuntime = vi.fn().mockResolvedValue({
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:55137",
      wsBaseUrl: "ws://127.0.0.1:55137",
    });
    (
      globalThis as typeof globalThis & {
        __CLASH_DESKTOP__?: {
          isDesktop: boolean;
          newWindow: () => Promise<{ windowId: number; windowCount: number }>;
          refreshRuntime: typeof refreshRuntime;
        };
      }
    ).__CLASH_DESKTOP__ = {
      isDesktop: true,
      newWindow: vi.fn(),
      refreshRuntime,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("ok"));

    const response = await runtimeFetch(
      "/api/v1/projects/project-1",
      { credentials: "include" },
      fetchImpl,
    );

    expect(await response.text()).toBe("ok");
    expect(refreshRuntime).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:50138/api/v1/projects/project-1",
      { credentials: "include" },
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:55137/api/v1/projects/project-1",
      { credentials: "include" },
    );
    expect(
      runtimeSyncWebSocketUrl("project-1", {
        protocol: "http:",
        host: "127.0.0.1:3001",
      }),
    ).toBe("ws://127.0.0.1:55137/sync/project-1");
  });
});
