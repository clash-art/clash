import { LoroDoc } from "loro-crdt";
import {
  CrdtType,
  MessageType,
  UpdateStatusCode,
  decode,
  encode,
} from "loro-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  LoroProtocolClientSession,
  LoroProtocolServerSession,
} from "./loro-protocol";

describe("LoroProtocolServerSession", () => {
  it("joins with a version vector and backfills only the missing document state", async () => {
    const serverDoc = new LoroDoc();
    serverDoc.getMap("nodes").set("server", { label: "Server" });
    serverDoc.commit();
    const clientDoc = new LoroDoc();
    const sent: Uint8Array[] = [];
    const session = new LoroProtocolServerSession({
      roomId: "project-1",
      doc: () => serverDoc,
      commit: vi.fn(),
      send: (frame) => {
        sent.push(frame);
      },
    });

    await session.receive(
      encode({
        type: MessageType.JoinRequest,
        crdt: CrdtType.Loro,
        roomId: "project-1",
        auth: new Uint8Array(),
        version: clientDoc.version().encode(),
      }),
    );

    expect(decode(sent[0]!)).toMatchObject({
      type: MessageType.JoinResponseOk,
      crdt: CrdtType.Loro,
      roomId: "project-1",
      permission: "write",
    });
    const backfill = decode(sent[1]!);
    expect(backfill.type).toBe(MessageType.DocUpdate);
    if (backfill.type !== MessageType.DocUpdate)
      throw new Error("missing backfill");
    clientDoc.importBatch(backfill.updates);
    expect(clientDoc.getMap("nodes").get("server")).toEqual({
      label: "Server",
    });
  });

  it("acknowledges an update only after the durable commit succeeds", async () => {
    const doc = new LoroDoc();
    const source = new LoroDoc();
    source.getMap("nodes").set("one", { label: "One" });
    source.commit();
    const update = source.export({ mode: "update" });
    const sent: Uint8Array[] = [];
    const commit = vi.fn().mockRejectedValue(new Error("storage failed"));
    const session = new LoroProtocolServerSession({
      roomId: "project-1",
      doc: () => doc,
      commit,
      send: (frame) => {
        sent.push(frame);
      },
      assumeJoined: true,
    });

    await session.receive(
      encode({
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId: "project-1",
        updates: [update],
        batchId: "0x0000000000000001",
      }),
    );

    expect(commit).toHaveBeenCalledWith("0x0000000000000001", [update]);
    expect(decode(sent.at(-1)!)).toMatchObject({
      type: MessageType.Ack,
      refId: "0x0000000000000001",
      status: UpdateStatusCode.AppError,
    });
  });

  it("broadcasts a durable update even when the sender disconnects before its ACK", async () => {
    const doc = new LoroDoc();
    const source = new LoroDoc();
    source.getMap("nodes").set("durable", { label: "Durable" });
    source.commit();
    const update = source.export({ mode: "snapshot" });
    const statuses: UpdateStatusCode[] = [];
    const commit = vi.fn(async (_batchId: string, updates: Uint8Array[]) => {
      doc.importBatch(updates);
    });
    const broadcast = vi.fn();
    const session = new LoroProtocolServerSession({
      roomId: "project-1",
      doc: () => doc,
      commit,
      broadcast,
      send: (frame) => {
        const message = decode(frame);
        if (message.type !== MessageType.Ack) return;
        statuses.push(message.status);
        throw new Error("sender disconnected");
      },
      assumeJoined: true,
    });

    await expect(
      session.receive(
        encode({
          type: MessageType.DocUpdate,
          crdt: CrdtType.Loro,
          roomId: "project-1",
          updates: [update],
          batchId: "0x0000000000000002",
        }),
      ),
    ).rejects.toThrow("sender disconnected");

    expect(commit).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("0x0000000000000002", [update]);
    expect(statuses).toEqual([UpdateStatusCode.Ok]);
  });
});

