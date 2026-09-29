import { it, expect } from "vitest";
import { readReplicaPage, type ReplicaRelayStore } from "./replica-relay";
it("forwards opaque bytes after the requested durable cursor without CRDT interpretation", async () => {
  const bytes = new Uint8Array([0xde, 0xad]);
  const store: ReplicaRelayStore = {
    head: async () => 8,
    loadCheckpoint: async () => ({ cursor: 7, data: bytes }),
    readAfter: async (after) => {
      expect(after).toBe(7);
      return [{ id: "x", cursor: 8, update: bytes }];
    },
    append: async () => 8,
  };
  expect(await readReplicaPage(store, 7)).toEqual({
    head: 8,
    cursor: 8,
    events: [{ id: "x", cursor: 8, update: bytes }],
  });
});
it("rejects holes and cursors ahead of committed history", async () => {
  const store: ReplicaRelayStore = {
    head: async () => 8,
    loadCheckpoint: async () => null,
    readAfter: async () => [],
    append: async () => 8,
  };
  await expect(readReplicaPage(store, 7)).rejects.toThrow("gap");
  await expect(readReplicaPage(store, 9)).rejects.toThrow("beyond");
});
