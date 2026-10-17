import { isDeepStrictEqual } from "node:util";

import {
  DurableRunEngine,
  createDurableRunRecord,
  type DurableOutputStore,
  type DurableProjectPublisher,
  type DurableProviderFailure,
  type DurableRetryPolicy,
  type DurableRunAdvanceResult,
  type DurableRunClock,
  type DurableRunIdentity,
  type DurableRunOperation,
  type DurableRunRecord,
} from "@clash/shared-runtime";
import { ExecutablePluginJsonValueSchema } from "@clash/shared-types";

import type { SqliteDurableRunJournal } from "./durable-run-journal";
import type { ProviderPluginExecutor } from "./local-aigc.js";
import { ProviderPluginHostUnavailableError } from "./local-aigc.js";

import {
  createExecutableRunProvider,
  FrozenExecutorInputError,
  parseFrozenExecutableInput,
  type ExecutablePluginActionInvoker,
  type FrozenExecutableInput,
  type FrozenExecutableTargetKind,
  type FrozenGeneratorProviderExecution,
  type FrozenProjectAssetDelivery,
} from "@clash/shared-runtime/executable-run";

export type {
  FrozenExecutableTargetKind,
  FrozenGeneratorProviderExecution,
  FrozenProjectAssetDelivery,
};
export type FrozenLocalProviderExecutorInput = FrozenExecutableInput;
export type { ProviderPluginExecutorRequest } from "@clash/shared-runtime/executable-run";
export {
  executableProviderRequest,
  executableProviderStep,
  parseFrozenExecutableInput,
  pluginOutputSlotsForDurableRun,
} from "@clash/shared-runtime/executable-run";

/** One Host policy shared by every local Provider-backed product surface. */
export const DEFAULT_LOCAL_PROVIDER_RUN_DEADLINE_MS = 30 * 60_000;

/**
 * Durable ownership names the logical local service that owns one profile's journal, not the
 * ephemeral discovery process advertising its current port. Keeping this stable lets hot reload
 * and ordinary Desktop restarts resume work recorded in the same local data directory.
 */
export function localDurableRunOwnerId(
  _discoveryHostId?: string,
): "local-api" {
  return "local-api";
}

/** Backward-compatible name for the extracted shared parser. */
export const parseFrozenExecutorInput = parseFrozenExecutableInput;

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FrozenExecutorInputError(
      `Frozen Provider executor ${field} must be a non-empty string.`,
    );
  }
  return value;
}

function freezeExecutorInput(
  input: LocalDurableRunCreateCommand["executor"],
): FrozenExecutableInput {
  return parseFrozenExecutableInput({ schemaVersion: 1, ...input });
}

export interface LocalDurableRunCreateCommand {
  type: "create";
  actionRunId: string;
  outputSlot: string;
  deadlineAt: number;
  executor: Omit<FrozenLocalProviderExecutorInput, "schemaVersion">;
}

export type LocalDurableRunCoordinatorCommand =
  | LocalDurableRunCreateCommand
  | { type: "advance"; identity: DurableRunIdentity }
  | { type: "recoverable"; now?: number };

export type LocalDurableRunCoordinatorResult =
  | { kind: "created"; run: DurableRunRecord }
  | DurableRunAdvanceResult
  | { kind: "recoverable"; identities: DurableRunIdentity[] };

export interface LocalDurableRunCoordinator {
  /** The single scheduling entry used by local-processor, sync, and restart recovery. */
  coordinate(
    command: LocalDurableRunCoordinatorCommand,
  ): Promise<LocalDurableRunCoordinatorResult>;
}

export interface LocalDurableRunCoordinatorOptions {
  ownerId: string;
  journal: SqliteDurableRunJournal;
  providerPluginExecutor: ProviderPluginExecutor;
  executablePluginAction?: ExecutablePluginActionInvoker;
  /** Host-local work still enters the same Durable Run graph; this is its submit adapter. */
  localExecutor?: ExecutablePluginActionInvoker;
  outputStore: DurableOutputStore;
  publisher: DurableProjectPublisher;
  retryPolicy: DurableRetryPolicy;
  clock?: DurableRunClock;
  attemptTimeoutMs?: Partial<Record<DurableRunOperation, number>>;
  deadlineReconciliationTimeoutMs?: number;
  recoveryFinalizationTimeoutMs?: number;
}

