/**
 * Process-wide control knobs and per-key-hash counters for the mock upstream.
 * Test-only: never deployed to production.
 */

export type MockMode = "ok" | "500" | "429" | "timeout" | "hang";

export interface MockUsageOverride {
  input: number;
  output: number;
  cached: number;
}

export interface MockControl {
  mode: MockMode;
  /** Delay before the first response byte (headers). */
  ttfb_ms: number;
  /** Delay between streamed content chunks. */
  chunk_ms: number;
  /** Number of content chunks to emit when streaming. */
  chunks: number;
  /** After this many content chunks, fail the stream with 500 mid-body. */
  fail_after_chunks?: number;
  /** Override deterministic usage when set. */
  usage?: MockUsageOverride;
}

export interface KeyStats {
  requests: number;
  streams: number;
  tokensEmitted: number;
  lastStatus: number;
}

export const DEFAULT_CONTROL: MockControl = {
  mode: "ok",
  ttfb_ms: 0,
  chunk_ms: 0,
  chunks: 3,
};

const MODES = new Set<MockMode>(["ok", "500", "429", "timeout", "hang"]);

export function createMockState() {
  let control: MockControl = { ...DEFAULT_CONTROL };
  const stats = new Map<string, KeyStats>();

  return {
    getControl(): MockControl {
      return {
        ...control,
        ...(control.usage ? { usage: { ...control.usage } } : {}),
      };
    },
    setControl(next: Partial<MockControl> & { mode?: string }): MockControl {
      const mode = (next.mode ?? control.mode) as MockMode;
      if (!MODES.has(mode)) throw new Error(`invalid mode: ${String(next.mode)}`);
      const ttfb_ms = intField(next.ttfb_ms, control.ttfb_ms, "ttfb_ms");
      const chunk_ms = intField(next.chunk_ms, control.chunk_ms, "chunk_ms");
      const chunks = intField(next.chunks, control.chunks, "chunks", 1);
      let fail_after_chunks = control.fail_after_chunks;
      if ("fail_after_chunks" in next) {
        if (next.fail_after_chunks === undefined || next.fail_after_chunks === null)
          fail_after_chunks = undefined;
        else
          fail_after_chunks = intField(
            next.fail_after_chunks,
            0,
            "fail_after_chunks",
            0,
          );
      }
      let usage = control.usage;
      if ("usage" in next) {
        if (next.usage === undefined || next.usage === null) usage = undefined;
        else {
          const u = next.usage;
          if (!u || typeof u !== "object") throw new Error("usage must be an object");
          usage = {
            input: intField(u.input, 0, "usage.input", 0),
            output: intField(u.output, 0, "usage.output", 0),
            cached: intField(u.cached, 0, "usage.cached", 0),
          };
        }
      }
      control = {
        mode,
        ttfb_ms,
        chunk_ms,
        chunks,
        ...(fail_after_chunks !== undefined ? { fail_after_chunks } : {}),
        ...(usage ? { usage } : {}),
      };
      return this.getControl();
    },
    record(
      keyId: string,
      info: { stream: boolean; tokensEmitted: number; status: number },
    ) {
      const row = stats.get(keyId) ?? {
        requests: 0,
        streams: 0,
        tokensEmitted: 0,
        lastStatus: 0,
      };
      row.requests += 1;
      if (info.stream) row.streams += 1;
      row.tokensEmitted += info.tokensEmitted;
      row.lastStatus = info.status;
      stats.set(keyId, row);
    },
    snapshot(): Record<string, KeyStats> {
      const out: Record<string, KeyStats> = {};
      for (const [key, value] of stats) out[key] = { ...value };
      return out;
    },
    reset() {
      stats.clear();
    },
  };
}

export type MockState = ReturnType<typeof createMockState>;

function intField(
  value: unknown,
  fallback: number,
  name: string,
  min = 0,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}
