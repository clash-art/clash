import type {
  ExecutablePluginInvocation,
  ExecutablePluginJsonValue,
  ExecutablePluginOutput,
  ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";

import type {
  Executor,
  ExecutorContext,
  ExecutorContextOverrides,
  ExecutorStep,
  MediaData,
} from "./define-plugin.js";
import { unsupportedAcceptedOperation } from "./executable-failure.js";

export type {
  ExecutorContext,
  ExecutorContextOverrides,
} from "./define-plugin.js";

/** Host-private scheduling choice. It never enters Generator semantic identity. */
export type PluginExecutionRealm = "local" | "cloud" | "client";

const KIND = Symbol.for("clash.plugin.kind");
const ACTION_MODE = Symbol.for("clash.plugin.action-mode");

export type ProjectorFn = (
  invocation: ExecutablePluginInvocation,
) => ExecutablePluginJsonValue;

export interface Action {
  run: (
    invocation: ExecutablePluginInvocation,
    context: ExecutorContext,
  ) => Promise<ExecutorStep>;
}

export interface ManifestFunction {
  id: string;
  kind: string;
  operations?: string[];
  assetInputs?: Array<{
    match: { kinds?: string[]; slots?: string[] };
    representations: string[];
    mediaTypes?: string[];
  }>;
}

/** The executable module shared by local, cloud, and browser client runners. */
export interface PluginModule {
  invoke(
    invocation: ExecutablePluginInvocation,
    hostContext?: ExecutorContextOverrides,
  ): Promise<ExecutablePluginResult>;
  contributes: ManifestFunction[];
}

export interface BrowserPluginModuleOptions {
  functions: ManifestFunction[];
  contributes: Record<string, unknown>;
  pluginId?: string;
}

export interface PluginModuleInvocation {
  realm: PluginExecutionRealm;
  module: PluginModule;
  invocation: ExecutablePluginInvocation;
  hostContext?: ExecutorContextOverrides;
}

/**
 * Select an execution owner without leaking the choice into the invocation or plugin business code.
 * Realm-specific runners may wrap persistence/telemetry around this boundary; the module is one.
 */
export function invokePluginModule(
  input: PluginModuleInvocation,
): Promise<ExecutablePluginResult> {
  return input.module.invoke(input.invocation, input.hostContext);
}

/** Pure arithmetic on an invocation: no network, credentials, or Host calls. */
export function defineProjector(project: ProjectorFn): ProjectorFn {
  return Object.assign(project, { [KIND]: "provider-projector" as const });
}

/** Talks to a Provider and may split submit from poll. */
export function defineExecutor(executor: Executor): Executor {
  return Object.assign(executor, { [KIND]: "provider-executor" as const });
}

/** A synchronous Action contributed by the plugin itself. */
export function defineAction(action: Action): Action {
  return Object.assign(action, {
    [KIND]: "action" as const,
    [ACTION_MODE]: "run" as const,
  });
}

/** A durable submit/poll Action contributed by the plugin itself. */
export function defineActionExecutor(executor: Executor): Executor {
  return Object.assign(executor, {
    [KIND]: "action" as const,
    [ACTION_MODE]: "executor" as const,
  });
}

function unavailable(name: string): never {
  throw new Error(
    `Plugin invocation has no ${name} capability in this execution realm.`,
  );
}

function contextFrom(
  overrides: ExecutorContextOverrides = {},
): ExecutorContext {
  const hostTools = overrides.hostTools ?? {};
  return {
    upload: overrides.upload ?? (async () => unavailable("upload")),
    asset: overrides.asset ?? (async () => unavailable("asset write")),
    document: overrides.document ?? (async () => unavailable("document write")),
    reference:
      overrides.reference ?? (async () => unavailable("Asset reference")),
    store: overrides.store ?? {
      get: async () => unavailable("store"),
      put: async () => unavailable("store"),
      remove: async () => unavailable("store"),
    },
    hostTools: {
      agentText: hostTools.agentText ?? (async () => unavailable("agent text Host tool")),
      codexImagegen: hostTools.codexImagegen ?? {
        generate: async () => unavailable("codex.imagegen Host tool"),
      },
      directorStageCaptureFrame:
        hostTools.directorStageCaptureFrame ??
        (async () => unavailable("Director Stage capture Host tool")),
      mediaAnalyze:
        hostTools.mediaAnalyze ??
        (async () => unavailable("media analysis Host tool")),
      speechTranscribe:
        hostTools.speechTranscribe ??
        (async () => unavailable("speech transcription Host tool")),
      videoEnhance:
        hostTools.videoEnhance ??
        (async () => unavailable("video enhancement Host tool")),
    },
  };
}

function assetKindOf(media: MediaData): "image" | "video" | "audio" | "model" {
  if (media.kind) return media.kind;
  if (media.mediaType?.startsWith("video/")) return "video";
  if (media.mediaType?.startsWith("audio/")) return "audio";
  return "image";
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function outputsFor(
  media: Record<string, MediaData>,
  context: ExecutorContext,
): Promise<ExecutablePluginOutput[]> {
  const outputs: ExecutablePluginOutput[] = [];
  for (const [slot, file] of Object.entries(media)) {
    const request = {
      slot,
      kind: assetKindOf(file),
      ...(file.mediaType ? { mediaType: file.mediaType } : {}),
    };
    if ("url" in file && file.url) {
      outputs.push(await context.upload({ ...request, url: file.url }));
    } else if ("bytes" in file && file.bytes) {
      outputs.push(await context.upload({ ...request, bytes: file.bytes }));
    } else if ("base64" in file && file.base64) {
      outputs.push(
        await context.upload({ ...request, bytes: decodeBase64(file.base64) }),
      );
    } else {
      throw new Error(`${slot} declares no bytes, base64 or url.`);
    }
  }
  return outputs;
}

async function normalise(
  invocation: ExecutablePluginInvocation,
  step: ExecutorStep,
  context: ExecutorContext,
): Promise<ExecutablePluginResult> {
  if (step.status === "accepted") {
    return {
      protocol: "clash.plugin.result/v1",
      invocationId: invocation.invocationId,
      status: "accepted",
      pollState: step.pollState,
      ...(step.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: step.retryAfterMs }),
    };
  }
  if (step.status === "failed") {
    return {
      protocol: "clash.plugin.result/v1",
      invocationId: invocation.invocationId,
      status: "failed",
      error: step.error,
    };
  }
  return {
    protocol: "clash.plugin.result/v1",
    invocationId: invocation.invocationId,
    status: "completed",
    outputs:
      "media" in step ? await outputsFor(step.media, context) : step.outputs,
  };
}

function requirePoll(declaration: ManifestFunction, executor: Executor) {
  if (!executor.poll) {
    throw new Error(
      `${declaration.id} answers at once and has no poll operation, but the runner asked it to poll.`,
    );
  }
  return executor.poll.bind(executor);
}

function validateContribution(
  declaration: ManifestFunction,
  bean: unknown,
): void {
  const definedKind = (bean as Record<symbol, string>)[KIND];
  if (definedKind && definedKind !== declaration.kind) {
    throw new Error(
      `${declaration.id} is declared ${declaration.kind} in the manifest but defined as ${definedKind} in code.`,
    );
  }
  if (declaration.kind !== "action") return;
  const mode = (bean as Record<symbol, string>)[ACTION_MODE];
  if (
    mode === "run" &&
    declaration.operations?.some((operation) => operation !== "submit")
  ) {
    throw new Error(
      `${declaration.id} is a run-only Action but declares a durable poll or callback operation.`,
    );
  }
  if (mode !== "executor") return;
  const executor = bean as Executor;
  if (declaration.operations?.includes("poll") && !executor.poll) {
    throw new Error(
      `${declaration.id} declares poll but its Action executor implements no poll operation.`,
    );
  }
  if (declaration.operations?.includes("callback") && !executor.callback) {
    throw new Error(
      `${declaration.id} declares callback but its Action executor implements no callback operation.`,
    );
  }
}

/**
 * Assemble one transport-neutral module from already-loaded declarations.
 *
 * Browser clients pass the packaged declaration JSON; local/cloud loaders read the same manifest
 * and call this function. The executable contribution code is therefore identical in all realms.
 */
export function assemblePluginModule(
  options: BrowserPluginModuleOptions,
): PluginModule {
  const wired = new Map<
    string,
    { declaration: ManifestFunction; bean: unknown }
  >();
  for (const declaration of options.functions) {
    const bean = options.contributes[declaration.id];
    if (bean === undefined) {
      throw new Error(
        `Plugin ${options.pluginId ?? "module"} declares ${declaration.id}, but nothing implements it.`,
      );
    }
    validateContribution(declaration, bean);
    wired.set(declaration.id, { declaration, bean });
  }
  for (const id of Object.keys(options.contributes)) {
    if (!wired.has(id)) {
      throw new Error(
        `Plugin ${options.pluginId ?? "module"} implements ${id}, but its declarations do not expose it.`,
      );
    }
  }

  return {
    contributes: options.functions,
    async invoke(invocation, hostContext) {
      const entry = wired.get(invocation.target.exportId);
      if (!entry) {
        throw new Error(
          `No export ${invocation.target.exportId}. This plugin declares: ${[...wired.keys()].join(", ") || "nothing"}.`,
        );
      }
      const context = contextFrom(hostContext);

      if (entry.declaration.kind === "provider-projector") {
        return {
          protocol: "clash.plugin.result/v1",
          invocationId: invocation.invocationId,
          status: "completed",
          outputs: [
            {
              slot: "projection",
              kind: "value",
              value: (entry.bean as ProjectorFn)(invocation),
            },
          ],
        };
      }

      if (entry.declaration.kind === "action") {
        const mode = (entry.bean as Record<symbol, string>)[ACTION_MODE];
        const step =
          mode === "executor"
            ? invocation.operation === "poll"
              ? await requirePoll(entry.declaration, entry.bean as Executor)(
                  invocation,
                  context,
                )
              : invocation.operation === "callback"
                ? (entry.bean as Executor).callback
                  ? await (entry.bean as Executor).callback!(
                      invocation,
                      context,
                    )
                  : {
                      status: "failed" as const,
                      error: unsupportedAcceptedOperation(
                        entry.declaration.id,
                        "callback",
                      ),
                    }
                : await (entry.bean as Executor).submit(invocation, context)
            : await (entry.bean as Action).run(invocation, context);
        return normalise(invocation, step, context);
      }

      const executor = entry.bean as Executor;
      const step =
        invocation.operation === "poll"
          ? await requirePoll(entry.declaration, executor)(invocation, context)
          : invocation.operation === "callback"
            ? executor.callback
              ? await executor.callback(invocation, context)
              : {
                  status: "failed" as const,
                  error: unsupportedAcceptedOperation(
                    entry.declaration.id,
                    "callback",
                  ),
                }
            : await executor.submit(invocation, context);
      return normalise(invocation, step, context);
    },
  };
}
