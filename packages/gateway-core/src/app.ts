/**
 * createGatewayApp: the runtime-neutral HTTP data plane over GatewayPorts.
 * A plain WHATWG fetch handler (no framework: gateway-core reaches only zod);
 * each adapter mounts it under its own prefix and supplies the ports.
 *
 * Served today: OpenAI-compatible `POST {base}/v1/chat/completions`, plain or
 * `stream: true`.
 * Flow: authenticate once (identity comes from the credential only, never a
 * header claim) -> normalize -> admit (allowlist, catalog policy, plan, price,
 * limits, hold) -> call the planned upstream routes in failover order ->
 * settle exactly once -> answer. Every failure is a coded GatewayError in the
 * OpenAI error shape; upstream error bodies are never forwarded (they can echo
 * key fragments), and only metadata is logged. A settlement that fails after
 * the request ran marks the holds `settle_failed` and adds the
 * GATEWAY_SETTLEMENT_FAILED settlement header to the real answer. With
 * `retention.enabled`, every admitted request's normalized body and the exact
 * answer bytes are then retained (retention.ts); a retention failure adds the
 * GATEWAY_RETENTION_FAILED retention header and never changes the answer or
 * its billing.
 *
 * Streams (#348): the hold is reserved before any byte is sent, so a refusal
 * (402 and every other admission error) is a plain coded JSON answer. Failover
 * happens only before the upstream's first byte. The upstream body is then
 * relayed byte for byte (stream.ts), except the usage chunk the gateway asked
 * for on a caller's behalf and each chunk's `model`, which is the public model
 * code the caller asked for (as in a plain answer), and settled when it ends: observed usage, partial
 * on a cut or failed stream, and after the upstream is aborted when the caller
 * disconnects. Headers are gone by then, so a settlement or retention failure
 * is reported in-stream (encodeGatewayStreamState) as well as by the
 * `settle_failed` / `failed` rows and the coded logs.
 */
import type { ModelUpstreamRoute } from "@clash/shared-types/model-routing";

import {
  admitGatewayRequest,
  settleGatewayRequest,
  type GatewayAdmission,
} from "./admission.js";
import type { BudgetFlag, GatewayOutcome } from "./budget.js";
import {
  GatewayError,
  gatewayErrorResponseInit,
  toGatewayError,
  type GatewayErrorCode,
} from "./errors.js";
import type { GatewayIdentity, GatewayPorts, GatewayUpstreamCredential } from "./ports.js";
import type { GatewayPrice } from "./pricing.js";
import {
  callerOmittedStreamUsage,
  normalizeOpenAIChatRequest,
  prepareUpstreamBody,
  type GatewayRequest,
} from "./request.js";
import {
  nextGatewayAttempt,
  type GatewayRouteAttempt,
  type UpstreamFailure,
} from "./routing.js";
import {
  createRetainedBodyCopy,
  GATEWAY_RETENTION_HEADER,
  GATEWAY_STREAM_RETENTION_MAX_BYTES,
  retainGatewayExchange,
  retentionHeaderValue,
  type RetainedBodyCopy,
  type RetainExchangeInput,
} from "./retention.js";
import { encodeSseError, isOpenAIUsageOnlyChunk } from "./sse.js";
import { encodeGatewayStreamState, relayGatewayStream, type StreamEnding, type StreamRelayResult } from "./stream.js";
import { createUsageAccumulator, emptyUsage, settledUsage, streamedUsage, type Usage } from "./usage.js";

export const GATEWAY_REQUEST_ID_HEADER = "x-clash-request-id";
/**
 * Present only when settlement failed after the request ran:
 * `failed; code=GATEWAY_SETTLEMENT_FAILED; request_id=<id>`. The answer itself
 * is still the request's real outcome.
 */
export const GATEWAY_SETTLEMENT_HEADER = "x-gateway-settlement";

