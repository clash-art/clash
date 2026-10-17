import {
  type ExecutablePluginFunctionExport,
  ExecutablePluginBindingSchema,
  ExecutablePluginInvocationSchema,
  ExecutablePluginResultSchema,
  type ExecutablePluginBinding,
  type ExecutablePluginInvocation,
  type ExecutablePluginResult,
} from "@clash/shared-types";

import type {
  ProviderPluginExecutor,
  ProviderPluginExecutorMedia,
  ProviderPluginExecutorTextOutput,
} from "./local-aigc.js";
import { ProviderPluginHostUnavailableError } from "./local-aigc.js";

export interface ProviderPluginExecutorClient {
  /** Declared entry points, used to check an acceptance against what the plugin says it supports. */
  listFunctionExports?(
    pluginId: string,
  ): Promise<ExecutablePluginFunctionExport[]>;
  resolveBinding(
    pluginId: string,
    exportId: string,
    kind: "provider-executor",
  ): Promise<ExecutablePluginBinding>;
  invoke(
    pluginId: string,
    invocation: ExecutablePluginInvocation,
    options?: { timeoutMs?: number; accountId?: string },
  ): Promise<ExecutablePluginResult>;
}

/**
 * Everything a finished generation produced, in order.
 *
 * This used to be `outputs.find(...)` -- the first match, with the rest dropped silently. One call
 * routinely yields several files: gpt-image takes an `n`, MiniMax returns a video and its cover,
 * and image models return variations of one prompt. Losing them looked like success.
 *
 * Only the `media` slot. A plugin that names an output something else means it to be something
 * else; a cover frame and the video it belongs to are not interchangeable.
 */
export function mediaListFromResult(
  input: unknown,
): ProviderPluginExecutorMedia[] {
  const result = ExecutablePluginResultSchema.parse(input);
  if (result.status === "failed") {
    throw new Error(
      `Provider plugin failed (${result.error.code}): ${result.error.message}`,
    );
  }
  if (result.status === "accepted") {
    // Reading media off an accepted result would invent an answer the provider has not given yet.
    // The caller decides what to do with an acceptance; this function only reads finished work.
    throw new Error(
      "Provider plugin accepted the work; no media is available yet.",
    );
  }
  const outputs = result.outputs.filter((entry) => entry.slot === "media");
  if (outputs.length === 0)
    throw new Error("Provider plugin returned no media output.");
  return outputs.map((output) => mediaFromOutput(output));
}

/**
 * The one media output accepted by the current Provider Run contract.
 *
 * A Project Run owns one output slot and one ProjectAsset publication. Until the public contract
 * gives multiple outputs distinct slots/identities, accepting several here would silently publish
 * only the first. Reject the ambiguous result instead of reporting partial success.
 */
export function mediaFromResult(input: unknown): ProviderPluginExecutorMedia {
  const media = mediaListFromResult(input);
  if (media.length !== 1) {
    throw new Error(
      `Provider plugin returned ${media.length} media outputs for one durable output slot; expected exactly one.`,
    );
  }
  return media[0]!;
}

type CompletedOutput = Extract<
  ReturnType<typeof ExecutablePluginResultSchema.parse>,
  { status: "completed" }
>["outputs"][number];

function mediaFromOutput(output: CompletedOutput): ProviderPluginExecutorMedia {
  // The Asset channel carries only the staging receipt and immutable media facts. A URL is a Host
  // projection, not Asset identity; the durable publication step resolves the receipt through the
  // Asset service instead of teaching this executor where local or cloud storage lives.
  if (output.kind === "asset") {
    return output.asset;
  }
  throw new Error(
    'Provider plugin slot "media" must use the canonical Asset output envelope.',
  );
}

