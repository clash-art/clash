import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ReplicaEngine,
  type CheckpointPort,
  type EventLogPort,
} from "@clash/replica";
import { LoroStateAdapter } from "@clash/replica/loro";
import {
  LoroProtocolServerSession,
  MessageType,
  UpdateStatusCode,
  decode,
  encodeLoroProtocolUpdateFrames,
  type HexString,
} from "@clash/replica/loro-protocol";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { LoroCloudReplicaLink } from "./cloud-replica-link.js";
import { LocalLoroRoom, type RemoteLoroPersistence } from "../sync.js";

const PROJECT_ID = "project/chaos";
const CHAOS_SEED = 0x5eedc0de;

interface DurableCloudStore {
  checkpoint: { cursor: number; data: Uint8Array } | null;
  events: Array<{ id: string; cursor: number; update: Uint8Array }>;
  nextCursor: number;
}

interface Connection {
  id: number;
  socket: WebSocket;
  session: LoroProtocolServerSession;
  queue: Promise<void>;
}

function exactBytes(data: RawData | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data.slice();
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data as ArrayBuffer).slice();
}

function createCloudPorts(store: DurableCloudStore): {
  eventLog: EventLogPort<Uint8Array>;
  checkpoints: CheckpointPort<Uint8Array>;
} {
  return {
    eventLog: {
      async append(event) {
        const duplicate = store.events.find(
          (candidate) => candidate.id === event.id,
        );
        if (duplicate) return { appended: false, event: duplicate };
        const stored = {
          ...event,
          cursor: ++store.nextCursor,
          update: event.update.slice(),
        };
        store.events.push(stored);
        return { appended: true, event: stored };
      },
      async readAfter(cursor) {
        return store.events
          .filter((event) => event.cursor > cursor)
          .map((event) => ({ ...event, update: event.update.slice() }));
      },
      async truncateThrough(cursor) {
        store.events = store.events.filter((event) => event.cursor > cursor);
      },
    },
    checkpoints: {
      async load() {
        return store.checkpoint
          ? { ...store.checkpoint, data: store.checkpoint.data.slice() }
          : null;
      },
      async save(checkpoint) {
        store.checkpoint = {
          cursor: checkpoint.cursor,
          data: checkpoint.data.slice(),
        };
      },
    },
  };
}

class SeededRandom {
  constructor(private state: number) {}

  next(): number {
    let value = this.state | 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }
}

class ReplicaLinkReadiness {
  private readonly joined = new Set<symbol>();
  private totalJoins = 0;

  markJoined(linkId: symbol): void {
    if (!this.joined.has(linkId)) this.totalJoins += 1;
    this.joined.add(linkId);
  }

  markDisconnected(linkId: symbol): void {
    this.joined.delete(linkId);
  }

  async waitFor(count: number, trace: string[]): Promise<void> {
    await waitUntil(() => this.joined.size >= count, trace);
  }

  async waitForExact(count: number, trace: string[]): Promise<void> {
    await waitUntil(() => this.joined.size === count, trace);
  }

  async waitForTotalJoins(count: number, trace: string[]): Promise<void> {
    await waitUntil(() => this.totalJoins >= count, trace);
  }
}

class ChaosCloudHost {
  readonly trace: string[] = [];
  readonly failures: Error[] = [];
  private readonly store: DurableCloudStore = {
    checkpoint: null,
    events: [],
    nextCursor: 0,
  };
  private readonly connections = new Set<Connection>();
  private server: WebSocketServer | undefined;
  private replica!: ReplicaEngine<LoroDoc, Uint8Array, Uint8Array>;
  private baseUrlValue = "";
  private dropNextInboundUpdate = false;
  private dropNextOkAck = false;
  private duplicateNextInboundUpdate = false;
  private reverseNextTwoInboundUpdates = false;
  private heldInboundUpdate:
    { connection: Connection; frame: Uint8Array } | undefined;
  private nextConnectionId = 0;

