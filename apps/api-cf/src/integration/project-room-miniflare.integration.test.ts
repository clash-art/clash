import {
  evictDurableObject,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { LoroDoc } from "loro-crdt";
import {
  CrdtType,
  MessageType,
  UpdateStatusCode,
  decode,
  encode,
} from "loro-protocol";
import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_REQUESTED_SEQ_KEY,
  NEXT_SEQ_KEY,
  SNAPSHOT_KEY,
  SNAPSHOT_SEQ_KEY,
  UPDATE_PREFIX,
} from "../loro/storage";

function roomStub(projectId: string): DurableObjectStub {
  return env.ROOM.get(env.ROOM.idFromName(projectId));
}

function binaryInbox(socket: WebSocket): {
  next(): Promise<Uint8Array>;
} {
  // The client WebSocket defaults to Blob in standards-compatible runtimes.
  // Request ArrayBuffer explicitly so protocol decoding remains synchronous
  // and preserves the wire order across hibernation.
  socket.binaryType = "arraybuffer";
  const frames: Uint8Array[] = [];
  const waiters: Array<(frame: Uint8Array) => void> = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") return;
    const frame = new Uint8Array(event.data as ArrayBuffer);
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  return {
    next() {
      const frame = frames.shift();
      if (frame) return Promise.resolve(frame);
      return new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for ProjectRoom frame")),
          5_000,
        );
        waiters.push((nextFrame) => {
          clearTimeout(timer);
          resolve(nextFrame);
        });
      });
    },
  };
}

async function nextProtocolMessage(
  inbox: ReturnType<typeof binaryInbox>,
  matches: (message: ReturnType<typeof decode>) => boolean,
): Promise<ReturnType<typeof decode>> {
  for (let index = 0; index < 8; index++) {
    const message = decode(await inbox.next());
    if (matches(message)) return message;
  }
  throw new Error("Timed out waiting for matching ProjectRoom protocol frame");
}

