/**
 * Node failure projection shared by every adapter and node surface.
 *
 * A failed generation node carries the failure message in `error` and the
 * durable-run/task failure code (`contract_violation`, `deadline_exceeded`,
 * ...) in `errorCode`. Hosted nodes written before `error` became the single
 * message field may still hold `errorMessage`, and older local nodes
 * `failureCode`; both are read as fallbacks only.
 */

export const UNKNOWN_NODE_FAILURE_CODE = "unknown_failure";
export const NODE_FAILURE_WITHOUT_MESSAGE =
  "Generation failed without an error message";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The visible failure line for a node: `message [code]`, or just the message
 * when there is no code. A failure is never empty: without a message the line
 * says so, and without either it is tagged `[unknown_failure]`.
 */
export function formatNodeFailure(data: unknown): string {
  const record =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const message = text(record.error) ?? text(record.errorMessage);
  // `failureCode` is the local Host's retired spelling, still on older nodes.
  const code = text(record.errorCode) ?? text(record.failureCode);
  if (!message)
    return `${NODE_FAILURE_WITHOUT_MESSAGE} [${code ?? UNKNOWN_NODE_FAILURE_CODE}]`;
  return code ? `${message} [${code}]` : message;
}
