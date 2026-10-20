/**
 * createGatewayApp: the runtime-neutral HTTP data plane over GatewayPorts.
 * A plain WHATWG fetch handler (no framework: gateway-core reaches only zod);
 * each adapter mounts it under its own prefix and supplies the ports.
 *
 * Served today: non-streaming OpenAI-compatible `POST {base}/v1/chat/completions`.
 * Flow: authenticate once (identity comes from the credential only, never a
 * header claim) -> normalize -> admit (allowlist, catalog policy, plan, price,
 * limits, hold) -> call the planned upstream routes in failover order ->
 * settle exactly once -> answer. Every failure is a coded GatewayError in the
 * OpenAI error shape; upstream error bodies are never forwarded (they can echo
 * key fragments), and only metadata is logged. A settlement that fails after
 * the request ran marks the holds `settle_failed` and adds the
 * GATEWAY_SETTLEMENT_FAILED settlement header to the real answer.
 */
import type { ModelUpstreamRoute } from "@clash/shared-types/model-routing";

import {
  admitGatewayRequest,
  settleGatewayRequest,
  type GatewayAdmission,
} from "./admission.js";
import type { GatewayOutcome } from "./budget.js";
import {
  GatewayError,
  gatewayErrorResponseInit,
  toGatewayError,
  type GatewayErrorCode,
} from "./errors.js";
import type { GatewayIdentity, GatewayPorts, GatewayUpstreamCredential } from "./ports.js";
import type { GatewayPrice } from "./pricing.js";
import {
  normalizeOpenAIChatRequest,
  prepareUpstreamBody,
  type GatewayRequest,
} from "./request.js";
import {
  nextGatewayAttempt,
  type GatewayRouteAttempt,
  type UpstreamFailure,
} from "./routing.js";
import { createUsageAccumulator, emptyUsage, settledUsage, type Usage } from "./usage.js";

export const GATEWAY_REQUEST_ID_HEADER = "x-clash-request-id";
/**
 * Present only when settlement failed after the request ran:
 * `failed; code=GATEWAY_SETTLEMENT_FAILED; request_id=<id>`. The answer itself
 * is still the request's real outcome.
 */
export const GATEWAY_SETTLEMENT_HEADER = "x-gateway-settlement";

export const GATEWAY_APP_DEFAULTS = {
  holdTtlMs: 10 * 60 * 1000,
  maxBodyBytes: 8 * 1024 * 1024,
  upstreamTimeoutMs: 120 * 1000,
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
  /** Upstream deadline when the route sets no first-byte timeout. */
  upstreamTimeoutMs?: number;
  maxAttempts?: number;
}

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

    let response: Response;
    try {
      response = await ports.upstream.fetch(
        new Request(`${baseUrl}/chat/completions`, {
          method: "POST",
          // Only gateway-owned headers: the caller's credential never travels upstream.
          headers: {
            authorization: `Bearer ${credential.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(prepareUpstreamBody(admission.request, attempt.route.upstreamModel)),
          signal: AbortSignal.timeout(attempt.firstByteTimeoutMs ?? upstreamTimeoutMs),
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
    }
    if (!response.ok) {
      // Drain without reading into anything the caller or logs can see.
      await response.body?.cancel().catch(() => undefined);
      return { kind: "failed", price, failure: { state: "answered", status: response.status } };
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
      await settleGatewayRequest(ports, admission, input);
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

  async function execute(admission: GatewayAdmission, started: number): Promise<Response> {
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
        return json(
          { ...result.body, model: admission.request.model },
          { status: 200, headers: { [GATEWAY_REQUEST_ID_HEADER]: requestId, ...settlement } },
        );
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
    return errorResponse(failure, requestId, settlement);
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
      if (gatewayRequest.stream)
        throw new GatewayError("GATEWAY_CAPABILITY_UNAVAILABLE", {
          message: "Streaming chat completions are not supported yet; send stream: false.",
          details: { param: "stream" },
        });
      admission = await admitGatewayRequest(
        // Authenticated once above; admission reuses that identity.
        { ...ports, identity: { authenticate: async () => identity } },
        { httpRequest: request, request: gatewayRequest },
        {
          holdTtlMs,
          routing: {
            isRouteExecutable: isOpenAIChatRoute,
            ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
          },
        },
      );
    } catch (error) {
      return errorResponse(error);
    }
    try {
      return await execute(admission, started);
    } catch (error) {
      // execute() settles on every path it controls; this is a last resort.
      return errorResponse(error, admission.requestId);
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
