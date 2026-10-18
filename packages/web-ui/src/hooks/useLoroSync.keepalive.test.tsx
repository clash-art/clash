// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEEPALIVE_MS,
  KEEPALIVE_TIMEOUT_CLOSE_CODE,
  KEEPALIVE_TIMEOUT_REASON,
  startKeepalive,
  useLoroSync,
} from "./useLoroSync";
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
  readonly closeCalls: Array<{ code: number; reason: string }> = [];

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
    this.closeCalls.push({ code, reason });
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
    const keepalive = startKeepalive(ws);

    vi.advanceTimersByTime(KEEPALIVE_MS - 1);
    expect(ws.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ws.send).toHaveBeenCalledWith("ping");

    for (let i = 0; i < 2; i++) {
      keepalive.noteInbound();
      vi.advanceTimersByTime(KEEPALIVE_MS);
    }
    expect(ws.send).toHaveBeenCalledTimes(3);

    keepalive.stop();
    vi.advanceTimersByTime(2 * KEEPALIVE_MS);
    expect(ws.send).toHaveBeenCalledTimes(3);
  });

  it("stays quiet while the socket is not open and swallows send failures", () => {
    vi.useFakeTimers();
    const ws = {
      readyState: FakeWebSocket.CONNECTING,
      send: vi.fn(),
    };
    const keepalive = startKeepalive(ws);

    vi.advanceTimersByTime(2 * KEEPALIVE_MS);
    expect(ws.send).not.toHaveBeenCalled();

    ws.readyState = FakeWebSocket.OPEN;
    ws.send.mockImplementation(() => {
      throw new Error("socket closed");
    });
    expect(() => vi.advanceTimersByTime(KEEPALIVE_MS)).not.toThrow();
    expect(ws.send).toHaveBeenCalledTimes(1);

    keepalive.stop();
  });

  it("stays alive across 10 intervals while each ping gets a pong", () => {
    vi.useFakeTimers();
    const ws = { readyState: FakeWebSocket.OPEN, send: vi.fn() };
    const onDead = vi.fn();
    const keepalive = startKeepalive(ws, { onDead });

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(KEEPALIVE_MS);
      keepalive.noteInbound();
    }

    expect(ws.send).toHaveBeenCalledTimes(10);
    expect(onDead).not.toHaveBeenCalled();
    keepalive.stop();
  });

  it("declares the socket dead once at the next tick when a ping gets no reply", () => {
    vi.useFakeTimers();
    const ws = { readyState: FakeWebSocket.OPEN, send: vi.fn() };
    const onDead = vi.fn();
    startKeepalive(ws, { onDead });

    vi.advanceTimersByTime(KEEPALIVE_MS);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(onDead).not.toHaveBeenCalled();

    vi.advanceTimersByTime(KEEPALIVE_MS);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead).toHaveBeenCalledWith({ idleMs: 2 * KEEPALIVE_MS });

    vi.advanceTimersByTime(10 * KEEPALIVE_MS);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("counts a binary inbound frame as liveness", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, unmount } = renderHook(() =>
      useLoroSync({ projectId: "keepalive-binary" }),
    );

    try {
      await waitFor(() => expect(result.current.connected).toBe(true));
      const socket = FakeWebSocket.instances.at(-1)!;
      const opened = FakeWebSocket.instances.length;

      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
        });
        // Not a valid protocol frame; it is still traffic on the socket.
        await act(async () => {
          await socket.onmessage?.({ data: new Uint8Array([0]).buffer });
        });
      }

      expect(socket.sent.filter((frame) => frame === "ping")).toHaveLength(3);
      expect(socket.closeCalls).toEqual([]);
      expect(FakeWebSocket.instances).toHaveLength(opened);
      expect(result.current.connected).toBe(true);
    } finally {
      unmount();
      await act(async () => {});
    }
  });

  it("closes a silent socket with KEEPALIVE_TIMEOUT and reconnects", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, unmount } = renderHook(() =>
      useLoroSync({ projectId: "keepalive-dead" }),
    );

    try {
      await waitFor(() => expect(result.current.connected).toBe(true));
      const socket = FakeWebSocket.instances.at(-1)!;
      const opened = FakeWebSocket.instances.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * KEEPALIVE_MS);
      });

      expect(socket.closeCalls).toEqual([
        { code: KEEPALIVE_TIMEOUT_CLOSE_CODE, reason: KEEPALIVE_TIMEOUT_REASON },
      ]);
      expect(
        vi.mocked(console.warn).mock.calls.some((args) =>
          args.some((arg) => String(arg).includes("sync.keepalive_timeout")),
        ),
      ).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(FakeWebSocket.instances.length).toBe(opened + 1);
      await waitFor(() => expect(result.current.connected).toBe(true));
    } finally {
      unmount();
      await act(async () => {});
    }
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
