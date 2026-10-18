import type {
  ExecutablePluginJsonValue,
  ExecutablePluginOutput,
  ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";

export type DurableProviderFailure = Extract<
  ExecutablePluginResult,
  { status: "failed" }
>["error"];

/** The only failure shape allowed to cross from the owner journal into Project state. */
export interface DurablePublicFailure {
  code: DurableProviderFailure["code"];
  message: string;
}

/**
 * Fixed Host sentences for codes whose generic text would hide the user's fix.
 * Never derived from the private message, which a plugin may have authored.
 */
const PUBLIC_FAILURE_MESSAGES: Partial<
  Record<DurableProviderFailure["code"], string>
> = {
  reference_unavailable:
    "A referenced Asset is missing, trashed or not yet uploaded. Restore or replace the reference before retrying.",
};

export function durablePublicFailure(
  failure: Pick<DurableProviderFailure, "code">,
): DurablePublicFailure {
  return {
    code: failure.code,
    message:
      PUBLIC_FAILURE_MESSAGES[failure.code] ??
      "Generation failed. See the owning Host for private diagnostics.",
  };
}

type AcceptedResult = Extract<ExecutablePluginResult, { status: "accepted" }>;
type CompletedResult = Extract<ExecutablePluginResult, { status: "completed" }>;

/** The protocol envelope has already been checked by the Plugin Host at this boundary. */
export type DurableProviderStep =
  | Pick<AcceptedResult, "status" | "pollState" | "retryAfterMs">
  | Pick<CompletedResult, "status" | "outputs">
  | { status: "failed"; error: DurableProviderFailure };

export type DurableRunPhase =
  "queued" | "submitting" | "polling" | "finalizing" | "succeeded" | "failed";

export type DurableRunOperation = "submit" | "poll" | "stage" | "publish";

export interface DurableRunOwner {
  realm: "local" | "cloud" | "client";
  id: string;
}

export interface DurableRunIdentity {
  actionRunId: string;
  outputSlot: string;
}

export interface DurableRunAttempt {
  operation: DurableRunOperation;
  number: number;
  startedAt: number;
  expiresAt: number;
}

export type DurableRunAttemptCounts = Record<DurableRunOperation, number>;
export type DurableRunFailureCounts = Record<DurableRunOperation, number>;

/**
 * Owner-private durable state. None of these fields belong in Project Loro.
 *
 * The record is intentionally JSON-shaped so SQLite and a future Workflow adapter can persist the
 * same graph without translating its semantics. `revision` is the journal CAS token; it is not a
 * Project revision and must never be synchronized.
 */
export interface DurableRunRecord {
  schemaVersion: 1;
  actionRunId: string;
  outputSlot: string;
  owner: DurableRunOwner;
  /** Frozen, owner-private route/account/input state interpreted only by the executor adapter. */
  executorInput: ExecutablePluginJsonValue;
  revision: number;
  phase: DurableRunPhase;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  nextAttemptAt?: number;
  attemptCounts: DurableRunAttemptCounts;
  failureCounts: DurableRunFailureCounts;
  activeAttempt?: DurableRunAttempt;
  pollState?: ExecutablePluginJsonValue;
  providerOutputs?: ExecutablePluginOutput[];
  stagedOutput?: ExecutablePluginJsonValue;
  /** Set after the nominal deadline until one conclusive Provider poll is received. */
  deadlineReconciliationPending?: boolean;
  /**
   * Persisted once when the one post-deadline reconciliation poll finds completed output.
   * Staging, publication, and all of their retries share this one recovery window; restart must
   * never derive a fresh deadline. Provider execution cannot resume in this mode.
   */
  recoveryFinalizationDeadlineAt?: number;
  failure?: DurableProviderFailure;
  /** Last failure while projecting a terminal run into Project state. */
  projectionFailure?: DurableProviderFailure;
  /** Consecutive failures of terminal-state projection, independent of output publication. */
  projectionFailureCount?: number;
  /** Terminal coarse state/output bindings have reached the Project replica. */
  projectedAt?: number;
  succeededAt?: number;
  failedAt?: number;
}

export interface DurableRunJournal {
  load(identity: DurableRunIdentity): Promise<DurableRunRecord | undefined>;
  compareAndSet(
    identity: DurableRunIdentity,
    expectedRevision: number,
    next: DurableRunRecord,
  ): Promise<boolean>;
}

export interface DurableProviderExecutor {
  submit(input: {
    run: DurableRunRecord;
    idempotencyKey: string;
  }): Promise<DurableProviderStep>;
  poll(input: {
    run: DurableRunRecord;
    pollState: ExecutablePluginJsonValue;
  }): Promise<DurableProviderStep>;
}

export interface DurableOutputStore {
  /** Must be idempotent for `idempotencyKey`. */
  stage(input: {
    run: DurableRunRecord;
    idempotencyKey: string;
    outputs: ExecutablePluginOutput[];
  }): Promise<ExecutablePluginJsonValue>;
}

export interface DurableProjectPublisher {
  /** Must publish one Project output and its succeeded state at most once for the key. */
  publish(input: {
    run: DurableRunRecord;
    idempotencyKey: string;
    stagedOutput: ExecutablePluginJsonValue;
  }): Promise<void>;
  /** Must be idempotent; private failure remains recoverable until this projection lands. */
  publishFailure(input: {
    run: DurableRunRecord;
    failure: DurablePublicFailure;
  }): Promise<void>;
}

export interface DurableOwnerGuard {
  assertOwner(run: DurableRunRecord): Promise<void>;
}

export interface DurableRetryPolicyInput {
  run: DurableRunRecord;
  operation: DurableRunOperation;
  failure: DurableProviderFailure;
  consecutiveFailures: number;
}

export interface DurableRetryPolicy {
  /** `null` exhausts the operation and makes the run terminal. */
  delayMs(input: DurableRetryPolicyInput): number | null;
}

export interface DurableRunClock {
  now(): number;
}

export interface DurableRunEngineOptions {
  journal: DurableRunJournal;
  provider: DurableProviderExecutor;
  outputStore: DurableOutputStore;
  publisher: DurableProjectPublisher;
  ownerGuard: DurableOwnerGuard;
  retryPolicy: DurableRetryPolicy;
  clock?: DurableRunClock;
  attemptTimeoutMs?: Partial<Record<DurableRunOperation, number>>;
  /** A bounded grace for the single post-deadline status probe, never a fresh run lifetime. */
  deadlineReconciliationTimeoutMs?: number;
  /** One shared window for idempotent stage + publish after a completed reconciliation poll. */
  recoveryFinalizationTimeoutMs?: number;
  classifyThrownError?: (
    error: unknown,
    operation: DurableRunOperation,
    run: DurableRunRecord,
  ) => DurableProviderFailure;
}

export type DurableRunAdvanceResult =
  | { kind: "progressed"; run: DurableRunRecord }
  | { kind: "waiting"; run: DurableRunRecord; wakeAt: number }
  | { kind: "contended" }
  | { kind: "terminal"; run: DurableRunRecord };

const DEFAULT_ATTEMPT_TIMEOUT_MS: Record<DurableRunOperation, number> = {
  submit: 30 * 60_000,
  poll: 30 * 60_000,
  stage: 30 * 60_000,
  publish: 30 * 60_000,
};

const DEFAULT_DEADLINE_RECONCILIATION_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_RECOVERY_FINALIZATION_TIMEOUT_MS = 30 * 60_000;

const EMPTY_COUNTS: DurableRunAttemptCounts = {
  submit: 0,
  poll: 0,
  stage: 0,
  publish: 0,
};

export function durableRunIdempotencyKey(
  run: Pick<DurableRunRecord, "actionRunId" | "outputSlot">,
): string {
  // The terminal segment is URI-encoded, so the final `:` is an unambiguous tuple boundary even
  // when either value contains a delimiter. Keeping actionRunId verbatim preserves the stable keys
  // of already-journaled runs whose conventional output slots (`media`, `text`, ...) need no
  // escaping, while encodeURIComponent also escapes `%` and therefore keeps the map injective.
  return `${run.actionRunId}:${encodeURIComponent(run.outputSlot)}`;
}

export function createDurableRunRecord(input: {
  actionRunId: string;
  outputSlot: string;
  owner: DurableRunOwner;
  executorInput: ExecutablePluginJsonValue;
  createdAt: number;
  deadlineAt: number;
}): DurableRunRecord {
  if (input.deadlineAt <= input.createdAt) {
    throw new Error(
      "A durable run deadline must be later than its creation time.",
    );
  }
  return {
    schemaVersion: 1,
    actionRunId: input.actionRunId,
    outputSlot: input.outputSlot,
    owner: input.owner,
    executorInput: input.executorInput,
    revision: 0,
    phase: "queued",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    deadlineAt: input.deadlineAt,
    attemptCounts: { ...EMPTY_COUNTS },
    failureCounts: { ...EMPTY_COUNTS },
  };
}

function defaultThrownFailure(
  error: unknown,
  operation: DurableRunOperation,
): DurableProviderFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    operation === "stage"
      ? "output_persistence_failed"
      : operation === "publish"
        ? "publication_failed"
        : "plugin_unavailable";
  return {
    code,
    message,
    retryable: true,
    requestState: operation === "submit" ? "unknown" : "accepted",
  };
}