  get baseUrl(): string {
    return this.baseUrlValue;
  }

  get document(): LoroDoc {
    return this.replica.read((doc) => doc);
  }

  async start(): Promise<void> {
    this.replica = await ReplicaEngine.open({
      adapter: new LoroStateAdapter(),
      ...createCloudPorts(this.store),
    });
    this.server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("listening", resolve);
      this.server!.once("error", reject);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Chaos cloud did not bind a TCP port");
    }
    this.baseUrlValue = `http://127.0.0.1:${address.port}`;
    this.server.on("connection", (socket, request) => {
      if (
        request.url !==
        `/sync/${encodeURIComponent(PROJECT_ID)}?protocol=loro-v1`
      ) {
        socket.close(1008, "wrong room");
        return;
      }
      this.accept(socket);
    });
  }

  loseNextInboundUpdate(): void {
    this.trace.push("fault:lose-inbound-and-disconnect");
    this.dropNextInboundUpdate = true;
  }

  loseNextSuccessfulAck(): void {
    this.trace.push("fault:lose-ack-after-commit");
    this.dropNextOkAck = true;
  }

  duplicateNextUpdate(): void {
    this.trace.push("fault:duplicate-inbound");
    this.duplicateNextInboundUpdate = true;
  }

  reverseNextTwoUpdates(): void {
    this.trace.push("fault:reverse-two-inbound");
    this.reverseNextTwoInboundUpdates = true;
  }

  disconnectAll(): void {
    this.trace.push("fault:network-partition");
    for (const connection of this.connections) connection.socket.terminate();
  }

  async checkpoint(): Promise<void> {
    this.trace.push(`cloud:checkpoint@${this.replica.cursor}`);
    await this.replica.checkpoint();
  }

  async restartReplica(): Promise<void> {
    this.trace.push("fault:cloud-replica-restart");
    this.disconnectAll();
    await Promise.allSettled(
      [...this.connections].map((connection) => connection.queue),
    );
    this.replica = await ReplicaEngine.open({
      adapter: new LoroStateAdapter(),
      ...createCloudPorts(this.store),
    });
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      connection.session.destroy();
      connection.socket.terminate();
    }
    this.connections.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: WebSocket): void {
    let connection!: Connection;
    const session = new LoroProtocolServerSession({
      roomId: PROJECT_ID,
      doc: () => this.document,
      commit: async (batchId, updates) => {
        for (const [index, update] of updates.entries()) {
          await this.replica.submit({
            id: `protocol:${batchId}:${index}`,
            update,
          });
        }
      },
      send: (frame) => this.send(connection, frame),
      broadcast: (batchId, updates) =>
        this.broadcast(connection, batchId, updates),
    });
    connection = {
      id: ++this.nextConnectionId,
      socket,
      session,
      queue: Promise.resolve(),
    };
    this.trace.push(`cloud:connect-${connection.id}`);
    this.connections.add(connection);

    socket.on("message", (raw, isBinary) => {
      if (!isBinary) return;
      const frame = exactBytes(raw);
      connection.queue = connection.queue
        .then(() => this.receive(connection, frame))
        .catch((error) => {
          this.failures.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });
    socket.on("close", () => {
      connection.session.destroy();
      this.connections.delete(connection);
    });
  }

  private async receive(
    connection: Connection,
    frame: Uint8Array,
  ): Promise<void> {
    const message = decode(frame);
    if (message.type !== MessageType.DocUpdate) {
      await connection.session.receive(frame);
      if (message.type === MessageType.JoinRequest) {
        this.trace.push(`cloud:join-${connection.id}`);
      }
      return;
    }

    this.trace.push(`cloud:update-${connection.id}:${message.batchId}`);

    if (this.dropNextInboundUpdate) {
      this.dropNextInboundUpdate = false;
      this.trace.push(`cloud:dropped-${connection.id}`);
      connection.socket.terminate();
      return;
    }

    if (this.reverseNextTwoInboundUpdates) {
      if (!this.heldInboundUpdate) {
        this.heldInboundUpdate = { connection, frame };
        this.trace.push(`cloud:held-${connection.id}`);
        return;
      }
      const held = this.heldInboundUpdate;
      this.heldInboundUpdate = undefined;
      this.reverseNextTwoInboundUpdates = false;
      this.trace.push(
        `cloud:released-reversed-${connection.id}-before-${held.connection.id}`,
      );
      await connection.session.receive(frame);
      await held.connection.session.receive(held.frame);
      return;
    }

    await connection.session.receive(frame);
    if (this.duplicateNextInboundUpdate) {
      this.duplicateNextInboundUpdate = false;
      await connection.session.receive(frame);
    }
  }

  private send(connection: Connection, frame: Uint8Array): void {
    const message = decode(frame);
    if (
      this.dropNextOkAck &&
      message.type === MessageType.Ack &&
      message.status === UpdateStatusCode.Ok
    ) {
      this.dropNextOkAck = false;
      connection.socket.terminate();
      return;
    }
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(frame);
    }
  }

  private broadcast(
    sender: Connection,
    batchId: HexString,
    updates: Uint8Array[],
  ): void {
    const frames = encodeLoroProtocolUpdateFrames(PROJECT_ID, batchId, updates);
    for (const connection of this.connections) {
      if (
        connection === sender ||
        connection.socket.readyState !== WebSocket.OPEN
      ) {
        continue;
      }
      for (const frame of frames) connection.socket.send(frame);
    }
  }
}

