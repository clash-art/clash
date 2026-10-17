import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  appOn: vi.fn(),
  ipcHandle: vi.fn(),
  protocolHandle: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, on: electron.appOn, getPath: vi.fn() },
  BrowserWindow: class BrowserWindow {
    static fromWebContents() {
      return undefined;
    }
  },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: { handle: electron.ipcHandle },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { handle: electron.protocolHandle },
  shell: { openExternal: vi.fn() },
}));

import { createDesktopWindowController } from "./windows";

describe("desktop project browser window routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("turns guest window.open requests into project browser tabs without creating a popup", () => {
    const controller = createDesktopWindowController({
      moduleDir: "/app/dist",
      dataDir: "/tmp/clash-browser-test",
      currentRuntime: () => ({
        mode: "desktop",
        webUrl: "http://127.0.0.1:3000",
        apiBaseUrl: "http://127.0.0.1:8789",
        wsBaseUrl: "ws://127.0.0.1:8789",
        capabilities: {
          assets: {
            storage: "local",
            signing: "unsigned",
            upload: "local",
          },
          workflows: {
            runner: "local-node",
            mediaPostprocess: "local-node",
          },
          loro: { persistence: "local", sync: "local-websocket" },
          host: { timelineRender: "available", textRevisions: "available", voiceInput: "available", localAudio: "available" },
          auth: { mode: "local-user" },
        },
      }),
      refreshRuntime: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    controller.registerHostBindings();

    const createdListener = electron.appOn.mock.calls.find(
      ([event]) => event === "web-contents-created",
    )?.[1] as
      ((event: unknown, contents: Record<string, unknown>) => void) | undefined;
    expect(createdListener).toBeTypeOf("function");

    const send = vi.fn();
    let openHandler:
      | ((details: { url: string; disposition: string }) => { action: string })
      | undefined;
    createdListener?.(
      {},
      {
        getType: () => "webview",
        hostWebContents: { send },
        setWindowOpenHandler: (
          handler: (details: { url: string; disposition: string }) => {
            action: string;
          },
        ) => {
          openHandler = handler;
        },
      },
    );

    expect(openHandler).toBeTypeOf("function");
    expect(
      openHandler?.({
        url: "https://app.example/redirected",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    expect(send).toHaveBeenCalledWith("clash:project-browser-open-tab", {
      url: "https://app.example/redirected",
      disposition: "foreground-tab",
    });
  });

  it("denies guest requests for local files without forwarding them", () => {
    const controller = createDesktopWindowController({
      moduleDir: "/app/dist",
      dataDir: "/tmp/clash-browser-test",
      currentRuntime: () => ({
        mode: "desktop",
        webUrl: "http://127.0.0.1:3000",
        apiBaseUrl: "http://127.0.0.1:8789",
        wsBaseUrl: "ws://127.0.0.1:8789",
        capabilities: {
          assets: {
            storage: "local",
            signing: "unsigned",
            upload: "local",
          },
          workflows: {
            runner: "local-node",
            mediaPostprocess: "local-node",
          },
          loro: { persistence: "local", sync: "local-websocket" },
          host: { timelineRender: "available", textRevisions: "available", voiceInput: "available", localAudio: "available" },
          auth: { mode: "local-user" },
        },
      }),
      refreshRuntime: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    controller.registerHostBindings();

    const createdListener = electron.appOn.mock.calls.find(
      ([event]) => event === "web-contents-created",
    )?.[1] as (event: unknown, contents: Record<string, unknown>) => void;
    const send = vi.fn();
    let openHandler:
      | ((details: { url: string; disposition: string }) => { action: string })
      | undefined;
    createdListener(
      {},
      {
        getType: () => "webview",
        hostWebContents: { send },
        setWindowOpenHandler: (
          handler: (details: { url: string; disposition: string }) => {
            action: string;
          },
        ) => {
          openHandler = handler;
        },
      },
    );

    expect(
      openHandler?.({
        url: "file:///Users/example/.ssh/id_ed25519",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    expect(send).not.toHaveBeenCalled();
  });
});
