import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplicaStreamClientOptions } from "@clash/replica/replica-stream-client";
import type {
  CloudReplicaLinkState,
  LoroCloudReplicaLinkOptions,
} from "./cloud-replica-link.js";
import { CursorCloudReplicaLink } from "./cursor-cloud-replica-link.js";

const clients = vi.hoisted(
  () =>
    [] as Array<{
      options: ReplicaStreamClientOptions;
      start: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      append: ReturnType<typeof vi.fn>;
    }>,
);
const nextStart = vi.hoisted(() => ({
  run: async (): Promise<void> => {},
}));

vi.mock("@clash/replica/replica-stream-client", () => ({
  createReplicaStreamClient: (options: ReplicaStreamClientOptions) => {
    const client = {
      options,
      start: vi.fn(() => nextStart.run()),
      close: vi.fn(async () => {}),
      append: vi.fn(async () => "1"),
    };
    clients.push(client);
    return client;
  },
}));

function link(overrides: Partial<LoroCloudReplicaLinkOptions> = {}) {
  const states: CloudReplicaLinkState[] = [];
  const instance = new CursorCloudReplicaLink(
    {
      baseUrl: "https://cloud.example",
      projectId: "project-cursor",
      doc: () => new LoroDoc(),
      commit: async () => {},
      onError: () => {},
      onState: (state) => states.push(state),
      reconnectBaseMs: 100,
      reconnectMaxMs: 1_000,
      random: () => 1,
      ...overrides,
    },
    "https://cloud.example/replica",
  );
  const retries = () => states.filter((state) => state.state === "retrying");
  return { instance, states, retries };
}

const delayOf = (state: CloudReplicaLinkState) =>
  Date.parse(state.retryAt!) - Date.now();

describe("CursorCloudReplicaLink reconnects", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clients.length = 0;
    nextStart.run = async () => {
      throw new TypeError("fetch failed");
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off to the cap instead of retrying at a fixed interval", async () => {
    const { instance, retries } = link();
    instance.start();
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await vi.advanceTimersByTimeAsync(0);
      expect(retries()).toHaveLength(attempt);
      const retry = retries().at(-1)!;
      expect(retry).toMatchObject({
        code: "CLOUD_LINK_UNREACHABLE",
        attempt,
        message: "fetch failed",
      });
      const delay = delayOf(retry);
      delays.push(delay);
      await vi.advanceTimersByTimeAsync(delay);
      expect(clients).toHaveLength(attempt + 1);
    }
    expect(delays).toEqual([100, 200, 400, 800, 1_000, 1_000]);
    await instance.close();
  });

  it("draws each delay from the jitter source", async () => {
    const { instance, retries } = link({ random: () => 0.5 });
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(delayOf(retries().at(-1)!)).toBe(50);
    await instance.close();
  });

  it("restarts the backoff after a completed join", async () => {
    const { instance, retries } = link();
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(delayOf(retries().at(-1)!));
    await vi.advanceTimersByTimeAsync(0);
    expect(delayOf(retries().at(-1)!)).toBe(200);

    nextStart.run = async () => {};
    await vi.advanceTimersByTimeAsync(delayOf(retries().at(-1)!));
    const joined = clients.at(-1)!;
    joined.options.onReady?.();
    await vi.advanceTimersByTimeAsync(0);
    joined.options.onError?.(new Error("stream dropped"));
    expect(delayOf(retries().at(-1)!)).toBe(100);
    await instance.close();
  });

  it("does not reset the backoff when the stream opens but the join upload fails", async () => {
    const { instance, retries } = link();
    nextStart.run = async () => {};
    instance.start();
    const client = clients.at(-1)!;
    client.append.mockRejectedValueOnce(new TypeError("fetch failed"));
    client.options.onReady?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(retries().at(-1)).toMatchObject({ attempt: 1 });
    await vi.advanceTimersByTimeAsync(100);
    const second = clients.at(-1)!;
    second.append.mockRejectedValueOnce(new TypeError("fetch failed"));
    second.options.onReady?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(retries().at(-1)).toMatchObject({ attempt: 2 });
    expect(delayOf(retries().at(-1)!)).toBe(200);
    await instance.close();
  });

  it("codes an SDK connect timeout as a handshake timeout", async () => {
    // StreamsClient reports an expired connect as `{ code: "timeout" }`, and
    // createReplicaStreamClient copies that code onto the Error it raises.
    nextStart.run = async () => {
      throw Object.assign(new Error("Request timed out"), { code: "timeout" });
    };
    const { instance, retries } = link();
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(retries().at(-1)).toMatchObject({
      code: "CLOUD_LINK_HANDSHAKE_TIMEOUT",
      retryAt: expect.any(String),
    });
    await instance.close();
  });

  it("publishes one retry state per scheduled attempt", async () => {
    const { instance, retries } = link();
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    const scheduled = retries().at(-1)!;
    clients.at(-1)!.options.onError?.(new Error("late stream error"));
    expect(retries()).toHaveLength(1);
    expect(retries().at(-1)).toBe(scheduled);
    await instance.close();
  });

  it("leaves no attempt or timer once the gate closes the link", async () => {
    const { instance, retries } = link({
      beforeReconnect: async () => {
        await instance.close();
      },
    });
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(delayOf(retries().at(-1)!));
    expect(clients).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries when the gate fails while the link is open", async () => {
    const gate = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("config store busy"))
      .mockResolvedValue(undefined);
    const { instance, retries } = link({ beforeReconnect: gate });
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(delayOf(retries().at(-1)!));
    expect(clients).toHaveLength(1);
    expect(retries().at(-1)).toMatchObject({
      code: "CLOUD_LINK_UNREACHABLE",
      message: "config store busy",
      attempt: 2,
    });
    await instance.close();
  });

  it("reports a document that cannot be read instead of throwing from a timer", async () => {
    const doc = vi
      .fn<() => LoroDoc>()
      .mockImplementationOnce(() => {
        throw new Error("document unavailable");
      })
      .mockImplementation(() => new LoroDoc());
    const { instance, retries } = link({ doc });
    expect(() => instance.start()).not.toThrow();
    expect(retries().at(-1)).toMatchObject({
      code: "CLOUD_LINK_UNREACHABLE",
      message: "document unavailable",
    });
    await vi.advanceTimersByTimeAsync(delayOf(retries().at(-1)!));
    expect(clients).toHaveLength(1);
    await instance.close();
  });
});
