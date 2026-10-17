/**
 * Shared frozen executable-run records.
 *
 * The Local adapter (Node) and the Cloudflare adapter parse and map exactly
 * these values. A realm may choose where a plugin runs, but it must not
 * reinterpret the frozen input, the provider request, or the step output.
 * This module therefore has no platform imports and no environment/mode
 * checks: it depends only on shared types and the realm-neutral engine.
 */
import {
  isModelGenerationOutputType,
  MODEL_TEXT_DOCUMENT_KIND,
  MODEL_TEXT_DOCUMENT_SCHEMA_VERSION,
  parseDocumentBody,
} from "@clash/shared-types";
import {
  ExecutablePluginBindingSchema,
  GeneratorActionOutputContractSchema,
  ExecutablePluginJsonValueSchema,
  ExecutablePluginOutputSchema,
  ExecutablePluginReferenceSchema,
  ProviderAssetInputSchema,
  type AssetKind,
  type ExecutablePluginAssetHandle,
  type ExecutablePluginBinding,
  type ExecutablePluginInvocation,
  type ExecutablePluginJsonValue,
  type ExecutablePluginReference,
  type ExecutablePluginResult,
  type GeneratorActionOutputContract,
  type ModelKind,
  type ModelUpstreamRoute,
  type ProviderAssetInput,
} from "@clash/shared-types";
import {
  durableRunIdempotencyKey,
  type DurableProviderStep,
  type DurableRunRecord,
} from "./durable-run-engine.js";

export type FrozenExecutableTargetKind =
  | "provider-executor"
  | "action"
  | "generator-action"
  | "local-executor";

type ProviderKind = "image" | "video" | "audio" | "text" | "model";

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

export interface FrozenProjectAssetDelivery {
  kind: "project-asset";
  /** Product Action identity used by the output ActionAssetBinding. */
  actionId: string;
  /** Product-facing name to publish after the immutable Resource has been staged. */
  name: string;
  /** Frozen provenance, independent from any Canvas node. */
  prompt?: string;
}

