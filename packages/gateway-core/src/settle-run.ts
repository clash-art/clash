/**
 * The `gateway-settle` Durable Run (#399, delivery N2), shared by every host:
 * one run per follow-up money write (a text `charge`, a failed media
 * `refund`), on the host's existing Durable Run journal and scheduler. A host
 * only names its owner (`<host>:gateway-settle`, like `<host>:generation`)
 * and wires its journal adapter and scheduler around these pieces:
 *
 *   createCloudDurableRunCoordinator({
 *     ownerId: "<host>:gateway-settle", journal, clock,
 *     ...gatewaySettleRunExecutor({ budgets, logger }),
 *   })
 *
 * - identity and creation (gatewaySettleRunCommand): one run per request id
 *   and kind, the frozen intent as executor input, a deadline derived from
 *   the intent, so a second dispatch of the same intent is the same run.
 * - provider `submit` parses the journaled intent with the one intent schema
 *   and applies it (applyGatewaySettlement), idempotent through the ledger's
 *   unique (request id, budget, kind): a duplicate step or recovery moves no
 *   money. `poll` never happens. Stage and publish are no-ops (a null
 *   projection): a settle run touches no Project state.
 * - retries: a raw (storage) failure retries with capped backoff until the
 *   run's deadline; a coded GatewayError is a deterministic refusal and fails
 *   the run at once, logged as `gateway.settle_run_failed`.
 *
 * Types are structural over the Durable Run engine's ports
 * (shared-runtime durable-run-engine.ts), so this module carries no runtime
 * dependency on a host or on shared-runtime.
 */
import type {
  ExecutablePluginJsonValue,
  ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";

import { isGatewayError } from "./errors.js";
import type { GatewayLogger, GatewayPorts } from "./ports.js";
import {
  applyGatewaySettlement,
  gatewaySettlementRunKey,
  parseGatewaySettlementIntent,
  settlementOccurredAt,
  type GatewaySettlementIntent,
} from "./settlement.js";

export const GATEWAY_SETTLE_RUN_DEFAULTS = {
  /** A settle run retries until this long after its request ended, then fails (logged). */
  lifetimeMs: 7 * 24 * 60 * 60 * 1000,
  /** One ledger transaction; an attempt a crash left open is retried after this. */
  attemptTimeoutMs: 60 * 1000,
  baseDelayMs: 2 * 1000,
  maxDelayMs: 5 * 60 * 1000,
} as const;

type SettleRunFailure = Extract<ExecutablePluginResult, { status: "failed" }>["error"];
type SettleRunOperation = "submit" | "poll" | "stage" | "publish";

/** The fields of a Durable Run record a settle run reads. */
interface SettleRunRecord {
  actionRunId: string;
  outputSlot: string;
  executorInput: ExecutablePluginJsonValue;
  failure?: SettleRunFailure;
}

/** The one run of an intent: a request owes at most one charge and at most one refund. */
export function gatewaySettleRunIdentity(intent: GatewaySettlementIntent): {
  actionRunId: string;
  outputSlot: string;
} {
  const { requestId, kind } = gatewaySettlementRunKey(intent);
  return { actionRunId: `gateway-settle:${requestId}`, outputSlot: kind };
}

/** The journal creation command of an intent (createCloudDurableRun's `command`). */
export function gatewaySettleRunCommand(intent: GatewaySettlementIntent): {
  actionRunId: string;
  outputSlot: string;
  deadlineAt: number;
  executorInput: ExecutablePluginJsonValue;
} {
  const parsed = parseGatewaySettlementIntent(intent);
  return {
    ...gatewaySettleRunIdentity(parsed),
    // Derived from the frozen intent, so a re-dispatch is the same run.
    deadlineAt: settlementOccurredAt(parsed) + GATEWAY_SETTLE_RUN_DEFAULTS.lifetimeMs,
    executorInput: parsed as unknown as ExecutablePluginJsonValue,
  };
}

/** Capped exponential backoff; never exhausted by count, the run's deadline bounds it. */
export function gatewaySettleRetryDelayMs(consecutiveFailures: number): number {
  const { baseDelayMs, maxDelayMs } = GATEWAY_SETTLE_RUN_DEFAULTS;
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(Math.max(consecutiveFailures, 1) - 1, 20));
}

/**
 * A coded error is the ledger's decision (an unreadable intent, a refund of
 * nothing): retrying cannot change it. Anything else is storage and retries.
 */
export function classifyGatewaySettleError(error: unknown, operation: SettleRunOperation): SettleRunFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (isGatewayError(error))
    return { code: "invalid_request", message, retryable: false, requestState: "rejected", providerCode: error.code };
  return {
    code: operation === "submit" ? "transport_error" : "publication_failed",
    message,
    retryable: true,
    requestState: operation === "submit" ? "unknown" : "accepted",
  };
}

/** The provider, projection and policy options of a settle run coordinator. */
export function gatewaySettleRunExecutor(input: {
  budgets: Pick<GatewayPorts["budgets"], "charge" | "refund">;
  logger: GatewayLogger;
}) {
  const { attemptTimeoutMs } = GATEWAY_SETTLE_RUN_DEFAULTS;
  const { budgets, logger } = input;
  return {
    provider: {
      async submit({ run }: { run: SettleRunRecord }) {
        const result = await applyGatewaySettlement({ budgets }, parseGatewaySettlementIntent(run.executorInput));
        if (result.duplicate)
          logger.info("gateway.settle_run_duplicate", { requestId: result.requestId, kind: result.kind });
        return { status: "completed" as const, outputs: [] };
      },
      async poll() {
        return {
          status: "failed" as const,
          error: {
            code: "contract_violation" as const,
            message: "A gateway settle run never polls.",
            retryable: false,
            requestState: "accepted" as const,
          },
        };
      },
    },
    outputStore: { stage: async () => null },
    publisher: {
      async publish() {},
      async publishFailure({ run }: { run: SettleRunRecord }) {
        logger.error("gateway.settle_run_failed", {
          actionRunId: run.actionRunId,
          kind: run.outputSlot,
          code: run.failure?.providerCode ?? run.failure?.code,
          retryable: run.failure?.retryable,
        });
      },
    },
    retryPolicy: {
      delayMs: ({ consecutiveFailures }: { consecutiveFailures: number }) =>
        gatewaySettleRetryDelayMs(consecutiveFailures),
    },
    attemptTimeoutMs: {
      submit: attemptTimeoutMs,
      poll: attemptTimeoutMs,
      stage: attemptTimeoutMs,
      publish: attemptTimeoutMs,
    },
    classifyThrownError: classifyGatewaySettleError,
  };
}
