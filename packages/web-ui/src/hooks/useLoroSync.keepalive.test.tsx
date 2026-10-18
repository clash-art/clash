// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEPALIVE_MS, startKeepalive, useLoroSync } from "./useLoroSync";
import { setRuntimeConfigOverride } from "../lib/runtimeConfig";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  binaryType = "arraybuffer";
  bufferedAmount = 0;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose:
    | ((event: { code: number; reason: string; wasClean: boolean }) => void)
    | null = null;
  readonly url: string;
  readonly sent: unknown[] = [];

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
    });
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ timelines: [], versions: {} }), {
      headers: { "content-type": "application/json" },
    }),
  ));
  vi.stubGlobal("WebSocket", FakeWebSocket);
  setRuntimeConfigOverride(undefined);
  globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
  delete globalThis.__CLASH_DESKTOP__;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRuntimeConfigOverride(undefined);
  globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
  delete globalThis.__CLASH_DESKTOP__;
  window.localStorage.clear();
});

describe("useLoroSync keepalive", () => {
  it("sends the exact ping every 30s while open and stops on close", () => {
    vi.useFakeTimers();
    const ws = { readyState: FakeWebSocket.OPEN, send: vi.fn() };
    const stop = startKeepalive(ws);

    vi.advanceTimersByTime(KEEPALIVE_MS - 1);
    expect(ws.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ws.send).toHaveBeenCalledWith("ping");

    vi.advanceTimersByTime(2 * KEEPALIVE_MS);
    expect(ws.send).toHaveBeenCalledTimes(3);

    stop();
    vi.advanceTimersByTime(2 * KEEPALIVE_MS);
    expect(ws.send).toHaveBeenCalledTimes(3);
  });

  it("stays quiet while the socket is not open and swallows send failures", () => {
    vi.useFakeTimers();
    const ws = {
      readyState: FakeWebSocket.CONNECTING,
      send: vi.fn(),
    };
    const stop = startKeepalive(ws);

    vi.advanceTimersByTime(2 * KEEPALIVE_MS);
    expect(ws.send).not.toHaveBeenCalled();

    ws.readyState = FakeWebSocket.OPEN;
    ws.send.mockImplementation(() => {
      throw new Error("socket closed");
    });
    expect(() => vi.advanceTimersByTime(KEEPALIVE_MS)).not.toThrow();
    expect(ws.send).toHaveBeenCalledTimes(1);

    stop();
  });

  it("ignores an incoming pong text frame before JSON.parse", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const { result, unmount } = renderHook(() =>
      useLoroSync({ projectId: "keepalive-pong" }),
    );

    try {
      await waitFor(() => expect(result.current.connected).toBe(true));
      const socket = FakeWebSocket.instances.at(-1)!;
      const errorsBefore = vi.mocked(console.error).mock.calls.length;

      parse.mockClear();
      await act(async () => {
        await socket.onmessage?.({ data: "pong" });
      });

      expect(
        parse.mock.calls.some(([value]) => value === "pong"),
      ).toBe(false);
      expect(vi.mocked(console.error).mock.calls.length).toBe(errorsBefore);
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
      expect(result.current.connected).toBe(true);
    } finally {
      unmount();
      await act(async () => {});
    }
  });
});
