import { isDeepStrictEqual } from "node:util";
import { isModelGenerationOutputType, MODEL_TEXT_DOCUMENT_KIND, MODEL_TEXT_DOCUMENT_SCHEMA_VERSION, parseDocumentBody } from "@clash/shared-types";

import {
  DurableRunEngine,
  createDurableRunRecord,
  durableRunIdempotencyKey,
  type DurableOutputStore,
  type DurableProjectPublisher,
  type DurableProviderFailure,
  type DurableProviderStep,
  type DurableRetryPolicy,
  type DurableRunAdvanceResult,
  type DurableRunClock,
  type DurableRunIdentity,
  type DurableRunOperation,
  type DurableRunRecord,
} from "@clash/shared-runtime";
import {
  ExecutablePluginBindingSchema,
  GeneratorActionOutputContractSchema,
  ExecutablePluginJsonValueSchema,
  ExecutablePluginOutputSchema,
  ExecutablePluginReferenceSchema,
  ProviderAssetInputSchema,
  type ExecutablePluginBinding,
  type ExecutablePluginInvocation,
  type ExecutablePluginJsonValue,
  type ExecutablePluginReference,
  type ExecutablePluginResult,
  type GeneratorActionOutputContract,
  type ProviderAssetInput,
} from "@clash/shared-types";

import type { SqliteDurableRunJournal } from "./durable-run-journal";
import type {
  ProviderPluginExecutor,
  ProviderPluginExecutorRequest,
  ProviderPluginExecutorResponse,
} from "./local-aigc";
import { ProviderPluginHostUnavailableError } from "./local-aigc";
import type {
  ExecutablePluginActionInvoker,
  ExecutablePluginActionRequest,
} from "./plugin-action-runtime";

type ProviderKind = ProviderPluginExecutorRequest["kind"];

/** Host-private execution route; the Generator's semantic executor remains unchanged. */
export interface FrozenGeneratorProviderExecution {
  binding: ExecutablePluginBinding;
  accountId?: string;
  assetInputs: ProviderAssetInput[];
  input: {
    values: Record<string, ExecutablePluginJsonValue>;
    references: ExecutablePluginReference[];
  };
}

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

export interface FrozenProjectAssetDelivery {
  kind: "project-asset";
  /** Product Action identity used by the output ActionAssetBinding. */
  actionId: string;
  /** Product-facing name to publish after the immutable Resource has been staged. */
  name: string;
  /** Frozen provenance, independent from any Canvas node. */
  prompt?: string;
}

export interface FrozenLocalProviderExecutorInput {
  schemaVersion: 1;
  /** Omitted by records created before custom Actions joined the shared durable graph. */
  targetKind?:
    "provider-executor" | "action" | "generator-action" | "local-executor";
  binding: ExecutablePluginBinding;
  /** Product Action definition identity; execution ownership remains the Canvas node/run. */
  actionId?: string;
  /** Exact public ActionRun output contract, frozen only for native Generator Actions. */
  generatorOutputContract?: GeneratorActionOutputContract;
  /** Model execution selected at admission, dispatched by the same native Run engine. */
  providerExecution?: FrozenGeneratorProviderExecution;
  /** User/agent attribution is frozen with a custom Action revision. */
  actor?: ExecutablePluginInvocation["actor"];
  /** Exact synchronized Action owner used by non-Canvas products such as Timeline render. */
  publicOwner?: {
    actionId: string;
    actionRevisionId: string;
  };
  /** Exact output slot the Action plugin must emit before durable publication remaps nothing. */
  pluginOutputSlot?: string;
  /** Frozen optimistic guard for projecting this immutable run onto a mutable Canvas node. */
  nodeProjectionRevisionId?: string;
  accountId?: string;
  kind: ProviderKind;
  projectId: string;
  nodeId?: string;
  /** Exact selected Provider binding delivery contract, frozen with the Action input. */
  assetInputs?: ProviderAssetInput[];
  delivery?: FrozenProjectAssetDelivery;
  provider?: string;
  modelEndpoint?: string;
  input: {
    values: Record<string, ExecutablePluginJsonValue>;
    references: ExecutablePluginReference[];
  };
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

class FrozenExecutorInputError extends Error {
  override name = "FrozenExecutorInputError";
}

const PROVIDER_KINDS = new Set<ProviderKind>([
  "image",
  "video",
  "audio",
  "text",
  "model",
]);

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FrozenExecutorInputError(
      `Frozen Provider executor ${field} must be a non-empty string.`,
    );
  }
  return value;
}

