/**
 * The Cloudflare adapter's one resolution of an executable plugin binding.
 *
 * First-party plugins are code-registered and run in-process. A first-party id
 * never falls through to the remote binding, even if a settings row exists.
 * Third-party plugins resolve a per-user HTTPS endpoint and sealed secret.
 */
import type { ExecutablePluginBinding } from "@clash/shared-types/executable-plugin";
import type { D1Database } from "@cloudflare/workers-types";

import { resolveRemotePluginSettings } from "../services/plugin-settings";
import {
  CLOUD_IN_PROCESS_PLUGIN_IDS,
  cloudInProcessExportIdempotentSubmit,
  resolveCloudInProcessBinding,
} from "./plugin-execution/registry";

export interface ResolvedExecutableBinding {
  binding: ExecutablePluginBinding;
  kind: "in-process" | "remote";
  idempotentSubmit: boolean;
  remote?: {
    endpoint: string;
    signingSecret: string;
  };
}

function sameBinding(
  left: ExecutablePluginBinding,
  right: ExecutablePluginBinding,
): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.version === right.version &&
    left.exportId === right.exportId &&
    left.schemaHash === right.schemaHash
  );
}

export async function resolveExecutableBinding(
  env: { DB: D1Database; ACTION_SECRET_KEY?: string },
  userId: string,
  candidate: ExecutablePluginBinding,
): Promise<ResolvedExecutableBinding | undefined> {
  const firstParty = (
    CLOUD_IN_PROCESS_PLUGIN_IDS as readonly string[]
  ).includes(candidate.pluginId);
  if (firstParty) {
    const binding = await resolveCloudInProcessBinding(
      candidate.pluginId,
      candidate.exportId,
    );
    // A stale card, changed package or wrong export is a contract mismatch,
    // never permission to route first-party code through a user endpoint.
    if (!binding || !sameBinding(binding, candidate)) return undefined;
    return {
      binding,
      kind: "in-process",
      idempotentSubmit: await cloudInProcessExportIdempotentSubmit(
        binding.pluginId,
        binding.exportId,
      ),
    };
  }

  const setting = await resolveRemotePluginSettings(
    env,
    userId,
    candidate.pluginId,
  );
  if (!setting) return undefined;
  if (setting.version && setting.version !== candidate.version)
    return undefined;
  if (setting.schemaHash && setting.schemaHash !== candidate.schemaHash)
    return undefined;
  if (
    setting.exportIds.length > 0 &&
    !setting.exportIds.includes(candidate.exportId)
  )
    return undefined;
  return {
    binding: candidate,
    kind: "remote",
    idempotentSubmit: setting.idempotentSubmit,
    remote: {
      endpoint: setting.endpoint,
      signingSecret: setting.signingSecret,
    },
  };
}
