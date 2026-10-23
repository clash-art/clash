/**
 * Streaming relay (#348): one upstream SSE body to the caller, unbuffered.
 *
 * The upstream body is `tee()`d. One branch goes to the caller chunk by chunk
 * (through the event transform when events are dropped or the model is
 * rewritten to the public code); the other runs through the usage
 * capture tap (sse.ts) and is discarded. Nothing waits for the whole body,
 * and `response.text()` is never called on a stream.
 *
 * The relay ends exactly once, with one of:
 * - `completed`: the body ended after the protocol's end marker;
 * - `truncated`: the body ended without it;
 * - `upstream_error`: reading the body failed;
 * - `timeout`: the stream outlived `maxDurationMs` and was aborted;
 * - `client_aborted`: the caller disconnected. The upstream fetch is aborted
 *   through its AbortController, then the relay ends (and settles) in the
 *   background, kept alive by `waitUntil`.
 * `onEnd` (settlement, retention) runs before the caller's stream closes, so
 * the text it returns, the coded trailer, is the last thing the caller reads.
 */
import {
  SSE_MODEL_PATHS,
  createSseEventTransform,
  createUsageCaptureStream,
  encodeSseComment,
  encodeSseEvent,
  sseModelRewrite,
  type SseEvent,
} from "./sse.js";
import type { GatewayErrorCode } from "./errors.js";
import type { StreamObservation, GatewayUsageShape } from "./usage.js";

export type StreamEnding = "completed" | "truncated" | "upstream_error" | "timeout" | "client_aborted";

export interface StreamRelayResult {
  ending: StreamEnding;
  observed: StreamObservation;
  /** Upstream bytes handed to the caller. */
  forwardedBytes: number;
}

export interface StreamRelayOptions {
  body: ReadableStream<Uint8Array>;
  shape: GatewayUsageShape;
  /** Controls the upstream fetch; aborted on disconnect and on the duration limit. */
  upstream: AbortController;
  maxDurationMs: number;
  /** Events the caller must not see (the usage chunk the gateway injected). */
  dropEvent?: (event: SseEvent) => boolean;
  /**
   * The public model code the caller asked for: each event's model is set to
   * it (sseModelRewrite), so no upstream model name reaches the caller. Every
   * other byte is relayed unchanged; the metering branch sees the upstream's.
   */
  publicModel?: string;
  /** Each upstream chunk exactly as handed to the caller. */
  onDelivered?: (chunk: Uint8Array) => void;
  /**
   * Runs once when the stream ends. Returns the text to append before the
   * caller's stream closes (ignored after a disconnect). Must not throw.
   */
  onEnd: (result: StreamRelayResult) => Promise<string>;
  /** Keeps background work alive after the caller is gone (Workers `ctx.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

const encoder = new TextEncoder();
const ignore = () => undefined;

/**
 * `source` through `transform`, with the pipe's own promise handled: an
 * aborted upstream errors the pipe, and the readable side already reports
 * that (workerd does not mark pipeThrough's promise handled).
 */
function through(source: ReadableStream<Uint8Array>, transform: TransformStream<Uint8Array, Uint8Array>): ReadableStream<Uint8Array> {
  source.pipeTo(transform.writable).catch(ignore);
  return transform.readable;
}

export function relayGatewayStream(options: StreamRelayOptions): ReadableStream<Uint8Array> {
  const [forward, meter] = options.body.tee();
  const capture = createUsageCaptureStream(options.shape);
  const meterReader = through(meter, capture.stream).getReader();
  const { dropEvent, publicModel } = options;
  const rewrite = publicModel !== undefined ? sseModelRewrite(publicModel, SSE_MODEL_PATHS[options.shape]) : undefined;
  const clientReader = (
    dropEvent || rewrite
      ? through(
          forward,
          createSseEventTransform((event, raw) => (dropEvent?.(event) ? null : rewrite ? rewrite(event, raw) : raw)),
        )
      : forward
  ).getReader();

  let clientGone = false;
  let timedOut = false;
  let meterFailed = false;
  let forwardedBytes = 0;

  const metered = (async () => {
    try {
      while (!(await meterReader.read()).done);
    } catch {
      meterFailed = true;
    }
    // No-op after a normal end (the tap's flush already resolved it).
    capture.stop();
    return capture.done;
  })();

  /**
   * Cancel both branches, which cancels the upstream body even if the upstream
   * ignores its signal, then abort the upstream fetch. In that order an abort
   * never errors a body the tee is still reading (workerd reports such tee
   * rejections as unhandled).
   */
  const stopUpstream = (reason: unknown) => {
    void Promise.allSettled([meterReader.cancel(reason), clientReader.cancel(reason)]).then(() =>
      options.upstream.abort(reason),
    );
  };

  let ending: Promise<string> | undefined;

  const end = (): Promise<string> =>
    (ending ??= (async () => {
      const observed = await metered;
      clearTimeout(timer);
      const kind: StreamEnding = clientGone
        ? "client_aborted"
        : timedOut
          ? "timeout"
          : meterFailed || !observed.completed
            ? "upstream_error"
            : observed.terminated
              ? "completed"
              : "truncated";
      const { completed: _completed, terminated: _terminated, ...observation } = observed;
      try {
        return await options.onEnd({ ending: kind, observed: observation, forwardedBytes });
      } catch {
        return "";
      }
    })());

  const timer = setTimeout(() => {
    timedOut = true;
    stopUpstream(new DOMException("The stream exceeded the gateway's duration limit.", "TimeoutError"));
    // Settle now, even if the caller is not reading; its next read gets the tail.
    options.waitUntil?.(end());
  }, options.maxDurationMs);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Uint8Array | undefined;
      try {
        const next = await clientReader.read();
        if (!next.done) chunk = next.value;
      } catch {
        // The upstream body failed; the metering branch sees the same failure.
      }
      if (chunk) {
        forwardedBytes += chunk.byteLength;
        options.onDelivered?.(chunk);
        controller.enqueue(chunk);
        return;
      }
      const tail = await end();
      if (clientGone) return;
      if (tail) controller.enqueue(encoder.encode(tail));
      controller.close();
    },
    cancel(reason) {
      clientGone = true;
      stopUpstream(reason ?? new DOMException("The caller disconnected.", "AbortError"));
      const settled = end();
      options.waitUntil?.(settled);
    },
  });
}

/** Name of the event that reports a coded gateway state inside a stream. */
export const GATEWAY_STREAM_STATE_EVENT = "gateway_error";

/**
 * A coded failure the caller can no longer receive as a header, because the
 * stream's headers were already sent: an SSE comment carrying the exact
 * header line (`: x-gateway-settlement: failed; code=…; request_id=…`), then a
 * `gateway_error` event with the same facts as JSON. The event has no `error`
 * field, so OpenAI clients do not mistake it for a failed completion, and it
 * follows the upstream's `[DONE]`, after which they stop reading.
 */
export function encodeGatewayStreamState(input: {
  header: string;
  value: string;
  code: GatewayErrorCode;
  requestId: string;
}): string {
  return (
    encodeSseComment(`${input.header}: ${input.value}`) +
    encodeSseEvent({
      event: GATEWAY_STREAM_STATE_EVENT,
      data: JSON.stringify({
        type: GATEWAY_STREAM_STATE_EVENT,
        header: input.header,
        state: "failed",
        code: input.code,
        request_id: input.requestId,
      }),
    })
  );
}
