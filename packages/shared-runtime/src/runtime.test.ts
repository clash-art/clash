import { describe, expect, it } from "vitest";
import {
  apiUrl,
  defaultRuntimeCapabilities,
  resolveRuntimeConfig,
  syncWebSocketUrl,
  webSocketUrl,
} from "./index";

describe("runtime endpoint helpers", () => {
  it("keeps same-origin paths when no runtime base URL is configured", () => {
    const cfg = resolveRuntimeConfig({});

    expect(apiUrl("/api/v1/projects", cfg)).toBe("/api/v1/projects");
    expect(apiUrl("api/v1/projects", cfg)).toBe("/api/v1/projects");
  });

  it("joins configured local API origins without duplicating slashes", () => {
    const cfg = resolveRuntimeConfig({ apiBaseUrl: "http://127.0.0.1:49152/" });

    expect(apiUrl("/api/v1/projects", cfg)).toBe(
      "http://127.0.0.1:49152/api/v1/projects",
    );
    expect(apiUrl("/api/v1/projects/p1/assets", cfg)).toBe(
      "http://127.0.0.1:49152/api/v1/projects/p1/assets",
    );
  });

  it("passes already absolute URLs through unchanged", () => {
    const cfg = resolveRuntimeConfig({ apiBaseUrl: "http://127.0.0.1:49152" });

    expect(apiUrl("https://cdn.example.test/a.png", cfg)).toBe(
      "https://cdn.example.test/a.png",
    );
  });

  it("derives WebSocket origins from HTTP API origins unless explicitly overridden", () => {
    const derived = resolveRuntimeConfig({
      apiBaseUrl: "https://clash.example.test",
    });
    const explicit = resolveRuntimeConfig({
      apiBaseUrl: "http://127.0.0.1:49152",
      wsBaseUrl: "ws://127.0.0.1:49153",
    });

    expect(syncWebSocketUrl("project-1", derived)).toBe(
      "wss://clash.example.test/sync/project-1",
    );
    expect(syncWebSocketUrl("project/with slash", explicit)).toBe(
      "ws://127.0.0.1:49153/sync/project%2Fwith%20slash",
    );
    expect(
      webSocketUrl("/api/v1/local-sessions/session-1/_stream", explicit),
    ).toBe("ws://127.0.0.1:49153/api/v1/local-sessions/session-1/_stream");
  });

  it("defaults to hosted cloud capabilities", () => {
    const cfg = resolveRuntimeConfig({});

    expect(cfg.mode).toBe("hosted");
    expect(cfg.capabilities).toEqual(defaultRuntimeCapabilities("hosted"));
    expect(cfg.capabilities.assets.storage).toBe("cloud");
    expect(cfg.capabilities.assets.upload).toBe("cloud");
    expect(cfg.capabilities.host).toEqual({
      timelineRender: "unavailable",
      textRevisions: "available",
      voiceInput: "available",
      localAudio: "unavailable",
    });
    expect(cfg.capabilities.workflows.runner).toBe("cloudflare");
    expect(cfg.capabilities.loro.persistence).toBe("remote");
  });

  it("derives local-first capabilities for desktop/local runtime modes", () => {
    const desktop = resolveRuntimeConfig({
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:49321",
    });
    const local = resolveRuntimeConfig({
      mode: "local",
      apiBaseUrl: "http://127.0.0.1:49321",
    });

    for (const cfg of [desktop, local]) {
      expect(cfg.capabilities.assets.storage).toBe("local");
      expect(cfg.capabilities.assets.signing).toBe("unsigned");
      expect(cfg.capabilities.auth.mode).toBe("local-user");
      expect(cfg.capabilities.loro.persistence).toBe("local");
      expect(cfg.capabilities.loro.sync).toBe("local-websocket");
    }
    expect(desktop.capabilities.workflows.runner).toBe("local-node");
    expect(local.capabilities.workflows.runner).toBe("local-node");
  });

  it("allows runtime capability overrides without losing defaults", () => {
    const cfg = resolveRuntimeConfig({
      mode: "desktop",
      capabilities: {
        workflows: { runner: "local-node" },
        loro: { persistence: "hybrid" },
      },
    });

    expect(cfg.capabilities.assets.storage).toBe("local");
    expect(cfg.capabilities.workflows.runner).toBe("local-node");
    expect(cfg.capabilities.workflows.mediaPostprocess).toBe("disabled");
    expect(cfg.capabilities.loro.persistence).toBe("hybrid");
    expect(cfg.capabilities.loro.sync).toBe("local-websocket");
  });
});
