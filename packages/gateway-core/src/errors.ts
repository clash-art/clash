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
  // Price book and credit billing (admin and purchase APIs, #352).
  GATEWAY_PRICE_VERSION_NOT_FOUND: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "No price-book version with this name exists.",
  },
  GATEWAY_PRICE_VERSION_PUBLISHED: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The price-book version is published and can no longer change.",
  },
  GATEWAY_PRICE_WINDOW_INVALID: {
    status: 400,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The price-book version's effective window is empty or already over.",
  },
  GATEWAY_PRICE_MODEL_BLOCKED: {
    status: 400,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The gateway serves DeepSeek through Flash models only.",
  },
  GATEWAY_PACKAGE_NOT_FOUND: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "The subscription package does not exist.",
  },
  GATEWAY_PACKAGE_ARCHIVED: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The subscription package is archived and cannot be subscribed to.",
  },
  GATEWAY_TOPUP_PACK_NOT_FOUND: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "The top-up pack does not exist.",
  },
  GATEWAY_TOPUP_PACK_ARCHIVED: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The top-up pack is archived and cannot be purchased.",
  },
  GATEWAY_TENANT_NOT_FOUND: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "The tenant does not exist.",
  },
  GATEWAY_SUBSCRIPTION_EXISTS: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The tenant already has an active subscription.",
  },
  GATEWAY_SUBSCRIPTION_NOT_FOUND: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "The tenant has no active subscription.",
  },
  GATEWAY_IDEMPOTENCY_CONFLICT: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The idempotency key was already used for a different purchase.",
  },
  GATEWAY_WALLET_INCOMPATIBLE: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The tenant wallet is unlimited or periodic and cannot hold purchased credits.",
  },
  // Admin console (#353): catalog, upstream accounts, budgets, roles, prompts.
  GATEWAY_CATALOG_VERSION_NOT_FOUND: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "No catalog version or draft model with this name exists.",
  },
  GATEWAY_CATALOG_VERSION_PUBLISHED: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The catalog version is published and can no longer change.",
  },
  GATEWAY_CATALOG_MODEL_INVALID: {
    status: 400,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The model card is invalid or does not match the catalog row.",
  },
  GATEWAY_CATALOG_MODEL_BLOCKED: {
    status: 400,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The gateway serves DeepSeek through Flash models only.",
  },
  GATEWAY_UPSTREAM_NOT_FOUND: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "The upstream account does not exist.",
  },
  GATEWAY_ENCRYPTION_KEY_MISSING: {
    status: 503,
    openai: "server_error",
    anthropic: "api_error",
    message: "The gateway credential encryption key is not configured; use a secret reference instead.",
  },
  GATEWAY_BUDGET_NOT_FOUND: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "The budget does not exist.",
  },
  GATEWAY_BUDGET_BELOW_USAGE: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The budget limit cannot go below what is already spent and reserved.",
  },
  GATEWAY_KEY_NOT_FOUND: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "The virtual key does not exist in this tenant.",
  },
  GATEWAY_MEMBER_NOT_FOUND: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "The user is not a member of this tenant.",
  },
  GATEWAY_LAST_OWNER: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "A tenant must keep at least one owner.",
  },
  GATEWAY_LAST_PLATFORM_ADMIN: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "The last platform admin cannot be revoked.",
  },
  GATEWAY_PROMPT_ACCESS_DISABLED: {
    status: 403,
    openai: "permission_error",
    anthropic: "permission_error",
    message: "Staff prompt access is disabled on this deployment.",
  },
  GATEWAY_PROMPT_NOT_RETAINED: {
    status: 404,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "No request or response body is retained for this request.",
  },
  GATEWAY_PROMPT_EXPIRED: {
    status: 410,
    openai: "not_found_error",
    anthropic: "not_found_error",
    message: "The retained request and response bodies are past their retention and can no longer be viewed.",
  },
  // Body retention (#353): a request whose bodies could not be stored or read back.
  GATEWAY_RETENTION_FAILED: {
    status: 500,
    openai: "server_error",
    anthropic: "api_error",
    message: "The request or response body could not be retained.",
  },
  GATEWAY_CONFLICT: {
    status: 409,
    openai: "invalid_request_error",
    anthropic: "invalid_request_error",
    message: "A concurrent change won; read the current state and retry.",
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