function classifyThrownError(
  error: unknown,
  operation: DurableRunOperation,
  run: DurableRunRecord,
): DurableProviderFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof FrozenExecutorInputError) {
    return {
      code: "contract_violation",
      message,
      retryable: false,
      requestState: operation === "submit" ? "rejected" : "accepted",
    };
  }
  if (/(?:plugin invocation|plugin host IPC).*timed out/i.test(message)) {
    return {
      code: "transport_timeout",
      message,
      retryable: true,
      requestState: operation === "submit" ? "unknown" : "accepted",
    };
  }
  if (error instanceof ProviderPluginHostUnavailableError) {
    return {
      code: "plugin_unavailable",
      message,
      retryable: true,
      requestState: operation === "submit" ? "unknown" : "accepted",
    };
  }
  if (
    operation === "submit" &&
    parseFrozenExecutorInput(run.executorInput).targetKind === "local-executor"
  ) {
    return {
      code: "execution_failed",
      message,
      retryable: true,
      requestState: "unknown",
    };
  }
  if (operation === "submit" || operation === "poll") {
    return {
      code: "execution_failed",
      message,
      retryable: false,
      requestState: operation === "submit" ? "unknown" : "accepted",
    };
  }
  return {
    code:
      operation === "stage"
        ? "output_persistence_failed"
        : "publication_failed",
    message,
    retryable: true,
    requestState: "accepted",
  };
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
    isDeepStrictEqual(existing.executorInput, intended.executorInput)
  );
}

/**
 * Persist the frozen run before any Provider side effect.
 *
 * HTTP surfaces and Canvas processing both enter the same journal through this helper. It contains
 * no executor, staging, or publication dependency, so a command can durably enqueue work without
 * constructing a second Durable Run Engine or a second polling loop.
 */
export async function createLocalDurableRun(options: {
  ownerId: string;
  journal: SqliteDurableRunJournal;
  command: LocalDurableRunCreateCommand;
  clock?: DurableRunClock;
}): Promise<DurableRunRecord> {
  if (!options.ownerId.trim()) {
    throw new Error("A Local Durable Run creator requires an owner id.");
  }
  const clock = options.clock ?? { now: () => Date.now() };
  const actionRunId = nonEmptyString(
    options.command.actionRunId,
    "actionRunId",
  );
  const outputSlot = nonEmptyString(options.command.outputSlot, "outputSlot");
  const executorInput = freezeExecutorInput(options.command.executor);
  const intended = createDurableRunRecord({
    actionRunId,
    outputSlot,
    owner: { realm: "local", id: options.ownerId },
    executorInput: ExecutablePluginJsonValueSchema.parse(executorInput),
    createdAt: clock.now(),
    deadlineAt: options.command.deadlineAt,
  });
  const identity = { actionRunId, outputSlot };
  const existing = await options.journal.load(identity);
  if (existing) {
    if (!sameCreation(existing, intended)) {
      throw new Error(
        `Durable run ${actionRunId}/${outputSlot} already exists with different frozen input.`,
      );
    }
    return existing;
  }
  try {
    await options.journal.create(intended);
    return intended;
  } catch (error) {
    const raced = await options.journal.load(identity);
    if (raced && sameCreation(raced, intended)) return raced;
    throw error;
  }
}

export function createLocalDurableRunCoordinator(
  options: LocalDurableRunCoordinatorOptions,
): LocalDurableRunCoordinator {
  if (!options.ownerId.trim()) {
    throw new Error("A Local Durable Run coordinator requires an owner id.");
  }
  const clock = options.clock ?? { now: () => Date.now() };
  const engine = new DurableRunEngine({
    journal: options.journal,
    provider: createExecutableRunProvider({
      now: () => clock.now(),
      ...(options.executablePluginAction
        ? { action: options.executablePluginAction }
        : {}),
      ...(options.localExecutor ? { localExecutor: options.localExecutor } : {}),
      provider: options.providerPluginExecutor,
      unavailable: (message) => new ProviderPluginHostUnavailableError(message),
    }),
    outputStore: options.outputStore,
    publisher: options.publisher,
    ownerGuard: {
      async assertOwner(run) {
        if (run.owner.realm !== "local" || run.owner.id !== options.ownerId) {
          throw new Error(
            `Durable run ${run.actionRunId}/${run.outputSlot} is owned by ` +
              `${run.owner.realm}/${run.owner.id}, not local/${options.ownerId}.`,
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
    classifyThrownError,
  });

  return {
    async coordinate(command) {
      if (command.type === "advance") {
        return engine.advance(command.identity);
      }
      if (command.type === "recoverable") {
        const records = await options.journal.listRecoverable(
          options.ownerId,
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

      const run = await createLocalDurableRun({
        ownerId: options.ownerId,
        journal: options.journal,
        command,
        clock,
      });
      return { kind: "created", run };
    },
  };
}