function assertMediaOutputsMatchKind(
  result: Extract<ExecutablePluginResult, { status: "completed" }>,
  expectedKind: "image" | "video" | "audio" | "model",
  target: string,
): void {
  const expectedPrefix = `${expectedKind}/`;
  for (const output of result.outputs.filter(
    (candidate) => candidate.slot === "media",
  )) {
    if (output.kind === "asset") {
      if (output.asset.kind !== expectedKind) {
        throw new Error(
          `Provider plugin ${target} returned media asset kind ${output.asset.kind} for a ${expectedKind} route.`,
        );
      }
      if (
        output.asset.mediaType &&
        !output.asset.mediaType.startsWith(expectedPrefix)
      ) {
        throw new Error(
          `Provider plugin ${target} returned media type ${output.asset.mediaType} for a ${expectedKind} route.`,
        );
      }
      continue;
    }
    throw new Error(
      `Provider plugin ${target} returned slot "media" through the value channel; ` +
        'media must use the canonical Asset output envelope.',
    );
  }
}

/**
 * Whether this entry says it can be asked about work it accepted.
 *
 * Read from the manifest rather than carried on the binding: a binding is an identity -- four
 * fields that hash into a contract check -- and adding capability to it would make two plugins with
 * identical contracts hash differently.
 *
 * A submit reads this before crossing the Provider boundary. A transient manifest failure must not
 * be collapsed into "does not support poll" after the Provider has already accepted paid work.
 */
async function declaresPoll(
  client: ProviderPluginExecutorClient,
  pluginId: string,
  exportId: string,
): Promise<boolean> {
  const entries = await client.listFunctionExports?.(pluginId);
  const entry = entries?.find((candidate) => candidate.id === exportId);
  return entry?.operations?.includes("poll") ?? false;
}

