import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalWorkflowProcessor } from "./local-processor.js";
import {
  LocalLoroRoomHub,
  type RemoteLoroPersistenceSource,
} from "./sync.js";

// Captured before any fake-timer test so file I/O can still settle on the real
// event loop while the schedule under test is driven by fake timers.
const realSetTimeout = globalThis.setTimeout;
const settleRealIo = () =>
  new Promise<void>((resolve) => realSetTimeout(resolve, 50));

let dataDir = "";

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clash-room-idle-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dataDir, { recursive: true, force: true });
});

function evictionHub(
  remotePersistence?: RemoteLoroPersistenceSource,
  workflowProcessor?: LocalWorkflowProcessor | null,
): LocalLoroRoomHub {
  return new LocalLoroRoomHub(
    dataDir,
    remotePersistence,
    workflowProcessor ?? null,
    undefined,
    undefined,
    undefined,
    {
      idleTimeoutMs: 60_000,
      maxRooms: 8,
      sweepIntervalMs: 60_000,
    },
  );
}

function hubFor(dataDir: string): LocalLoroRoomHub {
  return new LocalLoroRoomHub(
    dataDir,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    {
      idleTimeoutMs: 60_000,
      maxRooms: 8,
      sweepIntervalMs: 60_000,
    },
  );
}

