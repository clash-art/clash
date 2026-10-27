import { describe, expect, it, vi } from "vitest";
import { createPreviewHost } from "./createPreviewHost";
import {
  createIframePreviewHost,
  type PreviewHostBridge,
} from "./iframeHost";
import { createMainThreadPreviewHost } from "./mainThreadHost";
import {
  PREVIEW_HOST_PROTOCOL,
  type PreviewHostCommand,
  type PreviewHostEvent,
} from "./protocol";
import type { PreviewHostFact } from "./types";

const composition = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 300,
};

function fakePlayer() {
  return {
    getCurrentFrame: vi.fn(() => 12),
    seekTo: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
  };
}

describe("main-thread preview host", () => {
  it("forwards transport intent to the player that already owns the clock", () => {
    const player = fakePlayer();
    const host = createMainThreadPreviewHost({
      resolvePlayer: () => player,
    });
    host.mount(composition);
    host.seek(42);
    host.play();
    host.pause();
    expect(player.seekTo).toHaveBeenCalledWith(42);
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.pause).toHaveBeenCalledTimes(1);
  });

  it("does not touch the player before the host is mounted", () => {
    const player = fakePlayer();
    const host = createMainThreadPreviewHost({
      resolvePlayer: () => player,
    });
    host.seek(42);
    host.play();
    expect(player.seekTo).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
  });

  it("republishes the player's own facts to subscribers", () => {
    const player = fakePlayer();
    const host = createMainThreadPreviewHost({
      resolvePlayer: () => player,
    });
    const facts: PreviewHostFact[] = [];
    host.subscribe((fact) => facts.push(fact));
    host.publish({ type: "frame", frame: 8 });
    host.publish({ type: "transport", event: { type: "waiting" } });
    expect(facts).toEqual([
      { type: "frame", frame: 8 },
      { type: "transport", event: { type: "waiting" } },
    ]);
    expect(host.getCurrentFrame()).toBe(8);
  });

  it("stops notifying a listener that unsubscribed", () => {
    const host = createMainThreadPreviewHost({ resolvePlayer: () => null });
    const listener = vi.fn();
    const unsubscribe = host.subscribe(listener);
    unsubscribe();
    host.publish({ type: "frame", frame: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("iframe preview host", () => {
  function fakeBridge() {
    const sent: PreviewHostCommand[] = [];
    const listeners = new Set<(event: PreviewHostEvent) => void>();
    const bridge: PreviewHostBridge = {
      send: (command) => {
        sent.push(command);
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose: vi.fn(),
    };
    return {
      bridge,
      sent,
      emit(event: PreviewHostEvent) {
        for (const listener of [...listeners]) listener(event);
      },
    };
  }

  it("posts the mount command with the composition geometry", () => {
    const { bridge, sent } = fakeBridge();
    const host = createIframePreviewHost({ createBridge: () => bridge });
    host.mount(composition);
    expect(sent).toEqual([
      {
        protocol: PREVIEW_HOST_PROTOCOL,
        type: "mount",
        composition,
      },
    ]);
  });

  it("posts seek and play intent without inventing a clock", () => {
    const { bridge, sent } = fakeBridge();
    const host = createIframePreviewHost({ createBridge: () => bridge });
    host.mount(composition);
    host.seek(120);
    host.play();
    host.pause();
    expect(sent.slice(1)).toEqual([
      { protocol: PREVIEW_HOST_PROTOCOL, type: "seek", frame: 120 },
      { protocol: PREVIEW_HOST_PROTOCOL, type: "play" },
      { protocol: PREVIEW_HOST_PROTOCOL, type: "pause" },
    ]);
  });

  it("turns the frame's own facts into editor facts", () => {
    const { bridge, emit } = fakeBridge();
    const host = createIframePreviewHost({ createBridge: () => bridge });
    const facts: PreviewHostFact[] = [];
    host.subscribe((fact) => facts.push(fact));
    host.mount(composition);
    emit({
      protocol: PREVIEW_HOST_PROTOCOL,
      type: "frame",
      frame: 33,
    });
    emit({
      protocol: PREVIEW_HOST_PROTOCOL,
      type: "transport",
      event: { type: "waiting" },
    });
    emit({
      protocol: PREVIEW_HOST_PROTOCOL,
      type: "error",
      message: "decode failed",
    });
    expect(facts).toEqual([
      { type: "frame", frame: 33 },
      { type: "transport", event: { type: "waiting" } },
      { type: "error", message: "decode failed" },
    ]);
    expect(host.getCurrentFrame()).toBe(33);
  });

  it("unmounts the frame and stops listening to it", () => {
    const { bridge, emit, sent } = fakeBridge();
    const host = createIframePreviewHost({ createBridge: () => bridge });
    const listener = vi.fn();
    host.subscribe(listener);
    host.mount(composition);
    host.unmount();
    expect(sent.at(-1)).toEqual({
      protocol: PREVIEW_HOST_PROTOCOL,
      type: "unmount",
    });
    expect(bridge.dispose).toHaveBeenCalledTimes(1);
    emit({
      protocol: PREVIEW_HOST_PROTOCOL,
      type: "frame",
      frame: 99,
    });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("createPreviewHost", () => {
  it("builds a main-thread host that keeps today's behaviour", () => {
    const player = fakePlayer();
    const host = createPreviewHost({
      mode: "main-thread",
      mainThread: { resolvePlayer: () => player },
    });
    expect(host.mode).toBe("main-thread");
    host.mount(composition);
    host.play();
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it("builds an iframe host that talks to a frame", () => {
    const sent: PreviewHostCommand[] = [];
    const host = createPreviewHost({
      mode: "iframe",
      iframe: {
        createBridge: () => ({
          send: (command) => sent.push(command),
          onEvent: () => () => undefined,
          dispose: () => undefined,
        }),
      },
    });
    expect(host.mode).toBe("iframe");
    host.mount(composition);
    host.seek(3);
    expect(sent.map((command) => command.type)).toEqual(["mount", "seek"]);
  });

  it("refuses to guess the options a mode needs", () => {
    expect(() => createPreviewHost({ mode: "main-thread" })).toThrow(
      /mainThread/,
    );
    expect(() => createPreviewHost({ mode: "iframe" })).toThrow(/iframe/);
  });
});
