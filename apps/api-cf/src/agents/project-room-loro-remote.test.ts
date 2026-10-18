import { describe, expect, it, vi, beforeEach } from "vitest";
import { LoroDoc } from "loro-crdt";
import {
  CrdtType,
  MessageType,
  UpdateStatusCode,
  decode,
  encode,
} from "loro-protocol";
import { Canvas } from "@clash/shared-types";

const mocks = vi.hoisted(() => ({
  processPendingNodes: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("../loro/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../loro/auth")>(),
  revalidateProjectConnection: mocks.revalidate,
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {
    ctx: DurableObjectState;
    env: unknown;

    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../loro/NodeProcessor", () => ({
  processPendingNodes: mocks.processPendingNodes,
  recoverOrphanedTasks: vi.fn(),
}));

vi.mock("../loro/TaskPolling", () => ({
  pollNodeTasks: vi.fn(),
}));

vi.mock("../lib/runtime-status", () => ({
  deriveRuntimeStatus: vi.fn(),
}));

vi.mock("../lib/runtime-heartbeat", () => ({
  markRuntimeOnline: vi.fn(),
}));

import { ProjectRoom } from "./project-room";

function createMockStorage(
  data: Map<string, any> = new Map(),
  options: { failEventAppend?: boolean } = {},
) {
  let alarm: number | null = null;
  const storage = {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    put: vi.fn(async (entriesOrKey: Record<string, any> | string, value?: any) => {
      if (typeof entriesOrKey === "string") {
        data.set(entriesOrKey, value);
        return;
      }
      if (options.failEventAppend && "loro:next-seq" in entriesOrKey) {
        throw new Error("event log unavailable");
      }
      for (const [key, entryValue] of Object.entries(entriesOrKey)) {
        data.set(key, entryValue);
      }
    }),
    list: vi.fn(async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      return new Map(
        [...data.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    }),
    delete: vi.fn(async (keyOrKeys: string | string[]) => {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      for (const key of keys) data.delete(key);
    }),
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (scheduledTime: number) => {
      alarm = scheduledTime;
    }),
  };
  return { storage: storage as any as DurableObjectStorage, data };
}

function createRoom(
  options: { failEventAppend?: boolean; protocolClient?: boolean } = {},
) {
  const { storage, data } = createMockStorage(new Map(), options);
  const pending: Promise<unknown>[] = [];
  const ws = {
    send: vi.fn(),
    close: vi.fn(),
    // This fixture represents a trusted service-binding peer. Public credential
    // and hibernation authorization are exercised against real DOs separately.
    deserializeAttachment: vi.fn(() => ({
      id: "internal-client", userId: "internal", clientType: "agent",
      name: "Internal", connectedAt: 0, internal: true,
      ...(options.protocolClient ? { syncProtocol: "loro-v1" } : {}),
    })),
  };
  const ctx = {
    storage,
    getWebSockets: vi.fn(() => [ws]),
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
  } as any as DurableObjectState;
  const room = new ProjectRoom(ctx, { ENVIRONMENT: "development" } as any);
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return { room, data, storage, ws, flush };
}

describe("ProjectRoom Loro remote persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("imports remote updates, persists them, broadcasts them, and returns snapshots", async () => {
    const { room, data, ws, flush } = createRoom();
    const source = new LoroDoc();
    const before = source.version();
    source.getMap("nodes").set("n1", {
      type: "text",
      data: { label: "Remote mirrored" },
      position: { x: 1, y: 2 },
    });
    const update = source.export({ mode: "update", from: before });

    const updateRes = await room.fetch(new Request("https://room/loro/project%2Fone/updates", {
      method: "POST",
      headers: {
        "x-internal-loro": "true",
        "x-loro-project-id": "project/one",
        "content-type": "application/octet-stream",
      },
      body: update,
    }));

    expect(updateRes.status).toBe(204);
    expect(data.get("projectId")).toBe("project/one");
    expect(data.get("loro:next-seq")).toBe(1);
    expect(new Uint8Array(data.get("loro:u:000000000000"))).toEqual(update);
    await flush();
    expect(ws.send).toHaveBeenCalledWith(update);
    expect(mocks.processPendingNodes).not.toHaveBeenCalled();

    const snapshotRes = await room.fetch(new Request("https://room/loro/project%2Fone/snapshot", {
      headers: {
        "x-internal-loro": "true",
        "x-loro-project-id": "project/one",
      },
    }));

    expect(snapshotRes.status).toBe(200);
    expect(snapshotRes.headers.get("content-type")).toBe("application/octet-stream");
    const mirrored = new LoroDoc();
    mirrored.import(new Uint8Array(await snapshotRes.arrayBuffer()));
    expect((mirrored.getMap("nodes").get("n1") as any).data.label).toBe("Remote mirrored");
  });

  it("persists and broadcasts a repair update after an imported orphan edge", async () => {
    const { room, data, ws, flush } = createRoom();
    const source = new LoroDoc();
    source.getMap("nodes").set("target", { canvasId: "main", type: "image_gen", data: {} });
    source.getMap("nodeUpstreams").ensureMergeableMap("target").set("orphan", {
      nodeId: "missing-source",
      edgeId: "orphan",
      type: "default",
    });
    source.getMap("edgeIdentity").set("orphan", { target: "target" });
    const update = source.export({ mode: "snapshot" });

    const updateRes = await room.fetch(new Request("https://room/loro/project/updates", {
      method: "POST",
      headers: {
        "x-internal-loro": "true",
        "x-loro-project-id": "project",
        "content-type": "application/octet-stream",
      },
      body: update,
    }));

    expect(updateRes.status).toBe(204);
    expect(data.get("loro:next-seq")).toBe(2);
    await flush();
    expect(ws.send).toHaveBeenCalledTimes(2);

    const snapshotRes = await room.fetch(new Request("https://room/loro/project/snapshot", {
      headers: {
        "x-internal-loro": "true",
        "x-loro-project-id": "project",
      },
    }));
    const mirrored = new LoroDoc();
    mirrored.import(new Uint8Array(await snapshotRes.arrayBuffer()));
    expect(new Canvas(mirrored, () => {}, "main").listEdges()).toEqual([]);
    expect(mirrored.getMap("edgeIdentity").get("orphan")).toEqual({ deleted: true });
  });

  it("rejects remote persistence requests without the internal header", async () => {
    const { room } = createRoom();

    const res = await room.fetch(new Request("https://room/loro/project/snapshot", {
      headers: { "x-loro-project-id": "project" },
    }));

    expect(res.status).toBe(403);
  });

  it("does not acknowledge or broadcast an update that was not durably appended", async () => {
    const { room, data, ws } = createRoom({ failEventAppend: true });
    const source = new LoroDoc();
    source.getMap("nodes").set("n1", {
      type: "text",
      data: { label: "Must be durable" },
    });
    const update = source.export({ mode: "snapshot" });

    const response = await room.fetch(new Request("https://room/loro/project/updates", {
      method: "POST",
      headers: {
        "x-internal-loro": "true",
        "x-loro-project-id": "project",
        "content-type": "application/octet-stream",
      },
      body: update,
    }));

    expect(response.status).toBe(500);
    expect(data.has("loro:u:000000000000")).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("defers checkpoint compaction until the durable-object alarm runs", async () => {
    const { room, data, storage } = createRoom();
    const source = new LoroDoc();
    source.getMap("nodes").set("n1", {
      type: "text",
      data: { label: "Checkpoint later" },
    });
    const update = source.export({ mode: "snapshot" });

    for (let i = 0; i < 100; i++) {
      const response = await room.fetch(new Request("https://room/loro/project/updates", {
        method: "POST",
        headers: {
          "x-internal-loro": "true",
          "x-loro-project-id": "project",
          "content-type": "application/octet-stream",
        },
        body: update,
      }));
      expect(response.status).toBe(204);
    }

    expect(data.get("loro:next-seq")).toBe(100);
    expect(data.has("loro:snapshot")).toBe(false);
    expect(storage.setAlarm).toHaveBeenCalled();

    await room.alarm();

    expect(data.get("loro:snapshot-seq")).toBe(100);
    expect([...data.keys()].some((key) => key.startsWith("loro:u:"))).toBe(false);
  });

  it("speaks the official Loro protocol and ACKs only the durable update", async () => {
    const { room, data, ws, flush } = createRoom({ protocolClient: true });
    await room.fetch(
      new Request("https://room/loro/project/snapshot", {
        headers: {
          "x-internal-loro": "true",
          "x-loro-project-id": "project",
        },
      }),
    );

    const join = encode({
      type: MessageType.JoinRequest,
      crdt: CrdtType.Loro,
      roomId: "project",
      auth: new Uint8Array(),
      version: new LoroDoc().version().encode(),
    });
    await room.webSocketMessage(ws as any, join.slice().buffer);
    await flush();
    expect(decode(ws.send.mock.calls[0]![0] as Uint8Array)).toMatchObject({
      type: MessageType.JoinResponseOk,
      roomId: "project",
    });
    ws.send.mockClear();

    const source = new LoroDoc();
    source.getMap("nodes").set("protocol", { type: "text", data: {} });
    const update = source.export({ mode: "snapshot" });
    const batchId = "0x0000000000000042" as const;
    const frame = encode({
      type: MessageType.DocUpdate,
      crdt: CrdtType.Loro,
      roomId: "project",
      updates: [update],
      batchId,
    });

    await room.webSocketMessage(ws as any, frame.slice().buffer);
    await flush();

    expect(decode(ws.send.mock.calls.at(-1)![0] as Uint8Array)).toMatchObject({
      type: MessageType.Ack,
      refId: batchId,
      status: UpdateStatusCode.Ok,
    });
    expect(data.get("loro:event-id:protocol%3A0x0000000000000042%3A0")).toBe(1);
  });
});

