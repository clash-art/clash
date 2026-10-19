import { describe, expect, it, vi } from "vitest";

import {
  ReplicaEngine,
  type CheckpointPort,
  type EventLogPort,
  type ReplicaEvent,
  type StoredReplicaEvent,
} from "./replica-engine";

type State = { text: string };

function memoryPorts(options: { failAppend?: boolean } = {}) {
  const events: StoredReplicaEvent<string>[] = [];
  const ids = new Map<string, StoredReplicaEvent<string>>();
  let checkpoint: { cursor: number; data: string } | null = null;
  const order: string[] = [];

  const eventLog: EventLogPort<string> = {
    async append(event: ReplicaEvent<string>) {
      order.push("append");
      if (options.failAppend) throw new Error("event log unavailable");
      const duplicate = ids.get(event.id);
      if (duplicate) return { appended: false, event: duplicate };
      const stored = { ...event, cursor: events.length + 1 };
      events.push(stored);
      ids.set(event.id, stored);
      return { appended: true, event: stored };
    },
    async readAfter(cursor) {
      return events.filter((event) => event.cursor > cursor);
    },
    async truncateThrough(cursor) {
      order.push(`truncate:${cursor}`);
    },
  };

  const checkpoints: CheckpointPort<string> = {
    async load() {
      return checkpoint;
    },
    async save(next) {
      order.push(`checkpoint:${next.cursor}`);
      checkpoint = next;
    },
  };

  return {
    eventLog,
    checkpoints,
    events,
    order,
    setCheckpoint: (value: typeof checkpoint) => {
      checkpoint = value;
    },
  };
}

const adapter = {
  create: (): State => ({ text: "" }),
  restore: (data: string): State => ({ text: data }),
  validate: vi.fn(),
  apply: (state: State, update: string) => {
    state.text += update;
  },
  checkpoint: (state: State) => state.text,
};

describe("ReplicaEngine", () => {
  it("recovers a checkpoint and only replays the durable tail", async () => {
    const ports = memoryPorts();
    ports.setCheckpoint({ cursor: 1, data: "A" });
    await ports.eventLog.append({ id: "old", update: "A" });
    await ports.eventLog.append({ id: "tail", update: "B" });

    const engine = await ReplicaEngine.open({
      adapter,
      eventLog: ports.eventLog,
      checkpoints: ports.checkpoints,
    });

    expect(engine.read((state) => state.text)).toBe("AB");
    expect(engine.cursor).toBe(2);
  });

  it("never mutates or publishes before an event is durably appended", async () => {
    const ports = memoryPorts({ failAppend: true });
    const publish = vi.fn();
    const engine = await ReplicaEngine.open({
      adapter,
      eventLog: ports.eventLog,
      checkpoints: ports.checkpoints,
      fanout: { publish },
    });

    await expect(engine.submit({ id: "one", update: "A" })).rejects.toThrow(
      "event log unavailable",
    );

    expect(engine.read((state) => state.text)).toBe("");
    expect(publish).not.toHaveBeenCalled();
    expect(ports.order).toEqual(["append"]);
  });

  it("deduplicates a retried event without applying or publishing it twice", async () => {
    const ports = memoryPorts();
    const publish = vi.fn();
    const engine = await ReplicaEngine.open({
      adapter,
      eventLog: ports.eventLog,
      checkpoints: ports.checkpoints,
      fanout: { publish },
    });

    await engine.submit({ id: "same", update: "A" });
    const retry = await engine.submit({ id: "same", update: "A" });

    expect(retry.appended).toBe(false);
    expect(engine.read((state) => state.text)).toBe("A");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("skips the extra validation pass for an already-imported update", async () => {
    const ports = memoryPorts();
    const engine = await ReplicaEngine.open({
      adapter,
      eventLog: ports.eventLog,
      checkpoints: ports.checkpoints,
    });
    const validate = vi.mocked(adapter.validate);
    validate.mockClear();

    await engine.submit({ id: "prevalidated", update: "P" }, {
      prevalidated: true,
    });
    expect(validate).not.toHaveBeenCalled();
    expect(engine.read((state) => state.text)).toBe("P");

    await engine.submit({ id: "checked", update: "C" });
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("publishes a checkpoint before pruning and retains events needed by a lagging projection", async () => {
    const ports = memoryPorts();
    let projectionCursor = 1;
    const engine = await ReplicaEngine.open({
      adapter,
      eventLog: ports.eventLog,
      checkpoints: ports.checkpoints,
      projections: [
        {
          name: "search",
          loadCursor: async () => projectionCursor,
          apply: async () => undefined,
          saveCursor: async (cursor) => {
            projectionCursor = cursor;
          },
        },
      ],
    });
    await engine.submit({ id: "one", update: "A" });
    await engine.submit({ id: "two", update: "B" });

    await engine.checkpoint();

    expect(ports.order.slice(-2)).toEqual(["checkpoint:2", "truncate:1"]);
  });

  it("resumes an idempotent projection from its own cursor", async () => {
    const ports = memoryPorts();
    await ports.eventLog.append({ id: "one", update: "A" });
    await ports.eventLog.append({ id: "two", update: "B" });
    let projectionCursor = 1;
    const applied: string[] = [];
    const engine = await ReplicaEngine.open({
      adapter,
      eventLog: ports.eventLog,
      checkpoints: ports.checkpoints,
      projections: [
        {
          name: "search",
          loadCursor: async () => projectionCursor,
          apply: async (events) => {
            applied.push(...events.map((event) => event.update));
          },
          saveCursor: async (cursor) => {
            projectionCursor = cursor;
          },
        },
      ],
    });

    await engine.project("search");

    expect(applied).toEqual(["B"]);
    expect(projectionCursor).toBe(2);
  });
});
