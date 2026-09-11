import { ActionRunModelRouteSchema } from "@clash/shared-types";

/**
 * The exact minimal slice of a frozen durable-run executor input this check reads.
 *
 * Kept narrow and separate from `FrozenLocalProviderExecutorInput` so this module can be unit
 * tested without constructing the whole durable-run machinery.
 */
export interface FrozenReceiptOwnershipInput {
  targetKind?: string;
  binding: { pluginId: string; version: string; exportId?: string };
  providerExecution?: {
    binding: { pluginId: string; version: string };
    accountId?: string;
  };
  input: { values: Record<string, unknown> };
}

export type ProviderExecutorBindingResolver = (
  pluginId: string,
  exportId: string,
) => Promise<{ pluginId: string; version: string; exportId: string; schemaHash: string }>;

export interface StagedReceiptOwner {
  pluginId: string;
  pluginVersion: string;
  /** Present only when the frozen `modelRoute` names an account; absent otherwise. */
  accountId?: string;
}

/**
 * Who is allowed to have staged this durable run's media output.
 *
 * A plain Provider executor run (or a custom local Action) owns its own upload: the receipt must
 * carry that exact plugin and version. A generic model-consumer Generator Action -- one that never
 * recognizes a Provider by name and instead dispatches by Host-frozen `modelRoute` -- delegates the
 * actual upload to whichever Provider executor plugin/version/export that frozen route names.
 *
 * The frozen route's `executorBinding` is the pinned answer, resolved once by the Host at model
 * selection and never re-resolved here: a Provider plugin upgraded between this Run's submit and a
 * later poll must not silently swap in a newer version at publication time. Only a legacy route
 * that predates `executorBinding` falls back to a fresh Host resolution by plugin/export id.
 */
export async function expectedProviderReceiptOwner(input: {
  frozen: FrozenReceiptOwnershipInput;
  resolveProviderExecutorBinding?: ProviderExecutorBindingResolver;
}): Promise<StagedReceiptOwner> {
  const { frozen } = input;
  if (frozen.targetKind === "generator-action" && frozen.providerExecution) {
    return {
      pluginId: frozen.providerExecution.binding.pluginId,
      pluginVersion: frozen.providerExecution.binding.version,
      ...(frozen.providerExecution.accountId
        ? { accountId: frozen.providerExecution.accountId }
        : {}),
    };
  }
  const modelRoute = ActionRunModelRouteSchema.safeParse(
    frozen.input.values.modelRoute,
  );
  const delegatesToModelRoute =
    frozen.targetKind === "generator-action" &&
    modelRoute.success &&
    !!modelRoute.data.executorPluginId &&
    !!modelRoute.data.executorExportId;

  if (!delegatesToModelRoute) {
    return { pluginId: frozen.binding.pluginId, pluginVersion: frozen.binding.version };
  }

  const route = modelRoute.data;
  const accountId = route.accountId ? { accountId: route.accountId } : {};

  if (route.executorBinding) {
    if (
      route.executorBinding.pluginId !== route.executorPluginId ||
      route.executorBinding.exportId !== route.executorExportId
    ) {
      throw new Error(
        `Frozen Provider executor binding ${route.executorBinding.pluginId}/` +
          `${route.executorBinding.exportId} does not match its own route ` +
          `${route.executorPluginId}/${route.executorExportId}.`,
      );
    }
    return {
      pluginId: route.executorBinding.pluginId,
      pluginVersion: route.executorBinding.version,
      ...accountId,
    };
  }

  if (!input.resolveProviderExecutorBinding) {
    throw new Error(
      "Generator model-consumer Action requires a Provider executor binding resolver to " +
        "accept a staged media receipt.",
    );
  }
  const resolved = await input.resolveProviderExecutorBinding(
    route.executorPluginId!,
    route.executorExportId!,
  );
  if (
    resolved.pluginId !== route.executorPluginId ||
    resolved.exportId !== route.executorExportId
  ) {
    throw new Error(
      `Provider executor binding resolved ${resolved.pluginId}/${resolved.exportId}, expected ` +
        `${route.executorPluginId}/${route.executorExportId}.`,
    );
  }
  return {
    pluginId: resolved.pluginId,
    pluginVersion: resolved.version,
    ...accountId,
  };
}
