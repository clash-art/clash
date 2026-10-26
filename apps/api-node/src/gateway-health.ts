/**
 * Node gateway health, readiness, metrics and graceful drain (#375).
 *
 *   GET /healthz  liveness: the process answers (no dependency checks).
 *   GET /readyz   readiness: schema migrated, DB reachable, encryption key
 *                 usable, blob directory writable (when configured), and not
 *                 draining. 503 with the failed checks otherwise. The load
 *                 balancer's job is to stop routing on 503; nodes ship no LB
 *                 config.
 *   GET /metrics  Prometheus text of bounded, process-local gauges/counters.
 *                 No tenant, user, key or request labels (low cardinality).
 *                 The same values are also OTel instruments (metrics.ts).
 *
 * Drain (SIGTERM), see `runGatewayDrain`:
 *   readyz 503 → drain delay → stop accepting → grace (open streams may
 *   finish) → terminal SSE `GATEWAY_DRAINING` event to every open stream,
 *   whose relay is then cancelled so gateway-core settles its observed usage
 *   (#368 path, idempotent ledger) → wait for settlements → close sockets →
 *   close the DB pool. No connection is force-closed before the grace ends.
 *
 * Nothing here is shared between nodes: the registry only holds the streams
 * this process is serving right now (stateless nodes).
 */
import { access, constants } from "node:fs/promises";
import type { Server } from "node:http";
import { Hono, type MiddlewareHandler } from "hono";
import type { GatewayBackgroundWork } from "./gateway-node.ts";
import { loadMigrations } from "./migrations.ts";
import { currentEncryptionKid } from "./gateway-credentials.ts";
import type { GatewayKeyRing } from "./gateway-keyring.ts";
import type { GatewayBudgetSqlClient } from "./gateway-budget.ts";
import { observeGatewayNode, recordGatewayDrain } from "./metrics.ts";

export const GATEWAY_DRAINING_CODE = "GATEWAY_DRAINING";
const encoder = new TextEncoder();

/** The terminal event an open stream receives when its node drains. */
export function encodeGatewayDraining(requestId: string | undefined): string {
  const facts = { type: "gateway_error", state: "draining", code: GATEWAY_DRAINING_CODE, request_id: requestId ?? null };
  return `: x-gateway-state: draining; code=${GATEWAY_DRAINING_CODE}\n\nevent: gateway_error\ndata: ${JSON.stringify(facts)}\n\n`;
}

export interface GatewayStreamHandle {
  /** Write the terminal event, close the caller's stream, cancel the relay. */
  terminate(): Promise<void>;
}

export type GatewayDrainPhase = "serving" | "draining" | "stopped";

/** Process-local drain state plus the streams this node has open. */
export interface GatewayDrainController {
  readonly phase: GatewayDrainPhase;
  readonly openStreams: number;
  /** Register an open stream; call the returned function when it ends. */
  open(handle: GatewayStreamHandle): () => void;
  /** readyz turns 503 from here on. */
  beginDraining(): void;
  /** New gateway requests are refused from here on. */
  stopAccepting(): void;
  /** Resolves when no stream is open, or after `timeoutMs`; true if none left. */
  waitForStreams(timeoutMs: number): Promise<boolean>;
  /** Terminate every stream still open; resolves once each relay was cancelled. */
  terminateAll(): Promise<number>;
}

export function createGatewayDrainController(): GatewayDrainController {
  const streams = new Set<GatewayStreamHandle>();
  const waiters = new Set<() => void>();
  let phase: GatewayDrainPhase = "serving";
  const notify = () => {
    if (streams.size === 0) for (const wake of [...waiters]) wake();
  };
  return {
    get phase() {
      return phase;
    },
    get openStreams() {
      return streams.size;
    },
    open(handle) {
      streams.add(handle);
      return () => {
        streams.delete(handle);
        notify();
      };
    },
    beginDraining() {
      if (phase === "serving") phase = "draining";
    },
    stopAccepting() {
      phase = "stopped";
    },
    waitForStreams(timeoutMs) {
      if (streams.size === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (value: boolean) => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(value);
        };
        const wake = () => done(true);
        const timer = setTimeout(() => done(streams.size === 0), timeoutMs);
        timer.unref?.();
        waiters.add(wake);
      });
    },
    async terminateAll() {
      const open = [...streams];
      await Promise.allSettled(open.map((handle) => handle.terminate()));
      return open.length;
    },
  };
}

/**
 * Wrap a caller-facing SSE body so a drain can end it with the terminal event.
 * The event is written at an event boundary; then the caller's stream closes
 * and the inner (core relay) stream is cancelled, which aborts the upstream
 * and settles observed usage exactly once in the background.
 */
