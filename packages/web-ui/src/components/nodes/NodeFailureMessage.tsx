import { formatNodeFailure } from "@clash/shared-types";

interface NodeFailureMessageProps {
  /** The failed node's data: `error` message and durable-run `errorCode`. */
  data: Record<string, unknown>;
  className?: string;
}

/** The failed node's message with its failure code, never empty. */
export function NodeFailureMessage({
  data,
  className = "nodrag nowheel max-h-32 overflow-auto break-words px-4 text-center text-xs text-red-700 select-text",
}: NodeFailureMessageProps) {
  return <p className={className}>{formatNodeFailure(data)}</p>;
}