/**
 * Present only when the reservation admitted the request past a soft budget
 * limit or across an alert threshold (#354): one
 * `<soft_exceeded|alert_threshold>; budget_id=<id>; scope=<scope>` entry per
 * recorded flag, comma-separated. Set on every answer of the request,
 * stream headers included, since the flags are known at admission.
 */
export const GATEWAY_BUDGET_HEADER = "x-gateway-budget";

export function budgetHeaderValue(flags: readonly BudgetFlag[]): string {
  return flags.map((flag) => `${flag.kind}; budget_id=${flag.budgetId}; scope=${flag.scope}`).join(", ");
}

const budgetHeaders = (admission: GatewayAdmission): Record<string, string> =>
  admission.reservation.flags?.length ? { [GATEWAY_BUDGET_HEADER]: budgetHeaderValue(admission.reservation.flags) } : {};

export const GATEWAY_APP_DEFAULTS = {
  holdTtlMs: 10 * 60 * 1000,
  maxBodyBytes: 8 * 1024 * 1024,
  upstreamTimeoutMs: 120 * 1000,
  /** A stream is aborted and settled partial after this; its hold lives this much longer than `holdTtlMs`. */
  streamMaxDurationMs: 10 * 60 * 1000,
} as const;

/**
 * Upstream base URLs used when an official credential carries no `baseUrl`
 * (the same default as shared-runtime text generation). Any other upstream
 * must publish its `baseUrl` with the credential.
 */
const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
};

export interface GatewayAppOptions {
  /** Path prefix the app is mounted under, e.g. "/gateway". */
  basePath?: string;
  holdTtlMs?: number;
  maxBodyBytes?: number;
  /**
   * Upstream deadline when the route sets no first-byte timeout. For a stream
   * it covers the response headers only, never the stream itself.
   */
  upstreamTimeoutMs?: number;
  maxAttempts?: number;
  /** Longest a stream may run; see GATEWAY_APP_DEFAULTS.streamMaxDurationMs. */
  streamMaxDurationMs?: number;
  /**
   * Request/response body retention for admitted requests. Off unless enabled:
   * the deployment opts in (api-cf: hosted-only GATEWAY_STAFF_PROMPT_ACCESS).
   * `maxStreamBytes` caps a streamed answer's retained copy
   * (GATEWAY_STREAM_RETENTION_MAX_BYTES by default).
   */
  retention?: { enabled: boolean; ttlMs?: number; maxStreamBytes?: number };
  /**
   * Keeps work alive past the response (Workers `ctx.waitUntil`): a stream
   * whose caller disconnected is settled and retained in the background.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** How each stream ending is settled, and the in-stream error it reports. */
const STREAM_SETTLEMENT: Record<
  StreamEnding,
  { outcome: GatewayOutcome; error?: { code: GatewayErrorCode; reason: string } }
> = {
  completed: { outcome: "completed" },
  truncated: { outcome: "partial", error: { code: "GATEWAY_UPSTREAM_ERROR", reason: "stream_truncated" } },
  upstream_error: { outcome: "partial", error: { code: "GATEWAY_UPSTREAM_ERROR", reason: "stream_error" } },
  timeout: { outcome: "partial", error: { code: "GATEWAY_UPSTREAM_TIMEOUT", reason: "stream_max_duration" } },
  client_aborted: { outcome: "client_aborted" },
};

export interface GatewayApp {
  fetch(request: Request): Promise<Response>;
}

/**
 * Routes the chat protocol can execute without translation: OpenAI-compatible
 * text over plain HTTP. Executor-plugin routes own their whole lifecycle and
 * are never called directly.
 */
export function isOpenAIChatRoute(route: ModelUpstreamRoute): boolean {
  return route.kind === "text" && route.apiShape === "openai-compatible" && !route.executorPluginId;
}

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function json(body: unknown, init: { status: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init.status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...init.headers,
    },
  });
}

function normalizeBasePath(basePath: string | undefined): string {
  const trimmed = (basePath ?? "").replace(/\/+$/, "");
  return trimmed && !trimmed.startsWith("/") ? `/${trimmed}` : trimmed;
}