function parseFrozenExecutorInputUnchecked(
  input: unknown,
): FrozenLocalProviderExecutorInput {
  const json = ExecutablePluginJsonValueSchema.parse(input);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new FrozenExecutorInputError(
      "Frozen Provider executor input must be an object.",
    );
  }
  if (json.schemaVersion !== 1) {
    throw new FrozenExecutorInputError(
      "Frozen Provider executor schemaVersion must be 1.",
    );
  }
  const binding = ExecutablePluginBindingSchema.parse(json.binding);
  const targetKind = json.targetKind ?? "provider-executor";
  if (
    targetKind !== "provider-executor" &&
    targetKind !== "action" &&
    targetKind !== "generator-action" &&
    targetKind !== "local-executor"
  ) {
    throw new FrozenExecutorInputError(
      "Frozen executable targetKind is not recognized.",
    );
  }
  if (
    typeof json.kind !== "string" ||
    !PROVIDER_KINDS.has(json.kind as ProviderKind)
  ) {
    throw new FrozenExecutorInputError(
      "Frozen Provider executor kind is not recognized.",
    );
  }
  const executorInput = json.input;
  if (
    !executorInput ||
    typeof executorInput !== "object" ||
    Array.isArray(executorInput)
  ) {
    throw new FrozenExecutorInputError(
      "Frozen Provider executor input.input must be an object.",
    );
  }
  const values = executorInput.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new FrozenExecutorInputError(
      "Frozen Provider executor input.values must be an object.",
    );
  }
  if (!Array.isArray(executorInput.references)) {
    throw new FrozenExecutorInputError(
      "Frozen Provider executor input.references must be an array.",
    );
  }
  const accountId = json.accountId;
  const nodeId = json.nodeId;
  const actionId = json.actionId;
  const generatorOutputContract = json.generatorOutputContract;
  const actor = json.actor;
  const publicOwner = json.publicOwner;
  const pluginOutputSlot = json.pluginOutputSlot;
  const nodeProjectionRevisionId = json.nodeProjectionRevisionId;
  const assetInputs =
    json.assetInputs === undefined
      ? []
      : Array.isArray(json.assetInputs)
        ? json.assetInputs.map((input) => ProviderAssetInputSchema.parse(input))
        : (() => {
            throw new FrozenExecutorInputError(
              "Frozen Provider executor assetInputs must be an array.",
            );
          })();
  const delivery = json.delivery;
  const provider = json.provider;
  const modelEndpoint = json.modelEndpoint;
  let parsedDelivery: FrozenProjectAssetDelivery | undefined;
  if (delivery !== undefined) {
    if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
      throw new FrozenExecutorInputError(
        "Frozen Provider executor delivery must be an object.",
      );
    }
    if (delivery.kind !== "project-asset") {
      throw new FrozenExecutorInputError(
        "Frozen Provider executor delivery kind is not recognized.",
      );
    }
    // Prompt requirements belong to the Model Card. Delivery records preserve
    // provenance verbatim, including an empty prompt for reference-only models.
    if (delivery.prompt !== undefined && typeof delivery.prompt !== "string") {
      throw new FrozenExecutorInputError("Frozen Provider executor delivery.prompt must be a string.");
    }
    parsedDelivery = {
      kind: "project-asset",
      actionId: nonEmptyString(delivery.actionId, "delivery.actionId"),
      name: nonEmptyString(delivery.name, "delivery.name"),
      ...(delivery.prompt === undefined
        ? {}
        : { prompt: delivery.prompt }),
    };
  }
  // Native Generator delivery owns the Asset; a Canvas node is only an
  // optional guarded projection of that same output, not a second destination.
  if (nodeId !== undefined && parsedDelivery && targetKind !== "generator-action") {
    throw new FrozenExecutorInputError(
      "Frozen Provider executor cannot target both a Canvas node and a direct Project Asset delivery.",
    );
  }
  let parsedActor: ExecutablePluginInvocation["actor"] | undefined;
  if (actor !== undefined) {
    if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
      throw new FrozenExecutorInputError(
        "Frozen executable actor must be an object.",
      );
    }
    if (
      actor.kind !== "user" &&
      actor.kind !== "agent" &&
      actor.kind !== "system"
    ) {
      throw new FrozenExecutorInputError(
        "Frozen executable actor.kind is not recognized.",
      );
    }
    parsedActor = {
      kind: actor.kind,
      ...(actor.id === undefined
        ? {}
        : { id: nonEmptyString(actor.id, "actor.id") }),
    };
  }
  let parsedPublicOwner: FrozenLocalProviderExecutorInput["publicOwner"];
  if (publicOwner !== undefined) {
    if (
      !publicOwner ||
      typeof publicOwner !== "object" ||
      Array.isArray(publicOwner)
    ) {
      throw new FrozenExecutorInputError(
        "Frozen executable publicOwner must be an object.",
      );
    }
    parsedPublicOwner = {
      actionId: nonEmptyString(publicOwner.actionId, "publicOwner.actionId"),
      actionRevisionId: nonEmptyString(
        publicOwner.actionRevisionId,
        "publicOwner.actionRevisionId",
      ),
    };
  }
  if (
    targetKind === "action" ||
    targetKind === "generator-action" ||
    targetKind === "local-executor"
  ) {
    if (actionId === undefined) {
      throw new FrozenExecutorInputError(
        "Frozen Action executor actionId is missing.",
      );
    }
    if (!parsedActor) {
      throw new FrozenExecutorInputError(
        "Frozen Action executor actor is missing.",
      );
    }
    if (targetKind !== "generator-action" && !nodeId) {
      throw new FrozenExecutorInputError(
        "Frozen Action executor nodeId is missing.",
      );
    }
  }
  const parsedGeneratorOutputContract =
    generatorOutputContract === undefined
      ? undefined
      : GeneratorActionOutputContractSchema.parse(generatorOutputContract);
  if (
    (targetKind === "generator-action") !==
    (parsedGeneratorOutputContract !== undefined)
  ) {
    throw new FrozenExecutorInputError(
      "A native Generator Action requires exactly its frozen output contract.",
    );
  }
  const generatorOutput = parsedGeneratorOutputContract?.[0];
  const providerExecution =
    json.providerExecution === undefined
      ? undefined
      : parseGeneratorProviderExecution(json.providerExecution, json.projectId, json.kind);
  if (
    providerExecution &&
    (targetKind !== "generator-action" ||
      parsedGeneratorOutputContract?.some((port) => !isModelGenerationOutputType(port.assetType)))
  ) {
    throw new FrozenExecutorInputError(
      "A frozen Generator Provider route requires a native media or plain-text Document output contract.",
    );
  }
  if (
    generatorOutput?.assetType.kind === "media" &&
    generatorOutput.assetType.mediaKind !== json.kind
  ) {
    throw new FrozenExecutorInputError(
      "Frozen Generator Action kind does not match its media output contract.",
    );
  }
  if (generatorOutput?.assetType.kind === "document" && json.kind !== "text") {
    throw new FrozenExecutorInputError(
      "Frozen Generator document Actions must use the text durable staging path.",
    );
  }
  return {
    schemaVersion: 1,
    ...(targetKind === "provider-executor" ? {} : { targetKind }),
    binding,
    ...(providerExecution ? { providerExecution } : {}),
    ...(actionId === undefined
      ? {}
      : { actionId: nonEmptyString(actionId, "actionId") }),
    ...(parsedGeneratorOutputContract
      ? { generatorOutputContract: parsedGeneratorOutputContract }
      : {}),
    ...(parsedActor ? { actor: parsedActor } : {}),
    ...(parsedPublicOwner ? { publicOwner: parsedPublicOwner } : {}),
    ...(pluginOutputSlot === undefined
      ? {}
      : {
          pluginOutputSlot: nonEmptyString(
            pluginOutputSlot,
            "pluginOutputSlot",
          ),
        }),
    ...(nodeProjectionRevisionId === undefined
      ? {}
      : {
          nodeProjectionRevisionId: nonEmptyString(
            nodeProjectionRevisionId,
            "nodeProjectionRevisionId",
          ),
        }),
    ...(accountId === undefined
      ? {}
      : { accountId: nonEmptyString(accountId, "accountId") }),
    kind: json.kind as ProviderKind,
    projectId: nonEmptyString(json.projectId, "projectId"),
    ...(nodeId === undefined
      ? {}
      : { nodeId: nonEmptyString(nodeId, "nodeId") }),
    assetInputs,
    ...(parsedDelivery ? { delivery: parsedDelivery } : {}),
    ...(provider === undefined
      ? {}
      : { provider: nonEmptyString(provider, "provider") }),
    ...(modelEndpoint === undefined
      ? {}
      : { modelEndpoint: nonEmptyString(modelEndpoint, "modelEndpoint") }),
    input: {
      values: values as Record<string, ExecutablePluginJsonValue>,
      references: executorInput.references.map((reference) =>
        ExecutablePluginReferenceSchema.parse(reference),
      ),
    },
  };
}

