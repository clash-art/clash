/**
 * The Cloudflare adapter's Action port binding.
 *
 * One invocation is resolved from code first (`in-process`) and only then
 * from the user's per-plugin endpoint (`remote`). The caller sees one result
 * envelope and never learns which binding ran.
 */
import type { DurableRunIdentity } from "@clash/shared-runtime/durable-run-engine";
import {
  executablePluginActionInvocation,
  type ExecutablePluginActionInvoker,
  type ExecutablePluginActionRequest,
} from "@clash/shared-runtime/executable-run";
import type { PluginExecutionPort } from "@clash/shared-runtime/executable-plugin-port";
import {
  createRemotePluginExecution,
  type RemotePluginReference,
} from "@clash/shared-runtime/executable-plugin-remote";
import { issuePluginOutputCapabilities } from "@clash/shared-runtime/cloud-project-host/plugin-output-sessions";
import { referenceUnavailableFailure } from "@clash/shared-runtime/cloud-project-host/project-asset-references";
import type {
  ExecutablePluginReference,
  ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";

import type { Env } from "../../config";
import {
  cloudPluginOutputSessionPorts,
  pluginOutputUploaded,
} from "../../services/plugin-output-sessions";
import {
  createCloudProjectAssetReferenceResolver,
  roomProjectAssetReader,
} from "../../services/project-asset-references";
import {
  resolveExecutableBinding,
  type ResolvedExecutableBinding,
} from "../executable-binding";
import { hostedProjectOwnerId } from "../project-owner";
import { createCloudActionExecutorContext } from "./action-context";
import { createInProcessPluginExecution } from "./in-process";
import { loadCloudInProcessPluginModules } from "./registry";

export interface CloudActionInvokerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests can pin the owner without a project row. */
  userIdForProject?: (projectId: string) => Promise<string>;
}

/** Each pinned Project Asset becomes a short-lived signed URL, or the run fails `reference_unavailable`. */
async function remoteReferences(
  env: Env,
  request: ExecutablePluginActionRequest,
  userId: string,
): Promise<RemotePluginReference[]> {
  const references = request.input.references;
  // A text-only Action has nothing to sign; it must not need a media origin.
  if (references.length === 0) return [];
  const assetReferences = references.filter(
    (
      reference,
    ): reference is Extract<ExecutablePluginReference, { asset: unknown }> =>
      "asset" in reference,
  );
  if (assetReferences.length !== references.length) {
    throw new Error(
      "A remote plugin reference must be a pinned media Asset; text and Document references are not part of the remote protocol.",
    );
  }
  const resolver = createCloudProjectAssetReferenceResolver(env, {
    readAsset: roomProjectAssetReader(env),
    libraryOwnerId: userId,
  });
  const signed: RemotePluginReference[] = [];
  for (const reference of assetReferences) {
    const resolved = await resolver.resolve({
      projectId: request.projectId,
      assetId: reference.asset.assetId,
    });
    if (!resolved.ok)
      throw referenceUnavailableFailure(
        `Remote plugin reference ${reference.slot}#${reference.index}`,
        reference.asset.assetId,
        resolved.reason,
      );
    signed.push({
      slot: reference.slot,
      index: reference.index,
      url: resolved.reference.url,
      expiresAt: resolved.reference.expiresAt,
    });
  }
  return signed;
}

/**
 * A media run also hands the plugin one output upload capability per accepted
 * slot; they are built per invocation, like references, and never journaled.
 */
function remotePort(
  env: Env,
  run: DurableRunIdentity,
  request: ExecutablePluginActionRequest,
  userId: string,
  binding: ResolvedExecutableBinding,
  options: CloudActionInvokerOptions,
): PluginExecutionPort {
  const remote = binding.remote;
  if (!remote) {
    throw new Error(
      `Plugin ${binding.binding.pluginId} has no remote endpoint.`,
    );
  }
  const mediaKind = request.outputMediaKind;
  const mediaSlots = mediaKind ? (request.expectedOutputSlots ?? []) : [];
  return createRemotePluginExecution({
    fetch: options.fetch,
    now: options.now,
    target: async () => ({
      endpoint: remote.endpoint,
      secret: remote.signingSecret,
      references: await remoteReferences(env, request, userId),
      ...(mediaKind && mediaSlots.length
        ? {
            outputs: await issuePluginOutputCapabilities(
              {
                run,
                ownerId: userId,
                projectId: request.projectId,
                kind: mediaKind,
                slots: mediaSlots,
              },
              cloudPluginOutputSessionPorts(env, options.now),
            ),
          }
        : {}),
    }),
    outputUploaded: () => pluginOutputUploaded(env, run),
  });
}

async function inProcessPort(
  env: Env,
  request: ExecutablePluginActionRequest,
  userId: string,
): Promise<PluginExecutionPort> {
  const registrations = await loadCloudInProcessPluginModules();
  return createInProcessPluginExecution({
    modules: new Map(
      [...registrations].map(([pluginId, registration]) => [
        pluginId,
        registration.module,
      ]),
    ),
    context: () =>
      createCloudActionExecutorContext(
        env,
        {
          actionRunId: request.taskId,
          outputSlot: request.outputSlot!,
        },
        request.projectId,
        userId,
      ),
  });
}

export function createCloudActionInvoker(
  env: Env,
  options: CloudActionInvokerOptions = {},
): ExecutablePluginActionInvoker {
  return async (
    request: ExecutablePluginActionRequest,
  ): Promise<ExecutablePluginResult> => {
    if (!request.outputSlot) {
      throw new Error(
        "Executable Action invocation has no durable output slot.",
      );
    }
    if (!request.timeoutMs || request.timeoutMs <= 0) {
      throw new Error(
        "Executable Action invocation has no remaining attempt lease.",
      );
    }
    const userId = await (
      options.userIdForProject ??
      ((projectId) => hostedProjectOwnerId(env, projectId))
    )(request.projectId);
    const resolved = await resolveExecutableBinding(
      env,
      userId,
      request.binding,
    );
    if (!resolved) {
      throw new Error(
        `plugin_unavailable: ${request.binding.pluginId}/${request.binding.exportId} is not executable in this deployment.`,
      );
    }
    const run: DurableRunIdentity = {
      actionRunId: request.taskId,
      outputSlot: request.outputSlot,
    };
    const port =
      resolved.kind === "in-process"
        ? await inProcessPort(env, request, userId)
        : remotePort(env, run, request, userId, resolved, options);
    return port.invoke({
      run,
      invocation: executablePluginActionInvocation(request),
      timeoutMs: request.timeoutMs,
    });
  };
}