async function connectProtocolClient(projectId: string): Promise<{
  socket: WebSocket;
  inbox: ReturnType<typeof binaryInbox>;
}> {
  const response = await roomStub(projectId).fetch(
    new Request(`https://room/sync/${projectId}?protocol=loro-v1`, {
      headers: {
        Upgrade: "websocket",
        "x-internal-agent": "true",
      },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("ProjectRoom did not return a WebSocket");
  socket.accept();
  const inbox = binaryInbox(socket);
  const version = new LoroDoc().version();
  try {
    socket.send(
      encode({
        type: MessageType.JoinRequest,
        crdt: CrdtType.Loro,
        roomId: projectId,
        auth: new Uint8Array(),
        version: version.encode(),
      }),
    );
  } finally {
    version.free();
  }
  expect(
    await nextProtocolMessage(
      inbox,
      (message) => message.type === MessageType.JoinResponseOk,
    ),
  ).toMatchObject({
    type: MessageType.JoinResponseOk,
    roomId: projectId,
    permission: "write",
  });
  return { socket, inbox };
}

function remoteUpdateRequest(projectId: string, update: Uint8Array): Request {
  return new Request(`https://room/loro/${projectId}/updates`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-internal-loro": "true",
      "x-loro-project-id": projectId,
    },
    body: update,
  });
}

describe("ProjectRoom in Miniflare", () => {
  it("persists a protocol update before ACK and broadcasts it to another hibernatable WebSocket", async () => {
    const projectId = "miniflare-websocket";
    const first = await connectProtocolClient(projectId);
    const second = await connectProtocolClient(projectId);
    const source = new LoroDoc();
    source.getMap("chaos").set("from-first", 42);
    source.commit();
    const update = source.export({ mode: "snapshot" });

    first.socket.send(
      encode({
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId: projectId,
        batchId: "0x00000000000000aa",
        updates: [update],
      }),
    );

    expect(
      await nextProtocolMessage(
        first.inbox,
        (message) =>
          message.type === MessageType.Ack &&
          message.refId === "0x00000000000000aa",
      ),
    ).toMatchObject({
      type: MessageType.Ack,
      refId: "0x00000000000000aa",
      status: UpdateStatusCode.Ok,
    });
    const broadcast = await nextProtocolMessage(
      second.inbox,
      (message) =>
        message.type === MessageType.DocUpdate &&
        message.batchId === "0x00000000000000aa",
    );
    expect(broadcast.type).toBe(MessageType.DocUpdate);
    if (broadcast.type !== MessageType.DocUpdate) {
      throw new Error("ProjectRoom did not broadcast a Loro update");
    }
    const replica = new LoroDoc();
    replica.importBatch(broadcast.updates);
    expect(replica.getMap("chaos").get("from-first")).toBe(42);

    await evictDurableObject(roomStub(projectId));
    const previousVersion = source.version();
    source.getMap("chaos").set("after-eviction", 84);
    source.commit();
    const afterEvictionUpdate = source.export({
      mode: "update",
      from: previousVersion,
    });
    previousVersion.free();
    first.socket.send(
      encode({
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId: projectId,
        batchId: "0x00000000000000bb",
        updates: [afterEvictionUpdate],
      }),
    );
    await nextProtocolMessage(
      first.inbox,
      (message) =>
        message.type === MessageType.Ack &&
        message.refId === "0x00000000000000bb",
    );
    const afterEvictionBroadcast = await nextProtocolMessage(
      second.inbox,
      (message) =>
        message.type === MessageType.DocUpdate &&
        message.batchId === "0x00000000000000bb",
    );
    if (afterEvictionBroadcast.type !== MessageType.DocUpdate) {
      throw new Error(
        "ProjectRoom did not resume its hibernated protocol client",
      );
    }
    replica.importBatch(afterEvictionBroadcast.updates);
    expect(replica.getMap("chaos").get("after-eviction")).toBe(84);

    const durable = await runInDurableObject(
      roomStub(projectId),
      async (_instance, state) => ({
        cursor: await state.storage.get<number>(NEXT_SEQ_KEY),
        events: (await state.storage.list({ prefix: UPDATE_PREFIX })).size,
      }),
    );
    expect(durable).toEqual({ cursor: 2, events: 2 });

    first.socket.close(1000, "done");
    second.socket.close(1000, "done");
  });

  it("runs the real DO alarm to checkpoint and truncate one hundred persisted updates", async () => {
    const projectId = "miniflare-checkpoint";
    const stub = roomStub(projectId);
    const source = new LoroDoc();

    for (let index = 0; index < 100; index++) {
      const version = source.version();
      source.getMap("chaos").set(`event-${index}`, index);
      source.commit();
      const update = source.export({ mode: "update", from: version });
      version.free();
      const response = await stub.fetch(remoteUpdateRequest(projectId, update));
      expect(response.status).toBe(204);
    }

    const before = await runInDurableObject(stub, async (_instance, state) => {
      // The checkpoint request is scheduled for "now" in production. Move
      // it into the future while holding the object lock so this test can
      // deterministically invoke the real alarm rather than race Miniflare's
      // automatic alarm dispatch.
      await state.storage.setAlarm(Date.now() + 60_000);
      return {
        cursor: await state.storage.get<number>(NEXT_SEQ_KEY),
        checkpointRequested: await state.storage.get<number>(
          CHECKPOINT_REQUESTED_SEQ_KEY,
        ),
        events: (await state.storage.list({ prefix: UPDATE_PREFIX })).size,
        snapshot: await state.storage.get(SNAPSHOT_KEY),
      };
    });
    expect(before).toEqual({
      cursor: 100,
      checkpointRequested: 100,
      events: 100,
      snapshot: undefined,
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const after = await runInDurableObject(stub, async (_instance, state) => ({
      checkpointCursor: await state.storage.get<number>(SNAPSHOT_SEQ_KEY),
      checkpointRequested: await state.storage.get<number>(
        CHECKPOINT_REQUESTED_SEQ_KEY,
      ),
      events: (await state.storage.list({ prefix: UPDATE_PREFIX })).size,
      snapshot: await state.storage.get<ArrayBuffer>(SNAPSHOT_KEY),
    }));
    expect(after.checkpointCursor).toBe(100);
    expect(after.checkpointRequested).toBeUndefined();
    expect(after.events).toBe(0);
    expect(after.snapshot).toBeInstanceOf(ArrayBuffer);

    const recovered = new LoroDoc();
    recovered.import(new Uint8Array(after.snapshot!));
    expect(Object.keys(recovered.getMap("chaos").toJSON())).toHaveLength(100);
    expect(recovered.getMap("chaos").get("event-99")).toBe(99);
  });

  it("converges and cold-recovers one thousand ordered events across repeated DO evictions", async () => {
    const projectId = "miniflare-long-sequence";
    const stub = roomStub(projectId);
    const writer = await connectProtocolClient(projectId);
    const reader = await connectProtocolClient(projectId);
    const source = new LoroDoc();
    const replica = new LoroDoc();
    const eventsPerBatch = 10;
    const batchCount = 100;

    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
      const updates: Uint8Array[] = [];
      for (let offset = 0; offset < eventsPerBatch; offset++) {
        const eventIndex = batchIndex * eventsPerBatch + offset;
        const version = source.version();
        source.getMap("long-sequence").set(`event-${eventIndex}`, eventIndex);
        source.commit();
        updates.push(source.export({ mode: "update", from: version }));
        version.free();
      }

      const batchId =
        `0x${(batchIndex + 1).toString(16).padStart(16, "0")}` as const;
      writer.socket.send(
        encode({
          type: MessageType.DocUpdate,
          crdt: CrdtType.Loro,
          roomId: projectId,
          batchId,
          updates,
        }),
      );

      await nextProtocolMessage(
        writer.inbox,
        (message) =>
          message.type === MessageType.Ack && message.refId === batchId,
      );
      const broadcast = await nextProtocolMessage(
        reader.inbox,
        (message) =>
          message.type === MessageType.DocUpdate && message.batchId === batchId,
      );
      if (broadcast.type !== MessageType.DocUpdate) {
        throw new Error("Long-sequence broadcast was not a document update");
      }
      replica.importBatch(broadcast.updates);

      if ((batchIndex + 1) % 25 === 0 && batchIndex + 1 < batchCount) {
        await evictDurableObject(stub);
      }
    }

    expect(replica.getMap("long-sequence").toJSON()).toEqual(
      source.getMap("long-sequence").toJSON(),
    );

    await runInDurableObject(stub, async (_instance, state) => {
      const cursor = await state.storage.get<number>(NEXT_SEQ_KEY);
      expect(cursor).toBe(1_000);
      await state.storage.put(CHECKPOINT_REQUESTED_SEQ_KEY, cursor!);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const durable = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        cursor: await state.storage.get<number>(NEXT_SEQ_KEY),
        checkpointCursor: await state.storage.get<number>(SNAPSHOT_SEQ_KEY),
        tailEvents: (await state.storage.list({ prefix: UPDATE_PREFIX })).size,
      }),
    );
    expect(durable).toEqual({
      cursor: 1_000,
      checkpointCursor: 1_000,
      tailEvents: 0,
    });

    await evictDurableObject(stub);
    const recoveredClient = await connectProtocolClient(projectId);
    const recoveryFrame = await nextProtocolMessage(
      recoveredClient.inbox,
      (message) => message.type === MessageType.DocUpdate,
    );
    if (recoveryFrame.type !== MessageType.DocUpdate) {
      throw new Error("Cold recovery did not return a Loro update");
    }
    const recovered = new LoroDoc();
    recovered.importBatch(recoveryFrame.updates);
    expect(recovered.getMap("long-sequence").toJSON()).toEqual(
      source.getMap("long-sequence").toJSON(),
    );

    writer.socket.close(1000, "done");
    reader.socket.close(1000, "done");
    recoveredClient.socket.close(1000, "done");
  });
});