function parseGeneratorProviderExecution(
  value: ExecutablePluginJsonValue,
  projectId: ExecutablePluginJsonValue | undefined,
  kind: ExecutablePluginJsonValue,
): FrozenGeneratorProviderExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FrozenExecutorInputError("Frozen Generator Provider execution must be an object.");
  }
  // Reuse the Provider boundary's leaf validators. Do not compose schemas from
  // different Zod installations: structural comparison expands recursive JSON types.
  // Pick only route fields, so nested providerExecution can never recurse here.
  const parsed = parseFrozenExecutorInputUnchecked({
    schemaVersion: 1,
    targetKind: "provider-executor",
    projectId,
    kind,
    binding: value.binding,
    ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
    ...(value.assetInputs === undefined ? {} : { assetInputs: value.assetInputs }),
    input: value.input,
  });
  return {
    binding: parsed.binding,
    ...(parsed.accountId ? { accountId: parsed.accountId } : {}),
    assetInputs: parsed.assetInputs ?? [],
    input: parsed.input,
  };
}

export function parseFrozenExecutorInput(
  input: unknown,
): FrozenLocalProviderExecutorInput {
  try {
    return parseFrozenExecutorInputUnchecked(input);
  } catch (error) {
    if (error instanceof FrozenExecutorInputError) throw error;
    throw new FrozenExecutorInputError(
      `Frozen Provider executor input is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function freezeExecutorInput(
  input: LocalDurableRunCreateCommand["executor"],
): FrozenLocalProviderExecutorInput {
  return parseFrozenExecutorInput({ schemaVersion: 1, ...input });
}

function assertSameBinding(
  frozen: ExecutablePluginBinding,
  response: ExecutablePluginBinding,
): void {
  if (
    frozen.pluginId !== response.pluginId ||
    frozen.exportId !== response.exportId ||
    frozen.version !== response.version ||
    frozen.schemaHash !== response.schemaHash
  ) {
    throw new FrozenExecutorInputError(
      `Provider executor binding drifted from ${frozen.pluginId}/${frozen.exportId} ` +
        `${frozen.version}/${frozen.schemaHash}.`,
    );
  }
}

function providerStep(
  run: DurableRunRecord,
  response: ProviderPluginExecutorResponse,
): DurableProviderStep {
  const frozen = parseFrozenExecutorInput(run.executorInput);
  assertSameBinding(
    frozen.providerExecution?.binding ?? frozen.binding,
    response.binding,
  );
  if (response.status === "failed") {
    return { status: "failed", error: response.error };
  }
  if (response.status === "accepted") {
    return {
      status: "accepted",
      pollState: ExecutablePluginJsonValueSchema.parse(response.pollState),
      ...(response.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: response.retryAfterMs }),
    };
  }
  const output =
    "output" in response
      ? {
          ...response.output,
          slot: run.outputSlot,
        }
      : {
          slot: run.outputSlot,
          kind: "asset" as const,
          asset: response.media,
        };
  if (frozen.targetKind === "generator-action") {
    const port = frozen.generatorOutputContract?.find((candidate) => candidate.slot === run.outputSlot);
    const normalized = frozen.kind === "text" && port?.assetType.kind === "document" &&
      port.assetType.documentKind === MODEL_TEXT_DOCUMENT_KIND &&
      port.assetType.schemaVersion === MODEL_TEXT_DOCUMENT_SCHEMA_VERSION &&
      output.kind === "value" && typeof output.value === "string"
      ? { slot: run.outputSlot, kind: "document" as const, document: {
          documentKind: MODEL_TEXT_DOCUMENT_KIND, schemaVersion: MODEL_TEXT_DOCUMENT_SCHEMA_VERSION, body: output.value,
        } }
      : output;
    return generatorActionStep(run, {
      protocol: "clash.plugin.result/v1",
      invocationId: durableRunIdempotencyKey(run),
      status: "completed",
      outputs: [ExecutablePluginOutputSchema.parse(normalized)],
    });
  }
  return {
    status: "completed",
    outputs: [ExecutablePluginOutputSchema.parse(output)],
  };
}

function customActionText(value: ExecutablePluginJsonValue): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
  }
  return JSON.stringify(value);
}

function customActionStep(
  run: DurableRunRecord,
  result: ExecutablePluginResult,
): DurableProviderStep {
  const frozen = parseFrozenExecutorInput(run.executorInput);
  if (result.status === "failed") {
    return { status: "failed", error: result.error };
  }
  if (result.status === "accepted") {
    return {
      status: "failed",
      error: {
        code: "contract_violation",
        message:
          `Action plugin ${frozen.binding.pluginId}/${frozen.binding.exportId} accepted work, ` +
          "but custom Actions do not declare a poll operation.",
        retryable: false,
        requestState: "accepted",
      },
    };
  }
  if (result.outputs.length !== 1) {
    return {
      status: "failed",
      error: {
        code: "contract_violation",
        message:
          `Action plugin ${frozen.binding.pluginId}/${frozen.binding.exportId} returned ` +
          `${result.outputs.length} outputs for one legacy Action output; expected exactly one.`,
        retryable: false,
        requestState: "accepted",
      },
    };
  }

  const output = result.outputs[0]!;
  const expectedSlots = pluginOutputSlotsForDurableRun(
    frozen,
    run.outputSlot,
  );
  if (!expectedSlots.includes(output.slot)) {
    return {
      status: "failed",
      error: {
        code: "contract_violation",
        message:
          `Action plugin ${frozen.binding.pluginId}/${frozen.binding.exportId} returned ` +
          `output slot ${output.slot}; expected ${expectedSlots.join(" or ")}.`,
        retryable: false,
        requestState: "accepted",
      },
    };
  }
  if (frozen.kind === "text") {
    if (output.kind !== "value") {
      return {
        status: "failed",
        error: {
          code: "contract_violation",
          message:
            `Action plugin ${frozen.binding.pluginId}/${frozen.binding.exportId} returned ` +
            `${output.kind} output for a text Action; expected value.`,
          retryable: false,
          requestState: "accepted",
        },
      };
    }
    return {
      status: "completed",
      outputs: [
        {
          slot: run.outputSlot,
          kind: "value",
          value:
            frozen.targetKind === "local-executor"
              ? output.value
              : customActionText(output.value),
        },
      ],
    };
  }
  if (output.kind !== "asset") {
    return {
      status: "failed",
      error: {
        code: "contract_violation",
        message:
          `Action plugin ${frozen.binding.pluginId}/${frozen.binding.exportId} returned ` +
          `${output.kind} output for a ${frozen.kind} Action; expected asset.`,
        retryable: false,
        requestState: "accepted",
      },
    };
  }
  if (output.asset.kind !== frozen.kind) {
    return {
      status: "failed",
      error: {
        code: "contract_violation",
        message:
          `Action plugin ${frozen.binding.pluginId}/${frozen.binding.exportId} returned ` +
          `${output.asset.kind} for a ${frozen.kind} Action.`,
        retryable: false,
        requestState: "accepted",
      },
    };
  }
  return {
    status: "completed",
    outputs: [{ ...output, slot: run.outputSlot }],
  };
}

/**
 * Plugin-side output ports accepted by one frozen durable run.
 *
 * v1 Action Cards declare one outputType but no output-port field. A media Action therefore owns
 * the typed port named by that outputType (`image`, `video`, or `audio`); `media` remains accepted
 * for Actions written against the original generic-port convention. Other executors freeze their
 * exact durable slot. The same rule validates both the returned envelope and its Host staging
 * receipt so normalization cannot make an otherwise valid receipt look foreign.
 */
export function pluginOutputSlotsForDurableRun(
  frozen: Pick<
    FrozenLocalProviderExecutorInput,
    "targetKind" | "pluginOutputSlot" | "kind"
  >,
  durableOutputSlot: string,
): string[] {
  if (frozen.targetKind !== "action") return [durableOutputSlot];
  if (frozen.pluginOutputSlot) return [frozen.pluginOutputSlot];
  if (frozen.kind === "text") return ["result"];
  return [frozen.kind, "media"];
}

function generatorActionStep(
  run: DurableRunRecord,
  result: ExecutablePluginResult,
): DurableProviderStep {
  const frozen = parseFrozenExecutorInput(run.executorInput);
  if (
    frozen.targetKind !== "generator-action" ||
    !frozen.generatorOutputContract
  ) {
    throw new FrozenExecutorInputError(
      "A Generator Action result requires a frozen output contract.",
    );
  }
  if (result.status === "failed") {
    return { status: "failed", error: result.error };
  }
  if (result.status === "accepted") {
    return {
      status: "accepted",
      pollState: ExecutablePluginJsonValueSchema.parse(result.pollState),
      ...(result.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: result.retryAfterMs }),
    };
  }
  const port = frozen.generatorOutputContract.find(
    (candidate) => candidate.slot === run.outputSlot,
  );
  const output = result.outputs[0];
  if (!port || result.outputs.length !== 1 || !output) {
    return {
      status: "failed",
      error: {
        code: "contract_violation",
        message:
          `Generator Action ${frozen.binding.pluginId}/${frozen.binding.exportId} returned ` +
          `${result.outputs.length} outputs; the frozen Run requires exactly one ${run.outputSlot} output.`,
        retryable: false,
        requestState: "accepted",
      },
    };
  }
  if (output.slot !== port.slot) {
    return {
      status: "failed",
      error: {
        code: "contract_violation",
        message:
          `Generator Action ${frozen.binding.pluginId}/${frozen.binding.exportId} returned ` +
          `output slot ${output.slot}; the frozen Run requires ${port.slot}.`,
        retryable: false,
        requestState: "accepted",
      },
    };
  }
  if (
    port.assetType.kind === "media" &&
    (output.kind !== "asset" || output.asset.kind !== port.assetType.mediaKind)
  ) {
    return {
      status: "failed",
      error: {
        code: "contract_violation",
        message:
          `Generator Action ${frozen.binding.pluginId}/${frozen.binding.exportId} returned ` +
          `the wrong output type for ${port.assetType.mediaKind} slot ${port.slot}.`,
        retryable: false,
        requestState: "accepted",
      },
    };
  }
  if (port.assetType.kind === "document") {
    if (
      output.kind !== "document" ||
      output.document.documentKind !== port.assetType.documentKind ||
      output.document.schemaVersion !== port.assetType.schemaVersion
    ) {
      return {
        status: "failed",
        error: {
          code: "contract_violation",
          message:
            `Generator Action ${frozen.binding.pluginId}/${frozen.binding.exportId} returned ` +
            `the wrong Document contract for ${port.assetType.documentKind}@${port.assetType.schemaVersion} slot ${port.slot}.`,
          retryable: false,
          requestState: "accepted",
        },
      };
    }
  }
  if (output.kind === "document") {
    try {
      parseDocumentBody(output.document.documentKind, output.document.schemaVersion, output.document.body);
    } catch (error) {
      return { status: "failed", error: {
        code: "contract_violation", message: error instanceof Error ? error.message : String(error),
        retryable: false, requestState: "accepted",
      } };
    }
  }
  return { status: "completed", outputs: [output] };
}

function remainingAttemptTimeoutMs(run: DurableRunRecord, now: number): number {
  const attempt = run.activeAttempt;
  if (!attempt) {
    throw new FrozenExecutorInputError(
      "An executable request requires a checkpointed active attempt.",
    );
  }
  const timeoutMs = Math.ceil(attempt.expiresAt - now);
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new FrozenExecutorInputError(
      "An executable request has an invalid remaining attempt budget.",
    );
  }
  if (timeoutMs <= 0) {
    throw new Error(
      "Plugin invocation attempt timed out before it could be dispatched.",
    );
  }
  return timeoutMs;
}

function providerRequest(
  run: DurableRunRecord,
  idempotencyKey: string,
  now: number,
  pollState?: ExecutablePluginJsonValue,
): ProviderPluginExecutorRequest {
  const frozen = parseFrozenExecutorInput(run.executorInput);
  const timeoutMs = remainingAttemptTimeoutMs(run, now);
  const execution = frozen.providerExecution ?? frozen;
  return {
    pluginId: execution.binding.pluginId,
    exportId: execution.binding.exportId,
    binding: execution.binding,
    ...(execution.accountId ? { accountId: execution.accountId } : {}),
    kind: frozen.kind,
    taskId: idempotencyKey,
    timeoutMs,
    projectId: frozen.projectId,
    ...(frozen.nodeId ? { nodeId: frozen.nodeId } : {}),
    assetInputs: execution.assetInputs ?? [],
    input: execution.input,
    ...(pollState === undefined ? {} : { pollState }),
  };
}

function customActionRequest(
  run: DurableRunRecord,
  now: number,
  operation: "submit" | "poll" = "submit",
  pollState?: ExecutablePluginJsonValue,
): ExecutablePluginActionRequest {
  const frozen = parseFrozenExecutorInput(run.executorInput);
  if (
    (frozen.targetKind !== "action" &&
      frozen.targetKind !== "generator-action" &&
      frozen.targetKind !== "local-executor") ||
    !frozen.actor
  ) {
    throw new FrozenExecutorInputError(
      "A custom Action request requires a frozen Action target and actor.",
    );
  }
  return {
    binding: frozen.binding,
    taskId: run.actionRunId,
    projectId: frozen.projectId,
    ...(frozen.nodeId ? { nodeId: frozen.nodeId } : {}),
    input: frozen.input,
    actor: frozen.actor,
    operation,
    ...(pollState === undefined ? {} : { pollState }),
    timeoutMs: remainingAttemptTimeoutMs(run, now),
  };
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
    provider: {
      async submit({ run, idempotencyKey }) {
        const frozen = parseFrozenExecutorInput(run.executorInput);
        if (frozen.targetKind === "local-executor") {
          if (!options.localExecutor) {
            throw new ProviderPluginHostUnavailableError(
              "Host-local durable executor is unavailable.",
            );
          }
          return customActionStep(
            run,
            await options.localExecutor(customActionRequest(run, clock.now())),
          );
        }
        if (frozen.targetKind === "action") {
          if (!options.executablePluginAction) {
            throw new ProviderPluginHostUnavailableError(
              "Executable plugin Action runtime is unavailable.",
            );
          }
          return customActionStep(
            run,
            await options.executablePluginAction(
              customActionRequest(run, clock.now()),
            ),
          );
        }
        if (frozen.targetKind === "generator-action" && !frozen.providerExecution) {
          if (!options.executablePluginAction) {
            throw new ProviderPluginHostUnavailableError(
              "Executable Generator Action runtime is unavailable.",
            );
          }
          return generatorActionStep(
            run,
            await options.executablePluginAction(
              customActionRequest(run, clock.now(), "submit"),
            ),
          );
        }
        const response = await options.providerPluginExecutor(
          providerRequest(run, idempotencyKey, clock.now()),
        );
        return providerStep(run, response);
      },
      async poll({ run, pollState }) {
        const frozen = parseFrozenExecutorInput(run.executorInput);
        if (frozen.targetKind === "generator-action" && !frozen.providerExecution) {
          if (!options.executablePluginAction) {
            throw new ProviderPluginHostUnavailableError(
              "Executable Generator Action runtime is unavailable.",
            );
          }
          return generatorActionStep(
            run,
            await options.executablePluginAction(
              customActionRequest(run, clock.now(), "poll", pollState),
            ),
          );
        }
        if (
          frozen.targetKind === "action" ||
          frozen.targetKind === "local-executor"
        ) {
          return {
            status: "failed",
            error: {
              code: "contract_violation",
              message: "Custom Actions do not support durable polling.",
              retryable: false,
              requestState: "accepted",
            },
          };
        }
        const idempotencyKey = durableRunIdempotencyKey(run);
        const response = await options.providerPluginExecutor(
          providerRequest(run, idempotencyKey, clock.now(), pollState),
        );
        return providerStep(run, response);
      },
    },
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