function attemptTimeoutFailure(
  attempt: DurableRunAttempt,
): DurableProviderFailure {
  return {
    code: "transport_timeout",
    message: `Durable ${attempt.operation} attempt ${attempt.number} expired before it checkpointed a result.`,
    retryable: true,
    requestState: attempt.operation === "submit" ? "unknown" : "accepted",
  };
}

function deadlineFailure(
  requestState: DurableProviderFailure["requestState"],
): DurableProviderFailure {
  return {
    code: "deadline_exceeded",
    message:
      "The generation lifetime expired before the durable run reached a terminal state.",
    retryable: false,
    requestState,
  };
}

function recoveryFinalizationFailure(
  operation: "stage" | "publish",
): DurableProviderFailure {
  return {
    code:
      operation === "stage"
        ? "output_persistence_failed"
        : "publication_failed",
    message:
      operation === "stage"
        ? "The recovery finalization window expired before output staging completed."
        : "The recovery finalization window expired before Project publication completed.",
    retryable: false,
    requestState: "accepted",
  };
}

function phaseForOperation(operation: DurableRunOperation): DurableRunPhase {
  if (operation === "submit") return "submitting";
  if (operation === "poll") return "polling";
  return "finalizing";
}

export class DurableRunEngine {
  readonly #clock: DurableRunClock;
  readonly #attemptTimeoutMs: Record<DurableRunOperation, number>;
  readonly #deadlineReconciliationTimeoutMs: number;
  readonly #recoveryFinalizationTimeoutMs: number;
  readonly #classifyThrownError: NonNullable<
    DurableRunEngineOptions["classifyThrownError"]
  >;