export function drainableSseBody(
  inner: ReadableStream<Uint8Array>,
  input: { drain: GatewayDrainController; requestId?: string },
): ReadableStream<Uint8Array> {
  const reader = inner.getReader();
  const decoder = new TextDecoder();
  let tail = "\n\n";
  let closed = false;
  let release: (() => void) | undefined;
  const finish = () => {
    closed = true;
    release?.();
    release = undefined;
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      release = input.drain.open({
        async terminate() {
          if (closed) return;
          finish();
          try {
            controller.enqueue(encoder.encode((/\n\r?\n$/.test(tail) ? "" : "\n\n") + encodeGatewayDraining(input.requestId)));
            controller.close();
          } catch {
            // The caller already went away.
          }
          await reader.cancel(new DOMException("The gateway node is draining.", "AbortError")).catch(() => undefined);
        },
      });
    },
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        if (closed) return;
        finish();
        controller.error(error);
        return;
      }
      if (closed) return;
      if (next.done) {
        finish();
        controller.close();
        return;
      }
      if (next.value.byteLength > 0)
        tail = (tail + decoder.decode(next.value.subarray(Math.max(0, next.value.byteLength - 4)))).slice(-4);
      controller.enqueue(next.value);
    },
    cancel(reason) {
      if (closed) return;
      finish();
      return reader.cancel(reason);
    },
  });
}

// ─── Readiness ───────────────────────────────────────────────────────────────

export type ReadinessCheck = () => Promise<void>;
export interface GatewayReadinessInput {
  db: GatewayBudgetSqlClient;
  drain: GatewayDrainController;
  /** Present on the `api` role: a current key must be configured and loaded. */
  ring?: GatewayKeyRing;
  /** Directories the node writes blobs to (CLOUD_CONTENT_DIR, CLOUD_ASSET_DIR). */
  blobDirectories?: readonly string[];
  /** Per-check time limit. */
  timeoutMs?: number;
}

export async function expectedMigrationIds(): Promise<string[]> {
  return (await loadMigrations()).map((migration) => migration.id);
}