describe("socket authorization cache", () => {
  function fixture() {
    const fixture = createRoom();
    const room = fixture.room as any;
    fixture.ws.deserializeAttachment.mockReturnValue({
      projectAuthorization: { projectId: "project" },
    } as any);
    const schedule = vi.fn(async (_at: number) => {});
    room.scheduleAlarmAtEarliest = schedule;
    return { ...fixture, room, schedule };
  }
  const REVOKED =
    "PROJECT_AUTHORIZATION_REVOKED: Your session expired or your access to this project was revoked.";

  it("accepts frames inside the window and refuses the first frame after it lapses with a coded close (#240)", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      mocks.revalidate.mockReset().mockResolvedValue(true);
      const { room, ws, flush } = fixture();
      room.sendAuthorized(ws, "a");
      await flush();
      mocks.revalidate.mockResolvedValue(false); // revoked in D1 now
      clock.mockReturnValue(14_999);
      room.sendAuthorized(ws, "b"); // bounded window: still covered
      await flush();
      expect(mocks.revalidate).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(15_000);
      room.sendAuthorized(ws, "c");
      await flush();
      expect(mocks.revalidate).toHaveBeenCalledTimes(2);
      expect(ws.send.mock.calls).toEqual([["a"], ["b"]]);
      expect(ws.close).toHaveBeenCalledWith(1008, REVOKED);
      expect(room.authorizeSocket(ws)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("refuses an expired credential immediately, inside the window and without D1", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      mocks.revalidate.mockReset().mockResolvedValue(true);
      const { room, ws } = fixture();
      ws.deserializeAttachment.mockReturnValue({
        projectAuthorization: {
          projectId: "project",
          authorization: { kind: "session", expiresAt: 11_000 },
        },
      } as any);
      await expect(room.authorizeSocket(ws)).resolves.toBe(true);
      clock.mockReturnValue(11_000);
      expect(room.authorizeSocket(ws)).toBe(false);
      expect(mocks.revalidate).toHaveBeenCalledTimes(1);
      expect(ws.close).toHaveBeenCalledWith(1008, REVOKED);
    } finally {
      clock.mockRestore();
    }
  });

  it("schedules a recheck when the window lapses, so an idle revoked socket is closed without any frame", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      mocks.revalidate.mockReset().mockResolvedValue(true);
      const { room, ws, schedule } = fixture();
      await room.authorizeSocket(ws);
      expect(schedule).toHaveBeenCalledWith(15_000);
      // An alarm inside the window costs no D1 and reports the next lapse.
      clock.mockReturnValue(12_000);
      await expect(room.recheckIdleSockets()).resolves.toBe(15_000);
      expect(mocks.revalidate).toHaveBeenCalledTimes(1);
      mocks.revalidate.mockResolvedValue(false);
      clock.mockReturnValue(15_000);
      await expect(room.recheckIdleSockets()).resolves.toBeUndefined();
      expect(mocks.revalidate).toHaveBeenCalledTimes(2);
      expect(ws.close).toHaveBeenCalledWith(1008, REVOKED);
    } finally {
      clock.mockRestore();
    }
  });

  it("a recheck-only alarm neither loads the room nor runs the task poll or compaction", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(15_000);
    try {
      mocks.revalidate.mockReset().mockResolvedValue(true);
      const { room, ws, data, schedule } = fixture();
      data.set("taskPollDueAt", 70_000);
      room.initRoom = vi.fn();
      room.taskPoll = vi.fn();
      room.runCompaction = vi.fn();
      await room.alarm();
      expect(room.initRoom).not.toHaveBeenCalled();
      expect(room.taskPoll).not.toHaveBeenCalled();
      expect(room.runCompaction).not.toHaveBeenCalled();
      expect(mocks.revalidate).toHaveBeenCalledTimes(1);
      expect(ws.close).not.toHaveBeenCalled();
      // Both the 60 s task poll and the next authorization lapse stay scheduled.
      expect(schedule).toHaveBeenCalledWith(70_000);
      expect(schedule).toHaveBeenCalledWith(20_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("reuses successful authorization for frames until the five-second TTL expires", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      mocks.revalidate.mockReset().mockResolvedValue(true);
      const { room, ws, flush } = fixture();
      for (const frame of ["a", "b", "c"]) room.sendAuthorized(ws, frame);
      await flush();
      expect(mocks.revalidate).toHaveBeenCalledTimes(1);
      expect(ws.send.mock.calls).toEqual([["a"], ["b"], ["c"]]);
      clock.mockReturnValue(15_000);
      room.sendAuthorized(ws, "d");
      await flush();
      expect(mocks.revalidate).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("shares one revalidation across sockets presenting the same proof", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      mocks.revalidate.mockReset().mockResolvedValue(true);
      const { room, ws, flush } = fixture();
      const others = Array.from({ length: 20 }, () => ({
        send: vi.fn(),
        close: vi.fn(),
        deserializeAttachment: vi.fn(() => ({ projectAuthorization: { projectId: "project" } })),
      }));
      room.sendAuthorized(ws, "x");
      for (const other of others) room.sendAuthorized(other, "x");
      await flush();
      expect(mocks.revalidate).toHaveBeenCalledTimes(1);
      for (const other of others) expect(other.send).toHaveBeenCalledWith("x");
      // Still bounded by the TTL: a later send revalidates again.
      clock.mockReturnValue(15_001);
      room.sendAuthorized(others[0], "y");
      await flush();
      expect(mocks.revalidate).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("closes with 1013 instead of silently dropping frames when revalidation fails (D1 error)", async () => {
    mocks.revalidate
      .mockReset()
      .mockRejectedValueOnce(new Error("D1_ERROR: network connection lost"))
      .mockResolvedValue(true);
    const { room, ws, flush } = fixture();
    room.sendAuthorized(ws, "a");
    await flush();
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(
      1013,
      "PROJECT_AUTHORIZATION_CHECK_UNAVAILABLE: Could not verify project access; reconnect.",
    );
    expect(room.socketAuthorization.has(ws)).toBe(false);
    expect(room.clients.has(ws)).toBe(false);
    // The closed socket stays refused, but the failure is not cached for the
    // identity: the next socket with the same proof (D1 recovered) succeeds.
    expect(await room.authorizeSocket(ws)).toBe(false);
    const reconnected = {
      send: vi.fn(),
      close: vi.fn(),
      deserializeAttachment: vi.fn(() => ({ projectAuthorization: { projectId: "project" } })),
    };
    await expect(room.authorizeSocket(reconnected)).resolves.toBe(true);
  });

  it("drops frames for a socket that closed while authorization was in flight", async () => {
    mocks.revalidate.mockReset().mockResolvedValue(true);
    const { room, ws, flush } = fixture();
    (ws as any).readyState = 3;
    room.sendAuthorized(ws, "late");
    await flush();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("closes a revoked socket and clears its cached authorization", async () => {
    mocks.revalidate.mockReset().mockResolvedValue(false);
    const { room, ws, flush } = fixture();
    room.sendAuthorized(ws, "revoked");
    await flush();
    expect(ws.close).toHaveBeenCalledWith(
      1008,
      "PROJECT_AUTHORIZATION_REVOKED: Your session expired or your access to this project was revoked.",
    );
    expect(ws.send).not.toHaveBeenCalled();
    expect(room.socketAuthorization.has(ws)).toBe(false);
    expect(room.clients.has(ws)).toBe(false);
  });

  it("shares an in-flight check across concurrent sends and inbound authorization", async () => {
    let resolve!: (allowed: boolean) => void;
    mocks.revalidate.mockReset().mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const { room, ws, flush } = fixture();
    room.sendAuthorized(ws, "a");
    room.sendAuthorized(ws, "b");
    await Promise.resolve();
    const first = room.authorizeSocket(ws);
    expect(room.authorizeSocket(ws)).toBe(first);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
    resolve(true);
    await flush();
    expect(ws.send.mock.calls).toEqual([["a"], ["b"]]);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
  });

  it.each(["close", "error"] as const)("does not restore authorization after a socket %s during revalidation", async (event) => {
    let resolve!: (allowed: boolean) => void;
    mocks.revalidate.mockReset().mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const { room, ws } = fixture();
    const authorization = room.authorizeSocket(ws);
    room.broadcastPresence = vi.fn();
    room.flushAwarenessBroadcast = vi.fn();
    if (event === "close") await room.webSocketClose(ws, 1000, "closed");
    else await room.webSocketError(ws, new Error("socket failed"));
    resolve(true);
    expect(await authorization).toBe(false);
    expect(room.socketAuthorization.has(ws)).toBe(false);
  });
});
