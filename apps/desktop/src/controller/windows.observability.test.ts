import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const windows: FakeBrowserWindow[] = [];

  class FakeWebContents {
    listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    on(event: string, listener: (...args: unknown[]) => void) {
      const current = this.listeners.get(event) ?? [];
      current.push(listener);
      this.listeners.set(event, current);
    }
    async capturePage() {
      return { toPNG: () => Buffer.from([]) };
    }
    async executeJavaScript() {
      return {};
    }
  }

  class FakeBrowserWindow {
    static fromWebContents() {
      return undefined;
    }

    id = windows.length + 1;
    webContents = new FakeWebContents();
    listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    loadURL = vi.fn(async () => undefined);
    maximize = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    setWindowButtonVisibility = vi.fn();

    constructor() {
      windows.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      const current = this.listeners.get(event) ?? [];
      current.push(listener);
      this.listeners.set(event, current);
    }
    once(event: string, listener: (...args: unknown[]) => void) {
      this.on(event, listener);
    }
    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    isVisible() {
      return true;
    }
  }

  return { FakeBrowserWindow, windows };
});

vi.mock("electron", () => ({
  app: { isPackaged: false, on: vi.fn(), getPath: vi.fn() },
  BrowserWindow: electron.FakeBrowserWindow,
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

import { createDesktopWindowController } from "./windows";

function runtime() {
  return {
    mode: "desktop" as const,
    webUrl: "http://127.0.0.1:3001",
    apiBaseUrl: "http://127.0.0.1:49321",
    wsBaseUrl: "ws://127.0.0.1:49321",
    capabilities: {
      assets: {
        storage: "local" as const,
        signing: "unsigned" as const,
        upload: "local" as const,
      },
      workflows: {
        runner: "local-node" as const,
        mediaPostprocess: "disabled" as const,
      },
      loro: { persistence: "local" as const, sync: "local-websocket" as const },
      auth: { mode: "local-user" as const },
    },
  };
}

describe("desktop window observability", () => {
  beforeEach(() => {
    electron.windows.length = 0;
    vi.clearAllMocks();
  });

  it("deduplicates renderer console floods and emits a suppression summary", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const controller = createDesktopWindowController({
      moduleDir: "/app/dist",
      dataDir: "/tmp/clash-observability-test",
      currentRuntime: runtime,
      refreshRuntime: vi.fn(),
      log,
    });

    await controller.createWindow();
    const window = electron.windows[0];
    const consoleListener =
      window?.webContents.listeners.get("console-message")?.[0];
    expect(consoleListener).toBeTypeOf("function");

    consoleListener?.({ level: "warning", message: "repeated warning" });
    consoleListener?.({ level: "warning", message: "repeated warning" });
    consoleListener?.({ level: "warning", message: "repeated warning" });
    window?.emit("closed");

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenNthCalledWith(
      1,
      "[desktop:renderer:1:warning] repeated warning",
    );
    expect(log.warn).toHaveBeenNthCalledWith(
      2,
      "[desktop:renderer:1] suppressed 2 console messages across 1 fingerprints",
    );
  });

  it("forwards structured renderer errors with identity and source after an info flood", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn(), record: vi.fn() };
    const controller = createDesktopWindowController({ moduleDir: "/app/dist", dataDir: "/tmp/clash-observability-test", currentRuntime: runtime, refreshRuntime: vi.fn(), log });
    await controller.createWindow();
    const listener = electron.windows[0]?.webContents.listeners.get("console-message")?.[0];
    for (let i = 0; i < 120; i++) listener?.({ level: "info", message: `info-${i}` });
    listener?.({ level: "error", message: JSON.stringify({ schemaVersion: 1, timestamp: new Date().toISOString(), component: "renderer", module: "sync", level: "error", event: "sync.update_rejected", context: { projectId: "p", batchId: "b", error: { code: "STALE" } } }), sourceId: "https://clash.test/app.ts?token=secret", lineNumber: 42 });
    expect(log.record).toHaveBeenCalledWith(expect.objectContaining({ event: "sync.update_rejected", component: "renderer", module: "sync", context: expect.objectContaining({ projectId: "p", batchId: "b", windowId: 1, lineNumber: 42, sourceId: "https://clash.test/app.ts", error: { code: "STALE" } }) }));
  });

  it("reloads a crashed renderer and restores the maximized window", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      event: vi.fn(),
    };
    const controller = createDesktopWindowController({
      moduleDir: "/app/dist",
      dataDir: "/tmp/clash-observability-test",
      currentRuntime: runtime,
      refreshRuntime: vi.fn(),
      log,
    });

    await controller.createWindow();
    const window = electron.windows[0];
    const goneListener = window?.webContents.listeners.get(
      "render-process-gone",
    )?.[0];
    expect(goneListener).toBeTypeOf("function");

    goneListener?.({}, { reason: "crashed", exitCode: 5 });
    await vi.waitFor(() => expect(window?.loadURL).toHaveBeenCalledTimes(2));

    expect(window?.maximize).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.event).toHaveBeenCalledWith("error", "renderer.crashed", {
      windowId: 1,
      reason: "crashed",
      exitCode: 5,
    });
  });

  it("stops automatic reloads when the configured renderer recovery budget is exhausted", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      event: vi.fn(),
    };
    const controller = createDesktopWindowController({
      moduleDir: "/app/dist",
      dataDir: "/tmp/clash-observability-test",
      currentRuntime: runtime,
      refreshRuntime: vi.fn(),
      log,
      rendererRecoveryPolicy: { maxAttempts: 1, windowMs: 1_000 },
    });

    await controller.createWindow();
    const window = electron.windows[0];
    const goneListener = window?.webContents.listeners.get(
      "render-process-gone",
    )?.[0];

    goneListener?.({}, { reason: "crashed", exitCode: 5 });
    await vi.waitFor(() => expect(window?.maximize).toHaveBeenCalledTimes(2));
    goneListener?.({}, { reason: "crashed", exitCode: 5 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window?.loadURL).toHaveBeenCalledTimes(2);
    expect(log.event).toHaveBeenCalledWith(
      "error",
      "renderer.recovery_abandoned",
      { windowId: 1, reason: "crash_loop" },
    );
  });
});
