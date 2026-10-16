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
  LoroCloudReplicaLink,
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
});