  constructor(private readonly options: DurableRunEngineOptions) {
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#attemptTimeoutMs = {
      ...DEFAULT_ATTEMPT_TIMEOUT_MS,
      ...options.attemptTimeoutMs,
    };
    this.#deadlineReconciliationTimeoutMs =
      options.deadlineReconciliationTimeoutMs ??
      DEFAULT_DEADLINE_RECONCILIATION_TIMEOUT_MS;
    this.#recoveryFinalizationTimeoutMs =
      options.recoveryFinalizationTimeoutMs ??
      DEFAULT_RECOVERY_FINALIZATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#deadlineReconciliationTimeoutMs) ||
      this.#deadlineReconciliationTimeoutMs <= 0
    ) {
      throw new TypeError(
        "A deadline reconciliation timeout must be a positive safe integer.",
      );
    }
    if (
      !Number.isSafeInteger(this.#recoveryFinalizationTimeoutMs) ||
      this.#recoveryFinalizationTimeoutMs <= 0
    ) {
      throw new TypeError(
        "A recovery finalization timeout must be a positive safe integer.",
      );
    }
    this.#classifyThrownError =
      options.classifyThrownError ??
      ((error, operation) => defaultThrownFailure(error, operation));
  }

  /**
   * Advances at most one durable edge. A Provider call, stage, or publish is always bracketed by
   * CAS checkpoints, and no call to this method performs more than one external side effect.
   */
  async advance(
    identity: DurableRunIdentity,
  ): Promise<DurableRunAdvanceResult> {
    const run = await this.options.journal.load(identity);
    if (!run) {
      throw new Error(
        `Durable run ${identity.actionRunId}/${identity.outputSlot} does not exist.`,
      );
    }
    await this.options.ownerGuard.assertOwner(run);

    if (run.phase === "failed") {
      if (run.projectedAt !== undefined) {
        return { kind: "terminal", run };
      }
      const now = this.#clock.now();
      if (run.activeAttempt) {
        if (run.activeAttempt.operation !== "publish") {
          throw new Error(
            `Failed durable run ${run.actionRunId}/${run.outputSlot} has an invalid ${run.activeAttempt.operation} attempt.`,
          );
        }
        if (run.activeAttempt.expiresAt > now) {
          return { kind: "waiting", run, wakeAt: run.activeAttempt.expiresAt };
        }
        return this.#settleProjectionFailure(
          run,
          attemptTimeoutFailure(run.activeAttempt),
          now,
        );
      }
      if (run.projectionFailure && run.nextAttemptAt === undefined) {
        return { kind: "terminal", run };
      }
      if (run.nextAttemptAt !== undefined && run.nextAttemptAt > now) {
        return { kind: "waiting", run, wakeAt: run.nextAttemptAt };
      }
      return this.#projectFailure(run, now);
    }
    if (run.phase === "succeeded") {
      return { kind: "terminal", run };
    }

    const now = this.#clock.now();
    if (run.activeAttempt) {
      if (run.activeAttempt.expiresAt > now) {
        return { kind: "waiting", run, wakeAt: run.activeAttempt.expiresAt };
      }
      if (
        run.activeAttempt.operation === "poll" &&
        run.deadlineReconciliationPending
      ) {
        return this.#fail(run, attemptTimeoutFailure(run.activeAttempt), now);
      }
      if (
        (run.activeAttempt.operation === "stage" ||
          run.activeAttempt.operation === "publish") &&
        run.recoveryFinalizationDeadlineAt !== undefined &&
        now >= run.recoveryFinalizationDeadlineAt
      ) {
        return this.#fail(
          run,
          recoveryFinalizationFailure(run.activeAttempt.operation),
          now,
        );
      }
      if (
        (run.activeAttempt.operation === "stage" ||
          run.activeAttempt.operation === "publish") &&
        run.recoveryFinalizationDeadlineAt === undefined &&
        now >= run.deadlineAt
      ) {
        return this.#fail(run, deadlineFailure("accepted"), now);
      }
      if (run.activeAttempt.operation === "submit" && now >= run.deadlineAt) {
        return this.#fail(run, deadlineFailure("unknown"), now);
      }
      return this.#settleFailure(
        run,
        run.activeAttempt.operation,
        attemptTimeoutFailure(run.activeAttempt),
        now,
      );
    }

    if (run.phase === "queued") {
      return this.#checkpoint(run, { phase: "submitting" }, now);
    }

    if (run.phase === "submitting" && now >= run.deadlineAt) {
      return this.#fail(run, deadlineFailure("rejected"), now);
    }

    if (
      run.phase === "polling" &&
      now >= run.deadlineAt &&
      !run.deadlineReconciliationPending
    ) {
      return this.#checkpoint(
        run,
        {
          deadlineReconciliationPending: true,
          nextAttemptAt: now,
        },
        now,
      );
    }

    if (run.phase === "finalizing") {
      if (
        run.recoveryFinalizationDeadlineAt !== undefined &&
        now >= run.recoveryFinalizationDeadlineAt
      ) {
        return this.#fail(
          run,
          recoveryFinalizationFailure(
            run.stagedOutput === undefined ? "stage" : "publish",
          ),
          now,
        );
      }
      if (
        run.recoveryFinalizationDeadlineAt === undefined &&
        now >= run.deadlineAt
      ) {
        return this.#fail(run, deadlineFailure("accepted"), now);
      }
    }

    if (run.nextAttemptAt !== undefined && run.nextAttemptAt > now) {
      return { kind: "waiting", run, wakeAt: run.nextAttemptAt };
    }

    if (run.phase === "submitting")
      return this.#invokeProvider(run, "submit", now);
    if (run.phase === "polling") return this.#invokeProvider(run, "poll", now);
    return this.#advanceFinalization(run, now);
  }

  async #invokeProvider(
    run: DurableRunRecord,
    operation: "submit" | "poll",
    now: number,
  ): Promise<DurableRunAdvanceResult> {
    if (operation === "poll" && run.pollState === undefined) {
      return this.#fail(
        run,
        {
          code: "contract_violation",
          message: "A polling durable run has no Provider poll state.",
          retryable: false,
          requestState: "accepted",
        },
        now,
      );
    }
    const claimed = await this.#claimAttempt(run, operation, now);
    if (!claimed) return { kind: "contended" };
    let step: DurableProviderStep;
    try {
      step =
        operation === "submit"
          ? await this.options.provider.submit({
              run: claimed,
              idempotencyKey: durableRunIdempotencyKey(claimed),
            })
          : await this.options.provider.poll({
              run: claimed,
              pollState: claimed.pollState as ExecutablePluginJsonValue,
            });
    } catch (error) {
      const classified = this.#classifyThrownError(error, operation, claimed);
      const failure = this.#providerFailureForOperation(operation, classified);
      if (operation === "poll" && claimed.deadlineReconciliationPending) {
        return this.#fail(claimed, failure, this.#clock.now());
      }
      return this.#settleFailure(
        claimed,
        operation,
        failure,
        this.#clock.now(),
      );
    }
    return this.#settleProviderStep(
      claimed,
      operation,
      step,
      this.#clock.now(),
    );
  }

  async #settleProviderStep(
    run: DurableRunRecord,
    operation: "submit" | "poll",
    step: DurableProviderStep,
    now: number,
  ): Promise<DurableRunAdvanceResult> {
    if (step.status === "failed") {
      const failure = this.#providerFailureForOperation(operation, step.error);
      if (operation === "poll" && run.deadlineReconciliationPending) {
        return this.#fail(run, failure, now);
      }
      return this.#settleFailure(run, operation, failure, now);
    }
    if (step.status === "completed") {
      const recoveredAfterDeadline =
        operation === "poll" &&
        (run.deadlineReconciliationPending || now >= run.deadlineAt);
      return this.#checkpoint(
        run,
        {
          phase: "finalizing",
          activeAttempt: undefined,
          providerOutputs: step.outputs,
          nextAttemptAt: undefined,
          failure: undefined,
          deadlineReconciliationPending: undefined,
          ...(recoveredAfterDeadline
            ? {
                recoveryFinalizationDeadlineAt:
                  now + this.#recoveryFinalizationTimeoutMs,
              }
            : {}),
          failureCounts: { ...run.failureCounts, [operation]: 0 },
        },
        now,
      );
    }
    if (operation === "poll" && run.deadlineReconciliationPending) {
      return this.#fail(run, deadlineFailure("accepted"), now);
    }
    return this.#checkpoint(
      run,
      {
        phase: "polling",
        activeAttempt: undefined,
        pollState: step.pollState,
        nextAttemptAt: now + (step.retryAfterMs ?? 5_000),
        failure: undefined,
        failureCounts: { ...run.failureCounts, [operation]: 0 },
      },
      now,
    );
  }

  async #advanceFinalization(
    run: DurableRunRecord,
    now: number,
  ): Promise<DurableRunAdvanceResult> {
    if (!run.providerOutputs) {
      return this.#fail(
        run,
        {
          code: "contract_violation",
          message:
            "A finalizing durable run has no checkpointed Provider outputs.",
          retryable: false,
          requestState: "accepted",
        },
        now,
      );
    }
    if (run.stagedOutput === undefined) {
      return this.#invokeFinalizer(run, "stage", now);
    }
    return this.#invokeFinalizer(run, "publish", now);
  }

  async #invokeFinalizer(
    run: DurableRunRecord,
    operation: "stage" | "publish",
    now: number,
  ): Promise<DurableRunAdvanceResult> {
    const claimed = await this.#claimAttempt(run, operation, now);
    if (!claimed) return { kind: "contended" };
    const idempotencyKey = durableRunIdempotencyKey(claimed);
    try {
      if (operation === "stage") {
        const stagedOutput = await this.options.outputStore.stage({
          run: claimed,
          idempotencyKey,
          outputs: claimed.providerOutputs ?? [],
        });
        const completedAt = this.#clock.now();
        if (
          claimed.recoveryFinalizationDeadlineAt !== undefined &&
          completedAt >= claimed.recoveryFinalizationDeadlineAt
        ) {
          return this.#fail(
            claimed,
            recoveryFinalizationFailure("stage"),
            completedAt,
          );
        }
        if (
          claimed.recoveryFinalizationDeadlineAt === undefined &&
          completedAt >= claimed.deadlineAt
        ) {
          return this.#fail(claimed, deadlineFailure("accepted"), completedAt);
        }
        return this.#checkpoint(
          claimed,
          {
            activeAttempt: undefined,
            stagedOutput,
            failure: undefined,
            failureCounts: { ...claimed.failureCounts, stage: 0 },
          },
          completedAt,
        );
      }
      await this.options.publisher.publish({
        run: claimed,
        idempotencyKey,
        stagedOutput: claimed.stagedOutput as ExecutablePluginJsonValue,
      });
      const completedAt = this.#clock.now();
      return this.#checkpoint(
        claimed,
        {
          phase: "succeeded",
          activeAttempt: undefined,
          succeededAt: completedAt,
          projectedAt: completedAt,
          failure: undefined,
          failureCounts: { ...claimed.failureCounts, publish: 0 },
        },
        completedAt,
      );
    } catch (error) {
      const failedAt = this.#clock.now();
      if (
        claimed.recoveryFinalizationDeadlineAt !== undefined &&
        failedAt >= claimed.recoveryFinalizationDeadlineAt
      ) {
        return this.#fail(
          claimed,
          recoveryFinalizationFailure(operation),
          failedAt,
        );
      }
      if (
        claimed.recoveryFinalizationDeadlineAt === undefined &&
        failedAt >= claimed.deadlineAt
      ) {
        return this.#fail(claimed, deadlineFailure("accepted"), failedAt);
      }
      return this.#settleFailure(
        claimed,
        operation,
        this.#classifyThrownError(error, operation, claimed),
        failedAt,
      );
    }
  }

  async #claimAttempt(
    run: DurableRunRecord,
    operation: DurableRunOperation,
    now: number,
  ): Promise<DurableRunRecord | undefined> {
    const number = run.attemptCounts[operation] + 1;
    const result = await this.#checkpointRecord(
      run,
      {
        activeAttempt: {
          operation,
          number,
          startedAt: now,
          expiresAt: this.#attemptExpiresAt(run, operation, now),
        },
        attemptCounts: { ...run.attemptCounts, [operation]: number },
        nextAttemptAt: undefined,
      },
      now,
    );
    return result ?? undefined;
  }

  #attemptExpiresAt(
    run: DurableRunRecord,
    operation: DurableRunOperation,
    now: number,
  ): number {
    const attemptDeadline = now + this.#attemptTimeoutMs[operation];
    if (operation === "poll" && run.deadlineReconciliationPending) {
      return (
        now +
        Math.min(
          this.#attemptTimeoutMs.poll,
          this.#deadlineReconciliationTimeoutMs,
        )
      );
    }
    if (run.recoveryFinalizationDeadlineAt !== undefined) {
      return Math.min(attemptDeadline, run.recoveryFinalizationDeadlineAt);
    }
    return Math.min(attemptDeadline, run.deadlineAt);
  }

  #providerFailureForOperation(
    operation: "submit" | "poll",
    failure: DurableProviderFailure,
  ): DurableProviderFailure {
    if (operation !== "poll" || failure.requestState === "accepted") {
      return failure;
    }
    return {
      code: "contract_violation",
      message:
        `A Provider poll failure must use requestState "accepted"; received ` +
        `"${failure.requestState}".`,
      retryable: false,
      requestState: "accepted",
      details: {
        reportedCode: failure.code,
        reportedRequestState: failure.requestState,
      },
    };
  }

  async #settleFailure(
    run: DurableRunRecord,
    operation: DurableRunOperation,
    failure: DurableProviderFailure,
    now: number,
  ): Promise<DurableRunAdvanceResult> {
    const consecutiveFailures = run.failureCounts[operation] + 1;
    const failureCounts = {
      ...run.failureCounts,
      [operation]: consecutiveFailures,
    };
    // An accepted submit has already crossed the billing boundary. Without a poll token there is
    // no safe way to turn that same task into another submission, even when its failure category
    // is transient. An `unknown` submit is different: the product explicitly chooses availability
    // over strict at-most-once and may retry with the same stable idempotency identity.
    const mayRetry =
      failure.retryable &&
      !(operation === "submit" && failure.requestState === "accepted");
    const delay = mayRetry
      ? this.options.retryPolicy.delayMs({
          run,
          operation,
          failure,
          consecutiveFailures,
        })
      : null;
    if (delay === null) return this.#fail(run, failure, now, failureCounts);
    return this.#checkpoint(
      run,
      {
        phase: phaseForOperation(operation),
        activeAttempt: undefined,
        failure,
        failureCounts,
        nextAttemptAt: now + Math.max(0, delay),
      },
      now,
    );
  }

  async #fail(
    run: DurableRunRecord,
    failure: DurableProviderFailure,
    now: number,
    failureCounts: DurableRunFailureCounts = run.failureCounts,
  ): Promise<DurableRunAdvanceResult> {
    const result = await this.#checkpointRecord(
      run,
      {
        phase: "failed",
        activeAttempt: undefined,
        nextAttemptAt: undefined,
        deadlineReconciliationPending: undefined,
        failure,
        failureCounts,
        failedAt: now,
      },
      now,
    );
    return result ? { kind: "progressed", run: result } : { kind: "contended" };
  }

  async #projectFailure(
    run: DurableRunRecord,
    now: number,
  ): Promise<DurableRunAdvanceResult> {
    const claimed = await this.#claimAttempt(run, "publish", now);
    if (!claimed) return { kind: "contended" };
    const failure = claimed.failure;
    if (!failure) {
      throw new Error(
        `Failed durable run ${claimed.actionRunId}/${claimed.outputSlot} has no failure payload.`,
      );
    }
    try {
      await this.options.publisher.publishFailure({
        run: claimed,
        failure: durablePublicFailure(failure),
      });
    } catch (error) {
      const projectionFailure = this.#classifyThrownError(
        error,
        "publish",
        claimed,
      );
      return this.#settleProjectionFailure(
        claimed,
        projectionFailure,
        this.#clock.now(),
      );
    }
    const projected = await this.#checkpointRecord(
      claimed,
      {
        activeAttempt: undefined,
        projectedAt: this.#clock.now(),
        projectionFailure: undefined,
        projectionFailureCount: 0,
        nextAttemptAt: undefined,
        failureCounts: { ...claimed.failureCounts, publish: 0 },
      },
      this.#clock.now(),
    );
    return projected
      ? { kind: "terminal", run: projected }
      : { kind: "contended" };
  }

  async #settleProjectionFailure(
    run: DurableRunRecord,
    projectionFailure: DurableProviderFailure,
    now: number,
  ): Promise<DurableRunAdvanceResult> {
    const consecutiveFailures = (run.projectionFailureCount ?? 0) + 1;
    const delay = projectionFailure.retryable
      ? this.options.retryPolicy.delayMs({
          run,
          operation: "publish",
          failure: projectionFailure,
          consecutiveFailures,
        })
      : null;
    const checkpointed = await this.#checkpointRecord(
      run,
      {
        activeAttempt: undefined,
        projectionFailure,
        projectionFailureCount: consecutiveFailures,
        failureCounts: {
          ...run.failureCounts,
          publish: consecutiveFailures,
        },
        nextAttemptAt: delay === null ? undefined : now + Math.max(0, delay),
      },
      now,
    );
    if (!checkpointed) return { kind: "contended" };
    return delay === null
      ? { kind: "terminal", run: checkpointed }
      : { kind: "progressed", run: checkpointed };
  }

  async #checkpoint(
    run: DurableRunRecord,
    patch: Partial<DurableRunRecord>,
    now: number,
  ): Promise<DurableRunAdvanceResult> {
    const result = await this.#checkpointRecord(run, patch, now);
    return result ? { kind: "progressed", run: result } : { kind: "contended" };
  }

  async #checkpointRecord(
    run: DurableRunRecord,
    patch: Partial<DurableRunRecord>,
    now: number,
  ): Promise<DurableRunRecord | null> {
    const next: DurableRunRecord = {
      ...run,
      ...patch,
      revision: run.revision + 1,
      updatedAt: now,
    };
    const identity = {
      actionRunId: run.actionRunId,
      outputSlot: run.outputSlot,
    };
    const saved = await this.options.journal.compareAndSet(
      identity,
      run.revision,
      next,
    );
    return saved ? next : null;
  }
}

export function createBoundedRetryPolicy(input: {
  maxFailures: Partial<Record<DurableRunOperation, number>>;
  baseDelayMs: number;
  maxDelayMs: number;
}): DurableRetryPolicy {
  if (input.baseDelayMs < 0 || input.maxDelayMs < input.baseDelayMs) {
    throw new Error("Durable retry delays must be non-negative and ordered.");
  }
  return {
    delayMs({ operation, consecutiveFailures }) {
      const limit = input.maxFailures[operation] ?? 0;
      if (consecutiveFailures > limit) return null;
      return Math.min(
        input.maxDelayMs,
        input.baseDelayMs * 2 ** Math.max(0, consecutiveFailures - 1),
      );
    },
  };
}