function remotePersistence(
  cloud: ChaosCloudHost,
  errors: Error[],
  readiness: ReplicaLinkReadiness,
): RemoteLoroPersistence {
  return {
    async appendUpdate() {
      throw new Error("The chaos test requires the replica link");
    },
    createLink({ projectId, doc, commit }) {
      const linkId = Symbol(projectId);
      return new LoroCloudReplicaLink({
        baseUrl: cloud.baseUrl,
        projectId,
        doc,
        commit,
        onJoined: () => readiness.markJoined(linkId),
        onDisconnected: () => readiness.markDisconnected(linkId),
        onError: (error) => errors.push(error),
      });
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  trace: string[],
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for replica convergence. seed=${CHAOS_SEED} trace=${trace.join(" -> ")}`,
  );
}

function chaosState(doc: LoroDoc): Record<string, unknown> {
  return doc.getMap("chaos").toJSON() as Record<string, unknown>;
}

function matchesExpected(
  doc: LoroDoc,
  expected: Record<string, number>,
): boolean {
  const actual = chaosState(doc);
  const entries = Object.entries(expected);
  return (
    Object.keys(actual).length === entries.length &&
    entries.every(([key, value]) => actual[key] === value)
  );
}

describe("local-to-cloud Loro replication under deterministic chaos", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) {
      await dispose().catch(() => undefined);
    }
  });

  it("converges after loss, duplicate and reversed delivery, partitions, checkpoints, and replica restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-loro-chaos-"));
    const cloud = new ChaosCloudHost();
    await cloud.start();
    cleanup.push(
      () => cloud.close(),
      () => rm(root, { recursive: true, force: true }),
    );

    const errors: Error[] = [];
    const readiness = new ReplicaLinkReadiness();
    const persistence = remotePersistence(cloud, errors, readiness);
    let roomA = await LocalLoroRoom.open({
      dataDir: join(root, "machine-a"),
      projectId: PROJECT_ID,
      remotePersistence: persistence,
      workflowProcessor: null,
    });
    let roomB = await LocalLoroRoom.open({
      dataDir: join(root, "machine-b"),
      projectId: PROJECT_ID,
      remotePersistence: persistence,
      workflowProcessor: null,
    });
    cleanup.push(async () => {
      await Promise.allSettled([roomA.close(), roomB.close()]);
    });
    await readiness.waitFor(2, cloud.trace);

    const random = new SeededRandom(CHAOS_SEED);
    const expected: Record<string, number> = {};
    const write = async (room: LocalLoroRoom, index: number) => {
      const value = random.next();
      const key = `op-${index}`;
      expected[key] = value;
      cloud.trace.push(`${room === roomA ? "a" : "b"}:${key}`);
      await room.mutateProject((doc) => {
        doc.getMap("chaos").set(key, value);
        return { value: undefined };
      });
    };

    cloud.loseNextInboundUpdate();
    await write(roomA, 0);
    await waitUntil(
      () => matchesExpected(cloud.document, expected),
      cloud.trace,
    );
    await readiness.waitForTotalJoins(3, cloud.trace);
    await readiness.waitFor(2, cloud.trace);

    cloud.loseNextSuccessfulAck();
    await write(roomB, 1);
    await waitUntil(
      () => matchesExpected(cloud.document, expected),
      cloud.trace,
    );
    await readiness.waitForTotalJoins(4, cloud.trace);
    await readiness.waitFor(2, cloud.trace);

    cloud.duplicateNextUpdate();
    await write(roomA, 2);
    await waitUntil(
      () => matchesExpected(cloud.document, expected),
      cloud.trace,
    );

    cloud.reverseNextTwoUpdates();
    await write(roomB, 3);
    await write(roomB, 4);
    await waitUntil(
      () => matchesExpected(cloud.document, expected),
      cloud.trace,
    );

    cloud.disconnectAll();
    await readiness.waitForExact(0, cloud.trace);
    await Promise.all([write(roomA, 5), write(roomB, 6)]);
    await readiness.waitForTotalJoins(6, cloud.trace);
    await readiness.waitFor(2, cloud.trace);
    await waitUntil(
      () => matchesExpected(cloud.document, expected),
      cloud.trace,
    );

    await Promise.all([cloud.checkpoint(), write(roomA, 7)]);
    await waitUntil(
      () => matchesExpected(cloud.document, expected),
      cloud.trace,
    );
    await cloud.restartReplica();
    expect(matchesExpected(cloud.document, expected)).toBe(true);
    await readiness.waitFor(2, cloud.trace);

    await roomA.close();
    roomA = await LocalLoroRoom.open({
      dataDir: join(root, "machine-a"),
      projectId: PROJECT_ID,
      remotePersistence: persistence,
      workflowProcessor: null,
    });
    cloud.trace.push("fault:local-a-restart");
    await write(roomA, 8);

    await waitUntil(() => {
      return (
        matchesExpected(cloud.document, expected) &&
        matchesExpected(LoroDoc.fromSnapshot(roomA.snapshot()), expected) &&
        matchesExpected(LoroDoc.fromSnapshot(roomB.snapshot()), expected)
      );
    }, cloud.trace);

    await cloud.checkpoint();
    await cloud.restartReplica();
    expect(matchesExpected(cloud.document, expected)).toBe(true);
    await waitUntil(
      () => matchesExpected(cloud.document, expected),
      cloud.trace,
    );

    expect(chaosState(cloud.document)).toEqual(expected);
    expect(
      cloud.failures,
      `seed=${CHAOS_SEED} trace=${cloud.trace.join(" -> ")}`,
    ).toEqual([]);
    expect(
      errors,
      `seed=${CHAOS_SEED} trace=${cloud.trace.join(" -> ")}`,
    ).toEqual([]);
  }, 30_000);

  it("converges a long two-replica sequence across repeated faults and checkpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-loro-long-chaos-"));
    const cloud = new ChaosCloudHost();
    await cloud.start();
    cleanup.push(
      () => cloud.close(),
      () => rm(root, { recursive: true, force: true }),
    );

    const errors: Error[] = [];
    const readiness = new ReplicaLinkReadiness();
    const persistence = remotePersistence(cloud, errors, readiness);
    let roomA = await LocalLoroRoom.open({
      dataDir: join(root, "machine-a"),
      projectId: PROJECT_ID,
      remotePersistence: persistence,
      workflowProcessor: null,
    });
    let roomB = await LocalLoroRoom.open({
      dataDir: join(root, "machine-b"),
      projectId: PROJECT_ID,
      remotePersistence: persistence,
      workflowProcessor: null,
    });
    cleanup.push(async () => {
      await Promise.allSettled([roomA.close(), roomB.close()]);
    });
    await readiness.waitFor(2, cloud.trace);

    const random = new SeededRandom(CHAOS_SEED ^ 0x128);
    const expected: Record<string, number> = {};
    const writeBatch = async (start: number, count: number) => {
      await Promise.all(
        Array.from({ length: count }, async (_, offset) => {
          const index = start + offset;
          const key = `long-${index}`;
          const value = random.next();
          expected[key] = value;
          const room = index % 2 === 0 ? roomA : roomB;
          await room.mutateProject((doc) => {
            doc.getMap("chaos").set(key, value);
            return { value: undefined };
          });
        }),
      );
    };

    // Normal burst, then an ambiguous commit where the success ACK is lost.
    await writeBatch(0, 16);
    await waitUntil(() => matchesExpected(cloud.document, expected), cloud.trace);
    cloud.loseNextSuccessfulAck();
    await writeBatch(16, 16);
    await readiness.waitFor(2, cloud.trace);
    await waitUntil(() => matchesExpected(cloud.document, expected), cloud.trace);

    // Lose a write before commit. The link must reconnect and replay it.
    cloud.loseNextInboundUpdate();
    await writeBatch(32, 16);
    await readiness.waitFor(2, cloud.trace);
    await waitUntil(() => matchesExpected(cloud.document, expected), cloud.trace);
    await cloud.checkpoint();

    // Duplicate one batch and then partition both clients during the next burst.
    cloud.duplicateNextUpdate();
    await writeBatch(48, 16);
    await waitUntil(() => matchesExpected(cloud.document, expected), cloud.trace);
    cloud.disconnectAll();
    await readiness.waitForExact(0, cloud.trace);
    await writeBatch(64, 16);
    await readiness.waitFor(2, cloud.trace);
    await waitUntil(() => matchesExpected(cloud.document, expected), cloud.trace);

    // A checkpoint races with live writes, followed by a cloud process restart.
    await Promise.all([cloud.checkpoint(), writeBatch(80, 16)]);
    await waitUntil(() => matchesExpected(cloud.document, expected), cloud.trace);
    await cloud.restartReplica();
    expect(matchesExpected(cloud.document, expected)).toBe(true);
    await readiness.waitFor(2, cloud.trace);

    // Restart one local Host and finish with another ordinary burst.
    await roomA.close();
    roomA = await LocalLoroRoom.open({
      dataDir: join(root, "machine-a"),
      projectId: PROJECT_ID,
      remotePersistence: persistence,
      workflowProcessor: null,
    });
    cloud.trace.push("fault:long-local-a-restart");
    await readiness.waitFor(2, cloud.trace);
    await writeBatch(96, 32);

    await waitUntil(
      () =>
        matchesExpected(cloud.document, expected) &&
        matchesExpected(LoroDoc.fromSnapshot(roomA.snapshot()), expected) &&
        matchesExpected(LoroDoc.fromSnapshot(roomB.snapshot()), expected),
      cloud.trace,
      20_000,
    );
    await cloud.checkpoint();
    await cloud.restartReplica();

    expect(Object.keys(expected)).toHaveLength(128);
    expect(chaosState(cloud.document)).toEqual(expected);
    expect(
      cloud.failures,
      `seed=${CHAOS_SEED} trace=${cloud.trace.join(" -> ")}`,
    ).toEqual([]);
    expect(
      errors,
      `seed=${CHAOS_SEED} trace=${cloud.trace.join(" -> ")}`,
    ).toEqual([]);
  }, 45_000);
});
