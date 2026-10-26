/**
 * createGatewayApp: the runtime-neutral HTTP data plane over GatewayPorts.
 * A plain WHATWG fetch handler (no framework: gateway-core reaches only zod);
 * each adapter mounts it under its own prefix and supplies the ports.
 *
 * Served today, plain or `stream: true`:
 * - OpenAI-compatible `POST {base}/v1/chat/completions`;
 * - Anthropic Messages `POST {base}/anthropic/v1/messages` (#349), plus its
 *   unmetered `…/messages/count_tokens` (anthropic.ts).
 * Both protocols share one flow; PROTOCOLS holds what differs between them.
 * Flow: authenticate once (identity comes from the credential only, never a
 * header claim) -> normalize -> admit (catalog policy, model mapping,
 * allowlist, plan, price, limits, hold) -> call the planned upstream routes in
 * failover order -> settle exactly once -> answer. Every failure is a coded
 * GatewayError in the caller's protocol error shape; upstream error bodies are
 * never forwarded (they can echo key fragments), and only metadata is logged.
 * A settlement that fails after the request ran marks the holds
 * `settle_failed` and adds the GATEWAY_SETTLEMENT_FAILED settlement header to
 * the real answer. With `retention.enabled`, every admitted request's
 * normalized body and the exact answer bytes are then retained
 * (retention.ts); a retention failure adds the GATEWAY_RETENTION_FAILED
 * retention header and never changes the answer or its billing.
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
 *
 * Keys and circuits (#350): a route is called with its account's active key;
 * a 401/403 retries the account's draining version (a rotation in progress)
 * before failing over, and a key that cannot be resolved or decrypted is
 * GATEWAY_KEY_UNAVAILABLE for that route, never replaced by another version.
 * Connect failures, deadlines, 408/429/5xx fail over to the next route only
 * before the first byte. An official account whose circuit is open
 * (circuit.ts) is skipped without contact; all of them open is
 * GATEWAY_NO_ROUTE with Retry-After. Logs carry the key version, never a key.
 */
import type { ModelUpstreamRoute } from "@clash/shared-types/model-routing";

