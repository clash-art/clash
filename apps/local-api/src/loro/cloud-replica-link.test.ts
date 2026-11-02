import { createServer as createHttpServer } from "node:http";
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import type { Duplex } from "node:stream";
import { hostname } from "node:os";
import { LoroDoc } from "loro-crdt";
import {
  CrdtType,
  MessageType,
  decode,
  encode,
} from "@clash/replica/loro-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_REPLICA_RECONNECT_MAX_MS,
  LoroCloudReplicaLink,
  cloudReplicaReconnectDelay,
  type CloudReplicaLinkState,
  type ReplicaLinkSocket,
} from "./cloud-replica-link.js";

class FakeSocket implements ReplicaLinkSocket {
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<
    string,
    Array<(...args: any[]) => void>
  >();

  on(event: string, listener: (...args: any[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

vi.mock("node:os", () => ({ hostname: vi.fn(() => "工作室-mac") }));

describe("LoroCloudReplicaLink", () => {
  it("connects local-api to the cloud room with offset-free VersionVector recovery", async () => {
    const doc = new LoroDoc();
    doc.getMap("nodes").set("offline", { label: "Offline" });
    doc.commit();
    const socket = new FakeSocket();
    const commit = vi.fn(async (_batchId: string, updates: Uint8Array[]) => {
      doc.importBatch(updates);
    });
    const createSocket = vi.fn(
      (_url: string, _headers: Record<string, string>) => socket,
    );
    const onJoined = vi.fn();
    const onDisconnected = vi.fn();
    const link = new LoroCloudReplicaLink({
      baseUrl: "https://cloud.example/",
      projectId: "project/one",
      token: "secret",
      doc: () => doc,
      commit,
      createSocket,
      onJoined,
      onDisconnected,
    });

    link.start();
    socket.readyState = 1;
    socket.emit("open");

    expect(createSocket).toHaveBeenCalledWith(
      "wss://cloud.example/sync/project%2Fone?protocol=loro-v1",
      {
        authorization: "Bearer secret",
        "x-client-type": "cli",
        "x-device-name": encodeURIComponent(`Clash Host · ${hostname()}`),
      },
      { handshakeTimeoutMs: 10_000 },
    );
    const deviceHeader = createSocket.mock.calls[0]?.[1]?.["x-device-name"];
    expect(decodeURIComponent(deviceHeader!)).toBe(
      `Clash Host · ${hostname()}`,
    );
    expect(deviceHeader).toMatch(/^[\x20-\x7e]+$/u);
    expect(decode(socket.sent[0]!)).toMatchObject({
      type: MessageType.JoinRequest,
      roomId: "project/one",
    });

    const cloud = new LoroDoc();
    const cloudVersion = cloud.version();
    socket.emit(
      "message",
      encode({
        type: MessageType.JoinResponseOk,
        crdt: CrdtType.Loro,
        roomId: "project/one",
        permission: "write",
        version: cloudVersion.encode(),
      }),
      true,
    );
    cloudVersion.free();
    await vi.waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(
        socket.sent
          .map((frame) => decode(frame))
          .some((message) => message.type === MessageType.DocUpdate),
      ).toBe(true);
    });

    const cloudSource = new LoroDoc();
    cloudSource.getMap("nodes").set("cloud", { label: "Cloud" });
    cloudSource.commit();
    socket.emit(
      "message",
      encode({
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId: "project/one",
        batchId: "0x0000000000000042",
        updates: [cloudSource.export({ mode: "snapshot" })],
      }),
      true,
    );
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(
      socket.sent
        .map((frame) => decode(frame))
        .find(
          (message) =>
            message.type === MessageType.Ack &&
            message.refId === "0x0000000000000042",
        ),
    ).toBeDefined();
    socket.emit("close");
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    await link.close();
  });

  it("treats an ACK raced by socket close as disconnect recovery, not an application error", async () => {
    const doc = new LoroDoc();
    const socket = new FakeSocket();
    const onError = vi.fn();
    const link = new LoroCloudReplicaLink({
      baseUrl: "https://cloud.example/",
      projectId: "project-1",
      doc: () => doc,
      createSocket: () => socket,
      commit: async (_batchId, updates) => {
        doc.importBatch(updates);
        socket.readyState = 2;
      },
      onError,
    });

    link.start();
    socket.readyState = 1;
    socket.emit("open");
    const emptyCloud = new LoroDoc();
    const emptyCloudVersion = emptyCloud.version();
    socket.emit(
      "message",
      encode({
        type: MessageType.JoinResponseOk,
        crdt: CrdtType.Loro,
        roomId: "project-1",
        permission: "write",
        version: emptyCloudVersion.encode(),
      }),
      true,
    );
    emptyCloudVersion.free();

    const cloudSource = new LoroDoc();
    cloudSource.getMap("nodes").set("cloud", { label: "Cloud" });
    cloudSource.commit();
    socket.emit(
      "message",
      encode({
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId: "project-1",
        batchId: "0x0000000000000043",
        updates: [cloudSource.export({ mode: "snapshot" })],
      }),
      true,
    );

    await vi.waitFor(() => {
      expect(doc.getMap("nodes").get("cloud")).toEqual({ label: "Cloud" });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onError).not.toHaveBeenCalled();
    await link.close();
  });

  describe("retry classification", () => {
    function linkWith(sockets: FakeSocket[]) {
      const onError = vi.fn();
      const onActionRequired = vi.fn();
      const createSocket = vi.fn(() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      });
      const link = new LoroCloudReplicaLink({
        baseUrl: "https://cloud.example/",
        projectId: "project-1",
        token: "t",
        doc: () => new LoroDoc(),
        createSocket,
        commit: async () => {},
        onError,
        onActionRequired,
      });
      return { link, createSocket, onError, onActionRequired };
    }

    it("stops reconnecting when the room closes 1008 (token revoked/expired)", async () => {
      vi.useFakeTimers();
      try {
        const sockets: FakeSocket[] = [];
        const { link, createSocket, onActionRequired } = linkWith(sockets);
        link.start();
        sockets[0]!.emit("close", 1008);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(createSocket).toHaveBeenCalledTimes(1);
        expect(onActionRequired).toHaveBeenCalledWith(
          expect.objectContaining({ severity: "user_action_required", action: "reauthenticate" }),
          expect.any(Error),
        );
        expect(link.actionRequired?.action).toBe("reauthenticate");
        // start() after re-auth resumes.
        link.start();
        expect(createSocket).toHaveBeenCalledTimes(2);
        await link.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops reconnecting on an upgrade 401", async () => {
      vi.useFakeTimers();
      try {
        const sockets: FakeSocket[] = [];
        const { link, createSocket, onActionRequired } = linkWith(sockets);
        link.start();
        sockets[0]!.emit("error", new Error("Unexpected server response: 401"));
        sockets[0]!.emit("close", 1006);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(createSocket).toHaveBeenCalledTimes(1);
        expect(onActionRequired).toHaveBeenCalledTimes(1);
        await link.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives up a blackholed handshake at the timeout and reports the coded state", async () => {
      vi.useFakeTimers();
      try {
        const sockets: FakeSocket[] = [];
        const states: any[] = [];
        const createSocket = vi.fn(() => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        });
        const link = new LoroCloudReplicaLink({
          baseUrl: "https://cloud.example/",
          projectId: "project-timeout",
          doc: () => new LoroDoc(),
          createSocket,
          commit: async () => {},
          onState: (state) => states.push(state),
          handshakeTimeoutMs: 1_000,
          reconnectBaseMs: 100,
          reconnectMaxMs: 1_000,
          random: () => 1,
        });
        link.start();
        expect(states.at(-1)).toMatchObject({ state: "connecting" });
        await vi.advanceTimersByTimeAsync(999);
        expect(
          states.some((state) => state.code === "CLOUD_LINK_HANDSHAKE_TIMEOUT"),
        ).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(states).toContainEqual(
          expect.objectContaining({
            state: "retrying",
            code: "CLOUD_LINK_HANDSHAKE_TIMEOUT",
            attempt: 1,
            retryAt: expect.any(String),
          }),
        );
        await vi.advanceTimersByTimeAsync(100);
        expect(createSocket).toHaveBeenCalledTimes(2);
        await link.close();
        expect(states.at(-1)).toMatchObject({ state: "stopped" });
        // A closed link never keeps a reconnect timer alive.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(createSocket).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("caps full-jittered reconnect delays at the configured ceiling", async () => {
      vi.useFakeTimers();
      try {
        const sockets: FakeSocket[] = [];
        const states: any[] = [];
        const createSocket = vi.fn(() => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        });
        const link = new LoroCloudReplicaLink({
          baseUrl: "https://cloud.example/",
          projectId: "project-backoff",
          doc: () => new LoroDoc(),
          createSocket,
          commit: async () => {},
          onState: (state) => states.push(state),
          reconnectBaseMs: 100,
          reconnectMaxMs: 1_000,
          random: () => 1,
        });
        link.start();
        const delays: number[] = [];
        for (let attempt = 0; attempt < 7; attempt += 1) {
          const before = sockets.length;
          sockets.at(-1)!.emit("close", 1006);
          const retry = states.filter((state) => state.state === "retrying").at(-1)!;
          const delay = Date.parse(retry.retryAt) - Date.now();
          delays.push(delay);
          expect(delay).toBeLessThanOrEqual(1_000);
          await vi.advanceTimersByTimeAsync(delay);
          expect(sockets.length).toBe(before + 1);
        }
        expect(delays).toEqual([100, 200, 400, 800, 1_000, 1_000, 1_000]);
        await link.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps backing off on transient closes (1006, 1011, 1012)", async () => {
      vi.useFakeTimers();
      try {
        const sockets: FakeSocket[] = [];
        const { link, createSocket, onActionRequired } = linkWith(sockets);
        link.start();
        for (const code of [1006, 1011, 1012]) {
          sockets.at(-1)!.emit("close", code);
          await vi.advanceTimersByTimeAsync(6_000);
        }
        expect(createSocket).toHaveBeenCalledTimes(4);
        expect(onActionRequired).not.toHaveBeenCalled();
        await link.close();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("reconnect jitter", () => {
    it("scales the delay by the random draw below a ceiling that stops at the cap", () => {
      const ceiling = (failures: number) =>
        cloudReplicaReconnectDelay(failures, { random: () => 1 });
      expect(ceiling(1)).toBeGreaterThan(ceiling(0));
      expect(ceiling(100)).toBe(CLOUD_REPLICA_RECONNECT_MAX_MS);
      expect(cloudReplicaReconnectDelay(100, { random: () => 0.5 })).toBe(
        CLOUD_REPLICA_RECONNECT_MAX_MS / 2,
      );
      expect(
        cloudReplicaReconnectDelay(100, { random: () => 0 }),
      ).toBeGreaterThan(0);
    });
  });

  describe("reconnect gate", () => {
    function gatedLink(beforeReconnect: () => Promise<void>) {
      const states: CloudReplicaLinkState[] = [];
      const createSocket = vi.fn(() => new FakeSocket());
      const link = new LoroCloudReplicaLink({
        baseUrl: "https://cloud.example/",
        projectId: "project-gate",
        doc: () => new LoroDoc(),
        createSocket,
        commit: async () => {},
        onError: () => {},
        onState: (state) => states.push(state),
        beforeReconnect,
        reconnectBaseMs: 100,
        reconnectMaxMs: 100,
        random: () => 1,
      });
      return { link, states, createSocket };
    }

    it("leaves no attempt or timer once the gate closes the link", async () => {
      vi.useFakeTimers();
      try {
        const sockets: FakeSocket[] = [];
        const { link, createSocket } = gatedLink(async () => {
          await link.close();
        });
        createSocket.mockImplementation(() => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        });
        link.start();
        sockets[0]!.emit("close", 1006);
        await vi.advanceTimersByTimeAsync(100);
        expect(createSocket).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries with a coded state when the gate fails while the link is open", async () => {
      vi.useFakeTimers();
      try {
        const sockets: FakeSocket[] = [];
        const gate = vi
          .fn<() => Promise<void>>()
          .mockRejectedValueOnce(new Error("config store busy"))
          .mockResolvedValue(undefined);
        const { link, states, createSocket } = gatedLink(gate);
        createSocket.mockImplementation(() => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        });
        link.start();
        sockets[0]!.emit("close", 1006);
        await vi.advanceTimersByTimeAsync(100);
        expect(createSocket).toHaveBeenCalledTimes(1);
        expect(states.at(-1)).toMatchObject({
          state: "retrying",
          code: "CLOUD_LINK_UNREACHABLE",
          message: "config store busy",
          retryAt: expect.any(String),
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(createSocket).toHaveBeenCalledTimes(2);
        await link.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores a gate from before a restart instead of connecting twice", async () => {
      vi.useFakeTimers();
      try {
        const sockets: FakeSocket[] = [];
        let releaseGate = () => {};
        const { link, createSocket } = gatedLink(
          () =>
            new Promise<void>((resolve) => {
              releaseGate = resolve;
            }),
        );
        createSocket.mockImplementation(() => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        });
        link.start();
        sockets[0]!.emit("close", 1006);
        await vi.advanceTimersByTimeAsync(100);
        await link.close();
        link.start();
        expect(createSocket).toHaveBeenCalledTimes(2);
        releaseGate();
        await vi.advanceTimersByTimeAsync(0);
        expect(createSocket).toHaveBeenCalledTimes(2);
        await link.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps retrying when reading the document throws during a reconnect", async () => {
      vi.useFakeTimers();
      try {
        const states: CloudReplicaLinkState[] = [];
        const sockets: FakeSocket[] = [];
        const doc = vi
          .fn<() => LoroDoc>()
          .mockImplementationOnce(() => new LoroDoc())
          .mockImplementationOnce(() => {
            throw new Error("document unavailable");
          })
          .mockImplementation(() => new LoroDoc());
        const link = new LoroCloudReplicaLink({
          baseUrl: "https://cloud.example/",
          projectId: "project-doc",
          doc,
          createSocket: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
          },
          commit: async () => {},
          onError: () => {},
          onState: (state) => states.push(state),
          reconnectBaseMs: 100,
          reconnectMaxMs: 100,
          random: () => 1,
        });
        link.start();
        sockets[0]!.emit("close", 1006);
        await vi.advanceTimersByTimeAsync(100);
        expect(states.at(-1)).toMatchObject({
          state: "retrying",
          code: "CLOUD_LINK_UNREACHABLE",
          message: "document unavailable",
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(sockets).toHaveLength(2);
        await link.close();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("throws from start() on an unusable URL and leaves nothing running", async () => {
    vi.useFakeTimers();
    try {
      const link = new LoroCloudReplicaLink({
        baseUrl: "ftp://cloud.example/",
        projectId: "project-url",
        doc: () => new LoroDoc(),
        commit: async () => {},
      });
      expect(() => link.start()).toThrow(TypeError);
      expect(vi.getTimerCount()).toBe(0);
      // The failed start did not leave it marked as running.
      expect(() => link.start()).toThrow(TypeError);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("against a blackholed endpoint", () => {
    const listening = (server: Server) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () =>
          resolve((server.address() as AddressInfo).port),
        );
      });
    function linkTo(port: number) {
      const states: CloudReplicaLinkState[] = [];
      const onError = vi.fn();
      const link = new LoroCloudReplicaLink({
        baseUrl: `http://127.0.0.1:${port}`,
        projectId: "project-blackhole",
        doc: () => new LoroDoc(),
        commit: async () => {},
        onError,
        onState: (state) => states.push(state),
        handshakeTimeoutMs: 100,
        // Long enough that one attempt is observed on its own.
        reconnectBaseMs: 60_000,
        reconnectMaxMs: 60_000,
        random: () => 1,
      });
      return { link, states, onError };
    }

    it("gives up during discovery when connections are accepted but never answered", async () => {
      const held = new Set<Socket>();
      const server = createTcpServer((socket) => {
        held.add(socket);
        socket.on("error", () => {});
      });
      const port = await listening(server);
      const { link, states, onError } = linkTo(port);
      try {
        const startedAt = Date.now();
        link.start();
        await vi.waitFor(() =>
          expect(states.at(-1)).toMatchObject({
            state: "retrying",
            code: "CLOUD_LINK_HANDSHAKE_TIMEOUT",
            attempt: 1,
            retryAt: expect.any(String),
          }),
        );
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(onError).toHaveBeenCalledTimes(1);
      } finally {
        await link.close();
        for (const socket of held) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("gives up the WebSocket upgrade when the server never answers it", async () => {
      const server = createHttpServer((_request, response) => {
        // Discovery: this cloud only speaks the WebSocket protocol.
        response.writeHead(404).end();
      });
      const held = new Set<Duplex>();
      server.on("upgrade", (_request, socket) => {
        held.add(socket);
        socket.on("error", () => {});
      });
      const port = await listening(server);
      const { link, states, onError } = linkTo(port);
      try {
        link.start();
        await vi.waitFor(() =>
          expect(states.at(-1)).toMatchObject({
            state: "retrying",
            code: "CLOUD_LINK_HANDSHAKE_TIMEOUT",
            attempt: 1,
          }),
        );
        // Let the transport finish aborting; that is cleanup, not a second failure.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(onError).toHaveBeenCalledTimes(1);
        expect(states.filter((state) => state.state === "retrying")).toHaveLength(1);
      } finally {
        await link.close();
        for (const socket of held) socket.destroy();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});

