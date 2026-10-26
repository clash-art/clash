import type { ExecutorContextOverrides } from "@clash/action-sdk/browser";
import type {
  ExecutablePluginJsonValue,
  ExecutablePluginReference,
} from "@clash/shared-types/executable-plugin";
import type { ModelUpstreamRoute } from "@clash/shared-types";
import { getProviderCredentials } from "../../services/provider-accounts";
import {
  officialMediaCredentials,
  officialMediaRuntime,
} from "../official-media";
import { createGenerationOutputBroker } from "../output";
import { brokerUploadContext } from "./output-upload";
import type { Env } from "../../config";
import type { DurableRunRecord } from "@clash/shared-runtime/durable-run-engine";
import type { GenerationParams } from "../params";

export interface CloudPluginExecutionOptions {
  /** Injected in tests; production uses the selected provider account. */
  credentials?: (input: {
    route: ModelUpstreamRoute;
    actorUserId: string;
  }) => Promise<Record<string, string>>;
  /** Full hosted run, including frozen generation params; never journaled here. */
  run?: DurableRunRecord;
}

function hostedParams(run: Pick<DurableRunRecord, "executorInput">): GenerationParams {
  const input = run.executorInput as unknown as { params?: GenerationParams };
  if (!input?.params?.taskId || !input.params.projectId) {
    throw new Error("Hosted plugin execution requires frozen generation params.");
  }
  return input.params;
}

export function createCloudExecutorContext(
  env: Env,
  run: DurableRunRecord,
  options: CloudPluginExecutionOptions = {},
): ExecutorContextOverrides {
  const params = hostedParams(options.run ?? run);
  const route = params.selectedRoute;
  if (!route) {
    throw new Error("Hosted plugin execution requires a frozen provider route.");
  }
  const broker = createGenerationOutputBroker(
    env.R2_BUCKET,
    run,
    params.projectId,
  );
  const credentials = (async () => {
    if (options.credentials) {
      return options.credentials({ route, actorUserId: params.actorUserId });
    }
    // An admitted official media job resolves its official key; nothing else can.
    const official = await officialMediaCredentials(
      officialMediaRuntime(env),
      params,
    );
    if (official) return official;
    return getProviderCredentials(env, params.actorUserId, {
      providerId: route.providerId ?? route.upstreamId,
      ...(route.accountId ? { accountId: route.accountId } : {}),
      ...(route.upstreamId ? { upstreamId: route.upstreamId } : {}),
      modelCode: route.modelCode,
      ...(route.requiredCredentials?.length
        ? { requiredCredentials: route.requiredCredentials }
        : {}),
    });
  })();
  // A failed lookup must not become a rejected promise nobody observes.
  void credentials.catch(() => undefined);

  const { upload, asset } = brokerUploadContext(broker, "Plugin");

  return {
    store: {
      async get(key) {
        return (await credentials)[key];
      },
      async put() {
        throw new Error(
          "Hosted provider accounts are read-only during plugin execution.",
        );
      },
      async remove() {
        throw new Error(
          "Hosted provider accounts are read-only during plugin execution.",
        );
      },
    },
    upload,
    asset,
    async document(request) {
      return {
        slot: request.slot,
        kind: "document",
        document: {
          documentKind: request.documentKind,
          schemaVersion: request.schemaVersion,
          body: request.body as ExecutablePluginJsonValue,
        },
      };
    },
    async reference(reference: ExecutablePluginReference) {
      if ("text" in reference) {
        return { form: "text" as const, text: reference.text.value };
      }
      if ("document" in reference) {
        throw new Error(
          "Hosted provider execution cannot resolve a Document reference yet.",
        );
      }
      // Hosted references carry the server-resolved R2 key as their asset id
      // (plugin-provider-adapter hostedPluginReferences); the plugin never sees the key.
      const object = await env.R2_BUCKET.get(reference.asset.assetId);
      if (!object) {
        throw new Error(
          `Hosted provider reference ${reference.slot}#${reference.index} is unavailable.`,
        );
      }
      const mediaType =
        object.httpMetadata?.contentType ?? reference.asset.mediaType;
      return {
        form: "bytes" as const,
        bytes: new Uint8Array(await object.arrayBuffer()),
        kind: reference.asset.kind,
        ...(mediaType ? { mediaType } : {}),
      };
    },
  };
}

