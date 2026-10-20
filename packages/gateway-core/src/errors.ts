/**
 * Closed gateway error taxonomy. Every gateway operation either succeeds or
 * rejects with a `GatewayError` whose code is listed here; adapters render the
 * same code as an HTTP status plus the caller's wire-protocol error body.
 */

/** Anthropic `error.type` values (https://docs.anthropic.com/en/api/errors). */
export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "timeout_error"
  | "overloaded_error";

/** OpenAI `error.type` values the gateway emits. */
export type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "insufficient_quota"
  | "rate_limit_error"
  | "server_error";

interface GatewayErrorDefinition {
  status: number;
  openai: OpenAIErrorType;
  anthropic: AnthropicErrorType;
  message: string;
}

const definitions = {
  GATEWAY_AUTH_REQUIRED: {
    status: 401,
    openai: "authentication_error",
    anthropic: "authentication_error",
    message: "A gateway credential is required.",
  },
  GATEWAY_TOKEN_EXPIRED: {
    status: 401,
    openai: "authentication_error",
    anthropic: "authentication_error",
    message: "The gateway token has expired; mint a new one.",
  },
  GATEWAY_TOKEN_REVOKED: {
    status: 401,
    openai: "authentication_error",
    anthropic: "authentication_error",
    message: "The gateway credential has been revoked.",
  },
  GATEWAY_FORBIDDEN: {
    status: 403,
    openai: "permission_error",
    anthropic: "permission_error",
    message: "The credential is not permitted to perform this operation.",
  },
  GATEWAY_MODEL_NOT_ALLOWED: {
    status: 403,
    openai: "permission_error",
    anthropic: "permission_error",
    message: "The credential is not permitted to use this model.",
  },
  GATEWAY_MODEL_NOT_FOUND: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "The model is not in the gateway catalog.",
  },
  GATEWAY_INVALID_REQUEST: {
    status: 400,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The request body is invalid.",
  },
  GATEWAY_REQUEST_TOO_LARGE: {
    status: 413,
    openai: "invalid_request_error",
    anthropic: "request_too_large",
    message: "The request exceeds the gateway size limit.",
  },
  GATEWAY_IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "A request with this idempotency key is still in progress.",
  },
  GATEWAY_IDEMPOTENCY_ALREADY_SETTLED: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "A request with this idempotency key has already been settled.",
  },
  GATEWAY_BUDGET_EXCEEDED: {
    status: 402,
    openai: "insufficient_quota",
    anthropic: "billing_error",
    message: "The budget for this request is exhausted.",
  },
  GATEWAY_RATE_LIMITED: {
    status: 429,
    openai: "rate_limit_error",
    anthropic: "rate_limit_error",
    message: "Rate limit exceeded; retry later.",
  },
  GATEWAY_CONCURRENCY_LIMITED: {
    status: 429,
    openai: "rate_limit_error",
    anthropic: "rate_limit_error",
    message: "Too many concurrent requests; retry later.",
  },
  GATEWAY_UPSTREAM_REJECTED: {
    status: 400,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The upstream provider rejected the request.",
  },
  GATEWAY_NO_ROUTE: {
    status: 503,
    openai: "server_error",
    anthropic: "api_error",
    message: "No enabled upstream route can serve this model.",
  },
  GATEWAY_ROUTES_EXHAUSTED: {
    status: 502,
    openai: "server_error",
    anthropic: "api_error",
    message: "Every upstream route for this model failed.",
  },
  GATEWAY_KEY_UNAVAILABLE: {
    status: 503,
    openai: "server_error",
    anthropic: "api_error",
    message: "The upstream credential is unavailable.",
  },
  GATEWAY_PRICE_UNAVAILABLE: {
    status: 503,
    openai: "server_error",
    anthropic: "api_error",
    message: "No price is published for this model and usage.",
  },
  GATEWAY_UPSTREAM_ERROR: {
    status: 502,
    openai: "server_error",
    anthropic: "api_error",
    message: "The upstream provider failed.",
  },
  GATEWAY_UPSTREAM_TIMEOUT: {
    status: 504,
    openai: "server_error",
    anthropic: "timeout_error",
    message: "The upstream provider did not answer in time.",
  },
  GATEWAY_CAPABILITY_UNAVAILABLE: {
    status: 501,
    openai: "server_error",
    anthropic: "api_error",
    message: "This gateway deployment does not implement the capability.",
  },
  GATEWAY_SETTLEMENT_FAILED: {
    status: 500,
    openai: "server_error",
    anthropic: "api_error",
    message: "The request was served but its settlement could not be recorded; it is held for reconciliation.",
  },
  GATEWAY_INTERNAL: {
    status: 500,
    openai: "server_error",
    anthropic: "api_error",
    message: "The gateway failed unexpectedly.",
  },
} as const satisfies Record<string, GatewayErrorDefinition>;

