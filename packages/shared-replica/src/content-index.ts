/**
 * Room-side maintenance of the Project content-reference index (issue #130).
 *
 * Runtime-neutral: the Cloudflare ProjectRoom DO and a Node in-process room
 * both call {@link ContentReferenceIndexer.changed} after they durably accept
 * an update, and {@link ContentReferenceIndexer.refresh} when an upload service
 * reports an index miss. `compute` is typically `projectSyncContent(doc)`;
 * `writer` is D1, Postgres, SQLite or in-memory.
 */
export interface IndexedContentReferences {
  resources: Array<{ resourceId: string; kind: string }>;
  documents: Array<{ digest: string; byteLength: number; contentType: string }>;
}

export interface ContentReferenceIndexer<R extends IndexedContentReferences> {
  /** Debounced: coalesces bursts of updates into one index write. */
  changed(): void;
  /** Compute now, write if different from the last write, return the refs. */
  refresh(): Promise<R>;
  /** Wait for any scheduled/in-flight write (tests, shutdown). */
  flush(): Promise<void>;
}

export function createContentReferenceIndexer<
  R extends IndexedContentReferences,
>(options: {
  compute(): R;
  writer: { replace(refs: R): Promise<void> };
  debounceMs?: number;
  onError?(error: unknown): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}): ContentReferenceIndexer<R> {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let lastWritten: string | undefined;
  let timer: unknown;
  let inflight: Promise<unknown> = Promise.resolve();

  async function write(refs: R) {
    const fingerprint = JSON.stringify(refs);
    if (fingerprint === lastWritten) return;
    await options.writer.replace(refs);
    lastWritten = fingerprint;
  }
  function refresh(): Promise<R> {
    const refs = options.compute();
    const run = inflight.then(() => write(refs));
    inflight = run.catch((error) => options.onError?.(error));
    return run.then(() => refs);
  }
  return {
    changed() {
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(() => {
        timer = undefined;
        void refresh().catch(() => {});
      }, options.debounceMs ?? 200);
    },
    refresh,
    async flush() {
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
        await refresh().catch(() => {});
      }
      await inflight;
    },
  };
}