import {
  admitGatewayRequest,
  assertModelAllowed,
  planForIdentity,
  settleGatewayRequest,
  type GatewayAdmission,
} from "./admission.js";
import {
  anthropicCredentialRequest,
  anthropicMessageContent,
  anthropicTokenCount,
  anthropicUpstreamHeaders,
  isAnthropicMessagesRoute,
  resolveAnthropicModelCode,
} from "./anthropic.js";
import type { BudgetFlag, GatewayOutcome } from "./budget.js";
import { applyGatewayCatalogPolicy } from "./catalog-policy.js";
import {
  circuitFailureInput,
  countsAgainstCircuit,
  GATEWAY_CIRCUIT_DEFAULTS,
  gatewayCircuitState,
  type GatewayCircuitPolicy,
  type GatewayUpstreamHealth,
} from "./circuit.js";
import {
  GatewayError,
  gatewayErrorResponseInit,
  toGatewayError,
  type GatewayErrorCode,
  type GatewayWireProtocol,
} from "./errors.js";
import { requireAdmission, type GatewayRateLimitHeaders } from "./limits.js";
import type { GatewayIdentity, GatewayPorts, GatewayUpstreamCredential } from "./ports.js";
import type { GatewayPrice } from "./pricing.js";
import {
  callerOmittedStreamUsage,
  normalizeAnthropicCountTokensRequest,
  normalizeAnthropicMessagesRequest,
  normalizeOpenAIChatRequest,
  prepareUpstreamBody,
  type GatewayRequest,
  type NormalizeOptions,
} from "./request.js";
import {
  nextGatewayAttempt,
  type GatewayCatalog,
  type GatewayRouteAttempt,
  type UpstreamFailure,
  upstreamFailureCode,
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
import {
  createUsageAccumulator,
  emptyUsage,
  settledUsage,
  streamedUsage,
  type GatewayUsageShape,
  type Usage,
} from "./usage.js";

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

const rateLimitHeaders = (admission: GatewayAdmission): Record<string, string> =>
  admission.limitHeaders ?? {};

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
 * must publish its `baseUrl` with the credential, including the API version
 * segment the protocol path is appended to (`…/v1`).
 */
const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
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
  /** Upstream circuit breaker (circuit.ts); GATEWAY_CIRCUIT_DEFAULTS by default. */
  circuit?: GatewayCircuitPolicy;
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

/** What differs between the wire protocols the data plane serves; the flow is shared. */
interface WireProtocol {
  wire: GatewayWireProtocol;
  shape: GatewayUsageShape;
  /** Appended to the credential's base URL. */
  upstreamPath: string;
  isRouteExecutable(route: ModelUpstreamRoute): boolean;
  /** The request the identity port authenticates: the caller's credential only. */
  credentialRequest(request: Request): Request;
  normalize(body: unknown, options: NormalizeOptions): GatewayRequest;
  resolveModel?: (requested: string, catalog: GatewayCatalog) => string;
  /** Gateway-owned headers, plus only the protocol headers forwarded from the caller. */
  upstreamHeaders(apiKey: string, caller: Headers, stream: boolean): Record<string, string>;
  /** The generated part of a 2xx answer (the output estimate's basis), or undefined when it is not an answer. */
  answerContent(body: Record<string, unknown>): unknown;
  /** Log event prefix. */
  event: string;
}

const OPENAI_CHAT: WireProtocol = {
  wire: "openai",
  shape: "openai-chat",
  upstreamPath: "/chat/completions",
  isRouteExecutable: isOpenAIChatRoute,
  credentialRequest: (request) => request,
  normalize: normalizeOpenAIChatRequest,
  upstreamHeaders: (apiKey, _caller, stream) => ({
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
  }),
  answerContent: (body) => (Array.isArray(body.choices) ? body.choices : undefined),
  event: "gateway.chat_completion",
};

const ANTHROPIC_MESSAGES: WireProtocol = {
  wire: "anthropic",
  shape: "anthropic-messages",
  upstreamPath: "/messages",
  isRouteExecutable: isAnthropicMessagesRoute,
  credentialRequest: anthropicCredentialRequest,
  normalize: normalizeAnthropicMessagesRequest,
  resolveModel: resolveAnthropicModelCode,
  upstreamHeaders: anthropicUpstreamHeaders,
  answerContent: anthropicMessageContent,
  event: "gateway.messages",
};

/** Paths under the base path, each with the protocol whose errors it answers in. */
const ROUTES = new Map<string, { name: string; protocol: WireProtocol; countTokens?: true }>([
  ["/v1/chat/completions", { name: "chat/completions", protocol: OPENAI_CHAT }],
  ["/anthropic/v1/messages", { name: "messages", protocol: ANTHROPIC_MESSAGES }],
  ["/anthropic/v1/messages/count_tokens", { name: "messages/count_tokens", protocol: ANTHROPIC_MESSAGES, countTokens: true }],
]);

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

type AttemptResult = (
  | { kind: "answered"; body: Record<string, unknown>; outputBytes: number }
  /** A 2xx event stream; nothing was read from it yet. */
  | { kind: "streaming"; body: ReadableStream<Uint8Array>; contentType: string; upstream: AbortController }
  /** Nothing reached the upstream (no price, key or base URL for this route, or its circuit is open). */
  | { kind: "skipped"; error: GatewayError }
  | { kind: "failed"; failure: UpstreamFailure }
  /** The upstream answered 2xx with a body that is not an answer of the protocol. */
  | { kind: "invalid"; error: GatewayError }
) & {
  /** Version of the key the upstream was last called with; never the key. */
  keyVersion?: string;
};

/** The upstream refused the key itself: another version of the same account may be accepted. */
const isKeyRefusal = (result: AttemptResult): result is Extract<AttemptResult, { kind: "failed" }> =>
  result.kind === "failed" &&
  result.failure.state === "answered" &&
  (result.failure.status === 401 || result.failure.status === 403);

/**
 * One request's view of the planned accounts' circuits (circuit.ts), read
 * once before the first attempt. Official accounts only: tenant BYOK accounts
 * are the tenant's own. Advisory: a failed read or write is logged and routes
 * as if closed, never changing the answer.
 */
interface RequestCircuits {
  /** The coded skip for an attempt whose circuit is open, or undefined when it may be called. */
  openSkip(attempt: GatewayRouteAttempt): GatewayError | undefined;
  failed(attempt: GatewayRouteAttempt, code: GatewayErrorCode): Promise<void>;
  succeeded(attempt: GatewayRouteAttempt): Promise<void>;
}

/** One upstream call: where to send it and how to recognize its answer. */
interface UpstreamCall {
  path: string;
  stream: boolean;
  headers(apiKey: string): Record<string, string>;
  body: Record<string, unknown>;
  answerContent(body: Record<string, unknown>): unknown;
}

/** The attempt a stream is served by, for its settlement and log. */
interface StreamContext {
  attempt: GatewayRouteAttempt;
  price: GatewayPrice;
  tried: number;
  started: number;
  keyVersion?: string | undefined;
}

/** One caller request being served: its protocol and the caller's headers. */
interface Exchange {
  protocol: WireProtocol;
  caller: Headers;
}

export function createGatewayApp(ports: GatewayPorts, options: GatewayAppOptions = {}): GatewayApp {
  const basePath = normalizeBasePath(options.basePath);
  const holdTtlMs = options.holdTtlMs ?? GATEWAY_APP_DEFAULTS.holdTtlMs;
  const maxBodyBytes = options.maxBodyBytes ?? GATEWAY_APP_DEFAULTS.maxBodyBytes;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? GATEWAY_APP_DEFAULTS.upstreamTimeoutMs;
  const streamMaxDurationMs = options.streamMaxDurationMs ?? GATEWAY_APP_DEFAULTS.streamMaxDurationMs;

  const errorResponse = (
    error: unknown,
    requestId?: string,
    extraHeaders: Record<string, string> = {},
    wire: GatewayWireProtocol = "openai",
  ): Response => {
    const coded = toGatewayError(error);
    if (coded.code === "GATEWAY_INTERNAL")
      ports.logger.error("gateway.internal", {
        requestId,
        cause: coded.cause instanceof Error ? coded.cause.name : typeof coded.cause,
      });
    const init = gatewayErrorResponseInit(coded, wire);
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

  const circuitPolicy = options.circuit ?? GATEWAY_CIRCUIT_DEFAULTS;

  const circuitAccount = (attempt: GatewayRouteAttempt) =>
    attempt.scope === "official" ? attempt.route.accountId : undefined;

  async function requestCircuits(attempts: readonly GatewayRouteAttempt[], requestId?: string): Promise<RequestCircuits> {
    const health = new Map<string, GatewayUpstreamHealth>();
    const accountIds = [
      ...new Set(attempts.map(circuitAccount).filter((id): id is string => id !== undefined)),
    ];
    if (accountIds.length)
      try {
        for (const entry of await ports.upstreamHealth.read({ accountIds })) health.set(entry.accountId, entry);
      } catch (error) {
        ports.logger.warn("gateway.health_unavailable", { requestId, code: toGatewayError(error).code });
      }
    const recordFailed = (accountId: string, op: "failure" | "success", error: unknown) =>
      ports.logger.warn("gateway.health_record_failed", { requestId, accountId, op, code: toGatewayError(error).code });
    return {
      openSkip(attempt) {
        const accountId = circuitAccount(attempt);
        const entry = accountId ? health.get(accountId) : undefined;
        const now = ports.clock.now();
        if (gatewayCircuitState(entry, now) !== "open") return undefined;
        // Retry-After: the soonest any planned account's circuit half-opens.
        const reopens = [...health.values()]
          .filter((other) => gatewayCircuitState(other, now) === "open")
          .map((other) => other.openUntil! - now);
        return new GatewayError("GATEWAY_NO_ROUTE", {
          details: { upstreamId: attempt.route.upstreamId, accountId: accountId!, reason: "circuit_open" },
          retryAfterMs: Math.max(1, Math.min(...reopens)),
        });
      },
      async failed(attempt, code) {
        const accountId = circuitAccount(attempt);
        if (!accountId) return;
        const input = circuitFailureInput(accountId, code, ports.clock.now(), circuitPolicy);
        try {
          const entry = await ports.upstreamHealth.recordFailure(input);
          health.set(accountId, entry);
          if (entry.openUntil === input.openUntil)
            ports.logger.warn("gateway.circuit_open", {
              requestId,
              accountId,
              upstreamId: attempt.route.upstreamId,
              consecutiveFailures: entry.consecutiveFailures,
              cooldownMs: input.openUntil - input.at,
              code,
            });
        } catch (error) {
          recordFailed(accountId, "failure", error);
        }
      },
      async succeeded(attempt) {
        const accountId = circuitAccount(attempt);
        const entry = accountId ? health.get(accountId) : undefined;
        // Nothing on record to close: a healthy account's success writes nothing.
        if (!accountId || !entry || (entry.consecutiveFailures === 0 && entry.openUntil === undefined)) return;
        try {
          await ports.upstreamHealth.recordSuccess({ accountId, at: ports.clock.now() });
          health.set(accountId, { accountId, consecutiveFailures: 0 });
        } catch (error) {
          recordFailed(accountId, "success", error);
        }
      },
    };
  }

  /**
   * Call one route: skip it while its circuit is open, then call it with its
   * active key. A key the upstream refuses (401/403) is retried with the
   * account's next usable version (a rotation draining), still before any
   * byte reached the caller; a key that cannot be resolved is never replaced
   * by another version (fail closed). The outcome counts against the circuit.
   */
  async function callUpstream(
    attempt: GatewayRouteAttempt,
    tenantId: string,
    call: UpstreamCall,
    circuits: RequestCircuits,
    requestId?: string,
  ): Promise<AttemptResult> {
    const open = circuits.openSkip(attempt);
    if (open) return { kind: "skipped", error: open };
    const refused: string[] = [];
    let result: AttemptResult | undefined;
    for (;;) {
      let credential: GatewayUpstreamCredential;
      try {
        credential = await ports.credentials.resolve({
          route: attempt.route,
          scope: attempt.scope,
          tenantId,
          ...(refused.length ? { excludeKeyVersions: [...refused] } : {}),
        });
      } catch (error) {
        const coded = toGatewayError(error);
        const reason = typeof coded.details?.reason === "string" ? coded.details.reason : undefined;
        // After a refusal, an account with no other version simply has nothing left to try.
        if (!result || reason !== "no_key_version")
          ports.logger.warn("gateway.key_unavailable", {
            requestId,
            accountId: attempt.route.accountId,
            upstreamId: attempt.route.upstreamId,
            code: coded.code,
            reason,
            refusedVersions: refused.length,
          });
        if (!result) return { kind: "skipped", error: coded };
        break;
      }
      const { keyVersion } = credential;
      result = {
        ...(await callWithCredential(attempt, credential, call)),
        ...(keyVersion !== undefined ? { keyVersion } : {}),
      };
      if (!isKeyRefusal(result) || keyVersion === undefined || refused.includes(keyVersion)) break;
      ports.logger.warn("gateway.upstream_key_refused", {
        requestId,
        accountId: attempt.route.accountId,
        upstreamId: attempt.route.upstreamId,
        keyVersion,
        upstreamStatus: result.failure.state === "answered" ? result.failure.status : undefined,
      });
      refused.push(keyVersion);
    }
    if (result.kind === "answered" || result.kind === "streaming") await circuits.succeeded(attempt);
    else if (result.kind === "invalid") await circuits.failed(attempt, result.error.code);
    else if (result.kind === "failed" && countsAgainstCircuit(result.failure))
      await circuits.failed(attempt, upstreamFailureCode(result.failure));
    return result;
  }

  /** One upstream call with a resolved credential. */
  async function callWithCredential(
    attempt: GatewayRouteAttempt,
    credential: GatewayUpstreamCredential,
    call: UpstreamCall,
  ): Promise<AttemptResult> {
    const baseUrl = (credential.baseUrl ?? DEFAULT_BASE_URLS[attempt.route.upstreamId])?.replace(/\/+$/, "");
    if (!baseUrl)
      return {
        kind: "skipped",
        error: new GatewayError("GATEWAY_KEY_UNAVAILABLE", {
          details: { upstreamId: attempt.route.upstreamId, reason: "base_url" },
        }),
      };

    const { stream } = call;
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
        new Request(`${baseUrl}${call.path}`, {
          method: "POST",
          // Only gateway-owned and protocol headers: the caller's credential never travels upstream.
          headers: call.headers(credential.apiKey),
          body: JSON.stringify(call.body),
          signal: stream ? upstream.signal : AbortSignal.timeout(deadlineMs),
        }),
      );
    } catch (error) {
      // Executed routes are idempotent text routes, so the state only selects
      // the code: a deadline is a timeout, anything else a transport failure.
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        kind: "failed",
        failure: timedOut ? { state: "unknown", reason: "timeout" } : { state: "not-sent", reason: "network" },
      };
    } finally {
      clearTimeout(firstByte);
    }
    if (!response.ok) {
      // Drain without reading into anything the caller or logs can see.
      await response.body?.cancel().catch(() => undefined);
      return { kind: "failed", failure: { state: "answered", status: response.status } };
    }
    if (stream) {
      const contentType = response.headers.get("content-type");
      if (!response.body || (contentType !== null && !contentType.toLowerCase().includes("text/event-stream"))) {
        await response.body?.cancel().catch(() => undefined);
        return {
          kind: "invalid",
          error: new GatewayError("GATEWAY_UPSTREAM_ERROR", {
            details: { upstreamId: attempt.route.upstreamId, reason: "not_event_stream" },
          }),
        };
      }
      return { kind: "streaming", body: response.body, contentType: contentType ?? "text/event-stream", upstream };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const content = isRecord(body) ? call.answerContent(body) : undefined;
    if (!isRecord(body) || content === undefined)
      return {
        kind: "invalid",
        error: new GatewayError("GATEWAY_UPSTREAM_ERROR", {
          details: { upstreamId: attempt.route.upstreamId, reason: "invalid_body" },
        }),
      };
    return { kind: "answered", body, outputBytes: encoder.encode(JSON.stringify(content)).byteLength };
  }

  async function callAttempt(
    admission: GatewayAdmission,
    attempt: GatewayRouteAttempt,
    exchange: Exchange,
    circuits: RequestCircuits,
  ): Promise<AttemptResult & { price?: GatewayPrice }> {
    const open = circuits.openSkip(attempt);
    if (open) return { kind: "skipped", error: open };
    let price: GatewayPrice;
    try {
      price = await priceFor(admission, attempt);
    } catch (error) {
      return { kind: "skipped", error: toGatewayError(error) };
    }
    const { protocol, caller } = exchange;
    const { stream } = admission.request;
    const result = await callUpstream(
      attempt,
      admission.identity.tenantId,
      {
        path: protocol.upstreamPath,
        stream,
        headers: (apiKey) => protocol.upstreamHeaders(apiKey, caller, stream),
        body: prepareUpstreamBody(admission.request, attempt.route.upstreamModel),
        answerContent: protocol.answerContent,
      },
      circuits,
      admission.requestId,
    );
    // A skip before the call (no key or base URL) never priced anything worth recording.
    return result.kind === "skipped" ? result : { ...result, price };
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
  async function execute(
    admission: GatewayAdmission,
    exchange: Exchange,
    started: number,
  ): Promise<{ response: Response; streaming: boolean }> {
    const { plan, requestId } = admission;
    const { protocol } = exchange;
    let attempt: GatewayRouteAttempt | undefined = plan.attempts[0];
    let last: GatewayRouteAttempt = plan.attempts[0]!;
    let lastPrice: GatewayPrice | undefined;
    let error: GatewayError | undefined;
    let contacted = false;
    let tried = 0;
    const circuits = await requestCircuits(plan.attempts, requestId);

    while (attempt) {
      last = attempt;
      tried += 1;
      const result = await callAttempt(admission, attempt, exchange, circuits);
      lastPrice = result.price;
      if (result.kind === "streaming")
        return {
          response: streamAnswer(
            admission,
            exchange,
            { attempt, price: result.price ?? admission.price, tried, started, keyVersion: result.keyVersion },
            result,
          ),
          streaming: true,
        };
      if (result.kind === "answered") {
        const accumulator = createUsageAccumulator(protocol.shape);
        accumulator.observe(result.body);
        const usage = settledUsage(accumulator, {
          inputTokens: admission.request.estimatedInputTokens,
          outputBytes: result.outputBytes,
        });
        const settlement = await settle(admission, { attempt, outcome: "completed", usage, price: result.price });
        ports.logger.info(protocol.event, {
          requestId,
          model: plan.modelCode,
          upstreamId: attempt.route.upstreamId,
          accountId: attempt.route.accountId,
          keyVersion: result.keyVersion,
          attempts: tried,
          usageSource: usage.source,
          durationMs: ports.clock.now() - started,
        });
        // The public model code, not the upstream's, as the caller asked for it.
        return {
          response: json(
            { ...result.body, model: admission.request.model },
            {
              status: 200,
              headers: {
                [GATEWAY_REQUEST_ID_HEADER]: requestId,
                ...rateLimitHeaders(admission),
                ...budgetHeaders(admission),
                ...settlement,
              },
            },
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
    ports.logger.warn(`${protocol.event}_failed`, {
      requestId,
      model: plan.modelCode,
      upstreamId: last.route.upstreamId,
      attempts: tried,
      code: failure.code,
      upstreamStatus:
        typeof failure.details?.upstreamStatus === "number" ? failure.details.upstreamStatus : undefined,
      durationMs: ports.clock.now() - started,
    });
    return {
      response: errorResponse(
        failure,
        requestId,
        { ...rateLimitHeaders(admission), ...budgetHeaders(admission), ...settlement },
        protocol.wire,
      ),
      streaming: false,
    };
  }

  /**
   * Relay an accepted upstream stream to the caller. Settlement and retention
   * run when it ends (finishStream); the response is returned at once.
   */
  function streamAnswer(
    admission: GatewayAdmission,
    exchange: Exchange,
    context: StreamContext,
    result: Extract<AttemptResult, { kind: "streaming" }>,
  ): Response {
    const copy = options.retention?.enabled
      ? createRetainedBodyCopy(options.retention.maxStreamBytes ?? GATEWAY_STREAM_RETENTION_MAX_BYTES)
      : undefined;
    const body = relayGatewayStream({
      body: result.body,
      shape: exchange.protocol.shape,
      upstream: result.upstream,
      maxDurationMs: streamMaxDurationMs,
      // The usage chunk exists because the gateway asked for it; a caller that did not gets the stream it asked for.
      ...(callerOmittedStreamUsage(admission.request) ? { dropEvent: isOpenAIUsageOnlyChunk } : {}),
      // The public model code, not the upstream's, in every chunk, as in a plain answer.
      publicModel: admission.request.model,
      ...(copy ? { onDelivered: (chunk: Uint8Array) => copy.append(chunk) } : {}),
      ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
      onEnd: (relay) => finishStream(admission, exchange, context, relay, { copy, contentType: result.contentType }),
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": result.contentType,
        "cache-control": "no-store",
        [GATEWAY_REQUEST_ID_HEADER]: admission.requestId,
        ...rateLimitHeaders(admission),
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
    exchange: Exchange,
    context: StreamContext,
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
    let tail = error ? encodeSseError(error, exchange.protocol.wire) : "";
    if (settlementState)
      tail += encodeGatewayStreamState({
        header: GATEWAY_SETTLEMENT_HEADER,
        value: settlementState,
        code: "GATEWAY_SETTLEMENT_FAILED",
        requestId,
      });
    const callerGone = relay.ending === "client_aborted";
    ports.logger[relay.ending === "completed" ? "info" : "warn"](`${exchange.protocol.event}_stream`, {
      requestId,
      model: admission.plan.modelCode,
      upstreamId: attempt.route.upstreamId,
      accountId: attempt.route.accountId,
      keyVersion: context.keyVersion,
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

  /** A metered model call of either protocol. */
  async function serve(request: Request, protocol: WireProtocol): Promise<Response> {
    const started = ports.clock.now();
    let admission: GatewayAdmission;
    try {
      const identity: GatewayIdentity = await ports.identity.authenticate(protocol.credentialRequest(request));
      const body = await readJsonBody(request, maxBodyBytes);
      const gatewayRequest: GatewayRequest = protocol.normalize(body, {
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
            isRouteExecutable: protocol.isRouteExecutable,
            ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
          },
          ...(protocol.resolveModel ? { resolveModel: protocol.resolveModel } : {}),
        },
      );
    } catch (error) {
      return errorResponse(error, undefined, {}, protocol.wire);
    }
    const exchange: Exchange = { protocol, caller: request.headers };
    let answer: { response: Response; streaming: boolean };
    try {
      answer = await execute(admission, exchange, started);
    } catch (error) {
      // execute() settles on every path it controls; this is a last resort.
      answer = {
        response: errorResponse(error, admission.requestId, rateLimitHeaders(admission), protocol.wire),
        streaming: false,
      };
    }
    // A stream retains itself when it ends; everything else is retained now.
    return options.retention?.enabled && !answer.streaming ? retain(admission, answer.response) : answer.response;
  }

  /**
   * Anthropic `messages/count_tokens`: authenticated, catalog-mapped,
   * allowlisted and rate-limited like a model call, then proxied to the
   * planned anthropic-compatible routes in failover order. Nothing is
   * generated, so there is no hold and no ledger row.
   */
  async function countTokens(request: Request, protocol: WireProtocol): Promise<Response> {
    const started = ports.clock.now();
    let leaseId: string | undefined;
    let limitHeaders: GatewayRateLimitHeaders = {};
    try {
      const caller = await ports.identity.authenticate(protocol.credentialRequest(request));
      const counted = normalizeAnthropicCountTokensRequest(await readJsonBody(request, maxBodyBytes), { maxBodyBytes });
      const { catalog } = applyGatewayCatalogPolicy(await ports.routes.catalog(caller));
      const model = protocol.resolveModel ? protocol.resolveModel(counted.model, catalog) : counted.model;
      assertModelAllowed(caller, model);
      const { plan, identity } = await planForIdentity(ports, caller, {
        modelCode: model,
        kind: "text",
        catalog,
        isRouteExecutable: protocol.isRouteExecutable,
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      });
      const limitDecision = await ports.limits.admit({
        tenantId: identity.tenantId,
        userId: identity.userId,
        ...(identity.keyId ? { keyId: identity.keyId } : {}),
        modelCode: plan.modelCode,
        estimatedTokens: 0,
      });
      leaseId = requireAdmission(limitDecision);
      if (limitDecision.allowed && limitDecision.headers) limitHeaders = limitDecision.headers;
      let attempt: GatewayRouteAttempt | undefined = plan.attempts[0];
      let error: GatewayError | undefined;
      let contacted = false;
      const circuits = await requestCircuits(plan.attempts);
      while (attempt) {
        const result = await callUpstream(
          attempt,
          identity.tenantId,
          {
            path: `${protocol.upstreamPath}/count_tokens`,
            stream: false,
            headers: (apiKey) => protocol.upstreamHeaders(apiKey, request.headers, false),
            body: { ...counted.body, model: attempt.route.upstreamModel },
            answerContent: anthropicTokenCount,
          },
          circuits,
        );
        if (result.kind === "answered") {
          ports.logger.info(`${protocol.event}_count_tokens`, {
            model: plan.modelCode,
            upstreamId: attempt.route.upstreamId,
            accountId: attempt.route.accountId,
            durationMs: ports.clock.now() - started,
          });
          return json(result.body, { status: 200, headers: limitHeaders });
        }
        if (result.kind === "skipped") {
          error = result.error;
          attempt = plan.attempts[attempt.index + 1];
          continue;
        }
        if (result.kind === "streaming") {
          // Unreachable for a plain call; never leave a body open.
          await result.body.cancel().catch(() => undefined);
          throw new GatewayError("GATEWAY_INTERNAL");
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
      if (contacted && attempt === undefined && error && error.code !== "GATEWAY_ROUTES_EXHAUSTED")
        error = new GatewayError("GATEWAY_ROUTES_EXHAUSTED", {
          details: { model: plan.modelCode, lastCode: error.code },
          cause: error,
        });
      throw error ?? new GatewayError("GATEWAY_INTERNAL");
    } catch (error) {
      const coded = toGatewayError(error);
      if (leaseId !== undefined)
        ports.logger.warn(`${protocol.event}_count_tokens_failed`, {
          code: coded.code,
          durationMs: ports.clock.now() - started,
        });
      return errorResponse(coded, undefined, limitHeaders, protocol.wire);
    } finally {
      if (leaseId !== undefined) await ports.limits.release({ leaseId }).catch(() => undefined);
    }
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
      const route = path === undefined ? undefined : ROUTES.get(path);
      if (route) {
        if (request.method !== "POST")
          return errorResponse(
            new GatewayError("GATEWAY_INVALID_REQUEST", {
              message: `${route.name} accepts POST only.`,
              details: { method: request.method },
            }),
            undefined,
            {},
            route.protocol.wire,
          );
        return route.countTokens ? countTokens(request, route.protocol) : serve(request, route.protocol);
      }
      return errorResponse(
        new GatewayError("GATEWAY_CAPABILITY_UNAVAILABLE", {
          details: { method: request.method, path: path ?? pathname },
        }),
        undefined,
        {},
        path?.startsWith("/anthropic/") ? "anthropic" : "openai",
      );
    },
  };
}