export function createGatewayReadiness(input: GatewayReadinessInput) {
  let expected: Promise<string[]> | undefined;
  const timeoutMs = input.timeoutMs ?? 2000;
  const checks: Record<string, ReadinessCheck> = {
    db: async () => {
      await input.db.query("SELECT 1");
    },
    schema: async () => {
      const ids = await (expected ??= expectedMigrationIds());
      const { rows } = await input.db.query<{ id: string }>(
        "SELECT id FROM cloud_schema_migration WHERE id = ANY($1::text[])",
        [ids],
      );
      if (rows.length !== ids.length) throw Error("migrations_pending");
    },
    ...(input.ring
      ? {
          encryption: async () => {
            const kid = await currentEncryptionKid(input.db, input.ring!);
            if (!kid || !input.ring!.has(kid)) throw Error("current_key_missing");
          },
        }
      : {}),
    ...(input.blobDirectories?.length
      ? {
          blob: async () => {
            for (const directory of input.blobDirectories!) await access(directory, constants.W_OK);
          },
        }
      : {}),
  };
  return async (): Promise<{ ready: boolean; checks: Record<string, "ok" | "failed"> }> => {
    const results: Record<string, "ok" | "failed"> = {
      draining: input.drain.phase === "serving" ? "ok" : "failed",
    };
    await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            check(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(Error("timeout")), timeoutMs);
            }),
          ]);
          results[name] = "ok";
        } catch {
          // Reasons are not exposed: readyz is unauthenticated.
          results[name] = "failed";
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return { ready: Object.values(results).every((value) => value === "ok"), checks: results };
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export interface GatewayHealthRoutesInput extends GatewayReadinessInput {
  work: GatewayBackgroundWork;
}

/** Prometheus text exposition of the node's bounded gauges and counters. */
export function gatewayNodeMetricsText(input: { drain: GatewayDrainController; work: GatewayBackgroundWork }): string {
  const lines = [
    "# HELP clash_gateway_open_streams SSE streams this node is serving.",
    "# TYPE clash_gateway_open_streams gauge",
    `clash_gateway_open_streams ${input.drain.openStreams}`,
    "# HELP clash_gateway_pending_settlements Stream settlements still running in the background.",
    "# TYPE clash_gateway_pending_settlements gauge",
    `clash_gateway_pending_settlements ${input.work.pending}`,
    "# HELP clash_gateway_draining 1 while the node drains (readyz 503).",
    "# TYPE clash_gateway_draining gauge",
    `clash_gateway_draining ${input.drain.phase === "serving" ? 0 : 1}`,
    "# HELP clash_gateway_drained_streams_total Streams ended with GATEWAY_DRAINING.",
    "# TYPE clash_gateway_drained_streams_total counter",
    `clash_gateway_drained_streams_total ${drainedTotal}`,
  ];
  return `${lines.join("\n")}\n`;
}

let drainedTotal = 0;

export function createGatewayHealthRoutes(input: GatewayHealthRoutesInput): Hono {
  const readiness = createGatewayReadiness(input);
  observeGatewayNode({ drain: input.drain, work: input.work });
  const app = new Hono();
  const noStore = { "cache-control": "no-store" };
  app.get("/healthz", (c) => c.json({ status: "ok" }, 200, noStore));
  app.get("/readyz", async (c) => {
    const result = await readiness();
    return c.json({ status: result.ready ? "ok" : "unavailable", checks: result.checks }, result.ready ? 200 : 503, noStore);
  });
  app.get("/metrics", (c) =>
    c.body(gatewayNodeMetricsText(input), 200, { ...noStore, "content-type": "text/plain; version=0.0.4; charset=utf-8" }),
  );
  return app;
}

/** Refuse new gateway requests once the node stopped accepting (kept-alive sockets). */
export function refuseWhenStopped(drain: GatewayDrainController): MiddlewareHandler {
  return async (c, next) => {
    if (drain.phase !== "stopped") return next();
    return c.json(
      { error: { message: "The gateway node is draining; retry on another node.", type: "server_error", code: GATEWAY_DRAINING_CODE } },
      503,
      { "x-clash-error-code": GATEWAY_DRAINING_CODE, "retry-after": "1", connection: "close" },
    );
  };
}

// ─── Drain sequence ──────────────────────────────────────────────────────────

export interface GatewayDrainTimings {
  /** readyz 503 → stop accepting (lets the LB notice). GATEWAY_DRAIN_DELAY_MS. */
  delayMs: number;
  /** Stop accepting → terminal event to streams still open. GATEWAY_DRAIN_GRACE_MS. */
  graceMs: number;
  /** Time allowed for the drained streams' settlements. GATEWAY_DRAIN_SETTLE_MS. */
  settleMs: number;
}

const numberEnv = (value: string | undefined, fallback: number) => {
  const parsed = value?.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export function gatewayDrainTimingsFromEnv(env: Record<string, string | undefined>): GatewayDrainTimings {
  return {
    delayMs: numberEnv(env.GATEWAY_DRAIN_DELAY_MS, 5_000),
    graceMs: numberEnv(env.GATEWAY_DRAIN_GRACE_MS, 25_000),
    settleMs: numberEnv(env.GATEWAY_DRAIN_SETTLE_MS, 10_000),
  };
}

export interface GatewayDrainInput {
  drain: GatewayDrainController;
  work: GatewayBackgroundWork;
  server: Server;
  timings: GatewayDrainTimings;
  /** Called once the listener stopped accepting (stop timers, close websockets). */
  onStopAccepting?: () => Promise<void> | void;
  /** Closes the DB pool; runs last. */
  closeDatabase: () => Promise<void>;
  onStep?: (step: string, facts?: Record<string, unknown>) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runGatewayDrain(input: GatewayDrainInput): Promise<{ terminated: number }> {
  const step = input.onStep ?? (() => {});
  input.drain.beginDraining();
  step("draining", { openStreams: input.drain.openStreams });
  await sleep(input.timings.delayMs);
  input.drain.stopAccepting();
  const listenerClosed = new Promise<void>((resolve) => input.server.close(() => resolve()));
  // Only idle keep-alive sockets; requests in flight keep theirs.
  input.server.closeIdleConnections();
  step("stopped_accepting", { openStreams: input.drain.openStreams });
  let terminated = 0;
  try {
    await input.onStopAccepting?.();
    const empty = await input.drain.waitForStreams(input.timings.graceMs);
    if (!empty) {
      terminated = await input.drain.terminateAll();
      drainedTotal += terminated;
      recordGatewayDrain(terminated);
    }
    step("grace_ended", { terminated });
    await input.work.drain(input.timings.settleMs);
    step("settled", { pending: input.work.pending });
  } finally {
    // Every stream ended and settled (or the settle budget ran out): only now
    // may remaining sockets be cut.
    input.server.closeAllConnections();
    await listenerClosed;
    await input.closeDatabase();
    step("closed");
  }
  return { terminated };
}