async function readJsonBody(request: Request, maxBodyBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(declared) && declared > maxBodyBytes)
    throw new GatewayError("GATEWAY_REQUEST_TOO_LARGE", {
      details: { bytes: declared, maxBytes: maxBodyBytes },
    });
  let text: string;
  try {
    text = await request.text();
  } catch (cause) {
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      message: "The request body could not be read.",
      cause,
    });
  }
  const bytes = encoder.encode(text).byteLength;
  if (bytes > maxBodyBytes)
    throw new GatewayError("GATEWAY_REQUEST_TOO_LARGE", {
      details: { bytes, maxBytes: maxBodyBytes },
    });
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      message: "The request body is not valid JSON.",
      cause,
    });
  }
}

type AttemptResult =
  | { kind: "answered"; body: Record<string, unknown>; outputBytes: number }
  /** A 2xx event stream; nothing was read from it yet. */
  | { kind: "streaming"; body: ReadableStream<Uint8Array>; contentType: string; upstream: AbortController }
  /** Nothing reached the upstream (no price, key or base URL for this route). */
  | { kind: "skipped"; error: GatewayError }
  | { kind: "failed"; failure: UpstreamFailure }
  /** The upstream answered 2xx with a body that is not a completion. */
  | { kind: "invalid"; error: GatewayError };