export interface FrozenExecutableInput {
  schemaVersion: 1;
  /** Omitted by records created before custom Actions joined the shared durable graph. */
  targetKind?: FrozenExecutableTargetKind;
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

export class FrozenExecutorInputError extends Error {
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
): FrozenExecutableInput {
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
  let parsedPublicOwner: FrozenExecutableInput["publicOwner"];
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

export function parseFrozenExecutableInput(
  input: unknown,
): FrozenExecutableInput {
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

/** The provider boundary's response envelope, shared by both adapters. */
export type ProviderPluginFailure = Extract<
  ExecutablePluginResult,
  { status: "failed" }
>["error"];

/** Provider outputs include 3D Project Assets even though the generic AIGC card catalog does not. */
export type ProviderPluginExecutorKind = ModelKind | Extract<AssetKind, "model">;

export interface ProviderPluginExecutorRequest {
  pluginId: string;
  exportId: string;
  kind: ProviderPluginExecutorKind;
  taskId: string;
  projectId: string;
  nodeId?: string;
  binding?: ExecutablePluginBinding;
  /** Delivery declaration copied from the exact selected Provider route. */
  assetInputs?: ProviderAssetInput[];
  input: {
    values: Record<string, unknown>;
    references: ExecutablePluginReference[];
  };
  /**
   * Set when asking about work already accepted, carrying exactly what the plugin returned.
   *
   * Opaque on purpose: an id, a status URL, a job name with its region, or anything else a provider
   * needs. The host persists it and hands it back without reading it, so a provider that has no
   * task id is not forced to invent one.
   */
  pollState?: unknown;
  /** The account this work is charged to; credentials stay in its Host-scoped plugin store. */
  accountId?: string;
  /**
   * Host-owned remaining attempt budget. It is transport metadata for the plugin process and is
   * never exposed as a model value or reset by an individual submit/poll call.
   */
  timeoutMs?: number;
}

/** Media crosses the Provider boundary only as the Host-issued canonical Asset handle. */
export type ProviderPluginExecutorMedia = ExecutablePluginAssetHandle;

/** The protocol's canonical synchronous text envelope. */
export interface ProviderPluginExecutorTextOutput {
  slot: "text";
  kind: "value";
  value: string;
}

/**
 * The provider either finished, took the work and told us how to ask again, or reported failure.
 *
 * Typed as a union rather than as media-with-exceptions, because an acceptance thrown as an error
 * cannot be told apart from a failure by the code that catches it -- and the difference is that one
 * of them has already been paid for.
 */
export type ProviderPluginExecutorResponse =
  | {
      status: "completed";
      binding: ExecutablePluginBinding;
      media: ProviderPluginExecutorMedia;
    }
  | {
      status: "completed";
      binding: ExecutablePluginBinding;
      output: ProviderPluginExecutorTextOutput;
    }
  | {
      status: "accepted";
      binding: ExecutablePluginBinding;
      /**
       * Opaque; stored in the owner-private durable journal and handed back on the next poll.
       */
      pollState: unknown;
      retryAfterMs?: number;
    }
  | {
      status: "failed";
      binding: ExecutablePluginBinding;
      error: ProviderPluginFailure;
    };

export type ProviderPluginExecutor = (
  request: ProviderPluginExecutorRequest,
) => Promise<ProviderPluginExecutorResponse>;

/** Host-owned remaining attempt budget, moved verbatim from the Local coordinator. */
export function remainingAttemptTimeoutMs(
  run: DurableRunRecord,
  now: number,
): number {
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

export type ProviderStepTarget = Pick<
  FrozenExecutableInput,
  | "binding"
  | "kind"
  | "targetKind"
  | "generatorOutputContract"
  | "providerExecution"
>;

function providerStepFromResponse(
  run: DurableRunRecord,
  response: ProviderPluginExecutorResponse,
  target: ProviderStepTarget,
): DurableProviderStep {
  assertSameBinding(
    target.providerExecution?.binding ?? target.binding,
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
  if (target.targetKind === "generator-action") {
    const port = target.generatorOutputContract?.find(
      (candidate) => candidate.slot === run.outputSlot,
    );
    const normalized = target.kind === "text" && port?.assetType.kind === "document" &&
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

export function executableProviderStep(
  run: DurableRunRecord,
  response: ProviderPluginExecutorResponse,
): DurableProviderStep {
  return providerStepFromResponse(
    run,
    response,
    parseFrozenExecutableInput(run.executorInput),
  );
}

/**
 * Map one completed/accepted/failed plugin result without a frozen executable
 * record. The hosted generation journal freezes generation params rather than
 * an executable binding, so its adapter supplies the exact binding it invoked.
 */
export function executableProviderResultStep(
  run: DurableRunRecord,
  binding: ExecutablePluginBinding,
  kind: ProviderPluginExecutorKind,
  result: ExecutablePluginResult,
): DurableProviderStep {
  return providerStepFromResponse(
    run,
    providerPluginResponseFromResult(binding, kind, result),
    { binding, kind, targetKind: "provider-executor" },
  );
}

/** Normalize the plugin protocol's result envelope into the Provider boundary. */
export function providerPluginResponseFromResult(
  binding: ExecutablePluginBinding,
  kind: ProviderPluginExecutorKind,
  result: ExecutablePluginResult,
): ProviderPluginExecutorResponse {
  if (result.status === "failed") {
    return { status: "failed", binding, error: result.error };
  }
  if (result.status === "accepted") {
    return {
      status: "accepted",
      binding,
      pollState: result.pollState,
      ...(result.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: result.retryAfterMs }),
    };
  }
  const textOutputs = result.outputs.filter(
    (output) => output.slot === "text",
  );
  if (textOutputs.length > 1) {
    throw new Error(
      `Provider plugin ${binding.pluginId}/${binding.exportId} returned ${textOutputs.length} outputs for slot "text"; expected one.`,
    );
  }
  if (textOutputs.length === 1) {
    if (kind !== "text") {
      throw new Error(
        `Provider plugin ${binding.pluginId}/${binding.exportId} returned slot "text" for a ${kind} route.`,
      );
    }
    if (result.outputs.length !== 1) {
      throw new Error(
        `Provider plugin ${binding.pluginId}/${binding.exportId} returned slot "text" alongside conflicting outputs.`,
      );
    }
    const candidate = textOutputs[0];
    if (
      candidate?.kind !== "value" ||
      typeof candidate.value !== "string" ||
      !candidate.value.trim()
    ) {
      throw new Error(
        `Provider plugin ${binding.pluginId}/${binding.exportId} returned an invalid slot "text"; expected a non-empty string value.`,
      );
    }
    return {
      status: "completed",
      binding,
      output: candidate as ProviderPluginExecutorTextOutput,
    };
  }
  if (kind === "text") {
    throw new Error(
      `Provider plugin ${binding.pluginId}/${binding.exportId} returned no canonical slot "text" output.`,
    );
  }
  const media = result.outputs.filter((output) => output.slot === "media");
  if (media.length !== 1) {
    throw new Error(
      `Provider plugin ${binding.pluginId}/${binding.exportId} returned ${media.length} media outputs for one durable output slot; expected exactly one.`,
    );
  }
  const output = media[0];
  if (output?.kind !== "asset") {
    throw new Error(
      `Provider plugin ${binding.pluginId}/${binding.exportId} returned slot "media" through the value channel; media must use the canonical Asset output envelope.`,
    );
  }
  assertMediaOutputMatchesKind(binding, output.asset, kind);
  return { status: "completed", binding, media: output.asset };
}

function assertMediaOutputMatchesKind(
  binding: ExecutablePluginBinding,
  asset: ExecutablePluginAssetHandle,
  kind: ProviderPluginExecutorKind,
): void {
  if (asset.kind !== kind) {
    throw new Error(
      `Provider plugin ${binding.pluginId}/${binding.exportId} returned media asset kind ${asset.kind} for a ${kind} route.`,
    );
  }
  if (asset.mediaType && !asset.mediaType.startsWith(`${kind}/`)) {
    throw new Error(
      `Provider plugin ${binding.pluginId}/${binding.exportId} returned media type ${asset.mediaType} for a ${kind} route.`,
    );
  }
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
    FrozenExecutableInput,
    "targetKind" | "pluginOutputSlot" | "kind"
  >,
  durableOutputSlot: string,
): string[] {
  if (frozen.targetKind !== "action") return [durableOutputSlot];
  if (frozen.pluginOutputSlot) return [frozen.pluginOutputSlot];
  if (frozen.kind === "text") return ["result"];
  return [frozen.kind, "media"];
}

export function generatorActionStep(
  run: DurableRunRecord,
  result: ExecutablePluginResult,
): DurableProviderStep {
  const frozen = parseFrozenExecutableInput(run.executorInput);
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

export function executableProviderRequest(
  run: DurableRunRecord,
  idempotencyKey: string,
  now: number,
  pollState?: ExecutablePluginJsonValue,
): ProviderPluginExecutorRequest {
  const frozen = parseFrozenExecutableInput(run.executorInput);
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

/** Video-understanding controls owned by the Host, not Model Card parameters. */
export interface ExecutableProviderVideoControls {
  processing: "auto" | "static";
  fps: number;
  mediaResolution: "low" | "medium" | "high";
  startSeconds?: number;
  endSeconds?: number;
}

/** Everything the Host has already resolved when building one provider request. */
export interface ExecutableProviderRequestInput {
  route: ModelUpstreamRoute;
  kind: ModelKind;
  taskId: string;
  projectId?: string;
  nodeId?: string;
  prompt: string;
  aspectRatio?: string;
  duration?: number | string;
  modelParams?: Record<string, unknown>;
  video?: ExecutableProviderVideoControls;
  references?: ExecutablePluginReference[];
  pluginBinding?: ExecutablePluginBinding;
  pollState?: unknown;
  deadlineAt?: number;
}

function promptForRoute(
  input: Pick<ExecutableProviderRequestInput, "prompt" | "references">,
  route: ModelUpstreamRoute,
): string {
  const binding = route.referenceBinding;
  const content = (input.references ?? [])
    .filter((reference) => reference.slot === "content")
    .sort((left, right) => left.index - right.index);
  if (binding?.type !== "positional-tokens" || !content.some((part) => "asset" in part)) {
    return input.prompt;
  }
  // Token numbers follow occurrences, not Asset identity. The same immutable Asset can be placed
  // more than once in mixed content and every placement still has its own Provider position.
  const occurrence = { image: 0, video: 0, audio: 0 };
  return content
    .map((part) => {
      if ("text" in part) return part.text.value;
      if ("document" in part) return "";
      const modality = part.asset.kind;
      if (modality !== "image" && modality !== "video" && modality !== "audio") {
        return "";
      }
      const template = binding.tokens?.[modality];
      if (!template) return "";
      occurrence[modality] += 1;
      return template.split("{n}").join(String(occurrence[modality]));
    })
    .join("");
}

function providerVisibleModelParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const visible = { ...(params ?? {}) };
  delete visible.provider_id;
  delete visible.accountId;
  delete visible.credentials;
  delete visible.require_real_provider;
  return visible;
}

/** Build the exact provider-executor request both adapters send. Moved verbatim from Local. */
export function providerPluginExecutorRequest(
  input: ExecutableProviderRequestInput,
): ProviderPluginExecutorRequest {
  const { route } = input;
  if (!route.executorPluginId || !route.executorExportId) {
    throw new Error(
      `Route ${route.modelCode} has no executable provider executor.`,
    );
  }
  if (
    input.pluginBinding &&
    (input.pluginBinding.pluginId !== route.executorPluginId ||
      input.pluginBinding.exportId !== route.executorExportId)
  ) {
    throw new Error(
      `Pinned plugin ${input.pluginBinding.pluginId}/${input.pluginBinding.exportId} does not match ` +
        `route executor ${route.executorPluginId}/${route.executorExportId}.`,
    );
  }
  // These execution controls already belong to Google's video-understanding
  // adapter. Keep them out of Model Card validation and fail closed for another
  // executor, rather than silently ignoring the user's sampling/window settings.
  const video = input.video;
  if (video && (input.kind !== "text" || route.executorPluginId !== "clash.google"
    || route.executorExportId !== "google-execute")) {
    throw new Error(`Provider executor ${route.executorPluginId}/${route.executorExportId} does not support media-analysis video controls.`);
  }
  const remainingMs = input.deadlineAt === undefined ? undefined : input.deadlineAt - Date.now();
  if (remainingMs !== undefined && (!Number.isFinite(remainingMs) || remainingMs <= 0)) {
    throw new Error("Media generation Host deadline has elapsed before Provider dispatch.");
  }
  return {
    pluginId: route.executorPluginId,
    exportId: route.executorExportId,
    ...(route.accountId ? { accountId: route.accountId } : {}),
    kind: input.kind,
    ...(remainingMs === undefined ? {} : { timeoutMs: Math.max(1, Math.ceil(remainingMs)) }),
    taskId: input.taskId,
    projectId: input.projectId ?? "local",
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.pluginBinding ? { binding: input.pluginBinding } : {}),
    assetInputs: route.assetInputs ?? [],
    // Carried through untouched. Dropping it here silently turns every resume into a fresh
    // submission: the node keeps its record, the plugin never sees it, and the same generation is
    // bought again on every restart.
    ...(input.pollState === undefined ? {} : { pollState: input.pollState }),
    input: {
      values: {
        modelId: route.modelCode,
        upstreamModel: route.upstreamModel,
        apiShape: route.apiShape,
        prompt: promptForRoute(input, route),
        ...(input.aspectRatio !== undefined
          ? { aspectRatio: input.aspectRatio }
          : {}),
        ...(input.duration !== undefined ? { duration: input.duration } : {}),
        modelParams: {
          ...providerVisibleModelParams(input.modelParams),
          ...(video ? {
            video_processing: video.processing,
            video_fps: video.fps,
            video_media_resolution: video.mediaResolution,
            ...(video.startSeconds === undefined ? {} : { video_start_seconds: video.startSeconds }),
            ...(video.endSeconds === undefined ? {} : { video_end_seconds: video.endSeconds }),
          } : {}),
        },
      },
      references: [...(input.references ?? [])],
    },
  };
}
