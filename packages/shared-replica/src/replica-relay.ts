import type { ReplicaCheckpoint, StoredReplicaEvent } from "./replica-engine";
/** Durable cursors are log positions, independent of CRDT versions. */
export interface ReplicaRelayStore {
  head(): Promise<number>;
  loadCheckpoint(): Promise<ReplicaCheckpoint<Uint8Array> | null>;
  readAfter(
    cursor: number,
    through: number,
    limit: number,
  ): Promise<StoredReplicaEvent<Uint8Array>[]>;
  append(id: string, update: Uint8Array): Promise<number>;
}
export interface GatewayNotificationSource {
  start(
    notify: (projectId: string) => Promise<void>,
    reconnected: () => Promise<void>,
  ): { close(): Promise<void> };
}
export function replicaCursor(value: unknown): number {
  const n =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    throw Error("Invalid replica cursor");
  return n;
}
export async function readReplicaPage(
  store: ReplicaRelayStore,
  after: number,
  limit = 128,
) {
  replicaCursor(after);
  const head = await store.head();
  if (after > head) throw Error("Cursor beyond head");
  const events = await store.readAfter(after, head, limit);
  let cursor = after;
  for (const event of events) {
    if (event.cursor !== cursor + 1) throw Error("Replica log gap");
    cursor = event.cursor;
  }
  if (cursor < head && !events.length) throw Error("Replica log gap");
  return { head, cursor, events };
}
