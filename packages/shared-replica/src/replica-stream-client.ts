import {
  StreamsClient,
  type StreamError,
  type StreamPart,
} from "@loro-dev/streams-client";

export interface ReplicaStreamClientOptions {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  /** Opaque SDK offset belonging to an already persisted local replica. */
  loadCursor(): Promise<string | null>;
  /** Persist the entire batch before its offset. Imports must be idempotent. */
  apply(record: {
    kind: "snapshot" | "update";
    cursor: string;
    data: Uint8Array[];
  }): Promise<void>;
  onReady?(): void;
  onDisconnected?(): void;
  onError?(error: Error): void;
}
function streamError(error: StreamError): Error {
  return new Error(error.message);
}
function encode(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(chunks.join(""));
}
/** SDK owns HTTP, SSE framing, retries and resumption. This adapter owns local durability. */
export function createReplicaStreamClient(options: ReplicaStreamClientOptions) {
  let stop = new AbortController();
  let cursor: string | null = null;
  let running: Promise<void> | undefined;
  let live: Promise<void> | undefined;
  let applying: Promise<void> = Promise.resolve();
  let started = false;
  let ready = false;
  const headers = new Headers(options.headers);
  const bearer = headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  const sdk = new StreamsClient({
    url: options.url,
    headers,
    auth: bearer,
    fetch: (input, init) =>
      (options.fetch ?? globalThis.fetch)(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, stop.signal])
          : stop.signal,
      }),
  });
  function report(error: unknown) {
    if (!stop.signal.aborted)
      options.onError?.(error instanceof Error ? error : Error(String(error)));
  }
  function joined() {
    if (!ready && !stop.signal.aborted) {
      ready = true;
      options.onReady?.();
    }
  }
  function persist(
    kind: "snapshot" | "update",
    next: string,
    data: Uint8Array[],
  ) {
    const result = applying
      .catch(() => {})
      .then(async () => {
        if (stop.signal.aborted) return;
        // Opaque SDK offsets are lexicographically ordered within a stream.
        // Explicit catch-up and live reads can overlap; imports must be idempotent.
        if (cursor !== null && next <= cursor) return;
        await options.apply({ kind, cursor: next, data });
        cursor = next;
      });
    applying = result;
    return result;
  }
  async function updates(part: StreamPart, next: string) {
    const records: unknown = part.json();
    if (!Array.isArray(records)) throw Error("Invalid replica records");
    const bytes = records.map((record: unknown) => {
      if (
        typeof record !== "object" ||
        record === null ||
        !("update" in record) ||
        typeof record.update !== "string"
      )
        throw Error("Invalid replica record");
      return Uint8Array.from(atob(record.update), (c) => c.charCodeAt(0));
    });
    await persist("update", next, bytes);
  }
  async function snapshot() {
    const snapshot = await sdk.readLatestSnapshot();
    if (!snapshot.ok) throw streamError(snapshot.result);
    if (snapshot.result === null) {
      if (cursor !== null)
        throw Error("Retained log requires an available snapshot");
      cursor = "-1";
    } else
      await persist(
        "snapshot",
        snapshot.result.nextOffset,
        snapshot.result.payload.body.length
          ? [snapshot.result.payload.body]
          : [],
      );
  }
  async function pull() {
    if (cursor === null) await snapshot();
    let reset = false;
    while (!stop.signal.aborted) {
      const result = await sdk.read({ offset: cursor!, signal: stop.signal });
      if (!result.ok) {
        if (result.result.code === "gone" && !reset) {
          reset = true;
          await snapshot();
          continue;
        }
        throw streamError(result.result);
      }
      await updates(result.result.payload, result.result.nextOffset);
      if (result.result.upToDate) {
        joined();
        return;
      }
    }
  }
  function reconcile() {
    return (running ??= pull().finally(() => {
      running = undefined;
    }));
  }
  async function follow() {
    for await (const event of sdk.live({
      offset: cursor!,
      mode: "sse",
      signal: stop.signal,
    })) {
      if (stop.signal.aborted) return;
      if (event.type === "data") await updates(event.payload, event.nextOffset);
      else if (event.type === "up_to_date") joined();
      else if (event.type === "reconnecting") {
        ready = false;
        options.onDisconnected?.();
      } else if (event.type === "error") throw streamError(event.error);
    }
  }
  return {
    async start() {
      if (started) return;
      started = true;
      stop = new AbortController();
      cursor = await options.loadCursor();
      await reconcile();
      if (!stop.signal.aborted) live = follow().catch(report);
    },
    reconcile,
    async append(id: string, data: Uint8Array) {
      const result = await sdk.append({
        headers: { "idempotency-key": id },
        part: {
          contentType: "application/json",
          body: JSON.stringify({ id, update: encode(data) }),
        },
      });
      if (!result.ok) throw streamError(result.result);
      return result.result.nextOffset;
    },
    get cursor() {
      return cursor;
    },
    async close() {
      stop.abort();
      await Promise.allSettled([running, live, applying]);
      started = false;
      ready = false;
    },
  };
}