export type GatewayErrorCode = keyof typeof definitions;

export const GATEWAY_ERROR_CODES = Object.keys(
  definitions,
) as readonly GatewayErrorCode[];

export const GATEWAY_ERROR_TABLE: Readonly<
  Record<GatewayErrorCode, Readonly<GatewayErrorDefinition>>
> = definitions;

export interface GatewayErrorOptions {
  message?: string;
  /** Safe, non-secret structured context (budget id, reset time, upstream status). */
  details?: Record<string, unknown>;
  /** Advisory `Retry-After` in milliseconds for 429/503 answers. */
  retryAfterMs?: number;
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfterMs?: number;

  constructor(code: GatewayErrorCode, options: GatewayErrorOptions = {}) {
    super(options.message ?? definitions[code].message, {
      cause: options.cause,
    });
    this.name = "GatewayError";
    this.code = code;
    this.status = definitions[code].status;
    if (options.details) this.details = options.details;
    if (options.retryAfterMs !== undefined)
      this.retryAfterMs = Math.max(0, Math.ceil(options.retryAfterMs));
  }
}

export function isGatewayErrorCode(value: unknown): value is GatewayErrorCode {
  return typeof value === "string" && Object.hasOwn(definitions, value);
}

export function isGatewayError(error: unknown): error is GatewayError {
  return (
    error instanceof GatewayError ||
    (error instanceof Error &&
      error.name === "GatewayError" &&
      isGatewayErrorCode((error as { code?: unknown }).code))
  );
}

/** Coerce any thrown value into a coded error; unknown failures are GATEWAY_INTERNAL. */
export function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (isGatewayError(error))
    return new GatewayError(error.code, {
      message: error.message,
      details: error.details,
      retryAfterMs: error.retryAfterMs,
      cause: error,
    });
  return new GatewayError("GATEWAY_INTERNAL", { cause: error });
}

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: OpenAIErrorType;
    param: string | null;
    code: GatewayErrorCode;
  };
}

export interface AnthropicErrorBody {
  type: "error";
  error: { type: AnthropicErrorType; message: string };
}

export function toOpenAIErrorBody(error: GatewayError): OpenAIErrorBody {
  const param = error.details?.param;
  return {
    error: {
      message: error.message,
      type: definitions[error.code].openai,
      param: typeof param === "string" ? param : null,
      code: error.code,
    },
  };
}

export function toAnthropicErrorBody(error: GatewayError): AnthropicErrorBody {
  return {
    type: "error",
    error: {
      type: definitions[error.code].anthropic,
      message: `${error.code}: ${error.message}`,
    },
  };
}

export type GatewayWireProtocol = "openai" | "anthropic";

/** Status, headers and JSON body an adapter writes for a failed request. */
export function gatewayErrorResponseInit(
  error: GatewayError,
  protocol: GatewayWireProtocol,
): {
  status: number;
  headers: Record<string, string>;
  body: OpenAIErrorBody | AnthropicErrorBody;
} {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-clash-error-code": error.code,
  };
  if (error.retryAfterMs !== undefined)
    headers["retry-after"] = String(Math.ceil(error.retryAfterMs / 1000));
  return {
    status: error.status,
    headers,
    body:
      protocol === "anthropic"
        ? toAnthropicErrorBody(error)
        : toOpenAIErrorBody(error),
  };
}