export function createProviderPluginExecutor(options: {
  client: ProviderPluginExecutorClient;
  now?: () => number;
}): ProviderPluginExecutor {
  const now = options.now ?? Date.now;
  return async (request) => {
    const invocationDeadlineAt =
      request.timeoutMs === undefined ? undefined : now() + request.timeoutMs;
    let binding: ExecutablePluginBinding;
    try {
      binding = request.binding
        ? ExecutablePluginBindingSchema.parse(request.binding)
        : await options.client.resolveBinding(
            request.pluginId,
            request.exportId,
            "provider-executor",
          );
    } catch (error) {
      if (pluginHostUnavailable(error)) {
        throw new ProviderPluginHostUnavailableError((error as Error).message, {
          cause: error,
        });
      }
      throw error;
    }
    if (
      binding.pluginId !== request.pluginId ||
      binding.exportId !== request.exportId
    ) {
      throw new Error(
        `Plugin host resolved ${binding.pluginId}/${binding.exportId}, expected ` +
          `${request.pluginId}/${request.exportId}.`,
      );
    }
    // Account selection is host state. Remove similarly named model values even when an internal
    // caller supplies them: sending either field over stdio would let plugin-visible input disagree
    // with the account the host bills and later resumes.
    const {
      accountId: _untrustedAccountId,
      credentials: _untrustedCredentials,
      ...pluginValues
    } = request.input.values;
    const invocation = ExecutablePluginInvocationSchema.parse({
      protocol: "clash.plugin.invoke/v1",
      // The durable run's idempotency key, not a fresh id per process call:
      // an ambiguous submit retry must look like the same invocation.
      invocationId: request.taskId,
      taskId: request.taskId,
      projectId: request.projectId,
      ...(request.nodeId ? { nodeId: request.nodeId } : {}),
      target: { ...binding, kind: "provider-executor" },
      assetInputs: request.assetInputs ?? [],
      input: {
        ...request.input,
        values: {
          ...pluginValues,
          // Output shape is route metadata, not a model parameter. Executors need it to choose the
          // provider lifecycle (MiniMax audio completes inline while video is queued), so carry it
          // beside the other host-owned invocation metadata.
          kind: request.kind,
        },
      },
      actor: { kind: "system", id: "local-aigc" },
      // Passed through untouched. The host stores whatever the plugin handed back and returns it
      // verbatim, so a provider identified by a URL, a region pair, or nothing resembling an id at
      // all needs no accommodation here.
      ...(request.pollState === undefined
        ? {}
        : { operation: "poll" as const, pollState: request.pollState }),
    });
    // Capability discovery is a submit preflight. Looking it up after an `accepted` response can
    // strand a paid task when the plugin host restarts in the narrow gap between the two calls.
    // Existing poll work already has a durable token, so a transient manifest read must not block
    // its recovery path.
    const pollDeclared =
      request.pollState === undefined
        ? await declaresPoll(options.client, request.pluginId, request.exportId)
        : true;
    let invokeTimeoutMs = request.timeoutMs;
    if (invocationDeadlineAt !== undefined) {
      const remainingMs = invocationDeadlineAt - now();
      if (remainingMs <= 0) {
        throw new Error(
          `Plugin invocation ${invocation.invocationId} timed out before Provider ${invocation.operation}.`,
        );
      }
      invokeTimeoutMs = Math.max(1, Math.ceil(remainingMs));
    }
    let result: ExecutablePluginResult;
    try {
      result = await options.client.invoke(request.pluginId, invocation, {
        ...(invokeTimeoutMs === undefined
          ? {}
          : { timeoutMs: invokeTimeoutMs }),
        ...(request.accountId ? { accountId: request.accountId } : {}),
      });
    } catch (error) {
      if (pluginHostUnavailable(error)) {
        throw new ProviderPluginHostUnavailableError((error as Error).message, {
          cause: error,
        });
      }
      throw error;
    }
    if (result.status === "accepted") {
      // A plugin that never said it could be polled has just taken money for work nobody can
      // collect. Refusing here turns a silent loss into a loud one, at the only moment it is still
      // cheap to notice.
      if (!pollDeclared) {
        return {
          status: "failed",
          binding,
          error: {
            code: "contract_violation",
            message:
              `Provider plugin ${request.pluginId}/${request.exportId} accepted work but does not ` +
              "declare the poll operation, so its result could never be collected.",
            retryable: false,
            // The invocation has already crossed the Provider boundary. Throwing here used to
            // classify this as an ambiguous submit and could buy the same work a second time.
            requestState: "accepted",
          },
        };
      }
      return {
        status: "accepted",
        binding,
        pollState: result.pollState,
        ...(result.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: result.retryAfterMs }),
      };
    }
    if (result.status === "failed") {
      return {
        status: "failed",
        binding,
        error: result.error,
      };
    }
    const textOutputs = result.outputs.filter(
      (output) => output.slot === "text",
    );
    const target = `${request.pluginId}/${request.exportId}`;
    if (textOutputs.length > 1) {
      throw new Error(
        `Provider plugin ${target} returned ${textOutputs.length} outputs for slot "text"; expected one.`,
      );
    }
    if (textOutputs.length === 1) {
      if (request.kind !== "text") {
        throw new Error(
          `Provider plugin ${target} returned slot "text" for a ${request.kind} route.`,
        );
      }
      if (result.outputs.length !== 1) {
        throw new Error(
          `Provider plugin ${target} returned slot "text" alongside conflicting outputs.`,
        );
      }
      const candidate = textOutputs[0];
      if (
        candidate?.kind !== "value" ||
        typeof candidate.value !== "string" ||
        !candidate.value.trim()
      ) {
        throw new Error(
          `Provider plugin ${target} returned an invalid slot "text"; expected a non-empty string value.`,
        );
      }
      return {
        status: "completed",
        binding,
        output: candidate as ProviderPluginExecutorTextOutput,
      };
    }
    if (request.kind === "text") {
      throw new Error(
        `Provider plugin ${target} returned no canonical slot "text" output.`,
      );
    }
    assertMediaOutputsMatchKind(result, request.kind, target);
    return {
      status: "completed",
      binding,
      media: mediaFromResult(result),
    };
  };
}

function pluginHostUnavailable(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    /plugin host.*(closed|timed out)/i.test(message) ||
    /executable plugin .* (is not installed|is not running)/i.test(message)
  );
}
