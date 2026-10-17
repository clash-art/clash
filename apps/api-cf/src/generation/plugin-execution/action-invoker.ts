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
import type {
  ExecutablePluginReference,
  ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";

import type { Env } from "../../config";
import { getAssetsByIds } from "../../services/assets";
import { signAssetPath, SIGNED_URL_TTL } from "../../services/asset-signing";
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

function mediaBase(env: Env): string {
  const base =
    env.MEDIA_GATEWAY_URL ||
    env.WORKER_PUBLIC_URL ||
    (env.ENVIRONMENT === "development" ? "http://localhost:3000" : undefined);
  if (!base) {
    throw new Error(
      "MEDIA_GATEWAY_URL or WORKER_PUBLIC_URL must be set — a remote plugin cannot fetch references without an absolute origin.",
    );
  }
  return base.replace(/\/+$/, "");
}

async function remoteReferences(
  env: Env,
  userId: string,
  references: readonly ExecutablePluginReference[],
): Promise<RemotePluginReference[]> {
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
  const records = await getAssetsByIds(
    env.DB,
    assetReferences.map((reference) => reference.asset.assetId),
    userId,
  );
  const byId = new Map(records.map((record) => [record.id, record]));
  const base = mediaBase(env);
  const expiresAt = new Date(
    (Math.floor(Date.now() / 1000) + SIGNED_URL_TTL) * 1000,
  ).toISOString();
  return Promise.all(
    assetReferences.map(async (reference) => {
      const asset = byId.get(reference.asset.assetId);
      if (!asset) {
        throw new Error(
          `Remote plugin reference ${reference.slot}#${reference.index} is unavailable.`,
        );
      }
      return {
        slot: reference.slot,
        index: reference.index,
        url: `${base}${await signAssetPath(env, asset.srcR2Key, SIGNED_URL_TTL)}`,
        expiresAt,
      };
    }),
  );
}

function remotePort(
  env: Env,
  request: ExecutablePluginActionRequest,
  userId: string,
  binding: ResolvedExecutableBinding,
  options: CloudActionInvokerOptions,
): PluginExecutionPort {
  if (!binding.remote) {
    throw new Error(
      `Plugin ${binding.binding.pluginId} has no remote endpoint.`,
    );
  }
  return createRemotePluginExecution({
    fetch: options.fetch,
    now: options.now,
    target: async () => ({
      endpoint: binding.remote!.endpoint,
      secret: binding.remote!.signingSecret,
      references: await remoteReferences(env, userId, request.input.references),
    }),
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
        : remotePort(env, request, userId, resolved, options);
    return port.invoke({
      run,
      invocation: executablePluginActionInvocation(request),
      timeoutMs: request.timeoutMs,
    });
  };
}