export function createGatewayApp(ports: GatewayPorts, options: GatewayAppOptions = {}): GatewayApp {
  const basePath = normalizeBasePath(options.basePath);
  const holdTtlMs = options.holdTtlMs ?? GATEWAY_APP_DEFAULTS.holdTtlMs;
  const maxBodyBytes = options.maxBodyBytes ?? GATEWAY_APP_DEFAULTS.maxBodyBytes;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? GATEWAY_APP_DEFAULTS.upstreamTimeoutMs;
  const streamMaxDurationMs = options.streamMaxDurationMs ?? GATEWAY_APP_DEFAULTS.streamMaxDurationMs;

  const errorResponse = (error: unknown, requestId?: string, extraHeaders: Record<string, string> = {}): Response => {
    const coded = toGatewayError(error);
    if (coded.code === "GATEWAY_INTERNAL")
      ports.logger.error("gateway.internal", {
        requestId,
        cause: coded.cause instanceof Error ? coded.cause.name : typeof coded.cause,
      });
    const init = gatewayErrorResponseInit(coded, "openai");
    return json(init.body, {
      status: init.status,
      headers: {
        ...init.headers,
        ...(requestId ? { [GATEWAY_REQUEST_ID_HEADER]: requestId } : {}),
        ...extraHeaders,
      },
    });
  };

  const priceFor = async (
    admission: GatewayAdmission,
    attempt: GatewayRouteAttempt,
  ): Promise<GatewayPrice> =>
    attempt.index === 0
      ? admission.price
      : ports.routes.price({
          identity: admission.identity,
          catalogVersion: admission.plan.catalogVersion,
          route: attempt.route,
          at: admission.pricedAt,
        });

  async function callAttempt(
    admission: GatewayAdmission,
    attempt: GatewayRouteAttempt,
  ): Promise<AttemptResult & { price?: GatewayPrice }> {
    let price: GatewayPrice;
    let credential: GatewayUpstreamCredential;
    try {
      price = await priceFor(admission, attempt);
      credential = await ports.credentials.resolve({
        route: attempt.route,
        scope: attempt.scope,
        tenantId: admission.identity.tenantId,
      });
    } catch (error) {
      return { kind: "skipped", error: toGatewayError(error) };
    }
    const baseUrl = (credential.baseUrl ?? DEFAULT_BASE_URLS[attempt.route.upstreamId])?.replace(/\/+$/, "");
    if (!baseUrl)
      return {
        kind: "skipped",
        error: new GatewayError("GATEWAY_KEY_UNAVAILABLE", {
          details: { upstreamId: attempt.route.upstreamId, reason: "base_url" },
        }),
      };

    const { stream } = admission.request;
    const deadlineMs = attempt.firstByteTimeoutMs ?? upstreamTimeoutMs;
    // A stream's deadline covers the response headers only; once they arrive
    // the same controller stays with the relay for disconnects and its
    // duration limit.
    const upstream = new AbortController();
    const firstByte = stream
      ? setTimeout(
          () => upstream.abort(new DOMException("The upstream did not answer in time.", "TimeoutError")),
          deadlineMs,
        )
      : undefined;
    let response: Response;
    try {
      response = await ports.upstream.fetch(
        new Request(`${baseUrl}/chat/completions`, {
          method: "POST",
          // Only gateway-owned headers: the caller's credential never travels upstream.
          headers: {
            authorization: `Bearer ${credential.apiKey}`,
            "content-type": "application/json",
            accept: stream ? "text/event-stream" : "application/json",
          },
          body: JSON.stringify(prepareUpstreamBody(admission.request, attempt.route.upstreamModel)),
          signal: stream ? upstream.signal : AbortSignal.timeout(deadlineMs),
        }),
      );
    } catch (error) {
      // Executed routes are idempotent text routes (isOpenAIChatRoute), so the
      // state only selects the code: a deadline is a timeout, anything else a
      // transport failure.
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        kind: "failed",
        price,
        failure: timedOut ? { state: "unknown", reason: "timeout" } : { state: "not-sent", reason: "network" },
      };
    } finally {
      clearTimeout(firstByte);
    }
    if (!response.ok) {
      // Drain without reading into anything the caller or logs can see.
      await response.body?.cancel().catch(() => undefined);
      return { kind: "failed", price, failure: { state: "answered", status: response.status } };
    }
    if (stream) {
      const contentType = response.headers.get("content-type");
      if (!response.body || (contentType !== null && !contentType.toLowerCase().includes("text/event-stream"))) {
        await response.body?.cancel().catch(() => undefined);
        return {
          kind: "invalid",
          price,
          error: new GatewayError("GATEWAY_UPSTREAM_ERROR", {
            details: { upstreamId: attempt.route.upstreamId, reason: "not_event_stream" },
          }),
        };
      }
      return { kind: "streaming", price, body: response.body, contentType: contentType ?? "text/event-stream", upstream };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!isRecord(body) || !Array.isArray(body.choices))
      return {
        kind: "invalid",
        price,
        error: new GatewayError("GATEWAY_UPSTREAM_ERROR", {
          details: { upstreamId: attempt.route.upstreamId, reason: "invalid_body" },
        }),
      };
    return {
      kind: "answered",
      price,
      body,
      outputBytes: encoder.encode(JSON.stringify(body.choices)).byteLength,
    };
  }

  /**
   * Settle once. A failed settlement does not change the answer (the upstream
   * work is done or failed either way); instead the holds are durably marked
   * `settle_failed` for reconciliation and the answer carries the settlement
   * header. Returns the headers to add to the answer.
   */
  async function settle(
    admission: GatewayAdmission,
    input: { attempt: GatewayRouteAttempt; outcome: GatewayOutcome; usage: Usage; price?: GatewayPrice; error?: GatewayError },
  ): Promise<Record<string, string>> {
    const { requestId } = admission;
    let cause: GatewayError;
    try {
      const { result } = await settleGatewayRequest(ports, admission, input);
      // Already closed, e.g. by the stale-hold sweeper: the recorded cost stands.
      if (result.duplicate)
        ports.logger.warn("gateway.settle_duplicate", {
          requestId,
          outcome: input.outcome,
          recordedMicroCredits: result.costMicroCredits,
        });
      return {};
    } catch (error) {
      cause = toGatewayError(error);
    }
    let marker: "settled" | "settle_failed" | "unrecorded";
    let markCause: string | undefined;
    try {
      marker = (
        await ports.budgets.markSettleFailed({
          requestId,
          tenantId: admission.identity.tenantId,
          errorCode: cause.code,
        })
      ).status;
    } catch (error) {
      marker = "unrecorded";
      markCause = toGatewayError(error).code;
    }
    if (marker === "settled") {
      // The settlement was recorded after all; nothing is left to reconcile.
      ports.logger.warn("gateway.settle_recovered", { requestId, cause: cause.code });
      return {};
    }
    const code: GatewayErrorCode = "GATEWAY_SETTLEMENT_FAILED";
    ports.logger.error("gateway.settle_failed", { requestId, code, cause: cause.code, marker, markCause });
    return { [GATEWAY_SETTLEMENT_HEADER]: `failed; code=${code}; request_id=${requestId}` };
  }

  /** The answer, and whether it is a stream (which settles and retains itself when it ends). */
  async function execute(admission: GatewayAdmission, started: number): Promise<{ response: Response; streaming: boolean }> {
    const { plan, requestId } = admission;
    let attempt: GatewayRouteAttempt | undefined = plan.attempts[0];
    let last: GatewayRouteAttempt = plan.attempts[0]!;
    let lastPrice: GatewayPrice | undefined;
    let error: GatewayError | undefined;
    let contacted = false;
    let tried = 0;

    while (attempt) {
      last = attempt;
      tried += 1;
      const result = await callAttempt(admission, attempt);
      lastPrice = result.price;
      if (result.kind === "streaming")
        return {
          response: streamAnswer(admission, { attempt, price: result.price ?? admission.price, tried, started }, result),
          streaming: true,
        };
      if (result.kind === "answered") {
        const accumulator = createUsageAccumulator("openai-chat");
        accumulator.observe(result.body);
        const usage = settledUsage(accumulator, {
          inputTokens: admission.request.estimatedInputTokens,
          outputBytes: result.outputBytes,
        });
        const settlement = await settle(admission, { attempt, outcome: "completed", usage, price: result.price });
        ports.logger.info("gateway.chat_completion", {
          requestId,
          model: plan.modelCode,
          upstreamId: attempt.route.upstreamId,
          accountId: attempt.route.accountId,
          attempts: tried,
          usageSource: usage.source,
          durationMs: ports.clock.now() - started,
        });
        // The public model code, not the upstream's, as the caller asked for it.
        return {
          response: json(
            { ...result.body, model: admission.request.model },
            { status: 200, headers: { [GATEWAY_REQUEST_ID_HEADER]: requestId, ...budgetHeaders(admission), ...settlement } },
          ),
          streaming: false,
        };
      }
      if (result.kind === "skipped") {
        error = result.error;
        attempt = plan.attempts[attempt.index + 1];
        continue;
      }
      contacted = true;
      if (result.kind === "invalid") {
        error = result.error;
        break;
      }
      const decision = nextGatewayAttempt(plan, attempt, result.failure);
      error = decision.error;
      if (decision.action === "fail") break;
      attempt = decision.next;
    }

    // Ran out of routes on a skip after an upstream already failed: exhausted.
    if (contacted && attempt === undefined && error && error.code !== "GATEWAY_ROUTES_EXHAUSTED")
      error = new GatewayError("GATEWAY_ROUTES_EXHAUSTED", {
        details: { model: plan.modelCode, attempts: tried, lastCode: error.code },
        cause: error,
      });
    const failure = error ?? new GatewayError("GATEWAY_INTERNAL");
    const settlement = await settle(admission, {
      attempt: last,
      outcome: contacted ? "upstream_failed" : "gateway_failed",
      usage: emptyUsage(),
      ...(lastPrice ? { price: lastPrice } : {}),
      error: failure,
    });
    ports.logger.warn("gateway.chat_completion_failed", {
      requestId,
      model: plan.modelCode,
      upstreamId: last.route.upstreamId,
      attempts: tried,
      code: failure.code,
      upstreamStatus:
        typeof failure.details?.upstreamStatus === "number" ? failure.details.upstreamStatus : undefined,
      durationMs: ports.clock.now() - started,
    });
    return { response: errorResponse(failure, requestId, { ...budgetHeaders(admission), ...settlement }), streaming: false };
  }

  /**
   * Relay an accepted upstream stream to the caller. Settlement and retention
   * run when it ends (finishStream); the response is returned at once.
   */
  function streamAnswer(
    admission: GatewayAdmission,
    context: { attempt: GatewayRouteAttempt; price: GatewayPrice; tried: number; started: number },
    result: Extract<AttemptResult, { kind: "streaming" }>,
  ): Response {
    const copy = options.retention?.enabled
      ? createRetainedBodyCopy(options.retention.maxStreamBytes ?? GATEWAY_STREAM_RETENTION_MAX_BYTES)
      : undefined;
    const body = relayGatewayStream({
      body: result.body,
      shape: "openai-chat",
      upstream: result.upstream,
      maxDurationMs: streamMaxDurationMs,
      // The usage chunk exists because the gateway asked for it; a caller that did not gets the stream it asked for.
      ...(callerOmittedStreamUsage(admission.request) ? { dropEvent: isOpenAIUsageOnlyChunk } : {}),
      // The public model code, not the upstream's, in every chunk, as in a plain answer.
      publicModel: admission.request.model,
      ...(copy ? { onDelivered: (chunk: Uint8Array) => copy.append(chunk) } : {}),
      ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
      onEnd: (relay) => finishStream(admission, context, relay, { copy, contentType: result.contentType }),
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": result.contentType,
        "cache-control": "no-store",
        [GATEWAY_REQUEST_ID_HEADER]: admission.requestId,
        ...budgetHeaders(admission),
      },
    });
  }

  /**
   * Settle an ended stream once, then retain what the caller received. Returns
   * the stream's tail: the in-stream error of a stream that did not complete,
   * then the coded state of a failed settlement or retention.
   */
  async function finishStream(
    admission: GatewayAdmission,
    context: { attempt: GatewayRouteAttempt; price: GatewayPrice; tried: number; started: number },
    relay: StreamRelayResult,
    retained: { copy: RetainedBodyCopy | undefined; contentType: string },
  ): Promise<string> {
    const { requestId, request } = admission;
    const { attempt, price } = context;
    const plan = STREAM_SETTLEMENT[relay.ending];
    const error = plan.error
      ? new GatewayError(plan.error.code, {
          details: { upstreamId: attempt.route.upstreamId, reason: plan.error.reason },
        })
      : undefined;
    const ceilings = [request.maxOutputTokens, price.maxOutputTokens].filter(
      (value): value is number => value !== undefined,
    );
    const usage = streamedUsage(relay.observed, {
      inputTokens: request.estimatedInputTokens,
      ...(ceilings.length ? { maxOutputTokens: Math.min(...ceilings) } : {}),
    });
    const settlement = await settle(admission, {
      attempt,
      outcome: plan.outcome,
      usage,
      price,
      ...(error ? { error } : {}),
    });
    const settlementState = settlement[GATEWAY_SETTLEMENT_HEADER];
    let tail = error ? encodeSseError(error, "openai") : "";
    if (settlementState)
      tail += encodeGatewayStreamState({
        header: GATEWAY_SETTLEMENT_HEADER,
        value: settlementState,
        code: "GATEWAY_SETTLEMENT_FAILED",
        requestId,
      });
    const callerGone = relay.ending === "client_aborted";
    ports.logger[relay.ending === "completed" ? "info" : "warn"]("gateway.chat_completion_stream", {
      requestId,
      model: admission.plan.modelCode,
      upstreamId: attempt.route.upstreamId,
      accountId: attempt.route.accountId,
      attempts: context.tried,
      ending: relay.ending,
      outcome: plan.outcome,
      code: error?.code,
      usageSource: usage.source,
      forwardedBytes: relay.forwardedBytes,
      durationMs: ports.clock.now() - context.started,
    });
    if (retained.copy) {
      // The stored answer is what the caller received: a gone caller received no tail.
      if (!callerGone && tail) retained.copy.append(encoder.encode(tail));
      const { body, truncated } = retained.copy.result();
      const failed = await retainAnswer(admission, {
        status: 200,
        body,
        contentType: retained.contentType,
        ...(truncated ? { truncated } : {}),
      });
      if (failed)
        tail += encodeGatewayStreamState({
          header: GATEWAY_RETENTION_HEADER,
          value: retentionHeaderValue(requestId),
          code: "GATEWAY_RETENTION_FAILED",
          requestId,
        });
    }
    return callerGone ? "" : tail;
  }

  async function chatCompletions(request: Request): Promise<Response> {
    const started = ports.clock.now();
    let admission: GatewayAdmission;
    try {
      const identity: GatewayIdentity = await ports.identity.authenticate(request);
      const body = await readJsonBody(request, maxBodyBytes);
      const gatewayRequest: GatewayRequest = normalizeOpenAIChatRequest(body, {
        idempotencyKey: request.headers.get("idempotency-key"),
        maxBodyBytes,
      });
      admission = await admitGatewayRequest(
        // Authenticated once above; admission reuses that identity.
        { ...ports, identity: { authenticate: async () => identity } },
        { httpRequest: request, request: gatewayRequest },
        {
          // A stream's hold outlives the longest stream, so the sweeper never expires a live one.
          holdTtlMs: gatewayRequest.stream ? holdTtlMs + streamMaxDurationMs : holdTtlMs,
          routing: {
            isRouteExecutable: isOpenAIChatRoute,
            ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
          },
        },
      );
    } catch (error) {
      return errorResponse(error);
    }
    let answer: { response: Response; streaming: boolean };
    try {
      answer = await execute(admission, started);
    } catch (error) {
      // execute() settles on every path it controls; this is a last resort.
      answer = { response: errorResponse(error, admission.requestId), streaming: false };
    }
    // A stream retains itself when it ends; everything else is retained now.
    return options.retention?.enabled && !answer.streaming ? retain(admission, answer.response) : answer.response;
  }

  /**
   * Retain the normalized request and the answer's exact bytes. Runs after
   * settlement and never throws, so the answer and its billing are unchanged;
   * a failure only adds the retention header.
   */
  async function retain(admission: GatewayAdmission, response: Response): Promise<Response> {
    const failed = await retainAnswer(admission, {
      status: response.status,
      body: new Uint8Array(await response.clone().arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/json",
    });
    if (failed) response.headers.set(GATEWAY_RETENTION_HEADER, retentionHeaderValue(admission.requestId));
    return response;
  }

  /** Store one exchange; true when retention failed (already recorded and logged). Never throws. */
  async function retainAnswer(admission: GatewayAdmission, answer: RetainExchangeInput["response"]): Promise<boolean> {
    try {
      const outcome = await retainGatewayExchange(ports, {
        requestId: admission.requestId,
        identity: admission.identity,
        request: { body: encoder.encode(JSON.stringify(admission.request.body)), contentType: "application/json" },
        response: answer,
        ...(options.retention?.ttlMs !== undefined ? { ttlMs: options.retention.ttlMs } : {}),
      });
      return outcome.status === "failed";
    } catch (error) {
      ports.logger.error("gateway.retention_failed", {
        requestId: admission.requestId,
        code: "GATEWAY_RETENTION_FAILED",
        cause: toGatewayError(error).code,
        marker: "unrecorded",
      });
      return true;
    }
  }

  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const path =
        basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))
          ? pathname.slice(basePath.length) || "/"
          : basePath
            ? undefined
            : pathname;
      if (path === "/v1/chat/completions") {
        if (request.method !== "POST")
          return errorResponse(
            new GatewayError("GATEWAY_INVALID_REQUEST", {
              message: "chat/completions accepts POST only.",
              details: { method: request.method },
            }),
          );
        return chatCompletions(request);
      }
      return errorResponse(
        new GatewayError("GATEWAY_CAPABILITY_UNAVAILABLE", {
          details: { method: request.method, path: path ?? pathname },
        }),
      );
    },
  };
}