describe("LoroProtocolClientSession", () => {
  it("stops dependent uploads after rejection while preserving local recovery data", async () => {
    const doc = new LoroDoc();
    const sent: Uint8Array[] = [];
    const rejected = vi.fn();
    const errors = vi.fn();
    const client = new LoroProtocolClientSession({ roomId: "project", doc,
      send: frame => { sent.push(frame); }, onUpdateRejected: rejected, onError: errors });
    const version = doc.version();
    try {
      client.join();
      await client.receive(encode({ type: MessageType.JoinResponseOk, crdt: CrdtType.Loro,
        roomId: "project", permission: "write", version: version.encode() }));
      doc.getMap("nodes").set("rejected", { label: "Local draft" });
      doc.commit();
      const update = decode(sent.at(-1)!);
      if (update.type !== MessageType.DocUpdate) throw new Error("Expected local update");
      await client.receive(encode({ type: MessageType.Ack, crdt: CrdtType.Loro, roomId: "project",
        refId: update.batchId, status: UpdateStatusCode.AppError }));
      expect(rejected).toHaveBeenCalledWith(update.batchId, UpdateStatusCode.AppError, update.updates);
      expect(client.isJoined()).toBe(false);
      const previousFrames = sent.slice();
      doc.getMap("nodes").set("later", { label: "Keep for recovery" });
      doc.commit();
      expect(client.sendExternalUpdate(doc.export({ mode: "update" }))).toBe(false);
      client.join();
      expect(sent).toEqual(previousFrames);
      expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/recover/i) }));
      expect(doc.getMap("nodes").get("rejected")).toEqual({ label: "Local draft" });
      expect(doc.getMap("nodes").get("later")).toEqual({ label: "Keep for recovery" });
    } finally { version.free(); client.destroy(); doc.free(); }
  });

  it("joins from its VersionVector and uploads state missing on the server", async () => {
    const doc = new LoroDoc();
    doc.getMap("nodes").set("offline", { label: "Offline" });
    doc.commit();
    const sent: Uint8Array[] = [];
    const session = new LoroProtocolClientSession({
      roomId: "project-1",
      doc,
      send: (frame) => {
        sent.push(frame);
      },
    });

    session.join();
    expect(decode(sent[0]!)).toMatchObject({
      type: MessageType.JoinRequest,
      roomId: "project-1",
    });
    await session.receive(
      encode({
        type: MessageType.JoinResponseOk,
        crdt: CrdtType.Loro,
        roomId: "project-1",
        permission: "write",
        version: new LoroDoc().version().encode(),
      }),
    );

    const upload = decode(sent[1]!);
    expect(upload.type).toBe(MessageType.DocUpdate);
    if (upload.type !== MessageType.DocUpdate)
      throw new Error("missing upload");
    const server = new LoroDoc();
    server.importBatch(upload.updates);
    expect(server.getMap("nodes").get("offline")).toEqual({ label: "Offline" });
    session.destroy();
  });

  it("applies a server update and acknowledges the received batch", async () => {
    const doc = new LoroDoc();
    const source = new LoroDoc();
    source.getMap("nodes").set("remote", { label: "Remote" });
    source.commit();
    const sent: Uint8Array[] = [];
    const session = new LoroProtocolClientSession({
      roomId: "project-1",
      doc,
      send: (frame) => {
        sent.push(frame);
      },
    });

    await session.receive(
      encode({
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId: "project-1",
        batchId: "0x0000000000000007",
        updates: [source.export({ mode: "snapshot" })],
      }),
    );

    expect(doc.getMap("nodes").get("remote")).toEqual({ label: "Remote" });
    expect(decode(sent[0]!)).toMatchObject({
      type: MessageType.Ack,
      refId: "0x0000000000000007",
      status: UpdateStatusCode.Ok,
    });
    session.destroy();
  });

  it("can delegate incoming durability before acknowledging a server update", async () => {
    const doc = new LoroDoc();
    const source = new LoroDoc();
    source.getMap("nodes").set("cloud", { label: "Cloud" });
    source.commit();
    const order: string[] = [];
    const session = new LoroProtocolClientSession({
      roomId: "project-1",
      doc,
      subscribeLocalUpdates: false,
      commit: async (_batchId, updates) => {
        order.push("commit");
        doc.importBatch(updates);
      },
      send: (frame) => {
        const message = decode(frame);
        if (message.type === MessageType.Ack) order.push("ack");
      },
    });

    await session.receive(
      encode({
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId: "project-1",
        batchId: "0x0000000000000008",
        updates: [source.export({ mode: "snapshot" })],
      }),
    );

    expect(order).toEqual(["commit", "ack"]);
    expect(doc.getMap("nodes").get("cloud")).toEqual({ label: "Cloud" });
  });

  it("does not report a durable import as an application error when only its ACK transport fails", async () => {
    const doc = new LoroDoc();
    const source = new LoroDoc();
    source.getMap("nodes").set("cloud", { label: "Cloud" });
    source.commit();
    const statuses: UpdateStatusCode[] = [];
    const commit = vi.fn(async (_batchId: string, updates: Uint8Array[]) => {
      doc.importBatch(updates);
    });
    const session = new LoroProtocolClientSession({
      roomId: "project-1",
      doc,
      subscribeLocalUpdates: false,
      commit,
      send: (frame) => {
        const message = decode(frame);
        if (message.type !== MessageType.Ack) return;
        statuses.push(message.status);
        if (message.status === UpdateStatusCode.Ok) {
          throw new Error("cloud disconnected");
        }
      },
    });

    await expect(
      session.receive(
        encode({
          type: MessageType.DocUpdate,
          crdt: CrdtType.Loro,
          roomId: "project-1",
          batchId: "0x0000000000000009",
          updates: [source.export({ mode: "snapshot" })],
        }),
      ),
    ).rejects.toThrow("cloud disconnected");

    expect(commit).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([UpdateStatusCode.Ok]);
    expect(doc.getMap("nodes").get("cloud")).toEqual({ label: "Cloud" });
  });
});
