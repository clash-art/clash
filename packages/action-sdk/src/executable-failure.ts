import type {
  ExecutablePluginFailureCode,
  ExecutablePluginFailureError,
  ExecutablePluginInvocation,
} from "@clash/shared-types/executable-plugin";
import { ExecutablePluginFailureErrorSchema } from "@clash/shared-types/executable-plugin";

// Installed module plugins and the Host each bundle their own SDK class.
// instanceof alone loses failure semantics across that package boundary.
const PROVIDER_FAILURE_BRAND = Symbol.for("clash.ProviderExecutionError.v1");

const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

const TRANSPORT_TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

type InvocationOperation = ExecutablePluginInvocation["operation"];

export interface ProviderHttpFailureInput {
  status: number;
  message: string;
  operation: InvocationOperation;
  /** Stable Provider spelling, HTTP status text, or envelope code retained for diagnostics. */
  providerCode?: string;
  /** Override only when the Provider documents a more precise Clash category. */
  code?: ExecutablePluginFailureCode;
}

/** A failure whose request-boundary facts the executor can prove before throwing. */
export class ProviderExecutionError extends Error {
  override name = "ProviderExecutionError";
  readonly [PROVIDER_FAILURE_BRAND] = true;

  constructor(readonly failure: ExecutablePluginFailureError) {
    super(failure.message);
  }
}

/**
 * Converts an HTTP response into the shared Provider failure contract.
 *
 * A response is not a thrown transport error: 4xx responses prove that a submit was rejected,
 * while a 5xx/timeout response may have arrived after the Provider accepted the work. Polls always
 * refer to already-accepted work. Keeping that distinction here prevents every plugin from making
 * a different retry decision for the same boundary.
 */
export function providerHttpFailure(
  input: ProviderHttpFailureInput,
): ExecutablePluginFailureError {
  const status = Number.isInteger(input.status) ? input.status : 0;
  const code: ExecutablePluginFailureCode = input.code
    ?? (status === 401
      ? "authentication_failed"
      : status === 403
        ? "permission_denied"
        : status === 402
          ? "quota_exhausted"
          : status === 404 && input.operation !== "submit"
            ? "task_not_found"
            : status === 408 || status === 504
              ? "transport_timeout"
              : status === 429
                ? "rate_limited"
                : status >= 500
                  ? "provider_unavailable"
                  : "invalid_request");
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  const requestState = input.operation === "submit"
    ? (status === 408 || status >= 500 ? "unknown" : "rejected")
    : "accepted";
  return {
    code,
    message: input.message,
    retryable,
    requestState,
    providerCode: input.providerCode ?? (status > 0 ? `HTTP_${status}` : "HTTP_UNKNOWN"),
  };
}

export function providerHttpError(
  input: ProviderHttpFailureInput,
): ProviderExecutionError {
  return new ProviderExecutionError(providerHttpFailure(input));
}

function transportCode(error: unknown): "transport_timeout" | "transport_error" | undefined {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current !== "object") break;
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
      name?: unknown;
    };
    const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
    if (TRANSPORT_TIMEOUT_CODES.has(code)) return "transport_timeout";
    if (TRANSPORT_CODES.has(code)) return "transport_error";
    if (candidate.name === "TimeoutError") {
      return "transport_timeout";
    }
    if (
      candidate instanceof TypeError
      && typeof candidate.message === "string"
      && /\b(fetch failed|failed to fetch|network request failed|socket hang up)\b/i.test(
        candidate.message,
      )
    ) {
      return "transport_error";
    }
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Classify an exception at the executable-plugin boundary without claiming facts the SDK cannot
 * know. Only well-known network signals become retryable; an arbitrary handler exception remains a
 * non-retryable execution failure. A poll or callback always belongs to work already accepted.
 */
export function executableFailureFromThrown(
  error: unknown,
  operation: InvocationOperation,
): ExecutablePluginFailureError {
  if (error instanceof ProviderExecutionError) return error.failure;
  if (error && typeof error === "object" &&
      Reflect.get(error, PROVIDER_FAILURE_BRAND) === true) {
    const parsed = ExecutablePluginFailureErrorSchema.safeParse(Reflect.get(error, "failure"));
    if (parsed.success) return parsed.data;
  }
  const transport = transportCode(error);
  return {
    code: transport ?? "execution_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: transport !== undefined,
    requestState: operation === "submit" ? "unknown" : "accepted",
  };
}

export function unsupportedAcceptedOperation(
  exportId: string,
  operation: "callback",
): ExecutablePluginFailureError {
  return {
    code: "contract_violation",
    message: `${exportId} does not implement the ${operation} operation.`,
    retryable: false,
    requestState: "accepted",
  };
}