describe("LocalLoroRoomHub idle eviction", () => {
  it("never evicts a room with a connected client and flushes before eviction", async () => {
    const hub = hubFor(dataDir);
    try {
      await hub.mutateProject("project", (doc) => {
        doc.getMap("nodes").set("node", { data: { status: "idle" } });
        return { value: undefined, save: true };
      });
      const room = await hub.room("project");
      const peer = room.addPeer(() => undefined, {
        sendInitialSnapshot: false,
      });

      await expect(
        hub.evictIdleRooms({ idleTimeoutMs: 0 }),
      ).resolves.toEqual({ evicted: [], failures: [] });
      expect(hub.roomCount()).toBe(1);

      room.removePeer(peer);
      await expect(
        hub.evictIdleRooms({ idleTimeoutMs: 0 }),
      ).resolves.toEqual({ evicted: ["project"], failures: [] });
      expect(hub.roomCount()).toBe(0);

      // Reopening reads the flushed update from the durable replica.
      const reopened = await hub.room("project");
      await expect(
        reopened.inspectProject((doc) => doc.getMap("nodes").get("node")),
      ).resolves.toEqual({ data: { status: "idle" } });
    } finally {
      await hub.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "keeps the room open and reports the checkpoint failure",
    async () => {
      const hub = hubFor(dataDir);
      const loroDir = join(
        dataDir,
        "projects",
        encodeURIComponent("checkpoint-failure"),
        "loro",
      );
      try {
        await hub.mutateProject("checkpoint-failure", (doc) => {
          doc.getMap("nodes").set("node", { data: { status: "idle" } });
          return { value: undefined, save: true };
        });
        await mkdir(loroDir, { recursive: true });
        await chmod(loroDir, 0o555);

        const result = await hub.evictIdleRooms({ idleTimeoutMs: 0 });
        expect(result.evicted).toEqual([]);
        expect(result.failures[0]).toMatchObject({
          ok: false,
          code: "PROJECT_CHECKPOINT_FAILED",
        });
        expect(hub.roomCount()).toBe(1);
      } finally {
        await chmod(loroDir, 0o755).catch(() => undefined);
        await hub.close();
      }
    },
  );
});

describe("LocalLoroRoomHub cancelled idle eviction", () => {
  it("restores the remote retry and Provider poll after a failed checkpoint", async () => {
    vi.useFakeTimers();
    let loadCalls = 0;
    let processCalls = 0;
    const hub = evictionHub(
      {
        async loadSnapshot() {
          loadCalls += 1;
          // The first catch-up fails and arms a retry timer. That pending
          // schedule is exactly what an eviction flush must not discard.
          if (loadCalls === 1) throw new Error("cloud offline");
          return null;
        },
        async appendUpdate() {},
      },
      {
        async process() {
          processCalls += 1;
          return false;
        },
        async nextWakeAt() {
          return Date.now() + 5_000;
        },
        minimumPollDelayMs: 1_000,
      },
    );
    const loroDir = join(
      dataDir,
      "projects",
      encodeURIComponent("project"),
      "loro",
    );
    try {
      const room = await hub.room("project");
      // Deferred open: the poll is armed, then the first catch-up fails.
      await vi.advanceTimersByTimeAsync(1);
      expect(processCalls).toBe(1);
      expect(loadCalls).toBe(1);

      await hub.mutateProject("project", (doc) => {
        doc.getMap("nodes").set("node", { data: { status: "idle" } });
        return { value: undefined, save: true };
      });
      await mkdir(loroDir, { recursive: true });
      await chmod(loroDir, 0o555);

      const result = await hub.evictIdleRooms({ idleTimeoutMs: 0 });
      expect(result.evicted).toEqual([]);
      expect(result.failures[0]).toMatchObject({
        ok: false,
        code: "PROJECT_CHECKPOINT_FAILED",
      });
      expect(hub.roomCount()).toBe(1);

      // Let the failed-checkpoint retry run now that the directory is writable,
      // then verify the poll and cloud retry schedules survived cancellation.
      await chmod(loroDir, 0o755);
      await vi.advanceTimersByTimeAsync(300);
      await settleRealIo();
      const processesBeforePoll = processCalls;
      await vi.advanceTimersByTimeAsync(5_000);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(processCalls).toBeGreaterThan(processesBeforePoll);

      const loadsBeforeRetry = loadCalls;
      await vi.advanceTimersByTimeAsync(30_000);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(loadCalls).toBeGreaterThan(loadsBeforeRetry);

      await expect(
        room.inspectProject((doc) => doc.getMap("nodes").get("node")),
      ).resolves.toEqual({ data: { status: "idle" } });
    } finally {
      await chmod(loroDir, 0o755).catch(() => undefined);
      await hub.close();
    }
  });

  it("restores polling and pending work when a peer attach cancels the flush", async () => {
    vi.useFakeTimers();
    let loadCalls = 0;
    let processCalls = 0;
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let abortSeenResolve!: () => void;
    const abortSeen = new Promise<void>((resolve) => {
      abortSeenResolve = resolve;
    });
    const hub = evictionHub(
      {
        async loadSnapshot(_projectId, signal) {
          loadCalls += 1;
          if (loadCalls > 1) return null;
          signal?.addEventListener(
            "abort",
            () => {
              abortSeenResolve();
              // A real fetch rejects after its abort; delaying the rejection
              // until the gate keeps the flush inside its network wait while
              // the peer attaches.
              releaseLoad();
            },
            { once: true },
          );
          await loadGate;
          if (signal?.aborted) throw new Error("aborted");
          return null;
        },
        async appendUpdate() {},
      },
      {
        async process() {
          processCalls += 1;
          return false;
        },
        async nextWakeAt() {
          return Date.now() + 5_000;
        },
        minimumPollDelayMs: 1_000,
      },
    );
    try {
      const room = await hub.room("project");
      // Start the first catch-up (it stays in flight) and arm the poll.
      await vi.advanceTimersByTimeAsync(1);
      expect(processCalls).toBe(1);
      expect(loadCalls).toBe(1);

      // A coalesced peer edit leaves a pending-work pass armed, which the
      // eviction flush would suspend.
      const remote = new LoroDoc();
      try {
        remote
          .getMap("nodes")
          .set("remote", { data: { status: "generating" } });
        await room.mergeRemoteSnapshot(remote.export({ mode: "update" }), {
          awaitPendingWork: false,
        });
      } finally {
        remote.free();
      }

      const eviction = hub.evictIdleRooms({ idleTimeoutMs: 0 });
      await abortSeen;
      const peer = room.addPeer(() => undefined, {
        sendInitialSnapshot: false,
      });

      await expect(eviction).resolves.toEqual({
        evicted: [],
        failures: [],
      });
      expect(hub.roomCount()).toBe(1);

      const processesBefore = processCalls;
      // The pending pass completes first and re-schedules the next Provider
      // poll from its own completion, so allow one poll interval plus margin.
      await vi.advanceTimersByTimeAsync(5_200);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      // One pass from the restored pending-work debounce and one from a
      // Provider poll that still fires after cancellation.
      expect(processCalls).toBeGreaterThanOrEqual(processesBefore + 2);
      const loadsBeforeRetry = loadCalls;
      await vi.advanceTimersByTimeAsync(30_000);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(loadCalls).toBeGreaterThan(loadsBeforeRetry);

      room.removePeer(peer);
    } finally {
      await hub.close();
    }
  });
});
