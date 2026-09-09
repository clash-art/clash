import {
  DurableRunEngine,
  createDurableRunRecord,
  type DurableOutputStore,
  type DurableProjectPublisher,
  type DurableProviderExecutor,
  type DurableProviderFailure,
  type DurableRetryPolicy,
  type DurableRunAdvanceResult,
  type DurableRunClock,
  type DurableRunIdentity,
  type DurableRunJournal,
  type DurableRunOperation,
  type DurableRunRecord,
} from "@clash/shared-runtime/durable-run-engine";
import type { ExecutablePluginJsonValue } from "@clash/shared-types";
import { ExecutablePluginJsonValueSchema } from "@clash/shared-types";

/**
 * The cloud adapter deliberately knows only the shared durable-run protocol.
 * D1, Workflow, R2 and ProjectRoom are supplied through ports by the edge
 * integration. This keeps Cloudflare-specific APIs out of the executable
 * state machine and makes the same chaos harness usable for Node containers.
 */
export interface CloudDurableRunJournal extends DurableRunJournal {
  create(run: DurableRunRecord): Promise<void>;
  listRecoverable(ownerId: string, now: number): Promise<DurableRunRecord[]>;
}

export interface CloudDurableRunCreateCommand {
  type?: "create";
  actionRunId: string;
  outputSlot: string;
  deadlineAt: number;
  /** Frozen provider/action input. Credentials and mutable Project state do not belong here. */
  executorInput: ExecutablePluginJsonValue;
}

export type CloudDurableRunCoordinatorCommand =
  | (CloudDurableRunCreateCommand & { type: "create" })
  | { type: "advance"; identity: DurableRunIdentity }
  | { type: "recoverable"; now?: number };

export type CloudDurableRunCoordinatorResult =
  | { kind: "created"; run: DurableRunRecord }
  | DurableRunAdvanceResult
  | { kind: "recoverable"; identities: DurableRunIdentity[] };

export interface CloudDurableRunCoordinator {
  coordinate(
    command: CloudDurableRunCoordinatorCommand,
  ): Promise<CloudDurableRunCoordinatorResult>;
}

export interface CloudDurableRunCoordinatorOptions {
  ownerId: string;
  journal: CloudDurableRunJournal;
  provider: DurableProviderExecutor;
  outputStore: DurableOutputStore;
  publisher: DurableProjectPublisher;
  retryPolicy: DurableRetryPolicy;
  clock?: DurableRunClock;
  attemptTimeoutMs?: Partial<Record<DurableRunOperation, number>>;
  deadlineReconciliationTimeoutMs?: number;
  recoveryFinalizationTimeoutMs?: number;
  classifyThrownError?: (
    error: unknown,
    operation: DurableRunOperation,
    run: DurableRunRecord,
  ) => DurableProviderFailure;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Cloud durable run ${field} must be a non-empty string.`);
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    )
      return false;
    return left.every((value, index) => sameJson(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        sameJson(leftRecord[key], rightRecord[key]),
    )
  );
}

function sameCreation(
  existing: DurableRunRecord,
  intended: DurableRunRecord,
): boolean {
  return (
    existing.actionRunId === intended.actionRunId &&
    existing.outputSlot === intended.outputSlot &&
    existing.owner.realm === intended.owner.realm &&
    existing.owner.id === intended.owner.id &&
    existing.deadlineAt === intended.deadlineAt &&
    sameJson(existing.executorInput, intended.executorInput)
  );
}

/**
 * Persist the frozen cloud run before asking Workflow to start. A repeated
 * enqueue returns the same record; a conflicting request is rejected rather
 * than silently replacing the input under an existing idempotency key.
 */
export async function createCloudDurableRun(options: {
  ownerId: string;
  journal: CloudDurableRunJournal;
  command: CloudDurableRunCreateCommand;
  clock?: DurableRunClock;
}): Promise<DurableRunRecord> {
  const ownerId = nonEmpty(options.ownerId, "owner id");
  const clock = options.clock ?? { now: () => Date.now() };
  const actionRunId = nonEmpty(options.command.actionRunId, "actionRunId");
  const outputSlot = nonEmpty(options.command.outputSlot, "outputSlot");
  const executorInput = ExecutablePluginJsonValueSchema.parse(
    options.command.executorInput,
  );
  const intended = createDurableRunRecord({
    actionRunId,
    outputSlot,
    owner: { realm: "cloud", id: ownerId },
    executorInput,
    createdAt: clock.now(),
    deadlineAt: options.command.deadlineAt,
  });
  const identity = { actionRunId, outputSlot };
  const existing = await options.journal.load(identity);
  if (existing) {
    if (!sameCreation(existing, intended)) {
      throw new Error(
        `Cloud durable run ${actionRunId}/${outputSlot} already exists with different frozen input.`,
      );
    }
    return existing;
  }
  try {
    await options.journal.create(intended);
    return intended;
  } catch (error) {
    // A second edge request can win the insert between load and create. Read
    // the winner and return it only when the frozen creation is identical.
    const raced = await options.journal.load(identity);
    if (raced && sameCreation(raced, intended)) return raced;
    throw error;
  }
}

export function createCloudDurableRunCoordinator(
  options: CloudDurableRunCoordinatorOptions,
): CloudDurableRunCoordinator {
  const ownerId = nonEmpty(options.ownerId, "owner id");
  const clock = options.clock ?? { now: () => Date.now() };
  const engine = new DurableRunEngine({
    journal: options.journal,
    provider: options.provider,
    outputStore: options.outputStore,
    publisher: options.publisher,
    ownerGuard: {
      async assertOwner(run) {
        if (run.owner.realm !== "cloud" || run.owner.id !== ownerId) {
          throw new Error(
            `Cloud durable run ${run.actionRunId}/${run.outputSlot} is owned by ` +
              `${run.owner.realm}/${run.owner.id}, not cloud/${ownerId}.`,
          );
        }
      },
    },
    retryPolicy: options.retryPolicy,
    clock,
    ...(options.attemptTimeoutMs
      ? { attemptTimeoutMs: options.attemptTimeoutMs }
      : {}),
    ...(options.deadlineReconciliationTimeoutMs === undefined
      ? {}
      : {
          deadlineReconciliationTimeoutMs:
            options.deadlineReconciliationTimeoutMs,
        }),
    ...(options.recoveryFinalizationTimeoutMs === undefined
      ? {}
      : {
          recoveryFinalizationTimeoutMs: options.recoveryFinalizationTimeoutMs,
        }),
    ...(options.classifyThrownError
      ? { classifyThrownError: options.classifyThrownError }
      : {}),
  });

  return {
    async coordinate(command) {
      if (command.type === "advance") {
        return engine.advance(command.identity);
      }
      if (command.type === "recoverable") {
        const records = await options.journal.listRecoverable(
          ownerId,
          command.now ?? clock.now(),
        );
        return {
          kind: "recoverable",
          identities: records.map(({ actionRunId, outputSlot }) => ({
            actionRunId,
            outputSlot,
          })),
        };
      }
      const run = await createCloudDurableRun({
        ownerId,
        journal: options.journal,
        command,
        clock,
      });
      return { kind: "created", run };
    },
  };
}
