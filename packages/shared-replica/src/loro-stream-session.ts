import type { LoroDoc } from "loro-crdt";
import { createReplicaStreamClient } from "./replica-stream-client.js";

/** Browser document binding. Reconnect replays the retained snapshot/tail and
 * uploads the current local snapshot, so an interrupted append cannot lose a
 * locally retained edit. No cursor is persisted separately from the document. */
export function createLoroStreamSession(options: {
  doc: LoroDoc;
  url: string;
  fetch?: typeof globalThis.fetch;
  onReady?(): void;
  onDisconnected?(): void;
  onError?(error: Error): void;
}) {
  let closed = false,
    publishing = false,
    failed = false;
  let writes = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  const report = (error: unknown) => {
    if (closed || failed) return;
    failed = true;
    options.onDisconnected?.();
    options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  };
  const client = createReplicaStreamClient({
    url: options.url,
    fetch: options.fetch,
    loadCursor: async () => null,
    apply: async ({ data }) => {
      if (!closed && data.length) options.doc.importBatch(data);
    },
    onReady: () => {
      if (publishing)
        void writes.then(() => {
          if (!closed && !failed) options.onReady?.();
        });
    },
    onDisconnected: options.onDisconnected,
    onError: report,
  });
  function enqueue(bytes: Uint8Array) {
    const id = crypto.randomUUID();
    writes = writes
      .then(async () => {
        if (!closed && !failed) await client.append(id, bytes);
      })
      .catch(report);
    return writes;
  }
  return {
    async start() {
      unsubscribe = options.doc.subscribeLocalUpdates((bytes) => {
        if (publishing) void enqueue(bytes.slice());
      });
      try {
        await client.start();
        if (closed) return;
        // Synchronous export plus subscription activation captures edits made
        // during bootstrap without a gap between the snapshot and live updates.
        const snapshot = options.doc.export({ mode: "snapshot" });
        publishing = true;
        await enqueue(snapshot);
        if (!closed && !failed) options.onReady?.();
      } catch (error) {
        report(error);
      }
    },
    async close() {
      closed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      await client.close();
      await writes;
    },
  };
}
